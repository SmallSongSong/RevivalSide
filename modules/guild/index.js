"use strict";

const schema = require("../../packet-schema.json");
const codec = require("../packet-codec");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItem, spendMiscItem, toBigInt } = require("../inventory");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const { buildPlayerDeckForGameLoad } = require("../unit");
const { dateTimeBinaryForDate } = require("../server-time");
const cooperative = require("./cooperative");

const MASTER = 0;
const MEMBER = 2;
const DIRECT_JOIN = 0;
const APPROVAL_JOIN = 1;
const ERROR = 20191; // NEC_FAIL_INVALID_REQUEST in the bundled client.
const DAY_MS = 86400000;

function guildConstants() {
  const table = readGameplayTable("ab_script", "LUA_COMMON_CONST.json") || {};
  return (table.globals && table.globals.Guild) || table.Guild || {};
}

function getGuildNameLength(name) {
  let length = 0;
  for (let index = 0; index < name.length; index += 1) length += name.charCodeAt(index) <= 255 ? 1 : 2;
  return length;
}

function isValidGuildName(name) {
  // NKCUIGuildCreate checks weighted length 2..16; Global names permit these scripts.
  const length = getGuildNameLength(name);
  return length >= 2 && length <= 16 && /^[A-Za-z0-9\u3040-\u30ff\u4e00-\u9fa5\uac00-\ud7a3]+$/.test(name);
}

function ensureGuildStore(ctx) {
  const db = ctx.userDb || (ctx.userDb = { users: {} });
  db.guilds = db.guilds && typeof db.guilds === "object" ? db.guilds : {};
  for (const guild of Object.values(db.guilds)) {
    if (guild.guildState === 2 && toBigInt(guild.closingTime) <= toBigInt(binaryDate(nowDate(ctx)))) {
      for (const member of guild.members) {
        const user = db.users && db.users[member.commonProfile.userUid];
        if (user) setMembership(user, null);
      }
      delete db.guilds[guild.guildUid];
    }
  }
  for (const user of Object.values(db.users || {})) reconcileGuildMembership(user, db.guilds);
  return db.guilds;
}

function reconcileGuildMembership(user, guilds) {
  if (!user || toBigInt(user.guildUid) === 0n) return;
  const guild = guilds && guilds[String(user.guildUid)];
  if (guild && guild.members.some(member => member.commonProfile.userUid === String(user.userUid))) return;
  user.archivedGuildMembership = {
    guildUid: String(user.guildUid), guildName: user.guildName || "", guildBadgeId: user.guildBadgeId || "0",
    privateGuildData: { ...(user.privateGuildData || {}) },
    reason: guild ? "account-not-in-members" : "guild-not-in-local-db",
  };
  setMembership(user, null);
}

function privateGuildData(user, options = {}) {
  const data = user.privateGuildData || (user.privateGuildData = {});
  if (options.now) {
    const date = options.now instanceof Date ? options.now : new Date(options.now);
    const key = options.eventDateKey || date.toISOString().slice(0, 10);
    if (data.resetDay !== key) {
      data.resetDay = key;
      data.donationCount = 0;
      data.lastDailyResetDate = binaryDate(date);
    }
  }
  return {
    guildUid: String(user.guildUid || "0"),
    donationCount: Number(data.donationCount || 0),
    lastDailyResetDate: String(data.lastDailyResetDate || "0"),
    guildJoinDisableTime: String(data.guildJoinDisableTime || "0"),
  };
}

function buildPrivateGuildData(user, options = {}) {
  if (options.userDb) ensureGuildStore({ userDb: options.userDb, getServerNowDate: () => options.now || new Date() });
  return encodeType("PrivateGuildData", privateGuildData(user || {}, options));
}

function buildGuildSimpleData(user) {
  return encodeType("NKMGuildSimpleData", {
    guildUid: String(user && user.guildUid || "0"),
    guildName: String(user && user.guildName || ""),
    badgeId: String(user && user.guildBadgeId || "0"),
  });
}

function buildGuildDataUpdatedNotPayload(ctx, user) {
  const store = ensureGuildStore(ctx);
  const guild = user && store[String(user.guildUid || 0)];
  if (!guild || !guild.members.some(member => member.commonProfile.userUid === String(user.userUid))) return null;
  const data = handleRequest(ctx, user, 3414, { guildUid: guild.guildUid });
  return encodeFields(schema.packets[3416].fields, { guildData: data.guildData });
}

