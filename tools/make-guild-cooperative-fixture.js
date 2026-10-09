"use strict";
const fs = require("node:fs");
const path = require("node:path");
const guild = require("../modules/guild");
const cooperative = require("../modules/guild/cooperative");
const { setMiscItemBalance } = require("../modules/inventory");
const schema = require("../packet-schema.json");
if (process.argv.length !== 3) throw new Error("Usage: node tools/make-guild-cooperative-fixture.js <output JSON>");
const date = new Date("2025-04-10T19:21:27Z");
const user = { userUid: "1", friendCode: "101", nickname: "SyntheticCoop", level: 20, inventory: {} };
setMiscItemBalance(user,101,1500);
const ctx = { userDb: { users: { 1:user } }, getServerNowDate:()=>date, getEffectiveContentsTags:()=>["GUILD_DUNGEON_SEASON_DEMOLTION_2025_2","GUILD_DUNGEON_SEASON_GIGAS_2025_2"] };
guild.handleRequest(ctx,user,3400,{guildName:"CoopFixture",guildJoinType:0,badgeId:"0",greeting:""});
const info = guild.handleRequest(ctx,user,3471,{guildUid:user.guildUid});
const members = guild.handleRequest(ctx,user,3473,{guildUid:user.guildUid});
const chat = guild.handleRequest(ctx,user,3454,{guildUid:user.guildUid});
const interval = guild.buildGuildSeasonIntervals(ctx,user)[0];
const season = cooperative.catalog().seasons.find(row=>row.m_SeasonID===info.seasonId);
const fixture = {
  serviceTime:date.toISOString(), userUid:Number(user.userUid), guildUid:Number(user.guildUid),
  infoPayloadBase64:guild.encodeFields(schema.packets[3472].fields,info).toString("base64"),
  memberPayloadBase64:guild.encodeFields(schema.packets[3474].fields,members).toString("base64"),
  chatPayloadBase64:guild.encodeFields(schema.packets[3455].fields,chat).toString("base64"),
  season, interval:{m_DateStart:interval.startDate.toISOString(),m_DateEnd:interval.endDate.toISOString(),m_DateStrID:interval.strKey},
  schedules:cooperative.catalog().schedules.filter(row=>row.m_SeasonDungeonGroup===season.m_SeasonDungeonGroup),
  dungeons:cooperative.catalog().arenas.filter(row=>row.m_SeasonDungeonGroup===season.m_SeasonDungeonGroup),
  artifacts:cooperative.catalog().artifacts,
  constants:{ArenaPlayCountBasic:cooperative.catalog().basic.ARENA_PLAY_COUNT_BASIC,ArenaTicketBuyCount:cooperative.catalog().basic.ARENA_TICKET_BUY_COUNT,BossPlayCountBasic:cooperative.catalog().basic.BOSS_PLAY_COUNT_BASIC,ArtifactFulificationCount:cooperative.catalog().basic.ARTIFACT_FULIFICATION_COUNT},
};
fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(fixture,null,2)+"\n");
console.log("Synthetic guild cooperative calendar, INFO/MEMBER/CHAT packets and native table fixture generated.");
