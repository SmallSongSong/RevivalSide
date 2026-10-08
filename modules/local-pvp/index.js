const {
  readSignedVarInt, readSignedVarLong, readByte, readBool,
  writeSignedVarInt: wi, writeSignedVarLong: wl, writeBool, writeString,
  writeInt64LE, writeFloatLE, writeIntList, writeObjectList, writeObjectMapInt,
  writeNullableObject: object, writeNullObject: nil, dateTimeBinaryNow,
  buildEquipItemData, buildOperatorData, buildShipCmdModuleData, buildItemMiscData,
} = require("../packet-codec");
const { buildPlayerDeckForGameLoad } = require("../unit");
const { getUnitTemplet, getPlayableUnitIds, loadGameData, getUnitSkillMaxLevel } = require("../game-data");
const { getMiscItem, grantMiscItem, spendMiscItem } = require("../inventory");
const stamina = require("../stamina");
const { readGameplayTable } = require("../gameplay-jsons");
const path = require("node:path");
const presets = require("./bots.json");
const MIRROR_CODE = "900000001";

function ensureState(user) {
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  user.pvp.local = user.pvp.local && typeof user.pvp.local === "object" ? user.pvp.local : {};
  const state = user.pvp.local;
  state.history = Array.isArray(state.history) ? state.history : [];
  state.wins = Math.max(0, Number(state.wins || 0));
  state.losses = Math.max(0, Number(state.losses || 0));
  return state;
}

function cloneDeck(playerDeck, friendCode = MIRROR_CODE, name = "BOT · Mirror") {
  const deck = JSON.parse(JSON.stringify(playerDeck));
  const unitIds = new Map();
  const equipIds = new Map();
  const base = BigInt(friendCode) * 100n;
  const remap = (value, map, offset) => {
    const key = String(value || "0");
    if (key === "0" || key === "-1") return key;
    if (!map.has(key)) map.set(key, String(base + BigInt(offset + map.size)));
    return map.get(key);
  };
  deck.userUid = String(friendCode);
  deck.nickname = name;
  deck.units.forEach((unit) => { unit.unitUid = remap(unit.unitUid, unitIds, 10); });
  deck.leaderUnitUid = remap(deck.leaderUnitUid, unitIds, 10);
  deck.shipUid = remap(deck.shipUid, unitIds, 10);
  deck.operatorUid = remap(deck.operatorUid, unitIds, 10);
  if (deck.operatorData) deck.operatorData.uid = deck.operatorUid;
  for (const equip of deck.equipItems || []) {
    equip.equipUid = remap(equip.equipUid, equipIds, 50);
    equip.ownerUnitUid = remap(equip.ownerUnitUid, unitIds, 10);
  }
  for (const unit of deck.units) unit.equipItemUids = (unit.equipItemUids || []).map((uid) => remap(uid, equipIds, 50));
  return deck;
}

function buildPresetDeck(preset, playerDeck) {
  const playable = new Set(getPlayableUnitIds());
  if (preset.unitIds.some((id) => !playable.has(id))) throw new Error(`bot ${preset.key} references unavailable units`);
  const base = BigInt(preset.friendCode) * 100n;
  const levels = playerDeck.units.map((unit) => Number(unit.level || 1));
  const level = Math.max(1, Math.min(110, Math.round(levels.reduce((sum, value) => sum + value, 0) / levels.length)));
  return {
    userUid: preset.friendCode, nickname: preset.name, userLevel: playerDeck.userLevel,
    deckType: playerDeck.deckType, deckIndex: 0, leaderIndex: 0, leaderUnitUid: String(base + 10n),
    shipUid: String(base + 1n), shipUnitId: preset.shipUnitId,
    shipLevel: Math.max(1, Math.min(110, playerDeck.shipLevel)), shipSkinId: 0,
    operatorUid: "0", operatorId: 0, operatorLevel: 1, equipItems: [],
    units: preset.unitIds.map((unitId, slotIndex) => ({
      slotIndex, unitUid: String(base + 10n + BigInt(slotIndex)), unitId, level,
      skinId: 0, tacticLevel: 0, tacticGroup: Number((getUnitTemplet(unitId) || {}).m_TacticGroup || 0),
      limitBreakLevel: 0, skillLevels: presetSkillLevels(unitId), equipItemUids: ["0", "0", "0", "0"],
    })),
  };
}

