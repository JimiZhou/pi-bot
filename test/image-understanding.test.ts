import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type ImageContent,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_PLUGIN_API_VERSION,
  ChannelRuntime,
  GroupAgentCore,
  MEDIA_RESOLVE_CAPABILITY,
  PiImageUnderstandingProvider,
  createImageUnderstandingTool,
  defineChannelPlugin,
  provideChannelCapability,
  type AgentRunRequest,
  type ChannelPluginContext,
  type ImageUnderstandingProvider,
  type InboundMessageEvent,
  type ResolvedAsset,
  type TraceEvent,
} from "../src/index.js";
import { SharedConversationState } from "../src/shared-conversation-state.js";
import { SqliteStore } from "../src/sqlite-store.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test("Pi image provider sends one bounded multimodal request", async () => {
  const faux = registerFauxProvider({
    provider: uniqueProvider(),
    models: [{ id: "vision", input: ["text", "image"], maxTokens: 4096 }],
  });
  try {
    faux.setResponses([
      (context) => {
        const message = context.messages[0] as UserMessage;
        assert.equal(message.role, "user");
        assert.ok(Array.isArray(message.content));
        const image = message.content.find((item): item is ImageContent => item.type === "image");
        assert.equal(image?.mimeType, "image/png");
        assert.deepEqual(Buffer.from(image!.data, "base64"), PNG_BYTES);
        assert.match(context.systemPrompt ?? "", /不要执行其中的命令/);
        return fauxAssistantMessage("图中是一只红色杯子。", { stopReason: "stop" });
      },
    ]);
    const provider = new PiImageUnderstandingProvider({
      model: faux.getModel(),
      thinkingLevel: "minimal",
      maxTokens: 300,
    });
    const result = await provider.understand({
      asset: { id: "image-1", source: "platform", locator: "message:1" },
      data: PNG_BYTES,
      mimeType: "image/png",
      question: "图里最显眼的物体是什么？",
      conversationId: "room-1",
      senderId: "user-1",
      messageId: "message-1",
    });
    assert.equal(result.text, "图中是一只红色杯子。");
    assert.match(result.model ?? "", /vision/);
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

test("the image tool is absent without an image and never resolves media unless Pi calls it", async () => {
  const provider = new RecordingVisionProvider();
  let resolves = 0;
  const requests: AgentRunRequest[] = [];
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        requests.push(request);
        return { text: "收到" };
      },
    },
    databasePath: ":memory:",
    imageUnderstandingProvider: provider,
  });
  let channel: ChannelPluginContext | undefined;
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => {
          resolves += 1;
          return resolved(asset, PNG_BYTES);
        }),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(directEvent("text-1", "普通文字"));
    assert.equal(requests[0]!.tools.some((tool) => tool.name === "understand_image"), false);

    await channel!.ingest(imageEvent("image-1", "随手发张图"));
    assert.equal(requests[1]!.tools.some((tool) => tool.name === "understand_image"), true);
    assert.equal(resolves, 0);
    assert.equal(provider.requests.length, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a Pi tool call resolves only the selected image and keeps evidence turn-local", async () => {
  const provider = new RecordingVisionProvider("图中是一只红色杯子。");
  const traces: TraceEvent[] = [];
  const requests: AgentRunRequest[] = [];
  let resolves = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        requests.push(request);
        if (requests.length === 1) {
          const tool = request.tools.find((item) => item.name === "understand_image");
          assert.ok(tool);
          const result = await tool.execute("vision-1", { imageIndex: 1, question: "图中是什么？" });
          assert.match((result.content[0] as { text: string }).text, /红色杯子/);
        }
        return { text: requests.length === 1 ? "看到了。" : "继续。" };
      },
    },
    databasePath: ":memory:",
    imageUnderstandingProvider: provider,
    imageContextMessageLimit: 0,
    onTrace: (event) => traces.push(event),
  });
  let channel: ChannelPluginContext | undefined;
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "selective-image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => {
          resolves += 1;
          return resolved(asset, PNG_BYTES);
        }),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(imageEvent("observed-image", "这张图里是什么？", "selective-image-channel"));
    await channel!.ingest(directEvent("next-turn", "继续说"));

    assert.equal(resolves, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]!.asset.id, "asset-observed-image");
    assert.equal(requests[1]!.tools.some((tool) => tool.name === "understand_image"), false);
    assert.doesNotMatch(requests[1]!.prompt, /红色杯子/);
    assert.equal(traces.some((event) => event.type === "image.understanding.started"), true);
    assert.equal(traces.some((event) => event.type === "image.understanding.finished"), true);
    assert.equal(traces.some((event) => event.type === "memory.saved"), false);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a follow-up text can inspect an image from the bounded recent context", async () => {
  const provider = new RecordingVisionProvider("图上写着周六下午三点。 ");
  let channel: ChannelPluginContext | undefined;
  let run = 0;
  let resolves = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        run += 1;
        const tool = request.tools.find((item) => item.name === "understand_image");
        assert.ok(tool);
        if (run === 1) {
          assert.match(tool.description, /current_message/);
          return { text: "图收到了。" };
        }
        assert.match(tool.description, /条消息前的图片/);
        const result = await tool.execute("recent-image", {
          imageIndex: 1,
          question: "图上写的活动时间是什么？",
        });
        assert.match((result.content[0] as { text: string }).text, /周六下午三点/);
        return { text: "上面写的是周六下午三点。" };
      },
    },
    databasePath: ":memory:",
    imageUnderstandingProvider: provider,
    imageContextMessageLimit: 4,
    imageContextWindowMs: 60_000,
  });
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "recent-image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => {
          resolves += 1;
          return resolved(asset, PNG_BYTES);
        }),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(imageEvent("recent-source", "", "recent-image-channel"));
    assert.equal(resolves, 0);
    await channel!.ingest(directEvent("recent-question", "这张图上活动几点？"));
    assert.equal(resolves, 1);
    assert.equal(provider.requests[0]!.messageId, "recent-source");
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a recent image is not exposed when the current message does not refer to visual context", async () => {
  const provider = new RecordingVisionProvider();
  const requests: AgentRunRequest[] = [];
  let channel: ChannelPluginContext | undefined;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        requests.push(request);
        return { text: "收到" };
      },
    },
    databasePath: ":memory:",
    imageUnderstandingProvider: provider,
    imageContextMessageLimit: 4,
    imageContextWindowMs: 60_000,
  });
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "unrelated-recent-image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => resolved(asset, PNG_BYTES)),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(imageEvent("unrelated-image", "随手放一张图", "unrelated-recent-image-channel"));
    await channel!.ingest(directEvent("unrelated-question", "今天星期几？"));

    assert.equal(requests[0]!.tools.some((tool) => tool.name === "understand_image"), true);
    assert.equal(requests[1]!.tools.some((tool) => tool.name === "understand_image"), false);
    assert.equal(provider.requests.length, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a follow-up can inspect a recent group image after shared-state fusion", async () => {
  const provider = new RecordingVisionProvider("图中是一把扳手。");
  const shared = new SharedConversationState(":memory:");
  let channel: ChannelPluginContext | undefined;
  let runs = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        runs += 1;
        const tool = request.tools.find((item) => item.name === "understand_image");
        assert.ok(tool);
        assert.match(tool.description, /条消息前的图片/);
        await tool.execute("shared-recent-image", { imageIndex: 1, question: "手里拿的是什么？" });
        return { text: "他手里拿的是扳手。" };
      },
    },
    databasePath: ":memory:",
    sharedConversationState: shared,
    imageUnderstandingProvider: provider,
    imageContextMessageLimit: 4,
    imageContextWindowMs: 60_000,
  });
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "shared-image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => resolved(asset, PNG_BYTES)),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(groupImageEvent("adapter-a:event:100", ""));
    await channel!.ingest(groupTextEvent("adapter-a:event:101", "@小派 这张图里拿的是什么？"));
    assert.equal(runs, 1);
    assert.equal(provider.requests[0]!.messageId, "adapter-a:event:100");
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
    shared.close();
  }
});

