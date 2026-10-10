const assert = require("node:assert/strict");
const { ensureArmy, ensureDeck, setDeckOperator, setDeckShip, setDeckUnit } = require("../modules/unit");
const { normalizeShipCommandModules } = require("../modules/unit");

const threeModules = [1, 2, 3].map(rank => ({ slots: [{ targetStyleType: ["NUST_COUNTER"], targetRoleType: [], statType: "NST_ATK_FACTOR", statValue: rank / 100, isLock: true }] }));
assert.equal(normalizeShipCommandModules(threeModules).length, 3, "Third ship limit-break module must survive normalization");
assert.equal(normalizeShipCommandModules(threeModules)[2].slots[0].statValue, 0.03);
assert.equal(normalizeShipCommandModules([]).length, 0, "Ships without unlocked modules must retain an empty list");
assert.equal(normalizeShipCommandModules(threeModules.slice(0, 1)).length, 1, "Normalization must not unlock a second module");

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

user.army.ships[201].unitId = 26022;
user.army.ships[201].level = 130;
user.army.ships[201].limitBreakLevel = 3;
user.army.ships[201].shipCommandModules = threeModules;
user.army.ships[201].skillLevels = [5, 5, 5, 5, 5];
ensureArmy(user);
assert.deepEqual(user.army.ships[201].skillLevels, [1, 0, 0, 0, 0], "Patrol ship has one enhanced template skill and four empty slots");
const fullShip = buildPlayerDeckForGameLoad(user, { gameType: 17, selectDeckIndex: 0 });
assert.equal(fullShip.shipCommandModules.length, 3, "Game load must carry all three unlocked ship modules");
assert.deepEqual(fullShip.shipSkillLevels, [1, 0, 0, 0, 0]);
console.log("Raid extended loadouts: legacy16, live24, slot23, wire24, GuildBoss17 PASS");
