using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length is < 2 or > 3) throw new ArgumentException("Usage: LimitedEventClientProtocolCheck <original Managed directory> <frozen event fixture JSON> [reward protocol fixtures]");
var managed = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context,name) => { var p=Path.Combine(managed,name.Name+".dll");return File.Exists(p)?context.LoadFromAssemblyPath(p):null; };
var client=AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(managed,"Assembly-CSharp.dll"));
var flags=BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static;
using var json=JsonDocument.Parse(File.ReadAllText(args[1]));
var collectionType=client.GetType("NKM.Event.NKMEventCollectionIndexTemplet",true)!;
var defenceType=client.GetType("NKM.NKMDefenceTemplet",true)!;
var intervalType=client.GetType("NKM.Templet.NKMIntervalTemplet",true)!;
var tags=client.GetType("NKM.NKMOpenTagManager",true)!;
var collectionRow=json.RootElement.GetProperty("collections").EnumerateArray().Single(r=>r.GetProperty("EventID").GetInt32()==58);
var defenceRow=json.RootElement.GetProperty("defences").EnumerateArray().Single(r=>r.GetProperty("m_Id").GetInt32()==23);
var collection=RuntimeHelpers.GetUninitializedObject(collectionType);
Set(collection,"eventId",58);Set(collection,"openTag",collectionRow.GetProperty("OpenTag").GetString()!);Set(collection,"dateStrId",collectionRow.GetProperty("DateStrID").GetString()!);
Require(!(bool)collectionType.GetProperty("IsOpen",flags)!.GetValue(collection)!,"a closed native tag must hide the module");
tags.GetMethod("TryAddTag",flags)!.Invoke(null,[defenceRow.GetProperty("m_OpenTag").GetString()!]);
Require((bool)collectionType.GetProperty("IsOpen",flags)!.GetValue(collection)!,"selected native module must be open");
var intervals=new Dictionary<string,object>();
foreach(var key in new[]{collectionRow.GetProperty("DateStrID").GetString()!,defenceRow.GetProperty("m_DateStrID").GetString()!,defenceRow.GetProperty("m_RewardDateStrID").GetString()!}) {
 var interval=RuntimeHelpers.GetUninitializedObject(intervalType);Set(interval,"<Key>k__BackingField",Math.Abs(key.GetHashCode()));Set(interval,"<StrKey>k__BackingField",key);Set(interval,"<StartDate>k__BackingField",new DateTime(2000,1,1,0,0,0,DateTimeKind.Utc));Set(interval,"<EndDate>k__BackingField",new DateTime(2099,12,31,23,59,59,DateTimeKind.Utc));
 foreach(var date in new[]{new DateTime(2025,4,10,15,0,0,DateTimeKind.Utc),new DateTime(2026,10,10,7,0,0,DateTimeKind.Utc)})Require((bool)intervalType.GetMethod("IsValidTime",flags,null,[typeof(DateTime)],null)!.Invoke(interval,[date])!,"original interval rejected offline native event");
 intervals[key]=interval;
}
Set(collection,"<Intervaltemplet>k__BackingField",intervals[collectionRow.GetProperty("DateStrID").GetString()!]);
var defence=RuntimeHelpers.GetUninitializedObject(defenceType);Set(defence,"m_Id",23);Set(defence,"m_OpenTag",defenceRow.GetProperty("m_OpenTag").GetString()!);Set(defence,"m_DungeonID",8030023);Set(defence,"<IntervalTemplet>k__BackingField",intervals[defenceRow.GetProperty("m_DateStrID").GetString()!]);Set(defence,"<RewardIntervalTemplet>k__BackingField",intervals[defenceRow.GetProperty("m_RewardDateStrID").GetString()!]);
// Simulate the captured ACK's older active collaboration window. The actual
// native first-match selector must switch to the boss event after suppression.
var legacyRow=json.RootElement.GetProperty("collections").EnumerateArray().Single(r=>r.GetProperty("EventID").GetInt32()==26);
var legacy=RuntimeHelpers.GetUninitializedObject(collectionType);
Set(legacy,"eventId",26);Set(legacy,"openTag",legacyRow.GetProperty("OpenTag").GetString()!);Set(legacy,"dateStrId",legacyRow.GetProperty("DateStrID").GetString()!);
var legacyWindow=RuntimeHelpers.GetUninitializedObject(intervalType);
Set(legacyWindow,"<StartDate>k__BackingField",new DateTime(2025,4,1));Set(legacyWindow,"<EndDate>k__BackingField",new DateTime(2025,5,1));
Set(legacy,"<Intervaltemplet>k__BackingField",legacyWindow);
tags.GetMethod("TryAddTag",flags)!.Invoke(null,[legacyRow.GetProperty("OpenTag").GetString()!]);
var container=client.GetType("NKM.Templet.Base.NKMTempletContainer`1",true)!.MakeGenericType(collectionType);
var table=(IDictionary)container.GetField("data",flags)!.GetValue(null)!;
table[26]=legacy;table[58]=collection;
var selector=collectionType.GetMethod("GetByTime",flags,null,[typeof(DateTime)],null)!;
var now=new DateTime(2025,4,10,15,0,0,DateTimeKind.Utc);
var before=selector.Invoke(null,[now])!;
Require((int)collectionType.GetField("eventId",flags)!.GetValue(before)! == 26,"the old active window must reproduce native first-module capture");
Set(legacyWindow,"<StartDate>k__BackingField",new DateTime(2000,1,1));Set(legacyWindow,"<EndDate>k__BackingField",new DateTime(2000,1,2));
var after=selector.Invoke(null,[now])!;
Require((int)collectionType.GetField("eventId",flags)!.GetValue(after)! == 58,"the expired old window must restore native boss-module selection");
Console.WriteLine("[limited-event-native] PASS frozen original IsOpen/IsValidTime/GetByTime: old captured collaboration 26 -> defence collection 58 after suppressing its interval");
if(args.Length==3) {
 using var rewards=JsonDocument.Parse(File.ReadAllText(args[2]));
 var serializable=client.GetType("Cs.Protocol.ISerializable",true)!;
 var readerType=client.GetType("Cs.Protocol.PacketReader",true)!;
 var writer=client.GetType("Cs.Protocol.PacketWriter",true)!.GetMethod("ToBufferWithoutNullBit",flags,null,[serializable],null)!;
 var count=0;
 foreach(var fixture in rewards.RootElement.GetProperty("fixtures").EnumerateArray()) {
  var bytes=Convert.FromBase64String(fixture.GetProperty("payloadBase64").GetString()!);
  var typeName=fixture.GetProperty("typeName").GetString()!;
  var packet=Activator.CreateInstance(client.GetType(typeName.Contains('.')?typeName:"ClientPacket.Defence."+typeName,true)!)!;
  var reader=Activator.CreateInstance(readerType,[bytes])!;
  try {readerType.GetMethod("GetWithoutNullBit",flags,null,[serializable],null)!.Invoke(reader,[packet]);}finally{(reader as IDisposable)?.Dispose();}
  var buffer=writer.Invoke(null,[packet])!;
  var encoded=new byte[Convert.ToInt32(buffer.GetType().GetMethod("CalcTotalSize",flags)!.Invoke(buffer,null))];var offset=0;
  foreach(var part in (IEnumerable)buffer.GetType().GetMethod("GetView",flags)!.Invoke(buffer,null)!) {
   var type=part.GetType();var data=(byte[])type.GetProperty("Data")!.GetValue(part)!;var size=Convert.ToInt32(type.GetProperty("Offset")!.GetValue(part));
   Buffer.BlockCopy(data,0,encoded,offset,size);offset+=size;
  }
  Require(encoded.SequenceEqual(bytes),"Original defence reward packet did not round-trip every byte");count++;
 }
 Console.WriteLine($"[event-packets-native] PASS original response ACK round-trips: {count}");
}


void Set(object target,string field,object value)=>target.GetType().GetField(field,flags)!.SetValue(target,value);
void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
