using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: SaveInventoryProtocolCheck <original Managed directory> <inventory protocol fixture JSON>");
    return 2;
}

var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
try
{
    var managed = Path.GetFullPath(args[0]);
    AssemblyLoadContext.Default.Resolving += (context, name) =>
    {
        var path = Path.Combine(managed, name.Name + ".dll");
        return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
    };
    var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managed, "Assembly-CSharp.dll"));
    var serializable = client.GetType("Cs.Protocol.ISerializable", true)!;
    var readerType = client.GetType("Cs.Protocol.PacketReader", true)!;
    var readerGet = readerType.GetMethod("GetWithoutNullBit", flags, null, [serializable], null)!;
    var writerPut = client.GetType("Cs.Protocol.PacketWriter", true)!
        .GetMethod("ToBufferWithoutNullBit", flags, null, [serializable], null)!;
    using var input = JsonDocument.Parse(File.ReadAllText(args[1]));
    var units = new Dictionary<long, object>();
    var equipment = new Dictionary<long, object>();
    var mismatchCount = 0;
    var decodedUnits = 0;
    var decodedEquipment = 0;
    var decodedOperators = 0;

    foreach (var entry in input.RootElement.GetProperty("units").EnumerateArray())
    {
        var unit = Decode("NKM.NKMUnitData", entry, "unit", decodedUnits++);
        var uid = Number(unit, "m_UnitUID");
        Require(uid > 0 && units.TryAdd(uid, unit), "Unit UID is zero or duplicated.");
        if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("uid", out var expectedUid))
            Require(uid == JsonNumber(expectedUid), "Decoded unit UID differs from the source fixture.");
        Require(Number(unit, "m_UnitID") > 0, "Unit template ID is zero.");
        Require(Get(unit, "m_EquipItemList") is Array { Length: 4 }, "Decoded unit does not have four equipment slots.");
        if (entry.TryGetProperty("shipModuleCount", out var moduleCount))
        {
            Require(((IEnumerable)Get(unit, "ShipCommandModule")!).Cast<object>().Count() == moduleCount.GetInt32(), "Decoded ship module count differs from the source fixture.");
            Require(Number(unit, "m_UnitID") == JsonNumber(entry.GetProperty("id"))
                && Number(unit, "m_UnitLevel") == JsonNumber(entry.GetProperty("level"))
                && Number(unit, "m_LimitBreakLevel") == JsonNumber(entry.GetProperty("limitBreakLevel")), "Decoded ship growth differs from the source fixture.");
        }
        if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("equipmentUids", out var expectedSlots))
            Require(((Array)Get(unit, "m_EquipItemList")!).Cast<object>().Select(Convert.ToInt64)
                .SequenceEqual(expectedSlots.EnumerateArray().Select(JsonNumber)), "Decoded equipment slot order differs from the source fixture.");
    }
    var itemEntries = input.RootElement.TryGetProperty("equipItems", out var items) ? items : input.RootElement.GetProperty("equipment");
    foreach (var entry in itemEntries.EnumerateArray())
    {
        var item = Decode("NKM.NKMEquipItemData", entry, "equipment", decodedEquipment++);
        var uid = Number(item, "m_ItemUid");
        Require(uid > 0 && equipment.TryAdd(uid, item), "Equipment UID is zero or duplicated.");
        if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("uid", out var expectedUid))
            Require(uid == JsonNumber(expectedUid), "Decoded equipment UID differs from the source fixture.");
        Require(Number(item, "m_ItemEquipID") > 0, "Equipment template ID is zero.");
    }

    var assigned = new HashSet<long>();
    var slotCount = 0;
    foreach (var pair in units)
    {
        foreach (var entry in (Array)Get(pair.Value, "m_EquipItemList")!)
        {
            var uid = Convert.ToInt64(entry);
            if (uid == 0) continue;
            Require(equipment.TryGetValue(uid, out var item), "Decoded equipment slot references a missing inventory item.");
            Require(assigned.Add(uid), "Decoded equipment is assigned to more than one unit slot.");
            Require(Number(item!, "m_OwnerUnitUID") == pair.Key, "Decoded slot and equipment owner disagree.");
            slotCount++;
        }
    }
    foreach (var pair in equipment)
    {
        var owner = Number(pair.Value, "m_OwnerUnitUID");
        Require(owner <= 0 || units.ContainsKey(owner) && assigned.Contains(pair.Key), "Decoded owned equipment lacks a matching unit slot.");
    }
    if (input.RootElement.TryGetProperty("operators", out var operatorEntries))
    {
        var operatorUids = new HashSet<long>();
        foreach (var entry in operatorEntries.EnumerateArray())
        {
            var op = Decode("NKM.NKMOperator", entry, "operator", decodedOperators++);
            var uid = Number(op, "uid");
            Require(uid > 0 && operatorUids.Add(uid), "Operator UID is zero or duplicated.");
            Require(uid == JsonNumber(entry.GetProperty("uid")), "Decoded operator UID differs from the source fixture.");
            Require(Number(op, "id") == JsonNumber(entry.GetProperty("id")), "Decoded operator ID differs from the source fixture.");
            Require(Number(op, "level") == JsonNumber(entry.GetProperty("level")), "Decoded operator level differs from the source fixture.");
            foreach (var skillName in new[] { "mainSkill", "subSkill" })
            {
                var skill = Get(op, skillName)!;
                var expected = entry.GetProperty(skillName);
                Require(Number(skill, "id") == JsonNumber(expected.GetProperty("id"))
                    && Number(skill, "level") == JsonNumber(expected.GetProperty("level")), "Decoded operator skill differs from the source fixture.");
            }
        }
    }
    Console.WriteLine($"Original inventory protocol: units={decodedUnits} equipment={decodedEquipment} equippedSlots={slotCount} roundTripMismatches={mismatchCount}.");
    if (decodedOperators > 0) Console.WriteLine($"Original operator protocol: operators={decodedOperators} roundTripMismatches={mismatchCount}.");
    return mismatchCount == 0 ? 0 : 1;

    object Decode(string typeName, JsonElement source, string kind, int index)
    {
        var base64 = source.ValueKind == JsonValueKind.String ? source.GetString()! : source.GetProperty("payloadBase64").GetString()!;
        var bytes = Convert.FromBase64String(base64);
        var value = Activator.CreateInstance(client.GetType(typeName, true)!)!;
        var reader = Activator.CreateInstance(readerType, [bytes])!;
        try { readerGet.Invoke(reader, [value]); }
        finally { (reader as IDisposable)?.Dispose(); }
        var encoded = Encode(value);
        if (!bytes.AsSpan().SequenceEqual(encoded))
        {
            mismatchCount++;
            var offset = 0;
            while (offset < Math.Min(bytes.Length, encoded.Length) && bytes[offset] == encoded[offset]) offset++;
            Console.Error.WriteLine($"Round-trip mismatch: type={kind} index={index} firstOffset={offset} inputBytes={bytes.Length} outputBytes={encoded.Length}.");
        }
        return value;
    }

    byte[] Encode(object value)
    {
        var buffer = writerPut.Invoke(null, [value])!;
        var type = buffer.GetType();
        var length = Convert.ToInt32(type.GetMethod("CalcTotalSize", flags)!.Invoke(buffer, null));
        var output = new byte[length];
        var offset = 0;
        foreach (var segment in (IEnumerable)type.GetMethod("GetView", flags)!.Invoke(buffer, null)!)
        {
            var segmentType = segment.GetType();
            var bytes = (byte[])segmentType.GetProperty("Data")!.GetValue(segment)!;
            var count = Convert.ToInt32(segmentType.GetProperty("Offset")!.GetValue(segment));
            Buffer.BlockCopy(bytes, 0, output, offset, count);
            offset += count;
        }
        Require(offset == length, "Original writer did not emit the complete buffer.");
        return output;
    }
}
catch (Exception exception)
{
    while (exception is TargetInvocationException && exception.InnerException != null) exception = exception.InnerException;
    // Protocol bytes and UIDs remain private, including on decoding failures.
    Console.Error.WriteLine($"Original inventory protocol failed: {exception.GetType().Name}.");
    Console.Error.WriteLine(exception.StackTrace);
    return 1;
}

object? Get(object value, string name) => value.GetType().GetField(name, flags)!.GetValue(value);
long Number(object value, string name) => Convert.ToInt64(Get(value, name));
long JsonNumber(JsonElement value) => value.ValueKind == JsonValueKind.String ? long.Parse(value.GetString()!) : value.GetInt64();
void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
