import type { Channel } from "./channel.js";

/**
 * Shape of an MCP tool result we return. Mirrors the structure the MCP SDK
 * expects from a registerTool handler ({ content: [...] }), kept local so these
 * handlers are pure and unit-testable without the SDK.
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) };
}

/**
 * notify_human: fire-and-forget. Deliver a message to the human channel and
 * return immediately without awaiting any reply (R001).
 */
export async function notifyHuman(
  channel: Channel,
  args: { message: string }
): Promise<ToolResult> {
  try {
    const ref = await channel.send(args.message);
    return text(`Message delivered to human (ref: ${ref.id}).`);
  } catch (err) {
    return text(`Failed to notify human: ${errMessage(err)}`, true);
  }
}

export type AskHumanArgs = {
  question: string;
  choices?: string[];
  /** Reply deadline in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
};

const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * ask_human: deliver a question (optionally with tappable choices), block until
 * the human replies or the deadline elapses, then return the answer + who
 * answered (R002), or a clear timed-out result (R002). Choices render as inline
 * buttons and the tapped value is returned (R003).
 */
export async function askHuman(
  channel: Channel,
  args: AskHumanArgs
): Promise<ToolResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  let ref;
  try {
    ref = await channel.send(args.question, { choices: args.choices });
  } catch (err) {
    return text(`Failed to ask human: ${errMessage(err)}`, true);
  }

  let reply;
  try {
    reply = await channel.awaitReply({ timeoutMs, sinceRef: ref });
  } catch (err) {
    return text(`Failed while awaiting human reply: ${errMessage(err)}`, true);
  }

  if (reply.status === "timeout") {
    return text(
      `Timed out after ${timeoutMs}ms waiting for the human to reply. No answer was received.`
    );
  }

  const who = reply.respondent.name
    ? `${reply.respondent.name} (${reply.respondent.id})`
    : reply.respondent.id;
  return text(`Human (${who}) answered: ${reply.answer}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
