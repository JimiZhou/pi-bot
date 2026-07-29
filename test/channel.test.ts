import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_PLUGIN_API_VERSION,
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_SEND_IMAGE,
  CHANNEL_FEATURE_SEND_MENTION,
  ChannelRuntime,
  GroupAgentCore,
  defineChannelPlugin,
  defineChannelCapability,
  MEDIA_RESOLVE_CAPABILITY,
  provideChannelCapability,
  type AgentRunner,
  type ChannelPlugin,
  type ChannelPluginContext,
  type InboundMessageEvent,
  type OutboundMessageAction,
} from "../src/index.js";

const runner: AgentRunner = {
  async run() {
    return { text: "标准回复" };
  },
};

test("a channel plugin owns framework mapping while the runtime owns the invariant message loop", async () => {
  const core = createCore();
  let context: ChannelPluginContext | undefined;
  let stopped = false;
  const sent: OutboundMessageAction[] = [];
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "adapter-a",
    displayName: "设备 协议适配器",
    start(value) {
      context = value;
    },
    async send(action) {
      sent.push(action);
    },
    stop() {
      stopped = true;
    },
  });
  const runtime = new ChannelRuntime({ core, plugin });
  let inboundHandlerCalls = 0;
  runtime.setInboundHandlers([() => {
    inboundHandlerCalls += 1;
    return undefined;
  }]);

  try {
    assert.deepEqual(await runtime.start(), { attempted: [], delivered: [], failed: [] });
    assert.equal(context?.pluginId, "adapter-a");

    const first = await context!.ingest(directMessage("native-message-1"));
    assert.equal(first.handling.status, "replied");
    assert.equal(first.delivery.delivered.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.conversationId, "native-conversation-1");
    assert.equal(sent[0]!.replyToMessageId, "native-message-1");
    assert.equal(core.pendingOutbox().length, 0);
    assert.equal(context?.hasSeenEvent?.("native-message-1"), true);

    const replay = await context!.ingest(directMessage("native-message-1"));
    assert.equal(replay.handling.replayed, true);
    assert.deepEqual(replay.delivery.attempted, []);
    assert.equal(sent.length, 1);
    assert.equal(inboundHandlerCalls, 1);

    await runtime.stop();
    assert.equal(stopped, true);
    assert.equal(runtime.running, false);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("an unhandled pat interaction is stored silently and never reaches the model", async () => {
  let calls = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-pat", displayName: "小派" },
    runner: { async run() { calls += 1; return { text: "不该发送" }; } },
    databasePath: ":memory:",
  });
  let context: ChannelPluginContext | undefined;
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "pat-channel",
    start(value) { context = value; },
    async send() { throw new Error("should not send"); },
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin });
  try {
    await runtime.start();
    const result = await context!.ingest({
      ...directMessage("native-pat-1"),
      metadata: { interaction: "pat", interactionTargetIsBot: false },
    });
    assert.equal(result.handling.status, "ignored");
    assert.equal(result.handling.triggerReason, "plugin-pat-ignored");
    assert.equal(calls, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a passive protocol system event becomes context without calling the model", async () => {
  let calls = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-system", displayName: "小派" },
    runner: { async run() { calls += 1; return { text: "不该发送" }; } },
    databasePath: ":memory:",
  });
  let context: ChannelPluginContext | undefined;
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "system-channel",
    start(value) { context = value; },
    async send() { throw new Error("should not send"); },
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin });
  try {
    await runtime.start();
    const result = await context!.ingest({
      type: "message",
      id: "native-system-1",
      conversation: { id: "room-group", kind: "group" },
      sender: { id: "service-account", displayName: "平台系统" },
      text: "[群公告] 周六上午十点集合",
      metadata: { interaction: "system-event", passiveContext: true, systemEventKind: "group-announcement-changed" },
    });
    assert.equal(result.handling.status, "ignored");
    assert.equal(result.handling.triggerReason, "protocol-passive-context");
    assert.equal(calls, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("send failures remain pending and concurrent flushes never send the same action twice", async () => {
  const core = createCore();
  let context: ChannelPluginContext | undefined;
  let sendCalls = 0;
  let releaseRetry: (() => void) | undefined;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const errors: Array<{ message: string; phase: string; actionId?: string }> = [];
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "webhook-bot",
    start(value) {
      context = value;
    },
    async send() {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error("temporary channel failure");
      await retryGate;
    },
    stop() {},
  });
  const runtime = new ChannelRuntime({
    core,
    plugin,
    onError(error, errorContext) {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        phase: errorContext.phase,
        ...(errorContext.actionId ? { actionId: errorContext.actionId } : {}),
      });
    },
  });

  try {
    await runtime.start();
    const first = await context!.ingest(directMessage("native-message-2"));
    assert.equal(first.delivery.failed[0]?.error, "temporary channel failure");
    assert.equal(core.pendingOutbox().length, 1);
    const pendingId = core.pendingOutbox()[0]!.id;

    const flushOne = runtime.flushOutbox();
    const flushTwo = runtime.flushOutbox();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sendCalls, 2);
    releaseRetry!();
    const [one, two] = await Promise.all([flushOne, flushTwo]);

    assert.deepEqual(one.delivered, [pendingId]);
    assert.deepEqual(two.delivered, [pendingId]);
    assert.equal(sendCalls, 2);
    assert.equal(core.pendingOutbox().length, 0);
    assert.deepEqual(errors.map((entry) => entry.phase), ["send"]);
    assert.equal(errors[0]?.actionId, pendingId);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("stale social replies are retired instead of being sent after a long outage", async () => {
  const core = createCore();
  let context: ChannelPluginContext | undefined;
  let sendCalls = 0;
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "stale-outbox-channel",
    start(value) { context = value; },
    async send() {
      sendCalls += 1;
      throw new Error("offline");
    },
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin, maxOutboxAgeMs: 1 });
  try {
    await runtime.start();
    const first = await context!.ingest(directMessage("stale-message"));
    assert.equal(first.delivery.failed.length, 1);
    assert.equal(core.pendingOutbox().length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const report = await runtime.flushOutbox();
    assert.match(report.failed[0]?.error ?? "", /stale outbox action expired/);
    assert.equal(sendCalls, 1);
    assert.equal(core.pendingOutbox().length, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("the v1 contract rejects invalid plugins before any framework code starts", () => {
  assert.throws(
    () =>
      defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: " ",
        start() {},
        async send() {},
        stop() {},
      }),
    /id cannot be empty/,
  );

  assert.throws(
    () =>
      defineChannelPlugin({
        apiVersion: 2,
        id: "future-plugin",
        start() {},
        async send() {},
        stop() {},
      } as unknown as ChannelPlugin),
    /Unsupported channel plugin API version/,
  );
});

test("media and framework-specific APIs use negotiated typed capabilities", async () => {
  const prompts: string[] = [];
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run(request) {
        prompts.push(request.prompt);
        return { text: "看到了" };
      },
    },
    databasePath: ":memory:",
  });
  let context: ChannelPluginContext | undefined;
  const ListGroupMembers = defineChannelCapability<{ conversationId: string }, string[]>("channel.group.members", 1);
  const mediaBytes = new TextEncoder().encode("resolved-image");
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "media-adapter",
    features: [
      { ...CHANNEL_FEATURE_RECEIVE_IMAGE, options: { mimeTypes: ["image/jpeg", "image/png"] } },
      CHANNEL_FEATURE_SEND_IMAGE,
    ],
    capabilities: [
      provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, async ({ asset }) => ({
        asset,
        content: oneChunk(mediaBytes),
      })),
      provideChannelCapability(ListGroupMembers, async ({ conversationId }) => [`member-of-${conversationId}`]),
    ],
    start(value) {
      context = value;
    },
    async send() {},
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin });

  try {
    await runtime.start();
    assert.equal(runtime.supports(CHANNEL_FEATURE_RECEIVE_IMAGE), true);
    assert.equal(runtime.supports(MEDIA_RESOLVE_CAPABILITY), true);
    assert.equal(runtime.listFeatures().some((item) => item.id === "channel.group.members"), true);

    const asset = {
      id: "provider-media-1",
      source: "platform" as const,
      locator: "encrypted-native-media-id",
      ownerPluginId: "media-adapter",
      mimeType: "image/jpeg",
    };
    await context!.ingest({
      ...directMessage("native-image-1"),
      text: "",
      parts: [{ type: "image", asset, alt: "群友发来的菜单照片" }],
    });
    assert.match(prompts[0]!, /群友发来的菜单照片/);

    const resolved = await runtime.invoke(MEDIA_RESOLVE_CAPABILITY, { asset });
    assert.deepEqual(await collectBytes(resolved.content), mediaBytes);
    assert.deepEqual(await runtime.invoke(ListGroupMembers, { conversationId: "g1" }), ["member-of-g1"]);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a plugin cannot emit undeclared media", async () => {
  const core = createCore();
  let context: ChannelPluginContext | undefined;
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "text-only",
    start(value) {
      context = value;
    },
    async send() {},
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin });

  try {
    await runtime.start();
    await assert.rejects(
      context!.ingest({
        ...directMessage("undeclared-image"),
        text: "",
        parts: [
          {
            type: "image",
            asset: { id: "image-1", source: "platform", locator: "native-image" },
          },
        ],
      }),
      /without declaring message\.receive\.image@1/,
    );
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("outbound media is delivered only through an advertised send feature", async () => {
  const asset = {
    id: "asset:generated-image",
    source: "local" as const,
    locator: "ab/generated-image",
    mimeType: "image/png",
  };
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: {
      async run() {
        return { text: "给你看图", parts: [{ type: "image", asset, alt: "生成的示意图" }] };
      },
    },
    databasePath: ":memory:",
  });
  let context: ChannelPluginContext | undefined;
  const sent: OutboundMessageAction[] = [];
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "image-sender",
    features: [CHANNEL_FEATURE_SEND_IMAGE],
    start(value) {
      context = value;
    },
    async send(action) {
      sent.push(action);
    },
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin });

  try {
    await runtime.start();
    const result = await context!.ingest(directMessage("request-image"));
    assert.equal(result.delivery.failed.length, 0);
    assert.deepEqual(sent[0]!.parts, [
      { type: "text", text: "给你看图" },
      { type: "image", asset, alt: "生成的示意图" },
    ]);
    assert.equal(core.pendingOutbox().length, 0);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }

  const unsupportedCore = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: { async run() { return { text: null, parts: [{ type: "image", asset }] }; } },
    databasePath: ":memory:",
  });
  let unsupportedContext: ChannelPluginContext | undefined;
  let attemptedNativeSend = false;
  const unsupportedRuntime = new ChannelRuntime({
    core: unsupportedCore,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "text-only-output",
      start(value) {
        unsupportedContext = value;
      },
      async send() {
        attemptedNativeSend = true;
      },
      stop() {},
    }),
  });
  try {
    await unsupportedRuntime.start();
    const result = await unsupportedContext!.ingest(directMessage("unsupported-image"));
    assert.match(result.delivery.failed[0]!.error, /does not support message\.send\.image@1/);
    assert.equal(attemptedNativeSend, false);
    assert.equal(unsupportedCore.pendingOutbox().length, 1);
  } finally {
    if (unsupportedRuntime.running) await unsupportedRuntime.stop();
    unsupportedCore.close();
  }
});

