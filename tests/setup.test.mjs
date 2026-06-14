import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETUP = join(__dirname, "..", "dist", "setup.js");
const CONFIG = join(__dirname, "..", "dist", "config.js");

const {
  validateToken,
  detectChatId,
  writeConfig,
  mcpClientEntry,
  mcpClientEntrySnippet,
} = await import(SETUP);
const { loadConfig } = await import(CONFIG);

/** Build a fetch stub that returns a fixed JSON body for any URL. */
function fetchReturning(body) {
  return async () => ({ json: async () => body });
}

const SECRET = "123456:SUPER-SECRET-TOKEN";

test("validateToken returns ok + botUsername when getMe succeeds", async () => {
  const f = fetchReturning({ ok: true, result: { id: 1, username: "ping_a_human_bot" } });
  const res = await validateToken(SECRET, f);
  assert.equal(res.ok, true);
  assert.equal(res.botUsername, "ping_a_human_bot");
});

test("validateToken returns a secret-free reason when getMe fails", async () => {
  const f = fetchReturning({ ok: false, description: "Unauthorized" });
  const res = await validateToken(SECRET, f);
  assert.equal(res.ok, false);
  assert.match(res.reason, /Unauthorized/);
  assert.ok(!res.reason.includes(SECRET), "the token must never appear in the failure reason");
});

test("detectChatId extracts chatId from a message update", async () => {
  const f = fetchReturning({
    ok: true,
    result: [
      { update_id: 10, message: { chat: { id: 4242 }, from: { id: 9, first_name: "Ada" } } },
    ],
  });
  const res = await detectChatId(SECRET, f);
  assert.deepEqual(res, { chatId: "4242", fromName: "Ada" });
});

test("detectChatId extracts chatId from a callback_query-only update", async () => {
  const f = fetchReturning({
    ok: true,
    result: [
      { update_id: 11, callback_query: { message: { chat: { id: -100200 } }, from: { id: 7, username: "ada" } } },
    ],
  });
  const res = await detectChatId(SECRET, f);
  assert.equal(res.chatId, "-100200");
  assert.equal(res.fromName, "ada");
});

test("detectChatId returns the newest chat when multiple updates exist", async () => {
  const f = fetchReturning({
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 111 } } },
      { update_id: 2, message: { chat: { id: 222 } } },
    ],
  });
  const res = await detectChatId(SECRET, f);
  assert.equal(res.chatId, "222", "should pick the most recent update");
});

test("detectChatId returns null when there are no usable updates", async () => {
  const f = fetchReturning({ ok: true, result: [] });
  const res = await detectChatId(SECRET, f);
  assert.equal(res, null);
});

test("writeConfig round-trips through loadConfig", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ping-setup-"));
  const path = join(dir, "nested", "config.json");
  try {
    const config = { telegram: { botToken: SECRET, chatId: "4242" } };
    const written = await writeConfig(config, { path });
    assert.equal(written, path);
    const loaded = loadConfig({ path });
    assert.deepEqual(loaded, config, "written config must reload identically");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcpClientEntry / snippet produce an npx-based entry", () => {
  const entry = mcpClientEntry();
  assert.equal(entry.command, "npx");
  assert.ok(entry.args.includes("ping-a-human"), "args should reference the package");
  const snippet = mcpClientEntrySnippet();
  assert.match(snippet, /mcpServers/);
  assert.match(snippet, /ping-a-human/);
});
