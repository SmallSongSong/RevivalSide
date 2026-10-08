const { writeSignedVarInt } = require("../modules/packet-codec");

module.exports = {
  packetId: 861,
  name: "GAME_RESTART_REQ",
  handle(ctx, socket, packet) {
    const replay = socket.session && socket.session.gameReplay;
    const active = replay && replay.dynamicGame && !replay.dynamicBattleResultSent && replay.dynamicGame.miscMode !== "local-pvp";
    ctx.sendGameResponse(socket, packet, 862, writeSignedVarInt(active ? 0 : 1), "game-restart");
    if (!active) return true;
    if (replay.dynamicGame.miscMode === "defence" && typeof ctx.sendDefenceGameEnd === "function") {
      ctx.sendDefenceGameEnd(socket, { restart: true });
      ctx.abandonDynamicBattle(socket, "defence-restart");
      return true;
    }
    const battleState = replay.battleState || {};
    battleState.finished = true;
    battleState.win = false;
    battleState.Win = false;
    battleState.gameState = { ...(battleState.gameState || {}), state: 4, winTeam: 3 };
    const payload = ctx.buildDynamicGameEndNotPayload(replay, {
      battleState, restart: true, win: false, user: socket.session.user,
    });
    if (payload) ctx.sendServerGamePacket(socket, ctx.constants.GAME_END_NOT, payload, "game-restart-end");
    replay.dynamicBattleResultSent = true;
    replay.pendingGameStartBootstrap = false;
    replay.pendingGameStartPackets = [];
    if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "game-restart");
    else ctx.stopGameSyncTimers(socket);
    return true;
  },
};
