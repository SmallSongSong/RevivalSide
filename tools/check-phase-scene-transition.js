"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const codec = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
for (const id of [801, 606, 607, 807, 600]) assert.ok(handlers.get(id), `missing real packet handler ${id}`);

let nextGameUid = 700n;
let initialSyncs = 0;
let captured = 0;
let loops = 0;
let cancelledTimers = 0;
let sent = [];
const facadePath = require.resolve("../combat-handler");
const facadeRequire = createRequire(facadePath);
const facadeSandbox = {
  module: { exports: {} }, exports: {}, Buffer,
  process: { ...process, env: { ...process.env, CS_MOD_UNIT_IDS: "" } },
  console: { log() {} },
  require: (name) => name !== "./csharpHost" ? facadeRequire(name) : {
    createCsharpCombatHost: () => ({ enabled: true, hostPath: "synthetic-phase-host", request(command, data) {
      if (command === "warmup") return { ok: true };
      if (command === "startBattle") return {
        ok: true,
        dynamicGame: { managedCombat: true, stageID: data.req.stageID, dungeonID: data.req.dungeonID,
          mapID: 1001, assignedGameUnitUIDs: [], gameUID: data.gameUID, initialUnitsSent: false },
        battleState: { units: [], gameTime: 0, finished: false },
        payload: Buffer.concat([codec.writeSignedVarInt(0), codec.writeSignedVarLong(BigInt(data.gameUID))]),
      };
      assert.equal(command, "buildInitialSync", "loading scenes and pre-807 heartbeats cannot tick the native battle");
      initialSyncs++;
      return { ok: true, packets: [{ packetId: 822, payload: Buffer.from("synthetic-phase-sync") }] };
    } }),
  },
};
vm.createContext(facadeSandbox);
vm.runInContext(fs.readFileSync(facadePath, "utf8"), facadeSandbox, { filename: facadePath });
const combatHandler = facadeSandbox.module.exports.createCombatHandler({
  config: { CSHARP_COMBAT_HOST: true, DYNAMIC_BATTLE_MANAGER: true },
  constants: { GAME_END_NOT: 811, NPT_GAME_SYNC_DATA_PACK_NOT: 822 }, makeDynamicGameUid: () => ++nextGameUid,
});

