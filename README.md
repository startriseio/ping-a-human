# ping-a-human

An open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that adds a
human-in-the-loop step to any AI pipeline, agent, or automation. It lets an AI **notify** a human or
**ask** a human and wait for their answer — reaching the person on the messaging app they already use
(Telegram first; Slack, WhatsApp, and more later).

Unlike MCP's built-in elicitation (which prompts inside the AI client UI), `ping-a-human` reaches the
human **out-of-band on their own messaging app**, so it works even when nobody is watching the AI
session.

## Tools

The server exposes two tools over stdio:

- **`notify_human`** — fire-and-forget. Sends a message to the configured human and returns
  immediately without waiting for a reply.
  - Input: `{ message: string }`
- **`ask_human`** — sends a question, then **blocks until the human replies** (or a timeout elapses)
  and returns their answer.
  - Input: `{ question: string, choices?: string[], timeoutMs?: number }`
  - With `choices`, the options render as tappable Telegram inline buttons and the tapped value is
    returned (e.g. `["Yes", "No"]`).
  - On timeout it returns a clear timed-out result instead of an error, so the calling agent gets a
    clean signal. Default timeout is 5 minutes.

## Install

No clone or build required. The server runs straight from npm via your package runner:

```bash
npx  ping-a-human setup     # npm
bunx ping-a-human setup     # bun
pnpm dlx ping-a-human setup # pnpm
```

Your MCP client (Claude Desktop, Cursor, etc.) launches it the same way (see step 2) — so end users
never install anything globally. Cloning the repo is only needed for contributing.

## Quickstart

### 1. Create a Telegram bot and configure the server

Run the interactive setup wizard — it validates your bot token, auto-detects your chat id, writes the
config, and prints the MCP client entry to paste:

```bash
npx ping-a-human setup
```

The wizard walks you through:

1. Message [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and copy the bot token.
2. Paste the token when prompted — the wizard verifies it via Telegram and shows your bot's `@username`.
3. Send your new bot any message (e.g. "hi") in Telegram, then press Enter — the wizard auto-detects
   your `chat_id`.
4. The config is saved to `~/.config/ping-a-human/config.json` and the wizard prints an `mcpServers`
   snippet.

### 2. Add the server to your MCP client

Add this to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "ping-a-human": {
      "command": "npx",
      "args": ["-y", "ping-a-human"]
    }
  }
}
```

Restart the client. It will list `notify_human` and `ask_human`.

### 3. Use it from an agent

- **Notify** when a long job finishes: `notify_human({ message: "Deploy to prod finished ✅" })`.
- **Ask before a risky action**:
  `ask_human({ question: "Apply this DB migration to prod?", choices: ["Yes", "No"] })` — the human
  taps a button and the agent receives `"Yes"` or `"No"`.
- **Ask an open question**: `ask_human({ question: "What should the release title be?" })` — the agent
  receives the human's free-text reply.

## Configuration

The server reads configuration with this precedence:

1. Environment variables `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (both required together).
2. A config file at `$PING_A_HUMAN_CONFIG`, or `~/.config/ping-a-human/config.json` by default,
   shaped as:

```json
{ "telegram": { "botToken": "123456:ABC-...", "chatId": "4242" } }
```

The bot token is a secret — it is never logged or echoed. All diagnostics go to **stderr**; **stdout**
is reserved for the MCP JSON-RPC channel.

## Local development

```bash
npm install
npm run build
node dist/index.js          # starts the stdio MCP server
node dist/index.js setup    # runs the setup wizard
npm test                    # runs the full test suite
```

### Live smoke test (optional)

With real credentials set, send a real message and wait for a reply:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/smoke-telegram.mjs
```

Without credentials it prints a skip notice and exits 0, so it is safe in CI.

## End-to-end verification (live)

A repeatable manual procedure that exercises the whole loop against real Telegram:

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and
   copy the token.
2. **Run setup.** `npx ping-a-human setup` — paste the token, message your bot when prompted, and let
   the wizard auto-detect your `chat_id` and write the config.
3. **Wire up a client.** Add the printed `mcpServers` snippet to Claude Desktop / Cursor and restart.
4. **Prove `ask_human` with buttons.** From the client, call
   `ask_human({ question: "Proceed?", choices: ["Yes", "No"] })`. You should receive a Telegram message
   with two buttons; tap one and confirm the agent receives that exact value.
5. **Prove `notify_human`.** Call `notify_human({ message: "hello from my agent" })` and confirm the
   message arrives and the call returns immediately.
6. **Prove the timeout.** Call `ask_human({ question: "...", timeoutMs: 10000 })` and do not reply;
   after ~10s the agent should receive a clear timed-out result (not an error).

No MCP client handy? The credential-gated smoke script exercises the live send → reply path directly:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/smoke-telegram.mjs
```

## License

MIT — see [LICENSE](./LICENSE).
