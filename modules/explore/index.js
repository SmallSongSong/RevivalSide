"use strict";

const codec = require("../packet-codec");
const { readGameplayTableRecords, readGameplayTable } = require("../gameplay-jsons");
const { createUnitData, grantOperator, buildPlayerDeckForGameLoad } = require("../unit");
const { getUnitTemplet } = require("../game-data");
const { randomUUID, randomInt } = require("node:crypto");
const STATE = Object.freeze({ START: 1, EXPLORING: 10, BATTLE_READY: 20, BATTLE_LOAD: 21, BATTLE: 22, SELECT_EVENT: 30, SELECT_REWARD: 40, SET_UNIT: 50, SET_OPERATOR: 60, UPGRADE_SHIP: 70, CLEAR: 80, ANNIHILATION: 90 });
const ERROR = 20191;
let catalog;

function getCatalog() {
  if (catalog) return catalog;
  const table = name => readGameplayTableRecords("ab_script", `${name}.json`);
  catalog = { templets: table("LUA_EXPLORE_TEMPLET"), zones: table("LUA_EXPLORE_ZONE_TEMPLET"), stages: table("LUA_EXPLORE_STAGE_TEMPLET"), paths: table("LUA_EXPLORE_PATH_TEMPLET"), rewards: table("LUA_EXPLORE_REWARD_GROUP"), events: table("LUA_EXPLORE_EVENT_TEMPLET"), artifacts: table("LUA_EXPLORE_ARTIFACT_TEMPLET") };
  return catalog;
}

function getRun(user) { return user && user.localExplore || null; }
function requireRun(user) { const run = getRun(user); if (!run) throw new Error("exploration not started"); return run; }
function getTemplet(id) { const row = getCatalog().templets.find(r => Number(r.ExploreID) === Number(id)); if (!row) throw new Error("invalid exploration templet"); return row; }
function explorationUnit(user, id, uid, level = 100) { return createUnitData(user, Number(id), BigInt(uid), { level, skillLevels: [5, 5, 5, 5, 5], fromContract: false }); }
function weightedPick(rows) {
  let value = randomInt(rows.reduce((sum, row) => sum + Math.max(1, Number(row.Ratio || 1)), 0));
  for (const row of rows) { value -= Math.max(1, Number(row.Ratio || 1)); if (value < 0) return row; }
  return rows[rows.length - 1];
}

function createSquad(user, templet) {
  const units = {};
  const prefix = 9500000000000000n;
  for (const [index, id] of (templet.FirstSquadUnit || []).entries()) {
    const unit = explorationUnit(user, id, prefix + BigInt(index + 1));
    units[unit.unitUid] = unit;
  }
  const ship = explorationUnit(user, templet.FirstSquadShip, prefix + 100n, 100);
  const temporary = { userUid: user.userUid, nextUnitUid: String(prefix + 200n), army: {} };
  const operator = grantOperator(temporary, 31301, { level: 100, subSkillId: 1013, fromContract: false });
  return { units, ship, operatorUnit: operator, nextUnitUid: String(prefix + 1000n) };
}

function makeDeck(squad) {
  const unitUids = Object.keys(squad.units).slice(0, 4);
  while (unitUids.length < 8) unitUids.push(0);
  return { deckType: 10, index: 0, name: "", shipUid: squad.ship.unitUid, operatorUid: squad.operatorUnit.uid, unitUids, leaderIndex: 0, state: 0 };
}

function generateZone(templet, zoneId) {
  const source = getCatalog().zones.find(z => Number(z.Zone) === Number(zoneId));
  if (!source) throw new Error("invalid exploration zone");
  const steps = [];
  for (let index = 1; index <= Number(source.ZoneStageCount); index += 1) {
    const rows = getCatalog().stages.filter(row => Number(row.StageGroupID) === Number(source[`StageGroupID_${index}`]) && Number(row.Ratio) > 0);
    if (!rows.length) throw new Error("exploration stage group missing");
    const count = Number(source[`StageSlotCount_${index}`] || 1);
    const pool = [...rows];
    steps.push({ step: index - 1, stages: Array.from({ length: count }, (_, slotIndex) => {
      const selected = weightedPick(pool.length ? pool : rows);
      if (pool.length) pool.splice(pool.indexOf(selected), 1);
      return { stageId: selected.StageID, slotIndex, pathId: 0, isClear: false };
    }) });
  }
  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index];
    const targetCount = steps[index + 1] ? steps[index + 1].stages.length : current.stages.length;
    for (const stage of current.stages) {
      const paths = getCatalog().paths.filter(p => Number(p.PathPatternGroupID) === Number(templet.PathPatternGroupID) && Number(p.SourceCount) === current.stages.length && Number(p.TargetCount) === targetCount && Number(p.SourceIndex) === stage.slotIndex);
      if (!paths.length) throw new Error("exploration path pattern missing");
      stage.pathId = paths[0].PathPatternID;
    }
  }
  return { zoneId: Number(zoneId), steps };
}

