using System.Collections;
using System.Globalization;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2 && args.Length != 4)
{
    Console.Error.WriteLine("Usage: GuildCooperativeClientCheck <native Managed directory> <synthetic fixture JSON> [--export-lobby-fixture <output JSON>]");
    return 2;
}
var managed = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(managed, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managed, "Assembly-CSharp.dll"));
const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
using var document = JsonDocument.Parse(File.ReadAllText(args[1]));
var fixture = document.RootElement;
var info = Decode("ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_INFO_ACK", "infoPayloadBase64");
var members = Decode("ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_MEMBER_INFO_ACK", "memberPayloadBase64");
var chat = Decode("ClientPacket.Guild.NKMPacket_GUILD_CHAT_LIST_ACK", "chatPayloadBase64");
Require(Int(Get(info, "errorCode")) == 0 && Int(Get(members, "errorCode")) == 0, "Native INFO and MEMBER ACKs must succeed");
Require(Int(Get(chat, "errorCode")) == 0 && Convert.ToInt64(Get(chat, "guildUid")) == fixture.GetProperty("guildUid").GetInt64(), "Native Chat List ACK must succeed for the synthetic guild");
var seasonRow = fixture.GetProperty("season");
var intervalRow = fixture.GetProperty("interval");
var intervalStart = Date(intervalRow.GetProperty("m_DateStart").GetString()!);
var intervalEnd = Date(intervalRow.GetProperty("m_DateEnd").GetString()!);
if (fixture.TryGetProperty("productionIntervalPayloadBase64", out _))
{
    var productionInterval = Decode("ClientPacket.Common.NKMIntervalData", "productionIntervalPayloadBase64");
    Require((string)Get(productionInterval, "strKey") == seasonRow.GetProperty("m_DateStrID").GetString(), "Production interval must target the selected native guild season");
    intervalStart = (DateTime)Get(productionInterval, "startDate");
    intervalEnd = (DateTime)Get(productionInterval, "endDate");
    Require(intervalStart.Kind == DateTimeKind.Utc && intervalEnd.Kind == DateTimeKind.Utc, "Production interval bytes must retain UTC DateTime kind");
    Require(intervalStart == Date(intervalRow.GetProperty("m_DateStart").GetString()!) && intervalEnd == Date(intervalRow.GetProperty("m_DateEnd").GetString()!), "Native decoded production bytes must agree with the INFO calendar fixture");
    Console.WriteLine("PASS native production lobby interval decoding and complete byte round-trip; native season uses these production dates.");
}
var clock = Date(fixture.GetProperty("serviceTime").GetString()!);
var synchronizedTime = Type("NKC.NKCSynchronizedTime");
Set(synchronizedTime, "s_tsServerTimeDifference", DateTime.SpecifyKind(clock, DateTimeKind.Utc) - DateTime.UtcNow);
Set(synchronizedTime, "s_tsServiceTimeOffset", TimeSpan.Zero);
var serviceClock = (DateTime)Static(Type("Cs.Core.Util.ServiceTime"), "get_Recent")!;
Require(Math.Abs((serviceClock - clock).TotalSeconds) < 5, "Actual native ServiceTime.Recent must use the synthetic synchronized clock");
var season = New("NKM.Guild.GuildSeasonTemplet");
foreach (var (source, target) in new[] { ("m_SeasonID", "SeasonId"), ("m_SeasonDungeonGroup", "SeasonDungeonGroup"), ("m_SeasonRaidGroup", "SeasonRaidGroup") })
    Set(season, target, seasonRow.GetProperty(source).GetInt32());
