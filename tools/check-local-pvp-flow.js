"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const localPvp = require("../modules/local-pvp");
const giveup = require("../packet-handlers/0823-game-giveup-req");

const source = fs.readFileSync(require.resolve("../server/listener"), "utf8");
const start = source.indexOf("function sendManagedOrImmediatePacket(");
const end = source.indexOf("function sendPendingGameStartSync(", start);
assert(start > 0 && end > start);
const sent = [];
let saves = 0;
let pveResults = 0;
let stops = 0;
let missionEvents = 0;
const sandbox = {
  localPvp, USE_LOCAL_USER_DB: true, GAME_END_NOT: 811,
  extractManagedBattleWin: meta => meta.battleWin,
  extractManagedBattleRecords: meta => meta.battleRecords || [],
  extractManagedBattlePlayTime: meta => meta.battlePlayTime || 0,
  getBattleEndPlayTime: state => state.gameTime || 0,
  getServerNowDate: () => new Date("2026-10-08T02:00:00Z"),
  isBattleWin: state => state.win === true,
  buildBattleGameRecordState: state => state,
  buildBattleGameRecordData: () => Buffer.alloc(18),
  saveUserDb: () => { saves++; },
  trackMissionEvent: (_user, event) => { assert.equal(event, "PVP_PLAY_ASYNC"); missionEvents++; return false; },
  stopGameSyncTimers: () => { stops++; },
  sendServerGamePacket: (_socket, id, payload) => sent.push({ id, payload }),
  normalizeManagedCombatPayload: (_socket, _id, payload) => { pveResults++; return payload; },
};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end), sandbox);

const deck = { userUid: "1", nickname: "Player", userLevel: 30, shipUid: "10", shipUnitId: 10001, shipLevel: 100,
  units: [{ unitUid: "11", unitId: 1002, level: 100, skillLevels: [5, 5, 5, 5, 5], equipItemUids: [] }] };
const user = { userUid: "1", level: 30, army: { units: {}, ships: {}, decks: {} }, inventory: {} };
const match = { target: { friendCode: "900000001", deck: localPvp.cloneDeck(deck) }, playerDeck: deck, deckIndex: 0, gameType: 7 };
const socket = { session: { user, gameReplay: { dynamicGame: { miscMode: "local-pvp", gameUID: "123" },
  localPvpMatch: match, battleState: { win: false, gameTime: 50 } } } };

sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.from("pve-end"), "end", { battleWin: true });
sandbox.sendManagedOrImmediatePacket(socket, 811, Buffer.from("pve-end"), "end", { battleWin: false });
assert.deepEqual(sent.map(packet => packet.id), [2623], "managed PvP ends use the strategy arena result protocol once");
assert(sent[0].payload.length > 20);
assert.equal(pveResults, 0, "a bot battle cannot enter PvE reward normalization");
assert.equal(saves, 1);
assert.equal(user.pvp.local.wins, 1, "managed winner takes precedence over stale battle state");
assert.equal(user.pvp.local.history.length, 1);
assert.equal(stops, 1);
assert.equal(missionEvents, 1, "one completed bot battle counts once toward arena missions");

socket.session.gameReplay.localPvpMatch = { ...match, resultSent: false, endPayload: null, settled: false };
socket.session.gameReplay.dynamicGame.gameUID = "124";
let abandoned = 0;
giveup.handle({
  sendGameResponse: (_socket, _packet, id) => sent.push({ id }),
  constants: { GAME_GIVEUP_ACK: 824 }, writeSignedVarInt: () => Buffer.from([0]),
  sendLocalPvpGameEnd: sandbox.sendLocalPvpGameEnd,
  abandonDynamicBattle: () => { abandoned++; },
}, socket, {});
assert.deepEqual(sent.slice(1).map(packet => packet.id), [824, 2623]);
assert.equal(user.pvp.local.losses, 1);
assert.equal(user.pvp.local.history.length, 2);
assert.equal(abandoned, 1);
assert.equal(pveResults, 0);
console.log("[local-pvp-flow] PASS managed result routing, authoritative winner, one settlement, and giveup");
