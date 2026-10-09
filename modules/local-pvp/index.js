const {
  readSignedVarInt, readSignedVarLong, readByte, readBool,
  writeSignedVarInt: wi, writeSignedVarLong: wl, writeBool, writeString,
  writeInt64LE, writeFloatLE, writeIntList, writeObjectList, writeObjectMapInt,
  writeNullableObject: object, writeNullObject: nil, dateTimeBinaryNow,
  buildEquipItemData, buildOperatorData, buildShipCmdModuleData, buildItemMiscData,
} = require("../packet-codec");
const { buildPlayerDeckForGameLoad } = require("../unit");
const { getUnitTemplet, getPlayableUnitIds, loadGameData, getUnitSkillMaxLevel, getEquipTemplet, isUsableEquipTemplet, getEquipRandomStatRecords, getEquipSetOptionIds, getEquipSetOption, getEquipPotentialOptionRecords, getMaxEquipEnchantLevel, getShipMaxLevel, getMaxLimitBreakRank, getOperatorMaxLevel } = require("../game-data");
const { getMiscItem, grantMiscItem, spendMiscItem } = require("../inventory");
const stamina = require("../stamina");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const path = require("node:path");
const { createEquipData } = require("../equipment");
const presets = require("./bots.json");
const MIRROR_CODE = "900000001";

function ensureState(user) {
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  user.pvp.local = user.pvp.local && typeof user.pvp.local === "object" ? user.pvp.local : {};
  const state = user.pvp.local;
  state.history = Array.isArray(state.history) ? state.history : [];
  for (const key of ["wins", "losses", "draws", "winStreak", "maxWinStreak"]) state[key] = safeCount(state[key]);
  state.score = safeCount(state.score, 1000);
  state.maxScore = Math.max(state.score, safeCount(state.maxScore, 1000));
  return state;
}

function cloneDeck(playerDeck, friendCode = MIRROR_CODE, name = "BOT · Mirror 120") {
  const deck = JSON.parse(JSON.stringify(playerDeck));
  const base = BigInt(friendCode) * 100n;
  const originalLeader = String(deck.leaderUnitUid || "0");
  deck.userUid = String(friendCode);
  deck.nickname = name;
  deck.units = deck.units.map((unit, index) => {
    const originalUid = String(unit.unitUid);
    const result = maxBattleUnit(unit.unitId, String(base + 10n + BigInt(index)), unit.slotIndex);
    result.skinId = Number(unit.skinId || 0);
    if (originalUid === originalLeader) deck.leaderUnitUid = result.unitUid;
    return result;
  });
  if (!deck.units.some(unit => unit.unitUid === deck.leaderUnitUid)) deck.leaderUnitUid = deck.units[0]?.unitUid || "0";
  deck.shipUid = String(base + 1n);
  deck.shipLimitBreakLevel = 3;
  deck.shipLevel = getShipMaxLevel(deck.shipUnitId, { limitBreakLevel: 3 });
  deck.shipSkillLevels = [1, 1, 1, 0, 0];
  const operator = buildPresetOperator(deck.operatorId || 31901, String(base + 2n), deck.operatorData?.subSkill?.id || 1013);
  deck.operatorUid = operator.uid; deck.operatorId = operator.id; deck.operatorLevel = operator.level; deck.operatorData = operator;
  deck.equipItems = equipMaxBattleUnits(deck.units, base);
  return deck;
}

function maxBattleUnit(unitId, uid, slotIndex) {
  const record = getUnitTemplet(unitId);
  if (!record || !["NUST_COUNTER", "NUST_MECHANIC", "NUST_SOLDIER"].includes(record.m_NKM_UNIT_STYLE_TYPE)) throw new Error(`unavailable mirror unit ${unitId}`);
  return { slotIndex, unitUid: uid, unitId, level: 120, skinId: 0, tacticLevel: 6,
    tacticGroup: Number(record.m_TacticGroup || 0), limitBreakLevel: getMaxLimitBreakRank({ maxLevel: 120 }),
    skillLevels: presetSkillLevels(unitId), reactorLevel: presetReactorLevel(unitId), statExp: [0, 0, 0, 0, 0, 0], equipItemUids: [] };
}

