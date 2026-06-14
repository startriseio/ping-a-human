import type { Channel } from "./channel.js";
import { loadConfig, type LoadConfigOptions } from "./config.js";
import { TelegramChannel } from "./channels/telegram.js";

/**
 * Single seam where resolved configuration meets a concrete channel provider.
 *
 * Tools (notify_human / ask_human) depend only on the {@link Channel}
 * interface; this factory is the one place that knows Telegram is the current
 * implementation (R005). Adding Slack/WhatsApp later means branching here on a
 * provider field — tool logic stays untouched.
 */
export type CreateChannelOptions = LoadConfigOptions & {
  /**
   * Pre-built channel override. When provided it is returned as-is, bypassing
   * config loading. Used by tests to inject a stub Channel.
   */
  channel?: Channel;
};

/**
 * Build a {@link Channel} from configuration.
 *
 * Throws (via loadConfig) with a clear, secret-free message when configuration
 * is missing or invalid. Callers should surface that as a tool result rather
 * than crashing the server.
 */
export function createChannel(opts: CreateChannelOptions = {}): Channel {
  if (opts.channel) {
    return opts.channel;
  }

  const config = loadConfig(opts);
  return new TelegramChannel({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
  });
}
