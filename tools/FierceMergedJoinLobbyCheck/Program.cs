using System.Collections;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using RevivalSide.CombatHost;

if (args.Length != 2) throw new ArgumentException("Usage: FierceMergedJoinLobbyCheck <original Managed directory> <captured205 + production local intervals + 19 choice fixture>");
var managed = Path.GetFullPath(args[0]);
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
AssemblyLoadContext.Default.Resolving += (context, name) => { var file = Path.Combine(managed, name.Name + ".dll"); return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null; };
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managed, "Assembly-CSharp.dll"));
using var document = JsonDocument.Parse(File.ReadAllText(args[1]));
var fixture = document.RootElement;
var captured = Convert.FromBase64String(fixture.GetProperty("officialPayloadBase64").GetString()!);
var now = DateTime.Parse(fixture.GetProperty("serviceTime").GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind);
var bridge = typeof(HostOptions).Assembly.GetType("RevivalSide.CombatHost.ManagedCombatBridge", true)!;
var runtime = RuntimeHelpers.GetUninitializedObject(bridge.GetNestedType("ManagedRuntime", BindingFlags.NonPublic)!);
var intervalType = Type("NKM.Templet.NKMIntervalTemplet");
var seasonType = Type("NKM.Templet.NKMFierceTemplet");
var managerType = Type("NKC.NKCFierceBattleSupportDataMgr");
var sync = Type("NKC.NKCSynchronizedTime");
sync.GetField("s_tsServerTimeDifference", flags)!.SetValue(null, now - DateTime.UtcNow);
sync.GetField("s_tsServiceTimeOffset", flags)!.SetValue(null, TimeSpan.Zero);
var sceneType = Type("NKC.NKCScenManager");
var scene = RuntimeHelpers.GetUninitializedObject(sceneType);
for (var type = sceneType; type != null; type = type.BaseType) { var pointer = type.GetField("m_CachedPtr", flags); if (pointer != null) { pointer.SetValue(scene, new IntPtr(1)); break; } }
// Supply a synthetic unlocked current-user source. The native manager, interval
// joins, date checks and status logic remain unchanged; this does not boot Unity.
var user = New(Type("NKM.NKMUserData"));
Set(scene, "m_MyUserData", user); Set(sceneType, "m_ScenManager", scene);
var initialId = fixture.GetProperty("initialSeasonId").GetInt32();
var seasons = fixture.GetProperty("seasons").EnumerateArray().ToArray();
var allFierceKeys = seasons.SelectMany(row => new[] { row.GetProperty("m_GameDateStrID").GetString()!, row.GetProperty("m_RewardDateStrID").GetString()! }).ToHashSet();
var initial = seasons.Single(row => row.GetProperty("FierceID").GetInt32() == initialId);
var initialKeys = new[] { initial.GetProperty("m_GameDateStrID").GetString()!, initial.GetProperty("m_RewardDateStrID").GetString()! }.ToHashSet();
var bossType = Type("NKM.Templet.NKMFierceBossGroupTemplet");
var groupField = bossType.GetField("GroupData", flags)!;
var groups = (IDictionary)(groupField.GetValue(null) ?? Activator.CreateInstance(groupField.FieldType)!);
groupField.SetValue(null, groups);
foreach (var row in fixture.GetProperty("bosses").EnumerateArray()) {
  var boss = RuntimeHelpers.GetUninitializedObject(bossType);
  foreach (var name in new[] { "FierceBossID", "FierceBossGroupID", "Level", "DungeonID" }) Set(boss, name, row.GetProperty(name).GetInt32());
  RegisterInt(bossType, row.GetProperty("FierceBossID").GetInt32(), boss);
  var groupId = row.GetProperty("FierceBossGroupID").GetInt32();
  if (!groups.Contains(groupId)) groups[groupId] = Activator.CreateInstance(typeof(List<>).MakeGenericType(bossType));
  ((IList)groups[groupId]!).Add(boss);
}
var statusCounts = new List<int>();
foreach (var includeSelectableDates in new[] { false, true }) {
  var official = Decode("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK", captured);
  var local = New(Type("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK"));
  var localIntervals = (IList)Get(local, "intervalData");
  foreach (var row in fixture.GetProperty("intervals").EnumerateArray()) {
    var interval = Decode("ClientPacket.Common.NKMIntervalData", Convert.FromBase64String(row.GetProperty("payloadBase64").GetString()!));
    if (row.GetProperty("suppressed").GetBoolean()) { Set(interval, "startDate", new DateTime(1999, 1, 1, 0, 0, 0, DateTimeKind.Utc)); Set(interval, "endDate", new DateTime(1999, 1, 2, 0, 0, 0, DateTimeKind.Utc)); }
    localIntervals.Add(interval);
  }
  var mergeKeys = localIntervals.Cast<object>().Select(row => (string)Get(row, "strKey")).Where(key => includeSelectableDates || !allFierceKeys.Contains(key) || initialKeys.Contains(key)).ToArray();
  bridge.GetMethod("MergeIntervalData", flags)!.Invoke(null, [runtime, local, official, mergeKeys]);
  bridge.GetMethod("EnsureUniqueIntervalKeys", flags)!.Invoke(null, [runtime, official]);
  var bytes = Encode(official); var final = Decode("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK", bytes);
  Require(Encode(final).SequenceEqual(bytes), "Final merged205 must consume and round-trip all bytes");
  var finalIntervals = ((IList)Get(final, "intervalData")).Cast<object>().ToArray();
  Require(finalIntervals.Select(row => Convert.ToInt32(Get(row, "key"))).Distinct().Count() == finalIntervals.Length, "Merged interval integer keys must remain unique");
  ClearContainer(intervalType);
  foreach (var row in ((IList)Get(final, "intervalData")).Cast<object>()) {
    var templet = New(intervalType);
    foreach (var name in new[] { "key", "strKey", "startDate", "endDate", "repeatStartDate", "repeatEndDate" }) Set(templet, "<" + char.ToUpperInvariant(name[0]) + name[1..] + ">k__BackingField", Get(row, name));
    RegisterString(templet, "StrKey");
  }
  ClearContainer(seasonType);
  foreach (var row in seasons) {
    var season = New(seasonType);
    Set(season, "FierceID", row.GetProperty("FierceID").GetInt32());
    Set(season, "m_OpenTag", row.GetProperty("m_OpenTag").GetString());
    Set(season, "gameIntervalId", row.GetProperty("m_GameDateStrID").GetString());
    Set(season, "rewardIntervalId", row.GetProperty("m_RewardDateStrID").GetString());
    Set(season, "FierceBossGroupIdList", row.EnumerateObject().Where(property => property.Name.StartsWith("FierceBossGroupID_")).Select(property => property.Value.GetInt32()).ToList());
    RegisterInt(seasonType, row.GetProperty("FierceID").GetInt32(), season);
    Type("NKM.NKMOpenTagManager").GetMethod("TryAddTag", flags)!.Invoke(null, [row.GetProperty("m_OpenTag").GetString()!]);
    seasonType.GetMethod("JoinIntervalTemplet", flags)!.Invoke(season, null);
  }
  var manager = Activator.CreateInstance(managerType)!;
  var accessible = 0;
  foreach (var row in fixture.GetProperty("fixtures").EnumerateArray()) {
    var id = row.GetProperty("seasonId").GetInt32();
    managerType.GetMethod("Init", flags)!.Invoke(manager, [id]);
    var data = Decode("ClientPacket.Game.NKMPacket_FIERCE_DATA_ACK", Convert.FromBase64String(row.GetProperty("dataPayload").GetString()!));
    managerType.GetMethod("UpdateFierceData", flags, null, [data.GetType()], null)!.Invoke(manager, [data]);
    var selectedBoss = row.GetProperty("bosses")[1];
    managerType.GetMethod("SetCurBossID", flags)!.Invoke(manager, [selectedBoss.GetProperty("FierceBossID").GetInt32()]);
    Require(Convert.ToInt32(managerType.GetMethod("GetTargetDungeonID", flags)!.Invoke(manager, null)) == selectedBoss.GetProperty("DungeonID").GetInt32(), "Hot switched manager must resolve the new Boss difficulty to its real dungeon");
    var status = Convert.ToInt32(managerType.GetMethod("GetStatus", flags)!.Invoke(manager, null));
    var canAccess = (bool)managerType.GetMethod("IsCanAccessFierce", flags)!.Invoke(manager, null)!;
    if (canAccess) accessible++;
    var active = managerType.GetProperty("FierceTemplet", flags)!.GetValue(manager)!;
    Console.WriteLine($"mergeAllSelectableDates={includeSelectableDates}: season={id}, nativeStatus={status}, access={canAccess}, start={seasonType.GetProperty("FierceGameStart", flags)!.GetValue(active)}, end={seasonType.GetProperty("FierceGameEnd", flags)!.GetValue(active)}");
    if (includeSelectableDates) Require(status == 3 && canAccess, $"Selected native season {id} is not in playable time after final merged205");
  }
  statusCounts.Add(accessible);
}
Require(statusCounts[0] < seasons.Length, "Old merge policy must reproduce inaccessible switched seasons");
Require(statusCounts[1] == seasons.Length, "Corrected merge policy must permit all selectable seasons on the same native manager");
Console.WriteLine($"PASS final captured205 + production interval merge + same untouched native manager Init/845/GetStatus/IsCanAccessFierce: before={statusCounts[0]}, after={statusCounts[1]} of {seasons.Length}.");

