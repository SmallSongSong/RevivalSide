"use strict";
const { readGameplayTableRecords } = require("../gameplay-jsons");
const codec = require("../packet-codec");
const { createEmptyReward, mergeReward, grantRewardByType } = require("../reward");
let cachedCatalog;
function catalog() {
  if (!cachedCatalog) cachedCatalog = {
    defences: readGameplayTableRecords("ab_script", "LUA_DEFENCE_TEMPLET.json"),
    scores: readGameplayTableRecords("ab_script", "LUA_DEFENCE_SCORE_REWARD_TEMPLET.json"),
    ranks: readGameplayTableRecords("ab_script", "LUA_DEFENCE_RANK_REWARD_TEMPLET.json"),
  };
  return cachedCatalog;
}
function state(user, id) {
  if (!user || !Number.isInteger(id) || id <= 0) return null;
  const stages = user.miscStages ||= {};
  const states = stages.defence ||= {};
  const saved = states[String(id)] ||= {defenceTempletId:id,bestScore:0};
  saved.scoreRewardIds = [...new Set((saved.scoreRewardIds || []).map(Number).filter(value => Number.isInteger(value) && value > 0))];
  return saved;
}
function currentDefence(ctx) {
  const active = ctx && ctx.eventManager && ctx.eventManager.getActiveEventState();
  const seed = active && active.entries.find(entry => entry.source.tableName === "OFFLINE_DEFENCE_EVENT");
  return seed ? catalog().defences.find(row => Number(row.m_Id) === Number(seed.raw.defenceTempletId)) : null;
}
function info(user, id) {
  const saved = state(user, Number(id));
  const score = Math.max(0, Number(saved && saved.bestScore || 0));
  return {scoreRewardIds:saved ? saved.scoreRewardIds.slice() : [], rank:score > 0 ? 1 : 0, rankPercent:score > 0 ? 1 : 0,
    canReceiveRankReward:score > 0 && !saved.rankRewardClaimed};
}
function grantInline(ctx, user, row, prefix) {
  const reward = createEmptyReward();
  for (let slot = 1; slot <= 8; slot++) {
    const type = row[`${prefix}Type_${slot}`];
    const id = Number(row[`${prefix}ID_${slot}`]);
    const quantity = Number(row[`${prefix}Quantity_${slot}`]);
    if (!type || !Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity <= 0) continue;
    mergeReward(reward, grantRewardByType(ctx, user, type, id, quantity, quantity, 0, {expandPackages:false}));
  }
  return reward;
}
function persist(ctx) { if (ctx && typeof ctx.saveUserDb === "function" && (!ctx.config || ctx.config.USE_LOCAL_USER_DB !== false)) ctx.saveUserDb(); }
function scoreReward(ctx, user, rewardId = null) {
  const defence = currentDefence(ctx);
  const saved = defence && state(user, Number(defence.m_Id));
  const rows = defence ? catalog().scores.filter(row => Number(row.DefenceScoreRewardGroupID) === Number(defence.DefenceScoreRewardGroupID)) : [];
  const requested = rewardId == null ? rows : rows.filter(row => Number(row.DefenceScoreRewardID) === Number(rewardId));
  const eligible = saved ? requested.filter(row => Number(saved.bestScore || 0) >= Number(row.Score)) : [];
  const errorCode = !saved || (rewardId != null && !eligible.length) ? 1 : 0;
  const reward = createEmptyReward();
  const claimedIds = [];
  if (!errorCode) for (const row of eligible) {
    const id = Number(row.DefenceScoreRewardID);
    if (saved.scoreRewardIds.includes(id)) continue;
    mergeReward(reward, grantInline(ctx, user, row, "ScoreReward"));
    saved.scoreRewardIds.push(id); claimedIds.push(id);
  }
  if (claimedIds.length) persist(ctx);
  return {errorCode,reward,claimedIds};
}
function rankReward(ctx, user) {
  const defence = currentDefence(ctx);
  const saved = defence && state(user, Number(defence.m_Id));
  if (!saved || Number(saved.bestScore || 0) <= 0) return {errorCode:1,reward:createEmptyReward()};
  if (saved.rankRewardClaimed) return {errorCode:0,reward:createEmptyReward()};
  const row = catalog().ranks.filter(row => Number(row.DefenceRankRewardGroupID) === Number(defence.m_RankRewardGroupID))
    .filter(row => !row.PercentCheck && Number(row.RankValue) >= 1)
    .sort((a,b) => Number(a.RankValue)-Number(b.RankValue))[0];
  if (!row) return {errorCode:1,reward:createEmptyReward()};
  const reward = grantInline(ctx,user,row,"RankReward");
  saved.rankRewardClaimed = true; persist(ctx);
  return {errorCode:0,reward};
}
function rewardPayload(result) { return result.errorCode ? codec.writeNullObject() : codec.writeNullableObject(codec.buildRewardData(result.reward)); }
function handle(ctx,socket,packet) {
  const user = socket.session && socket.session.user;
  let payload;
  if (packet.packetId === 3911) {
    let id = 0;
    try { id = codec.readSignedVarInt(ctx.decryptCopy(packet.payload),0).value; } catch (_) {}
    const result = scoreReward(ctx,user,id);
    payload = Buffer.concat([codec.writeSignedVarInt(result.errorCode),rewardPayload(result),codec.writeSignedVarInt(id)]);
  } else if (packet.packetId === 3913) {
    const result = scoreReward(ctx,user);
    payload = Buffer.concat([codec.writeSignedVarInt(result.errorCode),codec.writeIntList(result.claimedIds),rewardPayload(result)]);
  } else {
    const result = rankReward(ctx,user);
    payload = Buffer.concat([codec.writeSignedVarInt(result.errorCode),rewardPayload(result)]);
  }
  ctx.sendGameResponse(socket,packet,packet.packetId+1,payload,"defence-season-reward");
  return true;
}
module.exports = {catalog,state,currentDefence,info,scoreReward,rankReward,handle};
