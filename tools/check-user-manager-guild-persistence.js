"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createUserManager } = require("../server/userManager");
const guild = require("../modules/guild");
const { setMiscItemBalance } = require("../modules/inventory");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-guild-db-"));
  const userDbPath = path.join(directory, "users.json");
  const owner = { userUid: "1", friendCode: "101", nickname: "SyntheticOwner", level: 20, inventory: {} };
  setMiscItemBalance(owner, 101, 1500);
  const incoming = { schemaVersion: 1, nextUserUid: "2", nextFriendCode: "102", activeUserUid: "1", users: { 1: owner } };
  const now = new Date("2026-10-09T00:00:00Z");
  const result = guild.handleRequest({ userDb: incoming, getServerNowDate: () => now }, owner, 3400, { guildName: "GuildBackup", guildJoinType: 0, badgeId: "8005011002", greeting: "Synthetic data" });
  const guildUid = result.guildData.guildUid;
  incoming.guilds[guildUid].notice = "Keep the full guild record";
  incoming.guilds[guildUid].trainingSession = { bossStageId: 8011301, history: [1, 2] };
  const expectedGuild = JSON.parse(JSON.stringify(incoming.guilds[guildUid]));
  const target = { schemaVersion: 1, nextUserUid: "10", nextFriendCode: "110", activeUserUid: "9", users: { 9: { userUid: "9", friendCode: "109", nickname: "Previous" } } };
  let saves = 0;
  const manager = createUserManager({ userDb: target, userDbPath, activeUserPath: path.join(directory, "active-user.json"), saveUserDb() { saves += 1; fs.writeFileSync(userDbPath, JSON.stringify(target)); }, makeAccessToken: () => "synthetic-token", makeToken: prefix => `${prefix}-synthetic-token` });
  const server = http.createServer((req, res) => { manager.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(error => { res.writeHead(500); res.end(error.message); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const replaced = await request(port, "PUT", "/user-manager/api/db", incoming);
    assert.equal(replaced.statusCode, 200);
    assert.deepEqual(target.guilds[guildUid], expectedGuild, "full DB load must preserve every guild field, including future fields");
    assert.equal(target.guilds[guildUid].masterUserUid, "1");
    assert.equal(target.guilds[guildUid].members[0].grade, 0);
    assert.equal(target.users[1].guildUid, guildUid);
    assert.equal(Object.keys(target.guilds).length, 1);
    assert.equal(saves, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(userDbPath)).guilds[guildUid], expectedGuild, "full DB replacement must persist the guild to disk");
    const exportedDb = await request(port, "GET", "/user-manager/api/db");
    assert.deepEqual(exportedDb.json.db.guilds[guildUid], expectedGuild);

    target.guilds = {};
    const reload = await request(port, "POST", "/user-manager/api/reload", {});
    assert.equal(reload.statusCode, 200);
    assert.deepEqual(target.guilds[guildUid], expectedGuild, "reload must retain the original guild and master");
    assert.equal(saves, 1, "reload reads the complete database without saving a partial replacement");
    assert(guild.buildGuildDataUpdatedNotPayload({ userDb: target, getServerNowDate: () => now }, target.users[1]), "a restored member must still receive its valid guild bootstrap");

    const beforeInvalid = JSON.stringify(target);
    for (const guilds of [[], null, "invalid", { [guildUid]: [] }, { [guildUid]: { ...expectedGuild, guildUid: "wrong" } }, { [guildUid]: { ...expectedGuild, members: {} } }, { [guildUid]: { ...expectedGuild, members: [null] } }]) {
      const invalid = await request(port, "PUT", "/user-manager/api/db", { ...incoming, guilds });
      assert.equal(invalid.statusCode, 400);
      assert.equal(JSON.stringify(target), beforeInvalid, "rejected guild input must not alter the live database");
    }
    assert.equal(saves, 1);

    const profileExport = await request(port, "GET", "/user-manager/api/users/1/export-json");
    assert.equal(profileExport.statusCode, 200);
    assert.equal(profileExport.json.db.guilds, undefined, "single profile export must not copy the multi-account guild database");
    const cloned = await request(port, "POST", "/user-manager/api/users/1/clone", { nickname: "SyntheticClone" });
    assert.equal(cloned.statusCode, 201);
    const clone = target.users[cloned.json.user.userUid];
    guild.buildPrivateGuildData(clone, { now, userDb: target });
    assert.equal(clone.guildUid, "0", "cloning must not inherit guild membership or master permission");
    assert.equal(clone.archivedGuildMembership.reason, "account-not-in-members");
    assert.deepEqual(target.guilds[guildUid], expectedGuild);

    const copied = await request(port, "POST", "/user-manager/api/users/import-json-profile", { db: { ...incoming, guilds: { unrelated: { guildUid: "unrelated", members: [] } } } });
    assert.equal(copied.statusCode, 201);
    const imported = target.users[copied.json.user.userUid];
    guild.buildPrivateGuildData(imported, { now, userDb: target });
    assert.equal(imported.guildUid, "0");
    assert.equal(imported.archivedGuildMembership.reason, "account-not-in-members");
    assert.equal(target.guilds.unrelated, undefined, "single profile import ignores incoming guild records");
    assert.deepEqual(target.guilds[guildUid], expectedGuild);
    assert.equal(target.users[1].guildUid, guildUid);

    const legacy = await request(port, "PUT", "/user-manager/api/db", { schemaVersion: 1, activeUserUid: "9", users: { 9: { userUid: "9", friendCode: "109" } } });
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(target.guilds, {}, "loading a guildless legacy database cannot inherit the previous database's guilds");
    console.log("[user-manager-guild-persistence] PASS complete DB PUT/export/reload preserve guild and master; invalid input is atomic; single-profile copy and clone do not inherit membership");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function request(port, method, pathname, data) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? "" : JSON.stringify(data);
    const req = http.request({ hostname: "127.0.0.1", port, method, path: pathname, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ statusCode: res.statusCode, json: text ? JSON.parse(text) : null }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
