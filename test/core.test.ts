import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createEmojiToolProvider } from "../src/emoji-library.js";
import { InMemoryEmojiRepository } from "./in-memory-emoji-repository.js";
import {
  GroupAgentCore,
  type GroupAgentCoreOptions,
  type AgentRunner,
  type AgentRunRequest,
  type AgentRunResult,
  type InboundMessageEvent,
} from "../src/index.js";

class RecordingRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = [];
  calls = 0;
  active = 0;
  maxActive = 0;

  constructor(
    private readonly respond: (request: AgentRunRequest, call: number) => Promise<AgentRunResult> | AgentRunResult = () => ({
      text: "收到",
    }),
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.requests.push(request);
    try {
      return await this.respond(request, this.calls);
    } finally {
      this.active -= 1;
    }
  }
}

test("non-triggering group messages become context and duplicate delivery is idempotent", async (context) => {
  const fixture = createFixture(context);
  const first = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "今晚八点打球"));
  assert.equal(first.status, "ignored");
  assert.equal(fixture.runner.calls, 0);

  const event = groupMessage("m2", "u2", "老林", "在吗？", { mentions: [{ id: "bot-1" }] });
  const result = await fixture.core.receive(event);
  assert.equal(result.status, "replied");
  assert.equal(result.triggerReason, "mention");
  assert.equal(fixture.runner.calls, 1);
  assert.deepEqual(result.actions[0]!.parts, [
    { type: "mention", memberId: "u2", displayName: "老林" },
    { type: "quote", messageId: "m2", senderId: "u2", senderName: "老林", excerpt: "在吗?" },
    { type: "text", text: "收到" },
  ]);
  assert.match(fixture.runner.requests[0]!.prompt, /今晚八点打球/);
  assert.match(fixture.runner.requests[0]!.prompt, /阿青/);
  assert.match(fixture.runner.requests[0]!.prompt, /这一轮必须作出自然回应/);
  assert.doesNotMatch(fixture.runner.requests[0]!.prompt, /或调用 skip_reply/);
  assert.match(fixture.runner.requests[0]!.systemPrompt, /群友 @、叫了你的名字\/唤醒词或引用了你的消息，则必须回应/);
  assert.doesNotMatch(fixture.runner.requests[0]!.systemPrompt, /群聊始终允许不回复/);
  assert.equal(fixture.runner.requests[0]!.tools.some((tool) => tool.name === "skip_reply"), false);

  const replay = await fixture.core.receive(event);
  assert.equal(replay.replayed, true);
  assert.equal(replay.actions[0]!.id, result.actions[0]!.id);
  assert.equal(fixture.runner.calls, 1);

  assert.equal(fixture.core.pendingOutbox().length, 1);
  fixture.core.acknowledgeOutbox([result.actions[0]!.id]);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("response gate suppresses a claimed cross-bot reply before the agent runs", async (context) => {
  const fixture = createFixture(context, new RecordingRunner(), { responseGate: () => false });
  const result = await fixture.core.receive(groupMessage("shared-1", "u1", "阿青", "小派，在吗？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "shared-reply-arbitrated");
  assert.equal(result.actions.length, 0);
  assert.equal(fixture.runner.calls, 0);
});

test("natural follow-up after the bot reply stays in the same social turn", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  await fixture.core.receive(
    groupMessage("m1", "u1", "阿青", "小派，球场在哪？", { timestamp: now, mentions: [{ id: "bot-1" }] }),
  );
  const followUp = await fixture.core.receive(groupMessage("m2", "u1", "阿青", "地铁哪个口？", { timestamp: now + 1000 }));
  assert.equal(followUp.status, "replied");
  assert.equal(followUp.triggerReason, "continuation");
  assert.equal(fixture.runner.calls, 2);
  assert.match(fixture.runner.requests[1]!.prompt, /<anti_repetition>/u);
  assert.match(fixture.runner.requests[1]!.prompt, /近期起句：.*收到/u);
  assert.match(fixture.runner.requests[1]!.prompt, /不要机械复用相同起句、结尾反问或固定段落结构/u);
});

test("a model judge keeps a multi-person topic alive after the bot has joined", async (context) => {
  const runner = new RecordingRunner((_request, call) => {
    if (call === 1) return { text: "从东门走最近" };
    return { text: "对，东门出来再走两分钟就到了" };
  });
  const judgeRunner = new RecordingRunner(() => ({
    text: '{"decision":"speak","reason":"followup","confidence":0.88}',
  }));
  const fixture = createFixture(context, runner, {
    defaultGroupActivation: "always",
    participationJudgeRunner: judgeRunner,
  });
  const now = Date.now();
  await fixture.core.receive(groupMessage("thread-1", "u1", "阿青", "小派，球场从哪边走？", {
    timestamp: now,
    mentions: [{ id: "bot-1" }],
  }));
  const continued = await fixture.core.receive(groupMessage("thread-2", "u2", "老林", "东门出来就是那条小路吧", {
    timestamp: now + 2000,
  }));
  assert.equal(continued.status, "replied");
  assert.equal(continued.triggerReason, "conversation-followup:followup:0.88");
  assert.equal(judgeRunner.calls, 1);
  assert.match(judgeRunner.requests[0]!.systemPrompt, /接话门控分类器/);
  assert.match(judgeRunner.requests[0]!.prompt, /ack_only/);
  assert.deepEqual(judgeRunner.requests[0]!.budget, { maxLlmCalls: 1, maxToolCalls: 0, timeoutMs: 20_000 });
  assert.deepEqual(judgeRunner.requests[0]!.tools, []);
  assert.equal(runner.calls, 2);
  assert.match(runner.requests[1]!.prompt, /从东门走最近/);
  assert.match(runner.requests[1]!.prompt, /老林/);
});

test("disabled auto participation blocks follow-up judging without affecting explicit mentions", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "从东门走" }));
  const judgeRunner = new RecordingRunner(() => ({
    text: '{"decision":"speak","reason":"followup","confidence":0.9}',
  }));
  const fixture = createFixture(context, runner, {
    defaultGroupActivation: "always",
    autoParticipationGate: () => false,
    participationJudgeRunner: judgeRunner,
  });
  const now = Date.now();
  const explicit = await fixture.core.receive(groupMessage("gate-1", "u1", "阿青", "小派，怎么走？", {
    timestamp: now,
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(explicit.status, "replied");
  const followUp = await fixture.core.receive(groupMessage("gate-2", "u2", "老林", "东门那条路吗", {
    timestamp: now + 1000,
  }));
  assert.equal(followUp.status, "ignored");
  assert.equal(followUp.triggerReason, "auto-participation-disabled");
  assert.equal(runner.calls, 1);
  assert.equal(judgeRunner.calls, 0);
});

test("the participation judge closes the bot turn when the group changes topic", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "东门集合" }));
  const judgeRunner = new RecordingRunner(() => ({
    text: '{"decision":"silent","reason":"topic_shift","confidence":0.93}',
  }));
  const fixture = createFixture(context, runner, {
    defaultGroupActivation: "always",
    participationJudgeRunner: judgeRunner,
  });
  const now = Date.now();
  await fixture.core.receive(groupMessage("shift-1", "u1", "阿青", "小派，在哪里集合？", {
    timestamp: now,
    mentions: [{ id: "bot-1" }],
  }));
  const shifted = await fixture.core.receive(groupMessage("shift-2", "u2", "老林", "今晚的新电影真不错", {
    timestamp: now + 2000,
  }));
  assert.equal(shifted.status, "ignored");
  assert.equal(shifted.triggerReason, "conversation-silent:topic_shift:0.93");
  assert.equal(judgeRunner.calls, 1);
  assert.equal(runner.calls, 1);
});

