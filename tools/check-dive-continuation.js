"use strict";

const assert = require("node:assert/strict");
const worldMap = require("../modules/world-map");
const { writeSignedVarInt, writeIntList, writeBool, writeByte } = require("../modules/packet-codec");

const handlers = new Map(worldMap.createWorldMapHandlers().map((handler) => [handler.packetId, handler]));
const now = 621355968000000000n + 17913888000000000n;

function request(user, packetId, parts = []) {
  let response;
  const ctx = {
    dateTimeBinaryNow: () => now,
    buildEncryptedPacket: (sequence, responseId, payload) => ({ responseId, payload }),
    sendResponse: (socket, sequence, responseId, build) => { response = build(); },
    config: {},
  };
  handlers.get(packetId).handle(ctx, { session: { user } }, { sequence: 1, payload: Buffer.concat(parts) });
  assert(response && response.payload.length > 0, `missing response to ${packetId}`);
  return response;
}

function start(user, decks = [0, 1]) {
  request(user, 1206, [writeSignedVarInt(1), writeSignedVarInt(1010), writeIntList(decks), writeBool(false)]);
  return user.worldMap.dive.active;
}

function move(user) {
  request(user, 1208, [writeSignedVarInt(0)]);
  return user.worldMap.dive.active;
}

function load(user, deckIndex = 0) {
  const loaded = worldMap.prepareDiveGameLoad(user, { diveStageID: 1010, selectDeckIndex: deckIndex }, { now });
  assert(loaded, "expected a playable dive node");
  return { ...loaded, diveDeckIndex: loaded.deckIndex };
}

const user = { userUid: "1", inventory: {}, army: {} };
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010 }), null);
move(user);
assert.equal(user.worldMap.dive.active, undefined, "movement cannot create an unstarted dive");
start(user);
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010 }), null, "move before loading");
move(user);
assert.equal(user.worldMap.dive.active.player.base.distance, 1);
const activeUid = user.worldMap.dive.active.diveUid;
start(user);
assert.equal(user.worldMap.dive.active.diveUid, activeUid, "a retried start preserves exploration");
assert.equal(user.worldMap.dive.active.player.base.distance, 1);
move(user);
assert.equal(user.worldMap.dive.active.player.base.distance, 1, "a retried movement cannot skip a battle");
request(user, 1215, [writeSignedVarInt(1)]);
assert.equal(user.worldMap.dive.active.player.base.state, 1, "an invalid artifact cannot skip a battle");
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1020 }), null, "reject another floor");
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010, selectDeckIndex: 9 }), null, "reject an unselected squad");

const first = load(user);
assert.equal(first.shipInitHp, 1);
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010, selectDeckIndex: 1 }), null, "cannot replace a loading squad");
const firstResult = worldMap.completeDiveBattle(user, first, { win: true, diveShipCurHp: 50, diveShipMaxHp: 100 }, { now });
assert.equal(firstResult.cleared, false);
assert.equal(firstResult.syncData.updatedSquads[0].curHp, 50000);
assert.equal(user.worldMap.dive.active.player.squads[0].supply, 1);
assert.equal(worldMap.completeDiveBattle(user, first, { win: true }, { now }), null, "completion is applied once");
user.worldMap = JSON.parse(JSON.stringify(user.worldMap));

move(user);
const second = load(user);
assert.equal(second.shipInitHp, 0.5, "next battle keeps the selected ship's HP");
assert.equal(worldMap.completeDiveBattle(user, first, { win: true }, { now }), null, "reject an old node result");
const failed = worldMap.completeDiveBattle(user, second, { Win: false }, { now });
assert.equal(failed.syncData.updatedSquads[0].curHp, 0);
assert.equal(failed.syncData.updatedSquads[0].state, 1);
assert.equal(user.worldMap.dive.active.player.base.state, 1, "another squad can retry this node");
assert.equal(user.worldMap.dive.active.player.base.leaderDeckIndex, 1);
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010, selectDeckIndex: 0 }), null, "a defeated squad cannot rejoin");
const retry = load(user, 1);
assert.equal(retry.diveSlotSetIndex, second.diveSlotSetIndex, "retry stays on the failed node");
const retryResult = worldMap.completeDiveBattle(user, retry, {
  win: true,
  units: [{ team: 1, role: "ship", hp: 75, maxHp: 100 }],
}, { now });
assert.equal(retryResult.syncData.updatedSquads[0].curHp, 75000, "JS combat HP is also retained");

move(user);
const boss = load(user, 1);
assert.equal(boss.selectedSlot.eventType, 2);
const cleared = worldMap.completeDiveBattle(user, boss, { win: true }, { now });
assert.equal(cleared.cleared, true);
assert(cleared.syncData.rewardData);
assert.equal(user.worldMap.dive.active, null);
assert(user.worldMap.diveClearStages.includes(1010));
const inventoryAfterClear = JSON.stringify(user.inventory);
assert.equal(worldMap.completeDiveBattle(user, boss, { win: true }, { now }), null);
assert.equal(JSON.stringify(user.inventory), inventoryAfterClear, "boss rewards are applied once");

