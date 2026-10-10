"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const worldMap = require("../modules/world-map");
const codec = require("../modules/packet-codec");
const schema = require("../packet-schema.json");
const originalForce = process.env.CS_WORLDMAP_FORCE_RAID;
const originalChance = process.env.CS_WORLDMAP_RAID_CHANCE;
delete process.env.CS_WORLDMAP_FORCE_RAID;
process.env.CS_WORLDMAP_RAID_CHANCE = "0";
const fixtures = [];
try {
  const user = { userUid: "1", friendCode: "1", level: 100, nickname: "RaidFixture", inventory: {}, army: {} };
  worldMap.ensureWorldMapState(user);
  const cityId = worldMap.getWorldMapCityIds(user)[0];
  const packets = [];
  const ctx = {
    config: { USE_LOCAL_USER_DB: false }, decryptCopy: Buffer.from,
    buildEncryptedPacket: (_sequence, _id, payload) => payload,
    sendResponse(_socket, _sequence, id, build) { packets.push(id); build(); },
    sendServerGamePacket(_socket, id, payload) {
      packets.push(id);
      fixtures.push({ packetId: id, typeName: schema.packets[String(id)].fullName, payloadBase64: payload.toString("base64") });
    },
  };
  const socket = { session: { user } };
  worldMap.createWorldMapHandlers().find(handler => handler.packetId === 2006).handle(ctx, socket, { sequence: 1, payload: Buffer.concat([codec.writeSignedVarInt(cityId), codec.writeSignedVarInt(0)]) });
  assert.equal(packets[0], 2007, "dispatch is acknowledged before refreshing the encounter");
  assert(packets.includes(2001) && packets.includes(2201), "branch map and raid list must update immediately");
  let city = user.worldMap.cities[String(cityId)];
  const uid = city.eventGroup.eventUid;
  assert.notEqual(uid, "0", "default offline dispatch guarantees an encounter even when the old chance was zero");
  assert(user.worldMap.raids[uid].curHP > 0);
  assert(BigInt(city.mission.completeTime) > 0n, "raid creation must not complete the dispatch or grant its rewards early");
  const inventoryAtStart = JSON.stringify(user.inventory);
  const repeated = worldMap.startWorldMapMission(user, cityId, city.mission.currentMissionID);
  assert.equal(repeated.worldMapEventGroup.eventUid, uid, "repeated dispatch cannot overwrite a living boss");
  assert.equal(Object.keys(user.worldMap.raids).length, 1);
  assert.equal(JSON.stringify(user.inventory), inventoryAtStart);
  const restored = JSON.parse(JSON.stringify(user));
  worldMap.ensureWorldMapState(restored);
  assert.equal(restored.worldMap.cities[String(cityId)].eventGroup.eventUid, uid, "relogin retains the encounter");
  const result = worldMap.completeWorldMapMission(user, cityId, { now: BigInt(city.mission.completeTime) });
  assert(result.isSuccess);
  assert.equal(result.worldMapEventGroup.eventUid, uid, "completion cannot create a duplicate after immediate spawn");
  worldMap.clearActiveRaids(user);
  const next = worldMap.startWorldMapMission(user, cityId, 0);
  assert.notEqual(next.worldMapEventGroup.eventUid, uid, "clearing the existing encounter permits the next dispatch boss");
  assert.equal(Object.keys(user.worldMap.raids).length, 1);
  const secondCity = 2;
  assert.equal(worldMap.unlockCity(user, secondCity).errorCode, 0);
  const elsewhere = worldMap.startWorldMapMission(user, secondCity, 0);
  assert.notEqual(elsewhere.worldMapEventGroup.eventUid, next.worldMapEventGroup.eventUid, "branches keep independent bosses");

  process.env.CS_WORLDMAP_FORCE_RAID = "0";
  const classic = { userUid: "2", inventory: {}, army: {} };
  worldMap.ensureWorldMapState(classic);
  const start = worldMap.startWorldMapMission(classic, cityId, 0);
  assert.equal(start.worldMapEventGroup, null, "explicit opt-out restores completion-time probability");
  const finish = worldMap.completeWorldMapMission(classic, cityId, { now: start.completeTime });
  assert.equal(finish.worldMapEventGroup.eventUid, "0", "zero chance remains zero when opted out");
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ fixtures }, null, 2) + "\n");
  console.log("[world-map-guaranteed-raid] PASS immediate dispatch boss, map/list refresh, no early reward, duplicate/relogin guard, repeated and independent branches, probability opt-out");
} finally {
  if (originalForce == null) delete process.env.CS_WORLDMAP_FORCE_RAID; else process.env.CS_WORLDMAP_FORCE_RAID = originalForce;
  if (originalChance == null) delete process.env.CS_WORLDMAP_RAID_CHANCE; else process.env.CS_WORLDMAP_RAID_CHANCE = originalChance;
}
