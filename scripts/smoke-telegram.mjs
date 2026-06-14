#!/usr/bin/env node
/**
 * Live Telegram smoke test (MANUAL / UAT).
 *
 * Sends a real message via the configured bot and waits up to 60s for a reply,
 * exercising the full send -> getUpdates -> reply-capture path against the real
 * Bot API. This is the end-to-end proof that mocked unit tests can't provide.
 *
 * Requirements to actually run:
 *   - TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set in the environment
 *   - the target chat must have already messaged the bot at least once
 *     (so Telegram will deliver updates for it)
 *
 * Safe in any environment: if credentials are absent it prints a skip notice
 * and exits 0, so CI / headless runs never fail on it. The bot token is never
 * printed.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/smoke-telegram.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error(
    "skipped: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to run the live smoke test."
  );
  process.exit(0);
}

const { TelegramChannel } = await import(
  join(__dirname, "..", "dist", "channels", "telegram.js")
);

const channel = new TelegramChannel({ botToken: token, chatId });

console.error("sending smoke-test message...");
const ref = await channel.send(
  "ping-a-human smoke test: reply within 60s (or tap a button)",
  { choices: ["Got it", "Ignore"] }
);
console.error(`sent (message id ${ref.id}); waiting up to 60s for a reply...`);

const reply = await channel.awaitReply({ timeoutMs: 60_000 });

if (reply.status === "answered") {
  console.error(
    `reply received: "${reply.answer}" from ${reply.respondent.name ?? reply.respondent.id}`
  );
  process.exit(0);
} else {
  console.error("no reply within the timeout (status: timeout).");
  process.exit(1);
}
