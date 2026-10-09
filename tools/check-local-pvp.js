"use strict";
const assert = require("node:assert/strict");
const pvp = require("../modules/local-pvp");
const unit = require("../modules/unit");
const inventory = require("../modules/inventory");
const codec = require("../modules/packet-codec");
const gameData = require("../modules/game-data");
const equipment = require("../modules/equipment");
const sceneHandler = require("../packet-handlers/0606-ui-scene-changed-req");

function makeUser() {
  const user = { userUid: "1", nickname: "Player", level: 30, army: {
    units: {
      11: { unitUid: "11", userUid: "1", unitId: 1002, level: 100, statExp: [1, 2, 3, 4, 5, 6], reactorLevel: 2, equipItemUids: ["21", 0, 0, 0] },
      12: { unitUid: "12", userUid: "1", unitId: 1003, level: 105 },
    }, ships: { 13: { unitUid: "13", userUid: "1", unitId: 26036, level: 110, limitBreakLevel: 2 } },
    operators: { 14: { uid: "14", id: 31901, level: 50, mainSkill: { id: 31901, level: 2 }, subSkill: { id: 1013, level: 3 } } },
  }, inventory: { equips: { 21: { equipUid: "21", itemEquipId: 1561141, ownerUnitUid: "11", stats: [{ type: "NST_HP", value: 12 }] } } } };
  unit.ensureArmy(user);
  for (let index = 0; index <= 1; index++) {
    unit.setDeckUnit(user, { deckType: 2, index }, 0, index ? "12" : "11");
    unit.setDeckShip(user, { deckType: 2, index }, "13");
    unit.setDeckOperator(user, { deckType: 2, index }, "14");
  }
  inventory.grantMiscItem(user, 13, 6n);
  inventory.grantMiscItem(user, 6, 900n);
  return user;
}
const user = makeUser();
const deck = pvp.buildPvpDeck(user, 0);
const mirror = pvp.cloneDeck(deck);
assert.equal(pvp.buildPvpDeck(user, 1).units[0].unitId, 1003, "PvP deck type 2 and requested index are honored");
assert.equal(mirror.units[0].unitId, deck.units[0].unitId);
assert.equal(mirror.units[0].slotIndex, deck.units[0].slotIndex);
assert.equal(mirror.units[0].level, 120);
assert.deepEqual(mirror.units[0].skillLevels, pvp.presetSkillLevels(deck.units[0].unitId));
assert.equal(mirror.units[0].reactorLevel, pvp.presetReactorLevel(deck.units[0].unitId));
assert.equal(mirror.units[0].limitBreakLevel, 13);
assert.equal(mirror.units[0].tacticLevel, 6);
assert.equal(mirror.shipUnitId, deck.shipUnitId);
assert.equal(mirror.shipLevel, 130);
assert.equal(mirror.shipLimitBreakLevel, 3);
assert.equal(mirror.operatorId, deck.operatorId);
assert.equal(mirror.operatorLevel, 100);
assert.equal(mirror.operatorData.mainSkill.level, 8);
assert.equal(mirror.operatorData.subSkill.level, 11);
assert.notEqual(mirror.operatorUid, deck.operatorUid);
assert.equal(mirror.equipItems.length, 4);
assert.equal(mirror.equipItems[0].ownerUnitUid, mirror.units[0].unitUid);
assert.equal(mirror.units[0].equipItemUids[0], mirror.equipItems[0].equipUid);
assert.notEqual(mirror.equipItems[0].equipUid, deck.equipItems[0].equipUid);
assert(mirror.equipItems.every(equip => equip.enchantLevel === 10 && equip.setOptionId === pvp.CDR_SET));
assert.equal(deck.units[0].level, 100);
assert.equal(deck.operatorLevel, 50);
assert.equal(deck.shipLevel, 110);
assert.equal(deck.equipItems[0].equipUid, "21", "the player's original inventory is preserved");
const targets = pvp.buildTargets(user);
assert.equal(targets.length, 7);
assert.deepEqual(targets[1].deck.units.map(unit => unit.unitId), [1239, 1256, 1135, 1246, 2042, 2091, 2158, 1206]);
assert(!pvp.presets.some(preset => ["evolved", "siege"].includes(preset.key)));
assert.throws(() => pvp.buildPresetDeck({ ...pvp.presets[0], shipUnitId: 26039 }, deck), /native content tags/, "Albion must not appear as an enabled native ship under KOR-only tags");
const inventoryBeforeBots = JSON.stringify(user.inventory);
const allBotUids = new Set();
for (const preset of pvp.presets) {
  const bot = pvp.buildPresetDeck(preset, deck);
  assert.equal(bot.units.length, 8);
  assert.equal(bot.equipItems.length, 32);
  assert.equal(bot.shipLevel, 130);
  assert.equal(bot.operatorLevel, 100);
  assert.equal(bot.operatorData.mainSkill.level, 8);
  assert.equal(bot.operatorData.subSkill.id, 1013);
  assert.equal(bot.operatorData.subSkill.level, 11);
  for (const character of bot.units) {
    const templet = gameData.getUnitTemplet(character.unitId);
    assert.equal(character.level, 120);
    assert.equal(character.limitBreakLevel, 13);
    assert.equal(character.tacticLevel, 6);
    assert.equal(templet.m_NKM_UNIT_GRADE, "NUG_SSR");
    assert.equal(character.equipItemUids.length, 4);
    const equipped = character.equipItemUids.map(uid => bot.equipItems.find(equip => equip.equipUid === uid));
    assert(equipped.every(Boolean));
    assert(equipped.every(equip => equip.ownerUnitUid === character.unitUid && equip.setOptionId === pvp.CDR_SET));
    assert.equal(gameData.getEquipSetOption(pvp.CDR_SET).m_EquipSetPart, 4);
    assert(equipped.filter(equip => (gameData.getEquipTemplet(equip.itemEquipId).m_lstPrivateUnitID || []).length > 0).length <= 1, "a unit cannot equip two exclusive accessories");
    for (const [slot, equip] of equipped.entries()) {
      assert(!allBotUids.has(equip.equipUid)); allBotUids.add(equip.equipUid);
      const item = gameData.getEquipTemplet(equip.itemEquipId);
      assert(gameData.isUsableEquipTemplet(item), "bot gear is a real visible item");
      assert(!/TEST/.test(item.m_ItemEquipStrID));
      assert.equal(item.m_EquipUnitStyleType, templet.m_NKM_UNIT_STYLE_TYPE);
      assert.equal(item.m_ItemEquipPosition, ["IEP_WEAPON", "IEP_DEFENCE", "IEP_ACC", "IEP_ACC"][slot]);
      assert.equal(equip.enchantLevel, item.m_MaxEnchantLevel);
      assert.equal(equip.precision, 100); assert.equal(equip.precision2, 100);
      assert.equal(equip.stats[0].type, item.STAT_TYPE_1);
      assert.equal(equip.stats[0].value, item.STAT_VALUE_1);
      assert.equal(equip.stats[0].levelValue, item.STAT_LEVELUP_VALUE_1);
      for (let statSlot = 1; statSlot <= 2; statSlot++) {
        const stat = equip.stats[statSlot];
        const valid = gameData.getEquipRandomStatRecords(statSlot === 1 ? item.m_StatGroupID : item.m_StatGroupID_2).find(row => row.m_StatType === stat.type);
        assert(valid, "no impossible substat is synthesized");
        assert.equal(stat.value, Number(valid.m_MaxStatValue ?? valid.m_MaxStat));
      }
      for (const potential of equip.potentialOptions) {
        const row = gameData.getEquipPotentialOptionRecords(item.m_PotentialOptionGroupID).find(row => row.OptionKey === potential.optionKey);
        assert(row);
        assert.equal(potential.statType, row.Socket1_StatType);
        potential.sockets.forEach((socket, index) => { assert.equal(socket.statValue, row[`Socket${index + 1}_MaxStat`]); assert.equal(socket.precision, 100); });
      }
      if (item.m_lstPrivateUnitID) assert(item.m_lstPrivateUnitID.includes(templet.m_BaseUnitID || character.unitId));
    }
    const haste = equipped.reduce((sum, equip) => sum + equip.stats.filter(stat => stat.type === "NST_SKILL_COOL_TIME_REDUCE_RATE").reduce((sum, stat) => sum + stat.value, 0)
      + equip.potentialOptions.filter(option => option.statType === "NST_SKILL_COOL_TIME_REDUCE_RATE").reduce((sum, option) => sum + option.sockets.reduce((sum, socket) => sum + socket.statValue, 0), 0), 0) + gameData.getEquipSetOption(pvp.CDR_SET).m_StatValue_1;
    assert(haste >= 0.73 && haste <= 0.9, "complete legal CDR sets are used");
  }
}
assert.equal(JSON.stringify(user.inventory), inventoryBeforeBots, "building bots cannot grant their equipment to the player");
assert.deepEqual(targets[1].deck.units[4].skillLevels, [10, 10, 10, 10, 5]);
assert.equal(targets[1].deck.units[1].reactorLevel, 1);
assert(targets.some(target => target.deck.equipItems.some(equip => equip.itemEquipId === 1101135)), "Yang Harim receives his valid T7 exclusive armor");
assert.equal(pvp.pvpConstants().AsyncPvpWinPoint, 75);
assert.equal(pvp.pvpConstants().AsyncPvpLosePoint, 50);

