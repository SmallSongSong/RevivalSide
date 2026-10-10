"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../server/listener.js"), "utf8");
const start = source.indexOf("function releaseGuildBattleForSocket(");
const end = source.indexOf("function abandonDynamicBattle(", start);
assert(start >= 0 && end > start);
let contexts = 0, cancels = 0, failures = 0;
const sandbox = { Boolean, createPacketContext() { contexts++; return {}; },
  cancelGuildBattle() { cancels++; throw new Error("guild cooperative season unavailable"); },
  summarizeErrorLine: (error) => error.message, console: { log() { failures++; } } };
vm.createContext(sandbox); vm.runInContext(source.slice(start,end),sandbox);
for (const socket of [undefined,{session:{}},{session:{user:{guildUid:"1"},gameReplay:{dynamicGame:null}}},{session:{gameReplay:{dynamicGame:{miscMode:"dungeon"}}}}])
  assert.equal(sandbox.releaseGuildBattleForSocket(socket,"disconnect"),false);
assert.equal(contexts,0);assert.equal(cancels,0,"normal login disconnects must not initialize guild calendars");
assert.equal(sandbox.releaseGuildBattleForSocket({session:{user:{},gameReplay:{dynamicGame:{guildBattleToken:"synthetic"}}}},"disconnect"),false);
assert.equal(cancels,1);assert.equal(failures,1,"a reservation error is diagnostic and must not become uncaught");
assert(source.includes('releaseGuildBattleForSocket(socket, "disconnect");'));
console.log("[guild-disconnect-safety] PASS ordinary/empty sessions skip calendar work; real guild cleanup errors cannot crash the listener");
