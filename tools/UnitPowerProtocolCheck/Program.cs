using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 4)
{
    Console.Error.WriteLine("Usage: UnitPowerProtocolCheck <managed directory> <gameplay-jsons directory> <units input JSON> <output JSON>");
    return 2;
}

try
{
    var check = new OriginalUnitPower(Path.GetFullPath(args[0]), Path.GetFullPath(args[1]));
    using var input = JsonDocument.Parse(File.ReadAllText(args[2]));
    var scores = check.Calculate(input.RootElement);
    if (input.RootElement.TryGetProperty("expectedPowers", out var expected))
    {
        foreach (var entry in expected.EnumerateObject())
            if (!scores.TryGetValue(entry.Name, out var actual) || actual != entry.Value.GetInt32())
                throw new InvalidOperationException("Public fixture operation power mismatch.");
    }
    var output = Path.GetFullPath(args[3]);
    var temp = output + ".tmp";
    File.WriteAllText(temp, JsonSerializer.Serialize(new
    {
        source = "original-client CalculateUnitOperationPower",
        assemblySha256 = check.AssemblySha256,
        scores,
    }));
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    File.Move(temp, output, overwrite: true);
    Console.WriteLine($"Original client power: units={scores.Count} equipment={check.EquipmentCount}.");
    return 0;
}
catch (Exception exception)
{
    // Input values stay out of diagnostic output, including unit and equipment UIDs.
    while (exception is TargetInvocationException && exception.InnerException != null) exception = exception.InnerException;
    Console.Error.WriteLine($"Original client power failed: {exception.GetType().Name}.");
    Console.Error.WriteLine(exception.StackTrace);
    return 1;
}

sealed class OriginalUnitPower
{
    private const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private readonly Assembly client;
    private readonly string tables;
    private readonly Type unitType;
    private readonly Type equipmentType;
    private readonly Type equipmentSetType;
    private readonly MethodInfo calculateUnit;
    private readonly Dictionary<int, object> bases = [];
    private readonly HashSet<int> equipmentTemplates = [];
    private readonly HashSet<int> potentialTemplates = [];
    public string AssemblySha256 { get; }
    public int EquipmentCount { get; private set; }

