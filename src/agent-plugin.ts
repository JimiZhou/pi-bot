import type { ChannelInboundAction, ChannelRuntime } from "./channel.js";
import type { GroupAgentCore } from "./core.js";
import type { BotPluginConfig, PersonaProfile } from "./config.js";
import type { InboundMessageEvent } from "./types.js";
import type { AssetStore } from "./asset-store.js";
import type { ScheduledTaskRepository } from "./scheduled-task.js";
import type { ConversationContextReset } from "./sqlite-store.js";
import type { ConversationVoiceMode } from "./reply-modality.js";

export type AgentPluginLogLevel = "debug" | "info" | "warn" | "error";

export interface AgentPluginClaim {
  claimKey: string;
  canonicalConversationId: string;
  reason: string;
  createdAt: number;
  ambient: boolean;
  cooldownMs?: number;
  botCooldownMs?: number;
  dailyLimit?: number;
  dayStartAt?: number;
}

export interface ManagedConversationPlugin {
  type: string;
  label: string;
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
}

export interface ManagedConversationSession {
  botId: string;
  displayName: string;
  personaProfileId: string | null;
  sessionId: string;
  sessionScope: string;
  contextEpoch: number;
}

export interface ManagedConversationVoiceStyle {
  voice: string;
  style: string;
  presetId: string | null;
  presetLabel: string | null;
  overridden: boolean;
}

export interface AgentPluginContext {
  botId: string;
  identityId: string;
  identityAliases?(conversationId: string): string[];
  /** Returns the bot that owns direct plugin replies for a shared group. */
  preferredGroupBotId?(conversationId: string): string | undefined;
  timezoneOffsetMinutes: number;
  core: GroupAgentCore;
  runtime: ChannelRuntime;
  /** Bot-owned local media storage for plugin-generated outbound assets. */
  assets?: AssetStore;
  scheduledTasks?: ScheduledTaskRepository;
  personas?: {
    list(): PersonaProfile[];
    current(conversationId: string): PersonaProfile | undefined;
    set(conversationId: string, personaProfileId: string | null): PersonaProfile | undefined;
  };
  management?: {
    isManager(conversationId: string, senderId: string): boolean;
    listManagerIds(conversationId: string): string[];
    redEnvelopeTargetIds(conversationId: string): string[];
    memberDisplayName(conversationId: string, memberId: string): string;
    resetContext(conversationId: string, actorId: string, sourceEventId: string): ConversationContextReset;
    contextReset(conversationId: string): ConversationContextReset | undefined;
    sessionStatuses(conversationId: string): ManagedConversationSession[];
    listPlugins(conversationId: string): ManagedConversationPlugin[];
    setPlugin(conversationId: string, pluginType: string, enabled: boolean): ManagedConversationPlugin;
    voiceStyle(conversationId: string): ManagedConversationVoiceStyle;
    setVoiceStyle(conversationId: string, query: string | null): ManagedConversationVoiceStyle;
    voiceMode(conversationId: string): ConversationVoiceMode;
    setVoiceMode(conversationId: string, mode: ConversationVoiceMode): ConversationVoiceMode;
    historyLimit: number;
    maxHistoryChars: number;
  };
  claim(input: AgentPluginClaim): boolean;
  releaseClaim(claimKey: string): boolean;
  isEnabledForConversation(pluginType: string, conversationId: string): boolean;
  log(
    level: AgentPluginLogLevel,
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void;
}

export type AgentPluginInboundAction = ChannelInboundAction;

/** Feature plugins never touch channel-native APIs; they use the same durable Core/Runtime path as inbound chat. */
export interface AgentPlugin {
  readonly id: string;
  readonly type: string;
  start?(): void | Promise<void>;
  handleInbound?(event: InboundMessageEvent): AgentPluginInboundAction | undefined | Promise<AgentPluginInboundAction | undefined>;
  tick(now: number): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface AgentPluginFactory {
  readonly type: string;
  create(config: BotPluginConfig, context: AgentPluginContext): AgentPlugin;
}

export class AgentPluginRegistry {
  readonly #factories = new Map<string, AgentPluginFactory>();

  register(factory: AgentPluginFactory): this {
    if (!factory.type.trim()) throw new Error("Agent plugin factory type cannot be empty");
    if (this.#factories.has(factory.type)) throw new Error(`Duplicate agent plugin type: ${factory.type}`);
    this.#factories.set(factory.type, factory);
    return this;
  }

  create(config: BotPluginConfig, context: AgentPluginContext): AgentPlugin {
    const factory = this.#factories.get(config.type);
    if (!factory) throw new Error(`Unknown agent plugin type: ${config.type}`);
    const plugin = factory.create(config, context);
    if (plugin.id !== config.id || plugin.type !== config.type) {
      throw new Error(`Agent plugin ${config.id} returned an invalid identity`);
    }
    return plugin;
  }
}
