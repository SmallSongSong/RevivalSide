const assert = require("node:assert/strict");
const game = require("../modules/game-data");
const { createEquipData } = require("../modules/equipment");
const { chooseDuplicates, deduplicateUser, maximizeEquip, equipAllUnits, equipPveBossUnits, validateUser, maxRecordValue, remapReferences, privateAllowed, annotateNativePowerReport } = require("./optimize-user-loadouts");

function unit(unitUid, unitId, extras = {}) {
  return { unitUid, unitId, userUid: "1", level: 1, equipItemUids: [0, 0, 0, 0], ...extras };
}
const original = {
  userUid: "1", mainUnitId: 1001, mainUnitSkinId: 0, mainUnitTacticLevel: 0, nextEquipUid: "20000",
  army: { units: {
    101: unit("101", 1001, { level: 120, isFavorite: true, equipItemUids: ["10001", 0, 0, 0] }),
    102: unit("102", 1001, { level: 1, tacticLevel: 6, skinId: 10 }),
    103: unit("103", 2001), 104: unit("104", 11001),
  }, ships: {}, deckSets: { 1: [{ unitUids: ["101", "102", "103", "104"], leaderIndex: 1 }] } },
  inventory: { equips: { 10001: createEquipData(1561141, 10001n, { regDate: "0" }) } },
  worldMap: { city: { leaderUnitUID: "101" }, dive: { hp: { 101: 75, 102: 100 }, deadUnitUids: ["101"] } },
  collection: { representativeUnitUid: "101" },
  office: { rooms: [{ unitUids: ["101", "999999", 0] }] },
  archive: { units: [unit("101", 1001), unit("102", 1001)] },
};
original.inventory.equips[10001].ownerUnitUid = "101";
const scores = { source: "native NKMStatData.GetUnitFightPower synthetic fixture", scores: { 101: 100, 102: 500 } };
assert.throws(() => chooseDuplicates(structuredClone(original), { source: "level proxy", scores: { 101: 100, 102: 500 } }), /native/);
assert.throws(() => chooseDuplicates(structuredClone(original), { source: "native", scores: { 101: 100 } }), /Missing native/);
const dedup = deduplicateUser(structuredClone(original), scores);
assert.deepEqual(dedup.mapping, { 101: "102" });
assert.equal(dedup.user.army.units[102].level, 1, "Native score controls selection, not level");
assert.equal(dedup.user.army.units[102].isFavorite, true);
assert.ok(dedup.user.army.units[103], "Rearmed different unit ID must remain");
assert.ok(dedup.user.army.units[104], "Awakened different unit ID must remain");
assert.equal(dedup.user.inventory.equips[10001].ownerUnitUid, "-1");
assert.deepEqual(dedup.user.army.deckSets[1][0].unitUids, ["102", 0, "103", "104"]);
assert.equal(dedup.user.army.deckSets[1][0].leaderIndex, 0);
assert.equal(dedup.user.worldMap.city.leaderUnitUID, "102");
assert.deepEqual(dedup.user.worldMap.dive.hp, { 102: 75 });
assert.equal(dedup.user.collection.representativeUnitUid, "102");
assert.deepEqual(dedup.user.office.rooms[0].unitUids, ["102", 0, 0]);
assert.equal(dedup.clearedDanglingOfficeReferences, 1);
assert.equal(dedup.user.mainUnitSkinId, 10);
assert.equal(dedup.user.mainUnitTacticLevel, 6);
assert.equal(dedup.user.archive.units.length, 1);
const powerReport = annotateNativePowerReport({ units: [{ unitId: 1001, name: "Synthetic fixture" }] }, dedup.user, scores, { source: "original-client CalculateUnitOperationPower", scores: { 102: 450 } });
assert.equal(powerReport.nativePowerValidation.decreased, 1);
assert.equal(powerReport.nativePowerValidation.decreasedUnits[0].delta, -50);
assert.ok(!JSON.stringify(powerReport).includes("unitUid"), "Public native validation report must not contain private unit UIDs");
assert.equal(Object.keys(original.army.units).length, 4, "Original input must remain unchanged");
assert.deepEqual(remapReferences({ 101: { unitUid: "101", hp: 75 }, 102: { unitUid: "102", hp: 100 } }, { 101: "102" }), { 102: { unitUid: "102", hp: 100 } });

