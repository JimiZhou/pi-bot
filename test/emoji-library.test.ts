import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LocalAssetStore } from "../src/asset-store.js";
import {
  collectInboundEmoji,
  createEmojiToolProvider,
  emojiToolRecommendation,
  retryEmojiAnalysis,
} from "../src/emoji-library.js";
import type { InboundMessageEvent, MessagePart } from "../src/types.js";
import { InMemoryEmojiRepository } from "./in-memory-emoji-repository.js";

test("normalized emoji images are deduplicated, labelled, and exposed as a send tool", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-emojis-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new InMemoryEmojiRepository();
  const assets = new LocalAssetStore({ directory });
  const bytes = Buffer.from("GIF89a-test-emoji");
  let visionCalls = 0;
  const event: InboundMessageEvent = {
    type: "message",
    id: "emoji-message-1",
    conversation: { id: "group-1", kind: "group" },
    sender: { id: "member-1", displayName: "群友" },
    text: "[动态表情]",
    metadata: { interaction: "emoji", emojiBattleDescription: "一只小猫认真点头" },
    parts: [{
      type: "image",
      asset: {
        id: "provider-emoji",
        source: "platform",
        locator: "emoji-asset",
        ownerPluginId: "test-adapter",
        metadata: { kind: "emoji" },
      },
    }],
  };
  const options = {
    botId: "bot-1",
    store,
    assets,
    mediaResolver: {
      async resolve() {
        const part = event.parts?.[0];
        assert.ok(part?.type === "image");
        return { asset: part.asset, content: one(bytes) };
      },
    },
    visionProvider: {
      async understand() {
        visionCalls += 1;
        return { text: "一只小猫认真点头，适合表示收到和赞同" };
      },
    },
    maxImageBytes: 1024,
    timeoutMs: 1000,
  };

  const first = await collectInboundEmoji(event, options);
  const duplicate = await collectInboundEmoji({ ...event, id: "emoji-message-2" }, options);
  const crossBotDuplicate = await collectInboundEmoji(
    { ...event, id: "emoji-message-3" },
    { ...options, botId: "bot-2" },
  );
  assert.equal(first?.id, duplicate?.id);
  assert.equal(first?.id, crossBotDuplicate?.id);
  assert.equal(visionCalls, 1);
  assert.equal(store.listEmojis().length, 1);
  assert.equal(first?.status, "ready");

  const staged: MessagePart[] = [];
  const tools = createEmojiToolProvider(store, "bot-1")({ event, stagePart: (part) => staged.push(part) });
  assert.deepEqual(tools.map((tool) => tool.name), ["search_emojis", "send_emoji"]);
  const sendTool = tools.find((tool) => tool.name === "send_emoji")!;
  assert.deepEqual(emojiToolRecommendation(sendTool), {
    emojiId: first!.id,
    score: 100,
    autoAllowed: true,
  });
  const result = await sendTool.execute("call-1", { emojiId: first!.id });
  assert.equal(result.terminate, true);
  assert.equal(staged[0]?.type, "image");
  assert.equal(store.getEmoji(first!.id)?.useCount, 1);
});

test("fast turns skip the complete emoji catalog scan", () => {
  class CountingEmojiRepository extends InMemoryEmojiRepository {
    listCalls = 0;

    override listEmojis(botId?: string) {
      this.listCalls += 1;
      return super.listEmojis(botId);
    }
  }

  const store = new CountingEmojiRepository();
  const tools = createEmojiToolProvider(store, "bot-fast")({
    event: {
      type: "message",
      id: "fast-text",
      conversation: { id: "direct-1", kind: "direct" },
      sender: { id: "member-1", displayName: "群友" },
      text: "你好",
    },
    stagePart: () => undefined,
    fastTurn: true,
  });

  assert.deepEqual(tools, []);
  assert.equal(store.listCalls, 0);
});

