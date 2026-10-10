"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const story = require("../stages/mainStoryStage");
const codec = require("../modules/packet-codec");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const explore = require("../modules/explore");
const rewardModule = require("../modules/reward");
const { getMiscItem } = require("../modules/inventory");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const rootDir = path.join(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const gameLoad = handlers.get(801);
const loadComplete = handlers.get(807);
const restart = handlers.get(861);
assert(restart.fileName.endsWith("0000-0861-game-restart-req.js"), "restart must use the specialist handler in the real registry");

const source = fs.readFileSync(path.join(__dirname, "../server/listener.js"), "utf8");
function sourceFunctions(first, after) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${after}(`, start);
  assert(start >= 0 && end > start, `missing listener functions ${first}`);
  return source.slice(start, end);
}

let rewards = 0;
let costs = 0;
let clears = 0;
let phaseClearPackets = 0;
let nextState;
const empty = () => Buffer.alloc(0);
const sandbox = {
  NGT_FIERCE: 14, fierceRecords: require("../modules/misc-stages/fierce-result"),
  ...codec, Buffer, console: { log() {} },
  explore,
  NGT_PHASE: 15, NGT_DIVE: 5, NGT_EXPLORE: 29, USE_LOCAL_USER_DB: false,
  stageIdForDungeonId: (id) => (story.getMainStoryStageByDungeonId(id) || {}).stageId || 0,
  resolveDungeonIdForStageProgress: (_stage, game) => game.dungeonID,
  isRaidDynamicGame: () => false,
  buildBattleGameRecordState: (state) => state,
  getBattleEndPlayTime: (state) => state.gameTime || 0,
  buildBattleMissionState: (state) => state,
  resolveBattleWin: (state, override) => override.win ?? state.win,
  resolveDungeonMissionResults: () => ({ missionResult1: true, missionResult2: true }),
  normalizeBattleResultState: (state, win) => { state.win = win; },
  isCutsceneOnlyDungeon: () => false,
  maybeRecordRaidBattleResultForReplay: () => null,
  getOrGrantStageClearLoot: () => { rewards++; return { unitExp: 0 }; },
  spendStageReqItemCostForReplay: () => { costs++; return []; },
  buildMainStoryEpisodeCompleteDataForStage: () => null,
  buildFierceResultState: () => ({}),
  ensureMiscStageState: (user) => user.miscStages ||= {},
  buildDungeonClearData: empty,
  buildPhaseClearData: () => { phaseClearPackets++; return Buffer.alloc(0); },
  buildBattleDeckIndexData: empty,
  buildRaidBossResultData: empty,
  buildBattleGameRecordData: empty,
  buildStagePlayData: empty,
  buildShadowGameResultData: empty,
  buildFierceResultData: empty,
  buildItemMiscData: empty,
  buildPhaseModeState: (...args) => { nextState = args; return Buffer.alloc(0); },
  isBattleWin: (state) => state.win === true,
  recordMainStoryDungeonClear: (socket, id, state) => {
    clears++;
    return story.recordMainStoryDungeonClearForUser(socket.session.user, id, 11663, state, { save: null });
  },
  recordGenericDungeonClear: () => false,
};
vm.createContext(sandbox);
vm.runInContext(sourceFunctions("buildDynamicGameEndNotPayload", "buildBattleGameRecordState"), sandbox);
vm.runInContext(sourceFunctions("maybeRecordDynamicBattleClear", "recordMainStoryDungeonClear"), sandbox);
Object.assign(sandbox, {
  cachedMiscStageCatalog: null,
  readMiscStageRecords: (file) => readGameplayTableRecords("ab_script", file, { rootDir: path.join(__dirname, "..") }),
  getDungeonTableEntryByStrId: (strId) => readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", { rootDir: path.join(__dirname, "..") }).find((row) => row.m_DungeonStrID === strId),
  NGT_SHADOW_PALACE: 13, NGT_TRIM: 23,
});
vm.runInContext(sourceFunctions("positiveInt", "readMiscStageRecords"), sandbox);
vm.runInContext(sourceFunctions("mapListPush", "choosePhaseOrder"), sandbox);
vm.runInContext(sourceFunctions("resolveMiscStageRequest", "classifyMiscDungeon"), sandbox);
vm.runInContext(sourceFunctions("buildTrimModeState", "buildFierceDataAckPayload"), sandbox);
vm.runInContext(sourceFunctions("buildTrimIntervalData", "buildSelectableContractStateData"), sandbox);
const stageRows = readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir });
const dungeonRows = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", { rootDir });
const mapRows = readGameplayTableRecords("ab_script", "LUA_MAP_TEMPLET.json", { rootDir });
Object.assign(sandbox, {
  NGT_DUNGEON: 1, NGT_CUTSCENE: 9, NGT_FIERCE: 14, NGT_PVE_DEFENCE: 26,
  getStageTableEntry: (id) => stageRows.find((row) => Number(row.m_StageID) === Number(id)),
  getDungeonTableEntry: (id) => dungeonRows.find((row) => Number(row.m_DungeonID) === Number(id)),
  getEventDeckTemplet: require("../modules/game-data").getEventDeckTemplet,
  mapIdForMapStrId: (strId) => Number((mapRows.find((row) => row.m_MapStrID === strId) || {}).m_MapID || 0),
  findStageRowForDungeonId: (id) => {
    const dungeon = dungeonRows.find((row) => Number(row.m_DungeonID) === Number(id));
    return stageRows.find((row) => dungeon && row.m_StageBattleStrID === dungeon.m_DungeonStrID) || null;
  },
  findStageIdForDungeonId: (id) => (story.getMainStoryStageByDungeonId(id) || {}).stageId || 0,
});
vm.runInContext(sourceFunctions("normalizePositiveIntList", "battleConditionLevelEntries"), sandbox);
vm.runInContext(sourceFunctions("classifyMiscDungeon", "mapIdForMapStrId"), sandbox);
let phaseBattlesChecked = 0;
for (const row of stageRows.filter((row) => row.m_StageType === "ST_PHASE")) {
  const phaseTemplet = sandbox.loadMiscStageCatalog().phaseByStrId.get(row.m_StageBattleStrID);
  const orders = sandbox.loadMiscStageCatalog().phaseOrdersByGroup.get(phaseTemplet.m_PhaseGroupID);
  for (const [index, order] of orders.entries()) {
    const dungeon = sandbox.getDungeonTableEntryByStrId(order.m_DungeonStrID);
    const req = { stageID: row.m_StageID, dungeonID: dungeon.m_DungeonID };
    const selected = story.getMainStoryStageForRequest(req) || sandbox.getGenericStageForRequest(req);
    assert.equal(selected.dungeonID, dungeon.m_DungeonID, `phase child routing for ${row.m_StageID}`);
    assert.equal(selected.phaseIndex, index);
    assert.equal(selected.phaseDungeonIds.length, orders.length);
    assert.equal(selected.gameType, 15);
    phaseBattlesChecked++;
  }
}
assert.equal(phaseBattlesChecked, 53, "all 18 main/side/event phase chains and 53 child battles are checked");
for (const palace of sandbox.loadMiscStageCatalog().shadowPalaceById.values()) {
  const battles = sandbox.loadMiscStageCatalog().shadowBattlesByGroup.get(palace.BATTLE_GROUP_ID);
  for (const battle of battles) {
    const selected = sandbox.getGenericStageForRequest({ stageID: battle.DUNGEON_ID, dungeonID: battle.DUNGEON_ID, palaceID: palace.PALACE_ID });
    assert.equal(selected.dungeonID, battle.DUNGEON_ID);
    assert.equal(selected.shadowBattleOrder, battle.BATTLE_ORDER);
    assert.equal(selected.gameType, 13);
  }
}
assert.equal(sandbox.loadMiscStageCatalog().shadowBattleByDungeonId.size, 25);
for (const trimId of sandbox.loadMiscStageCatalog().trimById.keys()) {
  for (let level = 1; level <= 20; level++) {
    const rows = sandbox.getTrimStageRows(trimId, level);
    assert.equal(rows.length, 3, `trim ${trimId} level ${level} selects its three matching battles`);
    for (const row of rows) {
      const selected = sandbox.getGenericStageForRequest({ stageID: row.DungeonID, dungeonID: row.DungeonID, trimId, trimLevel: level });
      assert.equal(selected.dungeonID, row.DungeonID);
      assert.equal(selected.trimLevel, level);
      assert.equal(selected.trimStageList.length, 3);
    }
  }
}
vm.runInContext(sourceFunctions("readNkmEventDeckData", "decodeGameRespawnReq"), sandbox);
const eventSelection = Buffer.concat([
  codec.writeSignedVarLong(456n), codec.writeVarInt(1), codec.writeSignedVarInt(2), codec.writeSignedVarLong(123n),
  codec.writeSignedVarLong(789n), codec.writeSignedVarInt(2),
]);
let decodedStart;
const startCtx = {
  decryptCopy: (raw) => raw,
  readNkmEventDeckData: sandbox.readNkmEventDeckData,
  buildPhaseStartAckPayload: (req) => { decodedStart = req; return Buffer.alloc(0); },
  buildTrimStartAckPayload: (req) => { decodedStart = req; return Buffer.alloc(0); },
  sendGameResponse() {},
};
handlers.get(1227).handle(startCtx, { session: { user: {} } }, { payload: Buffer.concat([
  codec.writeSignedVarInt(11663), codec.writeBool(true), codec.writeSignedVarInt(1), codec.writeByte(2),
  codec.writeBool(true), eventSelection, codec.writeSignedVarLong(99999887766n),
]) });
assert.equal(decodedStart.deckIndex.index, 2);
assert.equal(decodedStart.eventDeckData.units[2], 123n);
assert.equal(decodedStart.supportingUserUid, 99999887766n, "phase support UID is decoded after the selected event deck");
handlers.get(1234).handle(startCtx, { session: { user: {} } }, { payload: Buffer.concat([
  codec.writeSignedVarInt(101), codec.writeSignedVarInt(5), codec.writeVarInt(3),
  codec.writeBool(true), eventSelection, codec.writeBool(false), codec.writeBool(false),
]) });
assert.equal(decodedStart.eventDeckList.length, 3);
assert.equal(decodedStart.eventDeckList[0].shipUid, 456n, "trim preserves each selected battle formation");

const phase = story.getMainStoryStageByStageId(11663);
assert.deepEqual(phase.phaseDungeonIds, [1005564, 1005562, 1005561], "5-6 runs Knight, Queen, then King");
assert.equal(phase.gameType, 15);
const user = { userUid: "1", army: {}, inventory: {} };
for (const [index, dungeonID] of phase.phaseDungeonIds.entries()) {
  const selected = story.getMainStoryStageForRequest({ stageID: 11663, dungeonID });
  assert.equal(selected.dungeonID, dungeonID);
  assert.equal(selected.phaseIndex, index);
  let loadedStage;
  gameLoad.handle({
    config: { DYNAMIC_BATTLE_MANAGER: true },
    logGameLoadReq() {}, decodeGameLoadReq: () => ({ stageID: 11663, dungeonID, selectDeckIndex: 0 }),
    sendDynamicGameLoadAck: (_socket, _req, stage) => { loadedStage = stage; return true; },
  }, { session: { user, gameReplay: {} } }, { payload: Buffer.alloc(0) });
  assert.equal(loadedStage.dungeonID, dungeonID, "GAME_LOAD_REQ preserves the requested child battle");
  if (index > 0) assert.equal(loadedStage.shipInitHp, 0.7, "next phase retains ship HP");
  const replay = {
    dynamicGame: { ...selected, stageID: 11663, gameUID: String(index + 1) },
    battleState: { win: true, gameTime: 20, diveShipCurHp: 70, diveShipMaxHp: 100 },
  };
  nextState = null;
  const payload = sandbox.buildDynamicGameEndNotPayload(replay, { user });
  assert.equal(payload[0], 1);
  const socket = { session: { user, gameReplay: replay } };
  sandbox.maybeRecordDynamicBattleClear(socket);
  sandbox.maybeRecordDynamicBattleClear(socket);
  assert.strictEqual(sandbox.buildDynamicGameEndNotPayload(replay, { user }), payload, "duplicate results reuse the first settlement");
  if (index < 2) {
    assert.equal(nextState[1], index + 1);
    assert.equal(nextState[2], phase.phaseDungeonIds[index + 1]);
    assert.equal(nextState[3], (index + 1) * 20);
    assert.equal(rewards, 0);
    assert.equal(clears, 0, "a child battle cannot complete stage 5-6");
  } else {
    assert.equal(nextState, null, "final phase finishes the chain");
    assert.equal(user.miscStages.phase, null);
    assert.equal(rewards, 1);
    assert.equal(clears, 1);
    assert.equal(phaseClearPackets, 1);
    assert.equal(user.stagePlayData[11663].totalPlayCount, 1);
    assert.equal(user.stagePlayData[11663].bestClearTimeSec, 60, "clear time includes every phase");
  }
}
assert.equal(costs, 1, "charge the stage once across all three phases");
assert.equal(story.getMainStoryStageForRequest({ stageID: 11663, dungeonID: 1004 }).dungeonID, 1005564, "unrelated captured dungeons do not replace the selected stage");

function attemptGameLoad(targetUser, req, targetReplay = {}) {
  let loaded = 0;
  let loadedStage;
  let response;
  gameLoad.handle({
    constants: { GAME_LOAD_ACK: 804 },
    config: { DYNAMIC_BATTLE_MANAGER: true },
    logGameLoadReq() {}, decodeGameLoadReq: () => ({ ...req }),
    getGenericStageForRequest: (request) => {
      return sandbox.getGenericStageForRequest(request);
    },
    sendDynamicGameLoadAck: (_socket, _req, stage) => { loaded++; loadedStage = stage; return true; },
    sendGameResponse: (_socket, _packet, id, payload) => { response = { id, payload }; },
  }, { session: { user: targetUser, gameReplay: targetReplay } }, { payload: Buffer.alloc(0) });
  return { loaded, response, loadedStage };
}
const skipped = attemptGameLoad({ userUid: "1" }, { stageID: 11663, dungeonID: 1005561 });
assert.equal(skipped.loaded, 0, "an unstarted chain cannot load its last phase");
assert.equal(codec.readSignedVarInt(skipped.response.payload).value, 1);
const replayed = attemptGameLoad(user, { stageID: 11663, dungeonID: 1005561 });
assert.equal(replayed.loaded, 0, "a completed chain cannot replay its last phase for rewards");
const pendingUser = { miscStages: { phase: { stageId: 11663, phaseIndex: 1, dungeonId: 1005562 } } };
const pendingBefore = JSON.stringify(pendingUser);
assert.equal(attemptGameLoad(pendingUser, { stageID: 11663, dungeonID: 1005561 }).loaded, 0);
assert.equal(JSON.stringify(pendingUser), pendingBefore, "rejected chain requests preserve progression");
assert.equal(attemptGameLoad(pendingUser, { stageID: 11663, dungeonID: 1005562 }).loaded, 1);
const duplicateReq = { stageID: 11663, dungeonID: 1005562 };
const duplicateReplay = { dynamicGame: { gameUID: "existing-battle" }, gameLoadRequestKey: JSON.stringify(duplicateReq), gameLoadAckPayload: Buffer.from([0, 1]), dynamicBattleResultSent: false };
const duplicateResult = attemptGameLoad(pendingUser, duplicateReq, duplicateReplay);
assert.equal(duplicateResult.loaded, 0, "duplicate GAME_LOAD cannot create a new gameUID or clear settlement gates");
assert.strictEqual(duplicateResult.response.payload, duplicateReplay.gameLoadAckPayload);
assert.equal(duplicateReplay.dynamicGame.gameUID, "existing-battle");

const failedUser = { miscStages: { phase: { stageId: 11663, phaseIndex: 0 } } };
const failed = { dynamicGame: { ...phase, stageID: 11663 }, battleState: { win: false, gameTime: 10 } };
sandbox.buildDynamicGameEndNotPayload(failed, { user: failedUser });
assert.equal(failed.phaseBattleResult.completed, false);
assert.equal(failedUser.miscStages.phase, null, "a failed phase cannot advance");
assert.equal(rewards, 1, "a failed phase grants no rewards");

const trimRows = sandbox.getTrimStageRows(101, 5);
assert.deepEqual(Array.from(trimRows, (row) => row.DungeonID), [7001001, 7001002, 7001003], "trim selects three stages for the chosen level");
assert.deepEqual(Array.from(sandbox.getTrimStageRows(101, 9), (row) => row.DungeonID), [7001011, 7001012, 7001013]);
const trimUser = { miscStages: { trim: { current: { trimId: 101, trimLevel: 5, trimStageList: trimRows } } } };
const rewardBeforeTrim = rewards;
const costBeforeTrim = costs;
for (const [index, row] of trimRows.entries()) {
  const selected = sandbox.resolveMiscStageRequest({ trimId: 101, trimLevel: 5, dungeonID: row.DungeonID });
  assert.equal(selected.dungeonID, row.DungeonID, "trim preserves the selected child battle");
  const replay = {
    dynamicGame: { miscMode: "trim", trimId: 101, trimLevel: 5, trimStageList: trimRows, stageID: row.DungeonID, dungeonID: row.DungeonID },
    battleState: { win: true, gameTime: 30 },
  };
  sandbox.buildDynamicGameEndNotPayload(replay, { user: trimUser });
  assert.equal(replay.trimBattleResult.index, index);
  assert.equal(replay.trimBattleResult.completed, index === 2);
  assert.equal(replay.trimBattleResult.state.nextDungeonId, index < 2 ? trimRows[index + 1].DungeonID : 0);
  assert.equal(replay.trimBattleResult.state.trimStageResults.length, index + 1);
  assert.equal(rewards - rewardBeforeTrim, index === 2 ? 1 : 0, "trim settles the chain on its last stage");
}
assert.equal(costs - costBeforeTrim, 1);
assert.equal(trimUser.miscStages.trim.current, null);
assert.equal(trimUser.miscStages.trim.lastClear.trimLevel, 5, "retain the chosen level rather than its table range's lower bound");
assert.equal(trimUser.miscStages.trim.pendingEnd.trimStageResults.length, 3, "final state survives until the native 1240 settlement request");
Object.assign(sandbox, {
  createEmptyReward: rewardModule.createEmptyReward, mergeReward: rewardModule.mergeReward,
  grantRewardByType: rewardModule.grantRewardByType, buildSerializedRewardData: codec.buildRewardData,
  dateTimeBinaryNow: () => 0n, RESOURCE_ITEM_IDS: { CREDIT: 1 },
});
const trimEndHandler = handlers.get(1240);
assert.equal(trimEndHandler.name, "TRIM_END_REQ", "final settlement must use the specialist handler instead of a six-byte hydrated placeholder");
let trimEndPayload;
let trimProgressPayload;
const trimPackets = [];
trimEndHandler.handle({decryptCopy:Buffer.from, buildTrimEndAckPayload:sandbox.buildTrimEndAckPayload,
  buildTrimProgressNotPayload:sandbox.buildTrimProgressNotPayload,
  sendGameResponse(_socket,_packet,id,payload){assert.equal(id,1241);trimEndPayload=payload;trimPackets.push(id);},
  sendServerGamePacket(_socket,id,payload){assert.equal(id,1242);trimProgressPayload=payload;trimPackets.push(id);}},
  {session:{user:trimUser}}, {payload:codec.writeSignedVarInt(101)});
assert(trimEndPayload.length > 6, "native result screen receives the whole chain and clear/reward objects");
assert.equal(codec.readSignedVarInt(trimEndPayload,0).value,0);
assert.equal(trimEndPayload[1],1,"first completed chain is marked as a first clear");
assert.equal(trimUser.miscStages.trim.clearRecords["101:5"].isWin,true);
assert.deepEqual(trimPackets,[1241,1242],"the client receives its clear list as well as the result scene");
assert(trimProgressPayload.equals(sandbox.buildTrimProgressNotPayload(trimUser)));
const trimInventory = JSON.stringify(trimUser.inventory,(_key,value)=>typeof value === "bigint" ? String(value) : value);
assert(sandbox.buildTrimEndAckPayload({trimId:101},trimUser).equals(trimEndPayload),"repeated final request returns cached settlement");
assert.equal(JSON.stringify(trimUser.inventory,(_key,value)=>typeof value === "bigint" ? String(value) : value),trimInventory,"repeated final request cannot duplicate rewards");
const persistedTrim = JSON.parse(JSON.stringify(trimUser,(_key,value)=>typeof value === "bigint" ? String(value) : value));
assert.equal(sandbox.buildTrimClearListForUser(persistedTrim).length,1,"login restores the completed level");
assert(sandbox.buildTrimEndAckPayload({trimId:101},persistedTrim).equals(trimEndPayload),"settlement cache survives restarting the service");
const failedTrim = {miscStages:{trim:{pendingEnd:{trimId:101,trimLevel:5,nextDungeonId:0,
  trimStageList:trimRows,trimStageResults:[{score:1,isWin:true},{score:0,isWin:false}]}}}};
sandbox.buildTrimEndAckPayload({trimId:101},failedTrim);
assert.equal(sandbox.buildTrimClearListForUser(failedTrim).length,0,"an interrupted or lost chain cannot unlock a level");
assert.notEqual(codec.readSignedVarInt(sandbox.buildTrimEndAckPayload({trimId:104},failedTrim),0).value,0,"a request cannot settle another chapter");
if (process.argv[2]) {
  fs.writeFileSync(process.argv[2],JSON.stringify({typeName:"ClientPacket.Mode.NKMPacket_TRIM_END_ACK",payloadBase64:trimEndPayload.toString("base64")}));
  fs.writeFileSync(process.argv[2]+".progress.json",JSON.stringify({packetId:1242,payloadBase64:trimProgressPayload.toString("base64")}));
}
const skipTrimUser = { miscStages: { trim: { current: { trimId: 101, trimLevel: 5, trimStageList: trimRows, nextDungeonId: 7001001 } } } };
assert.equal(attemptGameLoad(skipTrimUser, { stageID: 7001003, dungeonID: 7001003 }).loaded, 0, "trim cannot skip its pending stage");

Object.assign(sandbox, {
  createEmptyReward: rewardModule.createEmptyReward,
  mergeReward: rewardModule.mergeReward,
  grantRewardByType: rewardModule.grantRewardByType,
  dateTimeBinaryNow: () => 0n,
});
let shadowRewardBytes = null;
sandbox.buildSerializedRewardData = (reward) => (shadowRewardBytes = codec.buildRewardData(reward));
vm.runInContext(sourceFunctions("buildShadowGameResultData", "buildFierceResultState"), sandbox);
vm.runInContext(sourceFunctions("buildShadowPalaceStartAckPayload", "buildPhaseStartAckPayload"), sandbox);
vm.runInContext(sourceFunctions("buildShadowPalaceDataForUser", "buildJukeboxData"), sandbox);
vm.runInContext(sourceFunctions("recordMiscStageClearForUser", "buildDungeonSkipAckPayload"), sandbox);
const shadowBattles = sandbox.loadMiscStageCatalog().shadowBattlesByGroup.get(1);
assert.equal(shadowBattles.length, 5);
assert.equal(sandbox.resolveMiscStageRequest({ palaceID: 1001, dungeonID: shadowBattles[1].DUNGEON_ID }).shadowBattleOrder, 2);
const shadowUser = { miscStages: { shadow: { currentPalaceId: 1001, life: 3 } } };
const shadowGame = { palaceID: 1001, dungeonID: shadowBattles[0].DUNGEON_ID };
function shadowResult(game, state, target = shadowUser) {
  shadowRewardBytes = null;
  const bytes = sandbox.buildShadowGameResultData(game, state, { user: target });
  let offset = 0;
  function read(reader) { const data = reader(bytes, offset); offset = data.offset; return data.value; }
  const palaceId = read(codec.readSignedVarInt);
  const dungeonData = read(codec.readBool) ? { dungeonId: read(codec.readSignedVarInt), recentTime: read(codec.readSignedVarInt), bestTime: read(codec.readSignedVarInt) } : null;
  const reward = read(codec.readBool);
  if (reward) { assert(shadowRewardBytes); offset += shadowRewardBytes.length; }
  const newRecord = read(codec.readBool);
  const currentDungeonId = read(codec.readSignedVarInt);
  const life = read(codec.readSignedVarInt);
  assert.equal(offset, bytes.length, "shadow result protocol must consume exactly its bytes");
  return { palaceId, dungeonData, reward, newRecord, currentDungeonId, life };
}
const lossResult = shadowResult(shadowGame, { win: false, gameTime: 10 });
assert.equal(lossResult.dungeonData, null, "a failed battle cannot add a cleared client dungeon");
assert.equal(lossResult.reward, false);
assert.equal(shadowUser.miscStages.shadow.life, 2);
assert.equal(shadowUser.miscStages.shadow.palaces[1001].currentDungeonId, shadowGame.dungeonID, "a shadow loss keeps the same battle");
// The Android DLL's UpdateUserData applies recentTime during the run, then
// clears currentPalaceId and promotes every bestTime only for a non-null reward.
const shadowClient = { currentPalaceId: 1001, dungeonDataList: [] };
for (const [index, battle] of shadowBattles.entries()) {
  const result = shadowResult({ palaceID: 1001, dungeonID: battle.DUNGEON_ID }, { win: true, gameTime: 10 + index });
  shadowClient.dungeonDataList.push({ dungeonId: result.dungeonData.dungeonId, recentTime: result.dungeonData.recentTime, bestTime: 0 });
  if (result.reward) {
    shadowClient.currentPalaceId = 0;
    if (result.newRecord) shadowClient.dungeonDataList.forEach((data) => { data.bestTime = data.recentTime; });
  }
  assert.equal(result.reward, index === 4, "only the fifth win signals whole-palace completion");
  assert.equal(result.newRecord, index === 4, "first whole-palace clear sets every client bestTime");
  if (index < 4) assert.equal(shadowUser.miscStages.shadow.palaces[1001].currentDungeonId, shadowBattles[index + 1].DUNGEON_ID);
  sandbox.recordMiscStageClearForUser(shadowUser, battle.DUNGEON_ID, battle.DUNGEON_ID, { gameTime: 10 + index });
}
assert.equal(shadowClient.currentPalaceId, 0, "native client must leave the in-progress chapter");
assert.equal(shadowClient.dungeonDataList.filter((data) => data.bestTime > 0).length, 5, "native IsClearPalace must unlock palace #2");
assert.equal(shadowUser.miscStages.shadow.currentPalaceId, 0, "later stage progress recording must preserve completed palace state");
assert.equal(BigInt(getMiscItem(shadowUser, 20).countFree), 15n);
assert.equal(BigInt(getMiscItem(shadowUser, 1).countFree), 108000n);
assert.equal(BigInt(getMiscItem(shadowUser, 2013).countFree), 20n);
const persistedShadow = JSON.parse(JSON.stringify(shadowUser, (_key, value) => typeof value === "bigint" ? String(value) : value));
sandbox.buildShadowPalaceDataForUser(persistedShadow);
assert.equal(persistedShadow.miscStages.shadow.currentPalaceId, 0);
assert.equal(persistedShadow.miscStages.shadow.palaces[1001].dungeonDataList.filter((data) => data.bestTime > 0).length, 5);
function readShadowLobbyState(target) {
  const payload = sandbox.buildShadowPalaceDataForUser(target);
  let offset = 0;
  function read(reader) { const data = reader(payload, offset); offset = data.offset; return data.value; }
  const currentPalaceId = read(codec.readSignedVarInt);
  const life = read(codec.readSignedVarInt);
  const palaces = [];
  const count = read(codec.readVarInt);
  for (let index = 0; index < count; index++) {
    assert(read(codec.readBool));
    const palace = { palaceId: read(codec.readSignedVarInt), currentDungeonId: read(codec.readSignedVarInt), dungeonDataList: [] };
    const dungeonCount = read(codec.readVarInt);
    for (let dungeonIndex = 0; dungeonIndex < dungeonCount; dungeonIndex++) {
      assert(read(codec.readBool));
      palace.dungeonDataList.push({ dungeonId: read(codec.readSignedVarInt), recentTime: read(codec.readSignedVarInt), bestTime: read(codec.readSignedVarInt) });
    }
    palaces.push(palace);
  }
  const rewardMultiply = read(codec.readSignedVarInt);
  assert.equal(offset, payload.length, "lobby shadow state must preserve its exact protocol boundary");
  return { currentPalaceId, life, palaces, rewardMultiply };
}
const shadowClientAfterLogin = readShadowLobbyState(persistedShadow);
assert.equal(shadowClientAfterLogin.palaces[0].dungeonDataList.filter((data) => data.bestTime > 0).length, 5, "login must copy local palace best times into the merged client ACK");
sandbox.completeShadowPalaceRun(shadowUser, shadowUser.miscStages.shadow, shadowUser.miscStages.shadow.palaces[1001]);
assert.equal(BigInt(getMiscItem(shadowUser, 20).countFree), 15n, "duplicate completion cannot grant the chapter reward again");
const oldShadow = { miscStages: { shadow: { currentPalaceId: 1001, life: 3, palaces: { 1001: { palaceId: 1001, currentDungeonId: 0, dungeonDataList: shadowBattles.map((battle) => ({ dungeonId: battle.DUNGEON_ID, recentTime: 10, bestTime: 0 })) } } } } };
sandbox.repairCompletedShadowPalaceState(oldShadow);
sandbox.buildShadowPalaceDataForUser(oldShadow);
assert.equal(oldShadow.miscStages.shadow.currentPalaceId, 0, "login recovers the already-finished old local save");
assert.equal(oldShadow.miscStages.shadow.palaces[1001].dungeonDataList.filter((data) => data.bestTime > 0).length, 5);
assert.equal(BigInt(getMiscItem(oldShadow, 20).countFree), 15n);
sandbox.repairCompletedShadowPalaceState(oldShadow);
sandbox.buildShadowPalaceDataForUser(oldShadow);
assert.equal(BigInt(getMiscItem(oldShadow, 20).countFree), 15n, "repeat login does not duplicate recovered rewards");
sandbox.buildShadowPalaceStartAckPayload({ palaceID: 1001 }, shadowUser);
assert(shadowUser.miscStages.shadow.palaces[1001].dungeonDataList.every((data) => data.recentTime === 0 && data.bestTime > 0), "a replay resets run times while preserving the previous clear");
assert.equal(shadowUser.miscStages.shadow.palaces[1001].completionRewardGranted, false);
for (const battle of shadowBattles) {
  const result = shadowResult({ palaceID: 1001, dungeonID: battle.DUNGEON_ID }, { win: true, gameTime: 20 });
  const clientDungeon = shadowClientAfterLogin.palaces[0].dungeonDataList.find((data) => data.dungeonId === result.dungeonData.dungeonId);
  clientDungeon.recentTime = result.dungeonData.recentTime;
  assert.equal(result.newRecord, false, "a slower replay cannot replace the existing full-run record");
}
assert.equal(shadowClientAfterLogin.palaces[0].dungeonDataList.filter((data) => data.bestTime > 0).length, 5, "native unlock still depends on local bestTime from login when newRecord is false");
assert.equal(BigInt(getMiscItem(shadowUser, 20).countFree), 30n, "a fresh complete replay receives exactly one chapter reward");
assert.deepEqual(Array.from(shadowUser.miscStages.shadow.palaces[1001].dungeonDataList, (data) => data.bestTime), [10, 11, 12, 13, 14], "a slower full run preserves the previous full-run record");
const nativeFixturesIndex = process.argv.indexOf("--native-fixtures");
if (nativeFixturesIndex >= 0) {
  const fixturePath = process.argv[nativeFixturesIndex + 1];
  assert(fixturePath && !fixturePath.startsWith("--"), "--native-fixtures requires an output path");
  fs.writeFileSync(fixturePath, JSON.stringify([
    { name: "fresh-five-win-completion", shadowPayload: sandbox.buildShadowPalaceDataForUser(persistedShadow).toString("base64"), expectedUnlock: true },
    { name: "existing-record-after-slower-replay", shadowPayload: sandbox.buildShadowPalaceDataForUser(shadowUser).toString("base64"), expectedUnlock: true },
    { name: "new-empty-palace", shadowPayload: sandbox.buildShadowPalaceDataForUser({}).toString("base64"), expectedUnlock: false },
  ], null, 2));
}
let shadowTicketCount = 0;
sandbox.spendStageReqItemCost = () => { shadowTicketCount++; return [{ itemId: 19, count: 1 }]; };
vm.runInContext(sourceFunctions("spendStageReqItemCostForReplay", "buildPhaseClearData"), sandbox);
for (const gameUID of ["shadow-first-loss", "shadow-first-retry"]) {
  sandbox.spendStageReqItemCostForReplay({ dynamicGame: { ...shadowGame, miscMode: "shadow", gameUID } }, shadowUser, shadowGame.dungeonID);
}
assert.equal(shadowTicketCount, 1, "retrying the first shadow battle consumes its run entry ticket once");

let bootstrapCount = 0;
const bootstrapSocket = { session: { gameReplay: { dynamicGame: {} } } };
const bootstrapCtx = {
  config: { DYNAMIC_BATTLE_MANAGER: true },
  isTutorialCapturedBootstrapActive: () => false,
  buildInitialBattlePackets: () => { bootstrapCount++; return []; },
  ensureGameStartPackets: (packets) => packets,
  sendPendingGameStartSync: (socket) => { socket.session.gameReplay.dynamicGame.initialUnitsSent = true; },
};
loadComplete.handle(bootstrapCtx, bootstrapSocket);
loadComplete.handle(bootstrapCtx, bootstrapSocket);
assert.equal(bootstrapCount, 1, "duplicate 807 does not restart simulation or respawn the deck");

const restartSocket = { session: { user, gameReplay: { dynamicGame: { stageID: 11212, dungeonID: 1005 }, battleState: {} } } };
const packets = [];
let stopped = 0;
const restartCtx = {
  constants: { GAME_END_NOT: 811 },
  sendGameResponse: (_socket, _packet, id, payload) => packets.push({ id, payload }),
  buildDynamicGameEndNotPayload: (_replay, options) => {
    assert.equal(options.restart, true);
    assert.equal(options.win, false);
    return Buffer.from([0, 0, 1]);
  },
  sendServerGamePacket: (_socket, id, payload) => packets.push({ id, payload }),
  stopGameSyncTimers: () => { stopped++; },
};
restart.handle(restartCtx, restartSocket, {});
restart.handle(restartCtx, restartSocket, {});
assert.deepEqual(packets.map((p) => p.id), [862, 811, 862]);
assert.equal(codec.readSignedVarInt(packets[0].payload).value, 0);
assert.equal(codec.readSignedVarInt(packets[2].payload).value, 1);
assert.equal(stopped, 1);

const exploreUser = { userUid: "55", nickname: "Explore", level: 100, army: { units: {}, ships: {}, operators: {} } };
const originalExploreArmy = JSON.stringify(exploreUser.army);
const exploreRun = explore.enter(exploreUser, 1);
explore.move(exploreUser, 0);
const exploreLoad = attemptGameLoad(exploreUser, { exploreID: 1, selectDeckIndex: 0 });
assert.equal(exploreLoad.loaded, 1);
assert.equal(exploreLoad.loadedStage.gameType, 29);
assert.equal(exploreLoad.loadedStage.playerDeck.units.length, 4, "GAME_LOAD preserves the temporary exploration squad");
assert.equal(exploreLoad.loadedStage.playerDeck.deckType, 10);
const rewardBeforeExplore = rewards;
const exploreReplay = {
  dynamicGame: { ...exploreLoad.loadedStage, stageID: exploreLoad.loadedStage.stageId, gameUID: "explore-battle" },
  battleState: { win: true, gameTime: 10, diveShipCurHp: 60, diveShipMaxHp: 100 },
};
const exploreEnd = sandbox.buildDynamicGameEndNotPayload(exploreReplay, { user: exploreUser });
assert.equal(exploreRun.currentHp, 60);
assert.equal(exploreRun.completedBattleTokens.length, 1);
const parts = explore.serializeGameEndParts(exploreUser);
const tail = Buffer.concat([parts.explore, parts.squad, parts.enhancePoint]);
assert(exploreEnd.subarray(exploreEnd.length - tail.length).equals(tail), "811 contains the real exploration state and squad for native UI continuation");
assert.strictEqual(sandbox.buildDynamicGameEndNotPayload(exploreReplay, { user: exploreUser }), exploreEnd);
assert.equal(rewards, rewardBeforeExplore, "exploration rewards cannot be delivered through the story reward path");
assert.equal(sandbox.maybeRecordDynamicBattleClear({ session: { user: exploreUser, gameReplay: exploreReplay } }), false);
assert.equal(JSON.stringify(exploreUser.army), originalExploreArmy, "exploration's temporary units remain separate from the real roster");
console.log("Battle continuation checks passed: 18 phase chains/53 child battles, phase HP/time/rewards, trim level and chain, shadow completion/rewards/client unlock/recovery/retry, duplicate bootstrap/results, and restart.");
