import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(__dirname, "..", "dist", "tools.js");

const { notifyHuman, askHuman } = await import(TOOLS);

/**
 * A scriptable Channel stub. Records calls so tests can assert the tool layer
 * uses the Channel interface exactly as expected (R005), without any live I/O.
 */
function makeStubChannel({ reply, sendError, replyError } = {}) {
  const calls = { send: [], awaitReply: [] };
  return {
    calls,
    async send(message, options) {
      calls.send.push({ message, options });
      if (sendError) throw sendError;
      return { id: "msg-1" };
    },
    async awaitReply(options) {
      calls.awaitReply.push({ options });
      if (replyError) throw replyError;
      return reply;
    },
  };
}

test("notify_human sends once and returns success without awaiting a reply (R001)", async () => {
  const ch = makeStubChannel();
  const res = await notifyHuman(ch, { message: "deploy finished" });

  assert.equal(ch.calls.send.length, 1, "send should be called exactly once");
  assert.equal(ch.calls.send[0].message, "deploy finished");
  assert.equal(ch.calls.awaitReply.length, 0, "notify_human must NOT await a reply");
  assert.ok(!res.isError, "should be a success result");
  assert.match(res.content[0].text, /delivered/i);
});

test("ask_human (no choices) returns the free-text answer and respondent (R002)", async () => {
  const ch = makeStubChannel({
    reply: { status: "answered", answer: "ship it", respondent: { id: "42", name: "Ada" } },
  });
  const res = await askHuman(ch, { question: "Ship now?" });

  assert.equal(ch.calls.send.length, 1);
  assert.equal(ch.calls.send[0].message, "Ship now?");
  assert.deepEqual(ch.calls.send[0].options, { choices: undefined });
  assert.equal(ch.calls.awaitReply.length, 1, "ask_human must await a reply");
  assert.match(res.content[0].text, /ship it/);
  assert.match(res.content[0].text, /Ada/);
  assert.match(res.content[0].text, /42/);
});

test("ask_human (choices) forwards choices to send and returns the tapped value (R003)", async () => {
  const ch = makeStubChannel({
    reply: { status: "answered", answer: "Yes", respondent: { id: "7" } },
  });
  const res = await askHuman(ch, { question: "Proceed?", choices: ["Yes", "No"] });

  assert.deepEqual(
    ch.calls.send[0].options,
    { choices: ["Yes", "No"] },
    "choices must be forwarded to Channel.send so they render as buttons"
  );
  assert.match(res.content[0].text, /answered: Yes/);
});

test("ask_human returns a clear timed-out result, not an error (R002)", async () => {
  const ch = makeStubChannel({ reply: { status: "timeout" } });
  const res = await askHuman(ch, { question: "Still there?", timeoutMs: 1234 });

  assert.ok(!res.isError, "timeout is a normal result, not an error");
  assert.match(res.content[0].text, /timed out/i);
  assert.match(res.content[0].text, /1234/);
  assert.equal(ch.calls.awaitReply[0].options.timeoutMs, 1234, "timeoutMs must be passed through");
});

test("ask_human surfaces a send failure as an error result", async () => {
  const ch = makeStubChannel({ sendError: new Error("network down") });
  const res = await askHuman(ch, { question: "hi" });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /network down/);
  assert.equal(ch.calls.awaitReply.length, 0, "should not await a reply if send failed");
});

test("notify_human surfaces a send failure as an error result", async () => {
  const ch = makeStubChannel({ sendError: new Error("bad token") });
  const res = await notifyHuman(ch, { message: "hi" });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /bad token/);
});
