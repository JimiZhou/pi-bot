import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractSearchTerms } from "./search-terms.js";
import { renderLegacyAttachments, renderMessageParts, textPart, validateMessageParts } from "./message-parts.js";
import type {
  BehaviorRule,
  BehaviorScope,
  GroupActivityDigest,
  GroupActivitySummary,
  GroupActivation,
  HandleResult,
  InboundMessageEvent,
  LearningAuditRecord,
  MessagePart,
  MemoryRecord,
  MemoryScope,
  OutboundMessageAction,
  ParticipationCase,
  ParticipationCaseQuery,
  ParticipationLabel,
  ParticipationOutcome,
  ParticipationSummary,
  ReplyQualityLabel,
  ProactiveParticipationRequest,
  RememberInput,
  SetBehaviorInput,
  StoredMessage,
} from "./types.js";

export interface SqliteStoreOptions {
  /** Disable only for short-lived admin readers; runtimes recover abandoned processing rows. */
  recoverProcessing?: boolean;
}

export interface ExternalStoredMessageInput {
  id: string;
  conversationId: string;
  conversationTitle?: string;
  direction: "inbound" | "outbound";
  senderId: string;
  senderName: string;
  senderIsBot?: boolean;
  text: string;
  timestamp: number;
  replyToMessageId?: string;
  sourceEventId?: string;
  transportMessageId?: string;
}

export interface ConversationContextReset {
  conversationId: string;
  afterSequence: number;
  afterTimestamp: number;
  resetBy: string;
  sourceEventId: string;
  resetAt: number;
}

interface InboxRow {
  event_id: string;
  conversation_id: string;
  status: "received" | "processing" | "done" | "failed";
  trigger_reason: string | null;
}

interface MessageRow {
  sequence: number;
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_id: string;
  sender_name: string;
  text: string;
  timestamp: number;
  reply_to_message_id: string | null;
  source_event_id: string | null;
  transport_message_id: string | null;
}

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  scope_id: string;
  conversation_id: string | null;
  kind: string;
  content: string;
  importance: number;
  active: number;
  superseded_by: string | null;
  last_confirmed_at: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MemoryEmbeddingRow {
  memory_id: string;
  model: string;
  dimensions: number;
  vector: Uint8Array;
}

interface ImageUnderstandingCacheRow {
  asset_id: string;
  content_sha256: string;
  evidence: string;
  model: string | null;
  created_at: number;
}

interface BehaviorRow {
  id: string;
  scope: BehaviorScope;
  scope_id: string;
  conversation_id: string;
  rule: string;
  active: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

interface LearningAuditRow {
  id: string;
  conversation_id: string;
  entity_type: "memory" | "behavior";
  entity_id: string;
  action: "saved" | "corrected" | "forgotten" | "restored";
  actor_id: string | null;
  source_event_id: string | null;
  before_value: string | null;
  after_value: string | null;
  reason: string | null;
  created_at: number;
}

interface OutboxRow {
  id: string;
  conversation_id: string;
  text: string;
  parts_json: string | null;
  reply_to_message_id: string;
  created_at: number;
}

interface ParticipationCaseRow {
  event_id: string;
  sample_fingerprint: string;
  conversation_id: string;
  conversation_title: string | null;
  sender_id: string;
  sender_name: string;
  message_text: string;
  context_json: string;
  activation: GroupActivation;
  policy_respond: number;
  policy_reason: string;
  model_used: number;
  outcome: ParticipationOutcome;
  reply_text: string | null;
  implicit_label: "speak" | "silent" | null;
  implicit_reason: string | null;
  implicit_source_event_id: string | null;
  admin_label: ParticipationLabel | null;
  admin_reason: string | null;
  admin_labeled_at: number | null;
  implicit_quality_label: "helpful" | "unhelpful" | null;
  implicit_quality_reason: string | null;
  implicit_quality_source_event_id: string | null;
  admin_quality_label: ReplyQualityLabel | null;
  admin_quality_reason: string | null;
  admin_quality_labeled_at: number | null;
  created_at: number;
  updated_at: number;
}

export class SqliteStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = NORMAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();

