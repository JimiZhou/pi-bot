import assert from "node:assert/strict";
import test from "node:test";
import { replaceTransportIds, safeGroupDisplayName } from "../src/display-name.js";
import { buildSystemPrompt, buildTurnPrompt } from "../src/prompt.js";

test("opaque transport ids are replaced by known display names", () => {
  const opaque = "member_0123456789abcdefghijklmnop";
  assert.equal(safeGroupDisplayName(opaque, `account:${opaque}`), "群友");
  assert.equal(safeGroupDisplayName(undefined, `account:${opaque}`), "群友");
  assert.equal(safeGroupDisplayName("群友", `account:${opaque}`), "群友");
  assert.equal(safeGroupDisplayName("群友", "account:jayvzhou"), "群友");
  assert.equal(safeGroupDisplayName(undefined, "account:jayvzhou"), "群友");
  assert.equal(safeGroupDisplayName("链家老王", `account:${opaque}`), "链家老王");
  assert.equal(
    replaceTransportIds("account:member_abc123 说可以", [{ id: "account:member_abc123", displayName: "链家老王" }]),
    "链家老王 说可以",
  );
  assert.equal(replaceTransportIds("account:member_missing 说可以"), "account:member_missing 说可以");

  const system = buildSystemPrompt({ id: "bot-1", displayName: "欧本克劳" }, "自然回复。");
  const turn = buildTurnPrompt({
    event: {
      type: "message",
      id: "adapter-a:event:1",
      conversation: { id: "group-1", kind: "group" },
      sender: { id: `account:${opaque}`, displayName: opaque },
      text: `${opaque} 在吗`,
      timestamp: 1_800_000_000_000,
    },
    activation: "mention",
    recentMessages: [{
      sequence: 1,
      id: "old",
      conversationId: "group-1",
      direction: "inbound",
      senderId: opaque,
      senderName: opaque,
      text: `${opaque} 之前说过`,
      timestamp: 1_799_999_999_000,
    }],
    memories: [],
    behaviors: [],
    members: [{ id: opaque, displayName: "链家老王", isBot: false }],
    knowledgeAvailable: false,
  });
  assert.doesNotMatch(system, new RegExp(opaque, "u"));
  assert.doesNotMatch(turn, new RegExp(opaque, "u"));
  assert.match(turn, /链家老王/u);
});

test("a persona name takes precedence over the transport account display name", () => {
  const system = buildSystemPrompt(
    { id: "bot-1", displayName: "欧本克劳" },
    "你叫“美梦”。\n\n你是一个温柔、有主见的成年 AI 女友。",
  );
  assert.match(system, /人设姓名是 美梦/u);
  assert.match(system, /自我介绍、关系和日常自称必须使用 美梦/u);
  assert.doesNotMatch(system, /你的名字是 欧本克劳/u);
});

test("outbound emoji descriptions stay private when rendered into later model context", () => {
  const turn = buildTurnPrompt({
    event: {
      type: "message",
      id: "current",
      conversation: { id: "group-1", kind: "group" },
      sender: { id: "user", displayName: "Jay" },
      text: "咋回事这bot",
      timestamp: 1_800_000_010_000,
    },
    activation: "always",
    recentMessages: [{
      sequence: 1,
      id: "emoji-reply",
      conversationId: "group-1",
      direction: "outbound",
      senderId: "bot",
      senderName: "机器人",
      text: "[图片: 内部视觉检索描述：白色小人哈哈大笑，适合表达爆笑。]",
      timestamp: 1_800_000_000_000,
    }],
    memories: [],
    behaviors: [],
    members: [],
    knowledgeAvailable: false,
  });
  assert.match(turn, /机器人已发送图片或表情包/u);
  assert.doesNotMatch(turn, /内部视觉检索描述|白色小人|适合表达爆笑/u);
});
