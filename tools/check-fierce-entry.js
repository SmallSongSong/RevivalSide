"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const codec = require("../modules/packet-codec");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const rootDir = path.resolve(__dirname, "..");
let selectedSeasonId = 0;
const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
const cycleMatch = source.match(/const FIERCE_ROTATION_GAME_DAYS = ([\s\S]*?);/);
assert(cycleMatch);
const sandbox = {
  fierceRecords: require("../modules/misc-stages/fierce-result"),
  ...codec, Buffer, fs, process: { env: {} }, cachedMiscStageCatalog: null,
  fierceSelector: { getActiveSeasonId: () => selectedSeasonId, selectionPath: "/nonexistent/revivalside-fierce-selection.json" },
  FIERCE_DAY_MS: 86400000, FIERCE_ROTATION_ANCHOR_ISO: "2025-10-01T03:00:00.000Z", FIERCE_ROTATION_CYCLE_DAYS: 14,
  now: new Date("2025-04-10T14:22:54.926Z"),
  getServerNowDate: () => sandbox.now,
  readMiscStageRecords: file => readGameplayTableRecords("ab_script", file, { rootDir }),
  getDungeonTableEntryByStrId: () => null,
  getFierceSeasonState: () => ({ fierce: { bosses: {} }, season: { bosses: {} } }),
  getFierceSeasonTotalPoint: () => 0,
  getFierceLeaderboardEntries: () => [{ user: { userUid: "123", friendCode: "456", nickname: "Fierce fixture", level: 35 }, point: 0 }],
  getFierceLeaderboardRank: () => 0,
  ensureAccountProgress() {}, getJoinLobbyUserLevel: user => user.level,
  buildGuildSimpleData: require("../modules/guild").buildGuildSimpleData,
};
vm.createContext(sandbox);
vm.runInContext(`const FIERCE_ROTATION_GAME_DAYS = ${cycleMatch[1]}; globalThis.FIERCE_ROTATION_GAME_DAYS = FIERCE_ROTATION_GAME_DAYS;`, sandbox);
assert.equal(vm.runInNewContext(cycleMatch[1], { FIERCE_ROTATION_CYCLE_DAYS: 14, process: { env: { CS_FIERCE_ROTATION_GAME_DAYS: "7" } }, Math, Number }), 7, "explicit gameplay-window configuration must remain supported");
for (const name of ["positiveInt", "mapListPush", "loadMiscStageCatalog", "getFierceRotationSeasonRows", "isRotatableFierceSeason", "getCurrentFierceSeasonRow", "getCurrentFierceSeasonId", "getFierceRotationSlot", "getCurrentFierceSeasonWindow", "positiveModulo", "coerceValidDate", "getFierceSeasonBossRows", "getFierceSeasonBossGroupIds", "sortNumberedFieldNames", "buildFierceDataAckPayload", "buildFierceBossData", "buildFierceSeasonNotPayload", "buildLeaderboardFierceBossGroupListAckPayload", "buildLeaderBoardFierceData", "buildLeaderBoardFierceEntry", "getUserProfileIdentity", "buildCommonProfileData"])
  vm.runInContext(extract(name), sandbox);