function profile(user) {
  return {
    userUid: String(user.userUid), friendCode: String(user.friendCode || 0),
    nickname: user.nickname || "LocalPlayer", level: Number(user.level || 1),
    mainUnitId: Number(user.mainUnitId || 0), mainUnitSkinId: Number(user.mainUnitSkinId || 0),
    frameId: Number(user.frameId || 0), mainUnitTacticLevel: Number(user.mainUnitTacticLevel || 0),
    titleId: Number(user.titleId || 0),
  };
}

function nowDate(ctx) {
  return ctx.getServerNowDate ? ctx.getServerNowDate() : new Date();
}

function binaryDate(date) {
  return String(dateTimeBinaryForDate(date));
}

function dayKey(ctx) {
  return ctx.getServerEventDateKey ? ctx.getServerEventDateKey() : nowDate(ctx).toISOString().slice(0, 10);
}

function requireGuild(ctx, user, uid, master = false) {
  const guild = ensureGuildStore(ctx)[String(uid || user.guildUid || 0)];
  if (!guild || String(user.guildUid || 0) !== guild.guildUid || !guild.members.some(m => m.commonProfile.userUid === String(user.userUid))) throw new Error("guild membership required");
  if (master && guild.masterUserUid !== String(user.userUid)) throw new Error("guild master required");
  return guild;
}

function setMembership(user, guild) {
  user.guildUid = guild ? guild.guildUid : "0";
  user.guildName = guild ? guild.name : "";
  user.guildBadgeId = guild ? guild.badgeId : "0";
  privateGuildData(user);
}

function joinGuild(ctx, user, guild, grade = MEMBER) {
  if (toBigInt(user.guildUid) !== 0n) throw new Error("already in a guild");
  if (guild.guildState !== 1) throw new Error("guild closed to applications");
  const row = readGameplayTableRecords("ab_script", "LUA_GUILD_EXP_TEMPLET.json").find(r => Number(r.m_GuildLv) === guild.guildLevel);
  if (guild.members.length >= Number(row && row.m_GuildLvPersonCapacity || 20)) throw new Error("guild is full");
  const time = binaryDate(nowDate(ctx));
  guild.members.push({ commonProfile: profile(user), createdAt: time, grade, lastOnlineTime: time, greeting: "", lastAttendanceDate: "0", weeklyContributionPoint: "0", totalContributionPoint: "0", hasOffice: Boolean(user.office) });
  guild.joinWaitingList = guild.joinWaitingList.filter(m => m.commonProfile.userUid !== String(user.userUid));
  guild.inviteList = guild.inviteList.filter(m => m.commonProfile.userUid !== String(user.userUid));
  setMembership(user, guild);
}

function guildListData(guild) {
  const master = guild.members.find(m => m.commonProfile.userUid === guild.masterUserUid);
  return { ...guild, masterNickname: master ? master.commonProfile.nickname : "", memberCount: guild.members.length };
}

function checkCost(user, itemId, amount) {
  const item = getMiscItem(user, itemId);
  if (toBigInt(item.countFree) + toBigInt(item.countPaid) < toBigInt(amount)) throw new Error("insufficient items");
}

function addExp(guild, amount) {
  guild.guildLevelExp = String(toBigInt(guild.guildLevelExp) + BigInt(amount));
  guild.totalExp = String(toBigInt(guild.totalExp) + BigInt(amount));
  const rows = readGameplayTableRecords("ab_script", "LUA_GUILD_EXP_TEMPLET.json").sort((a, b) => a.m_GuildLv - b.m_GuildLv);
  let row = rows.find(r => Number(r.m_GuildLv) === guild.guildLevel);
  while (row && rows.some(r => Number(r.m_GuildLv) === guild.guildLevel + 1) && toBigInt(guild.guildLevelExp) >= BigInt(row.m_GuildExpRequired)) {
    guild.guildLevelExp = String(toBigInt(guild.guildLevelExp) - BigInt(row.m_GuildExpRequired));
    guild.guildLevel += 1;
    row = rows.find(r => Number(r.m_GuildLv) === guild.guildLevel);
  }
}

function friendData(ctx, user) {
  return { commonProfile: profile(user), lastLoginDate: binaryDate(nowDate(ctx)), guildData: { guildUid: user.guildUid || "0", guildName: user.guildName || "", badgeId: user.guildBadgeId || "0" }, hasOffice: Boolean(user.office) };
}

