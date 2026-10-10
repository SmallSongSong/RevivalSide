const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const game = require("../modules/game-data");
const { potentialType, maxRecordValue, validateUser, privateWrite } = require("./optimize-user-loadouts");

const ROOT = path.resolve(__dirname, "..");
const CRITICAL_RESISTANCE = "NST_CRITICAL_DAMAGE_RESIST_RATE";
const HP_FACTOR = "NST_HP_FACTOR";
const HP_SET = 220700;
const names = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, "wiki/data/units.json"))).map((unit) => [Number(unit.id), unit.name]));

function statTotal(equipment, type) {
  return equipment.flatMap((item) => item.stats || []).filter((stat) => stat.type === type).reduce((sum, stat) => sum + Number(stat.value || 0), 0)
    + equipment.flatMap((item) => item.potentialOptions || []).filter((option) => option.statType === type).flatMap((option) => option.sockets || []).reduce((sum, socket) => sum + Number(socket?.statValue || 0), 0);
}

function makeMaximumPotential(template, previousOption, requestedType) {
  const records = game.getEquipPotentialOptionRecords(template.m_PotentialOptionGroupID);
  const record = records.find((candidate) => potentialType(candidate) === requestedType);
  assert.ok(record, `Potential ${requestedType} is unsupported by template ${template.m_ItemEquipID}`);
  return {
    ...previousOption,
    optionKey: Number(record.OptionKey),
    statType: requestedType,
    sockets: [1, 2, 3].map((index) => ({ ...previousOption.sockets?.[index - 1], statValue: maxRecordValue(record, `Socket${index}_`), precision: 100 })),
  };
}

function makeLifeSpecializedVariant(database, activeUid, options = {}) {
  assert.ok(database.users?.[String(activeUid)], "Active account is missing");
  const result = structuredClone(database);
  const user = result.users[String(activeUid)];
  const changes = [];
  for (const unit of Object.values(user.army.units)) {
    if (options.excludeUntrained !== false && Number(unit.level || 1) <= 1) continue;
    const equipment = unit.equipItemUids.map((uid) => user.inventory.equips[String(uid)]);
    assert.ok(equipment.length === 4 && equipment.every(Boolean), "Mitigation audit requires four equipped items");
    const slots = [];
    // The specialized profile changes only the existing Inhibitor critical-resistance latent.
    if (Number(unit.unitId) !== 1071 && equipment.every((item) => Number(item.setOptionId) === HP_SET)) slots.push(0);
    if (options.includeNaYubin && Number(unit.unitId) === 1071) slots.push(2, 3);
    for (const slot of slots) {
      const item = equipment[slot];
      const template = game.getEquipTemplet(item.itemEquipId);
      const expectedGroup = slot === 0 ? 2461141 : 2461341;
      if (Number(template?.m_PotentialOptionGroupID) !== expectedGroup) continue;
      const index = item.potentialOptions.findIndex((option) => option.statType === CRITICAL_RESISTANCE);
      if (index < 0) continue;
      const previous = structuredClone(item.potentialOptions[index]);
      const next = makeMaximumPotential(template, previous, HP_FACTOR);
      item.potentialOptions[index] = next;
      changes.push({
        unitId: Number(unit.unitId), name: names.get(Number(unit.unitId)), slot,
        itemEquipId: Number(item.itemEquipId), groupId: expectedGroup,
        before: previous, after: structuredClone(next),
        criticalResistanceAfter: statTotal(equipment, CRITICAL_RESISTANCE),
        groundReductionAfter: statTotal(equipment, "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE"),
      });
    }
  }
  assertOnlyLatentsChanged(database, result, String(activeUid), changes);
  validateUser(user);
  return { database: result, changes };
}

