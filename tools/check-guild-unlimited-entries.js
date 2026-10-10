"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const guild = require("../modules/guild");
const cooperative = require("../modules/guild/cooperative");
const { ensureArmy, setDeckUnit, setDeckShip } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const schema = require("../packet-schema.json");

const clock = new Date("2025-04-10T19:21:27Z");
const user = { userUid: "1", friendCode: "101", nickname: "UnlimitedOwner", level: 100, inventory: {}, army: {
  units: { 101: { unitUid: "101", userUid: "1", unitId: 1001, level: 120 } },
  ships: { 201: { unitUid: "201", userUid: "1", unitId: 21001, level: 100 } }, operators: {},
} };
ensureArmy(user);
for (const deckType of [1, 4]) {
  setDeckUnit(user, { deckType, index: 0 }, 0, "101");
  setDeckShip(user, { deckType, index: 0 }, "201");
}
setMiscItemBalance(user, 101, 1500);
const ctx = { userDb: { users: { 1: user } }, getServerNowDate: () => clock,
  getEffectiveContentsTags: () => ["GUILD_DUNGEON_SEASON_DEMOLTION_2025_2", "GUILD_DUNGEON_SEASON_GIGAS_2025_2"],
  getGenericStageForRequest: req => ({ dungeonID: req.dungeonID, stageId: req.dungeonID, mapID: 1, eventDeckId: 0 }),
};
guild.handleRequest(ctx, user, 3400, { guildName: "UnlimitedGuild", guildJoinType: 0, badgeId: "0", greeting: "" });
const info = () => guild.handleRequest(ctx, user, 3471, { guildUid: user.guildUid });
const members = () => guild.handleRequest(ctx, user, 3473, { guildUid: user.guildUid });
const active = () => ctx.userDb.guilds[user.guildUid].cooperative.sessions[info().sessionId];
const entryCount = Number(cooperative.catalog().basic.BOSS_PLAY_COUNT_BASIC);
const arenaId = info().arenaList[0].dungeonId;
const initial = active();
const localGuild = ctx.userDb.guilds[user.guildUid];
localGuild.members.push({ ...localGuild.members[0], commonProfile: { ...localGuild.members[0].commonProfile, userUid: "2", nickname: "OtherMember" } });
info();
initial.members["2"].arenaList.push({ arenaId: initial.arenas[0].arenaIndex, grade: 3, regDate: "0" });
assert.equal(members().memberInfoList.find(member => String(member.profile.userUid) === "2").arenaList.length, 1, "other guildmates' contribution histories remain visible");
const otherView = cooperative.memberInfo(ctx, { userUid: "2" }, localGuild, { guildBossMaxHp: () => 1 });
assert.equal(otherView.memberInfoList.find(member => String(member.profile.userUid) === "2").arenaList.length, 0, "each caller gets its own empty native debit list");

// Imported exhausted saves must work without discarding their real contribution records.
const owner = initial.members[user.userUid];
owner.arenaList = Array.from({ length: 12 }, () => ({ arenaId: initial.arenas[0].arenaIndex, grade: 0, regDate: "0" }));
owner.bossPlays = 12;
owner.ticketBuyCount = 1;
assert.equal(info().bossData.playCount, entryCount);
assert.equal(info().arenaTicketBuyCount, 0);
assert.equal(members().memberInfoList[0].arenaList.length, 0);