    // A new process cannot own work left in `processing` by an older process.
    if (options.recoverProcessing ?? true) {
      this.#database.prepare("UPDATE inbox SET status = 'received' WHERE status = 'processing'").run();
    }
  }

  close(): void {
    this.#closed = true;
    this.#database.close();
  }

  /**
   * Outbound replies are already durable in the messages/outbox transaction.
   * Their search terms can be indexed after the channel has started delivery;
   * keeping that secondary index off the reply critical path matters on large
   * long-lived SQLite files.
   */
  deferMessageIndex(sequence: number, text: string): void {
    if (this.#closed) return;
    setImmediate(() => {
      if (this.#closed) return;
      try {
        this.#transaction(() => this.#indexMessage(sequence, text));
      } catch {
        // Search indexing is best effort; the durable message remains intact.
      }
    });
  }

  ingest(event: InboundMessageEvent): { inserted: boolean; status: InboxRow["status"] } {
    const existing = this.#getInbox(event.id);
    if (existing) return { inserted: false, status: existing.status };

    const now = Date.now();
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO conversations (id, kind, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             title = COALESCE(excluded.title, conversations.title),
             updated_at = excluded.updated_at`,
        )
        .run(event.conversation.id, event.conversation.kind, event.conversation.title ?? null, now, now);

      this.#database
        .prepare(
          `INSERT INTO members (conversation_id, sender_id, display_name, is_bot, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, sender_id) DO UPDATE SET
             display_name = excluded.display_name,
             is_bot = excluded.is_bot,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          event.conversation.id,
          event.sender.id,
          event.sender.displayName,
          event.sender.isBot ? 1 : 0,
          event.timestamp ?? now,
          event.timestamp ?? now,
        );

      this.#database
        .prepare(
          `INSERT INTO inbox
             (event_id, conversation_id, status, raw_json, created_at, updated_at)
           VALUES (?, ?, 'received', ?, ?, ?)`,
        )
        .run(event.id, event.conversation.id, JSON.stringify(event), now, now);

      const result = this.#database
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
              source_event_id, transport_message_id)
           VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.conversation.id,
          event.sender.id,
          event.sender.displayName,
          eventText(event),
          event.timestamp ?? now,
          event.replyTo?.messageId ?? null,
          event.id,
          event.transportMessageId ?? null,
        );
      this.#indexMessage(Number(result.lastInsertRowid), eventText(event));
    });

    return { inserted: true, status: "received" };
  }

  getOutcome(eventId: string, replayed: boolean): HandleResult | undefined {
    const inbox = this.#getInbox(eventId);
    if (!inbox || inbox.status !== "done") return undefined;
    const actions = this.#outboxForEvent(eventId);
    return {
      eventId,
      status: actions.length > 0 ? "replied" : "ignored",
      triggerReason: inbox.trigger_reason ?? "unknown",
      actions,
      replayed,
    };
  }

  hasSeenEvent(eventId: string): boolean {
    return this.#database.prepare("SELECT 1 FROM inbox WHERE event_id = ?").get(eventId) !== undefined;
  }

  claimProcessing(eventId: string, reason: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE inbox
         SET status = 'processing', trigger_reason = ?, error = NULL, updated_at = ?
         WHERE event_id = ? AND status IN ('received', 'failed')`,
      )
      .run(reason, Date.now(), eventId);
    return result.changes === 1;
  }

  markFailed(eventId: string, error: string): void {
    this.#database
      .prepare("UPDATE inbox SET status = 'failed', error = ?, updated_at = ? WHERE event_id = ?")
      .run(error.slice(0, 4000), Date.now(), eventId);
  }

  completeWithoutReply(eventId: string, reason: string): HandleResult {
    this.#database
      .prepare(
        `UPDATE inbox
         SET status = 'done', trigger_reason = ?, error = NULL, updated_at = ?
         WHERE event_id = ?`,
      )
      .run(reason, Date.now(), eventId);
    return { eventId, status: "ignored", triggerReason: reason, actions: [], replayed: false };
  }

  completeWithReply(
    event: InboundMessageEvent,
    botId: string,
    botName: string,
    text: string,
    parts: MessagePart[],
    reason: string,
  ): HandleResult {
    const now = Date.now();
    const messageId = `bot:${randomUUID()}`;
    const actionId = `out:${randomUUID()}`;
    const normalizedParts = parts.length > 0 ? parts : [textPart(text)];
    let action!: OutboundMessageAction;

    let messageSequence = 0;
    this.#transaction(() => {
      const result = this.#database
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id, source_event_id)
           VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, event.conversation.id, botId, botName, text, now, event.id, event.id);
      messageSequence = Number(result.lastInsertRowid);

      this.#database
        .prepare(
          `INSERT INTO outbox
             (id, event_id, conversation_id, text, parts_json, reply_to_message_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(actionId, event.id, event.conversation.id, text, JSON.stringify(normalizedParts), event.id, now);

      this.#database
        .prepare(
          `UPDATE inbox
           SET status = 'done', trigger_reason = ?, error = NULL, updated_at = ?
           WHERE event_id = ?`,
        )
        .run(reason, now, event.id);

      action = {
        id: actionId,
        type: "message",
        conversationId: event.conversation.id,
        text,
        parts: normalizedParts,
        replyToMessageId: event.id,
        createdAt: now,
      };
    });

    this.deferMessageIndex(messageSequence, text);

    return { eventId: event.id, status: "replied", triggerReason: reason, actions: [action], replayed: false };
  }

  getRecentBefore(conversationId: string, eventId: string, limit: number): StoredMessage[] {
    const anchor = this.#database.prepare("SELECT sequence FROM messages WHERE id = ?").get(eventId) as
      | { sequence: number }
      | undefined;
    if (!anchor) return [];

    const rows = this.#database
      .prepare(
        `SELECT m.sequence, m.id, m.conversation_id, m.direction, m.sender_id, m.sender_name,
                m.text, m.timestamp, m.reply_to_message_id, m.source_event_id, m.transport_message_id
         FROM messages m
         LEFT JOIN conversation_context_resets r ON r.conversation_id = m.conversation_id
         WHERE m.conversation_id = ? AND m.sequence < ?
           AND m.sequence > COALESCE(r.after_sequence, 0)
           AND m.timestamp > COALESCE(r.after_timestamp, 0)
         ORDER BY m.sequence DESC
         LIMIT ?`,
      )
      .all(conversationId, anchor.sequence, limit) as unknown as MessageRow[];
    return rows.reverse().map(toStoredMessage);
  }

  getRecent(conversationId: string, limit: number): StoredMessage[] {
    const rows = this.#database
      .prepare(
        `SELECT m.sequence, m.id, m.conversation_id, m.direction, m.sender_id, m.sender_name,
                m.text, m.timestamp, m.reply_to_message_id, m.source_event_id, m.transport_message_id
         FROM messages m
         LEFT JOIN conversation_context_resets r ON r.conversation_id = m.conversation_id
         WHERE m.conversation_id = ?
           AND m.sequence > COALESCE(r.after_sequence, 0)
           AND m.timestamp > COALESCE(r.after_timestamp, 0)
         ORDER BY m.sequence DESC LIMIT ?`,
      )
      .all(conversationId, integerBetween(limit, 1, 500, "recent message limit")) as unknown as MessageRow[];
    return rows.reverse().map(toStoredMessage);
  }

  exportConversationMessages(conversationId: string): StoredMessage[] {
    const normalized = conversationId.normalize("NFKC").trim();
    if (!normalized) throw new Error("conversationId cannot be empty");
    const rows = this.#database
      .prepare(
        `SELECT sequence, id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
                source_event_id, transport_message_id
         FROM messages WHERE conversation_id = ? ORDER BY timestamp, sequence`,
      )
      .all(normalized) as unknown as MessageRow[];
    return rows.map(toStoredMessage);
  }

  appendExternalMessage(input: ExternalStoredMessageInput): boolean {
    const id = input.id.normalize("NFKC").trim();
    const conversationId = input.conversationId.normalize("NFKC").trim();
    const senderId = input.senderId.normalize("NFKC").trim();
    const senderName = input.senderName.normalize("NFKC").trim();
    if (!id || !conversationId || !senderId || !senderName) {
      throw new Error("External message identity fields cannot be empty");
    }
    if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
      throw new Error("External message timestamp is invalid");
    }
    let inserted = false;
    this.#transaction(() => {
      this.#database.prepare(
        `INSERT INTO conversations (id, kind, title, created_at, updated_at)
         VALUES (?, 'group', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, conversations.title),
           updated_at = MAX(conversations.updated_at, excluded.updated_at)`,
      ).run(conversationId, input.conversationTitle ?? null, input.timestamp, input.timestamp);
      this.#database.prepare(
        `INSERT INTO members (conversation_id, sender_id, display_name, is_bot, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, sender_id) DO UPDATE SET
           display_name = excluded.display_name,
           is_bot = MAX(members.is_bot, excluded.is_bot),
           first_seen_at = MIN(members.first_seen_at, excluded.first_seen_at),
           last_seen_at = MAX(members.last_seen_at, excluded.last_seen_at)`,
      ).run(
        conversationId,
        senderId,
        senderName,
        input.senderIsBot ? 1 : 0,
        input.timestamp,
        input.timestamp,
      );
      const result = this.#database.prepare(
        `INSERT OR IGNORE INTO messages
           (id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
            source_event_id, transport_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        conversationId,
        input.direction,
        senderId,
        senderName,
        input.text,
        input.timestamp,
        input.replyToMessageId ?? null,
        input.sourceEventId ?? null,
        input.transportMessageId ?? null,
      );
      if (result.changes === 1) {
        inserted = true;
        this.#indexMessage(Number(result.lastInsertRowid), input.text);
      }
    });
    return inserted;
  }

  /** Records the channel-native source behind a shared/fused message without replacing an existing source. */
  preserveMessageSourceEventId(messageId: string, sourceEventId: string): void {
    const normalizedMessageId = messageId.normalize("NFKC").trim();
    const normalizedSourceEventId = sourceEventId.normalize("NFKC").trim();
    if (!normalizedMessageId || !normalizedSourceEventId) {
      throw new Error("Message source mapping requires message and source event ids");
    }
    this.#database.prepare(
      `UPDATE messages SET source_event_id = ?
       WHERE id = ? AND (source_event_id IS NULL OR source_event_id = id)`,
    ).run(normalizedSourceEventId, normalizedMessageId);
  }

  /**
   * Starts a new short-term conversation epoch without deleting messages or long-term memory.
   * Messages written after this call remain visible to future turns.
   */
  resetConversationContext(
    conversationId: string,
    resetBy: string,
    sourceEventId: string,
  ): ConversationContextReset {
    const normalizedConversationId = conversationId.normalize("NFKC").trim();
    const normalizedResetBy = resetBy.normalize("NFKC").trim();
    const normalizedSourceEventId = sourceEventId.normalize("NFKC").trim();
    if (!normalizedConversationId || !normalizedResetBy || !normalizedSourceEventId) {
      throw new Error("Context reset requires conversation, actor, and source event ids");
    }
    const previous = this.#database
      .prepare("SELECT reset_at FROM conversation_context_resets WHERE conversation_id = ?")
      .get(normalizedConversationId) as { reset_at: number } | undefined;
    const now = Math.max(Date.now(), (previous?.reset_at ?? 0) + 1);
    const afterTimestamp = contextResetTimestampCutoff(now);
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE conversation_id = ?")
      .get(normalizedConversationId) as { sequence: number };
    const afterSequence = Number(row.sequence);
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO conversations (id, kind, created_at, updated_at)
           VALUES (?, 'group', ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(normalizedConversationId, now, now);
      this.#database
        .prepare(
          `INSERT INTO conversation_context_resets
             (conversation_id, after_sequence, after_timestamp, reset_by, source_event_id, reset_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             after_sequence = excluded.after_sequence,
             after_timestamp = excluded.after_timestamp,
             reset_by = excluded.reset_by,
             source_event_id = excluded.source_event_id,
             reset_at = excluded.reset_at`,
        )
        .run(normalizedConversationId, afterSequence, afterTimestamp, normalizedResetBy, normalizedSourceEventId, now);
    });
    return {
      conversationId: normalizedConversationId,
      afterSequence,
      afterTimestamp,
      resetBy: normalizedResetBy,
      sourceEventId: normalizedSourceEventId,
      resetAt: now,
    };
  }

  resetConversationContextAt(
    conversationId: string,
    resetBy: string,
    sourceEventId: string,
    resetAt: number,
  ): ConversationContextReset {
    const normalizedConversationId = conversationId.normalize("NFKC").trim();
    const normalizedResetBy = resetBy.normalize("NFKC").trim();
    const normalizedSourceEventId = sourceEventId.normalize("NFKC").trim();
    if (!normalizedConversationId || !normalizedResetBy || !normalizedSourceEventId) {
      throw new Error("Context reset requires conversation, actor, and source event ids");
    }
    if (!Number.isSafeInteger(resetAt) || resetAt < 0) throw new Error("Context reset time is invalid");
    const afterTimestamp = contextResetTimestampCutoff(resetAt);
    const row = this.#database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE conversation_id = ? AND timestamp <= ?",
    ).get(normalizedConversationId, resetAt) as { sequence: number };
    const afterSequence = Number(row.sequence);
    this.#transaction(() => {
      this.#database.prepare(
        `INSERT INTO conversations (id, kind, created_at, updated_at)
         VALUES (?, 'group', ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = MAX(conversations.updated_at, excluded.updated_at)`,
      ).run(normalizedConversationId, resetAt, resetAt);
      this.#database.prepare(
        `INSERT INTO conversation_context_resets
           (conversation_id, after_sequence, after_timestamp, reset_by, source_event_id, reset_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           after_sequence = excluded.after_sequence,
           after_timestamp = excluded.after_timestamp,
           reset_by = excluded.reset_by,
           source_event_id = excluded.source_event_id,
           reset_at = excluded.reset_at
         WHERE excluded.reset_at >= conversation_context_resets.reset_at`,
      ).run(normalizedConversationId, afterSequence, afterTimestamp, normalizedResetBy, normalizedSourceEventId, resetAt);
    });
    return {
      conversationId: normalizedConversationId,
      afterSequence,
      afterTimestamp,
      resetBy: normalizedResetBy,
      sourceEventId: normalizedSourceEventId,
      resetAt,
    };
  }

  getConversationContextReset(conversationId: string): ConversationContextReset | undefined {
    const row = this.#database
      .prepare(
        `SELECT conversation_id, after_sequence, after_timestamp, reset_by, source_event_id, reset_at
         FROM conversation_context_resets WHERE conversation_id = ?`,
      )
      .get(conversationId) as
        | {
            conversation_id: string;
            after_sequence: number;
            after_timestamp: number;
            reset_by: string;
            source_event_id: string;
            reset_at: number;
          }
        | undefined;
    return row
      ? {
          conversationId: row.conversation_id,
          afterSequence: row.after_sequence,
          afterTimestamp: row.after_timestamp,
          resetBy: row.reset_by,
          sourceEventId: row.source_event_id,
          resetAt: row.reset_at,
        }
      : undefined;
  }

  listConversationMessages(
    conversationId: string,
    options: { limit?: number; beforeSequence?: number } = {},
  ): StoredMessage[] {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) throw new Error("conversationId cannot be empty");
    const limit = integerBetween(options.limit ?? 50, 1, 201, "conversation message limit");
    const rows = options.beforeSequence === undefined
      ? this.#database
          .prepare(
            `SELECT sequence, id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
                    source_event_id, transport_message_id
             FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?`,
          )
          .all(normalizedConversationId, limit) as unknown as MessageRow[]
      : this.#database
          .prepare(
            `SELECT sequence, id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
                    source_event_id, transport_message_id
             FROM messages WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
          )
          .all(
            normalizedConversationId,
            integerBetween(options.beforeSequence, 1, Number.MAX_SAFE_INTEGER, "before sequence"),
            limit,
          ) as unknown as MessageRow[];
    return rows.reverse().map(toStoredMessage);
  }

  listGroupActivity(startAt: number, endAt: number, minInboundMessages = 1): GroupActivitySummary[] {
    const start = integerBetween(startAt, 0, Number.MAX_SAFE_INTEGER, "activity start");
    const end = integerBetween(endAt, start + 1, Number.MAX_SAFE_INTEGER, "activity end");
    const minimum = integerBetween(minInboundMessages, 1, 100_000, "minimum inbound messages");
    const rows = this.#database
      .prepare(
        `SELECT c.id AS conversation_id, c.title AS conversation_title,
                COUNT(m.sequence) AS inbound_messages, COUNT(DISTINCT m.sender_id) AS active_members,
                MAX(m.timestamp) AS last_message_at
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id AND m.direction = 'inbound'
         WHERE c.kind = 'group' AND m.timestamp >= ? AND m.timestamp < ?
         GROUP BY c.id, c.title HAVING COUNT(m.sequence) >= ?
         ORDER BY last_message_at DESC`,
      )
      .all(start, end, minimum) as unknown as Array<{
        conversation_id: string;
        conversation_title: string | null;
        inbound_messages: number;
        active_members: number;
        last_message_at: number;
      }>;
    return rows.map(toGroupActivitySummary);
  }

  listColdGroups(cutoffAt: number, earliestAt: number, limit = 20): GroupActivitySummary[] {
    const cutoff = integerBetween(cutoffAt, 1, Number.MAX_SAFE_INTEGER, "cold cutoff");
    const earliest = integerBetween(earliestAt, 0, cutoff, "cold earliest time");
    const rows = this.#database
      .prepare(
        `SELECT c.id AS conversation_id, c.title AS conversation_title,
                SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_messages,
                COUNT(DISTINCT CASE WHEN m.direction = 'inbound' THEN m.sender_id END) AS active_members,
                MAX(m.timestamp) AS last_message_at
         FROM conversations c JOIN messages m ON m.conversation_id = c.id
         WHERE c.kind = 'group'
         GROUP BY c.id, c.title
         HAVING MAX(m.timestamp) <= ? AND MAX(m.timestamp) >= ?
            AND SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) > 0
         ORDER BY last_message_at DESC LIMIT ?`,
      )
      .all(cutoff, earliest, integerBetween(limit, 1, 200, "cold group limit")) as unknown as Array<{
        conversation_id: string;
        conversation_title: string | null;
        inbound_messages: number;
        active_members: number;
        last_message_at: number;
      }>;
    return rows.map(toGroupActivitySummary);
  }

  getGroupActivityDigest(
    conversationId: string,
    startAt: number,
    endAt: number,
    messageLimit = 160,
  ): GroupActivityDigest | undefined {
    const summaryRow = this.#database
      .prepare(
        `SELECT c.id AS conversation_id, c.title AS conversation_title,
                COUNT(m.sequence) AS inbound_messages, COUNT(DISTINCT m.sender_id) AS active_members,
                MAX(m.timestamp) AS last_message_at
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id AND m.direction = 'inbound'
         WHERE c.id = ? AND c.kind = 'group' AND m.timestamp >= ? AND m.timestamp < ?
         GROUP BY c.id, c.title`,
      )
      .get(conversationId, startAt, endAt) as {
        conversation_id: string;
        conversation_title: string | null;
        inbound_messages: number;
        active_members: number;
        last_message_at: number;
      } | undefined;
    if (!summaryRow) return undefined;
    const summary = toGroupActivitySummary(summaryRow);
    const rankingRows = this.#database
      .prepare(
        `SELECT sender_id, MAX(sender_name) AS sender_name, COUNT(*) AS messages
         FROM messages
         WHERE conversation_id = ? AND direction = 'inbound' AND timestamp >= ? AND timestamp < ?
         GROUP BY sender_id ORDER BY messages DESC, sender_id LIMIT 10`,
      )
      .all(conversationId, startAt, endAt) as unknown as Array<{
        sender_id: string;
        sender_name: string;
        messages: number;
      }>;
    const rows = this.#database
      .prepare(
        `SELECT sequence, id, conversation_id, direction, sender_id, sender_name, text, timestamp, reply_to_message_id,
                source_event_id, transport_message_id
         FROM messages
         WHERE conversation_id = ? AND direction = 'inbound' AND timestamp >= ? AND timestamp < ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(conversationId, startAt, endAt, integerBetween(messageLimit, 1, 500, "digest message limit")) as unknown as MessageRow[];
    return {
      ...summary,
      ranking: rankingRows.map((row) => ({
        senderId: row.sender_id,
        senderName: row.sender_name,
        messages: row.messages,
      })),
      messages: rows.reverse().map(toStoredMessage),
    };
  }

  beginProactiveEvent(
    request: ProactiveParticipationRequest,
    botId: string,
    context: StoredMessage[],
  ): { inserted: boolean; event: InboundMessageEvent } {
    const conversation = this.#database
      .prepare("SELECT id, title FROM conversations WHERE id = ? AND kind = 'group'")
      .get(request.conversationId) as { id: string; title: string | null } | undefined;
    if (!conversation) throw new Error(`Group conversation ${request.conversationId} does not exist`);
    const event: InboundMessageEvent = {
      type: "message",
      id: request.id,
      conversation: {
        id: conversation.id,
        kind: "group",
        ...(conversation.title ? { title: conversation.title } : {}),
      },
      sender: { id: `scheduler:${botId}`, displayName: "群聊节奏调度器", isBot: true },
      text: request.prompt,
      timestamp: request.timestamp,
      metadata: { proactiveKind: request.kind },
    };
    if (this.#database.prepare("SELECT 1 FROM inbox WHERE event_id = ?").get(request.id)) {
      return { inserted: false, event };
    }
    const now = Date.now();
    const messageText = eventText(event).slice(0, 4000);
    const boundedContext = context.slice(-12).map((message) => ({ ...message, text: message.text.slice(0, 1000) }));
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO inbox (event_id, conversation_id, status, raw_json, created_at, updated_at)
           VALUES (?, ?, 'received', ?, ?, ?)`,
        )
        .run(event.id, event.conversation.id, JSON.stringify(event), now, now);
      this.#database
        .prepare(
          `INSERT INTO participation_cases
             (event_id, sample_fingerprint, conversation_id, conversation_title, sender_id, sender_name, message_text,
              context_json, activation, policy_respond, policy_reason, model_used, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'always', 1, ?, 0, 'pending', ?, ?)`,
        )
        .run(
          event.id,
          participationSampleFingerprint(event, messageText),
          event.conversation.id,
          event.conversation.title ?? null,
          event.sender.id,
          event.sender.displayName,
          messageText,
          JSON.stringify(boundedContext),
          `proactive-${request.kind}`,
          now,
          now,
        );
      const insertTerm = this.#database.prepare(
        "INSERT OR IGNORE INTO participation_case_terms (event_id, term) VALUES (?, ?)",
      );
      for (const term of extractSearchTerms(messageText)) insertTerm.run(event.id, term);
    });
    return { inserted: true, event };
  }

  getInboundImages(eventId: string): Array<{
    messageId: string;
    senderId: string;
    timestamp: number;
    part: Extract<MessagePart, { type: "image" }>;
  }> {
    const value = this.getInboundMessage(eventId);
    if (!value || !Array.isArray(value.parts)) return [];
    try {
      const parts = value.parts.filter(
        (part): part is Extract<MessagePart, { type: "image" }> => part.type === "image",
      );
      validateMessageParts(parts);
      return parts.map((part) => ({
        messageId: eventId,
        senderId: value.sender.id,
        timestamp: value.timestamp ?? 0,
        part,
      }));
    } catch {
      return [];
    }
  }

  /** Returns the original inbound event, including binary attachment metadata. */
  getInboundMessage(eventId: string): InboundMessageEvent | undefined {
    const row = this.#database.prepare("SELECT raw_json FROM inbox WHERE event_id = ?").get(eventId) as
      | { raw_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.raw_json) as Partial<InboundMessageEvent>;
      if (
        value.type !== "message" ||
        value.id !== eventId ||
        !value.conversation?.id ||
        !value.sender?.id ||
        typeof value.text !== "string"
      ) {
        return undefined;
      }
      if (value.parts !== undefined) {
        if (!Array.isArray(value.parts)) return undefined;
        validateMessageParts(value.parts);
      }
      return value as InboundMessageEvent;
    } catch {
      return undefined;
    }
  }

  getInboundMessageByTransportMessageId(
    conversationId: string,
    transportMessageId: string,
  ): InboundMessageEvent | undefined {
    const row = this.#database.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND direction = 'inbound' AND transport_message_id = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(conversationId, transportMessageId) as { id: string } | undefined;
    return row ? this.getInboundMessage(row.id) : undefined;
  }

  getInboundImagesByTransportMessageId(
    conversationId: string,
    transportMessageId: string,
  ): ReturnType<SqliteStore["getInboundImages"]> {
    const row = this.#database.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND direction = 'inbound' AND transport_message_id = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(conversationId, transportMessageId) as { id: string } | undefined;
    return row ? this.getInboundImages(row.id) : [];
  }

  listMembers(conversationId: string): Array<{ id: string; displayName: string; isBot: boolean }> {
    const rows = this.#database
      .prepare(
        `SELECT sender_id, display_name, is_bot
         FROM members WHERE conversation_id = ?
         ORDER BY last_seen_at DESC LIMIT 100`,
      )
      .all(conversationId) as unknown as Array<{ sender_id: string; display_name: string; is_bot: number }>;
    return rows.map((row) => ({ id: row.sender_id, displayName: row.display_name, isBot: row.is_bot === 1 }));
  }

  upsertMember(
    conversationId: string,
    member: { id: string; displayName: string; isBot?: boolean },
    observedAt = Date.now(),
  ): void {
    if (!conversationId.trim() || !member.id.trim() || !member.displayName.trim()) {
      throw new Error("Member directory entry is incomplete");
    }
    this.#database.prepare(
      `INSERT INTO members (conversation_id, sender_id, display_name, is_bot, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, sender_id) DO UPDATE SET
         display_name = excluded.display_name,
         is_bot = MAX(members.is_bot, excluded.is_bot),
         last_seen_at = MAX(members.last_seen_at, excluded.last_seen_at)`,
    ).run(
      conversationId,
      member.id,
      member.displayName,
      member.isBot ? 1 : 0,
      observedAt,
      observedAt,
    );
  }

  setGroupActivation(conversationId: string, activation: GroupActivation): void {
    const now = Date.now();
    this.#database
      .prepare(
        `INSERT INTO conversations (id, kind, activation, created_at, updated_at)
         VALUES (?, 'group', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET activation = excluded.activation, updated_at = excluded.updated_at`,
      )
      .run(conversationId, activation, now, now);
  }

  getGroupActivation(conversationId: string): GroupActivation | undefined {
    const row = this.#database.prepare("SELECT activation FROM conversations WHERE id = ?").get(conversationId) as
      | { activation: GroupActivation | null }
      | undefined;
    return row?.activation ?? undefined;
  }

  remember(input: RememberInput): MemoryRecord {
    const content = normalizeMemory(input.content);
    if (!content) throw new Error("Memory content cannot be empty");
    if (!input.scopeId.trim()) throw new Error("Memory scope id cannot be empty");
    if (input.scope === "person" && !input.conversationId?.trim()) {
      throw new Error("Person memory requires conversationId to prevent cross-chat leakage");
    }
    const importance = clamp(input.importance, 0, 1);
    const kind = input.kind.trim().toLocaleLowerCase() || "fact";
    const fingerprint = memoryFingerprint(input.scope, input.scopeId, input.conversationId, kind, content);
    const existing = this.#database.prepare("SELECT id, active FROM memories WHERE fingerprint = ?").get(fingerprint) as
      | { id: string; active: number }
      | undefined;
    const now = Date.now();
    const expiresAt = validatedMemoryExpiry(input.expiresAt, now);

    if (existing) {
      this.#transaction(() => {
        this.#database
          .prepare(
            `UPDATE memories
             SET importance = MAX(importance, ?), active = 1, superseded_by = NULL,
                 last_confirmed_at = ?, expires_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(importance, now, expiresAt, now, existing.id);
        if (existing.active === 0) {
          this.#insertAudit({
            conversationId: memoryConversationId(input.scope, input.scopeId, input.conversationId),
            entityType: "memory",
            entityId: existing.id,
            action: "restored",
            ...(input.actorId ? { actorId: input.actorId } : {}),
            ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
            afterValue: content,
          });
        }
      });
      return this.getMemory(existing.id)!;
    }

    const id = `mem:${randomUUID()}`;
    this.#transaction(() => {
      this.#insertMemoryRow({ id, ...input, kind, content, importance, fingerprint, now, ...(expiresAt ? { expiresAt } : {}) });
      this.#indexMemory(id, content);
      this.#insertAudit({
        conversationId: memoryConversationId(input.scope, input.scopeId, input.conversationId),
        entityType: "memory",
        entityId: id,
        action: "saved",
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        afterValue: content,
      });
    });
    return this.getMemory(id)!;
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, kind, content, importance, active, superseded_by,
                last_confirmed_at, expires_at, created_at, updated_at FROM memories WHERE id = ?`,
      )
      .get(id) as unknown as MemoryRow | undefined;
    return row ? toMemoryRecord(row) : undefined;
  }

  /** Lists active group and member memories that are isolated to one conversation. */
  listConversationMemories(conversationId: string, limit = 500, includeExpired = false): MemoryRecord[] {
    const expirySql = includeExpired ? "" : "AND (expires_at IS NULL OR expires_at > ?)";
    const parameters: Array<string | number> = [conversationId, conversationId];
    if (!includeExpired) parameters.push(Date.now());
    parameters.push(integerBetween(limit, 1, 2000, "conversation memory limit"));
    const rows = this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, kind, content, importance, active, superseded_by,
                last_confirmed_at, expires_at, created_at, updated_at
         FROM memories
         WHERE active = 1 AND (
           (scope = 'conversation' AND scope_id = ?)
           OR (scope = 'person' AND conversation_id = ?)
         )
         ${expirySql}
         ORDER BY scope, importance DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...parameters) as unknown as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  hasConversationMemoryHistory(conversationId: string): boolean {
    const row = this.#database.prepare(
      `SELECT 1 AS found FROM memories
       WHERE (scope = 'conversation' AND scope_id = ?)
          OR (scope = 'person' AND conversation_id = ?)
       LIMIT 1`,
    ).get(conversationId, conversationId) as { found: number } | undefined;
    return row?.found === 1;
  }

  /** Admin-only removal with the same audit trail as a chat-issued forget action. */
  forgetConversationMemoryAsAdmin(memoryId: string, conversationId: string, reason: string): void {
    const current = this.#getMemoryRow(memoryId);
    if (!current || current.active !== 1) throw new Error("Active memory not found");
    const belongsToConversation =
      (current.scope === "conversation" && current.scope_id === conversationId) ||
      (current.scope === "person" && current.conversation_id === conversationId);
    if (!belongsToConversation) throw new Error("Memory does not belong to this conversation");
    this.#transaction(() => {
      this.#database.prepare("UPDATE memories SET active = 0, updated_at = ? WHERE id = ?").run(Date.now(), current.id);
      this.#insertAudit({
        conversationId,
        entityType: "memory",
        entityId: current.id,
        action: "forgotten",
        actorId: "admin:webui",
        beforeValue: current.content,
        reason: reason.normalize("NFKC").trim().slice(0, 500) || "管理员从 WebUI 删除",
      });
    });
  }

  /** Confirms an active memory is still valid and optionally assigns a new expiry. */
  confirmConversationMemoryAsAdmin(memoryId: string, conversationId: string, expiresAt?: number | null): MemoryRecord {
    const current = this.#getMemoryRow(memoryId);
    if (!current || current.active !== 1) throw new Error("Active memory not found");
    const belongsToConversation =
      (current.scope === "conversation" && current.scope_id === conversationId) ||
      (current.scope === "person" && current.conversation_id === conversationId);
    if (!belongsToConversation) throw new Error("Memory does not belong to this conversation");
    const now = Date.now();
    const validatedExpiry = expiresAt === null ? null : validatedMemoryExpiry(expiresAt, now);
    this.#transaction(() => {
      if (expiresAt === undefined) {
        this.#database.prepare(
          "UPDATE memories SET last_confirmed_at = ?, updated_at = ? WHERE id = ?",
        ).run(now, now, current.id);
      } else {
        this.#database.prepare(
          "UPDATE memories SET last_confirmed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?",
        ).run(now, validatedExpiry, now, current.id);
      }
      this.#insertAudit({
        conversationId,
        entityType: "memory",
        entityId: current.id,
        action: "corrected",
        actorId: "admin:webui",
        beforeValue: current.content,
        afterValue: current.content,
        reason: expiresAt === undefined ? "管理员确认记忆仍然有效" : "管理员确认记忆并更新有效期",
      });
    });
    return this.getMemory(current.id)!;
  }

  reviseMemory(input: {
    memoryId: string;
    conversationId: string;
    actorId: string;
    sourceEventId: string;
    content: string;
    scope?: Exclude<MemoryScope, "global">;
    kind?: string;
    importance?: number;
    reason: string;
  }): MemoryRecord {
    const current = this.#getMemoryRow(input.memoryId);
    if (!current || current.active !== 1) throw new Error("Active memory not found");
    this.#assertMemoryEditable(current, input.conversationId, input.actorId);
    const content = normalizeMemory(input.content);
    if (!content) throw new Error("Corrected memory content cannot be empty");
    const scope = input.scope ?? current.scope;
    if (scope === "global") throw new Error("Corrections from chat cannot create global memories");
    const scopeId = scope === "person" ? input.actorId : input.conversationId;
    const conversationId = input.conversationId;
    const kind = input.kind?.trim().toLocaleLowerCase() || current.kind;
    const importance = clamp(input.importance ?? current.importance, 0, 1);
    const fingerprint = memoryFingerprint(scope, scopeId, conversationId, kind, content);
    const same = this.#database.prepare("SELECT id, active FROM memories WHERE fingerprint = ?").get(fingerprint) as
      | { id: string; active: number }
      | undefined;
    if (same?.id === current.id) return toMemoryRecord(current);

    const replacementId = same?.id ?? `mem:${randomUUID()}`;
    const now = Date.now();
    this.#transaction(() => {
      if (same) {
        this.#database
          .prepare(
            `UPDATE memories SET active = 1, superseded_by = NULL, importance = ?, updated_at = ? WHERE id = ?`,
          )
          .run(importance, now, replacementId);
      } else {
        this.#insertMemoryRow({
          id: replacementId,
          scope,
          scopeId,
          conversationId,
          kind,
          content,
          importance,
          fingerprint,
          sourceEventId: input.sourceEventId,
          actorId: input.actorId,
          now,
        });
        this.#indexMemory(replacementId, content);
      }
      this.#database
        .prepare("UPDATE memories SET active = 0, superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(replacementId, now, current.id);
      this.#insertAudit({
        conversationId: input.conversationId,
        entityType: "memory",
        entityId: current.id,
        action: "corrected",
        actorId: input.actorId,
        sourceEventId: input.sourceEventId,
        beforeValue: current.content,
        afterValue: content,
        reason: input.reason,
      });
    });
    return this.getMemory(replacementId)!;
  }

  forgetMemory(input: {
    memoryId: string;
    conversationId: string;
    actorId: string;
    sourceEventId: string;
    reason: string;
  }): void {
    const current = this.#getMemoryRow(input.memoryId);
    if (!current || current.active !== 1) throw new Error("Active memory not found");
    this.#assertMemoryEditable(current, input.conversationId, input.actorId);
    this.#transaction(() => {
      this.#database.prepare("UPDATE memories SET active = 0, updated_at = ? WHERE id = ?").run(Date.now(), current.id);
      this.#insertAudit({
        conversationId: input.conversationId,
        entityType: "memory",
        entityId: current.id,
        action: "forgotten",
        actorId: input.actorId,
        sourceEventId: input.sourceEventId,
        beforeValue: current.content,
        reason: input.reason,
      });
    });
  }

  searchEditableMemories(conversationId: string, actorId: string, query: string, limit: number): MemoryRecord[] {
    const terms = extractSearchTerms(query);
    const scopeSql = `m.active = 1 AND (m.expires_at IS NULL OR m.expires_at > ?) AND (
      (m.scope = 'conversation' AND m.scope_id = ?)
      OR (m.scope = 'person' AND m.scope_id = ? AND m.conversation_id = ?))`;
    const now = Date.now();
    let rows: MemoryRow[];
    if (terms.length === 0) {
      rows = this.#database
        .prepare(
          `SELECT m.id, m.scope, m.scope_id, m.conversation_id, m.kind, m.content, m.importance,
                  m.active, m.superseded_by, m.last_confirmed_at, m.expires_at, m.created_at, m.updated_at
           FROM memories m WHERE ${scopeSql} ORDER BY m.updated_at DESC LIMIT ?`,
        )
        .all(now, conversationId, actorId, conversationId, limit) as unknown as MemoryRow[];
    } else {
      const placeholders = terms.map(() => "?").join(", ");
      rows = this.#database
        .prepare(
          `SELECT m.id, m.scope, m.scope_id, m.conversation_id, m.kind, m.content, m.importance,
                  m.active, m.superseded_by, m.last_confirmed_at, m.expires_at, m.created_at, m.updated_at, COUNT(mt.term) AS matched_terms
           FROM memories m
           JOIN memory_terms mt ON mt.memory_id = m.id AND mt.term IN (${placeholders})
           WHERE ${scopeSql}
           GROUP BY m.id ORDER BY matched_terms DESC, m.updated_at DESC LIMIT ?`,
        )
        .all(...terms, now, conversationId, actorId, conversationId, limit) as unknown as MemoryRow[];
    }
    return rows.map(toMemoryRecord);
  }

  findRelevantMemories(conversationId: string, personId: string, query: string, limit: number): MemoryRecord[] {
    const terms = extractSearchTerms(query);
    const scopeSql = `m.active = 1 AND (m.expires_at IS NULL OR m.expires_at > ?) AND (m.scope = 'global'
      OR (m.scope = 'conversation' AND m.scope_id = ?)
      OR (m.scope = 'person' AND m.scope_id = ? AND m.conversation_id = ?))`;
    const now = Date.now();
    let rows: MemoryRow[];

    if (terms.length === 0) {
      rows = this.#database
        .prepare(
          `SELECT m.id, m.scope, m.scope_id, m.conversation_id, m.kind, m.content, m.importance,
                  m.active, m.superseded_by, m.last_confirmed_at, m.expires_at, m.created_at, m.updated_at
           FROM memories m WHERE ${scopeSql}
           ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
        )
        .all(now, conversationId, personId, conversationId, limit) as unknown as MemoryRow[];
    } else {
      const placeholders = terms.map(() => "?").join(", ");
      rows = this.#database
        .prepare(
          `SELECT m.id, m.scope, m.scope_id, m.conversation_id, m.kind, m.content, m.importance,
                  m.active, m.superseded_by, m.last_confirmed_at, m.expires_at, m.created_at, m.updated_at,
                  COUNT(mt.term) AS matched_terms
           FROM memories m
           LEFT JOIN memory_terms mt ON mt.memory_id = m.id AND mt.term IN (${placeholders})
           WHERE ${scopeSql}
           GROUP BY m.id
           HAVING matched_terms > 0 OR m.importance >= 0.8
           ORDER BY (matched_terms * (0.75 + m.importance)) DESC, m.importance DESC, m.updated_at DESC
           LIMIT ?`,
        )
        .all(...terms, now, conversationId, personId, conversationId, limit) as unknown as MemoryRow[];
    }

    if (rows.length > 0) {
      const placeholders = rows.map(() => "?").join(", ");
      this.#database
        .prepare(`UPDATE memories SET last_accessed_at = ? WHERE id IN (${placeholders})`)
        .run(Date.now(), ...rows.map((row) => row.id));
    }
    return rows.map(toMemoryRecord);
  }

  /** Lists all visible active memories for semantic indexing in one conversation. */
  listMemoriesForEmbedding(conversationId: string, personId: string, limit = 500): MemoryRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, kind, content, importance, active, superseded_by,
                last_confirmed_at, expires_at, created_at, updated_at
         FROM memories
         WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) AND (
           scope = 'global'
           OR (scope = 'conversation' AND scope_id = ?)
           OR (scope = 'person' AND scope_id = ? AND conversation_id = ?)
         )
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(
        Date.now(),
        conversationId,
        personId,
        conversationId,
        integerBetween(limit, 1, 2000, "memory embedding limit"),
      ) as unknown as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  getMemoryEmbedding(memoryId: string, model: string): number[] | undefined {
    const row = this.#database
      .prepare("SELECT memory_id, model, dimensions, vector FROM memory_embeddings WHERE memory_id = ? AND model = ?")
      .get(memoryId, model) as unknown as MemoryEmbeddingRow | undefined;
    if (!row || !Number.isSafeInteger(row.dimensions) || row.dimensions <= 0) return undefined;
    const bytes = row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector as unknown as ArrayBuffer);
    if (bytes.byteLength !== row.dimensions * Float32Array.BYTES_PER_ELEMENT) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = new Array<number>(row.dimensions);
    for (let index = 0; index < row.dimensions; index += 1) {
      const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
      if (!Number.isFinite(value)) return undefined;
      values[index] = value;
    }
    return values;
  }

  saveMemoryEmbedding(memoryId: string, model: string, vector: readonly number[]): void {
    const normalizedModel = model.normalize("NFKC").trim();
    if (!normalizedModel) throw new Error("Memory embedding model cannot be empty");
    if (vector.length === 0 || vector.length > 16_384) throw new Error("Memory embedding dimensions are invalid");
    const floats = new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index += 1) {
      const value = Number(vector[index]);
      if (!Number.isFinite(value)) throw new Error("Memory embedding contains a non-finite value");
      floats[index] = value;
    }
    const bytes = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
    const now = Date.now();
    this.#database
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, model, dimensions, vector, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET
           dimensions = excluded.dimensions,
           vector = excluded.vector,
           updated_at = excluded.updated_at`,
      )
      .run(memoryId, normalizedModel, floats.length, bytes, now, now);
  }

  getImageUnderstandingCache(assetId: string, sha256?: string): {
    assetId: string;
    sha256: string;
    evidence: string;
    model?: string;
    createdAt: number;
  } | undefined {
    const normalizedAssetId = assetId.normalize("NFKC").trim();
    const normalizedSha256 = sha256?.trim().toLocaleLowerCase();
    if (!normalizedAssetId) return undefined;
    const row = (normalizedSha256 && /^[a-f\d]{64}$/u.test(normalizedSha256)
      ? this.#database.prepare(
          `SELECT asset_id, content_sha256, evidence, model, created_at
           FROM image_understanding_cache
           WHERE asset_id = ? OR content_sha256 = ?
           ORDER BY CASE WHEN asset_id = ? THEN 0 ELSE 1 END, last_accessed_at DESC
           LIMIT 1`,
        ).get(normalizedAssetId, normalizedSha256, normalizedAssetId)
      : this.#database.prepare(
          `SELECT asset_id, content_sha256, evidence, model, created_at
           FROM image_understanding_cache WHERE asset_id = ? LIMIT 1`,
        ).get(normalizedAssetId)) as unknown as ImageUnderstandingCacheRow | undefined;
    if (!row) return undefined;
    this.#database.prepare("UPDATE image_understanding_cache SET last_accessed_at = ? WHERE asset_id = ?")
      .run(Date.now(), row.asset_id);
    return {
      assetId: row.asset_id,
      sha256: row.content_sha256,
      evidence: row.evidence,
      ...(row.model ? { model: row.model } : {}),
      createdAt: row.created_at,
    };
  }

  saveImageUnderstandingCache(input: {
    assetId: string;
    sha256: string;
    evidence: string;
    model?: string;
  }): void {
    const assetId = input.assetId.normalize("NFKC").trim();
    const sha256 = input.sha256.trim().toLocaleLowerCase();
    const evidence = input.evidence.normalize("NFKC").trim();
    if (!assetId || !/^[a-f\d]{64}$/u.test(sha256) || !evidence) return;
    const now = Date.now();
    this.#database.prepare(
      `INSERT INTO image_understanding_cache
         (asset_id, content_sha256, evidence, model, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         content_sha256 = excluded.content_sha256,
         evidence = excluded.evidence,
         model = excluded.model,
         last_accessed_at = excluded.last_accessed_at`,
    ).run(assetId, sha256, evidence.slice(0, 8_000), input.model?.trim() || null, now, now);
    this.#database.prepare(
      `DELETE FROM image_understanding_cache
       WHERE asset_id IN (
         SELECT asset_id FROM image_understanding_cache
         ORDER BY last_accessed_at DESC LIMIT -1 OFFSET 2000
       )`,
    ).run();
  }

  setBehavior(input: SetBehaviorInput): BehaviorRule {
    const rule = normalizeBehavior(input.rule);
    if (!rule) throw new Error("Behavior rule cannot be empty");
    if (!input.scopeId.trim() || !input.conversationId.trim()) throw new Error("Behavior scope cannot be empty");
    const fingerprint = behaviorFingerprint(input.scope, input.scopeId, input.conversationId, rule);
    const existing = this.#database.prepare("SELECT id, active FROM behavior_rules WHERE fingerprint = ?").get(fingerprint) as
      | { id: string; active: number }
      | undefined;
    const now = Date.now();
    if (existing) {
      this.#transaction(() => {
        this.#database
          .prepare("UPDATE behavior_rules SET active = 1, superseded_by = NULL, updated_at = ? WHERE id = ?")
          .run(now, existing.id);
        if (existing.active === 0) {
          this.#insertAudit({
            conversationId: input.conversationId,
            entityType: "behavior",
            entityId: existing.id,
            action: "restored",
            ...(input.actorId ? { actorId: input.actorId } : {}),
            ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
            afterValue: rule,
          });
        }
      });
      return this.#getBehavior(existing.id)!;
    }

    const id = `behavior:${randomUUID()}`;
    this.#transaction(() => {
      this.#insertBehaviorRow({ id, ...input, rule, fingerprint, now });
      this.#insertAudit({
        conversationId: input.conversationId,
        entityType: "behavior",
        entityId: id,
        action: "saved",
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        afterValue: rule,
      });
    });
    return this.#getBehavior(id)!;
  }

  reviseBehavior(input: {
    behaviorId: string;
    conversationId: string;
    actorId: string;
    sourceEventId: string;
    rule: string;
    reason: string;
    canManageConversation: boolean;
  }): BehaviorRule {
    const current = this.#getBehaviorRow(input.behaviorId);
    if (!current || current.active !== 1) throw new Error("Active behavior rule not found");
    this.#assertBehaviorEditable(current, input.conversationId, input.actorId, input.canManageConversation);
    const rule = normalizeBehavior(input.rule);
    if (!rule) throw new Error("Corrected behavior rule cannot be empty");
    const fingerprint = behaviorFingerprint(current.scope, current.scope_id, current.conversation_id, rule);
    const same = this.#database.prepare("SELECT id, active FROM behavior_rules WHERE fingerprint = ?").get(fingerprint) as
      | { id: string; active: number }
      | undefined;
    if (same?.id === current.id) return toBehaviorRule(current);

    const replacementId = same?.id ?? `behavior:${randomUUID()}`;
    const now = Date.now();
    this.#transaction(() => {
      if (same) {
        this.#database
          .prepare("UPDATE behavior_rules SET active = 1, superseded_by = NULL, updated_at = ? WHERE id = ?")
          .run(now, replacementId);
      } else {
        this.#insertBehaviorRow({
          id: replacementId,
          scope: current.scope,
          scopeId: current.scope_id,
          conversationId: current.conversation_id,
          rule,
          sourceEventId: input.sourceEventId,
          actorId: input.actorId,
          fingerprint,
          now,
        });
      }
      this.#database
        .prepare("UPDATE behavior_rules SET active = 0, superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(replacementId, now, current.id);
      this.#insertAudit({
        conversationId: input.conversationId,
        entityType: "behavior",
        entityId: current.id,
        action: "corrected",
        actorId: input.actorId,
        sourceEventId: input.sourceEventId,
        beforeValue: current.rule,
        afterValue: rule,
        reason: input.reason,
      });
    });
    return this.#getBehavior(replacementId)!;
  }

  forgetBehavior(input: {
    behaviorId: string;
    conversationId: string;
    actorId: string;
    sourceEventId: string;
    reason: string;
    canManageConversation: boolean;
  }): void {
    const current = this.#getBehaviorRow(input.behaviorId);
    if (!current || current.active !== 1) throw new Error("Active behavior rule not found");
    this.#assertBehaviorEditable(current, input.conversationId, input.actorId, input.canManageConversation);
    this.#transaction(() => {
      this.#database.prepare("UPDATE behavior_rules SET active = 0, updated_at = ? WHERE id = ?").run(Date.now(), current.id);
      this.#insertAudit({
        conversationId: input.conversationId,
        entityType: "behavior",
        entityId: current.id,
        action: "forgotten",
        actorId: input.actorId,
        sourceEventId: input.sourceEventId,
        beforeValue: current.rule,
        reason: input.reason,
      });
    });
  }

  getBehaviorRules(conversationId: string, personId: string, limit: number): BehaviorRule[] {
    const rows = this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, rule, active, superseded_by, created_at, updated_at
         FROM behavior_rules
         WHERE active = 1 AND conversation_id = ?
           AND ((scope = 'conversation' AND scope_id = ?) OR (scope = 'person' AND scope_id = ?))
         ORDER BY CASE scope WHEN 'person' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT ?`,
      )
      .all(conversationId, conversationId, personId, limit) as unknown as BehaviorRow[];
    return rows.map(toBehaviorRule);
  }

  listConversationBehaviorRules(conversationId: string, limit = 500): BehaviorRule[] {
    const rows = this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, rule, active, superseded_by, created_at, updated_at
         FROM behavior_rules
         WHERE active = 1 AND conversation_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(conversationId, integerBetween(limit, 1, 2000, "conversation behavior limit")) as unknown as BehaviorRow[];
    return rows.map(toBehaviorRule);
  }

  hasConversationBehaviorHistory(conversationId: string): boolean {
    const row = this.#database.prepare(
      "SELECT 1 AS found FROM behavior_rules WHERE conversation_id = ? LIMIT 1",
    ).get(conversationId) as { found: number } | undefined;
    return row?.found === 1;
  }

  listLearningAudit(conversationId: string, limit: number): LearningAuditRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, conversation_id, entity_type, entity_id, action, actor_id, source_event_id,
                before_value, after_value, reason, created_at
         FROM learning_audit WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as LearningAuditRow[];
    return rows.map(toLearningAuditRecord);
  }

  recordParticipationCase(input: {
    event: InboundMessageEvent;
    context: StoredMessage[];
    activation: GroupActivation;
    decision: { respond: boolean; reason: string };
  }): void {
    if (input.event.conversation.kind !== "group") return;
    const now = Date.now();
    const messageText = eventText(input.event).slice(0, 4000);
    const context = input.context.slice(-12).map((message) => ({
      ...message,
      text: message.text.slice(0, 1000),
    }));
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO participation_cases
             (event_id, sample_fingerprint, conversation_id, conversation_title, sender_id, sender_name, message_text,
              context_json, activation, policy_respond, policy_reason, model_used, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(
          input.event.id,
          participationSampleFingerprint(input.event, messageText),
          input.event.conversation.id,
          input.event.conversation.title ?? null,
          input.event.sender.id,
          input.event.sender.displayName,
          messageText,
          JSON.stringify(context),
          input.activation,
          input.decision.respond ? 1 : 0,
          input.decision.reason,
          now,
          now,
        );
      const insert = this.#database.prepare(
        "INSERT OR IGNORE INTO participation_case_terms (event_id, term) VALUES (?, ?)",
      );
      for (const term of extractSearchTerms(messageText)) insert.run(input.event.id, term);
    });
  }

  markParticipationModelUsed(eventId: string): void {
    this.#database
      .prepare("UPDATE participation_cases SET model_used = 1, updated_at = ? WHERE event_id = ?")
      .run(Date.now(), eventId);
  }

  completeParticipationCase(eventId: string, outcome: ParticipationOutcome, replyText?: string): void {
    this.#database
      .prepare(
        `UPDATE participation_cases SET outcome = ?, reply_text = ?, updated_at = ? WHERE event_id = ?`,
      )
      .run(outcome, replyText?.slice(0, 4000) ?? null, Date.now(), eventId);
  }

  listParticipationCases(query: ParticipationCaseQuery = {}): ParticipationCase[] {
    const limit = integerBetween(query.limit ?? 50, 1, 200, "participation case limit");
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.conversationId?.trim()) {
      clauses.push("conversation_id = ?");
      values.push(query.conversationId.trim());
    }
    const review = query.review ?? "all";
    if (review === "unrated") clauses.push("admin_label IS NULL");
    else if (review !== "all") {
      clauses.push("admin_label = ?");
      values.push(review);
    }
    const qualityReview = query.qualityReview ?? "all";
    if (qualityReview === "unrated") clauses.push("admin_quality_label IS NULL AND reply_text IS NOT NULL");
    else if (qualityReview !== "all") {
      clauses.push("admin_quality_label = ?");
      values.push(qualityReview);
    }
    if (query.beforeCreatedAt !== undefined) {
      clauses.push("created_at < ?");
      values.push(integerBetween(query.beforeCreatedAt, 1, Number.MAX_SAFE_INTEGER, "beforeCreatedAt"));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database
      .prepare(
        `SELECT event_id, sample_fingerprint, conversation_id, conversation_title, sender_id, sender_name, message_text,
                context_json, activation, policy_respond, policy_reason, model_used, outcome, reply_text,
                implicit_label, implicit_reason, implicit_source_event_id, admin_label, admin_reason,
                admin_labeled_at, implicit_quality_label, implicit_quality_reason, implicit_quality_source_event_id,
                admin_quality_label, admin_quality_reason, admin_quality_labeled_at, created_at, updated_at
         FROM participation_cases ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...values, limit) as unknown as ParticipationCaseRow[];
    return rows.map(toParticipationCase);
  }

  participationSummary(): ParticipationSummary {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN admin_label IS NULL THEN 1 ELSE 0 END) AS unrated,
                SUM(CASE WHEN admin_label = 'speak' THEN 1 ELSE 0 END) AS speak,
                SUM(CASE WHEN admin_label = 'silent' THEN 1 ELSE 0 END) AS silent,
                SUM(CASE WHEN admin_label = 'unsure' THEN 1 ELSE 0 END) AS unsure,
                SUM(CASE WHEN implicit_label = 'speak' THEN 1 ELSE 0 END) AS implicit_positive,
                SUM(CASE WHEN implicit_label = 'silent' THEN 1 ELSE 0 END) AS implicit_negative,
                SUM(CASE WHEN admin_quality_label = 'helpful' THEN 1 ELSE 0 END) AS helpful,
                SUM(CASE WHEN admin_quality_label = 'unhelpful' THEN 1 ELSE 0 END) AS unhelpful,
                SUM(CASE WHEN admin_quality_label = 'unsure' THEN 1 ELSE 0 END) AS quality_unsure,
                SUM(CASE WHEN implicit_quality_label = 'helpful' THEN 1 ELSE 0 END) AS implicit_helpful,
                SUM(CASE WHEN implicit_quality_label = 'unhelpful' THEN 1 ELSE 0 END) AS implicit_unhelpful
         FROM participation_cases`,
      )
      .get() as Record<string, number | null>;
    return {
      total: row.total ?? 0,
      unrated: row.unrated ?? 0,
      speak: row.speak ?? 0,
      silent: row.silent ?? 0,
      unsure: row.unsure ?? 0,
      implicitPositive: row.implicit_positive ?? 0,
      implicitNegative: row.implicit_negative ?? 0,
      helpful: row.helpful ?? 0,
      unhelpful: row.unhelpful ?? 0,
      qualityUnsure: row.quality_unsure ?? 0,
      implicitHelpful: row.implicit_helpful ?? 0,
      implicitUnhelpful: row.implicit_unhelpful ?? 0,
    };
  }

  pruneParticipationCases(retentionDays: number, maxCases: number): { deleted: number } {
    const days = integerBetween(retentionDays, 1, 3650, "participation retention days");
    const maximum = integerBetween(maxCases, 1000, 1_000_000, "maximum participation cases");
    const cutoff = Date.now() - days * 24 * 60 * 60_000;
    const expired = this.#database
      .prepare("DELETE FROM participation_cases WHERE admin_label IS NULL AND created_at < ?")
      .run(cutoff).changes;
    const total = (this.#database.prepare("SELECT COUNT(*) AS count FROM participation_cases").get() as { count: number }).count;
    const excess = Math.max(0, total - maximum);
    const overflow = excess === 0
      ? 0
      : this.#database
          .prepare(
            `DELETE FROM participation_cases WHERE event_id IN (
               SELECT event_id FROM participation_cases
               WHERE admin_label IS NULL ORDER BY created_at ASC LIMIT ?
             )`,
          )
          .run(excess).changes;
    return { deleted: Number(expired) + Number(overflow) };
  }

  labelParticipationCase(eventId: string, label: ParticipationLabel, reason?: string): ParticipationCase {
    const normalizedReason = reason?.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500) || null;
    const result = this.#database
      .prepare(
        `UPDATE participation_cases
         SET admin_label = ?, admin_reason = ?, admin_labeled_at = ?, updated_at = ?
         WHERE event_id = ?`,
      )
      .run(label, normalizedReason, Date.now(), Date.now(), eventId);
    if (result.changes !== 1) throw new Error(`Participation case ${eventId} does not exist`);
    const row = this.#database
      .prepare(
        `SELECT event_id, sample_fingerprint, conversation_id, conversation_title, sender_id, sender_name, message_text,
                context_json, activation, policy_respond, policy_reason, model_used, outcome, reply_text,
                implicit_label, implicit_reason, implicit_source_event_id, admin_label, admin_reason,
                admin_labeled_at, implicit_quality_label, implicit_quality_reason, implicit_quality_source_event_id,
                admin_quality_label, admin_quality_reason, admin_quality_labeled_at, created_at, updated_at
         FROM participation_cases WHERE event_id = ?`,
      )
      .get(eventId) as unknown as ParticipationCaseRow;
    return toParticipationCase(row);
  }

  labelReplyQualityCase(eventId: string, label: ReplyQualityLabel, reason?: string): ParticipationCase {
    const normalizedReason = reason?.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500) || null;
    const result = this.#database
      .prepare(
        `UPDATE participation_cases
         SET admin_quality_label = ?, admin_quality_reason = ?, admin_quality_labeled_at = ?, updated_at = ?
         WHERE event_id = ?`,
      )
      .run(label, normalizedReason, Date.now(), Date.now(), eventId);
    if (result.changes !== 1) throw new Error(`Participation case ${eventId} does not exist`);
    const row = this.#database
      .prepare(
        `SELECT event_id, sample_fingerprint, conversation_id, conversation_title, sender_id, sender_name, message_text,
                context_json, activation, policy_respond, policy_reason, model_used, outcome, reply_text,
                implicit_label, implicit_reason, implicit_source_event_id, admin_label, admin_reason,
                admin_labeled_at, implicit_quality_label, implicit_quality_reason, implicit_quality_source_event_id,
                admin_quality_label, admin_quality_reason, admin_quality_labeled_at, created_at, updated_at
         FROM participation_cases WHERE event_id = ?`,
      )
      .get(eventId) as unknown as ParticipationCaseRow;
    return toParticipationCase(row);
  }

  participationGuidance(
    conversationId: string,
    text: string,
  ): { label: "speak" | "silent"; confidence: number; evidence: number } | undefined {
    const terms = extractSearchTerms(text).slice(0, 24);
    if (terms.length < 2) return undefined;
    const placeholders = terms.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT pc.admin_label AS label, COUNT(DISTINCT pct.term) AS matched_terms,
                (SELECT COUNT(*) FROM participation_case_terms all_terms WHERE all_terms.event_id = pc.event_id) AS total_terms
         FROM participation_cases pc
         JOIN participation_case_terms pct ON pct.event_id = pc.event_id AND pct.term IN (${placeholders})
         WHERE pc.conversation_id = ? AND pc.admin_label IN ('speak', 'silent')
         GROUP BY pc.sample_fingerprint, pc.admin_label
         ORDER BY matched_terms DESC, pc.admin_labeled_at DESC
         LIMIT 12`,
      )
      .all(...terms, conversationId) as unknown as Array<{
        label: "speak" | "silent";
        matched_terms: number;
        total_terms: number;
      }>;
    const evidence = rows
      .map((row) => ({
        label: row.label,
        similarity: row.matched_terms / Math.max(2, Math.min(terms.length, row.total_terms)),
        matchedTerms: row.matched_terms,
      }))
      .filter((row) => row.matchedTerms >= 2 && row.similarity >= 0.5);
    if (evidence.length === 0) return undefined;
    const score = evidence.reduce((sum, item) => sum + (item.label === "speak" ? 1 : -1) * item.similarity, 0);
    const magnitude = evidence.reduce((sum, item) => sum + item.similarity, 0);
    const strongest = Math.max(...evidence.map((item) => item.similarity));
    if (strongest < 0.85 && (evidence.length < 2 || Math.abs(score) < 0.9)) return undefined;
    const confidence = Math.min(1, Math.abs(score) / Math.max(1, magnitude));
    if (confidence < 0.55) return undefined;
    return { label: score >= 0 ? "speak" : "silent", confidence, evidence: evidence.length };
  }

  participationFeedbackTarget(
    conversationId: string,
    replyToMessageId: string | undefined,
    since: number,
  ): string | undefined {
    if (replyToMessageId) {
      const direct = this.#database
        .prepare(
          `SELECT pc.event_id
           FROM messages m JOIN participation_cases pc ON pc.event_id = m.source_event_id
           WHERE m.id = ? AND m.conversation_id = ? AND m.direction = 'outbound' AND pc.outcome = 'replied'`,
        )
        .get(replyToMessageId, conversationId) as { event_id: string } | undefined;
      if (direct) return direct.event_id;
    }
    const recent = this.#database
      .prepare(
        `SELECT event_id FROM participation_cases
         WHERE conversation_id = ? AND outcome = 'replied' AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(conversationId, since) as { event_id: string } | undefined;
    return recent?.event_id;
  }

  recordParticipationFeedback(input: {
    eventId: string;
    label: "speak" | "silent";
    reason: string;
    sourceEventId: string;
  }): void {
    this.#database
      .prepare(
        `UPDATE participation_cases
         SET implicit_label = ?, implicit_reason = ?, implicit_source_event_id = ?, updated_at = ?
         WHERE event_id = ?`,
      )
      .run(input.label, input.reason.slice(0, 500), input.sourceEventId, Date.now(), input.eventId);
  }

  recordReplyQualityFeedback(input: {
    eventId: string;
    label: "helpful" | "unhelpful";
    reason: string;
    sourceEventId: string;
  }): void {
    this.#database
      .prepare(
        `UPDATE participation_cases
         SET implicit_quality_label = ?, implicit_quality_reason = ?, implicit_quality_source_event_id = ?, updated_at = ?
         WHERE event_id = ?`,
      )
      .run(input.label, input.reason.slice(0, 500), input.sourceEventId, Date.now(), input.eventId);
  }

  searchHistory(conversationId: string, query: string, limit: number): StoredMessage[] {
    const terms = extractSearchTerms(query);
    if (terms.length === 0) return [];
    const placeholders = terms.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT m.sequence, m.id, m.conversation_id, m.direction, m.sender_id, m.sender_name,
                m.text, m.timestamp, m.reply_to_message_id, m.source_event_id, m.transport_message_id,
                COUNT(mt.term) AS matched_terms
         FROM messages m
         JOIN message_terms mt ON mt.message_sequence = m.sequence
         WHERE m.conversation_id = ? AND mt.term IN (${placeholders})
         GROUP BY m.sequence
         ORDER BY matched_terms DESC, m.sequence DESC
         LIMIT ?`,
      )
      .all(conversationId, ...terms, limit) as unknown as MessageRow[];
    return rows.map(toStoredMessage);
  }

  pendingOutbox(limit = 100): OutboundMessageAction[] {
    const rows = this.#database
      .prepare(
        `SELECT id, conversation_id, text, parts_json, reply_to_message_id, created_at
         FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as OutboxRow[];
    return rows.map(toOutboundAction);
  }

  acknowledgeOutbox(actionIds: string[]): void {
    if (actionIds.length === 0) return;
    const placeholders = actionIds.map(() => "?").join(", ");
    this.#database
      .prepare(`UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE id IN (${placeholders})`)
      .run(Date.now(), ...actionIds);
  }

  #insertMemoryRow(
    input: RememberInput & {
      id: string;
      kind: string;
      content: string;
      importance: number;
      fingerprint: string;
      now: number;
    },
  ): void {
    this.#database
      .prepare(
        `INSERT INTO memories
           (id, scope, scope_id, conversation_id, kind, content, importance, fingerprint, active, superseded_by,
            source_event_id, actor_id, created_at, updated_at, last_accessed_at, last_confirmed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.scope,
        input.scopeId,
        input.conversationId ?? null,
        input.kind,
        input.content,
        input.importance,
        input.fingerprint,
        input.sourceEventId ?? null,
        input.actorId ?? null,
        input.now,
        input.now,
        input.now,
        input.now,
        input.expiresAt ?? null,
      );
  }

  #insertBehaviorRow(
    input: SetBehaviorInput & { id: string; rule: string; fingerprint: string; now: number },
  ): void {
    this.#database
      .prepare(
        `INSERT INTO behavior_rules
           (id, scope, scope_id, conversation_id, rule, fingerprint, active, superseded_by,
            source_event_id, actor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.scope,
        input.scopeId,
        input.conversationId,
        input.rule,
        input.fingerprint,
        input.sourceEventId ?? null,
        input.actorId ?? null,
        input.now,
        input.now,
      );
  }

  #getMemoryRow(id: string): MemoryRow | undefined {
    return this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, kind, content, importance, active, superseded_by,
                last_confirmed_at, expires_at, created_at, updated_at FROM memories WHERE id = ?`,
      )
      .get(id) as unknown as MemoryRow | undefined;
  }

  #getBehavior(id: string): BehaviorRule | undefined {
    const row = this.#getBehaviorRow(id);
    return row ? toBehaviorRule(row) : undefined;
  }

  #getBehaviorRow(id: string): BehaviorRow | undefined {
    return this.#database
      .prepare(
        `SELECT id, scope, scope_id, conversation_id, rule, active, superseded_by, created_at, updated_at
         FROM behavior_rules WHERE id = ?`,
      )
      .get(id) as unknown as BehaviorRow | undefined;
  }

  #assertMemoryEditable(memory: MemoryRow, conversationId: string, actorId: string): void {
    if (memory.scope === "global") throw new Error("Global memories cannot be changed from chat");
    if (memory.scope === "conversation" && memory.scope_id === conversationId) return;
    if (memory.scope === "person" && memory.scope_id === actorId && memory.conversation_id === conversationId) return;
    throw new Error("Memory is outside the current speaker's editable scope");
  }

  #assertBehaviorEditable(
    behavior: BehaviorRow,
    conversationId: string,
    actorId: string,
    canManageConversation: boolean,
  ): void {
    if (behavior.conversation_id !== conversationId) throw new Error("Behavior rule belongs to another conversation");
    if (behavior.scope === "person" && behavior.scope_id === actorId) return;
    if (behavior.scope === "conversation" && behavior.scope_id === conversationId && canManageConversation) return;
    throw new Error("Behavior rule is outside the current speaker's editable scope");
  }

  #insertAudit(input: {
    conversationId: string;
    entityType: "memory" | "behavior";
    entityId: string;
    action: "saved" | "corrected" | "forgotten" | "restored";
    actorId?: string;
    sourceEventId?: string;
    beforeValue?: string;
    afterValue?: string;
    reason?: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO learning_audit
           (id, conversation_id, entity_type, entity_id, action, actor_id, source_event_id,
            before_value, after_value, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `audit:${randomUUID()}`,
        input.conversationId,
        input.entityType,
        input.entityId,
        input.action,
        input.actorId ?? null,
        input.sourceEventId ?? null,
        input.beforeValue ?? null,
        input.afterValue ?? null,
        input.reason ?? null,
        Date.now(),
      );
  }

  #outboxForEvent(eventId: string): OutboundMessageAction[] {
    const rows = this.#database
      .prepare(
        `SELECT id, conversation_id, text, parts_json, reply_to_message_id, created_at
         FROM outbox WHERE event_id = ? ORDER BY created_at ASC`,
      )
      .all(eventId) as unknown as OutboxRow[];
    return rows.map(toOutboundAction);
  }

  #getInbox(eventId: string): InboxRow | undefined {
    return this.#database
      .prepare("SELECT event_id, conversation_id, status, trigger_reason FROM inbox WHERE event_id = ?")
      .get(eventId) as unknown as InboxRow | undefined;
  }

  #indexMessage(sequence: number, text: string): void {
    const insert = this.#database.prepare(
      "INSERT OR IGNORE INTO message_terms (message_sequence, term) VALUES (?, ?)",
    );
    for (const term of extractSearchTerms(text)) insert.run(sequence, term);
  }

  #indexMemory(memoryId: string, text: string): void {
    const insert = this.#database.prepare("INSERT OR IGNORE INTO memory_terms (memory_id, term) VALUES (?, ?)");
    for (const term of extractSearchTerms(text)) insert.run(memoryId, term);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (versionRow.user_version > 9) {
      throw new Error(`Database schema ${versionRow.user_version} is newer than supported schema 9`);
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct', 'group')),
        title TEXT,
        activation TEXT CHECK(activation IN ('mention', 'always', 'off')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, sender_id)
      );

      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('received', 'processing', 'done', 'failed')),
        trigger_reason TEXT,
        error TEXT,
        raw_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_conversation_idx ON inbox(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reply_to_message_id TEXT,
        source_event_id TEXT,
        transport_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, sequence);

      CREATE TABLE IF NOT EXISTS conversation_context_resets (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        after_sequence INTEGER NOT NULL,
        after_timestamp INTEGER NOT NULL DEFAULT 0,
        reset_by TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        reset_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_activity_idx ON messages(direction, timestamp, conversation_id);
      CREATE INDEX IF NOT EXISTS messages_conversation_timestamp_idx ON messages(conversation_id, timestamp);

      CREATE TABLE IF NOT EXISTS message_terms (
        message_sequence INTEGER NOT NULL REFERENCES messages(sequence) ON DELETE CASCADE,
        term TEXT NOT NULL,
        PRIMARY KEY (message_sequence, term)
      );
      CREATE INDEX IF NOT EXISTS message_terms_term_idx ON message_terms(term, message_sequence);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'conversation', 'person')),
        scope_id TEXT NOT NULL,
        conversation_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        source_event_id TEXT,
        actor_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        last_confirmed_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope, scope_id, conversation_id, importance DESC);

      CREATE TABLE IF NOT EXISTS memory_terms (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        term TEXT NOT NULL,
        PRIMARY KEY (memory_id, term)
      );
      CREATE INDEX IF NOT EXISTS memory_terms_term_idx ON memory_terms(term, memory_id);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (memory_id, model)
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model, updated_at DESC);

      CREATE TABLE IF NOT EXISTS image_understanding_cache (
        asset_id TEXT PRIMARY KEY,
        content_sha256 TEXT NOT NULL,
        evidence TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS image_understanding_cache_sha_idx
        ON image_understanding_cache(content_sha256, last_accessed_at DESC);

      CREATE TABLE IF NOT EXISTS behavior_rules (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('conversation', 'person')),
        scope_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        source_event_id TEXT,
        actor_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_audit (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('memory', 'behavior')),
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('saved', 'corrected', 'forgotten', 'restored')),
        actor_id TEXT,
        source_event_id TEXT,
        before_value TEXT,
        after_value TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES inbox(event_id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        parts_json TEXT,
        reply_to_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS outbox_event_idx ON outbox(event_id);

      CREATE TABLE IF NOT EXISTS participation_cases (
        event_id TEXT PRIMARY KEY REFERENCES inbox(event_id) ON DELETE CASCADE,
        sample_fingerprint TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        conversation_title TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message_text TEXT NOT NULL,
        context_json TEXT NOT NULL,
        activation TEXT NOT NULL CHECK(activation IN ('mention', 'always', 'off')),
        policy_respond INTEGER NOT NULL,
        policy_reason TEXT NOT NULL,
        model_used INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'ignored', 'silent', 'replied', 'blocked', 'failed')),
        reply_text TEXT,
        implicit_label TEXT CHECK(implicit_label IN ('speak', 'silent')),
        implicit_reason TEXT,
        implicit_source_event_id TEXT,
        admin_label TEXT CHECK(admin_label IN ('speak', 'silent', 'unsure')),
        admin_reason TEXT,
        admin_labeled_at INTEGER,
        implicit_quality_label TEXT CHECK(implicit_quality_label IN ('helpful', 'unhelpful')),
        implicit_quality_reason TEXT,
        implicit_quality_source_event_id TEXT,
        admin_quality_label TEXT CHECK(admin_quality_label IN ('helpful', 'unhelpful', 'unsure')),
        admin_quality_reason TEXT,
        admin_quality_labeled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS participation_cases_review_idx
        ON participation_cases(admin_label, created_at DESC);
      CREATE INDEX IF NOT EXISTS participation_cases_conversation_idx
        ON participation_cases(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS participation_case_terms (
        event_id TEXT NOT NULL REFERENCES participation_cases(event_id) ON DELETE CASCADE,
        term TEXT NOT NULL,
        PRIMARY KEY (event_id, term)
      );
      CREATE INDEX IF NOT EXISTS participation_case_terms_term_idx
        ON participation_case_terms(term, event_id);
    `);

    this.#ensureColumn("memories", "active", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("memories", "superseded_by", "TEXT");
    this.#ensureColumn("memories", "last_confirmed_at", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("memories", "expires_at", "INTEGER");
    this.#ensureColumn("memories", "source_event_id", "TEXT");
    this.#ensureColumn("memories", "actor_id", "TEXT");
    this.#ensureColumn("outbox", "parts_json", "TEXT");
    this.#ensureColumn("participation_cases", "sample_fingerprint", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("participation_cases", "implicit_quality_label", "TEXT CHECK(implicit_quality_label IN ('helpful', 'unhelpful'))");
    this.#ensureColumn("participation_cases", "implicit_quality_reason", "TEXT");
    this.#ensureColumn("participation_cases", "implicit_quality_source_event_id", "TEXT");
    this.#ensureColumn("participation_cases", "admin_quality_label", "TEXT CHECK(admin_quality_label IN ('helpful', 'unhelpful', 'unsure'))");
    this.#ensureColumn("participation_cases", "admin_quality_reason", "TEXT");
    this.#ensureColumn("participation_cases", "admin_quality_labeled_at", "INTEGER");
    this.#ensureColumn("conversation_context_resets", "after_timestamp", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("messages", "transport_message_id", "TEXT");
    this.#database.prepare(
      `UPDATE conversation_context_resets
       SET after_timestamp = MAX(0, CAST(reset_at / 1000 AS INTEGER) * 1000 - 1)
       WHERE after_timestamp = 0 AND reset_at > 0`,
    ).run();
    this.#database.prepare("UPDATE participation_cases SET sample_fingerprint = event_id WHERE sample_fingerprint = ''").run();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS memories_active_scope_idx
        ON memories(active, scope, scope_id, conversation_id, importance DESC);
      CREATE INDEX IF NOT EXISTS behavior_rules_active_scope_idx
        ON behavior_rules(active, conversation_id, scope, scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS learning_audit_conversation_idx
        ON learning_audit(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS participation_cases_sample_idx
        ON participation_cases(sample_fingerprint, created_at DESC);
      UPDATE memories SET last_confirmed_at = updated_at WHERE last_confirmed_at = 0;
      CREATE INDEX IF NOT EXISTS memories_expiry_idx ON memories(active, expires_at);
      CREATE INDEX IF NOT EXISTS messages_transport_message_idx
        ON messages(conversation_id, transport_message_id)
        WHERE direction = 'inbound' AND transport_message_id IS NOT NULL;
      PRAGMA user_version = 9;
    `);
  }

  #ensureColumn(
    table: "memories" | "messages" | "outbox" | "participation_cases" | "conversation_context_resets",
    column: string,
    definition: string,
  ): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function contextResetTimestampCutoff(resetAt: number): number {
  return Math.max(0, Math.floor(resetAt / 1000) * 1000 - 1);
}

