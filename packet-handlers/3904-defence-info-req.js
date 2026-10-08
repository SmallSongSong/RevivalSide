const { readSignedVarInt } = require("../modules/packet-codec");

module.exports = {
  packetId: 3904,
  name: "DEFENCE_INFO_REQ",
  handle(ctx, socket, packet) {
    const req = decodeDefenceInfoReq(ctx, packet.payload);
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.DEFENCE_INFO_ACK,
      ctx.buildDefenceInfoAckPayload(req.defenceTempletId, socket.session && socket.session.user),
      "defence-info"
    );
    return true;
  },
};

function decodeDefenceInfoReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { defenceTempletId: readSignedVarInt(decrypted, 0).value };
  } catch (_) {
    return { defenceTempletId: 0 };
  }
}
