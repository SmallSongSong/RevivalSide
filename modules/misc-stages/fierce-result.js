"use strict";

const {
  writeSignedVarInt, writeSignedVarLong, writeSByte, writeNullableObject,
  writeNullObject, writeObjectList, writeVarInt, toBigInt,
} = require("../packet-codec");

function recordFierceResult(replay, seasonState, result, options = {}) {
  const game = replay && replay.dynamicGame;
  if (!game || (game.miscMode !== "fierce" && Number(game.gameType) !== 14)) return null;
  const bossId = positiveInt(game.fierceBossId || game.fierceBossID);
  const gameUid = String(game.gameUID || game.gameUid || "");
  if (!bossId || !gameUid || gameUid === "0" || !seasonState || !seasonState.season || !seasonState.fierce) return null;
  if (positiveInt(result && result.bossId) !== bossId) throw new Error("Fierce result does not match the active battle boss");
  const { season, fierce } = seasonState;
  season.bosses ||= {};
  fierce.bosses ||= {};
  season.settledGameUids ||= {};
  if (Object.hasOwn(season.settledGameUids, gameUid)) return { changed: false, boss: season.bosses[String(bossId)] };
  const previous = season.bosses[String(bossId)] || {};
  const point = nonnegative(result.accquirePoint);
  const previousPoint = nonnegative(previous.point);
  const bestRecord = point > previousPoint || (point === previousPoint && !previous.bestDeck);
  const win = options.win === true;
  const updated = {
    ...previous, bossId, point: Math.max(previousPoint, point),
    isCleared: Boolean(previous.isCleared || win),
    lastPoint: point, lastWin: win,
    bestPenaltyIds: [...(previous.bestPenaltyIds || previous.penaltyIds || [])],
  };
  updated.rankNumber = updated.point > 0 ? 1 : 0;
  updated.rankPercent = updated.point > 0 ? 1 : 0;
  if (bestRecord) {
    updated.penaltyPoint = nonnegative(result.penaltyPoint);
    updated.penaltyIds = [...new Set((result.penaltyIds || []).map(positiveInt).filter(Boolean))];
    updated.bestPenaltyIds = updated.penaltyIds.slice();
    const deck = game.playerDeck || options.playerDeck;
    if (deck && Array.isArray(deck.units) && deck.units.length) updated.bestDeck = clone(deck);
  }
  season.bosses[String(bossId)] = updated;
  fierce.bosses[String(bossId)] = updated;
  season.settledGameUids[gameUid] = { bossId, point, win };
  const groupPoints = new Map();
  for (const row of options.bossRows || []) {
    const groupId = positiveInt(row.FierceBossGroupID);
    const rowBossId = positiveInt(row.FierceBossID);
    if (!groupId || !rowBossId) continue;
    const boss = season.bosses[String(rowBossId)] || {};
    groupPoints.set(groupId, Math.max(groupPoints.get(groupId) || 0, nonnegative(boss.point)));
  }
  if (groupPoints.size) {
    season.totalPoint = [...groupPoints.values()].reduce((sum, value) => sum + value, 0);
    season.rankNumber = season.totalPoint > 0 ? 1 : 0;
    season.rankPercent = season.totalPoint > 0 ? 1 : 0;
    fierce.rankNumber = season.rankNumber;
    fierce.rankPercent = season.rankPercent;
  }
  return { changed: true, boss: updated };
}

// NKMFierceBoss.deckData and NKMFierceResultData.bestDeck are NKMEventDeckData.
function buildFierceEventDeckData(deck) {
  if (!deck || !Array.isArray(deck.units) || !deck.units.length) return null;
  const units = deck.units.filter(unit => Number.isInteger(unit.slotIndex) && unit.slotIndex >= 0 && toBigInt(unit.unitUid || 0) > 0n);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(deck.shipUid || 0)),
    writeVarInt(units.length),
    ...units.flatMap(unit => [writeSignedVarInt(unit.slotIndex), writeSignedVarLong(toBigInt(unit.unitUid))]),
    writeSignedVarLong(toBigInt(deck.operatorUid || 0)),
    writeSignedVarInt(Number.isInteger(deck.leaderIndex) ? deck.leaderIndex : -1),
  ]);
}

// NKMFierceProfileData.profileDeck is NKMDummyDeckData, with actual empty slots.
function buildFierceProfileDeckData(deck) {
  if (!deck || !Array.isArray(deck.units) || !deck.units.length) return null;
  const units = Array(8).fill(null);
  for (const unit of deck.units) {
    if (Number.isInteger(unit.slotIndex) && unit.slotIndex >= 0 && unit.slotIndex < units.length) units[unit.slotIndex] = unit;
  }
  const ship = positiveInt(deck.shipUnitId) ? {
    unitId: deck.shipUnitId, level: deck.shipLevel, skinId: deck.shipSkinId,
    limitBreakLevel: deck.shipLimitBreakLevel,
  } : null;
  const operator = positiveInt(deck.operatorId) ? {
    unitId: deck.operatorId, level: deck.operatorLevel,
  } : null;
  const nullable = unit => unit ? writeNullableObject(dummyUnit(unit)) : writeNullObject();
  return Buffer.concat([
    writeSByte(Number.isInteger(deck.leaderIndex) ? deck.leaderIndex : -1),
    nullable(ship), nullable(operator), writeObjectList(units.map(nullable)),
  ]);
}

function dummyUnit(unit) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(unit.unitId)), writeSignedVarInt(positiveInt(unit.level)),
    writeSignedVarInt(nonnegative(unit.skinId)), writeSignedVarInt(nonnegative(unit.limitBreakLevel)),
    writeSignedVarInt(nonnegative(unit.tacticLevel)), writeSignedVarInt(nonnegative(unit.reactorLevel)),
  ]);
}
function clone(value) { return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry)); }
function positiveInt(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : 0; }
function nonnegative(value) { return Math.max(0, Math.trunc(Number.isFinite(Number(value)) ? Number(value) : 0)); }

module.exports = { recordFierceResult, buildFierceEventDeckData, buildFierceProfileDeckData };
