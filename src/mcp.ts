import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerProfile } from "./config.js";
import type { AgentToolProvider } from "./types.js";

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpProbeResult {
  serverInfo?: { name: string; version: string };
  latencyMs: number;
  tools: McpToolDescription[];
}

export async function probeMcpServer(profile: McpServerProfile, secret?: string): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const { client, transport } = mcpConnection(profile, secret);
  try {
    await within(client.connect(transport as never), profile.timeoutMs, `MCP server ${profile.id} connection timed out`);
    const listed = await within(client.listTools(), profile.timeoutMs, `MCP server ${profile.id} tool discovery timed out`);
    const version = client.getServerVersion();
    return {
      ...(version ? { serverInfo: { name: version.name, version: version.version } } : {}),
      latencyMs: Date.now() - startedAt,
      tools: listed.tools.slice(0, profile.maxTools).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
    };
  } finally {
    await client.close().catch(() => transport.close().catch(() => undefined));
  }
}

export function createMcpToolProvider(
  profiles: ReadonlyArray<{ profile: McpServerProfile; secret?: string; tools: McpToolDescription[] }>,
): AgentToolProvider {
  const tools = profiles.flatMap(({ profile, secret, tools: descriptions }) =>
    descriptions.slice(0, profile.maxTools).map((description) => mcpAgentTool(profile, secret, description))).slice(0, 40);
  return () => tools;
}

function mcpAgentTool(profile: McpServerProfile, secret: string | undefined, description: McpToolDescription): AgentTool {
  return {
    name: mcpToolName(profile.id, description.name),
    label: `${profile.label} · ${description.name}`,
    description: `${description.description ?? "MCP 外部工具"}。这是外部服务；只传递当前任务必要参数，不发送整段聊天记录或隐私。`,
    parameters: description.inputSchema as never,
    async execute(_toolCallId: string, parameters: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> {
      const { client, transport } = mcpConnection(profile, secret);
      try {
        await within(client.connect(transport as never), profile.timeoutMs, `MCP server ${profile.id} connection timed out`);
        const result = await within(
          client.callTool({ name: description.name, arguments: parameters }),
          profile.timeoutMs,
          `MCP tool ${description.name} timed out`,
        );
        return {
          content: [{ type: "text", text: boundedMcpResult(result) }],
          details: { serverId: profile.id, toolName: description.name, isError: result.isError === true },
        };
      } finally {
        await client.close().catch(() => transport.close().catch(() => undefined));
      }
    },
  } as AgentTool;
}

function mcpConnection(profile: McpServerProfile, secret?: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const headers: Record<string, string> = { ...profile.headers };
  if (profile.authType !== "none" && secret) {
    headers[profile.authHeader] = profile.authType === "bearer" ? `Bearer ${secret}` : secret;
  }
  const transport = new StreamableHTTPClientTransport(new URL(profile.url), { requestInit: { headers } });
  const client = new Client({ name: "pi-bot", version: "0.2.0" }, { capabilities: {} });
  return { client, transport };
}

function mcpToolName(serverId: string, toolName: string): string {
  const clean = (value: string) => value.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 8);
  return `mcp__${clean(serverId).slice(0, 20) || "server"}__${clean(toolName).slice(0, 24) || "tool"}__${digest}`;
}

function boundedMcpResult(result: unknown): string {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const texts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "resource_link" && typeof block.uri === "string") return [`外部资源：${block.uri}`];
    if (block.type === "image" || block.type === "audio") return [`[MCP 返回了 ${block.type}，出于安全边界未直接转发媒体]`];
    return [];
  });
  const structured = record.structuredContent === undefined ? "" : JSON.stringify(record.structuredContent);
  const value = [...texts, structured].filter(Boolean).join("\n") || JSON.stringify(record);
  return value.length <= 12_000 ? value : `${value.slice(0, 12_000)}\n[结果已截断]`;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