    public OriginalUnitPower(string managed, string tablesDirectory)
    {
        tables = tablesDirectory;
        AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            var path = Path.Combine(managed, name.Name + ".dll");
            return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
        };
        var assemblyPath = Path.Combine(managed, "Assembly-CSharp.dll");
        AssemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assemblyPath))).ToLowerInvariant();
        client = AssemblyLoadContext.Default.LoadFromAssemblyPath(assemblyPath);
        unitType = Type("NKM.NKMUnitData");
        equipmentType = Type("NKM.NKMEquipItemData");
        equipmentSetType = Type("NKM.NKMEquipmentSet");
        calculateUnit = unitType.GetMethod("CalculateUnitOperationPower", Flags, [equipmentSetType])!;
        LoadBases();
        LoadEquipment();
        LoadSets();
        LoadPotential();
    }

    public Dictionary<string, int> Calculate(JsonElement root)
    {
        var equipment = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var source in Required(root, "equipItems").EnumerateArray())
        {
            var uid = Text(Required(source, "equipUid", "itemUid", "m_ItemUid"));
            if (equipment.ContainsKey(uid)) throw new InvalidDataException("Duplicate equipment UID in power input.");
            var id = Int(Required(source, "itemEquipId", "m_ItemEquipID"));
            if (!equipmentTemplates.Contains(id)) throw new InvalidDataException("Equipment template missing from public tables.");
            var item = New(equipmentType);
            Set(item, "m_ItemUid", uid);
            Set(item, "m_ItemEquipID", id);
            Set(item, "m_EnchantLevel", Number(source, "enchantLevel", "m_EnchantLevel"));
            Set(item, "m_Precision", Number(source, "precision", "m_Precision"));
            Set(item, "m_Precision2", Number(source, "precision2", "m_Precision2"));
            Set(item, "m_SetOptionId", Number(source, "setOptionId", "m_SetOptionId"));
            var potentialField = Field(item.GetType(), "potentialOptions");
            var options = (IList)Activator.CreateInstance(potentialField.FieldType)!;
            potentialField.SetValue(item, options);
            if (Find(source, out var sourceOptions, "potentialOptions"))
            {
                foreach (var optionSource in sourceOptions.EnumerateArray())
                {
                    var key = Int(Required(optionSource, "optionKey"));
                    if (!potentialTemplates.Contains(key)) throw new InvalidDataException("Potential option template missing from public tables.");
                    var option = New(Type("NKM.NKMPotentialOption"));
                    Set(option, "optionKey", key);
                    var field = Field(option.GetType(), "sockets");
                    var socketSources = Required(optionSource, "sockets").EnumerateArray().ToArray();
                    if (socketSources.Length > 3) throw new InvalidDataException("Potential input has more than three sockets.");
                    var sockets = Array.CreateInstance(field.FieldType.GetElementType()!, 3);
                    for (var i = 0; i < socketSources.Length; i++)
                    {
                        if (socketSources[i].ValueKind == JsonValueKind.Null) continue;
                        var socket = New(field.FieldType.GetElementType()!);
                        Set(socket, "statValue", Required(socketSources[i], "statValue").GetSingle());
                        sockets.SetValue(socket, i);
                    }
                    field.SetValue(option, sockets);
                    options.Add(option);
                }
            }
            equipment.Add(uid, item);
        }
        EquipmentCount = equipment.Count;

        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var source in Required(root, "units").EnumerateArray())
        {
            var uid = Text(Required(source, "unitUid", "m_UnitUID"));
            var id = Int(Required(source, "unitId", "m_UnitID"));
            if (!bases.TryGetValue(id, out var templet)) throw new InvalidDataException("Unit template missing from public tables.");
            if (Get(templet, "m_NKM_UNIT_TYPE")!.ToString() != "NUT_NORMAL") throw new InvalidDataException("Input includes a non-character unit.");
            var unit = New(unitType);
            Set(unit, "m_UnitID", id);
            Set(unit, "m_UnitLevel", Number(source, "level", "m_UnitLevel"));
            Set(unit, "m_LimitBreakLevel", Number(source, "limitBreakLevel", "m_LimitBreakLevel"));
            Set(unit, "tacticLevel", Number(source, "tacticLevel"));
            Set(unit, "reactorLevel", Number(source, "reactorLevel"));
            var levels = Required(source, "skillLevels", "m_aUnitSkillLevel").EnumerateArray().Select(Int).ToArray();
            SetArray(unit, "m_aUnitSkillLevel", levels.Cast<object?>().ToArray());
            var uids = Required(source, "equipItemUids").EnumerateArray().Select(Text).ToArray();
            if (uids.Length != 4) throw new InvalidDataException("Power input requires four ordered equipment slots.");
            var slots = uids.Select(equipUid => equipUid is "0" or "" ? null : equipment.TryGetValue(equipUid, out var item)
                ? item : throw new InvalidDataException("Equipped item missing from input.")).ToArray();
            var set = equipmentSetType.GetConstructor([equipmentType, equipmentType, equipmentType, equipmentType])!.Invoke(slots);
            var power = (int)calculateUnit.Invoke(unit, [set])!;
            if (!result.TryAdd(uid, power)) throw new InvalidDataException("Duplicate unit UID in power input.");
        }
        return result;
    }

    private void LoadBases()
    {
        var baseType = Type("NKM.Templet.NKMUnitTempletBase");
        var container = Type("NKM.Templet.Base.NKMTempletContainer`1").MakeGenericType(baseType);
        var cache = Cache(container, "data");
        foreach (var file in new[] { "LUA_UNIT_TEMPLET_BASE.json", "LUA_UNIT_TEMPLET_BASE2.json" })
        {
            foreach (var record in Records("ab_script_unit_data", file))
            {
                var id = Number(record, "m_UnitID");
                if (id <= 0 || bases.ContainsKey(id)) continue;
                var templet = New(baseType);
                foreach (var name in new[] { "m_UnitID", "m_UnitStrID", "m_NKM_UNIT_TYPE", "m_NKM_UNIT_STYLE_TYPE", "m_NKM_UNIT_ROLE_TYPE", "m_NKM_UNIT_GRADE", "m_bAwaken", "m_BaseUnitID", "m_RearmGrade", "m_ShipGroupID" })
                    if (Find(record, out var value, name)) Set(templet, name, value);
                bases.Add(id, templet);
                cache[id] = templet;
            }
        }
        var bind = baseType.GetMethod("set_BaseUnit", Flags)!;
        foreach (var templet in bases.Values)
        {
            var id = Convert.ToInt32(Get(templet, "m_BaseUnitID"));
            if (id > 0)
            {
                if (!bases.TryGetValue(id, out var baseUnit)) throw new InvalidDataException("Base unit template missing from public tables.");
                bind.Invoke(templet, [baseUnit]);
            }
        }
    }

    private void LoadEquipment()
    {
        var manager = Type("NKM.NKMItemManager");
        var cache = Cache(manager, "m_dicItemEquipTempletByID");
        foreach (var record in Records("ab_script_item_templet", "LUA_ITEM_EQUIP_TEMPLET.json"))
        {
            var id = Number(record, "m_ItemEquipID");
            if (equipmentTemplates.Contains(id)) continue;
            var templet = New(Type("NKM.NKMEquipTemplet"));
            foreach (var name in new[] { "m_ItemEquipID", "m_NKM_ITEM_TIER", "m_NKM_ITEM_GRADE", "m_bRelic" }) Set(templet, name, Required(record, name));
            cache[id] = templet;
            equipmentTemplates.Add(id);
        }
    }

    private void LoadSets()
    {
        var manager = Type("NKM.NKMItemManager");
        var field = Field(manager, "m_dicItemEquipSetOptionTempletByID");
        var templateType = field.FieldType.GetGenericArguments()[1];
        var cache = Cache(manager, field.Name);
        var listField = Field(manager, "m_lstItemEquipSetOptionTemplet");
        var list = (IList)Activator.CreateInstance(listField.FieldType)!;
        listField.SetValue(null, list);
        foreach (var record in Records("ab_script_item_templet", "LUA_ITEM_EQUIP_SET_OPTION.json"))
        {
            var templet = New(templateType);
            Set(templet, "m_EquipSetID", Required(record, "m_EquipSetID"));
            Set(templet, "m_EquipSetPart", Required(record, "m_EquipSetPart"));
            cache[Number(record, "m_EquipSetID")] = templet;
            list.Add(templet);
        }
    }

    private void LoadPotential()
    {
        var optionType = Type("NKM.NKMPotentialOptionTemplet");
        var socketType = Type("NKM.NKMPotentialSocketTemplet");
        var cache = Cache(optionType, "options");
        foreach (var record in Records("ab_script", "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json"))
        {
            var key = Number(record, "OptionKey");
            var templet = New(optionType);
            Set(templet, "optionKey", key);
            var sockets = Array.CreateInstance(socketType, 3);
            for (var i = 0; i < 3; i++)
            {
                var socket = New(socketType);
                var prefix = $"Socket{i + 1}_";
                var min = Float(record, prefix + "MinStat");
                var max = Float(record, prefix + "MaxStat");
                var minRate = Float(record, prefix + "MinStatRate");
                var maxRate = Float(record, prefix + "MaxStatRate");
                if (minRate != 0 || maxRate != 0) { min = minRate; max = maxRate; }
                Set(socket, "minStatValue", min);
                Set(socket, "maxStatValue", max);
                sockets.SetValue(socket, i);
            }
            Set(templet, "sockets", sockets);
            cache[key] = templet;
            potentialTemplates.Add(key);
        }
    }

    private IEnumerable<JsonElement> Records(string bundle, string file)
    {
        var path = Path.Combine(tables, "Assetbundles", bundle, "luac", file);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.GetProperty("records").EnumerateArray().Select(record => record.Clone()).ToArray();
    }

    private IDictionary Cache(Type type, string fieldName)
    {
        var field = Field(type, fieldName);
        if (field.GetValue(null) is IDictionary existing) return existing;
        var cache = (IDictionary)Activator.CreateInstance(field.FieldType)!;
        field.SetValue(null, cache);
        return cache;
    }
    private Type Type(string name) => client.GetType(name, throwOnError: true)!;
    private static object New(Type type) => RuntimeHelpers.GetUninitializedObject(type);
    private static FieldInfo Field(Type type, string name) => type.GetField(name, Flags) ?? throw new MissingFieldException(type.FullName, name);
    private static object? Get(object value, string name) => Field(value.GetType(), name).GetValue(value);
    private static void Set(object target, string name, object? value)
    {
        var field = Field(target.GetType(), name);
        field.SetValue(target, ConvertValue(value, field.FieldType));
    }
    private static void SetArray(object target, string name, object?[] source)
    {
        var field = Field(target.GetType(), name);
        var elementType = field.FieldType.GetElementType()!;
        var array = Array.CreateInstance(elementType, source.Length);
        for (var i = 0; i < source.Length; i++) array.SetValue(ConvertValue(source[i], elementType), i);
        field.SetValue(target, array);
    }
    private static object? ConvertValue(object? value, Type type)
    {
        if (value is JsonElement json)
            value = json.ValueKind switch { JsonValueKind.String => json.GetString(), JsonValueKind.True => true,
                JsonValueKind.False => false, JsonValueKind.Number => type == typeof(float) ? json.GetSingle() : json.GetDouble(), _ => null };
        if (value == null || type.IsInstanceOfType(value)) return value;
        return type.IsEnum ? value is string text ? Enum.Parse(type, text) : Enum.ToObject(type, Convert.ToInt64(value, CultureInfo.InvariantCulture))
            : Convert.ChangeType(value, type, CultureInfo.InvariantCulture);
    }
    private static bool Find(JsonElement source, out JsonElement value, params string[] names)
    {
        foreach (var name in names) if (source.TryGetProperty(name, out value)) return true;
        value = default; return false;
    }
    private static JsonElement Required(JsonElement source, params string[] names) => Find(source, out var value, names) ? value
        : throw new InvalidDataException("Required input field missing: " + names[0]);
    private static int Int(JsonElement value) => value.ValueKind == JsonValueKind.String ? int.Parse(value.GetString()!, CultureInfo.InvariantCulture) : value.GetInt32();
    private static string Text(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
    private static int Number(JsonElement source, params string[] names) => Find(source, out var value, names) ? Int(value) : 0;
    private static float Float(JsonElement source, string name) => source.TryGetProperty(name, out var value) ? value.GetSingle() : 0;
}