function equipMaxBattleUnits(units, base) {
  const equips = [];
  for (const [index, unit] of units.entries()) {
    for (const [slot, template] of presetEquipTemplates(unit.unitId).entries()) {
      const equip = buildPresetEquip(template, String(base + 50n + BigInt(index * 4 + slot)));
      equip.ownerUnitUid = unit.unitUid;
      unit.equipItemUids.push(equip.equipUid);
      equips.push(equip);
    }
  }
  return equips;
}

function buildPresetDeck(preset, playerDeck) {
  const playable = new Set(getPlayableUnitIds());
  if (preset.unitIds.length !== 8 || new Set(preset.unitIds).size !== 8 || preset.unitIds.some(id => !playable.has(id) || getUnitTemplet(id).m_NKM_UNIT_GRADE !== "NUG_SSR"))
    throw new Error(`bot ${preset.key} references unavailable SSR units`);
  const ship = getUnitTemplet(preset.shipUnitId);
  if (!ship || ship.m_NKM_UNIT_TYPE !== "NUT_SHIP" || (ship.listContentsTagAllow?.length && !ship.listContentsTagAllow.includes("KOR")))
    throw new Error(`bot ${preset.key} ship requires unavailable native content tags`);
  const base = BigInt(preset.friendCode) * 100n;
  const operator = buildPresetOperator(preset.operatorId, String(base + 2n));
  const units = preset.unitIds.map((id, index) => maxBattleUnit(id, String(base + 10n + BigInt(index)), index));
  const equipItems = equipMaxBattleUnits(units, base);
  return {
    userUid: preset.friendCode, nickname: preset.name, userLevel: playerDeck.userLevel,
    deckType: 2, deckIndex: 0, leaderIndex: 0, leaderUnitUid: units[0].unitUid,
    shipUid: String(base + 1n), shipUnitId: preset.shipUnitId,
    shipLevel: getShipMaxLevel(preset.shipUnitId, { limitBreakLevel: 3 }), shipLimitBreakLevel: 3,
    shipSkillLevels: [1, 1, 1, 0, 0], shipSkinId: 0, shipCommandModules: [],
    operatorUid: operator.uid, operatorId: operator.id, operatorLevel: operator.level, operatorData: operator,
    equipItems, units,
  };
}

