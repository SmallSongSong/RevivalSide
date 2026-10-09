const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const game = require("../modules/game-data");
const { createEquipData } = require("../modules/equipment");
const { getInventoryCapacity, INVENTORY_TYPES } = require("../modules/inventory-capacity");

// Reads an external save and writes a separate copy. Real save data must stay outside the repository.
const ROOT = path.resolve(__dirname, "..");
const POSITION = ["IEP_WEAPON", "IEP_DEFENCE", "IEP_ACC", "IEP_ACC"];
const CDR = "NST_SKILL_COOL_TIME_REDUCE_RATE";
const ASPD = "NST_ATTACK_SPEED_RATE";
const LAND = "NST_MOVE_TYPE_LAND_DAMAGE_RATE";
const LAND_RES = "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE";
const MODE_SETS = { cdr: 241900, tankCdr: 241900, aspd: 242100, tankAspd: 242100, tank: 220700, crit: 241700, atk: 220800 };
const names = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, "wiki/data/gears.json"))).map((x) => [Number(x.id), x.name]));
const unitNames = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, "wiki/data/units.json"))).map((x) => [Number(x.id), x.name]));
const templates = game.getAllEquipIds().map(game.getEquipTemplet);

function unitGroups(user) {
  const groups = new Map();
  for (const unit of Object.values(user.army.units || {})) {
    const key = Number(unit.unitId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }
  return groups;
}

function chooseDuplicates(user, powerData) {
  assert.match(String(powerData?.source || ""), /native|NKMStatData|original-client CalculateUnitOperationPower/i, "Duplicate selection requires documented native fight-power scores");
  const mapping = {}, selections = [];
  for (const [unitId, units] of unitGroups(user)) {
    if (units.length < 2) continue;
    for (const unit of units) assert.ok(Number.isFinite(Number(powerData.scores?.[unit.unitUid])) && Object.hasOwn(powerData.scores, unit.unitUid), `Missing native score for unit ID ${unitId}`);
    const sorted = units.slice().sort((a, b) => Number(powerData.scores[b.unitUid]) - Number(powerData.scores[a.unitUid]) || Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || (BigInt(a.unitUid) < BigInt(b.unitUid) ? -1 : 1));
    const keeper = sorted[0];
    keeper.isFavorite = units.some((x) => x.isFavorite);
    keeper.locked = units.some((x) => x.locked);
    for (const unit of sorted.slice(1)) mapping[String(unit.unitUid)] = String(keeper.unitUid);
    selections.push({ unitId, retainedUid: keeper.unitUid, nativePower: Number(powerData.scores[keeper.unitUid]), candidates: units.map((x) => ({ uid: x.unitUid, power: Number(powerData.scores[x.unitUid]) })) });
  }
  return { mapping, selections };
}

function remapReferences(value, mapping, counters = { scalars: 0, keys: 0 }) {
  if (Array.isArray(value)) {
    const remapped = value.map((x) => remapReferences(x, mapping, counters));
    if (remapped.every((x) => x && typeof x === "object" && Object.hasOwn(x, "unitUid"))) {
      const byUid = new Map();
      remapped.forEach((x, index) => { const key = String(x.unitUid); if (!byUid.has(key) || !Object.hasOwn(mapping, String(value[index].unitUid))) byUid.set(key, x); });
      return Array.from(byUid.values());
    }
    return remapped;
  }
  if (!value || typeof value !== "object") {
    const replacement = mapping[String(value)];
    if (replacement != null) { counters.scalars += 1; return replacement; }
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = mapping[key] || key;
    if (nextKey !== key) counters.keys += 1;
    if (nextKey !== key && Object.hasOwn(value, nextKey) && typeof value[nextKey] === "object") continue;
    const nextValue = remapReferences(item, mapping, counters);
    if (Object.hasOwn(output, nextKey)) {
      // Duplicate reference entries (for example dive HP maps) keep the more conservative value.
      const old = output[nextKey];
      if (typeof old === "number" && typeof nextValue === "number") output[nextKey] = Math.min(old, nextValue);
      else if (key === nextKey) output[nextKey] = nextValue;
    } else output[nextKey] = nextValue;
  }
  if (Array.isArray(output.unitUids)) {
    const leaderUid = output.unitUids[Number(output.leaderIndex)];
    const seen = new Set();
    output.unitUids = output.unitUids.map((uid) => {
      const key = String(uid || 0);
      if (key === "0") return 0;
      if (seen.has(key)) return 0;
      seen.add(key); return uid;
    });
    if (leaderUid && String(leaderUid) !== "0") output.leaderIndex = output.unitUids.findIndex((uid) => String(uid) === String(leaderUid));
  }
  return output;
}

function deduplicateUser(user, powerData) {
  const { mapping, selections } = chooseDuplicates(user, powerData);
  const equips = user.inventory.equips || {};
  let detached = 0;
  for (const equip of Object.values(equips)) if (Object.hasOwn(mapping, String(equip.ownerUnitUid))) { equip.ownerUnitUid = "-1"; detached += 1; }
  for (const uid of Object.keys(mapping)) delete user.army.units[uid];
  const referenceChanges = { scalars: 0, keys: 0 };
  const result = remapReferences(user, mapping, referenceChanges);
  const main = Object.values(result.army.units).find((unit) => Number(unit.unitId) === Number(result.mainUnitId));
  if (main) { result.mainUnitSkinId = Number(main.skinId || 0); result.mainUnitTacticLevel = Number(main.tacticLevel || 0); }
  let clearedDanglingOfficeReferences = 0;
  for (const room of result.office?.rooms || []) if (Array.isArray(room.unitUids)) {
    room.unitUids = room.unitUids.map((uid) => {
      if (String(uid || 0) === "0" || Object.hasOwn(result.army.units, String(uid))) return uid;
      clearedDanglingOfficeReferences += 1; return 0;
    });
  }
  assertNoRemovedReferences(result, mapping);
  return { user: result, mapping, selections, detached, referenceChanges, clearedDanglingOfficeReferences };
}

function assertNoRemovedReferences(value, mapping) {
  if (Array.isArray(value)) { for (const x of value) assertNoRemovedReferences(x, mapping); return; }
  if (value && typeof value === "object") {
    for (const [key, x] of Object.entries(value)) { assert.ok(!Object.hasOwn(mapping, key), "Removed unit UID remains in reference key"); assertNoRemovedReferences(x, mapping); }
  } else assert.ok(!Object.hasOwn(mapping, String(value)), "Removed unit UID remains in reference value");
}

function terminalEquipId(equipId) {
  const seen = new Set(); let id = Number(equipId);
  while (!seen.has(id)) {
    seen.add(id); const upgrade = game.getEquipUpgradeTemplet(id);
    if (!upgrade || !game.isUsableEquipTemplet(game.getEquipTemplet(upgrade.UpgradeEquipID))) return id;
    id = Number(upgrade.UpgradeEquipID);
  }
  throw new Error("Equipment upgrade cycle");
}

function maxRecordValue(record, prefix = "m_") {
  const min = Number(record[`${prefix}MinStatValue`] ?? record[`${prefix}MinStat`] ?? record[`${prefix}MinStatRate`] ?? 0);
  const max = Number(record[`${prefix}MaxStatValue`] ?? record[`${prefix}MaxStat`] ?? record[`${prefix}MaxStatRate`] ?? min);
  return min < 0 && max < 0 ? min : max;
}

function potentialType(record) {
  const type = record.Socket1_StatType;
  if (record.Socket1_MaxStatRate != null) return { NST_HP: "NST_HP_FACTOR", NST_ATK: "NST_ATK_FACTOR", NST_DEF: "NST_DEF_FACTOR", NST_HIT: "NST_HIT_FACTOR", NST_EVADE: "NST_EVADE_FACTOR", NST_CRITICAL: "NST_CRITICAL_FACTOR" }[type] || type;
  return type;
}

function preferredStats(mode) {
  if (mode === "tank") return [LAND_RES, "NST_DAMAGE_REDUCE_RATE", "NST_SHORT_RANGE_DAMAGE_REDUCE_RATE", "NST_LONG_RANGE_DAMAGE_REDUCE_RATE", "NST_HP_FACTOR", "NST_CRITICAL_DAMAGE_RESIST_RATE", CDR, "NST_HP", "NST_DEF"];
  if (mode === "tankCdr") return [CDR, LAND_RES, "NST_HP_FACTOR", "NST_DAMAGE_REDUCE_RATE", "NST_CRITICAL_DAMAGE_RESIST_RATE", "NST_HP"];
  if (mode === "tankAspd") return [ASPD, LAND_RES, "NST_HP_FACTOR", "NST_DAMAGE_REDUCE_RATE", "NST_CRITICAL_DAMAGE_RESIST_RATE", "NST_HP"];
  if (mode === "aspd") return [ASPD, LAND, "NST_CRITICAL_DAMAGE_RATE", CDR, "NST_ATK_FACTOR", "NST_ATK", "NST_ROLE_TYPE_DEFFENDER_DAMAGE_RATE", "NST_ROLE_TYPE_STRIKER_DAMAGE_RATE"];
  if (mode === "crit") return ["NST_CRITICAL_DAMAGE_RATE", LAND, ASPD, "NST_ATK_FACTOR", "NST_ATK", CDR];
  if (mode === "atk") return ["NST_ATK_FACTOR", LAND, "NST_ATK", "NST_CRITICAL_DAMAGE_RATE", ASPD, CDR];
  return [CDR, LAND, LAND_RES, "NST_ATK_FACTOR", ASPD, "NST_HP_FACTOR", "NST_ATK", "NST_CRITICAL_DAMAGE_RATE"];
}

function chooseRecord(records, priorities, typeField) {
  if (!records.length) return null;
  const index = (type) => { const i = priorities.indexOf(type); return i < 0 ? priorities.length + 1 : i; };
  return records.slice().sort((a, b) => index(typeField(a)) - index(typeField(b)) || Math.abs(maxRecordValue(b)) - Math.abs(maxRecordValue(a)))[0];
}

function maximizeEquip(original, mode = "cdr", profile = {}) {
  const itemEquipId = terminalEquipId(original.itemEquipId);
  const t = game.getEquipTemplet(itemEquipId);
  assert.ok(t && game.isUsableEquipTemplet(t), "Unsupported equipment template");
  const priorities = profile.statPriority || preferredStats(mode);
  const customSubstats = [];
  const hasGroup1 = game.getEquipRandomStatRecords(t.m_StatGroupID).length > 0;
  const hasGroup2 = game.getEquipRandomStatRecords(t.m_StatGroupID_2).length > 0;
  for (let slot = 1; slot <= 2; slot += 1) {
    const groupId = slot === 1 ? t.m_StatGroupID : t.m_StatGroupID_2;
    const records = game.getEquipRandomStatRecords(groupId).filter((record) => !profile.forbiddenStats?.includes(record.m_StatType));
    if (!records.length) continue;
    const desired = profile.preserveSubstats ? original.stats?.[slot]?.type : null;
    const record = records.find((x) => desired && x.m_StatType === desired) || chooseRecord(records, profile.slotStatPriorities?.[slot - 1] || priorities, (x) => x.m_StatType);
    customSubstats.push({ slot, type: record.m_StatType, value: maxRecordValue(record), precision: 100 });
  }
  const allowedSets = t.m_ItemEquipPosition === "IEP_ENCHANT" ? [] : game.getEquipSetOptionIds(t);
  const requestedSet = profile.setId || MODE_SETS[mode];
  const setOptionId = allowedSets.includes(Number(requestedSet)) ? Number(requestedSet) : allowedSets.includes(Number(original.setOptionId)) ? Number(original.setOptionId) : allowedSets[0] || 0;
  const options = t.m_bRelic ? game.getEquipPotentialOptionRecords(t.m_PotentialOptionGroupID).filter((record) => !profile.forbiddenStats?.includes(potentialType(record))) : [];
  const p = chooseRecord(options, profile.potentialPriority || priorities, potentialType);
  const potentialOptions = p ? [{ optionKey: Number(p.OptionKey), statType: potentialType(p), sockets: [1, 2, 3].map((i) => ({ statValue: maxRecordValue(p, `Socket${i}_`), precision: 100 })), precisionChangeCount: 0 }] : [];
  const equip = createEquipData(itemEquipId, BigInt(original.equipUid), {
    precision: hasGroup1 ? 100 : 0, precision2: hasGroup2 ? 100 : 0, enchantLevel: Math.min(Number(t.m_MaxEnchantLevel ?? Infinity), game.getMaxEquipEnchantLevel(t.m_NKM_ITEM_TIER)), enchantExp: 0,
    customSubstats, setOptionId, potentialOptions, locked: Boolean(original.locked), regDate: original.regDate || "0", imprintUnitId: original.imprintUnitId || 0,
  });
  // Use exact table endpoints, avoiding binary rounding during the helper's precision interpolation.
  equip.stats = [{ type: t.STAT_TYPE_1, value: Number(t.STAT_VALUE_1), levelValue: Number(t.STAT_LEVELUP_VALUE_1) }, ...customSubstats.map((sub) => ({ type: sub.type, value: sub.value, levelValue: 0 }))];
  equip.setOptionId = setOptionId;
  return { ...original, ...equip, ownerUnitUid: String(original.ownerUnitUid ?? "-1"), tuningCandidate: null, potentialCandidate: null };
}

function defaultProfile(unit) {
  const t = game.getUnitTemplet(unit.unitId) || {};
  const mode = t.m_NKM_UNIT_ROLE_TYPE === "NURT_DEFENDER" ? "tank" : t.m_NKM_UNIT_STYLE_TYPE !== "NUST_COUNTER" ? "aspd" : "cdr";
  return { mode, source: "current-client-role-fallback", reason: "No public per-unit recommendation matched; legal client role and equipment stat groups used." };
}

function privateAllowed(equipmentTemplate, unitId) {
  if (!equipmentTemplate.m_lstPrivateUnitID?.length) return true;
  const current = game.getUnitTemplet(unitId);
  if (!current) return false;
  const currentBase = Number(current.m_BaseUnitID || current.m_UnitID);
  return equipmentTemplate.m_lstPrivateUnitID.some((privateId) => {
    const other = game.getUnitTemplet(privateId);
    const otherBase = Number(other?.m_BaseUnitID || privateId);
    // Mirrors NKMUnitTempletBase.IsSameBaseUnit used by IsPrivateEquipForUnit.
    return Number(unitId) === Number(privateId) || currentBase === Number(privateId) || otherBase === Number(unitId) || currentBase === otherBase;
  });
}

function chooseTemplate(unit, slot, profile, usedPrivateAccessory) {
  const unitTemplate = game.getUnitTemplet(unit.unitId);
  const setId = Number(profile.setId || MODE_SETS[profile.mode]);
  const explicit = profile.equipmentIds?.[slot];
  const candidates = templates.filter((t) => t.m_EquipUnitStyleType === unitTemplate.m_NKM_UNIT_STYLE_TYPE && t.m_ItemEquipPosition === POSITION[slot] && Number(t.m_NKM_ITEM_TIER) === 7 && t.m_NKM_ITEM_GRADE === "NIG_SSR")
    .filter((t) => privateAllowed(t, unit.unitId))
    .filter((t) => !t.m_lstPrivateUnitID?.length || profile.private === true && (!profile.exclusiveEquipmentIds?.length || profile.exclusiveEquipmentIds.map(terminalEquipId).includes(Number(t.m_ItemEquipID))))
    .filter((t) => !(slot >= 2 && usedPrivateAccessory && t.m_lstPrivateUnitID?.length))
    .filter((t) => slot < 2 || !profile.accessoryMainStat || t.m_lstPrivateUnitID?.length || t.STAT_TYPE_1 === profile.accessoryMainStat)
    .filter((t) => game.getEquipSetOptionIds(t).includes(setId));
  const allowedCandidates = candidates.filter((t) => !profile.forbiddenSetIds?.includes(setId))
    .filter((t) => [t.m_StatGroupID, t.m_StatGroupID_2].every((id) => { const records = game.getEquipRandomStatRecords(id); return !records.length || records.some((r) => !profile.forbiddenStats?.includes(r.m_StatType)); }))
    .filter((t) => { const records = t.m_bRelic ? game.getEquipPotentialOptionRecords(t.m_PotentialOptionGroupID) : []; return !records.length || records.some((r) => !profile.forbiddenStats?.includes(potentialType(r))); });
  if (explicit) { const t = allowedCandidates.find((x) => Number(x.m_ItemEquipID) === Number(explicit)); assert.ok(t, `Invalid explicit gear for unit ID ${unit.unitId} slot ${slot}`); return t; }
  const tank = /^tank/.test(profile.mode);
  const families = profile.familyPreferences?.[slot] || (tank ? [slot === 0 ? "Inhibitor" : slot === 1 ? "Maze" : "Gordias", "Inhibitor", "Hummingbird", "Maze"] : profile.mode === "cdr" ? ["Swift", "Maze"] : profile.mode === "crit" ? ["Britra", "Maze"] : ["Swift", "Britra", "Maze"]);
  const familyRank = (t) => {
    if (t.m_lstPrivateUnitID?.length) return profile.private === true && (!profile.privateSlots?.length || profile.privateSlots.includes(slot) || profile.privateSlots.includes(POSITION[slot])) ? -1 : families.length + 20;
    const name = names.get(Number(t.m_ItemEquipID)) || "";
    const i = families.findIndex((family) => name.includes(family));
    return i < 0 ? families.length + 10 : i;
  };
  const score = (t) => {
    const e = maximizeEquip({ itemEquipId: t.m_ItemEquipID, equipUid: "1" }, profile.mode, profile);
    const priorities = profile.statPriority || preferredStats(profile.mode);
    let score = 0;
    // Flat HP/ATK values and fractional rates use different units; raw magnitudes must not override the declared stat priority.
    for (const stat of e.stats.slice(1)) { const i = priorities.indexOf(stat.type); if (i >= 0) score += (priorities.length - i) * 10 + Math.min(1, Math.abs(stat.value)); }
    const potentialPriorities = profile.potentialPriority || priorities;
    for (const p of e.potentialOptions) { const i = potentialPriorities.indexOf(p.statType); if (i >= 0) score += (potentialPriorities.length - i) * 10 + Math.min(1, p.sockets.reduce((n, s) => n + Math.abs(s.statValue), 0)); }
    return score;
  };
  assert.ok(allowedCandidates.length, `No legal gear for unit ID ${unit.unitId} slot ${slot}`);
  return allowedCandidates.sort((a, b) => familyRank(a) - familyRank(b) || score(b) - score(a) || Number(a.m_ItemEquipID) - Number(b.m_ItemEquipID))[0];
}

function equipAllUnits(user, guides = {}, spareCount = 2) {
  const inventory = user.inventory;
  const originalCount = Object.keys(inventory.equips).length;
  let upgraded = 0;
  const shipOwners = new Map();
  for (const ship of Object.values(user.army.ships || {})) for (const uid of ship.equipItemUids || []) if (String(uid) !== "0") shipOwners.set(String(uid), String(ship.unitUid));
  for (const [uid, equip] of Object.entries(inventory.equips)) {
    const next = maximizeEquip(equip, "cdr", { preserveSubstats: true, setId: equip.setOptionId });
    if (next.itemEquipId !== equip.itemEquipId) upgraded += 1;
    next.ownerUnitUid = shipOwners.get(uid) || "-1"; inventory.equips[uid] = next;
  }
  for (const unit of Object.values(user.army.units)) unit.equipItemUids = [0, 0, 0, 0];
  let nextUid = BigInt(user.nextEquipUid || "9100000000000001");
  const allocate = () => { while (Object.hasOwn(inventory.equips, String(nextUid))) nextUid += 1n; return String(nextUid++); };
  const selected = [], reserveTemplates = new Map();
  for (const unit of Object.values(user.army.units).sort((a, b) => Number(a.unitId) - Number(b.unitId))) {
    const guide = guides.units?.[unit.unitId] || guides[unit.unitId];
    const profile = { ...defaultProfile(unit), ...guide, source: guide?.identityStatus?.includes("fallback") || !guide?.sources?.length ? "current-client-role-fallback" : guide.evidenceLevel?.includes("inference") ? "public-skill-and-client-mechanism-inference" : "Prydwen per-unit PvE/PvP recommendation" };
    profile.mode ||= "cdr";
    let privateAccessory = false; const gearReport = [];
    for (let slot = 0; slot < 4; slot += 1) {
      const slotProfile = { ...profile, setId: profile.setIds?.[slot] || profile.setId || MODE_SETS[profile.mode], statPriority: profile.statPriorityBySlot?.[slot] || profile.statPriority, potentialPriority: profile.potentialPriorityBySlot?.[slot] || profile.potentialPriority };
      const t = chooseTemplate(unit, slot, slotProfile, privateAccessory);
      const free = Object.values(inventory.equips).find((e) => String(e.ownerUnitUid) === "-1" && Number(e.itemEquipId) === Number(t.m_ItemEquipID));
      const uid = free?.equipUid || allocate();
      const equip = maximizeEquip(free || { equipUid: uid, itemEquipId: t.m_ItemEquipID, regDate: "0" }, profile.mode, slotProfile);
      equip.ownerUnitUid = String(unit.unitUid); equip.locked = true;
      inventory.equips[uid] = equip; unit.equipItemUids[slot] = uid;
      if (slot >= 2 && t.m_lstPrivateUnitID?.length) privateAccessory = true;
      reserveTemplates.set(JSON.stringify({ id: t.m_ItemEquipID, set: equip.setOptionId, stats: equip.stats, potential: equip.potentialOptions }), { id: t.m_ItemEquipID, profile: slotProfile });
      gearReport.push({ slot, itemEquipId: equip.itemEquipId, name: names.get(equip.itemEquipId), setOptionId: equip.setOptionId, enchantLevel: equip.enchantLevel, stats: equip.stats, potentialOptions: equip.potentialOptions, exclusive: Boolean(t.m_lstPrivateUnitID?.length) });
    }
    selected.push({ unitId: Number(unit.unitId), name: profile.guideName || unitNames.get(Number(unit.unitId)), mode: profile.mode, reason: profile.reason || "", source: profile.source, evidenceLevel: profile.evidenceLevel || "client-role-fallback", equipmentSelectionEvidence: profile.equipmentSelectionEvidence || profile.evidenceLevel || "client-role-fallback", sources: profile.sources || [], recommendation: profile.recommendation || {}, pveModes: profile.pveModes || [], pvpModes: profile.pvpModes || [], equipment: gearReport });
  }
  let spares = 0;
  for (const { id, profile } of reserveTemplates.values()) {
    const expected = maximizeEquip({ equipUid: "1", itemEquipId: id }, profile.mode, profile);
    const signature = (e) => JSON.stringify({ itemEquipId: e.itemEquipId, setOptionId: e.setOptionId, stats: e.stats, potential: e.potentialOptions.map((p) => ({ optionKey: p.optionKey, statType: p.statType, sockets: p.sockets })) });
    const expectedSignature = signature(expected);
    const current = Object.values(inventory.equips).filter((e) => e.ownerUnitUid === "-1" && signature(e) === expectedSignature).length;
    for (let i = current; i < spareCount; i += 1) {
      const uid = allocate(); inventory.equips[uid] = maximizeEquip({ equipUid: uid, itemEquipId: id, regDate: "0", locked: true }, profile.mode, profile); spares += 1;
    }
  }
  user.nextEquipUid = String(nextUid);
  return { selected, originalCount, upgraded, spareAdded: spares, spareTarget: spareCount, finalCount: Object.keys(inventory.equips).length };
}

function validateProfileEquipment(equipment, profile, unitId) {
  const forbidden = new Set(profile.forbiddenStats || []);
  for (const equip of equipment) {
    assert.ok(!profile.forbiddenSetIds?.includes(equip.setOptionId), `Forbidden set for unit ID ${unitId}`);
    assert.ok(equip.stats.every((stat) => !forbidden.has(stat.type)), `Forbidden random stat for unit ID ${unitId}`);
    assert.ok(equip.potentialOptions.every((option) => !forbidden.has(option.statType)), `Forbidden potential for unit ID ${unitId}`);
  }
  const criticalResistance = equipment.flatMap((e) => e.stats).filter((s) => s.type === "NST_CRITICAL_DAMAGE_RESIST_RATE").reduce((n, s) => n + s.value, 0) + equipment.flatMap((e) => e.potentialOptions).filter((p) => p.statType === "NST_CRITICAL_DAMAGE_RESIST_RATE").flatMap((p) => p.sockets).reduce((n, s) => n + s.statValue, 0);
  if (profile.tankMinimumCritResistance != null) assert.ok(criticalResistance + 1e-9 >= profile.tankMinimumCritResistance, `Tank critical resistance below guide requirement for unit ID ${unitId}: ${criticalResistance}`);
  return { criticalResistance };
}

function equipPveBossUnits(user, balancedGuides = {}, bossGuides = {}) {
  const originalCount = Object.keys(user.inventory.equips).length;
  const preservedSpareCount = Object.values(user.inventory.equips).filter((equip) => String(equip.ownerUnitUid) === "-1").length;
  const selected = [];
  let changedUnits = 0, changedSlots = 0;
  for (const unit of Object.values(user.army.units).sort((a, b) => Number(a.unitId) - Number(b.unitId))) {
    const base = balancedGuides.units?.[unit.unitId] || balancedGuides[unit.unitId] || {};
    const override = bossGuides.units?.[unit.unitId] || bossGuides[unit.unitId] || {};
    // A complete purpose profile replaces the balanced row; absent fields must not resurrect balanced-only mixed sets.
    const completeOverride = bossGuides.profilePurpose === "pve-boss" && Object.keys(override).length > 0;
    const profile = { ...defaultProfile(unit), ...(completeOverride ? override : { ...base, ...override }) };
    const previousSetOptionIds = unit.equipItemUids.map((uid) => user.inventory.equips[String(uid)]?.setOptionId || 0);
    let privateAccessory = false, unitChanged = false;
    const gearReport = [], changes = [];
    for (let slot = 0; slot < 4; slot += 1) {
      const uid = String(unit.equipItemUids[slot]);
      const previous = user.inventory.equips[uid];
      assert.ok(previous && String(previous.ownerUnitUid) === String(unit.unitUid), "PvE boss profile requires existing four-slot equipment ownership");
      const slotProfile = { ...profile, setId: profile.setIds?.[slot] || profile.setId || MODE_SETS[profile.mode], statPriority: profile.statPriorityBySlot?.[slot] || profile.statPriority, potentialPriority: profile.potentialPriorityBySlot?.[slot] || profile.potentialPriority };
      const t = chooseTemplate(unit, slot, slotProfile, privateAccessory);
      const next = maximizeEquip({ ...previous, itemEquipId: t.m_ItemEquipID }, profile.mode, slotProfile);
      const signature = (equip) => JSON.stringify({ itemEquipId: equip.itemEquipId, enchantLevel: equip.enchantLevel, enchantExp: equip.enchantExp, stats: equip.stats, precision: equip.precision, precision2: equip.precision2, setOptionId: equip.setOptionId, potentialOptions: equip.potentialOptions });
      if (signature(previous) !== signature(next)) {
        user.inventory.equips[uid] = next;
        changedSlots += 1; unitChanged = true;
        changes.push({ slot, before: { itemEquipId: previous.itemEquipId, setOptionId: previous.setOptionId, stats: previous.stats, potentialOptions: previous.potentialOptions }, after: { itemEquipId: next.itemEquipId, setOptionId: next.setOptionId, stats: next.stats, potentialOptions: next.potentialOptions } });
      }
      if (slot >= 2 && t.m_lstPrivateUnitID?.length) privateAccessory = true;
      const equip = user.inventory.equips[uid];
      gearReport.push({ slot, itemEquipId: equip.itemEquipId, name: names.get(equip.itemEquipId), setOptionId: equip.setOptionId, enchantLevel: equip.enchantLevel, stats: equip.stats, potentialOptions: equip.potentialOptions, exclusive: Boolean(t.m_lstPrivateUnitID?.length) });
    }
    if (unitChanged) changedUnits += 1;
    const gearValidation = validateProfileEquipment(gearReport, profile, unit.unitId);
    const unitTemplate = game.getUnitTemplet(unit.unitId);
    selected.push({ unitId: Number(unit.unitId), name: profile.guideName || unitNames.get(Number(unit.unitId)), role: unitTemplate.m_NKM_UNIT_ROLE_TYPE, style: unitTemplate.m_NKM_UNIT_STYLE_TYPE, previousSetOptionIds, gearValidation, mode: profile.mode, reason: profile.pveBossReason || profile.reason || "", source: profile.source || "public-pve-boss-guide", evidenceLevel: profile.evidenceLevel || "client-mechanism-inference", equipmentSelectionEvidence: profile.equipmentSelectionEvidence || profile.evidenceLevel || "client-mechanism-inference", sources: profile.sources || [], recommendation: profile.recommendation || {}, pveModes: profile.pveModes || [], pvpModes: profile.pvpModes || [], changed: unitChanged, changes, equipment: gearReport });
  }
  return { selected, originalCount, upgraded: 0, spareAdded: 0, preservedSpareCount, spareTarget: "保留当前备用库存", finalCount: originalCount, changedUnits, changedSlots };
}

function validateUser(user) {
  const seen = new Set(); const equips = user.inventory.equips;
  for (const ship of Object.values(user.army.ships || {})) for (const uid of ship.equipItemUids || []) {
    if (String(uid) === "0") continue;
    assert.ok(equips[String(uid)]); assert.equal(equips[String(uid)].ownerUnitUid, String(ship.unitUid)); assert.ok(!seen.has(String(uid))); seen.add(String(uid));
  }
  for (const unit of Object.values(user.army.units)) {
    assert.equal(unit.equipItemUids.length, 4); let privateAccessories = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const uid = String(unit.equipItemUids[slot]); const equip = equips[uid]; const t = game.getEquipTemplet(equip?.itemEquipId); const u = game.getUnitTemplet(unit.unitId);
      assert.ok(equip && t); assert.ok(!seen.has(uid), "Equipment assigned twice"); seen.add(uid);
      assert.equal(String(equip.ownerUnitUid), String(unit.unitUid)); assert.equal(t.m_ItemEquipPosition, POSITION[slot]); assert.equal(t.m_EquipUnitStyleType, u.m_NKM_UNIT_STYLE_TYPE);
      if (t.m_lstPrivateUnitID?.length) { assert.ok(privateAllowed(t, unit.unitId)); if (slot >= 2) privateAccessories += 1; }
      assert.ok(game.getEquipSetOptionIds(t).includes(equip.setOptionId));
    }
    assert.ok(privateAccessories <= 1, "Two private accessories are not legal");
  }
  for (const equip of Object.values(equips)) {
    const t = game.getEquipTemplet(equip.itemEquipId); assert.ok(game.isUsableEquipTemplet(t));
    assert.equal(equip.enchantLevel, Math.min(Number(t.m_MaxEnchantLevel ?? Infinity), game.getMaxEquipEnchantLevel(t.m_NKM_ITEM_TIER)));
    const supportedGroups = [t.m_StatGroupID, t.m_StatGroupID_2].map((id) => game.getEquipRandomStatRecords(id));
    assert.equal(equip.precision, supportedGroups[0].length ? 100 : 0); assert.equal(equip.precision2, supportedGroups[1].length ? 100 : 0);
    assert.equal(equip.stats.length, 1 + supportedGroups.filter((records) => records.length).length);
    assert.deepEqual(equip.stats[0], { type: t.STAT_TYPE_1, value: Number(t.STAT_VALUE_1), levelValue: Number(t.STAT_LEVELUP_VALUE_1) });
    for (let slot = 1; slot < equip.stats.length; slot += 1) {
      const records = supportedGroups.filter((group) => group.length)[slot - 1];
      assert.ok(records.some((r) => r.m_StatType === equip.stats[slot].type && Math.abs(maxRecordValue(r) - equip.stats[slot].value) < 1e-10), "Equipment substat is outside its legal group");
    }
    if (!t.m_bRelic) assert.equal(equip.potentialOptions.length, 0);
    for (const p of equip.potentialOptions) {
      const record = game.getEquipPotentialOptionRecords(t.m_PotentialOptionGroupID).find((r) => Number(r.OptionKey) === Number(p.optionKey));
      assert.ok(record); assert.equal(p.statType, potentialType(record)); assert.equal(p.sockets.length, 3);
      p.sockets.forEach((s, i) => { assert.equal(s.precision, 100); assert.equal(s.statValue, maxRecordValue(record, `Socket${i + 1}_`)); });
    }
    if (String(equip.ownerUnitUid) !== "-1") assert.ok(seen.has(String(equip.equipUid)), "Equipment owner has no matching slot");
  }
  return { units: Object.keys(user.army.units).length, equipment: Object.keys(equips).length, equipped: seen.size };
}