function handleRequest(ctx, user, id, req) {
  const store = ensureGuildStore(ctx);
  const now = binaryDate(nowDate(ctx));
  const base = { errorCode: 0, ...req };
  if ([3471, 3473, 3475, 3477, 3483, 3491, 3494].includes(id)) {
    const guild = requireGuild(ctx, user, req.guildUid || user.guildUid);
    return { ...base, ...cooperative.request(ctx, user, guild, id, req, { guildBossMaxHp }) };
  }
  switch (id) {
    case 3400: {
      const name = String(req.guildName || "");
      if (toBigInt(user.guildUid) !== 0n) throw new Error("already in a guild");
      if (!isValidGuildName(name)) throw new Error("invalid guild name");
      if (Object.values(store).some(g => g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("duplicate guild name");
      const settings = guildConstants();
      if (Number(user.level || 1) < Number(settings.Creation && settings.Creation.UserMinLevel || 15)) throw new Error("guild creation level required");
      const costs = settings.Creation && settings.Creation.ReqMiscItems || [];
      costs.forEach(c => checkCost(user, c.ItemId, c.ItemCount));
      const uid = String(Object.values(store).reduce((max, g) => toBigInt(g.guildUid) > max ? toBigInt(g.guildUid) : max, 100000n) + 1n);
      const guild = { guildUid: uid, name, badgeId: String(req.badgeId || 0), guildLevel: 1, guildLevelExp: "0", totalExp: "0", guildJoinType: req.guildJoinType, guildState: 1, closingTime: "0", greeting: req.greeting || "", notice: "", inviteList: [], joinWaitingList: [], members: [], attendanceList: [], unionPoint: "0", dungeonNotice: "", chatNoticeType: 0, renameCount: 0, latestRenameDate: "0", masterUserUid: String(user.userUid), messages: [] };
      joinGuild(ctx, user, guild, MASTER);
      store[uid] = guild;
      return { ...base, costItemDataList: costs.map(c => spendMiscItem(user, c.ItemId, c.ItemCount)), guildData: guild, privateGuildData: privateGuildData(user, { now: nowDate(ctx) }) };
    }
    case 3406:
    case 3408:
      return { ...base, list: Object.values(store).filter(g => !req.keyword || g.name.toLocaleLowerCase().includes(req.keyword.toLocaleLowerCase())).map(guildListData) };
    case 3414: {
      const guild = store[String(req.guildUid)];
      if (!guild) throw new Error("guild not found");
      for (const member of guild.members) {
        const local = ctx.userDb.users && ctx.userDb.users[member.commonProfile.userUid];
        if (local) member.commonProfile = profile(local);
      }
      return { ...base, guildData: guild };
    }
    case 3410: {
      if (toBigInt(user.guildUid) !== 0n) throw new Error("already in a guild");
      const guild = store[String(req.guildUid)];
      if (!guild) throw new Error("guild not found");
      if (guild.guildState !== 1) throw new Error("guild closed to applications");
      const needsApproval = guild.guildJoinType === APPROVAL_JOIN;
      if (guild.guildJoinType !== DIRECT_JOIN && !needsApproval) throw new Error("guild closed to applications");
      if (needsApproval) {
        if (!guild.joinWaitingList.some(m => m.commonProfile.userUid === String(user.userUid))) guild.joinWaitingList.push(friendData(ctx, user));
      } else joinGuild(ctx, user, guild);
      return { ...base, needApproval: needsApproval, privateGuildData: privateGuildData(user, { now: nowDate(ctx) }) };
    }
    case 3412: {
      const guild = store[String(req.guildUid)];
      if (!guild) throw new Error("guild not found");
      guild.joinWaitingList = guild.joinWaitingList.filter(m => m.commonProfile.userUid !== String(user.userUid));
      return base;
    }
    case 3417: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      const target = ctx.userDb.users && ctx.userDb.users[String(req.joinUserUid)];
      if (!target || !guild.joinWaitingList.some(m => m.commonProfile.userUid === String(req.joinUserUid))) throw new Error("application not found");
      if (req.isAllow) joinGuild(ctx, target, guild);
      else guild.joinWaitingList = guild.joinWaitingList.filter(m => m.commonProfile.userUid !== String(req.joinUserUid));
      return base;
    }
    case 3420:
    case 3423: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      const target = ctx.userDb.users && ctx.userDb.users[String(req.userUid)];
      if (!target || toBigInt(target.guildUid) !== 0n) throw new Error("local player unavailable");
      guild.inviteList = guild.inviteList.filter(m => m.commonProfile.userUid !== String(req.userUid));
      if (id === 3420) guild.inviteList.push(friendData(ctx, target));
      return base;
    }
    case 3426: {
      const guild = store[String(req.guildUid)];
      if (!guild || !guild.inviteList.some(m => m.commonProfile.userUid === String(user.userUid))) throw new Error("invitation not found");
      if (req.isAllow) joinGuild(ctx, user, guild);
      else guild.inviteList = guild.inviteList.filter(m => m.commonProfile.userUid !== String(user.userUid));
      return { ...base, privateGuildData: privateGuildData(user, { now: nowDate(ctx) }) };
    }
    case 3428: {
      const guild = requireGuild(ctx, user, req.guildUid);
      if (guild.masterUserUid === String(user.userUid) && guild.members.length > 1) throw new Error("transfer guild leadership first");
      guild.members = guild.members.filter(m => m.commonProfile.userUid !== String(user.userUid));
      setMembership(user, null);
      if (!guild.members.length) delete store[guild.guildUid];
      return { ...base, joinDisableTime: "0" };
    }
    case 3402: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      if (guild.guildState !== 1) throw new Error("guild closing already requested");
      guild.guildState = 2;
      guild.closingTime = binaryDate(new Date(nowDate(ctx).getTime() + Number(guildConstants().ClosingDelayHour || 48) * 3600000));
      return { ...base, closingTime: guild.closingTime };
    }
    case 3404: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      if (guild.guildState !== 2) throw new Error("guild is not closing");
      guild.guildState = 1;
      guild.closingTime = "0";
      return base;
    }
    case 3441: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      const before = guild.greeting;
      Object.assign(guild, { greeting: req.greeting, guildJoinType: req.guildJoinType, badgeId: String(req.badgeId), chatNoticeType: req.chatNoticeType });
      for (const member of guild.members) {
        const local = ctx.userDb.users && ctx.userDb.users[member.commonProfile.userUid];
        if (local) setMembership(local, guild);
      }
      setMembership(user, guild);
      return { ...base, greetingBefore: before };
    }
    case 3443:
    case 3497: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      const key = id === 3443 ? "notice" : "dungeonNotice";
      const before = guild[key];
      guild[key] = String(req.notice || "").slice(0, 500);
      return { ...base, noticeBefore: before, notice: guild[key] };
    }
    case 3445: {
      const guild = requireGuild(ctx, user, req.guildUid);
      guild.members.find(m => m.commonProfile.userUid === String(user.userUid)).greeting = req.greeting;
      return base;
    }
    case 3430:
    case 3433:
    case 3438: {
      const guild = requireGuild(ctx, user, req.guildUid, true);
      const member = guild.members.find(m => m.commonProfile.userUid === String(req.targetUserUid));
      if (!member || member.commonProfile.userUid === guild.masterUserUid) throw new Error("invalid member target");
      if (id === 3430) {
        if (![1, MEMBER].includes(req.grade)) throw new Error("invalid member grade");
        member.grade = req.grade;
      } else if (id === 3433) {
        guild.members = guild.members.filter(m => m !== member);
        const target = ctx.userDb.users && ctx.userDb.users[String(req.targetUserUid)];
        if (target) setMembership(target, null);
      } else {
        const oldMaster = guild.masterUserUid;
        guild.members.find(m => m.commonProfile.userUid === oldMaster).grade = MEMBER;
        guild.masterUserUid = member.commonProfile.userUid;
        member.grade = MASTER;
        return { ...base, oldMasterUserUid: oldMaster, newMasterUserUid: guild.masterUserUid };
      }
      return base;
    }
    case 3447: {
      const guild = requireGuild(ctx, user, req.guildUid);
      const member = guild.members.find(m => m.commonProfile.userUid === String(user.userUid));
      const key = dayKey(ctx);
      const reward = createEmptyReward();
      let delta = 0;
      if (member.attendanceDay !== key) {
        member.attendanceDay = key;
        member.lastAttendanceDate = now;
        let attendance = guild.attendanceList.find(a => a.day === key);
        if (!attendance) guild.attendanceList.push(attendance = { day: key, date: now, count: 0 });
        attendance.count += 1;
        guild.attendanceList = guild.attendanceList.slice(-30);
        for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_ATTENDANCE_TEMPLET.json").filter(r => r.m_RewardCond === "ATTENDANCE_GUILD_GENERAL")) mergeReward(reward, grantRewardByType(ctx, user, row.m_RewardType, row.m_RewardID, row.m_RewardValue));
        delta = Number(guildConstants().AttendanceExp || 50);
        addExp(guild, delta);
      }
      const today = guild.attendanceList.find(a => a.day === key);
      const yesterdayKey = new Date(nowDate(ctx).getTime() - DAY_MS).toISOString().slice(0, 10);
      const yesterday = guild.attendanceList.find(a => a.day === yesterdayKey);
      return { ...base, lastAttendanceDate: member.lastAttendanceDate, memberJoinDate: member.createdAt, rewardData: codec.buildRewardData(reward), additionalReward: { guildExpDelta: delta, unionPointDelta: 0, eventPassExpDelta: 0 }, yesterdayAttendanceCount: yesterday ? yesterday.count : 0, todayAttendanceCount: today ? today.count : 0 };
    }
    case 3461: {
      const guild = requireGuild(ctx, user, req.guildUid);
      const row = readGameplayTableRecords("ab_script", "LUA_GUILD_DONATION_TEMPLET.json").find(r => Number(r.ID) === req.donationId);
      const count = req.donationCount;
      if (!row || !Number.isInteger(count) || count < 1) throw new Error("invalid donation");
      const state = user.privateGuildData;
      if (state.resetDay !== dayKey(ctx)) { state.resetDay = dayKey(ctx); state.donationCount = 0; state.lastDailyResetDate = now; }
      if (Number(state.donationCount || 0) + count > Number(guildConstants().DailyDonationCount || 8)) throw new Error("daily donation limit");
      checkCost(user, row.m_DonateRequireItemID, BigInt(row.m_DonateRequireItemValue) * BigInt(count));
      const cost = spendMiscItem(user, row.m_DonateRequireItemID, BigInt(row.m_DonateRequireItemValue) * BigInt(count));
      const reward = createEmptyReward();
      let expDelta = 0;
      let unionDelta = 0;
      for (let i = 1; i <= 10; i += 1) {
        const rewardId = Number(row[`m_RewardID_${i}`]);
        if (!rewardId) continue;
        const value = Number(row[`m_RewardValue_${i}`]) * count;
        if (rewardId === 503) expDelta += value;
        else if (rewardId === 24) unionDelta += value;
        else mergeReward(reward, grantRewardByType(ctx, user, row[`m_RewardType_${i}`], rewardId, value));
      }
      state.donationCount = Number(state.donationCount || 0) + count;
      addExp(guild, expDelta);
      guild.unionPoint = String(toBigInt(guild.unionPoint) + BigInt(unionDelta));
      const member = guild.members.find(m => m.commonProfile.userUid === String(user.userUid));
      member.totalContributionPoint = String(toBigInt(member.totalContributionPoint) + BigInt(unionDelta));
      member.weeklyContributionPoint = String(toBigInt(member.weeklyContributionPoint) + BigInt(unionDelta));
      return { ...base, costItemDataList: [cost], rewardData: codec.buildRewardData(reward), additionalReward: { guildExpDelta: expDelta, unionPointDelta: unionDelta, eventPassExpDelta: 0 }, donationCount: state.donationCount, lastDailyResetDate: state.lastDailyResetDate };
    }
    case 3451: {
      const guild = requireGuild(ctx, user, req.guildUid);
      const uid = String(toBigInt(guild.nextMessageUid, 0n) + 1n);
      guild.nextMessageUid = uid;
      guild.messages.push({ messageUid: uid, messageType: req.messageType, commonProfile: profile(user), emotionId: req.emotionId, message: String(req.message || "").slice(0, 500), createdAt: now, typeParam: "0", blocked: false });
      guild.messages = guild.messages.slice(-100);
      return { ...base, messageUid: uid };
    }
    case 3454:
      return { ...base, messages: requireGuild(ctx, user, req.guildUid).messages || [] };
    case 3459:
      requireGuild(ctx, user, req.guildUid);
      return { ...base, list: Object.values(ctx.userDb.users || {}).filter(u => toBigInt(u.guildUid) === 0n && String(u.userUid) !== String(user.userUid)).map(u => friendData(ctx, u)) };
    case 3466: {
      requireGuild(ctx, user, req.guildUid);
      const settings = guildConstants();
      if (!Number.isInteger(req.buyCount) || req.buyCount < 1) throw new Error("invalid welfare count");
      const amount = BigInt(req.buyCount) * BigInt(settings.WelfarePointBuyAmount || 5);
      const price = BigInt(req.buyCount) * BigInt(settings.WelfarePointPrice || 30);
      const current = getMiscItem(user, 23);
      if (toBigInt(current.countFree) + toBigInt(current.countPaid) + amount > BigInt(settings.WelfarePointBuyLimit || 100000)) throw new Error("welfare point limit");
      checkCost(user, 101, price);
      const cost = spendMiscItem(user, 101, price);
      const reward = grantRewardByType(ctx, user, "RT_MISC", 23, amount);
      return { ...base, costItemDataList: [cost], rewardData: codec.buildRewardData(reward) };
    }
    case 3500: {
      const guild = requireGuild(ctx, user, user.guildUid, true);
      const name = String(req.newName || "").trim();
      if (!name || name.length > 32 || Object.values(store).some(g => g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("invalid or duplicate guild name");
      const settings = guildConstants();
      const prevName = guild.name;
      if (guild.renameCount >= Number(settings.ConsortiumNameChangeFree || 1)) {
        const earliest = toBigInt(guild.latestRenameDate) + BigInt(settings.ConsortiumNameChangeLimitDay || 30) * 864000000000n;
        if (toBigInt(now) < earliest) throw new Error("guild rename cooldown");
        const price = BigInt(settings.ConsortiumNameChangeResourceValue || 300000);
        if (toBigInt(guild.unionPoint) < price) throw new Error("insufficient union funds");
        guild.unionPoint = String(toBigInt(guild.unionPoint) - price);
      }
      guild.name = name;
      guild.renameCount += 1;
      guild.latestRenameDate = now;
      for (const member of guild.members) {
        const local = ctx.userDb.users && ctx.userDb.users[member.commonProfile.userUid];
        if (local) setMembership(local, guild);
      }
      setMembership(user, guild);
      return { ...base, prevName, newName: name };
    }
    case 3468:
      requireGuild(ctx, user, req.guildUid);
      return base;
    case 3488: {
      const message = (requireGuild(ctx, user, req.guildUid).messages || []).find(m => m.messageUid === String(req.messageUid));
      if (!message) throw new Error("message not found");
      return { ...base, textTranslated: message.message };
    }
    default:
      throw new Error("guild operation unavailable locally");
  }
}