test("the participation judge rejects a low-confidence speak decision without calling the final model", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "东门集合" }));
  const judgeRunner = new RecordingRunner(() => ({
    text: '{"decision":"speak","reason":"followup","confidence":0.74}',
  }));
  const fixture = createFixture(context, runner, {
    defaultGroupActivation: "always",
    participationJudgeRunner: judgeRunner,
  });
  const now = Date.now();
  await fixture.core.receive(groupMessage("low-confidence-1", "u1", "阿青", "小派，在哪里集合？", {
    timestamp: now,
    mentions: [{ id: "bot-1" }],
  }));
  const result = await fixture.core.receive(groupMessage("low-confidence-2", "u2", "老林", "东门出来应该就是那条小路吧", {
    timestamp: now + 2000,
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "conversation-silent:low_confidence:0.74");
  assert.equal(judgeRunner.calls, 1);
  assert.equal(runner.calls, 1);
});

test("per-room participation intensity changes the local judge threshold", async (context) => {
  for (const [intensity, expectedStatus] of [
    ["conservative", "ignored"],
    ["standard", "ignored"],
    ["active", "replied"],
  ] as const) {
    const runner = new RecordingRunner(() => ({ text: "接上这个话题" }));
    const judgeRunner = new RecordingRunner(() => ({
      text: '{"decision":"speak","reason":"new_info","confidence":0.65}',
    }));
    const fixture = createFixture(context, runner, {
      defaultGroupActivation: "always",
      participationJudgeRunner: judgeRunner,
      participationIntensityResolver: () => intensity,
    });
    const now = Date.now();
    await fixture.core.receive(groupMessage(`${intensity}-1`, "u1", "阿青", "小派，这个功能怎么用？", {
      timestamp: now,
      mentions: [{ id: "bot-1" }],
    }));
    const result = await fixture.core.receive(groupMessage(`${intensity}-2`, "u2", "老林", "还有一个相关技巧", {
      timestamp: now + 1000,
    }));
    assert.equal(result.status, expectedStatus, intensity);
    assert.match(judgeRunner.requests[0]!.systemPrompt, new RegExp(intensity === "active" ? "积极档" : intensity === "standard" ? "标准档" : "保守档"));
  }
});

test("the participation judge fails closed when its JSON uses an invalid decision/reason pair", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "东门集合" }));
  const judgeRunner = new RecordingRunner(() => ({
    text: '{"decision":"speak","reason":"ack_only","confidence":0.99}',
  }));
  const fixture = createFixture(context, runner, {
    defaultGroupActivation: "always",
    participationJudgeRunner: judgeRunner,
  });
  const now = Date.now();
  await fixture.core.receive(groupMessage("invalid-judge-1", "u1", "阿青", "小派，在哪里集合？", {
    timestamp: now,
    mentions: [{ id: "bot-1" }],
  }));
  const result = await fixture.core.receive(groupMessage("invalid-judge-2", "u2", "老林", "好的谢谢", {
    timestamp: now + 2000,
  }));
  assert.equal(result.status, "ignored");
  assert.equal(judgeRunner.calls, 1);
  assert.equal(runner.calls, 1);
});

test("always-on mode lets the agent stay silent without emitting placeholder text", async (context) => {
  const fixture = createFixture(context, new RecordingRunner(() => ({ text: null })));
  fixture.core.setGroupActivation("g1", "always");
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "老林你明天有空吗"));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "agent-silent");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.runner.calls, 1);
});

test("always-on mode ignores ambient chatter before calling the model", async (context) => {
  const fixture = createFixture(context);
  fixture.core.setGroupActivation("g1", "always");
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "哈哈哈哈"));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "ambient-no-signal");
  assert.equal(fixture.runner.calls, 0);
});

test("night schedule blocks ambient questions but keeps explicit wake words available", async (context) => {
  const fixture = createFixture(context, new RecordingRunner(), {
    defaultGroupActivation: "always",
    socialSchedule: {
      enabled: true,
      timezoneOffsetMinutes: 480,
      activeStartMinute: 420,
      activeEndMinute: 1380,
      hotChatWindowMs: 180_000,
      hotChatMinMessages: 10,
      hotChatMinParticipants: 4,
    },
  });
  const atTwoAmShanghai = Date.UTC(2026, 6, 20, 18, 0, 0);
  const ambient = await fixture.core.receive(groupMessage("night-1", "u1", "阿青", "有人知道这是怎么回事吗？", {
    timestamp: atTwoAmShanghai,
  }));
  assert.equal(ambient.triggerReason, "quiet-hours");
  assert.equal(fixture.runner.calls, 0);

  const explicit = await fixture.core.receive(groupMessage("night-2", "u1", "阿青", "派派，帮我看看", {
    timestamp: atTwoAmShanghai + 1000,
  }));
  assert.equal(explicit.triggerReason, "wake-word");
  assert.equal(fixture.runner.calls, 1);
});