const CDR_SET = 241900;
const HASTE = "NST_SKILL_COOL_TIME_REDUCE_RATE";
const ROOT_DIR = path.resolve(__dirname, "../..");
let presetTables;
function getPresetTables() {
  if (!presetTables) presetTables = {
    operatorSkills: readGameplayTableRecords("ab_script_unit_data", "LUA_OPERATOR_SKILL_TEMPLET.json", { rootDir: ROOT_DIR }),
    reactors: readGameplayTableRecords("ab_script", "LUA_REACTOR_TEMPLET.json", { rootDir: ROOT_DIR }),
  };
  return presetTables;
}
function buildPresetOperator(id, uid, subSkillId = 1013) {
  const unit = getUnitTemplet(id);
  const main = getPresetTables().operatorSkills.find(record => record.m_OperSkillStrID === unit?.m_SkillStrID1);
  const sub = getPresetTables().operatorSkills.find(record => record.m_OperSkillID === Number(subSkillId) && record.m_OperSkillType === "m_Passive");
  if (!main || !sub || unit.m_NKM_UNIT_TYPE !== "NUT_OPERATOR") throw new Error(`missing bot operator ${id}`);
  return { uid, id, level: getOperatorMaxLevel(unit.m_NKM_UNIT_GRADE), exp: 0, locked: true, fromContract: true,
    mainSkill: { id: main.m_OperSkillID, level: main.m_MaxSkillLevel, exp: 0 },
    subSkill: { id: sub.m_OperSkillID, level: sub.m_MaxSkillLevel, exp: 0 } };
}
function presetReactorLevel(unitId) {
  const reactor = getPresetTables().reactors.find(record => Number(record.ReactorID) === unitId);
  return reactor ? Object.keys(reactor).filter(key => /^Level\d+$/.test(key) && Number(reactor[key]) > 0).length : 0;
}
function statRecords(template, slot) { return getEquipRandomStatRecords(slot === 1 ? template.m_StatGroupID : template.m_StatGroupID_2); }
function bestStat(template, slot, preferred) {
  const records = statRecords(template, slot);
  for (const type of preferred) { const record = records.find(record => record.m_StatType === type); if (record) return record; }
  return records[0] || null;
}
function presetEquipTemplates(unitId) {
  const unit = getUnitTemplet(unitId);
  const offset = { NUST_COUNTER: 0, NUST_MECHANIC: 1000, NUST_SOLDIER: 2000 }[unit.m_NKM_UNIT_STYLE_TYPE];
  if (offset == null) throw new Error(`unsupported bot unit style ${unitId}`);
  const tank = ["NURT_DEFENDER", "NURT_STRIKER"].includes(unit.m_NKM_UNIT_ROLE_TYPE);
  const support = unit.m_NKM_UNIT_ROLE_TYPE === "NURT_SUPPORTER";
  const ids = tank ? [2461141 + offset, 1561241 + offset, 1561342 + offset, 1561342 + offset]
    : support ? [1661101 + offset, 1561241 + offset, 1561342 + offset, 1561342 + offset]
      : [1561141 + offset, 1561241 + offset, 1561341 + offset, 1561341 + offset];
  const positions = ["IEP_WEAPON", "IEP_DEFENCE", "IEP_ACC", "IEP_ACC"];
  let hasExclusive = false;
  return ids.map((id, slot) => {
    let template = getEquipTemplet(id);
    if (!isUsableEquipTemplet(template) && support && slot === 0) template = getEquipTemplet(1561141 + offset);
    if (!tank && !hasExclusive) {
      const exclusive = Array.from(loadGameData().equipById.values()).filter(record =>
        isUsableEquipTemplet(record) && record.m_NKM_ITEM_TIER === 7 && record.m_ItemEquipPosition === positions[slot]
        && record.m_EquipUnitStyleType === unit.m_NKM_UNIT_STYLE_TYPE && (record.m_lstPrivateUnitID || []).includes(unit.m_BaseUnitID || unitId)
        && getEquipSetOptionIds(record).includes(CDR_SET) && statRecords(record, 2).some(stat => stat.m_StatType === HASTE))
        .sort((a, b) => Number(a.m_ItemEquipID) - Number(b.m_ItemEquipID))[0];
      if (exclusive) { template = exclusive; hasExclusive = true; }
    }
    if (!isUsableEquipTemplet(template) || template.m_ItemEquipPosition !== positions[slot] || template.m_EquipUnitStyleType !== unit.m_NKM_UNIT_STYLE_TYPE || !getEquipSetOptionIds(template).includes(CDR_SET))
      throw new Error(`invalid bot gear ${id} for unit ${unitId}`);
    return template;
  });
}
function buildPresetEquip(template, uid) {
  const defensive = template.m_bRelic || /1661|1662|1663|1561342|1562342|1563342/.test(String(template.m_ItemEquipID));
  const preferences = defensive ? ["NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE", "NST_DAMAGE_REDUCE_RATE", "NST_LONG_RANGE_DAMAGE_REDUCE_RATE", "NST_UNIT_TYPE_COUNTER_DAMAGE_REDUCE_RATE"]
    : ["NST_MOVE_TYPE_LAND_DAMAGE_RATE", "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE"];
  const first = bestStat(template, 1, preferences);
  const second = bestStat(template, 2, [HASTE, "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE"]);
  const customSubstats = [first, second].map((record, index) => record && ({ slot: index + 1, type: record.m_StatType, valueKind: "max" })).filter(Boolean);
  const potential = template.m_bRelic ? getEquipPotentialOptionRecords(template.m_PotentialOptionGroupID).find(record => record.Socket1_StatType === HASTE) : null;
  if (template.m_bRelic && !potential) throw new Error(`missing bot gear haste potential ${template.m_ItemEquipID}`);
  const potentialOptions = potential ? [{ optionKey: potential.OptionKey, statType: HASTE, precisionChangeCount: 0,
    sockets: [1, 2, 3].map(slot => ({ statValue: Number(potential[`Socket${slot}_MaxStat`]), precision: 100 })) }] : [];
  return createEquipData(template.m_ItemEquipID, uid, { enchantLevel: Math.min(template.m_MaxEnchantLevel, getMaxEquipEnchantLevel(template.m_NKM_ITEM_TIER)),
    precision: 100, precision2: 100, setOptionId: CDR_SET, customSubstats, potentialOptions, regDate: "0", locked: true });
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
  const flag = readBool(payload, offset); offset = flag.offset;
  if (offset !== payload.length) throw new Error("unexpected trailing local PvP request bytes");
  if (!(ranked ? [6] : [11, 20, 21, 22]).includes(type.value)) throw new Error(`unsupported local PvP game type ${type.value}`);
  return { targetFriendCode, selectDeckIndex: deck.value, gameType: type.value, simulationGame: !ranked && flag.value, ...(ranked ? { usingBot: flag.value } : {}) };
}