function encodeType(type, value = {}) {
  // Native NKM models are omitted from the generated ClientPacket schema.
  if (type === "NKMItemMiscData") return codec.buildItemMiscData(value);
  if (type === "NKMRewardData") return codec.buildRewardData(value);
  const definition = schema.types[type];
  if (!definition) throw new Error(`missing guild protocol type ${type}`);
  return encodeFields(definition.fields, value);
}

function encodeFields(fields, value = {}) {
  return Buffer.concat(fields.map(field => encodeWire(field.wire, value[field.name])));
}

function encodeWire(wire, value) {
  if (wire.kind === "object") {
    if (value == null) return codec.writeNullObject();
    return codec.writeNullableObject(Buffer.isBuffer(value) ? value : encodeType(wire.type, value));
  }
  if (wire.kind === "list") return codec.writeObjectList((value || []).map(v => encodeWire(wire.element, v)));
  if (wire.kind === "enum") return codec.writeSignedVarInt(Number(value || 0));
  switch (wire.type) {
    case "string": return codec.writeString(value == null ? "" : value);
    case "bool": return codec.writeBool(value);
    case "DateTime": return codec.writeInt64LE(toBigInt(value));
    case "long": return codec.writeSignedVarLong(toBigInt(value));
    case "float": return codec.writeFloatLE(value || 0);
    case "byte": return codec.writeByte(value || 0);
    case "short":
    case "int": return codec.writeSignedVarInt(Number(value || 0));
    default: throw new Error(`unsupported guild wire ${wire.kind}/${wire.type}`);
  }
}

