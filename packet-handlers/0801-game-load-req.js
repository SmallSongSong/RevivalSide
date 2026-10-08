const { getTutorialStageForRequest, isTutorialDungeonId, isTutorialStageId, TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { writeSignedVarInt, writeNullObject, writeObjectList } = require("../modules/packet-codec");
const { eventDeckHasFreeShipSlot, eventDeckHasGivenUnitSlots, getEventDeckPlayerUnitSlots } = require("../modules/game-data");
const worldMap = require("../modules/world-map");
const explore = require("../modules/explore");

const NGT_DIVE = 5;

module.exports = {
  packetId: 801,
  name: "GAME_LOAD_REQ",
  handle(ctx, socket, packet) {
    ctx.logGameLoadReq(packet.payload);
    const req = ctx.decodeGameLoadReq(packet.payload);
    if (!req) return rejectGameLoad(ctx, socket, packet, "invalid-game-load");
    const replay = socket.session && socket.session.gameReplay;
    const requestKey = JSON.stringify(req, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    if (replay && replay.dynamicGame && !replay.dynamicBattleResultSent && !(replay.dynamicGame.tutorial && replay.tutorialClearRecorded)) {
      if (replay.gameLoadRequestKey === requestKey && replay.gameLoadAckPayload) {
        ctx.sendGameResponse(socket, packet, ctx.constants.GAME_LOAD_ACK, replay.gameLoadAckPayload, "game-load-retry");
        return true;
      }
      return rejectGameLoad(ctx, socket, packet, "battle-already-loading");
    }
    // Stage selection can arrive with a stale/captured dungeonID. Prefer the
    // selected stageID first so Act 2+ does not get pulled back into 1004.
    // Tutorial stages must come from tutorialStage.js, not the main-story catalog
    // wrapper, because that module carries the phase-specific tutorial runtime.
    const user = socket.session && socket.session.user;
    const requestedStageId = Number((req && req.stageID) || 0);
    const requestedDungeonId = Number((req && req.dungeonID) || 0);
    const requestedFierceBossId = Number((req && req.fierceBossId) || 0);
    if (Number(req && req.palaceID || 0) > 0 && user && user.miscStages && user.miscStages.shadow && user.miscStages.shadow.life === 0) {
      ctx.sendGameResponse(socket, packet, ctx.constants.GAME_LOAD_ACK,
        Buffer.concat([writeSignedVarInt(1), writeNullObject(), writeObjectList([])]), "shadow-palace-exhausted");
      return true;
    }
    const trim = user && user.miscStages && user.miscStages.trim && user.miscStages.trim.current;
    if (trim && (trim.trimStageList || []).some((row) => Number(row.DungeonID) === requestedDungeonId || Number(row.DungeonID) === requestedStageId)) {
      req.trimId = trim.trimId;
      req.trimLevel = trim.trimLevel;
      const trimIndex = trim.trimStageList.findIndex((row) => Number(row.DungeonID) === requestedDungeonId || Number(row.DungeonID) === requestedStageId);
      if (!req.eventDeckData && trim.eventDeckList) req.eventDeckData = trim.eventDeckList[trimIndex] || null;
    }
    const explicitTutorial = isTutorialStageId(requestedStageId) || isTutorialDungeonId(requestedDungeonId);
    const diveGameLoad = req && Number(req.diveStageID || 0) > 0 ? worldMap.prepareDiveGameLoad(user, req) : null;
    let exploreStage = null;
    if (Number(req.exploreID || 0) > 0) {
      try {
        exploreStage = explore.prepareGameLoad(user, req, { resolveStage: ctx.getGenericStageForRequest });
      } catch (_) {
        return rejectGameLoad(ctx, socket, packet, "invalid-explore-game-load");
      }
    }
    if (Number(req.exploreID || 0) > 0 && !exploreStage) return rejectGameLoad(ctx, socket, packet, "invalid-explore-game-load");
    if (Number(req && req.diveStageID || 0) > 0 && !diveGameLoad) {
      ctx.sendGameResponse(socket, packet, ctx.constants.GAME_LOAD_ACK,
        Buffer.concat([writeSignedVarInt(1), writeNullObject(), writeObjectList([])]), "invalid-dive-game-load");
      return true;
    }
    let stage = null;
    if (exploreStage) {
      stage = exploreStage;
    } else if (diveGameLoad) {
      const diveStage =
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ dungeonID: diveGameLoad.dungeonID }) : null) ||
        (ctx.getGenericStageForRequest
          ? ctx.getGenericStageForRequest({ stageID: requestedStageId, dungeonID: diveGameLoad.dungeonID })
          : null) ||
        {};
      req.stageID = Number(diveStage.stageId || requestedStageId || diveGameLoad.diveStageID || 0);
      req.dungeonID = diveGameLoad.dungeonID;
      req.gameType = NGT_DIVE;
      stage = {
        ...diveStage,
        stageId: req.stageID,
        dungeonID: diveGameLoad.dungeonID,
        gameType: NGT_DIVE,
        eventDeckId: 0,
        EventDeckId: 0,
        miscMode: "dive",
        diveStageID: diveGameLoad.diveStageID,
        diveDeckIndex: diveGameLoad.deckIndex,
        diveUid: diveGameLoad.diveUid,
        diveSlotSetIndex: diveGameLoad.diveSlotSetIndex,
        diveSlotIndex: diveGameLoad.diveSlotIndex,
        diveDistance: diveGameLoad.diveDistance,
        shipInitHp: diveGameLoad.shipInitHp,
        tutorial: false,
        cutsceneOnly: false,
      };
      console.log(
        `[game-load:dive] diveStageID=${diveGameLoad.diveStageID} dungeonID=${diveGameLoad.dungeonID} deck=${diveGameLoad.deckIndex}`
      );
    } else if (requestedFierceBossId > 0 && ctx.getGenericStageForRequest) {
      stage = ctx.getGenericStageForRequest(req);
    } else {
      stage = (explicitTutorial
        ? getTutorialStageForRequest({ stageID: requestedStageId, dungeonID: requestedDungeonId })
        : getMainStoryStageForRequest(req)) ||
        getMainStoryStageForRequest(req) ||
        getTutorialStageForRequest(req) ||
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest(req) : null);
    }
    if (requestedFierceBossId > 0) {
      if (stage) {
        console.log(
          `[game-load:fierce] bossId=${requestedFierceBossId} stageID=${stage.stageId || 0} dungeonID=${
            stage.dungeonID || 0
          } gameType=${stage.gameType || 0} mode=${stage.miscMode || ""} eventDeck=${
            stage.eventDeckId || stage.EventDeckId || 0
          } eventDeckData=${req && req.eventDeckData ? 1 : 0}`
        );
      } else {
        console.log(`[game-load:fierce] unresolved bossId=${requestedFierceBossId} dungeonID=${requestedDungeonId}`);
      }
    }
    if (stage) {
      if (!canLoadChainBattle(user, stage)) return rejectGameLoad(ctx, socket, packet, "invalid-chain-battle");
      req.stageID = stage.stageId;
      req.dungeonID = stage.dungeonID;
      if (stage.miscMode === "phase") {
        const phase = user && user.miscStages && user.miscStages.phase;
        if (phase && Number(phase.stageId) === Number(stage.stageId) && Number(phase.phaseIndex) === Number(stage.phaseIndex)) {
          stage.shipInitHp = phase.shipInitHp;
          if (!req.eventDeckData) req.eventDeckData = phase.eventDeckData || null;
          if (phase.deckIndex) req.selectDeckIndex = Number(phase.deckIndex.index || 0);
        }
      }
    }
    if (stage && stage.tutorial && user) {
      const expectedTutorialStage = getExpectedTutorialStageForUser(user);
      if (
        expectedTutorialStage &&
        (Number(stage.stageId) !== Number(expectedTutorialStage.stageId) ||
          Number(stage.dungeonID) !== Number(expectedTutorialStage.dungeonID))
      ) {
        const redirectedStage = getTutorialStageForRequest({
          stageID: expectedTutorialStage.stageId,
          dungeonID: expectedTutorialStage.dungeonID,
        });
        if (redirectedStage) {
          console.log(
            `[game-load:tutorial] redirect stageID=${stage.stageId} dungeonID=${stage.dungeonID} -> stageID=${redirectedStage.stageId} dungeonID=${redirectedStage.dungeonID}`
          );
          stage = redirectedStage;
          req.stageID = stage.stageId;
          req.dungeonID = stage.dungeonID;
        }
      }
    }
    if (socket.session && socket.session.gameReplay) {
      socket.session.gameReplay.lastGameLoadReq = {
        stageID: Number((req && req.stageID) || 0),
        dungeonID: Number((req && req.dungeonID) || 0),
      };
    }
    const eventDeckId = stage ? Number(stage.eventDeckId || stage.EventDeckId || 0) : 0;
    const usesEventDeck = eventDeckId > 0;
    const eventDeckPlayerUnitSlots = usesEventDeck ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
    const eventDeckAllowsPlayerUnits = eventDeckPlayerUnitSlots.length > 0;
    const usesHybridEventDeck = eventDeckAllowsPlayerUnits && eventDeckHasGivenUnitSlots(eventDeckId);
    let playerDeck = stage && stage.playerDeck || null;
    if (stage && !stage.cutsceneOnly && !playerDeck) {
      if (stage.tutorial || (usesEventDeck && !eventDeckAllowsPlayerUnits)) {
        playerDeck = buildPlayerIdentityForGameLoad(user);
      } else if (stage.miscMode === "trim" && req.eventDeckData) {
        const selection = req.eventDeckData;
        playerDeck = buildPlayerDeckForGameLoad(user, req, {
          deckIndex: { deckType: 7, index: Math.max(0, (stage.trimStageList || []).findIndex((row) => Number(row.DungeonID) === Number(stage.dungeonID))) },
          slotUnitUids: selection.units, shipUid: selection.shipUid,
          operatorUid: selection.operatorUid, leaderIndex: selection.leaderIndex,
        }) || buildPlayerIdentityForGameLoad(user);
      } else if (eventDeckAllowsPlayerUnits) {
        const eventDeckSelection = req && req.eventDeckData ? req.eventDeckData : null;
        playerDeck =
          buildPlayerDeckForGameLoad(user, req, {
            allowedUnitSlots: eventDeckPlayerUnitSlots,
            slotUnitUids: eventDeckSelection && eventDeckSelection.units,
            shipUid: eventDeckSelection && eventDeckSelection.shipUid,
            operatorUid: eventDeckSelection && eventDeckSelection.operatorUid,
            leaderIndex: eventDeckSelection && eventDeckSelection.leaderIndex,
          }) || buildPlayerIdentityForGameLoad(user);
      } else {
        playerDeck = buildPlayerDeckForGameLoad(user, req) || buildPlayerIdentityForGameLoad(user);
      }
    }
    if (playerDeck && !stage.tutorial && playerDeck.units && playerDeck.units.length) {
      console.log(
        `[game-load] selectedDeck deckType=${playerDeck.deckType} index=${playerDeck.deckIndex} ${
          usesEventDeck
            ? `eventDeck=${eventDeckId} playerSlots=${eventDeckPlayerUnitSlots.join("/") || "none"} source=${
                req && req.eventDeckData ? "eventDeckData" : "deck"
              } `
            : ""
        }units=${playerDeck.units
          .map((unit) => `${unit.slotIndex}:${unit.unitId}/${unit.unitUid}`)
          .join(",")} leader=${playerDeck.leaderIndex}:${playerDeck.leaderUnitUid} ship=${playerDeck.shipUnitId}/${
          playerDeck.shipUid
        } operator=${playerDeck.operatorId}/${playerDeck.operatorUid}`
      );
    } else if (stage && usesEventDeck) {
      console.log(`[game-load] eventDeck=${stage.eventDeckId || stage.EventDeckId} stageID=${stage.stageId} dungeonID=${stage.dungeonID}`);
    }
    const activeStage =
      stage && !stage.cutsceneOnly
        ? {
            ...stage,
            eventDeckFreeUnitSlots: eventDeckPlayerUnitSlots,
            usesHybridEventDeck,
            eventDeckFreeShipSlot: usesEventDeck ? eventDeckHasFreeShipSlot(eventDeckId) : false,
            playerDeck,
          }
        : stage;
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.logCapturedClientPacketMatch(packet, 10, "game-load");
    }
    if (!activeStage || activeStage.tutorial) ctx.maybeSendTutorialCutsceneClear(socket, packet.payload);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && activeStage && !activeStage.cutsceneOnly) {
      if (ctx.sendDynamicGameLoadAck(socket, req, activeStage)) {
        if (replay) replay.gameLoadRequestKey = requestKey;
        return true;
      }
      if (diveGameLoad && typeof worldMap.cancelDiveGameLoad === "function") worldMap.cancelDiveGameLoad(user, diveGameLoad);
      return rejectGameLoad(ctx, socket, packet, "managed-game-load-failed");
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_LOAD_ACK, "game-load");
      ctx.scheduleCapturedGameAutoAdvance(socket);
      return true;
    }
    return false;
  },
};