function assertOnlyLatentsChanged(before, after, activeUid, changes) {
  const reconstructed = structuredClone(after);
  const previousUser = before.users[activeUid], currentUser = reconstructed.users[activeUid];
  const allowedItems = new Set(changes.map((change) => String(currentUser.army.units[Object.keys(currentUser.army.units).find((uid) => Number(currentUser.army.units[uid].unitId) === change.unitId)].equipItemUids[change.slot])));
  for (const [uid, previousItem] of Object.entries(previousUser.inventory.equips)) {
    const currentItem = currentUser.inventory.equips[uid];
    assert.ok(currentItem, "Existing equipment UID was removed");
    if (allowedItems.has(uid)) currentItem.potentialOptions = structuredClone(previousItem.potentialOptions);
  }
  assert.deepEqual(reconstructed, before, "A specialized profile may change only selected equipped potentialOptions");
  assert.equal(allowedItems.size, changes.length, "A selected equipment UID must be changed once");
}

function checksum(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function writeChecksumList(output) {
  const filenames = fs.readdirSync(output).filter((filename) => filename !== "SHA256SUMS.txt" && fs.statSync(path.join(output, filename)).isFile()).sort();
  privateWrite(path.join(output, "SHA256SUMS.txt"), `${filenames.map((filename) => `${checksum(path.join(output, filename))}  ${filename}`).join("\n")}\n`);
  return filenames.length;
}

function main(argv) {
  const args = {}; for (let index = 0; index < argv.length; index += 2) args[argv[index].replace(/^--/, "")] = argv[index + 1];
  assert.ok(args.input && args.output && args["active-user"], "Usage: --input users.json --active-user active-user.json --output external-directory --default-name descriptive.json [--life-name descriptive.json --include-na true]");
  const input = path.resolve(args.input), output = path.resolve(args.output);
  assert.ok(!output.startsWith(`${ROOT}${path.sep}`), "Private saves must stay outside the repository");
  assert.notEqual(path.join(output, "users.json"), input, "Original source cannot be overwritten");
  const defaultName = args["default-name"] || "RevivalSide-通用高难PvE-稳定抗暴.json";
  for (const filename of [defaultName, args["life-name"]].filter(Boolean)) assert.equal(path.basename(filename), filename, "Output name must be a filename");
  const beforeHash = checksum(input);
  const database = JSON.parse(fs.readFileSync(input));
  const activeUid = String(JSON.parse(fs.readFileSync(args["active-user"])).activeUserUid);
  assert.ok(database.users[activeUid], "Active selection must refer to the latest provided account");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.chmodSync(output, 0o700);
  // The default is an audited retention copy. Preserve its exact original bytes.
  fs.copyFileSync(input, path.join(output, defaultName)); fs.chmodSync(path.join(output, defaultName), 0o600);
  fs.copyFileSync(input, path.join(output, "users.json")); fs.chmodSync(path.join(output, "users.json"), 0o600);
  fs.copyFileSync(args["active-user"], path.join(output, "active-user.json")); fs.chmodSync(path.join(output, "active-user.json"), 0o600);
  const report = { purpose: "native-damage-audit", default: { filename: defaultName, changedGear: 0, sourceSha256: beforeHash, outputSha256: checksum(path.join(output, defaultName)), byteIdentical: true }, lifeSpecialized: null };
  if (args["life-name"]) {
    const specialized = makeLifeSpecializedVariant(database, activeUid, { includeNaYubin: args["include-na"] === "true", excludeUntrained: args["exclude-untrained"] !== "false" });
    privateWrite(path.join(output, args["life-name"]), specialized.database);
    report.lifeSpecialized = { filename: args["life-name"], changedUnits: specialized.changes.length, changedLatents: specialized.changes.length, purpose: "Only verified non-critical Inhibitor/Kraken ordinary-hit conditions; not a general replacement", changes: specialized.changes };
  }
  report.sourceUnchanged = beforeHash === checksum(input);
  assert.ok(report.sourceUnchanged, "Source changed during audit");
  privateWrite(path.join(output, "减伤校正-完整配装差异.json"), report);
  const count = writeChecksumList(output);
  console.log(JSON.stringify({ defaultByteIdentical: true, activeUnits: Object.keys(database.users[activeUid].army.units).length, specializedChanged: report.lifeSpecialized?.changedLatents || 0, artifactChecksums: count, sourceUnchanged: true }));
}

module.exports = { statTotal, makeMaximumPotential, makeLifeSpecializedVariant, assertOnlyLatentsChanged, checksum, writeChecksumList, main };
if (require.main === module) main(process.argv.slice(2));
