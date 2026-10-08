const {
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarIntList,
  readBool,
  readVarInt,
} = require("../../packet-codec");
const { buildPlayerDeckForGameLoad } = require("../../unit");
const { getEventDeckPlayerUnitSlots, eventDeckHasFreeShipSlot } = require("../../game-data");

const SHADOW_PALACE_START_ACK = 1222;
const PHASE_START_ACK = 1228;
const TRIM_START_ACK = 1235;
const FIERCE_DATA_ACK = 845;
const FIERCE_PROFILE_ACK = 847;
const FIERCE_RANK_REWARD_ACK = 849;
const FIERCE_POINT_REWARD_ACK = 851;
const FIERCE_POINT_REWARD_ALL_ACK = 853;
const FIERCE_PENALTY_ACK = 858;
const EXPLORE_INFO_ACK = 1256;
const EXPLORE_ENTER_ACK = 1258;
const LEADERBOARD_FIERCE_LIST_ACK = 3205;
const LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK = 3207;
const DEFENCE_GAME_START_ACK = 3901;

module.exports = [
  {
    packetId: 844,
    name: "FIERCE_DATA_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_DATA_ACK, ctx.buildFierceDataAckPayload(socket.session && socket.session.user), "fierce-data");
      return true;
    },
  },
  {
    packetId: 857,
    name: "FIERCE_PENALTY_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFiercePenaltyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PENALTY_ACK, ctx.buildFiercePenaltyAckPayload(req, socket.session && socket.session.user), "fierce-penalty");
      return true;
    },
  },
  {
    packetId: 846,
    name: "FIERCE_PROFILE_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFierceProfileReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PROFILE_ACK, ctx.buildFierceProfileAckPayload(req, socket.session && socket.session.user), "fierce-profile");
      return true;
    },
  },
  {
    packetId: 848,
    name: "FIERCE_COMPLETE_RANK_REWARD_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_RANK_REWARD_ACK, ctx.buildFierceRankRewardAckPayload(socket.session && socket.session.user), "fierce-rank-reward");
      return true;
    },
  },
  {
    packetId: 850,
    name: "FIERCE_COMPLETE_POINT_REWARD_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "fiercePointRewardId");
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ACK, ctx.buildFiercePointRewardAckPayload(req, socket.session && socket.session.user), "fierce-point-reward");
      return true;
    },
  },
  {
    packetId: 852,
    name: "FIERCE_COMPLETE_POINT_REWARD_ALL_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ALL_ACK, ctx.buildFiercePointRewardAllAckPayload(socket.session && socket.session.user), "fierce-point-reward-all");
      return true;
    },
  },
  {
    packetId: 3204,
    name: "LEADERBOARD_FIERCE_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_LIST_ACK, ctx.buildLeaderboardFierceListAckPayload(req, socket.session && socket.session.user), "leaderboard-fierce-list");
      return true;
    },
  },
  {
    packetId: 3206,
    name: "LEADERBOARD_FIERCE_BOSSGROUP_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceBossGroupListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK, ctx.buildLeaderboardFierceBossGroupListAckPayload(req, socket.session && socket.session.user), "leaderboard-fierce-bossgroup-list");
      return true;
    },
  },
  {
    packetId: 1221,
    name: "SHADOW_PALACE_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "palaceId");
      ctx.sendGameResponse(
        socket,
        packet,
        SHADOW_PALACE_START_ACK,
        ctx.buildShadowPalaceStartAckPayload(req, socket.session && socket.session.user),
        "shadow-palace-start"
      );
      return true;
    },
  },
  {
    packetId: 1227,
    name: "PHASE_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodePhaseStartReq(ctx, packet.payload);
      ctx.sendGameResponse(
        socket,
        packet,
        PHASE_START_ACK,
        ctx.buildPhaseStartAckPayload(req, socket.session && socket.session.user),
        "phase-start"
      );
      return true;
    },
  },
  {
    packetId: 1234,
    name: "TRIM_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeTrimStartReq(ctx, packet.payload);
      ctx.sendGameResponse(
        socket,
        packet,
        TRIM_START_ACK,
        ctx.buildTrimStartAckPayload(req, socket.session && socket.session.user),
        "trim-start"
      );
      return true;
    },
  },
  {
    packetId: 1255,
    name: "EXPLORE_INFO_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "templetId");
      ctx.sendGameResponse(socket, packet, EXPLORE_INFO_ACK, ctx.buildExploreInfoAckPayload(req, socket.session && socket.session.user), "explore-info");
      return true;
    },
  },
  {
    packetId: 1257,
    name: "EXPLORE_ENTER_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "templetId");
      ctx.sendGameResponse(socket, packet, EXPLORE_ENTER_ACK, ctx.buildExploreEnterAckPayload(req, socket.session && socket.session.user), "explore-enter");
      return true;
    },
  },
  {
    packetId: 3900,
    name: "DEFENCE_GAME_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeDefenceStartReq(ctx, packet.payload);
      const stage = ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ defenceTempletId: req.defenceTempletId }) : null;
      const user = socket.session && socket.session.user;
      const loadReq = {
        selectDeckIndex: 0,
        stageID: Number((stage && stage.stageId) || 0),
        dungeonID: Number((stage && stage.dungeonID) || 0),
        defenceTempletId: req.defenceTempletId,
        eventDeckData: req.eventDeckData,
      };
      const eventDeckId = Number(stage && (stage.eventDeckId || stage.EventDeckId) || 0);
      const playerSlots = eventDeckId ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
      const playerDeck = stage && !stage.cutsceneOnly
        ? buildPlayerDeckForGameLoad(user, loadReq, {
            allowedUnitSlots: eventDeckId ? playerSlots : undefined,
            slotUnitUids: req.eventDeckData && req.eventDeckData.units,
            shipUid: req.eventDeckData && req.eventDeckData.shipUid,
            operatorUid: req.eventDeckData && req.eventDeckData.operatorUid,
            leaderIndex: req.eventDeckData && req.eventDeckData.leaderIndex,
          }) || buildPlayerIdentityForGameLoad(user)
        : null;
      const payload = ctx.buildDefenceGameStartAckPayload(socket, loadReq, {
        stage: stage && playerDeck ? { ...stage, playerDeck, eventDeckFreeUnitSlots: playerSlots, eventDeckFreeShipSlot: eventDeckHasFreeShipSlot(eventDeckId) } : stage,
      });
      ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, payload, "defence-game-start");
      return true;
    },
  },
];