function buildTargets(user, deckIndex = 0) {
  const playerDeck = buildPvpDeck(user, deckIndex);
  if (!playerDeck || !playerDeck.units.length || !playerDeck.shipUnitId) return [];
  return [
    { friendCode: MIRROR_CODE, key: "mirror", deck: cloneDeck(playerDeck) },
    ...presets.map((preset) => ({ friendCode: preset.friendCode, key: preset.key, deck: buildPresetDeck(preset, playerDeck) })),
  ];
}

function asyncUnit(unit) {
  return Buffer.concat([
    wl(BigInt(unit.unitUid || 0)), wi(unit.unitId), wi(unit.level), wi(unit.skinId || 0), wi(unit.limitBreakLevel || 0),
    writeIntList(unit.skillLevels || []), writeIntList(unit.statExp || [0, 0, 0, 0, 0, 0]),
    writeObjectList((unit.equipItemUids || []).map((uid) => wl(BigInt(uid || 0)))),
    writeObjectList((unit.shipCommandModules || []).map((module) => object(buildShipCmdModuleData(module)))), wi(unit.tacticLevel || 0), wi(unit.reactorLevel || 0),
  ]);
}

function asyncDeck(deck) {
  return Buffer.concat([
    wi(deck.leaderIndex || 0),
    object(asyncUnit({ unitUid: deck.shipUid, unitId: deck.shipUnitId, level: deck.shipLevel, skinId: deck.shipSkinId, limitBreakLevel: deck.shipLimitBreakLevel, skillLevels: deck.shipSkillLevels || [1, 1, 1, 1, 1], shipCommandModules: deck.shipCommandModules })),
    writeObjectList(deck.units.map((unit) => object(asyncUnit(unit)))),
    writeObjectList((deck.equipItems || []).map((equip) => object(buildEquipItemData(equip)))),
    wi(deck.units.reduce((sum, unit) => sum + Number(unit.level) * 100, 0)),
    deck.operatorId > 0 ? object(buildOperatorData(deck.operatorData || { uid: deck.operatorUid, id: deck.operatorId, level: deck.operatorLevel })) : nil(),
    nil(), writeObjectMapInt([]), writeObjectMapInt([]),
  ]);
}

function targetData(target, index = 0) {
  const deck = target.deck;
  const leader = deck.units.find((unit) => String(unit.unitUid) === String(deck.leaderUnitUid)) || deck.units[0];
  return Buffer.concat([
    wi(deck.userLevel), writeString(deck.nickname), wl(BigInt(target.friendCode)), wi(index + 1), wi(1000), wi(0),
    wi(leader.unitId), wi(leader.skinId || 0), wi(0), object(asyncDeck(deck)), nil(), wi(leader.tacticLevel || 0), wi(0),
  ]);
}

function targetList(user, deckIndex = 0) {
  return writeObjectList(buildTargets(user, deckIndex).map((target, index) => object(targetData(target, index))));
}

function decodeStartRequest(ctx, packet, ranked = false) {
  const payload = ctx.decryptCopy ? ctx.decryptCopy(packet.payload) : ctx.decryptPayload ? ctx.decryptPayload(packet.payload) : packet.payload;
  let offset = 0;
  let targetFriendCode = MIRROR_CODE;
  if (!ranked) { const item = readSignedVarLong(payload, offset); offset = item.offset; targetFriendCode = String(item.value); }
  const deck = readByte(payload, offset); offset = deck.offset;
  const type = readSignedVarInt(payload, offset); offset = type.offset;
  const simulationGame = offset < payload.length ? readBool(payload, offset).value : false;
  return { targetFriendCode, selectDeckIndex: deck.value, gameType: type.value, simulationGame };
}

function send(ctx, socket, packet, id, payload, label) {
  ctx.sendGameResponse(socket, packet, id, payload, label);
}

