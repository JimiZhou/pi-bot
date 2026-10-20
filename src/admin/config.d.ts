import type { GroupActivation } from "../types.js";
export type ManagedThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ManagedOpenAIThinkingFormat = "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
export type ManagedProviderApi = "auto" | "openai-completions" | "openai-responses" | "google-generative-ai" | "anthropic-messages";
/** Request protocol selected per model. `inherit` preserves existing provider-level configurations. */
export type ManagedModelApi = ManagedProviderApi | "inherit";
export type EmojiMode = "auto" | "explicit" | "disabled";
export interface ProviderProfile {
    id: string;
    label: string;
    provider: string;
    api: ManagedProviderApi;
    apiKeyEnv?: string;
    baseUrl: string;
    enabled: boolean;
}
export interface ProviderProfileSummary extends ProviderProfile {
    hasApiKey: boolean;
}
export type KnowledgeProviderKind = "searxng" | "brave" | "tavily";
export interface KnowledgeProviderProfile {
    id: string;
    label: string;
    kind: KnowledgeProviderKind;
    baseUrl: string;
    apiKeyEnv?: string;
    timeoutMs: number;
    maxResults: number;
    enabled: boolean;
}
export interface KnowledgeProviderProfileSummary extends KnowledgeProviderProfile {
    hasApiKey: boolean;
}
export type McpAuthType = "none" | "bearer" | "api-key";
export type McpTransport = "http" | "stdio";
export interface McpServerProfile {
    id: string;
    label: string;
    transport: McpTransport;
    url: string;
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    secretEnv?: string;
    authType: McpAuthType;
    authHeader: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxTools: number;
    enabled: boolean;
}
export interface McpServerProfileSummary extends McpServerProfile {
    hasSecret: boolean;
}
export interface ModelProfile {
    id: string;
    label: string;
    providerProfileId: string;
    modelId: string;
    api: ManagedModelApi;
    input: Array<"text" | "image">;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    thinkingLevel: ManagedThinkingLevel;
    openaiThinkingFormat?: ManagedOpenAIThinkingFormat;
    maxRetryDelayMs: number;
    enabled: boolean;
}
export interface PersonaProfile {
    id: string;
    label: string;
    prompt: string;
    /** Persona-facing name used for self-reference and optional adapter identity sync. */
    accountNickname?: string;
    /** Per-room display name understood by adapters that support conversation identity. */
    groupNickname?: string;
    /** Conversation-scoped aliases that wake this persona in addition to the Bot defaults. */
    wakeWords: string[];
    /** Administrator-provided avatar preset for adapters that support identity updates. */
    avatarDataUrl?: string;
    /** Applying this persona may update the adapter account nickname/avatar. */
    autoApplyAccountProfile: boolean;
    enabled: boolean;
}
export interface ChatroomModelOverride {
    chatroomId: string;
    label?: string;
    chatModelProfileId: string | null;
    visionModelProfileId: string | null;
    personaProfileId?: string | null;
    /** Optional Gemini prebuilt voice used as this room's default TTS voice. */
    ttsVoice?: string;
    /** Optional natural-language delivery direction used for this room's TTS. */
    ttsStyle?: string;
    /** How readily the local judge may join an unaddressed conversation in this room. */
    participationIntensity?: "conservative" | "standard" | "active";
    /** Group members allowed to run mutating @bot management commands in this room. */
    managerIds: string[];
    /** Group members that receive native mentions when this room gets a red envelope. */
    redEnvelopeTargetIds: string[];
    pluginOverrides: ChatroomPluginOverride[];
}
export interface ChatroomPluginOverride {
    pluginType: string;
    enabled: boolean;
}
export interface BotChannelConfig {
    type: string;
    accountId?: string;
    settings: Record<string, unknown>;
}
export interface BotAgentLimits {
    historyLimit: number;
    maxHistoryChars: number;
    memoryLimit: number;
    behaviorLimit: number;
    continuationWindowMs: number;
    messageBurstDebounceMs: number;
    explicitMessageBurstDebounceMs: number;
    maxAgentLlmCalls: number;
    maxAgentToolCalls: number;
    agentTimeoutMs: number;
    maxReplyChars: number;
    maxImageUnderstandingCalls: number;
    maxImageBytes: number;
    maxImageEvidenceChars: number;
    imageUnderstandingTimeoutMs: number;
    imageContextMessageLimit: number;
    imageContextWindowMs: number;
    maxAvailableImagesPerTurn: number;
}
export interface SocialScheduleConfig {
    enabled: boolean;
    timezoneOffsetMinutes: number;
    activeStartMinute: number;
    activeEndMinute: number;
    hotChatWindowMs: number;
    hotChatMinMessages: number;
    hotChatMinParticipants: number;
    hotChatCooldownMs: number;
    coldChatAfterMs: number;
    coldChatCooldownMs: number;
    maxDailyAmbientMessages: number;
    goodnightEnabled: boolean;
    goodnightMinute: number;
    activeGroupMinMessages: number;
}
export interface BotPluginConfig {
    id: string;
    type: string;
    enabled: boolean;
    settings: Readonly<Record<string, unknown>>;
}
export interface BotConfig {
    id: string;
    enabled: boolean;
    identityId: string;
    displayName: string;
    wakeWords: string[];
    operatorIds: string[];
    soul?: string;
    personaProfileId?: string | null;
    defaultGroupActivation: GroupActivation;
    chatModelProfileId: string | null;
    /** Optional low-cost model for deterministic short/simple turns. */
    fastChatModelProfileId: string | null;
    /** Dedicated Gemini model used only for ambiguous group participation decisions. */
    participationJudgeModelProfileId: string | null;
    /** Ordered cross-provider fallbacks used after the primary/provider-internal chain is exhausted. */
    fallbackChatModelProfileIds: string[];
    /** Controls when the emoji catalog is made available to the chat model. */
    emojiMode: EmojiMode;
    /** Number of initial emoji candidates exposed to the model. */
    emojiCandidateLimit: number;
    visionModelProfileId: string | null;
    chatroomModelOverrides: ChatroomModelOverride[];
    imageUnderstandingEnabled: boolean;
    databaseFile: string;
    channel: BotChannelConfig;
    limits: BotAgentLimits;
    socialSchedule: SocialScheduleConfig;
    plugins: BotPluginConfig[];
}
export interface GlobalSettings {
    defaultChatModelProfileId: string | null;
    defaultVisionModelProfileId: string | null;
    defaultKnowledgeProfileId: string | null;
    defaultPersonaProfileId: string | null;
    logRetentionDays: number;
    maxLogRows: number;
    statusRefreshMs: number;
    participationRetentionDays: number;
    maxParticipationCasesPerBot: number;
}
export declare const DEFAULT_GLOBAL_SETTINGS: GlobalSettings;
export declare const DEFAULT_PERSONA_PROFILE: PersonaProfile;
export declare const DEFAULT_BOT_LIMITS: BotAgentLimits;
export declare const DEFAULT_SOCIAL_SCHEDULE: SocialScheduleConfig;
export declare function parseProviderProfile(value: unknown): ProviderProfile;
export declare function parseKnowledgeProviderProfile(value: unknown): KnowledgeProviderProfile;
export declare function parseMcpServerProfile(value: unknown): McpServerProfile;
export declare function parseModelProfile(value: unknown): ModelProfile;
export declare function parsePersonaProfile(value: unknown): PersonaProfile;
export declare function parseBotConfig(value: unknown): BotConfig;
export declare function parseGlobalSettings(value: unknown): GlobalSettings;
//# sourceMappingURL=config.d.ts.map
