import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPluginRegistry,
  GroupEventNotifyPlugin,
  GroupSummaryPlugin,
  PatReplyPlugin,
  PersonaCommandPlugin,
  SuxunMorningNewsSource,
  isGroupSummaryRequest,
  morningBriefPluginFactory,
} from "../src/index.js";

test("morning news source is bounded and keeps only source-labelled text", async () => {
  const source = new SuxunMorningNewsSource({
    url: "https://news.example.test/daily",
    fetch: async () => new Response(JSON.stringify({
      code: 200,
      date: "2026-07-21",
      news: ["  第一条新闻  ", "第二条新闻"],
      weiyu: " 今日一句 ",
      image: "https://untrusted.example/image.png",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  const result = await source.fetch();
  assert.deepEqual(result, {
    date: "2026-07-21",
    headlines: ["第一条新闻", "第二条新闻"],
    dailyWords: "今日一句",
    source: "https://news.example.test",
  });
  assert.equal("image" in result, false);
});

test("persona commands require an explicit mention and switch only the current group", () => {
  let selected: string | null = null;
  const profiles = [
    { id: "sharp", label: "犀利网友", prompt: "简短犀利", enabled: true },
    { id: "quiet", label: "安静模式", prompt: "保持克制", enabled: true },
  ];
  const plugin = new PersonaCommandPlugin({
    id: "persona-command",
    type: "persona-command",
    enabled: true,
    settings: {},
  }, {
    botId: "bot-config",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    personas: {
      list: () => profiles,
      current: () => profiles.find((item) => item.id === selected),
      set: (_conversationId: string, id: string | null) => {
        selected = id;
        return profiles.find((item) => item.id === id);
      },
    },
    management: {
      isManager: () => true,
      listManagerIds: () => ["member-1"],
      resetContext: (conversationId: string, actorId: string, sourceEventId: string) => ({
        conversationId,
        afterSequence: 0,
        afterTimestamp: 0,
        resetBy: actorId,
        sourceEventId,
        resetAt: Date.now(),
      }),
      contextReset: () => undefined,
      sessionStatuses: () => [{
        botId: "bot-config",
        displayName: "测试机器人",
        personaProfileId: selected,
        sessionId: `session:${selected ?? "default"}`,
        sessionScope: selected ?? "default",
        contextEpoch: 1,
      }],
      historyLimit: 50,
      maxHistoryChars: 12_000,
    },
    log: () => undefined,
  } as never);
  const base = {
    type: "message",
    id: "persona-1",
    conversation: { id: "room-group", kind: "group" },
    sender: { id: "member-1", displayName: "阿青" },
    text: "切换人设 犀利网友",
  } as const;
  assert.equal(plugin.handleInbound(base), undefined);
  assert.deepEqual(plugin.handleInbound({ ...base, mentions: [{ id: "bot-identity" }] }), {
    kind: "direct-reply",
    reason: "plugin-persona-switched",
    text: "本群已切换为“犀利网友”，并重置短期对话上下文，新人设立即生效。\n测试机器人 新 Session：session:sharp",
  });
  assert.equal(selected, "sharp");
});

test("agent feature plugin registry rejects duplicate and unknown plugin types", () => {
  const registry = new AgentPluginRegistry().register(morningBriefPluginFactory);
  assert.throws(() => registry.register(morningBriefPluginFactory), /Duplicate/);
  assert.throws(
    () => registry.create(
      { id: "unknown", type: "unknown", enabled: true, settings: {} },
      {} as never,
    ),
    /Unknown agent plugin type/,
  );
});

test("pat reply plugin substitutes the sender name and respects per-chat enablement", () => {
  let enabled = true;
  const plugin = new PatReplyPlugin({
    id: "pat-reply",
    type: "pat-reply",
    enabled: true,
    settings: { replies: ["{昵称}，别拍啦"], groupOnly: true },
  }, {
    botId: "bot-config",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    isEnabledForConversation: () => enabled,
    log: () => undefined,
  } as never);
  const event = {
    type: "message",
    id: "pat-1",
    conversation: { id: "room-group", kind: "group" },
    sender: { id: "member-1", displayName: "阿青" },
    text: "阿青拍了拍机器人",
    metadata: { interaction: "pat", interactionTargetId: "bot-identity" },
  } as const;
  assert.deepEqual(plugin.handleInbound(event), {
    kind: "direct-reply",
    text: "阿青，别拍啦",
    reason: "plugin-pat-reply",
  });
  enabled = false;
  assert.equal(plugin.handleInbound(event), undefined);
});

test("group event plugin welcomes joins and reports exits without using an agent prompt", () => {
  const plugin = new GroupEventNotifyPlugin({
    id: "group-event-notify",
    type: "group-event-notify",
    enabled: true,
    settings: {},
  }, {
    isEnabledForConversation: () => true,
    log: () => undefined,
  } as never);
  const base = {
    type: "message",
    id: "system-event-1",
    conversation: { id: "room-group", kind: "group" },
    sender: { id: "service-account", displayName: "平台系统" },
    text: "[系统事件] 小新加入了群聊",
    metadata: {
      interaction: "system-event",
      systemEventKind: "group-member-joined",
      systemEventMemberNames: ["小新", "阿青"],
      passiveContext: true,
    },
  } as const;
  assert.deepEqual(plugin.handleInbound(base), {
    kind: "direct-reply",
    text: "欢迎小新、阿青入群",
    reason: "plugin-group-event-notify",
  });
  assert.deepEqual(plugin.handleInbound({
    ...base,
    id: "system-event-2",
    metadata: { ...base.metadata, systemEventKind: "group-member-left" },
  }), {
    kind: "direct-reply",
    text: "小新、阿青退出了群聊",
    reason: "plugin-group-event-notify",
  });
});

test("group summary plugin recognizes explicit group recap requests and builds a bounded agent directive", () => {
  assert.equal(isGroupSummaryRequest("机器人，帮忙总结一下今天群聊吧"), true);
  assert.equal(isGroupSummaryRequest("刚才大家都聊了什么？"), true);
  assert.equal(isGroupSummaryRequest("总结一下这个网页"), false);
  const plugin = new GroupSummaryPlugin({
    id: "group-summary",
    type: "group-summary",
    enabled: true,
    settings: { scheduledEnabled: true, onDemandEnabled: true, minute: 1200, maxTranscriptChars: 1000 },
  }, {
    timezoneOffsetMinutes: 480,
    isEnabledForConversation: () => true,
    claim: () => true,
    core: {
      getGroupActivityDigest: () => ({
        conversationId: "room-group",
        inboundMessages: 2,
        activeMembers: 2,
        lastMessageAt: Date.now(),
        ranking: [
          { senderId: "u1", senderName: "阿青", messages: 1 },
          { senderId: "u2", senderName: "老林", messages: 1 },
        ],
        messages: [
          { id: "m1", conversationId: "room-group", direction: "inbound", senderId: "u1", senderName: "阿青", text: "晚上吃火锅", timestamp: Date.now() },
          { id: "m2", conversationId: "room-group", direction: "inbound", senderId: "u2", senderName: "老林", text: "我来订位", timestamp: Date.now() },
        ],
      }),
    },
    log: () => undefined,
  } as never);
  const action = plugin.handleInbound({
    type: "message",
    id: "summary-1",
    conversation: { id: "room-group", kind: "group" },
    sender: { id: "u1", displayName: "阿青" },
    text: "总结一下今天群聊",
    timestamp: Date.now(),
  });
  assert.equal(action?.kind, "agent-prompt");
  assert.match(action?.kind === "agent-prompt" ? action.prompt : "", /晚上吃火锅/);
  assert.match(action?.kind === "agent-prompt" ? action.prompt : "", /我来订位/);
  assert.match(action?.kind === "agent-prompt" ? action.prompt : "", /只允许输出文字/u);
});