function eventText(event: InboundMessageEvent): string {
  return [
    event.text,
    ...renderMessageParts(event.parts, !event.text.trim()),
    ...renderLegacyAttachments(event.attachments),
  ]
    .filter(Boolean)
    .join("\n");
}

function participationSampleFingerprint(event: InboundMessageEvent, messageText: string): string {
  const timeBucket = Math.floor((event.timestamp ?? Date.now()) / 5000);
  const normalizedText = messageText.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return createHash("sha256")
    // Transport event ids can differ for the same provider-side message. Keep those ids
    // in each bot's audit trail, but exclude them from the shared learning identity.
    .update(`${event.conversation.id}\u0000${event.sender.id}\u0000${timeBucket}\u0000${normalizedText}`)
    .digest("hex");
}

function normalizeMemory(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function normalizeBehavior(rule: string): string {
  return rule.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500);
}

function memoryFingerprint(
  scope: MemoryScope,
  scopeId: string,
  conversationId: string | undefined,
  kind: string,
  content: string,
): string {
  return createHash("sha256")
    .update(`${scope}\u0000${scopeId}\u0000${conversationId ?? ""}\u0000${kind}\u0000${content.toLocaleLowerCase()}`)
    .digest("hex");
}

function behaviorFingerprint(scope: BehaviorScope, scopeId: string, conversationId: string, rule: string): string {
  return createHash("sha256")
    .update(`${scope}\u0000${scopeId}\u0000${conversationId}\u0000${rule.toLocaleLowerCase()}`)
    .digest("hex");
}

