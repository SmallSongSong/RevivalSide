"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const codec = require("../modules/packet-codec");
const { dateTimeBinaryForDate, dateFromDateTime } = require("../modules/server-time");
const guild = require("../modules/guild");
const { setMiscItemBalance } = require("../modules/inventory");
const schema = require("../packet-schema.json");
const source = fs.readFileSync(path.join(__dirname,"../server/listener.js"),"utf8");
function extract(first, after) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${after}(`, start);
  assert(start>=0&&end>start,`missing production function ${first}`);
  return source.slice(start,end);
}
function decodeInterval(payload) {
  let offset=0;
  const read=method=>{const result=method(payload,offset);offset=result.offset;return result.value;};
  const key=read(codec.readSignedVarInt);
  const strKey=read(codec.readString);
  const startBinary=payload.readBigInt64LE(offset);offset+=8;
  const endBinary=payload.readBigInt64LE(offset);offset+=8;
  const repeatStartDate=read(codec.readSignedVarInt);
  const repeatEndDate=read(codec.readSignedVarInt);
  assert.equal(offset,payload.length,"production interval has no truncated or trailing fields");
  assert(startBinary&0x4000000000000000n);
  assert(endBinary&0x4000000000000000n);
  return {key,strKey,startDate:dateFromDateTime(startBinary),endDate:dateFromDateTime(endBinary),repeatStartDate,repeatEndDate};
}
const clock=new Date("2025-04-10T19:21:27Z");
const user={userUid:"1",friendCode:"101",nickname:"SyntheticCoop",level:20,inventory:{}};
setMiscItemBalance(user,101,1500);
const ctx={userDb:{users:{1:user}},getServerNowDate:()=>clock,getEffectiveContentsTags:()=>["GUILD_DUNGEON_SEASON_DEMOLTION_2025_2","GUILD_DUNGEON_SEASON_GIGAS_2025_2"]};
guild.handleRequest(ctx,user,3400,{guildName:"CoopFixture",guildJoinType:0,badgeId:"0",greeting:""});
const expected=guild.buildGuildSeasonIntervals(ctx,user)[0];
const retained={key:700001,strKey:"DATE_SYNTHETIC_OTHER_EVENT",startDate:new Date("2025-04-01T00:00:00Z"),endDate:new Date("2025-05-01T00:00:00Z")};
const sandbox={...codec,Buffer,Date,Map,Set,Array,dateTimeBinaryForDate,
  buildGuildSeasonIntervals:guild.buildGuildSeasonIntervals,createPacketContext:()=>ctx,getServerNowDate:()=>clock,
  buildEventIntervalDataList:()=>[retained],buildEventShopIntervalDataList:()=>[],buildFierceSeasonIntervalDataList:()=>[],buildSerializedAttendanceIntervalDataList:()=>[],
  getSelectableFierceSeasonRows:()=>[],
  getSelectableFierceSeasonIntervalStrKeys:()=>[],
  REQUIRED_INTERVAL_TAGS:[expected.strKey,"DATE_SYNTHETIC_REQUIRED"],
};
vm.createContext(sandbox);
vm.runInContext(extract("buildRequiredIntervalDataList","buildEventShopIntervalDataList"),sandbox);
vm.runInContext(extract("buildIntervalData","readIntervalDataStrKey"),sandbox);
vm.runInContext(extract("readIntervalDataStrKey","buildMinimalJoinLobbyPayload"),sandbox);
vm.runInContext(extract("buildJoinLobbyIntervalDataList","getActiveEventMissionTabIds"),sandbox);
const entries=sandbox.buildJoinLobbyIntervalDataList(user).map(decodeInterval);
const selected=entries.filter(entry=>entry.strKey===expected.strKey);
assert.equal(selected.length,1,"production lobby emits one selected guild interval");
assert.equal(selected[0].startDate.getTime(),expected.startDate.getTime(),"required 2000..2099 defaults cannot overwrite the selected guild calendar");
assert.equal(selected[0].endDate.getTime(),expected.endDate.getTime(),"guild countdown must remain the persistent real session window");
const unchanged=entries.find(entry=>entry.strKey===retained.strKey);
assert.equal(unchanged.startDate.getTime(),retained.startDate.getTime());
assert.equal(unchanged.endDate.getTime(),retained.endDate.getTime());
const required=entries.find(entry=>entry.strKey==="DATE_SYNTHETIC_REQUIRED");
assert.equal(required.startDate.getUTCFullYear(),2000,"unrelated required intervals keep the production default behavior");
assert.equal(required.endDate.getUTCFullYear(),2099);
const info=guild.handleRequest(ctx,user,3471,{guildUid:user.guildUid});
const member=guild.handleRequest(ctx,user,3473,{guildUid:user.guildUid});
assert.equal(info.seasonId,100012);
assert.equal(info.sessionId,1);
assert.equal(dateFromDateTime(BigInt(info.currentSessionEndDate)).getTime(),selected[0].startDate.getTime()+5*86400000,"production 205 calendar and cooperation INFO share the native five-day session end");
assert.equal(dateFromDateTime(BigInt(info.NextSessionStartDate)).getTime(),selected[0].startDate.getTime()+7*86400000);
assert.equal(member.memberInfoList[0].profile.userUid,user.userUid);
let mergeOptions;
Object.assign(sandbox,{
  process:{env:{}},console:{log(){}},JOIN_LOBBY_ACK:205,REPLAY_CAPTURED_GAME_FLOW:true,
  buildMinimalJoinLobbyPayload:()=>Buffer.from("synthetic-local-205"),getCapturedServerPayloadTemplate:()=>Buffer.from("synthetic-official-205"),
  hasLocalContractState:()=>false,getActiveEventShopTags:()=>({intervalTags:[]}),getFierceSeasonIntervalStrKeys:()=>[],getActiveEventState:()=>({intervalData:[]}),getInactiveEventIntervalStrKeys:()=>[],
  eventManager:{config:{enabled:false}},joinLobbyAckPayloadCache:new Map(),sha1Buffer:()=>"synthetic-cache-key",rememberJoinLobbyAckPayload:()=>{},
  combatHandler:{mergeJoinLobbyAck(_official,_local,options){mergeOptions=options;return{ok:true,payload:Buffer.from("synthetic-merged-205")};}},
});
vm.runInContext(extract("getIntervalPayloadStrKeys","buildIntervalData"),sandbox);
vm.runInContext(extract("mergeTags","parseGameUnitGroups"),sandbox);
vm.runInContext(extract("buildJoinLobbyAckPayload","rememberJoinLobbyAckPayload"),sandbox);
sandbox.buildJoinLobbyAckPayload(user);
assert.equal(mergeOptions.preserveOfficialContractData,true);
assert.equal(mergeOptions.copyIntervalData,true,"production merge must copy the guild calendar even when all other event intervals are absent");
assert(mergeOptions.mergeIntervalStrKeys.includes(expected.strKey),"production native-merge allowlist must include the selected guild calendar");
assert(!mergeOptions.mergeIntervalStrKeys.includes(retained.strKey),"the guild patch must not request an unrelated event-calendar replacement");
if(process.argv[2]) {
  const fixture=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  fixture.interval={m_DateStart:selected[0].startDate.toISOString(),m_DateEnd:selected[0].endDate.toISOString(),m_DateStrID:selected[0].strKey};
  fixture.infoPayloadBase64=guild.encodeFields(schema.packets[3472].fields,info).toString("base64");
  fixture.memberPayloadBase64=guild.encodeFields(schema.packets[3474].fields,member).toString("base64");
  fixture.productionIntervalPayloadBase64=sandbox.buildJoinLobbyIntervalDataList(user).find(payload=>decodeInterval(payload).strKey===expected.strKey).toString("base64");
  fs.writeFileSync(process.argv[2],JSON.stringify(fixture,null,2)+"\n");
}
console.log("[guild-interval-listener] PASS real production lobby/required/codec functions; selected guild interval wins collisions, other intervals remain unchanged, INFO/MEMBER match the same calendar");