test("explicit emoji mode gates ordinary turns and caches the catalog briefly", () => {
  class CountingEmojiRepository extends InMemoryEmojiRepository {
    listCalls = 0;

    override listEmojis(botId?: string) {
      this.listCalls += 1;
      return super.listEmojis(botId);
    }
  }

  const store = new CountingEmojiRepository();
  const provider = createEmojiToolProvider(store, "bot-explicit", () => ["bot-explicit"], {
    mode: "explicit",
    cacheTtlMs: 30_000,
  });
  const baseEvent: InboundMessageEvent = {
    type: "message",
    id: "explicit-text",
    conversation: { id: "direct-1", kind: "direct" },
    sender: { id: "member-1", displayName: "群友" },
    text: "你好",
  };
  const context = { event: baseEvent, stagePart: () => undefined };

  assert.deepEqual(provider(context), []);
  assert.equal(store.listCalls, 0);

  const emojiEvent = { ...baseEvent, id: "explicit-emoji", text: "发个表情" };
  assert.deepEqual(provider({ ...context, event: emojiEvent }), []);
  assert.deepEqual(provider({ ...context, event: { ...emojiEvent, id: "explicit-emoji-2" } }), []);
  assert.equal(store.listCalls, 1);
});

test("the initial catalog stays bounded and can search the complete repository", async () => {
  const store = new InMemoryEmojiRepository();
  let targetId = "";
  for (let index = 0; index < 12; index += 1) {
    const saved = store.saveCollectedEmoji({
      botId: "bot-library",
      asset: {
        id: `asset-${index}`,
        source: "local",
        locator: `emojis/${index}.gif`,
        sha256: index.toString(16).padStart(64, "0"),
      },
      sha256: index.toString(16).padStart(64, "0"),
      sourceConversationId: "group-1",
      sourceSenderId: "member-1",
      sourceMessageId: `message-${index}`,
    }).emoji;
    store.completeEmojiAnalysis(saved.id, index === 0
      ? "火箭升空并撒花，适合庆祝重大成功"
      : `普通聊天表情 ${index}，适合日常回应`);
    if (index === 0) targetId = saved.id;
  }

  const staged: MessagePart[] = [];
  const tools = createEmojiToolProvider(store, "bot-library")({
    event: {
      type: "message",
      id: "emoji-library-search",
      conversation: { id: "group-1", kind: "group" },
      sender: { id: "member-1", displayName: "群友" },
      text: "普通聊天",
      timestamp: Date.now(),
    },
    stagePart: (part) => staged.push(part),
  });
  const send = tools.find((tool) => tool.name === "send_emoji")!;
  const search = tools.find((tool) => tool.name === "search_emojis")!;
  assert.equal((send.description.match(/[a-f\d-]{36}:/gu) ?? []).length, 8);
  assert.doesNotMatch(send.description, new RegExp(targetId));
  const result = await search.execute("search", { query: "火箭庆祝成功" });
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, new RegExp(targetId));
  await send.execute("send", { emojiId: targetId });
  assert.equal(staged[0]?.type, "image");
});

test("failed emoji analysis can recover from the durable asset later", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-emoji-retry-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new InMemoryEmojiRepository();
  const assets = new LocalAssetStore({ directory });
  const localAsset = await assets.put({
    data: Buffer.from("GIF89a-retry"),
    mimeType: "image/gif",
    metadata: { kind: "emoji" },
  });
  const saved = store.saveCollectedEmoji({
    botId: "bot-retry",
    asset: localAsset,
    sha256: localAsset.sha256!,
    sourceConversationId: "group-retry",
    sourceSenderId: "member-retry",
    sourceMessageId: "message-retry",
  }).emoji;
  store.failEmojiAnalysis(saved.id, "quota exhausted");

  const recovered = await retryEmojiAnalysis(store.getEmoji(saved.id)!, {
    store,
    assets,
    visionProvider: {
      async understand() {
        return { text: "一只小猫挥手，适合打招呼" };
      },
    },
    maxImageBytes: 1024,
    timeoutMs: 1000,
  });

  assert.equal(recovered.status, "ready");
  assert.equal(recovered.error, undefined);
  assert.match(recovered.description, /小猫挥手/u);
});

async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
