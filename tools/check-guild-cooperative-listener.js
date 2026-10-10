"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const guild = require("../modules/guild");
const codec = require("../modules/packet-codec");
const inventory = require("../modules/inventory");
const unit = require("../modules/unit");
const reward = require("../modules/reward");
const { readGameplayTableRecords, readGameplayTable } = require("../modules/gameplay-jsons");
const fierceRecords = require("../modules/misc-stages/fierce-result");

const source = fs.readFileSync(require.resolve("../server/listener"), "utf8");
function productionFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `listener function ${name} must exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  assert(next > start, `listener function ${name} must have a boundary`);
  return source.slice(start, next);
}
const functions = [
  "buildDynamicGameEndNotPayload", "sendManagedOrImmediatePacket", "sendGuildBattleResultPackets", "normalizeManagedCombatPayload",
  "extractManagedBattleWin", "extractManagedBattleRecords", "extractManagedBattlePlayTime", "extractManagedFiercePoint",
  "buildBattleGameRecordState", "buildBattleMissionState", "getBattleEndPlayTime", "getBattleRecordMaxPlayTime", "getBattlePlayTime",
  "resolveBattleWin", "resolveBattleWinTeam", "inferBattleWinFromUnits", "normalizeBattleResultState", "normalizePendingBattleGameStates", "isBattleWin",
  "resolveDungeonMissionResults", "evaluateDungeonMission", "buildDungeonClearData", "buildEmptyRewardData", "isRaidDynamicGame",
  "buildBattleDeckIndexData", "buildBattleGameRecordData", "collectBattleGameRecords", "normalizeBattleGameRecord", "applyBattleRecordDeckMetadata",
  "synthesizeMinimalBattleDamage", "buildBattleGameRecordUnitData", "normalizeBattleRecordTeam", "isATeamType", "isBTeamType",
  "writeBoolList", "writeIntList", "writeObjectMapShort", "buildRaidBossResultData", "buildShadowGameResultData", "buildPalaceDungeonData", "nextShadowDungeonId", "buildFierceResultState", "buildFierceResultData", "finiteNumber", "positiveInt",
];
const constants = Object.fromEntries([...source.matchAll(/^const ((?:NGT|NTT)_[A-Z0-9_]+) = (\d+);$/gm)].map(([, name, value]) => [name, Number(value)]));
const dungeonBases = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json");
function dungeonEntry(id) {
  const base = dungeonBases.find(row => Number(row.m_DungeonID) === Number(id));
  if (!base) return null;
  const table = readGameplayTable("ab_script_dungeon_templet_all", `${base.m_DungeonTempletFileName}.json`) || {};
  return { ...base, ...(table.root || table) };
}
const forbidden = name => () => { throw new Error(`guild battle entered forbidden ${name}`); };
function createHarness() {
  const now = new Date("2025-04-10T19:21:27Z");
  const user = { userUid: "1", friendCode: "101", nickname: "SyntheticCoop", level: 100, inventory: {}, army: {
    units: { 101: { unitUid: "101", userUid: "1", unitId: 1001, level: 120 }, 102: { unitUid: "102", userUid: "1", unitId: 1002, level: 120 } },
    ships: { 201: { unitUid: "201", userUid: "1", unitId: 21001, level: 100 } }, operators: {},
  } };
  unit.ensureArmy(user);
  for (const deckType of [1, 4]) {
    unit.setDeckUnit(user, { deckType, index: 0 }, 0, "101");
    unit.setDeckUnit(user, { deckType, index: 0 }, 1, "102");
    unit.setDeckShip(user, { deckType, index: 0 }, "201");
  }
  inventory.setMiscItemBalance(user, 101, 10000);
  inventory.setMiscItemBalance(user, 2, 10000);
  const counters = { saves: 0, dungeonClear: [], raidResult: [] };
  const sent = [];
  const ctx = {
    userDb: { users: { 1: user } }, config: { USE_LOCAL_USER_DB: true },
    getServerNowDate: () => now,
    getEffectiveContentsTags: () => ["GUILD_DUNGEON_SEASON_DEMOLTION_2025_2", "GUILD_DUNGEON_SEASON_GIGAS_2025_2"],
    getGenericStageForRequest: req => ({ dungeonID: Number(req.dungeonID), stageId: Number(req.dungeonID), mapID: 1, eventDeckId: 0 }),
    saveUserDb: () => { counters.saves++; },
  };
  guild.handleRequest(ctx, user, 3400, { guildName: "CoopListener", guildJoinType: 0, badgeId: "0", greeting: "" });
  const info = () => guild.handleRequest(ctx, user, 3471, { guildUid: user.guildUid });
  const sandbox = {
    ...codec, Buffer, console: { log() {} }, USE_LOCAL_USER_DB: true, GAME_END_NOT: 811,
    ...constants,
    toBigInt: inventory.toBigInt, createEmptyReward: reward.createEmptyReward, completeGuildBattle: guild.completeGuildBattle,
    buildSerializedRewardData: codec.buildRewardData, buildSerializedDeckIndexData: codec.buildDeckIndexData,
    createPacketContext: () => ctx, saveUserDb: ctx.saveUserDb, fierceRecords,
    localPvp: { isLocalPvpReplay: () => false },
    isCutsceneOnlyDungeon: () => false, getStageContentTemplet: dungeonEntry, classifyMiscDungeon: () => null, loadMiscStageCatalog: () => ({ shadowPalaceById: new Map(), shadowBattlesByGroup: new Map() }),
    getStageTableEntry: () => null, stageIdForDungeonId: id => id, resolveDungeonIdForStageProgress: id => id,
    worldMap: { completeDiveBattle: forbidden("Dive completion"), syncRaidCombatHpFromBattleState: forbidden("world map raid HP") },
    explore: { completeBattle: forbidden("Explore completion") },
    getOrGrantStageClearLoot: forbidden("ordinary loot"), spendStageReqItemCostForReplay: forbidden("ordinary stage cost"),
    buildMainStoryEpisodeCompleteDataForStage: forbidden("episode completion"), buildStagePlayData: forbidden("stage clear"),
    maybeRecordRaidBattleResultForReplay: forbidden("world map raid result"),
    resolvePhaseBattleResult: forbidden("phase completion"), resolveTrimBattleResult: forbidden("trim completion"),
    sendServerGamePacket: (_socket, id, payload, label) => { assert(Buffer.isBuffer(payload)); sent.push({ id, payload, label }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(functions.map(productionFunction).join("\n"), sandbox, { filename: "guild-listener-production-functions.js" });
  for (const [name, key] of [["buildDungeonClearData", "dungeonClear"], ["buildRaidBossResultData", "raidResult"]]) {
    const real = sandbox[name];
    sandbox[name] = (...args) => { const payload = real(...args); counters[key].push({ args, payload }); return payload; };
  }
  return { user, ctx, info, sent, counters, sandbox };
}

function runCase(kind) {
  const h = createHarness();
  const info = h.info();
  const stage = kind === "arena"
    ? guild.prepareGuildArenaGameLoad(h.ctx, h.user, { dungeonID: info.arenaList[0].dungeonId, selectDeckIndex: 0 })
    : guild.prepareGuildPractice(h.ctx, h.user, { bossStageId: info.bossData.stageId, selectDeckIndex: 0, isPractice: kind === "practice" }).stage;
  assert.equal(stage.gameType, { arena: 16, boss: 17, practice: 25 }[kind]);
  assert.equal(stage.raidUID, undefined);
  const replay = { dynamicGame: { ...stage, stageID: stage.stageId }, battleState: {
    win: true, gameTime: 60, usedRespawnCostA1: 2, shipHpDamagePercent: 0,
    ...(kind === "arena" ? {} : { raidBossCurHp: stage.guildBossMaxHp * .75, raidBossMaxHp: stage.guildBossMaxHp, raidBossKilled: false }),
  } };
  const socket = { session: { user: h.user, gameReplay: replay } };
  const inventoryBefore = JSON.stringify(h.user.inventory);
  const savesBefore = h.counters.saves;
  const payload = h.sandbox.buildDynamicGameEndNotPayload(replay, { user: h.user, win: true });
  assert(Buffer.isBuffer(payload) && payload.length > 40);
  assert.equal(payload[0], 1);
  assert.equal(h.counters.saves, savesBefore + 1, "one completed guild transaction is persisted once");
  assert.equal(JSON.stringify(h.user.inventory), inventoryBefore, "811 cannot spend ordinary items or grant ordinary loot");
  assert.equal(replay.stageClearLoot, undefined);
  assert.equal(replay.raidBattleResult, undefined);
  const after = h.info();
  const stateAfter = JSON.stringify(h.ctx.userDb);
  if (kind === "arena") {
    assert.equal(payload[3], 1, "guild arena needs native dungeonClearData");
    assert.equal(h.counters.dungeonClear.length, 1);
    const clear = h.counters.dungeonClear[0];
    const options = clear.args[1];
    assert.deepEqual(options.reward, reward.createEmptyReward());
    assert.equal(options.unitExp, 0);
    assert.equal(after.arenaList[0].totalMedalCount, 1 + Number(options.missionResult1) + Number(options.missionResult2));
    assert(after.arenaList[0].totalMedalCount > 0);
    assert(payload.subarray(4, 4 + clear.payload.length).equals(clear.payload), "811 embeds production medal and empty reward serialization");
    assert.equal(replay.guildBattleResult.raidBossResult, null);
  } else {
    assert.equal(payload[3], 0, "boss and practice do not emit ordinary dungeon clear");
    assert.equal(h.counters.dungeonClear.length, 0);
    const result = replay.guildBattleResult.raidBossResult;
    assert(result && result.maxHp > 0 && result.damage > 0);
    assert.equal(result.curHP, stage.guildBossMaxHp * .75);
    assert.equal(h.counters.raidResult[0].args[0], result);
    assert.equal(after.bossData.playCount, info.bossData.playCount,"formal and practice entries stay available after settlement");
    assert.equal(after.bossData.remainHp, kind === "practice" ? info.bossData.remainHp : result.curHP);
  }
  assert.equal(h.sandbox.buildDynamicGameEndNotPayload(replay, { user: h.user, win: false }), payload, "cached 811 must preserve its authoritative result");
  assert.equal(JSON.stringify(h.ctx.userDb), stateAfter, "cached result cannot rescore or spend another guild play");
  assert.equal(h.counters.saves, savesBefore + 1);
  h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.from("untrusted-local-result"), "managed-guild-end", { battleWin: true });
  const expected = kind === "arena" ? [811, 3481, 3472, 3474] : kind === "boss" ? [811, 3482, 3472, 3474] : [811, 3472, 3474];
  assert.deepEqual(h.sent.map(packet => packet.id), expected, "811 precedes cooperative result and refreshed info/member notices");
  assert(h.sent[0].payload.equals(payload), "managed 811 must be replaced by the authoritative cached guild payload");
  assert.equal(h.sandbox.sendGuildBattleResultPackets(socket), false, "same token cannot resend guild notices");
  h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.from("duplicate"), "managed-guild-end", { battleWin: false });
  assert.deepEqual(h.sent.map(packet => packet.id), expected, "same token cannot resend any result packet, including 811");
  assert.equal(JSON.stringify(h.ctx.userDb), stateAfter);
  assert.equal(h.counters.saves, savesBefore + 1);
  return { kind, gameType: stage.gameType, dungeonId: stage.dungeonID, userUid: h.user.userUid, guildUid: h.user.guildUid,
    coverage: "full-native-wire-production-builders", gameEndPayloadBase64: payload.toString("base64"),
    expected: { win: true, giveup: false, restart: false, dungeonClear: kind === "arena", raidBossResult: replay.guildBattleResult.raidBossResult },
    packets: h.sent.map(packet => ({ packetId: packet.id, payloadBase64: packet.payload.toString("base64") })) };
}

function checkStaleToken() {
  const h = createHarness();
  const stage = guild.prepareGuildPractice(h.ctx, h.user, { bossStageId: h.info().bossData.stageId, selectDeckIndex: 0, isPractice: false }).stage;
  const stale = { ...stage, guildBattleToken: "stale-test-token", stageID: stage.stageId };
  const replay = { dynamicGame: stale, battleState: { win: true, raidBossCurHp: 0, raidBossMaxHp: stage.guildBossMaxHp } };
  const stateBefore = JSON.stringify(h.ctx.userDb);
  const saves = h.counters.saves;
  assert.equal(h.sandbox.buildDynamicGameEndNotPayload(replay, { user: h.user, win: true }), null, "wrong token cannot settle a reserved guild battle");
  assert.equal(replay.guildBattleResult, undefined);
  assert.equal(JSON.stringify(h.ctx.userDb), stateBefore);
  assert.equal(h.counters.saves, saves);
  const socket = { session: { user: h.user, gameReplay: replay } };
  assert.equal(h.sandbox.sendGuildBattleResultPackets(socket), false);
  assert.equal(h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.from("native-untrusted-end"), "stale-end", { battleWin: true }), false,
    "a rejected guild token must not fall back to an untrusted native 811");
  assert.equal(h.sent.length, 0);
  assert.equal(h.counters.saves, saves);
  replay.guildBattleResult = { token: stage.guildBattleToken, packets: [{ packetId: 3482, payload: Buffer.from([1]) }] };
  assert.equal(h.sandbox.sendGuildBattleResultPackets(socket), false, "old result token cannot emit notices for another active game");
  assert.equal(h.sent.length, 0);
}

function checkFailedSendRetry() {
  const h = createHarness();
  const info = h.info();
  const stage = guild.prepareGuildArenaGameLoad(h.ctx, h.user, { dungeonID: info.arenaList[0].dungeonId, selectDeckIndex: 0 });
  const replay = { dynamicGame: { ...stage, stageID: stage.stageId }, battleState: { win: true, gameTime: 60 } };
  const socket = { session: { user: h.user, gameReplay: replay } };
  const saveBefore = h.counters.saves;
  const realSend = h.sandbox.sendServerGamePacket;
  h.sandbox.sendServerGamePacket = () => false;
  assert.equal(h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "failed-end", { battleWin: true }), false);
  assert.equal(replay.guildEndTokenSent, undefined, "failed 811 send must remain retryable");
  assert.equal(replay.guildResultNoticeTokenSent, undefined, "guild notices cannot overtake a failed 811");
  assert.equal(h.sent.length, 0);
  assert.equal(h.counters.saves, saveBefore + 1, "failed transmission still caches its one authoritative settlement");
  const stateAfter = JSON.stringify(h.ctx.userDb);
  h.sandbox.sendServerGamePacket = realSend;
  h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "retry-end", { battleWin: true });
  assert.deepEqual(h.sent.map(packet => packet.id), [811, 3481, 3472, 3474]);
  assert.equal(JSON.stringify(h.ctx.userDb), stateAfter);
  assert.equal(h.counters.saves, saveBefore + 1);
  assert.equal(h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "duplicate-end", { battleWin: false }), true);
  assert.deepEqual(h.sent.map(packet => packet.id), [811, 3481, 3472, 3474]);
}

function checkFailedNoticeRetry(failedPacketId) {
  const h = createHarness();
  const stage = guild.prepareGuildArenaGameLoad(h.ctx, h.user, { dungeonID: h.info().arenaList[0].dungeonId, selectDeckIndex: 0 });
  const replay = { dynamicGame: { ...stage, stageID: stage.stageId }, battleState: { win: true, gameTime: 60 } };
  const socket = { session: { user: h.user, gameReplay: replay } };
  const expected = [811, 3481, 3472, 3474];
  const failureIndex = expected.indexOf(failedPacketId);
  assert(failureIndex > 0);
  const attempts = [];
  const realSend = h.sandbox.sendServerGamePacket;
  let failOnce = true;
  h.sandbox.sendServerGamePacket = (...args) => {
    attempts.push(args[1]);
    if (args[1] === failedPacketId && failOnce) { failOnce = false; return false; }
    return realSend(...args);
  };
  const savesBefore = h.counters.saves;
  h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "partial-end", { battleWin: true });
  assert.deepEqual(h.sent.map(packet => packet.id), expected.slice(0, failureIndex), "a failed notice stops the chain at its unsent position");
  assert.deepEqual(attempts, expected.slice(0, failureIndex + 1));
  assert.equal(replay.guildEndTokenSent, stage.guildBattleToken);
  assert.equal(replay.guildResultNoticeTokenSent, undefined, "a partial notice chain cannot be marked complete");
  assert.equal(replay.guildResultNoticeProgress.token, stage.guildBattleToken);
  assert.equal(replay.guildResultNoticeProgress.index, failureIndex - 1);
  assert.equal(h.counters.saves, savesBefore + 1);
  const stateAfter = JSON.stringify(h.ctx.userDb);
  const cachedPayload = replay.dynamicGameEndPayload;
  assert.equal(h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "resume-end", { battleWin: false }), true);
  assert.deepEqual(h.sent.map(packet => packet.id), expected, "retry resumes failed notice without repeating 811 or its successful prefix");
  assert.deepEqual(attempts, [...expected.slice(0, failureIndex + 1), ...expected.slice(failureIndex)], "only the failed notice is attempted twice");
  assert.equal(replay.guildResultNoticeTokenSent, stage.guildBattleToken);
  assert.equal(replay.guildResultNoticeProgress.index, expected.length - 1);
  assert.equal(replay.dynamicGameEndPayload, cachedPayload);
  assert.equal(JSON.stringify(h.ctx.userDb), stateAfter, "resuming notices cannot rescore or consume another guild play");
  assert.equal(h.counters.saves, savesBefore + 1);
  h.sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.alloc(0), "complete-duplicate", { battleWin: true });
  assert.deepEqual(h.sent.map(packet => packet.id), expected);
  assert.equal(attempts.length, expected.length + 1);
}

const fixtures = ["arena", "boss", "practice"].map(runCase);
checkStaleToken();
checkFailedSendRetry();
checkFailedNoticeRetry(3481);
checkFailedNoticeRetry(3472);
const args = process.argv.slice(2);
if (args.length) {
  assert(args.length === 2 && args[0] === "--out", "Usage: node tools/check-guild-cooperative-listener.js [--out fixture.json]");
  fs.writeFileSync(path.resolve(args[1]), JSON.stringify({ schema: 1, syntheticOnly: true, fixtures }, null, 2) + "\n");
}
console.log("[guild-cooperative-listener] PASS real helpers, native 811 builders, medals/HP, isolated rewards, cached settlement, one ordered result chain, 811/3481/3472 failed-send recovery and stale-token rejection");
