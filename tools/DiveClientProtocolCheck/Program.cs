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
    var playerBase = PlayerBase(baseJson);
    var player = New("NKM.NKMDivePlayer");
    Set(player, "playerBase", playerBase);
    var squadField = player.GetType().GetField("squads", flags)!;
    var squads = (IDictionary)Activator.CreateInstance(squadField.FieldType)!;
    squadField.SetValue(player, squads);
    foreach (var squad in dive.GetProperty("player").GetProperty("squads").EnumerateObject())
        squads[int.Parse(squad.Name)] = Squad(squad.Value);
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
    if (fixture.TryGetProperty("afterMove", out var afterMove))
    {
        var moveSync = fixture.GetProperty("moveSync");
        foreach (var updated in moveSync.GetProperty("updatedSlots").EnumerateArray())
        {
            var target = floor.GetType().GetMethod("GetSlot", flags)!.Invoke(floor,
                new object[] { updated.GetProperty("slotSetIndex").GetInt32(), updated.GetProperty("slotIndex").GetInt32() })!;
            foreach (var property in updated.GetProperty("slot").EnumerateObject()) Set(target, property.Name, property.Value.GetInt32());
        }
        var update = moveSync.GetProperty("updatedPlayer");
        if (update.GetProperty("state").GetInt32() is 0 or 4)
            floor.GetType().GetMethod("Rebuild", flags)!.Invoke(floor,
                new object[] { distance, nextSet, update.GetProperty("slotIndex").GetInt32() });
        // NKCPacketHandlersLobby's MOVE_ACK applies updated slots and the above
        // rebuild before copying player/squads; the remaining native data copy
        // therefore uses UpdateData(false), with an empty updated-slot list.
        game.GetType().GetMethod("UpdateData", flags)!.Invoke(game,
            new object[] { false, Sync(update, moveSync.GetProperty("updatedSquads")) });
        AssertPlayer(playerBase, afterMove.GetProperty("player").GetProperty("base"), name!);
        AssertFloor(sets, afterMove.GetProperty("floor"), name!);
        foreach (var expected in afterMove.GetProperty("player").GetProperty("squads").EnumerateObject())
            foreach (var property in expected.Value.EnumerateObject())
            {
                var squad = squads[int.Parse(expected.Name)]!;
                var actual = Convert.ToDouble(squad.GetType().GetField(property.Name, flags)!.GetValue(squad));
                Require(Math.Abs(actual - property.Value.GetDouble()) < 0.01, $"{name}: MOVE_ACK squad {expected.Name}/{property.Name}");
            }
        checks++;
    }
    if (fixture.TryGetProperty("afterSelection", out var afterSelection))
    {
        var expectedBase = afterSelection.GetProperty("player").GetProperty("base");
        game.GetType().GetMethod("UpdateData", flags)!.Invoke(game, new object[] { false, Sync(expectedBase) });
        AssertPlayer(playerBase, expectedBase, name!);
        AssertFloor(sets, afterSelection.GetProperty("floor"), name!);
        var selectionSlot = ReachableSlot(expectedBase, floorJson);
        Require(Convert.ToInt32(canMove.Invoke(null, new object[] { selectionSlot, user })) == 0, $"{name}: selection reopens movement without another Rebuild");
        checks++;
    }
    if (fixture.TryGetProperty("afterLoss", out var afterLoss))
    {
        var losingSync = fixture.GetProperty("lossSync");
        var expectedBase = afterLoss.GetProperty("player").GetProperty("base");
        game.GetType().GetMethod("UpdateData", flags)!.Invoke(game,
            new object[] { false, Sync(losingSync.GetProperty("updatedPlayer"), losingSync.GetProperty("updatedSquads")) });
        AssertPlayer(playerBase, expectedBase, name!);
        AssertFloor(sets, afterLoss.GetProperty("floor"), name!);
        Require(expectedBase.GetProperty("distance").GetInt32() == distance, $"{name}: loss does not occupy another row");
        var deadDeck = expectedBase.GetProperty("reservedDeckIndex").GetInt32();
        var defeated = squads[deadDeck]!;
        Require(Convert.ToInt32(defeated.GetType().GetField("state", flags)!.GetValue(defeated)) == 1 &&
            Convert.ToDouble(defeated.GetType().GetField("curHp", flags)!.GetValue(defeated)) == 0,
            $"{name}: native dead-ship state and animation identity are retained");
        var nextSlot = expectedBase.GetProperty("state").GetInt32() == 5 ? 0 : ReachableSlot(expectedBase, floorJson);
        var expectedError = expectedBase.GetProperty("state").GetInt32() == 5 ? 322 : 0;
        Require(Convert.ToInt32(canMove.Invoke(null, new object[] { nextSlot, user })) == expectedError,
            $"{name}: a living replacement can search again, while annihilation stops movement");
        checks++;
    }
    if (fixture.TryGetProperty("difficulty", out var difficulty))
    {
        var gameData = New("NKM.NKMGameData");
        Set(gameData, "m_TeamBLevelFix", 0);
        Set(gameData, "m_TeamBLevelAdd", difficulty.GetProperty("levelAdd").GetInt32());
        var fixedLevel = client.GetType("NKM.NKMDungeonManager", throwOnError: true)!
            .GetMethod("GetFixedTeamBUnitLevel", flags)!;
        foreach (var level in difficulty.GetProperty("levels").EnumerateArray())
        {
            var source = level.GetProperty("source").GetInt32();
            var actual = Convert.ToInt32(fixedLevel.Invoke(null, new object[] { source, gameData }));
            Require(actual == level.GetProperty("expected").GetInt32(), $"{name}: native enemy level {source} became {actual}");
            checks++;
        }
    }
    var hasWinSync = fixture.TryGetProperty("afterWin", out var afterWin);
    if (hasWinSync)
    {
        var expectedBase = afterWin.GetProperty("player").GetProperty("base");
        var sync = Sync(expectedBase);
        // This is the client's actual successful GAME_END_NOT update, including
        // floor rebuilding before UpdatedPlayer is copied into the player.
        game.GetType().GetMethod("UpdateData", flags)!.Invoke(game, new object[] { true, sync });
        foreach (var property in expectedBase.EnumerateObject())
            if (property.Value.ValueKind == JsonValueKind.Number)
                Require(Convert.ToInt32(playerBase.GetType().GetField(property.Name, flags)!.GetValue(playerBase)) == property.Value.GetInt32(),
                    $"{name}: win-sync player {property.Name}");
        var postSet = expectedBase.GetProperty("slotSetIndex").GetInt32();
        var postSlot = expectedBase.GetProperty("slotIndex").GetInt32();
        var completedSlots = (IList)sets[0]!.GetType().GetField("slots", flags)!.GetValue(sets[0])!;
        Require(postSet == 0 && completedSlots.Count == 1, $"{name}: the completed row contains the selected slot");
        // SectorSetMgr.SetUI places completed-row Slots[0] at PlayerBase.slotIndex
        // in the UI. Floor.GetSlot(0, oldLane) is deliberately not that UI lookup.
        Require(postSlot == baseJson.GetProperty("slotIndex").GetInt32(), $"{name}: preserve the chosen UI lane after Rebuild");
        var nextAfterWin = Convert.ToInt32(player.GetType().GetMethod("GetNextSlotSetIndex", flags)!.Invoke(player, null));
        var cleared = expectedBase.GetProperty("state").GetInt32() == 6;
        if (cleared)
        {
            Require(expectedBase.GetProperty("distance").GetInt32() == floorJson.GetProperty("randomSetCount").GetInt32() + 1,
                $"{name}: clearing the terminal boss completes every node");
            Require(Convert.ToInt32(canMove.Invoke(null, new object[] { 0, user })) == 322,
                $"{name}: native movement stops after the boss clear");
        }
        else if (expectedBase.GetProperty("state").GetInt32() == 4)
        {
            Require(nextAfterWin < sets.Count, $"{name}: an artifact choice retains the next connected row");
            Require(Convert.ToInt32(canMove.Invoke(null, new object[] { 0, user })) == 322, $"{name}: native waits for artifact selection");
        }
        else
        {
            Require(nextAfterWin < sets.Count, $"{name}: next connected row exists");
            Require(Convert.ToInt32(canMove.Invoke(null, new object[] { ReachableSlot(expectedBase, floorJson), user })) == 0,
                $"{name}: native next-node search can proceed after win-sync");
        }
        checks++;
    }
    if (hasWinSync || fixture.TryGetProperty("expectedFloorAfterWin", out _))
    {
        var expectedFloor = hasWinSync ? afterWin.GetProperty("floor") : fixture.GetProperty("expectedFloorAfterWin");
        if (!hasWinSync) floor.GetType().GetMethod("Rebuild", flags)!.Invoke(floor,
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
    field.SetValue(target, field.FieldType.IsEnum ? Enum.ToObject(field.FieldType, Convert.ToInt32(value)) :
        field.FieldType.IsPrimitive ? Convert.ChangeType(value, field.FieldType) : value);
}

object PlayerBase(JsonElement json)
{
    var value = New("NKM.NKMDivePlayerBase");
    foreach (var property in json.EnumerateObject())
        if (property.Value.ValueKind == JsonValueKind.Number) Set(value, property.Name, property.Value.GetInt32());
    foreach (var field in new[] { "artifacts", "reservedArtifacts" })
    {
        var values = NewList(value, field);
        if (json.TryGetProperty(field, out var source)) foreach (var item in source.EnumerateArray()) values.Add(item.GetInt32());
    }
    return value;
}

object Squad(JsonElement json)
{
    var value = New("NKM.NKMDiveSquad");
    foreach (var property in json.EnumerateObject()) Set(value, property.Name, property.Value.GetDouble());
    return value;
}

object Sync(JsonElement json, JsonElement changedSquads = default)
{
    var sync = New("NKM.NKMDiveSyncData");
    Set(sync, "updatedPlayer", PlayerBase(json));
    NewList(sync, "updatedSlots"); NewList(sync, "addedSlotSets");
    var values = NewList(sync, "updatedSquads");
    if (changedSquads.ValueKind == JsonValueKind.Array)
        foreach (var item in changedSquads.EnumerateArray()) values.Add(Squad(item));
    return sync;
}

void AssertPlayer(object playerBase, JsonElement expected, string name)
{
    foreach (var property in expected.EnumerateObject())
    {
        var actual = playerBase.GetType().GetField(property.Name, flags)!.GetValue(playerBase);
        if (property.Value.ValueKind == JsonValueKind.Array)
            Require(((IEnumerable)actual!).Cast<object>().Select(Convert.ToInt32).SequenceEqual(property.Value.EnumerateArray().Select(value => value.GetInt32())), $"{name}: player {property.Name}");
        else Require(Convert.ToInt32(actual) == property.Value.GetInt32(), $"{name}: player {property.Name}");
    }
}

void AssertFloor(IList sets, JsonElement expectedFloor, string name)
{
    var expected = expectedFloor.GetProperty("slotSets").EnumerateArray().ToArray();
    Require(sets.Count == expected.Length, $"{name}: floor row count");
    for (var row = 0; row < sets.Count; row++)
    {
        var slots = (IList)sets[row]!.GetType().GetField("slots", flags)!.GetValue(sets[row])!;
        var expectedSlots = expected[row].GetProperty("slots").EnumerateArray().ToArray();
        Require(slots.Count == expectedSlots.Length, $"{name}: row {row} slot count");
        for (var index = 0; index < slots.Count; index++)
            foreach (var property in expectedSlots[index].EnumerateObject())
                Require(Convert.ToInt32(slots[index]!.GetType().GetField(property.Name, flags)!.GetValue(slots[index])) == property.Value.GetInt32(), $"{name}: row {row}/{index}/{property.Name}");
    }
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

static int ReachableSlot(JsonElement playerBase, JsonElement floor) =>
    playerBase.GetProperty("distance").GetInt32() == floor.GetProperty("randomSetCount").GetInt32()
        ? 0 : Math.Max(0, playerBase.GetProperty("slotIndex").GetInt32() - 1);
