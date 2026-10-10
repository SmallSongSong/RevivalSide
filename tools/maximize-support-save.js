const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const game = require("../modules/game-data");
const codec = require("../modules/packet-codec");
const { privateWrite } = require("./optimize-user-loadouts");
const { normalizeShipCommandModules, ensureArmy } = require("../modules/unit");

function records(directory, name) {
  const data = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`)));
  const rows = Object.values(data.globals).find(Array.isArray);
  assert.ok(rows?.length, `Missing frozen records: ${name}`);
  return rows;
}
function hash(filename) { return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex"); }
function tables(directory) {
  return Object.fromEntries(["LUA_OPERATOR_SKILL_TEMPLET", "LUA_OPERATOR_EXP_TEMPLET", "LUA_SHIP_BUILD_TEMPLET", "LUA_SHIP_LEVELUP_TEMPLET", "LUA_SHIP_LIMITBREAK_TEMPLET", "LUA_COMMANDMODULE_TEMPLET", "LUA_COMMANDMODULE_PASSIVE_TEMPLET", "LUA_COMMANDMODULE_RANDOM_STAT"].map(name => [name, records(directory, name)]));
}
function preferredStyle(user, shipUid) {
  const counts = {};
  for (const deck of Object.values(user.army.deckSets).flat()) {
    if (String(deck.shipUid) !== String(shipUid)) continue;
    for (const uid of deck.unitUids || []) {
      const unit = user.army.units[String(uid)];
      const style = unit && game.getUnitTemplet(unit.unitId)?.m_NKM_UNIT_STYLE_TYPE;
      if (["NUST_COUNTER", "NUST_SOLDIER", "NUST_MECHANIC"].includes(style)) counts[style] = (counts[style] || 0) + 1;
    }
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "NUST_COUNTER";
}
function maxSlot(t, group, style, role, preferredStat) {
  const passive = t.LUA_COMMANDMODULE_PASSIVE_TEMPLET.find(row => row.CMDPassiveGroupID === group
    && (style ? row.ListRangeSonAllowStyleType?.includes(style) : row.ListRangeSonAllowRoleType?.includes(role)));
  assert.ok(passive, `No legal module target in group ${group}`);
  const stat = t.LUA_COMMANDMODULE_RANDOM_STAT.find(row => row.StatGroupID === passive.StatGroupID && row.StatType === preferredStat);
  assert.ok(stat, `No legal module stat ${preferredStat}`);
  const statType = stat.MaxStatFactor != null ? `${stat.StatType}_FACTOR` : stat.StatType;
  const statValue = Number(stat.MaxStatFactor ?? stat.MaxStatValue);
  assert.ok(statValue > 0 && statValue < 1, "Module roll must be a bounded, legal fraction");
  return { targetStyleType: style ? [style] : [], targetRoleType: role ? [role] : [], statType, statValue, isLock: true };
}
function maximize(database, activeUid, t) {
  const result = structuredClone(database), user = result.users[activeUid];
  assert.ok(user?.army, "Active account missing");
  const report = { operators: [], ships: [] };
  for (const op of Object.values(user.army.operators)) {
    const unit = game.getUnitTemplet(op.id);
    assert.equal(unit?.m_NKM_UNIT_TYPE, "NUT_OPERATOR");
    const main = t.LUA_OPERATOR_SKILL_TEMPLET.find(row => row.m_OperSkillStrID === unit.m_SkillStrID1 && row.m_OperSkillType === "m_Tactical");
    const sub = t.LUA_OPERATOR_SKILL_TEMPLET.find(row => row.m_OperSkillID === op.subSkill?.id && row.m_OperSkillType === "m_Passive");
    assert.ok(main && sub, "Operator must have its own tactical skill and an existing legal passive");
    const maxLevel = Math.max(...t.LUA_OPERATOR_EXP_TEMPLET.filter(row => row.m_NKM_UNIT_GRADE === unit.m_NKM_UNIT_GRADE).map(row => row.m_iLevel));
    const before = { level: op.level, mainSkill: structuredClone(op.mainSkill), subSkill: structuredClone(op.subSkill) };
    op.level = maxLevel; op.exp = 0;
    op.mainSkill = { ...op.mainSkill, id: main.m_OperSkillID, level: main.m_MaxSkillLevel, exp: 0 };
    op.subSkill = { ...op.subSkill, level: sub.m_MaxSkillLevel, exp: 0 };
    report.operators.push({ id: op.id, uid: op.uid, before, after: { level: op.level, mainSkill: op.mainSkill, subSkill: op.subSkill } });
  }
  for (const ship of Object.values(user.army.ships)) {
    const before = { unitId: ship.unitId, level: ship.level, limitBreakLevel: ship.limitBreakLevel, skillLevels: ship.skillLevels, shipCommandModules: ship.shipCommandModules };
    const visited = new Set();
    while (true) {
      assert.ok(!visited.has(ship.unitId), "Ship upgrade chain contains a cycle"); visited.add(ship.unitId);
      const row = t.LUA_SHIP_BUILD_TEMPLET.find(row => row.m_ShipID === ship.unitId);
      assert.ok(row, "Ship must exist in frozen build table");
      if (!row.m_ShipUpgradeTarget1) break;
      ship.unitId = row.m_ShipUpgradeTarget1;
    }
    const unit = game.getUnitTemplet(ship.unitId);
    assert.equal(unit?.m_NKM_UNIT_TYPE, "NUT_SHIP");
    const breaks = t.LUA_SHIP_LIMITBREAK_TEMPLET.filter(row => row.ShipID === ship.unitId);
    ship.limitBreakLevel = breaks.length ? Math.max(...breaks.map(row => row.ShipLimitBreakGrade)) : 0;
    const growth = t.LUA_SHIP_LEVELUP_TEMPLET.find(row => row.m_ShipStarGrade === unit.m_StarGradeMax && row.m_ShipRareGrade === unit.m_NKM_UNIT_GRADE && Number(row.m_ShipLimitBreakGrade || 0) === ship.limitBreakLevel);
    assert.ok(growth, "Ship level must come from its grade and unlocked limit-break table");
    ship.level = growth.m_ShipMaxLevel; ship.exp = 0;
    ship.skillLevels = [1, 2, 3, 4, 5].map(index => unit[`m_SkillStrID${index}`] ? 1 : 0);
    const style = preferredStyle(user, ship.unitUid);
    ship.shipCommandModules = [];
    for (let rank = 1; rank <= ship.limitBreakLevel; rank++) {
      const module = t.LUA_COMMANDMODULE_TEMPLET.find(row => row.ShipType === unit.m_NKM_UNIT_STYLE_TYPE && row.ShipGrade === unit.m_NKM_UNIT_GRADE && row.ShipLimitBreakGrade === rank);
      assert.ok(module, "Each module must be unlocked by a real limit-break rank");
      ship.shipCommandModules.push({ slots: [maxSlot(t, module.CommandModuleSlot1, style, null, rank === 2 ? "NST_HP" : "NST_ATK"), maxSlot(t, module.CommandModuleSlot2, null, rank === 2 ? "NURT_DEFENDER" : "NURT_RANGER", rank === 2 ? "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE" : "NST_MOVE_TYPE_LAND_DAMAGE_RATE")] });
    }
    assert.deepEqual(normalizeShipCommandModules(ship.shipCommandModules), ship.shipCommandModules, "Runtime must retain every unlocked module");
    report.ships.push({ uid: ship.unitUid, before, after: { unitId: ship.unitId, level: ship.level, limitBreakLevel: ship.limitBreakLevel, skillLevels: ship.skillLevels, shipCommandModules: ship.shipCommandModules } });
  }
  const normalized = structuredClone(user);
  ensureArmy(normalized);
  for (const op of Object.values(user.army.operators)) {
    const actual = normalized.army.operators[op.uid];
    assert.equal(actual.level, op.level, "Runtime must retain maximum operator level");
    assert.deepEqual(actual.mainSkill, op.mainSkill);
    assert.deepEqual(actual.subSkill, op.subSkill);
  }
  for (const ship of Object.values(user.army.ships)) {
    const actual = normalized.army.ships[ship.unitUid];
    for (const field of ["unitId", "level", "limitBreakLevel", "skillLevels", "shipCommandModules"]) assert.deepEqual(actual[field], ship[field], "Runtime must retain maximum ship growth");
  }
  // The complete database must differ only in the two requested support rosters.
  const reconstructed = structuredClone(result);
  reconstructed.users[activeUid].army.operators = structuredClone(database.users[activeUid].army.operators);
  reconstructed.users[activeUid].army.ships = structuredClone(database.users[activeUid].army.ships);
  assert.deepEqual(reconstructed, database, "Equipment, characters, decks, guilds, progress and other accounts must remain unchanged");
  return { database: result, report };
}
function wireFixture(user) {
  return {
    units: [...Object.values(user.army.units), ...Object.values(user.army.ships)].map(unit => ({ uid: unit.unitUid, payloadBase64: codec.buildUnitData(unit).toString("base64"), equipmentUids: unit.equipItemUids,
      ...(user.army.ships[String(unit.unitUid)] ? { id: unit.unitId, level: unit.level, limitBreakLevel: unit.limitBreakLevel, shipModuleCount: unit.shipCommandModules.length } : {}) })),
    equipment: Object.values(user.inventory.equips).map(item => ({ uid: item.itemUid, payloadBase64: codec.buildEquipItemData(item).toString("base64") })),
    operators: Object.values(user.army.operators).map(op => ({ uid: op.uid, id: op.id, level: op.level, mainSkill: op.mainSkill, subSkill: op.subSkill, payloadBase64: codec.buildOperatorData(op).toString("base64") })),
  };
}
function main(argv) {
  const args = {}; for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  assert.ok(args.input && args.output && args.frozen && args["active-user"] && args.name, "Provide --input --output --frozen --active-user --name");
  const output = path.resolve(args.output), input = path.resolve(args.input);
  assert.ok(!output.startsWith(path.resolve(__dirname, "..") + path.sep), "Private saves must remain outside the repository");
  assert.equal(path.basename(args.name), args.name);
  assert.notEqual(path.join(output, args.name), input);
  const originalHash = hash(input), original = JSON.parse(fs.readFileSync(input));
  const uid = String(JSON.parse(fs.readFileSync(args["active-user"])).activeUserUid);
  const result = maximize(original, uid, tables(args.frozen));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.chmodSync(output, 0o700);
  privateWrite(path.join(output, args.name), result.database);
  privateWrite(path.join(output, `${args.name}.changes.json`), result.report);
  privateWrite(path.join(output, `${args.name}.wire.json`), wireFixture(result.database.users[uid]));
  assert.equal(hash(input), originalHash, "Original source must not change");
  privateWrite(path.join(output, `${args.name}.integrity.json`), { sourceSha256: originalHash, outputSha256: hash(path.join(output, args.name)), sourceUnchanged: true, onlySupportRostersChanged: true, operatorCount: result.report.operators.length, shipCount: result.report.ships.length });
  console.log(JSON.stringify({ operators: result.report.operators.length, ships: result.report.ships.length, sourceUnchanged: true }));
}
module.exports = { maximize, tables, wireFixture };
if (require.main === module) main(process.argv.slice(2));
