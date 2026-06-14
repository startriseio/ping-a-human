import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as processStdin } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  ConfigSchema,
  defaultConfigPath,
  type PingConfig,
} from "./config.js";

type FetchImpl = typeof fetch;

/** Minimal Bot API shapes the wizard depends on. */
type TgResponse<T> = { ok: boolean; result?: T; description?: string };
type TgUser = { id: number; username?: string; first_name?: string };
type TgChat = { id: number; title?: string; username?: string };
type TgMessage = { chat?: TgChat; from?: TgUser };
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: { message?: TgMessage; from?: TgUser };
};

const API_BASE = "https://api.telegram.org";

/** POST a JSON body to a Bot API method. Never includes the token in errors. */
async function callApi<T>(
  token: string,
  method: string,
  body: unknown,
  fetchImpl: FetchImpl
): Promise<TgResponse<T>> {
  const res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as TgResponse<T>;
}

export type ValidateTokenResult =
  | { ok: true; botUsername: string }
  | { ok: false; reason: string };

/**
 * Validate a bot token by calling getMe. On success returns the bot's
 * @username (proof the token works) — never the token itself. On failure
 * returns a secret-free reason.
 */
export async function validateToken(
  token: string,
  fetchImpl: FetchImpl = fetch
): Promise<ValidateTokenResult> {
  let resp: TgResponse<TgUser>;
  try {
    resp = await callApi<TgUser>(token, "getMe", {}, fetchImpl);
  } catch (err) {
    return {
      ok: false,
      reason: `Could not reach Telegram: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!resp.ok || !resp.result) {
    return {
      ok: false,
      reason:
        resp.description ??
        "Telegram rejected the token (getMe failed). Double-check the token from BotFather.",
    };
  }
  return { ok: true, botUsername: resp.result.username ?? "(unknown)" };
}

export type DetectChatIdResult = { chatId: string; fromName?: string } | null;

/** Pull the chat id + best-effort name out of a single update. */
function chatFromUpdate(u: TgUpdate): DetectChatIdResult {
  const msg = u.message ?? u.edited_message ?? u.channel_post;
  if (msg?.chat) {
    return { chatId: String(msg.chat.id), fromName: nameOf(msg) };
  }
  const cbMsg = u.callback_query?.message;
  if (cbMsg?.chat) {
    return {
      chatId: String(cbMsg.chat.id),
      fromName: u.callback_query?.from?.first_name ?? u.callback_query?.from?.username,
    };
  }
  return null;
}

function nameOf(msg: TgMessage): string | undefined {
  return (
    msg.from?.first_name ??
    msg.from?.username ??
    msg.chat?.title ??
    msg.chat?.username
  );
}

/**
 * Detect the chat id by calling getUpdates and reading the most recent update
 * that carries a chat. Returns null when there are no usable updates yet (the
 * user must message the bot first). Reads newest-first so a fresh message wins.
 */
export async function detectChatId(
  token: string,
  fetchImpl: FetchImpl = fetch
): Promise<DetectChatIdResult> {
  let resp: TgResponse<TgUpdate[]>;
  try {
    resp = await callApi<TgUpdate[]>(token, "getUpdates", { timeout: 0 }, fetchImpl);
  } catch {
    return null;
  }
  const updates = resp.ok && resp.result ? resp.result : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const found = chatFromUpdate(updates[i]);
    if (found) return found;
  }
  return null;
}

export type WriteConfigDeps = {
  path?: string;
  writeFile?: (path: string, data: string) => Promise<void>;
  mkdir?: (path: string, opts: { recursive: boolean }) => Promise<unknown>;
};

/**
 * Persist config in the exact shape loadConfig reads, creating the parent dir
 * if needed. Returns the path written. Validates against ConfigSchema first so
 * we never write a malformed file.
 */
export async function writeConfig(
  config: PingConfig,
  deps: WriteConfigDeps = {}
): Promise<string> {
  const valid = ConfigSchema.parse(config);
  const path = deps.path ?? defaultConfigPath();
  const mkdir = deps.mkdir ?? ((p, o) => fsMkdir(p, o));
  const writeFile = deps.writeFile ?? ((p, d) => fsWriteFile(p, d, "utf8"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}

/** The MCP client entry users paste into Claude Desktop / Cursor config. */
export function mcpClientEntry(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "ping-a-human"] };
}

/** A ready-to-paste mcpServers JSON snippet for the MCP client config. */
export function mcpClientEntrySnippet(): string {
  return JSON.stringify(
    { mcpServers: { "ping-a-human": mcpClientEntry() } },
    null,
    2
  );
}

export type RunSetupDeps = {
  /** Where prompts are read from (defaults to process.stdin). */
  input?: Readable;
  /** Where prompts/diagnostics are written (defaults to process.stderr). */
  output?: Writable;
  fetchImpl?: FetchImpl;
  writeConfigDeps?: WriteConfigDeps;
  /** Attempts to detect the chat id after the user messages the bot. */
  detectAttempts?: number;
  /** Delay (ms) between chat-id detection attempts. */
  detectDelayMs?: number;
  /** Sleep impl (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Interactive setup wizard. Returns a process exit code (0 success, non-zero
 * failure). All prompts/diagnostics go to `output` (stderr by default); the bot
 * token is never written back to output.
 */
export async function runSetup(deps: RunSetupDeps = {}): Promise<number> {
  const input = deps.input ?? processStdin;
  // Default prompts to stderr so this stays consistent with the stdout-is-MCP
  // rule, even though setup is a separate invocation.
  const output = deps.output ?? process.stderr;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const detectAttempts = deps.detectAttempts ?? 10;
  const detectDelayMs = deps.detectDelayMs ?? 2000;
  const sleep = deps.sleep ?? defaultSleep;

  const rl = readline.createInterface({ input, output });
  const log = (s: string) => output.write(s + "\n");
  // Prompt wrapper that tolerates a closed/EOF'd input stream (e.g. piped or
  // non-interactive runs) by returning empty instead of throwing
  // ERR_USE_AFTER_CLOSE, so the loops fall through to their abort messages.
  const ask = async (q: string): Promise<string> => {
    try {
      return await rl.question(q);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ERR_USE_AFTER_CLOSE") return "";
      throw err;
    }
  };

  try {
    log("ping-a-human setup");
    log("");
    log("1. In Telegram, message @BotFather, send /newbot, and follow the prompts.");
    log("2. Copy the bot token it gives you (looks like 123456:ABC-...).");
    log("");

    let token = "";
    let botUsername = "";
    for (let i = 0; i < 3; i++) {
      token = (await ask("Paste your bot token: ")).trim();
      if (!token) {
        log("No token entered.");
        continue;
      }
      const v = await validateToken(token, fetchImpl);
      if (v.ok) {
        botUsername = v.botUsername;
        break;
      }
      log(`Token rejected: ${v.reason}`);
      token = "";
    }
    if (!token) {
      log("Could not validate a bot token after 3 attempts. Aborting.");
      return 1;
    }
    log(`Token OK — bot is @${botUsername}.`);
    log("");
    log(`3. Open Telegram, find @${botUsername}, and send it any message (e.g. \"hi\").`);
    await ask("   Press Enter once you've sent a message to the bot... ");

    let detected: DetectChatIdResult = null;
    for (let attempt = 1; attempt <= detectAttempts; attempt++) {
      detected = await detectChatId(token, fetchImpl);
      if (detected) break;
      if (attempt < detectAttempts) {
        log(`   No message seen yet (attempt ${attempt}/${detectAttempts}); retrying...`);
        await sleep(detectDelayMs);
      }
    }
    if (!detected) {
      log("");
      log("Could not detect your chat. Make sure you sent a message to the bot,");
      log("then run 'ping-a-human setup' again.");
      return 1;
    }
    log(
      `Detected chat${detected.fromName ? ` from ${detected.fromName}` : ""} (id ${detected.chatId}).`
    );

    const config: PingConfig = {
      telegram: { botToken: token, chatId: detected.chatId },
    };
    const savedPath = await writeConfig(config, deps.writeConfigDeps);
    log(`Saved config to ${savedPath}`);
    log("");
    log("4. Add this to your MCP client config (Claude Desktop / Cursor):");
    log("");
    log(mcpClientEntrySnippet());
    log("");
    log("Done. notify_human and ask_human are ready to use.");
    return 0;
  } finally {
    rl.close();
  }
}
