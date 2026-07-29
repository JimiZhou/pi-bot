import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { extractSearchTerms } from "../src/search-terms.js";
import { SqliteStore } from "../src/sqlite-store.js";
import type { InboundMessageEvent } from "../src/types.js";

test("Chinese n-grams recall memories without an embedding service", () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "g1",
      kind: "preference",
      content: "阿青最喜欢特斯拉的旅行版车型",
      importance: 0.6,
    });
    const duplicate = store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "g1",
      kind: "preference",
      content: "阿青最喜欢特斯拉的旅行版车型",
      importance: 0.8,
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.importance, 0.8);

    const found = store.findRelevantMemories("g1", "u1", "特斯拉新车型", 10);
    assert.equal(found.length, 1);
    assert.match(found[0]!.content, /特斯拉/);
    assert.deepEqual(store.findRelevantMemories("another-group", "u1", "特斯拉新车型", 10), []);
  } finally {
    store.close();
  }
});

test("memory embeddings round-trip as float vectors and remain scope-isolated", () => {
  const store = new SqliteStore(":memory:");
  try {
    const visible = store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "g1",
      kind: "preference",
      content: "阿青喜欢雨夜听爵士乐",
      importance: 0.8,
    });
    store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "g2",
      kind: "preference",
      content: "另一个群的私有记忆",
      importance: 0.9,
    });
    store.saveMemoryEmbedding(visible.id, "gemini-embedding-2", [0.125, -0.5, 1]);
    const restored = store.getMemoryEmbedding(visible.id, "gemini-embedding-2");
    assert.ok(restored);
    assert.ok(Math.abs(restored[0]! - 0.125) < 1e-6);
    assert.ok(Math.abs(restored[1]! + 0.5) < 1e-6);
    assert.ok(Math.abs(restored[2]! - 1) < 1e-6);
    assert.equal(store.getMemoryEmbedding(visible.id, "another-model"), undefined);
    assert.deepEqual(store.listMemoriesForEmbedding("g1", "u1").map((memory) => memory.id), [visible.id]);
  } finally {
    store.close();
  }
});

test("image understanding evidence survives restart and is reusable by content hash", (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-image-cache-"));
  const path = join(directory, "agent.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sha256 = "ab".repeat(32);

  const first = new SqliteStore(path);
  first.saveImageUnderstandingCache({
    assetId: "platform-image-1",
    sha256,
    evidence: "图中是一只红色杯子，右侧写着 SALE。",
    model: "test/vision",
  });
  first.close();

  const second = new SqliteStore(path);
  try {
    assert.match(second.getImageUnderstandingCache("platform-image-1")!.evidence, /红色杯子/u);
    const byContent = second.getImageUnderstandingCache("a-new-message-id", sha256);
    assert.equal(byContent?.model, "test/vision");
    assert.equal(byContent?.sha256, sha256);
  } finally {
    second.close();
  }
});

test("a transport message id resolves the local media copy without parsing event ids", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.ingest({
      type: "message",
      id: "adapter-local-event-7",
      transportMessageId: "upstream-message-42",
      conversation: { id: "room-1", kind: "group" },
      sender: { id: "member-1", displayName: "阿青" },
      text: "[图片]",
      timestamp: 1_800_000_000_000,
      parts: [{
        type: "image",
        asset: {
          id: "local-image-7",
          source: "platform",
          locator: "opaque-locator",
          ownerPluginId: "adapter-instance",
          mimeType: "image/png",
        },
      }],
    });
    const images = store.getInboundImagesByTransportMessageId("room-1", "upstream-message-42");
    assert.equal(images.length, 1);
    assert.equal(images[0]?.messageId, "adapter-local-event-7");
    assert.equal(images[0]?.part.asset.id, "local-image-7");
    assert.deepEqual(store.getInboundImagesByTransportMessageId("room-2", "upstream-message-42"), []);
  } finally {
    store.close();
  }
});

