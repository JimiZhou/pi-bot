import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

const MAX_MCP_TEXT_CHARS = 12_000;
const MAX_MCP_IMAGES = 250;
const MAX_MCP_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MCP_STDIO_BUFFER_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME = /^image\/(?:avif|gif|jpeg|png|webp)$/iu;

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
        const content = mcpResultContent(result);
        return {
          content,
          details: {
            serverId: profile.id,
            toolName: description.name,
            isError: result.isError === true,
            imageCount: content.filter((item) => item.type === "image").length,
          },
        };
      } finally {
        await client.close().catch(() => transport.close().catch(() => undefined));
      }
    },
  } as AgentTool;
}

function mcpConnection(profile: McpServerProfile, secret?: string): {
  client: Client;
  transport: StreamableHTTPClientTransport | StdioClientTransport;
} {
  let transport: StreamableHTTPClientTransport | StdioClientTransport;
  if (profile.transport === "stdio") {
    const env = { ...getDefaultEnvironment(), ...profile.env };
    if (profile.secretEnv && secret) env[profile.secretEnv] = secret;
    transport = new StdioClientTransport({
      command: profile.command,
      args: profile.args,
      env,
      ...(profile.cwd ? { cwd: profile.cwd } : {}),
      maxBufferSize: MAX_MCP_STDIO_BUFFER_BYTES,
    });
  } else {
    const headers: Record<string, string> = { ...profile.headers };
    if (profile.authType !== "none" && secret) {
      headers[profile.authHeader] = profile.authType === "bearer" ? `Bearer ${secret}` : secret;
    }
    transport = new StreamableHTTPClientTransport(new URL(profile.url), { requestInit: { headers } });
  }
  const client = new Client({ name: "pi-bot", version: "0.2.0" }, { capabilities: {} });
  return { client, transport };
}

function mcpToolName(serverId: string, toolName: string): string {
  const clean = (value: string) => value.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 8);
  return `mcp__${clean(serverId).slice(0, 20) || "server"}__${clean(toolName).slice(0, 24) || "tool"}__${digest}`;
}

/** Convert MCP result blocks into the text/image content accepted by pi-agent-core. */
export function mcpResultContent(result: unknown): Array<TextContent | ImageContent> {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const converted: Array<TextContent | ImageContent> = [];
  let textChars = 0;
  let imageBytes = 0;
  let imageCount = 0;

  const addText = (value: string): void => {
    if (!value || textChars >= MAX_MCP_TEXT_CHARS) return;
    const remaining = MAX_MCP_TEXT_CHARS - textChars;
    const bounded = value.length <= remaining ? value : `${value.slice(0, Math.max(0, remaining - 7))}\n[截断]`;
    converted.push({ type: "text", text: bounded });
    textChars += bounded.length;
  };
  const addImage = (data: unknown, mimeType: unknown, label: string): void => {
    if (typeof data !== "string" || typeof mimeType !== "string" || !IMAGE_MIME.test(mimeType)) {
      addText(`[${label}不是受支持的图片格式]`);
      return;
    }
    const normalized = data.replace(/\s+/gu, "");
    const estimatedBytes = base64Bytes(normalized);
    if (estimatedBytes === undefined) {
      addText(`[${label}包含无效的 base64 数据]`);
      return;
    }
    if (imageCount >= MAX_MCP_IMAGES || imageBytes + estimatedBytes > MAX_MCP_IMAGE_BYTES) {
      addText(`[${label}超过 MCP 图片数量或 20 MiB 总大小限制]`);
      return;
    }
    converted.push({ type: "image", data: normalized, mimeType: mimeType.toLowerCase() });
    imageCount += 1;
    imageBytes += estimatedBytes;
  };

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      addText(block.text);
    } else if (block.type === "image") {
      addImage(block.data, block.mimeType, "MCP 图片");
    } else if (block.type === "audio") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "未知格式";
      addText(`[MCP 返回了音频 ${mime}；当前模型工具结果协议只支持文字和图片]`);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      addText(`外部资源：${block.uri}`);
    } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const resource = block.resource as Record<string, unknown>;
      const uri = typeof resource.uri === "string" ? resource.uri : "embedded-resource";
      if (typeof resource.text === "string") addText(`资源 ${uri}:\n${resource.text}`);
      else if (typeof resource.blob === "string" && typeof resource.mimeType === "string" && IMAGE_MIME.test(resource.mimeType)) {
        addImage(resource.blob, resource.mimeType, `MCP 资源 ${uri}`);
      } else addText(`MCP 资源：${uri}`);
    }
  }
  if (record.structuredContent !== undefined) addText(JSON.stringify(record.structuredContent));
  if (converted.length === 0) addText(JSON.stringify(result));
  return converted;
}

function base64Bytes(value: string): number | undefined {
  if (!value || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
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
