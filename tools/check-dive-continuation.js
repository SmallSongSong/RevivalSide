"use strict";

const assert = require("node:assert/strict");
const worldMap = require("../modules/world-map");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const { setDeckUnit, ensureDeck } = require("../modules/unit");
const { writeSignedVarInt, writeIntList, writeBool, writeByte, readSignedVarInt, readBool, readVarInt, readSignedVarIntList } = require("../modules/packet-codec");

const handlers = new Map(worldMap.createWorldMapHandlers().map((handler) => [handler.packetId, handler]));
const now = 621355968000000000n + 17913888000000000n;
const nativeFixtures = [];

function nativeFixture(name, dive, expectedNextSet, expectedBattleButton, moves) {
  if (dive.player.base.state === 4) moves = moves.map((move) => ({ ...move, error: 322 }));
  nativeFixtures.push({ name, dive: JSON.parse(JSON.stringify(dive)), expectedNextSet, expectedBattleButton, moves });
}

function settleArtifacts(user) {
  const dive = user.worldMap && user.worldMap.dive.active;
  if (!dive || dive.player.base.state !== 4) return;
  const before = JSON.parse(JSON.stringify(dive));
  const candidate = dive.player.base.reservedArtifacts[0];
  assert(candidate > 0);
  request(user, 1215, [writeSignedVarInt(candidate)]);
  const after = user.worldMap.dive.active;
  assert.equal(after.player.base.state, 0);
  assert.equal(after.player.base.distance, before.player.base.distance, "artifact choice does not occupy another node");
  assert(after.player.base.artifacts.includes(candidate));
  nativeFixtures.push({ name: `artifact-selection-${before.diveUid}-${before.player.base.distance}`, dive: before,
    expectedNextSet: 1, expectedBattleButton: false, moves: [{ slot: 0, error: 322 }], afterSelection: JSON.parse(JSON.stringify(after)) });
}

function decodeDiveSync(payload) {
  let offset = 0;
  const read = (fn) => { const result = fn(payload, offset); offset = result.offset; return result.value; };
  assert.equal(read(readSignedVarInt), 0);
  assert.equal(read(readBool), true);
  const updatedPlayer = {};
  if (read(readBool)) {
    for (const key of ["state", "prevSlotSetIndex", "prevSlotIndex", "slotSetIndex", "slotIndex", "distance", "leaderDeckIndex", "reservedDungeonID", "reservedDeckIndex"]) updatedPlayer[key] = read(readSignedVarInt);
    updatedPlayer.artifacts = read(readSignedVarIntList);
    updatedPlayer.reservedArtifacts = read(readSignedVarIntList);
  }
  const updatedSquads = [];
  for (let count = read(readVarInt); count > 0; count--) {
    assert.equal(read(readBool), true);
    const state = read(readSignedVarInt), deckIndex = read(readSignedVarInt);
    const curHp = payload.readFloatLE(offset), maxHp = payload.readFloatLE(offset + 4); offset += 8;
    updatedSquads.push({ state, deckIndex, curHp, maxHp, supply: read(readSignedVarInt) });
  }
  assert.equal(read(readVarInt), 0, "these routes already contain all remaining rows");
  const updatedSlots = [];
  for (let count = read(readVarInt); count > 0; count--) {
    assert.equal(read(readBool), true); assert.equal(read(readBool), true);
    const slot = { sectorType: read(readSignedVarInt), eventType: read(readSignedVarInt), eventValue: read(readSignedVarInt) };
    updatedSlots.push({ slot, slotSetIndex: read(readSignedVarInt), slotIndex: read(readSignedVarInt) });
  }
  return { updatedPlayer, updatedSquads, updatedSlots };
}

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
  settleArtifacts(user);
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
nativeFixture("start-without-a-START-slot", user.worldMap.dive.active, 0, false, [{ slot: 0, error: 0 }, { slot: 2, error: 0 }]);
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010 }), null, "move before loading");
move(user);
assert.equal(user.worldMap.dive.active.player.base.distance, 0, "reserving a battle does not complete its node");
nativeFixture("first-node-awaiting-battle", user.worldMap.dive.active, 0, true, [{ slot: 0, error: 322 }]);
const incorrectFirstMove = JSON.parse(JSON.stringify(user.worldMap.dive.active));
incorrectFirstMove.player.base.distance = 1;
nativeFixture("old-distance-error-displays-search", incorrectFirstMove, 1, false, [{ slot: 0, error: 322 }]);
const activeUid = user.worldMap.dive.active.diveUid;
start(user);
assert.equal(user.worldMap.dive.active.diveUid, activeUid, "a retried start preserves exploration");
assert.equal(user.worldMap.dive.active.player.base.distance, 0);
move(user);
assert.equal(user.worldMap.dive.active.player.base.distance, 0, "a retried movement cannot skip a battle");
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
assert.equal(user.worldMap.dive.active.player.squads[0].supply, 2, "winning a battle does not consume local ammo");
assert.equal(user.worldMap.dive.active.player.base.distance, 1);
assert.equal(user.worldMap.dive.active.floor.slotSets[0].slots.length, 1, "native floor keeps only the completed path");
nativeFixture("first-node-completed", user.worldMap.dive.active, 1, false, [{ slot: 0, error: 0 }, { slot: 1, error: 0 }, { slot: 2, error: 322 }]);
assert.equal(worldMap.completeDiveBattle(user, first, { win: true }, { now }), null, "completion is applied once");
user.worldMap = JSON.parse(JSON.stringify(user.worldMap));

