import assert from "node:assert/strict";
import test from "node:test";
import { SocialTriggerPolicy } from "../src/trigger.js";
import type { InboundMessageEvent, TriggerContext } from "../src/types.js";

const policy = new SocialTriggerPolicy();

test("direct messages, mentions, wake words and bot replies trigger deterministically", () => {
  assert.equal(policy.decide(context({ conversation: { id: "d1", kind: "direct" } })).reason, "direct-message");
  assert.equal(policy.decide(context({ mentions: [{ id: "bot" }] })).reason, "mention");
  assert.equal(policy.decide(context({ text: "派派帮我看下" })).reason, "wake-word");
  assert.equal(policy.decide(context({ replyTo: { messageId: "old", senderId: "bot" } })).reason, "reply-to-bot");
});

test("off mode and bot echoes stay silent", () => {
  const off = policy.decide({ ...context(), activation: "off" });
  assert.equal(off.respond, false);
  assert.equal(off.reason, "activation-off");

  const echo = policy.decide(context({ sender: { id: "bot", displayName: "小派", isBot: true } }));
  assert.equal(echo.respond, false);
  assert.equal(echo.reason, "bot-message");
});

test("quiet hours keep ambient chat silent while explicit calls still work", () => {
  const ambient = policy.decide({
    ...context({ text: "有人知道明天几点开门吗？" }),
    activation: "always",
    quietHours: true,
  });
  assert.deepEqual(ambient, { respond: false, reason: "quiet-hours" });

  const called = policy.decide({
    ...context({ text: "机器人，帮我看一下" }),
    bot: { id: "bot", displayName: "小派", wakeWords: ["机器人"] },
    activation: "always",
    quietHours: true,
  });
  assert.deepEqual(called, { respond: true, reason: "wake-word" });
});

test("a dense multi-person conversation creates a bounded hot-chat opportunity", () => {
  const now = 1_800_000_000_000;
  const recentMessages = Array.from({ length: 9 }, (_, index) => ({
    sequence: index + 1,
    id: `old-${index}`,
    conversationId: "g1",
    direction: "inbound" as const,
    senderId: `u${index % 4}`,
    senderName: `群友${index % 4}`,
    text: `热聊 ${index}`,
    timestamp: now - (9 - index) * 5000,
  }));
  const decision = policy.decide({
    ...context({ text: "确实挺有意思", timestamp: now }),
    activation: "always",
    recentMessages,
    hotChat: { windowMs: 3 * 60_000, minMessages: 10, minParticipants: 4 },
  });
  assert.deepEqual(decision, { respond: true, reason: "ambient-hot-chat" });
});

test("a pure image cannot become the unsolicited hot-chat trigger", () => {
  const now = 1_800_000_000_000;
  const recentMessages = Array.from({ length: 9 }, (_, index) => ({
    sequence: index + 1,
    id: `old-${index}`,
    conversationId: "g1",
    direction: "inbound" as const,
    senderId: `u${index % 4}`,
    senderName: `群友${index % 4}`,
    text: `热聊 ${index}`,
    timestamp: now - (9 - index) * 5000,
  }));
  const decision = policy.decide({
    ...context({
      text: "",
      timestamp: now,
      parts: [{
        type: "image",
        asset: { id: "img-1", source: "platform", locator: "message:1", ownerPluginId: "test" },
        alt: "平台图片",
      }],
    }),
    activation: "always",
    recentMessages,
    hotChat: { windowMs: 3 * 60_000, minMessages: 10, minParticipants: 4 },
  });
  assert.deepEqual(decision, { respond: false, reason: "ambient-media-only" });
});

test("always-on mode enters emoji battle mode for a normalized emoji", () => {
  const decision = policy.decide({
    ...context({
      text: "",
      metadata: { interaction: "emoji" },
      parts: [{
        type: "image",
        asset: {
          id: "incoming-emoji",
          source: "platform",
          locator: "message:1",
          ownerPluginId: "test",
          metadata: { kind: "emoji" },
        },
      }],
    }),
    activation: "always",
  });
  assert.deepEqual(decision, { respond: true, reason: "ambient-emoji-battle" });
});

test("always-on mode recognizes voice commands and native voice messages as participation signals", () => {
  const command = policy.decide({
    ...context({ text: "给我发一条语音" }),
    activation: "always",
  });
  assert.deepEqual(command, { respond: true, reason: "ambient-voice-request" });

  const voice = policy.decide({
    ...context({
      text: "",
      parts: [{
        type: "voice",
        asset: { id: "voice-1", source: "platform", locator: "message:voice-1", ownerPluginId: "test" },
      }],
    }),
    activation: "always",
  });
  assert.deepEqual(voice, { respond: true, reason: "ambient-voice" });
});

test("a third-person wake word buried mid-sentence does not force a reply", () => {
  const midSentence = policy.decide(context({ text: "我同事派派今天又迟到了" }));
  assert.equal(midSentence.respond, false);
  assert.equal(midSentence.reason, "not-addressed");

  const ambient = policy.decide({
    ...context({ text: "我同事派派今天又迟到了" }),
    activation: "always",
  });
  assert.deepEqual(ambient, { respond: true, reason: "ambient-name-mention" });

  assert.equal(policy.decide(context({ text: "派派你怎么看" })).reason, "wake-word");
  assert.equal(policy.decide(context({ text: "这个问题问派派" })).reason, "wake-word");
});

test("a demonstrative reference to the generic bot name is not mistaken for a call", () => {
  const decision = policy.decide({
    ...context({ text: "咋回事这bot" }),
    bot: { id: "bot-id", displayName: "小派", wakeWords: ["bot"] },
  });
  assert.deepEqual(decision, { respond: false, reason: "not-addressed" });

  assert.equal(policy.decide({
    ...context({ text: "bot，咋回事" }),
    bot: { id: "bot-id", displayName: "小派", wakeWords: ["bot"] },
  }).reason, "wake-word");
});

test("a follow-up survives one interjection from another member", () => {
  const now = 1_800_000_000_000;
  const thread = [
    message(1, "q1", "inbound", "u1", "小派这家店怎么样", now - 60_000, undefined),
    message(2, "a1", "outbound", "bot", "口碑还不错", now - 50_000, "q1"),
    message(3, "x1", "inbound", "u2", "顺便问下明天谁有空", now - 20_000, undefined),
  ];
  const followup = policy.decide({
    ...context({ text: "那价格贵不贵", sender: { id: "u1", displayName: "阿青" }, timestamp: now }),
    recentMessages: thread,
  });
  assert.deepEqual(followup, { respond: true, reason: "continuation" });

  const stranger = policy.decide({
    ...context({ text: "那价格贵不贵", sender: { id: "u9", displayName: "路人" }, timestamp: now }),
    recentMessages: thread,
  });
  assert.equal(stranger.respond, false);
});

function message(
  sequence: number,
  id: string,
  direction: "inbound" | "outbound",
  senderId: string,
  text: string,
  timestamp: number,
  replyToMessageId: string | undefined,
) {
  return {
    sequence,
    id,
    conversationId: "g1",
    direction,
    senderId,
    senderName: senderId,
    text,
    timestamp,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

function context(overrides: Partial<InboundMessageEvent> = {}): TriggerContext {
  return {
    event: {
      type: "message",
      id: "m1",
      conversation: { id: "g1", kind: "group" },
      sender: { id: "u1", displayName: "阿青" },
      text: "普通消息",
      ...overrides,
    },
    bot: { id: "bot", displayName: "小派", wakeWords: ["派派"] },
    activation: "mention",
    recentMessages: [],
    continuationWindowMs: 300_000,
  };
}