for (const friendCode of [900000001n, 900000002n, 900000003n]) {
  const payload = Buffer.concat([codec.writeSignedVarLong(friendCode), codec.writeByte(0), codec.writeSignedVarInt(20), codec.writeBool(false)]);
  assert.equal(payload.length, 8, "strategy bot request follows the eight-byte contract seen on device");
  assert.deepEqual(pvp.decodeStartRequest({}, { payload }), { targetFriendCode: String(friendCode), selectDeckIndex: 0, gameType: 20, simulationGame: false });
}

const handlers = new Map(pvp.createHandlers().map(handler => [handler.packetId, handler]));
const socket = { session: { user, gameReplay: { lastSceneId: 3 } } };
const sent = [];
let starts = 0;
let abandons = 0;
let managed = true;
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true }, decryptCopy: payload => payload,
  sendGameResponse: (_socket, _packet, id, payload) => sent.push({ id, payload }),
  sendServerGamePacket: (_socket, id, payload) => sent.push({ id, payload }),
  abandonDynamicBattle: () => { abandons++; socket.session.gameReplay.dynamicGame = null; },
  buildDynamicGameLoadPayload: (_socket, _req, stage) => {
    starts++;
    const replay = socket.session.gameReplay;
    replay.loadCompleteReceived = false;
    replay.dynamicBattleResultSent = false;
    replay.dynamicGame = { gameUID: String(100 + starts), miscMode: "local-pvp", localPvpGameType: 20,
      localPvpStartPayloadBase64: Buffer.from([0, 1, 11, 0, 0, 0]).toString("base64") };
    assert.equal(stage.playerDeck.deckType, 2);
    assert(gameData.getUnitTemplet(stage.enemyDeck.units[0].unitId));
    return { managed, payload: Buffer.from([0, 1, 11, 22, 0]) };
  },
};
const packet = simulation => ({ payload: Buffer.concat([codec.writeSignedVarLong(900000001n), codec.writeByte(0), codec.writeSignedVarInt(20), codec.writeBool(simulation)]) });
handlers.get(2617).handle(ctx, socket, packet(false));
assert.deepEqual(sent.map(packet => packet.id), [2618]);
assert.equal(inventory.getMiscItem(user, 13).countFree, "6");
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(starts, 1, "request retries retain the same battle");
assert.equal(sent.filter(packet => packet.id === 2618).length, 1, "double-click retries must not trigger two client scene changes");
assert.equal(inventory.getMiscItem(user, 13).countFree, "6", "request retries cannot consume tickets");
sceneHandler.handle(ctx, socket, { payload: codec.writeSignedVarInt(26) });
sceneHandler.handle(ctx, socket, { payload: codec.writeSignedVarInt(26) });
assert.equal(sent.filter(packet => packet.id === 2604).length, 1);
assert.equal(abandons, 0, "a new match survives the previous game scene marker");
const originalMatch = socket.session.gameReplay.localPvpMatch;
const conflict = Buffer.concat([codec.writeSignedVarLong(900000002n), codec.writeByte(0), codec.writeSignedVarInt(20), codec.writeBool(false)]);
handlers.get(2617).handle(ctx, socket, { payload: conflict });
assert.equal(codec.readSignedVarInt(sent.at(-1).payload).value, 1);
assert.equal(socket.session.gameReplay.localPvpMatch, originalMatch, "another target cannot be accepted as a retry of an active battle");
assert.equal(starts, 1);
assert.throws(() => pvp.decodeStartRequest({}, { payload: packet(false).payload.subarray(0, 7) }));
assert.throws(() => pvp.decodeStartRequest({}, { payload: Buffer.concat([packet(false).payload, Buffer.from([0])]) }));
assert.deepEqual(pvp.decodeStartRequest({}, { payload: Buffer.concat([codec.writeByte(0), codec.writeSignedVarInt(6), codec.writeBool(true)]) }, true),
  { targetFriendCode: "900000001", selectDeckIndex: 0, gameType: 6, simulationGame: false, usingBot: true });