move(user);
const second = load(user);
nativeFixture("second-node-awaiting-battle", { ...user.worldMap.dive.active, player: { ...user.worldMap.dive.active.player, base: { ...user.worldMap.dive.active.player.base, state: 1 } } }, 2, true, [{ slot: 0, error: 322 }]);
assert.equal(second.shipInitHp, 0.5, "next battle keeps the selected ship's HP");
assert.equal(worldMap.completeDiveBattle(user, first, { win: true }, { now }), null, "reject an old node result");
const failed = worldMap.completeDiveBattle(user, second, { Win: false }, { now });
assert.equal(failed.syncData.updatedSquads[0].curHp, 0);
assert.equal(failed.syncData.updatedSquads[0].state, 1);
assert.equal(user.worldMap.dive.active.player.base.state, 0, "a replacement squad returns to the last resolved node");
assert.equal(user.worldMap.dive.active.player.base.leaderDeckIndex, 1);
assert.equal(worldMap.prepareDiveGameLoad(user, { diveStageID: 1010, selectDeckIndex: 0 }), null, "a defeated squad cannot rejoin");
move(user);
const retry = load(user, 1);
assert.equal(retry.diveSlotSetIndex, second.diveSlotSetIndex, "retry stays on the failed node");
const retryResult = worldMap.completeDiveBattle(user, retry, {
  win: true,
  units: [{ team: 1, role: "ship", hp: 75, maxHp: 100 }],
}, { now });
assert.equal(retryResult.syncData.updatedSquads[0].curHp, 75000, "JS combat HP is also retained");
assert.equal(user.worldMap.dive.active.player.base.distance, 2);
assert.equal(user.worldMap.dive.active.player.base.slotSetIndex, 0, "completed normal route stays on the collapsed row until moving to the boss");
assert.equal(user.worldMap.dive.active.floor.slotSets.length, 2, "native floor slides after later wins");
nativeFixture("second-node-completed", user.worldMap.dive.active, 1, false, [{ slot: 0, error: 0 }, { slot: 1, error: 322 }]);

move(user);
const boss = load(user, 1);
nativeFixture("boss-awaiting-battle", { ...user.worldMap.dive.active, player: { ...user.worldMap.dive.active.player, base: { ...user.worldMap.dive.active.player.base, state: 1 } } }, 2, true, [{ slot: 0, error: 322 }]);
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
assert.equal(defeated.worldMap.dive.active.player.base.distance, 0, "annihilated squads cannot move forward");

start(defeated, [0]);
move(defeated);
load(defeated);
assert.equal(worldMap.completeDiveBattle(defeated, losing, { win: true }, { now }), null, "another exploration's result cannot settle the new battle");
request(defeated, 1217, [writeByte(0)]);
assert.equal(defeated.worldMap.dive.active.player.base.state, 5, "sacrificing the last squad ends exploration");

