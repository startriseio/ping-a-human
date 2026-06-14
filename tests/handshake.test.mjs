import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "dist", "index.js");

/**
 * Drives the MCP server over stdio with line-delimited JSON-RPC (the framing
 * the SDK's StdioServerTransport uses: JSON.stringify(msg) + "\n").
 *
 * Sends initialize -> notifications/initialized -> tools/list, collects
 * responses keyed by id, and resolves once both request responses (ids 1 and 2)
 * have arrived. We intentionally do NOT call a tool here: notify_human /
 * ask_human perform live network I/O, so behavioral coverage lives in
 * tools.test.mjs against a stub Channel. This test guards the protocol surface.
 */
function runHandshake() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = new Map();
    const stdoutLines = [];
    let stdoutBuf = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`handshake timed out. stderr:\n${stderr}`));
    }, 10000);

    function finish() {
      if (settled) return;
      // Need responses for the two requests we sent (ids 1 and 2).
      if (responses.has(1) && responses.has(2)) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve({ responses, stdoutLines, stderr });
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim() === "") continue;
        stdoutLines.push(line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          // Non-JSON on stdout is a hard protocol violation.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`non-JSON line on stdout: ${JSON.stringify(line)}`));
          return;
        }
        if (typeof msg.id !== "undefined" && msg.id !== null) {
          responses.set(msg.id, msg);
        }
        finish();
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

    // 1) initialize
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "handshake-test", version: "0.0.0" },
      },
    });
    // initialized notification
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // 2) tools/list
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

test("server boots over stdio and lists notify_human and ask_human", async () => {
  const { responses, stdoutLines } = await runHandshake();

  // initialize succeeded
  const init = responses.get(1);
  assert.ok(init, "no initialize response");
  assert.ok(init.result, "initialize returned no result");

  // tools/list contains the two human-in-the-loop tools and no placeholder.
  const list = responses.get(2);
  assert.ok(list, "no tools/list response");
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert.ok(
    names.includes("notify_human"),
    `tools/list missing notify_human; got ${names.join(", ")}`
  );
  assert.ok(
    names.includes("ask_human"),
    `tools/list missing ask_human; got ${names.join(", ")}`
  );
  assert.ok(!names.includes("ping"), `placeholder ping should be gone; got ${names.join(", ")}`);

  // Guard the stdout-is-protocol constraint: every stdout line is valid JSON.
  for (const line of stdoutLines) {
    assert.doesNotThrow(() => JSON.parse(line), `stray non-JSON on stdout: ${line}`);
  }
});
