import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServerProfile } from "../src/admin/config.js";
import type { McpServerProfile } from "../src/config.js";
import { createMcpToolProvider, mcpResultContent, probeMcpServer } from "../src/mcp.js";

const PNG = Buffer.from("fake-png-bytes");

test("legacy MCP profiles remain HTTP profiles", () => {
  const profile = parseMcpServerProfile({
    id: "legacy",
    label: "Legacy HTTP",
    url: "https://mcp.example.test/mcp",
    authType: "none",
    authHeader: "Authorization",
    headers: {},
    timeoutMs: 15_000,
    maxTools: 20,
    enabled: true,
  });

  assert.equal(profile.transport, "http");
  assert.equal(profile.url, "https://mcp.example.test/mcp");
  assert.equal(profile.command, "");
  assert.deepEqual(profile.args, []);
  assert.deepEqual(profile.env, {});
});

test("stdio MCP profiles validate commands without a shell", () => {
  const profile = parseMcpServerProfile({
    id: "local",
    label: "Local stdio",
    transport: "stdio",
    command: "uvx",
    args: ["--from", "example-package", "example-server"],
    env: { LOG_LEVEL: "warn" },
    secretEnv: "EXAMPLE_API_KEY",
    timeoutMs: 600_000,
    maxTools: 10,
    enabled: true,
  });

  assert.equal(profile.transport, "stdio");
  assert.equal(profile.url, "");
  assert.equal(profile.command, "uvx");
  assert.deepEqual(profile.args, ["--from", "example-package", "example-server"]);
  assert.deepEqual(profile.env, { LOG_LEVEL: "warn" });
  assert.equal(profile.secretEnv, "EXAMPLE_API_KEY");
  assert.throws(() => parseMcpServerProfile({ ...profile, command: "node\nmalicious" }), /control characters/u);
});

test("MCP result conversion preserves image blocks and embedded image resources", () => {
  const encoded = PNG.toString("base64");
  const content = mcpResultContent({
    content: [
      { type: "text", text: "frame one" },
      { type: "image", data: encoded, mimeType: "image/png" },
      { type: "resource", resource: { uri: "memory://frame-two", blob: encoded, mimeType: "image/jpeg" } },
      { type: "audio", data: Buffer.from("wav").toString("base64"), mimeType: "audio/wav" },
    ],
    structuredContent: { frames: 2 },
  });

  assert.deepEqual(content.filter((item) => item.type === "image"), [
    { type: "image", data: encoded, mimeType: "image/png" },
    { type: "image", data: encoded, mimeType: "image/jpeg" },
  ]);
  const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.match(text, /frame one/u);
  assert.match(text, /当前模型工具结果协议只支持文字和图片/u);
  assert.match(text, /"frames":2/u);
});

test("stdio MCP transport probes and calls a media-returning tool", async () => {
  const serverSource = `
    import { Server } from "@modelcontextprotocol/sdk/server/index.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
    const server = new Server({ name: "stdio-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: process.env.MCP_TEST_SECRET === "secret-value" ? "read_image" : "missing_secret",
      description: "Return one image",
      inputSchema: { type: "object", properties: {} }
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [
      { type: "text", text: "fixture image" },
      { type: "image", data: "${PNG.toString("base64")}", mimeType: "image/png" }
    ] }));
    await server.connect(new StdioServerTransport());
  `;
  const profile: McpServerProfile = {
    id: "stdio-fixture",
    label: "stdio fixture",
    transport: "stdio",
    url: "",
    command: process.execPath,
    args: ["--input-type=module", "--eval", serverSource],
    env: {},
    secretEnv: "MCP_TEST_SECRET",
    authType: "none",
    authHeader: "Authorization",
    headers: {},
    timeoutMs: 10_000,
    maxTools: 5,
    enabled: true,
  };

  const probe = await probeMcpServer(profile, "secret-value");
  assert.equal(probe.serverInfo?.name, "stdio-fixture");
  assert.deepEqual(probe.tools.map((tool) => tool.name), ["read_image"]);

  const provider = createMcpToolProvider([{ profile, secret: "secret-value", tools: probe.tools }]);
  const tools = provider({
    event: {
      type: "message",
      id: "event-1",
      conversation: { id: "room-1", kind: "group" },
      sender: { id: "member-1", displayName: "Member" },
      text: "read it",
    },
    stagePart: () => undefined,
  });
  const result = await tools[0]!.execute("call-1", {});
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[1]?.type, "image");
  assert.deepEqual(Buffer.from(result.content[1]!.type === "image" ? result.content[1].data : "", "base64"), PNG);
});