const now = new Date("2026-10-08T02:00:00Z");
socket.session.gameReplay.loadCompleteReceived = true;
const firstEnd = pvp.buildGameEndPayload(socket, { win: true, now });
assert.equal(inventory.getMiscItem(user, 5).countFree, "75");
assert.equal(inventory.getMiscItem(user, 6).countFree, "825");
assert.equal(user.pvp.local.wins, 1);
assert.equal(user.pvp.local.score, 1025);
assert.deepEqual(firstEnd, pvp.buildGameEndPayload(socket, { win: false, now }));
assert.equal(inventory.getMiscItem(user, 5).countFree, "75", "duplicate results cannot grant rewards again");
handlers.get(2617).handle(ctx, socket, packet(true));
pvp.buildGameEndPayload(socket, { win: false, now });
assert.equal(inventory.getMiscItem(user, 13).countFree, "6");
assert.equal(inventory.getMiscItem(user, 5).countFree, "75");
assert.equal(user.pvp.local.losses, 0, "simulation does not change normal arena progression");
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(inventory.getMiscItem(user, 13).countFree, "6");
handlers.get(2602).handle(ctx, socket, {});
assert.equal(inventory.getMiscItem(user, 13).countFree, "6", "cancelling a match does not affect tickets");
managed = false;
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(codec.readSignedVarInt(sent.at(-1).payload).value, 1);
assert.equal(inventory.getMiscItem(user, 13).countFree, "6", "an unavailable combat host does not consume a ticket");
inventory.setMiscItemBalance(user, 13, 0n, 0n);
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(sent.at(-1).id, 2618, "arena matches are available with zero tickets");
pvp.buildGameEndPayload(socket, { win: false, now });
assert.equal(inventory.getMiscItem(user, 13).countFree, "0");
managed = true;
inventory.setMiscItemBalance(user, 13, 2n, 0n);
inventory.setMiscItemBalance(user, 6, 25n, 0n);
handlers.get(2617).handle(ctx, socket, packet(false));
socket.session.gameReplay.loadCompleteReceived = true;
pvp.buildGameEndPayload(socket, { win: false, now });
assert.equal(inventory.getMiscItem(user, 5).countFree, "100", "reward is capped to the remaining 25-point budget");
assert.equal(inventory.getMiscItem(user, 6).countFree, "0");
assert.equal(user.pvp.local.losses, 1);
assert.equal(user.pvp.local.history.length, 2);
assert.equal(user.pvp.local.score, 1000);
const logs = [];
const originalLog = console.log;
const originalBuilder = ctx.buildDynamicGameLoadPayload;
console.log = message => logs.push(String(message));
try {
  for (const failure of ["thrown", "invalid-envelope", "null-game-data", "managed-failure"]) {
    const ticketsBefore = inventory.getMiscItem(user, 13).countFree;
    ctx.buildDynamicGameLoadPayload = (...args) => {
      const result = originalBuilder(...args);
      if (failure === "thrown") throw new Error("Ship module enum assignment failed");
      if (failure === "invalid-envelope") result.payload = Buffer.from([0]);
      if (failure === "null-game-data") result.payload = Buffer.from([0, 0, 0]);
      if (failure === "managed-failure") {
        result.managed = false;
        socket.session.gameReplay.lastBattleStartError = "native managed failure retained";
      }
      return result;
    };
    handlers.get(2617).handle(ctx, socket, packet(false));
    assert.equal(codec.readSignedVarInt(sent.at(-1).payload).value, 1);
    assert.equal(inventory.getMiscItem(user, 13).countFree, ticketsBefore, `${failure} does not consume tickets`);
    assert.equal(socket.session.gameReplay.dynamicGame, null, `${failure} clears an unusable battle`);
  }
} finally {
  console.log = originalLog;
  ctx.buildDynamicGameLoadPayload = originalBuilder;
}
assert(logs.some(line => line.includes("reason=managed-start-threw") && line.includes("Ship module enum assignment failed")));
assert(logs.some(line => line.includes("reason=invalid-game-load-payload")));
assert(logs.some(line => line.includes("reason=managed-start-failed") && line.includes("native managed failure retained")));
// Notification failures leave the same prepared gameData available for retry.
handlers.get(2617).handle(ctx, socket, packet(false));
const transport = ctx.sendServerGamePacket;
ctx.sendServerGamePacket = () => { throw new Error("transport unavailable"); };
assert.throws(() => pvp.notifyMatchReady(ctx, socket));
assert.equal(socket.session.gameReplay.localPvpMatch.matchNotified, undefined);
ctx.sendServerGamePacket = transport;
assert.equal(pvp.notifyMatchReady(ctx, socket), true);

