import { createHash } from "node:crypto";
import type { AgentPlugin, AgentPluginContext, AgentPluginFactory, AgentPluginInboundAction } from "../agent-plugin.js";
import type { BotPluginConfig } from "../config.js";
import { safeGroupDisplayName } from "../display-name.js";
import type { InboundMessageEvent } from "../types.js";

interface PatReplySettings {
  replies: string[];
  groupOnly: boolean;
}

/** A deterministic, zero-LLM reply to a normalized nudge directed at this bot. */
export class PatReplyPlugin implements AgentPlugin {
  readonly id: string;
  readonly type = "pat-reply";
  readonly #context: AgentPluginContext;
  readonly #settings: PatReplySettings;

  constructor(config: BotPluginConfig, context: AgentPluginContext) {
    this.id = config.id;
    this.#context = context;
    this.#settings = parseSettings(config.settings);
  }

  handleInbound(event: InboundMessageEvent): AgentPluginInboundAction | undefined {
    if (event.metadata?.interaction !== "pat") return undefined;
    if (!this.#context.isEnabledForConversation(this.type, event.conversation.id)) return undefined;
    if (this.#settings.groupOnly && event.conversation.kind !== "group") return undefined;
    const targetId = typeof event.metadata.interactionTargetId === "string"
      ? event.metadata.interactionTargetId
      : "";
    const isBot = event.metadata.interactionTargetIsBot === true ||
      targetId === this.#context.identityId ||
      targetId.endsWith(`:${this.#context.identityId}`);
    if (!isBot) return undefined;
    const template = deterministicReply(this.#settings.replies, event.id);
    const senderName = safeGroupDisplayName(event.sender.displayName, event.sender.id, "你");
    const text = template.replace(/\{(?:name|sender|昵称)\}/giu, senderName).trim();
    if (!text) return undefined;
    this.#context.log("info", "plugin.pat_reply", "已响应拍一拍", {
      conversationId: event.conversation.id,
      senderId: event.sender.id,
    });
    return { kind: "direct-reply", text, reason: "plugin-pat-reply" };
  }

  tick(): void {
    // Event-driven plugin; no polling work.
  }
}

export const patReplyPluginFactory: AgentPluginFactory = {
  type: "pat-reply",
  create: (config, context) => new PatReplyPlugin(config, context),
};

function parseSettings(value: Readonly<Record<string, unknown>>): PatReplySettings {
  const raw = Array.isArray(value.replies)
    ? value.replies
    : typeof value.replyText === "string"
      ? value.replyText.split(/\r?\n/u)
      : ["拍我干嘛～"];
  if (raw.length > 50 || raw.some((item) => typeof item !== "string")) {
    throw new Error("pat-reply replies must contain at most 50 strings");
  }
  const replies = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  if (replies.length === 0 || replies.some((item) => [...item].length > 500)) {
    throw new Error("pat-reply requires 1-50 non-empty replies of at most 500 characters");
  }
  return { replies, groupOnly: value.groupOnly !== false };
}

function deterministicReply(replies: readonly string[], eventId: string): string {
  const digest = createHash("sha256").update(eventId).digest();
  return replies[digest.readUInt32BE(0) % replies.length]!;
}
