"use strict";

const { randomUUID } = require("node:crypto");
const { readGameplayTableRecords, readGameplayTable } = require("../gameplay-jsons");
const { dateTimeBinaryForDate } = require("../server-time");
const { buildPlayerDeckForGameLoad } = require("../unit");
const { getMiscItem } = require("../inventory");
const { grantRewardByType } = require("../reward");
const codec = require("../packet-codec");

const DAY_MS = 86400000;
let tables;
function catalog() {
  if (tables) return tables;
  const read = name => readGameplayTableRecords("ab_script", `${name}.json`);
  const common = readGameplayTable("ab_script", "LUA_COMMON_CONST.json") || {};
  tables = { seasons: read("LUA_GUILD_SEASON_TEMPLET"), intervals: read("LUA_INTERVAL_TEMPLET"), schedules: read("LUA_GUILD_DUNGEON_SCHEDULE_TEMPLET"), arenas: read("LUA_GUILD_DUNGEON_INFO_TEMPLET"), bosses: read("LUA_GUILD_RAID_TEMPLET"), artifacts: read("LUA_GUILD_DUNGEON_ARTIFACT_TEMPLET"), rewards: read("LUA_GUILD_SEASON_REWARD_TEMPLET"), basic: common.globals && common.globals.GUILD_DUNGEON && common.globals.GUILD_DUNGEON.BASIC_CONST || {} };
  return tables;
}
function now(ctx) { return ctx.getServerNowDate ? ctx.getServerNowDate() : new Date(); }
function binary(value) { return String(dateTimeBinaryForDate(value instanceof Date ? value : new Date(value))); }
function parseDate(value) {
  if (value instanceof Date) return value.getTime();
  if (!value) return NaN;
  let text = String(value).trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "Z";
  return Date.parse(text);
}
function list(value) { return Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : value ? [value] : []; }
function field(row, ...names) { return names.map(name => row[name]).find(value => value != null); }
function error(message, code) { const failure = new Error(message); failure.errorCode = code; return failure; }
function selectedSeason(ctx) {
  const data = catalog();
  const tags = new Set(list(ctx.getEffectiveContentsTags ? ctx.getEffectiveContentsTags([]) : []).map(tag => String(tag).toUpperCase()));
  const eligible = data.seasons.map((row, sourceOrder) => ({ ...row, sourceOrder,
    m_SeasonID: Number(field(row,"m_SeasonID","SeasonId","seasonId")),
    m_SeasonDungeonGroup: Number(field(row,"m_SeasonDungeonGroup","SeasonDungeonGroup","seasonDungeonGroup")),
    m_SeasonRaidGroup: Number(field(row,"m_SeasonRaidGroup","SeasonRaidGroup","seasonRaidGroup")),
    m_SeasonRewardGroup: Number(field(row,"m_SeasonRewardGroup","SeasonRewardGroup","seasonRewardGroup")),
    m_DateStrID: String(field(row,"m_DateStrID","SeasonDateStrId","seasonDateStrId") || ""),
    listContentsTagAllow: list(field(row,"listContentsTagAllow","m_OpenTag","OpenTag","openTag")),
  })).filter(season => season.m_SeasonID > 0 && season.m_DateStrID && (!tags.size || !season.listContentsTagAllow.length || season.listContentsTagAllow.some(tag => tags.has(String(tag).toUpperCase()))) &&
    data.schedules.some(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup) && data.arenas.some(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup) && data.bosses.some(row => row.m_SeasonRaidGroup === season.m_SeasonRaidGroup))
    .map(season => {
      const original = data.intervals.find(row => String(field(row,"m_DateStrID","StrKey","strKey") || "").toUpperCase() === season.m_DateStrID.toUpperCase());
      // Frozen Android exports an empty INTERVAL_TEMPLET; 205 supplies these dates dynamically.
      const interval = original ? { ...original, m_DateID: Number(field(original,"m_DateID","Key","key")), m_DateStart: field(original,"m_DateStart","StartDate","startDate"), m_DateEnd: field(original,"m_DateEnd","EndDate","endDate") } : { m_DateStrID: season.m_DateStrID, m_DateID: 2000000000 + season.m_SeasonID };
      return { season, interval };
    });
  const dated = eligible.filter(row => Number.isFinite(parseDate(row.interval.m_DateStart)));
  const started = dated.filter(row => parseDate(row.interval.m_DateStart) <= now(ctx).getTime());
  const chosen = (started.length ? started : dated.length ? dated : eligible).sort((a, b) => (parseDate(a.interval.m_DateStart) || 0) - (parseDate(b.interval.m_DateStart) || 0) || a.season.sourceOrder - b.season.sourceOrder).at(-1);
  if (!chosen) throw error("guild cooperative season unavailable", 20635);
  return chosen;
}
function sessionsFor(data) {
  const sessions = [];
  for (let index = 0; index < data.sessionCount; index += 1) sessions.push({ sessionId: index + 1, startMs: data.startMs + index * 7 * DAY_MS, endMs: data.startMs + (index * 7 + 5) * DAY_MS });
  return sessions;
}
function currentSession(data, date) {
  const sessions = sessionsFor(data);
  if (date > sessions.at(-1).endMs) return sessions.at(-1);
  const next = sessions.find(session => date <= session.endMs);
  if (!next) return null;
  return date < next.startMs ? sessions.find(session => session.sessionId === next.sessionId - 1) || null : next;
}
function ensureCalendar(ctx, guild) {
  const data = catalog();
  let state = guild.cooperative;
  const chosen = selectedSeason(ctx);
  if (!state || state.seasonId !== chosen.season.m_SeasonID || now(ctx).getTime() < state.startMs || now(ctx).getTime() > state.endMs) {
    const count = Math.max(...data.schedules.filter(row => row.m_SeasonDungeonGroup === chosen.season.m_SeasonDungeonGroup).map(row => row.m_SeasonSessionIndex));
    if (!Number.isFinite(count)) throw error("guild cooperative schedule unavailable", 20634);
    const start = new Date(now(ctx));
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    state = { version: 1, seasonId: chosen.season.m_SeasonID, seasonKey: chosen.season.m_DateStrID, windowId: randomUUID(), sessionCount: count, startMs: start.getTime(), endMs: start.getTime() + ((count - 1) * 7 + 5) * DAY_MS, killPoint: 0, memberTotals: {}, sessions: {} };
    guild.cooperative = state;
  }
  const season = chosen.season;
  return { state, season };
}
function ensureState(ctx, guild, helpers) {
  const data = catalog();
  const { state, season } = ensureCalendar(ctx, guild);
  const session = currentSession(state, now(ctx).getTime());
  if (!season || !session) throw error("guild cooperative session unavailable", 20634);
  const schedule = data.schedules.find(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup && row.m_SeasonSessionIndex === session.sessionId);
  if (!schedule) throw error("guild cooperative schedule unavailable", 20634);
  let progress = state.sessions[session.sessionId];
  const bosses = data.bosses.filter(row => row.m_SeasonRaidGroup === season.m_SeasonRaidGroup).sort((a, b) => a.m_RaidStageIndex - b.m_RaidStageIndex);
  if (!progress) {
    const ids = Object.entries(schedule).filter(([key]) => /^m_UseSeasonDungeonID_/.test(key)).map(([, id]) => id);
    const arenas = ids.map(id => data.arenas.find(row => row.m_SeasonDungeonGroup === season.m_SeasonDungeonGroup && row.m_SeasonDungeonID === id));
    if (!arenas.every(Boolean) || !bosses.length) throw error("guild cooperative arena unavailable", 20643);
    progress = { sessionId: session.sessionId, arenas: arenas.map(row => ({ arenaIndex: row.m_StageArenaIndex, dungeonId: row.m_SeasonDungeonID, artifactGroup: row.m_StageRewardArtifactGroup, totalMedalCount: 0, playUserUid: "0", flagIndex: 0 })), boss: { stageIndex: 0, stageId: bosses[0].m_StageID, maxHp: helpers.guildBossMaxHp(bosses[0].m_StageID), remainHp: helpers.guildBossMaxHp(bosses[0].m_StageID), totalPoint: 0, extraPoint: 0, playUserUid: "0", orderIndex: 0 }, members: {}, completedGames: [] };
    state.sessions[session.sessionId] = progress;
  }
  for (const member of guild.members) {
    const uid = member.commonProfile.userUid;
    progress.members[uid] = progress.members[uid] || { arenaList: [], bossPoint: 0, bossPlays: 0, ticketBuyCount: 0, pending: null, rewards: {}, claimed: false };
    state.memberTotals[uid] = state.memberTotals[uid] || { tryCount: 0, rewarded: {} };
  }
  return { state, season, session, progress, bosses, playable: now(ctx).getTime() >= session.startMs && now(ctx).getTime() <= session.endMs };
}
function info(ctx, user, guild, helpers) {
  const live = ensureState(ctx, guild, helpers);
  const member = live.progress.members[String(user.userUid)];
  if (!member) throw error("guild cooperative member missing", 20443);
  const next = sessionsFor(live.state).find(session => session.sessionId === live.session.sessionId + 1);
  return { errorCode: 0, guildDungeonState: live.playable ? 1 : 3, seasonId: live.state.seasonId, sessionId: live.session.sessionId, currentSessionEndDate: binary(live.session.endMs), NextSessionStartDate: binary(next ? next.startMs : live.state.endMs + 2 * DAY_MS), arenaList: live.progress.arenas, lastSeasonRewardData: [{ category: 0, totalValue: live.state.killPoint, receivedValue: member.receivedRank || 0 }, { category: 1, totalValue: live.state.memberTotals[user.userUid].tryCount, receivedValue: member.receivedTry || 0 }], bossData: { ...live.progress.boss, playCount: Number(catalog().basic.BOSS_PLAY_COUNT_BASIC || 5) }, arenaTicketBuyCount: 0, canReward: !member.claimed && Object.keys(member.rewards).length > 0 };
}
function memberInfo(ctx, user, guild, helpers) {
  const live = ensureState(ctx, guild, helpers);
  // Native MEMBER OnRecv subtracts the current user's arenaList.Count from available entries.
  // Keep real history in the save; an empty debit list leaves local entries available after every result/relogin.
  return { errorCode: 0, memberInfoList: guild.members.map(member => ({ profile: member.commonProfile, arenaList: String(member.commonProfile.userUid) === String(user.userUid) ? [] : live.progress.members[member.commonProfile.userUid].arenaList, bossPoint: live.progress.members[member.commonProfile.userUid].bossPoint })) };
}
function buildSeasonIntervals(ctx, guild, helpers) {
  let state;
  let interval;
  if (guild) { const live = ensureCalendar(ctx, guild); state = live.state; interval = selectedSeason(ctx).interval; }
  else {
    const chosen = selectedSeason(ctx); interval = chosen.interval;
    const count = Math.max(...catalog().schedules.filter(row => row.m_SeasonDungeonGroup === chosen.season.m_SeasonDungeonGroup).map(row => row.m_SeasonSessionIndex));
    const start = new Date(now(ctx)); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    state = { seasonKey: chosen.season.m_DateStrID, startMs: start.getTime(), endMs: start.getTime() + ((count - 1) * 7 + 5) * DAY_MS };
  }
  return [{ key: interval.m_DateID, strKey: state.seasonKey, startDate: new Date(state.startMs), endDate: new Date(state.endMs), repeatStartDate: 0, repeatEndDate: 0 }];
}
function requirePlayable(live, member) {
  if (!live.playable) throw error("guild cooperative session closed", 20630);
  if (!member) throw error("guild cooperative member missing", 20443);
  if (member.pending) throw error("guild cooperative battle already loading", 20657);
}
function unlockedArtifacts(live) {
  const countPerArtifact = Number(catalog().basic.ARTIFACT_FULIFICATION_COUNT || 10);
  return live.progress.arenas.flatMap(arena => {
    const artifacts = catalog().artifacts.filter(row => row.m_StageRewardArtifactGroup === arena.artifactGroup).sort((a,b) => a.m_ArtifactOrder - b.m_ArtifactOrder);
    return artifacts.slice(0, Math.min(artifacts.length, Math.floor(arena.totalMedalCount / countPerArtifact)));
  });
}
function prepareArena(ctx, user, guild, req, helpers) {
  if (!catalog().arenas.some(row => row.m_SeasonDungeonID === Number(req.dungeonID || req.stageID))) return null;
  const live = ensureState(ctx, guild, helpers);
  const member = live.progress.members[user.userUid]; requirePlayable(live, member);
  const arena = live.progress.arenas.find(row => row.dungeonId === Number(req.dungeonID || req.stageID));
  if (!arena) throw error("guild cooperative arena not active", 20643);
  if (arena.playUserUid !== "0") throw error("guild cooperative arena busy", 20644);
  const artifactCount = catalog().artifacts.filter(row => row.m_StageRewardArtifactGroup === arena.artifactGroup).length;
  if (arena.totalMedalCount >= artifactCount * Number(catalog().basic.ARTIFACT_FULIFICATION_COUNT || 10)) throw error("guild cooperative arena artifacts complete", 20646);
  const stage = ctx.getGenericStageForRequest && ctx.getGenericStageForRequest({ dungeonID: arena.dungeonId });
  if (!stage || stage.dungeonID !== arena.dungeonId) throw error("guild cooperative dungeon unavailable", 20637);
  const loadReq = { ...req, stageID: stage.stageId, dungeonID: arena.dungeonId, gameType: 16, rewardMultiply: 1 };
  const playerDeck = buildPlayerDeckForGameLoad(user, loadReq);
  if (!playerDeck) throw error("guild cooperative deck empty", 20191);
  const token = randomUUID();
  member.pending = { token, kind: "arena", arenaIndex: arena.arenaIndex, dungeonId: arena.dungeonId };
  arena.playUserUid = String(user.userUid);
  return { ...stage, gameType: 16, miscMode: "guild-arena", guildUid: guild.guildUid, guildSeasonId: live.state.seasonId, guildWindowId: live.state.windowId, guildSessionId: live.session.sessionId, guildBattleToken: token, guildArenaIndex: arena.arenaIndex, playerDeck, tutorial: false, cutsceneOnly: false };
}
function prepareBoss(ctx, user, guild, req, helpers) {
  const live = ensureState(ctx, guild, helpers);
  const member = live.progress.members[user.userUid];
  if (!req.isPractice) requirePlayable(live, member);
  else if (!member || member.pending) throw error("guild cooperative battle already loading", 20657);
  const boss = live.bosses.find(row => row.m_StageID === Number(req.bossStageId));
  if (!boss || !req.isPractice && boss.m_StageID !== live.progress.boss.stageId) throw error("guild cooperative invalid boss stage", 20652);
  if (!req.isPractice && live.progress.boss.remainHp <= 0) throw error("guild cooperative boss defeated", 20645);
  if (!req.isPractice && live.progress.boss.playUserUid !== "0") throw error("guild cooperative boss busy", 20657);
  const stage = ctx.getGenericStageForRequest && ctx.getGenericStageForRequest({ dungeonID: boss.m_StageID });
  if (!stage || stage.dungeonID !== boss.m_StageID) throw error("guild cooperative dungeon unavailable", 20637);
  const gameType = req.isPractice ? 25 : 17;
  const loadReq = { isDev: false, selectDeckIndex: req.selectDeckIndex, stageID: stage.stageId, dungeonID: stage.dungeonID, gameType, rewardMultiply: 1 };
  const playerDeck = buildPlayerDeckForGameLoad(user, loadReq);
  if (!playerDeck) throw error("guild cooperative deck empty", 20191);
  const token = randomUUID();
  member.pending = { token, kind: req.isPractice ? "practice" : "boss", bossStageId: boss.m_StageID };
  if (!req.isPractice) live.progress.boss.playUserUid = String(user.userUid);
  const maxHp = helpers.guildBossMaxHp(boss.m_StageID);
  const battleConditionIds = Array.from(new Set([...(stage.battleConditionIds || []), ...unlockedArtifacts(live).map(row => Number(row.m_RefBattleConditionID)).filter(Boolean)]));
  return { req: loadReq, stage: { ...stage, gameType, miscMode: req.isPractice ? "guild-practice" : "guild-boss", guildUid: guild.guildUid, guildSeasonId: live.state.seasonId, guildWindowId: live.state.windowId, guildSessionId: live.session.sessionId, guildBattleToken: token, guildBossStageId: boss.m_StageID, guildBossInitHp: req.isPractice ? maxHp : live.progress.boss.remainHp, guildBossMaxHp: maxHp, battleConditionIds, playerDeck, tutorial: false, cutsceneOnly: false, eventDeckId: 0, EventDeckId: 0 } };
}
function resultPackets(ctx, user, guild, helpers, first) {
  return [...first, { packetId: 3472, data: info(ctx, user, guild, helpers) }, { packetId: 3474, data: memberInfo(ctx, user, guild, helpers) }];
}
function completeBattle(ctx, user, guild, game, battle, options, helpers) {
  const live = ensureState(ctx, guild, helpers);
  const member = live.progress.members[user.userUid];
  if (!member || !member.pending || game.guildWindowId !== live.state.windowId || game.guildSessionId !== live.session.sessionId || member.pending.token !== game.guildBattleToken || live.progress.completedGames.includes(game.guildBattleToken)) return null;
  const pending = member.pending;
  member.pending = null;
  live.progress.completedGames.push(game.guildBattleToken);
  const win = Boolean(options.win) && !options.giveup;
  live.state.memberTotals[user.userUid].tryCount += pending.kind === "practice" ? 0 : 1;
  let first;
  let raidResult = null;
  if (pending.kind === "arena") {
    const arena = live.progress.arenas.find(row => row.arenaIndex === pending.arenaIndex);
    arena.playUserUid = "0";
    const grade = win ? 1 + Number(Boolean(battle.missionResult1)) + Number(Boolean(battle.missionResult2)) : 0;
    arena.totalMedalCount += grade;
    member.arenaList.push({ arenaId: arena.arenaIndex, grade, regDate: binary(now(ctx)) });
    first = [{ packetId: 3481, data: { errorCode: 0, playedUserUid: user.userUid, arenaId: arena.arenaIndex, totalGrade: arena.totalMedalCount } }];
  } else {
    const maxHp = pending.kind === "practice" ? helpers.guildBossMaxHp(pending.bossStageId) : live.progress.boss.maxHp;
    const initialHp = pending.kind === "practice" ? maxHp : live.progress.boss.remainHp;
    const snapshot = Number(battle.raidBossCurHp ?? battle.RaidBossCurHp);
    const capturedMax = Number(battle.raidBossMaxHp ?? battle.RaidBossMaxHp);
    let hp = capturedMax > 0 && Number.isFinite(snapshot) ? snapshot / capturedMax * maxHp : initialHp;
    hp = Math.max(0, Math.min(initialHp, hp));
    if (win && Boolean(battle.raidBossKilled ?? battle.RaidBossKilled)) hp = 0;
    const damage = initialHp - hp;
    raidResult = { initHp: initialHp, curHP: hp, maxHp, damage };
    first = [];
    if (pending.kind !== "practice") {
      const boss = live.bosses.find(row => row.m_StageID === pending.bossStageId);
      const point = Math.floor(damage / maxHp * Number(boss.m_RaidRewardPoint || 0));
      member.bossPlays += 1; member.bossPoint += point;
      live.progress.boss.totalPoint += point; live.progress.boss.playUserUid = "0"; live.progress.boss.remainHp = hp;
      first.push({ packetId: 3482, data: { playedUserUid: user.userUid, bossStageId: pending.bossStageId, damage, remainHp: hp, totalPoint: live.progress.boss.totalPoint, extraPoint: live.progress.boss.extraPoint, point } });
      if (hp === 0) {
        live.state.killPoint += Number(boss.m_RaidRewardPoint || 0);
        if (boss.m_RaidRewardID && boss.m_RaidRewardValue) {
          member.rewards[boss.m_RaidRewardID] = Number(member.rewards[boss.m_RaidRewardID] || 0) + Number(boss.m_RaidRewardValue);
          member.claimed = false;
        }
        const next = live.bosses[live.progress.boss.stageIndex + 1];
        if (next) { live.progress.boss.stageIndex += 1; live.progress.boss.stageId = next.m_StageID; live.progress.boss.maxHp = helpers.guildBossMaxHp(next.m_StageID); live.progress.boss.remainHp = live.progress.boss.maxHp; }
      }
    }
  }
  return { packets: resultPackets(ctx, user, guild, helpers, first), raidBossResult: raidResult };
}
function cancelBattle(ctx, user, guild, game, helpers) {
  if (game && (!game.guildBattleToken || String(game.guildUid) !== guild.guildUid)) return null;
  const stored = guild.cooperative;
  const progress = Object.values(stored && stored.sessions || {}).find(session => {
    const member = session.members && session.members[user.userUid];
    return member && member.pending && (!game || member.pending.token === game.guildBattleToken);
  });
  if (!progress) return null;
  const member = progress.members[user.userUid];
  const pending = member.pending; member.pending = null;
  const first = [];
  if (pending.kind === "arena") {
    const arena = progress.arenas.find(row => row.arenaIndex === pending.arenaIndex);
    if (arena) arena.playUserUid = "0";
    first.push({ packetId: 3486, data: { arenaIndex: pending.arenaIndex } });
  }
  if (pending.kind === "boss") { progress.boss.playUserUid = "0"; first.push({ packetId: 3487, data: { playUserUid: user.userUid } }); }
  try { return { packets: resultPackets(ctx, user, guild, helpers, first) }; }
  catch (failure) {
    console.log(`[guild:cancel] cleared reservation; status refresh unavailable code=${failure.errorCode || 20191}`);
    return { packets: first };
  }
}
function request(ctx, user, guild, id, req, helpers) {
  if (id === 3471) return info(ctx, user, guild, helpers);
  if (id === 3473) return memberInfo(ctx, user, guild, helpers);
  const live = ensureState(ctx, guild, helpers);
  const member = live.progress.members[user.userUid];
  if (id === 3491) {
    const arena = live.progress.arenas.find(row => row.arenaIndex === req.arenaIndex);
    if (!arena || req.flagIndex < 0 || req.flagIndex > 3) throw error("guild cooperative invalid flag", 23902);
    arena.flagIndex = req.flagIndex; return { errorCode: 0, arenaIndex: req.arenaIndex, flagIndex: req.flagIndex };
  }
  if (id === 3494) { if (req.orderIndex < 0 || req.orderIndex > 5) throw error("guild cooperative invalid order", 23903); live.progress.boss.orderIndex = req.orderIndex; return { errorCode: 0, orderIndex: req.orderIndex }; }
  if (id === 3483) {
    // A stale purchase dialog must not charge quartz for entries that already stay available.
    return { errorCode: 0, currentTicketBuyCount: 0, costItemData: getMiscItem(user, 101) };
  }
  if (id === 3477) {
    if (member.claimed || !Object.keys(member.rewards).length) throw error("guild cooperative no session reward", 20672);
    const rewards = [];
    for (const [itemId, amount] of Object.entries(member.rewards)) rewards.push(...grantRewardByType(ctx, user, "RT_MISC", Number(itemId), amount).miscItems);
    member.claimed = true;
    member.rewards = {};
    return { errorCode: 0, stageIndex: live.progress.boss.stageIndex, remainHp: String(Math.floor(live.progress.boss.remainHp)), clearPoint: live.progress.boss.totalPoint, rewardList: rewards, artifactReward: [] };
  }
  if (id === 3475) {
    const category = req.rewardCategory;
    const total = category === 0 ? live.state.killPoint : live.state.memberTotals[user.userUid].tryCount;
    const row = catalog().rewards.find(row => row.m_SeasonRewardGroup === live.season.m_SeasonRewardGroup && row.m_RewardCountValue === req.rewardCountValue && row.m_RewardCategory === (category === 0 ? "RANK" : "DUNGEON_TRY"));
    const key = `${category}:${req.rewardCountValue}`;
    if (!row || total < req.rewardCountValue || live.state.memberTotals[user.userUid].rewarded[key]) throw error("guild cooperative season reward unavailable", 20668);
    const reward = grantRewardByType(ctx, user, row.m_RewardItemType, row.m_RewardItemID, row.m_RewardItemValue);
    live.state.memberTotals[user.userUid].rewarded[key] = true;
    return { errorCode: 0, rewardCategory: category, rewardCountValue: req.rewardCountValue, rewardData: codec.buildRewardData(reward) };
  }
  throw error("guild cooperative request unavailable", 20630);
}
module.exports = { catalog, selectedSeason, ensureState, currentSession, sessionsFor, buildSeasonIntervals, info, memberInfo, prepareArena, prepareBoss, completeBattle, cancelBattle, request };