function createHandlers() {
  return [
    { packetId: 2615, name: "ASYNC_PVP_TARGET_LIST_REQ", handle(ctx, socket, packet) {
      const user = socket.session.user;
      send(ctx, socket, packet, 2616, Buffer.concat([wi(0), targetList(user)]), "local-pvp-targets");
      return true;
    } },
    ...[2600, 2617].map((id) => ({ packetId: id, name: id === 2600 ? "PVP_GAME_MATCH_REQ" : "ASYNC_PVP_START_GAME_REQ", handle(ctx, socket, packet) {
      let req;
      try { req = decodeStartRequest(ctx, packet, id === 2600); }
      catch (error) {
        logStartFailure(id, null, "request-decode", error);
        sendStartError(ctx, socket, packet, id); return true;
      }
      const user = socket.session.user;
      const replay = socket.session.gameReplay;
      if (isLocalPvpReplay(replay) && !replay.localPvpMatch.settled) {
        const existing = replay.localPvpMatch;
        if (id === 2617 && existing.startPayload) send(ctx, socket, packet, 2618, Buffer.from(existing.startPayload, "base64"), "local-pvp-start-retry");
        else send(ctx, socket, packet, 2601, wi(0), "local-pvp-match-retry");
        return true;
      }
      console.log(`[local-pvp:start] request=${id} target=${req.targetFriendCode} deck=${req.selectDeckIndex} gameType=${req.gameType} simulation=${req.simulationGame ? 1 : 0}`);
      const simulationGame = id === 2617 && req.simulationGame;
      const targets = buildTargets(user, req.selectDeckIndex);
      const target = targets.find((item) => item.friendCode === req.targetFriendCode);
      if (!target) {
        logStartFailure(id, req, targets.length ? "target-unavailable" : "player-deck-unavailable");
        sendStartError(ctx, socket, packet, id); return true;
      }
      const playerDeck = buildPvpDeck(user, req.selectDeckIndex);
      const stage = { stageId: 0, dungeonID: 0, mapID: 1001, gameType: req.gameType || 1, miscMode: "local-pvp", tutorial: false, playerDeck, enemyDeck: target.deck };
      console.log(`[local-pvp:roster] bot=${target.key} playerUnits=${playerDeck.units.map(unit => `${unit.slotIndex}:${unit.unitId}`).join(",")} enemyUnits=${target.deck.units.map(unit => unit.unitId).join(",")} ship=${playerDeck.shipUnitId} operator=${playerDeck.operatorId} equips=${playerDeck.equipItems.length}`);
      let result;
      try {
        result = ctx.buildDynamicGameLoadPayload(socket, { stageID: 0, dungeonID: 0, gameType: stage.gameType }, stage);
      } catch (error) {
        failStart(ctx, socket, packet, id, req, "managed-start-threw", error);
        return true;
      }
      const startPayload = result && result.managed && replay.dynamicGame && replay.dynamicGame.localPvpStartPayloadBase64;
      if (!startPayload) {
        failStart(ctx, socket, packet, id, req, result && result.managed ? "start-payload-unavailable" : "managed-start-failed", replay.lastBattleStartError);
        return true;
      }
      const body = result.payload;
      let error;
      try {
        if (!Buffer.isBuffer(body) || body.length < 3) throw new Error("empty managed GAME_LOAD_ACK");
        error = readSignedVarInt(body, 0);
        if (error.value !== 0 || body[error.offset] === 0 || body[body.length - 1] !== 0) throw new Error("unexpected managed GAME_LOAD_ACK envelope");
      } catch (cause) {
        failStart(ctx, socket, packet, id, req, "invalid-game-load-payload", cause);
        return true;
      }
      replay.localPvpMatch = { target, playerDeck, deckIndex: req.selectDeckIndex, simulationGame, gameType: replay.dynamicGame.localPvpGameType, settled: false, pendingMatch: id === 2617, gameDataPayload: body.subarray(error.offset, body.length - 1).toString("base64"), startPayload };
      if (id === 2600) {
        send(ctx, socket, packet, 2601, wi(0), "local-pvp-match");
        notifyMatchReady(ctx, socket, { force: true });
      } else {
        send(ctx, socket, packet, 2618, Buffer.from(startPayload, "base64"), "local-pvp-start");
      }
      return true;
    } })),
    { packetId: 2602, name: "PVP_GAME_MATCH_CANCEL_REQ", handle(ctx, socket, packet) {
      const replay = socket.session && socket.session.gameReplay;
      if (isLocalPvpReplay(replay) && !replay.loadCompleteReceived) {
        const match = replay.localPvpMatch;
        if (match.ticketCost && !match.ticketRefunded) {
          grantMiscItem(socket.session.user, 13, 1n);
          match.ticketRefunded = true;
          if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
        }
        if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "local-pvp-match-cancel");
      }
      send(ctx, socket, packet, 2603, wi(0), "local-pvp-cancel"); return true;
    } },
  ];
}