test("scheduled participation uses the durable outbox without inventing a native reply", async (context) => {
  const fixture = createFixture(context);
  await fixture.core.receive(groupMessage("seed", "u1", "阿青", "昨天聊了很多事情"));
  const result = await fixture.core.participate({
    id: "plugin:morning-brief:2026-07-21:test",
    kind: "morning-brief",
    conversationId: "g1",
    prompt: "生成晨报，昨日共 12 条消息。",
    timestamp: Date.now(),
  });
  assert.equal(result.status, "replied");
  assert.equal(result.triggerReason, "proactive-morning-brief");
  assert.equal(result.actions[0]?.replyToMessageId, "plugin:morning-brief:2026-07-21:test");
  assert.deepEqual(result.actions[0]?.parts, [{ type: "text", text: "收到" }]);
  assert.match(fixture.runner.requests.at(-1)!.prompt, /scheduled_participation/);
});

test("an administrator can stage a durable proactive emoji without adding text", async (context) => {
  const fixture = createFixture(context);
  await fixture.core.receive(groupMessage("emoji-seed", "u1", "阿青", "把这个表情发到群里"));
  const result = await fixture.core.sendProactiveMessage({
    id: "proactive:admin-message:emoji-test",
    kind: "admin-message",
    conversationId: "g1",
    prompt: "管理员选择表情包发送。",
    timestamp: Date.now(),
  }, "", [{
    type: "image",
    asset: {
      id: "emoji-asset",
      source: "local",
      locator: "aa/emoji.gif",
      mimeType: "image/gif",
      metadata: { kind: "emoji", collectedByBotId: "bot-1" },
    },
    alt: "开心庆祝",
  }]);
  assert.equal(result.status, "replied");
  assert.equal(result.triggerReason, "proactive-admin-message");
  assert.equal(result.actions[0]?.text, "");
  assert.deepEqual(result.actions[0]?.parts, [{
    type: "image",
    asset: {
      id: "emoji-asset",
      source: "local",
      locator: "aa/emoji.gif",
      mimeType: "image/gif",
      metadata: { kind: "emoji", collectedByBotId: "bot-1" },
    },
    alt: "开心庆祝",
  }]);
  assert.equal(fixture.core.pendingOutbox().length, 1);
});

test("a normalized inbound emoji starts a model-free emoji battle reply", async (context) => {
  const emojiStore = new InMemoryEmojiRepository();
  const saved = emojiStore.saveCollectedEmoji({
    botId: "bot-1",
    asset: {
      id: "battle-reply",
      source: "local",
      locator: "emoji/battle.gif",
      mimeType: "image/gif",
      sha256: "d".repeat(64),
      metadata: { kind: "emoji" },
    },
    sha256: "d".repeat(64),
    sourceConversationId: "g1",
    sourceSenderId: "u1",
    sourceMessageId: "battle-reply-source",
  }).emoji;
  emojiStore.completeEmojiAnalysis(saved.id, "一只小动物叉腰挑衅，适合斗图回应");
  const commercialRunner = new RecordingRunner();
  const localEmojiRunner = new RecordingRunner(async (request) => {
    const tool = request.tools.find((candidate) => candidate.name === "send_emoji");
    assert.ok(tool);
    const emojiId = /[a-f\d]{8}-[a-f\d-]{27,}/u.exec(tool.description)?.[0];
    assert.ok(emojiId);
    await tool.execute("local-qwen-emoji-choice", { emojiId });
    return { text: "" };
  });
  const fixture = createFixture(context, commercialRunner, {
    defaultGroupActivation: "always",
    toolProviders: [createEmojiToolProvider(emojiStore, "bot-1")],
    emojiBattleRunner: localEmojiRunner,
  });
  const result = await fixture.core.receive(groupMessage("battle-inbound", "u1", "阿青", "", {
    metadata: { interaction: "emoji", emojiBattleDescription: "一只猫叉腰挑衅,正在邀请斗图" },
    parts: [{
      type: "image",
      asset: {
        id: "incoming-battle",
        source: "platform",
        locator: "message:47",
        ownerPluginId: "test-adapter",
        metadata: { kind: "emoji" },
      },
      alt: "动态表情",
    }],
  }));
  assert.equal(result.status, "replied");
  assert.equal(result.triggerReason, "ambient-emoji-battle");
  assert.equal(commercialRunner.calls, 0);
  assert.equal(localEmojiRunner.calls, 1);
  assert.equal(result.actions[0]?.parts?.some((part) => part.type === "image"), true);
});

test("proactive summaries remain text-only even when transcript text asks for voice", async (context) => {
  const Parameters = Type.Object({ text: Type.String() });
  let speechExecutions = 0;
  const runner = new RecordingRunner((request) => {
    assert.equal(request.tools.some((tool) => tool.name === "synthesize_speech"), false);
    return { text: "这是文字总结" };
  });
  const fixture = createFixture(context, runner, {
    toolProviders: [({ stagePart }) => [{
      name: "synthesize_speech",
      label: "合成语音",
      description: "合成语音",
      parameters: Parameters,
      async execute() {
        speechExecutions += 1;
        stagePart({
          type: "voice",
          asset: { id: "blocked-voice", source: "local", locator: "blocked/voice", mimeType: "audio/wav" },
        });
        return { content: [{ type: "text", text: "语音已加入" }], details: { blocked: false } };
      },
    }]],
  });
  await fixture.core.receive(groupMessage("summary-seed", "u1", "阿青", "有人说请发语音总结"));
  const result = await fixture.core.participate({
    id: "plugin:group-summary:2026-07-25:text-only",
    kind: "group-summary",
    conversationId: "g1",
    prompt: "总结今天群聊。原始片段：请发语音总结。",
    timestamp: Date.now(),
  });
  assert.equal(speechExecutions, 0);
  assert.deepEqual(result.actions[0]?.parts, [{ type: "text", text: "这是文字总结" }]);
  assert.match(runner.requests.at(-1)!.prompt, /scheduled_participation kind="group-summary"/u);
});