function decodeRequest(id, payload) {
  let offset = 0;
  const result = {};
  for (const field of schema.packets[id].fields) {
    let read;
    if (field.wire.type === "string") read = codec.readString(payload, offset);
    else if (field.wire.type === "long") read = codec.readSignedVarLong(payload, offset);
    else if (field.wire.type === "bool") read = codec.readBool(payload, offset);
    else if (field.wire.type === "byte") read = codec.readByte(payload, offset);
    else read = codec.readSignedVarInt(payload, offset);
    offset = read.offset;
    result[field.name] = typeof read.value === "bigint" ? String(read.value) : read.value;
  }
  if (offset !== payload.length) throw new Error("invalid guild request length");
  return result;
}

function guildDungeonCatalog(ctx) {
  const { season } = cooperative.selectedSeason(ctx);
  const bosses = readGameplayTableRecords("ab_script", "LUA_GUILD_RAID_TEMPLET.json").filter(r => season && r.m_SeasonRaidGroup === season.m_SeasonRaidGroup).sort((a, b) => a.m_RaidStageIndex - b.m_RaidStageIndex);
  return { season, bosses };
}

function guildBossMaxHp(dungeonId) {
  const base = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json").find(row => Number(row.m_DungeonID) === Number(dungeonId));
  if (!base) throw new Error("guild boss dungeon unavailable");
  const table = readGameplayTable("ab_script_dungeon_templet_all", `${base.m_DungeonTempletFileName}.json`) || {};
  const dungeon = table.root || table;
  const stats = ["LUA_UNIT_STAT_TEMPLET.json", "LUA_UNIT_STAT_TEMPLET2.json"].flatMap(name => readGameplayTableRecords("ab_script_unit_data", name)).find(row => row.m_UnitStrID === dungeon.m_BossUnitStrID);
  if (!stats || !stats.m_StatData) throw new Error("guild boss stats unavailable");
  const data = stats.m_StatData;
  // NKMDungeonManager.GetBossHp uses NKMUnitStatManager.CalculateStat at the dungeon level.
  return Math.fround(Math.fround(Number(data.m_Stat.NST_HP || 0)) + Math.fround(Number(data.m_StatPerLevel.NST_HP || 0) * (Number(base.m_DungeonLevel || dungeon.m_BossUnitLevel || 1) - 1)));
}

