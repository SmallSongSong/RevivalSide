"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const codec = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createFierceSelector } = require("../modules/fierce-selection");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const rootDir = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function extract(name) { const start = source.indexOf(`function ${name}(`), end = source.indexOf("\nfunction ", start + 1); assert(start >= 0); return source.slice(start, end < 0 ? source.length : end); }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-fierce-hot-"));
const selector = createFierceSelector({ rootDir, selectionPath: path.join(directory, "selection.json") });
const options = selector.listOptions();
const seasons = readGameplayTableRecords("ab_script", "LUA_FIERCE_TEMPLET.json", { rootDir });
const sent = []; let saves = 0, invalidations = 0;
const live = { session: { user: { userUid: "1" }, gameReplay: {} }, destroyed: false };
const disconnected = { destroyed: true, session: { user: { userUid: "2" } } };
const sandbox = { ...codec, Buffer, Date, Map, Set, Array, console, dateTimeBinaryForDate,
  fierceSelector: selector, liveGameSockets: new Set([live, disconnected]), NGT_FIERCE: 14, FIERCE_SEASON_NOT: 854, USE_LOCAL_USER_DB: true,
  loadMiscStageCatalog: () => ({ fierceSeasonRows: seasons }),
  getServerNowDate: () => new Date("2025-04-10T00:00:00Z"),
  getCurrentFierceSeasonId: () => selector.getActiveSeasonId() || options[0].seasonId,
  getCurrentFierceSeasonRow: () => seasons.find(row => row.FierceID === sandbox.getCurrentFierceSeasonId()),
  getCurrentFierceSeasonWindow: () => ({ startDate: new Date("2025-04-01T00:00:00Z"), gameEndDate: new Date("2025-04-15T00:00:00Z"), rewardStartDate: new Date("2025-04-15T00:00:00Z"), rewardEndDate: new Date("2025-04-29T00:00:00Z") }),
  mergeTags: (...groups) => [...new Set(groups.flat())],
  invalidateJoinLobbyAckPayloadCache: () => invalidations++, saveUserDb: () => saves++,
  sendServerGamePacket: (socket, id) => { assert.equal(socket, live); sent.push(id); },
  buildFierceSeasonNotPayload: () => codec.writeSignedVarInt(sandbox.getCurrentFierceSeasonId()),
  buildFierceDataAckPayload: user => { assert.equal(user.userUid, "1"); return Buffer.alloc(0); },
  buildEventIntervalDataList: () => [], buildEventShopIntervalDataList: () => [], buildRequiredIntervalDataList: () => [],
  buildSerializedAttendanceIntervalDataList: () => [], buildGuildSeasonIntervals: () => [], createPacketContext: () => ({}),
};
try {
  vm.createContext(sandbox);
  for (const name of ["getSelectableFierceSeasonRows", "getSelectableFierceSeasonTags", "getSelectableFierceSeasonIntervalStrKeys", "assertFierceSelectionCanApply", "refreshFierceSelectionForClients", "buildFierceSeasonIntervalDataList", "buildIntervalData", "readIntervalDataStrKey", "buildJoinLobbyIntervalDataList"]) vm.runInContext(extract(name), sandbox);
  const intervals = sandbox.buildJoinLobbyIntervalDataList({});
  const keys = new Set(intervals.map(sandbox.readIntervalDataStrKey));
  const enabled = new Set(sandbox.getSelectableFierceSeasonTags().openTags);
  for (const option of options) {
    const row = seasons.find(row => row.FierceID === option.seasonId);
    assert(keys.has(row.m_GameDateStrID) && keys.has(row.m_RewardDateStrID), "Every selectable native season must be preloaded before hot switching");
    assert(enabled.has(row.m_OpenTag));
  }
  let mergeOptions;
  Object.assign(sandbox, {
    process: { env: {} }, JOIN_LOBBY_ACK: 205, joinLobbyAckPayloadCache: new Map(),
    buildMinimalJoinLobbyPayload: () => Buffer.from([0]), getCapturedServerPayloadTemplate: () => Buffer.from([1]),
    hasLocalContractState: () => false, getIntervalPayloadStrKeys: rows => rows.map(sandbox.readIntervalDataStrKey),
    isEventMissionIntervalStrKey: () => false, getActiveEventShopTags: () => ({ intervalTags: [] }),
    getFierceSeasonIntervalStrKeys: () => { const row = sandbox.getCurrentFierceSeasonRow(); return [row.m_GameDateStrID, row.m_RewardDateStrID]; },
    getActiveEventState: () => ({ intervalData: [] }), getInactiveEventIntervalStrKeys: () => [],
    sha1Buffer: buffer => buffer.toString("hex"), rememberJoinLobbyAckPayload: () => {},
    eventManager: { config: { enabled: true } },
    combatHandler: { mergeJoinLobbyAck: (_official, _local, value) => { mergeOptions = value; return { ok: true, payload: Buffer.from([2]) }; } },
  });
  vm.runInContext(extract("buildJoinLobbyAckPayload"), sandbox);
  sandbox.buildJoinLobbyAckPayload({ userUid: "1" });
  for (const key of sandbox.getSelectableFierceSeasonIntervalStrKeys()) assert(mergeOptions.mergeIntervalStrKeys.includes(key), "Final captured205 merge must retain every hot-switch date, not only the current season");
  sandbox.assertFierceSelectionCanApply();
  live.session.gameReplay = { dynamicGame: { miscMode: "fierce", gameType: 14 }, dynamicBattleResultSent: false };
  assert.throws(() => sandbox.assertFierceSelectionCanApply(), error => error.statusCode === 409, "Hot switch must not change an in-flight result season");
  live.session.gameReplay.dynamicBattleResultSent = true;
  sandbox.assertFierceSelectionCanApply();
  selector.saveSelection({ seasonId: options[1].seasonId });
  sandbox.refreshFierceSelectionForClients();
  assert.deepEqual(sent, [854, 845], "Native season must switch before the new boss data");
  assert.equal(live.session.fierceSeasonId, options[1].seasonId);
  assert.equal(invalidations, 1); assert.equal(saves, 1);
  assert.equal(createFierceSelector({ rootDir, selectionPath: selector.selectionPath }).getActiveSeasonId(), options[1].seasonId);
  console.log("[fierce-selection-listener] PASS all native interval/tag prerequisites, active battle guard, 854-before-845 hot refresh, session/cache update and restart persistence");
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
