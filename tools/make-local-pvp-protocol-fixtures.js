"use strict";

// Public gameplay-table fixtures only. This tool never reads a user save or uses adb.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const pvp = require("../modules/local-pvp");
const units = require("../modules/unit");
const inventory = require("../modules/inventory");

function fixtureUser(deck) {
  const user = { userUid: deck.userUid, nickname: "Public Fixture Player", level: 100,
    army: { units: Object.fromEntries(deck.units.map(unit => [unit.unitUid, { ...unit, userUid: deck.userUid }])),
      ships: { [deck.shipUid]: { unitUid: deck.shipUid, userUid: deck.userUid, unitId: deck.shipUnitId, level: deck.shipLevel,
        skinId: deck.shipSkinId, limitBreakLevel: deck.shipLimitBreakLevel, skillLevels: deck.shipSkillLevels, shipCommandModules: deck.shipCommandModules } },
      operators: { [deck.operatorUid]: deck.operatorData } },
    inventory: { equips: Object.fromEntries(deck.equipItems.map(equip => [equip.equipUid, equip])) } };
  units.ensureArmy(user);
  for (const unit of deck.units) units.setDeckUnit(user, { deckType: 2, index: 0 }, unit.slotIndex, unit.unitUid);
  units.setDeckShip(user, { deckType: 2, index: 0 }, deck.shipUid);
  units.setDeckOperator(user, { deckType: 2, index: 0 }, deck.operatorUid);
  inventory.grantMiscItem(user, 6, 900n);
  return user;
}

function generateFixtures(outputDir, deviceRoot) {
  fs.mkdirSync(outputDir, { recursive: true });
  const options = { managedDir: `${deviceRoot}/managed`, gameplayTablesDir: `${deviceRoot}/tables/gameplay-tables`, contentsTags: ["KOR"] };
  const player = pvp.cloneDeck(pvp.buildPresetDeck(pvp.presets[0], { userLevel: 100 }), "910099000", "Public Fixture Player");
  const lowerPlayer = JSON.parse(JSON.stringify(player));
  lowerPlayer.units.forEach(unit => { unit.level = 80; unit.tacticLevel = 0; unit.limitBreakLevel = 0; unit.reactorLevel = 0; unit.skillLevels = [1, 1, 1, 1, 0]; unit.equipItemUids = ["0", "0", "0", "0"]; });
  lowerPlayer.equipItems = [];
  const targets = [{ key: "mirror", friendCode: "900000001", deck: pvp.cloneDeck(lowerPlayer), player: lowerPlayer },
    ...pvp.presets.map(preset => ({ key: preset.key, friendCode: preset.friendCode, deck: pvp.buildPresetDeck(preset, player), player }))];
  const write = (name, request) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(request));
  write("warmup.json", { command: "warmup", options, data: {} });
  for (const [index, target] of targets.entries()) {
    const gameUID = String(960000001 + index);
    write(`start-${target.key}.json`, { command: "startBattle", options,
      data: { gameUID, req: { stageID: 0, dungeonID: 0, gameType: 20 },
        stage: { stageId: 0, dungeonID: 0, mapID: 1001, gameType: 20, miscMode: "local-pvp", playerDeck: target.player, enemyDeck: target.deck }, gameLoadAckPayloadBase64: "" } });
    for (const result of [0, 1, 2]) {
      const user = fixtureUser(target.player);
      const socket = { session: { user, gameReplay: { dynamicGame: { miscMode: "local-pvp", gameUID }, loadCompleteReceived: true,
        localPvpMatch: { target, playerDeck: target.player, deckIndex: 0, gameType: 20, simulationGame: false } } } };
      const payload = pvp.buildGameEndPayload(socket, { result, gameEndTime: 90, now: new Date("2026-10-09T04:00:00Z") });
      write(`validate-2623-${target.key}-${result}.json`, { command: "validatePacket", options, data: { packetId: 2623, payloadBase64: payload.toString("base64") } });
    }
  }
  const payload = Buffer.concat([Buffer.from([0]), pvp.targetList(fixtureUser(player))]);
  write("validate-2616.json", { command: "validatePacket", options, data: { packetId: 2616, payloadBase64: payload.toString("base64") } });
  return { outputDir, fixtureKeys: targets.map(target => target.key), targetListBytes: payload.length, fullyPublic: true };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const out = path.resolve(arg("--out", path.join(os.tmpdir(), "revivalside-pvp-max-fixtures")));
  const root = arg("--device-root", "/data/local/tmp/revivalside-managed-probe-20261008");
  if (!out || !root) throw new Error("missing fixture output or device root");
  console.log(JSON.stringify(generateFixtures(out, root)));
}
module.exports = { generateFixtures, fixtureUser };
