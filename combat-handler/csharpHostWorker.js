const { parentPort, workerData } = require("worker_threads");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RESPONSE_FILE_MARKER = "__revivalsideCombatHostResponseFile";
const responseFileDir = path.resolve(String(workerData.responseFileDir || process.cwd()));
const responseFilePrefix = String(workerData.responseFilePrefix || "revivalside-combat-host-response-");

let child = null;
let stdoutBuffer = "";
let stderrBuffer = "";
const pending = [];

startChild();

parentPort.on("message", (message) => {
  if (!message || !message.sharedBuffer) return;
  if (message.shutdown) {
    stopChild();
    const header = new Int32Array(message.sharedBuffer);
    Atomics.store(header, 0, 1);
    Atomics.notify(header, 0, 1);
    parentPort.close();
    return;
  }
  if (!child || child.killed || !child.stdin.writable) {
    complete(message.sharedBuffer, JSON.stringify({ ok: false, error: "C# combat host process is not running" }));
    return;
  }
  pending.push(message.sharedBuffer);
  child.stdin.write(`${message.input}\n`);
});
parentPort.on("close", stopChild);
process.on("exit", stopChild);

function startChild() {
  const runDirectly = Boolean(workerData.runDirectly);
  const fileName = runDirectly ? workerData.hostPath : workerData.dotnetPath || "dotnet";
  const args = runDirectly ? ["--stdio"] : [workerData.hostPath, "--stdio"];
  child = spawn(fileName, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: workerData.modTablesDir ? { ...process.env, CS_MOD_TABLES_DIR: workerData.modTablesDir } : process.env,
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const sharedBuffer = pending.shift();
      if (sharedBuffer) complete(sharedBuffer, line || JSON.stringify({ ok: false, error: "empty host response" }));
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
  });

  child.on("exit", (code, signal) => {
    const error = `C# combat host exited code=${code} signal=${signal || ""} ${stderrBuffer.trim()}`.trim();
    while (pending.length) complete(pending.shift(), JSON.stringify({ ok: false, error }));
  });
}

function complete(sharedBuffer, text) {
  const header = new Int32Array(sharedBuffer, 0, 2);
  const bytes = Buffer.from(sharedBuffer, 8);
  let payload = Buffer.from(String(text), "utf8");
  if (payload.length > bytes.length) {
    try {
      fs.mkdirSync(responseFileDir, { recursive: true });
      const responseFile = path.join(responseFileDir, `${responseFilePrefix}${process.pid}-${crypto.randomUUID()}.json`);
      fs.writeFileSync(responseFile, payload);
      payload = Buffer.from(JSON.stringify({ [RESPONSE_FILE_MARKER]: responseFile }), "utf8");
    } catch (err) {
      payload = Buffer.from(JSON.stringify({ ok: false, error: `combat host response spill failed: ${err.message}` }), "utf8");
    }
  }
  payload.copy(bytes, 0, 0, Math.min(payload.length, bytes.length));
  Atomics.store(header, 1, Math.min(payload.length, bytes.length));
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0, 1);
}

function stopChild() {
  if (child && !child.killed) child.kill();
  child = null;
}