test("all agent text is converted from Markdown before entering the durable outbox", async (context) => {
  const fixture = createFixture(context, new RecordingRunner(() => ({
    text: "## 回答 🎯\n\n**重点**：看这里\n- 第一项\n[来源](https://example.com)",
  })));
  const result = await fixture.core.receive(groupMessage("plain-1", "u1", "阿青", "小派，回答一下", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.actions[0]?.text, "回答 🎯\n\n重点：看这里\n• 第一项\n来源：https://example.com");
  assert.deepEqual(result.actions[0]?.parts, [
    { type: "mention", memberId: "u1", displayName: "阿青" },
    { type: "quote", messageId: "plain-1", senderId: "u1", senderName: "阿青", excerpt: "小派,回答一下" },
    {
      type: "text",
      text: "回答 🎯\n\n重点：看这里\n• 第一项\n来源：https://example.com",
    },
  ]);
});

test("a trusted plugin prompt uses the normal agent and durable reply path", async (context) => {
  const fixture = createFixture(context);
  const event = groupMessage("summary-directive", "u1", "阿青", "总结一下今天群聊");
  const result = await fixture.core.receiveWithPrompt(event, "只总结已经提供的群聊记录，不得编造。", "plugin-group-summary-request");
  assert.equal(result.status, "replied");
  assert.equal(result.triggerReason, "plugin-group-summary-request");
  assert.match(fixture.runner.requests[0]!.prompt, /trusted_plugin_instruction/);
  assert.match(fixture.runner.requests[0]!.prompt, /只总结已经提供的群聊记录/);
});

test("admin-rated participation cases adapt only ambiguous always-on decisions", async (context) => {
  const fixture = createFixture(context);
  fixture.core.setGroupActivation("g1", "always");

  const first = await fixture.core.receive(groupMessage("learn-1", "u1", "阿青", "有人知道明天几点开门吗？"));
  assert.equal(first.status, "replied");
  const firstCase = fixture.core.listParticipationCases({ review: "unrated" })[0]!;
  assert.equal(firstCase.outcome, "replied");
  fixture.core.labelParticipationCase(firstCase.eventId, "silent", "这是群友之间的问题，不要主动抢答");

  const learnedSilent = await fixture.core.receive(groupMessage("learn-2", "u2", "老林", "有人知道明天几点开门吗？"));
  assert.equal(learnedSilent.status, "ignored");
  assert.match(learnedSilent.triggerReason, /^learned-silent:/);
  assert.equal(fixture.runner.calls, 1);

  const mentioned = await fixture.core.receive(groupMessage("learn-3", "u2", "老林", "有人知道明天几点开门吗？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(mentioned.status, "replied");
  assert.equal(mentioned.triggerReason, "mention");
  assert.equal(fixture.runner.calls, 2);
});

test("a positively rated silent case can admit a similar ambient message", async (context) => {
  const fixture = createFixture(context);
  fixture.core.setGroupActivation("g1", "always");
  const first = await fixture.core.receive(groupMessage("speak-1", "u1", "阿青", "今晚服务器又崩了"));
  assert.equal(first.status, "ignored");
  fixture.core.labelParticipationCase("speak-1", "speak", "遇到服务器故障时可以主动帮忙");

  const second = await fixture.core.receive(groupMessage("speak-2", "u2", "老林", "今晚服务器又崩了"));
  assert.equal(second.status, "replied");
  assert.match(second.triggerReason, /^learned-speak:/);
  assert.equal(fixture.runner.calls, 1);
});

test("explicit group feedback is attached to the prior participation case without changing weights", async (context) => {
  const fixture = createFixture(context);
  fixture.core.setGroupActivation("g1", "always");
  await fixture.core.receive(groupMessage("feedback-1", "u1", "阿青", "这个功能应该怎么设置？"));
  await fixture.core.receive(groupMessage("feedback-2", "u1", "阿青", "小派，别插话，没问你", {
    replyTo: { messageId: "unknown-native-reply-id", senderId: "bot-1" },
  }));
  const target = fixture.core.listParticipationCases({ review: "all" }).find((item) => item.eventId === "feedback-1")!;
  assert.equal(target.implicitLabel, "silent");
  assert.match(target.implicitReason ?? "", /不应参与/);
  assert.equal(target.adminLabel, undefined);
});

test("internal model deliberation is blocked before it reaches the outbox", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "这条消息没有明确的问题需要我回答。我会用自然的方式回应。\n回复：哈哈，怎么了？",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，在吗？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "agent-silent");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("untagged Qwen routing deliberation is blocked before it reaches chat", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: `这个@是直接点名了，而且对方问的是基础问题，不是需要查证的复杂内容，当前记忆里也没有关于我的任何需要修正的信息。直接给一个带点个性但不过度的自我介绍就好，保持群聊氛围。

@🐻 我在呢～我是欧本克劳。`,
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("qwen-leak", "u1", "🐻", "小派，你是谁？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "agent-silent");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("an explicitly delimited final answer is separated from model deliberation", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "## 思考过程\n\n这是一道基础题。\n\n## 回复\n\n4",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，2+2？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "replied");
  assert.equal(result.actions[0]?.text, "4");
  assert.doesNotMatch(result.actions[0]?.text ?? "", /思考|回复/);
});

test("prompt echoes and internal tool commentary fail closed", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "小派，2+2？\n\n这不需要调用记忆工具。直接回答：4",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，2+2？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("upstream safety errors are logged as blocked output and never reach chat", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("upstream-error", "u1", "阿青", "小派，总结一下", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "agent-silent");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("a model cannot send a normalized verbatim copy of the triggering message", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "这图里线都理好了还问要不要理？" }));
  const fixture = createFixture(context, runner, { defaultGroupActivation: "always" });
  const result = await fixture.core.receive(groupMessage(
    "echo-source",
    "u1",
    "阿青",
    "这图里线都理好了，还问要不要理？",
  ));
  assert.equal(result.status, "ignored");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("textual tool wrappers are stripped down to an explicitly delimited reply", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: `<tool_use>
<!-- 无需工具调用：欢迎图片属于自然社交信号，直接参与即可 -->
</tool_use>

---

**回复：**

欢迎仪式到位啊 😂`,
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，欢迎一下", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "replied");
  assert.equal(result.actions[0]?.text, "欢迎仪式到位啊 😂");
  assert.doesNotMatch(result.actions[0]?.text ?? "", /tool_use|工具|回复/iu);
});

test("Chinese rule deliberation before a direct-answer delimiter never reaches chat", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: `这明显是个测试消息。

根据规则：
1. 这不是需要记忆的事实
2. 这不是需要查证的知识

直接自然回答：

---

我是群里这个正常聊天的成员。`,
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，你是什么模型？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "replied");
  assert.equal(result.actions[0]?.text, "我是群里这个正常聊天的成员。");
  assert.doesNotMatch(result.actions[0]?.text ?? "", /规则|测试消息|直接自然回答/u);
});

