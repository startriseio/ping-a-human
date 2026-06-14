import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { TelegramChannel } = await import(
  join(__dirname, "..", "dist", "channels", "telegram.js")
);

const BOT_TOKEN = "TEST_TOKEN";
const CHAT_ID = "12345";

/**
 * Build a mock fetch that records each call (method name parsed from the URL +
 * the parsed JSON body) and returns queued responses per Bot API method.
 *
 * enqueue(method, result) adds a { ok: true, result } response for the next
 * call to that method. getUpdates with an empty queue returns [] (so awaitReply
 * keeps polling until its deadline, exercising the timeout path).
 */
function makeMockFetch() {
  const calls = [];
  const queues = new Map(); // method -> array of results

  const mock = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });

    const queue = queues.get(method) ?? [];
    const result = queue.length > 0 ? queue.shift() : defaultFor(method);
    return {
      ok: true,
      json: async () => ({ ok: true, result }),
    };
  };

  function defaultFor(method) {
    if (method === "getUpdates") return [];
    if (method === "answerCallbackQuery") return true;
    if (method === "sendMessage") return { message_id: 1 };
    return {};
  }

  mock.calls = calls;
  mock.enqueue = (method, result) => {
    if (!queues.has(method)) queues.set(method, []);
    queues.get(method).push(result);
  };
  mock.callsTo = (method) => calls.filter((c) => c.method === method);
  return mock;
}

function makeChannel(mock, overrides = {}) {
  return new TelegramChannel({
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    fetchImpl: mock,
    longPollSeconds: 0, // keep tests fast
    ...overrides,
  });
}

test("send posts the correct sendMessage body and returns a string id", async () => {
  const mock = makeMockFetch();
  mock.enqueue("sendMessage", { message_id: 99 });
  const ch = makeChannel(mock);

  const ref = await ch.send("hi");

  const sent = mock.callsTo("sendMessage");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, CHAT_ID);
  assert.equal(sent[0].body.text, "hi");
  assert.equal(ref.id, "99");
});

test("send with choices includes an inline keyboard", async () => {
  const mock = makeMockFetch();
  const ch = makeChannel(mock);

  await ch.send("pick", { choices: ["Yes", "No"] });

  const body = mock.callsTo("sendMessage")[0].body;
  const kb = body.reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(kb), "missing inline_keyboard");
  const buttons = kb.flat();
  const texts = buttons.map((b) => b.text);
  assert.deepEqual(texts, ["Yes", "No"]);
  // callback_data must be short (<= 64 bytes).
  for (const b of buttons) {
    assert.ok(b.callback_data.length <= 64);
  }
});

test("awaitReply resolves a free-text reply from the configured chat", async () => {
  const mock = makeMockFetch();
  mock.enqueue("getUpdates", [
    {
      update_id: 10,
      message: {
        message_id: 5,
        text: "hello",
        from: { id: 42, first_name: "Ada" },
        chat: { id: Number(CHAT_ID) },
      },
    },
  ]);
  const ch = makeChannel(mock);

  const reply = await ch.awaitReply({ timeoutMs: 2000 });

  assert.equal(reply.status, "answered");
  assert.equal(reply.answer, "hello");
  assert.equal(reply.respondent.id, "42");
  assert.equal(reply.respondent.name, "Ada");
});

test("awaitReply resolves a button tap and answers the callback query", async () => {
  const mock = makeMockFetch();
  const ch = makeChannel(mock);

  // First send with choices so the channel knows token -> value mapping.
  await ch.send("pick", { choices: ["Yes", "No"] });
  // Telegram sends callback_data of the tapped button; "c0" maps to "Yes".
  mock.enqueue("getUpdates", [
    {
      update_id: 20,
      callback_query: {
        id: "cbq1",
        data: "c0",
        from: { id: 7, username: "grace" },
        message: { message_id: 5, chat: { id: Number(CHAT_ID) } },
      },
    },
  ]);

  const reply = await ch.awaitReply({ timeoutMs: 2000 });

  assert.equal(reply.status, "answered");
  assert.equal(reply.answer, "Yes");
  assert.equal(reply.respondent.id, "7");
  assert.equal(mock.callsTo("answerCallbackQuery").length, 1);
  assert.equal(
    mock.callsTo("answerCallbackQuery")[0].body.callback_query_id,
    "cbq1"
  );
});

test("awaitReply advances the getUpdates offset to update_id + 1", async () => {
  const mock = makeMockFetch();
  // First poll returns a non-matching update (different chat) so the loop
  // continues and makes a second getUpdates call with the advanced offset.
  mock.enqueue("getUpdates", [
    {
      update_id: 100,
      message: { message_id: 1, text: "noise", chat: { id: 999 } },
    },
  ]);
  const ch = makeChannel(mock);

  await ch.awaitReply({ timeoutMs: 300 });

  const polls = mock.callsTo("getUpdates");
  assert.ok(polls.length >= 2, `expected >=2 getUpdates calls, got ${polls.length}`);
  // First call has no offset; the next must be 101.
  assert.equal(polls[1].body.offset, 101);
});

test("awaitReply returns a structured timeout when no reply arrives", async () => {
  const mock = makeMockFetch(); // getUpdates always returns []
  const ch = makeChannel(mock);

  const reply = await ch.awaitReply({ timeoutMs: 200 });

  assert.equal(reply.status, "timeout");
});