function enter(user, id, extra = false) {
  const templet = getTemplet(id);
  const previous = getRun(user);
  const same = previous && previous.templetId === Number(id) && previous.squad;
  if (same && !extra && ![STATE.CLEAR, STATE.ANNIHILATION].includes(previous.state) && !(previous.state === STATE.EXPLORING && previous.currentStep === previous.zone.steps.length - 1)) return previous;
  if (same && previous.state === STATE.ANNIHILATION) throw new Error("reset defeated exploration first");
  let zonePosition = same && !extra ? previous.zonePosition + 1 : 1;
  let zoneId = extra ? templet.ZONE_ID_EX : templet[`ZONE_ID_${zonePosition}`];
  if (!zoneId) { if (same) return previous; throw new Error("exploration zone unavailable"); }
  if (extra && (!same || previous.state !== STATE.CLEAR)) throw new Error("complete the main exploration first");
  const squad = same ? previous.squad : createSquad(user, templet);
  const run = same ? previous : { templetId: Number(id), runId: randomUUID(), squad, deck: makeDeck(squad), maxHp: 100, currentHp: 100, seasonScore: String(previous && previous.seasonScore || 0), score: "0", scoreEX: "0", artifacts: [], selectionList: [], selectEvent: 0, rewardValue: { id: 0, value: 0 }, clearStageIndexList: [], rerollCount: 0, enhancePoint: Number(previous && previous.enhancePoint || 0), completedBattleTokens: [] };
  run.zonePosition = zonePosition;
  run.extra = extra;
  run.currentZone = Number(zoneId);
  run.zone = generateZone(templet, zoneId);
  run.currentStep = -1;
  run.currentSlotIndex = 0;
  run.state = STATE.START;
  run.selectionList = [];
  run.selectEvent = 0;
  run.clearStageIndexList = [];
  run.pendingBattle = null;
  user.localExplore = run;
  return run;
}

function reset(user) {
  const old = requireRun(user);
  const run = { ...old, state: STATE.START, currentZone: -1, currentStep: -1, currentSlotIndex: -1, score: "0", scoreEX: "0", artifacts: [], selectionList: [], rewardValue: { id: 0, value: 0 }, squad: null, deck: null, pendingBattle: null };
  user.localExplore = run;
  return run;
}

function currentNode(run) { const step = run.zone && run.zone.steps[run.currentStep]; return step && step.stages[run.currentSlotIndex] || null; }
function stageRow(run) { const node = currentNode(run); return node && getCatalog().stages.find(row => Number(row.StageID) === Number(node.stageId)) || null; }

function move(user, slotIndex) {
  const run = requireRun(user);
  if (![STATE.START, STATE.EXPLORING].includes(run.state)) throw new Error("resolve the current node before moving");
  const nextStep = run.currentStep + 1;
  const step = run.zone.steps[nextStep];
  if (!step || !Number.isInteger(slotIndex) || !step.stages[slotIndex]) throw new Error("invalid exploration destination");
  if (run.currentStep >= 0) {
    const path = getCatalog().paths.find(p => p.PathPatternGroupID === getTemplet(run.templetId).PathPatternGroupID && p.PathPatternID === currentNode(run).pathId);
    if (!path || !path.MoveAblePathList.includes(slotIndex)) throw new Error("unreachable exploration destination");
  }
  run.currentStep = nextStep;
  run.currentSlotIndex = slotIndex;
  run.selectEvent = 0;
  run.eventDungeonId = 0;
  run.eventRewardGroup = 0;
  run.rewardValue = { id: 0, value: 0 };
  run.selectionList = [];
  const row = stageRow(run);
  if (!row) throw new Error("exploration stage unavailable");
  if (row.StageType === "EVENT_SELECTION") {
    run.state = STATE.SELECT_EVENT;
    run.selectionList = getCatalog().events.filter(e => Number(e.EventGroupID) === Number(row.EventValue)).map(e => ({ id: e.EventID, value: 0 }));
  } else run.state = STATE.BATTLE_READY;
  return run;
}