test("textual tool wrappers without a final delimiter fail closed", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "<tool_use>无需调用工具，直接参与群聊</tool_use>",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.deepEqual(result.actions, []);
});

test("empty plural tool-call wrappers fail closed before reaching the outbox", async (context) => {
  const runner = new RecordingRunner(() => ({
    text: "<tool_calls>\n</tool_calls>",
  }));
  const fixture = createFixture(context, runner);
  const result = await fixture.core.receive(groupMessage("plural-tool-calls", "u1", "阿青", "小派？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(result.status, "ignored");
  assert.equal(result.triggerReason, "agent-silent");
  assert.deepEqual(result.actions, []);
  assert.equal(fixture.core.pendingOutbox().length, 0);
});

test("same-conversation runs are serialized", async (context) => {
  const runner = new RecordingRunner(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { text: "好" };
  });
  const fixture = createFixture(context, runner);
  await Promise.all([
    fixture.core.receive(groupMessage("m1", "u1", "甲", "一", { mentions: [{ id: "bot-1" }] })),
    fixture.core.receive(groupMessage("m2", "u2", "乙", "二", { mentions: [{ id: "bot-1" }] })),
  ]);
  assert.equal(runner.calls, 2);
  assert.equal(runner.maxActive, 1);
});

test("a failed model run is durable and the same event can be retried", async (context) => {
  const runner = new RecordingRunner((_request, call) => {
    if (call === 1) throw new Error("temporary provider failure");
    return { text: "恢复了" };
  });
  const fixture = createFixture(context, runner);
  const event = groupMessage("m1", "u1", "阿青", "小派？", { mentions: [{ id: "bot-1" }] });
  await assert.rejects(fixture.core.receive(event), /temporary provider failure/);
  const retry = await fixture.core.receive(event);
  assert.equal(retry.status, "replied");
  assert.equal(retry.replayed, false);
  assert.equal(runner.calls, 2);
});

test("a failed model run releases its shared reply claim", async (context) => {
  const releases: Array<{ eventId: string; reason: string }> = [];
  const runner = new RecordingRunner(() => {
    throw new Error("HTTP 500 do_request_failed");
  });
  const fixture = createFixture(context, runner, {
    responseGate: () => true,
    responseGateRelease: (event, reason) => {
      releases.push({ eventId: event.id, reason });
    },
  });
  const event = groupMessage("release-claim", "u1", "阿青", "小派？", { mentions: [{ id: "bot-1" }] });
  await assert.rejects(fixture.core.receive(event), /do_request_failed/u);
  assert.deepEqual(releases, [{ eventId: event.id, reason: "mention" }]);
});

test("runner resolution can route each chatroom to a different model runner", async (context) => {
  const defaultRunner = new RecordingRunner(() => ({ text: "默认模型" }));
  const chatroomRunner = new RecordingRunner(() => ({ text: "群专属模型" }));
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-routing-test-"));
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: defaultRunner,
    runnerResolver: (event) => event.conversation.id === "account:room-1-group" ? chatroomRunner : defaultRunner,
    databasePath: join(directory, "agent.sqlite"),
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const special = await core.receive(groupMessage("route-special", "u1", "阿青", "小派，在吗", {
    conversation: { id: "account:room-1-group", kind: "group" },
    mentions: [{ id: "bot-1" }],
  }));
  const fallback = await core.receive(groupMessage("route-default", "u1", "阿青", "小派，在吗", {
    conversation: { id: "account:room-2-group", kind: "group" },
    mentions: [{ id: "bot-1" }],
  }));

  assert.equal(special.actions[0]!.text, "群专属模型");
  assert.equal(fallback.actions[0]!.text, "默认模型");
  assert.equal(chatroomRunner.calls, 1);
  assert.equal(defaultRunner.calls, 1);
});

test("persona soul resolution applies per chatroom without restarting the core", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "收到" }));
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-persona-test-"));
  let roomSoul = "你是本群的犀利网友。";
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    soul: "你使用默认人设。",
    soulResolver: (event) => event.conversation.id === "room-1-group" ? roomSoul : undefined,
    databasePath: join(directory, "agent.sqlite"),
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await core.receive(groupMessage("persona-1", "u1", "阿青", "在吗", {
    conversation: { id: "room-1-group", kind: "group" },
    mentions: [{ id: "bot-1" }],
  }));
  roomSoul = "你现在是冷静的复盘助手。";
  await core.receive(groupMessage("persona-2", "u1", "阿青", "继续", {
    conversation: { id: "room-1-group", kind: "group" },
    mentions: [{ id: "bot-1" }],
  }));
  await core.receive(groupMessage("persona-3", "u1", "阿青", "另一个群", {
    conversation: { id: "room-2-group", kind: "group" },
    mentions: [{ id: "bot-1" }],
  }));
  assert.match(runner.requests[0]!.systemPrompt, /犀利网友/);
  assert.match(runner.requests[1]!.systemPrompt, /冷静的复盘助手/);
  assert.match(runner.requests[2]!.systemPrompt, /默认人设/);
});

test("conversation persona identity changes wake words and stored outbound display name", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "抱抱你" }));
  const fixture = createFixture(context, runner, {
    botIdentityResolver: (event) => event.conversation.id === "room-1-group"
      ? { displayName: "魅梦", wakeWords: ["梦梦"] }
      : undefined,
  });
  const replied = await fixture.core.receive(groupMessage("identity-1", "u1", "阿青", "梦梦，在吗", {
    conversation: { id: "room-1-group", kind: "group" },
  }));
  const ignored = await fixture.core.receive(groupMessage("identity-2", "u1", "阿青", "梦梦，在吗", {
    conversation: { id: "room-2-group", kind: "group" },
  }));
  assert.equal(replied.triggerReason, "wake-word");
  assert.equal(ignored.status, "ignored");
  assert.match(runner.requests[0]!.systemPrompt, /你的名字是 魅梦/u);
  const stored = fixture.core.listConversationMessages("room-1-group", { limit: 10 });
  assert.equal(stored.find((message) => message.direction === "outbound")?.senderName, "魅梦");
});