test("admins can list and remove only memories isolated to one chatroom", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.ingest({
      type: "message",
      id: "member-seed",
      conversation: { id: "room-group", kind: "group", title: "测试群" },
      sender: { id: "u1", displayName: "阿青" },
      text: "大家好",
      timestamp: Date.now(),
    });
    const groupMemory = store.remember({
      scope: "conversation",
      scopeId: "room-group",
      conversationId: "room-group",
      kind: "inside-joke",
      content: "群里把周五部署叫作开盲盒",
      importance: 0.8,
    });
    const personMemory = store.remember({
      scope: "person",
      scopeId: "u1",
      conversationId: "room-group",
      kind: "preference",
      content: "阿青不喜欢香菜",
      importance: 0.7,
    });
    store.remember({
      scope: "conversation",
      scopeId: "other-group",
      conversationId: "other-group",
      kind: "fact",
      content: "另一个群的记忆",
      importance: 0.9,
    });
    assert.deepEqual(
      new Set(store.listConversationMemories("room-group").map((item) => item.id)),
      new Set([groupMemory.id, personMemory.id]),
    );
    assert.deepEqual(store.listMembers("room-group").map((item) => item.displayName), ["阿青"]);
    assert.throws(
      () => store.forgetConversationMemoryAsAdmin(groupMemory.id, "other-group", "wrong group"),
      /does not belong/,
    );
    store.forgetConversationMemoryAsAdmin(groupMemory.id, "room-group", "管理员清理错误记忆");
    assert.deepEqual(store.listConversationMemories("room-group").map((item) => item.id), [personMemory.id]);
    assert.equal(store.listLearningAudit("room-group", 10)[0]?.actorId, "admin:webui");
  } finally {
    store.close();
  }
});

