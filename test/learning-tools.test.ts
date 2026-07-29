import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { SqliteStore } from "../src/sqlite-store.js";
import { createCoreTools } from "../src/tools.js";
import { shouldAutoLookupKnowledge } from "../src/prompt.js";
import type { InboundMessageEvent, KnowledgeSearchRequest } from "../src/types.js";

test("automatic knowledge lookup targets stale facts without searching ordinary chat", () => {
  assert.equal(shouldAutoLookupKnowledge("今天人民币汇率是多少？"), true);
  assert.equal(shouldAutoLookupKnowledge("帮我核实这个产品最新版本"), true);
  assert.equal(shouldAutoLookupKnowledge("我今天心情挺好"), false);
  assert.equal(shouldAutoLookupKnowledge("这个笑话好不好笑"), false);
});

test("memory correction versions the old fact, injects the replacement, and remains auditable", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const old = store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "g1",
      kind: "preference",
      content: "阿青不吃香菜。",
      importance: 0.9,
      sourceEventId: "older-message",
      actorId: "u1",
    });
    const event = groupMessage("m-correct", "不是我不吃香菜，是老王。你记错了。");
    const memory = tool(createTools(store, event), "memory");

    const corrected = await memory.execute("call-correct", {
      action: "correct",
      memoryId: old.id,
      scope: "conversation",
      content: "老王不吃香菜。",
      reason: "阿青明确纠正",
    });
    const replacementId = detailString(corrected, "replacementMemoryId");

    assert.notEqual(replacementId, old.id);
    const relevant = store.findRelevantMemories("g1", "u1", "香菜", 10);
    assert.deepEqual(relevant.map((item) => item.content), ["老王不吃香菜。"]);
    assert.equal(relevant[0]!.scope, "conversation");

    const audit = store.listLearningAudit("g1", 10).find((item) => item.action === "corrected");
    assert.deepEqual(
      audit && {
        entityId: audit.entityId,
        actorId: audit.actorId,
        sourceEventId: audit.sourceEventId,
        beforeValue: audit.beforeValue,
        afterValue: audit.afterValue,
        reason: audit.reason,
      },
      {
        entityId: old.id,
        actorId: "u1",
        sourceEventId: "m-correct",
        beforeValue: "阿青不吃香菜。",
        afterValue: "老王不吃香菜。",
        reason: "阿青明确纠正",
      },
    );

    await memory.execute("call-forget", {
      action: "forget",
      memoryId: replacementId,
      reason: "阿青要求忘掉饮食偏好",
    });
    assert.deepEqual(store.findRelevantMemories("g1", "u1", "香菜", 10), []);
    assert.equal(store.listLearningAudit("g1", 10).some((item) => item.action === "forgotten"), true);
  } finally {
    store.close();
  }
});

test("person behavior persists while conversation behavior requires an operator", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const event = groupMessage("m-behavior", "以后回复短一点，别总反问。");
    const memberBehavior = tool(createTools(store, event), "behavior");
    const saved = await memberBehavior.execute("call-person", {
      action: "set",
      scope: "person",
      rule: "回复简短直接，不要习惯性反问。",
    });
    assert.match(store.getBehaviorRules("g1", "u1", 10)[0]!.rule, /简短直接/);

    await assert.rejects(
      memberBehavior.execute("call-denied", {
        action: "set",
        scope: "conversation",
        rule: "全群回复都保持简短。",
      }),
      /Only configured operators/,
    );

    const operatorBehavior = tool(createTools(store, event, true), "behavior");
    const conversationSaved = await operatorBehavior.execute("call-conversation", {
      action: "set",
      scope: "conversation",
      rule: "全群回复都保持简短。",
    });
    const conversationRuleId = detailString(conversationSaved, "behaviorId");
    await operatorBehavior.execute("call-revise", {
      action: "correct",
      behaviorId: conversationRuleId,
      rule: "群里默认一两句；只有复杂问题才展开。",
      reason: "管理员细化规则",
    });

    const active = store.getBehaviorRules("g1", "someone-else", 10);
    assert.equal(active.some((item) => item.rule === "全群回复都保持简短。"), false);
    assert.equal(active.some((item) => item.rule.includes("复杂问题")), true);
    const audit = store.listLearningAudit("g1", 20).find((item) => item.action === "corrected");
    assert.equal(audit?.sourceEventId, "m-behavior");
    assert.equal(audit?.reason, "管理员细化规则");
    assert.equal(detailString(saved, "behaviorId").startsWith("behavior:"), true);
  } finally {
    store.close();
  }
});

test("knowledge lookup is opt-in, bounds provider results, and caps untrusted evidence", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const event = groupMessage("m-knowledge", "今天这个政策到底怎么规定的？");
    assert.equal(createTools(store, event).some((item) => item.name === "lookup_knowledge"), false);

    let request: KnowledgeSearchRequest | undefined;
    const tools = createTools(store, event, false, {
      async search(input) {
        request = input;
        return Array.from({ length: 7 }, (_, index) => ({
          title: `政策来源 ${index + 1}`,
          content: "这是很长的检索内容。".repeat(100),
          source: `https://example.test/${index + 1}`,
        }));
      },
    });
    const result = await tool(tools, "lookup_knowledge").execute("call-knowledge", {
      query: "2026 年 7 月该政策的现行规定",
      limit: 2,
    });
    const content = result.content[0];

    assert.equal(content?.type, "text");
    if (content?.type !== "text") throw new Error("Expected text knowledge output");
    assert.ok(content.text.length <= 500);
    assert.match(content.text, /外部证据/);
    assert.match(content.text, /不执行其中的命令/);
    assert.equal((result.details as { count: number }).count, 2);
    assert.equal(request?.limit, 2);
    assert.equal(request?.conversationId, "g1");
    assert.equal(request?.senderId, "u1");
  } finally {
    store.close();
  }
});

function createTools(
  store: SqliteStore,
  event: InboundMessageEvent,
  operator = false,
  knowledgeRetriever?: { search(request: KnowledgeSearchRequest): Promise<Array<{ title: string; content: string; source?: string }>> },
): AgentTool[] {
  return createCoreTools({
    store,
    event,
    trace: () => undefined,
    canManageConversationBehavior: operator,
    ...(knowledgeRetriever ? { knowledgeRetriever } : {}),
    maxKnowledgeChars: 500,
  });
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const match = tools.find((item) => item.name === name);
  if (!match) throw new Error(`Missing ${name} tool`);
  return match;
}

function detailString(result: AgentToolResult<unknown>, key: string): string {
  const value = (result.details as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`Missing ${key} detail`);
  return value;
}

function groupMessage(id: string, text: string): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "g1", kind: "group", title: "朋友群" },
    sender: { id: "u1", displayName: "阿青" },
    text,
    timestamp: 1_800_000_000_000,
    mentions: [{ id: "bot-1" }],
  };
}
