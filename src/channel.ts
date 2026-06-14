/**
 * Transport-agnostic messaging channel contract.
 *
 * This interface is deliberately free of any provider-specific types so that
 * the first messaging provider is just one implementation and others (Slack,
 * WhatsApp) can be added later without changing tool logic (R005). Tools
 * (notify_human / ask_human) import ONLY this module — never a concrete
 * channel's types.
 */

/** Opaque handle to a message that was sent through a channel. */
export type MessageRef = {
  /** Provider-neutral message identifier (the provider's message id as a string). */
  id: string;
};

/** Options controlling how a message is sent. */
export type SendOptions = {
  /**
   * Optional predefined choices. When present, the channel should render them
   * as tappable buttons and return the selected value as the reply answer.
   */
  choices?: string[];
};

/** Options controlling how long, and from when, to wait for a human reply. */
export type AwaitReplyOptions = {
  /** Overall deadline in milliseconds. On expiry, awaitReply resolves to a timeout result. */
  timeoutMs: number;
  /** Optional anchor: only consider replies that arrive after this sent message. */
  sinceRef?: MessageRef;
};

/** The human who answered. Neutral identity — no provider-specific fields. */
export type Respondent = {
  /** Provider-neutral respondent identifier. */
  id: string;
  /** Best-effort display name, when available. */
  name?: string;
};

/**
 * Result of awaiting a human reply. A discriminated union so callers must
 * handle the timeout case explicitly instead of treating it as an error.
 */
export type ReplyResult =
  | { status: "answered"; answer: string; respondent: Respondent }
  | { status: "timeout" };

/**
 * A messaging channel that can deliver a message to a human and (optionally)
 * wait for their reply.
 */
export interface Channel {
  /**
   * Deliver a message. Returns a reference to the sent message. Does not wait
   * for a reply — use awaitReply for that.
   */
  send(message: string, options?: SendOptions): Promise<MessageRef>;

  /**
   * Wait for the next human reply (free text or a chosen option) until the
   * deadline. Resolves to an answered result or a timeout result; it does not
   * throw on timeout.
   */
  awaitReply(options: AwaitReplyOptions): Promise<ReplyResult>;
}
