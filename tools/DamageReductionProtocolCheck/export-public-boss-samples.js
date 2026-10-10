const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const tables = require(path.join(repo, 'modules/gameplay-jsons'));
const output = process.argv[2] || '/tmp/revivalside-public-boss-damage-samples.json';
const read = (bundle, file) => tables.readGameplayTableRecords(bundle, file);
const bases = ['LUA_UNIT_TEMPLET_BASE.json', 'LUA_UNIT_TEMPLET_BASE2.json'].flatMap(f => read('ab_script_unit_data', f));
const stats = ['LUA_UNIT_STAT_TEMPLET.json', 'LUA_UNIT_STAT_TEMPLET2.json'].flatMap(f => read('ab_script_unit_data', f));
const buffs = ['LUA_BUFF_TEMPLET.json', 'LUA_BUFF_TEMPLET2.json', 'LUA_BUFF_TEMPLET3.json'].flatMap(f => read('ab_script', f));
const damage = Array.from({ length: 6 }, (_, i) => read('ab_script', `LUA_DAMAGE_TEMPLET_BASE${i ? i + 1 : ''}.json`)).flat();
const effects = Array.from({ length: 6 }, (_, i) => read('ab_script_effect', `LUA_DAMAGE_EFFECT_TEMPLET${i ? i + 1 : ''}.json`)).flat();
const dungeons = read('ab_script_dungeon_templet', 'LUA_DUNGEON_TEMPLET_BASE.json');
const raids = read('ab_script', 'LUA_RAID_TEMPLET.json');
const stageSamples = [
  ...[8011301, 8011305, 8011310, 8011316].map(id => [`Guild${id}`, id, false]),
  ['DC3001', 3001, false], ['DC3804', 3804, false],
  ...[150, 170, 190].flatMap(level => [[`Britra${level}`, 400000 + level, true], [`Inhibitor${level}`, 500000 + level, true], [`Kraken${level}`, 600000 + level, true]]),
];
const unitSamples = stageSamples.map(([name, stage, isRaid]) => {
  const raid = isRaid ? raids.find(x => x.m_StageID === stage) : null;
  const dungeon = dungeons.find(x => x.m_DungeonID === (raid ? raid.m_DungeonID : stage));
  if (!dungeon) throw new Error(`Public dungeon template unavailable: ${name}`);
  const content = read('ab_script_dungeon_templet_all', `${dungeon.m_DungeonTempletFileName}.json`);
  const str = content.find(x => x.__key === 'm_BossUnitStrID')?.value;
  if (!str) throw new Error(`Public dungeon Boss binding unavailable: ${name}`);
  return [name, str, raid ? raid.m_RaidLevel : dungeon.m_DungeonLevel, dungeon.m_DungeonID, stage];
});
function walk(value, visitor, at = '') {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visitor, `${at}[${i}]`));
  else if (value && typeof value === 'object') {
    visitor(value, at);
    Object.entries(value).forEach(([key, v]) => walk(v, visitor, `${at}.${key}`));
  }
}
const evidence = [];
const cases = [];
for (const [name, str, level, dungeonId, stageId] of unitSamples) {
  const base = bases.find(x => x.m_UnitStrID === str);
  const stat = stats.find(x => x.m_UnitStrID === str);
  if (!base || !stat) throw new Error(`Public boss template unavailable: ${name}`);
  const unit = read('ab_script_unit_data_unit_templet', `${base.m_UnitTempletFileName}.json`);
  const flags = [], buffIds = new Set(), damageIds = new Set(), effectIds = new Set();
  walk(unit, (row, at) => {
    const flagged = Object.fromEntries(Object.entries(row).filter(([key, value]) => /Critical|TrueDamage|CleanHit/.test(key) && value));
    if (Object.keys(flagged).length) flags.push({ path: at, ...flagged, damageName: row.m_DamageTempletName, condition: row.m_Condition });
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      if (/BuffStrID|BuffStrId/.test(key)) buffIds.add(value);
      if (/DamageTempletName|DamageTempletStrID/.test(key)) damageIds.add(value);
      if (/DEName|DamageEffectName/.test(key)) effectIds.add(value);
    }
  });
  const linkedEffects = effects.filter(x => effectIds.has(x.m_DamageEffectID));
  walk(linkedEffects, (row, at) => {
    const flagged = Object.fromEntries(Object.entries(row).filter(([key, value]) => /Critical|TrueDamage|CleanHit/.test(key) && value));
    if (Object.keys(flagged).length) flags.push({ path: `damageEffect${at}`, ...flagged, damageName: row.m_DamageTempletName, condition: row.m_Condition });
    for (const [key, value] of Object.entries(row)) if (typeof value === 'string' && /DamageTempletName|DamageTempletStrID/.test(key)) damageIds.add(value);
  });
  const linkedBuffs = buffs.filter(x => buffIds.has(x.m_BuffStrID));
  const importantBuffs = linkedBuffs.filter(x => /CRITICAL|DEF_PENETRATE|FORCE_HIT|FORCE_MISS|DAMAGE_RATE/.test(JSON.stringify(x)));
  const linkedDamage = damage.filter(x => damageIds.has(x.m_DamageTempletName));
  evidence.push({ name, dungeonId, stageId, unitId: base.m_UnitID, unitStrID: str, level, style: base.m_NKM_UNIT_STYLE_TYPE,
    role: base.m_NKM_UNIT_ROLE_TYPE, unitType: base.m_NKM_UNIT_TYPE, air: !!base.m_bAirUnit, sourceFile: base.m_UnitTempletFileName,
    rawStats: stat.m_StatData, attackFlags: flags, importantBuffs, damageReferences: [...damageIds], linkedDamage,
    notes: 'Raw table evidence; conditional buffs and battle-condition activation are retained as evidence, not assumed active.' });
  cases.push({ name, rawAttackerStats: stat.m_StatData, attackerLevel: level, attackerStyle: base.m_NKM_UNIT_STYLE_TYPE, attackerUnitType: base.m_NKM_UNIT_TYPE,
    attackerRole: base.m_NKM_UNIT_ROLE_TYPE, attackerAir: !!base.m_bAirUnit, attackerBoss: true,
    skillType: null, distance: 0, attackFactor: 1,
    defenderStats: { NST_HP: 100000, NST_DEF: 2000, NST_EVADE: 1000, NST_CRITICAL_DAMAGE_RESIST_RATE: .72,
      NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE: .672, NST_SHORT_RANGE_DAMAGE_REDUCE_RATE: .107, NST_LONG_RANGE_DAMAGE_REDUCE_RATE: .107,
      NST_UNIT_TYPE_COUNTER_DAMAGE_REDUCE_RATE: .14 },
    variants: [{ name: 'current', defenderOverrides: {} }, { name: 'crit40_hp25', defenderOverrides: { NST_CRITICAL_DAMAGE_RESIST_RATE: .4, NST_HP: 125000 } },
      { name: 'hypothetical_crit40_skill_res12', defenderOverrides: { NST_CRITICAL_DAMAGE_RESIST_RATE: .4, NST_SKILL_DAMAGE_REDUCE_RATE: .12 } },
      { name: 'hypothetical_land16', defenderOverrides: { NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE: .832 } }],
  });
}
fs.writeFileSync(output, JSON.stringify({ syntheticOnly: true, originalPublicTables: true, evidence, cases }, null, 2));
console.log(`Public boss evidence: bosses=${evidence.length} output=${output}`);
