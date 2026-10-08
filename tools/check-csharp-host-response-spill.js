"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-host-spill-"));
  const fakeHost = path.join(temporary, "fake-host.js");
  const spillDir = path.join(temporary, "responses");
  const responseBufferBytes = 1024;
  fs.writeFileSync(fakeHost, `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { command, data } = JSON.parse(line);
  if (command === "largeAccount") {
    const equips = Array.from({ length: data.equipCount }, (_, index) => ({
      equipUid: String(9100000000000001n + BigInt(index)), itemEquipId: 561141,
      stats: [{ type: "NST_ATK", value: 237 }, { type: "NST_SKILL_COOL_TIME_REDUCE_RATE", value: 0.1 }],
    }));
    process.stdout.write(JSON.stringify({ ok: true, equips, payloadBase64: Buffer.from("account-payload").toString("base64") }) + "\\n");
  } else if (command === "defaultLimit") {
    process.stdout.write(JSON.stringify({ ok: true, contents: "x".repeat(data.length) }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, summary: "small response", count: data.count }) + "\\n");
  }
});
`, "utf8");

  const host = createCsharpCombatHost({
    enabled: true, dllPath: fakeHost, dotnetPath: process.execPath,
    responseFileDir: spillDir, responseBufferBytes, timeoutMs: 10000,
  });
  let defaultHost = null;
  try {
    assert.deepEqual(host.request("small", { count: 1 }), { ok: true, summary: "small response", count: 1 });
    assert.deepEqual(fs.readdirSync(spillDir), [], "small replies must not leave a spill file");
    const large = host.request("largeAccount", { equipCount: 6000 });
    assert.equal(large.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > responseBufferBytes);
    assert.equal(large.equips.length, 6000);
    assert.equal(large.equips[5999].equipUid, "9100000000006000");
    assert.equal(large.payload.toString(), "account-payload", "spilled responses must still revive base64 payloads");
    assert.deepEqual(fs.readdirSync(spillDir), [], "the spill file must be deleted before request returns");
    const second = host.request("largeAccount", { equipCount: 7000 });
    assert.equal(second.equips.length, 7000);
    assert.deepEqual(fs.readdirSync(spillDir), [], "repeated large replies must not accumulate files");
    assert.deepEqual(host.request("small", { count: 2 }), { ok: true, summary: "small response", count: 2 });
    assert.deepEqual(fs.readdirSync(spillDir), [], "small replies after spilling must still work");

    defaultHost = createCsharpCombatHost({
      enabled: true, dllPath: fakeHost, dotnetPath: process.execPath,
      responseFileDir: spillDir, timeoutMs: 15000,
    });
    const defaultLength = 17 * 1024 * 1024;
    const defaultLarge = defaultHost.request("defaultLimit", { length: defaultLength });
    assert.equal(defaultLarge.ok, true, "responses above the default 16 MiB shared buffer must succeed");
    assert.equal(defaultLarge.contents.length, defaultLength);
    assert.equal(defaultLarge.contents, "x".repeat(defaultLength));
    assert.deepEqual(fs.readdirSync(spillDir), [], "default-buffer spill must be removed immediately");
    console.log("[csharp-host-response-spill] PASS real Worker/process bridge, account JSON, >16 MiB response, cleanup, and small replies");
  } finally {
    await host.close();
    if (defaultHost) await defaultHost.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
