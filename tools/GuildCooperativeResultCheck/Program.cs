using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: GuildCooperativeResultCheck <original Managed directory> <public cooperative result fixture JSON>");
    return 2;
}

var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
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
var writerPut = client.GetType("Cs.Protocol.PacketWriter", true)!.GetMethod("ToBufferWithoutNullBit", flags, null, [serializable], null)!;
using var document = JsonDocument.Parse(File.ReadAllText(args[1]));
Require(document.RootElement.GetProperty("syntheticOnly").GetBoolean(), "The result check requires public synthetic fixtures.");
var checks = 0;
var packetChecks = 0;
var floatRoundingCount = 0;
foreach (var fixture in document.RootElement.GetProperty("fixtures").EnumerateArray())
{
    var gameType = fixture.GetProperty("gameType").GetInt32();
    Require(gameType is 16 or 17 or 25, "Expected Arena, Boss or Practice game type.");
    var packets = fixture.GetProperty("packets").EnumerateArray().ToArray();
    Require(packets.Length > 0 && packets[0].GetProperty("packetId").GetInt32() == 811, "GAME_END must precede cooperative notifications.");
    Require(packets[0].GetProperty("payloadBase64").GetString() == fixture.GetProperty("gameEndPayloadBase64").GetString(),
        "Recorded GAME_END must match the packet burst.");
    var decoded = new Dictionary<int, object>();
    foreach (var entry in packets)
    {
        var id = entry.GetProperty("packetId").GetInt32();
        Require(decoded.TryAdd(id, Decode(id, Convert.FromBase64String(entry.GetProperty("payloadBase64").GetString()!))), "Duplicate result packet type.");
        packetChecks++;
    }
    var expected = fixture.GetProperty("expected");
    var end = decoded[811];
    Require((bool)Get(end, "win")! == expected.GetProperty("win").GetBoolean(), "Native GAME_END win must match the fixture.");
    Require((bool)Get(end, "giveup")! == expected.GetProperty("giveup").GetBoolean(), "Native giveup must match the fixture.");
    Require((bool)Get(end, "restart")! == expected.GetProperty("restart").GetBoolean(), "Native restart must match the fixture.");
    Require(Count(Get(end, "stagePlayData")) == 0, "Cooperative results must not update ordinary stage progression.");
    Require(Get(end, "episodeCompleteData") == null, "Cooperative results must not update ordinary episode progression.");
    Require(Count(Get(end, "costItemDataList")) == 0, "The synthetic cooperative result must not grant ordinary item rewards.");
    Require(decoded.ContainsKey(3472) && decoded.ContainsKey(3474), "Result must refresh native cooperative INFO and MEMBER_INFO.");
    Require(Convert.ToInt32(Get(decoded[3472], "errorCode")) == 0 && Convert.ToInt32(Get(decoded[3474], "errorCode")) == 0,
        "Native cooperative info refresh must succeed.");

    if (gameType == 16)
    {
        // The original GAME_END constructor initializes an empty Raid DTO;
        // reading an absent wire object can retain that default instance.
        Require(IsEmptyRaid(Get(end, "raidBossResultData")) && decoded.ContainsKey(3481) && !decoded.ContainsKey(3482), "Arena requires its own end notification.");
        var clear = Get(end, "dungeonClearData");
        Require(clear != null && expected.GetProperty("dungeonClear").GetBoolean(), "Arena requires native dungeon clear data.");
        Require(Convert.ToInt32(Get(clear!, "dungeonId")) == fixture.GetProperty("dungeonId").GetInt32(), "Arena clear dungeon must match its stage.");
        var medals = ((bool)Get(end, "win")! ? 1 : 0) + ((bool)Get(clear!, "missionResult1")! ? 1 : 0) + ((bool)Get(clear!, "missionResult2")! ? 1 : 0);
        Require(medals == 3, "The public winning Arena fixture must retain all three mission medals.");
        var notification = decoded[3481];
        Require(Convert.ToInt32(Get(notification, "errorCode")) == 0, "Arena end notification must succeed.");
        var arenaId = Convert.ToInt32(Get(notification, "arenaId"));
        var grade = Convert.ToInt32(Get(notification, "totalGrade"));
        Require(grade == medals, "First synthetic Arena result must report the cumulative three medals.");
        var arena = ((IEnumerable)Get(decoded[3472], "arenaList")!).Cast<object>().Single(item => Convert.ToInt32(Get(item, "arenaIndex")) == arenaId);
        Require(Convert.ToInt32(Get(arena, "totalMedalCount")) == grade && Convert.ToInt64(Get(arena, "playUserUid")) == 0,
            "Native INFO must retain Arena medals and release occupancy.");
        Require(IsEmptyReward(Get(clear!, "rewardData")) && IsEmptyReward(Get(clear!, "missionReward")) && IsEmptyReward(Get(clear!, "oneTimeRewards"))
            && Convert.ToInt32(Get(clear!, "unitExp")) == 0,
            "Arena must not synthesize ordinary dungeon rewards.");
    }
    else
    {
        Require(Get(end, "dungeonClearData") == null && !decoded.ContainsKey(3481), "Boss must use its native Raid result shape.");
        var raid = Get(end, "raidBossResultData");
        Require(raid != null, "Boss and Practice require non-null native raidBossResultData.");
        foreach (var name in new[] { "initHp", "curHP", "maxHp", "damage" })
        {
            var exact = expected.GetProperty("raidBossResult").GetProperty(name).GetDouble();
            Require((float)Get(raid!, name)! == (float)exact, "Native Boss Float32 result must match the fixture.");
            if ((double)(float)exact != exact) floatRoundingCount++;
        }
        Require((float)Get(raid!, "damage")! > 0 && (float)Get(raid!, "curHP")! > 0, "Public fixture must exercise partial Boss damage.");
        if (gameType == 17)
        {
            Require(decoded.ContainsKey(3482), "Formal Boss result requires its cooperative end notification.");
            var notification = decoded[3482];
            Require((float)Get(notification, "damage")! == (float)Get(raid!, "damage")!, "Boss notification damage must match GAME_END.");
            Require((float)Get(notification, "remainHp")! == (float)Get(raid!, "curHP")!, "Boss notification HP must match GAME_END.");
            Require(Convert.ToInt32(Get(notification, "bossStageId")) == fixture.GetProperty("dungeonId").GetInt32(), "Boss notification must retain the stage ID.");
            var boss = Get(decoded[3472], "bossData")!;
            Require((float)Get(boss, "remainHp")! == (float)Get(raid!, "curHP")!, "Formal INFO must retain shared Boss HP.");
        }
        else
        {
            Require(!decoded.ContainsKey(3482), "Practice must not send formal Boss completion.");
            var boss = Get(decoded[3472], "bossData")!;
            Require((float)Get(boss, "remainHp")! == (float)Get(raid!, "maxHp")!, "Practice INFO must preserve shared Boss HP.");
        }
    }
    checks++;
}
Require(checks == 3, "The native check requires Arena, formal Boss and Practice fixtures.");
Console.WriteLine($"Original cooperative result protocol: fixtures={checks} packets={packetChecks} strictRoundTrips={packetChecks} float32RoundedExpectedFields={floatRoundingCount}.");
return 0;