test("expired memories stay visible to admins but are excluded from every active retrieval path", (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-memory-expiry-"));
  const path = join(directory, "agent.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new SqliteStore(path);
  const memory = first.remember({
    scope: "person",
    scopeId: "u1",
    conversationId: "room-group",
    kind: "temporary-plan",
    content: "阿青这周五暂定去杭州",
    importance: 0.9,
    expiresAt: Date.now() + 60_000,
  });
  first.close();

  const database = new DatabaseSync(path);
  database.prepare("UPDATE memories SET expires_at = ? WHERE id = ?").run(Date.now() - 1, memory.id);
  database.close();

  const store = new SqliteStore(path);
  try {
    assert.deepEqual(store.listConversationMemories("room-group"), []);
    assert.equal(store.listConversationMemories("room-group", 500, true)[0]?.id, memory.id);
    assert.deepEqual(store.searchEditableMemories("room-group", "u1", "杭州", 10), []);
    assert.deepEqual(store.findRelevantMemories("room-group", "u1", "杭州", 10), []);
    assert.deepEqual(store.listMemoriesForEmbedding("room-group", "u1"), []);

    const renewed = store.confirmConversationMemoryAsAdmin(
      memory.id,
      "room-group",
      Date.now() + 365 * 24 * 60 * 60_000,
    );
    assert.ok((renewed.expiresAt ?? 0) > Date.now());
    assert.equal(store.findRelevantMemories("room-group", "u1", "杭州", 10)[0]?.id, memory.id);
    assert.match(store.listLearningAudit("room-group", 1)[0]?.reason ?? "", /有效期/u);
  } finally {
    store.close();
  }
});

test("full transcript history remains searchable", () => {
  const store = new SqliteStore(":memory:");
  try {
    const event: InboundMessageEvent = {
      type: "message",
      id: "m1",
      conversation: { id: "g1", kind: "group" },
      sender: { id: "u1", displayName: "阿青" },
      text: "下次聚会去虹桥那家潮汕火锅",
      timestamp: 1_700_000_000_000,
    };
    store.ingest(event);
    assert.deepEqual(store.searchHistory("g1", "潮汕火锅", 5).map((message) => message.id), ["m1"]);
    assert.deepEqual(store.searchHistory("other", "潮汕火锅", 5), []);
  } finally {
    store.close();
  }
});

test("context reset starts a new short-term epoch without deleting history or memory", () => {
  const store = new SqliteStore(":memory:");
  try {
    const currentSecond = Math.floor(Date.now() / 1000) * 1000;
    const first: InboundMessageEvent = {
      type: "message",
      id: "before-reset",
      conversation: { id: "room-group", kind: "group" },
      sender: { id: "member-a", displayName: "阿青" },
      text: "旧上下文里的暗号是蓝鲸",
      timestamp: currentSecond - 5000,
    };
    store.ingest(first);
    const memory = store.remember({
      scope: "conversation",
      scopeId: first.conversation.id,
      conversationId: first.conversation.id,
      kind: "fact",
      content: "长期记忆不会被上下文重置删除",
      importance: 0.9,
    });
    const reset = store.resetConversationContext(first.conversation.id, first.sender.id, "reset-command");
    assert.equal(reset.afterSequence, 1);
    const repeatedReset = store.resetConversationContext(first.conversation.id, first.sender.id, "reset-command-again");
    assert.equal(repeatedReset.afterSequence, reset.afterSequence);
    assert.ok(repeatedReset.resetAt > reset.resetAt);
    assert.equal(store.getRecent(first.conversation.id, 50).length, 0);

    store.appendExternalMessage({
      id: "late-import-from-before-reset",
      conversationId: first.conversation.id,
      direction: "inbound",
      senderId: first.sender.id,
      senderName: first.sender.displayName,
      text: "这是重置后才导入的旧聊天",
      timestamp: currentSecond - 10_000,
    });
    assert.equal(store.getRecent(first.conversation.id, 50).length, 0);

    const second: InboundMessageEvent = {
      ...first,
      id: "after-reset",
      text: "这是新上下文",
      timestamp: currentSecond + 1000,
    };
    store.ingest(second);
    assert.deepEqual(store.getRecent(first.conversation.id, 50).map((message) => message.id), [second.id]);
    assert.deepEqual(store.getRecentBefore(first.conversation.id, second.id, 50), []);
    assert.deepEqual(
      store.listConversationMessages(first.conversation.id, { limit: 50 }).map((message) => message.id),
      [first.id, "late-import-from-before-reset", second.id],
    );
    assert.deepEqual(store.searchHistory(first.conversation.id, "蓝鲸", 5).map((message) => message.id), [first.id]);
    assert.equal(store.listConversationMemories(first.conversation.id)[0]?.id, memory.id);
  } finally {
    store.close();
  }
});

test("conversation history supports stable sequence pagination", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (let index = 1; index <= 5; index += 1) {
      store.ingest({
        type: "message",
        id: `page-${index}`,
        conversation: { id: "room-group", kind: "group" },
        sender: { id: "u1", displayName: "阿青" },
        text: `消息 ${index}`,
        timestamp: 1_700_000_000_000 + index,
      });
    }
    const latest = store.listConversationMessages("room-group", { limit: 2 });
    assert.deepEqual(latest.map((message) => message.id), ["page-4", "page-5"]);
    const older = store.listConversationMessages("room-group", {
      limit: 2,
      beforeSequence: latest[0]!.sequence,
    });
    assert.deepEqual(older.map((message) => message.id), ["page-2", "page-3"]);
  } finally {
    store.close();
  }
});

test("term extraction indexes both Chinese phrases and technical tokens", () => {
  const terms = extractSearchTerms("平台群里的 TypeScript / agent-core");
  assert.ok(terms.includes("平台"));
  assert.ok(terms.includes("typescript"));
  assert.ok(terms.includes("agent-core"));
});

