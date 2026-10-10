// Run in a net8.0 console project with the built host, Managed directory,
// gameplay-tables directory, and check-battle-continuation progress fixture.
using System.Collections;
using System.Reflection;
using System.Text.Json;

var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
var host = Assembly.LoadFrom(Path.GetFullPath(args[0]));
var bridge = host.GetType("RevivalSide.CombatHost.ManagedCombatBridge")!;
var runtimeType = bridge.GetNestedType("ManagedRuntime", BindingFlags.NonPublic)!;
object?[] load = [Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), null];
var runtime = runtimeType.GetMethod("TryLoad", flags)!.Invoke(null, load)
    ?? throw new Exception(Convert.ToString(load[2]));
object Call(string name, params object[] values) => runtimeType.GetMethod(name, flags)!.Invoke(runtime, values)!;
object Field(object value, string name) => value.GetType().GetField(name, flags)!.GetValue(value)!;
void Set(object value, string name, object? fieldValue) => value.GetType().GetField(name, flags)!.SetValue(value, fieldValue);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
using var fixture = JsonDocument.Parse(File.ReadAllText(args[3]));
var payload = Convert.FromBase64String(fixture.RootElement.GetProperty("payloadBase64").GetString()!);
var progress = Call("DeserializePacket", 1242, payload);
var clears = (IList)Field(progress, "trimClearList");
Check(clears.Count == 1, "progress notification must contain the completed chain");
var clear = clears[0]!;
var trimId = (int)Field(clear, "trimId");
var level = (int)Field(clear, "trimLevel");
Check((bool)Field(clear, "isWin") && level > 0, "native decoder must receive a winning level");
var gameAssembly = clear.GetType().Assembly;
var clientDataType = gameAssembly.GetType("NKC.Trim.NKCTrimData")!;
var client = Activator.CreateInstance(clientDataType)!;
clientDataType.GetMethod("SetTrimClearList")!.Invoke(client, [clears]);
Check((int)clientDataType.GetMethod("GetClearedTrimLevel")!.Invoke(client, [trimId])! == level,
    "native client must unlock the level after the completed one");

var lobbyType = gameAssembly.GetType("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK")!;
var official = Activator.CreateInstance(lobbyType)!;
var local = Activator.CreateInstance(lobbyType)!;
Set(local, "trimClearList", clears);
Set(local, "trimIntervalData", Field(progress, "trimIntervalData"));
var state = Activator.CreateInstance(gameAssembly.GetType("ClientPacket.Mode.TrimModeState")!)!;
Set(state, "trimId", trimId); Set(state, "trimLevel", level + 1); Set(local, "trimModeState", state);
string Encode(object packet) {
    var encoded = Call("SerializePacket", packet, 205, "trim-test");
    return (string)encoded.GetType().GetProperty("PayloadBase64")!.GetValue(encoded)!;
}
var options = Activator.CreateInstance(host.GetType("RevivalSide.CombatHost.HostOptions")!)!;
options.GetType().GetProperty("ManagedDir")!.SetValue(options, Path.GetFullPath(args[1]));
options.GetType().GetProperty("GameplayTablesDir")!.SetValue(options, Path.GetFullPath(args[2]));
var merge = Activator.CreateInstance(host.GetType("RevivalSide.CombatHost.JoinLobbyMergeData")!)!;
merge.GetType().GetProperty("OfficialPayloadBase64")!.SetValue(merge, Encode(official));
merge.GetType().GetProperty("LocalPayloadBase64")!.SetValue(merge, Encode(local));
object?[] request = [options, merge, null, null];
Check((bool)bridge.GetMethod("TryMergeJoinLobbyAck", flags)!.Invoke(null, request)!, Convert.ToString(request[3]) ?? "lobby merge failed");
var response = request[2]!;
var merged = Call("DeserializePacket", 205, Convert.FromBase64String((string)response.GetType().GetProperty("PayloadBase64")!.GetValue(response)!));
var restored = (IList)Field(merged, "trimClearList");
Check(restored.Count == 1 && (int)Field(restored[0]!, "trimLevel") == level,
    "captured official lobby must not erase the local clear record on login");
Check((int)Field(Field(merged, "trimModeState"), "trimLevel") == level + 1,
    "login merge must retain the next in-progress chain");
Set(local, "trimClearList", Activator.CreateInstance(clears.GetType()));
Set(local, "trimModeState", null);
merge.GetType().GetProperty("LocalPayloadBase64")!.SetValue(merge, Encode(local));
Set(official, "trimClearList", clears);
merge.GetType().GetProperty("OfficialPayloadBase64")!.SetValue(merge, Encode(official));
request = [options, merge, null, null];
Check((bool)bridge.GetMethod("TryMergeJoinLobbyAck", flags)!.Invoke(null, request)!, "empty local merge failed");
response = request[2]!;
merged = Call("DeserializePacket", 205, Convert.FromBase64String((string)response.GetType().GetProperty("PayloadBase64")!.GetValue(response)!));
Check(((IList)Field(merged, "trimClearList")).Count == 0 && Field(merged, "trimModeState") == null,
    "fresh local accounts must not inherit captured Trim progress");
Console.WriteLine($"Native Trim progress checks passed: notification, level {level + 1} unlock, relogin merge, resume, and fresh account.");