function rejectGameLoad(ctx, socket, packet, label) {
  ctx.sendGameResponse(socket, packet, ctx.constants.GAME_LOAD_ACK,
    Buffer.concat([writeSignedVarInt(1), writeNullObject(), writeObjectList([])]), label);
  return true;
}

function canLoadChainBattle(user, stage) {
  const saved = user && user.miscStages || {};
  if (stage.miscMode === "phase") {
    const phase = saved.phase;
    if (phase && Number(phase.stageId) === Number(stage.stageId)) {
      return Number(phase.phaseIndex) === Number(stage.phaseIndex) && Number(phase.dungeonId) === Number(stage.dungeonID);
    }
    return Number(stage.phaseIndex || 0) === 0;
  }
  if (stage.miscMode === "trim") {
    const current = saved.trim && saved.trim.current;
    if (current && Number(current.trimId) === Number(stage.trimId)) {
      return Number(current.trimLevel) === Number(stage.trimLevel) && Number(current.nextDungeonId) === Number(stage.dungeonID);
    }
    return Number((stage.trimStageList && stage.trimStageList[0] || {}).DungeonID) === Number(stage.dungeonID);
  }
  if (stage.miscMode === "shadow") {
    const palace = saved.shadow && saved.shadow.palaces && saved.shadow.palaces[String(stage.palaceID)];
    if (palace) return Number(palace.currentDungeonId) === Number(stage.dungeonID);
    return Number(stage.shadowBattleOrder || 1) === 1;
  }
  return true;
}

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    units: [],
  };
}

function getExpectedTutorialStageForUser(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (!tutorial || tutorial.enabled === false || tutorial.completed === true || tutorial.loginMode === "post-tutorial") return null;
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[String(stage.dungeonID)] || phases[String(stage.stageId)];
    if (!phase || phase.completed !== true) return stage;
  }
  return null;
}