const defeated = { userUid: "2", inventory: {}, army: {} };
start(defeated, [0]);
move(defeated);
const losing = load(defeated);
worldMap.completeDiveBattle(defeated, losing, { GameState: { WinTeam: 3 } }, { now });
assert.equal(defeated.worldMap.dive.active.player.base.state, 5);
move(defeated);
assert.equal(defeated.worldMap.dive.active.player.base.distance, 1, "annihilated squads cannot move forward");

start(defeated, [0]);
move(defeated);
load(defeated);
assert.equal(worldMap.completeDiveBattle(defeated, losing, { win: true }, { now }), null, "another exploration's result cannot settle the new battle");
request(defeated, 1217, [writeByte(0)]);
assert.equal(defeated.worldMap.dive.active.player.base.state, 5, "sacrificing the last squad ends exploration");

const deep = { userUid: "3", inventory: {}, army: {} };
request(deep, 1206, [writeSignedVarInt(1), writeSignedVarInt(1460), writeIntList([0, 1, 2, 3]), writeBool(false)]);
assert.equal(deep.worldMap.dive.active.floor.randomSetCount, 8);
for (let node = 0; node < 9; node += 1) {
  move(deep);
  const deckIndex = Math.floor(node / 3);
  assert(deep.worldMap.dive.active.player.squads[deckIndex].supply > 0, "all-battle local route has enough ammo");
  const loaded = worldMap.prepareDiveGameLoad(deep, { diveStageID: 1460, selectDeckIndex: deckIndex }, { now });
  assert(loaded);
  const result = worldMap.completeDiveBattle(deep, { ...loaded, diveDeckIndex: deckIndex }, { win: true }, { now });
  assert.equal(result.cleared, node === 8);
  if (node === 2 || node === 5) {
    assert.equal(deep.worldMap.dive.active.player.base.leaderDeckIndex, deckIndex + 1, "move leadership to a supplied squad");
    move(deep);
    assert.equal(worldMap.prepareDiveGameLoad(deep, { diveStageID: 1460, selectDeckIndex: deckIndex }), null, "empty ammo squads cannot enter combat");
  }
}
assert.equal(deep.worldMap.dive.active, null);

const legacy = { userUid: "4", inventory: {}, army: {} };
request(legacy, 1206, [writeSignedVarInt(1), writeSignedVarInt(1460), writeIntList([0, 1, 2, 3]), writeBool(false)]);
const legacyDive = legacy.worldMap.dive.active;
delete legacyDive.supplyRuleVersion;
legacyDive.player.squads[0].supply = 1;
legacyDive.player.squads[1].supply = 0;
legacyDive.player.squads[2].supply = 2;
legacyDive.player.squads[3] = { ...legacyDive.player.squads[3], supply: 0, state: 1, curHp: 0 };
move(legacy);
const migratedSupplies = Object.values(legacy.worldMap.dive.active.player.squads).map((squad) => squad.supply);
assert.deepEqual(migratedSupplies, [2, 1, 3, 0], "old routes receive only their missing initial ammo, without reviving dead squads");
worldMap.buildActiveDiveGameData(legacy);
worldMap.prepareDiveGameLoad(legacy, { diveStageID: 1460, selectDeckIndex: 0 });
assert.deepEqual(Object.values(legacy.worldMap.dive.active.player.squads).map((squad) => squad.supply), migratedSupplies, "ammo migration runs once");
legacy.worldMap.dive.active.player.base.state = 3;
assert(worldMap.prepareDiveGameLoad(legacy, { diveStageID: 1460, selectDeckIndex: 0 }), "saved BATTLE state can resume");

const starter = { userUid: "5", inventory: {}, army: {} };
start(starter);
move(starter);
starter.worldMap.dive.active.floor.slotSets.unshift({ slots: [{ sectorType: 1, eventType: 0, eventValue: 0 }] });
Object.assign(starter.worldMap.dive.active.player.base, { slotSetIndex: 1, prevSlotSetIndex: 0, distance: 2 });
const migratedStarter = load(starter);
assert.equal(migratedStarter.diveSlotSetIndex, 0, "removing the obsolete start node also remaps the player's position");
assert.equal(starter.worldMap.dive.active.player.base.prevSlotSetIndex, -1);
assert.equal(starter.worldMap.dive.active.player.base.distance, 1);
assert.equal(load(starter).diveSlotSetIndex, 0, "start-node migration does not shift the player twice");

console.log("Dive continuation checks passed: movement, squads, retained HP, retry, annihilation, and one-time rewards.");
