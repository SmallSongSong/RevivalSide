"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const explore = require("../modules/explore");
const codec = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const user = { userUid: "42", nickname: "Explore", level: 100, army: { units: {}, ships: {}, operators: {} } };
const originalArmy = JSON.stringify(user.army);
let run = explore.enter(user, 1);
assert.equal(run.currentStep, -1);
assert.equal(run.state, explore.STATE.START);
assert.equal(Object.keys(run.squad.units).length, 4);
assert.equal(run.squad.ship.unitId, 26001);
assert(run.zone.steps.every(step => step.stages.every(stage => stage.pathId > 0)), "native reachability cannot use pathId=0");
assert(explore.serializeSquad(run.squad).length > 100);
const squadBytes = explore.serializeSquad(run.squad);
let squadOffset = 1 + 1 + codec.buildOperatorData(run.squad.operatorUnit).length + 1 + codec.buildUnitData(run.squad.ship).length;
assert.equal(squadBytes[squadOffset++], 4, "exploration dictionary contains four units");
const firstSquadKey = codec.readSignedVarLong(squadBytes, squadOffset);
squadOffset = firstSquadKey.offset;
assert.equal(squadBytes[squadOffset++], 1, "dictionary entry has one nullable-object marker");
assert.equal(codec.readSignedVarLong(squadBytes, squadOffset).value, firstSquadKey.value, "dictionary value begins with the real unit UID, without a second nullable marker");
assert(explore.handlerPayload(user, 1257, { templetId: 1 }).length > 200, "ENTER contains the squad and deck");
const initialRunId = run.runId;
explore.move(user, 0);
assert.throws(() => explore.prepareGameLoad(user, { exploreID: 1 }, { resolveStage: () => null }), /unavailable/);
assert.equal(explore.completeBattle({}, {}, {}, { win: true }), null, "missing runs cannot consume stale game-end results");
const first = explore.prepareGameLoad(user, { exploreID: 1, selectDeckIndex: 0 }, { resolveStage: req => ({ dungeonID: req.dungeonID, mapID: 77 }) });
assert.equal(first.gameType, 29);
assert.equal(first.miscMode, "explore");
assert.equal(first.playerDeck.deckType, 10);
assert.equal(first.playerDeck.units.length, 4);
assert.equal(first.shipInitHp, 1);
assert.throws(() => explore.move(user, 0), /resolve/);
assert.throws(() => explore.prepareGameLoad(user, { exploreID: 1, dungeonID: 999 }), /dungeon/);
explore.completeBattle(user, first, { diveShipCurHp: 60, diveShipMaxHp: 100, killCount: 2 }, { win: true });
assert.equal(run.currentHp, 60);
assert.equal(run.state, explore.STATE.SELECT_REWARD);
assert.equal(explore.completeBattle(user, first, { diveShipCurHp: 0, diveShipMaxHp: 100 }, { win: false }), null, "duplicate results cannot alter HP or advance again");
assert.equal(run.currentHp, 60);
const afterRestart = JSON.parse(JSON.stringify(user));
assert.equal(afterRestart.localExplore.runId, initialRunId);
assert.equal(afterRestart.localExplore.state, 40);
assert.throws(() => explore.selectReward(user, { id: 999999, value: 1 }), /selection/);
explore.selectReward(user, run.selectionList[0]);

function finishSelections(account) {
  for (let guard = 0; guard < 10; guard += 1) {
    const current = explore.getRun(account);
    if (current.state === explore.STATE.SELECT_EVENT) {
      const row = explore.getCatalog().stages.find(r => r.StageID === current.zone.steps[current.currentStep].stages[current.currentSlotIndex].stageId);
      const choices = explore.getCatalog().events.filter(e => e.EventGroupID === Number(row.EventValue));
      const selected = choices.find(e => e.EventType === "SKIP") || choices.find(e => e.EventType === "INSTANT_REWARD") || choices[0];
      explore.selectEvent(account, { id: selected.EventID, value: 0 });
    } else if (current.state === explore.STATE.SELECT_REWARD) explore.selectReward(account, current.selectionList[0]);
    else if (current.state === explore.STATE.SET_UNIT) explore.handlerPayload(account, 1269, { choiceItem: current.rewardValue, targetUid: Object.keys(current.squad.units)[0], skip: false });
    else if (current.state === explore.STATE.SET_OPERATOR) explore.handlerPayload(account, 1271, { choiceItem: current.rewardValue, skip: false });
    else if (current.state === explore.STATE.UPGRADE_SHIP) explore.handlerPayload(account, 1273, { shipId: current.selectionList[0] && current.selectionList[0].id || current.rewardValue.id, skip: false });
    else return;
  }
  throw new Error("selection flow did not resolve");
}
finishSelections(user);