const beforeSerialization = { coins: inventory.getMiscItem(user, 5).countFree, history: user.pvp.local.history.length, wins: user.pvp.local.wins };
socket.session.gameReplay.loadCompleteReceived = true;
assert.throws(() => pvp.buildGameEndPayload(socket, { win: true, now, gameRecordPayload: {} }));
const ids = pvp.presets[0].unitIds;
pvp.presets[0].unitIds = [999999];
try { assert.throws(() => pvp.buildGameEndPayload(socket, { win: true, now })); } finally { pvp.presets[0].unitIds = ids; }
assert.equal(inventory.getMiscItem(user, 5).countFree, beforeSerialization.coins);
assert.equal(user.pvp.local.history.length, beforeSerialization.history);
assert.equal(user.pvp.local.wins, beforeSerialization.wins);

inventory.setMiscItemBalance(user, 6, 500n, 0n);
const lossesBeforeDraw = user.pvp.local.losses;
const scoreBeforeDraw = user.pvp.local.score;
const drawPayload = pvp.buildGameEndPayload(socket, { result: 2, now });
assert.equal(codec.readSignedVarInt(drawPayload).value, 2);
assert.equal(user.pvp.local.draws, 1);
assert.equal(user.pvp.local.losses, lossesBeforeDraw);
assert.equal(user.pvp.local.score, scoreBeforeDraw);
assert.equal(inventory.getMiscItem(user, 6).countFree, "500", "no unpublished draw reward is invented");
assert.equal(user.pvp.local.history[0].result, 2);
assert.equal(user.pvp.local.history[0].gainScore, 0);

