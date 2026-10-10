using System.Collections;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using RevivalSide.CombatHost;

if(args.Length!=2)throw new ArgumentException("Usage: LimitedEventJoinLobbyCheck <original Managed directory> <real captured205 + local interval fixture>");
var managed=Path.GetFullPath(args[0]);var flags=BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static;
AssemblyLoadContext.Default.Resolving+=(context,name)=>{var p=Path.Combine(managed,name.Name+".dll");return File.Exists(p)?context.LoadFromAssemblyPath(p):null;};
var client=AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managed,"Assembly-CSharp.dll"));
using var json=JsonDocument.Parse(File.ReadAllText(args[1]));var fixture=json.RootElement;
var officialBytes=Convert.FromBase64String(fixture.GetProperty("officialPayloadBase64").GetString()!);
var now=DateTime.Parse(fixture.GetProperty("serviceTime").GetString()!,null,System.Globalization.DateTimeStyles.RoundtripKind);
var packetType=Type("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");var nativeIntervalType=Type("ClientPacket.Common.NKMIntervalData");
var bridge=typeof(HostOptions).Assembly.GetType("RevivalSide.CombatHost.ManagedCombatBridge",true)!;
var runtime=RuntimeHelpers.GetUninitializedObject(bridge.GetNestedType("ManagedRuntime",BindingFlags.NonPublic)!);
var merge=bridge.GetMethod("MergeIntervalData",flags)!;
var checkUnique=bridge.GetMethod("EnsureUniqueIntervalKeys",flags)!;
var collectionType=Type("NKM.Event.NKMEventCollectionIndexTemplet");
var intervalType=Type("NKM.Templet.NKMIntervalTemplet");
var tags=Type("NKM.NKMOpenTagManager");
var selectedIds=new List<int>();
foreach(var corrected in new[]{false,true}) {
 var official=Decode(packetType,officialBytes);var local=New(packetType);
 Set(local,"utcTime",now);
 foreach(var clockField in new[]{"utcTime","utcOffset"})bridge.GetMethod("CopyField",flags)!.Invoke(null,[runtime,local,official,clockField]);
 var localIntervals=(IList)Get(local,"intervalData");
 foreach(var row in fixture.GetProperty("intervals").EnumerateArray()) {
  var interval=Decode(nativeIntervalType,Convert.FromBase64String(row.GetProperty("payloadBase64").GetString()!));
  if(row.GetProperty("suppressed").GetBoolean()) {Set(interval,"startDate",new DateTime(corrected?1999:2000,1,1,0,0,0,DateTimeKind.Utc));Set(interval,"endDate",new DateTime(corrected?1999:2000,1,2,0,0,0,DateTimeKind.Utc));}
  localIntervals.Add(interval);
 }
 var keys=localIntervals.Cast<object>().Select(row=>(string)Get(row,"strKey")).ToArray();
 merge.Invoke(null,[runtime,local,official,keys]);checkUnique.Invoke(null,[runtime,official]);
 var serialized=Encode(official);var final=Decode(packetType,serialized);Require(Encode(final).SequenceEqual(serialized),"Final merged205 must consume and round-trip every byte");
 var intervalContainer=Container(intervalType);
 foreach(var f in intervalContainer.GetFields(flags).Where(f=>f.IsStatic&&typeof(IDictionary).IsAssignableFrom(f.FieldType)))((IDictionary)f.GetValue(null)!).Clear();
 foreach(var row in ((IList)Get(final,"intervalData")).Cast<object>()) {
  var templet=New(intervalType);
  foreach(var name in new[]{"key","strKey","startDate","endDate","repeatStartDate","repeatEndDate"})Set(templet,"<"+char.ToUpperInvariant(name[0])+name[1..]+">k__BackingField",Get(row,name));
  Register(templet,"StrKey");
 }
 var collectionData=(IDictionary)Container(collectionType).GetField("data",flags)!.GetValue(null)!;collectionData.Clear();
 foreach(var row in fixture.GetProperty("collections").EnumerateArray()) {
  var templet=New(collectionType);var id=row.GetProperty("EventID").GetInt32();
  Set(templet,"eventId",id);Set(templet,"openTag",row.GetProperty("OpenTag").GetString()!);Set(templet,"dateStrId",row.GetProperty("DateStrID").GetString()!);
  Set(templet,"eventMissionTabIds",new List<int>());
  collectionData[id]=templet;
  var tag=row.GetProperty("OpenTag").GetString()!;
  if(fixture.GetProperty("openTags").EnumerateArray().Any(value=>value.GetString()==tag))tags.GetMethod("TryAddTag",flags)!.Invoke(null,[tag]);
  collectionType.GetMethod("JoinTemplet",flags)!.Invoke(templet,null);
 }
 var selected=collectionType.GetMethod("GetByTime",flags,null,[typeof(DateTime)],null)!.Invoke(null,[now]);
 var selectedId=selected==null?0:(int)Get(selected,"eventId");selectedIds.Add(selectedId);
 var sync=Type("NKC.NKCSynchronizedTime");
 sync.GetField("s_tsServerTimeDifference",flags)!.SetValue(null,(DateTime)Get(final,"utcTime")-DateTime.UtcNow);
 sync.GetField("s_tsServiceTimeOffset",flags)!.SetValue(null,TimeSpan.Zero);
 var moduleChoice=Type("NKC.UI.Module.NKCUIModuleLobby").GetMethod("GetEventCollectionIndexTemplet",flags)!.Invoke(null,null);
 var moduleId=moduleChoice==null?0:(int)Get(moduleChoice,"eventId");
 Require(moduleId==selectedId,"actual lobby selector disagrees with native GetByTime");
 var legacy=intervalType.GetMethod("Find",flags,null,[typeof(string)],null)!.Invoke(null,["DATE_EPISODE_SUMMARY_EVENT_CLB_004"]);
 Console.WriteLine($"Production MergeIntervalData -> serialized205 {serialized.Length} bytes -> original Find/JoinTemplet/GetByTime: suppressionYear={(corrected?1999:2000)}, selected={selectedId}, actualLobbyModule={moduleId}, oldCollabEnd={(legacy==null?"none":Get(legacy,"<EndDate>k__BackingField"))}");
 if(corrected)Require(selectedId==58,"corrected final merged205 must select defence58");
}
Require(selectedIds[0]!=58,"old fallback window must reproduce failure in actual production merge");
Console.WriteLine("PASS real captured205 + production merge + untouched original final consumer: fallback suppression skipped, explicit closed window restores defence58.");
object New(Type type)=>Activator.CreateInstance(type)!;
Type Type(string name)=>client.GetType(name,true)!;
object Get(object target,string name)=>target.GetType().GetField(name,flags)!.GetValue(target)!;
void Set(object target,string name,object? value)=>target.GetType().GetField(name,flags)!.SetValue(target,value);
void Require(bool v,string message){if(!v)throw new InvalidOperationException(message);}
Type Container(Type type)=>Type("NKM.Templet.Base.NKMTempletContainer`1").MakeGenericType(type);
void Register(object templet,string key) {
 var parameter=Expression.Parameter(templet.GetType(),"templet");var selector=Expression.Lambda(typeof(Func<,>).MakeGenericType(templet.GetType(),typeof(string)),Expression.Property(parameter,key),parameter).Compile();
 Container(templet.GetType()).GetMethods(flags).Single(method=>method.Name=="Add"&&method.GetParameters().Length==2).Invoke(null,[templet,selector]);
}
object Decode(Type type,byte[] bytes){var packet=New(type);var readerType=Type("Cs.Protocol.PacketReader");var reader=Activator.CreateInstance(readerType,[bytes])!;try{readerType.GetMethod("GetWithoutNullBit",flags,null,[Type("Cs.Protocol.ISerializable")],null)!.Invoke(reader,[packet]);return packet;}finally{(reader as IDisposable)?.Dispose();}}
byte[] Encode(object packet){var buffer=Type("Cs.Protocol.PacketWriter").GetMethod("ToBufferWithoutNullBit",flags,null,[Type("Cs.Protocol.ISerializable")],null)!.Invoke(null,[packet])!;var bytes=new byte[Convert.ToInt32(buffer.GetType().GetMethod("CalcTotalSize",flags)!.Invoke(buffer,null))];var offset=0;foreach(var part in (IEnumerable)buffer.GetType().GetMethod("GetView",flags)!.Invoke(buffer,null)!){var type=part.GetType();var data=(byte[])type.GetProperty("Data")!.GetValue(part)!;var size=Convert.ToInt32(type.GetProperty("Offset")!.GetValue(part));Buffer.BlockCopy(data,0,bytes,offset,size);offset+=size;}return bytes;}
