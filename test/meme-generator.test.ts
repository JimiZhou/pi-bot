import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPluginContext } from "../src/agent-plugin.js";
import {
  MemeGeneratorPlugin,
  parseMemeCommand,
} from "../src/plugins/meme-generator.js";
import type { AssetRef, InboundMessageEvent } from "../src/types.js";

test("meme commands preserve the key, pipe-separated texts, and JSON args", () => {
  assert.deepEqual(parseMemeCommand("/meme petpet 你好 | 世界 --args={\"circle\":true}"), {
    kind: "generate",
    key: "petpet",
    texts: ["你好", "世界"],
    args: { circle: true },
  });
  assert.deepEqual(parseMemeCommand("表情 list"), { kind: "list" });
  assert.deepEqual(parseMemeCommand("meme 菜单 2"), { kind: "list", page: 2 });
  assert.deepEqual(parseMemeCommand("meme info petpet"), { kind: "info", key: "petpet" });
  assert.deepEqual(parseMemeCommand("meme 摸摸"), { kind: "generate", key: "摸摸", texts: [], args: {} });
  assert.equal(parseMemeCommand("普通聊天"), undefined);
});

test("meme plugin posts upstream multipart fields and stores the returned image", async () => {
  const outputBytes = new TextEncoder().encode("GIF89a-fake-but-sniffable");
  const stored: AssetRef[] = [];
  let postedUrl = "";
  let postedTexts: string[] = [];
  let postedArgs = "";
  let storedMetadata: Readonly<Record<string, unknown>> | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/memes/petpet/info")) {
      return new Response(JSON.stringify({
        key: "petpet",
        keywords: ["摸摸"],
        params_type: { min_images: 0, max_images: 1, min_texts: 0, max_texts: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    postedUrl = url;
    const form = init?.body as FormData;
    postedTexts = form.getAll("texts").map(String);
    postedArgs = String(form.get("args"));
    return new Response(outputBytes, { status: 200, headers: { "content-type": "image/gif" } });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233", defaultArgs: { quality: "safe" } },
  }, pluginContext({
    assets: {
      async put(request) {
        const data = request.data instanceof Uint8Array ? request.data : new Uint8Array();
        const asset: AssetRef = {
          id: "asset:meme",
          source: "local",
          locator: "meme.gif",
        ...(request.mimeType ? { mimeType: request.mimeType } : {}),
        size: data.byteLength,
      };
        storedMetadata = request.metadata;
        stored.push(asset);
        return asset;
      },
      async resolve() { throw new Error("not used"); },
      async has() { return false; },
    },
  }), { fetch: fetchImpl });

  const action = await plugin.handleInbound(message("meme petpet 你好 | 世界 --args={\"circle\":true}"));

  assert.equal(action?.kind, "direct-reply");
  assert.equal(action?.kind === "direct-reply" ? action.reason : "", "plugin-meme-generator");
  assert.equal(action?.kind === "direct-reply" ? action.parts?.[0]?.type : "", "image");
  assert.equal(postedUrl, "http://meme.test:2233/memes/petpet/");
  assert.deepEqual(postedTexts, ["你好", "世界"]);
  assert.deepEqual(JSON.parse(postedArgs), { quality: "safe", circle: true });
  assert.equal(stored[0]?.mimeType, "image/gif");
  assert.equal(stored[0]?.size, outputBytes.byteLength);
  assert.equal(storedMetadata?.kind, "emoji");
});

test("meme plugin accepts an @bot command while using the quoted image", async () => {
  const outputBytes = new TextEncoder().encode("GIF89a-quoted-result");
  const inputBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const quotedAsset = {
    id: "asset:quoted",
    source: "platform" as const,
    locator: "quoted-image",
    mimeType: "image/png",
  };
  let postedImageBytes: Uint8Array | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const url = String(_input);
    if (url.endsWith("/memes/petpet/info")) {
      return new Response(JSON.stringify({
        key: "petpet",
        keywords: ["摸摸"],
        params_type: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const form = init?.body as FormData;
    const image = form.getAll("images")[0];
    postedImageBytes = image instanceof Blob ? new Uint8Array(await image.arrayBuffer()) : undefined;
    return new Response(outputBytes, { status: 200, headers: { "content-type": "image/gif" } });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233" },
  }, pluginContext({
    core: {
      inboundImages(eventId: string) {
        assert.equal(eventId, "quoted-event");
        return [{ messageId: eventId, senderId: "member-b", timestamp: Date.now(), part: { type: "image", asset: quotedAsset } }];
      },
    } as unknown as AgentPluginContext["core"],
    runtime: {
      async invoke() {
        return { asset: quotedAsset, content: (async function* () { yield inputBytes; })() };
      },
    } as unknown as AgentPluginContext["runtime"],
    assets: {
      async put(request) {
        return {
          id: "asset:generated",
          source: "local" as const,
          locator: "generated.gif",
          ...(request.mimeType ? { mimeType: request.mimeType } : {}),
          size: outputBytes.byteLength,
        };
      },
      async resolve() { throw new Error("not used"); },
      async has() { return false; },
    },
  }), { fetch: fetchImpl });

  const event = {
    ...message("@MemeBot\nmeme petpet"),
    mentions: [{ id: "room:bot-identity", displayName: "MemeBot" }],
    replyTo: { messageId: "quoted-event", senderId: "member-b" },
  } satisfies InboundMessageEvent;
  const action = await plugin.handleInbound(event);

  assert.equal(action?.kind, "direct-reply");
  assert.deepEqual(postedImageBytes, inputBytes);
});

test("meme command without inputs returns an upstream preview", async () => {
  let postCount = 0;
  let previewCount = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/memes/keys")) {
      return new Response(JSON.stringify(["petpet"]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/memes/petpet/info")) {
      return new Response(JSON.stringify({
        key: "petpet",
        keywords: ["摸摸"],
        params_type: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/memes/petpet/preview")) {
      previewCount += 1;
      return new Response(new TextEncoder().encode("GIF89a-preview"), { status: 200, headers: { "content-type": "image/gif" } });
    }
    postCount += 1;
    return new Response(JSON.stringify({ detail: "图片数量不符，图片数量应为 1" }), { status: 541 });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233" },
  }, pluginContext({
    assets: {
      async put() {
        return { id: "asset:generated", source: "local", locator: "generated.gif", size: 1 };
      },
      async resolve() { throw new Error("not used"); },
      async has() { return false; },
    },
  }), { fetch: fetchImpl });

  const action = await plugin.handleInbound(message("meme petpet"));

  assert.equal(action?.kind, "direct-reply");
  assert.equal(action?.kind === "direct-reply" ? action.reason : "", "plugin-meme-generator-preview");
  assert.match(action?.kind === "direct-reply" ? action.text : "", /示例/u);
  assert.match(action?.kind === "direct-reply" ? action.text : "", /摸摸/u);
  assert.equal(previewCount, 1);
  assert.equal(postCount, 0);
});

test("group meme commands do not require an @ mention and ignore stray text for zero-text memes", async () => {
  let previewCount = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/memes/keys")) {
      return new Response(JSON.stringify(["petpet"]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/memes/petpet/info")) {
      return new Response(JSON.stringify({
        key: "petpet",
        keywords: ["摸摸"],
        params_type: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    previewCount += 1;
    return new Response(new TextEncoder().encode("GIF89a-preview"), { status: 200, headers: { "content-type": "image/gif" } });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233" },
  }, pluginContext({
    assets: {
      async put() {
        return { id: "asset:generated", source: "local", locator: "generated.gif", size: 1 };
      },
      async resolve() { throw new Error("not used"); },
      async has() { return false; },
    },
  }), { fetch: fetchImpl });

  const action = await plugin.handleInbound(message("群友说一下 meme 摸摸 随手备注"));

  assert.equal(action?.kind, "direct-reply");
  assert.equal(action?.kind === "direct-reply" ? action.reason : "", "plugin-meme-generator-preview");
  assert.equal(previewCount, 1);
});

test("shared groups route meme replies to the preferred bot", async () => {
  let fetchCount = 0;
  let claimCount = 0;
  const fetchImpl = (async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233" },
  }, pluginContext({
    botId: "adapter-main",
    preferredGroupBotId: () => "backup-main",
    claim: () => {
      claimCount += 1;
      return true;
    },
  }), { fetch: fetchImpl });

  const action = await plugin.handleInbound(message("群里 meme 摸摸"));

  assert.equal(action, undefined);
  assert.equal(fetchCount, 0);
  assert.equal(claimCount, 0);
});

test("meme plugin resolves Chinese keywords to the upstream key", async () => {
  const outputBytes = new TextEncoder().encode("GIF89a-chinese-alias");
  let postedUrl = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/memes/keys")) {
      return new Response(JSON.stringify(["good_news"]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/memes/good_news/info")) {
      return new Response(JSON.stringify({
        key: "good_news",
        keywords: ["喜报"],
        params_type: { min_images: 0, max_images: 0, min_texts: 1, max_texts: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    postedUrl = url;
    assert.equal((init?.body as FormData).get("texts"), "今天发工资了");
    return new Response(outputBytes, { status: 200, headers: { "content-type": "image/gif" } });
  }) as typeof globalThis.fetch;
  const plugin = new MemeGeneratorPlugin({
    id: "meme-generator",
    type: "meme-generator",
    enabled: true,
    settings: { apiBaseUrl: "http://meme.test:2233" },
  }, pluginContext({
    assets: {
      async put(request) {
        return { id: "asset:generated", source: "local", locator: "generated.gif", size: request.data instanceof Uint8Array ? request.data.byteLength : 0 };
      },
      async resolve() { throw new Error("not used"); },
      async has() { return false; },
    },
  }), { fetch: fetchImpl });

  const action = await plugin.handleInbound(message("meme 喜报 今天发工资了"));

  assert.equal(action?.kind, "direct-reply");
  assert.equal(postedUrl, "http://meme.test:2233/memes/good_news/");
});

function pluginContext(overrides: Partial<AgentPluginContext>): AgentPluginContext {
  return {
    botId: "bot-main",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    core: {
      inboundImages: () => [],
    } as unknown as AgentPluginContext["core"],
    runtime: {} as AgentPluginContext["runtime"],
    claim: () => true,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
    ...overrides,
  };
}

function message(text: string): InboundMessageEvent {
  return {
    type: "message",
    id: "event-meme-1",
    conversation: { id: "account:room-group", kind: "group" },
    sender: { id: "member-a", displayName: "甲" },
    text,
    timestamp: Date.now(),
  };
}
