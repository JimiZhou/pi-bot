import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpKnowledgeRetriever } from "../src/knowledge-retriever.js";
import type { KnowledgeProviderProfile } from "../src/config.js";

test("SearXNG, Brave and Tavily provide bounded source-labelled knowledge", async (context) => {
  const requests: Array<{ path: string; token?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url ?? "",
      ...(typeof request.headers["x-subscription-token"] === "string"
        ? { token: request.headers["x-subscription-token"] }
        : {}),
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/searx/search")) {
      response.end(JSON.stringify({
        results: [
          { title: "SearX 结果", content: "<b>最新</b> 信息", url: "https://example.com/searx" },
          { title: "缺少正文", content: "", url: "https://example.com/empty" },
        ],
      }));
      return;
    }
    if (request.url?.startsWith("/res/v1/web/search")) {
      response.end(JSON.stringify({ web: { results: [
        { title: "Brave 结果", description: "精确资料", url: "https://example.com/brave" },
      ] } }));
      return;
    }
    response.end(JSON.stringify({ results: [
      { title: "Tavily 结果", content: "时效资料", url: "https://example.com/tavily" },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  const base = {
    id: "search",
    label: "Search",
    timeoutMs: 3000,
    maxResults: 3,
    enabled: true,
  } satisfies Omit<KnowledgeProviderProfile, "kind" | "baseUrl">;
  const request = { query: "今天有什么新闻", conversationId: "g1", senderId: "u1", limit: 2 };

  const searx = await new HttpKnowledgeRetriever({ ...base, kind: "searxng", baseUrl: `${origin}/searx/` }).search(request);
  assert.deepEqual(searx, [{ title: "SearX 结果", content: "最新 信息", source: "https://example.com/searx" }]);

  const brave = await new HttpKnowledgeRetriever(
    { ...base, id: "brave", kind: "brave", baseUrl: origin },
    "brave-secret",
  ).search(request);
  assert.equal(brave[0]?.source, "https://example.com/brave");
  assert.equal(requests.find((item) => item.path.startsWith("/res/v1/web/search"))?.token, "brave-secret");

  const tavily = await new HttpKnowledgeRetriever(
    { ...base, id: "tavily", kind: "tavily", baseUrl: `${origin}/search` },
    "tavily-secret",
  ).search(request);
  assert.equal(tavily[0]?.title, "Tavily 结果");
  const tavilyBody = JSON.parse(requests.find((item) => item.path === "/search")?.body ?? "{}") as Record<string, unknown>;
  assert.equal(tavilyBody.api_key, "tavily-secret");
  assert.equal(tavilyBody.max_results, 2);
});