const swift = maximizeEquip({ equipUid: "123", itemEquipId: 2161141 }, "cdr");
assert.equal(swift.precision, 100); assert.equal(swift.precision2, 100);
assert.equal(swift.potentialOptions[0].statType, "NST_SKILL_COOL_TIME_REDUCE_RATE");
assert.deepEqual(swift.potentialOptions[0].sockets.map((x) => x.statValue), [0.023, 0.046, 0.046]);
assert.equal(swift.stats[1].value, 0.022);
assert.equal(maxRecordValue({ m_MinStatValue: -0.2, m_MaxStatValue: -0.1 }), -0.2);
assert.equal(maximizeEquip({ equipUid: "457", itemEquipId: 90001 }).setOptionId, 0, "Enhancement modules have no set bonus");
const moduleItem = maximizeEquip({ equipUid: "458", itemEquipId: 90001 });
assert.equal(moduleItem.precision, 0); assert.equal(moduleItem.precision2, 0); assert.equal(moduleItem.stats.length, 1, "No random stat may be invented for enhancement modules");
assert.equal(maximizeEquip({ equipUid: "456", itemEquipId: 561141 }).itemEquipId, 1561141, "Maze upgrade should follow client upgrade table");
assert.ok(privateAllowed(game.getEquipTemplet(1101006), 2006), "Rearmed Kestrel Xiao Lin inherits base Xiao Lin EE");
assert.ok(privateAllowed(game.getEquipTemplet(1101006), 3006), "Rearmed Nest Keeper Xiao Lin inherits base Xiao Lin EE");
assert.ok(!privateAllowed(game.getEquipTemplet(1101006), 1007), "Unrelated units cannot wear Xiao Lin EE");

// A single exclusive accessory can occupy either slot; the other accessory is generic.
const exclusiveUser = { army: { units: { 201: unit("201", 1306), 202: unit("202", 1008) }, ships: {} }, inventory: { equips: {} }, nextEquipUid: "30000" };
const result = equipAllUnits(exclusiveUser, { 1306: { mode: "tank", private: true }, 1008: { mode: "aspd" } }, 1);
const checked = validateUser(exclusiveUser);
assert.equal(checked.equipped, 8); assert.equal(result.selected.length, 2);
const accessories = exclusiveUser.army.units[201].equipItemUids.slice(2).map((uid) => game.getEquipTemplet(exclusiveUser.inventory.equips[uid].itemEquipId));
assert.equal(accessories.filter((t) => t.m_lstPrivateUnitID?.length).length, 1);
for (const uid of exclusiveUser.army.units[202].equipItemUids) assert.equal(game.getEquipTemplet(exclusiveUser.inventory.equips[uid].itemEquipId).m_EquipUnitStyleType, "NUST_SOLDIER");
assert.ok(Object.values(exclusiveUser.inventory.equips).some((e) => e.ownerUnitUid === "-1"), "Spare equipment should remain in inventory");
const inherited = { army: { units: { 301: unit("301", 2006), 302: unit("302", 1001) }, ships: {} }, inventory: { equips: {} }, nextEquipUid: "40000" };
equipAllUnits(inherited, { 2006: { mode: "crit", private: true, privateSlots: ["IEP_ACC"], exclusiveEquipmentIds: [1101006] }, 1001: { mode: "tank", setIds: [220700, 220700, 320300, 320300] } }, 0);
validateUser(inherited);
assert.equal(inherited.army.units[301].equipItemUids.map((uid) => inherited.inventory.equips[uid].itemEquipId).filter((id) => id === 1101006).length, 1);
assert.deepEqual(inherited.army.units[302].equipItemUids.map((uid) => inherited.inventory.equips[uid].setOptionId), [220700, 220700, 320300, 320300]);

