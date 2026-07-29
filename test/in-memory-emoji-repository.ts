import { randomUUID } from "node:crypto";
import type { EmojiRecord, EmojiRepository } from "../src/emoji-library.js";

export class InMemoryEmojiRepository implements EmojiRepository {
  readonly #records = new Map<string, EmojiRecord>();

  listEmojis(botId?: string): EmojiRecord[] {
    return [...this.#records.values()].filter((record) => !botId || record.botId === botId);
  }

  getEmoji(id: string): EmojiRecord | undefined {
    return this.#records.get(id);
  }

  saveCollectedEmoji(input: Parameters<EmojiRepository["saveCollectedEmoji"]>[0]): {
    emoji: EmojiRecord;
    created: boolean;
  } {
    const existing = this.listEmojis(input.botId).find((record) => record.sha256 === input.sha256);
    if (existing) return { emoji: existing, created: false };
    const now = Date.now();
    const emoji: EmojiRecord = {
      id: randomUUID(),
      botId: input.botId,
      asset: input.asset,
      sha256: input.sha256,
      description: "",
      status: "analyzing",
      enabled: true,
      isThinking: false,
      sourceConversationId: input.sourceConversationId,
      sourceSenderId: input.sourceSenderId,
      sourceMessageId: input.sourceMessageId,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(emoji.id, emoji);
    return { emoji, created: true };
  }

  completeEmojiAnalysis(id: string, description: string): EmojiRecord {
    const { error: _error, ...existing } = this.#required(id);
    const updated = { ...existing, description, status: "ready" as const, updatedAt: Date.now() };
    this.#records.set(id, updated);
    return updated;
  }

  failEmojiAnalysis(id: string, error: string): EmojiRecord {
    return this.#update(id, { status: "failed", error });
  }

  markEmojiUsed(id: string): void {
    const existing = this.#required(id);
    this.#records.set(id, {
      ...existing,
      useCount: existing.useCount + 1,
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  #update(id: string, patch: Partial<EmojiRecord>): EmojiRecord {
    const updated = { ...this.#required(id), ...patch, updatedAt: Date.now() };
    this.#records.set(id, updated);
    return updated;
  }

  #required(id: string): EmojiRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown emoji: ${id}`);
    return record;
  }
}
