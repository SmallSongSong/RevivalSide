"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const names = require("./boss-names.json").names;

function readPersistedSelection(selectionPath) {
  if (!fs.existsSync(selectionPath)) return { seasonId: 0 };
  const value = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.seasonId) || value.seasonId < 0) {
    throw new Error("激战支援设置格式无效，已恢复自动轮换。");
  }
  return { seasonId: value.seasonId };
}

function buildBossOptions(catalog) {
  const seasons = (catalog.fierceSeasonRows || []).slice().sort((a, b) => b.FierceID - a.FierceID);
  const groups = catalog.fierceBossesByGroup;
  const dungeonIds = catalog.dungeonIds;
  const result = [];
  const seen = new Set();
  for (const season of seasons) {
    const id = Number(season.FierceID);
    const tag = String(season.m_OpenTag || "").toUpperCase();
    if (!Number.isSafeInteger(id) || id <= 0 || id >= 9000 || !tag.includes("GLOBAL") || tag.includes("DEV") || tag.startsWith("TAG_ZL") || String(season.m_GameDateStrID || "").includes("_ZL")) continue;
    const groupIds = Object.keys(season).filter(key => /^FierceBossGroupID_\d+$/.test(key)).map(key => Number(season[key])).filter(id => id > 0);
    if (!groupIds.length || !season.m_GameDateStrID || !season.m_RewardDateStrID) continue;
    const bosses = groupIds.flatMap(id => groups.get(id) || []);
    if (!bosses.length || groupIds.some(id => !(groups.get(id) || []).some(row => Number(row.Level) === 1))) continue;
    if (bosses.some(row => !names[row.UI_BossTitle] || !Number(row.FierceBossID) || !Number(row.DungeonID) || (dungeonIds && !dungeonIds.has(Number(row.DungeonID))))) continue;
    const titles = [...new Set(bosses.map(row => row.UI_BossTitle))];
    const key = titles.slice().sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ seasonId: id, groupIds, name: titles.map(title => names[title].simplified).join(" / "),
      traditionalName: titles.map(title => names[title].traditional).join(" / "),
      bosses: bosses.map(row => ({ bossId: Number(row.FierceBossID), groupId: Number(row.FierceBossGroupID), difficulty: Number(row.Level), dungeonId: Number(row.DungeonID), name: names[row.UI_BossTitle].simplified })) });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function createFierceSelector(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "../.."));
  const selectionPath = options.selectionPath || path.join(rootDir, "server-data/fierce-selection.json");
  const getCatalog = options.getCatalog || (() => loadCatalog(rootDir));
  let activeSeasonId = 0;
  let warning = "";
  let initialized = false;
  let cachedOptions;

  function listOptions() { return cachedOptions ||= buildBossOptions(getCatalog()); }
  function validateSelection(value) {
    const id = value && value.seasonId;
    if (!Number.isSafeInteger(id) || id < 0 || (id !== 0 && !listOptions().some(row => row.seasonId === id))) {
      const error = new Error("请选择列表中的激战支援 Boss。");
      error.statusCode = 400;
      throw error;
    }
    return { seasonId: id };
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    try { activeSeasonId = validateSelection(readPersistedSelection(selectionPath)).seasonId; }
    catch (error) { warning = error.message; }
  }
  function getActiveSeasonId() { initialize(); return activeSeasonId; }
  function getState() {
    initialize();
    const rows = listOptions();
    return { seasonId: activeSeasonId, mode: activeSeasonId ? "manual" : "rotation", options: rows, warning,
      activeName: rows.find(row => row.seasonId === activeSeasonId)?.name || "自动轮换" };
  }
  function saveSelection(value) {
    initialize();
    const next = validateSelection(value);
    const previous = { seasonId: activeSeasonId };
    // Reject active combat before persisting so its result remains in the original season.
    if (options.canApply) options.canApply(next, previous);
    const oldBytes = fs.existsSync(selectionPath) ? fs.readFileSync(selectionPath) : null;
    writeAtomic(selectionPath, Buffer.from(JSON.stringify({ schemaVersion: 1, seasonId: next.seasonId }, null, 2) + "\n"));
    activeSeasonId = next.seasonId;
    try { if (options.onApply) options.onApply(next, previous); }
    catch (error) {
      activeSeasonId = previous.seasonId;
      if (oldBytes) writeAtomic(selectionPath, oldBytes);
      else fs.unlinkSync(selectionPath);
      throw error;
    }
    warning = "";
    return getState();
  }
  return { getActiveSeasonId, getState, listOptions, validateSelection, saveSelection, selectionPath };
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function loadCatalog(rootDir) {
  const read = (directory, file) => readGameplayTableRecords(directory, file, { rootDir });
  const fierceBossesByGroup = new Map();
  for (const row of read("ab_script", "LUA_FIERCE_BOSS_GROUP_TEMPLET.json")) {
    const id = Number(row.FierceBossGroupID);
    if (!fierceBossesByGroup.has(id)) fierceBossesByGroup.set(id, []);
    fierceBossesByGroup.get(id).push(row);
  }
  return { fierceSeasonRows: read("ab_script", "LUA_FIERCE_TEMPLET.json"), fierceBossesByGroup,
    dungeonIds: new Set(read("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json").map(row => Number(row.m_DungeonID))) };
}
module.exports = { createFierceSelector, buildBossOptions, readPersistedSelection };