handlers.get(2617).handle(ctx, socket, packet(false));
const beforePreloadGiveup = { history: user.pvp.local.history.length, losses: user.pvp.local.losses, coins: inventory.getMiscItem(user, 5).countFree };
pvp.buildGameEndPayload(socket, { result: 1, now });
assert.equal(socket.session.gameReplay.localPvpMatch.progressionEligible, false);
assert.equal(user.pvp.local.history.length, beforePreloadGiveup.history);
assert.equal(user.pvp.local.losses, beforePreloadGiveup.losses);
assert.equal(inventory.getMiscItem(user, 5).countFree, beforePreloadGiveup.coins);
// Real client 2618 handlers update the selected target and schedule scene 26 on
// every ACK. Reproduce the logged Rosaria -> Jake double request on one socket.
const sceneMoves = [];
const responseTransport = ctx.sendGameResponse;
ctx.sendGameResponse = (_socket, _packet, id, payload) => {
  const result = responseTransport(_socket, _packet, id, payload);
  if (id === 2618 && codec.readSignedVarInt(payload).value === 0) sceneMoves.push(26);
  return result;
};
const battleRequest = code => ({ payload: Buffer.concat([codec.writeSignedVarLong(BigInt(code)), codec.writeByte(1), codec.writeSignedVarInt(11), codec.writeBool(false)]) });
const startsBeforeSwitch = starts;
handlers.get(2617).handle(ctx, socket, battleRequest("900000002"));
const firstGame = socket.session.gameReplay.dynamicGame.gameUID;
socket.session.gameReplay.loadCompleteReceived = true;
pvp.buildGameEndPayload(socket, { win: true, now });
handlers.get(2617).handle(ctx, socket, battleRequest("900000003"));
const secondMatch = socket.session.gameReplay.localPvpMatch;
const secondGame = socket.session.gameReplay.dynamicGame.gameUID;
handlers.get(2617).handle(ctx, socket, battleRequest("900000003"));
assert.equal(starts, startsBeforeSwitch + 2);
assert.notEqual(firstGame, secondGame);
assert.equal(secondMatch.target.key, "regina-control");
assert.equal(secondMatch.target.deck.units[0].unitId, 1202, "the stalled opponent from the log is Jake");
assert.equal(sceneMoves.length, 2, "the two battles each schedule one scene transition, not three");
const expectedTargets = pvp.buildTargets(user, 1);
const nativePrefix = Buffer.from([0, 1, 11]);
const expectedStart = Buffer.concat([nativePrefix, codec.writeNullableObject(pvp.targetData(secondMatch.target, 2)),
  codec.writeObjectList(expectedTargets.map((target, index) => codec.writeNullableObject(pvp.targetData(target, index)))), codec.writeBool(false)]);