function buildGuildSeasonIntervals(ctx, user) {
  const store = ensureGuildStore(ctx);
  const guild = user && store[String(user.guildUid || 0)];
  return cooperative.buildSeasonIntervals(ctx, guild || null, { guildBossMaxHp });
}

function prepareGuildArenaGameLoad(ctx, user, req) {
  if (!cooperative.catalog().arenas.some(row => row.m_SeasonDungeonID === Number(req.dungeonID || req.stageID))) return null;
  const guild = requireGuild(ctx, user, user.guildUid);
  return cooperative.prepareArena(ctx, user, guild, req, { guildBossMaxHp });
}

function prepareGuildPractice(ctx, user, req) {
  const guild = requireGuild(ctx, user, user.guildUid);
  return cooperative.prepareBoss(ctx, user, guild, req, { guildBossMaxHp });
}

function completeGuildBattle(ctx, user, game, state, options = {}) {
  if (!user || !game || !game.guildUid) return null;
  const guild = requireGuild(ctx, user, game.guildUid);
  const result = cooperative.completeBattle(ctx, user, guild, game, state || {}, options, { guildBossMaxHp });
  if (!result) return null;
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && ctx.saveUserDb) ctx.saveUserDb();
  return { ...result, packets: result.packets.map(packet => ({ packetId: packet.packetId, payload: encodeFields(schema.packets[packet.packetId].fields, packet.data), label: `guild-coop-${packet.packetId}` })) };
}

