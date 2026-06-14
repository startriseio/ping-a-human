import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Persisted configuration shape. The setup wizard (S04) writes this exact
 * structure, and the channel layer reads it. Validated with zod so malformed
 * config fails loudly with a clear (secret-free) message.
 */
export const ConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1),
    // chat ids can be large negative numbers for groups; keep as string to
    // avoid JS number precision issues.
    chatId: z.string().min(1),
  }),
});

export type PingConfig = z.infer<typeof ConfigSchema>;

/** Environment variable name pointing at an explicit config file path. */
export const CONFIG_PATH_ENV = "PING_A_HUMAN_CONFIG";

/**
 * Default on-disk config location: ~/.config/ping-a-human/config.json.
 * Exported so the S04 setup wizard writes to the same place loadConfig reads.
 */
export function defaultConfigPath(): string {
  return join(homedir(), ".config", "ping-a-human", "config.json");
}

export type LoadConfigOptions = {
  /** Explicit config object — highest precedence (used by tests). */
  config?: PingConfig;
  /** Explicit config file path — overrides env and default. */
  path?: string;
  /** Environment source (defaults to process.env); injectable for tests. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolve configuration with this precedence:
 *   1. opts.config (explicit object)
 *   2. env vars TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (both must be present)
 *   3. config file at opts.path -> $PING_A_HUMAN_CONFIG -> defaultConfigPath()
 *
 * Throws a clear, secret-free Error when configuration is missing or invalid.
 * The bot token value is never included in any thrown message.
 */
export function loadConfig(opts: LoadConfigOptions = {}): PingConfig {
  const env = opts.env ?? process.env;

  // 1. Explicit object.
  if (opts.config) {
    return ConfigSchema.parse(opts.config);
  }

  // 2. Environment variable overrides (handy for tests and CI).
  const envToken = env.TELEGRAM_BOT_TOKEN;
  const envChatId = env.TELEGRAM_CHAT_ID;
  if (envToken && envChatId) {
    return ConfigSchema.parse({
      telegram: { botToken: envToken, chatId: envChatId },
    });
  }

  // 3. Config file.
  const filePath = opts.path ?? env[CONFIG_PATH_ENV] ?? defaultConfigPath();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(
      `No ping-a-human configuration found. Set TELEGRAM_BOT_TOKEN and ` +
        `TELEGRAM_CHAT_ID, or create a config file at ${filePath} ` +
        `(run 'ping-a-human setup').`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config file at ${filePath} is not valid JSON.`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Surface which fields are wrong without echoing any values.
    const issues = result.error.issues
      .map((i) => i.path.join("."))
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Config file at ${filePath} is missing or has invalid fields` +
        (issues ? `: ${issues}` : "") +
        `. Expected { telegram: { botToken, chatId } }.`
    );
  }
  return result.data;
}
