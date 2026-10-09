using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using RevivalSide.CombatHost;

if (args.Length != 2 && args.Length != 4)
{
    Console.Error.WriteLine("Usage: GuildClientProtocolCheck <client Managed directory> <synthetic guild fixture JSON> [--export-lobby-fixture <output JSON> | --check-merged <host response JSON>]");
    return 2;
}

var managedDir = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(managedDir, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managedDir, "Assembly-CSharp.dll"));
var serializableType = client.GetType("Cs.Protocol.ISerializable", throwOnError: true)!;
var readerType = client.GetType("Cs.Protocol.PacketReader", throwOnError: true)!;
var readerGet = readerType.GetMethod("GetWithoutNullBit", flags, null, [serializableType], null)!;
var writerType = client.GetType("Cs.Protocol.PacketWriter", throwOnError: true)!;
var writerPut = writerType.GetMethod("ToBufferWithoutNullBit", flags, null, [serializableType], null)!;

using var fixture = JsonDocument.Parse(File.ReadAllText(args[1]));
var expected = fixture.RootElement;
if (expected.TryGetProperty("nameValidation", out var names))
{
    var nativeNameLength = client.GetType("NKM.NKM_USER_COMMON", throwOnError: true)!.GetMethod("GetNickNameLength", flags)!;
    var nativeGlobalChar = client.GetType("NKC.StringValidSet", throwOnError: true)!.GetMethod("ValidGlobal", flags)!;
    foreach (var sample in names.EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!;
        var length = Convert.ToInt32(nativeNameLength.Invoke(null, [name]));
        var valid = length is >= 2 and <= 16 && name.All(character => !char.IsWhiteSpace(character) && (bool)nativeGlobalChar.Invoke(null, [character])!);
        Require(length == sample.GetProperty("weightedLength").GetInt32(), "Node guild-name length must match the native weighted length");
        Require(valid == sample.GetProperty("valid").GetBoolean(), "Node guild-name character rules must match the native Global character set");
    }
    Console.WriteLine("Guild name rules: native weighted length and Global character validation match the Node checks.");
}
var createPayload = Convert.FromBase64String(expected.GetProperty("createPayloadBase64").GetString()!);
var createAck = Decode(3401, createPayload);
Require(Convert.ToInt32(Get(createAck, "errorCode")) == 0, "native CREATE_ACK error code must be success");
var costs = (IList)Get(createAck, "costItemDataList");
Require(costs.Count == 1, "native CREATE_ACK must contain one real cost item");
var cost = costs[0]!;
Require(Convert.ToInt32(Get(cost, "m_ItemMiscID")) == 101, "native cost ID must be quartz");
Require(Convert.ToInt64(Get(cost, "m_CountFree")) == 500L, "native cost balance must reflect the 1000 quartz debit");
Require(Convert.ToInt64(Get(cost, "m_CountPaid")) == 0L, "native paid balance must retain its correct position");
Require(Convert.ToInt32(Get(cost, "BonusRatio")) == 0, "native bonus ratio must decode after the 64-bit counts");
Require(((DateTime)Get(cost, "m_RegDate")).Kind == DateTimeKind.Utc, "native cost DateTime must retain UTC kind");
Require((DateTime)Get(cost, "m_RegDate") == new DateTime(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc), "native item DateTime must decode with its original UTC kind");
var createdGuild = Get(createAck, "guildData");
var createdPrivate = Get(createAck, "privateGuildData");
var createdUid = Convert.ToInt64(Get(createdGuild, "guildUid"));
Require(createdUid == expected.GetProperty("guildUid").GetInt64(), "native guild UID must match the committed local state");
Require(Convert.ToInt64(Get(createdPrivate, "guildUid")) == createdUid, "native CREATE_ACK private membership must match the created guild");
Require(Convert.ToInt64(Get(createdGuild, "badgeId")) == 8005011002L, "native guild badge must retain all 64-bit data");
var members = (IList)Get(createdGuild, "members");
Require(members.Count == 1 && Convert.ToInt32(Get(members[0]!, "grade")) == 0, "native guild data must contain its master");
Require(Encode(createAck, 3401).SequenceEqual(createPayload), "native CREATE_ACK round-trip must consume and retain the entire Node payload");
Console.WriteLine("CREATE_ACK: Node packet-handler response decoded and round-tripped by the real client protocol.");
if (expected.TryGetProperty("guildDataUpdatedPayloadBase64", out var updateData))
{
    var updatePayload = Convert.FromBase64String(updateData.GetString()!);
    var update = Decode(3416, updatePayload);
    var updatedGuild = Get(update, "guildData");
    Require(Convert.ToInt64(Get(updatedGuild, "guildUid")) == createdUid, "native guild bootstrap notification must restore the existing guild");
    Require(((IList)Get(updatedGuild, "members")).Count == 1, "native guild bootstrap notification must retain the real master");
    Require(Encode(update, 3416).SequenceEqual(updatePayload), "native guild data notification must round-trip completely");
    Console.WriteLine("GUILD_DATA_UPDATED_NOT: native decoder receives the existing guild and its master for client state restoration.");
}