test("same-sender group bursts persist every fragment but run the Agent once with merged signals", async () => {
  const prompts: string[] = [];
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: { async run(request) { prompts.push(request.prompt); return { text: "合并后回复" }; } },
    databasePath: ":memory:",
  });
  let channelContext: ChannelPluginContext | undefined;
  const sent: OutboundMessageAction[] = [];
  const plugin = defineChannelPlugin({
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "burst-channel",
    features: [CHANNEL_FEATURE_SEND_MENTION],
    start(value) { channelContext = value; },
    async send(action) { sent.push(action); },
    stop() {},
  });
  const runtime = new ChannelRuntime({ core, plugin, messageBurstDebounceMs: 15 });
  const handlerTexts: string[] = [];
  runtime.setInboundHandlers([(event) => { handlerTexts.push(event.text); return undefined; }]);
  try {
    await runtime.start();
    const first = channelContext!.ingest(groupMessage("burst-1", "u1", "小派", {
      mentions: [{ id: "bot-1" }],
    }));
    const second = channelContext!.ingest(groupMessage("burst-2", "u1", "帮我看看这个问题"));
    const [fragment, final] = await Promise.all([first, second]);

    assert.equal(fragment.handling.status, "ignored");
    assert.equal(fragment.handling.triggerReason, "message-burst-fragment");
    assert.equal(final.handling.status, "replied");
    assert.equal(prompts.length, 1);
    assert.deepEqual(handlerTexts, ["小派\n帮我看看这个问题"]);
    assert.equal(sent.length, 1);
    const messages = core.listConversationMessages("room-group", { limit: 10 });
    assert.deepEqual(messages.filter((message) => message.direction === "inbound").map((message) => message.id), ["burst-1", "burst-2"]);
    assert.match(prompts[0]!, /小派/u);
    assert.match(prompts[0]!, /帮我看看这个问题/u);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("explicit Bot calls use a short merge window while ambient group speech waits for completion", async () => {
  const prompts: string[] = [];
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: { async run(request) { prompts.push(request.prompt); return { text: "收到" }; } },
    databasePath: ":memory:",
    defaultGroupActivation: "always",
  });
  let channelContext: ChannelPluginContext | undefined;
  const runtime = new ChannelRuntime({
    core,
    messageBurstDebounceMs: 150,
    explicitMessageBurstDebounceMs: 10,
    messageBurstExplicitSignal: (event) => event.mentions?.some((mention) => mention.id === "bot-1") ?? false,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "layered-burst-channel",
      features: [CHANNEL_FEATURE_SEND_MENTION],
      start(value) { channelContext = value; },
      async send() {},
      stop() {},
    }),
  });
  try {
    await runtime.start();
    let explicitSettled = false;
    const explicit = channelContext!.ingest(groupMessage("explicit", "u1", "小派，在吗", {
      mentions: [{ id: "bot-1" }],
    })).then((result) => {
      explicitSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(explicitSettled, true);
    assert.equal((await explicit).handling.status, "replied");

    let ambientSettled = false;
    const first = channelContext!.ingest(groupMessage("ambient-1", "u1", "我想问一下", {
      mentions: [],
    })).then((result) => {
      ambientSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ambientSettled, false);
    const second = channelContext!.ingest(groupMessage("ambient-2", "u1", "这个方案为什么会失败？", {
      mentions: [],
    }));
    const [fragment, final] = await Promise.all([first, second]);
    assert.equal(fragment.handling.triggerReason, "message-burst-fragment");
    assert.equal(final.handling.status, "replied");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /我想问一下/u);
    assert.match(prompts[1]!, /这个方案为什么会失败/u);
  } finally {
    if (runtime.running) await runtime.stop();
    core.close();
  }
});

