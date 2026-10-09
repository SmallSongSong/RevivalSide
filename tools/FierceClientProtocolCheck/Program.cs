using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length is < 2 or > 3) throw new ArgumentException("Usage: FierceClientProtocolCheck <original client Managed directory> <synthetic entry fixture JSON> [synthetic result fixture JSON]");
var managedDir = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(managedDir, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managedDir, "Assembly-CSharp.dll"));
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
using var document = JsonDocument.Parse(File.ReadAllText(args[1]));
var seasonType = client.GetType("NKM.Templet.NKMFierceTemplet", true)!;
var bossType = client.GetType("NKM.Templet.NKMFierceBossGroupTemplet", true)!;
var openTags = client.GetType("NKM.NKMOpenTagManager", true)!;
var groupField = bossType.GetField("GroupData", flags)!;
var groups = (IDictionary)(groupField.GetValue(null) ?? Activator.CreateInstance(groupField.FieldType)!);
groupField.SetValue(null, groups);
var checks = 0;
foreach (var row in document.RootElement.GetProperty("bosses").EnumerateArray())
{
    var boss = New(bossType);
    foreach (var name in new[] { "FierceBossID", "FierceBossGroupID", "Level", "DungeonID" }) Set(boss, name, row.GetProperty(name).GetInt32());
    Register(bossType, row.GetProperty("FierceBossID").GetInt32(), boss);
    var groupId = row.GetProperty("FierceBossGroupID").GetInt32();
    if (!groups.Contains(groupId)) groups[groupId] = Activator.CreateInstance(typeof(List<>).MakeGenericType(bossType));
    ((IList)groups[groupId]!).Add(boss);
}
foreach (var row in document.RootElement.GetProperty("seasons").EnumerateArray())
{
    var season = New(seasonType);
    Set(season, "FierceID", row.GetProperty("FierceID").GetInt32());
    Set(season, "m_OpenTag", row.GetProperty("m_OpenTag").GetString()!);
    var groupList = new List<int>();
    foreach (var property in row.EnumerateObject().Where(entry => entry.Name.StartsWith("FierceBossGroupID_"))) groupList.Add(property.Value.GetInt32());
    Set(season, "FierceBossGroupIdList", groupList);
    Register(seasonType, row.GetProperty("FierceID").GetInt32(), season);
    foreach (var groupId in groupList) Require(groups.Contains(groupId), $"Native season {row.GetProperty("FierceID")} cannot resolve group {groupId}");
    checks++;
}
foreach (var fixture in document.RootElement.GetProperty("fixtures").EnumerateArray())
{
    var seasonId = fixture.GetProperty("seasonId").GetInt32();
    openTags.GetMethod("TryAddTag", flags)!.Invoke(null, new object[] { fixture.GetProperty("openTag").GetString()! });
    var season = seasonType.GetMethod("Find", flags, null, new[] { typeof(int) }, null)!.Invoke(null, new object[] { seasonId })!;
    Require(season != null && (bool)seasonType.GetProperty("EnableByTag", flags)!.GetValue(season)!, $"Native season {seasonId} is not enabled");
    var packet = Read("ClientPacket.Game.NKMPacket_FIERCE_DATA_ACK", fixture.GetProperty("dataPayload").GetString()!);
    var bosses = (IList)Get(packet, "bossList");
    var expected = fixture.GetProperty("bosses").EnumerateArray().ToArray();
    Require(bosses.Count == expected.Length, "845 boss count differs from source fixture");
    for (var index = 0; index < bosses.Count; index++)
    {
        var id = (int)Get(bosses[index]!, "bossId");
        Require(id == expected[index].GetProperty("FierceBossID").GetInt32(), "845 native boss ID mismatch");
        var boss = bossType.GetMethod("Find", flags, null, new[] { typeof(int) }, null)!.Invoke(null, new object[] { id });
        Require(boss != null && (int)Get(boss, "DungeonID") == expected[index].GetProperty("DungeonID").GetInt32(), $"Native boss {id} has wrong dungeon");
        checks++;
    }
    var ranking = Read("ClientPacket.LeaderBoard.NKMPacket_LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK", fixture.GetProperty("rankPayload").GetString()!);
    Require((int)Get(ranking, "fierceId") == seasonId, "3207 native season differs from 854");
    Require((int)Get(ranking, "fierceBossGroupId") == fixture.GetProperty("groupId").GetInt32(), "3207 native group differs from selected season");
    var ranks = (IList)Get(Get(ranking, "leaderBoardfierceData"), "fierceData");
    Require(ranks.Count == 1 && (string)Get(Get(ranks[0]!, "commonProfile"), "nickname") == "Fierce fixture", "3207 native leaderboard/profile deserialization failed");
    var managerType = client.GetType("NKC.NKCFierceBattleSupportDataMgr", true)!;
    var manager = Activator.CreateInstance(managerType)!;
    managerType.GetMethod("Init", flags)!.Invoke(manager, new object[] { seasonId });
    var selectedBoss = expected[1].GetProperty("FierceBossID").GetInt32();
    managerType.GetMethod("SetCurBossID", flags)!.Invoke(manager, new object[] { selectedBoss });
    managerType.GetMethod("UpdateFierceData", flags, null, new[] { packet.GetType() }, null)!.Invoke(manager, new[] { packet });
    managerType.GetMethod("UpdateFierceData", flags, null, new[] { ranking.GetType() }, null)!.Invoke(manager, new[] { ranking });
    Require((int)managerType.GetProperty("CurBossID", flags)!.GetValue(manager)! == selectedBoss, "845/3207 refresh reset the player's selected boss difficulty");
    Require((int)managerType.GetMethod("GetTargetDungeonID", flags)!.Invoke(manager, null)! == expected[1].GetProperty("DungeonID").GetInt32(), "Native challenge resolves the wrong selected dungeon");
    checks++;
    Console.WriteLine($"{fixture.GetProperty("date")}: native season {seasonId}, {bosses.Count} bosses and 3207 profile passed.");
}
if (args.Length == 3)
{
    using var resultDocument = JsonDocument.Parse(File.ReadAllText(args[2]));
    var fixture = resultDocument.RootElement;
    var expectedDeck = fixture.GetProperty("expectedDeck");
    var eventDeck = Read("NKM.NKMEventDeckData", fixture.GetProperty("eventDeck").GetString()!);
    AssertEventDeck(eventDeck);
    var boss = Read("ClientPacket.Common.NKMFierceBoss", fixture.GetProperty("bossPayload").GetString()!);
    Require((int)Get(boss, "bossId") == fixture.GetProperty("bossId").GetInt32(), "native persisted boss identity mismatch");
    AssertEventDeck(Get(boss, "deckData"));
    var result = Read("ClientPacket.Game.NKMFierceResultData", fixture.GetProperty("resultPayload").GetString()!);
    AssertEventDeck(Get(result, "bestDeck"));
    var profile = Read("ClientPacket.Common.NKMFierceProfileData", fixture.GetProperty("profilePayload").GetString()!);
    Require((int)Get(profile, "totalPoint") == 1500, "native profile lost the highest score");
    var penalties = (IList)Get(profile, "penaltyIds");
    Require(penalties.Count == 1 && (int)penalties[0]! == 1, "native profile shows the next battle's penalties instead of the best record");
    var profileDeck = Get(profile, "profileDeck");
    var units = (Array)Get(profileDeck, "List");
    Require(units.Length == 8 && units.GetValue(1) == null, "profile lineup invented a unit in the empty slot");
    Require(Convert.ToInt32(Get(profileDeck, "LeaderIndex")) == expectedDeck.GetProperty("leaderIndex").GetInt32(), "native profile leader differs from the saved lineup");
    foreach (var expected in expectedDeck.GetProperty("units").EnumerateArray())
    {
        var unit = units.GetValue(expected.GetProperty("slotIndex").GetInt32())!;
        Require((int)Get(unit, "UnitId") == expected.GetProperty("unitId").GetInt32(), "native profile unit moved to another slot");
        Require((int)Get(unit, "UnitLevel") == expected.GetProperty("level").GetInt32(), "native profile lost saved unit level");
        Require((int)Get(unit, "TacticLevel") == expected.GetProperty("tacticLevel").GetInt32(), "native profile lost tactical level");
    }
    Require((int)Get(Get(profileDeck, "Ship"), "UnitId") == expectedDeck.GetProperty("shipUnitId").GetInt32(), "native profile lost saved ship");
    Require((int)Get(Get(profileDeck, "operatorUnit"), "UnitId") == expectedDeck.GetProperty("operatorId").GetInt32(), "native profile lost saved operator");
    checks += 9;
    Console.WriteLine("Native Boss.deckData, Result.bestDeck and Profile.profileDeck passed with real units, empty slots, leader, ship and operator.");

    void AssertEventDeck(object deck)
    {
        Require((long)Get(deck, "m_ShipUID") == long.Parse(expectedDeck.GetProperty("shipUid").GetString()!), "native best lineup lost ship UID");
        Require((long)Get(deck, "m_OperatorUID") == long.Parse(expectedDeck.GetProperty("operatorUid").GetString()!), "native best lineup lost operator UID");
        Require((int)Get(deck, "m_LeaderIndex") == expectedDeck.GetProperty("leaderIndex").GetInt32(), "native best lineup lost leader slot");
        var units = (IDictionary)Get(deck, "m_dicUnit");
        Require(units.Count == expectedDeck.GetProperty("units").GetArrayLength(), "native best lineup contains extra units");
        foreach (var expected in expectedDeck.GetProperty("units").EnumerateArray())
            Require((long)units[expected.GetProperty("slotIndex").GetInt32()]! == long.Parse(expected.GetProperty("unitUid").GetString()!), "native best lineup has wrong slot UID");
    }
}
Console.WriteLine($"Fierce native client checks passed: {checks}.");

object New(Type type) => RuntimeHelpers.GetUninitializedObject(type);
void Set(object target, string field, object value) => target.GetType().GetField(field, flags)!.SetValue(target, value);
object Get(object target, string field) => target.GetType().GetField(field, flags)!.GetValue(target)!;
void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
void Register(Type type, int id, object row)
{
    var container = client.GetType("NKM.Templet.Base.NKMTempletContainer`1", true)!.MakeGenericType(type);
    ((IDictionary)container.GetField("data", flags)!.GetValue(null)!)[id] = row;
}
object Read(string typeName, string payload)
{
    var packet = Activator.CreateInstance(client.GetType(typeName, true)!)!;
    var readerType = client.GetType("Cs.Protocol.PacketReader", true)!;
    var reader = Activator.CreateInstance(readerType, new object[] { Convert.FromBase64String(payload) })!;
    try
    {
        readerType.GetMethod("GetWithoutNullBit", flags, null, new[] { client.GetType("Cs.Protocol.ISerializable", true)! }, null)!.Invoke(reader, new[] { packet });
        return packet;
    }
    finally { (reader as IDisposable)?.Dispose(); }
}