const dungeonIds = new Set(readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", { rootDir }).map(row => row.m_DungeonID));
const seasons = sandbox.getFierceRotationSeasonRows();
assert(seasons.length > 0);
let bosses = 0;
for (const season of seasons) {
  const rows = sandbox.getFierceSeasonBossRows(season);
  assert(rows.length > 0, `season ${season.FierceID} has no boss`);
  for (const groupId of sandbox.getFierceSeasonBossGroupIds(season)) {
    const levels = rows.filter(row => row.FierceBossGroupID === groupId).map(row => row.Level);
    assert(levels.includes(1), `season ${season.FierceID} group ${groupId} misses entry difficulty`);
  }
  for (const boss of rows) {
    assert(dungeonIds.has(boss.DungeonID), `boss ${boss.FierceBossID} has no frozen dungeon ${boss.DungeonID}`);
    bosses++;
  }
}
const fixtures = [];
for (const date of ["2025-04-10T14:22:54.926Z", "2026-10-09T03:13:26.000Z", "2026-10-14T02:59:59.000Z", "2026-10-14T03:00:00.000Z"]) {
  sandbox.now = new Date(date);
  const season = sandbox.getCurrentFierceSeasonRow();
  const rows = sandbox.getFierceSeasonBossRows();
  const window = sandbox.getCurrentFierceSeasonWindow();
  assert(sandbox.now >= window.startDate && sandbox.now < window.gameEndDate, `local challenge unexpectedly closed at ${date}`);
  fixtures.push({ date, seasonId: season.FierceID, openTag: season.m_OpenTag, groupId: season.FierceBossGroupID_1,
    bosses: rows, seasonPayload: sandbox.buildFierceSeasonNotPayload().toString("base64"),
    dataPayload: sandbox.buildFierceDataAckPayload().toString("base64"),
    rankPayload: sandbox.buildLeaderboardFierceBossGroupListAckPayload({ fierceBossGroupId: season.FierceBossGroupID_1 }, {}).toString("base64") });
}
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(844);
assert(handler && handler.fileName.endsWith("0000-1221-misc-stage-starts.js"), "registry must select the local Fierce handler");
const sent = [];
let seasonId = 2303;
const ctx = {
  getCurrentFierceSeasonId: () => seasonId, buildFierceSeasonNotPayload: () => codec.writeSignedVarInt(seasonId),
  buildFierceDataAckPayload: () => Buffer.alloc(0),
  sendServerGamePacket(_socket, id) { sent.push(id); }, sendGameResponse(_socket, _req, id) { sent.push(id); },
};
const socket = { session: {} };
handler.handle(ctx, socket, {});
handler.handle(ctx, socket, {});
seasonId++;
handler.handle(ctx, socket, {});
assert.deepEqual(sent, [854, 845, 845, 854, 845], "season manager must initialize before boss data without resetting selected difficulty on each refresh");
const selectorArg = process.argv.indexOf("--selector-fixtures");
if (selectorArg >= 0) {
  const output = process.argv[selectorArg + 1];
  assert(output && !output.startsWith("--"), "--selector-fixtures requires an output path");
  const selector = require("../modules/fierce-selection").createFierceSelector({ rootDir, selectionPath: "/nonexistent/revivalside-fierce-selection.json" });
  const choices = selector.listOptions();
  assert.equal(choices.length, 19, "native selector fixture must cover every supported Chinese Boss");
  const selectedFixtures = [];
  const selectedSeasons = [];
  sandbox.now = new Date("2026-10-10T06:00:00.000Z");
  for (const choice of choices) {
    selectedSeasonId = choice.seasonId;
    const season = sandbox.getCurrentFierceSeasonRow();
    assert.equal(season.FierceID, choice.seasonId, "running listener must resolve the exact selected season");
    const rows = sandbox.getFierceSeasonBossRows();
    assert.deepEqual(Array.from(rows, row => Number(row.FierceBossID)).sort((a, b) => a - b), choice.bosses.map(boss => boss.bossId).sort((a, b) => a - b));
    assert(sandbox.buildFierceSeasonNotPayload().equals(codec.writeSignedVarInt(choice.seasonId)), "854 must contain the selected season");
    for (const boss of choice.bosses) {
      const row = rows.find(row => row.FierceBossID === boss.bossId);
      assert.equal(row.DungeonID, boss.dungeonId);
      assert.equal(row.Level, boss.difficulty);
      assert(dungeonIds.has(boss.dungeonId), `selected ${choice.name} dungeon ${boss.dungeonId} is absent`);
    }
    selectedSeasons.push(season);
    selectedFixtures.push({ date: `${choice.name} (${choice.seasonId})`, seasonId: season.FierceID,
      openTag: season.m_OpenTag, groupId: season.FierceBossGroupID_1, bosses: rows,
      seasonPayload: sandbox.buildFierceSeasonNotPayload().toString("base64"),
      dataPayload: sandbox.buildFierceDataAckPayload().toString("base64"),
      rankPayload: sandbox.buildLeaderboardFierceBossGroupListAckPayload({ fierceBossGroupId: season.FierceBossGroupID_1 }, {}).toString("base64") });
  }
  selectedSeasonId = 0;
  fs.writeFileSync(output, JSON.stringify({ fixtures: selectedFixtures, seasons: selectedSeasons,
    bosses: Array.from(sandbox.loadMiscStageCatalog().fierceBossById.values()) }));
  console.log(`Fierce selector fixtures generated: ${choices.length} Chinese Boss choices, ${selectedFixtures.reduce((total, fixture) => total + fixture.bosses.length, 0)} real difficulty/dungeon routes.`);
}
const fixtureArg = process.argv.indexOf("--fixtures");
if (fixtureArg >= 0) fs.writeFileSync(process.argv[fixtureArg + 1], JSON.stringify({ fixtures, seasons, bosses: Array.from(sandbox.loadMiscStageCatalog().fierceBossById.values()) }));
console.log(`Fierce entry checks passed: ${seasons.length} production seasons, ${bosses} boss routes, ${fixtures.length} clock windows, season/data ordering.`);
