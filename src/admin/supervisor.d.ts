import { ChannelAdapterRegistry } from "../channel-adapter.js";
import type { InboundMessageEvent, LearningAuditRecord, MemoryRecord, ParticipationCase, ParticipationCaseQuery, ParticipationLabel, ReplyQualityLabel, ParticipationSummary, StoredMessage } from "../types.js";
import { AdminStore, type AdminLogLevel } from "./admin-store.js";
import type { BotConfig, ModelProfile } from "./config.js";
export type BotRuntimePhase = "stopped" | "starting" | "running" | "stopping" | "error";
export interface BotRuntimeMetrics {
    inboundMessages: number;
    agentRuns: number;
    replies: number;
    agentFailures: number;
    imageCalls: number;
    imageFailures: number;
    deliveries: number;
    lastAgentDurationMs: number | null;
    totalAgentDurationMs: number;
    llmCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number;
    fallbackHops: number;
    lastModelRoute: string[];
    lastTimeToFirstTokenMs: number | null;
}
export interface BotRuntimeStatus {
    id: string;
    displayName: string;
    enabled: boolean;
    phase: BotRuntimePhase;
    since: number;
    startedAt: number | null;
    lastEventAt: number | null;
    lastError: string | null;
    gatewayHealthy: boolean | null;
    gatewayCheckedAt: number | null;
    webhookAddress: {
        host: string;
        port: number;
        path: string;
    } | null;
    pendingOutbox: number;
    chatModel: string | null;
    visionModel: string | null;
    chatroomModelOverrides: number;
    metrics: BotRuntimeMetrics;
}
export interface SupervisorStatus {
    startedAt: number;
    uptimeMs: number;
    process: {
        pid: number;
        node: string;
        rssBytes: number;
        heapUsedBytes: number;
        heapTotalBytes: number;
    };
    bots: BotRuntimeStatus[];
    logCounts: Record<AdminLogLevel, number>;
}
export interface ManagedChatroomSummary {
    botId: string;
    botDisplayName: string;
    botIds: string[];
    bots: Array<{
        id: string;
        displayName: string;
        channelType: BotConfig["channel"]["type"];
        role: "primary" | "backup";
        running: boolean;
        healthy: boolean | null;
        personaProfileId: string | null;
        sessionId: string;
        sessionScope: string;
        contextEpoch: number;
    }>;
    chatroomId: string;
    title?: string;
    label?: string;
    inboundMessages: number;
    activeMembers: number;
    lastMessageAt: number | null;
    chatModelProfileId: string | null;
    visionModelProfileId: string | null;
    personaProfileId: string | null;
    ttsVoice: string | null;
    ttsStyle: string | null;
    ttsPresetId: string | null;
    participationIntensity: "conservative" | "standard" | "active";
    managerIds: string[];
    redEnvelopeTargetIds: string[];
    plugins: Array<{
        type: string;
        defaultEnabled: boolean;
        override: boolean | null;
        enabled: boolean;
    }>;
}
export interface ChatroomBotSessionStatus {
    botId: string;
    displayName: string;
    personaProfileId: string | null;
    sessionId: string;
    sessionScope: string;
    contextEpoch: number;
}
export interface ChatroomContextResetResult {
    botId: string;
    chatroomId: string;
    afterSequence: number;
    afterTimestamp: number;
    resetAt: number;
    sessions: ChatroomBotSessionStatus[];
}
export interface AgentSupervisorOptions {
    store: AdminStore;
    dataDirectory: string;
    healthIntervalMs?: number;
    socialIntervalMs?: number;
    adapterRegistry?: ChannelAdapterRegistry;
    env?: Readonly<Record<string, string | undefined>>;
}
/** Reconciles durable bot definitions into independently restartable Core + ChannelRuntime instances. */
export declare class AgentSupervisor {
    #private;
    constructor(options: AgentSupervisorOptions);
    start(): Promise<void>;
    close(): Promise<void>;
    reconcileBot(id: string): Promise<void>;
    reconcileAll(): Promise<void>;
    restartBot(id: string): Promise<void>;
    stopBot(id: string): Promise<void>;
    status(): SupervisorStatus;
    emojiContent(id: string): Promise<{
        data: Uint8Array;
        mimeType: string;
    }>;
    listChatrooms(): Promise<ManagedChatroomSummary[]>;
    listChatroomMessages(botId: string, chatroomId: string, options?: {
        limit?: number;
        beforeSequence?: number;
    }): {
        chatroomId: string;
        messages: StoredMessage[];
        hasMore: boolean;
    };
    listChatroomMemories(botId: string, chatroomId: string): {
        chatroomId: string;
        memories: MemoryRecord[];
        members: Array<{
            id: string;
            displayName: string;
            isBot: boolean;
        }>;
        audit: LearningAuditRecord[];
    };
    listChatroomSessions(botId: string, chatroomId: string): ChatroomBotSessionStatus[];
    resetChatroomContext(botId: string, chatroomId: string, actorId?: string): ChatroomContextResetResult;
    createChatroomMemory(botId: string, chatroomId: string, input: {
        scope: "conversation" | "person";
        personId?: string;
        kind: string;
        content: string;
        importance: number;
        expiresInDays?: number;
    }): MemoryRecord;
    confirmChatroomMemory(botId: string, chatroomId: string, memoryId: string, extendDays?: number): MemoryRecord;
    deleteChatroomMemory(botId: string, chatroomId: string, memoryId: string): void;
    saveGeneratedEmoji(botId: string, input: {
        data: Uint8Array;
        mimeType: string;
        name?: string;
        description?: string;
        memeKey?: string;
    }): Promise<import("../emoji-library.js").EmojiRecord>;
    sendChatroomMessage(botId: string, chatroomId: string, input: {
        text?: string;
        emojiId?: string;
    }): Promise<{
        eventId: string;
        delivered: number;
        botId: string;
        kind: "text" | "emoji";
        emojiId?: string;
    }>;
    checkGateway(id: string): Promise<Record<string, unknown>>;
    channelCapabilities(botId: string): Record<string, unknown>;
    applyChannelIdentity(botId: string, personaProfileId: string, options?: {
        force?: boolean;
        conversationId?: string;
    }): Promise<Record<string, unknown>>;
    /** Copies one logical room's management state to every account known in that room. */
    synchronizeChatroomConfiguration(sourceBotId: string, chatroomId: string): string[];
    /** Copies logical-Agent defaults after an account-level configuration change. */
    synchronizeAgentConfiguration(sourceBotId: string): string[];
    listParticipationCases(id: string, query?: ParticipationCaseQuery): ParticipationCase[];
    participationSummary(id: string): ParticipationSummary;
    labelParticipationCase(id: string, eventId: string, label: ParticipationLabel, reason?: string): ParticipationCase;
    labelReplyQualityCase(id: string, eventId: string, label: ReplyQualityLabel, reason?: string): ParticipationCase;
    pruneParticipationCases(id: string): {
        deleted: number;
    };
    testWebhook(id: string): Promise<{
        deliveryId: string;
    }>;
    ensureWebhook(id: string, webhookUrl: string): Promise<{
        id: string;
        created: boolean;
        url: string;
    }>;
}
/** Uses every configured chat-capable Gemini before crossing to another Provider. */
export declare function orderedGeminiFallbackProfileIds(primary: ModelProfile, profiles: readonly ModelProfile[]): string[];
/** Routes only obviously bounded social turns to the optional low-cost fast model. */
export declare function shouldUseFastChatModel(event: InboundMessageEvent): boolean;
export declare function gatewayHealthReady(config: BotConfig, health: Readonly<Record<string, unknown>>): boolean;
export declare function selectReplyBot(bots: readonly BotConfig[], healthyBotIds: ReadonlySet<string>, mentionedIdentityIds: ReadonlySet<string>): BotConfig | undefined;
export declare function sharedReplyFingerprint(event: InboundMessageEvent): string;
/** Thinking feedback is only for the first model reply after an explicit group @mention. */
export declare function shouldSendThinkingEmoji(event: InboundMessageEvent, botIdentityId: string | readonly string[], recentMessages: readonly StoredMessage[], continuationWindowMs: number): boolean;
export {};
//# sourceMappingURL=supervisor.d.ts.map