function memoryConversationId(scope: MemoryScope, scopeId: string, conversationId: string | undefined): string {
  if (conversationId) return conversationId;
  return scope === "conversation" ? scopeId : "__global__";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function validatedMemoryExpiry(value: number | undefined, now: number): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= now || value > now + 10 * 365 * 24 * 60 * 60_000) {
    throw new Error("Memory expiry must be a future timestamp within ten years");
  }
  return value;
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    sequence: row.sequence,
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    timestamp: row.timestamp,
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    ...(row.transport_message_id ? { transportMessageId: row.transport_message_id } : {}),
  };
}

function toGroupActivitySummary(row: {
  conversation_id: string;
  conversation_title: string | null;
  inbound_messages: number;
  active_members: number;
  last_message_at: number;
}): GroupActivitySummary {
  return {
    conversationId: row.conversation_id,
    ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
    inboundMessages: Number(row.inbound_messages),
    activeMembers: Number(row.active_members),
    lastMessageAt: Number(row.last_message_at),
  };
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    lastConfirmedAt: row.last_confirmed_at || row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBehaviorRule(row: BehaviorRow): BehaviorRule {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    conversationId: row.conversation_id,
    rule: row.rule,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLearningAuditRecord(row: LearningAuditRow): LearningAuditRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    ...(row.before_value ? { beforeValue: row.before_value } : {}),
    ...(row.after_value ? { afterValue: row.after_value } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
  };
}

function toParticipationCase(row: ParticipationCaseRow): ParticipationCase {
  let context: StoredMessage[] = [];
  try {
    const parsed: unknown = JSON.parse(row.context_json);
    if (Array.isArray(parsed)) context = parsed as StoredMessage[];
  } catch {
    // A malformed snapshot must not hide the review case itself.
  }
  return {
    eventId: row.event_id,
    sampleFingerprint: row.sample_fingerprint,
    conversationId: row.conversation_id,
    ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
    senderId: row.sender_id,
    senderName: row.sender_name,
    messageText: row.message_text,
    context,
    activation: row.activation,
    policyRespond: row.policy_respond === 1,
    policyReason: row.policy_reason,
    modelUsed: row.model_used === 1,
    outcome: row.outcome,
    ...(row.reply_text ? { replyText: row.reply_text } : {}),
    ...(row.implicit_label ? { implicitLabel: row.implicit_label } : {}),
    ...(row.implicit_reason ? { implicitReason: row.implicit_reason } : {}),
    ...(row.implicit_source_event_id ? { implicitSourceEventId: row.implicit_source_event_id } : {}),
    ...(row.admin_label ? { adminLabel: row.admin_label } : {}),
    ...(row.admin_reason ? { adminReason: row.admin_reason } : {}),
    ...(row.admin_labeled_at ? { adminLabeledAt: row.admin_labeled_at } : {}),
    ...(row.implicit_quality_label ? { implicitQualityLabel: row.implicit_quality_label } : {}),
    ...(row.implicit_quality_reason ? { implicitQualityReason: row.implicit_quality_reason } : {}),
    ...(row.implicit_quality_source_event_id ? { implicitQualitySourceEventId: row.implicit_quality_source_event_id } : {}),
    ...(row.admin_quality_label ? { adminQualityLabel: row.admin_quality_label } : {}),
    ...(row.admin_quality_reason ? { adminQualityReason: row.admin_quality_reason } : {}),
    ...(row.admin_quality_labeled_at ? { adminQualityLabeledAt: row.admin_quality_labeled_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOutboundAction(row: OutboxRow): OutboundMessageAction {
  const parts = parseMessageParts(row.parts_json);
  return {
    id: row.id,
    type: "message",
    conversationId: row.conversation_id,
    text: row.text,
    ...(parts ? { parts } : {}),
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  };
}

function parseMessageParts(value: string | null): MessagePart[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const parts = parsed as MessagePart[];
    validateMessageParts(parts);
    return parts;
  } catch {
    return undefined;
  }
}

function integerBetween(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