function finishNode(run) {
  const node = currentNode(run);
  if (node) node.isClear = true;
  if (!run.clearStageIndexList.includes(run.currentStep)) run.clearStageIndexList.push(run.currentStep);
  const templet = getTemplet(run.templetId);
  const lastStep = run.currentStep === run.zone.steps.length - 1;
  const lastZone = run.extra || !templet[`ZONE_ID_${run.zonePosition + 1}`];
  run.state = lastStep && lastZone ? STATE.CLEAR : STATE.EXPLORING;
  run.selectionList = [];
  run.pendingBattle = null;
  if (lastStep) {
    const zone = getCatalog().zones.find(z => Number(z.Zone) === run.currentZone);
    run.enhancePoint += Number(zone && zone.ZoneClearEnhancePoint || 0);
  }
}

function generateRewardSelections(run, groupId, type = null, excludeIds = []) {
  run.selectionGroupId = Number(groupId || 0);
  let rows = getCatalog().rewards.filter(row => Number(row.RewardGroupID) === Number(groupId) && Number(row.Ratio) > 0 && (!type || row.RewardType === type));
  const alternatives = rows.filter(row => !excludeIds.includes(Number(row.RewardID)));
  if (alternatives.length >= 3) rows = alternatives;
  const pool = [...rows];
  const choices = [];
  while (pool.length && choices.length < 3) {
    const row = weightedPick(pool);
    choices.push({ id: Number(row.RewardID), value: row.RewardType === "RT_OPERATOR" ? Number((row.RandomOprSkill || [1013])[0]) : 1 });
    for (let i = pool.length - 1; i >= 0; i -= 1) if (pool[i].RewardID === row.RewardID) pool.splice(i, 1);
  }
  run.selectionType = rows[0] && rows[0].RewardType || type || "NONE";
  run.selectionList = choices.slice(0, 3);
  if (!run.selectionList.length) finishNode(run);
  else run.state = STATE.SELECT_REWARD;
}

function selectReward(user, choice, skip = false) {
  const run = requireRun(user);
  if (run.state !== STATE.SELECT_REWARD) throw new Error("no exploration reward to select");
  if (skip) { run.rewardValue = { id: 0, value: 0 }; finishNode(run); return run; }
  const selected = run.selectionList.find(c => c.id === Number(choice && choice.id) && c.value === Number(choice && choice.value));
  if (!selected) throw new Error("invalid exploration reward selection");
  run.rewardValue = { ...selected };
  run.selectionList = [];
  if (run.selectionType === "RT_UNIT") {
    const existing = Object.values(run.squad.units).find(u => u.unitId === selected.id);
    if (existing) { existing.level = Math.min(120, existing.level + selected.value); finishNode(run); }
    else if (Object.keys(run.squad.units).length < Number(getTemplet(run.templetId).UnitHaveCount || 12)) { addSquadUnit(user, run, selected.id); finishNode(run); }
    else run.state = STATE.SET_UNIT;
  } else if (run.selectionType === "RT_ARTIFACT") {
    if (!run.artifacts.includes(selected.id)) run.artifacts.push(selected.id);
    finishNode(run);
  } else if (run.selectionType === "RT_OPERATOR") run.state = STATE.SET_OPERATOR;
  else if (run.selectionType === "RT_SHIP") run.state = STATE.UPGRADE_SHIP;
  else throw new Error("unsupported exploration reward type");
  return run;
}

function addSquadUnit(user, run, id, targetUid = null) {
  if (!getUnitTemplet(id)) throw new Error("invalid exploration unit");
  const uid = targetUid || run.squad.nextUnitUid;
  if (!targetUid) run.squad.nextUnitUid = String(BigInt(uid) + 1n);
  run.squad.units[String(uid)] = explorationUnit(user, id, uid);
  if (!run.deck.unitUids.some(v => String(v) === String(uid))) {
    const free = run.deck.unitUids.findIndex(v => !v || v === "0");
    if (free >= 0 && run.deck.unitUids.filter(v => BigInt(v || 0) > 0n).length < 4) run.deck.unitUids[free] = String(uid);
  }
}

