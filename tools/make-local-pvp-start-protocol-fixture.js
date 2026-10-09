"use strict";
const fs = require("node:fs");
const pvp = require("../modules/local-pvp");
const { fixtureUser } = require("./make-local-pvp-protocol-fixtures");

function populateNativeFixture(native) {
  const player = pvp.cloneDeck(pvp.buildPresetDeck(pvp.presets[0], { userLevel: 100 }), "910099000", "Public Fixture Player");
  const targets = pvp.buildTargets(fixtureUser(player));
  const selected = targets.find(target => target.friendCode === "900000003");
  if (!selected) throw new Error("missing public Jake fixture");
  const payload = pvp.buildPopulatedStartAck(Buffer.from(native.nativePayloadBase64, "base64"), selected, targets);
  return { ...native, payloadBase64: payload.toString("base64"), targetFriendCode: selected.friendCode, leaderId: selected.deck.units[0].unitId, targetCount: targets.length };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: node tools/make-local-pvp-start-protocol-fixture.js <native empty2618 JSON> <populated2618 JSON>");
  const fixture = populateNativeFixture(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(fixture));
  console.log(`public2618 fixture: selected=${fixture.targetFriendCode}, leader=${fixture.leaderId}, targets=${fixture.targetCount}, bytes=${Buffer.from(fixture.payloadBase64, "base64").length}`);
}
module.exports = { populateNativeFixture };