for (let attempt = 0; attempt < 20; attempt += 1) {
  const stage = guild.prepareGuildArenaGameLoad(ctx, user, { dungeonID: arenaId, selectDeckIndex: 0 });
  const win = attempt === 19;
  const result = guild.completeGuildBattle(ctx, user, stage, { missionResult1: win, missionResult2: win }, { win, giveup: attempt % 3 === 0 });
  assert.equal(members().memberInfoList[0].arenaList.length, 0);
  assert.equal(info().arenaTicketBuyCount, 0);
  assert(result.packets.find(packet => packet.packetId === 3474).payload.equals(guild.encodeFields(schema.packets[3474].fields, members())), "settlement notice carries the same unlimited native MEMBER fields");
  assert.equal(guild.completeGuildBattle(ctx, user, stage, {}, { win: true }), null, "duplicate settlement cannot add another contribution");
}
assert.equal(owner.arenaList.length, 32);
assert.equal(initial.arenas[0].totalMedalCount, 3, "unlimited entries retain actual global medals");
const maxHp = info().bossData.maxHp;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const stage = guild.prepareGuildPractice(ctx, user, { bossStageId: info().bossData.stageId, selectDeckIndex: 0, isPractice: false }).stage;
  const result = guild.completeGuildBattle(ctx, user, stage, { raidBossCurHp: maxHp, raidBossMaxHp: maxHp }, { win: false, giveup: attempt % 3 === 0 });
  assert.equal(info().bossData.playCount, entryCount);
  assert(result.packets.find(packet => packet.packetId === 3472).payload.equals(guild.encodeFields(schema.packets[3472].fields, info())), "settlement notice carries the same unlimited native Boss fields");
  assert.equal(guild.completeGuildBattle(ctx, user, stage, {}, { win: true }), null);
}
assert.equal(owner.bossPlays, 32, "real Boss history remains available for diagnostics");
assert.equal(info().lastSeasonRewardData.find(row => row.category === 1).totalValue, 40, "real attempts still count toward season contribution rewards");
assert.equal(info().bossData.remainHp, maxHp);
const cancelStage = guild.prepareGuildPractice(ctx, user, { bossStageId: info().bossData.stageId, selectDeckIndex: 0, isPractice: false }).stage;
guild.cancelGuildBattle(ctx, user, cancelStage);
assert.equal(info().bossData.playCount, entryCount);
assert.equal(owner.bossPlays, 32);
const inventoryBefore = JSON.stringify(user.inventory);
for (let count = 0; count < 2; count += 1) assert.equal(guild.handleRequest(ctx, user, 3483, {}).currentTicketBuyCount, 0);
assert.equal(JSON.stringify(user.inventory), inventoryBefore, "stale purchase requests do not spend quartz");
assert.equal(getMiscItem(user, 101).countFree, "500", "only the original guild creation fee was paid");

ctx.userDb = JSON.parse(JSON.stringify(ctx.userDb));
assert.equal(info().bossData.playCount, entryCount, "full DB reload retains the unlimited client count");
assert.equal(members().memberInfoList[0].arenaList.length, 0);
assert.equal(active().members[user.userUid].arenaList.length, 32, "reload does not erase contribution history");
const resumed = guild.prepareGuildArenaGameLoad(ctx, user, { dungeonID: arenaId, selectDeckIndex: 0 });
guild.cancelGuildBattle(ctx, user, resumed);

const args = process.argv.slice(2);
if (args.length) {
  assert(args.length === 2 && args[0] === "--native-fixture");
  const liveInfo = info();
  const liveMembers = members();
  const interval = guild.buildGuildSeasonIntervals(ctx, user)[0];
  const catalog = cooperative.catalog();
  const season = catalog.seasons.find(row => row.m_SeasonID === liveInfo.seasonId);
  fs.writeFileSync(args[1], JSON.stringify({
    serviceTime: clock.toISOString(), userUid: Number(user.userUid), guildUid: Number(user.guildUid),
    infoPayloadBase64: guild.encodeFields(schema.packets[3472].fields, liveInfo).toString("base64"),
    memberPayloadBase64: guild.encodeFields(schema.packets[3474].fields, liveMembers).toString("base64"),
    chatPayloadBase64: guild.encodeFields(schema.packets[3455].fields, guild.handleRequest(ctx, user, 3454, { guildUid: user.guildUid })).toString("base64"),
    unlimitedEntryCounters: true, storedArenaPlays: active().members[user.userUid].arenaList.length, storedBossPlays: active().members[user.userUid].bossPlays,
    season, interval: { m_DateStart: interval.startDate.toISOString(), m_DateEnd: interval.endDate.toISOString(), m_DateStrID: interval.strKey },
    schedules: catalog.schedules.filter(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup),
    dungeons: catalog.arenas.filter(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup), artifacts: catalog.artifacts,
    constants: { ArenaPlayCountBasic: catalog.basic.ARENA_PLAY_COUNT_BASIC, ArenaTicketBuyCount: catalog.basic.ARENA_TICKET_BUY_COUNT,
      BossPlayCountBasic: catalog.basic.BOSS_PLAY_COUNT_BASIC, ArtifactFulificationCount: catalog.basic.ARTIFACT_FULIFICATION_COUNT },
  }, null, 2) + "\n");
}
console.log("[guild-unlimited-entries] PASS imported exhausted state, 20 arena/20 Boss results, native debit fields, win/loss/giveup/cancel/duplicate, history/rewards, free stale purchase and full reload");