function selectEvent(user, choice) {
  const run = requireRun(user);
  if (run.state !== STATE.SELECT_EVENT || !run.selectionList.some(c => c.id === Number(choice && choice.id))) throw new Error("invalid exploration event selection");
  const row = getCatalog().events.find(e => Number(e.EventID) === Number(choice.id) && Number(e.EventGroupID) === Number(stageRow(run).EventValue));
  if (!row) throw new Error("exploration event unavailable");
  run.selectEvent = row.EventID;
  run.selectionList = [];
  run.rewardValue = { id: 0, value: 0 };
  if (row.EventType === "DUNGEON_CLEAR") { run.eventDungeonId = Number(row.EventValue); run.eventRewardGroup = Number(row.RewardValue); run.state = STATE.BATTLE_READY; return run; }
  if (row.EventType === "SHIP_BREAK") {
    run.currentHp = Math.max(0, run.currentHp - run.maxHp * Number(row.EventValue || 0) / 100);
    if (run.currentHp <= 0) { run.state = STATE.ANNIHILATION; return run; }
  }
  if (row.EventType === "SKIP" || row.RewardType === "NONE") { finishNode(run); return run; }
  if (row.RewardType === "SHIP_REPAIR") { run.currentHp = Math.min(run.maxHp, run.currentHp + run.maxHp * Number(row.RewardValue || 0) / 100); finishNode(run); return run; }
  if (row.RewardType === "UNIT_UPGRADE") {
    for (const unit of Object.values(run.squad.units)) unit.level = Math.min(120, unit.level + Number(row.RewardValue || 1));
    finishNode(run); return run;
  }
  if (row.RewardType === "SHIP_UPGRADE") {
    run.selectionType = "RT_SHIP";
    const choices = (getTemplet(run.templetId).ShipUpgradeGroup || []).flatMap(group => getCatalog().rewards.filter(r => Number(r.RewardGroupID) === Number(group))).slice(0, 3);
    run.selectionList = choices.map(r => ({ id: Number(r.RewardID), value: 1 }));
    run.state = STATE.UPGRADE_SHIP; return run;
  }
  const type = { UNIT_GET: "RT_UNIT", ARTIFACT_GET: "RT_ARTIFACT", OPERATOR_GET: "RT_OPERATOR" }[row.RewardType];
  if (!type) throw new Error("unsupported exploration event reward");
  generateRewardSelections(run, row.RewardValue, type);
  return run;
}

function prepareGameLoad(user, req, options = {}) {
  const run = requireRun(user);
  if (![STATE.BATTLE_READY, STATE.BATTLE_LOAD].includes(run.state) || Number(req.exploreID || 0) !== run.templetId) throw new Error("exploration battle is not ready");
  const row = stageRow(run);
  const dungeonID = run.eventDungeonId || Number(row && row.EventValue);
  if (!row || !dungeonID || Number(req.dungeonID || 0) && Number(req.dungeonID) !== dungeonID) throw new Error("invalid exploration battle dungeon");
  const deck = { ...run.deck, deckType: 10, index: Number(req.selectDeckIndex || 0) };
  const temporary = { userUid: user.userUid, nickname: user.nickname, level: user.level, army: { units: run.squad.units, ships: { [run.squad.ship.unitUid]: run.squad.ship }, operators: { [run.squad.operatorUnit.uid]: run.squad.operatorUnit }, decks: [], deckSets: { 10: { [deck.index]: deck } } } };
  const playerDeck = buildPlayerDeckForGameLoad(temporary, { exploreID: run.templetId, selectDeckIndex: deck.index }, { deckIndex: { deckType: 10, index: deck.index } });
  if (!playerDeck) throw new Error("exploration squad has no deployed units");
  const resolved = options.resolveStage ? options.resolveStage({ dungeonID }) : {};
  if (options.resolveStage && (!resolved || Number(resolved.dungeonID) !== dungeonID)) throw new Error("exploration dungeon unavailable");
  if (!run.pendingBattle) run.pendingBattle = { token: `${run.runId}:${run.currentZone}:${run.currentStep}:${run.currentSlotIndex}`, dungeonID };
  run.state = STATE.BATTLE_LOAD;
  const artifactConditions = run.artifacts.map(id => getCatalog().artifacts.find(a => Number(a.ArtifactID) === id)).filter(Boolean).map(a => Number(a.RefBattleCondition_ID)).filter(Boolean);
  return { ...resolved, stageId: row.StageID, dungeonID, gameType: 29, miscMode: "explore", exploreID: run.templetId, exploreStageId: row.StageID, exploreRunId: run.runId, exploreBattleToken: run.pendingBattle.token, exploreZoneId: run.currentZone, exploreStep: run.currentStep, exploreSlotIndex: run.currentSlotIndex, shipInitHp: Math.max(0, Math.min(1, run.currentHp / run.maxHp)), playerDeck, battleConditionIds: Array.from(new Set([...(resolved && resolved.battleConditionIds || []), ...artifactConditions])), tutorial: false, cutsceneOnly: false, eventDeckId: 0, EventDeckId: 0 };
}

