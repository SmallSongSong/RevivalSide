"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { createFierceSelector } = require("../modules/fierce-selection");
const { createUserManager } = require("../server/userManager");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-fierce-selection-"));
  const selectionPath = path.join(dir, "server-data/fierce-selection.json");
  let inBattle = false;
  let failApply = false;
  const applied = [];
  const selector = createFierceSelector({ selectionPath,
    canApply() { if (inBattle) { const error = new Error("请先结束或退出激战支援战斗。"); error.statusCode = 409; throw error; } },
    onApply(next, previous) { if (failApply) throw new Error("notification failed"); applied.push([next.seasonId, previous.seasonId]); },
  });
  const catalog = selector.getState();
  assert.equal(catalog.seasonId, 0);
  assert.equal(catalog.options.length, 19);
  assert.equal(new Set(catalog.options.map(row => row.name)).size, 19);
  for (const option of catalog.options) {
    assert.match(option.name, /[\u4e00-\u9fff]/);
    assert(option.bosses.length >= 3);
    for (const group of option.groupIds) assert(option.bosses.some(boss => boss.groupId === group && boss.difficulty === 1));
    assert(option.bosses.every(boss => boss.bossId > 0 && boss.dungeonId > 0));
  }
  const orochi = catalog.options.find(row => row.name === "八岐大蛇");
  const moderator = catalog.options.find(row => row.name === "仲裁者 TYPE A");
  assert(orochi && moderator);
  selector.saveSelection({ seasonId: orochi.seasonId });
  const persisted = fs.readFileSync(selectionPath);
  assert.equal(createFierceSelector({ selectionPath }).getActiveSeasonId(), orochi.seasonId, "restart must retain manual selection");
  for (const value of [null, {}, { seasonId: "2337" }, { seasonId: 9001 }, { seasonId: 999999 }, { seasonId: -1 }]) {
    assert.throws(() => selector.saveSelection(value), error => error.statusCode === 400);
    assert.deepEqual(fs.readFileSync(selectionPath), persisted);
  }
  inBattle = true;
  assert.throws(() => selector.saveSelection({ seasonId: moderator.seasonId }), error => error.statusCode === 409);
  assert.deepEqual(fs.readFileSync(selectionPath), persisted);
  assert.equal(selector.getActiveSeasonId(), orochi.seasonId);
  inBattle = false;
  failApply = true;
  assert.throws(() => selector.saveSelection({ seasonId: moderator.seasonId }), /notification failed/);
  assert.deepEqual(fs.readFileSync(selectionPath), persisted);
  assert.equal(selector.getActiveSeasonId(), orochi.seasonId);
  failApply = false;

  const dbPath = path.join(dir, "users.json");
  const db = { users: {}, activeUserUid: "" };
  fs.writeFileSync(dbPath, JSON.stringify(db));
  const dbBytes = fs.readFileSync(dbPath);
  const manager = createUserManager({ userDb: db, userDbPath: dbPath, saveUserDb() { throw new Error("selector must not save profiles"); },
    getFierceSelectorState: selector.getState, saveFierceSelection: selector.saveSelection });
  const server = http.createServer((req, res) => manager.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/user-manager`;
  try {
    const html = await (await fetch(base)).text();
    assert(html.includes('id="fierceBossBtn"'));
    assert(html.includes("保存并切换"));
    new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    const get = await fetch(base + "/api/fierce-boss");
    assert.equal(get.status, 200);
    assert.equal((await get.json()).options.length, 19);
    const put = value => fetch(base + "/api/fierce-boss", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    inBattle = true;
    const busy = await put({ seasonId: moderator.seasonId });
    assert.equal(busy.status, 409);
    assert.deepEqual(fs.readFileSync(selectionPath), persisted);
    inBattle = false;
    const invalid = await put({ seasonId: 999999 });
    assert.equal(invalid.status, 400);
    assert.deepEqual(fs.readFileSync(selectionPath), persisted);
    const changed = await put({ seasonId: moderator.seasonId });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).activeName, "仲裁者 TYPE A");
    assert.equal(selector.getActiveSeasonId(), moderator.seasonId, "hot switch must affect running controller");
    assert.deepEqual(fs.readFileSync(dbPath), dbBytes, "Boss config must not modify account data");
    const auto = await put({ seasonId: 0 });
    assert.equal(auto.status, 200);
    assert.equal((await auto.json()).mode, "rotation");
    assert.equal(createFierceSelector({ selectionPath }).getActiveSeasonId(), 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(selectionPath, '{"schemaVersion":1,"seasonId":999999}');
  const stale = createFierceSelector({ selectionPath });
  assert.equal(stale.getActiveSeasonId(), 0);
  assert(stale.getState().warning);
  fs.writeFileSync(selectionPath, "broken");
  const broken = createFierceSelector({ selectionPath });
  assert.equal(broken.getActiveSeasonId(), 0);
  assert(broken.getState().warning);
  assert(applied.length >= 3);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("Fierce selection checks passed: 19 real Chinese Boss choices, persistence, hot apply, busy/invalid rollback, account isolation and manager API/UI syntax.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