function cancelGuildBattle(ctx, user, game = null) {
  if (!user || toBigInt(user.guildUid) === 0n) return null;
  const guild = requireGuild(ctx, user, user.guildUid);
  const result = cooperative.cancelBattle(ctx, user, guild, game, { guildBossMaxHp });
  if (!result) return null;
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && ctx.saveUserDb) ctx.saveUserDb();
  return { packets: result.packets.map(packet => ({ packetId: packet.packetId, payload: encodeFields(schema.packets[packet.packetId].fields, packet.data), label: `guild-coop-${packet.packetId}` })) };
}

function createGuildPracticeHandler() {
  return { packetId: 3485, name: "GUILD_DUNGEON_BOSS_GAME_LOAD_REQ", handle(ctx, socket, packet) {
    let preparedGame = null;
    try {
      const user = socket.session && socket.session.user;
      if (!user || !user.userUid) throw new Error("login required");
      const req = decodeRequest(3485, ctx.decryptCopy ? ctx.decryptCopy(packet.payload) : packet.payload);
      const battle = prepareGuildPractice(ctx, user, req);
      preparedGame = battle.stage;
      if (!ctx.config || !ctx.config.DYNAMIC_BATTLE_MANAGER || !ctx.sendDynamicGameLoadAck || !ctx.sendDynamicGameLoadAck(socket, battle.req, battle.stage)) throw new Error("guild boss combat unavailable");
      return true;
    } catch (err) {
      console.log(`[guild:practice] ${err.message}`);
      if (preparedGame) cancelGuildBattle(ctx, socket.session && socket.session.user, preparedGame);
      ctx.sendGameResponse(socket, packet, 804, Buffer.concat([codec.writeSignedVarInt(err.errorCode || guildErrorCode(err.message)), codec.writeNullObject(), codec.writeObjectList([])]), "guild-practice-unavailable");
      return true;
    }
  } };
}

