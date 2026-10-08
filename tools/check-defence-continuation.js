"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const codec = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const rootDir = path.join(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
assert(handlers.get(3902).fileName.includes("0000-3902-defence"));
const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function functions(first, after) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${after}(`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const sent = [];
let stopped = 0;
const sandbox = {
  ...codec, Buffer, USE_LOCAL_USER_DB: false,
  extractManagedBattleRecords: (meta) => meta.battleRecords || [],
  extractManagedBattlePlayTime: (meta) => meta.battlePlayTime || 0,
  extractManagedBattleWin: (meta) => meta.battleWin ?? null,
  buildBattleGameRecordState: (state, override) => override.managedBattleRecords ? { ...state, unitRecords: override.managedBattleRecords } : state,
  getBattleEndPlayTime: (state, override) => override.managedBattlePlayTime || state.gameTime || 0,
  isBattleWin: (state) => state.win === true,
  resolveDungeonMissionResults: (_id, { win }) => ({ missionResult1: win, missionResult2: false }),
  buildBattleMissionState: (state) => state,
  isBTeamType: (team) => Number(team) === 3 || Number(team) === 4,
  positiveInt: (n) => Math.max(0, Number(n || 0)),
  ensureMiscStageState: (user) => user.miscStages ||= {},
  buildDungeonClearData: () => Buffer.alloc(0),
  buildBattleDeckIndexData: () => Buffer.alloc(0),
  buildBattleGameRecordData: () => Buffer.alloc(0),
  buildCommonProfileData: () => Buffer.alloc(0),
  buildGuildSimpleData: () => Buffer.alloc(0),
  stopGameSyncTimers: () => { stopped++; },
  sendServerGamePacket: (_socket, id, payload) => sent.push({ id, payload }),
};
vm.createContext(sandbox);
vm.runInContext(functions("sendDefenceGameEnd", "buildDefenceGameStartAckPayload"), sandbox);
vm.runInContext(functions("buildDefenceInfoAckPayload", "ensureMiscStageState"), sandbox);

const user = {};
function socketWithScore(kills) {
  return { session: { user, gameReplay: {
    dynamicGame: { miscMode: "defence", defenceTempletId: 1, dungeonID: 8030001, stageID: 8030001 },
    battleState: { win: true, gameTime: 80, unitRecords: {
      1: { teamType: 1, recordDieCount: 100 },
      3: { teamType: 3, recordDieCount: kills },
    } },
  } } };
}
const socket = socketWithScore(13);
assert(sandbox.sendDefenceGameEnd(socket));
assert(sandbox.sendDefenceGameEnd(socket));
assert.equal(sent.length, 1, "a Defence result is settled and sent once");
assert.equal(sent[0].id, 3906, "use the Defence result protocol, rather than generic 811");
assert.equal(stopped, 1);
assert.equal(user.miscStages.defence[1].bestScore, 13, "local score counts actual enemy deaths");
assert.equal(socket.session.gameReplay.dynamicBattleResultSent, true);
assert(sandbox.sendDefenceGameEnd(socketWithScore(4)));
assert.equal(user.miscStages.defence[1].bestScore, 13, "a lower later score preserves the record");
const info = sandbox.buildDefenceInfoAckPayload(1, user);
let offset = 0;
for (const value of [0, 1, 13]) {
  const decoded = codec.readSignedVarInt(info, offset);
  assert.equal(decoded.value, value);
  offset = decoded.offset;
}
assert.equal(info[offset], 1, "INFO returns the persisted mission medal");

const giveupSocket = socketWithScore(3);
const acks = [];
handlers.get(3902).handle({
  sendGameResponse: (_socket, _packet, id, payload) => acks.push({ id, payload }),
  sendDefenceGameEnd: sandbox.sendDefenceGameEnd,
  abandonDynamicBattle: (target) => { target.session.gameReplay.dynamicGame = null; },
}, giveupSocket, {});
assert.equal(acks[0].id, 3903);
assert.equal(codec.readSignedVarInt(acks[0].payload).value, 0);
assert.equal(sent.at(-1).id, 3906);
assert.equal(sent.at(-1).payload[1], 0, "giving up cannot count as a victory");
const userBeforeRewards = JSON.stringify(user);
for (const id of [3907, 3911, 3913]) {
  let response;
  handlers.get(id).handle({ sendGameResponse: (_socket, _packet, _id, payload) => { response = payload; } }, { session: { user } }, {});
  assert.equal(codec.readSignedVarInt(response).value, 1, "unimplemented official seasonal rewards return an error");
}
assert.equal(JSON.stringify(user), userBeforeRewards);

const combatSource = fs.readFileSync(path.join(rootDir, "combat-handler/index.js"), "utf8");
const loopSandbox = {
  console: { log() {} }, Date, config: { DYNAMIC_BATTLE_MANAGER: true }, constants: { GAME_END_NOT: 811 },
  buildSyncPackets: () => [{ packetId: 822, payload: Buffer.from([0]) }, { packetId: 3906, payload: Buffer.from([0]) }, { packetId: 822, payload: Buffer.from([1]) }],
  clearTimeout() {}, setTimeout() { throw new Error("a completed Defence battle must not schedule another tick"); },
};
vm.createContext(loopSandbox);
vm.runInContext(combatSource.slice(combatSource.indexOf("  function startBattleLoop("), combatSource.indexOf("  function transitionTutorialReplayToDynamic(")), loopSandbox);
const loopSocket = { session: { gameReplay: { dynamicGame: {}, battleState: {} } } };
const outboundIds = [];
let finishCount = 0;
const callbacks = { sendGamePacket: (_socket, id) => outboundIds.push(id), onGameEndPacketSent: () => { finishCount++; } };
assert(loopSandbox.startBattleLoop(loopSocket, "defence-test", callbacks));
assert.deepEqual(outboundIds, [822, 3906]);
assert.equal(finishCount, 1);
assert.equal(loopSocket.session.gameReplay.dynamicBattleTimer, null);
assert.equal(loopSandbox.startBattleLoop(loopSocket, "defence-duplicate", callbacks), false);
console.log("Defence continuation checks passed: protocol 3906, kill score persistence, INFO medals, giveup, no phantom seasonal rewards, and stopped result loop.");
