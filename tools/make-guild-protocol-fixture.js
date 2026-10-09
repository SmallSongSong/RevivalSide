"use strict";

// Generate public synthetic data through the actual CREATE packet handler.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const guild = require("../modules/guild");
const codec = require("../modules/packet-codec");
const { setMiscItemBalance } = require("../modules/inventory");
const { dateTimeBinaryForDate } = require("../modules/server-time");

if (process.argv.length !== 3) throw new Error("Usage: node tools/make-guild-protocol-fixture.js <output JSON path>");
const now = new Date("2026-10-09T00:00:00Z");
const user = { userUid: "3", friendCode: "103", nickname: "SyntheticOwner", level: 20, inventory: {} };
setMiscItemBalance(user, 101, 1500, 0, { regDate: String(dateTimeBinaryForDate(now)) });
let ack;
let persisted;
const ctx = { userDb: { users: { 3: user } }, config: { USE_LOCAL_USER_DB: true }, getServerNowDate: () => now, getServerEventDateKey: () => "2026-10-09", decryptCopy: payload => payload, saveUserDb() { persisted = JSON.parse(JSON.stringify(this.userDb)); }, sendGameResponse(_socket, _request, id, payload) { ack = { id, payload }; } };
const handler = guild.createGuildHandlers().find(h => h.packetId === 3400);
handler.handle(ctx, { session: { user } }, { sequence: 1, payload: Buffer.concat([codec.writeString("SyntheticGuild"), codec.writeSignedVarInt(0), codec.writeSignedVarLong(8005011002n), codec.writeString("Public protocol fixture")]) });
assert.equal(ack.id, 3401);
assert.equal(codec.readSignedVarInt(ack.payload).value, 0);
assert.equal(persisted.users[3].guildUid, user.guildUid);
const nameValidation = ["song", "a", "AbCd1234", "公会", "公".repeat(8), "公".repeat(9), "カウンター", "길드", "Guild Name", "Guild_", "😀Guild"].map(name => ({ name, weightedLength: guild.getGuildNameLength(name), valid: guild.isValidGuildName(name) }));
fs.writeFileSync(path.resolve(process.argv[2]), `${JSON.stringify({ guildUid: Number(user.guildUid), createPayloadBase64: ack.payload.toString("base64"), guildDataUpdatedPayloadBase64: guild.buildGuildDataUpdatedNotPayload(ctx, user).toString("base64"), nameValidation }, null, 2)}\n`);
console.log("Synthetic guild CREATE_ACK fixture generated from the real packet handler.");