const deep = { userUid: "3", inventory: {}, army: {} };
request(deep, 1206, [writeSignedVarInt(1), writeSignedVarInt(1460), writeIntList([0, 1, 2, 3]), writeBool(false)]);
assert.equal(deep.worldMap.dive.active.floor.randomSetCount, 8);
let previousLoaded;
for (let node = 0; node < 9; node += 1) {
  move(deep);
  const deckIndex = Math.floor(node / 3);
  assert(deep.worldMap.dive.active.player.squads[deckIndex].supply > 0, "local squads retain visible ammo for the route");
  const loaded = worldMap.prepareDiveGameLoad(deep, { diveStageID: 1460, selectDeckIndex: deckIndex }, { now });
  assert(loaded);
  assert.equal(loaded.diveDistance, node, "node identity uses completed distance across sliding indexes");
  if (node === 2) {
    assert.equal(loaded.diveSlotSetIndex, previousLoaded.diveSlotSetIndex);
    assert.equal(loaded.deckIndex, previousLoaded.deckIndex);
    assert.equal(worldMap.completeDiveBattle(deep, { ...previousLoaded, diveDeckIndex: previousLoaded.deckIndex }, { win: true }), null, "a reused local index cannot settle a later node");
  }
  const result = worldMap.completeDiveBattle(deep, { ...loaded, diveDeckIndex: deckIndex }, { win: true }, { now });
  previousLoaded = loaded;
  assert.equal(result.cleared, node === 8);
  if (!result.cleared) assert(deep.worldMap.dive.active.player.squads[deckIndex].supply > 0, "battle completion leaves ammo unchanged");
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
assert.deepEqual(migratedSupplies, [2, 2, 2, 0], "old supply values align with the native maximum without reviving dead squads");
worldMap.buildActiveDiveGameData(legacy);
worldMap.prepareDiveGameLoad(legacy, { diveStageID: 1460, selectDeckIndex: 0 });
assert.deepEqual(Object.values(legacy.worldMap.dive.active.player.squads).map((squad) => squad.supply), migratedSupplies, "ammo migration runs once");
legacy.worldMap.dive.active.player.base.state = 3;
assert(worldMap.prepareDiveGameLoad(legacy, { diveStageID: 1460, selectDeckIndex: 0 }), "saved BATTLE state can resume");

const starter = { userUid: "5", inventory: {}, army: {} };
start(starter);
move(starter);
starter.worldMap.dive.active.floor.slotSets.unshift({ slots: [{ sectorType: 1, eventType: 0, eventValue: 0 }] });
delete starter.worldMap.dive.active.progressRuleVersion;
Object.assign(starter.worldMap.dive.active.player.base, { slotSetIndex: 1, prevSlotSetIndex: 0, distance: 2 });
const migratedStarter = load(starter);
assert.equal(migratedStarter.diveSlotSetIndex, 0, "removing the obsolete start node also remaps the player's position");
assert.equal(starter.worldMap.dive.active.player.base.prevSlotSetIndex, -1);
assert.equal(starter.worldMap.dive.active.player.base.distance, 0);
assert.equal(load(starter).diveSlotSetIndex, 0, "start-node migration does not shift the player twice");

const interrupted = { userUid: "8", inventory: {}, army: {} };
start(interrupted);
move(interrupted);
const interruptedLoad = load(interrupted);
const squadBeforeFailure = JSON.stringify(interrupted.worldMap.dive.active.player.squads);
assert.equal(worldMap.cancelDiveGameLoad(interrupted, { ...interruptedLoad, diveDistance: 1 }), false, "rollback cannot touch another node");
assert.equal(worldMap.cancelDiveGameLoad(interrupted, interruptedLoad), true);
assert.equal(interrupted.worldMap.dive.active.player.base.state, 1);
assert.equal(interrupted.worldMap.dive.active.player.base.reservedDeckIndex, -1);
assert.equal(JSON.stringify(interrupted.worldMap.dive.active.player.squads), squadBeforeFailure, "failed bootstrap spends no ammo or HP");
assert.equal(worldMap.cancelDiveGameLoad(interrupted, interruptedLoad), false);
assert(load(interrupted, 1), "another squad can retry a failed bootstrap");

const oldCompleted = { userUid: "9", inventory: {}, army: {} };
start(oldCompleted);
delete oldCompleted.worldMap.dive.active.progressRuleVersion;
Object.assign(oldCompleted.worldMap.dive.active.player.base, { distance: 2, slotSetIndex: 1, slotIndex: 2 });
worldMap.buildActiveDiveGameData(oldCompleted);
request(oldCompleted, 1208, [writeSignedVarInt(0)]);
assert.equal(oldCompleted.worldMap.dive.active.player.base.distance, 2, "legacy completed distance is retained");
assert.equal(oldCompleted.worldMap.dive.active.player.base.slotSetIndex, 1, "old absolute floor is migrated before reserving the boss");
assert.equal(oldCompleted.worldMap.dive.active.floor.slotSets.length, 2);
assert.equal(oldCompleted.worldMap.dive.active.floor.slotSets[0].slots.length, 1);

// Android's global Dive sends city 0, followed by MOVE and a GAME_LOAD whose
// stageID is 0. A nonzero city in START_ACK makes the native client mutate a
// branch event, so verify the wire response as well as the persisted state.
for (const [isAuto, slotIndex, dungeonID] of [[false, 0, 9110011], [true, 2, 9310013]]) {
  const android = { userUid: isAuto ? "7" : "6", inventory: {}, army: {} };
  const started = request(android, 1206, [writeSignedVarInt(0), writeSignedVarInt(1010), writeIntList([0, 1, 2, 3]), writeBool(false)]);
  const startError = readSignedVarInt(started.payload);
  assert.equal(startError.value, 0);
  assert.equal(readSignedVarInt(started.payload, startError.offset).value, 0, "global Dive ACK keeps city 0");
  assert.equal(android.worldMap.dive.active.cityID, 0);
  if (isAuto) request(android, 1212, [writeBool(true)]);
  const moved = request(android, 1208, [writeSignedVarInt(slotIndex)]);
  const moveError = readSignedVarInt(moved.payload);
  assert.equal(moveError.value, 0);
  const syncPresent = readBool(moved.payload, moveError.offset);
  assert.equal(syncPresent.value, true);
  const playerPresent = readBool(moved.payload, syncPresent.offset);
  assert.equal(playerPresent.value, true);
  assert.equal(readSignedVarInt(moved.payload, playerPresent.offset).value, android.worldMap.dive.active.player.base.state, "native MOVE_ACK carries the actual battle or non-combat state");
  if (android.worldMap.dive.active.player.base.state !== 1) {
    assert.equal(worldMap.prepareDiveGameLoad(android, { diveStageID: 1010, selectDeckIndex: 0 }), null);
    settleArtifacts(android);
    continue;
  }
  const loaded = worldMap.prepareDiveGameLoad(android, {
    stageID: 0, diveStageID: 1010, dungeonID, selectDeckIndex: 0, rewardMultiply: 1,
  }, { now });
  assert(loaded, "recorded manual/auto Android request can enter combat");
  assert(loaded.dungeonID >= 9500000, "current client loads the stage's modern pool rather than a stale legacy request");
  assert.equal(loaded.diveSlotIndex, slotIndex);
  assert.equal(loaded.dive.cityID, 0);
  android.worldMap.dive.active.cityID = 1;
  const oldUid = android.worldMap.dive.active.diveUid;
  request(android, 1206, [writeSignedVarInt(0), writeSignedVarInt(1010), writeIntList([0, 1, 2, 3]), writeBool(false)]);
  assert.equal(android.worldMap.dive.active.cityID, 0, "a repeated global start repairs old synthetic branch linkage");
  assert.equal(android.worldMap.dive.active.diveUid, oldUid, "repair preserves current exploration");
}

// Exercise off-center choices through the native post-win UpdateData path.
// Rebuild collapses the selected row to slot 0 before copying the new player.
for (const firstLane of [0, 1, 2]) {
  const routed = { userUid: `lane-${firstLane}`, inventory: {}, army: {} };
  request(routed, 1206, [writeSignedVarInt(0), writeSignedVarInt(1020), writeIntList([0, 1]), writeBool(false)]);
  for (const [node, lane] of [firstLane, 1, 0].entries()) {
    settleArtifacts(routed);
    request(routed, 1208, [writeSignedVarInt(lane)]);
    if (routed.worldMap.dive.active.player.base.state !== 1) {
      // A mixed non-combat route also occupies exactly one connected row.
      settleArtifacts(routed);
      continue;
    }
    const pending = JSON.parse(JSON.stringify(routed.worldMap.dive.active));
    const prepared = worldMap.prepareDiveGameLoad(routed, { diveStageID: 1020, selectDeckIndex: 0 }, { now });
    assert(prepared, `lane ${firstLane}: node ${node} must start`);
    assert.equal(prepared.diveLevel, node === 2 ? 37 : 32);
    assert.equal(prepared.diveLevelAdd, node === 2 ? 7 : 2);
    assert.equal(prepared.diveIsBoss, node === 2);
    const result = worldMap.completeDiveBattle(routed, { ...prepared, diveDeckIndex: 0 }, { win: true }, { now });
    assert.equal(result.cleared, node === 2);
    if (!result.cleared) {
      const afterWin = routed.worldMap.dive.active;
      assert.equal(afterWin.player.base.slotSetIndex, 0);
      assert.equal(afterWin.player.base.slotIndex, lane, "the completed row keeps the selected UI lane for the next connected range");
      assert(afterWin.floor.slotSets[1], "a connected next row remains available");
      nativeFixtures.push({ name: `lane-${firstLane}-node-${node}-win-sync`, dive: pending,
        expectedNextSet: node === 0 ? 0 : 2, expectedBattleButton: true, moves: [{ slot: 0, error: 322 }],
        afterWin: JSON.parse(JSON.stringify(afterWin)) });
      if (node === 1) {
        const broken = JSON.parse(JSON.stringify(afterWin));
        broken.progressRuleVersion = 3;
        broken.player.base.slotSetIndex = 1;
        routed.worldMap.dive.active = broken;
        assert(worldMap.repairActiveDiveSupply(routed, { now }), "local.4's Exploring cursor on the boss is repaired");
        assert.equal(routed.worldMap.dive.active.player.base.slotSetIndex, 0);
      }
    }
  }
  assert.equal(routed.worldMap.dive.active, null, "only the boss ends the route");
}

const assisted = { userUid: "10", inventory: {}, army: { units: {
  101: { unitUid: "101", userUid: "10", unitId: 1008, level: 100 },
  102: { unitUid: "102", userUid: "10", unitId: 1009, level: 90 },
  103: { unitUid: "103", userUid: "10", unitId: 1010, level: 80 },
  104: { unitUid: "104", userUid: "10", unitId: 1011, level: 70 },
} } };
for (const [index, uid] of ["101", "102", "103", "104"].entries()) {
  setDeckUnit(assisted, { deckType: 8, index }, 2, uid);
  ensureDeck(assisted, { deckType: 8, index }).leaderIndex = 2;
}
start(assisted, [0, 1, 2, 3]);
move(assisted);
const assistedLoad = load(assisted);
assert.deepEqual(assistedLoad.diveAssistDecks.map((deck) => deck.units[0].unitUid), ["102", "103", "104"]);
assert.deepEqual(assistedLoad.diveAssistDecks.map((deck) => deck.units[0].level), [90, 80, 70]);
assert(assistedLoad.diveAssistDecks.every((deck) => deck.units.length === 1), "only other squad leaders enter the assist pool");
worldMap.cancelDiveGameLoad(assisted, assistedLoad);
assisted.worldMap.dive.active.player.squads[1].state = 1;
assisted.worldMap.dive.active.player.squads[1].curHp = 0;
assert.deepEqual(load(assisted).diveAssistDecks.map((deck) => deck.units[0].unitUid), ["103", "104"], "dead squads cannot support a battle");
assisted.worldMap.dive.active.player.base.artifacts = [1, 2, 1, 999999];
assert.deepEqual(load(assisted).diveBattleConditionIds, [1001, 1002], "saved artifacts use their real battle-condition IDs, without unknown or duplicate effects");

const prematureBoss = { userUid: "11", inventory: {}, army: {} };
start(prematureBoss);
prematureBoss.worldMap.dive.active.floor.slotSets[0].slots[0] =
  prematureBoss.worldMap.dive.active.floor.slotSets.at(-1).slots[0];
move(prematureBoss);
const repairedNode = load(prematureBoss);
assert.equal(repairedNode.diveIsBoss, false, "an old misplaced boss flag is repaired before combat");
assert.equal(repairedNode.selectedSlot.eventType, 1);
assert.equal(worldMap.completeDiveBattle(prematureBoss, repairedNode, { win: true }, { now }).cleared, false,
  "a boss-looking node before the terminal row cannot finish the exploration");

const dungeonRows = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json");
const dungeonById = new Map(dungeonRows.map((row) => [row.m_DungeonID, row]));
const diveRows = readGameplayTableRecords("ab_script", "LUA_DIVE_TEMPLET.json");

for (const eventType of [6, 7, 19]) {
  const events = { userUid: `event-${eventType}`, inventory: {}, army: {} };
  start(events, [0, 1]);
  const active = events.worldMap.dive.active;
  active.floor.slotSets[0].slots[1] = { sectorType: 10, eventType, eventValue: 0 };
  active.player.squads[0].curHp = 45000;
  active.player.squads[0].supply = 1;
  active.player.squads[1].curHp = 0;
  active.player.squads[1].state = 1;
  const before = JSON.parse(JSON.stringify(active));
  const moved = request(events, 1208, [writeSignedVarInt(1)]);
  const actualSync = decodeDiveSync(moved.payload);
  const after = events.worldMap.dive.active;
  assert.equal(after.player.base.distance, 1);
  assert.equal(after.player.base.slotSetIndex, 0);
  assert.equal(after.player.base.slotIndex, 1, "non-combat MOVE_ACK retains the chosen UI lane");
  assert.equal(after.floor.slotSets[0].slots[0].eventType, eventType, "off-center events remain the selected collapsed node");
  assert.equal(after.player.squads[1].curHp, 0, "nodes do not resurrect dead squads");
  if (eventType === 6) {
    assert.equal(after.player.squads[0].curHp, 65000);
    assert.equal(actualSync.updatedSquads[0].curHp, 65000, "MOVE_ACK carries the real 20-percent repair");
  } else if (eventType === 7) {
    assert.equal(after.player.squads[0].supply, 2);
    assert.equal(actualSync.updatedSquads[0].supply, 2, "MOVE_ACK carries +1 supply capped at 2");
  } else {
    assert.equal(after.player.base.state, 4);
    assert.equal(after.player.base.reservedArtifacts.length, 3);
    assert.equal(new Set(after.player.base.reservedArtifacts).size, 3);
  }
  assert.deepEqual(actualSync.updatedPlayer, after.player.base);
  nativeFixtures.push({ name: `noncombat-MOVE_ACK-${eventType}`, dive: before, expectedNextSet: 0,
    expectedBattleButton: false, moves: [{ slot: 1, error: 0 }], afterMove: JSON.parse(JSON.stringify(after)), moveSync: actualSync });
  if (eventType === 19) settleArtifacts(events);
  const serialized = JSON.stringify(events.worldMap.dive.active);
  events.worldMap.dive.active = JSON.parse(serialized);
  worldMap.buildActiveDiveGameData(events);
  assert.equal(JSON.stringify(events.worldMap.dive.active), serialized, "reload preserves the mixed route and selected artifact");
  move(events);
  const nextBattle = load(events);
  assert.equal(nextBattle.diveDistance, 1);
  assert.equal(worldMap.completeDiveBattle(events, nextBattle, { win: true }, { now }).cleared, false);
  move(events);
  const terminal = load(events);
  assert.equal(terminal.diveIsBoss, true);
  assert.equal(worldMap.completeDiveBattle(events, terminal, { win: true }, { now }).cleared, true,
    "a utility node resolves one row and still requires the terminal boss");
}

const repeatedRuns = { userUid: "20", inventory: {}, army: {} };
const routeSignatures = new Set(), generatedEvents = new Set();
for (let run = 0; run < 20; run++) {
  request(repeatedRuns, 1210);
  request(repeatedRuns, 1206, [writeSignedVarInt(0), writeSignedVarInt(1460), writeIntList([0, 1]), writeBool(false)]);
  const route = repeatedRuns.worldMap.dive.active;
  routeSignatures.add(JSON.stringify(route.floor.slotSets));
  const hallway = route.floor.slotSets.slice(0, -1).flatMap((row) => row.slots);
  hallway.forEach((slot) => generatedEvents.add(slot.eventType));
  assert(hallway.filter((slot) => slot.eventType === 6).length <= 1);
  assert(hallway.filter((slot) => slot.eventType === 19).length <= 1);
  assert(route.floor.slotSets.slice(0, -1).every((row) => row.slots[0].eventType === 1));
  const beforeReload = JSON.stringify(route);
  repeatedRuns.worldMap.dive.active = JSON.parse(beforeReload);
  worldMap.buildActiveDiveGameData(repeatedRuns);
  assert.equal(JSON.stringify(repeatedRuns.worldMap.dive.active), beforeReload);
}
assert(routeSignatures.size > 1, "different run UIDs produce changing mixed routes");
assert.deepEqual([...generatedEvents].sort((a, b) => a - b), [1, 6, 19], "restore exactly the upstream generated event types without inventing a Supply weight");

for (const scenario of ["first", "later-lane-1", "annihilation"]) {
  const lost = { userUid: scenario === "later-lane-1" ? "31" : "30", inventory: {}, army: {} };
  start(lost, scenario === "annihilation" ? [0] : [0, 1]);
  if (scenario === "later-lane-1") {
    move(lost);
    worldMap.completeDiveBattle(lost, load(lost), { win: true }, { now });
    settleArtifacts(lost);
    lost.worldMap.dive.active.floor.slotSets[1].slots[1] = { ...lost.worldMap.dive.active.floor.slotSets[1].slots[0] };
    request(lost, 1208, [writeSignedVarInt(1)]);
  } else move(lost);
  const beforeLoss = JSON.parse(JSON.stringify(lost.worldMap.dive.active));
  const losing = load(lost);
  const result = worldMap.completeDiveBattle(lost, losing, { win: false }, { now });
  const afterLoss = lost.worldMap.dive.active;
  assert.equal(afterLoss.player.base.distance, beforeLoss.player.base.distance);
  assert.equal(afterLoss.player.base.reservedDeckIndex, 0, "retain the defeated ship identity for native animation");
  assert.equal(afterLoss.player.squads[0].state, 1);
  assert.equal(afterLoss.player.squads[0].curHp, 0);
  assert.equal(worldMap.completeDiveBattle(lost, losing, { win: false }, { now }), null, "a losing result also settles once");
  if (scenario !== "annihilation") {
    assert.equal(afterLoss.player.base.state, 0);
    assert.equal(afterLoss.player.base.slotSetIndex, beforeLoss.player.base.prevSlotSetIndex);
    assert.equal(afterLoss.player.base.slotIndex, beforeLoss.player.base.prevSlotIndex);
    assert.equal(afterLoss.player.base.leaderDeckIndex, 1);
  } else assert.equal(afterLoss.player.base.state, 5);
  nativeFixtures.push({ name: `loss-${scenario}`, dive: beforeLoss,
    expectedNextSet: scenario === "later-lane-1" ? 2 : 0, expectedBattleButton: true, moves: [{ slot: 0, error: 322 }],
    afterLoss: JSON.parse(JSON.stringify(afterLoss)), lossSync: result.syncData });
  if (scenario !== "annihilation") {
    request(lost, 1208, [writeSignedVarInt(scenario === "later-lane-1" ? 1 : 0)]);
    assert(load(lost, 1), "the next living squad can reselect this column after loss");
    assert.equal(worldMap.prepareDiveGameLoad(lost, { diveStageID: 1010, selectDeckIndex: 0 }), null);
  }
}
let auditedNodes = 0;
for (const templet of diveRows) {
  const audited = { userUid: String(1000 + templet.STAGE_ID), inventory: {}, army: {} };
  request(audited, 1206, [writeSignedVarInt(0), writeSignedVarInt(templet.STAGE_ID), writeIntList([0, 1]), writeBool(false)]);
  const nodeCount = templet.RANDOM_SET_COUNT + 1;
  for (let node = 0; node < nodeCount; node += 1) {
    settleArtifacts(audited);
    request(audited, 1208, [writeSignedVarInt(0)]);
    const prepared = worldMap.prepareDiveGameLoad(audited, { diveStageID: templet.STAGE_ID, selectDeckIndex: 0 }, { now });
    assert(prepared, `floor ${templet.STAGE_ID}: node ${node} is playable`);
    const isBoss = node === nodeCount - 1;
    const expectedLevel = templet.STAGE_LEVEL + (isBoss ? templet.SET_LEVEL_SCALE : 0);
    assert.equal(prepared.diveDistance, node);
    assert.equal(prepared.diveIsBoss, isBoss, "only the last node is the exploration boss");
    assert.equal(prepared.diveLevel, expectedLevel);
    assert.equal(prepared.diveLevelFix, 0, "preserve native relative monster levels with an explicit zero fix");
    assert.equal(prepared.diveLevelAdd + dungeonById.get(prepared.dungeonID).m_DungeonLevel, expectedLevel);
    assert(prepared.dungeonID >= 9500000, "both global and world-map templates use the real modern pool");
    if (templet.DIVE_MONSTER_BC === "BC_DIVE_DEPTH_7") assert(prepared.diveBattleConditionIds.includes(41031));
    assert([2, 3, 4, 5, 6, 7, 8, 9].includes(prepared.selectedSlot.sectorType));
    const pending = JSON.parse(JSON.stringify(audited.worldMap.dive.active));
    if (templet.STAGE_ID === 1020 && (node === 0 || isBoss)) {
      nativeFixtures.push({ name: `difficulty-${templet.STAGE_ID}-${node}`, dive: pending,
        expectedNextSet: node === 0 ? 0 : 2, expectedBattleButton: true, moves: [{ slot: 0, error: 322 }],
        difficulty: { levelAdd: prepared.diveLevelAdd, levels: [
          { source: 30, expected: expectedLevel }, { source: 32, expected: expectedLevel + 2 },
        ] } });
    }
    const completed = worldMap.completeDiveBattle(audited, { ...prepared, diveDeckIndex: 0 }, { win: true }, { now });
    assert.equal(completed.cleared, isBoss, `floor ${templet.STAGE_ID}: normal nodes never unlock the next exploration`);
    nativeFixtures.push({ name: `full-route-${templet.STAGE_ID}-node-${node}`, dive: pending,
      expectedNextSet: node === 0 ? 0 : 2, expectedBattleButton: true, moves: [{ slot: 0, error: 322 }],
      afterWin: JSON.parse(JSON.stringify(completed.dive)) });
    auditedNodes++;
  }
  assert.equal(audited.worldMap.dive.active, null);
}
console.log(`Dive data audit passed: ${diveRows.length} exploration floors, ${auditedNodes} nodes, calibrated enemy levels, terminal bosses, hard sectors, and squad-leader assists.`);

const fixtureOutputIndex = process.argv.indexOf("--native-fixtures");
if (fixtureOutputIndex >= 0) {
  const output = process.argv[fixtureOutputIndex + 1];
  assert(output, "--native-fixtures requires an output path");
  for (const [pendingName, completedName] of [
    ["first-node-awaiting-battle", "first-node-completed"],
    ["second-node-awaiting-battle", "second-node-completed"],
  ]) {
    nativeFixtures.find((fixture) => fixture.name === pendingName).expectedFloorAfterWin =
      nativeFixtures.find((fixture) => fixture.name === completedName).dive.floor;
    nativeFixtures.find((fixture) => fixture.name === pendingName).afterWin =
      nativeFixtures.find((fixture) => fixture.name === completedName).dive;
  }
  require("node:fs").writeFileSync(output, JSON.stringify(nativeFixtures, null, 2));
}

console.log("Dive continuation checks passed: movement, squads, retained HP, retry, annihilation, and one-time rewards.");