function decodeSingleIntReq(ctx, payload, fieldName) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { [fieldName]: readSignedVarInt(decrypted, 0).value };
  } catch (_) {
    return { [fieldName]: 0 };
  }
}

function decodePhaseStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const stageId = readSignedVarInt(decrypted, 0);
    let offset = stageId.offset;
    let deckIndex = null;
    if (readBool(decrypted, offset++).value) {
      const deckType = readSignedVarInt(decrypted, offset);
      offset = deckType.offset;
      deckIndex = { deckType: deckType.value, index: decrypted.readUInt8(offset++) };
    }
    let eventDeckData = null;
    if (readBool(decrypted, offset++).value) {
      const eventDeck = ctx.readNkmEventDeckData(decrypted, offset);
      eventDeckData = eventDeck.value;
      offset = eventDeck.offset;
    }
    const supportingUserUid = readSignedVarLong(decrypted, offset).value;
    return { stageId: stageId.value, supportingUserUid, deckIndex, eventDeckData };
  } catch (_) {
    return { stageId: 0, supportingUserUid: 0n };
  }
}

function decodeTrimStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const trimId = readSignedVarInt(decrypted, 0);
    const trimLevel = readSignedVarInt(decrypted, trimId.offset);
    let offset = trimLevel.offset;
    const count = readVarInt(decrypted, offset);
    offset = count.offset;
    const eventDeckList = [];
    for (let index = 0; index < count.value; index++) {
      if (!readBool(decrypted, offset++).value) { eventDeckList.push(null); continue; }
      const parsed = ctx.readNkmEventDeckData(decrypted, offset);
      eventDeckList.push(parsed.value);
      offset = parsed.offset;
    }
    return { trimId: trimId.value, trimLevel: trimLevel.value, eventDeckList };
  } catch (_) {
    return { trimId: 0, trimLevel: 1 };
  }
}

function decodeDefenceStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const id = readSignedVarInt(decrypted, 0);
    const eventDeckData = readBool(decrypted, id.offset).value ? ctx.readNkmEventDeckData(decrypted, id.offset + 1).value : null;
    return { defenceTempletId: id.value, eventDeckData };
  } catch (_) {
    return { defenceTempletId: 0, eventDeckData: null };
  }
}

function decodeFiercePenaltyReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const boss = readSignedVarInt(decrypted, 0);
    const penalties = readSignedVarIntList(decrypted, boss.offset);
    return { fierceBossId: boss.value, penaltyIds: penalties.value };
  } catch (_) {
    return { fierceBossId: 0, penaltyIds: [] };
  }
}

function decodeFierceProfileReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const userUid = readSignedVarLong(decrypted, 0);
    const isForce = readBool(decrypted, userUid.offset);
    return { userUid: userUid.value, isForce: isForce.value };
  } catch (_) {
    return { userUid: 0n, isForce: false };
  }
}

function decodeLeaderboardFierceListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { isAll: readBool(decrypted, 0).value };
  } catch (_) {
    return { isAll: false };
  }
}

function decodeLeaderboardFierceBossGroupListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const group = readSignedVarInt(decrypted, 0);
    const isAll = readBool(decrypted, group.offset);
    return { fierceBossGroupId: group.value, isAll: isAll.value };
  } catch (_) {
    return { fierceBossGroupId: 0, isAll: false };
  }
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