test("persona and context reset epochs isolate provider session affinity", async (context) => {
  const runner = new RecordingRunner(() => ({ text: "收到" }));
  let personaId = "old-persona";
  const fixture = createFixture(context, runner, {
    sessionKeyResolver: () => personaId,
  });
  await fixture.core.receive(groupMessage("session-persona-1", "u1", "阿青", "小派，在吗", {
    mentions: [{ id: "bot-1" }],
  }));
  personaId = "new-persona";
  const reset = fixture.core.resetConversationContext("g1", "admin", "persona-command");
  await fixture.core.receive(groupMessage("session-persona-2", "u1", "阿青", "小派，继续", {
    mentions: [{ id: "bot-1" }],
  }));

  assert.match(runner.requests[0]!.sessionId, /scope:old-persona:epoch:0$/u);
  assert.match(runner.requests[1]!.sessionId, new RegExp(`scope:new-persona:epoch:${reset.resetAt}$`, "u"));
  assert.notEqual(runner.requests[0]!.sessionId, runner.requests[1]!.sessionId);
});

test("high-value person memory is injected without another model call", async (context) => {
  const fixture = createFixture(context);
  fixture.core.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "g1",
    kind: "preference",
    content: "阿青喜欢特斯拉，也一直关注电动车。",
    importance: 0.9,
  });
  await fixture.core.receive(groupMessage("m1", "u1", "阿青", "小派，猜猜我最近在看什么车", { mentions: [{ id: "bot-1" }] }));
  assert.match(fixture.runner.requests[0]!.prompt, /喜欢特斯拉/);
  assert.equal(fixture.runner.calls, 1);
});

test("semantic embeddings recall a related memory without shared keywords", async (context) => {
  const fixture = createFixture(context, new RecordingRunner(), {
    memoryLimit: 1,
    memoryEmbeddingProvider: {
      model: "gemini-embedding-2",
      async embed(texts, task) {
        if (task === "retrieval_query") return texts.map(() => [1, 0]);
        return texts.map((text) => text.includes("爵士乐") ? [1, 0] : [0, 1]);
      },
    },
  });
  fixture.core.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "g1",
    kind: "preference",
    content: "阿青习惯在雨夜播放低沉的爵士乐",
    importance: 0.7,
  });
  fixture.core.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "g1",
    kind: "preference",
    content: "阿青午饭喜欢吃番茄炒蛋",
    importance: 0.99,
  });
  await fixture.core.receive(groupMessage("semantic-memory", "u1", "阿青", "小派，我失眠时适合放点什么？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.match(fixture.runner.requests[0]!.prompt, /雨夜播放低沉的爵士乐/u);
  assert.doesNotMatch(fixture.runner.requests[0]!.prompt, /番茄炒蛋/u);
});

test("memory retrieval falls back to local terms when embeddings fail", async (context) => {
  const traces: string[] = [];
  const fixture = createFixture(context, new RecordingRunner(), {
    memoryLimit: 1,
    memoryEmbeddingProvider: {
      model: "gemini-embedding-2",
      async embed() {
        throw new Error("embedding unavailable");
      },
    },
    onTrace: (event) => traces.push(event.type),
  });
  fixture.core.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "g1",
    kind: "preference",
    content: "阿青最喜欢特斯拉旅行版",
    importance: 0.8,
  });
  fixture.core.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "g1",
    kind: "preference",
    content: "阿青周末喜欢去爬山",
    importance: 0.5,
  });
  await fixture.core.receive(groupMessage("embedding-fallback", "u1", "阿青", "小派，特斯拉新车怎么样？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.match(fixture.runner.requests[0]!.prompt, /特斯拉旅行版/u);
  assert.ok(traces.includes("memory.embedding.failed"));
});

test("a natural-language behavior correction is persisted into later turns", async (context) => {
  const runner = new RecordingRunner(async (request, call) => {
    if (call === 1) {
      const behavior = request.tools.find((item) => item.name === "behavior");
      if (!behavior) throw new Error("behavior tool missing");
      await behavior.execute("learn-style", {
        action: "set",
        scope: "person",
        rule: "回复简短直接，不要习惯性反问。",
      });
      return { text: "好，之后我说短点。" };
    }
    return { text: "行。" };
  });
  const fixture = createFixture(context, runner);

  await fixture.core.receive(
    groupMessage("m1", "u1", "阿青", "小派，以后回复短一点，别总反问。", {
      mentions: [{ id: "bot-1" }],
    }),
  );
  await fixture.core.receive(
    groupMessage("m2", "u1", "阿青", "小派，周末还去打球吗？", {
      mentions: [{ id: "bot-1" }],
    }),
  );

  assert.match(runner.requests[1]!.prompt, /回复简短直接[,，]不要习惯性反问/);
  assert.equal(fixture.core.listLearningAudit("g1").some((item) => item.action === "saved"), true);
});

test("recent group context is bounded by a character budget", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-budget-"));
  const runner = new RecordingRunner();
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    databasePath: join(directory, "agent.sqlite"),
    maxHistoryChars: 1000,
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await core.receive(groupMessage("m1", "u1", "阿青", `开头标记${"很长的群聊内容".repeat(300)}结尾标记`));
  await core.receive(
    groupMessage("m2", "u1", "阿青", "小派，刚才说到哪了？", { mentions: [{ id: "bot-1" }] }),
  );

  const prompt = runner.requests[0]!.prompt;
  assert.match(prompt, /开头标记/);
  assert.match(prompt, /…/);
  assert.match(prompt, /结尾标记/);
  assert.ok(prompt.length < 3000);
});

test("group generation excludes context older than the thirty-minute ceiling", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  await fixture.core.receive(groupMessage("old-topic", "u1", "阿青", "旧话题暗号：火星披萨", {
    timestamp: now,
  }));
  await fixture.core.receive(groupMessage("fresh-topic", "u2", "老林", "小派，推荐一首适合开车的歌", {
    timestamp: now + 31 * 60_000,
    mentions: [{ id: "bot-1" }],
  }));

  assert.doesNotMatch(fixture.runner.requests[0]!.prompt, /火星披萨/u);
});

test("a slow room keeps minutes-old context visible for an addressed turn", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  await fixture.core.receive(groupMessage("slow-topic", "u1", "阿青", "慢聊话题：老码头钓鱼", {
    timestamp: now,
  }));
  await fixture.core.receive(groupMessage("slow-followup", "u2", "老林", "小派，那地方值得去吗", {
    timestamp: now + 10 * 60_000,
    mentions: [{ id: "bot-1" }],
  }));

  assert.match(fixture.runner.requests[0]!.prompt, /老码头钓鱼/u);
});

