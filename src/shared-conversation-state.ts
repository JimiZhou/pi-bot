import { createHash } from "node:crypto";
import { replaceTransportIds, safeGroupDisplayName } from "./display-name.js";
import { SqliteStore } from "./sqlite-store.js";
import type {
  BehaviorRule,
  BotIdentity,
  InboundMessageEvent,
  MemoryRecord,
  StoredMessage,
} from "./types.js";

/**
 * Bot-independent group history and learned state. Channel inbox/outbox data
 * remains isolated per bot; only social context lives here for failover.
 */
export class SharedConversationState {
  readonly store: SqliteStore;
  readonly #conversationIdResolver: (value: string) => string;
  readonly #identityIdResolver: (value: string) => string;

  constructor(databasePath: string, options: SharedConversationStateOptions = {}) {
    this.store = new SqliteStore(databasePath);
    this.#conversationIdResolver = options.conversationIdResolver ?? identity;
    this.#identityIdResolver = options.identityIdResolver ?? identity;
  }

  close(): void {
    this.store.close();
  }

  hasConversation(conversationId: string): boolean {
    return this.store.getRecent(this.#conversationIdResolver(conversationId), 1).length > 0;
  }

  prepareInbound(event: InboundMessageEvent): InboundMessageEvent | undefined {
    if (event.conversation.kind !== "group") return undefined;
    const mapped = this.mapEvent(event);
    const ingested = this.store.ingest(mapped);
    this.store.preserveMessageSourceEventId(mapped.id, event.id);
    if (ingested.inserted) this.store.completeWithoutReply(mapped.id, "shared-context");
    return mapped;
  }

  mapEvent(event: InboundMessageEvent): InboundMessageEvent {
    if (event.conversation.kind !== "group") return event;
    const conversationId = this.#conversationIdResolver(event.conversation.id);
    const senderId = this.#identityIdResolver(event.sender.id);
    return {
      ...event,
      id: fusedMessageId({
        sourceId: event.id,
        ...(event.transportMessageId ? { transportMessageId: event.transportMessageId } : {}),
        conversationId,
        direction: "inbound",
        senderId: event.sender.id,
        timestamp: event.timestamp ?? Date.now(),
        text: event.text,
      }),
      conversation: {
        ...event.conversation,
        id: conversationId,
      },
      sender: {
        ...event.sender,
        id: senderId,
        displayName: safeGroupDisplayName(event.sender.displayName, senderId),
      },
      ...(event.mentions
        ? { mentions: event.mentions.map((mention) => ({ ...mention, id: this.#identityIdResolver(mention.id) })) }
        : {}),
      ...(event.replyTo
        ? {
            replyTo: {
              ...event.replyTo,
              messageId: fusedReferenceId(
                conversationId,
                event.replyTo.messageId,
                event.replyTo.transportMessageId,
              ),
              ...(event.replyTo.senderId ? { senderId: this.#identityIdResolver(event.replyTo.senderId) } : {}),
            },
          }
        : {}),
    };
  }

  recentBefore(event: InboundMessageEvent, limit: number, bot: BotIdentity): StoredMessage[] {
    const mapped = this.mapEvent(event);
    return this.#forBot(
      this.store.getRecentBefore(mapped.conversation.id, mapped.id, limit),
      mapped.conversation.id,
      bot,
    );
  }

  recent(conversationId: string, limit: number, bot: BotIdentity): StoredMessage[] {
    return this.#forBot(
      this.store.getRecent(this.#conversationIdResolver(conversationId), limit),
      this.#conversationIdResolver(conversationId),
      bot,
    );
  }

  appendOutbound(
    event: InboundMessageEvent,
    bot: BotIdentity,
    sourceMessageId: string,
    text: string,
    timestamp = Date.now(),
  ): boolean {
    if (event.conversation.kind !== "group") return false;
    const mappedInbound = this.mapEvent(event);
    const conversationId = mappedInbound.conversation.id;
    return this.store.appendExternalMessage({
      id: fusedMessageId({
        sourceId: sourceMessageId,
        conversationId,
        direction: "outbound",
        senderId: "shared-bot",
        timestamp,
        text,
      }),
      conversationId,
      ...(event.conversation.title ? { conversationTitle: event.conversation.title } : {}),
      direction: "outbound",
      senderId: "shared-bot",
      senderName: bot.displayName,
      senderIsBot: true,
      text,
      timestamp,
      replyToMessageId: mappedInbound.id,
      sourceEventId: mappedInbound.id,
    });
  }

  importMessage(
    message: StoredMessage,
    sourceConversationId: string,
    conversationTitle?: string,
  ): boolean {
    const conversationId = sourceConversationId;
    const senderId = message.direction === "outbound" ? "shared-bot" : message.senderId;
    return this.store.appendExternalMessage({
      id: fusedMessageId({
        sourceId: message.id,
        conversationId,
        direction: message.direction,
        senderId,
        timestamp: message.timestamp,
        text: message.text,
      }),
      conversationId,
      ...(conversationTitle ? { conversationTitle } : {}),
      direction: message.direction,
      senderId,
      senderName: message.direction === "outbound"
        ? message.senderName
        : safeGroupDisplayName(message.senderName, message.senderId),
      senderIsBot: message.direction === "outbound",
      text: message.text,
      timestamp: message.timestamp,
      ...(message.replyToMessageId
        ? { replyToMessageId: fusedReferenceId(conversationId, message.replyToMessageId) }
        : {}),
      sourceEventId: message.sourceEventId ?? message.id,
      ...(message.transportMessageId ? { transportMessageId: message.transportMessageId } : {}),
    });
  }

  importMemory(memory: MemoryRecord): MemoryRecord {
    const conversationId = this.#conversationIdResolver(memory.conversationId ?? memory.scopeId);
    const scopeId = memory.scope === "conversation" ? conversationId : this.#identityIdResolver(memory.scopeId);
    return this.store.remember({
      scope: memory.scope,
      scopeId,
      ...(memory.scope === "person" ? { conversationId } : {}),
      kind: memory.kind,
      content: memory.content,
      importance: memory.importance,
      actorId: "system:failover-import",
      sourceEventId: `import:${memory.id}`,
    });
  }

  importBehavior(rule: BehaviorRule): BehaviorRule {
    const conversationId = this.#conversationIdResolver(rule.conversationId);
    return this.store.setBehavior({
      scope: rule.scope,
      scopeId: rule.scope === "conversation" ? conversationId : this.#identityIdResolver(rule.scopeId),
      conversationId,
      rule: rule.rule,
      actorId: "system:failover-import",
      sourceEventId: `import:${rule.id}`,
    });
  }

  resetContext(
    conversationId: string,
    actorId: string,
    sourceEventId: string,
  ) {
    return this.store.resetConversationContext(this.#conversationIdResolver(conversationId), this.#identityIdResolver(actorId), sourceEventId);
  }

  contextReset(conversationId: string) {
    return this.store.getConversationContextReset(this.#conversationIdResolver(conversationId));
  }

  #forBot(messages: StoredMessage[], conversationId: string, bot: BotIdentity): StoredMessage[] {
    return messages.map((message) => ({
      ...message,
      conversationId,
      ...(message.direction === "outbound"
        ? { senderId: bot.id, senderName: bot.displayName }
        : {
            senderId: this.#identityIdResolver(message.senderId),
            senderName: safeGroupDisplayName(message.senderName, message.senderId),
            text: replaceTransportIds(message.text),
          }),
    }));
  }
}

export interface SharedConversationStateOptions {
  /** Maps adapter-specific room ids to the bot-independent room id. */
  conversationIdResolver?: (value: string) => string;
  /** Maps adapter-specific member ids to the bot-independent member id. */
  identityIdResolver?: (value: string) => string;
}

function identity(value: string): string {
  return value.normalize("NFKC").trim();
}

export function fusedMessageId(input: {
  sourceId: string;
  transportMessageId?: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  senderId: string;
  timestamp: number;
  text: string;
}): string {
  const identity = input.transportMessageId
    ? `${input.conversationId}\u0000transport:${input.transportMessageId}`
    : [
        input.conversationId,
        input.direction,
        input.sourceId,
      ].join("\u0000");
  return `fusion:message:${createHash("sha256").update(identity).digest("hex")}`;
}

function fusedReferenceId(conversationId: string, sourceId: string, transportMessageId?: string): string {
  if (!transportMessageId) {
    return `fusion:reference:${createHash("sha256").update(`${conversationId}\u0000${sourceId}`).digest("hex")}`;
  }
  return `fusion:message:${createHash("sha256").update(`${conversationId}\u0000transport:${transportMessageId}`).digest("hex")}`;
}
