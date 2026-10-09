using System.Collections;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 3 || args[1] is not ("--make" or "--check"))
{
    Console.Error.WriteLine("Usage: PvpStartClientProtocolCheck <Managed directory> --make|--check <public fixture JSON>");
    return 2;
}
var directory = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var file = Path.Combine(directory, name.Name + ".dll");
    return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
};
var client = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Assembly-CSharp.dll"));
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
var serializable = client.GetType("Cs.Protocol.ISerializable", true)!;
var readerType = client.GetType("Cs.Protocol.PacketReader", true)!;
var readerGet = readerType.GetMethod("GetWithoutNullBit", flags, null, [serializable], null)!;
var writerType = client.GetType("Cs.Protocol.PacketWriter", true)!;
var writerPut = writerType.GetMethod("ToBufferWithoutNullBit", flags, null, [serializable], null)!;
const long gameUid = 960000101L;

if (args[1] == "--make")
{
    var packet = New("ClientPacket.Pvp.NKMPacket_ASYNC_PVP_START_GAME_ACK");
    var game = New("NKM.NKMGameData");
    Set(game, "m_GameUID", gameUid);
    var kind = game.GetType().GetField("m_NKM_GAME_TYPE", flags)!.FieldType;
    Set(game, "m_NKM_GAME_TYPE", Enum.Parse(kind, "NGT_PVP_STRATEGY"));
    Set(packet, "gameData", game);
    Set(packet, "gameRuntimeData", New("NKM.NKMGameRuntimeData"));
    Set(packet, "refreshedTargetData", null);
    Set(packet, "targetList", Activator.CreateInstance(packet.GetType().GetField("targetList", flags)!.FieldType));
    Set(packet, "skip", false);
    var bytes = Encode(packet);
    Require(bytes.Length > 6 && bytes.AsSpan(bytes.Length - 3).SequenceEqual(new byte[] { 0, 0, 0 }), "native writer must produce the exact frozen empty target footer");
    File.WriteAllText(args[2], JsonSerializer.Serialize(new { gameUid, nativePayloadBase64 = Convert.ToBase64String(bytes) }));
    Console.WriteLine($"native2618 writer: bytes={bytes.Length}, uid={gameUid}, footer=null/empty/false PASS");
    return 0;
}
using var document = JsonDocument.Parse(File.ReadAllText(args[2]));
var json = document.RootElement;
var native = Convert.FromBase64String(json.GetProperty("nativePayloadBase64").GetString()!);
var filled = Convert.FromBase64String(json.GetProperty("payloadBase64").GetString()!);
var oldPacket = Decode(native);
var newPacket = Decode(filled);
Require(Convert.ToInt32(Get(newPacket, "errorCode")) == 0, "native start response must succeed");
Require(Convert.ToInt64(Get(Get(newPacket, "gameData"), "m_GameUID")) == gameUid, "the prepared game UID must survive target population");
Require(Encode(Get(oldPacket, "gameData")).SequenceEqual(Encode(Get(newPacket, "gameData"))), "gameData must remain byte-exact");
Require(Encode(Get(oldPacket, "gameRuntimeData")).SequenceEqual(Encode(Get(newPacket, "gameRuntimeData"))), "runtimeData must remain byte-exact");
var selected = Get(newPacket, "refreshedTargetData");
Require(Convert.ToInt64(Get(selected, "userFriendCode")) == 900000003L, "Jake's selected target must be explicit");
Require(Convert.ToInt32(Get(selected, "mainUnitId")) == 1202, "the selected opponent leader must be Jake 1202");
var targets = (IList)Get(newPacket, "targetList");
Require(targets.Count == 7, "the start response must retain all seven targets");
Require(targets.Cast<object>().Count(target => Convert.ToInt64(Get(target, "userFriendCode")) == 900000003L) == 1, "selected target must appear once in the roster");
Require(!(bool)Get(newPacket, "skip"), "real battles must remain non-skip");
Require(Encode(newPacket).SequenceEqual(filled), "the original client must consume and round-trip every populated2618 byte");

// Read only these exact client types/methods. Broad Assembly.GetTypes and the
// full combat runtime are intentionally unnecessary for protocol verification.
var ready = client.GetType("NKC.UI.Gauntlet.NKCUIGauntletAsyncReady", true)!;
var handler = ready.GetMethods(flags | BindingFlags.DeclaredOnly).Single(method => method.Name == "OnRecv" && method.GetParameters().Length == 1
    && method.GetParameters()[0].ParameterType.Name == "NKMPacket_ASYNC_PVP_START_GAME_ACK");
var calls = Calls(handler).ToArray();
Require(calls.Count(method => method.Name == "ScenChangeFade") == 1, "each original2618 callback must schedule scene transition exactly once");
Require(calls.Any(method => method.Name == "SetReservedAsyncTarget") && calls.Any(method => method.Name == "SetReservedGameType"), "the original2618 callback must mutate reserved matching state");
Console.WriteLine($"native2618 reader: uid={gameUid}, selected=900000003/Jake1202, targets=7, bytes={filled.Length}, exact game/runtime and round-trip PASS");
Console.WriteLine("original2618 callback IL: SetReservedAsyncTarget/GameType + ScenChangeFade per success callback; duplicate ACK is not a harmless replay PASS");
return 0;

object New(string name) => Activator.CreateInstance(client.GetType(name, true)!)!;
object Get(object target, string name) => target.GetType().GetField(name, flags)!.GetValue(target)!;
void Set(object target, string name, object? value) => target.GetType().GetField(name, flags)!.SetValue(target, value);
void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
object Decode(byte[] bytes)
{
    var packet = New("ClientPacket.Pvp.NKMPacket_ASYNC_PVP_START_GAME_ACK");
    var reader = Activator.CreateInstance(readerType, [bytes])!;
    try { readerGet.Invoke(reader, [packet]); return packet; }
    finally { (reader as IDisposable)?.Dispose(); }
}
byte[] Encode(object value)
{
    var buffer = writerPut.Invoke(null, [value])!;
    var type = buffer.GetType();
    var count = Convert.ToInt32(type.GetMethod("CalcTotalSize", flags)!.Invoke(buffer, null));
    var bytes = new byte[count]; var offset = 0;
    foreach (var part in (IEnumerable)type.GetMethod("GetView", flags)!.Invoke(buffer, null)!)
    {
        var partType = part.GetType();
        var source = (byte[])partType.GetProperty("Data")!.GetValue(part)!;
        var length = Convert.ToInt32(partType.GetProperty("Offset")!.GetValue(part));
        Buffer.BlockCopy(source, 0, bytes, offset, length); offset += length;
    }
    Require(offset == count, "native serialization must emit all segments");
    return bytes;
}
IEnumerable<MethodBase> Calls(MethodInfo method)
{
    var body = method.GetMethodBody()!.GetILAsByteArray()!;
    var ops = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static).Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null)!).ToDictionary(op => unchecked((ushort)op.Value));
    var offset = 0;
    while (offset < body.Length)
    {
        var code = (ushort)body[offset++]; if (code == 0xfe) code = (ushort)(0xfe00 | body[offset++]);
        var op = ops[code];
        if (op == OpCodes.Call || op == OpCodes.Callvirt) yield return method.Module.ResolveMethod(BitConverter.ToInt32(body, offset))!;
        offset += op.OperandType switch {
            OperandType.InlineNone => 0, OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2, OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + BitConverter.ToInt32(body, offset) * 4, _ => 4 };
    }
}
