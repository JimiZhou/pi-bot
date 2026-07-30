import { createHash } from "node:crypto";
import { replaceWechatIds, safeGroupDisplayName } from "./display-name.js";
import { SqliteStore } from "./sqlite-store.js";
/**
 * Bot-independent group history and learned state. Channel inbox/outbox data
 * remains isolated per bot; only social context lives here for failover.
 */
export class SharedConversationState {
    store;
    constructor(databasePath) {
        this.store = new SqliteStore(databasePath);
    }
    close() {
        this.store.close();
    }
    prepareInbound(event) {
        if (event.conversation.kind !== "group")
            return undefined;
        const mapped = this.mapEvent(event);
        const ingested = this.store.ingest(mapped);
        this.store.preserveMessageSourceEventId(mapped.id, event.id);
        if (ingested.inserted)
            this.store.completeWithoutReply(mapped.id, "shared-context");
        return mapped;
    }
    mapEvent(event) {
        if (event.conversation.kind !== "group")
            return event;
        const conversationId = canonicalNativeId(event.conversation.id);
        return {
            ...event,
            id: fusedMessageId({
                sourceId: event.id,
                conversationId,
                direction: "inbound",
                senderId: canonicalNativeId(event.sender.id),
                timestamp: event.timestamp ?? Date.now(),
                text: event.text,
            }),
            conversation: {
                ...event.conversation,
                id: conversationId,
            },
            sender: {
                ...event.sender,
                id: canonicalNativeId(event.sender.id),
                displayName: safeGroupDisplayName(event.sender.displayName, event.sender.id),
            },
            ...(event.mentions
                ? { mentions: event.mentions.map((mention) => ({ ...mention, id: canonicalNativeId(mention.id) })) }
                : {}),
            ...(event.replyTo
                ? {
                    replyTo: {
                        ...event.replyTo,
                        messageId: fusedReferenceId(conversationId, event.replyTo.messageId),
                        ...(event.replyTo.senderId ? { senderId: canonicalNativeId(event.replyTo.senderId) } : {}),
                    },
                }
                : {}),
        };
    }
    recentBefore(event, limit, bot) {
        const mapped = this.mapEvent(event);
        return this.#forBot(this.store.getRecentBefore(mapped.conversation.id, mapped.id, limit), event.conversation.id, bot);
    }
    recent(conversationId, limit, bot) {
        return this.#forBot(this.store.getRecent(canonicalNativeId(conversationId), limit), conversationId, bot);
    }
    appendOutbound(event, bot, sourceMessageId, text, timestamp = Date.now()) {
        if (event.conversation.kind !== "group")
            return false;
        const conversationId = canonicalNativeId(event.conversation.id);
        const mappedInbound = this.mapEvent(event);
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
    importMessage(message, sourceConversationId, conversationTitle) {
        const conversationId = canonicalNativeId(sourceConversationId);
        const senderId = message.direction === "outbound" ? "shared-bot" : canonicalNativeId(message.senderId);
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
        });
    }
    importMemory(memory) {
        const conversationId = canonicalNativeId(memory.conversationId ?? memory.scopeId);
        const scopeId = memory.scope === "conversation" ? conversationId : canonicalNativeId(memory.scopeId);
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
    importBehavior(rule) {
        const conversationId = canonicalNativeId(rule.conversationId);
        return this.store.setBehavior({
            scope: rule.scope,
            scopeId: rule.scope === "conversation" ? conversationId : canonicalNativeId(rule.scopeId),
            conversationId,
            rule: rule.rule,
            actorId: "system:failover-import",
            sourceEventId: `import:${rule.id}`,
        });
    }
    resetContext(conversationId, actorId, sourceEventId) {
        return this.store.resetConversationContext(canonicalNativeId(conversationId), actorId, sourceEventId);
    }
    contextReset(conversationId) {
        return this.store.getConversationContextReset(canonicalNativeId(conversationId));
    }
    #forBot(messages, conversationId, bot) {
        return messages.map((message) => ({
            ...message,
            conversationId,
            ...(message.direction === "outbound"
                ? { senderId: bot.id, senderName: bot.displayName }
                : {
                    senderName: safeGroupDisplayName(message.senderName, message.senderId),
                    text: replaceWechatIds(message.text),
                }),
        }));
    }
}
export function fusedMessageId(input) {
    const nativeMessageId = /:(?:ipadmsg|wxmsg):(.+)$/u.exec(input.sourceId)?.[1];
    const identity = nativeMessageId
        ? `${input.conversationId}\u0000native:${nativeMessageId}`
        : [
            input.conversationId,
            input.direction,
            canonicalNativeId(input.senderId),
            String(Math.floor(input.timestamp / 1000)),
            input.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase(),
        ].join("\u0000");
    return `fusion:message:${createHash("sha256").update(identity).digest("hex")}`;
}
function fusedReferenceId(conversationId, sourceId) {
    const nativeMessageId = /:(?:ipadmsg|wxmsg):(.+)$/u.exec(sourceId)?.[1];
    if (!nativeMessageId)
        return `fusion:reference:${createHash("sha256").update(sourceId).digest("hex")}`;
    return `fusion:message:${createHash("sha256").update(`${conversationId}\u0000native:${nativeMessageId}`).digest("hex")}`;
}
export function canonicalNativeId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
//# sourceMappingURL=shared-conversation-state.js.map