function logStartFailure(id, req, reason, error) {
  const message = error && (error.stack || error.message) || (error ? String(error) : "");
  console.log(`[local-pvp:start-failed] request=${id} target=${req ? req.targetFriendCode : "unknown"} deck=${req ? req.selectDeckIndex : "unknown"} reason=${reason}${message ? ` error=${JSON.stringify(message.slice(0, 6000))}` : ""}`);
}

function failStart(ctx, socket, packet, id, req, reason, error) {
  logStartFailure(id, req, reason, error);
  if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "local-pvp-start-failed");
  sendStartError(ctx, socket, packet, id);
}

function sendStartError(ctx, socket, packet, id, errorCode = 1) {
  // Nonzero error prevents the client entering a loading screen with null gameData.
  const payload = id === 2600 ? wi(errorCode) : Buffer.concat([wi(errorCode), nil(), nil(), nil(), writeObjectList([]), writeBool(false)]);
  send(ctx, socket, packet, id === 2600 ? 2601 : 2618, payload, "local-pvp-unavailable");
}

function isLocalPvpReplay(replay) { return Boolean(replay && replay.dynamicGame && replay.dynamicGame.miscMode === "local-pvp" && replay.localPvpMatch); }
function buildPvpState(user) {
  const state = user ? ensureState(user) : {};
  // PvpState.Serialize order from the bundled Android Assembly-CSharp.dll.
  return Buffer.concat([0, 0, state.wins || 0, state.losses || 0, 0, 0, state.score ?? 1000, state.maxScore ?? 1000, state.winStreak || 0, state.maxWinStreak || 0, 0, (state.wins || 0) + (state.losses || 0), state.wins || 0].map(wi));
}

function historyData(match, result, gameUid, now, user) {
  return Buffer.concat([
    wl(BigInt(gameUid)), wi(user.level || 1), wi(match.target.deck.userLevel), writeString(match.target.deck.nickname),
    wi(result), wi(0), wi(0), wi(0), wi(0), wi(1000), wl(now), object(asyncDeck(match.playerDeck)), object(asyncDeck(match.target.deck)),
    wi(match.gameType || 0), wl(BigInt(match.target.friendCode)), wl(0n), writeString(""), wl(0n), wl(0n), writeString(""), wl(0n),
    writeIntList([]), writeIntList([]), writeBool(false), wi(0), writeIntList([]), writeIntList([]),
  ]);
}

