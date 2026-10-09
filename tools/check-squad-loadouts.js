const assert = require("node:assert/strict");
const { ensureArmy, ensureDeck, setDeckOperator, setDeckShip, setDeckUnit } = require("../modules/unit");

const user = {
  userUid: "1",
  army: {
    units: { 101: { unitUid: "101", userUid: "1", unitId: 1001, level: 1 } },
    ships: { 201: { unitUid: "201", userUid: "1", unitId: 21001, level: 1 } },
    operators: { 301: { uid: "301", id: 10001, level: 1 } },
  },
};

ensureArmy(user);

setDeckUnit(user, { deckType: 1, index: 0 }, 0, "101");
setDeckUnit(user, { deckType: 1, index: 1 }, 0, "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).unitUids[0], "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[0], "101");
setDeckUnit(user, { deckType: 1, index: 1 }, 1, "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[0], 0);
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[1], "101");

for (const index of [0, 1]) {
  setDeckShip(user, { deckType: 1, index }, "201");
  setDeckOperator(user, { deckType: 1, index }, "301");
}
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).operatorUid, "301");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).operatorUid, "301");

for (const index of [0, 1]) {
  setDeckUnit(user, { deckType: 8, index }, 0, "101");
  setDeckShip(user, { deckType: 8, index }, "201");
  setDeckOperator(user, { deckType: 8, index }, "301");
}
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).unitUids[0], 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).shipUid, 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).operatorUid, 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).unitUids[0], "101");
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).operatorUid, "301");

console.log("Squad loadout checks passed.");

const { buildDeckData, readString, readSignedVarLong } = require("../modules/packet-codec");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const raid = ensureDeck(user, { deckType: 4, index: 0 });
assert.equal(raid.unitUids.length, 16, "legacy raid decks remain sixteen slots");
setDeckUnit(user, { deckType: 4, index: 0 }, 23, "101");
const extended = ensureDeck(user, { deckType: 4, index: 0 });
assert.equal(extended.unitUids.length, 24);
assert.equal(extended.unitUids[23], "101");
ensureArmy(user);
assert.equal(ensureDeck(user, { deckType: 4, index: 0 }).unitUids[23], "101", "normalization must retain extended raid slots");
const payload = buildDeckData(extended);
let offset = readString(payload, 0).offset;
offset = readSignedVarLong(payload, offset).offset;
offset = readSignedVarLong(payload, offset).offset;
assert.equal(payload[offset], 24, "wire deck list must preserve twenty-four slots");
const deployment = buildPlayerDeckForGameLoad(user, { gameType: 17, selectDeckIndex: 0 });
assert.equal(deployment.deckType, 4);
assert(deployment.units.some(unit => unit.slotIndex === 23 && unit.unitUid === "101"), "formal Guild Boss loads the actual RAID extended selection");
setDeckUnit(user, { deckType: 4, index: 0 }, 24, "101");
assert.equal(ensureDeck(user, { deckType: 4, index: 0 }).unitUids.length, 24, "out-of-range edits cannot create more than twenty-four slots");
console.log("Raid extended loadouts: legacy16, live24, slot23, wire24, GuildBoss17 PASS");
