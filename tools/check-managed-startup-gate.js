"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const codec = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const rootDir = path.resolve(__dirname, "..");
const registry = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const gameLoad = registry.get(801);
const loadComplete = registry.get(807);
const respawn = registry.get(816);
assert.ok(gameLoad.fileName.endsWith("0801-game-load-req.js"));

const starts = [];
let hostMode = "enum-error";
const managedAck = Buffer.concat([codec.writeSignedVarInt(0), codec.writeNullableObject(Buffer.from("synthetic-managed-game-data")), codec.writeObjectList([])]);
const createMockHost = ({ enabled }) => ({
  enabled, hostPath: "synthetic-test-host", close() {},
  request(command, data) {
    if (command === "warmup") return hostMode === "enum-error"
      ? { ok: false, error: "System.TypeInitializationException: synthetic enum registry failure" } : { ok: true };
    assert.equal(command, "startBattle", "failed startup must not send managed deploy/sync commands");
    starts.push({ mode: hostMode, command, data });
    if (hostMode === "enum-error") return { ok: false, error: "System.TypeInitializationException: synthetic enum registry failure" };
    const response = {
      ok: true,
      dynamicGame: { managedCombat: true, stageID: 999777, dungeonID: 999778, mapID: 1001, assignedGameUnitUIDs: [] },
      battleState: { units: [], gameTime: 0, finished: false },
    };
    if (hostMode !== "missing-payload") response.payload = hostMode === "empty-payload" ? Buffer.alloc(0) : managedAck;
    return response;
  },
});

// Execute the production facade; only its managed process dependency is replaced.
const facadePath = require.resolve("../combat-handler");
const facadeRequire = createRequire(facadePath);
const facadeSandbox = {
  module: { exports: {} }, exports: {}, Buffer,
  process: { ...process, env: { ...process.env, CS_MOD_UNIT_IDS: "" } },
  console: { log() {} }, setInterval, clearInterval,
  require: (name) => name === "./csharpHost" ? { createCsharpCombatHost: createMockHost } : facadeRequire(name),
};
vm.createContext(facadeSandbox);
vm.runInContext(fs.readFileSync(facadePath, "utf8"), facadeSandbox, { filename: facadePath });
const createFacade = (enabled = true) => facadeSandbox.module.exports.createCombatHandler({
  config: { CSHARP_COMBAT_HOST: enabled, DYNAMIC_BATTLE_MANAGER: true },
  constants: { GAME_END_NOT: 811, NPT_GAME_SYNC_DATA_PACK_NOT: 822 }, makeDynamicGameUid: () => 123n,
});
const facade = createFacade();
assert.equal(facade.getStartupStatus().ready,false);
assert.match(facade.getStartupStatus().error,/synthetic enum registry failure/);
const startupSnapshot = facade.getStartupStatus();
startupSnapshot.ready = true;
assert.equal(facade.getStartupStatus().ready,false,"callers cannot mutate the startup gate");
const stale = { dynamicGame: { managedCombat: true }, battleState: { units: [] }, managedGameLoadAckPayload: Buffer.from("stale") };
assert.equal(facade.startBattle({ replay: stale, req: {} }), null);
assert.equal(stale.dynamicGame, null);
assert.equal(stale.battleState, null);
assert.equal(stale.managedGameLoadAckPayload, null);
assert.match(stale.lastBattleStartError, /synthetic enum registry failure/);
hostMode = "missing-payload";
assert.equal(facade.startBattle({ replay: stale, req: {} }), null);
assert.match(stale.lastBattleStartError, /did not return GAME_LOAD_ACK/);
hostMode = "success";
assert.ok(facade.startBattle({ replay: stale, req: {} }));
assert.equal(stale.lastBattleStartError, null, "a successful retry clears the preceding failure");
assert.equal(stale.managedGameLoadAckPayload, managedAck);