test("a new group topic keeps only a small immediate message window", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  for (let index = 1; index <= 8; index += 1) {
    await fixture.core.receive(groupMessage(`short-context-${index}`, "u1", "阿青", `背景消息第${index}条`, {
      timestamp: now + index * 1_000,
    }));
  }
  await fixture.core.receive(groupMessage("short-context-question", "u2", "老林", "小派，换个话题，晚饭吃什么？", {
    timestamp: now + 9_000,
    mentions: [{ id: "bot-1" }],
  }));

  const prompt = fixture.runner.requests[0]!.prompt;
  assert.doesNotMatch(prompt, /背景消息第1条|背景消息第2条/u);
  assert.match(prompt, /背景消息第3条/u);
  assert.match(prompt, /背景消息第8条/u);
});

test("interleaved group topics retrieve lexically related earlier turns", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  const messages = [
    ["u1", "阿青", "特斯拉旅行版的续航数据值得关注"],
    ["u2", "老林", "昨晚球赛比分是三比一"],
    ["u1", "阿青", "咖啡店今天换了豆子"],
    ["u2", "老林", "球队下周还有客场"],
    ["u3", "小周", "午饭想吃面条"],
    ["u2", "老林", "新电影周五上映"],
    ["u1", "阿青", "特斯拉续航在冬天会打折"],
    ["u3", "小周", "地铁今天有点挤"],
    ["u2", "老林", "周末准备去爬山"],
    ["u3", "小周", "办公室空调太冷"],
    ["u2", "老林", "有人换了新头像"],
    ["u3", "小周", "快递已经到了"],
  ] as const;
  for (let index = 0; index < messages.length; index += 1) {
    const [senderId, senderName, text] = messages[index]!;
    await fixture.core.receive(groupMessage(`interleaved-${index}`, senderId, senderName, text, {
      timestamp: now + index * 1_000,
    }));
  }
  await fixture.core.receive(groupMessage("interleaved-question", "u1", "阿青", "小派，刚才特斯拉冬季续航那件事怎么看？", {
    timestamp: now + 13_000,
    mentions: [{ id: "bot-1" }],
  }));

  const prompt = fixture.runner.requests[0]!.prompt;
  assert.match(prompt, /特斯拉旅行版的续航数据|特斯拉续航在冬天会打折/u);
  assert.doesNotMatch(prompt, /昨晚球赛比分是三比一/u);
});

test("an explicit quoted reply follows its ancestor chain through interleaved noise", async (context) => {
  const fixture = createFixture(context);
  const now = Date.now();
  await fixture.core.receive(groupMessage("chain-root", "u1", "阿青", "根节点暗号是蓝鲸计划", { timestamp: now }));
  await fixture.core.receive(groupMessage("chain-child", "u2", "老林", "蓝鲸计划第一步先订场地", {
    timestamp: now + 1000,
    replyTo: { messageId: "chain-root", senderId: "u1" },
  }));
  await fixture.core.receive(groupMessage("chain-grandchild", "u3", "小周", "第二步再通知所有参加者", {
    timestamp: now + 2000,
    replyTo: { messageId: "chain-child", senderId: "u2" },
  }));
  for (let index = 0; index < 12; index += 1) {
    await fixture.core.receive(groupMessage(`chain-noise-${index}`, "u4", "路人", `无关的新话题 ${index}`, {
      timestamp: now + 3000 + index * 1000,
    }));
  }
  await fixture.core.receive(groupMessage("chain-question", "u1", "阿青", "小派，接着这个安排往下说", {
    timestamp: now + 16_000,
    mentions: [{ id: "bot-1" }],
    replyTo: { messageId: "chain-grandchild", senderId: "u3" },
  }));

  const prompt = fixture.runner.requests[0]!.prompt;
  assert.match(prompt, /根节点暗号是蓝鲸计划/u);
  assert.match(prompt, /第一步先订场地/u);
  assert.match(prompt, /第二步再通知所有参加者/u);
});

test("framework APIs reach Pi only through explicit named tool providers", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-tools-"));
  const runner = new RecordingRunner();
  const Parameters = Type.Object({ conversationId: Type.String() });
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    databasePath: join(directory, "agent.sqlite"),
    toolProviders: [({ event }) => {
      const tool: AgentTool<typeof Parameters, { count: number }> = {
        name: "channel_list_group_members",
        label: "查询群成员",
        description: "只读查询当前群成员",
        parameters: Parameters,
        async execute() {
          return {
            content: [{ type: "text", text: "阿青、老王" }],
            details: { count: 2 },
          };
        },
      };
      assert.equal(event.conversation.id, "g1");
      return [tool];
    }],
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await core.receive(groupMessage("tool-message", "u1", "阿青", "小派，群里都有谁？", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(runner.requests[0]!.tools.some((tool) => tool.name === "channel_list_group_members"), true);
  assert.equal(runner.requests[0]!.tools.some((tool) => tool.name === "invoke_raw_channel_api"), false);
});

test("media parts survive a process restart in the durable outbox", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-media-restart-"));
  const databasePath = join(directory, "agent.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const asset = {
    id: "asset:restart-image",
    source: "local" as const,
    locator: "aa/restart-image",
    mimeType: "image/png",
  };
  const first = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: { async run() { return { text: "图片", parts: [{ type: "image", asset }] }; } },
    databasePath,
  });
  await first.receive(groupMessage("media-restart", "u1", "阿青", "小派，发图", {
    mentions: [{ id: "bot-1" }],
  }));
  first.close();

  const second = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: new RecordingRunner(),
    databasePath,
  });
  try {
    assert.deepEqual(second.pendingOutbox()[0]!.parts, [
      { type: "mention", memberId: "u1", displayName: "阿青" },
      { type: "quote", messageId: "media-restart", senderId: "u1", senderName: "阿青", excerpt: "小派,发图" },
      { type: "text", text: "图片" },
      { type: "image", asset },
    ]);
  } finally {
    second.close();
  }
});

