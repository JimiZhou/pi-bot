import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as XLSX from "xlsx";
import { createAgentToolsProvider } from "../src/agent-tools.js";
import { LocalAssetStore } from "../src/asset-store.js";
import { SqliteStore } from "../src/sqlite-store.js";
import type { InboundMessageEvent } from "../src/index.js";

test("agent tools recover quoted files, analyze spreadsheets, and execute bounded code", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-agent-tools-"));
  const store = new SqliteStore(":memory:");
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["姓名", "分数"], ["小明", 97]]), "成绩");
  const bytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const original = message("file-message", "[文件]", {
    parts: [{
      type: "file",
      name: "成绩.xlsx",
      asset: { id: "xlsx-1", source: "platform", locator: "native-file", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    }],
  });
  store.ingest(original);
  const followUp = message("follow-up", "分析这个表", { replyTo: { messageId: original.id } });
  const provider = createAgentToolsProvider({
    workspaceDirectory: directory,
    enableShell: true,
    fetchImpl: async () => new Response("<html><title>测试页</title><body>BM3 log body</body></html>", { headers: { "content-type": "text/html" } }),
  });
  const tools = provider({
    event: followUp,
    stagePart: () => undefined,
    store,
    mediaResolver: {
      async resolve(asset) {
        return { asset, content: chunks(bytes) };
      },
    },
  });

  assert.ok(tools.some((tool) => tool.name === "open_url"));
  assert.ok(tools.some((tool) => tool.name === "analyze_spreadsheet"));
  const spreadsheet = requiredTool(tools, "analyze_spreadsheet");
  const analyzed = await spreadsheet.execute("sheet", { attachmentIndex: 1 });
  const details = analyzed.details as { sheetNames: string[]; rows: unknown[][] };
  assert.deepEqual(details.sheetNames, ["成绩"]);
  assert.deepEqual(details.rows[1], ["小明", "97"]);

  const materialize = requiredTool(tools, "materialize_attachment");
  const saved = await materialize.execute("save", { attachmentIndex: 1 });
  assert.match(String((saved.details as { path: string }).path), /成绩\.xlsx/u);

  const runCode = requiredTool(tools, "run_code");
  const execution = await runCode.execute("code", { language: "javascript", code: "console.log(6 * 7)" });
  assert.match(String((execution.details as { stdout: string }).stdout), /42/u);
});

test("open_url follows only public redirects and strips HTML into evidence", async (context) => {
  let calls = 0;
  const store = new SqliteStore(":memory:");
  const directory = mkdtempSync(join(process.cwd(), ".pi-agent-url-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  try {
    const provider = createAgentToolsProvider({
      workspaceDirectory: directory,
      fetchImpl: async (url) => {
        calls += 1;
        if (String(url).includes("redirect")) return new Response(null, { status: 302, headers: { location: "https://example.test/page" } });
        return new Response("<html><head><title>页面</title><meta property=\"og:image\" content=\"/cover.png\"></head><script>ignore()</script><body><img src=\"/inline.png\">正文内容</body></html>", { headers: { "content-type": "text/html" } });
      },
    });
    const event = message("url", "看网页");
    const tool = requiredTool(provider({ event, stagePart: () => undefined, store }), "open_url");
    const page = await tool.execute("open", { url: "https://example.test/redirect" });
    assert.equal((page.details as { title: string }).title, "页面");
    assert.match(String((page.details as { text: string }).text), /正文内容/u);
    assert.deepEqual((page.details as { imageUrls: string[] }).imageUrls, [
      "https://example.test/cover.png",
      "https://example.test/inline.png",
    ]);
    assert.equal(calls, 2);
    await assert.rejects(() => tool.execute("private", { url: "http://127.0.0.1:8787/healthz" }), /内网|本机/u);
  } finally {
    store.close();
  }
});

test("download_image stages a public image for the current reply", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-agent-image-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = new LocalAssetStore({ directory });
  const staged: Array<{ type: string; asset?: { id: string } }> = [];
  const provider = createAgentToolsProvider({
    workspaceDirectory: directory,
    assets,
    sendImage: true,
    fetchImpl: async () => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
  });
  const tools = provider({
    event: message("download", "发张参考图"),
    stagePart: (part) => staged.push(part as { type: string; asset?: { id: string } }),
  });
  const tool = requiredTool(tools, "download_image");
  const result = await tool.execute("download-image", { url: "https://images.example.test/reference.png", alt: "参考图" });
  assert.equal(result.terminate, true);
  assert.equal(staged[0]?.type, "image");
  assert.ok(staged[0]?.asset?.id);
  const resolved = await assets.resolve(staged[0]!.asset as never);
  assert.deepEqual(await collect(resolved.content), PNG_BYTES);
});

function message(id: string, text: string, extra: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "room-agent-tools", kind: "group" },
    sender: { id: "member-1", displayName: "群友" },
    text,
    ...extra,
  };
}

function requiredTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
