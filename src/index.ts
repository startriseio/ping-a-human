#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Channel } from "./channel.js";
import { createChannel, type CreateChannelOptions } from "./channel-factory.js";
import { askHuman, notifyHuman } from "./tools.js";
import { runSetup } from "./setup.js";

/**
 * Build the MCP server with notify_human and ask_human registered.
 *
 * The Channel is resolved lazily (per tool call) via {@link createChannel} so
 * the server still boots without configuration; a missing/invalid config
 * surfaces as a tool error result instead of crashing at startup. Tests inject
 * a stub Channel through `channelOptions.channel`.
 */
/** Read this package's version from package.json so MCP serverInfo never drifts. */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js -> ../package.json
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createServer(channelOptions: CreateChannelOptions = {}): McpServer {
  const server = new McpServer({ name: "ping-a-human", version: packageVersion() });

  const resolveChannel = (): Channel => createChannel(channelOptions);

  // 1.x registerTool: inputSchema is a ZodRawShape (plain object), NOT z.object(...).
  server.registerTool(
    "notify_human",
    {
      title: "Notify human",
      description:
        "Send a one-way, fire-and-forget message to the configured human (via Telegram) and return IMMEDIATELY. Use this ONLY to inform the human (status updates, 'task finished', 'deploy succeeded', FYIs) when you do NOT need anything back. The human's reply, if any, is NOT captured or returned. If you need a decision, approval, or any answer before continuing, DO NOT use this — use ask_human instead.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => notifyHuman(resolveChannel(), { message })
  );

  server.registerTool(
    "ask_human",
    {
      title: "Ask human",
      description:
        "Ask the configured human a question and BLOCK until they reply on their messaging app (Telegram) or a timeout elapses. Use this whenever you need a human decision, approval, confirmation, clarification, or any answer before you can continue — the human's reply is captured and returned to you. Optionally provide `choices` to render tappable buttons (the tapped value is returned). Returns the human's answer, or a clear timed-out result if they don't respond in time. If you only need to inform the human and do NOT need a response, use notify_human instead.",
      inputSchema: {
        question: z.string(),
        choices: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ question, choices, timeoutMs }) =>
      askHuman(resolveChannel(), { question, choices, timeoutMs })
  );

  return server;
}

async function main() {
  // Subcommand routing: `ping-a-human setup` runs the interactive wizard;
  // any other invocation starts the MCP server over stdio.
  if (process.argv[2] === "setup") {
    const code = await runSetup();
    process.exit(code);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics MUST go to stderr — stdout is the MCP JSON-RPC channel.
  console.error("ping-a-human MCP server running on stdio");
}

// Only auto-start when run as the entrypoint, so tests can import createServer.
// Resolve symlinks on both sides: when launched via the npm-installed bin,
// process.argv[1] is the .bin symlink while import.meta.url is the real file,
// so a naive string compare would never match and the server wouldn't start.
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