function completeBattle(user, dynamicGame, battleState = {}, options = {}) {
  const run = getRun(user);
  if (!run || !dynamicGame) return null;
  const token = dynamicGame.exploreBattleToken;
  if (dynamicGame.exploreRunId !== run.runId || !run.pendingBattle || token !== run.pendingBattle.token || run.completedBattleTokens.includes(token)) return null;
  run.completedBattleTokens.push(token);
  const units = battleState.units || battleState.Units || [];
  const ship = units.find(unit => Number(unit.team ?? unit.Team) === 1 && String(unit.role ?? unit.Role) === "ship");
  const hp = Number(battleState.diveShipCurHp ?? battleState.DiveShipCurHp ?? (ship && (ship.hp ?? ship.Hp)));
  const maxHp = Number(battleState.diveShipMaxHp ?? battleState.DiveShipMaxHp ?? (ship && (ship.maxHp ?? ship.MaxHp)));
  if (maxHp > 0 && Number.isFinite(hp)) run.currentHp = Math.max(0, Math.min(run.maxHp, hp / maxHp * run.maxHp));
  if (!options.win || run.currentHp <= 0) { run.currentHp = 0; run.state = STATE.ANNIHILATION; run.pendingBattle = null; return run; }
  const row = stageRow(run);
  run.score = String(BigInt(run.score || 0) + BigInt(Math.max(1, Number(battleState.killCount || 1))) * 100n);
  run.seasonScore = String(BigInt(run.seasonScore || 0) + 100n);
  if (run.extra) run.scoreEX = run.score;
  generateRewardSelections(run, run.eventRewardGroup || row.RewardGroupID);
  run.eventDungeonId = 0;
  run.eventRewardGroup = 0;
  run.pendingBattle = null;
  return run;
}

function serializeExplore(run) {
  return Buffer.concat([codec.writeSignedVarInt(run.templetId), codec.writeFloatLE(run.maxHp || 100), codec.writeFloatLE(run.currentHp == null ? 100 : run.currentHp), codec.writeSignedVarLong(BigInt(run.seasonScore || 0)), codec.writeSignedVarLong(BigInt(run.score || 0)), codec.writeSignedVarInt(run.currentZone == null ? -1 : run.currentZone), codec.writeSignedVarInt(run.currentStep == null ? -1 : run.currentStep), codec.writeSignedVarInt(run.currentSlotIndex == null ? -1 : run.currentSlotIndex), codec.writeIntList(run.artifacts || []), codec.writeNullableObjectList((run.selectionList || []).map(serializeChoice)), codec.writeSignedVarInt(run.selectEvent || 0), codec.writeNullableObject(serializeChoice(run.rewardValue || { id: 0, value: 0 })), codec.writeIntList(run.clearStageIndexList || []), codec.writeSignedVarInt(run.state || STATE.START), codec.writeSignedVarInt(run.rerollCount || 0), codec.writeSignedVarLong(BigInt(run.scoreEX || 0))]);
}
function serializeChoice(choice) { return Buffer.concat([codec.writeSignedVarInt(Number(choice.id || 0)), codec.writeSignedVarInt(Number(choice.value || 0))]); }
function serializeSquad(squad) {
  if (!squad) return codec.writeNullObject();
  return codec.writeNullableObject(Buffer.concat([squad.operatorUnit ? codec.writeNullableObject(codec.buildOperatorData(squad.operatorUnit)) : codec.writeNullObject(), squad.ship ? codec.writeNullableObject(codec.buildUnitData(squad.ship)) : codec.writeNullObject(), codec.writeObjectMapLong(Object.entries(squad.units).map(([uid, unit]) => [BigInt(uid), codec.buildUnitData(unit)]))]));
}
function serializeZone(zone) { return codec.writeNullableObject(Buffer.concat([codec.writeSignedVarInt(zone.zoneId), codec.writeNullableObjectList(zone.steps.map(step => Buffer.concat([codec.writeSignedVarInt(step.step), codec.writeNullableObjectList(step.stages.map(stage => Buffer.concat([codec.writeSignedVarInt(stage.stageId), codec.writeSignedVarInt(stage.slotIndex), codec.writeSignedVarInt(stage.pathId), codec.writeBool(stage.isClear)])))])))])); }
function serializeGameEndParts(user) {
  const run = requireRun(user);
  return { explore: codec.writeNullableObject(serializeExplore(run)), squad: serializeSquad(run.squad), enhancePoint: codec.writeSignedVarInt(Number(run.enhancePoint || 0)) };
}