assert.deepEqual(Buffer.from(secondMatch.startPayload, "base64"), expectedStart, "2618 carries the selected Jake target and all seven current targets");
assert.throws(() => pvp.buildPopulatedStartAck(Buffer.from([0, 1, 11, 1, 0, 0]), secondMatch.target, expectedTargets));
assert.throws(() => pvp.buildPopulatedStartAck(Buffer.from([0, 0, 0, 0, 0, 0]), secondMatch.target, expectedTargets));
sceneHandler.handle(ctx, socket, { payload: codec.writeSignedVarInt(26) });
assert.equal(secondMatch.matchNotified, true);
ctx.sendGameResponse = responseTransport;

// A response that was not sent can be retried without making another battle.
socket.session.gameReplay.loadCompleteReceived = true;
pvp.buildGameEndPayload(socket, { win: false, now });
ctx.sendGameResponse = () => false;
handlers.get(2617).handle(ctx, socket, battleRequest("900000003"));
assert.equal(socket.session.gameReplay.localPvpMatch.startResponseSent, false);
const beforeUnsentRetry = starts;
ctx.sendGameResponse = responseTransport;
handlers.get(2617).handle(ctx, socket, battleRequest("900000003"));
assert.equal(starts, beforeUnsentRetry);
assert.equal(socket.session.gameReplay.localPvpMatch.startResponseSent, true);

socket.session.gameReplay.loadCompleteReceived = true;
pvp.buildGameEndPayload(socket, { win: false, now });
const logTransport = console.log;
console.log = () => {};
ctx.sendGameResponse = () => { throw new Error("write failed"); };
try { handlers.get(2617).handle(ctx, socket, battleRequest("900000003")); } finally { console.log = logTransport; }
assert.equal(socket.session.gameReplay.localPvpMatch.startResponseSent, false);
const beforeThrownRetry = starts;
ctx.sendGameResponse = responseTransport;
handlers.get(2617).handle(ctx, socket, battleRequest("900000003"));
assert.equal(starts, beforeThrownRetry);
assert.equal(socket.session.gameReplay.localPvpMatch.startResponseSent, true);

const fixtureGenerator = require("./make-local-pvp-protocol-fixtures");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-public-pvp-test-"));
try {
  const generated = fixtureGenerator.generateFixtures(fixtureDir, "/data/local/tmp/public-fixture-test");
  assert.equal(generated.fixtureKeys.length, 7);
  const mirrorInput = JSON.parse(fs.readFileSync(path.join(fixtureDir, "start-mirror.json")));
  assert(mirrorInput.data.stage.playerDeck.units.every(unit => unit.level === 80));
  assert(mirrorInput.data.stage.enemyDeck.units.every(unit => unit.level === 120));
  assert.equal(mirrorInput.data.stage.playerDeck.equipItems.length, 0);
  assert.equal(mirrorInput.data.stage.enemyDeck.equipItems.length, 32);
  assert.equal(mirrorInput.data.stage.playerDeck.shipUnitId, 26024);
  assert.equal(mirrorInput.options.managedDir, "/data/local/tmp/public-fixture-test/managed");
  for (const key of generated.fixtureKeys) for (const result of [0, 1, 2]) {
    const request = JSON.parse(fs.readFileSync(path.join(fixtureDir, `validate-2623-${key}-${result}.json`)));
    assert.equal(request.data.packetId, 2623);
    assert.equal(codec.readSignedVarInt(Buffer.from(request.data.payloadBase64, "base64")).value, result);
  }
} finally { fs.rmSync(fixtureDir, { recursive: true, force: true }); }
console.log("[local-pvp] PASS mirror identity/equipment, wiki presets, PvP decks, match scene, retries, unlimited ticket access, rewards, cancellation and failed startup");