function send(ctx, socket, packet, id, payload, label) {
  return ctx.sendGameResponse(socket, packet, id, payload, label);
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
        const sameRequest = existing.target.friendCode === req.targetFriendCode && existing.deckIndex === req.selectDeckIndex
          && Boolean(existing.simulationGame) === Boolean(id === 2617 && req.simulationGame)
          && (existing.requestPacketId == null || existing.requestPacketId === id)
          && (existing.requestGameType == null || existing.requestGameType === req.gameType);
        if (!sameRequest) {
          logStartFailure(id, req, "active-match-conflict");
          sendStartError(ctx, socket, packet, id); return true;
        }
        if (id === 2617 && existing.startPayload) {
          if (!existing.startResponseSent) sendPreparedStart(ctx, socket, packet, existing, "local-pvp-start-retry");
          else console.log(`[local-pvp:duplicate-start] target=${req.targetFriendCode} deck=${req.selectDeckIndex} gameUID=${replay.dynamicGame.gameUID} ACK already sent`);
        } else send(ctx, socket, packet, 2601, wi(0), "local-pvp-match-retry");
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
      let populatedStartPayload;
      try {
        populatedStartPayload = buildPopulatedStartAck(Buffer.from(startPayload, "base64"), target, targets);
      } catch (cause) {
        failStart(ctx, socket, packet, id, req, "invalid-async-start-payload", cause);
        return true;
      }
      replay.localPvpMatch = { target, playerDeck, requestPacketId: id, requestGameType: req.gameType, deckIndex: req.selectDeckIndex, simulationGame, gameType: replay.dynamicGame.localPvpGameType, settled: false, pendingMatch: id === 2617, gameDataPayload: body.subarray(error.offset, body.length - 1).toString("base64"), startPayload: populatedStartPayload.toString("base64"), startResponseSent: false };
      if (id === 2600) {
        send(ctx, socket, packet, 2601, wi(0), "local-pvp-match");
        notifyMatchReady(ctx, socket, { force: true });
      } else {
        sendPreparedStart(ctx, socket, packet, replay.localPvpMatch, "local-pvp-start");
      }
      return true;
    } })),
    { packetId: 2602, name: "PVP_GAME_MATCH_CANCEL_REQ", handle(ctx, socket, packet) {
      const replay = socket.session && socket.session.gameReplay;
      if (isLocalPvpReplay(replay) && !replay.loadCompleteReceived) {
        replay.localPvpMatch.canceled = true;
        replay.localPvpMatch.pendingMatch = false;
        if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "local-pvp-match-cancel");
      }
      send(ctx, socket, packet, 2603, wi(0), "local-pvp-cancel"); return true;
    } },
  ];
}

