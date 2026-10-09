"use strict";

const assert = require("node:assert/strict");
const guild = require("../modules/guild");
const codec = require("../modules/packet-codec");
const { setMiscItemBalance, getMiscItem } = require("../modules/inventory");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const path = require("node:path");
const schema = require("../packet-schema.json");

function readGuildAck(packetId, payload) {
  let offset = 0;
  function scalar(reader) {
    const result = reader(payload, offset);
    offset = result.offset;
    return result.value;
  }
  function uint() {
    let value = 0;
    let shift = 0;
    while (offset < payload.length) {
      const byte = payload[offset++];
      value |= (byte & 127) << shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error("truncated guild list length");
  }
  function fields(definition) {
    return Object.fromEntries(definition.map(field => [field.name, wire(field.wire)]));
  }
  function wire(definition) {
    if (definition.kind === "list") return Array.from({ length: uint() }, () => wire(definition.element));
    if (definition.kind === "object") {
      if (!scalar(codec.readBool)) return null;
      if (definition.type === "NKMItemMiscData") {
        const item = { itemId: scalar(codec.readSignedVarInt), countFree: scalar(codec.readSignedVarLong), countPaid: scalar(codec.readSignedVarLong), bonusRatio: scalar(codec.readSignedVarInt), regDate: payload.readBigInt64LE(offset) };
        offset += 8;
        return item;
      }
      assert(schema.types[definition.type], `no ACK reader for ${definition.type}`);
      return fields(schema.types[definition.type].fields);
    }
    if (definition.type === "string") return scalar(codec.readString);
    if (definition.type === "bool") return scalar(codec.readBool);
    if (definition.type === "long") return scalar(codec.readSignedVarLong);
    if (definition.type === "DateTime") { const value = payload.readBigInt64LE(offset); offset += 8; return value; }
    return scalar(codec.readSignedVarInt);
  }
  const result = fields(schema.packets[packetId].fields);
  assert.equal(offset, payload.length, "the complete native ACK body must be consumed");
  return result;
}

let now = new Date("2026-10-08T02:00:00Z");
let saves = 0;
const owner = { userUid: "1", friendCode: "101", nickname: "Owner", level: 20, inventory: {} };
const guest = { userUid: "2", friendCode: "102", nickname: "Guest", level: 20, inventory: {} };
setMiscItemBalance(owner, 101, 1500);
setMiscItemBalance(owner, 1, 500000);
const ctx = { userDb: { users: { 1: owner, 2: guest } }, config: { USE_LOCAL_USER_DB: true }, getServerNowDate: () => now, getServerEventDateKey: () => now.toISOString().slice(0, 10), saveUserDb: () => { saves += 1; }, decryptCopy: p => p, sendGameResponse(_s, _p, id, payload) { this.lastAck = { id, payload }; } };

function request(user, id, req) {
  return guild.handleRequest(ctx, user, id, req);
}

assert.equal(guild.getGuildNameLength("Guild123"), 8);
assert.equal(guild.getGuildNameLength("公会"), 4, "native nickname length counts CJK characters as two units");
for (const name of ["song", "ab", "AbCd1234", "公", "公会", "公".repeat(8), "カウンター", "길드"]) assert(guild.isValidGuildName(name), `native-compatible guild name ${name}`);
for (const name of ["", "a", "a".repeat(17), "公".repeat(9), "Guild Name", " Guild", "Guild\n", "Guild_", "Guild!", "😀Guild"]) assert.equal(guild.isValidGuildName(name), false, `invalid guild name ${JSON.stringify(name)}`);

const result = request(owner, 3400, { guildName: "LocalGuild", guildJoinType: 0, badgeId: "0", greeting: "Welcome" });
const uid = owner.guildUid;
assert.notEqual(uid, "0");
assert.equal(result.guildData.members[0].commonProfile.userUid, "1");
assert.equal(result.guildData.guildState, 1, "bundled client GuildState.Created is 1");
assert.equal(getMiscItem(owner, 101).countFree, "500", "create cost is deducted once");
assert.throws(() => request(owner, 3400, { guildName: "Again", guildJoinType: 0 }), /already/);
assert.equal(getMiscItem(owner, 101).countFree, "500");
assert.equal(request(guest, 3406, { keyword: "guild" }).list.length, 1);
assert.equal(request(guest, 3410, { guildUid: uid }).needApproval, false);
assert.equal(guest.guildUid, uid);
assert.equal(request(owner, 3414, { guildUid: uid }).guildData.members.length, 2);
assert.throws(() => request(guest, 3443, { guildUid: uid, notice: "bad" }), /master/);
request(owner, 3443, { guildUid: uid, notice: "Local notice" });
assert.equal(ctx.userDb.guilds[uid].notice, "Local notice");

const attendance = request(owner, 3447, { guildUid: uid });
assert.equal(BigInt(attendance.lastAttendanceDate) & 0x4000000000000000n, 0x4000000000000000n, "guild DateTime carries the client UTC kind bit");
assert.equal(attendance.todayAttendanceCount, 1);
assert.equal(getMiscItem(owner, 21).countFree, "50");
assert.equal(attendance.additionalReward.guildExpDelta, 50);
request(owner, 3447, { guildUid: uid });
assert.equal(getMiscItem(owner, 21).countFree, "50", "same day attendance grants once");
const donation = request(owner, 3461, { guildUid: uid, donationId: 2, donationCount: 2 });
assert.equal(getMiscItem(owner, 1).countFree, "440000");
assert.equal(getMiscItem(owner, 21).countFree, "150");
assert.equal(ctx.userDb.guilds[uid].unionPoint, "40");
assert.equal(donation.additionalReward.guildExpDelta, 40);
assert.equal(donation.donationCount, 2);
assert.equal(getMiscItem(owner, 24).countFree, "0", "union funds stay in the guild");
assert.equal(getMiscItem(owner, 503).countFree, "0", "guild experience is not an inventory item");
assert.throws(() => request(owner, 3461, { guildUid: uid, donationId: 2, donationCount: 7 }), /daily/);
assert.equal(getMiscItem(owner, 1).countFree, "440000");
setMiscItemBalance(guest, 1, 0);
assert.throws(() => request(guest, 3461, { guildUid: uid, donationId: 2, donationCount: 1 }), /insufficient/);
assert.equal(getMiscItem(guest, 1).countFree, "0");

now = new Date("2026-10-09T02:00:00Z");
request(owner, 3447, { guildUid: uid });
assert.equal(getMiscItem(owner, 21).countFree, "200");
request(owner, 3461, { guildUid: uid, donationId: 2, donationCount: 1 });
assert.equal(owner.privateGuildData.donationCount, 1);
const message = request(owner, 3451, { guildUid: uid, messageType: 0, emotionId: 0, message: "hello guild" });
assert.equal(message.messageUid, "1");
assert.equal(request(guest, 3454, { guildUid: uid }).messages[0].message, "hello guild");

const registry = loadPacketHandlers([path.resolve(__dirname, "../packet-handlers"), path.resolve(__dirname, "../modules")], { rootDir: path.resolve(__dirname, "..") });
assert(registry.get(3400).fileName.startsWith("modules/guild/handlers/"));
const packetOwner = { userUid: "3", friendCode: "103", nickname: "PacketOwner", level: 20, inventory: {} };
setMiscItemBalance(packetOwner, 101, 1500);
setMiscItemBalance(packetOwner, 1, 60000);
let persistedPacketDb;
const membershipNotifications = [];
const packetCtx = { ...ctx, userDb: { users: { 3: packetOwner } }, saveUserDb() { persistedPacketDb = JSON.parse(JSON.stringify(this.userDb)); }, sendServerGamePacket(_socket, id, payload) { membershipNotifications.push({ id, payload }); } };
const packetSocket = { session: { user: packetOwner } };
const badgeId = 8005011002n;
const createPacket = { sequence: 1, payload: Buffer.concat([codec.writeString("PacketGuild"), codec.writeSignedVarInt(0), codec.writeSignedVarLong(badgeId), codec.writeString("Welcome")]) };
assert.doesNotThrow(() => registry.get(3400).handle(packetCtx, packetSocket, createPacket), "successful CREATE must send its native item-cost ACK without dropping the connection");
assert.equal(packetCtx.lastAck.id, 3401);
const createAck = readGuildAck(3401, packetCtx.lastAck.payload);
assert.equal(createAck.errorCode, 0);
assert.equal(createAck.costItemDataList.length, 1);
assert.equal(createAck.costItemDataList[0].itemId, 101);
assert.equal(createAck.costItemDataList[0].countFree, 500n);
assert.equal(createAck.guildData.badgeId, badgeId, "native badge IDs must retain all 64-bit data");
assert.equal(createAck.guildData.members[0].grade, 0);
assert.equal(createAck.privateGuildData.guildUid, createAck.guildData.guildUid);
assert.equal(persistedPacketDb.users[3].guildUid, createAck.guildData.guildUid.toString());
assert.equal(Object.keys(persistedPacketDb.guilds).length, 1);
registry.get(3400).handle(packetCtx, packetSocket, createPacket);
assert.equal(readGuildAck(3401, packetCtx.lastAck.payload).errorCode, 20431, "already-created membership must report already joined, never invalid name");
assert.equal(getMiscItem(packetOwner, 101).countFree, "500");
assert.equal(membershipNotifications.at(-1).id, 3416, "existing members receive their real guild data to restore the client guild page");
assert.equal(readGuildAck(3416, membershipNotifications.at(-1).payload).guildData.guildUid.toString(), packetOwner.guildUid);
const secondName = { ...createPacket, payload: Buffer.concat([codec.writeString("AnotherName"), codec.writeSignedVarInt(0), codec.writeSignedVarLong(badgeId), codec.writeString("")]) };
registry.get(3400).handle(packetCtx, packetSocket, secondName);
assert.equal(readGuildAck(3401, packetCtx.lastAck.payload).errorCode, 20431, "changing names cannot bypass an existing membership");
assert.equal(getMiscItem(packetOwner, 101).countFree, "500");
assert.equal(Object.keys(packetCtx.userDb.guilds).length, 1);
const outsider = { userUid: "4", level: 20, inventory: {} };
setMiscItemBalance(outsider, 101, 1500);
packetCtx.userDb.users[4] = outsider;
const outsiderSocket = { session: { user: outsider } };
registry.get(3400).handle(packetCtx, outsiderSocket, createPacket);
assert.equal(readGuildAck(3401, packetCtx.lastAck.payload).errorCode, 20442, "true duplicate names have the native duplicate-name code");
registry.get(3400).handle(packetCtx, outsiderSocket, { ...createPacket, payload: Buffer.concat([codec.writeString("Guild Name"), codec.writeSignedVarInt(0), codec.writeSignedVarLong(badgeId), codec.writeString("")]) });
assert.equal(readGuildAck(3401, packetCtx.lastAck.payload).errorCode, 20436, "invalid character or length has the native invalid-name code");
assert.equal(getMiscItem(outsider, 101).countFree, "1500");
assert.equal(guild.buildGuildDataUpdatedNotPayload(packetCtx, outsider), null, "guildless accounts must not receive another account's guild membership");
assert.equal(readGuildAck(3416, guild.buildGuildDataUpdatedNotPayload(packetCtx, packetOwner)).guildData.guildUid.toString(), packetOwner.guildUid, "login boot can restore native MyGuildData for an existing member");
const packetGuildUid = BigInt(packetOwner.guildUid);
registry.get(3414).handle(packetCtx, packetSocket, { sequence: 2, payload: codec.writeSignedVarLong(packetGuildUid) });
assert.equal(readGuildAck(3415, packetCtx.lastAck.payload).guildData.guildUid, packetGuildUid);
assert.doesNotThrow(() => registry.get(3461).handle(packetCtx, packetSocket, { sequence: 3, payload: Buffer.concat([codec.writeSignedVarLong(packetGuildUid), codec.writeSignedVarInt(2), codec.writeSignedVarInt(1)]) }), "donation must serialize its native item-cost list");
assert.equal(packetCtx.lastAck.id, 3462);
assert.equal(codec.readSignedVarInt(packetCtx.lastAck.payload).value, 0);
assert.equal(getMiscItem(packetOwner, 1).countFree, "30000");
assert.doesNotThrow(() => registry.get(3466).handle(packetCtx, packetSocket, { sequence: 4, payload: Buffer.concat([codec.writeSignedVarLong(packetGuildUid), codec.writeSignedVarInt(1)]) }), "welfare-point purchase must serialize its native item-cost list");
assert.equal(packetCtx.lastAck.id, 3467);
assert.equal(codec.readSignedVarInt(packetCtx.lastAck.payload).value, 0);
assert.equal(getMiscItem(packetOwner, 101).countFree, "470");
assert.equal(codec.readSignedVarLong(guild.buildPrivateGuildData(persistedPacketDb.users[3], { now, userDb: persistedPacketDb })).value, packetGuildUid, "the persisted guild remains visible after restoring the login membership");
const socket = { session: { user: owner } };
registry.get(3414).handle(ctx, socket, { sequence: 1, payload: codec.writeSignedVarLong(BigInt(uid)) });
assert.equal(ctx.lastAck.id, 3415);
assert.equal(codec.readSignedVarInt(ctx.lastAck.payload).value, 0);
assert(ctx.lastAck.payload.length > 40, "guild ACK includes data and members");
registry.get(3400).handle(ctx, socket, { sequence: 1, payload: Buffer.from([0xff]) });
assert.notEqual(codec.readSignedVarInt(ctx.lastAck.payload).value, 0, "malformed requests fail without creating a guild");
registry.get(3477).handle(ctx, socket, { sequence: 1, payload: Buffer.alloc(0) });
assert.notEqual(codec.readSignedVarInt(ctx.lastAck.payload).value, 0, "unimplemented dungeon rewards do not report success");
assert(saves > 0);

const info = request(owner, 3471, { guildUid: uid });
assert(info.seasonId > 0 && info.bossData.stageId > 0);
assert(info.bossData.remainHp > 1000000, "guild boss HP is absolute HP from the real boss stats");
assert(info.arenaList.length > 0);
const { ensureArmy, setDeckUnit, ensureDeck } = require("../modules/unit");
owner.army = { units: {
  101: { unitUid: "101", userUid: "1", unitId: 1001, level: 120 },
  102: { unitUid: "102", userUid: "1", unitId: 1002, level: 120 },
}, ships: {}, operators: {} };
ensureArmy(owner);
setDeckUnit(owner, { deckType: 1, index: 1 }, 0, "101");
setDeckUnit(owner, { deckType: 4, index: 1 }, 12, "102");
assert.equal(ensureDeck(owner, { deckType: 4, index: 1 }).unitUids.length, 16);
ctx.getGenericStageForRequest = req => ({ stageId: req.stageID, dungeonID: req.dungeonID, mapID: 1 });
let practiceStarted = null;
ctx.config.DYNAMIC_BATTLE_MANAGER = true;
ctx.sendDynamicGameLoadAck = (_socket, req, stage) => { practiceStarted = { req, stage }; return true; };
registry.get(3485).handle(ctx, socket, { sequence: 1, payload: Buffer.concat([codec.writeByte(1), codec.writeSignedVarInt(info.bossData.stageId), codec.writeBool(true)]) });
assert.equal(practiceStarted.req.gameType, 25);
assert.equal(practiceStarted.stage.miscMode, "guild-practice");
assert.equal(practiceStarted.stage.playerDeck.deckType, 4);
assert.equal(practiceStarted.stage.playerDeck.deckIndex, 1);
assert.deepEqual(practiceStarted.stage.playerDeck.units.map(u => u.unitUid), ["102"], "Boss training uses the selected 16-slot raid squad");
assert.equal(practiceStarted.req.raidUID, undefined, "practice cannot attach to a world raid");
registry.get(3485).handle(ctx, socket, { sequence: 1, payload: Buffer.concat([codec.writeByte(1), codec.writeSignedVarInt(info.bossData.stageId), codec.writeBool(false)]) });
assert.equal(ctx.lastAck.id, 804);
assert.notEqual(codec.readSignedVarInt(ctx.lastAck.payload).value, 0, "unsupported multiplayer raid does not grant training rewards");
const welfare = request(owner, 3466, { guildUid: uid, buyCount: 2 });
assert.equal(getMiscItem(owner, 101).countFree, "440");
assert.equal(getMiscItem(owner, 23).countFree, "10");
assert(welfare.rewardData.length > 0);
const renamed = request(owner, 3500, { newName: "RenamedGuild" });
assert.equal(renamed.prevName, "LocalGuild");
assert.equal(guest.guildName, "RenamedGuild");
assert.throws(() => request(owner, 3500, { newName: "AnotherGuild" }), /cooldown/);
request(owner, 3402, { guildUid: uid });
assert.equal(ctx.userDb.guilds[uid].guildState, 2);
assert.throws(() => request({ userUid: "3", guildUid: "0" }, 3410, { guildUid: uid }), /closed/);
request(owner, 3404, { guildUid: uid });
assert.equal(ctx.userDb.guilds[uid].guildState, 1);
const restarted = JSON.parse(JSON.stringify(ctx.userDb));
assert.equal(restarted.guilds[uid].members.length, 2);
assert.equal(restarted.users[1].guildUid, uid);
assert.equal(restarted.users[1].privateGuildData.donationCount, 1);
assert.equal(codec.readSignedVarLong(guild.buildPrivateGuildData(restarted.users[1])).value.toString(), uid);
const clonedDb = JSON.parse(JSON.stringify(restarted));
const clone = { ...JSON.parse(JSON.stringify(clonedDb.users[1])), userUid: "3" };
clonedDb.users[3] = clone;
guild.buildPrivateGuildData(clone, { now, userDb: clonedDb });
assert.equal(clone.guildUid, "0", "cloned profiles do not inherit guild membership or leadership");
assert.equal(clone.archivedGuildMembership.reason, "account-not-in-members");
assert.equal(clonedDb.users[1].guildUid, uid, "real members retain their original membership");
const profileOnly = { users: { 1: JSON.parse(JSON.stringify(restarted.users[1])) } };
guild.buildPrivateGuildData(profileOnly.users[1], { now, userDb: profileOnly });
assert.equal(profileOnly.users[1].guildUid, "0", "profile import without a guild database can create a new local guild");
assert.equal(profileOnly.users[1].archivedGuildMembership.guildUid, uid);
request(owner, 3438, { guildUid: uid, targetUserUid: "2" });
assert.equal(ctx.userDb.guilds[uid].masterUserUid, "2");
request(owner, 3428, { guildUid: uid });
assert.equal(owner.guildUid, "0");
request(guest, 3428, { guildUid: uid });
assert.equal(Object.keys(ctx.userDb.guilds).length, 0);
now = new Date("2026-10-10T02:00:00Z");
guild.buildPrivateGuildData(restarted.users[1], { now });
assert.equal(restarted.users[1].privateGuildData.donationCount, 0, "login resets yesterday's donation limit");
const eventClockUser = { privateGuildData: { resetDay: "2026-10-08", donationCount: 4 } };
guild.buildPrivateGuildData(eventClockUser, { now: new Date("2026-10-09T01:00:00Z"), eventDateKey: "2026-10-08" });
assert.equal(eventClockUser.privateGuildData.donationCount, 4, "login follows the same event day as donation requests");
guild.buildPrivateGuildData(eventClockUser, { now: new Date("2026-10-09T04:00:00Z"), eventDateKey: "2026-10-09" });
assert.equal(eventClockUser.privateGuildData.donationCount, 0);
console.log("[local-guild] PASS creation, persistence, membership, permissions, attendance, donation, chat and real handler precedence");
