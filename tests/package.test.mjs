import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Proves the npx/bin launch path works from a CLEAN INSTALL of the packed
 * tarball — not from the source tree. Steps:
 *   1. npm pack the project into a tarball.
 *   2. Install that tarball into a throwaway temp project.
 *   3. Drive the installed `ping-a-human` bin over stdio (MCP handshake).
 *   4. Run the installed bin with `setup` and confirm the wizard starts.
 *
 * npm pack + install are slow, so this whole flow runs under one test with a
 * generous timeout and tears the temp dir down afterward.
 */

function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`
    );
  }
  return res;
}

/** Build the tarball and return its absolute path. */
function packTarball(destDir) {
  const res = runSync("npm", ["pack", "--json", "--pack-destination", destDir], {
    cwd: PROJECT_ROOT,
  });
  const parsed = JSON.parse(res.stdout);
  const filename = parsed[0]?.filename;
  assert.ok(filename, "npm pack --json returned no filename");
  const tgz = join(destDir, filename);
  assert.ok(existsSync(tgz), `packed tarball not found at ${tgz}`);
  return tgz;
}

/** MCP stdio handshake: initialize -> tools/list. Resolves with responses. */
function handshake(binPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    const stdoutLines = [];
    let buf = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`handshake timed out. stderr:\n${stderr}`));
    }, 15000);

    function finish() {
      if (settled) return;
      if (responses.has(1) && responses.has(2)) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve({ responses, stdoutLines });
      }
    }

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.trim() === "") continue;
        stdoutLines.push(line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`non-JSON line on stdout: ${JSON.stringify(line)}`));
          return;
        }
        if (typeof msg.id !== "undefined" && msg.id !== null) responses.set(msg.id, msg);
        finish();
      }
    });
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "package-test", version: "0.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

/** Run the bin with `setup` and empty stdin; capture stderr + exit code. */
function runSetupBanner(binPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ["setup"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("setup did not finish in time"));
    }, 15000);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Empty stdin -> wizard can't read a token -> clean abort.
    child.stdin.end();
  });
}

test("packed tarball installs and the bin runs the MCP server + setup wizard", async () => {
  // Ensure dist is current before packing.
  runSync("npm", ["run", "build"], { cwd: PROJECT_ROOT });

  const work = mkdtempSync(join(tmpdir(), "ping-pack-"));
  try {
    const tgz = packTarball(work);

    // Fresh consumer project that depends on the tarball.
    const consumer = join(work, "consumer");
    runSync("mkdir", ["-p", consumer]);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2)
    );
    runSync("npm", ["install", tgz, "--no-audit", "--no-fund"], { cwd: consumer });

    const bin = join(consumer, "node_modules", ".bin", "ping-a-human");
    assert.ok(existsSync(bin), `installed bin not found at ${bin}`);

    // (a) MCP server over stdio lists both tools.
    const { responses, stdoutLines } = await handshake(bin);
    const init = responses.get(1);
    assert.ok(init?.result, "initialize failed from installed bin");
    const names = (responses.get(2)?.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("notify_human"), `missing notify_human; got ${names.join(", ")}`);
    assert.ok(names.includes("ask_human"), `missing ask_human; got ${names.join(", ")}`);
    assert.ok(!names.includes("ping"), "placeholder ping should not be present");
    for (const line of stdoutLines) {
      assert.doesNotThrow(() => JSON.parse(line), `stray non-JSON on stdout: ${line}`);
    }

    // (b) `setup` enters the wizard and aborts cleanly on empty stdin.
    const setup = await runSetupBanner(bin);
    assert.match(setup.stderr, /ping-a-human setup/, "wizard banner not printed");
    assert.notEqual(setup.code, null, "setup process did not exit");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
