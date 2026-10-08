"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const schema = require("../packet-schema.json");
const { writeSignedVarInt, readSignedVarInt } = require("../modules/packet-codec");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { getAllEquipIds, getEquipTemplet, isUsableEquipTemplet } = require("../modules/game-data");
const { grantEquipItem, getEquipItems } = require("../modules/equipment");
const { handleAdminCommand, ensureAdminState } = require("../modules/admin");
const { PACKETS: itemPackets, createItemHandler } = require("../modules/item");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
for (const [key, id] of Object.entries(itemPackets)) {
  assert.equal(schema.packets[id].name, `NKMPacket_${key}`, `incorrect ${key} packet id`);
}
assert.equal(handlers.get(1008).name, "EQUIPMENT_PIPELINE_1008");
assert.equal(handlers.get(1026).name, "EQUIPMENT_PIPELINE_1026");

// Exercise the registered client route and the standalone item fallback.
for (const handler of [handlers.get(1008), createItemHandler(1008, "RANDOM_ITEM_BOX_OPEN_REQ")]) {
  const user = { userUid: "1" };
  grantMiscItem(user, 621, 3);
  let response = null;
  let saved = 0;
  const ctx = {
    config: { USE_LOCAL_USER_DB: true },
    decryptCopy: (payload) => payload,
    dateTimeBinaryNow: () => 1n,
    saveUserDb: () => { saved += 1; },
    sendResponse(_socket, _sequence, packetId, build) { response = { packetId, payload: build() }; },
    buildEncryptedPacket: (_sequence, _packetId, payload) => payload,
  };
  handler.handle(ctx, { session: { user } }, {
    sequence: 1,
    payload: Buffer.concat([writeSignedVarInt(621), writeSignedVarInt(3)]),
  });
  assert.equal(response.packetId, 1009);
  assert.equal(readSignedVarInt(response.payload).value, 0);
  assert.equal(getMiscItem(user, 621).countFree, "0", "opened boxes were re-granted");
  const contents = [622, 623, 624].reduce((total, id) => total + BigInt(getMiscItem(user, id).countFree), 0n);
  assert.ok(contents >= 3n && contents <= 6n, "three boxes must grant contents within their table quantity bounds");
  assert.equal(saved, 1);
}

for (const handler of [handlers.get(1008), createItemHandler(1008, "RANDOM_ITEM_BOX_OPEN_REQ"),
  handlers.get(1026), createItemHandler(1026, "CHOICE_ITEM_USE_REQ")]) {
  const choice = handler.packetId === 1026;
  const itemId = choice ? 1060 : 621;
  const fields = (id, count, rewardId = 15) => choice ? [id, rewardId, count, 0, 0] : [id, count];
  const run = (user, values, expectedError) => {
    let missions = 0;
    let ack = null;
    handler.handle({
      config: { USE_LOCAL_USER_DB: true },
      decryptCopy: (payload) => payload,
      dateTimeBinaryNow: () => 1n,
      saveUserDb() {},
      trackMissionEvent() { missions += 1; return []; },
      sendResponse(_socket, _sequence, id, build) { ack = { id, payload: build() }; },
      buildEncryptedPacket: (_sequence, _packetId, payload) => payload,
    }, { session: { user } }, { sequence: 1, payload: Buffer.concat(values.map(writeSignedVarInt)) });
    assert.equal(ack.id, handler.packetId + 1);
    assert.equal(readSignedVarInt(ack.payload).value, expectedError);
    assert.equal(missions, expectedError ? 0 : 1, "rejected requests must not advance missions");
  };
  for (const values of [fields(itemId, 0), fields(itemId, -1), fields(itemId, 3),
    fields(987654321, 1), fields(1, 1), ...(choice ? [fields(itemId, 1, 987654321)] : [])]) {
    const user = { userUid: "4" };
    grantMiscItem(user, itemId, 1, 1);
    const before = JSON.stringify(user);
    run(user, values, 111);
    assert.equal(JSON.stringify(user), before, "rejected item request mutated the save");
  }
  const emptyUser = { userUid: "5" };
  run(emptyUser, fields(itemId, 1), 111);
  assert.deepEqual(emptyUser, { userUid: "5" }, "rejection must not initialize empty inventory");
  const user = { userUid: "6" };
  grantMiscItem(user, itemId, 1, 1);
  run(user, fields(itemId, 2), 0);
  assert.equal(getMiscItem(user, itemId).countFree, "0");
  assert.equal(getMiscItem(user, itemId).countPaid, "0");
  if (choice) assert.equal(getMiscItem(user, 15).countFree, "2");
}

const allIds = getAllEquipIds({ includeTestEquipment: true });
const testIds = allIds.filter((id) => /(?:^|_)TEST(?:_|$)/.test(getEquipTemplet(id).m_ItemEquipStrID));
const safeIds = getAllEquipIds();
assert.ok(testIds.length > 0, "test gear fixture missing");
assert.ok(safeIds.length > 100);
assert.ok(safeIds.every((id) => isUsableEquipTemplet(getEquipTemplet(id))));
assert.ok(testIds.every((id) => !safeIds.includes(id)));

const bulkUser = { userUid: "2" };
const bulk = handleAdminCommand({}, bulkUser, "/give all gears");
assert.ok(bulk.createdPosts > 0);
const rewardIds = ensureAdminState(bulkUser).posts.flatMap((post) => post.rewards.map((reward) => reward.id));
assert.deepEqual(rewardIds, safeIds);
assert.equal(handleAdminCommand({}, bulkUser, `/give gear ${testIds[0]}`).createdPosts, 0);
assert.equal(grantEquipItem(bulkUser, testIds[0]), null, "test gear must not enter inventory through rewards");

const user = { userUid: "3" };
const legal = grantEquipItem(user, 561141, { locked: true });
const material = grantEquipItem(user, 90001);
assert.ok(legal && material, "normal gear and enchant materials must remain usable");
const broken = { equipUid: "901", itemEquipId: testIds[0], locked: true, ownerUnitUid: "101", stats: [] };
user.inventory.equips[broken.equipUid] = broken;
user.inventory.equips["902"] = { equipUid: "902", itemEquipId: 987654321, locked: true };
user.army.units["101"] = { unitUid: "101", userUid: "3", unitId: 1001, equipItemUids: ["901", legal.equipUid, 0, 0] };
user.inventory.equipPresets = [{ presetIndex: 0, equipUids: ["901", legal.equipUid, 0, 0] }];
const repaired = handleAdminCommand({}, user, "/repair gears");
assert.match(repaired.reply, /Quarantined 2/);
assert.equal(user.inventory.quarantinedEquips["901"].item, broken, "original invalid entry must be preserved");
assert.equal(user.army.units["101"].equipItemUids[0], 0);
assert.equal(user.inventory.equipPresets[0].equipUids[0], 0);
assert.deepEqual(getEquipItems(user).map((equip) => equip.itemEquipId).sort((a, b) => a - b), [90001, 561141]);
assert.ok(getEquipItems(user).find((equip) => equip.equipUid === legal.equipUid).locked);
assert.match(handleAdminCommand({}, user, "/repair gears").reply, /Quarantined 0/);
assert.equal(Object.keys(user.inventory.quarantinedEquips).length, 2);
const restored = JSON.parse(JSON.stringify(user));
assert.equal(getEquipItems(restored).length, 2, "quarantine must survive save/reload without restoring bad gear");
assert.equal(Object.keys(restored.inventory.quarantinedEquips).length, 2);

console.log(`item/admin repair checks passed (${safeIds.length} playable gear, ${testIds.length} excluded test entries)`);