test("participation samples share a cross-bot fingerprint while decisions stay isolated", () => {
  const first = new SqliteStore(":memory:");
  const second = new SqliteStore(":memory:");
  try {
    const timestamp = 1_784_000_000_000;
    const firstEvent: InboundMessageEvent = {
      type: "message",
      id: "bot-a:event:123456789",
      conversation: { id: "998877-group", kind: "group", title: "同一个群" },
      sender: { id: "member_1", displayName: "阿青" },
      text: "今晚几点集合？",
      timestamp,
    };
    const secondEvent: InboundMessageEvent = {
      ...firstEvent,
      // Another adapter may assign a different local event id while preserving normalized identities.
      id: "bot-b:event:987654321",
    };
    first.ingest(firstEvent);
    second.ingest(secondEvent);
    first.recordParticipationCase({
      event: firstEvent,
      context: [],
      activation: "always",
      decision: { respond: true, reason: "ambient-question" },
    });
    second.recordParticipationCase({
      event: secondEvent,
      context: [],
      activation: "always",
      decision: { respond: false, reason: "ambient-no-signal" },
    });
    const firstCase = first.listParticipationCases()[0]!;
    const secondCase = second.listParticipationCases()[0]!;
    assert.equal(firstCase.sampleFingerprint, secondCase.sampleFingerprint);
    assert.equal(firstCase.policyRespond, true);
    assert.equal(secondCase.policyRespond, false);
  } finally {
    first.close();
    second.close();
  }
});

test("participation cases can be filtered and labeled by reply quality independently", () => {
  const store = new SqliteStore(":memory:");
  try {
    const firstEvent: InboundMessageEvent = {
      type: "message",
      id: "quality-helpful",
      conversation: { id: "room-group", kind: "group" },
      sender: { id: "u1", displayName: "阿青" },
      text: "怎么配置模型？",
      timestamp: Date.now(),
    };
    const secondEvent = { ...firstEvent, id: "quality-unrated", text: "另一个问题" };
    for (const event of [firstEvent, secondEvent]) {
      store.ingest(event);
      store.recordParticipationCase({
        event,
        context: [],
        activation: "always",
        decision: { respond: true, reason: "ambient-question" },
      });
      store.completeParticipationCase(event.id, "replied", "测试回复");
    }
    store.labelReplyQualityCase(firstEvent.id, "helpful", "解决了问题");
    assert.deepEqual(store.listParticipationCases({ qualityReview: "helpful" }).map((item) => item.eventId), [firstEvent.id]);
    assert.deepEqual(store.listParticipationCases({ qualityReview: "unhelpful" }), []);
    assert.deepEqual(store.listParticipationCases({ qualityReview: "unrated" }).map((item) => item.eventId), [secondEvent.id]);
    assert.equal(store.participationSummary().helpful, 1);
  } finally {
    store.close();
  }
});

test("a version-1 database migrates without losing existing memories", (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-migration-"));
  const path = join(directory, "v1.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      conversation_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );
    INSERT INTO memories
      (id, scope, scope_id, conversation_id, kind, content, importance, fingerprint,
       created_at, updated_at, last_accessed_at)
    VALUES
      ('legacy-memory', 'person', 'u1', 'g1', 'preference', '阿青喜欢潮汕火锅。', 0.9,
       'legacy-fingerprint', 1, 1, 1);
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = new SqliteStore(path);
  try {
    assert.equal(store.getMemory("legacy-memory")?.content, "阿青喜欢潮汕火锅。");
    assert.equal(store.findRelevantMemories("g1", "u1", "火锅", 5)[0]?.id, "legacy-memory");
    const behavior = store.setBehavior({
      scope: "person",
      scopeId: "u1",
      conversationId: "g1",
      rule: "回复短一点。",
    });
    assert.equal(store.getBehaviorRules("g1", "u1", 5)[0]?.id, behavior.id);
  } finally {
    store.close();
  }
});

test("a version-2 outbox migrates to durable message parts", (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-v2-outbox-"));
  const path = join(directory, "v2.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    INSERT INTO outbox
      (id, event_id, conversation_id, text, reply_to_message_id, status, created_at)
    VALUES ('legacy-out', 'legacy-event', 'g1', '旧版文本', 'legacy-event', 'pending', 1);
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const store = new SqliteStore(path);
  try {
    assert.deepEqual(store.pendingOutbox(), [
      {
        id: "legacy-out",
        type: "message",
        conversationId: "g1",
        text: "旧版文本",
        replyToMessageId: "legacy-event",
        createdAt: 1,
      },
    ]);
  } finally {
    store.close();
  }

  const migrated = new DatabaseSync(path);
  try {
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    const columns = migrated.prepare("PRAGMA table_info(outbox)").all() as unknown as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "parts_json"), true);
  } finally {
    migrated.close();
  }
});