function guildErrorCode(message) {
  const errors = {
    "already in a guild": 20431, "guild not found": 20432, "guild membership required": 20443,
    "guild master required": 20616, "guild creation level required": 20437,
    "invalid guild name": 20436, "duplicate guild name": 20442,
    "invalid or duplicate guild name": 20436, "guild is full": 20467,
    "guild closed to applications": 20473, "application not found": 20472,
    "local player unavailable": 20445, "invitation not found": 20444,
    "invalid member grade": 20449, "invalid member target": 20448,
    "daily donation limit": 20530, "invalid donation": 24100,
    "welfare point limit": 20587, "message not found": 20721,
    "guild rename cooldown": 27005, "insufficient union funds": 20481,
    "guild closing already requested": 20477, "guild is not closing": 20477,
    "guild operation unavailable locally": 20630,
  };
  return errors[message] || ERROR;
}

function createGuildHandlers() {
  const handlers = Object.values(schema.packets).filter(p => p.namespace === "ClientPacket.Guild" && p.direction === "client->server" && p.id !== 3485).map(request => ({
    packetId: request.id,
    name: request.name.replace(/^NKMPacket_/, ""),
    handle(ctx, socket, packet) {
      const user = socket.session && socket.session.user;
      let response = { errorCode: ERROR };
      let req = {};
      try {
        if (!user || !user.userUid) throw new Error("login required");
        req = decodeRequest(request.id, ctx.decryptCopy ? ctx.decryptCopy(packet.payload) : packet.payload);
        response = handleRequest(ctx, user, request.id, req);
        if (ctx.config && ctx.config.USE_LOCAL_USER_DB && ctx.saveUserDb) ctx.saveUserDb();
        if (ctx.invalidateJoinLobbyAckPayloadCache) ctx.invalidateJoinLobbyAckPayloadCache("guild-state");
      } catch (err) {
        response = { ...req, errorCode: err.errorCode || guildErrorCode(err.message) };
        console.log(`[guild:${request.id}] ${err.message}`);
      }
      const ackId = request.id + 1;
      ctx.sendGameResponse(socket, packet, ackId, encodeFields(schema.packets[ackId].fields, response), `guild-${request.id}`);
      if (request.id === 3400 && response.errorCode === 20431 && ctx.sendServerGamePacket) {
        const guildData = buildGuildDataUpdatedNotPayload(ctx, user);
        if (guildData) ctx.sendServerGamePacket(socket, 3416, guildData, "guild-existing-membership");
      }
      if (!response.errorCode && request.id === 3451 && ctx.sendServerGamePacket) {
        const guild = ensureGuildStore(ctx)[String(user.guildUid)];
        ctx.sendServerGamePacket(socket, 3453, encodeFields(schema.packets[3453].fields, { message: guild.messages[guild.messages.length - 1] }), "guild-chat");
      }
      if (!response.errorCode && [3447, 3461, 3500].includes(request.id) && ctx.sendServerGamePacket) {
        const guild = ensureGuildStore(ctx)[String(user.guildUid)];
        if (guild) ctx.sendServerGamePacket(socket, 3416, encodeFields(schema.packets[3416].fields, { guildData: guild }), "guild-data-update");
      }
      return true;
    },
  }));
  return [...handlers, createGuildPracticeHandler()];
}

module.exports = { createGuildHandlers, handleRequest, encodeType, encodeFields, decodeRequest, guildDungeonCatalog, prepareGuildPractice, reconcileGuildMembership, privateGuildData, buildPrivateGuildData, buildGuildSimpleData, buildGuildDataUpdatedNotPayload, getGuildNameLength, isValidGuildName, buildGuildSeasonIntervals, prepareGuildArenaGameLoad, completeGuildBattle, cancelGuildBattle };