function buildPopulatedStartAck(nativePayload, target, targets) {
  if (!Buffer.isBuffer(nativePayload) || nativePayload.length < 6) throw new Error("empty managed ASYNC_PVP_START_GAME_ACK");
  const error = readSignedVarInt(nativePayload, 0);
  if (error.value !== 0 || nativePayload[error.offset] !== 1 || !nativePayload.subarray(-3).equals(Buffer.from([0, 0, 0])))
    throw new Error("unexpected managed ASYNC_PVP_START_GAME_ACK target envelope");
  const index = targets.findIndex(item => item.friendCode === target.friendCode);
  if (index < 0) throw new Error("selected local PvP target is absent");
  // The managed writer owns gameData/runtimeData. Its final fields are currently
  // refreshedTargetData=null, targetList=[], skip=false in the frozen client ABI.
  return Buffer.concat([nativePayload.subarray(0, -3), object(targetData(target, index)),
    writeObjectList(targets.map((item, index) => object(targetData(item, index)))), writeBool(false)]);
}

function sendPreparedStart(ctx, socket, packet, match, label) {
  try {
    const result = send(ctx, socket, packet, 2618, Buffer.from(match.startPayload, "base64"), label);
    if (result !== false) match.startResponseSent = true;
    return result !== false;
  } catch (error) {
    logStartFailure(2617, { targetFriendCode: match.target.friendCode, selectDeckIndex: match.deckIndex }, "start-response-send", error);
    return false;
  }
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

function isLocalPvpReplay(replay) { return Boolean(replay && replay.dynamicGame && replay.dynamicGame.miscMode === "local-pvp" && replay.localPvpMatch && !replay.localPvpMatch.canceled); }
function buildPvpState(user) {
  const state = user ? ensureState(user) : {};
  // PvpState.Serialize order from the bundled Android Assembly-CSharp.dll.
  return Buffer.concat([0, 0, state.wins || 0, state.losses || 0, 0, 0, state.score ?? 1000, state.maxScore ?? 1000, state.winStreak || 0, state.maxWinStreak || 0, 0, (state.wins || 0) + (state.losses || 0) + (state.draws || 0), state.wins || 0].map(wi));
}

function historyData(match, result, gameUid, now, user, score = {}) {
  return Buffer.concat([
    wl(BigInt(gameUid)), wi(user.level || 1), wi(match.target.deck.userLevel), writeString(match.target.deck.nickname),
    wi(result), wi(score.gainScore || 0), wi(0), wi(score.score ?? 1000), wi(0), wi(1000), wl(now), object(asyncDeck(match.playerDeck)), object(asyncDeck(match.target.deck)),
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
  const result = options.result == null ? options.draw === true ? 2 : options.win === true ? 0 : 1 : Number(options.result);
  if (![0, 1, 2].includes(result)) throw new Error(`invalid local PvP result ${result}`);
  const win = result === 0;
  const draw = result === 2;
  const eligible = !match.simulationGame && replay.loadCompleteReceived !== false;
  const gameUid = String(replay.dynamicGame.gameUID);
  const now = options.now instanceof Date ? (BigInt(options.now.getTime()) * 10000n + 621355968000000000n | 0x4000000000000000n) : typeof options.now === "bigint" ? options.now : dateTimeBinaryNow();
  if (options.gameRecordPayload != null && !Buffer.isBuffer(options.gameRecordPayload)) throw new Error("invalid local PvP gameRecord payload");
  // Prepare roster/history serialization before committing currency or statistics.
  const targetsPayload = targetList(user, match.deckIndex);
  const constants = pvpConstants();
  const next = { ...state };
  let points = 0n;
  let budget = null;
  let costBudget = null;
  if (eligible) {
    stamina.refreshTimedStamina(user, { itemIds: [6], now, initializeMissing: false });
    const maximumReward = BigInt(draw ? 0 : Math.max(0, Number(win ? constants.AsyncPvpWinPoint : constants.AsyncPvpLosePoint)));
    budget = getMiscItem(user, 6);
    const available = miscCount(budget);
    points = available < maximumReward ? available : maximumReward;
    if (points > 0n) {
      const free = BigInt(budget.countFree || 0);
      const freeSpend = free < points ? free : points;
      costBudget = { ...budget, countFree: String(free - freeSpend), countPaid: String(BigInt(budget.countPaid || 0) - (points - freeSpend)), regDate: String(now) };
    }
    if (draw) next.draws++; else if (win) next.wins++; else next.losses++;
    next.score = safeCount(state.score + (draw ? 0 : win ? 1 : -1) * Number(constants.ScoreMinIntervalUnit || 25));
    next.maxScore = Math.max(state.maxScore, next.score);
    next.winStreak = win ? state.winStreak + 1 : 0;
    next.maxWinStreak = Math.max(state.maxWinStreak, next.winStreak);
  }
  const gain = points > 0n ? { itemId: 5, countFree: String(points), countPaid: "0", bonusRatio: 0, regDate: String(now) } : null;
  const score = { score: next.score, gainScore: next.score - state.score };
  const payload = Buffer.concat([
    wi(result), object(buildPvpState({ pvp: { local: next } })), gain ? object(buildItemMiscData(gain)) : nil(), options.gameRecordPayload ? object(options.gameRecordPayload) : nil(),
    writeObjectList(costBudget ? [object(buildItemMiscData(costBudget))] : []),
    object(historyData(match, result, gameUid, now, user, score)), targetsPayload, writeInt64LE(stamina.getChargeItemLastUpdateDate(user, 6, now)),
    writeBool(true), writeBool(false), wi(0), writeFloatLE(Number(options.gameEndTime || 0)), writeBool(match.simulationGame),
  ]);
  if (eligible) {
    if (points > 0n) {
      grantMiscItem(user, 5, points, 0, { regDate: now });
      spendMiscItem(user, 6, points, { regDate: now });
    }
    Object.assign(state, next);
    state.history.unshift({ gameUid, targetFriendCode: match.target.friendCode, targetNickName: match.target.deck.nickname, win, draw, result,
      score: next.score, gainScore: score.gainScore, createdAt: options.now instanceof Date ? options.now.toISOString() : new Date().toISOString() });
    state.history = state.history.slice(0, 30);
  }
  match.progressionEligible = eligible;
  match.settlementResult = result;
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
  const sent = ctx.sendServerGamePacket(socket, 2604, Buffer.from(match.gameDataPayload, "base64"), "local-pvp-match-complete");
  if (sent === false) return false;
  match.matchNotified = true;
  match.pendingMatch = false;
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

function safeCount(value, fallback = 0) { const number = Number(value ?? fallback); return Number.isFinite(number) ? Math.min(0x7fffffff, Math.max(0, Math.trunc(number))) : fallback; }
function miscCount(item) { return BigInt(item.countFree || 0) + BigInt(item.countPaid || 0); }
let cachedPvpConstants;
function pvpConstants() {
  if (!cachedPvpConstants) {
    const parsed = readGameplayTable("ab_script", "LUA_PVP_CONST.json", { rootDir: path.resolve(__dirname, "../.."), logLabel: "local-pvp" });
    cachedPvpConstants = parsed.root || Object.fromEntries((parsed.records || []).map((entry) => [entry.__key, entry.value]));
  }
  return cachedPvpConstants;
}

module.exports = { buildPopulatedStartAck, CDR_SET, presetSkillLevels, presetReactorLevel, presetEquipTemplates, buildPresetEquip, buildPresetOperator, pvpConstants, buildPvpDeck, notifyMatchReady, createHandlers, ensureState, buildTargets, cloneDeck, buildPresetDeck, asyncDeck, asyncUnit, targetData, targetList, decodeStartRequest, isLocalPvpReplay, buildPvpState, buildGameEndPayload, presets };