function buildExploreDeckResponse(user, packetId, req, delegate) {
  const run = requireRun(user);
  const index = codec.writeNullableObject(codec.buildDeckIndexData(req.deckIndex));
  try {
    if ([STATE.BATTLE_LOAD, STATE.BATTLE, STATE.ANNIHILATION].includes(run.state) || Number(req.deckIndex.index) !== 0) throw new Error("exploration deck is not editable");
    const selected = packetId === 1608 ? req.unitUIDList : packetId === 1606 ? [req.unitUID] : [];
    if ((selected || []).some(uid => BigInt(uid || 0) > 0n && !run.squad.units[String(uid)])) throw new Error("unit does not belong to the exploration squad");
    if (req.shipUID && String(req.shipUID) !== "0" && String(req.shipUID) !== run.squad.ship.unitUid) throw new Error("ship does not belong to the exploration squad");
    if (req.operatorUid && String(req.operatorUid) !== "0" && String(req.operatorUid) !== run.squad.operatorUnit.uid) throw new Error("operator does not belong to the exploration squad");
    const temporary = { userUid: user.userUid, army: { units: run.squad.units, ships: { [run.squad.ship.unitUid]: run.squad.ship }, operators: { [run.squad.operatorUnit.uid]: run.squad.operatorUnit }, decks: [], deckSets: { 10: [JSON.parse(JSON.stringify(run.deck))] } } };
    const response = delegate(temporary, packetId, req);
    const deck = temporary.army.deckSets[10][0];
    if (deck.unitUids.filter(uid => BigInt(uid || 0) > 0n).length > 4) throw new Error("exploration deployment limit is four units");
    run.deck = deck;
    return response;
  } catch (err) {
    const error = codec.writeSignedVarInt(ERROR);
    let payload;
    if (packetId === 1600) payload = Buffer.concat([error,index,codec.writeSByte(-1),codec.writeByte(req.slotIndexFrom),codec.writeByte(req.slotIndexTo),codec.writeSignedVarLong(0n),codec.writeSignedVarLong(0n)]);
    else if (packetId === 1602) payload = Buffer.concat([error,index,codec.writeSByte(-1)]);
    else if (packetId === 1606) payload = Buffer.concat([error,index,codec.writeByte(req.slotIndex),codec.writeSignedVarLong(BigInt(req.unitUID || 0)),codec.writeNullObject(),codec.writeSByte(-1),codec.writeSByte(-1),codec.writeSByte(-1)]);
    else if (packetId === 1608) payload = Buffer.concat([index,error,codec.writeNullObject()]);
    else if (packetId === 1610) payload = Buffer.concat([error,index,codec.writeNullObject(),codec.writeSignedVarLong(BigInt(req.shipUID || 0))]);
    else if (packetId === 1612) payload = Buffer.concat([error,index,codec.writeSignedVarLong(BigInt(req.operatorUid || 0)),codec.writeNullObject()]);
    else return null;
    console.log(`[explore:deck] ${err.message}`);
    return { packetId: packetId + 1, payload };
  }
}