const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function functions(first, after) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${after}(`, start);
  assert.ok(start >= 0 && end > start, `missing production function ${first}`);
  return source.slice(start, end);
}
const counts = { captured: 0, hydratedSuccess: 0, bootstraps: 0, rewards: 0, clears: 0, loops: 0 };
let sent = [];
const sandbox = {
  ...codec, Buffer, console: { log() {} }, combatHandler: facade,
  GAME_LOAD_ACK: 804, GAME_RESPAWN_ACK: 817, NPT_GAME_SYNC_DATA_PACK_NOT: 822,
  NGT_FIERCE: 14, DYNAMIC_BATTLE_MANAGER: true,
  stopGameSyncTimers() {},
  getCapturedServerPayloadTemplate: () => Buffer.from("captured-804-must-not-rescue-failed-native-start"),
  isTutorialStageId: () => false, isTutorialDungeonId: () => false,
  positiveInt: (value) => Math.max(0, Math.trunc(Number(value) || 0)),
  resolveGameLoadBattleConditionIds: () => [], buildFierceScorePlanForStage: () => ({}),
  applySavedCombatControls() {}, patchGameLoadAckBattleConditionIds: (payload) => payload,
  syncRaidCombatHpForReplay: () => false,
  sendCapturedTutorialGameLoadAck() { counts.captured++; return true; },
  sendRaidStateDataForSocket() {},
  sendServerGamePacket(_socket, id, payload) { sent.push({ id, payload }); },
  sendManagedOrImmediatePackets(_socket, packets) { sent.push(...packets); },
  startDynamicBattleManager() { counts.loops++; },
  recordMainStoryDungeonClear() { counts.clears++; return true; },
  recordGenericDungeonClear() { counts.clears++; return true; },
  getOrGrantStageClearLoot() { counts.rewards++; throw new Error("failed battles must not grant rewards"); },
};
vm.createContext(sandbox);
vm.runInContext(functions("buildDynamicGameLoadPayload", "handleDynamicBattlePause"), sandbox);
vm.runInContext(functions("maybeRecordDynamicBattleClear", "recordMainStoryDungeonClear"), sandbox);
vm.runInContext(functions("buildDynamicGameEndNotPayload", "resolvePhaseBattleResult"), sandbox);

const user = { userUid: "synthetic-test-user", level: 30, inventory: { misc: {}, equips: {}, skins: [] }, army: {} };
const socket = { session: { user, gameReplay: {} } };
const request = { stageID: 999777, dungeonID: 999778, selectDeckIndex: 0 };
const stage = { stageId: request.stageID, dungeonID: request.dungeonID, tutorial: false,
  playerDeck: { userUid: user.userUid, nickname: "Synthetic", units: [], shipUid: "0", shipUnitId: 0 } };
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: true }, capturedGameFlow: {},
  constants: { GAME_LOAD_ACK: 804, GAME_RESPAWN_ACK: 817 },
  logGameLoadReq() {}, decodeGameLoadReq: () => ({ ...request }), getGenericStageForRequest: () => ({ ...stage }),
  logCapturedClientPacketMatch() {}, maybeSendTutorialCutsceneClear() { counts.clears++; },
  sendDynamicGameLoadAck: sandbox.sendDynamicGameLoadAck,
  sendGameResponse(_socket, _packet, id, payload) {
    if (codec.readSignedVarInt(payload).value === 0) counts.hydratedSuccess++;
    sent.push({ id, payload });
  },
  sendCapturedGameThroughPacketId() { counts.captured++; return true; },
  scheduleCapturedGameAutoAdvance() { counts.captured++; },
  sendCapturedGameUntilBeforePacketIds() { counts.captured++; },
  isTutorialCapturedBootstrapActive: () => false,
  sendCapturedTutorialLoadCompleteBootstrap() { counts.captured++; return true; },
  sendCapturedTutorialThroughPacketId() { counts.captured++; return true; },
  sendCapturedTutorialUntilBeforePacketIds() { counts.captured++; }, maybeTransitionTutorialReplayToDynamic() {},
  buildInitialBattlePackets() { counts.bootstraps++; return []; }, ensureGameStartPackets: (packets) => packets,
  sendPendingGameStartSync() { counts.bootstraps++; },
  handleDynamicBattleRespawn: sandbox.handleDynamicBattleRespawn,
  decodeGameRespawnReq: () => ({ unitUID: "1", assistUnit: false, respawnPosX: 400, gameTime: 0 }),
};
const initialUser = JSON.stringify(user);

function assertFailedRoute(mode, handler = facade) {
  hostMode = mode;
  sandbox.combatHandler = handler;
  socket.session.gameReplay = {};
  sent = [];
  assert.equal(gameLoad.handle(ctx, socket, { payload: Buffer.alloc(0), sequence: 1 }), true);
  const replay = socket.session.gameReplay;
  assert.equal(sent.length, 1, "failed 801 must emit exactly one error ACK");
  assert.equal(sent[0].id, 804);
  assert.ok(sent[0].payload.length > 0, "failed 801 must emit a decodable nonempty error ACK");
  assert.notEqual(codec.readSignedVarInt(sent[0].payload).value, 0);
  assert.equal(replay.dynamicGame, null);
  assert.equal(replay.battleState, null);
  assert.equal(replay.managedGameLoadAckPayload, null);
  assert.ok(replay.lastBattleStartError);
  if (handler === facade) {
    const deployed = handler.handleDeploy({ replay, req: { unitUID: "1", respawnPosX: 400, gameTime: 0 } });
    assert.equal(deployed.handled, false, "the facade must reject deployment after native startup failure");
    assert.equal(replay.battleSim, null);
  }
  const sentBeforeExtraRequests = sent.length;
  loadComplete.handle(ctx, socket);
  respawn.handle(ctx, socket, { payload: Buffer.alloc(0) });
  assert.equal(sent.length, sentBeforeExtraRequests, "late 807/816 cannot bootstrap or deploy a rejected battle");
  assert.equal(replay.battleSim, null, "a rejected native start must not create a JS simulation");
  assert.equal(handler.isFinished(replay), false);
  assert.equal(handler.getResult(replay), null, "a failed start cannot produce a fake win");
  assert.equal(sandbox.maybeRecordDynamicBattleClear(socket), false);
  assert.equal(sandbox.buildDynamicGameEndNotPayload(replay, { user }), null);
  assert.equal(JSON.stringify(user), initialUser, "failed startup must not change the account or its rewards");
  assert.deepEqual(counts, { captured: 0, hydratedSuccess: 0, bootstraps: 0, rewards: 0, clears: 0, loops: 0 });
}

assertFailedRoute("enum-error");
assertFailedRoute("missing-payload");
assertFailedRoute("empty-payload");
assertFailedRoute("success", createFacade(false)); // A JS state without native/captured 804 is also rejected.

hostMode = "success";
sandbox.combatHandler = facade;
sent = [];
assert.equal(gameLoad.handle(ctx, socket, { payload: Buffer.alloc(0), sequence: 2 }), true);
assert.equal(sent.length, 1);
assert.equal(sent[0].id, 804);
assert.equal(sent[0].payload, managedAck);
assert.equal(socket.session.gameReplay.lastBattleStartError, null);
assert.ok(socket.session.gameReplay.dynamicGame.managedCombat);
assert.ok(socket.session.gameReplay.battleState);
const startsBeforeRetry = starts.length;
gameLoad.handle(ctx, socket, { payload: Buffer.alloc(0), sequence: 3 });
assert.equal(starts.length, startsBeforeRetry, "an in-flight 801 retry must reuse the accepted native ACK");
assert.equal(sent[1].payload, managedAck);
assert.equal(counts.captured, 0);
assert.equal(JSON.stringify(user), initialUser);

console.log("[managed-startup-gate] PASS production facade and 801/807/816 routes: enum/missing-payload failures, no fallback battle/rewards, retry recovery");
