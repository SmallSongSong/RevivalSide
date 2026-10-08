"use strict";
const assert = require("node:assert/strict");
const pvp = require("../modules/local-pvp");
const unit = require("../modules/unit");
const inventory = require("../modules/inventory");
const codec = require("../modules/packet-codec");
const sceneHandler = require("../packet-handlers/0606-ui-scene-changed-req");

function makeUser() {
  const user = { userUid: "1", nickname: "Player", level: 30, army: {
    units: {
      11: { unitUid: "11", userUid: "1", unitId: 1002, level: 100, statExp: [1, 2, 3, 4, 5, 6], reactorLevel: 2, equipItemUids: ["21", 0, 0, 0] },
      12: { unitUid: "12", userUid: "1", unitId: 1003, level: 105 },
    }, ships: { 13: { unitUid: "13", userUid: "1", unitId: 26036, level: 110, limitBreakLevel: 2 } },
    operators: { 14: { uid: "14", id: 10001, level: 50, mainSkill: { id: 100, level: 2 }, subSkill: { id: 200, level: 3 } } },
  }, inventory: { equips: { 21: { equipUid: "21", itemEquipId: 1, ownerUnitUid: "11", stats: [{ type: "NST_HP", value: 12 }] } } } };
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
assert.equal(mirror.units[0].reactorLevel, deck.units[0].reactorLevel);
assert.deepEqual(mirror.units[0].statExp, deck.units[0].statExp);
assert.deepEqual(mirror.shipCommandModules, deck.shipCommandModules);
assert.equal(mirror.shipLimitBreakLevel, 2);
assert.deepEqual(mirror.operatorData.mainSkill, deck.operatorData.mainSkill);
assert.notEqual(mirror.operatorUid, deck.operatorUid);
assert.equal(mirror.equipItems[0].ownerUnitUid, mirror.units[0].unitUid);
assert.equal(mirror.units[0].equipItemUids[0], mirror.equipItems[0].equipUid);
assert.notEqual(mirror.equipItems[0].equipUid, deck.equipItems[0].equipUid);
assert.equal(deck.equipItems[0].equipUid, "21", "the player's original inventory is preserved");
const targets = pvp.buildTargets(user);
assert.equal(targets.length, 3);
assert.deepEqual(targets[1].deck.units.map(unit => unit.unitId), [1190, 1012, 1187, 1188, 1068, 1219, 1061, 2042]);
assert.equal(pvp.pvpConstants().AsyncPvpWinPoint, 75);
assert.equal(pvp.pvpConstants().AsyncPvpLosePoint, 50);

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
      localPvpStartPayloadBase64: Buffer.from([0, 0, 0, 0, 0, 0]).toString("base64") };
    assert.equal(stage.playerDeck.deckType, 2);
    assert.equal(stage.enemyDeck.units[0].unitId, 1002);
    return { managed, payload: Buffer.from([0, 1, 11, 22, 0]) };
  },
};
const packet = simulation => ({ payload: Buffer.concat([codec.writeSignedVarLong(900000001n), codec.writeByte(0), codec.writeSignedVarInt(20), codec.writeBool(simulation)]) });
handlers.get(2617).handle(ctx, socket, packet(false));
assert.deepEqual(sent.map(packet => packet.id), [2618]);
assert.equal(inventory.getMiscItem(user, 13).countFree, "5");
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(starts, 1, "request retries retain the same battle");
assert.equal(inventory.getMiscItem(user, 13).countFree, "5", "request retries cannot consume another ticket");
sceneHandler.handle(ctx, socket, { payload: codec.writeSignedVarInt(26) });
sceneHandler.handle(ctx, socket, { payload: codec.writeSignedVarInt(26) });
assert.equal(sent.filter(packet => packet.id === 2604).length, 1);
assert.equal(abandons, 0, "a new match survives the previous game scene marker");
const now = new Date("2026-10-08T02:00:00Z");
const firstEnd = pvp.buildGameEndPayload(socket, { win: true, now });
assert.equal(inventory.getMiscItem(user, 5).countFree, "75");
assert.equal(inventory.getMiscItem(user, 6).countFree, "825");
assert.equal(user.pvp.local.wins, 1);
assert.equal(user.pvp.local.score, 1025);
assert.deepEqual(firstEnd, pvp.buildGameEndPayload(socket, { win: false, now }));
assert.equal(inventory.getMiscItem(user, 5).countFree, "75", "duplicate results cannot grant rewards again");
handlers.get(2617).handle(ctx, socket, packet(true));
pvp.buildGameEndPayload(socket, { win: false, now });
assert.equal(inventory.getMiscItem(user, 13).countFree, "5");
assert.equal(inventory.getMiscItem(user, 5).countFree, "75");
assert.equal(user.pvp.local.losses, 0, "simulation does not change normal arena progression");
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(inventory.getMiscItem(user, 13).countFree, "4");
handlers.get(2602).handle(ctx, socket, {});
assert.equal(inventory.getMiscItem(user, 13).countFree, "5", "cancelling before loading refunds the reserved ticket");
managed = false;
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(codec.readSignedVarInt(sent.at(-1).payload).value, 1);
assert.equal(inventory.getMiscItem(user, 13).countFree, "5", "an unavailable combat host does not consume a ticket");
inventory.setMiscItemBalance(user, 13, 0n, 0n);
handlers.get(2617).handle(ctx, socket, packet(false));
assert.equal(codec.readSignedVarInt(sent.at(-1).payload).value, 20335);
managed = true;
inventory.setMiscItemBalance(user, 13, 2n, 0n);
inventory.setMiscItemBalance(user, 6, 25n, 0n);
handlers.get(2617).handle(ctx, socket, packet(false));
pvp.buildGameEndPayload(socket, { win: false, now });
assert.equal(inventory.getMiscItem(user, 5).countFree, "100", "reward is capped to the remaining 25-point budget");
assert.equal(inventory.getMiscItem(user, 6).countFree, "0");
assert.equal(user.pvp.local.losses, 1);
assert.equal(user.pvp.local.history.length, 2);
assert.equal(user.pvp.local.score, 1000);
console.log("[local-pvp] PASS mirror identity/equipment, wiki presets, PvP decks, match scene, retries, ticket costs, rewards, cancellation and failed startup");
