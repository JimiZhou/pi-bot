import type {
  AgentPlugin,
  AgentPluginContext,
  AgentPluginFactory,
  AgentPluginInboundAction,
} from "../agent-plugin.js";
import type { BotPluginConfig } from "../config.js";
import type { InboundMessageEvent } from "../types.js";

/** Deterministic welcome/leave notices derived from normalized system events. */
export class GroupEventNotifyPlugin implements AgentPlugin {
  readonly id: string;
  readonly type = "group-event-notify";
  readonly #context: AgentPluginContext;

  constructor(config: BotPluginConfig, context: AgentPluginContext) {
    this.id = config.id;
    this.#context = context;
  }

  handleInbound(event: InboundMessageEvent): AgentPluginInboundAction | undefined {
    if (event.conversation.kind !== "group" || event.metadata?.interaction !== "system-event") return undefined;
    if (!this.#context.isEnabledForConversation(this.type, event.conversation.id)) return undefined;
    const kind = typeof event.metadata.systemEventKind === "string" ? event.metadata.systemEventKind : "";
    if (![
      "group-member-joined",
      "group-member-left",
      "group-member-removed",
    ].includes(kind)) return undefined;
    const names = systemMemberNames(event);
    if (names.length === 0) return undefined;
    const display = names.slice(0, 10).join("、") + (names.length > 10 ? `等 ${names.length} 人` : "");
    const text = kind === "group-member-joined"
      ? `欢迎${display}入群`
      : `${display}退出了群聊`;
    this.#context.log("info", "plugin.group_event_notified", kind === "group-member-joined" ? "已发送入群欢迎" : "已发送退群通知", {
      conversationId: event.conversation.id,
      kind,
      names,
    });
    return { kind: "direct-reply", text, reason: "plugin-group-event-notify" };
  }

  tick(): void {}
}

export const groupEventNotifyPluginFactory: AgentPluginFactory = {
  type: "group-event-notify",
  create: (config, context) => new GroupEventNotifyPlugin(config, context),
};

function systemMemberNames(event: InboundMessageEvent): string[] {
  const raw = event.metadata?.systemEventMemberNames;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (!name || [...name].length > 200 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