test("a different sender flushes the previous burst and stop flushes the remaining burst", async () => {
  let calls = 0;
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: { async run() { calls += 1; return { text: `回复 ${calls}` }; } },
    databasePath: ":memory:",
    defaultGroupActivation: "always",
  });
  let channelContext: ChannelPluginContext | undefined;
  let stopped = false;
  const runtime = new ChannelRuntime({
    core,
    messageBurstDebounceMs: 1000,
    plugin: defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: "burst-flush-channel",
      start(value) { channelContext = value; },
      async send() {},
      stop() { stopped = true; },
    }),
  });
  await runtime.start();
  const first = channelContext!.ingest(groupMessage("sender-a", "u1", "第一个问题是什么？"));
  const second = channelContext!.ingest(groupMessage("sender-b", "u2", "第二个问题是什么？"));
  await runtime.stop();
  const results = await Promise.all([first, second]);
  assert.equal(results[0]!.handling.status, "replied");
  assert.equal(results[1]!.handling.status, "replied");
  assert.equal(calls, 2);
  assert.equal(stopped, true);
  core.close();
});

function createCore(): GroupAgentCore {
  return new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    databasePath: ":memory:",
  });
}

function directMessage(id: string): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "native-conversation-1", kind: "direct" },
    sender: { id: "native-user-1", displayName: "阿青" },
    text: "你好",
    timestamp: 1_800_000_000_000,
  };
}

function groupMessage(
  id: string,
  senderId: string,
  text: string,
  extra: Partial<InboundMessageEvent> = {},
): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "room-group", kind: "group", title: "测试群" },
    sender: { id: senderId, displayName: senderId },
    text,
    timestamp: Date.now(),
    ...extra,
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function collectBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: number[] = [];
  for await (const chunk of content) chunks.push(...chunk);
  return new Uint8Array(chunks);
}
