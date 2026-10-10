"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const codec=require("../modules/packet-codec");
const {dateTimeBinaryForDate}=require("../modules/server-time");
const {createEventManager}=require("../modules/event-manager");
const root=path.join(__dirname,"..");
const source=fs.readFileSync(path.join(root,"server/listener.js"),"utf8");
const scope={...codec,Buffer};vm.createContext(scope);
for(const [first,after] of [["lz4StreamDecompress","lz4StreamWrapUncompressed"],["lz4BlockDecode","loadCapturedGameFlow"],["readStringList","writeObjectList"]]) {
 const begin=source.indexOf(`function ${first}(`),end=source.indexOf(`function ${after}(`,begin);
 if(begin<0||end<=begin)throw Error(`Missing production ${first}`);
 vm.runInContext(source.slice(begin,end),scope);
}
const capturedDir=process.argv[2]||path.join(root,"server-data/captured-game-flow");
const manifest=JSON.parse(fs.readFileSync(path.join(capturedDir,"manifest.json")));
const row=manifest.server.find(item=>item.packetId===205);
if(!row||!row.compressed)throw Error("A real compressed captured205 is required");
const official=scope.lz4StreamDecompress(fs.readFileSync(path.join(capturedDir,row.payloadFile)));
const env=process.argv[4]?{CS_GAMEPLAY_TABLES_DIR:process.argv[4]}:{};
const manager=createEventManager({rootDir:root,env});
const state=manager.getActiveEventState("2025-04-10T18:31:41Z");
function intervalPayload(row) {return Buffer.concat([codec.writeSignedVarInt(row.key),codec.writeString(row.strKey),codec.writeInt64LE(dateTimeBinaryForDate(row.startDate)),codec.writeInt64LE(dateTimeBinaryForDate(row.endDate)),codec.writeSignedVarInt(row.repeatStartDate),codec.writeSignedVarInt(row.repeatEndDate)]).toString("base64");}
const tcpDir=path.join(root,"server-data/captured-tcp");
const tcp=JSON.parse(fs.readFileSync(path.join(tcpDir,"manifest.json")));
const login=tcp[203];
if(!login||!login.compressed)throw Error("A real captured login203 is required");
const loginRaw=scope.lz4StreamDecompress(fs.readFileSync(path.join(tcpDir,login.payloadFile)));
let offset=0;
function skip(read){const r=read(loginRaw,offset);offset=r.offset;return r.value;}
skip(codec.readSignedVarInt);skip(codec.readString);skip(codec.readString);skip(codec.readSignedVarInt);skip(codec.readString);skip(scope.readStringList);
const actualOpenTags=[...new Set([...skip(scope.readStringList),...state.openTags])];
const out={serviceTime:"2025-04-10T18:31:41Z",officialPayloadBase64:official.toString("base64"),intervals:state.intervalData.map(row=>({strKey:row.strKey,suppressed:row.sourceTable==="OFFLINE_DISABLED_MODULE_WINDOW",payloadBase64:intervalPayload(row)})),collections:manager.getRegistry().entries.filter(entry=>entry.source.tableName==="EVENT_COLLECTION_INDEX_TEMPLET").map(entry=>entry.raw),defences:manager.getRegistry().entries.filter(entry=>entry.source.tableName==="DEFENCE_TEMPLET").map(entry=>entry.raw),openTags:actualOpenTags};
const output=process.argv[3]||"/tmp/revivalside-limited-event-actual-205-fixture.json";
fs.writeFileSync(output,JSON.stringify(out,null,2)+"\n",{mode:0o600});
console.log(`Real captured205 decompressed: ${official.length} bytes; native interval inputs: ${out.intervals.length}. Private fixture written without printing account fields.`);
