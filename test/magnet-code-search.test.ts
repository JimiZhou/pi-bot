import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPluginContext } from "../src/agent-plugin.js";
import {
  MagnetCodeSearchPlugin,
  parseCatalogCode,
  searchMagnets,
} from "../src/plugins/magnet-code-search.js";
import type { InboundMessageEvent } from "../src/types.js";

test("catalog-code recognition requires a whole English-number message", () => {
  assert.equal(parseCatalogCode(" abcd-1234 "), "ABCD-1234");
  assert.equal(parseCatalogCode("ＡＢＣＤ－１２３４"), "ABCD-1234");
  assert.equal(parseCatalogCode("帮我找 ABCD-1234"), undefined);
  assert.equal(parseCatalogCode("A-12"), undefined);
  assert.equal(parseCatalogCode("ABCD_1234"), undefined);
});

test("search follows only exact candidates and returns bounded canonical magnets", async () => {
  const requested: string[] = [];
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/search") {
      return htmlResponse(`
        <ul class="list">
          <li class="item"><div class="result-title"><b>ABCD-1234</b></div><a class="link" href="/magnet/exact"></a></li>
          <li class="item"><div class="result-title">unrelated</div><a class="link" href="/magnet/wrong"></a></li>
          <li class="item"><div class="filename">ABCD-1234.mp4</div><a class="link" href="/magnet/second"></a></li>
        </ul>
      `);
    }
    if (url.pathname === "/magnet/exact") {
      return htmlResponse(`<input id="input-magnet" value="magnet:?xt=urn:btih:${hash}&amp;amp;dn=ABCD-1234">`);
    }
    if (url.pathname === "/magnet/second") {
      return htmlResponse(`<input id="input-magnet" value="magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff">`);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof globalThis.fetch;

  const magnets = await searchMagnets("ABCD-1234", { timeoutMs: 2_000, maxResults: 1 }, fetchImpl);

  assert.deepEqual(magnets, [`magnet:?xt=urn:btih:${hash}`]);
  assert.deepEqual(requested, ["/search?q=ABCD-1234", "/magnet/exact"]);
});

test("plugin ignores non-group and non-code messages, then replies without invoking a model", async () => {
  const hash = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  let claims = 0;
  const plugin = new MagnetCodeSearchPlugin({
    id: "magnet-code-search",
    type: "magnet-code-search",
    enabled: true,
    settings: { timeoutSeconds: 8, maxResults: 1 },
  }, pluginContext(() => {
    claims += 1;
    return true;
  }), {
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return url.pathname === "/search"
        ? htmlResponse(`<li class="item"><div>ABCD-1234</div><a class="link" href="/magnet/one"></a></li>`)
        : htmlResponse(`<input id="input-magnet" value="magnet:?xt=urn:btih:${hash}">`);
    }) as typeof globalThis.fetch,
  });

  assert.equal(await plugin.handleInbound(message("普通聊天")), undefined);
  assert.equal(await plugin.handleInbound(message("ABCD-1234", { conversation: { id: "dm", kind: "direct" } })), undefined);
  const action = await plugin.handleInbound(message("abcd-1234"));
  assert.deepEqual(action, {
    kind: "direct-reply",
    text: `ABCD-1234 查询结果（1 条）：\nmagnet:?xt=urn:btih:${hash}`,
    parts: [
      { type: "quote", messageId: "event-abcd-1234", senderId: "member-a" },
      { type: "text", text: `ABCD-1234 查询结果（1 条）：\nmagnet:?xt=urn:btih:${hash}` },
    ],
    reason: "plugin-magnet-code-search",
  });
  assert.equal(claims, 1);
});

test("plugin quotes the original group message when an exact result is not found", async () => {
  const plugin = new MagnetCodeSearchPlugin({
    id: "magnet-code-search",
    type: "magnet-code-search",
    enabled: true,
    settings: { timeoutSeconds: 8, maxResults: 1 },
  }, pluginContext(() => true), {
    fetch: (async () => htmlResponse(`
      <li class="item"><div>OTHER-999</div><a class="link" href="/magnet/wrong"></a></li>
    `)) as typeof globalThis.fetch,
  });

  const action = await plugin.handleInbound(message("ABCD-1234"));

  assert.deepEqual(action, {
    kind: "direct-reply",
    text: "未找到 ABCD-1234 的精确磁力链接。",
    parts: [
      { type: "quote", messageId: "event-ABCD-1234", senderId: "member-a" },
      { type: "text", text: "未找到 ABCD-1234 的精确磁力链接。" },
    ],
    reason: "plugin-magnet-code-search",
  });
});

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function pluginContext(claim: AgentPluginContext["claim"]): AgentPluginContext {
  return {
    botId: "bot-main",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    core: {} as AgentPluginContext["core"],
    runtime: {} as AgentPluginContext["runtime"],
    claim,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
  };
}

function message(text: string, overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    type: "message",
    id: `event-${text}`,
    conversation: { id: "account:room-group", kind: "group" },
    sender: { id: "member-a", displayName: "甲" },
    text,
    timestamp: Date.now(),
    ...overrides,
  };
}