Set(season, "SeasonDateStrId", seasonRow.GetProperty("m_DateStrID").GetString());
Set(season, "m_OpenTag", "");
Register(season, Int(Get(season, "SeasonId")));
var interval = New("NKM.Templet.NKMIntervalTemplet");
Set(interval, "<Key>k__BackingField", 900001);
Set(interval, "<StrKey>k__BackingField", seasonRow.GetProperty("m_DateStrID").GetString());
Set(interval, "<StartDate>k__BackingField", intervalStart);
Set(interval, "<EndDate>k__BackingField", intervalEnd);
Register(interval, 900001, "StrKey");
var tables = Type("NKM.Guild.GuildDungeonTempletManager");
var schedules = new List<object>();
foreach (var row in fixture.GetProperty("schedules").EnumerateArray())
{
    var schedule = New("NKM.Guild.GuildDungeonScheduleTemplet");
    Set(schedule, "SeasonDungeonGroup", row.GetProperty("m_SeasonDungeonGroup").GetInt32());
    Set(schedule, "SeasonSessionIndex", row.GetProperty("m_SeasonSessionIndex").GetInt32());
    for (var i = 1; i <= 4; i++) Set(schedule, "UseSeasonDungeonId" + i, row.GetProperty("m_UseSeasonDungeonID_" + i).GetInt32());
    schedules.Add(schedule);
}
var group = Int(Get(season, "SeasonDungeonGroup"));
SetListEntry(tables, "dicDungeonScheduleTemplet", group, schedules);
var dungeons = new List<object>();
foreach (var row in fixture.GetProperty("dungeons").EnumerateArray())
{
    var dungeon = New("NKM.Guild.GuildDungeonInfoTemplet");
    foreach (var (source, target) in new[] { ("m_SeasonDungeonGroup", "SeasonDungeonGroup"), ("m_StageArenaIndex", "StageArenaIndex"), ("m_SeasonDungeonID", "SeasonDungeonId") })
        Set(dungeon, target, row.GetProperty(source).GetInt32());
    Set(dungeon, "StageRewardArtifactGroup", row.GetProperty("m_StageRewardArtifactGroup").GetInt32());
    dungeons.Add(dungeon);
}
SetListEntry(tables, "dicDungeonInfoTemplet", group, dungeons);
Call(season, "JoinIntervalTemplet");
Require(ReferenceEquals(Static(season.GetType(), "Find", group), season), "Native GuildSeasonTemplet.Find must resolve the registered fixture");
Require(ReferenceEquals(Static(tables, "GetCurrentSeasonTemplet", clock), season), "Native GetCurrentSeasonTemplet must select the fixture at service time");
Require(ReferenceEquals(Static(tables, "GetCurrentSeasonTemplet", serviceClock), season), "Native season selection must also match actual ServiceTime.Recent");
var nativeSession = Call(season, "GetCurrentSession", clock)!;
var sessionId = Int(Get(nativeSession, "SessionId"));
Require(sessionId == Int(Get(info, "sessionId")), "Node ACK session must match the native time-selected session");
Require(Int(Get(info, "seasonId")) == Int(Get(season, "SeasonId")), "Node ACK season must match native selection");
Require((DateTime)Get(info, "currentSessionEndDate") == (DateTime)Get(nativeSession, "EndDate"), $"ACK session end must match native interval construction: ACK={(DateTime)Get(info, "currentSessionEndDate"):O}, native={(DateTime)Get(nativeSession, "EndDate"):O}");
var nextSession = Call(season, "GetNextSession", sessionId + 1)!;
Require((DateTime)Get(info, "NextSessionStartDate") == (DateTime)Get(nextSession, "StartDate"), $"ACK next-session start must match native interval construction: ACK={(DateTime)Get(info, "NextSessionStartDate"):O}, native={(DateTime)Get(nextSession, "StartDate"):O}, nextId={Get(nextSession, "SessionId")}");
var allSessions = (IList)Get(season, "sessionDatas");
for (var i = 0; i < allSessions.Count; i++)
{
    var session = allSessions[i]!;
    var start = (DateTime)Get(session, "StartDate");
    var end = (DateTime)Get(session, "EndDate");
    Require(end - start == TimeSpan.FromDays(5), "Native active sessions must last five days");
    if (i > 0) Require(start - (DateTime)Get(allSessions[i - 1]!, "EndDate") == TimeSpan.FromDays(2), "Native intermission must last two days");
    Require(Int(Get(Call(season, "GetCurrentSession", end)!, "SessionId")) == i + 1, "Native EndDate boundary must remain in the current session");
    Require(Int(Get(Call(season, "GetCurrentSession", end.AddHours(1))!, "SessionId")) == i + 1, "Native intermission must retain the preceding session");
}
Require(Int(Get(Call(season, "GetCurrentSession", clock.AddYears(5))!, "SessionId")) == allSessions.Count, "Native expired seasons must retain the final session");
var dungeonIds = ((IEnumerable)Call(Get(nativeSession, "templet"), "GetDungeonList")!).Cast<object>().Select(Int).ToHashSet();
var nativePins = dungeons.Where(dungeon => dungeonIds.Contains(Int(Call(dungeon, "GetSeasonDungeonId")))).ToDictionary(dungeon => Int(Call(dungeon, "GetArenaIndex")));
var ackPins = ((IList)Get(info, "arenaList")).Cast<object>().Select(arena => Int(Get(arena, "arenaIndex"))).ToHashSet();
Require(ackPins.SetEquals(nativePins.Keys), "ACK arena indices must match the native background's current-session pins");
Require(nativePins.Count == 4 && nativePins.Keys.All(index => index is >= 1 and <= 12), "Native schedule must expose four static arena indices within the twelve map slots");
var manager = Type("NKC.NKCGuildCoopManager");
Static(manager, "Initialize");
Set(manager, "m_dicGuildDungeonInfoTemplet", BuildDictionary(Get(manager, "m_dicGuildDungeonInfoTemplet").GetType(), nativePins));
Set(manager, "m_lstGuildDungeonArena", Get(info, "arenaList"));
Set(manager, "m_lstGuildDungeonMemberInfo", Get(members, "memberInfoList"));
Set(manager, "m_BossData", Get(info, "bossData"));
Set(manager, "<m_GuildDungeonState>k__BackingField", Get(info, "guildDungeonState"));
Set(manager, "<m_SeasonId>k__BackingField", Int(Get(info, "seasonId")));
Set(manager, "<m_SessionId>k__BackingField", sessionId);
var userUid = fixture.GetProperty("userUid").GetInt64();
Require(((IList)Get(members, "memberInfoList")).Cast<object>().Any(member => Convert.ToInt64(Get(Get(member, "profile"), "userUid")) == userUid), "Native MEMBER ACK must include the synthetic current user");
Require(Int(Get(Get(info, "bossData"), "playCount")) == 5, "Native Boss attack button must see five remaining entries");
Console.WriteLine($"PASS native season/interval/session: {group}, session {sessionId}, {allSessions.Count} sessions with 5+2 day boundaries.");
Console.WriteLine("PASS native decoded ACKs and map data: current-session dungeon template dictionary and four static arena pins agree.");
if (args.Length == 4)
{
    Require(args[2] == "--export-lobby-fixture", "Unknown fixture export mode");
    var productionInterval = Decode("ClientPacket.Common.NKMIntervalData", "productionIntervalPayloadBase64");
    var localLobby = Activator.CreateInstance(Type("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK"))!;
    var officialLobby = Activator.CreateInstance(Type("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK"))!;
    Set(localLobby, "userData", null);
    Set(officialLobby, "userData", null);
    ((IList)Get(localLobby, "intervalData")).Add(productionInterval);
    var oldInterval = New("ClientPacket.Common.NKMIntervalData");
    Set(oldInterval, "key", Int(Get(productionInterval, "key")));
    Set(oldInterval, "strKey", (string)Get(productionInterval, "strKey"));
    Set(oldInterval, "startDate", new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    Set(oldInterval, "endDate", new DateTime(2099, 12, 31, 0, 0, 0, DateTimeKind.Utc));
    ((IList)Get(officialLobby, "intervalData")).Add(oldInterval);
    File.WriteAllText(args[3], JsonSerializer.Serialize(new {
        officialPayloadBase64 = Convert.ToBase64String(Encode(local: officialLobby)),
        localPayloadBase64 = Convert.ToBase64String(Encode(local: localLobby)),
        copyIntervalData = true, replaceIntervalData = false,
        mergeIntervalStrKeys = new[] { (string)Get(productionInterval, "strKey") },
        preserveOfficialContractData = true,
    }, new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine("Synthetic 205 native merge fixture exported with the production guild interval and a conflicting official interval.");
}

// This fixture supplies only the current-user source used by CanStartBoss. It does not boot a Unity scene.
try
{
    var sceneType = Type("NKC.NKCScenManager");
    var scene = RuntimeHelpers.GetUninitializedObject(sceneType);
    var unityObject = sceneType;
    while (unityObject != null && unityObject.GetField("m_CachedPtr", flags) == null) unityObject = unityObject.BaseType;
    Require(unityObject != null, "Unity object wrapper must expose its cached pointer");
    unityObject!.GetField("m_CachedPtr", flags)!.SetValue(scene, new IntPtr(1));
    var user = New("NKM.NKMUserData");
    Set(user, "m_UserUID", userUid);
    Set(scene, "m_MyUserData", user);
    Set(sceneType, "m_ScenManager", scene);
    var constants = New("NKM.Guild.GuildDungeonConstTemplet");
    foreach (var entry in fixture.GetProperty("constants").EnumerateObject()) Set(constants, entry.Name, entry.Value.GetInt32());
    Set(Type("NKM.NKMCommonConst"), "<GuildDungeonConstTemplet>k__BackingField", constants);
    Static(manager, "OnRecv", members);
    Require((bool)Static(manager, "get_m_bGuildCoopMemberDataRecved")!, "Actual native MEMBER handler must mark reception");
    if (fixture.TryGetProperty("unlimitedEntryCounters", out var unlimited) && unlimited.GetBoolean())
    {
        Require(fixture.GetProperty("storedArenaPlays").GetInt32() > Int(Get(constants, "ArenaPlayCountBasic")) && fixture.GetProperty("storedBossPlays").GetInt32() > Int(Get(constants, "BossPlayCountBasic")), "Unlimited fixture must retain real exhausted save histories");
        Require(Int(Static(manager, "get_m_ArenaPlayableCount")) == Int(Get(constants, "ArenaPlayCountBasic")), "Production MEMBER packet must restore full native arena entries even for an exhausted save");
        Require(Int(Get(Get(manager, "m_BossData"), "playCount")) == Int(Get(constants, "BossPlayCountBasic")), "Production INFO packet must restore full native Boss entries even for an exhausted save");
        Console.WriteLine("PASS native unlimited-entry production fields: retained exhausted save history cannot close current-user Arena/Boss entry gates.");
    }
    Require(Int(Static(manager, "CanStartBoss")) == 0, "Native CanStartBoss must accept current member, positive HP and five entries");
    var boss = Get(manager, "m_BossData");
    Set(boss, "playCount", 0);
    Require(Int(Static(manager, "CanStartBoss")) == 20655, "Native CanStartBoss must reject exhausted entries");
    Set(boss, "playCount", 5);
    Set(boss, "playUserUid", 999L);
    Require(Int(Static(manager, "CanStartBoss")) == 20644, "Native CanStartBoss must reject an occupied boss");
    Set(boss, "playUserUid", 0L);
    Console.WriteLine("PASS native CanStartBoss: accepted fixture and rejected exhausted/occupied boss. Synthetic current-user source; no Unity boot.");
    if (fixture.TryGetProperty("artifacts", out var artifacts))
    {
        foreach (var rows in artifacts.EnumerateArray().GroupBy(row => row.GetProperty("m_StageRewardArtifactGroup").GetInt32()))
        {
            var nativeArtifacts = new List<object>();
            foreach (var row in rows)
            {
                var artifact = New("NKM.Guild.GuildDungeonArtifactTemplet");
                Set(artifact, "stageRewardArtifactGroup", rows.Key);
                Set(artifact, "artifactId", row.GetProperty("m_ArtifactID").GetInt32());
                Set(artifact, "artifactOrder", row.GetProperty("m_ArtifactOrder").GetInt32());
                Set(artifact, "refBattleConditionId", row.GetProperty("m_RefBattleConditionID").GetInt32());
                nativeArtifacts.Add(artifact);
            }
            Require(nativeArtifacts.Select(artifact => Int(Call(artifact, "GetOrder"))).SequenceEqual(Enumerable.Range(1, nativeArtifacts.Count)), "Fixture artifact group must retain the native table's ascending order");
            SetListEntry(tables, "dicDungeonArtifactTemplet", rows.Key, nativeArtifacts);
        }
        var arenaId = nativePins.Keys.First();
        Require(Int(Static(manager, "CanStartArena", arenaId)) == 0, "Native arena button must accept the initial fixture");
        var currentMember = ((IList)Get(members, "memberInfoList")).Cast<object>().Single(member => Convert.ToInt64(Get(Get(member, "profile"), "userUid")) == userUid);
        var history = (IList)Get(currentMember, "arenaList");
        for (var grade = 0; grade <= 3; grade++)
        {
            var result = New("ClientPacket.Guild.GuildDungeonMemberArena");
            Set(result, "arenaId", arenaId);
            Set(result, "grade", grade);
            Set(result, "regDate", DateTime.SpecifyKind(clock, DateTimeKind.Utc));
            history.Add(result);
            Static(manager, "OnRecv", members);
            Require(Int(Static(manager, "get_m_ArenaPlayableCount")) == Int(Get(constants, "ArenaPlayCountBasic")) - history.Count, "Actual native MEMBER handler must count all historical grades");
            Require(Int(Static(manager, "CanStartArena", arenaId)) == 0, "Native arena button must allow repeat-sector history while entries remain");
        }
        var globalArena = ((IList)Get(info, "arenaList")).Cast<object>().Single(arena => Int(Get(arena, "arenaIndex")) == arenaId);
        var artifactDictionary = (IDictionary)Static(manager, "GetAllArtifactDictionary")!;
        var allArenaArtifacts = (IList)artifactDictionary[arenaId]!;
        var threshold = Int(Get(constants, "ArtifactFulificationCount"));
        for (var unlockedCount = 1; unlockedCount <= Math.Min(2, allArenaArtifacts.Count); unlockedCount++)
        {
            Set(globalArena, "totalMedalCount", threshold * unlockedCount);
            var mine = (IDictionary)Static(manager, "GetMyArtifactDictionary")!;
            var unlocked = (IList)mine[arenaId]!;
            Require(unlocked.Count == unlockedCount, "Native unlocked artifact count must follow global total medals");
            for (var i = 0; i < unlocked.Count; i++)
            {
                Require(ReferenceEquals(unlocked[i], allArenaArtifacts[i]), "Native unlocked artifact list must use the group's prefix");
                Require(Int(Call(unlocked[i]!, "get_RefBattleConditionId")) > 0, "Selected native artifact must expose its real battle-condition ID");
            }
        }
        Set(globalArena, "totalMedalCount", ((IList)artifactDictionary[arenaId]!).Count * Int(Get(constants, "ArtifactFulificationCount")));
        Require(Int(Static(manager, "CanStartArena", arenaId)) == 20646, "Native arena button must reject a completed global artifact sector");
        Set(globalArena, "totalMedalCount", 0);
        Set(manager, "<m_ArenaPlayableCount>k__BackingField", 0);
        Set(manager, "m_ArenaTicketBuyCount", Int(Get(constants, "ArenaTicketBuyCount")));
        Require(Int(Static(manager, "CanStartArena", arenaId)) == 20645, "Native arena button must reject exhaustion after the purchase limit");
        if (fixture.TryGetProperty("unlimitedEntryCounters", out var repeatUnlimited) && repeatUnlimited.GetBoolean())
        {
            var refreshedInfo = Decode("ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_INFO_ACK", "infoPayloadBase64");
            var refreshedMembers = Decode("ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_MEMBER_INFO_ACK", "memberPayloadBase64");
            Set(manager, "m_ArenaTicketBuyCount", Int(Get(refreshedInfo, "arenaTicketBuyCount")));
            Static(manager, "OnRecv", refreshedMembers);
            Require(Int(Static(manager, "get_m_ArenaPlayableCount")) == Int(Get(constants, "ArenaPlayCountBasic")), "Production result/relogin MEMBER refresh must reopen the native exhausted arena gate at its fixed full count");
            Require(Int(Static(manager, "CanStartArena", arenaId)) == 0, "Refreshed unlimited arena count must permit another fight");
            Set(Get(manager, "m_BossData"), "playCount", 0);
            Require(Int(Static(manager, "CanStartBoss")) == 20655, "Synthetic exhausted Boss counter must close the native gate");
            Set(manager, "m_BossData", Get(refreshedInfo, "bossData"));
            Require(Int(Static(manager, "CanStartBoss")) == 0, "Production result/relogin INFO refresh must reopen the native exhausted Boss gate");
            Console.WriteLine("PASS native unlimited-entry refresh: exhausted CanStartArena/CanStartBoss gates reopen from production MEMBER/INFO payloads.");
        }
        Console.WriteLine("PASS native MEMBER handler and CanStartArena: grades 0..3 consume entries; repeat sector remains playable; completed/exhausted sectors are rejected.");
        Console.WriteLine("PASS native GetMyArtifactDictionary: global medal thresholds select the artifact-list prefix with real battle-condition IDs. Boss effect application remains a separate integration check.");
    }
    else throw new InvalidOperationException("Fixture artifacts are required for actual native CanStartArena validation");
}
catch (Exception exception)
{
    Console.Error.WriteLine("Native entry validation failed: " + Root(exception).GetType().Name + ": " + Root(exception).Message);
    return 3;
}
var lobby = RuntimeHelpers.GetUninitializedObject(Type("NKC.NKC_SCEN_GUILD_LOBBY"));
Call(lobby, "SetChatDataRecved", false);
Call(lobby, "SetCoopDataRecved", false);
Require(!(bool)Get(lobby, "m_bChatDataRecved") && !(bool)Get(lobby, "m_bCoopDataRecved"), "Native lobby receive gates must start closed");
Call(lobby, "SetChatDataRecved", true);
Require((bool)Get(lobby, "m_bChatDataRecved") && !(bool)Get(lobby, "m_bCoopDataRecved"), "Chat gate must not imply INFO reception");
Call(lobby, "SetCoopDataRecved", true);
Require((bool)Get(lobby, "m_bChatDataRecved") && (bool)Get(lobby, "m_bCoopDataRecved"), "Native lobby gates must retain independent reception state");
Console.WriteLine("PASS native lobby gate setters. LIMITATION: scene transition, UI callbacks, wait timer and packet-handler dispatch require Android/Unity validation.");
return 0;

Type Type(string name) => client.GetType(name, true)!;
object New(string name) => Activator.CreateInstance(Type(name))!;
int Int(object? value) => Convert.ToInt32(value, CultureInfo.InvariantCulture);
DateTime Date(string value) => DateTime.SpecifyKind(DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal), DateTimeKind.Unspecified);
object Get(object target, string name) => (target is Type type ? type : target.GetType()).GetField(name, flags)!.GetValue(target is Type ? null : target)!;
void Set(object target, string name, object? value) => (target is Type type ? type : target.GetType()).GetField(name, flags)!.SetValue(target is Type ? null : target, value);
object? Call(object target, string name, params object?[] values) => Invoke(target.GetType(), target, name, values);
object? Static(Type type, string name, params object?[] values) => Invoke(type, null, name, values);
object? Invoke(Type type, object? target, string name, object?[] values)
{
    var method = type.GetMethods(flags).Single(candidate => candidate.Name == name && candidate.GetParameters().Length == values.Length && candidate.GetParameters().Select((parameter, i) => values[i] == null || parameter.ParameterType.IsInstanceOfType(values[i])).All(match => match));
    return method.Invoke(target, values);
}
void Register(object templet, int key, string? stringKey = null)
{
    var container = Type("NKM.Templet.Base.NKMTempletContainer`1").MakeGenericType(templet.GetType());
    if (stringKey == null) { Static(container, "SetForTest", key, templet); return; }
    var parameter = Expression.Parameter(templet.GetType(), "templet");
    var selector = Expression.Lambda(typeof(Func<,>).MakeGenericType(templet.GetType(), typeof(string)), Expression.Property(parameter, stringKey), parameter).Compile();
    Static(container, "Add", templet, selector);
}
void SetListEntry(Type owner, string field, int key, List<object> values)
{
    var dictionary = (IDictionary)Get(owner, field);
    var listType = dictionary.GetType().GetGenericArguments()[1];
    var list = (IList)Activator.CreateInstance(listType)!;
    foreach (var value in values) list.Add(value);
    dictionary[key] = list;
}
object BuildDictionary(Type type, Dictionary<int, object> values)
{
    var result = (IDictionary)Activator.CreateInstance(type)!;
    foreach (var entry in values) result.Add(entry.Key, entry.Value);
    return result;
}
object Decode(string name, string field)
{
    var bytes = Convert.FromBase64String(fixture.GetProperty(field).GetString()!);
    var packet = New(name);
    var reader = Activator.CreateInstance(Type("Cs.Protocol.PacketReader"), [bytes])!;
    try { Call(reader, "GetWithoutNullBit", packet); }
    finally { (reader as IDisposable)?.Dispose(); }
    var buffer = Static(Type("Cs.Protocol.PacketWriter"), "ToBufferWithoutNullBit", packet)!;
    var output = new List<byte>();
    foreach (var segment in (IEnumerable)Call(buffer, "GetView")!)
    {
        var segmentType = segment!.GetType();
        output.AddRange(((byte[])segmentType.GetProperty("Data")!.GetValue(segment)!).Take(Int(segmentType.GetProperty("Offset")!.GetValue(segment))));
    }
    Require(output.SequenceEqual(bytes), name + " must round-trip every native protocol byte");
    return packet;
}
byte[] Encode(object local)
{
    var buffer = Static(Type("Cs.Protocol.PacketWriter"), "ToBufferWithoutNullBit", local)!;
    var output = new List<byte>();
    foreach (var segment in (IEnumerable)Call(buffer, "GetView")!)
    {
        var type = segment.GetType();
        var data = (byte[])type.GetProperty("Data")!.GetValue(segment)!;
        var count = Int(type.GetProperty("Offset")!.GetValue(segment));
        output.AddRange(data.Take(count));
    }
    return output.ToArray();
}
Exception Root(Exception exception) => exception.InnerException == null ? exception : Root(exception.InnerException);
void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