const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function functions(first, after) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${after}(`, start);
  assert.ok(start >= 0 && end > start, `missing lifecycle function ${first}`);
  return source.slice(start, end);
}
const sandbox = {
  ...codec, Buffer, console: { log() {} }, combatHandler,
  GAME_LOAD_ACK: 804, GAME_LOAD_COMPLETE_ACK: 808, GAME_START_NOT: 809, NPT_GAME_SYNC_DATA_PACK_NOT: 822,
  NGT_FIERCE: 14, USE_LOCAL_USER_DB: false,
  getCapturedServerPayloadTemplate: () => null,
  isTutorialStageId: () => false, isTutorialDungeonId: () => false,
  positiveInt: (value) => Math.max(0, Math.trunc(Number(value) || 0)),
  resolveGameLoadBattleConditionIds: () => [], buildFierceScorePlanForStage: () => ({}),
  applySavedCombatControls() {}, patchGameLoadAckBattleConditionIds: (payload) => payload,
  syncRaidCombatHpForReplay: () => false, sendRaidStateDataForSocket() {},
  sendCapturedTutorialGameLoadAck() { captured++; return true; },
  buildGameLoadCompleteAckPayload: () => codec.writeSignedVarInt(0),
  ensureMiscStageState: (user) => user.miscStages ||= {},
  clearTimeout() { cancelledTimers++; }, clearInterval() { cancelledTimers++; },
  sendServerGamePacket(socket, id, payload) { sent.push({ id, payload, gameUid: socket.session.gameReplay.dynamicGame && socket.session.gameReplay.dynamicGame.gameUID }); },
  sendManagedOrImmediatePackets(socket, packets) { packets.forEach(packet => sandbox.sendServerGamePacket(socket, packet.packetId, packet.payload)); },
  startDynamicBattleManager(socket) {
    if (socket.session.gameReplay.dynamicBattleTimer) return false;
    loops++;
    socket.session.gameReplay.dynamicBattleTimer = { synthetic: true };
    return true;
  },
};
vm.createContext(sandbox);
vm.runInContext(functions("buildDynamicGameLoadPayload", "handleDynamicBattleRespawn"), sandbox);
vm.runInContext(functions("sendPendingGameStartSync", "normalizeManagedCombatPayload"), sandbox);
vm.runInContext(functions("stopGameSyncTimers", "startDynamicBattleManager"), sandbox);
vm.runInContext(functions("buildInitialBattlePackets", "getCapturedServerPayloadTemplate"), sandbox);
vm.runInContext(functions("resolvePhaseBattleResult", "resolveTrimBattleResult"), sandbox);

function setup(replayCaptured = true) {
  initialSyncs = captured = loops = cancelledTimers = 0;
  sent = [];
  const user = { userUid: "1", nickname: "Synthetic phase player", inventory: {}, army: {},
    miscStages: { phase: { stageId: 11663, phaseIndex: 1, dungeonId: 1005562, totalPlayTime: 20 } } };
  const oldGame = { stageID: 11663, dungeonID: 1005562, phaseIndex: 1, phaseDungeonIds: [1005564, 1005562, 1005561], gameUID: 699n };
  const result = sandbox.resolvePhaseBattleResult(oldGame, user, true, 20, {});
  assert.equal(result.next.dungeonId, 1005561, "winning the second battle prepares the third");
  const socket = { session: { user, gameReplay: {
    dynamicGame: oldGame, battleState: { units: [], finished: true, win: true }, dynamicBattleResultSent: true,
    loadCompleteReceived: true, battleSceneEntered: true, lastSceneId: 3, dynamicBattleTimer: { previousBattle: true },
    pendingGameStartBootstrap: false, nextServerSequence: 1,
  } } };
  const ctx = {
    config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: replayCaptured },
    capturedGameFlow: replayCaptured ? { server: [] } : null,
    constants: { GAME_LOAD_ACK: 804, HEART_BIT_ACK: 601 },
    logGameLoadReq() {}, decodeGameLoadReq: () => ({ stageID: 11663, dungeonID: 1005561, selectDeckIndex: 0 }),
    decryptCopy: (payload) => payload, safeReadSignedVarLong: codec.readSignedVarLong, writeSignedVarLong: codec.writeSignedVarLong,
    logCapturedClientPacketMatch() {}, maybeSendTutorialCutsceneClear() { throw new Error("not a tutorial"); },
    sendDynamicGameLoadAck: sandbox.sendDynamicGameLoadAck, sendServerGamePacket: sandbox.sendServerGamePacket,
    sendGameResponse(socket, _packet, id, payload) { sandbox.sendServerGamePacket(socket, id, payload); },
    sendCapturedGameThroughPacketId() { captured++; return true; }, scheduleCapturedGameAutoAdvance() { captured++; },
    sendCapturedGameUntilBeforePacketIds() { captured++; }, sendCapturedHeartbeatReply() { captured++; },
    isTutorialCapturedBootstrapActive: () => false, sendStaminaChargeNotifications() {},
    buildInitialBattlePackets: sandbox.buildInitialBattlePackets, ensureGameStartPackets: sandbox.ensureGameStartPackets,
    sendPendingGameStartSync: sandbox.sendPendingGameStartSync, sendManagedOrImmediatePackets: sandbox.sendManagedOrImmediatePackets,
    startDynamicBattleManager: sandbox.startDynamicBattleManager, abandonDynamicBattle: sandbox.abandonDynamicBattle,
    stopGameSyncTimers: sandbox.stopGameSyncTimers,
    buildGameSyncPackets() { throw new Error("heartbeat cannot bypass the loading gate"); },
  };
  const dispatch = (id, payload = Buffer.alloc(0)) => handlers.get(id).handle(ctx, socket, { payload, sequence: 1 });
  const scene = (id) => dispatch(606, codec.writeSignedVarInt(id));
  const heartbeat = () => dispatch(600, codec.writeSignedVarLong(123n));
  assert.equal(dispatch(801), true);
  const replay = socket.session.gameReplay;
  const uid = replay.dynamicGame.gameUID;
  assert.notEqual(uid, oldGame.gameUID);
  assert.equal(replay.dynamicGame.dungeonID, 1005561);
  assert.equal(replay.battleSceneEntered, false, "the previous GAME scene cannot mark the new battle as entered");
  assert.equal(replay.loadCompleteReceived, false);
  assert.equal(replay.dynamicBattleTimer, null);
  assert.equal(cancelledTimers, 1, "the previous battle timer is stopped during loading");
  assert.deepEqual(sent.map(packet => packet.id), [804]);
  const ackError = codec.readSignedVarInt(sent[0].payload);
  assert.equal(ackError.value, 0);
  assert.equal(codec.readSignedVarLong(sent[0].payload, ackError.offset).value, uid, "804 carries the same new battle UID");
  return { dispatch, scene, heartbeat, replay, socket, uid };
}

const startPackets = () => sent.filter(packet => [808, 809, 822].includes(packet.id));
for (const replayCaptured of [true, false]) {
  for (const prepareScene of [11, 21, 29, 41, 45]) {
    const { dispatch, scene, heartbeat, replay, uid } = setup(replayCaptured);
    scene(prepareScene);
    scene(prepareScene);
    heartbeat();
    dispatch(607);
    assert.equal(replay.dynamicGame.gameUID, uid, `prepare scene ${prepareScene} must preserve the loaded battle`);
    assert.equal(replay.battleSceneEntered, false);
    assert.equal(initialSyncs, 0, "pre-807 heartbeat cannot deploy or emit battle sync");
    assert.equal(startPackets().length, 0);
    dispatch(807);
    assert.deepEqual(startPackets().map(packet => packet.id), [808, 809, 822], "807 must start the battle before scene 3 arrives");
    assert.ok(startPackets().every(packet => packet.gameUid === uid));
    assert.equal(loops, 1);
    assert.equal(initialSyncs, 1);
    assert.equal(replay.dynamicGame.initialUnitsSent, true);
    scene(prepareScene);
    heartbeat();
    dispatch(607);
    assert.equal(replay.dynamicGame.gameUID, uid, "repeated preparation notifications after 807 must also survive");
    scene(3);
    assert.equal(replay.battleSceneEntered, true);
    dispatch(807);
    assert.equal(initialSyncs, 1, "duplicate 807 cannot respawn the new phase");
    assert.equal(startPackets().length, 3);
    assert.equal(replay.dynamicGame.gameUID, uid);
    assert.equal(captured, 0);
    scene(11);
    assert.equal(replay.dynamicGame, null, "leaving an actually entered GAME scene abandons the battle");
    assert.equal(replay.dynamicBattleTimer, null);
    assert.equal(cancelledTimers, 2);
  }
}

{
  const { dispatch, scene, replay, uid } = setup();
  dispatch(807);
  scene(11);
  assert.equal(replay.dynamicGame.gameUID, uid, "out-of-order 807 before scene 11 must preserve the new battle");
  scene(11);
  dispatch(807);
  assert.deepEqual(startPackets().map(packet => packet.id), [808, 809, 822]);
  scene(3);
  assert.equal(replay.dynamicGame.gameUID, uid);
}
for (const cancelScene of [2, 9]) {
  for (const alreadyLoaded of [false, true]) {
    const { scene, replay, dispatch } = setup();
    if (alreadyLoaded) dispatch(807);
    scene(cancelScene);
    assert.equal(replay.dynamicGame, null, "Home/Operation cancels the loading battle");
    assert.equal(replay.battleState, null);
    assert.equal(replay.dynamicBattleTimer, null);
    assert.equal(cancelledTimers, alreadyLoaded ? 2 : 1);
    assert.equal(replay.pendingGameStartBootstrap, false);
    dispatch(807);
    assert.equal(startPackets().length, alreadyLoaded ? 3 : 0, "cancelled loading must not emit another bootstrap");
  }
}

console.log("[phase-scene-transition] PASS third-phase UID continuity, preparation scenes, heartbeat/607/807 ordering, one bootstrap, and deliberate exits");