object Decode(int id, byte[] bytes)
{
    var name = id switch
    {
        811 => "ClientPacket.Game.NKMPacket_GAME_END_NOT",
        3481 => "ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_ARENA_PLAY_END_NOT",
        3482 => "ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_BOSS_PLAY_END_NOT",
        3472 => "ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_INFO_ACK",
        3474 => "ClientPacket.Guild.NKMPacket_GUILD_DUNGEON_MEMBER_INFO_ACK",
        _ => throw new InvalidDataException("Unexpected cooperative result packet ID."),
    };
    var packet = Activator.CreateInstance(client.GetType(name, true)!)!;
    var reader = Activator.CreateInstance(readerType, [bytes])!;
    try { readerGet.Invoke(reader, [packet]); }
    finally { (reader as IDisposable)?.Dispose(); }
    var buffer = writerPut.Invoke(null, [packet])!;
    var type = buffer.GetType();
    var length = Convert.ToInt32(type.GetMethod("CalcTotalSize", flags)!.Invoke(buffer, null));
    var encoded = new byte[length];
    var offset = 0;
    foreach (var segment in (IEnumerable)type.GetMethod("GetView", flags)!.Invoke(buffer, null)!)
    {
        var segmentType = segment.GetType();
        var data = (byte[])segmentType.GetProperty("Data")!.GetValue(segment)!;
        var count = Convert.ToInt32(segmentType.GetProperty("Offset")!.GetValue(segment));
        Buffer.BlockCopy(data, 0, encoded, offset, count);
        offset += count;
    }
    Require(offset == length && bytes.AsSpan().SequenceEqual(encoded), $"Original packet {id} must retain every byte in its round-trip.");
    return packet;
}
object? Get(object value, string name) => value.GetType().GetField(name, flags)!.GetValue(value);
int Count(object? value) => value is IEnumerable values ? values.Cast<object?>().Count() : 0;
bool IsEmptyReward(object? reward) => reward == null || reward.GetType().GetFields(flags).Where(field => typeof(IEnumerable).IsAssignableFrom(field.FieldType) && field.FieldType != typeof(string)).All(field => Count(field.GetValue(reward)) == 0);
bool IsEmptyRaid(object? raid) => raid == null || new[] { "initHp", "curHP", "maxHp", "damage" }.All(name => (float)Get(raid, name)! == 0);
void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