Type Type(string name) => client.GetType(name, true)!;
object New(Type type) => Activator.CreateInstance(type)!;
object Get(object target, string name) => target.GetType().GetField(name, flags)!.GetValue(target)!;
void Set(object target, string name, object? value) => (target is Type type ? type : target.GetType()).GetField(name, flags)!.SetValue(target is Type ? null : target, value);
void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
Type Container(Type type) => Type("NKM.Templet.Base.NKMTempletContainer`1").MakeGenericType(type);
void ClearContainer(Type type) { foreach (var field in Container(type).GetFields(flags).Where(field => field.IsStatic && typeof(IDictionary).IsAssignableFrom(field.FieldType))) if (field.GetValue(null) is IDictionary dictionary) dictionary.Clear(); }
void RegisterString(object templet, string key) { var p = Expression.Parameter(templet.GetType(), "templet"); var selector = Expression.Lambda(typeof(Func<,>).MakeGenericType(templet.GetType(), typeof(string)), Expression.Property(p, key), p).Compile(); Container(templet.GetType()).GetMethods(flags).Single(method => method.Name == "Add" && method.GetParameters().Length == 2).Invoke(null, [templet, selector]); }
void RegisterInt(Type type, int id, object row) { var dictionary = (IDictionary)Container(type).GetField("data", flags)!.GetValue(null)!; dictionary[id] = row; }
object Decode(string name, byte[] bytes) { var packet = New(Type(name)); var readerType = Type("Cs.Protocol.PacketReader"); var reader = Activator.CreateInstance(readerType, [bytes])!; try { readerType.GetMethod("GetWithoutNullBit", flags, null, [Type("Cs.Protocol.ISerializable")], null)!.Invoke(reader, [packet]); return packet; } finally { (reader as IDisposable)?.Dispose(); } }
byte[] Encode(object packet) { var buffer = Type("Cs.Protocol.PacketWriter").GetMethod("ToBufferWithoutNullBit", flags, null, [Type("Cs.Protocol.ISerializable")], null)!.Invoke(null, [packet])!; var bytes = new byte[Convert.ToInt32(buffer.GetType().GetMethod("CalcTotalSize", flags)!.Invoke(buffer, null))]; var offset = 0; foreach (var part in (IEnumerable)buffer.GetType().GetMethod("GetView", flags)!.Invoke(buffer, null)!) { var type = part.GetType(); var data = (byte[])type.GetProperty("Data")!.GetValue(part)!; var size = Convert.ToInt32(type.GetProperty("Offset")!.GetValue(part)); Buffer.BlockCopy(data, 0, bytes, offset, size); offset += size; } return bytes; }