let fights = 1;
let zones = 1;
for (let guard = 0; guard < 200 && run.state !== explore.STATE.CLEAR; guard += 1) {
  finishSelections(user);
  if ([explore.STATE.START, explore.STATE.EXPLORING].includes(run.state)) {
    if (run.currentStep === run.zone.steps.length - 1) {
      const hp = run.currentHp;
      explore.enter(user, 1); zones += 1;
      assert.equal(run.currentHp, hp, "ENTER next zone preserves the surviving ship HP");
      continue;
    }
    const node = run.currentStep >= 0 ? run.zone.steps[run.currentStep].stages[run.currentSlotIndex] : null;
    const pathRow = node && explore.getCatalog().paths.find(p => p.PathPatternGroupID === explore.getCatalog().templets[0].PathPatternGroupID && p.PathPatternID === node.pathId);
    const slot = pathRow ? pathRow.MoveAblePathList[0] : 0;
    explore.move(user, slot);
  }
  finishSelections(user);
  if (run.state === explore.STATE.BATTLE_READY) {
    const stage = explore.prepareGameLoad(user, { exploreID: 1, selectDeckIndex: 0 });
    assert.equal(stage.shipInitHp, run.currentHp / run.maxHp);
    explore.completeBattle(user, stage, { diveShipCurHp: 60, diveShipMaxHp: 100 }, { win: true });
    fights += 1;
  }
}
finishSelections(user);
assert.equal(run.state, explore.STATE.CLEAR);
assert.equal(zones, 3);
assert(fights > 10);
assert.equal(JSON.stringify(user.army), originalArmy, "exploration units do not enter the account inventory");
assert(run.enhancePoint > 0);
const tail = explore.serializeGameEndParts(user);
assert.equal(tail.explore[0], 1);
assert.equal(tail.squad[0], 1);
assert.equal(codec.readSignedVarInt(tail.enhancePoint).value, run.enhancePoint);

explore.reset(user);
explore.enter(user, 1);
run = user.localExplore;
assert.notEqual(run.runId, initialRunId);
assert.equal(run.currentHp, 100);
explore.move(user, 0);
const defeat = explore.prepareGameLoad(user, { exploreID: 1 });
explore.completeBattle(user, defeat, { diveShipCurHp: 0, diveShipMaxHp: 100 }, { win: false });
assert.equal(run.state, explore.STATE.ANNIHILATION);
assert.equal(run.currentHp, 0);
assert.throws(() => explore.enter(user, 1), /reset/);

const registry = loadPacketHandlers([path.resolve(__dirname, "../packet-handlers"), path.resolve(__dirname, "../modules")], { rootDir: path.resolve(__dirname, "..") });
for (const id of [1255,1257,1259,1261,1263,1265,1267,1269,1271,1273]) assert(registry.get(id).fileName.includes("modules/explore/handlers/"), `${id} must reach the exploration specialist`);
let lastAck;
const ctx = { config: { USE_LOCAL_USER_DB: true }, decryptCopy: p => p, saveUserDb() {}, sendGameResponse(_socket,_packet,id,payload) { lastAck = { id, payload }; }, sendResponse(_socket,_sequence,id,build) { lastAck = { id, payload: build() }; }, buildEncryptedPacket(_sequence,_id,payload) { return payload; } };
const socket = { session: { user } };
registry.get(1261).handle(ctx, socket, { payload: Buffer.alloc(0), sequence: 1 });
registry.get(1257).handle(ctx, socket, { payload: codec.writeSignedVarInt(1), sequence: 2 });
assert.equal(lastAck.id, 1258);
assert.equal(codec.readSignedVarInt(lastAck.payload).value, 0);
run = user.localExplore;
const index = codec.writeNullableObject(codec.buildDeckIndexData({ deckType: 10, index: 0 }));
const uid = Object.keys(run.squad.units)[0];
registry.get(1606).handle(ctx, socket, { sequence: 3, payload: Buffer.concat([index,codec.writeByte(0),codec.writeSignedVarLong(0n)]) });
assert.equal(codec.readSignedVarInt(lastAck.payload).value, 0);
assert.equal(run.deck.unitUids[0], 0);
registry.get(1606).handle(ctx, socket, { sequence: 4, payload: Buffer.concat([index,codec.writeByte(5),codec.writeSignedVarLong(BigInt(uid))]) });
assert.equal(codec.readSignedVarInt(lastAck.payload).value, 0);
assert.equal(run.deck.unitUids[5], uid);
registry.get(1606).handle(ctx, socket, { sequence: 5, payload: Buffer.concat([index,codec.writeByte(0),codec.writeSignedVarLong(123n)]) });
assert.notEqual(codec.readSignedVarInt(lastAck.payload).value, 0);
assert.equal(JSON.stringify(user.army), originalArmy);
registry.get(1263).handle(ctx, socket, { sequence: 6, payload: codec.writeSignedVarInt(0) });
assert.equal(lastAck.id, 1264);
assert.equal(codec.readSignedVarInt(lastAck.payload).value, 0);
registry.get(1275).handle(ctx, socket, { sequence: 7, payload: codec.writeSignedVarInt(1) });
assert.notEqual(codec.readSignedVarInt(lastAck.payload).value, 0, "unsupported enhancement has no fake success");
console.log(`[explore-continuation] PASS fights=${fights} zones=${zones}; native states, paths, squad/deck, HP, rewards, persistence, duplicate results and handler routing`);
