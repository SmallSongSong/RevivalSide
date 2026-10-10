"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const codec = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createFierceSelector } = require("../modules/fierce-selection");

if (process.argv.length !== 5) throw new Error("Usage: node tools/build-fierce-merged-lobby-fixture.js <private captured205/local-interval fixture> <selector entry fixture> <private output JSON>");
const rootDir = path.resolve(__dirname, "..");
const lobby = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const entries = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const now = new Date(lobby.serviceTime);
assert(Number.isFinite(now.getTime()), "fixture must include the actual service clock");
assert(lobby.officialPayloadBase64 && Array.isArray(lobby.intervals), "a real captured205 and production local intervals are required");
assert.equal(entries.seasons.length, 19);
const source = fs.readFileSync(path.join(rootDir, "server/listener.js"), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
const selector = createFierceSelector({ rootDir, selectionPath: "/nonexistent/revivalside-fierce-merged-lobby.json" });
const sandbox = { ...codec, Buffer, Date, Map, Set, Array, fs, process: { env: {} }, dateTimeBinaryForDate,
  getServerNowDate: () => now, FIERCE_DAY_MS: 86400000, FIERCE_ROTATION_ANCHOR_ISO: "2025-10-01T03:00:00.000Z",
  FIERCE_ROTATION_CYCLE_DAYS: 14, FIERCE_ROTATION_GAME_DAYS: 14, fierceSelector: selector,
  loadMiscStageCatalog: () => ({ fierceSeasonRows: entries.seasons }), positiveInt: value => Math.max(0, Number(value) || 0),
  getCurrentFierceSeasonRow: () => entries.seasons[0], mergeTags: (...groups) => [...new Set(groups.flat())] };
vm.createContext(sandbox);
for (const name of ["getSelectableFierceSeasonRows", "getFierceRotationSlot", "positiveModulo", "coerceValidDate", "getCurrentFierceSeasonWindow", "buildFierceSeasonIntervalDataList", "buildIntervalData"]) vm.runInContext(extract(name), sandbox);
const byKey = new Map(lobby.intervals.map(row => [row.strKey, row]));
for (const [index, season] of entries.seasons.entries()) {
  for (const row of sandbox.buildFierceSeasonIntervalDataList(now, season, 941000 + index * 2)) {
    byKey.set(row.strKey, { strKey: row.strKey, suppressed: false, payloadBase64: sandbox.buildIntervalData(row).toString("base64") });
  }
}
const output = { ...lobby, ...entries, intervals: [...byKey.values()], initialSeasonId: entries.seasons[0].FierceID };
fs.writeFileSync(process.argv[4], JSON.stringify(output), { mode: 0o600 });
fs.chmodSync(process.argv[4], 0o600);
console.log(`Fierce merged205 fixture written: ${entries.seasons.length} choices, ${output.intervals.length} local intervals, service time ${now.toISOString()}. Captured account bytes remain in the private output only.`);
