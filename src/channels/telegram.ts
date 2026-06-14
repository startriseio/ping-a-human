import type {
  AwaitReplyOptions,
  Channel,
  MessageRef,
  ReplyResult,
  Respondent,
  SendOptions,
} from "../channel.js";

/** Minimal subset of the Telegram Bot API types we depend on. */
type TgUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TgChat = { id: number };

type TgMessage = {
  message_id: number;
  text?: string;
  from?: TgUser;
  chat?: TgChat;
};

type TgCallbackQuery = {
  id: string;
  data?: string;
  from?: TgUser;
  message?: TgMessage;
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

type TgResponse<T> = { ok: boolean; result?: T; description?: string };

type FetchImpl = typeof fetch;

/**
 * Telegram bot commands (text beginning with "/", e.g. "/start", "/help") are
 * client/protocol messages, never a human's answer to a free-text question.
 * The most common offender is the "/start" Telegram auto-sends when a user
 * first opens the bot, which would otherwise be returned as the reply.
 */
function isBotCommand(text: string): boolean {
  return /^\/[A-Za-z0-9_]+(@\w+)?(\s|$)/.test(text.trim());
}

export type TelegramChannelConfig = {
  botToken: string;
  chatId: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchImpl;
  /** Server-side long-poll seconds per getUpdates call. Tests use 0 for speed. */
  longPollSeconds?: number;
};

/**
 * Telegram implementation of the Channel interface using the Bot API over
 * plain HTTPS (Node's built-in fetch). No third-party Telegram SDK.
 *
 * Reply capture uses getUpdates long-polling (no webhook / public URL needed).
 * Both free-text replies (update.message) and inline-button taps
 * (update.callback_query) resolve awaitReply. The getUpdates offset cursor is
 * owned per instance and always advanced to update_id + 1 to avoid redelivery.
 */
export class TelegramChannel implements Channel {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly fetchImpl: FetchImpl;
  private readonly longPollSeconds: number;

  /** getUpdates cursor: next update offset to request. */
  private offset: number | undefined;

  /** Maps short callback_data tokens back to human-readable choice values. */
  private callbackChoices = new Map<string, string>();

  constructor(config: TelegramChannelConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.longPollSeconds = config.longPollSeconds ?? 30;
  }

  /** POST a JSON body to a Bot API method. Never logs or echoes the token. */
  private async api<T>(method: string, body: unknown): Promise<T> {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) {
      // Reference the method, not the token, in the error.
      throw new Error(
        `Telegram API ${method} failed: ${json.description ?? "unknown error"}`
      );
    }
    return json.result as T;
  }

  async send(message: string, options?: SendOptions): Promise<MessageRef> {
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text: message,
    };

    if (options?.choices && options.choices.length > 0) {
      // Build inline buttons. callback_data is capped at 64 bytes by Telegram,
      // so use a short token and map it back to the choice value.
      //
      // The token carries a per-send random prefix so it is UNIQUE to this
      // question. Telegram can redeliver a stale tap from an earlier question
      // (getUpdates backlog), and a fixed token like "c0" would then collide
      // with this question's first choice and be wrongly returned as the
      // answer. A unique prefix means a stale tap's token simply won't be in
      // the current map, so awaitReply can recognize and ignore it.
      this.callbackChoices.clear();
      const nonce = Math.random().toString(36).slice(2, 8);
      const row = options.choices.map((choice, i) => {
        const token = `${nonce}${i}`;
        this.callbackChoices.set(token, choice);
        return { text: choice, callback_data: token };
      });
      body.reply_markup = { inline_keyboard: [row] };
    }

    const result = await this.api<TgMessage>("sendMessage", body);
    return { id: String(result.message_id) };
  }

  async awaitReply(options: AwaitReplyOptions): Promise<ReplyResult> {
    const deadline = Date.now() + options.timeoutMs;

    // Anchor: only accept replies that arrive AFTER the question was sent.
    // Telegram message ids are monotonically increasing per chat, so any
    // update whose message predates the question (e.g. a queued `/start` from
    // first opening the bot) must be ignored — otherwise it would be wrongly
    // returned as the human's answer. Honors AwaitReplyOptions.sinceRef.
    const sinceMessageId =
      options.sinceRef != null ? Number(options.sinceRef.id) : undefined;
    const isStale = (messageId: number | undefined): boolean =>
      sinceMessageId != null &&
      messageId != null &&
      messageId <= sinceMessageId;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      // Don't long-poll longer than the time we have left.
      const pollSeconds = Math.max(
        0,
        Math.min(this.longPollSeconds, Math.floor(remainingMs / 1000))
      );

      const updates = await this.api<TgUpdate[]>("getUpdates", {
        offset: this.offset,
        timeout: pollSeconds,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        // Always advance the cursor so updates are not redelivered.
        this.offset = update.update_id + 1;

        // Free-text reply.
        const msg = update.message;
        if (msg?.text && this.fromConfiguredChat(msg.chat)) {
          // Skip backlog that predates the question (e.g. a stale `/start`).
          if (isStale(msg.message_id)) continue;
          // Bot commands ("/start", "/help", ...) are never valid answers to a
          // free-text question; treat them as noise and keep waiting.
          if (isBotCommand(msg.text)) continue;
          return {
            status: "answered",
            answer: msg.text,
            respondent: this.respondentFrom(msg.from),
          };
        }

        // Inline-button tap. We must NOT use the isStale message_id anchor
        // here: a callback_query's `message` is the bot's OWN question, so its
        // id always satisfies id <= sinceRef and the anchor would drop every
        // tap. Instead we key off the unique per-send callback token: only a
        // tap whose token is in the CURRENT question's map is a real answer to
        // this question. A tap whose token is unknown is stale or redelivered
        // (a previous question's button, or backlog Telegram replayed) — clear
        // its spinner and keep waiting rather than returning it as the answer.
        const cb = update.callback_query;
        if (cb) {
          // Best-effort: clear the client's loading spinner.
          try {
            await this.api("answerCallbackQuery", { callback_query_id: cb.id });
          } catch {
            // Non-fatal.
          }
          const answer = cb.data ? this.callbackChoices.get(cb.data) : undefined;
          if (answer === undefined) continue; // stale/unknown tap — keep waiting
          // A known token is by definition our question; accept it (the chat
          // guard only matters when a message envelope is present).
          if (cb.message != null && !this.fromConfiguredChat(cb.message.chat)) {
            continue;
          }
          return {
            status: "answered",
            answer,
            respondent: this.respondentFrom(cb.from),
          };
        }
      }
    }

    return { status: "timeout" };
  }

  private fromConfiguredChat(chat: TgChat | undefined): boolean {
    if (!chat) return false;
    return String(chat.id) === this.chatId;
  }

  private respondentFrom(user: TgUser | undefined): Respondent {
    if (!user) return { id: "unknown" };
    return {
      id: String(user.id),
      name: user.first_name ?? user.username,
    };
  }
}
