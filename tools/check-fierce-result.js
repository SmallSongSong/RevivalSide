"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const codec = require("../modules/packet-codec");
const path = require("node:path");
const vm = require("node:vm");
const { recordFierceResult, buildFierceEventDeckData, buildFierceProfileDeckData } = require("../modules/misc-stages/fierce-result");
const bossId = 5100251;
const rows = [
  { FierceBossID: bossId, FierceBossGroupID: 510025, OperationPower: 8000 },
  { FierceBossID: bossId + 1, FierceBossGroupID: 510025, OperationPower: 12000 },
  { FierceBossID: 5100271, FierceBossGroupID: 510027, OperationPower: 8000 },
];
const playerDeck = {
  leaderIndex: 2, leaderUnitUid: "101", shipUid: "200", shipUnitId: 26001,
  shipLevel: 100, shipSkinId: 17, shipLimitBreakLevel: 5,
  operatorUid: "300", operatorId: 31301, operatorLevel: 100,
  units: [0, 2, 7].map((slotIndex, index) => ({
    slotIndex, unitUid: String(100 + index), unitId: 1101 + index, level: 120,
    skinId: index + 1, tacticLevel: 6, reactorLevel: 3, limitBreakLevel: 6,
    skillLevels: [5, 5, 5, 5, 1], equipItemUids: ["400", "401", "0", "0"],
  })),
  equipItems: [{ equipUid: "400", itemEquipId: 101, enchantLevel: 10, stats: [{ type: "NST_ATK", value: 100 }] }],
};
const state = { season: { bosses: {} }, fierce: { bosses: {} } };
const replay = uid => ({ dynamicGame: { miscMode: "fierce", gameType: 14, gameUID: uid, fierceBossId: bossId, dungeonID: 3001, playerDeck } });
const options = win => ({ win, bossRows: rows });
const result = (point, penalties = [1]) => ({ bossId, accquirePoint: point, penaltyPoint: 200, penaltyIds: penalties });
const first = recordFierceResult(replay("1"), state, result(1500), options(false));
assert(first.changed);
assert.equal(first.boss.point, 1500, "nonlethal battle damage must still persist points");
assert.equal(first.boss.isCleared, false, "damage points must not unlock the next difficulty");
assert.equal(state.season.totalPoint, 1500);
assert.equal(state.season.bosses["10001"], undefined, "shared DungeonID must not select another season's boss");
playerDeck.units[0].level = 77;
playerDeck.equipItems[0].enchantLevel = 1;
assert.equal(first.boss.bestDeck.units[0].level, 120, "best lineup must retain the battle snapshot");
assert.equal(first.boss.bestDeck.equipItems[0].enchantLevel, 10);
assert.equal(recordFierceResult(replay("1"), state, result(9000), options(true)).changed, false, "repeated gameUID must not change its settled outcome");
assert.equal(state.season.bosses[bossId].isCleared, false);
state.season.bosses[bossId].penaltyIds = [2]; // The native penalty request saves the next battle's selection.
const lowerWin = recordFierceResult(replay("2"), state, result(1000, [2]), options(true));
assert.equal(lowerWin.boss.isCleared, true);
assert.equal(lowerWin.boss.point, 1500);
assert.deepEqual(lowerWin.boss.bestPenaltyIds, [1], "a lower score must not replace best-record penalty metadata");
assert.deepEqual(lowerWin.boss.penaltyIds, [2], "the player's next-battle selection must remain available");
assert.equal(lowerWin.boss.bestDeck.units[0].level, 120);
const freshState = JSON.parse(JSON.stringify(state));
assert.equal(recordFierceResult(replay("2"), freshState, result(12000), options(true)).changed, false, "gameUID deduplication must survive saving and loading");
const higher = recordFierceResult(replay("3"), state, result(3000, [3]), options(false));
assert.equal(higher.boss.point, 3000);
assert.equal(higher.boss.isCleared, true, "a later defeat must retain an earlier clear");
assert.equal(higher.boss.bestDeck.units[0].level, 77);
assert.throws(() => recordFierceResult(replay("4"), state, { ...result(5000), bossId: 10001 }, options(true)), /does not match/);
const otherDifficulty = replay("5");
otherDifficulty.dynamicGame.fierceBossId = bossId + 1;
recordFierceResult(otherDifficulty, state, { ...result(5000), bossId: bossId + 1 }, options(true));
assert.equal(state.season.totalPoint, 5000, "the season total uses the best difficulty per boss group");
const otherGroup = replay("6");
otherGroup.dynamicGame.fierceBossId = 5100271;
recordFierceResult(otherGroup, state, { ...result(2000), bossId: 5100271 }, options(false));
assert.equal(state.season.totalPoint, 7000, "different boss groups each contribute their best score");
const deck = first.boss.bestDeck;
assert.equal(buildFierceEventDeckData(null), null);
assert.equal(buildFierceProfileDeckData(null), null);
const source = fs.readFileSync(path.join(__dirname, "../server/listener.js"), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
const wiredState = { season: { bosses: {} }, fierce: { bosses: {} } };
let saves = 0;
let genericClears = 0;
const empty = () => Buffer.alloc(0);
const sandbox = {
  ...codec, Buffer, console: { log() {} }, fierceRecords: require("../modules/misc-stages/fierce-result"),
  NGT_FIERCE: 14, NGT_EXPLORE: 29, NGT_DIVE: 5, NGT_PHASE: 15, USE_LOCAL_USER_DB: true,
  stageIdForDungeonId: () => 3001, resolveDungeonIdForStageProgress: () => 3001,
  isRaidDynamicGame: () => false,
  buildBattleGameRecordState: state => state, getBattleEndPlayTime: () => 180,
  buildBattleMissionState: state => state, resolveBattleWin: (_state, options) => options.win,
  resolveDungeonMissionResults: () => ({ missionResult1: false, missionResult2: false }),
  normalizeBattleResultState() {}, isCutsceneOnlyDungeon: () => false,
  spendStageReqItemCostForReplay: () => [], getOrGrantStageClearLoot: () => null,
  buildMainStoryEpisodeCompleteDataForStage: () => null,
  buildFierceResultState: options => ({
    bossId: options.dynamicGame.fierceBossId, hpPercent: options.win ? 0 : 50, restTime: 0,
    accquirePoint: options.fiercePoint, bestPoint: 0, penaltyPoint: options.fiercePenaltyPoint, penaltyIds: options.dynamicGame.testPenaltyIds,
  }),
  ensureFierceSeasonState: () => wiredState, getFierceSeasonBossRows: () => rows,
  getCurrentFierceSeasonRow: () => ({ FierceID: 2327 }),
  getFierceSavedBossState: (_user, id) => wiredState.season.bosses[String(id)] || {},
  uniquePositiveIntList: ids => [...new Set((ids || []).map(Number).filter(id => id > 0))],
  buildDungeonClearData: empty, buildBattleDeckIndexData: empty, buildRaidBossResultData: empty,
  buildBattleGameRecordData: empty, buildStagePlayData: empty, buildShadowGameResultData: empty,
  buildProfileEmblemData: empty, saveUserDb() { saves++; },
  recordMainStoryDungeonClear() { genericClears++; }, recordGenericDungeonClear() { genericClears++; },
  ensureAccountProgress() {}, buildCommonProfileData: empty, buildPvpProfileData: empty,
  buildAsyncDeckData: empty, buildGuildSimpleData: empty,
  positiveInt: value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0,
};
vm.createContext(sandbox);
for (const name of ["buildDynamicGameEndNotPayload", "buildFierceResultData", "buildFierceBossData", "buildFierceProfileState", "buildFierceProfileData", "maybeRecordDynamicBattleClear", "buildUserProfileData"])
  vm.runInContext(extract(name), sandbox);
const user = {};
const battle = replay("wired-loss");
battle.dynamicGame.playerDeck = JSON.parse(JSON.stringify(deck));
battle.dynamicGame.testPenaltyIds = [1];
const payload = sandbox.buildDynamicGameEndNotPayload(battle, { user, win: false, managedFiercePoint: 1500, managedFiercePenaltyPoint: 200 });
assert(Buffer.isBuffer(payload));
assert.equal(wiredState.season.bosses[bossId].point, 1500, "real GAME_END integration must persist nonlethal managed points");
assert.equal(wiredState.season.bosses[bossId].isCleared, false);
assert.equal(saves, 1, "real GAME_END must save the changed Fierce result");
assert.strictEqual(sandbox.buildDynamicGameEndNotPayload(battle, { user, win: true, managedFiercePoint: 9000 }), payload);
assert.equal(saves, 1, "cached GAME_END must not persist a different replayed outcome");
assert.equal(sandbox.maybeRecordDynamicBattleClear({ session: { user, gameReplay: battle } }), false);
assert.equal(genericClears, 0, "Fierce must skip generic DungeonID-based clear recording");
const lowerBattle = replay("wired-lower-win");
lowerBattle.dynamicGame.testPenaltyIds = [2];
wiredState.season.bosses[bossId].penaltyIds = [2];
sandbox.buildDynamicGameEndNotPayload(lowerBattle, { user, win: true, managedFiercePoint: 1000, managedFiercePenaltyPoint: 50 });
assert.equal(wiredState.season.bosses[bossId].point, 1500);
assert.equal(wiredState.season.bosses[bossId].isCleared, true);
const bestProfile = sandbox.buildFierceProfileState(user);
assert.deepEqual(Array.from(bestProfile.penaltyIds), [1], "highest-score profile must use the saved record's penalty selection");
assert.equal(bestProfile.bestDeck.units[0].level, 120);
assert(Buffer.isBuffer(sandbox.buildUserProfileData({}, 0n, 0n, "")), "ordinary profile requests must still build without Fierce-local fields");
const fixture = {
  bossId, groupId: 510025,
  eventDeck: buildFierceEventDeckData(deck).toString("base64"),
  profileDeck: buildFierceProfileDeckData(deck).toString("base64"),
  bossPayload: sandbox.buildFierceBossData({ bossId, point: 1500, rankNumber: 1, rankPercent: 1, bestDeck: deck, isCleared: false }).toString("base64"),
  resultPayload: sandbox.buildFierceResultData({ hpPercent: 50, restTime: 0, accquirePoint: 1500, bestPoint: 1500, bestDeck: deck }).toString("base64"),
  profilePayload: sandbox.buildFierceProfileData(bestProfile, user).toString("base64"),
  expectedDeck: deck,
};
const arg = process.argv.indexOf("--fixtures");
if (arg >= 0) fs.writeFileSync(process.argv[arg + 1], JSON.stringify(fixture));
console.log("Fierce result checks passed: actual boss identity, nonlethal score, clear retention, durable gameUID deduplication, best lineup snapshot and real-slot serializers.");
