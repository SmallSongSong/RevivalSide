using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length is < 2 or > 3)
{
    Console.Error.WriteLine("Usage: ShadowClientProtocolCheck <client Managed directory> <synthetic fixture JSON> [client Assembly-CSharp.dll]");
    return 2;
}

var managedDir = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(managedDir, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var clientPath = args.Length == 3 ? Path.GetFullPath(args[2]) : Path.Combine(managedDir, "Assembly-CSharp.dll");
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(clientPath);
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

// Load the actual compiled lobby merge, without initializing a battle runtime.
// Its field accessors only reflect on the packet and user instances.
var host = Assembly.Load("CombatHost");
var bridge = host.GetType("RevivalSide.CombatHost.ManagedCombatBridge", throwOnError: true)!;
var runtimeType = bridge.GetNestedType("ManagedRuntime", BindingFlags.NonPublic)!;
var runtime = RuntimeHelpers.GetUninitializedObject(runtimeType);
var mergeUserData = bridge.GetMethod("MergeJoinLobbyUserData", flags)!;

// Register the five public palace #1 battle templates used by the fixtures.
var palaceTemplet = New("NKM.Templet.NKMShadowPalaceTemplet");
Set(palaceTemplet, "PALACE_ID", 1001);
Set(palaceTemplet, "BATTLE_GROUP_ID", 1);
var container = client.GetType("NKM.Templet.Base.NKMTempletContainer`1", throwOnError: true)!.MakeGenericType(palaceTemplet.GetType());
((IDictionary)container.GetField("data", flags)!.GetValue(null)!).Add(1001, palaceTemplet);
var manager = client.GetType("NKM.NKMShadowPalaceManager", throwOnError: true)!;
var battleType = client.GetType("NKM.Templet.NKMShadowBattleTemplet", throwOnError: true)!;
var battles = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(battleType))!;
for (var index = 0; index < 5; index++)
{
    var battle = New(battleType.FullName!);
    Set(battle, "DUNGEON_ID", 2001 + index);
    battles.Add(battle);
}
((IDictionary)manager.GetField("dicShadowBattleTemplet", flags)!.GetValue(null)!).Add(1, battles);
var unlock = New("NKM.UnlockInfo");
Set(unlock, "eReqType", Enum.Parse(client.GetType("NKM.STAGE_UNLOCK_REQ_TYPE", throwOnError: true)!, "SURT_CLEAR_PALACE"));
Set(unlock, "reqValue", 1001);
var canUnlock = client.GetType("NKM.NKMContentUnlockManager", throwOnError: true)!.GetMethods(flags).Single(method =>
    method.Name == "IsContentUnlocked" && method.GetParameters()[1].ParameterType.GetElementType()?.Name == "UnlockInfo" &&
    method.GetParameters()[2].ParameterType == typeof(bool));

using var fixtures = JsonDocument.Parse(File.ReadAllText(args[1]));
var checks = 0;
foreach (var fixture in fixtures.RootElement.EnumerateArray())
{
    var name = fixture.GetProperty("name").GetString();
    var localShadow = ReadShadow(Convert.FromBase64String(fixture.GetProperty("shadowPayload").GetString()!));
    var localUser = New("NKM.NKMUserData");
    Set(localUser, "m_ShadowPalace", localShadow);
    var officialUser = New("NKM.NKMUserData");
    var officialShadow = New("ClientPacket.Mode.NKMShadowPalace");
    NewList(officialShadow, "palaceDataList");
    Set(officialUser, "m_ShadowPalace", officialShadow);
    var localPacket = New("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
    var officialPacket = New("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
    Set(localPacket, "userData", localUser);
    Set(officialPacket, "userData", officialUser);

    mergeUserData.Invoke(null, new[] { runtime, localPacket, officialPacket });
    var mergedUser = Get(officialPacket, "userData");
    Require(ReferenceEquals(Get(mergedUser, "m_ShadowPalace"), localShadow), $"{name}: lobby merge lost local palace progress");
    var allowed = (bool)canUnlock.Invoke(null, new object[] { mergedUser, unlock, true })!;
    Require(allowed == fixture.GetProperty("expectedUnlock").GetBoolean(), $"{name}: native palace #2 unlock was {allowed}");
    Console.WriteLine($"{name}: compiled lobby merge and native palace #2 unlock passed ({allowed})");
    checks++;
}
Console.WriteLine($"Shadow client protocol checks passed: {checks} lobby merge/unlock fixtures.");
return 0;

object New(string name) => RuntimeHelpers.GetUninitializedObject(client.GetType(name, throwOnError: true)!);
void Set(object target, string field, object value) => target.GetType().GetField(field, flags)!.SetValue(target, value);
object Get(object target, string field) => target.GetType().GetField(field, flags)!.GetValue(target)!;
IList NewList(object target, string field)
{
    var info = target.GetType().GetField(field, flags)!;
    var list = (IList)Activator.CreateInstance(info.FieldType)!;
    info.SetValue(target, list);
    return list;
}
void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
object ReadShadow(byte[] bytes)
{
    var offset = 0;
    uint ReadVar()
    {
        uint result = 0;
        for (var shift = 0; shift < 35; shift += 7)
        {
            if (offset >= bytes.Length) throw new InvalidDataException("truncated palace varint");
            var value = bytes[offset++];
            result |= (uint)(value & 127) << shift;
            if ((value & 128) == 0) return result;
        }
        throw new InvalidDataException("invalid palace varint");
    }
    int ReadInt()
    {
        var value = ReadVar();
        return (int)((value >> 1) ^ (uint)-(int)(value & 1));
    }
    void RequireObject()
    {
        Require(offset < bytes.Length && bytes[offset++] != 0, "null/truncated palace object");
    }
    var shadow = New("ClientPacket.Mode.NKMShadowPalace");
    Set(shadow, "currentPalaceId", ReadInt());
    Set(shadow, "life", ReadInt());
    var palaces = NewList(shadow, "palaceDataList");
    var count = ReadVar();
    for (var index = 0; index < count; index++)
    {
        RequireObject();
        var palace = New("ClientPacket.Mode.NKMPalaceData");
        Set(palace, "palaceId", ReadInt());
        Set(palace, "currentDungeonId", ReadInt());
        var dungeons = NewList(palace, "dungeonDataList");
        var dungeonCount = ReadVar();
        for (var dungeonIndex = 0; dungeonIndex < dungeonCount; dungeonIndex++)
        {
            RequireObject();
            var dungeon = New("ClientPacket.Mode.NKMPalaceDungeonData");
            Set(dungeon, "dungeonId", ReadInt());
            Set(dungeon, "recentTime", ReadInt());
            Set(dungeon, "bestTime", ReadInt());
            dungeons.Add(dungeon);
        }
        palaces.Add(palace);
    }
    Set(shadow, "rewardMultiply", ReadInt());
    Require(offset == bytes.Length, "palace fixture did not consume its full serialized payload");
    return shadow;
}