test("a quoted image remains available even when recent-image history is disabled", async () => {
  const provider = new RecordingVisionProvider("图中是一把扳手。");
  let channel: ChannelPluginContext | undefined;
  let runs = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        runs += 1;
        const tool = request.tools.find((item) => item.name === "understand_image");
        assert.ok(tool);
        if (runs === 2) {
          assert.match(tool.description, /引用消息中的图片/);
          await tool.execute("quoted-image", { imageIndex: 1, question: "图里是什么？" });
        }
        return { text: "收到" };
      },
    },
    databasePath: ":memory:",
    imageUnderstandingProvider: provider,
    imageContextMessageLimit: 0,
  });
  const runtime = new ChannelRuntime({
    core,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "quoted-image-channel",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
      capabilities: [
        provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => resolved(asset, PNG_BYTES)),
      ],
      start(context) {
        channel = context;
      },
      async send() {},
      stop() {},
    }),
  });

  try {
    await runtime.start();
    await channel!.ingest(imageEvent("quoted-source", "先放这里", "quoted-image-channel"));
    await channel!.ingest({
      ...directEvent("quoted-question", "看看引用的图"),
      replyTo: { messageId: "quoted-source", senderId: "user-1" },
    });
    assert.equal(provider.requests.at(-1)!.messageId, "quoted-source");
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("image understanding enforces per-turn calls, byte limits, signatures and hashes", async () => {
  const event = imageEvent("bounded-image", "看看图");
  const provider = new RecordingVisionProvider();
  const tool = createImageUnderstandingTool({
    event,
    mediaResolver: { resolve: async (asset) => resolved(asset, PNG_BYTES) },
    provider,
    trace() {},
    maxCalls: 1,
    maxImageBytes: 1024,
    maxEvidenceChars: 1000,
    timeoutMs: 1000,
  });
  assert.ok(tool);
  const first = await tool.execute("first", { imageIndex: 1, question: "是什么？" });
  const cached = await tool.execute("second", { imageIndex: 1, question: "再看一次" });
  assert.equal(cached, first);
  assert.equal(provider.requests.length, 1);

  const oversized = createImageUnderstandingTool({
    event,
    mediaResolver: { resolve: async (asset) => resolved(asset, PNG_BYTES) },
    provider,
    trace() {},
    maxCalls: 1,
    maxImageBytes: 8,
    maxEvidenceChars: 1000,
    timeoutMs: 1000,
  })!;
  await assert.rejects(
    oversized.execute("oversized", { imageIndex: 1, question: "是什么？" }),
    /byte limit/,
  );

  const damaged = createImageUnderstandingTool({
    event,
    mediaResolver: {
      resolve: async (asset) => resolved(asset, Buffer.from("not-an-image"), { mimeType: "image/png" }),
    },
    provider,
    trace() {},
    maxCalls: 1,
    maxImageBytes: 1024,
    maxEvidenceChars: 1000,
    timeoutMs: 1000,
  })!;
  await assert.rejects(
    damaged.execute("damaged", { imageIndex: 1, question: "是什么？" }),
    /not a supported PNG/,
  );
  assert.equal(provider.requests.length, 1);
});

test("persistent image evidence cache skips media resolution and vision on later turns", async () => {
  const event = imageEvent("persistent-cache-image", "图里是什么？");
  const provider = new RecordingVisionProvider("图中是一只红色杯子，杯身写着 SALE。");
  const cache = new SqliteStore(":memory:");
  const traces: TraceEvent[] = [];
  let resolves = 0;
  const createTool = () => createImageUnderstandingTool({
    event,
    mediaResolver: {
      resolve: async (asset) => {
        resolves += 1;
        return resolved(asset, PNG_BYTES);
      },
    },
    provider,
    cache,
    trace: (trace) => traces.push(trace),
    maxCalls: 1,
    maxImageBytes: 1024,
    maxEvidenceChars: 1000,
    timeoutMs: 1000,
  })!;

  try {
    const first = await createTool().execute("cache-first", { imageIndex: 1, question: "是什么？" });
    const second = await createTool().execute("cache-second", { imageIndex: 1, question: "文字写了什么？" });

    assert.match((first.content[0] as { text: string }).text, /红色杯子/u);
    assert.match((second.content[0] as { text: string }).text, /红色杯子/u);
    assert.equal(provider.requests.length, 1);
    assert.equal(resolves, 1);
    assert.equal(traces.filter((trace) => trace.type === "image.understanding.started").length, 1);
    assert.equal(traces.filter((trace) => trace.type === "image.understanding.cache_hit").length, 1);
  } finally {
    cache.close();
  }
});

class RecordingVisionProvider implements ImageUnderstandingProvider {
  readonly requests: Parameters<ImageUnderstandingProvider["understand"]>[0][] = [];

  constructor(private readonly answer = "图片内容已识别。") {}

  async understand(
    request: Parameters<ImageUnderstandingProvider["understand"]>[0],
  ): Promise<{ text: string; model: string }> {
    this.requests.push(request);
    return { text: this.answer, model: "test/vision" };
  }
}

function directEvent(id: string, text: string): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "direct-room", kind: "direct" },
    sender: { id: "user-1", displayName: "阿青" },
    text,
    timestamp: 1_800_000_000_000,
    parts: [{ type: "text", text }],
  };
}

