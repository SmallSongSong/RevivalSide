using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: DiveClientProtocolCheck <client Data/Managed directory> <generated fixture JSON>");
    return 2;
}

var managedDir = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(managedDir, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managedDir, "Assembly-CSharp.dll"));
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
var manager = client.GetType("NKM.NKMDiveGameManager", throwOnError: true)!;
var canMove = manager.GetMethod("CanMoveForward", flags)!;
using var fixtures = JsonDocument.Parse(File.ReadAllText(args[1]));
var checks = 0;

foreach (var fixture in fixtures.RootElement.EnumerateArray())
{
    var name = fixture.GetProperty("name").GetString();
    var dive = fixture.GetProperty("dive");
    var floorJson = dive.GetProperty("floor");
    var baseJson = dive.GetProperty("player").GetProperty("base");
    var floor = New("NKM.NKMDiveFloor");
    var templet = New("NKM.Templet.NKMDiveTemplet");
    Set(templet, "RANDOM_SET_COUNT", floorJson.GetProperty("randomSetCount").GetInt32());
    Set(floor, "templet", templet);
    var sets = NewList(floor, "slotSets");
    foreach (var setJson in floorJson.GetProperty("slotSets").EnumerateArray())
    {
        var set = New("NKM.NKMDiveSlotSet");
        var slots = NewList(set, "slots");
        foreach (var slotJson in setJson.GetProperty("slots").EnumerateArray())
        {
            var slot = New("NKM.NKMDiveSlot");
            foreach (var property in slotJson.EnumerateObject()) Set(slot, property.Name, property.Value.GetInt32());
            slots.Add(slot);
        }
        sets.Add(set);
    }
    var playerBase = New("NKM.NKMDivePlayerBase");
    foreach (var property in baseJson.EnumerateObject())
        if (property.Value.ValueKind == JsonValueKind.Number) Set(playerBase, property.Name, property.Value.GetInt32());
    var player = New("NKM.NKMDivePlayer");
    Set(player, "playerBase", playerBase);
    var game = New("NKM.NKMDiveGameData");
    Set(game, "floor", floor);
    Set(game, "player", player);
    var user = New("NKM.NKMUserData");
    Set(user, "m_DiveGameData", game);

    var nextSet = Convert.ToInt32(player.GetType().GetMethod("GetNextSlotSetIndex", flags)!.Invoke(player, null));
    Require(nextSet == fixture.GetProperty("expectedNextSet").GetInt32(), $"{name}: native next-set index {nextSet}");
    foreach (var move in fixture.GetProperty("moves").EnumerateArray())
    {
        var slotIndex = move.GetProperty("slot").GetInt32();
        var error = Convert.ToInt32(canMove.Invoke(null, new object[] { slotIndex, user }));
        Require(error == move.GetProperty("error").GetInt32(), $"{name}: native movement to slot {slotIndex} returned {error}");
        checks++;
    }

    // NKCDiveGame.IsSameCol feeds UpdateSectorInfoUI's battle/search boolean.
    // Its IL compares set 0 before the first completion and set 1 afterwards.
    // These Unity UI methods are intentionally not instantiated by this check.
    var distance = baseJson.GetProperty("distance").GetInt32();
    var currentSet = baseJson.GetProperty("slotSetIndex").GetInt32();
    var battleButton = currentSet == (distance == 0 ? 0 : 1);
    Require(battleButton == fixture.GetProperty("expectedBattleButton").GetBoolean(), $"{name}: native battle/search button contract");
    if (fixture.TryGetProperty("expectedFloorAfterWin", out var expectedFloor))
    {
        floor.GetType().GetMethod("Rebuild", flags)!.Invoke(floor,
            new object[] { distance, currentSet, baseJson.GetProperty("slotIndex").GetInt32() });
        var expectedSets = expectedFloor.GetProperty("slotSets").EnumerateArray().ToArray();
        Require(sets.Count == expectedSets.Length, $"{name}: native floor Rebuild count");
        for (var setIndex = 0; setIndex < sets.Count; setIndex++)
        {
            var nativeSlots = (IList)sets[setIndex]!.GetType().GetField("slots", flags)!.GetValue(sets[setIndex])!;
            var expectedSlots = expectedSets[setIndex].GetProperty("slots").EnumerateArray().ToArray();
            Require(nativeSlots.Count == expectedSlots.Length, $"{name}: native rebuilt row {setIndex}");
            for (var slotIndex = 0; slotIndex < nativeSlots.Count; slotIndex++)
                foreach (var property in expectedSlots[slotIndex].EnumerateObject())
                {
                    var slot = nativeSlots[slotIndex]!;
                    var actual = Convert.ToInt32(slot.GetType().GetField(property.Name, flags)!.GetValue(slot));
                    Require(actual == property.Value.GetInt32(), $"{name}: rebuilt {setIndex}/{slotIndex}/{property.Name}");
                }
        }
        checks++;
    }
    Console.WriteLine($"{name}: native movement and button contract passed");
}
Console.WriteLine($"Dive client protocol checks passed ({checks} native movement/Rebuild checks, no Unity scene).");
return 0;

object New(string name) => RuntimeHelpers.GetUninitializedObject(client.GetType(name, throwOnError: true)!);

void Set(object target, string name, object value)
{
    var field = target.GetType().GetField(name, flags) ?? throw new InvalidOperationException($"Missing {target.GetType().Name}.{name}");
    field.SetValue(target, field.FieldType.IsEnum ? Enum.ToObject(field.FieldType, value) : value);
}

IList NewList(object target, string name)
{
    var field = target.GetType().GetField(name, flags)!;
    var list = (IList)Activator.CreateInstance(field.FieldType)!;
    field.SetValue(target, list);
    return list;
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
