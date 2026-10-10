"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,"../server/listener.js"),"utf8");
const apiStart = source.indexOf("async function serveLauncherApi(");
const apiEnd = source.indexOf("function sendJsonResponse(",apiStart);
const warmStart = source.indexOf("function warmLauncherRuntime(");
const warmEnd = source.indexOf("function createOfficialProfileImporterForRuntime(",warmStart);
assert(apiStart >= 0 && apiEnd > apiStart && warmStart >= 0 && warmEnd > warmStart);
const status = {enabled:true,ready:false,error:"native initialization failed"};
let lobbyFailure = false;
let requests = 0;
const sandbox = {
  URL, Buffer, Date, console:{log(){}}, MIRROR_PUBLIC_BASE_URL:"http://127.0.0.1:8088",
  isLoopbackAddress:address=>address === "127.0.0.1",
  combatHandler:{getStartupStatus:()=>({...status})}, tcpServerListening:false,
  PORT:7100,HTTP_MIRROR_PORT:8088,userManager:null,serverTime:{getSummary:()=>({})},
  sendJsonResponse(_res,code,body){ sandbox.reply={code,body}; },
  getJoinLobbyWarmupUsers:()=>[{}], ensureUserDefaults:user=>user,prepareTutorialLogin(){},
  prepareUserLobbySession(){requests++; if(lobbyFailure) throw Error("lobby data failed");},
  prewarmJoinLobbyAckPayload:()=>Buffer.alloc(32), joinLobbyAckPayloadCache:new Map(),
  USE_LOCAL_USER_DB:false,summarizeErrorLine:error=>String(error).split("\n")[0],
};
vm.createContext(sandbox);
vm.runInContext(source.slice(apiStart,apiEnd)+source.slice(warmStart,warmEnd),sandbox);
async function request(route,method="GET",address="127.0.0.1") {
  assert(await sandbox.serveLauncherApi({url:route,method,socket:{remoteAddress:address}},{}));
  return sandbox.reply;
}
(async()=>{
  let reply = await request("/launcher/api/health");
  assert.equal(reply.body.ok,false);
  assert.equal(reply.body.combatHost.error,status.error);
  sandbox.tcpServerListening=true;
  reply = await request("/launcher/api/warmup","POST");
  assert.equal(reply.body.ok,false);
  assert.equal(requests,0,"failed native startup must not warm or save lobby data");
  status.ready=true;
  status.error="";
  sandbox.tcpServerListening=false;
  assert.equal((await request("/launcher/api/health")).body.ok,false,"HTTP alone does not mean game TCP is ready");
  sandbox.tcpServerListening=true;
  assert.equal((await request("/launcher/api/health")).body.ok,true);
  assert.equal((await request("/launcher/api/warmup","POST")).body.ok,true);
  lobbyFailure=true;
  reply = await request("/launcher/api/warmup","POST");
  assert.equal(reply.body.ok,false,"a reachable listener with failed lobby preparation cannot complete the app progress screen");
  assert.equal(reply.body.joinLobbyAck.failed,1);
  assert.equal((await request("/launcher/api/health","GET","192.0.2.1")).code,403);
  console.log("[launcher-readiness] PASS production health/warmup routes: native failure, TCP binding, lobby warmup failure/success and loopback restriction");
})().catch(error=>{console.error(error);process.exitCode=1;});