function decode(id, payload) {
  let offset = 0;
  const read = name => { const r = codec[name](payload, offset); offset = r.offset; return r.value; };
  const choice = () => read("readBool") ? { id: read("readSignedVarInt"), value: read("readSignedVarInt") } : null;
  let req;
  if ([1255,1257,1259].includes(id)) req = { templetId: read("readSignedVarInt") };
  else if (id === 1263) req = { slotIndex: read("readSignedVarInt") };
  else if (id === 1265) req = { choiceItem: choice(), skip: read("readBool") };
  else if (id === 1267) req = { choiceItem: choice() };
  else if (id === 1269) req = { choiceItem: choice(), targetUid: String(read("readSignedVarLong")), skip: read("readBool") };
  else if (id === 1271) req = { choiceItem: choice(), skip: read("readBool") };
  else if (id === 1273) req = { shipId: read("readSignedVarInt"), skip: read("readBool") };
  else if ([1275,1279,1281].includes(id)) req = { id: read("readSignedVarInt") };
  else req = {};
  if (offset !== payload.length) throw new Error("invalid exploration request payload");
  return req;
}

function handlerPayload(user, id, req) {
  const ok = codec.writeSignedVarInt(0);
  if (id === 1255) {
    const templet = getTemplet(req.templetId);
    const run = getRun(user) && getRun(user).templetId === Number(req.templetId) ? getRun(user) : { templetId: templet.ExploreID, state: STATE.START, currentZone: -1, currentStep: -1, currentSlotIndex: -1 };
    return Buffer.concat([ok, codec.writeNullableObject(serializeExplore(run)), codec.writeIntList([]), codec.writeVarInt(0), codec.writeSignedVarInt(run.enhancePoint || 0)]);
  }
  if ([1257,1259].includes(id)) {
    const run = enter(user, req.templetId, id === 1259);
    if (!run.squad) { delete user.localExplore; return handlerPayload(user, id, req); }
    return Buffer.concat([ok, codec.writeNullableObject(serializeExplore(run)), serializeZone(run.zone), serializeSquad(run.squad), codec.writeNullableObject(codec.buildDeckData(run.deck))]);
  }
  if (id === 1261) { const run = reset(user); return Buffer.concat([ok, codec.writeNullableObject(serializeExplore(run)), codec.writeSignedVarInt(run.enhancePoint || 0)]); }
  if (id === 1263) return Buffer.concat([ok, codec.writeNullableObject(serializeExplore(move(user, req.slotIndex)))]);
  if (id === 1265 || id === 1267) {
    const run = id === 1265 ? selectReward(user, req.choiceItem, req.skip) : selectEvent(user, req.choiceItem);
    return Buffer.concat([ok, codec.writeNullableObject(serializeExplore(run)), serializeSquad(run.squad)]);
  }
  if (id === 1269) {
    const run = requireRun(user);
    if (run.state !== STATE.SET_UNIT) throw new Error("no exploration unit replacement");
    if (!req.skip) { if (!run.squad.units[req.targetUid] || Number(req.choiceItem && req.choiceItem.id) !== run.rewardValue.id) throw new Error("invalid exploration replacement"); addSquadUnit(user, run, run.rewardValue.id, req.targetUid); }
    finishNode(run);
    return Buffer.concat([ok, serializeSquad(run.squad), codec.writeSignedVarInt(run.state)]);
  }
  if (id === 1271) {
    const run = requireRun(user);
    if (run.state !== STATE.SET_OPERATOR) throw new Error("no exploration operator replacement");
    if (!req.skip) {
      if (Number(req.choiceItem && req.choiceItem.id) !== run.rewardValue.id) throw new Error("invalid exploration operator");
      const temporary = { userUid: user.userUid, nextUnitUid: run.squad.nextUnitUid, army: {} };
      run.squad.operatorUnit = grantOperator(temporary, run.rewardValue.id, { level: 100, subSkillId: run.rewardValue.value, fromContract: false });
      run.squad.nextUnitUid = String(BigInt(run.squad.nextUnitUid) + 1n);
      run.deck.operatorUid = run.squad.operatorUnit.uid;
    }
    finishNode(run);
    return Buffer.concat([ok, codec.writeSignedVarInt(run.state), serializeSquad(run.squad)]);
  }
  if (id === 1273) {
    const run = requireRun(user);
    if (run.state !== STATE.UPGRADE_SHIP) throw new Error("no exploration ship upgrade");
    if (!req.skip) {
      const valid = run.selectionList.some(c => c.id === req.shipId) || run.rewardValue.id === req.shipId;
      if (!valid) throw new Error("invalid exploration ship");
      run.squad.ship = explorationUnit(user, req.shipId, run.squad.ship.unitUid, 100);
      run.deck.shipUid = run.squad.ship.unitUid;
    }
    finishNode(run);
    return Buffer.concat([ok, codec.writeSignedVarInt(run.state), serializeSquad(run.squad), codec.writeFloatLE(run.maxHp), codec.writeFloatLE(run.currentHp)]);
  }
  if (id === 1283) {
    const run = requireRun(user);
    if (run.state !== STATE.SELECT_REWARD || run.rerollCount >= Number(getTemplet(run.templetId).RerollCount || 0)) throw new Error("exploration reroll unavailable");
    run.rerollCount += 1;
    generateRewardSelections(run, run.selectionGroupId, run.selectionType, run.selectionList.map(c => c.id));
    return Buffer.concat([ok, codec.writeSignedVarInt(run.rerollCount), codec.writeNullableObjectList(run.selectionList.map(serializeChoice))]);
  }
  throw new Error("exploration enhancement or season reward unavailable");
}

