const assert = require("node:assert/strict");
const game = require("../modules/game-data");
const { equipAllUnits, validateUser } = require("./optimize-user-loadouts");
const { makeMaximumPotential, makeLifeSpecializedVariant } = require("./audit-user-mitigation");

const units = {};
for (const [uid, id, level] of [[101, 1002, 120], [102, 1009, 120], [103, 1042, 120], [104, 1013, 1], [105, 1072, 120], [106, 1280, 120], [107, 1071, 120]]) {
  units[String(uid)] = { unitUid: String(uid), unitId: id, level, equipItemUids: [0, 0, 0, 0], skillLevels: [5, 5, 5, 5, 5] };
}
const user = { army: { units, ships: {}, deckSets: { 1: [{ unitUids: ["101", "102", "105"], leaderIndex: 0 }] } }, inventory: { equips: {} }, nextEquipUid: "70000", progress: { completed: [1, 2] }, privateGuildData: { score: 100 } };
const critical = "NST_CRITICAL_DAMAGE_RESIST_RATE", land = "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE";
const hpProfile = { mode: "tank", familyPreferences: [["Inhibitor"], ["Maze"], ["Inhibitor"], ["Inhibitor"]], statPriority: [land, critical], potentialPriorityBySlot: [[critical], [critical], ["NST_SHORT_RANGE_DAMAGE_REDUCE_RATE"], ["NST_LONG_RANGE_DAMAGE_REDUCE_RATE"]] };
const guides = { units: Object.fromEntries([1002, 1009, 1042, 1013].map((id) => [id, hpProfile])) };
guides.units[1072] = { ...hpProfile, mode: "tankCdr" };
guides.units[1280] = { ...hpProfile, mode: "tankAspd", forbiddenStats: ["NST_SKILL_COOL_TIME_REDUCE_RATE"] };
guides.units[1071] = { mode: "tank", private: true, equipmentIds: [1101071, 1111071, 1121071, 2461342], potentialPriorityBySlot: [[], [], [], [critical]], statPriorityBySlot: [["NST_SKILL_COOL_TIME_REDUCE_RATE", land], [critical, land], ["NST_LONG_RANGE_DAMAGE_REDUCE_RATE", land], [land, critical]] };
equipAllUnits(user, guides, 1);
validateUser(user);
const database = { users: { accountA: user, accountB: { progress: { keep: true } } }, activeUserUid: "accountA", metadata: { preserved: true } };
const original = structuredClone(database);
const result = makeLifeSpecializedVariant(database, "accountA", { includeNaYubin: true });
assert.equal(result.changes.length, 4, "Three cultivated HP tanks and one Na Yubin accessory may change");
assert.deepEqual(database, original, "Input database must not mutate");
assert.deepEqual(result.database.users.accountB, original.users.accountB);
assert.deepEqual(result.database.metadata, original.metadata);
assert.deepEqual(result.database.users.accountA.army, original.users.accountA.army, "All unit growth, UIDs and deck records are preserved");
for (const [uid, item] of Object.entries(original.users.accountA.inventory.equips)) if (item.ownerUnitUid === "-1") assert.deepEqual(result.database.users.accountA.inventory.equips[uid], item);
const specialized = result.database.users.accountA;
for (const uid of ["101", "102", "103"]) {
  const weapon = specialized.inventory.equips[specialized.army.units[uid].equipItemUids[0]];
  assert.equal(weapon.potentialOptions[0].statType, "NST_HP_FACTOR");
  assert.equal(weapon.potentialOptions[0].optionKey, 246114103);
  assert.deepEqual(weapon.potentialOptions[0].sockets.map((s) => s.statValue), [0.013, 0.026, 0.026]);
}
for (const uid of ["104", "105", "106"]) for (const itemUid of original.users.accountA.army.units[uid].equipItemUids) assert.deepEqual(specialized.inventory.equips[itemUid], original.users.accountA.inventory.equips[itemUid], "Untrained, CDR, and Fury/ASPD tank equipment must stay unchanged");
const accessory = specialized.inventory.equips[specialized.army.units[107].equipItemUids[3]];
assert.equal(accessory.potentialOptions[0].optionKey, 246134103);
assert.deepEqual(accessory.potentialOptions[0].sockets.map((s) => s.statValue), [0.014, 0.028, 0.028]);
const template = game.getEquipTemplet(2461141);
assert.throws(() => makeMaximumPotential(template, accessory.potentialOptions[0], land), /unsupported/, "An illegal ground-reduction potential must never be invented");
assert.ok(result.changes.every((change) => change.criticalResistanceAfter >= 0.32), "Armor critical resistance remains in place");
console.log("Mitigation audit synthetic checks passed.");
