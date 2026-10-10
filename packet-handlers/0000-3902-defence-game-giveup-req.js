const { writeSignedVarInt } = require("../modules/packet-codec");

module.exports = [{
  packetId: 3902,
  name: "DEFENCE_GAME_GIVE_UP_REQ",
  handle(ctx, socket, packet) {
    const replay = socket.session && socket.session.gameReplay;
    const active = replay && replay.dynamicGame && replay.dynamicGame.miscMode === "defence" && !replay.dynamicBattleResultSent;
    ctx.sendGameResponse(socket, packet, 3903, writeSignedVarInt(active ? 0 : 1), "defence-giveup");
    if (active) {
      ctx.sendDefenceGameEnd(socket, { giveup: true });
      ctx.abandonDynamicBattle(socket, "defence-giveup");
    }
    return true;
  },
}, ...[3907, 3911, 3913].map((packetId) => ({
  packetId,
  name: "DEFENCE_SEASON_REWARD_REQ",
  handle: require("../modules/event-manager/defence-rewards").handle,
}))];
