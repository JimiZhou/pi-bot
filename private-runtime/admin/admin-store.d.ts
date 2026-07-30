import { type BotConfig, type GlobalSettings, type KnowledgeProviderProfileSummary, type McpServerProfileSummary, type ModelProfile, type PersonaProfile, type ProviderProfileSummary } from "./config.js";
import { type ScheduledTask, type ScheduledTaskCreateInput, type ScheduledTaskDraft, type ScheduledTaskRepository, type ScheduledTaskUpdateInput } from "../scheduled-task.js";
import type { AssetRef } from "../types.js";
import type { ConversationVoiceMode } from "../reply-modality.js";
export type AdminLogLevel = "debug" | "info" | "warn" | "error";
export interface AppendAdminLogInput {
    level: AdminLogLevel;
    scope: "system" | "web" | "bot" | "channel" | "agent";
    event: string;
    message: string;
    botId?: string;
    details?: Readonly<Record<string, unknown>>;
    createdAt?: number;
}
export interface AdminLogRecord extends AppendAdminLogInput {
    id: number;
    createdAt: number;
}
export interface AdminLogQuery {
    limit?: number;
    beforeId?: number;
    level?: AdminLogLevel;
    botId?: string;
    query?: string;
}
export interface AdminStoreOptions {
    /** 32-byte key used only to encrypt provider API keys at rest. */
    secretKey?: Uint8Array;
}
export interface WechatMomentAutomationSettings {
    botId: string;
    enabled: boolean;
    autoLike: boolean;
    autoComment: boolean;
    allowedAuthorWxids: string[];
    maxActionsPerDay: number;
    minIntervalMinutes: number;
    lookbackMinutes: number;
    commentTemplates: string[];
    dryRun: boolean;
}
export interface WechatMomentActionRecord {
    id: number;
    botId: string;
    momentId: string;
    authorWxid: string;
    action: "like" | "comment";
    status: "claimed" | "delivered" | "dry_run" | "failed";
    content?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
}
export interface ProactiveClaimInput {
    claimKey: string;
    canonicalConversationId: string;
    botId: string;
    reason: string;
    createdAt: number;
    ambient: boolean;
    cooldownMs?: number;
    botCooldownMs?: number;
    dailyLimit?: number;
    dayStartAt?: number;
}
export type EmojiStatus = "analyzing" | "ready" | "failed";
export interface EmojiRecord {
    id: string;
    botId: string;
    asset: AssetRef;
    sha256: string;
    description: string;
    status: EmojiStatus;
    enabled: boolean;
    isThinking: boolean;
    sourceConversationId?: string;
    sourceSenderId?: string;
    sourceMessageId?: string;
    useCount: number;
    lastUsedAt?: number;
    error?: string;
    createdAt: number;
    updatedAt: number;
}
export interface GroupMemberSnapshotInput {
    id: string;
    nickname?: string;
    displayName?: string;
}
export interface GroupMemberNameChange {
    id: string;
    oldName: string;
    newName: string;
}
export interface GroupMemberPresenceChange {
    id: string;
    name: string;
}
export interface GroupMemberSnapshotResult {
    initialized: boolean;
    changes: GroupMemberNameChange[];
    joined: GroupMemberPresenceChange[];
    left: GroupMemberPresenceChange[];
}
/** Small control-plane database. Bot transcripts remain in separate per-bot SQLite files. */
export declare class AdminStore implements ScheduledTaskRepository {
    #private;
    constructor(path: string, options?: AdminStoreOptions);
    close(): void;
    getGlobalSettings(): GlobalSettings;
    saveGlobalSettings(value: unknown): GlobalSettings;
    getWechatMomentAutomation(botId: string): WechatMomentAutomationSettings;
    saveWechatMomentAutomation(botId: string, value: unknown): WechatMomentAutomationSettings;
    claimWechatMomentAction(input: {
        botId: string;
        momentId: string;
        authorWxid: string;
        action: "like" | "comment";
        content?: string;
        maxActionsPerDay: number;
        minIntervalMinutes: number;
        now?: number;
    }): {
        claimed: boolean;
        reason?: string;
        id?: number;
    };
    completeWechatMomentAction(id: number, status: "delivered" | "dry_run" | "failed", error?: string): void;
    listWechatMomentActions(botId: string, limit?: number): WechatMomentActionRecord[];
    listProviderProfiles(): ProviderProfileSummary[];
    getProviderProfile(id: string): ProviderProfileSummary | undefined;
    saveProviderProfile(value: unknown, apiKeyUpdate?: string | null): ProviderProfileSummary;
    deleteProviderProfile(id: string): boolean;
    getProviderApiKey(id: string): string | undefined;
    providerUsage(id: string): {
        modelIds: string[];
    };
    listKnowledgeProviderProfiles(): KnowledgeProviderProfileSummary[];
    getKnowledgeProviderProfile(id: string): KnowledgeProviderProfileSummary | undefined;
    saveKnowledgeProviderProfile(value: unknown, apiKeyUpdate?: string | null): KnowledgeProviderProfileSummary;
    deleteKnowledgeProviderProfile(id: string): boolean;
    getKnowledgeProviderApiKey(id: string): string | undefined;
    listMcpServerProfiles(): McpServerProfileSummary[];
    getMcpServerProfile(id: string): McpServerProfileSummary | undefined;
    saveMcpServerProfile(value: unknown, secretUpdate?: string | null): McpServerProfileSummary;
    deleteMcpServerProfile(id: string): boolean;
    getMcpServerSecret(id: string): string | undefined;
    listModelProfiles(): ModelProfile[];
    getModelProfile(id: string): ModelProfile | undefined;
    saveModelProfile(value: unknown): ModelProfile;
    deleteModelProfile(id: string): boolean;
    listPersonaProfiles(): PersonaProfile[];
    getPersonaProfile(id: string): PersonaProfile | undefined;
    savePersonaProfile(value: unknown): PersonaProfile;
    deletePersonaProfile(id: string): boolean;
    getConversationPersonaOverride(botId: string, conversationId: string): string | undefined;
    setConversationPersonaOverride(botId: string, conversationId: string, personaProfileId: string | null): void;
    getConversationVoiceMode(botId: string, conversationId: string): ConversationVoiceMode;
    setConversationVoiceMode(botId: string, conversationId: string, mode: ConversationVoiceMode): ConversationVoiceMode;
    personaUsage(id: string): {
        global: boolean;
        botIds: string[];
        chatrooms: Array<{
            botId: string;
            chatroomId: string;
        }>;
        directConversations: Array<{
            botId: string;
            conversationId: string;
        }>;
    };
    modelUsage(id: string): {
        global: boolean;
        botIds: string[];
    };
    listBots(): BotConfig[];
    getBot(id: string): BotConfig | undefined;
    saveBot(value: unknown): BotConfig;
    deleteBot(id: string): boolean;
    listScheduledTasks(query?: {
        botId?: string;
        conversationId?: string;
    }): ScheduledTask[];
    createScheduledTask(input: ScheduledTaskCreateInput): ScheduledTask;
    updateScheduledTask(id: string, input: ScheduledTaskUpdateInput): ScheduledTask;
    deleteScheduledTask(id: string): boolean;
    assignScheduledTask(id: string, botId: string, conversationId: string, now?: number): boolean;
    claimDueScheduledTasks(botId: string, now: number, limit?: number): ScheduledTask[];
    completeScheduledTaskRun(id: string, scheduledFor: number, result: {
        success: boolean;
        error?: string;
        completedAt: number;
    }): ScheduledTask;
    getScheduledTaskDraft(botId: string, conversationId: string, creatorId: string, now?: number): ScheduledTaskDraft | undefined;
    saveScheduledTaskDraft(input: Omit<ScheduledTaskDraft, "createdAt" | "updatedAt">): ScheduledTaskDraft;
    deleteScheduledTaskDraft(botId: string, conversationId: string, creatorId: string): boolean;
    claimProactive(input: ProactiveClaimInput): boolean;
    pruneProactiveClaims(before: number): number;
    releaseProactiveClaim(claimKey: string, botId: string): boolean;
    appendLog(input: AppendAdminLogInput): AdminLogRecord;
    listLogs(query?: AdminLogQuery): AdminLogRecord[];
    logCounts(): Record<AdminLogLevel, number>;
    pruneLogs(settings?: GlobalSettings): {
        deleted: number;
    };
    isGroupRoomInactive(botId: string, conversationId: string): boolean;
    markGroupRoomAvailable(botId: string, conversationId: string): boolean;
    noteGroupRoomUnavailable(botId: string, conversationId: string, reason: string, confirmed?: boolean, observedAt?: number): {
        consecutive: number;
        inactive: boolean;
    };
    deleteGroupMemberSnapshots(conversationId: string): number;
    /**
     * Reconciles a native iPad group-member snapshot and returns visible name
     * and presence changes relative to the preceding complete snapshot.
     * The first complete snapshot is deliberately a silent baseline.
     */
    syncGroupMemberSnapshots(conversationId: string, members: readonly GroupMemberSnapshotInput[], observedAt?: number): GroupMemberSnapshotResult;
    listEmojis(botId?: string): EmojiRecord[];
    getEmoji(id: string): EmojiRecord | undefined;
    findEmojiByHash(botId: string, sha256: string): EmojiRecord | undefined;
    saveCollectedEmoji(input: {
        botId: string;
        asset: AssetRef;
        sha256: string;
        sourceConversationId?: string;
        sourceSenderId?: string;
        sourceMessageId?: string;
        description?: string;
    }): {
        emoji: EmojiRecord;
        created: boolean;
    };
    completeEmojiAnalysis(id: string, description: string): EmojiRecord;
    failEmojiAnalysis(id: string, error: string): EmojiRecord;
    updateEmoji(id: string, input: {
        description?: string;
        enabled?: boolean;
        isThinking?: boolean;
    }): EmojiRecord;
    updateEmojiAsset(id: string, asset: AssetRef): EmojiRecord;
    markEmojiUsed(id: string): void;
    thinkingEmoji(botId: string): EmojiRecord | undefined;
    deleteEmoji(id: string): boolean;
}
//# sourceMappingURL=admin-store.d.ts.map