var local = New("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
var official = New("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
Set(local, "userData", null);
Set(official, "userData", null);
var localMembership = New("ClientPacket.Common.PrivateGuildData");
Set(localMembership, "guildUid", 123L);
Set(localMembership, "donationCount", 2);
Set(localMembership, "lastDailyResetDate", new DateTime(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc));
Set(local, "privateGuildData", localMembership);
var officialMembership = New("ClientPacket.Common.PrivateGuildData");
Set(officialMembership, "guildUid", 0L);
Set(official, "privateGuildData", officialMembership);
var input = new JoinLobbyMergeData
{
    OfficialPayloadBase64 = Convert.ToBase64String(Encode(official, 205)),
    LocalPayloadBase64 = Convert.ToBase64String(Encode(local, 205)),
};
byte[] mergedPayload;
if (args.Length == 4 && args[2] == "--export-lobby-fixture")
{
    File.WriteAllText(args[3], JsonSerializer.Serialize(input, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }));
    Console.WriteLine("Synthetic official/local JOIN_LOBBY_ACK fixture written with the untouched native PacketWriter; no lobby merge has run.");
    return 0;
}
if (args.Length == 4 && args[2] == "--check-merged")
{
    using var result = JsonDocument.Parse(File.ReadAllText(args[3]));
    Require(result.RootElement.GetProperty("ok").GetBoolean(), "the complete Android host merge must report success");
    mergedPayload = Convert.FromBase64String(result.RootElement.GetProperty("payloadBase64").GetString()!);
}
else
{
    Require(args.Length == 2, "invalid protocol-check mode");
    var host = Assembly.Load("CombatHost");
    var bridge = host.GetType("RevivalSide.CombatHost.ManagedCombatBridge", throwOnError: true)!;
    var runtimeType = bridge.GetNestedType("ManagedRuntime", BindingFlags.NonPublic)!;
    object?[] loadArgs = [managedDir, "", null];
    var runtime = runtimeType.GetMethod("TryLoad", flags)!.Invoke(null, loadArgs);
    Require(runtime != null, $"complete managed runtime could not load: {string.Join(Environment.NewLine, Convert.ToString(loadArgs[2])?.Split('\n').Take(5) ?? [])}");
    object?[] mergeArgs = [new HostOptions { ManagedDir = managedDir }, input, null, null];
    var merged = (bool)bridge.GetMethod("TryMergeJoinLobbyAck", flags)!.Invoke(null, mergeArgs)!;
    Require(merged, $"real compiled lobby merge failed: {mergeArgs[3]}");
    var response = (HostResponse)mergeArgs[2]!;
    Require(response.Ok && !string.IsNullOrEmpty(response.PayloadBase64), "lobby merge must return a serialized native ACK");
    mergedPayload = Convert.FromBase64String(response.PayloadBase64!);
}
var mergedAck = Decode(205, mergedPayload);
Require(Convert.ToInt32(Get(mergedAck, "errorCode")) == 0, "native merged lobby ACK must remain successful");
var membership = Get(mergedAck, "privateGuildData");
Require(Convert.ToInt64(Get(membership, "guildUid")) == 123L, "real 205 merge must replace the official empty guild UID with the local membership");
Require(Convert.ToInt32(Get(membership, "donationCount")) == 2, "real 205 merge must preserve local donation state");
Require(((DateTime)Get(membership, "lastDailyResetDate")).Kind == DateTimeKind.Utc, "native merged reset DateTime must retain UTC kind");
Require((DateTime)Get(membership, "lastDailyResetDate") == new DateTime(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc), "real 205 merge must preserve the local reset DateTime");
Require(Encode(mergedAck, 205).SequenceEqual(mergedPayload), "native merged JOIN_LOBBY_ACK must round-trip without unconsumed fields");
Console.WriteLine(args.Length == 4
    ? "JOIN_LOBBY_ACK: native decoding of the supplied full-host response retains guild UID 123 and local donation/reset state."
    : "JOIN_LOBBY_ACK: real compiled merge, native serialization and native decoding retain local guild UID 123 over official UID 0.");
return 0;

object New(string type) => Activator.CreateInstance(client.GetType(type, throwOnError: true)!)!;
object Decode(int id, byte[] bytes)
{
    var type = id switch { 205 => "ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK", 3401 => "ClientPacket.Guild.NKMPacket_GUILD_CREATE_ACK", 3416 => "ClientPacket.Guild.NKMPacket_GUILD_DATA_UPDATED_NOT", _ => throw new ArgumentOutOfRangeException(nameof(id)) };
    var packet = New(type);
    var reader = Activator.CreateInstance(readerType, [bytes])!;
    try { readerGet.Invoke(reader, [packet]); return packet; }
    finally { (reader as IDisposable)?.Dispose(); }
}
byte[] Encode(object packet, int id)
{
    var buffer = writerPut.Invoke(null, [packet])!;
    var type = buffer.GetType();
    var length = Convert.ToInt32(type.GetMethod("CalcTotalSize", flags)!.Invoke(buffer, null));
    var output = new byte[length];
    var offset = 0;
    foreach (var segment in (IEnumerable)type.GetMethod("GetView", flags)!.Invoke(buffer, null)!)
    {
        var segmentType = segment.GetType();
        var data = (byte[])segmentType.GetProperty("Data")!.GetValue(segment)!;
        var count = Convert.ToInt32(segmentType.GetProperty("Offset")!.GetValue(segment));
        Buffer.BlockCopy(data, 0, output, offset, count);
        offset += count;
    }
    Require(offset == length, $"native packet {id} serialization must emit all segments");
    return output;
}
object Get(object target, string field) => target.GetType().GetField(field, flags)!.GetValue(target)!;
void Set(object target, string field, object? value) => target.GetType().GetField(field, flags)!.SetValue(target, value);
void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
