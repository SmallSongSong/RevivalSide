"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { createEventManager, buildEventRegistry, selectOfflineDefenceEntries, buildActiveEventState, resolveEventManagerConfig } = require("../modules/event-manager");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const codec = require("../modules/packet-codec");
const fixture = require("./fixtures/limited-event-frozen-defence.json");
const tables = [
  ["DEFENCE_TEMPLET", fixture.defences],
  ["EVENT_COLLECTION_INDEX_TEMPLET", fixture.collections],
  ["EVENT_LOBBY_INDEX_TEMPLET", fixture.lobby],
].map(([tableName, records]) => ({category:"event", tableName, records, relativePath:`${tableName}.json`}));
const config = resolveEventManagerConfig({ env: {} });
const registry = buildEventRegistry(tables, config);
registry.offlineDefenceEntries = selectOfflineDefenceEntries(registry, {records:fixture.dungeons});
assert.equal(registry.offlineDefenceEntries.length, 1);
const event = registry.offlineDefenceEntries[0];
assert.equal(event.raw.defenceTempletId, 23, "choose the latest native boss event, excluding test/expedition variants");
assert.equal(event.raw.dungeonId, 8030023);
assert.equal(event.raw.lobbyId, 74);
assert.equal(event.raw.EventID, 58);
for (const date of ["2025-04-10T15:00:00Z", "2026-10-10T07:00:00Z", "2030-01-01T00:00:00Z"]) {
  const state = buildActiveEventState(registry, config, date);
  assert.deepEqual(state.openTags.filter(tag => /DEFENCE_DUNGEON/.test(tag)), ["TAG_COMMON_DEFENCE_DUNGEON_23"]);
  const intervals = state.intervalData.filter(row => /DEFENCE_DUNGEON/.test(row.strKey) && row.sourceTable !== "OFFLINE_DISABLED_MODULE_WINDOW");
  assert.equal(intervals.length, 3, "collection, game and score-result windows are all available");
  for (const row of intervals) assert(row.startDate <= new Date(date) && new Date(date) < row.endDate);
}
assert.equal(buildActiveEventState(registry, {...config,enabled:false}, "2025-04-10").openTags.length, 0);
assert.equal(buildActiveEventState(registry, {...config,offlineDefenceEnabled:false}, "2025-04-10").openTags.filter(tag => /^TAG_COMMON_DEFENCE_DUNGEON_/.test(tag)).length, 0);
assert.equal(selectOfflineDefenceEntries(registry, {records:[]}).length, 0, "never open an event whose dungeon is missing");
const withoutLatest = selectOfflineDefenceEntries(registry, {records:fixture.dungeons.filter(row => row.m_DungeonID !== 8030023)});
assert.equal(withoutLatest[0].raw.defenceTempletId, 22, "missing latest dungeon falls back to a complete native event");
const noBanner = buildEventRegistry(tables.map(table => table.tableName !== "EVENT_LOBBY_INDEX_TEMPLET" ? table : {...table,records:table.records.map(row => ({...row,BannerID:""}))}), config);
assert.equal(selectOfflineDefenceEntries(noBanner, {records:fixture.dungeons}).length, 0);
const rootDir = path.join(__dirname,"..");
const manager = createEventManager({rootDir,env:{}});
const actual = manager.getActiveEventState("2025-04-10");
assert.equal(actual.openTags.filter(tag => /^TAG_COMMON_DEFENCE_DUNGEON_/.test(tag)).join(","), "TAG_COMMON_DEFENCE_DUNGEON_23", "historical date schedules cannot displace the offline boss event");
const handlers = loadPacketHandlers([path.join(rootDir,"packet-handlers"),path.join(rootDir,"modules")], {rootDir});
let info;
handlers.get(3904).handle({decryptCopy:Buffer.from, constants:{DEFENCE_INFO_ACK:3905}, buildDefenceInfoAckPayload:(id,user)=>{assert.equal(id,23);assert.equal(user.nickname,"Fixture");return Buffer.from([0]);},sendGameResponse:(_socket,_packet,id,payload)=>{info={id,payload};}}, {session:{user:{nickname:"Fixture"}}}, {payload:codec.writeSignedVarInt(23)});
assert.equal(info.id,3905,"actual 3904 registry handler completes the native event entry");
const collectionRows = manager.getRegistry().entries.filter(entry => entry.source.tableName === "EVENT_COLLECTION_INDEX_TEMPLET");
const legacy = collectionRows.find(entry => Number(entry.raw.EventID) === 26);
assert(legacy, "the actual frozen catalog contains an older collaboration module");
const date = new Date("2025-04-10T15:00:00Z");
const copiedOfficialIntervals = new Map([[legacy.raw.DateStrID,{strKey:legacy.raw.DateStrID,startDate:new Date("2025-04-01"),endDate:new Date("2025-05-01")}]]);
for (const row of actual.intervalData) copiedOfficialIntervals.set(row.strKey,row);
const oldTags = new Set([legacy.raw.OpenTag,...actual.openTags]);
const selected = collectionRows.find(entry => {
  const interval = copiedOfficialIntervals.get(entry.raw.DateStrID);
  return oldTags.has(entry.raw.OpenTag) && interval && interval.startDate <= date && date < interval.endDate;
});
assert.equal(Number(selected.raw.EventID),58,"copied older active modules cannot steal the native first-open collection choice");
assert(actual.offlineModuleSuppressedIntervalStrKeys.includes(legacy.raw.DateStrID));
const closed = actual.intervalData.find(row => row.strKey === legacy.raw.DateStrID);
assert.equal(closed.startDate.getUTCFullYear(),1999,"explicit closure must avoid the native merge's reserved 2000 fallback timing");
assert.equal(closed.endDate.getUTCFullYear(),1999);
assert(!actual.offlineModuleSuppressedIntervalStrKeys.some(key => key.includes("CONTRACT")),"unrelated contract intervals stay untouched");
assert.equal(handlers.get(3900).name,"DEFENCE_GAME_START_REQ");
assert.equal(handlers.get(3902).name,"DEFENCE_GAME_GIVE_UP_REQ");
console.log("[limited-event] PASS frozen native Event 58 / defence 23 / boss dungeon 8030023; all three windows, banner, fallback, historical schedule isolation, disable and actual entry handlers");