test("an allowlisted Agent tool can stage a durable media reply", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-stage-media-"));
  const asset = {
    id: "asset:tool-image",
    source: "local" as const,
    locator: "bb/tool-image",
    mimeType: "image/png",
  };
  const runner = new RecordingRunner(async (request) => {
    const tool = request.tools.find((candidate) => candidate.name === "generate_group_image");
    if (!tool) throw new Error("generate_group_image tool missing");
    await tool.execute("generate-image", {});
    return { text: "图做好了" };
  });
  const Parameters = Type.Object({});
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    databasePath: join(directory, "agent.sqlite"),
    toolProviders: [({ stagePart }) => {
      const tool: AgentTool<typeof Parameters, { staged: true }> = {
        name: "generate_group_image",
        label: "生成群聊图片",
        description: "生成图片并加入当前回复",
        parameters: Parameters,
        async execute() {
          stagePart({ type: "image", asset, alt: "工具生成的图片" });
          return {
            content: [{ type: "text", text: "图片已准备" }],
            details: { staged: true },
          };
        },
      };
      return [tool];
    }],
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await core.receive(groupMessage("stage-image", "u1", "阿青", "小派，画一张图", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.deepEqual(result.actions[0]!.parts, [
    { type: "mention", memberId: "u1", displayName: "阿青" },
    { type: "quote", messageId: "stage-image", senderId: "u1", senderName: "阿青", excerpt: "小派,画一张图" },
    { type: "text", text: "图做好了" },
    { type: "image", asset, alt: "工具生成的图片" },
  ]);
});

test("an explicit voice command is enforced even when the model initially returns text", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-voice-command-"));
  const voiceAsset = {
    id: "asset:voice-command",
    source: "local" as const,
    locator: "cc/voice-command",
    mimeType: "audio/wav",
  };
  let synthesizedText = "";
  const Parameters = Type.Object({ text: Type.String() });
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner: new RecordingRunner(() => ({ text: "这是按你的要求发的语音。" })),
    databasePath: join(directory, "agent.sqlite"),
    toolProviders: [({ stagePart }) => {
      const tool: AgentTool<typeof Parameters, { assetId: string }> = {
        name: "synthesize_speech",
        label: "合成语音",
        description: "合成语音",
        parameters: Parameters,
        async execute(_toolCallId, parameters) {
          synthesizedText = parameters.text;
          stagePart({ type: "voice", asset: voiceAsset, durationMs: 1_200 });
          return { content: [{ type: "text", text: "语音已加入" }], details: { assetId: voiceAsset.id } };
        },
      };
      return [tool];
    }],
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await core.receive(groupMessage("voice-command", "u1", "阿青", "小派，请用语音回复我", {
    mentions: [{ id: "bot-1" }],
  }));
  assert.equal(synthesizedText, "这是按你的要求发的语音。");
  assert.deepEqual(result.actions[0]!.parts, [
    { type: "mention", memberId: "u1", displayName: "阿青" },
    { type: "quote", messageId: "voice-command", senderId: "u1", senderName: "阿青", excerpt: "小派,请用语音回复我" },
    { type: "voice", asset: voiceAsset, durationMs: 1_200 },
  ]);
});

test("automatic participation follows an inbound group voice with a voice-only reply", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-voice-follow-"));
  const voiceAsset = {
    id: "asset:voice-follow",
    source: "local" as const,
    locator: "dd/voice-follow",
    mimeType: "audio/wav",
  };
  const Parameters = Type.Object({ text: Type.String() });
  const runner = new RecordingRunner(() => ({ text: "我也来打个招呼" }));
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派" },
    runner,
    databasePath: join(directory, "agent.sqlite"),
    defaultGroupActivation: "always",
    autoParticipationGate: () => true,
    toolProviders: [({ stagePart }) => {
      const tool: AgentTool<typeof Parameters, { assetId: string }> = {
        name: "synthesize_speech",
        label: "合成语音",
        description: "合成语音",
        parameters: Parameters,
        async execute(_toolCallId, parameters) {
          assert.equal(parameters.text, "我也来打个招呼");
          stagePart({ type: "voice", asset: voiceAsset, durationMs: 900 });
          return { content: [{ type: "text", text: "语音已加入" }], details: { assetId: voiceAsset.id } };
        },
      };
      return [tool];
    }],
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = await core.receive(groupMessage("voice-follow", "u1", "阿青", "", {
    parts: [{
      type: "voice",
      asset: { id: "voice-in", source: "platform", locator: "message:voice-follow", ownerPluginId: "test" },
      durationMs: 2_000,
    }],
  }));
  assert.equal(result.triggerReason, "ambient-voice");
  assert.deepEqual(result.actions[0]!.parts, [
    { type: "voice", asset: voiceAsset, durationMs: 900 },
  ]);
  assert.match(runner.requests[0]!.prompt, /自动接话触发的群友语音/);
});

test("automatic participation prechecks time-sensitive facts from the recent topic", async (context) => {
  let searchQuery = "";
  const runner = new RecordingRunner(() => ({ text: "我查到的消息是这样的" }));
  const fixture = createFixture(context, runner, {
    autoParticipationGate: () => true,
    knowledgeRetriever: {
      async search(request) {
        searchQuery = request.query;
        return [{
          title: "Gemini 官方更新",
          content: "官方已发布更新说明。",
          source: "https://example.test/gemini-update",
        }];
      },
    },
  });
  await fixture.core.receive(groupMessage("knowledge-context-1", "u1", "阿青", "听说 Gemini 最新版本已经发布了"));
  fixture.core.setGroupActivation("g1", "always");
  const result = await fixture.core.receive(groupMessage("knowledge-context-2", "u2", "老林", "这个消息靠谱吗？"));

  assert.equal(result.triggerReason, "ambient-question");
  assert.match(searchQuery, /Gemini 最新版本/);
  assert.match(searchQuery, /这个消息靠谱吗/);
  assert.match(runner.requests[0]!.prompt, /Gemini 官方更新/);
  assert.match(runner.requests[0]!.prompt, /example\.test\/gemini-update/);
});

function createFixture(
  context: test.TestContext,
  runner = new RecordingRunner(),
  options: Partial<GroupAgentCoreOptions> = {},
): {
  core: GroupAgentCore;
  runner: RecordingRunner;
} {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-test-"));
  const core = new GroupAgentCore({
    bot: { id: "bot-1", displayName: "小派", wakeWords: ["派派"] },
    runner,
    databasePath: join(directory, "agent.sqlite"),
    ...options,
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { core, runner };
}

function groupMessage(
  id: string,
  senderId: string,
  senderName: string,
  text: string,
  overrides: Partial<InboundMessageEvent> = {},
): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "g1", kind: "group", title: "周末去哪玩" },
    sender: { id: senderId, displayName: senderName },
    text,
    timestamp: Date.now(),
    ...overrides,
  };
}