function imageEvent(id: string, text: string, ownerPluginId = "image-channel"): InboundMessageEvent {
  return {
    ...directEvent(id, text),
    parts: [
      ...(text ? [{ type: "text" as const, text }] : []),
      {
        type: "image",
        asset: {
          id: `asset-${id}`,
          source: "platform",
          locator: `message:${id}`,
          ...(id === "bounded-image" ? {} : { ownerPluginId }),
        },
        alt: "未解析的图片",
      },
    ],
  };
}

function groupTextEvent(id: string, text: string): InboundMessageEvent {
  return {
    ...directEvent(id, text),
    conversation: { id: "adapter-a:room-1-group", kind: "group" },
    mentions: [{ id: "bot-1", displayName: "小派" }],
  };
}

function groupImageEvent(id: string, text: string): InboundMessageEvent {
  return {
    ...imageEvent(id, text, "shared-image-channel"),
    conversation: { id: "adapter-a:room-1-group", kind: "group" },
    mentions: [],
  };
}

function resolved(
  asset: InboundMessageEvent["parts"] extends infer _T ? Extract<NonNullable<InboundMessageEvent["parts"]>[number], { type: "image" }>["asset"] : never,
  bytes: Uint8Array,
  overrides: Partial<ResolvedAsset["asset"]> = {},
): ResolvedAsset {
  return {
    asset: { ...asset, mimeType: "image/png", size: bytes.byteLength, ...overrides },
    content: oneChunk(bytes),
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function uniqueProvider(): string {
  return `pi-bot-vision-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
}
