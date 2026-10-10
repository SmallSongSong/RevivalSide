using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 3) { Console.Error.WriteLine("Usage: DamageReductionProtocolCheck <Managed directory> <public synthetic cases JSON> <result JSON>"); return 2; }
var native = new OriginalDamage(Path.GetFullPath(args[0]));
using var input = JsonDocument.Parse(File.ReadAllText(args[1]));
if (!input.RootElement.GetProperty("syntheticOnly").GetBoolean()) throw new InvalidDataException("Only public synthetic inputs are accepted.");
var output = new List<object>();
foreach (var scenario in input.RootElement.GetProperty("cases").EnumerateArray())
{
    var name = scenario.GetProperty("name").GetString();
    foreach (var variant in scenario.GetProperty("variants").EnumerateArray())
        output.Add(native.Evaluate(name!, scenario, variant));
}
var hpComparisons = input.RootElement.TryGetProperty("unitHpComparisons", out var hpProfiles)
    ? hpProfiles.EnumerateArray().Select(native.CompareHp).ToArray() : [];
File.WriteAllText(args[2], JsonSerializer.Serialize(new { source = "original NKMUnitStatManager.GetFinalDamage/GetEvade/ApplyStatCap", native.AssemblySha256,
    randomControl = "System.Random is replaced by a controlled midpoint generator; original damage IL is unchanged.", results = output, hpComparisons }, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"Original damage comparison: cases={input.RootElement.GetProperty("cases").GetArrayLength()} variants={output.Count} hpProfiles={hpComparisons.Length}.");
return 0;

sealed class OriginalDamage
{
    const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
    readonly Assembly client;
    readonly Type statEnum;
    readonly Type statType;
    readonly Type unitType;
    readonly Type manager;
    readonly MethodInfo finalDamage;
    readonly MethodInfo evade;
    readonly MethodInfo cap;
    readonly MethodInfo setStat;
    readonly FieldInfo randomField;
    readonly Dictionary<string, (double Crit, double Evade)> chances = [];
    public string AssemblySha256 { get; }

    public OriginalDamage(string managed)
    {
        AssemblyLoadContext.Default.Resolving += (context, name) => { var p = Path.Combine(managed, name.Name + ".dll"); return File.Exists(p) ? context.LoadFromAssemblyPath(p) : null; };
        var path = Path.Combine(managed, "Assembly-CSharp.dll");
        AssemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
        client = AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
        statEnum = Type("NKM.NKM_STAT_TYPE"); statType = Type("NKM.NKMStatData"); unitType = Type("NKM.NKMUnit"); manager = Type("NKM.NKMUnitStatManager");
        finalDamage = manager.GetMethods(Flags).Single(m => m.Name == "GetFinalDamage" && m.GetParameters().Length == 20);
        evade = manager.GetMethod("GetEvade", Flags)!;
        cap = statType.GetMethod("ApplyStatCap", Flags)!;
        setStat = statType.GetMethods(Flags).Single(m => m.Name == "SetStatFinal");
        randomField = Type("NKM.PerThreadRandom").GetField("random_", Flags)!;
    }

    public object Evaluate(string name, JsonElement scenario, JsonElement variant)
    {
        var atkStats = scenario.TryGetProperty("rawAttackerStats", out var rawStats)
            ? LevelStats(rawStats, scenario.GetProperty("attackerLevel").GetInt32(), Text(scenario, "attackerUnitType", "NUT_NORMAL")) : ReadStats(scenario.GetProperty("attackerStats"));
        var defStats = ReadStats(scenario.GetProperty("defenderStats"));
        foreach (var pair in ReadStats(variant.GetProperty("defenderOverrides"))) defStats[pair.Key] = pair.Value;
        var aStat = Stats(atkStats); var dStat = Stats(defStats);
        var attacker = Unit(1, aStat, false, Bool(scenario, "attackerAir"), Bool(scenario, "attackerBoss"), Text(scenario, "attackerRole", "NURT_RANGER"),
            Text(scenario, "attackerStyle", "NUST_CORRUPTED"), Value(scenario, "attackerHpRate", 1), Text(scenario, "attackerUnitType", "NUT_NORMAL"));
        var defender = Unit(2, dStat, true, Bool(scenario, "defenderAir"), Bool(scenario, "defenderBoss"), Text(scenario, "defenderRole", "NURT_DEFENDER"),
            Text(scenario, "defenderStyle", "NUST_COUNTER"), Value(scenario, "defenderHpRate", 1), Text(scenario, "defenderUnitType", "NUT_NORMAL"));
        foreach (var (actor, prefix) in new[] { (attacker, "attacker"), (defender, "defender") })
        {
            foreach (var (suffix, frameField, baseField) in new[] { ("SourceType", "m_UnitSourceType", "m_NKM_UNIT_SOURCE_TYPE"), ("SourceTypeSub", "m_UnitSourceTypeSub", "m_NKM_UNIT_SOURCE_TYPE_SUB") })
                if (scenario.TryGetProperty(prefix + suffix, out var source))
                {
                    Set(Get(actor, "m_UnitFrameData")!, frameField, source.GetString());
                    Set(Get(Get(actor, "m_UnitTemplet")!, "m_UnitTempletBase")!, baseField, source.GetString());
                }
        }
        if (Bool(scenario, "percentDamageImmune"))
        {
            var statuses = Get(Get(defender, "m_UnitFrameData")!, "m_hsStatus")!;
            var type = statuses.GetType().GetGenericArguments()[0];
            statuses.GetType().GetMethod("Add")!.Invoke(statuses, [Enum.ToObject(type, 35)]);
        }
        var damageBase = New(Type("NKM.NKMDamageTempletBase"));
        Set(damageBase, "m_AtkFactorStat", "NST_ATK"); Set(damageBase, "m_fAtkFactor", Value(scenario, "attackFactor", 1));
        Set(damageBase, "m_fAtkMaxHPRateFactor", Value(scenario, "maxHpDamageFactor", 0));
        Set(damageBase, "m_fAtkHPRateFactor", Value(scenario, "currentHpDamageFactor", 0));
        var damage = New(Type("NKM.NKMDamageTemplet")); Set(damage, "m_DamageTempletBase", damageBase);
        object? skill = null;
        if (scenario.GetProperty("skillType").ValueKind != JsonValueKind.Null)
        {
            skill = New(Type("NKM.NKMUnitSkillTemplet")); Set(skill, "m_NKM_SKILL_TYPE", scenario.GetProperty("skillType").GetString()); Set(skill, "m_fEmpowerFactor", 1f);
        }
        var damageResultType = finalDamage.GetParameters()[11].ParameterType.GetElementType()!;
        object?[] arguments = [false, aStat, dStat, Get(attacker, "m_UnitData"), attacker, defender, damage, skill, Bool(scenario, "attackCountOver"), Bool(scenario, "buffDamage"), false,
            Enum.ToObject(damageResultType, 0), Value(scenario, "defenderProtect", 0), Value(scenario, "distance", 0), Bool(scenario, "defenderBoss"), Value(scenario, "attackerHpRate", 1), Bool(scenario, "trueDamage"), Bool(scenario, "splash"), false, false];
        var controlled = new ControlledRandom(); randomField.SetValue(null, controlled);
        float Damage(bool isEvade, bool critical, bool noCritical)
        {
            arguments[10] = isEvade; arguments[18] = critical; arguments[19] = noCritical;
            return (float)finalDamage.Invoke(null, arguments)!;
        }
        var normal = Damage(false, false, true); var criticalDamage = Damage(false, true, false);
        var evaded = Damage(true, false, true); var criticalEvaded = Damage(true, true, false);
        var chanceKey = JsonSerializer.Serialize(new { atkStats, defStats, forceCritical = Bool(scenario, "forceCritical"), noCritical = Bool(scenario, "noCritical"),
            cleanHit = Bool(scenario, "cleanHit"), buff = Bool(scenario, "buffDamage"), over = Bool(scenario, "attackCountOver") });
        if (!chances.TryGetValue(chanceKey, out var chance))
        {
            var eventAttack = New(Type("NKM.NKMEventAttack")); Set(eventAttack, "m_bCleanHit", Bool(scenario, "cleanHit"));
            int criticalCount = 0, evadeCount = 0;
            for (var roll = 0; roll < 10000; roll++)
            {
                controlled.Roll = roll;
                Damage(false, Bool(scenario, "forceCritical"), Bool(scenario, "noCritical"));
                if (Convert.ToInt32(arguments[11]) == 3) criticalCount++;
                if ((bool)evade.Invoke(null, [attacker, defender, Bool(scenario, "buffDamage"), Value(scenario, "defenderHpRate", 1), eventAttack])!) evadeCount++;
            }
            chance = (criticalCount / 10000d, evadeCount / 10000d); chances.Add(chanceKey, chance);
        }
        var forced = Bool(scenario, "forceCritical") && !Bool(scenario, "noCritical") && !Bool(scenario, "buffDamage") && !Bool(scenario, "attackCountOver");
        var evadedExpected = forced ? criticalEvaded : evaded;
        var expected = (1 - chance.Evade) * (normal * (1 - chance.Crit) + criticalDamage * chance.Crit) + chance.Evade * evadedExpected;
        var hp = defStats.GetValueOrDefault("NST_HP", 100000);
        return new { scenario = name, variant = variant.GetProperty("name").GetString(), attackerStats = atkStats, defenderStats = defStats,
            critProbability = chance.Crit, evadeProbability = chance.Evade, normalDamage = normal, criticalDamage, evadeDamage = evaded,
            forcedCriticalEvadeDamage = criticalEvaded, expectedDamage = expected, relativeEffectiveHp = hp / expected };
    }

    public object CompareHp(JsonElement profile)
    {
        var unit = New(Type("NKM.NKMUnitData")); Set(unit, "loyalty", profile.GetProperty("loyalty").GetInt32()); Set(unit, "isPermanentContract", Bool(profile, "permanentContract"));
        var permanent = (float)unit.GetType().GetMethod("GetMultiplierByPermanentContract", Flags)!.Invoke(unit, null)!;
        var raw = profile.GetProperty("rawStats"); var level = profile.GetProperty("level").GetInt32(); var limitBreak = profile.GetProperty("limitBreakLevel").GetInt32();
        var basic = LevelStats(raw, level, "NUT_NORMAL", limitBreak, permanent)["NST_HP"];
        float FinalHp(float factor)
        {
            var stats = Activator.CreateInstance(statType)!;
            ((IDictionary)Get(stats, "m_StatBase")!)[Enum.Parse(statEnum, "NST_HP")] = basic;
            var bonus = (IDictionary)Get(stats, "m_StatBonusBaseValue")!;
            bonus[Enum.Parse(statEnum, "NST_HP")] = profile.GetProperty("gearFlatHp").GetSingle();
            bonus[Enum.Parse(statEnum, "NST_HP_FACTOR")] = factor;
            statType.GetMethod("ApplyBuffStatToFinalStat", Flags)!.Invoke(stats, [null, null, Enum.Parse(statEnum, "NST_HP"), false, false]);
            return (float)statType.GetMethod("GetStatFinal", Flags, [statEnum])!.Invoke(stats, [Enum.Parse(statEnum, "NST_HP")])!;
        }
        var oldHp = FinalHp(profile.GetProperty("gearHpFactor").GetSingle());
        var newHp = FinalHp(profile.GetProperty("gearHpFactor").GetSingle() + profile.GetProperty("additionalHpFactor").GetSingle());
        var critBefore = Value(profile, "critBefore", .72f); var critAfter = Value(profile, "critAfter", .4f); var critDamage = Value(profile, "enemyCritDamage", .5f);
        var oldCritExtra = Math.Clamp(critDamage - critBefore, 0, 5); var newCritExtra = Math.Clamp(critDamage - critAfter, 0, 5);
        var hpRatio = newHp / oldHp;
        return new { unitId = profile.GetProperty("unitId").GetInt32(), level, limitBreakLevel = limitBreak, permanentContractMultiplier = permanent,
            nativeBaseHp = basic, currentHp = oldHp, hpAfterSwap = newHp, relativeGain = newHp / oldHp - 1,
            critBefore, critAfter, enemyCritDamage = critDamage,
            noEvadeCrit50BreakEvenProbability = (hpRatio - 1) / (newCritExtra - hpRatio * oldCritExtra),
            scope = "Original base growth and gear HP only; character, ship and conditional battle buffs are not assumed active." };
    }

    object Stats(Dictionary<string, float> values)
    {
        var stats = Activator.CreateInstance(statType)!;
        foreach (var pair in values) { var key = Enum.Parse(statEnum, pair.Key); var value = cap.Invoke(stats, [key, pair.Value]); setStat.Invoke(stats, [key, value]); }
        return stats;
    }
    Dictionary<string, float> LevelStats(JsonElement source, int level, string unitKind, int limitBreak = 0, float permanent = 0)
    {
        var stats = Activator.CreateInstance(statType)!;
        foreach (var (jsonName, fieldName) in new[] { ("m_Stat", "m_StatBase"), ("m_StatPerLevel", "m_StatPerLevel"), ("m_StatMaxPerLevel", "m_StatMaxPerLevel") })
        {
            if (!source.TryGetProperty(jsonName, out var values)) continue;
            var dictionary = (IDictionary)Get(stats, fieldName)!;
            foreach (var pair in ReadStats(values)) dictionary[Enum.Parse(statEnum, pair.Key)] = pair.Value;
        }
        var calculate = manager.GetMethods(Flags).Single(m => m.Name == "CalculateStat" && m.GetParameters().Length == 9);
        var unitTypeEnum = calculate.GetParameters()[8].ParameterType;
        var result = new Dictionary<string, float>();
        foreach (var pair in source.GetProperty("m_Stat").EnumerateObject())
        {
            var key = Enum.Parse(statEnum, pair.Name);
            result[pair.Name] = Convert.ToInt32(key) <= 5
                ? (float)calculate.Invoke(null, [key, stats, level, limitBreak, permanent, null, null, 0, Enum.Parse(unitTypeEnum, unitKind)])!
                : pair.Value.GetSingle();
        }
        return result;
    }
    object Unit(int id, object stats, bool player, bool air, bool boss, string role, string style, float hpRate, string unitKind)
    {
        var unit = New(unitType); var data = New(Type("NKM.NKMUnitData")); Set(data, "m_UnitID", id); Set(data, "m_UnitLevel", 120); Set(unit, "m_UnitData", data);
        Set(unit, "m_UnitDataGame", New(Type("NKM.NKMUnitDataGame")));
        var templetBase = New(Type("NKM.Templet.NKMUnitTempletBase")); Set(templetBase, "m_UnitID", id); Set(templetBase, "m_NKM_UNIT_TYPE", unitKind);
        Set(templetBase, "m_NKM_UNIT_STYLE_TYPE", style); Set(templetBase, "m_NKM_UNIT_ROLE_TYPE", role);
        Set(templetBase, "m_bAirUnit", air); Set(templetBase, "m_bMonster", !player);
        var container = Type("NKM.Templet.Base.NKMTempletContainer`1").MakeGenericType(templetBase.GetType());
        ((IDictionary)container.GetField("data", Flags)!.GetValue(null)!)[id] = templetBase;
        var templet = New(Type("NKM.NKMUnitTemplet")); Set(templet, "m_UnitTempletBase", templetBase);
        Empty(templet, "m_listFixedStatusEffect"); Empty(templet, "m_listFixedStatusImmune"); Set(unit, "m_UnitTemplet", templet); Set(unit, "m_bBoss", boss);
        var frame = New(Type("NKM.NKMUnitFrameData")); Set(frame, "m_StatData", stats); Set(frame, "m_UnitRoleType", role);
        Empty(frame, "m_hsStatus"); Empty(frame, "m_hsImmuneStatus"); Set(unit, "m_UnitFrameData", frame);
        var sync = Activator.CreateInstance(Type("NKM.NKMUnitSyncData"))!; Set(sync, "m_GameUnitUID", id);
        var hp = (float)statType.GetMethod("GetStatFinal", Flags, [statEnum])!.Invoke(stats, [Enum.Parse(statEnum, "NST_HP")])!;
        sync.GetType().GetMethod("SetHP", Flags)!.Invoke(sync, [hp * hpRate]); Set(unit, "m_UnitSyncData", sync);
        return unit;
    }
    Dictionary<string, float> ReadStats(JsonElement source) => source.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetSingle());
    Type Type(string name) => client.GetType(name, true)!;
    static object New(Type type) => RuntimeHelpers.GetUninitializedObject(type);
    static object? Get(object value, string field) => value.GetType().GetField(field, Flags)!.GetValue(value);
    static void Empty(object value, string name) { var field = value.GetType().GetField(name, Flags)!; field.SetValue(value, Activator.CreateInstance(field.FieldType)); }
    static void Set(object value, string name, object? fieldValue) { var field = value.GetType().GetField(name, Flags)!; field.SetValue(value, field.FieldType.IsEnum
        ? fieldValue is string text ? Enum.Parse(field.FieldType, text) : Enum.ToObject(field.FieldType, Convert.ToInt32(fieldValue))
        : fieldValue == null || field.FieldType.IsInstanceOfType(fieldValue) ? fieldValue : Convert.ChangeType(fieldValue, field.FieldType)); }
    static float Value(JsonElement source, string name, float fallback) => source.TryGetProperty(name, out var value) ? value.GetSingle() : fallback;
    static bool Bool(JsonElement source, string name) => source.TryGetProperty(name, out var value) && value.GetBoolean();
    static string Text(JsonElement source, string name, string fallback) => source.TryGetProperty(name, out var value) ? value.GetString()! : fallback;
}

sealed class ControlledRandom : Random
{
    public int Roll { get; set; } = 5000;
    public override int Next(int minValue, int maxValue) => Math.Clamp(Roll, minValue, maxValue - 1);
    public override double NextDouble() => .5;
}