const purposeUser = { army: { units: {}, ships: {}, deckSets: { 1: [{ unitUids: ["501", "502", "503"], leaderIndex: 0 }] } }, inventory: { equips: {} }, nextEquipUid: "50000", progress: { completed: [1, 2, 3] }, privateGuildData: { score: 123 } };
const ids = [1001, 1002, 1006, 1246, 1061, 1008];
ids.forEach((id, i) => purposeUser.army.units[String(501 + i)] = unit(String(501 + i), id, { level: 120, skillLevels: [5, 5, 5, 5, 5], reactorLevel: 2 }));
const balanced = { units: { 1001: { mode: "tank" }, 1002: { mode: "tank" }, 1006: { mode: "crit", private: true, exclusiveEquipmentIds: [1101006] }, 1246: { mode: "aspd" }, 1061: { mode: "cdr", private: true, exclusiveEquipmentIds: [1101061] }, 1008: { mode: "aspd" } } };
equipAllUnits(purposeUser, balanced, 1);
const beforePurpose = structuredClone(purposeUser);
const purposeReport = equipPveBossUnits(purposeUser, balanced, { units: { 1001: { mode: "tankCdr", familyPreferences: [["Inhibitor"], ["Maze"], ["Swift"], ["Swift"]], statPriorityBySlot: [undefined, ["NST_CRITICAL_DAMAGE_RESIST_RATE", "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE"], undefined, undefined], potentialPriorityBySlot: [["NST_CRITICAL_DAMAGE_RESIST_RATE"], ["NST_SKILL_COOL_TIME_REDUCE_RATE"], ["NST_SKILL_COOL_TIME_REDUCE_RATE"], ["NST_SKILL_COOL_TIME_REDUCE_RATE"]] }, 1002: { mode: "tank" }, 1246: { mode: "aspd", pveBossReason: "Synthetic Fury unit keeps attack-speed gear" } } });
validateUser(purposeUser);
assert.ok(purposeReport.changedUnits >= 1);
assert.deepEqual(purposeUser.army, beforePurpose.army, "Growth, unit/equipment UIDs and decks must remain unchanged for purpose switch");
assert.deepEqual(purposeUser.progress, beforePurpose.progress);
assert.deepEqual(purposeUser.privateGuildData, beforePurpose.privateGuildData);
assert.equal(purposeUser.nextEquipUid, beforePurpose.nextEquipUid);
assert.deepEqual(Object.keys(purposeUser.inventory.equips), Object.keys(beforePurpose.inventory.equips));
for (const [uid, e] of Object.entries(beforePurpose.inventory.equips)) if (e.ownerUnitUid === "-1") assert.deepEqual(purposeUser.inventory.equips[uid], e, "Existing spare inventory must remain byte-for-byte equivalent");
assert.ok(purposeUser.army.units[502].equipItemUids.every((uid) => purposeUser.inventory.equips[uid].setOptionId === 220700), "Real tank HP profile must be preserved");
assert.ok(purposeUser.army.units[504].equipItemUids.every((uid) => purposeUser.inventory.equips[uid].setOptionId === 242100), "Fury profile must not switch to CDR");
assert.ok(purposeUser.army.units[501].equipItemUids.every((uid) => purposeUser.inventory.equips[uid].setOptionId === 241900), "Skill-tank profile may switch to survival CDR");
const survivalGear = purposeUser.army.units[501].equipItemUids.map((uid) => purposeUser.inventory.equips[uid]);
assert.equal(survivalGear[0].potentialOptions[0].statType, "NST_CRITICAL_DAMAGE_RESIST_RATE");
assert.equal(survivalGear[2].potentialOptions[0].statType, "NST_SKILL_COOL_TIME_REDUCE_RATE");
const criticalResistance = survivalGear.flatMap((e) => e.stats.slice(1)).filter((s) => s.type === "NST_CRITICAL_DAMAGE_RESIST_RATE").reduce((n, s) => n + s.value, 0) + survivalGear.flatMap((e) => e.potentialOptions).filter((p) => p.statType === "NST_CRITICAL_DAMAGE_RESIST_RATE").flatMap((p) => p.sockets).reduce((n, s) => n + s.statValue, 0);
assert.ok(criticalResistance >= 0.5, "Survival CDR can retain boss critical-damage resistance without changing every socket away from CDR");
assert.ok(purposeUser.army.units[503].equipItemUids.every((uid) => purposeUser.inventory.equips[uid].setOptionId === 241700), "Guaranteed-crit damage profile remains distinct");
const mixedPurpose = { army: { units: { 601: unit("601", 1001) }, ships: {} }, inventory: { equips: {} }, nextEquipUid: "60000" };
const mixedBase = { units: { 1001: { mode: "tank", setIds: [220700, 220700, 320300, 320300] } } };
equipAllUnits(mixedPurpose, mixedBase, 0);
equipPveBossUnits(mixedPurpose, mixedBase, { profilePurpose: "pve-boss", units: { 1001: { mode: "tank", setId: 340500 } } });
assert.ok(mixedPurpose.army.units[601].equipItemUids.every((uid) => mixedPurpose.inventory.equips[uid].setOptionId === 340500), "A complete purpose row must remove obsolete balanced mixed-set overrides");
console.log("Save loadout optimizer synthetic checks passed.");