function errorPayload(id) {
  const error = codec.writeSignedVarInt(ERROR);
  if (id === 1255) return Buffer.concat([error,codec.writeNullObject(),codec.writeIntList([]),codec.writeVarInt(0),codec.writeSignedVarInt(0)]);
  if ([1257,1259].includes(id)) return Buffer.concat([error,...Array.from({length:4},()=>codec.writeNullObject())]);
  if (id === 1261) return Buffer.concat([error,codec.writeNullObject(),codec.writeSignedVarInt(0)]);
  if (id === 1263) return Buffer.concat([error,codec.writeNullObject()]);
  if ([1265,1267].includes(id)) return Buffer.concat([error,codec.writeNullObject(),codec.writeNullObject()]);
  if (id === 1269) return Buffer.concat([error,codec.writeNullObject(),codec.writeSignedVarInt(0)]);
  if (id === 1271) return Buffer.concat([error,codec.writeSignedVarInt(0),codec.writeNullObject()]);
  if (id === 1273) return Buffer.concat([error,codec.writeSignedVarInt(0),codec.writeNullObject(),codec.writeFloatLE(0),codec.writeFloatLE(0)]);
  if (id === 1275) return Buffer.concat([error,...Array.from({length:4},()=>codec.writeSignedVarInt(0))]);
  if (id === 1277) return Buffer.concat([error,codec.writeVarInt(0),codec.writeSignedVarInt(0)]);
  if (id === 1279) return Buffer.concat([error,codec.writeNullObject(),codec.writeSignedVarInt(0)]);
  if (id === 1281) return Buffer.concat([error,codec.writeIntList([]),codec.writeNullObject()]);
  return Buffer.concat([error,codec.writeSignedVarInt(0),codec.writeObjectList([])]);
}

function createExploreHandlers() {
  return [1255,1257,1259,1261,1263,1265,1267,1269,1271,1273,1275,1277,1279,1281,1283].map(packetId => ({ packetId, name: `EXPLORE_${packetId}_REQ`, handle(ctx,socket,packet) {
    const user = socket.session && socket.session.user;
    let payload;
    try {
      if (!user) throw new Error("login required");
      const req = decode(packetId, ctx.decryptCopy ? ctx.decryptCopy(packet.payload) : packet.payload);
      payload = handlerPayload(user, packetId, req);
      if (ctx.config && ctx.config.USE_LOCAL_USER_DB && ctx.saveUserDb) ctx.saveUserDb();
    } catch (err) { console.log(`[explore:${packetId}] ${err.message}`); payload = errorPayload(packetId); }
    ctx.sendGameResponse(socket,packet,packetId+1,payload,`explore-${packetId}`);
    return true;
  } }));
}

module.exports = { STATE, getCatalog, getRun, enter, reset, move, selectReward, selectEvent, prepareGameLoad, completeBattle, serializeExplore, serializeSquad, serializeZone, serializeGameEndParts, buildExploreDeckResponse, createExploreHandlers, handlerPayload };