function privateWrite(filename, value) {
  fs.writeFileSync(filename, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(filename, 0o600);
}

function equippedAttributeSummary(user) {
  const conditions = { fixedMainHP: (e) => e.stats[0]?.type === "NST_HP", HPSet: (e) => game.getEquipSetOption(e.setOptionId)?.m_StatType_1 === "NST_HP", randomHP: (e) => e.stats.slice(1).some((s) => ["NST_HP", "NST_HP_FACTOR"].includes(s.type)), HPFactorPotential: (e) => e.potentialOptions.some((p) => p.statType === "NST_HP_FACTOR"), CDRSet: (e) => e.setOptionId === 241900, randomCDR: (e) => e.stats.slice(1).some((s) => s.type === CDR), CDRPotential: (e) => e.potentialOptions.some((p) => p.statType === CDR) };
  const result = Object.fromEntries(Object.keys(conditions).map((key) => [key, { units: 0, slots: 0 }]));
  for (const unit of Object.values(user.army.units)) {
    const equipment = unit.equipItemUids.map((uid) => user.inventory.equips[String(uid)]).filter(Boolean);
    for (const [key, test] of Object.entries(conditions)) { const count = equipment.filter(test).length; result[key].slots += count; result[key].units += count > 0 ? 1 : 0; }
  }
  return result;
}

function annotateNativePowerReport(report, user, before, after) {
  assert.match(String(after.source || ""), /native|NKMStatData|original-client CalculateUnitOperationPower/i);
  const byId = new Map(Object.values(user.army.units).map((unit) => [Number(unit.unitId), unit]));
  const validation = { source: after.source, units: report.units.length, increased: 0, equal: 0, decreased: 0, decreasedUnits: [] };
  for (const row of report.units) {
    const unit = byId.get(Number(row.unitId)); assert.ok(unit);
    assert.ok(Object.hasOwn(before.scores, unit.unitUid) && Object.hasOwn(after.scores, unit.unitUid));
    row.nativePowerBefore = Number(before.scores[unit.unitUid]); row.nativePowerAfter = Number(after.scores[unit.unitUid]);
    const delta = row.nativePowerAfter - row.nativePowerBefore;
    if (delta > 0) validation.increased += 1;
    else if (delta === 0) validation.equal += 1;
    else { validation.decreased += 1; validation.decreasedUnits.push({ unitId: row.unitId, name: row.name, before: row.nativePowerBefore, after: row.nativePowerAfter, delta }); }
  }
  report.nativePowerValidation = validation;
  return report;
}

function main(argv) {
  const args = {}; for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  const purpose = args.purpose || "balanced";
  assert.ok(["balanced", "pve-boss"].includes(purpose), "Supported purposes: balanced, pve-boss");
  assert.ok(args.input && args.output && (purpose === "pve-boss" || args["power-scores"]), "Usage: --input users.json --output external-directory [--purpose balanced|pve-boss] [--power-scores native-scores.json] [--guides balanced-guides.json] [--purpose-guides pve-boss-guides.json] [--active-user active-user.json]");
  if (purpose === "pve-boss") assert.ok(args.guides && args["purpose-guides"], "PvE boss purpose requires separate balanced and PvE boss guides");
  const output = path.resolve(args.output), input = path.resolve(args.input);
  assert.ok(!output.startsWith(`${ROOT}${path.sep}`), "Save outputs cannot be written into the repository"); assert.ok(path.join(output, "users.json") !== input, "Original input cannot be overwritten");
  const database = JSON.parse(fs.readFileSync(input));
  const activeUid = String(args["user-uid"] || (args["active-user"] ? JSON.parse(fs.readFileSync(args["active-user"])).activeUserUid : database.activeUserUid));
  assert.ok(database.users?.[activeUid], "Active account does not exist");
  const powerData = args["power-scores"] ? JSON.parse(fs.readFileSync(args["power-scores"])) : { source: "No duplicate removal; existing character identities preserved" };
  const guides = args.guides ? JSON.parse(fs.readFileSync(args.guides)) : {};
  const purposeGuides = args["purpose-guides"] ? JSON.parse(fs.readFileSync(args["purpose-guides"])) : {};
  const dedup = purpose === "pve-boss" ? { user: database.users[activeUid], mapping: {}, selections: [], referenceChanges: { scalars: 0, keys: 0 }, detached: 0, clearedDanglingOfficeReferences: 0 } : deduplicateUser(database.users[activeUid], powerData);
  const previousAttributes = equippedAttributeSummary(dedup.user);
  const equipment = purpose === "pve-boss" ? equipPveBossUnits(dedup.user, guides, purposeGuides) : equipAllUnits(dedup.user, guides, Number(args.spares ?? 2));
  const validation = validateUser(dedup.user); assertNoRemovedReferences(dedup.user, dedup.mapping);
  const equipmentCapacity = getInventoryCapacity(dedup.user, INVENTORY_TYPES.EQUIP);
  assert.ok(equipment.finalCount <= equipmentCapacity, "Optimized equipment inventory exceeds the supported capacity");
  database.users[activeUid] = dedup.user;
  fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.chmodSync(output, 0o700);
  privateWrite(path.join(output, "users.json"), database);
  privateWrite(path.join(output, "active-user-data.json"), dedup.user);
  privateWrite(path.join(output, "unit-reference-map.json"), { source: powerData.source, mapping: dedup.mapping, selections: dedup.selections });
  const report = { purpose, changedUnits: equipment.changedUnits || 0, changedSlots: equipment.changedSlots || 0, nativePowerSource: powerData.source, initialUnitCount: Object.keys(dedup.user.army.units).length + Object.keys(dedup.mapping).length, removedDuplicates: Object.keys(dedup.mapping).length, referenceChanges: dedup.referenceChanges, detachedDuplicateEquipment: dedup.detached, clearedDanglingOfficeReferences: dedup.clearedDanglingOfficeReferences, validation, equipment: { originalCount: equipment.originalCount, upgraded: equipment.upgraded, spareAdded: equipment.spareAdded, preservedSpareCount: equipment.preservedSpareCount || 0, spareTarget: equipment.spareTarget, finalCount: equipment.finalCount, capacity: equipmentCapacity }, units: equipment.selected };
  report.attributes = { before: previousAttributes, after: equippedAttributeSummary(dedup.user) };
  privateWrite(path.join(output, "loadout-report.json"), report);
  privateWrite(path.join(output, "loadout-report.md"), renderReport(report));
  console.log(JSON.stringify({ removedDuplicates: report.removedDuplicates, ...validation, upgraded: equipment.upgraded, spareAdded: equipment.spareAdded }));
}

function renderReport(report) {
  const lines = ["# 通用 PvE / PvP 配装报告", "", `同角色 ID 重复副本删除 ${report.removedDuplicates} 个，保留 ${report.validation.units} 个独立角色 ID。`, `保留依据：${report.nativePowerSource}。并列战力优先收藏副本，再按 UID 稳定排序。`, `库存 ${report.equipment.originalCount} → ${report.equipment.finalCount}；升级到合法终阶装备 ${report.equipment.upgraded} 件，新增备用 ${report.equipment.spareAdded} 件。每种已选配装另保留至少 ${report.equipment.spareTarget} 件同词条和潜能的未装备备用件。`, `同步删除原已不存在角色的办公室占位 ${report.clearedDanglingOfficeReferences} 条。`, "", "所有装备强化到客户端表上限，副词条按对应合法词条组取 100 精度端点，遗物三潜能插槽按对应 OptionKey 全满。非遗物不写入潜能。每个饰品槽独立装备 UID，专属饰品最多一件。", "", "角色推荐存在场景差异；本报告记录兼顾 PvE/PvP 的常驻组合，未匹配公开攻略时按当前客户端角色及装备机制选择。", ""];
  if (report.purpose === "pve-boss") {
    lines.splice(0, lines.length, "# 高难 PvE / Boss 配装报告", "", `保留 ${report.validation.units} 个角色及其全部成长、角色UID、装备UID、编队、进度、公会和 ${report.equipment.preservedSpareCount} 件备用装备。必要调整 ${report.changedUnits} 个角色、${report.changedSlots} 个装备槽。`, `库存保持 ${report.equipment.finalCount}/${report.equipment.capacity}。当前四装备UID原位更新合法模板、套装和词条；旧balanced存档独立保留。`, "", "防具固定主属性HP由客户端模板决定，不能合法洗成CDR。CDR来自套装、随机副词条或遗物潜能。副词条与潜能取实际支持的合法上限，不存在的副词条精度保持0。所有专属饰品至多一件。坦克、技能循环、普攻、Fury、治疗和Boss增伤按角色机制分别处理。", "");
    const previousHP = report.units.filter((row) => row.previousSetOptionIds?.includes(220700));
    const keptHP = previousHP.filter((row) => row.equipment.some((equip) => equip.setOptionId === 220700));
    const toCDR = previousHP.filter((row) => row.equipment.every((equip) => equip.setOptionId === 241900));
    const toOther = previousHP.filter((row) => !keptHP.includes(row) && !toCDR.includes(row));
    lines.push(`原有HP套角色 ${previousHP.length} 个：保留HP ${keptHP.length} 个，改为生存/技能CDR ${toCDR.length} 个，改为其他符合机制方案 ${toOther.length} 个。`, "");
    for (const [label, rows] of [["保留HP", keptHP], ["HP改CDR", toCDR], ["HP改其他", toOther]]) lines.push(`- ${label}：${rows.map((row) => `${row.name}（${row.unitId}，${row.role}）`).join("；") || "无"}。`);
    const newHP = report.units.filter((row) => !row.previousSetOptionIds.includes(220700) && row.equipment.some((equip) => equip.setOptionId === 220700));
    lines.push(`- 原未用HP套、按PvE主坦方向改用HP：${newHP.map((row) => `${row.name}（${row.unitId}）`).join("；") || "无"}。`);
    if (report.attributes) {
      lines.push("", "| 已装备属性 | 原角色数/槽数 | PvE角色数/槽数 |", "| --- | --- | --- |");
      for (const [key, label] of Object.entries({ fixedMainHP: "防具固定HP主属性", HPSet: "HP套装", randomHP: "HP随机副词条", HPFactorPotential: "HP比例潜能", CDRSet: "CDR套装", randomCDR: "CDR随机副词条", CDRPotential: "CDR潜能" })) { const before = report.attributes.before[key], after = report.attributes.after[key]; lines.push(`| ${label} | ${before.units}/${before.slots} | ${after.units}/${after.slots} |`); }
    }
    lines.push("");
  }
  if (report.nativePowerValidation) {
    const p = report.nativePowerValidation;
    lines.push(`原客户端最终战力复核：${p.increased} 角色提高、${p.equal} 相等、${p.decreased} 下降。${report.purpose === "pve-boss" ? "战力评分不等于高难伤害和续航；配装选择依据角色机制与Boss情境。" : "保留副本仍按优化前的真实最高战力选取；最终装备按 PvE/PvP 实用收益选择，战力评分与实际技能效益有所差异。"}`, "");
    for (const u of p.decreasedUnits) lines.push(`- ${u.name}（${u.unitId}）：${u.before} → ${u.after}（${u.delta}）。`);
    lines.push("");
  }
  for (const unit of report.units) {
    lines.push(`## ${unit.name || "Unknown"}（${unit.unitId}）`, "", `方案：${unit.mode}。${unit.reason}`, `角色配装依据：${unit.evidenceLevel}；具体装备选择依据：${unit.equipmentSelectionEvidence}。PvE：${unit.recommendation.pve || "未直接推荐"}；PvP：${unit.recommendation.pvp || "未直接推荐"}。`, "");
    if (unit.nativePowerAfter != null) lines.push(`原客户端战力：${unit.nativePowerBefore} → ${unit.nativePowerAfter}。`, "");
    for (const e of unit.equipment) lines.push(`- ${["武器", "防具", "饰品1", "饰品2"][e.slot]}：${e.name}（${e.itemEquipId}），套装 ${e.setOptionId}；${e.stats.slice(1).map((s) => `${s.type}=${s.value}`).join("；")}${e.potentialOptions.length ? `；潜能 ${e.potentialOptions[0].statType}=${e.potentialOptions[0].sockets.map((s) => s.statValue).join("/")}` : ""}`);
    if (unit.sources.length) lines.push("", `来源：${unit.sources.map((s) => typeof s === "string" ? s : s.url).filter(Boolean).join("；")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { chooseDuplicates, remapReferences, deduplicateUser, assertNoRemovedReferences, terminalEquipId, maxRecordValue, potentialType, maximizeEquip, defaultProfile, privateAllowed, chooseTemplate, equipAllUnits, equipPveBossUnits, validateProfileEquipment, validateUser, equippedAttributeSummary, annotateNativePowerReport, renderReport, privateWrite, main };
if (require.main === module) main(process.argv.slice(2));