function buildGameEndPayload(socket, options = {}) {
  const replay = socket.session.gameReplay;
  if (!isLocalPvpReplay(replay)) return null;
  const match = replay.localPvpMatch;
  if (match.endPayload) return Buffer.from(match.endPayload, "base64");
  const user = socket.session.user;
  const state = ensureState(user);
  const win = options.win === true;
  const result = win ? 0 : 1;
  const gameUid = String(replay.dynamicGame.gameUID);
  const now = options.now instanceof Date ? (BigInt(options.now.getTime()) * 10000n + 621355968000000000n | 0x4000000000000000n) : typeof options.now === "bigint" ? options.now : dateTimeBinaryNow();
  let gainPointItem = null;
  const costItems = match.ticketCost ? [getMiscItem(user, 13)] : [];
  if (!match.simulationGame) {
    stamina.refreshTimedStamina(user, { itemIds: [6], now, initializeMissing: false });
    const constants = pvpConstants();
    const maximumReward = BigInt(Math.max(0, Number(win ? constants.AsyncPvpWinPoint : constants.AsyncPvpLosePoint)));
    const available = miscCount(getMiscItem(user, 6));
    const points = available < maximumReward ? available : maximumReward;
    if (points > 0n) {
      gainPointItem = grantMiscItem(user, 5, points, 0, { regDate: now });
      costItems.push(spendMiscItem(user, 6, points, { regDate: now }));
    }
    if (win) state.wins++; else state.losses++;
    state.score = Math.max(0, Number(state.score ?? 1000) + (win ? 1 : -1) * Number(constants.ScoreMinIntervalUnit || 25));
    state.maxScore = Math.max(Number(state.maxScore ?? 1000), state.score);
    state.winStreak = win ? Number(state.winStreak || 0) + 1 : 0;
    state.maxWinStreak = Math.max(Number(state.maxWinStreak || 0), state.winStreak);
    state.history.unshift({ gameUid, targetFriendCode: match.target.friendCode, targetNickName: match.target.deck.nickname, win, createdAt: options.now instanceof Date ? options.now.toISOString() : new Date().toISOString() });
    state.history = state.history.slice(0, 30);
  }
  const payload = Buffer.concat([
    wi(result), object(buildPvpState(user)), gainPointItem ? object(buildItemMiscData(gainPointItem)) : nil(), options.gameRecordPayload ? object(options.gameRecordPayload) : nil(),
    writeObjectList(costItems.map((item) => object(buildItemMiscData(item)))), object(historyData(match, result, gameUid, now, user)), targetList(user, match.deckIndex), writeInt64LE(stamina.getChargeItemLastUpdateDate(user, 6, now)),
    writeBool(true), writeBool(false), wi(0), writeFloatLE(Number(options.gameEndTime || 0)), writeBool(match.simulationGame),
  ]);
  match.settled = true;
  match.endPayload = payload.toString("base64");
  return payload;
}

function buildPvpDeck(user, index = 0) {
  return buildPlayerDeckForGameLoad(user, { selectDeckIndex: index }, { deckIndex: { deckType: 2, index } });
}

function notifyMatchReady(ctx, socket, options = {}) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!isLocalPvpReplay(replay)) return false;
  const match = replay.localPvpMatch;
  if (match.matchNotified || match.settled || (!match.pendingMatch && !options.force)) return false;
  match.matchNotified = true;
  match.pendingMatch = false;
  ctx.sendServerGamePacket(socket, 2604, Buffer.from(match.gameDataPayload, "base64"), "local-pvp-match-complete");
  return true;
}

function presetSkillLevels(unitId) {
  const record = getUnitTemplet(unitId);
  const skills = loadGameData().unitSkillStrIdById;
  return Array.from({ length: 5 }, (_, index) => {
    const name = record[`m_SkillStrID${index + 1}`];
    if (!name) return 0;
    const entry = Array.from(skills).find(([, strId]) => strId === name);
    return entry ? Math.max(1, getUnitSkillMaxLevel(entry[0])) : 1;
  });
}

function miscCount(item) { return BigInt(item.countFree || 0) + BigInt(item.countPaid || 0); }
let cachedPvpConstants;
function pvpConstants() {
  if (!cachedPvpConstants) {
    const parsed = readGameplayTable("ab_script", "LUA_PVP_CONST.json", { rootDir: path.resolve(__dirname, "../.."), logLabel: "local-pvp" });
    cachedPvpConstants = parsed.root || Object.fromEntries((parsed.records || []).map((entry) => [entry.__key, entry.value]));
  }
  return cachedPvpConstants;
}

module.exports = { pvpConstants, buildPvpDeck, notifyMatchReady, createHandlers, ensureState, buildTargets, cloneDeck, buildPresetDeck, asyncDeck, asyncUnit, targetData, targetList, decodeStartRequest, isLocalPvpReplay, buildPvpState, buildGameEndPayload, presets };
