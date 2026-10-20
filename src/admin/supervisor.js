import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { ChannelAdapterRegistry } from "../channel-adapter.js";
import { AistudioClient, DEFAULT_EMBEDDING_MODEL, createAistudioMediaToolProvider } from "../aistudio.js";
import { LocalAssetStore } from "../asset-store.js";
import { enrichInboundVoiceTranscripts, MemoryVoiceTranscriptCache } from "../audio-transcription.js";
import { ChannelRuntime, MEDIA_RESOLVE_CAPABILITY } from "../channel.js";
import { CHANNEL_FEATURE_SEND_IMAGE, CHANNEL_FEATURE_SEND_VOICE } from "../channel-capabilities.js";
import { createChatSessionDescriptor, GroupAgentCore } from "../core.js";
import { createAgentToolsProvider } from "../agent-tools.js";
import { createBrowserTool } from "../browser-tools.js";
import { collectInboundEmoji, createEmojiToolProvider, emojiAssetWithOwner, retryEmojiAnalysis, } from "../emoji-library.js";
import { replaceTransportIds, safeGroupDisplayName } from "../display-name.js";
import { FallbackImageUnderstandingProvider, PiImageUnderstandingProvider, } from "../image-understanding.js";
import { HttpKnowledgeRetriever } from "../knowledge-retriever.js";
import { DEFAULT_TTS_STYLE, DEFAULT_TTS_VOICE, matchingTtsVoicePreset, resolveTtsVoiceStyleQuery, } from "../voice-style.js";
import { createMcpToolProvider, probeMcpServer } from "../mcp.js";
import { PiAgentRunner } from "../pi-runner.js";
import { ResilientSpeechSynthesizer, TtsApiClient } from "../speech.js";
import { WHISPER_TTS_STYLE } from "../reply-modality.js";
import { createBuiltInAgentPluginRegistry } from "../plugins/index.js";
import { BUILT_IN_PLUGIN_DEFINITIONS, builtInPluginDefinition, withImplicitBuiltInPlugins, } from "../plugins/catalog.js";
import { createScheduledTaskToolProvider } from "../plugins/scheduled-task.js";
import { SqliteStore } from "../sqlite-store.js";
import { SharedConversationState } from "../shared-conversation-state.js";
import { AdminStore } from "./admin-store.js";
import { resolveCustomModel } from "./model-runtime.js";
const EMOJI_ANALYSIS_RETRY_INTERVAL_MS = 15 * 60_000;
const EMOJI_ANALYSIS_RETRY_MIN_AGE_MS = 30 * 60_000;
/** Reconciles durable bot definitions into independently restartable Core + ChannelRuntime instances. */
export class AgentSupervisor {
    #store;
    #dataDirectory;
    #env;
    #healthIntervalMs;
    #socialIntervalMs;
    #startedAt = Date.now();
    #runtimes = new Map();
    #states = new Map();
    #tails = new Map();
    #groupMemberCache = new Map();
    #groupMemberInflight = new Map();
    #groupTitleCache = new Map();
    #groupTitleInflight = new Map();
    #roomBots = new Map();
    #fallbackNotificationAt = new Map();
    #adapterRegistry;
    #voiceTranscriptCache = new MemoryVoiceTranscriptCache(1_000);
    #sharedConversationState;
    #healthTimer;
    #socialTimer;
    #emojiAnalysisRetryTimer;
    #emojiAnalysisRetriers = new Map();
    #emojiAssetRecoveryInflight = new Map();
    #emojiAnalysisRetryRunning = false;
    #socialPollRunning = false;
    #closed = false;
    constructor(options) {
        this.#store = options.store;
        this.#dataDirectory = resolve(options.dataDirectory);
        this.#adapterRegistry = options.adapterRegistry ?? new ChannelAdapterRegistry();
        this.#sharedConversationState = new SharedConversationState(safeDataPath(this.#dataDirectory, "fusion/shared-agent.sqlite"), {
            conversationIdResolver: canonicalConversationId,
            identityIdResolver: canonicalIdentityId,
        });
        this.#env = options.env ?? process.env;
        this.#healthIntervalMs = boundedInteger(options.healthIntervalMs ?? 30_000, 5000, 10 * 60_000);
        this.#socialIntervalMs = boundedInteger(options.socialIntervalMs ?? 60_000, 10_000, 10 * 60_000);
    }
    async start() {
        this.#assertOpen();
        const pruned = this.#store.pruneLogs();
        this.#log("info", "system", "supervisor.started", "机器人 Supervisor 已启动", {
            prunedLogs: pruned.deleted,
        });
        if (this.#env.PI_FUSION_BOOTSTRAP?.trim().toLowerCase() === "true") {
            this.#bootstrapSharedConversationState();
        }
        else {
            this.#log("info", "system", "fusion.state_bootstrap_skipped", "按配置跳过共享群历史全量导入", undefined);
        }
        this.#synchronizeInitialFusionConfiguration();
        await Promise.all(this.#store.listBots().map((bot) => this.reconcileBot(bot.id)));
        this.#rebalanceFusionScheduledTasks();
        this.#healthTimer = setInterval(() => void this.#pollGatewayHealth(), this.#healthIntervalMs);
        this.#healthTimer.unref();
        this.#socialTimer = setInterval(() => void this.#pollSocialSchedule(), this.#socialIntervalMs);
        this.#socialTimer.unref();
        this.#emojiAnalysisRetryTimer = setInterval(() => void this.#retryFailedEmojiAnalyses(), EMOJI_ANALYSIS_RETRY_INTERVAL_MS);
        this.#emojiAnalysisRetryTimer.unref();
        void this.#retryFailedEmojiAnalyses();
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        if (this.#healthTimer)
            clearInterval(this.#healthTimer);
        if (this.#socialTimer)
            clearInterval(this.#socialTimer);
        if (this.#emojiAnalysisRetryTimer)
            clearInterval(this.#emojiAnalysisRetryTimer);
        this.#healthTimer = undefined;
        this.#socialTimer = undefined;
        this.#emojiAnalysisRetryTimer = undefined;
        this.#emojiAnalysisRetriers.clear();
        await Promise.allSettled([...this.#runtimes.keys()].map((id) => this.#stopNow(id)));
        this.#sharedConversationState.close();
        this.#log("info", "system", "supervisor.stopped", "机器人 Supervisor 已停止");
    }
    reconcileBot(id) {
        return this.#serialize(id, async () => {
            const config = this.#store.getBot(id);
            await this.#stopNow(id);
            if (!config) {
                this.#states.delete(id);
                return;
            }
            const state = this.#stateFor(config);
            if (!config.enabled) {
                state.phase = "stopped";
                state.enabled = false;
                state.since = Date.now();
                state.lastError = null;
                return;
            }
            await this.#startNow(config, state);
        });
    }
    async reconcileAll() {
        this.#assertOpen();
        await Promise.all(this.#store.listBots().map((bot) => this.reconcileBot(bot.id)));
    }
    /**
     * Mark affected bots as applying and reconcile them without making the
     * admin request wait for channel/plugin startup to finish.
     */
    scheduleReconcile(botIds) {
        this.#assertOpen();
        const ids = [...new Set(botIds)];
        for (const id of ids) {
            const config = this.#store.getBot(id);
            if (!config)
                continue;
            const state = this.#stateFor(config);
            state.phase = config.enabled ? "starting" : "stopping";
            state.since = Date.now();
            state.lastError = null;
        }
        const operation = Promise.all(ids.map((id) => this.reconcileBot(id)));
        void operation.catch((error) => {
            this.#log("error", "system", "bot.reconcile_failed", errorMessage(error), { botIds: ids });
        });
        return this.status();
    }
    scheduleReconcileAll() {
        return this.scheduleReconcile(this.#store.listBots().map((bot) => bot.id));
    }
    restartBot(id) {
        return this.reconcileBot(id);
    }
    async stopBot(id) {
        return this.#serialize(id, async () => this.#stopNow(id));
    }
    status() {
        const memory = process.memoryUsage();
        const bots = this.#store.listBots().map((bot) => this.#snapshot(this.#stateFor(bot)));
        return {
            startedAt: this.#startedAt,
            uptimeMs: Date.now() - this.#startedAt,
            process: {
                pid: process.pid,
                node: process.version,
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal,
            },
            bots,
            logCounts: this.#store.logCounts(),
        };
    }
    async emojiContent(id) {
        const emoji = this.#store.getEmoji(id);
        if (!emoji)
            throw new Error(`Emoji ${id} does not exist`);
        const resolved = await this.#resolveEmojiAsset(emoji.asset, emoji.botId);
        const chunks = [];
        let size = 0;
        for await (const chunk of resolved.content) {
            size += chunk.byteLength;
            if (size > 64 * 1024 * 1024)
                throw new Error("Emoji exceeds the preview byte limit");
            chunks.push(Buffer.from(chunk));
        }
        if (size === 0)
            throw new Error("Emoji asset is empty");
        return { data: Buffer.concat(chunks), mimeType: emoji.asset.mimeType ?? "image/gif" };
    }
    async listChatrooms() {
        const discovered = new Map();
        for (const config of this.#store.listBots()) {
            const managed = this.#runtimes.get(config.id);
            let activity;
            if (managed) {
                activity = managed.core.listGroupActivity(0, Date.now() + 1, 1);
            }
            else {
                const store = new SqliteStore(safeDataPath(this.#dataDirectory, config.databaseFile), { recoverProcessing: false });
                try {
                    activity = store.listGroupActivity(0, Date.now() + 1, 1);
                }
                finally {
                    store.close();
                }
            }
            for (const group of activity) {
                const roomId = canonicalConversationId(group.conversationId);
                this.#rememberBotRoom(config.id, roomId);
                const entry = discovered.get(roomId) ?? { groups: [] };
                if (!entry.title && group.conversationTitle)
                    entry.title = group.conversationTitle;
                entry.groups.push(group);
                discovered.set(roomId, entry);
            }
            for (const override of config.chatroomModelOverrides) {
                const roomId = canonicalConversationId(override.chatroomId);
                this.#rememberBotRoom(config.id, roomId);
                const entry = discovered.get(roomId) ?? { groups: [] };
                if (!entry.title && override.label)
                    entry.title = override.label;
                discovered.set(roomId, entry);
            }
        }
        const sharedActivity = new Map(this.#sharedConversationState.store.listGroupActivity(0, Date.now() + 1, 1)
            .map((group) => [canonicalConversationId(group.conversationId), group]));
        const result = [];
        for (const [chatroomId, discoveredRoom] of discovered) {
            const participants = this.#fusionBotsForRoom(chatroomId);
            if (participants.length === 0)
                continue;
            const primary = participants[0];
            const override = primary.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === chatroomId);
            const shared = sharedActivity.get(chatroomId);
            const fallbackInbound = discoveredRoom.groups.reduce((total, group) => total + group.inboundMessages, 0);
            const fallbackActive = Math.max(0, ...discoveredRoom.groups.map((group) => group.activeMembers));
            const fallbackLast = Math.max(0, ...discoveredRoom.groups.map((group) => group.lastMessageAt));
            result.push({
                botId: primary.id,
                botDisplayName: primary.displayName,
                botIds: participants.map((bot) => bot.id),
                bots: participants.map((bot, index) => {
                    const session = this.#chatroomBotSession(bot, chatroomId);
                    return {
                        id: bot.id,
                        displayName: bot.displayName,
                        channelType: bot.channel.type,
                        role: index === 0 ? "primary" : "backup",
                        running: this.#runtimes.has(bot.id),
                        healthy: this.#states.get(bot.id)?.gatewayHealthy ?? null,
                        personaProfileId: session.personaProfileId,
                        sessionId: session.sessionId,
                        sessionScope: session.sessionScope,
                        contextEpoch: session.contextEpoch,
                    };
                }),
                chatroomId,
                ...(shared?.conversationTitle || discoveredRoom.title
                    ? { title: shared?.conversationTitle ?? discoveredRoom.title }
                    : {}),
                ...(override?.label ? { label: override.label } : {}),
                inboundMessages: shared?.inboundMessages ?? fallbackInbound,
                activeMembers: shared?.activeMembers ?? fallbackActive,
                lastMessageAt: (shared?.lastMessageAt ?? fallbackLast) > 0 ? (shared?.lastMessageAt ?? fallbackLast) : null,
                chatModelProfileId: override?.chatModelProfileId ?? null,
                visionModelProfileId: override?.visionModelProfileId ?? null,
                personaProfileId: override?.personaProfileId ?? null,
                ttsVoice: override?.ttsVoice ?? null,
                ttsStyle: override?.ttsStyle ?? null,
                ttsPresetId: matchingTtsVoicePreset(override?.ttsVoice, override?.ttsStyle)?.id ?? null,
                participationIntensity: override?.participationIntensity ?? "standard",
                managerIds: [...(override?.managerIds ?? [])],
                redEnvelopeTargetIds: [...(override?.redEnvelopeTargetIds ?? [])],
                plugins: withImplicitBuiltInPlugins(primary.plugins).map((plugin) => {
                    const configured = override?.pluginOverrides.find((item) => item.pluginType === plugin.type);
                    return {
                        type: plugin.type,
                        defaultEnabled: plugin.enabled,
                        override: configured?.enabled ?? null,
                        enabled: configured?.enabled ?? plugin.enabled,
                    };
                }),
            });
        }
        await Promise.all(result.map(async (item) => {
            if (item.title)
                return;
            const title = await this.#resolveGroupTitle(item.chatroomId);
            if (title)
                item.title = title;
        }));
        return result.sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0) ||
            left.chatroomId.localeCompare(right.chatroomId));
    }
    listChatroomMessages(botId, chatroomId, options = {}) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        const requestedLimit = boundedInteger(options.limit ?? 50, 1, 200);
        const page = this.#sharedConversationState.store.listConversationMessages(canonical, {
            limit: requestedLimit + 1,
            ...(options.beforeSequence !== undefined ? { beforeSequence: options.beforeSequence } : {}),
        });
        const members = this.#sharedConversationState.store.listMembers(canonical);
        const primary = this.#fusionBotsForRoom(canonical)[0];
        return {
            chatroomId: canonical,
            messages: page.slice(Math.max(0, page.length - requestedLimit)).map((message) => ({
                ...message,
                senderName: message.direction === "outbound"
                    ? primary?.displayName ?? message.senderName
                    : safeGroupDisplayName(message.senderName, message.senderId),
                text: replaceTransportIds(message.text, members),
            })),
            hasMore: page.length > requestedLimit,
        };
    }
    listChatroomMemories(botId, chatroomId) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        return {
            chatroomId: canonical,
            memories: this.#sharedConversationState.store.listConversationMemories(canonical, 500, true),
            members: this.#sharedConversationState.store.listMembers(canonical)
                .filter((member) => canonicalIdentityId(member.id) !== canonicalConversationId(chatroomId))
                .map((member) => ({
                ...member,
                displayName: safeGroupDisplayName(member.displayName, member.id, member.isBot ? "机器人" : "群友"),
            })),
            audit: this.#sharedConversationState.store.listLearningAudit(canonical, 100),
        };
    }
    listChatroomSessions(botId, chatroomId) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        return this.#fusionBotsForRoom(canonical).map((bot) => this.#chatroomBotSession(bot, canonical));
    }
    resetChatroomContext(botId, chatroomId, actorId = "admin:webui") {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        const reset = this.#sharedConversationState.resetContext(canonical, actorId, `admin-context-reset:${randomUUID()}`);
        return {
            botId,
            chatroomId: canonical,
            afterSequence: reset.afterSequence,
            afterTimestamp: reset.afterTimestamp,
            resetAt: reset.resetAt,
            sessions: this.#fusionBotsForRoom(canonical).map((bot) => this.#chatroomBotSession(bot, canonical, reset)),
        };
    }
    createChatroomMemory(botId, chatroomId, input) {
        const conversationId = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, conversationId);
        const kind = input.kind.normalize("NFKC").trim().toLocaleLowerCase();
        const content = input.content.normalize("NFKC").trim();
        if (!kind || kind.length > 80)
            throw new Error("Memory kind must contain 1-80 characters");
        if (!content || content.length > 1000)
            throw new Error("Memory content must contain 1-1000 characters");
        if (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1) {
            throw new Error("Memory importance must be between 0 and 1");
        }
        if (input.expiresInDays !== undefined &&
            (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 3650)) {
            throw new Error("Memory expiry must be between 1 and 3650 days");
        }
        let scopeId = conversationId;
        if (input.scope === "person") {
            const requested = input.personId?.normalize("NFKC").trim();
            if (!requested)
                throw new Error("Person memory requires a group member");
            const member = this.#sharedConversationState.store.listMembers(conversationId).find((item) => item.id === requested || canonicalIdentityId(item.id) === canonicalIdentityId(requested));
            if (!member)
                throw new Error("Selected person is not a known member of this chatroom");
            scopeId = member.id;
        }
        return this.#sharedConversationState.store.remember({
            scope: input.scope,
            scopeId,
            conversationId,
            kind,
            content,
            importance: input.importance,
            actorId: "admin:webui",
            sourceEventId: `admin:memory:${randomUUID()}`,
            ...(input.expiresInDays
                ? { expiresAt: Date.now() + input.expiresInDays * 24 * 60 * 60_000 }
                : {}),
        });
    }
    confirmChatroomMemory(botId, chatroomId, memoryId, extendDays) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        if (extendDays !== undefined && (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > 3650)) {
            throw new Error("Memory extension must be between 1 and 3650 days");
        }
        return this.#sharedConversationState.store.confirmConversationMemoryAsAdmin(memoryId, canonical, extendDays ? Date.now() + extendDays * 24 * 60 * 60_000 : undefined);
    }
    deleteChatroomMemory(botId, chatroomId, memoryId) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        this.#sharedConversationState.store.forgetConversationMemoryAsAdmin(memoryId, canonical, "管理员从群聊管理删除");
    }
    async saveGeneratedEmoji(botId, input) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        if (!(input.data instanceof Uint8Array) || input.data.byteLength < 1)
            throw new Error("Generated meme data is empty");
        if (!input.mimeType.startsWith("image/"))
            throw new Error("Generated meme must be an image");
        const assets = new LocalAssetStore({
            directory: safeDataPath(this.#dataDirectory, `bots/${bot.id}/assets`),
            maxAssetBytes: 512 * 1024 * 1024,
        });
        const asset = await assets.put({
            data: input.data,
            mimeType: input.mimeType,
            name: input.name?.trim() || "meme-generated",
            metadata: { kind: input.mimeType === "image/gif" ? "emoji" : "meme-generator", collectedByBotId: bot.id },
        });
        if (!asset.sha256)
            throw new Error("Generated meme asset has no content hash");
        const saved = this.#store.saveCollectedEmoji({
            botId: bot.id,
            asset,
            sha256: asset.sha256,
            description: input.description,
        });
        const emoji = saved.emoji.status === "ready"
            ? saved.emoji
            : this.#store.completeEmojiAnalysis(saved.emoji.id, input.description ?? "Meme 生成表情");
        this.#log("info", "emoji.meme_saved", "已将生成的 meme 保存到表情库", {
            emojiId: emoji.id,
            memeKey: input.memeKey,
            created: saved.created,
        }, bot.id);
        return emoji;
    }
    async sendChatroomMessage(botId, chatroomId, input) {
        const canonical = canonicalConversationId(chatroomId);
        this.#assertChatroomAccess(botId, canonical);
        const config = this.#fusionBotsForRoom(canonical).find((candidate) => candidate.id === botId);
        if (!config)
            throw new Error(`Bot ${botId} is not available for chatroom ${canonical}`);
        const managed = this.#runtimes.get(config.id);
        if (!managed)
            throw new Error(`Bot ${config.id} is not running`);
        // Do not reject an operator send because one preflight health probe had a
        // transient false negative. The proactive path persists to the durable
        // outbox first; a real channel failure remains pending for normal retry.
        const normalizedText = input.text?.normalize("NFKC").trim() ?? "";
        const emojiId = input.emojiId?.normalize("NFKC").trim() || undefined;
        if ((!normalizedText && !emojiId) || (normalizedText && emojiId)) {
            throw new Error("Choose exactly one of message text or emoji");
        }
        if (normalizedText.length > Math.min(config.limits.maxReplyChars, 4000)) {
            throw new Error(`Message text exceeds this bot's ${Math.min(config.limits.maxReplyChars, 4000)} character limit`);
        }
        const emoji = emojiId ? this.#store.getEmoji(emojiId) : undefined;
        if (emojiId && !emoji)
            throw new Error(`Emoji ${emojiId} does not exist`);
        if (emoji && emoji.status !== "ready")
            throw new Error(`Emoji ${emoji.id} is not ready`);
        const conversationId = this.#localConversationId(config, canonical);
        const eventId = `proactive:admin-message:${randomUUID()}`;
        const result = await managed.runtime.sendProactiveMessage({
            id: eventId,
            kind: "admin-message",
            conversationId,
            prompt: "管理员从 WebUI 主动发送的消息，不调用模型。",
            timestamp: Date.now(),
        }, normalizedText, emoji ? [{
                type: "image",
                asset: emojiAssetWithOwner(emoji),
                alt: emoji.description,
            }] : []);
        if (emoji)
            this.#store.markEmojiUsed(emoji.id);
        this.#log("info", "agent", "admin.chatroom_message_sent", emoji ? "管理员已从 WebUI 主动发送表情包" : "管理员已从 WebUI 主动发送群消息", {
            chatroomId: canonical,
            delivered: result.delivery.delivered.length,
            selectedBotId: config.id,
            kind: emoji ? "emoji" : "text",
            ...(emoji ? { emojiId: emoji.id, emojiOwnerBotId: emoji.botId } : {}),
        }, config.id);
        return {
            eventId,
            delivered: result.delivery.delivered.length,
            botId: config.id,
            kind: emoji ? "emoji" : "text",
            ...(emoji ? { emojiId: emoji.id } : {}),
        };
    }
    async checkGateway(id) {
        return (await this.#probeGateway(id, true)).health;
    }
    channelCapabilities(botId) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const plugin = this.#runtimes.get(botId)?.channel.plugin;
        return {
            botId,
            channelType: bot.channel.type,
            available: Boolean(plugin),
            features: plugin?.features ?? [],
            capabilities: plugin?.capabilities?.map((item) => item.capability) ?? [],
        };
    }
    async applyChannelIdentity(botId, personaProfileId, options = {}) {
        const persona = this.#store.getPersonaProfile(personaProfileId);
        if (!persona?.enabled)
            throw new Error(`Persona ${personaProfileId} is not available`);
        const channel = this.#runtimes.get(botId)?.channel;
        const applyIdentity = channel?.plugin?.applyIdentity;
        const allowed = options.force === true || persona.autoApplyAccountProfile;
        const result = {
            botId,
            personaProfileId,
            agentIdentityApplied: Boolean(channel),
            accountProfileApplied: false,
            groupNicknameApplied: false,
            ...(options.conversationId ? { conversationId: canonicalConversationId(options.conversationId) } : {}),
        };
        if (!allowed || typeof applyIdentity !== "function")
            return { ...result, skipped: "autoApplyAccountProfile is disabled" };
        const applied = await applyIdentity({ persona, conversationId: options.conversationId });
        return { ...result, ...applied, accountProfileApplied: true };
    }
    /** Copies one logical room's management state to every account known in that room. */
    synchronizeChatroomConfiguration(sourceBotId, chatroomId) {
        const source = this.#store.getBot(sourceBotId);
        if (!source)
            throw new Error(`Bot ${sourceBotId} does not exist`);
        const roomId = canonicalConversationId(chatroomId);
        this.#assertChatroomId(roomId);
        this.#rememberBotRoom(sourceBotId, roomId);
        const sourceOverride = source.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === roomId);
        const updatedBotIds = [];
        for (const target of this.#fusionBotsForRoom(roomId)) {
            if (target.id === sourceBotId)
                continue;
            const retained = target.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== roomId);
            const next = sourceOverride
                ? [...retained, cloneChatroomOverride(sourceOverride, roomId)]
                : retained;
            if (JSON.stringify(next) === JSON.stringify(target.chatroomModelOverrides))
                continue;
            this.#store.saveBot({ ...target, chatroomModelOverrides: next });
            updatedBotIds.push(target.id);
        }
        return updatedBotIds;
    }
    /** Copies logical-Agent defaults after an account-level configuration change. */
    synchronizeAgentConfiguration(sourceBotId) {
        const source = this.#store.getBot(sourceBotId);
        if (!source)
            throw new Error(`Bot ${sourceBotId} does not exist`);
        const sourceRooms = this.#roomsForBot(sourceBotId);
        const updatedBotIds = [];
        for (const target of this.#store.listBots()) {
            if (target.id === sourceBotId)
                continue;
            const sharedRooms = [...sourceRooms].filter((roomId) => this.#roomsForBot(target.id).has(roomId));
            if (sharedRooms.length === 0)
                continue;
            const fused = fusedBotConfiguration(source, target, sharedRooms);
            if (JSON.stringify(fused) === JSON.stringify(target))
                continue;
            this.#store.saveBot(fused);
            updatedBotIds.push(target.id);
        }
        return updatedBotIds;
    }
    listParticipationCases(id, query = {}) {
        return this.#withParticipationStore(id, (store) => store.listParticipationCases(query));
    }
    participationSummary(id) {
        return this.#withParticipationStore(id, (store) => store.participationSummary());
    }
    labelParticipationCase(id, eventId, label, reason) {
        const record = this.#withParticipationStore(id, (store) => store.labelParticipationCase(eventId, label, reason));
        this.#log("info", "agent", "participation.labeled", `参与案例已标注为 ${label}`, { eventId, label, hasReason: Boolean(reason?.trim()) }, id);
        return record;
    }
    labelReplyQualityCase(id, eventId, label, reason) {
        const record = this.#withParticipationStore(id, (store) => store.labelReplyQualityCase(eventId, label, reason));
        this.#log("info", "agent", "reply_quality.labeled", `回复质量已标注为 ${label}`, { eventId, label, hasReason: Boolean(reason?.trim()) }, id);
        return record;
    }
    pruneParticipationCases(id) {
        const settings = this.#store.getGlobalSettings();
        const result = this.#withParticipationStore(id, (store) => store.pruneParticipationCases(settings.participationRetentionDays, settings.maxParticipationCasesPerBot));
        this.#log("info", "agent", "participation.pruned", `已清理 ${result.deleted} 条参与案例`, result, id);
        return result;
    }
    async testWebhook(id) {
        const managed = this.#runtimes.get(id);
        if (!managed)
            throw new Error(`Bot ${id} is not running`);
        if (!managed.channel.testCallback)
            throw new Error("This channel does not provide a callback test event");
        const result = await managed.channel.testCallback();
        this.#log("info", "channel", "callback.test", "回调测试事件已发送", undefined, id);
        return result;
    }
    async ensureWebhook(id, webhookUrl) {
        const managed = this.#runtimes.get(id);
        if (!managed)
            throw new Error(`Bot ${id} is not running`);
        const registration = await managed.channel.registerCallback(webhookUrl);
        this.#log("info", "channel", "callback.registered", "回调已注册到通道", { registrationId: registration.id, url: registration.url, created: registration.created }, id);
        return registration;
    }
    #serialize(id, operation) {
        this.#assertOpen();
        const previous = this.#tails.get(id) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.#tails.set(id, current);
        current.then(() => {
            if (this.#tails.get(id) === current)
                this.#tails.delete(id);
        }, () => {
            if (this.#tails.get(id) === current)
                this.#tails.delete(id);
        });
        return current;
    }
    async #startNow(config, state) {
        state.enabled = true;
        state.phase = "starting";
        state.since = Date.now();
        state.lastError = null;
        this.#log("info", "bot", "bot.starting", `正在启动机器人 ${config.displayName}`, undefined, config.id);
        let core;
        let runtime;
        try {
            const settings = this.#store.getGlobalSettings();
            const knowledgeRetriever = settings.defaultKnowledgeProfileId
                ? this.#resolvedKnowledgeRetriever(settings.defaultKnowledgeProfileId)
                : undefined;
            const discoveredMcpServers = [];
            for (const profile of this.#store.listMcpServerProfiles().filter((item) => item.enabled)) {
                try {
                    const probe = await probeMcpServer(profile, this.#store.getMcpServerSecret(profile.id));
                    const secret = this.#store.getMcpServerSecret(profile.id);
                    discoveredMcpServers.push({
                        profile,
                        ...(secret ? { secret } : {}),
                        tools: probe.tools,
                    });
                    this.#log("info", "agent", "mcp.server_ready", `MCP 服务 ${profile.label} 已加载 ${probe.tools.length} 个工具`, {
                        serverId: profile.id,
                        latencyMs: probe.latencyMs,
                    }, config.id);
                }
                catch (error) {
                    this.#log("warn", "agent", "mcp.server_unavailable", `MCP 服务 ${profile.label} 暂不可用，已跳过：${errorMessage(error)}`, {
                        serverId: profile.id,
                    }, config.id);
                }
            }
            const mcpToolProvider = discoveredMcpServers.length > 0 ? createMcpToolProvider(discoveredMcpServers) : undefined;
            const databasePath = safeDataPath(this.#dataDirectory, config.databaseFile);
            const channelStateDirectory = safeDataPath(this.#dataDirectory, `bots/${config.id}/channel`);
            const channel = await this.#createManagedChannel(config, channelStateDirectory);
            const chatProfileId = config.chatModelProfileId ?? settings.defaultChatModelProfileId;
            const fallbackChatProfileIds = config.fallbackChatModelProfileIds;
            const internalFallbackProfileIdsFor = (profileId, requireImage) => {
                const primary = this.#requiredProfile(profileId, requireImage ? "vision" : "chat");
                const provider = this.#store.getProviderProfile(primary.providerProfileId);
                if (provider?.provider !== "aistudio")
                    return [];
                // Go directly from the configured Gemini model to the external
                // fallback. Rotating through more Gemini profiles only delays a
                // reply when the upstream account or gateway is unhealthy.
                return [];
            };
            const runnerCache = new Map();
            const runnerFor = (profileId) => {
                if (!profileId)
                    throw new Error("No default chat model profile is configured");
                const cached = runnerCache.get(profileId);
                if (cached)
                    return cached;
                const profileIds = [...new Set([
                        profileId,
                        // Keep enough Gemini redundancy for transient failures without
                        // slicing a 120s turn into 12s attempts when many profiles are enabled.
                        ...internalFallbackProfileIdsFor(profileId, false),
                        ...fallbackChatProfileIds.filter((id) => id !== profileId),
                        // The fast route is intentionally the reverse of the normal
                        // route: flash handles simple turns first, but the configured
                        // 27B primary remains available if flash itself fails.
                        ...(profileId === config.fastChatModelProfileId && chatProfileId !== profileId
                            ? [chatProfileId]
                            : []),
                    ])];
                const chain = profileIds.map((id) => this.#resolvedModel(id, "chat", false));
                // A hung provider must not consume the absolute turn deadline before the
                // remaining models get a chance. Divide the budget across the chain and
                // cap each non-final attempt so at least one fallback retains time.
                const attemptTimeoutMs = Math.max(5_000, Math.min(30_000, Math.floor(config.limits.agentTimeoutMs / chain.length)));
                const externalIndex = fallbackChatProfileIds.length > 0
                    ? profileIds.findIndex((id) => fallbackChatProfileIds.includes(id))
                    : -1;
                const geminiChainLabel = chain
                    .slice(0, externalIndex >= 0 ? externalIndex : chain.length)
                    .map(modelLabel)
                    .join(" → ");
                let next;
                for (let index = chain.length - 1; index >= 0; index -= 1) {
                    const resolved = chain[index];
                    const fallback = next;
                    const current = {
                        runtime: resolved,
                        external: fallbackChatProfileIds.includes(resolved.profile.id),
                        runner: new PiAgentRunner({
                            model: resolved.model,
                            apiKey: resolved.apiKey,
                            // The external fallback is a responsiveness escape hatch;
                            // do not carry an xhigh reasoning budget into degraded chat.
                            thinkingLevel: fallbackChatProfileIds.includes(resolved.profile.id)
                                ? "low"
                                : resolved.profile.thinkingLevel,
                            // Replies are hard-truncated to maxReplyChars anyway; capping the
                            // provider output stops paying for tokens that get thrown away.
                            maxOutputTokens: Math.min(8_192, Math.max(1_024, config.limits.maxReplyChars * 2)),
                            maxRetryDelayMs: resolved.profile.maxRetryDelayMs,
                            ...(fallback ? { attemptTimeoutMs } : {}),
                            ...(fallback
                                ? {
                                    fallbackRunner: fallback.runner,
                                    fallbackMode: fallback.external ? "degraded" : "internal",
                                    // A model chain is itself the retry strategy. Move to the
                                    // next Gemini immediately so one provider cannot consume
                                    // two calls before GPT/local get a chance within the turn budget.
                                    retryDelaysMs: [],
                                    circuitBreakerCooldownMs: 60_000,
                                    onFallback: (error, reason, request) => {
                                        const external = fallback.external;
                                        this.#log("warn", "agent", external ? "model.external_fallback" : "model.gemini_rotated", external
                                            ? `${modelLabel(resolved)} 暂不可用，已按降级链切换到 ${modelLabel(fallback.runtime)}`
                                            : `${modelLabel(resolved)} 暂不可用，已在 Gemini 内部切换到 ${modelLabel(fallback.runtime)}`, {
                                            primaryModel: modelLabel(resolved),
                                            fallbackModel: modelLabel(fallback.runtime),
                                            fallbackKind: external ? "external" : "gemini-internal",
                                            reason,
                                            sessionId: request.sessionId,
                                            error,
                                        }, config.id);
                                        if (external && reason === "primary-failed") {
                                            void this.#notifyModelFallback({
                                                sourceBotId: config.id,
                                                primaryModel: geminiChainLabel || modelLabel(resolved),
                                                fallbackModel: modelLabel(fallback.runtime),
                                                sessionId: request.sessionId,
                                                error,
                                            });
                                        }
                                    },
                                }
                                : {}),
                        }),
                    };
                    next = current;
                }
                const value = { runner: next.runner, runtime: chain[0] };
                runnerCache.set(profileId, value);
                return value;
            };
            const defaultChat = runnerFor(chatProfileId);
            const fastChat = config.fastChatModelProfileId
                ? runnerFor(config.fastChatModelProfileId)
                : undefined;
            // Keep the participation judge on the configured text-model chain.
            // This lets deployments use the same external Qwen/compatible model
            // family for chat, vision, and participation decisions.
            const autoParticipationEnabled = config.plugins.some((plugin) => plugin.type === "auto-participation" && plugin.enabled);
            const judgeProfiles = this.#store.listModelProfiles().filter((candidate) => {
                const provider = this.#store.getProviderProfile(candidate.providerProfileId);
                return candidate.enabled && candidate.input.includes("text") && provider?.enabled === true;
            });
            const participationJudgeProfileId = autoParticipationEnabled ? selectParticipationProfileId([
                config.participationJudgeModelProfileId,
                config.fastChatModelProfileId,
                chatProfileId,
                settings.defaultChatModelProfileId,
            ], judgeProfiles) : undefined;
            const participationJudgePrimary = participationJudgeProfileId
                ? this.#requiredProfile(participationJudgeProfileId, "participation judge")
                : undefined;
            const participationJudgeProfileIds = participationJudgePrimary
                ? [...new Set([
                    participationJudgePrimary.id,
                    ...config.fallbackChatProfileIds.filter((id) => id !== participationJudgePrimary.id &&
                        judgeProfiles.some((candidate) => candidate.id === id)),
                ])]
                : [];
            const participationJudgeChain = participationJudgeProfileIds.map((id) => this.#resolvedModel(id, "participation judge", false));
            // Keep participation judging isolated from the final reply chain while
            // allowing the configured fallback model to handle provider failures.
            let participationJudgeRunner;
            for (let index = participationJudgeChain.length - 1; index >= 0; index -= 1) {
                const resolved = participationJudgeChain[index];
                const fallback = participationJudgeRunner;
                participationJudgeRunner = new PiAgentRunner({
                    model: resolved.model,
                    apiKey: resolved.apiKey,
                    thinkingLevel: "off",
                    maxOutputTokens: Math.min(resolved.profile.maxTokens, 128),
                    maxRetryDelayMs: Math.min(resolved.profile.maxRetryDelayMs, 1_000),
                    retryDelaysMs: [],
                    attemptTimeoutMs: Math.min(config.limits.agentTimeoutMs, 20_000),
                    ...(fallback ? {
                        fallbackRunner: fallback,
                        fallbackMode: "internal",
                        circuitBreakerCooldownMs: 60_000,
                    } : {}),
                });
            }
            const fallbackChats = fallbackChatProfileIds.map((id) => this.#resolvedModel(id, "chat fallback", false));
            // CPA exposes the native Gemini media endpoints alongside its
            // OpenAI-compatible chat endpoint.
            const aistudioClient = isNativeGeminiGateway(defaultChat.runtime)
                ? new AistudioClient({
                    baseUrl: defaultChat.runtime.providerProfile.baseUrl,
                    apiKey: defaultChat.runtime.apiKey,
                    timeoutMs: Math.max(120_000, channelTimeoutMs(config.channel)),
                })
                : undefined;
            // TTS availability and circuit state remain independent from text and
            // vision. Every Gemini speech model is bound explicitly so a 429 rotates
            // through Gemini capacity before Edge TTS and local Kokoro are considered.
            const geminiTtsEnabled = this.#env.PI_GEMINI_TTS_ENABLED?.trim().toLocaleLowerCase() === "true";
            let speechClient = geminiTtsEnabled ? aistudioClient : undefined;
            const ttsApiBaseUrl = this.#env.PI_TTS_API_BASE_URL?.trim();
            if (ttsApiBaseUrl) {
                const edgeVoice = this.#env.PI_TTS_API_EDGE_VOICE?.trim() || "zh-CN-XiaoxiaoNeural";
                const kokoroVoice = this.#env.PI_TTS_API_KOKORO_VOICE?.trim() || "zf_xiaoxiao";
                const ttsApiKey = this.#env.PI_TTS_API_KEY?.trim();
                const sharedTtsApiOptions = {
                    baseUrl: ttsApiBaseUrl,
                    timeoutMs: 180_000,
                    speed: Number(this.#env.PI_TTS_API_SPEED?.trim() || 1),
                    ...(ttsApiKey ? { apiKey: ttsApiKey } : {}),
                };
                const edgeTtsClient = new TtsApiClient({
                    ...sharedTtsApiOptions,
                    engine: "edge",
                    voice: edgeVoice,
                });
                const kokoroTtsClient = new TtsApiClient({
                    ...sharedTtsApiOptions,
                    engine: "kokoro",
                    voice: kokoroVoice,
                });
                speechClient = aistudioClient && geminiTtsEnabled
                    ? new ResilientSpeechSynthesizer({
                        entries: [
                            {
                                label: "gemini/gemini-3.1-flash-tts-preview",
                                model: "gemini-3.1-flash-tts-preview",
                                synthesizer: aistudioClient,
                            },
                            {
                                label: "gemini/gemini-2.5-flash-preview-tts",
                                model: "gemini-2.5-flash-preview-tts",
                                synthesizer: aistudioClient,
                            },
                            {
                                label: "gemini/gemini-2.5-pro-preview-tts",
                                model: "gemini-2.5-pro-preview-tts",
                                synthesizer: aistudioClient,
                            },
                            { label: `tts-api/edge/${edgeVoice}`, synthesizer: edgeTtsClient },
                            { label: `tts-api/kokoro/${kokoroVoice}`, synthesizer: kokoroTtsClient },
                        ],
                        retryDelaysMs: [500, 1_500],
                        circuitBreakerCooldownMs: 60_000,
                        onFallback: ({ error, from, to }) => {
                            const edge = to.startsWith("tts-api/edge/");
                            const local = to.startsWith("tts-api/kokoro/");
                            this.#log("warn", "agent", local ? "tts.local_fallback" : edge ? "tts.edge_fallback" : "tts.gemini_rotated", local
                                ? "Edge TTS 暂不可用，已独立切换到本地 Kokoro"
                                : edge
                                    ? "Gemini TTS 模型链暂不可用，已切换到 Edge TTS"
                                    : `${from} 暂不可用，语音合成已在 Gemini 内部切换到 ${to}`, { from, to, fallbackKind: local ? "local" : edge ? "edge" : "gemini-internal", error }, config.id);
                        },
                    })
                    : new ResilientSpeechSynthesizer({
                        entries: [
                            { label: `tts-api/edge/${edgeVoice}`, synthesizer: edgeTtsClient },
                            { label: `tts-api/kokoro/${kokoroVoice}`, synthesizer: kokoroTtsClient },
                        ],
                        retryDelaysMs: [],
                    });
            }
            let embeddingUnavailableUntil = 0;
            const memoryEmbeddingProvider = aistudioClient
                ? {
                    model: DEFAULT_EMBEDDING_MODEL,
                    embed: async (texts, task) => {
                        if (Date.now() < embeddingUnavailableUntil) {
                            throw new Error("AIStudio embedding circuit is temporarily open");
                        }
                        try {
                            const vectors = await aistudioClient.embedContents(texts, {
                                model: DEFAULT_EMBEDDING_MODEL,
                                taskType: task === "retrieval_query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
                            });
                            embeddingUnavailableUntil = 0;
                            return vectors;
                        }
                        catch (error) {
                            embeddingUnavailableUntil = Date.now() + 60_000;
                            throw error;
                        }
                    },
                }
                : undefined;
            const mediaToolProvider = aistudioClient
                ? createAistudioMediaToolProvider({
                    client: aistudioClient,
                    ...(speechClient ? { speechClient } : {}),
                    assets: channel.assets,
                    sendImage: channel.plugin.features?.some((feature) => feature.id === CHANNEL_FEATURE_SEND_IMAGE.id && feature.version >= CHANNEL_FEATURE_SEND_IMAGE.version) ?? false,
                    sendVoice: channel.plugin.features?.some((feature) => feature.id === CHANNEL_FEATURE_SEND_VOICE.id && feature.version >= CHANNEL_FEATURE_SEND_VOICE.version) ?? false,
                    ttsDefaults: (event) => {
                        const voiceStyle = this.#conversationVoiceStyle(config.id, event.conversation.id);
                        const mode = this.#store.getConversationVoiceMode(config.id, event.conversation.id);
                        return {
                            voice: voiceStyle.voice,
                            style: mode === "whisper"
                                ? `${voiceStyle.style}；${WHISPER_TTS_STYLE}`.slice(0, 200)
                                : voiceStyle.style,
                        };
                    },
                    log: (level, event, message, details) => this.#log(level, "agent", event, message, details, config.id),
                })
                : undefined;
            const chatroomRunners = new Map();
            for (const override of config.chatroomModelOverrides) {
                if (override.chatModelProfileId) {
                    chatroomRunners.set(override.chatroomId, runnerFor(override.chatModelProfileId).runner);
                }
            }
            const visionCache = new Map();
            const visionFor = (profileId) => {
                const cached = visionCache.get(profileId);
                if (cached)
                    return cached;
                const externalVisionProfileIds = fallbackChatProfileIds.filter((candidateId) => candidateId !== profileId && this.#requiredProfile(candidateId, "vision fallback").input.includes("image"));
                const profileIds = [...new Set([
                        profileId,
                        ...internalFallbackProfileIdsFor(profileId, true),
                        ...externalVisionProfileIds,
                ])];
                const chain = profileIds.map((id) => this.#resolvedModel(id, "vision", true));
                // Each vision hop needs its own generous deadline. Do not divide the
                // configured timeout across the chain: vision is slower than text.
                const visionAttemptTimeoutMs = Math.max(20_000, config.limits.imageUnderstandingTimeoutMs);
                const entries = chain.map((resolved) => {
                    const degraded = externalVisionProfileIds.includes(resolved.profile.id);
                    return {
                        label: modelLabel(resolved),
                        degraded,
                        provider: new PiImageUnderstandingProvider({
                            model: resolved.model,
                            apiKey: resolved.apiKey,
                            thinkingLevel: degraded
                                ? "minimal"
                                : resolved.profile.thinkingLevel === "off"
                                    ? "minimal"
                                    : resolved.profile.thinkingLevel,
                            maxTokens: Math.min(resolved.model.maxTokens, 800),
                            maxImageBytes: config.limits.maxImageBytes,
                            timeoutMs: visionAttemptTimeoutMs,
                            maxRetryDelayMs: Math.min(resolved.profile.maxRetryDelayMs, 2_000),
                        }),
                    };
                });
                const externalIndex = externalVisionProfileIds.length > 0
                    ? profileIds.findIndex((id) => externalVisionProfileIds.includes(id))
                    : -1;
                const geminiChainLabel = chain
                    .slice(0, externalIndex >= 0 ? externalIndex : chain.length)
                    .map(modelLabel)
                    .join(" → ");
                const value = {
                    runtime: chain[0],
                    provider: new FallbackImageUnderstandingProvider({
                        entries,
                        circuitBreakerCooldownMs: 60_000,
                        onFallback: ({ error, from, to, degraded, request }) => {
                            this.#log("warn", "agent", degraded ? "vision.external_fallback" : "vision.gemini_rotated", degraded
                                ? `Gemini 视觉模型链暂不可用，已使用最终视觉降级模型 ${to}`
                                : `${from} 暂不可用，视觉识别已在 Gemini 内部切换到 ${to}`, { from, to, fallbackKind: degraded ? "external" : "gemini-internal", error, messageId: request.messageId }, config.id);
                            if (degraded) {
                                void this.#notifyModelFallback({
                                    sourceBotId: config.id,
                                    primaryModel: geminiChainLabel || from,
                                    fallbackModel: to,
                                    sessionId: `vision:${request.conversationId}:${request.messageId}`,
                                    error,
                                });
                            }
                        },
                    }),
                };
                visionCache.set(profileId, value);
                return value;
            };
            // A vision profile is optional in the admin UI, but image messages
            // must still be actionable. When no explicit vision profile exists,
            // select an enabled Gemini profile that advertises image input so
            // the main model never has to answer from an image placeholder.
            const configuredVisionProfileId = config.visionModelProfileId ?? settings.defaultVisionModelProfileId;
            const geminiVisionProfiles = this.#store.listModelProfiles().filter((candidate) => {
                const provider = this.#store.getProviderProfile(candidate.providerProfileId);
                return isGeminiVisionProfile(candidate, provider);
            });
            const defaultVisionProfileId = configuredVisionProfileId ?? selectGeminiVisionProfileId([
                chatProfileId,
                config.fastChatModelProfileId,
            ], geminiVisionProfiles);
            const defaultVision = config.imageUnderstandingEnabled && defaultVisionProfileId
                ? visionFor(defaultVisionProfileId)
                : undefined;
            const chatroomVisionProviders = new Map();
            if (config.imageUnderstandingEnabled) {
                for (const override of config.chatroomModelOverrides) {
                    if (override.visionModelProfileId) {
                        chatroomVisionProviders.set(override.chatroomId, visionFor(override.visionModelProfileId).provider);
                    }
                }
            }
            const scheduledTaskConfig = config.plugins.find((plugin) => plugin.type === "scheduled-task");
            const autoParticipationConfig = config.plugins.find((plugin) => plugin.type === "auto-participation" && plugin.enabled);
            const scheduledTaskToolProvider = scheduledTaskConfig
                ? createScheduledTaskToolProvider({
                    botId: config.id,
                    identityId: config.identityId,
                    identityAliases: (event) => this.#fusionPeerBots(config.id, event.conversation.id)
                        .map((bot) => bot.identityId),
                    timezoneOffsetMinutes: config.socialSchedule.timezoneOffsetMinutes,
                    config: scheduledTaskConfig,
                    repository: this.#store,
                    isEnabled: (event) => {
                        const current = this.#store.getBot(config.id) ?? config;
                        const plugin = current.plugins.find((item) => item.type === scheduledTaskConfig.type) ?? scheduledTaskConfig;
                        return agentPluginEnabled(current, plugin, event.conversation.id);
                    },
                    log: (level, event, message, details) => this.#log(level, "agent", event, message, details, config.id),
                })
                : undefined;
            core = new GroupAgentCore({
                bot: { id: config.identityId, displayName: config.displayName, wakeWords: config.wakeWords },
                botIdentityResolver: (event) => this.#resolveBotIdentity(config.id, event, config),
                sessionNamespace: config.id,
                runner: defaultChat.runner,
                voiceModeResolver: (event) => this.#store.getConversationVoiceMode(config.id, event.conversation.id),
                sharedConversationState: this.#sharedConversationState,
                identityAliasesResolver: (event) => this.#fusionPeerBots(config.id, event.conversation.id)
                    .map((bot) => bot.identityId),
                ...(chatroomRunners.size > 0 || fastChat
                    ? {
                        runnerResolver: (event) => chatroomValue(chatroomRunners, event) ??
                            (fastChat && shouldUseFastChatModel(event) ? fastChat.runner : defaultChat.runner),
                        ...(fastChat ? { fastTurnResolver: (event) => shouldUseFastChatModel(event) } : {}),
                    }
                    : {}),
                ...(participationJudgeRunner ? { participationJudgeRunner } : {}),
                ...(participationJudgeRunner ? { emojiBattleRunner: participationJudgeRunner } : {}),
                databasePath,
                ...(config.soul ? { soul: config.soul } : {}),
                soulResolver: (event) => this.#resolvePersonaSoul(config.id, event),
                sessionKeyResolver: (event) => this.#resolvePersonaId(config.id, event) ?? "default",
                defaultGroupActivation: autoParticipationConfig ? "always" : config.defaultGroupActivation,
                operatorIds: config.operatorIds,
                historyLimit: config.limits.historyLimit,
                maxHistoryChars: config.limits.maxHistoryChars,
                memoryLimit: config.limits.memoryLimit,
                behaviorLimit: config.limits.behaviorLimit,
                continuationWindowMs: config.limits.continuationWindowMs,
                maxReplyChars: config.limits.maxReplyChars,
                maxAgentLlmCalls: config.limits.maxAgentLlmCalls,
                maxAgentToolCalls: config.limits.maxAgentToolCalls,
                agentTimeoutMs: config.limits.agentTimeoutMs,
                ...(memoryEmbeddingProvider ? { memoryEmbeddingProvider } : {}),
                ...(knowledgeRetriever ? { knowledgeRetriever } : {}),
                toolProviders: [
                    ...(scheduledTaskToolProvider ? [scheduledTaskToolProvider] : []),
                    ...(mcpToolProvider ? [mcpToolProvider] : []),
                    ...(mediaToolProvider ? [mediaToolProvider] : []),
                    createAgentToolsProvider({
                        workspaceDirectory: safeDataPath(this.#dataDirectory, `bots/${config.id}/workspace`),
                        ...(knowledgeRetriever ? { knowledgeRetriever } : {}),
                        assets: channel.assets,
                        sendImage: channel.plugin.features?.some((feature) => feature.id === CHANNEL_FEATURE_SEND_IMAGE.id && feature.version >= CHANNEL_FEATURE_SEND_IMAGE.version) ?? false,
                        enableShell: this.#env.PI_AGENT_ENABLE_SHELL?.trim().toLowerCase() === "true",
                        pythonCommand: this.#env.PI_AGENT_PYTHON_COMMAND?.trim() || "python3",
                    }),
                    ...(this.#env.PI_BROWSER_CDP_URL?.trim()
                        ? [() => [createBrowserTool({ cdpUrl: this.#env.PI_BROWSER_CDP_URL.trim() })]]
                        : []),
                    createEmojiToolProvider(this.#store, config.id, () => this.#store.listBots()
                        .filter((bot) => bot.enabled)
                        .map((bot) => bot.id), {
                        mode: config.emojiMode,
                        candidateLimit: config.emojiCandidateLimit,
                        log: (level, event, message, details) => this.#log(level, "agent", event, message, details, config.id),
                    }),
                ],
                ...(defaultVision
                    ? {
                        imageUnderstandingProvider: defaultVision.provider,
                    }
                    : {}),
                ...(chatroomVisionProviders.size > 0
                    ? {
                        imageUnderstandingProviderResolver: (event) => chatroomValue(chatroomVisionProviders, event) ?? defaultVision?.provider,
                    }
                    : {}),
                maxImageUnderstandingCalls: config.limits.maxImageUnderstandingCalls,
                maxImageBytes: config.limits.maxImageBytes,
                maxImageEvidenceChars: config.limits.maxImageEvidenceChars,
                imageUnderstandingTimeoutMs: config.limits.imageUnderstandingTimeoutMs,
                imageContextMessageLimit: config.limits.imageContextMessageLimit,
                imageContextWindowMs: config.limits.imageContextWindowMs,
                maxAvailableImagesPerTurn: config.limits.maxAvailableImagesPerTurn,
                socialSchedule: {
                    enabled: config.socialSchedule.enabled,
                    timezoneOffsetMinutes: config.socialSchedule.timezoneOffsetMinutes,
                    activeStartMinute: config.socialSchedule.activeStartMinute,
                    activeEndMinute: config.socialSchedule.activeEndMinute,
                    hotChatWindowMs: config.socialSchedule.hotChatWindowMs,
                    hotChatMinMessages: config.socialSchedule.hotChatMinMessages,
                    hotChatMinParticipants: config.socialSchedule.hotChatMinParticipants,
                },
                autoParticipationGate: (event) => {
                    if (!autoParticipationConfig)
                        return false;
                    const current = this.#store.getBot(config.id) ?? config;
                    const plugin = current.plugins.find((item) => item.type === autoParticipationConfig.type) ?? autoParticipationConfig;
                    return agentPluginEnabled(current, plugin, event.conversation.id);
                },
                participationIntensityResolver: (event) => {
                    if (event.conversation.kind !== "group")
                        return "standard";
                    const current = this.#store.getBot(config.id) ?? config;
                    return current.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === canonicalConversationId(event.conversation.id))?.participationIntensity ?? "standard";
                },
                responseGate: (event, reason) => this.#claimSharedReply(config, event, reason),
                responseGateRelease: (event, reason) => this.#releaseSharedReply(config, event, reason),
                // Tool progress is internal and should not be emitted as a chat message.
                toolCallFeedback: () => {},
                proactiveGate: async (event, reason) => {
                    const selected = (await this.#healthyFusionBotsForRoom(event.conversation.id, true))[0];
                    if (!selected || selected.id !== config.id)
                        return false;
                    const now = Date.now();
                    const { startAt } = localDay(now, config.socialSchedule.timezoneOffsetMinutes);
                    return this.#store.claimProactive({
                        claimKey: `${reason}:${sharedReplyFingerprint(event)}`,
                        canonicalConversationId: canonicalConversationId(event.conversation.id),
                        botId: config.id,
                        reason,
                        createdAt: now,
                        ambient: true,
                        cooldownMs: config.socialSchedule.hotChatCooldownMs,
                        botCooldownMs: config.socialSchedule.hotChatCooldownMs,
                        dailyLimit: config.socialSchedule.maxDailyAmbientMessages,
                        dayStartAt: startAt,
                    });
                },
                onTrace: (event) => this.#trace(config.id, event),
            });
            core.pruneParticipationCases(settings.participationRetentionDays, settings.maxParticipationCasesPerBot);
            runtime = new ChannelRuntime({
                core,
                plugin: channel.plugin,
                messageBurstDebounceMs: config.limits.messageBurstDebounceMs,
                explicitMessageBurstDebounceMs: config.limits.explicitMessageBurstDebounceMs,
                messageBurstExplicitSignal: (event) => {
                    const identity = this.#resolveBotIdentity(config.id, event, config);
                    return explicitlyAddressesBot(event, [
                        config.identityId,
                        ...this.#fusionPeerBots(config.id, event.conversation.id).map((bot) => bot.identityId),
                    ], [identity.displayName, ...identity.wakeWords]);
                },
                onError: (error, context) => {
                    this.#log("error", "channel", `runtime.${context.phase}`, errorMessage(error), { ...context }, config.id);
                },
            });
            if (aistudioClient) {
                const transcriptionModels = [...new Set([
                        defaultChat.runtime.model.id,
                        ...fallbackChatProfileIds
                            .map((id) => this.#requiredProfile(id, "audio transcription fallback").modelId),
                        ...internalFallbackProfileIdsFor(defaultChat.runtime.profile.id, false)
                            .map((id) => this.#requiredProfile(id, "audio transcription").modelId),
                    ])];
                runtime.setInboundTransformers([
                    async (event) => {
                        if (!channel.assets || !hasEmojiImage(event))
                            return event;
                        const visionProvider = config.imageUnderstandingEnabled
                            ? chatroomValue(chatroomVisionProviders, event) ?? defaultVision?.provider
                            : undefined;
                        if (!visionProvider)
                            return event;
                        try {
                            const emoji = await collectInboundEmoji(event, {
                                botId: config.id,
                                store: this.#store,
                                assets: channel.assets,
                                mediaResolver: { resolve: (asset) => runtime.invoke(MEDIA_RESOLVE_CAPABILITY, { asset }) },
                                visionProvider,
                                maxImageBytes: config.limits.maxImageBytes,
                                timeoutMs: config.limits.imageUnderstandingTimeoutMs,
                                log: (level, name, message, details) => this.#log(level, "agent", name, message, details, config.id),
                            });
                            if (!emoji?.description.trim())
                                return event;
                            return {
                                ...event,
                                text: `[收到的表情包描述] ${emoji.description}`,
                                metadata: { ...event.metadata, emojiBattleDescription: emoji.description },
                            };
                        }
                        catch (error) {
                            this.#log("warn", "agent", "emoji.battle_description_failed", errorMessage(error), {
                                eventId: event.id,
                                conversationId: event.conversation.id,
                            }, config.id);
                            return event;
                        }
                    },
                    async (event) => {
                        if (!event.parts?.some((part) => part.type === "voice" && !part.transcript?.trim()))
                            return event;
                        const startedAt = Date.now();
                        try {
                            const enriched = await enrichInboundVoiceTranscripts({
                                event,
                                mediaResolver: {
                                    resolve: async (asset) => {
                                        let lastError;
                                        for (const delayMs of [0, 400, 1_200]) {
                                            if (delayMs > 0)
                                                await delay(delayMs);
                                            try {
                                                return await runtime.invoke(MEDIA_RESOLVE_CAPABILITY, { asset });
                                            }
                                            catch (error) {
                                                lastError = error;
                                                if (!isTransientVoiceMediaError(error))
                                                    break;
                                            }
                                        }
                                        throw lastError;
                                    },
                                },
                                provider: {
                                    transcribe: async (request) => {
                                        let lastError;
                                        for (const model of transcriptionModels) {
                                            for (const delayMs of [0, 500]) {
                                                if (delayMs > 0)
                                                    await delay(delayMs);
                                                try {
                                                    return await aistudioClient.transcribeAudio(request.data, request.mimeType, model);
                                                }
                                                catch (error) {
                                                    lastError = error;
                                                    if (!isTransientAudioTranscriptionError(error))
                                                        throw error;
                                                }
                                            }
                                        }
                                        throw lastError;
                                    },
                                },
                                cache: this.#voiceTranscriptCache,
                            });
                            this.#log("info", "agent", "voice.transcribed", "入站语音已转写", {
                                eventId: event.id,
                                conversationId: event.conversation.id,
                                transcribed: enriched.transcribed,
                                cacheHits: enriched.cacheHits,
                                durationMs: Date.now() - startedAt,
                                models: transcriptionModels,
                            }, config.id);
                            return enriched.event;
                        }
                        catch (error) {
                            this.#log("warn", "agent", "voice.transcription_failed", errorMessage(error), {
                                eventId: event.id,
                                conversationId: event.conversation.id,
                                durationMs: Date.now() - startedAt,
                                models: transcriptionModels,
                            }, config.id);
                            return event;
                        }
                    },
                ]);
            }
            const plugins = this.#createAgentPlugins(config, core, runtime, channel.assets);
            runtime.setInboundHandlers([
                (event) => {
                    this.#observeLiveGroupRoom(config.id, event);
                    return undefined;
                },
                async (event) => {
                    if (!channel.assets || !hasEmojiImage(event))
                        return undefined;
                    const visionProvider = config.imageUnderstandingEnabled
                        ? chatroomValue(chatroomVisionProviders, event) ?? defaultVision?.provider
                        : undefined;
                    // Collection and visual labelling are enrichment work. Never hold the
                    // ordered channel ingest path while an upstream vision service retries.
                    void collectInboundEmoji(event, {
                        botId: config.id,
                        store: this.#store,
                        assets: channel.assets,
                        mediaResolver: { resolve: (asset) => runtime.invoke(MEDIA_RESOLVE_CAPABILITY, { asset }) },
                        ...(visionProvider ? { visionProvider } : {}),
                        maxImageBytes: config.limits.maxImageBytes,
                        timeoutMs: config.limits.imageUnderstandingTimeoutMs,
                        log: (level, name, message, details) => this.#log(level, "agent", name, message, details, config.id),
                    }).catch((error) => {
                        this.#log("warn", "agent", "emoji.collect_failed", errorMessage(error), { eventId: event.id }, config.id);
                    });
                    return undefined;
                },
                ...plugins
                    .filter((plugin) => plugin.handleInbound !== undefined)
                    .map((plugin) => (event) => plugin.handleInbound(event)),
            ]);
            await runtime.start();
            for (const plugin of plugins)
                await plugin.start?.();
            this.#runtimes.set(config.id, { core, runtime, channel, plugins });
            if (defaultVision && channel.assets) {
                this.#emojiAnalysisRetriers.set(config.id, (emoji) => retryEmojiAnalysis(emoji, {
                    store: this.#store,
                    assets: { resolve: (asset) => this.#resolveEmojiAsset(asset, emoji.botId) },
                    visionProvider: defaultVision.provider,
                    maxImageBytes: config.limits.maxImageBytes,
                    timeoutMs: config.limits.imageUnderstandingTimeoutMs,
                    log: (level, name, message, details) => this.#log(level, "agent", name, message, details, config.id),
                }));
            }
            state.phase = "running";
            state.since = Date.now();
            state.startedAt = Date.now();
            state.webhookAddress = channel.callbackAddress() ?? null;
            state.chatModel = modelLabel(defaultChat.runtime);
            state.visionModel = defaultVision ? modelLabel(defaultVision.runtime) : null;
            state.chatroomModelOverrides = config.chatroomModelOverrides.length;
            this.#log("info", "bot", "bot.running", `机器人 ${config.displayName} 已运行`, {
                chatModel: state.chatModel,
                fallbackChatModels: fallbackChats.map(modelLabel),
                visionModel: state.visionModel,
                chatroomModelOverrides: state.chatroomModelOverrides,
                webhook: state.webhookAddress,
            }, config.id);
            await this.checkGateway(config.id).catch(() => undefined);
        }
        catch (error) {
            if (runtime?.running)
                await runtime.stop().catch(() => undefined);
            core?.close();
            state.phase = "error";
            state.since = Date.now();
            state.startedAt = null;
            state.lastError = errorMessage(error);
            state.gatewayHealthy = null;
            state.webhookAddress = null;
            this.#log("error", "bot", "bot.start_failed", state.lastError, undefined, config.id);
        }
    }
    #createAgentPlugins(config, core, runtime, assets) {
        const registry = createBuiltInAgentPluginRegistry();
        const personaCommand = { id: "persona-command", type: "persona-command", enabled: true, settings: {} };
        const builtIns = withImplicitBuiltInPlugins(config.plugins);
        const pluginConfigs = builtIns.some((plugin) => plugin.type === "persona-command")
            ? builtIns.map((plugin) => plugin.type === "persona-command" ? { ...plugin, enabled: true } : plugin)
            : [...builtIns, personaCommand];
        // Instantiate every built-in once. Per-room commands mutate AdminStore and the
        // hot path below reads it dynamically, so enabling a disabled plugin is immediate.
        return pluginConfigs.map((pluginConfig) => registry.create(pluginConfig, {
            botId: config.id,
            identityId: config.identityId,
            identityAliases: (conversationId) => this.#fusionPeerBots(config.id, conversationId)
                .map((bot) => bot.identityId),
            timezoneOffsetMinutes: config.socialSchedule.timezoneOffsetMinutes,
            core,
            runtime,
            ...(assets ? { assets } : {}),
            scheduledTasks: this.#store,
            personas: {
                list: () => this.#store.listPersonaProfiles(),
                current: (conversationId) => this.#conversationPersona(config.id, conversationId),
                set: (conversationId, personaProfileId) => this.#setConversationPersona(config.id, conversationId, personaProfileId),
            },
            management: {
                isManager: (conversationId, senderId) => {
                    const current = this.#store.getBot(config.id) ?? config;
                    return isConversationManager(current, conversationId, senderId);
                },
                listManagerIds: (conversationId) => {
                    const current = this.#store.getBot(config.id) ?? config;
                    return conversationManagerIds(current, conversationId);
                },
                redEnvelopeTargetIds: (conversationId) => {
                    const current = this.#store.getBot(config.id) ?? config;
                    const roomId = canonicalConversationId(conversationId);
                    return current.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === roomId)?.redEnvelopeTargetIds ?? [];
                },
                memberDisplayName: (conversationId, memberId) => {
                    const canonicalRoom = canonicalConversationId(conversationId);
                    const member = this.#sharedConversationState.store.listMembers(canonicalRoom).find((item) => canonicalIdentityId(item.id) === canonicalIdentityId(memberId));
                    return safeGroupDisplayName(member?.displayName, memberId);
                },
                resetContext: (conversationId, actorId, sourceEventId) => core.resetConversationContext(conversationId, actorId, sourceEventId),
                contextReset: (conversationId) => core.conversationContextReset(conversationId),
                sessionStatuses: (conversationId) => this.#roomsForBot(config.id).has(canonicalConversationId(conversationId))
                    ? this.listChatroomSessions(config.id, conversationId)
                    : [this.#directConversationSession(config, conversationId, core.conversationContextReset(conversationId))],
                listPlugins: (conversationId) => this.#conversationPlugins(config.id, conversationId),
                setPlugin: (conversationId, pluginType, enabled) => this.#setConversationPlugin(config.id, conversationId, pluginType, enabled),
                voiceStyle: (conversationId) => this.#conversationVoiceStyle(config.id, conversationId),
                setVoiceStyle: (conversationId, query) => this.#setConversationVoiceStyle(config.id, conversationId, query),
                voiceMode: (conversationId) => this.#store.getConversationVoiceMode(config.id, conversationId),
                setVoiceMode: (conversationId, mode) => this.#store.setConversationVoiceMode(config.id, conversationId, mode),
                historyLimit: config.limits.historyLimit,
                maxHistoryChars: config.limits.maxHistoryChars,
            },
            claim: (input) => this.#store.claimProactive({ ...input, botId: config.id }),
            releaseClaim: (claimKey) => this.#store.releaseProactiveClaim(claimKey, config.id),
            isEnabledForConversation: (pluginType, conversationId) => {
                const current = this.#store.getBot(config.id) ?? config;
                const currentPlugin = current.plugins.find((item) => item.type === pluginType) ?? pluginConfig;
                return agentPluginEnabled(current, currentPlugin, conversationId);
            },
            log: (level, event, message, details) => this.#log(level, "agent", event, message, details, config.id),
        }));
    }
    #bootstrapSharedConversationState() {
        const groups = new Map();
        const importMemoryByRoom = new Map();
        const importBehaviorByRoom = new Map();
        let importedMemories = 0;
        let importedBehaviors = 0;
        for (const bot of this.#store.listBots()) {
            for (const override of bot.chatroomModelOverrides) {
                this.#rememberBotRoom(bot.id, canonicalConversationId(override.chatroomId));
            }
            const local = new SqliteStore(safeDataPath(this.#dataDirectory, bot.databaseFile), { recoverProcessing: false });
            try {
                for (const activity of local.listGroupActivity(0, Date.now() + 1, 1)) {
                    const roomId = canonicalConversationId(activity.conversationId);
                    this.#rememberBotRoom(bot.id, roomId);
                    const group = groups.get(roomId) ?? { messages: [] };
                    if (!group.title && activity.conversationTitle)
                        group.title = activity.conversationTitle;
                    group.messages.push(...local.exportConversationMessages(activity.conversationId));
                    const reset = local.getConversationContextReset(activity.conversationId);
                    if (reset && (!group.latestReset || reset.resetAt > group.latestReset.resetAt))
                        group.latestReset = reset;
                    const importMemories = importMemoryByRoom.get(roomId) ??
                        !this.#sharedConversationState.store.hasConversationMemoryHistory(roomId);
                    importMemoryByRoom.set(roomId, importMemories);
                    if (importMemories) {
                        for (const memory of local.listConversationMemories(activity.conversationId)) {
                            this.#sharedConversationState.importMemory(memory);
                            importedMemories += 1;
                        }
                    }
                    const importBehaviors = importBehaviorByRoom.get(roomId) ??
                        !this.#sharedConversationState.store.hasConversationBehaviorHistory(roomId);
                    importBehaviorByRoom.set(roomId, importBehaviors);
                    if (importBehaviors) {
                        for (const behavior of local.listConversationBehaviorRules(activity.conversationId)) {
                            this.#sharedConversationState.importBehavior(behavior);
                            importedBehaviors += 1;
                        }
                    }
                    groups.set(roomId, group);
                }
            }
            finally {
                local.close();
            }
        }
        let importedMessages = 0;
        for (const [roomId, group] of groups) {
            group.messages.sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence);
            for (const message of group.messages) {
                if (this.#sharedConversationState.importMessage(message, roomId, group.title))
                    importedMessages += 1;
            }
            if (group.latestReset) {
                this.#sharedConversationState.store.resetConversationContextAt(roomId, group.latestReset.resetBy, `fusion:${group.latestReset.sourceEventId}`, group.latestReset.resetAt);
            }
        }
        this.#log("info", "system", "fusion.state_bootstrapped", "双机器人共享群状态已合并", {
            groups: groups.size,
            importedMessages,
            importedMemories,
            importedBehaviors,
        });
    }
    #synchronizeInitialFusionConfiguration() {
        const bots = this.#store.listBots();
        let updated = 0;
        for (const target of bots) {
            const peers = bots.filter((candidate) => candidate.id !== target.id &&
                [...this.#roomsForBot(candidate.id)].some((roomId) => this.#roomsForBot(target.id).has(roomId)));
            const primary = [target, ...peers].sort(fusionBotPriority)[0];
            if (primary.id === target.id)
                continue;
            const sharedRooms = [...this.#roomsForBot(primary.id)].filter((roomId) => this.#roomsForBot(target.id).has(roomId));
            const fused = fusedBotConfiguration(primary, target, sharedRooms);
            if (JSON.stringify(fused) === JSON.stringify(target))
                continue;
            this.#store.saveBot(fused);
            updated += 1;
        }
        if (updated > 0) {
            this.#log("info", "system", "fusion.configuration_synchronized", "备用机器人已同步主机器人的 Agent 配置", {
                updatedBots: updated,
            });
        }
    }
    #fusionPeerBots(botId, conversationId) {
        const roomId = canonicalConversationId(conversationId);
        if (!this.#store.getBot(botId) || !roomId)
            return [];
        this.#rememberBotRoom(botId, roomId);
        return this.#fusionBotsForRoom(roomId).filter((bot) => bot.id !== botId && bot.enabled);
    }
    #conversationPlugins(botId, conversationId) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const chatroom = bot.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === canonicalConversationId(conversationId));
        const configs = withImplicitBuiltInPlugins(bot.plugins);
        return BUILT_IN_PLUGIN_DEFINITIONS.map((definition) => {
            const config = configs.find((item) => item.type === definition.type);
            const override = chatroom?.pluginOverrides.find((item) => item.pluginType === definition.type);
            return {
                type: definition.type,
                label: definition.label,
                enabled: override?.enabled ?? config.enabled,
                defaultEnabled: config.enabled,
                overridden: override !== undefined,
            };
        });
    }
    #setConversationPlugin(botId, conversationId, pluginType, enabled) {
        const definition = builtInPluginDefinition(pluginType);
        if (!definition)
            throw new Error(`Plugin ${pluginType} is not manageable`);
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const chatroomId = canonicalConversationId(conversationId);
        const existing = bot.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === chatroomId);
        const updated = existing
            ? { ...existing, pluginOverrides: [...existing.pluginOverrides] }
            : {
                chatroomId,
                chatModelProfileId: null,
                visionModelProfileId: null,
                personaProfileId: null,
                managerIds: [],
                redEnvelopeTargetIds: [],
                pluginOverrides: [],
            };
        const byType = new Map(updated.pluginOverrides.map((item) => [item.pluginType, item]));
        byType.set(pluginType, { pluginType, enabled });
        updated.pluginOverrides = [...byType.values()];
        this.#store.saveBot({
            ...bot,
            chatroomModelOverrides: [
                ...bot.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== chatroomId),
                updated,
            ],
        });
        this.synchronizeChatroomConfiguration(botId, chatroomId);
        return this.#conversationPlugins(botId, chatroomId).find((item) => item.type === pluginType);
    }
    #resolvePersonaSoul(botId, event) {
        const profileId = this.#resolvePersonaId(botId, event);
        if (!profileId)
            return undefined;
        const profile = this.#store.getPersonaProfile(profileId);
        return profile?.enabled ? profile.prompt : undefined;
    }
    #resolveBotIdentity(botId, event, fallback) {
        const bot = this.#store.getBot(botId) ?? fallback;
        const profileId = this.#resolvePersonaId(botId, event);
        const persona = profileId ? this.#store.getPersonaProfile(profileId) : undefined;
        const displayName = persona?.accountNickname ?? persona?.groupNickname ?? persona?.label ?? bot.displayName;
        return {
            displayName,
            wakeWords: [...new Set([
                    bot.displayName,
                    ...bot.wakeWords,
                    persona?.label,
                    persona?.accountNickname,
                    persona?.groupNickname,
                    ...(persona?.wakeWords ?? []),
                ].filter((value) => Boolean(value?.trim())).map((value) => value.trim()))],
        };
    }
    #resolvePersonaId(botId, event) {
        const bot = this.#store.getBot(botId);
        if (event.conversation.kind === "group") {
            const override = bot?.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === canonicalConversationId(event.conversation.id));
            const profileId = override?.personaProfileId ?? bot?.personaProfileId ?? this.#store.getGlobalSettings().defaultPersonaProfileId;
            return profileId && this.#store.getPersonaProfile(profileId)?.enabled ? profileId : undefined;
        }
        const profileId = this.#store.getConversationPersonaOverride(botId, event.conversation.id) ??
            bot?.personaProfileId ?? this.#store.getGlobalSettings().defaultPersonaProfileId;
        return profileId && this.#store.getPersonaProfile(profileId)?.enabled ? profileId : undefined;
    }
    #conversationPersona(botId, conversationId) {
        const bot = this.#store.getBot(botId);
        const chatroomId = canonicalConversationId(conversationId);
        const override = bot?.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === chatroomId)?.personaProfileId
            ?? this.#store.getConversationPersonaOverride(botId, conversationId);
        const profileId = override ?? bot?.personaProfileId ?? this.#store.getGlobalSettings().defaultPersonaProfileId;
        if (!profileId)
            return undefined;
        const profile = this.#store.getPersonaProfile(profileId);
        return profile?.enabled ? profile : undefined;
    }
    #conversationVoiceStyle(botId, conversationId) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const roomId = canonicalConversationId(conversationId);
        const override = bot.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === roomId);
        const voice = override?.ttsVoice ?? DEFAULT_TTS_VOICE;
        const style = override?.ttsStyle ?? DEFAULT_TTS_STYLE;
        const preset = matchingTtsVoicePreset(voice, style);
        return {
            voice,
            style,
            presetId: preset?.id ?? null,
            presetLabel: preset?.label ?? null,
            overridden: Boolean(override?.ttsVoice || override?.ttsStyle),
        };
    }
    #setConversationVoiceStyle(botId, conversationId, query) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const roomId = canonicalConversationId(conversationId);
        const existing = bot.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === roomId);
        const updated = existing
            ? cloneChatroomOverride(existing, roomId)
            : {
                chatroomId: roomId,
                chatModelProfileId: null,
                visionModelProfileId: null,
                personaProfileId: null,
                managerIds: [],
                redEnvelopeTargetIds: [],
                pluginOverrides: [],
            };
        if (query === null) {
            delete updated.ttsVoice;
            delete updated.ttsStyle;
        }
        else {
            const selection = resolveTtsVoiceStyleQuery(query, this.#conversationVoiceStyle(botId, roomId));
            updated.ttsVoice = selection.voice;
            updated.ttsStyle = selection.style;
        }
        const retained = bot.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== roomId);
        this.#store.saveBot({
            ...bot,
            chatroomModelOverrides: chatroomOverrideEmpty(updated) ? retained : [...retained, updated],
        });
        this.synchronizeChatroomConfiguration(botId, roomId);
        return this.#conversationVoiceStyle(botId, roomId);
    }
    #setConversationPersona(botId, conversationId, personaProfileId) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`Bot ${botId} does not exist`);
        const chatroomId = canonicalConversationId(conversationId);
        const profile = personaProfileId ? this.#store.getPersonaProfile(personaProfileId) : undefined;
        if (personaProfileId && (!profile || !profile.enabled))
            throw new Error(`Persona ${personaProfileId} is not available`);
        if (!bot.chatroomModelOverrides.some((item) => canonicalConversationId(item.chatroomId) === chatroomId)) {
            this.#store.setConversationPersonaOverride(botId, conversationId, personaProfileId);
            if (profile?.autoApplyAccountProfile) {
                void this.applyChannelIdentity(botId, profile.id, { conversationId }).catch((error) => this.#log("warn", "channel", "channel.persona_identity_apply_failed", errorMessage(error), {
                    personaProfileId: profile.id,
                    conversationId,
                }, botId));
            }
            return profile;
        }
        const existing = bot.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === chatroomId);
        const updated = existing
            ? { ...existing, personaProfileId }
            : {
                chatroomId,
                chatModelProfileId: null,
                visionModelProfileId: null,
                personaProfileId,
                managerIds: [],
                redEnvelopeTargetIds: [],
                pluginOverrides: [],
            };
        this.#store.saveBot({
            ...bot,
            chatroomModelOverrides: chatroomOverrideEmpty(updated)
                ? bot.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== chatroomId)
                : [
                    ...bot.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== chatroomId),
                    updated,
                ],
        });
        this.synchronizeChatroomConfiguration(botId, chatroomId);
        if (profile?.autoApplyAccountProfile) {
            void this.applyChannelIdentity(botId, profile.id, { conversationId: chatroomId }).catch((error) => this.#log("warn", "channel", "channel.persona_identity_apply_failed", errorMessage(error), {
                personaProfileId: profile.id,
                conversationId: chatroomId,
            }, botId));
        }
        return profile;
    }
    async #createManagedChannel(config, stateDirectory) {
        const outboundAssetStores = new Map();
        const outboundAssetStore = (asset) => {
            const collectedByBotId = typeof asset.metadata?.collectedByBotId === "string"
                ? asset.metadata.collectedByBotId.trim()
                : "";
            const ownerBotId = collectedByBotId && this.#store.getBot(collectedByBotId) ? collectedByBotId : config.id;
            let store = outboundAssetStores.get(ownerBotId);
            if (!store) {
                store = new LocalAssetStore({
                    directory: safeDataPath(this.#dataDirectory, `bots/${ownerBotId}/assets`),
                    maxAssetBytes: 512 * 1024 * 1024,
                });
                outboundAssetStores.set(ownerBotId, store);
            }
            return store;
        };
        const assets = outboundAssetStore({ metadata: { collectedByBotId: config.id } });
        const outboundMediaResolver = {
            resolve: (asset) => this.#resolveEmojiAsset(asset, typeof asset.metadata?.collectedByBotId === "string"
                ? asset.metadata.collectedByBotId
                : config.id),
        };
        const plugin = await this.#adapterRegistry.create(config.channel.type, {
            pluginId: `channel-${config.id}`,
            displayName: config.displayName,
            config: config.channel,
            settings: config.channel.settings,
            stateDirectory,
            assets,
            outboundMediaResolver,
            resolveGroupMemberName: (roomId, senderId) => this.#resolveGroupMemberName(roomId, senderId),
            onError: (error, context) => {
                this.#log("error", "channel", `channel.${context.phase}`, errorMessage(error), { ...context }, config.id);
            },
        });
        return {
            plugin,
            assets,
            health: typeof plugin.health === "function" ? () => plugin.health() : async () => ({ ok: true }),
            resolveConversationTitle: typeof plugin.resolveConversationTitle === "function"
                ? (chatroomId) => plugin.resolveConversationTitle(chatroomId)
                : undefined,
            callbackAddress: typeof plugin.callbackAddress === "function" ? () => plugin.callbackAddress() : undefined,
            registerCallback: typeof plugin.registerCallback === "function"
                ? (webhookUrl) => plugin.registerCallback(webhookUrl)
                : undefined,
            testCallback: typeof plugin.testCallback === "function" ? () => plugin.testCallback() : undefined,
        };
    }

    async #stopNow(id) {
        this.#emojiAnalysisRetriers.delete(id);
        const managed = this.#runtimes.get(id);
        if (!managed)
            return;
        const state = this.#states.get(id);
        if (state) {
            state.phase = "stopping";
            state.since = Date.now();
        }
        try {
            for (const plugin of [...managed.plugins].reverse())
                await plugin.stop?.();
            if (managed.runtime.running)
                await managed.runtime.stop();
        }
        finally {
            managed.core.close();
            this.#runtimes.delete(id);
        }
        if (state) {
            state.phase = "stopped";
            state.since = Date.now();
            state.startedAt = null;
            state.gatewayHealthy = null;
            state.gatewayCheckedAt = null;
            state.webhookAddress = null;
            state.pendingOutbox = 0;
        }
        this.#log("info", "bot", "bot.stopped", "机器人已停止", undefined, id);
    }
    async #retryFailedEmojiAnalyses() {
        if (this.#emojiAnalysisRetryRunning || this.#closed)
            return;
        this.#emojiAnalysisRetryRunning = true;
        try {
            const cutoff = Date.now() - EMOJI_ANALYSIS_RETRY_MIN_AGE_MS;
            for (const [botId, retry] of this.#emojiAnalysisRetriers) {
                const candidate = this.#store.listEmojis(botId)
                    .filter((emoji) => emoji.status === "failed" && emoji.updatedAt <= cutoff)
                    .sort((left, right) => left.updatedAt - right.updatedAt)[0];
                if (candidate) {
                    try {
                        await retry(candidate);
                    }
                    catch (error) {
                        this.#log("warn", "agent", "emoji.analysis_retry_failed", errorMessage(error), { emojiId: candidate.id }, botId);
                    }
                }
            }
        }
        finally {
            this.#emojiAnalysisRetryRunning = false;
        }
    }
    async #resolveEmojiAsset(asset, preferredBotId) {
        const botIds = [...new Set([
                preferredBotId,
                typeof asset.metadata?.collectedByBotId === "string" ? asset.metadata.collectedByBotId : "",
                ...this.#store.listBots().map((bot) => bot.id),
            ].filter(Boolean))];
        for (const botId of botIds) {
            const store = new LocalAssetStore({
                directory: safeDataPath(this.#dataDirectory, `bots/${botId}/assets`),
                maxAssetBytes: 512 * 1024 * 1024,
            });
            if (await store.has(asset))
                return store.resolve(asset);
        }
        const key = asset.sha256 ?? asset.id;
        let inflight = this.#emojiAssetRecoveryInflight.get(key);
        if (!inflight) {
            inflight = this.#recoverEmojiAsset(asset, preferredBotId);
            this.#emojiAssetRecoveryInflight.set(key, inflight);
            void inflight.then(() => this.#emojiAssetRecoveryInflight.delete(key), () => this.#emojiAssetRecoveryInflight.delete(key));
        }
        return inflight;
    }
    async #recoverEmojiAsset(asset, preferredBotId) {
        void preferredBotId;
        throw new Error(`Local asset not found for emoji ${asset.id}; the adapter must keep media resolvable until delivery`);
    }
    async #resolveGroupMemberName(roomId, senderId) {
        if (!roomId || !senderId.trim())
            return undefined;
        const canonicalRoom = canonicalConversationId(roomId);
        const canonicalSender = canonicalIdentityId(senderId);
        const now = Date.now();
        const cached = this.#groupMemberCache.get(canonicalRoom);
        if (cached && cached.expiresAt > now) {
            return cached.members.get(canonicalSender);
        }
        let inflight = this.#groupMemberInflight.get(canonicalRoom);
        if (!inflight) {
            inflight = this.#loadGroupMembers(canonicalRoom);
            this.#groupMemberInflight.set(canonicalRoom, inflight);
            void inflight.finally(() => this.#groupMemberInflight.delete(canonicalRoom));
        }
        const members = await inflight.catch(() => new Map());
        return members.get(canonicalSender);
    }
    #observeLiveGroupRoom(botId, event) {
        if (event.conversation.kind !== "group")
            return;
        const roomId = canonicalConversationId(event.conversation.id);
        const kind = event.metadata?.systemEventKind;
        if (kind === "bot-removed-from-group" || kind === "group-dissolved") {
            this.#deactivateGroupRoom(botId, roomId, `standard-${kind}`, true);
            return;
        }
        this.#activateGroupRoom(botId, roomId);
        for (const member of event.metadata?.members ?? []) {
            if (!member || typeof member !== "object")
                continue;
            const id = typeof member.id === "string" ? canonicalIdentityId(member.id) : "";
            const displayName = typeof member.displayName === "string" ? safeGroupDisplayName(member.displayName, id) : "";
            if (id && displayName) {
                this.#sharedConversationState.store.upsertMember(roomId, {
                    id,
                    displayName,
                    isBot: Boolean(member.isBot),
                });
            }
        }
    }
    #activateGroupRoom(botId, conversationId) {
        const roomId = canonicalConversationId(conversationId);
        const reactivated = this.#store.markGroupRoomAvailable(botId, roomId);
        this.#rememberBotRoom(botId, roomId);
        if (reactivated) {
            this.#log("info", "channel", "group.room_reactivated", "收到新的群事件，已恢复群监控", { conversationId: roomId }, botId);
        }
    }
    #deactivateGroupRoom(botId, conversationId, reason, confirmed) {
        const roomId = canonicalConversationId(conversationId);
        const result = this.#store.noteGroupRoomUnavailable(botId, roomId, reason, confirmed);
        if (!result.inactive)
            return result;
        this.#forgetBotRoom(botId, roomId);
        const bot = this.#store.getBot(botId);
        if (bot) {
            const overrides = bot.chatroomModelOverrides.filter((item) => canonicalConversationId(item.chatroomId) !== roomId);
            if (overrides.length !== bot.chatroomModelOverrides.length)
                this.#store.saveBot({ ...bot, chatroomModelOverrides: overrides });
        }
        this.#store.deleteGroupMemberSnapshots(roomId);
        this.#groupMemberCache.delete(roomId);
        this.#log("info", "channel", "group.room_removed", "适配器报告机器人已离开群聊，已移除群配置但保留历史", {
            conversationId: roomId,
            reason,
            historyPreserved: true,
        }, botId);
        return result;
    }


    async #claimSharedReply(config, event, reason) {
        if (event.conversation.kind !== "group")
            return true;
        const roomId = canonicalConversationId(event.conversation.id);
        this.#rememberBotRoom(config.id, roomId);
        const roomBots = this.#fusionBotsForRoom(roomId).filter((bot) => bot.enabled && this.#runtimes.has(bot.id));
        const health = new Set((await Promise.all(roomBots.map(async (bot) => {
            try {
                return (await this.#probeGateway(bot.id, false)).healthy ? bot.id : undefined;
            }
            catch {
                return undefined;
            }
        }))).filter((id) => id !== undefined));
        const mentioned = new Set((event.mentions ?? []).map((item) => canonicalIdentityId(item.id)));
        const selected = selectReplyBot(roomBots, health, mentioned);
        if (!selected) {
            this.#log("debug", "agent", "reply.arbitrated_primary", "同群没有健康机器人，当前消息暂不回复", { chatroomId: roomId, eventId: event.id, selectedBotId: null }, config.id);
            return false;
        }
        const preferred = roomBots[0];
        const claimKey = `shared-reply:${sharedReplyFingerprint(event)}`;
        if (preferred.id !== config.id) {
            // Always give the stable primary a short head start. A channel health
            // endpoint can be stale or endpoint-specific; if the primary really did
            // not receive this event, the backup still takes over after the grace.
            await new Promise((resolveWait) => {
                setTimeout(resolveWait, 4_000);
            });
        }
        const claimed = this.#store.claimProactive({
            claimKey,
            canonicalConversationId: roomId,
            botId: config.id,
            reason: `reply:${reason}`,
            createdAt: Date.now(),
            ambient: false,
        });
        if (!claimed) {
            this.#log("debug", "agent", "reply.arbitrated_duplicate", "同一群消息已由另一机器人取得回复权", { chatroomId: canonicalConversationId(event.conversation.id), eventId: event.id, fingerprint: claimKey.slice(13) }, config.id);
        }
        else if (preferred.id !== config.id) {
            this.#log("warn", "agent", "reply.backup_callback_failover", "首选账号未在宽限时间内取得回复权，健康备用账号已接管", { chatroomId: roomId, eventId: event.id, preferredBotId: preferred.id }, config.id);
        }
        return claimed;
    }
    #releaseSharedReply(config, event, reason) {
        if (event.conversation.kind !== "group")
            return;
        const claimKey = `shared-reply:${sharedReplyFingerprint(event)}`;
        if (!this.#store.releaseProactiveClaim(claimKey, config.id))
            return;
        this.#log("warn", "agent", "reply.claim_released", "模型调用失败，已释放共享回复权供备用机器人接管", {
            chatroomId: canonicalConversationId(event.conversation.id),
            eventId: event.id,
            reason,
            fingerprint: claimKey.slice(13),
        }, config.id);
    }
    async #notifyModelFallback(details) {
        const configuredRecipient = this.#env.PI_FALLBACK_NOTIFY_USER?.trim();
        if (!configuredRecipient)
            return;
        const recipient = canonicalIdentityId(configuredRecipient);
        const dedupeKey = `${details.primaryModel}:${details.fallbackModel}:${recipient}`;
        const now = Date.now();
        if (now - (this.#fallbackNotificationAt.get(dedupeKey) ?? 0) < 15 * 60_000)
            return;
        this.#fallbackNotificationAt.set(dedupeKey, now);
        const candidates = this.#store.listBots()
            .filter((bot) => bot.enabled && this.#runtimes.get(bot.id)?.runtime.running)
            .sort((left, right) => left.id.localeCompare(right.id));
        const target = candidates.find((bot) => this.#states.get(bot.id)?.gatewayHealthy !== false);
        const managed = target ? this.#runtimes.get(target.id) : undefined;
        if (!target || !managed) {
            this.#fallbackNotificationAt.delete(dedupeKey);
            this.#log("error", "agent", "model.fallback_notification_failed", "没有可用机器人发送模型降级私聊通知", details, details.sourceBotId);
            return;
        }
        const namespace = target.channel.accountId?.trim() || target.identityId;
        const conversationId = `${namespace}:${recipient}`;
        const error = [...details.error.normalize("NFKC")].slice(0, 360).join("");
        const text = [
            "【机器人模型降级提醒】",
            `时间：${new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ")}（北京时间）`,
            `机器人：${details.sourceBotId}`,
            `主模型：${details.primaryModel}`,
            `已降级：${details.fallbackModel}`,
            `会话：${details.sessionId}`,
            `原因：${error}`,
            "系统将在熔断窗口结束后自动探测并恢复 Gemini。",
        ].join("\n");
        try {
            await managed.runtime.sendTransient(conversationId, [], text);
            this.#log("info", "agent", "model.fallback_notification_sent", "已通过私聊发送模型降级通知", {
                recipient,
                notificationBotId: target.id,
                sourceBotId: details.sourceBotId,
            }, target.id);
        }
        catch (notificationError) {
            this.#fallbackNotificationAt.delete(dedupeKey);
            this.#log("error", "agent", "model.fallback_notification_failed", errorMessage(notificationError), {
                recipient,
                notificationBotId: target.id,
                sourceBotId: details.sourceBotId,
            }, target.id);
        }
    }
    #rememberBotRoom(botId, conversationId) {
        const roomId = canonicalConversationId(conversationId);
        if (!roomId)
            return;
        const botIds = this.#roomBots.get(roomId) ?? new Set();
        botIds.add(botId);
        this.#roomBots.set(roomId, botIds);
    }
    #forgetBotRoom(botId, conversationId) {
        const roomId = canonicalConversationId(conversationId);
        const botIds = this.#roomBots.get(roomId);
        if (!botIds)
            return;
        botIds.delete(botId);
        if (botIds.size === 0)
            this.#roomBots.delete(roomId);
    }
    #roomsForBot(botId) {
        const rooms = new Set();
        for (const [roomId, botIds] of this.#roomBots) {
            if (botIds.has(botId) && !this.#store.isGroupRoomInactive(botId, roomId))
                rooms.add(roomId);
        }
        const config = this.#store.getBot(botId);
        for (const override of config?.chatroomModelOverrides ?? []) {
            const roomId = canonicalConversationId(override.chatroomId);
            if (!this.#store.isGroupRoomInactive(botId, roomId))
                rooms.add(roomId);
        }
        return rooms;
    }
    #fusionBotsForRoom(conversationId) {
        const roomId = canonicalConversationId(conversationId);
        const known = this.#roomBots.get(roomId) ?? new Set();
        return this.#store.listBots()
            .filter((bot) => !this.#store.isGroupRoomInactive(bot.id, roomId) &&
            (known.has(bot.id) || botConfiguredForRoom(bot, roomId)))
            .sort(fusionBotPriority);
    }
    async #healthyFusionBotsForRoom(conversationId, refresh) {
        const candidates = this.#fusionBotsForRoom(conversationId)
            .filter((bot) => bot.enabled && this.#runtimes.has(bot.id));
        if (refresh) {
            await Promise.allSettled(candidates.map((bot) => this.#probeGateway(bot.id, false)));
        }
        return candidates.filter((bot) => this.#states.get(bot.id)?.gatewayHealthy === true);
    }
    #assertChatroomId(chatroomId) {
        if (!chatroomId)
            throw new Error("chatroomId must not be empty");
    }
    #assertChatroomAccess(botId, chatroomId) {
        if (!this.#store.getBot(botId))
            throw new Error(`Bot ${botId} does not exist`);
        this.#assertChatroomId(chatroomId);
        if (!this.#fusionBotsForRoom(chatroomId).some((bot) => bot.id === botId)) {
            throw new Error(`Chatroom ${chatroomId} has not been discovered by bot ${botId}`);
        }
        this.#ensureSharedRoomImported(chatroomId);
    }
    #ensureSharedRoomImported(chatroomId) {
        for (const bot of this.#fusionBotsForRoom(chatroomId)) {
            const local = new SqliteStore(safeDataPath(this.#dataDirectory, bot.databaseFile), { recoverProcessing: false });
            try {
                const activity = local.listGroupActivity(0, Date.now() + 1, 1).find((group) => canonicalConversationId(group.conversationId) === chatroomId);
                if (!activity)
                    continue;
                for (const message of local.exportConversationMessages(activity.conversationId)) {
                    this.#sharedConversationState.importMessage(message, chatroomId, activity.conversationTitle);
                }
            }
            finally {
                local.close();
            }
        }
    }
    #localConversationId(config, chatroomId) {
        const namespace = config.channel.accountId?.normalize("NFKC").trim();
        return namespace ? `${namespace}:${chatroomId}` : chatroomId;
    }
    #chatroomBotSession(bot, chatroomId, contextReset = this.#sharedConversationState.contextReset(chatroomId)) {
        const persona = this.#conversationPersona(bot.id, chatroomId);
        const descriptor = createChatSessionDescriptor({
            conversationKind: "group",
            conversationId: this.#localConversationId(bot, chatroomId),
            sessionNamespace: bot.id,
            sessionScope: persona?.id ?? "default",
            ...(contextReset ? { contextReset } : {}),
        });
        return {
            botId: bot.id,
            displayName: bot.displayName,
            personaProfileId: persona?.id ?? null,
            ...descriptor,
        };
    }
    #directConversationSession(bot, conversationId, contextReset) {
        const persona = this.#conversationPersona(bot.id, conversationId);
        const descriptor = createChatSessionDescriptor({
            conversationKind: "direct",
            conversationId,
            sessionNamespace: bot.id,
            sessionScope: persona?.id ?? "default",
            ...(contextReset ? { contextReset } : {}),
        });
        return {
            botId: bot.id,
            displayName: bot.displayName,
            personaProfileId: persona?.id ?? null,
            ...descriptor,
        };
    }
    async #resolveGroupTitle(chatroomId) {
        const canonical = canonicalConversationId(chatroomId);
        const now = Date.now();
        const cached = this.#groupTitleCache.get(canonical);
        if (cached && cached.expiresAt > now)
            return cached.title;
        const inflight = this.#groupTitleInflight.get(canonical);
        if (inflight)
            return inflight;
        const operation = (async () => {
            let title;
            for (const runtime of this.#runtimes.values()) {
                if (!runtime.channel.resolveConversationTitle)
                    continue;
                try {
                    title = (await runtime.channel.resolveConversationTitle(canonical))?.normalize("NFKC").trim() || undefined;
                    if (title)
                        break;
                }
                catch {
                    // An adapter may not know every room title. Try the next snapshot.
                }
            }
            this.#groupTitleCache.set(canonical, {
                expiresAt: now + (title ? 6 * 60 * 60_000 : 10 * 60_000),
                ...(title ? { title } : {}),
            });
            return title;
        })();
        this.#groupTitleInflight.set(canonical, operation);
        try {
            return await operation;
        }
        finally {
            this.#groupTitleInflight.delete(canonical);
        }
    }
    async #loadGroupMembers(roomId) {
        const members = new Map();
        for (const member of this.#sharedConversationState.store.listMembers(roomId)) {
            const id = canonicalIdentityId(member.id);
            const displayName = safeGroupDisplayName(member.displayName, member.id, "");
            if (displayName && !members.has(id))
                members.set(id, displayName);
        }
        // Previously observed names are durable in each bot store.
        for (const bot of this.#store.listBots()) {
            const namespace = bot.channel.accountId?.trim();
            const conversationIds = [...new Set([roomId, ...(namespace ? [`${namespace}:${roomId}`] : [])])];
            const store = new SqliteStore(safeDataPath(this.#dataDirectory, bot.databaseFile), { recoverProcessing: false });
            try {
                for (const conversationId of conversationIds) {
                    for (const member of store.listMembers(conversationId)) {
                        const id = canonicalConversationId(member.id);
                        const displayName = safeGroupDisplayName(member.displayName, member.id, "");
                        if (displayName && !members.has(id))
                            members.set(id, displayName);
                    }
                }
            }
            finally {
                store.close();
            }
        }
        // Nickname resolution is on the inbound-message hot path. Never issue a
        // Adapters can enrich the snapshot through standard event metadata; this
        // hot path only reads local durable names.
        if (this.#groupMemberCache.size >= 500) {
            const oldest = this.#groupMemberCache.keys().next().value;
            if (oldest)
                this.#groupMemberCache.delete(oldest);
        }
        const botIdentities = new Set(this.#store.listBots().map((bot) => canonicalIdentityId(bot.identityId)));
        for (const [memberId, displayName] of members) {
            this.#sharedConversationState.store.upsertMember(roomId, {
                id: memberId,
                displayName,
                isBot: botIdentities.has(canonicalIdentityId(memberId)),
            });
        }
        this.#groupMemberCache.set(roomId, {
            expiresAt: Date.now() + (members.size > 0 ? 30 * 60_000 : 2 * 60_000),
            members,
        });
        return members;
    }
    #requiredProfile(id, purpose) {
        if (!id)
            throw new Error(`No default ${purpose} model profile is configured`);
        const profile = this.#store.getModelProfile(id);
        if (!profile)
            throw new Error(`Model profile ${id} does not exist`);
        if (!profile.enabled)
            throw new Error(`Model profile ${id} is disabled`);
        return profile;
    }
    #resolvedModel(id, purpose, requireImage) {
        const profile = this.#requiredProfile(id, purpose);
        const providerProfile = this.#store.getProviderProfile(profile.providerProfileId);
        if (!providerProfile)
            throw new Error(`Provider profile ${profile.providerProfileId} does not exist`);
        if (!providerProfile.enabled)
            throw new Error(`Provider profile ${providerProfile.id} is disabled`);
        const model = resolveCustomModel(profile, providerProfile);
        if (requireImage && !model.input.includes("image")) {
            throw new Error(`Vision model ${profile.id} does not accept images`);
        }
        const apiKey = this.#store.getProviderApiKey(providerProfile.id) ??
            (providerProfile.apiKeyEnv ? requiredSecret(this.#env, providerProfile.apiKeyEnv) : undefined);
        if (!apiKey)
            throw new Error(`Provider profile ${providerProfile.id} has no API key configured`);
        return { profile, providerProfile, model, apiKey };
    }
    #resolvedKnowledgeRetriever(id) {
        const profile = this.#store.getKnowledgeProviderProfile(id);
        if (!profile)
            throw new Error(`Knowledge provider ${id} does not exist`);
        if (!profile.enabled)
            throw new Error(`Knowledge provider ${id} is disabled`);
        const apiKey = this.#store.getKnowledgeProviderApiKey(id) ??
            (profile.apiKeyEnv ? this.#env[profile.apiKeyEnv]?.trim() : undefined);
        return new HttpKnowledgeRetriever(profile, apiKey);
    }
    #withParticipationStore(id, operation) {
        const config = this.#store.getBot(id);
        if (!config)
            throw new Error(`Bot ${id} does not exist`);
        const managed = this.#runtimes.get(id);
        if (managed) {
            const bridge = {
                listParticipationCases: (query) => managed.core.listParticipationCases(query),
                participationSummary: () => managed.core.participationSummary(),
                labelParticipationCase: (eventId, label, reason) => managed.core.labelParticipationCase(eventId, label, reason),
                labelReplyQualityCase: (eventId, label, reason) => managed.core.labelReplyQualityCase(eventId, label, reason),
                pruneParticipationCases: (retentionDays, maxCases) => managed.core.pruneParticipationCases(retentionDays, maxCases),
            };
            return operation(bridge);
        }
        const store = new SqliteStore(safeDataPath(this.#dataDirectory, config.databaseFile), { recoverProcessing: false });
        try {
            return operation(store);
        }
        finally {
            store.close();
        }
    }
    #trace(botId, event) {
        const state = this.#states.get(botId);
        if (state) {
            state.lastEventAt = Date.now();
            if (event.type === "inbound.stored")
                state.metrics.inboundMessages += 1;
            if (event.type === "agent.started")
                state.metrics.agentRuns += 1;
            if (event.type === "agent.finished") {
                if (event.replied)
                    state.metrics.replies += 1;
                state.metrics.lastAgentDurationMs = event.durationMs;
                state.metrics.totalAgentDurationMs += event.durationMs;
                if (event.telemetry) {
                    state.metrics.llmCalls += event.telemetry.llmCalls;
                    state.metrics.toolCalls += event.telemetry.toolCalls;
                    state.metrics.inputTokens += event.telemetry.inputTokens;
                    state.metrics.outputTokens += event.telemetry.outputTokens;
                    state.metrics.cacheReadTokens += event.telemetry.cacheReadTokens;
                    state.metrics.cacheWriteTokens += event.telemetry.cacheWriteTokens;
                    state.metrics.estimatedCostUsd += event.telemetry.estimatedCostUsd;
                    state.metrics.fallbackHops += event.telemetry.fallbackHops;
                    state.metrics.lastModelRoute = [...event.telemetry.modelRoute];
                    state.metrics.lastTimeToFirstTokenMs = event.telemetry.timeToFirstTokenMs ?? null;
                }
            }
            if (event.type === "agent.failed")
                state.metrics.agentFailures += 1;
            if (event.type === "image.understanding.started")
                state.metrics.imageCalls += 1;
            if (event.type === "image.understanding.failed")
                state.metrics.imageFailures += 1;
            if (event.type === "outbox.acked")
                state.metrics.deliveries += event.actionIds.length;
        }
        const level = event.type === "agent.failed" || event.type === "image.understanding.failed"
            ? "error"
            : event.type === "agent.output_blocked"
                ? "warn"
                : event.type === "agent.finished" || event.type.includes("saved")
                    ? "info"
                    : "debug";
        const write = () => this.#log(level, "agent", event.type, traceMessage(event), event, botId);
        // The finished trace is observability only. On large SQLite files its
        // synchronous insert can sit between the durable outbox write and the
        // channel send, adding seconds to the user's perceived latency.
        if (event.type === "agent.finished") {
            setImmediate(write);
            return;
        }
        write();
    }
    #stateFor(config) {
        let state = this.#states.get(config.id);
        if (!state) {
            state = {
                id: config.id,
                displayName: config.displayName,
                enabled: config.enabled,
                phase: "stopped",
                since: Date.now(),
                startedAt: null,
                lastEventAt: null,
                lastError: null,
                gatewayHealthy: null,
                gatewayCheckedAt: null,
                webhookAddress: null,
                pendingOutbox: 0,
                chatModel: null,
                visionModel: null,
                chatroomModelOverrides: config.chatroomModelOverrides.length,
                metrics: emptyMetrics(),
            };
            this.#states.set(config.id, state);
        }
        state.displayName = config.displayName;
        state.enabled = config.enabled;
        state.chatroomModelOverrides = config.chatroomModelOverrides.length;
        const managed = this.#runtimes.get(config.id);
        state.pendingOutbox = managed ? managed.core.pendingOutbox(10_000).length : 0;
        return state;
    }
    async #pollSocialSchedule() {
        if (this.#socialPollRunning || this.#closed)
            return;
        this.#socialPollRunning = true;
        try {
            const now = Date.now();
            this.#store.pruneProactiveClaims(now - 45 * 24 * 60 * 60_000);
            for (const config of this.#store.listBots()) {
                const managed = this.#runtimes.get(config.id);
                if (!managed || !managed.runtime.running || !config.enabled ||
                    this.#states.get(config.id)?.gatewayHealthy !== true)
                    continue;
                for (const plugin of managed.plugins) {
                    try {
                        await plugin.tick(now);
                    }
                    catch (error) {
                        this.#log("error", "agent", "plugin.tick_failed", errorMessage(error), { pluginId: plugin.id, pluginType: plugin.type }, config.id);
                    }
                }
                if (!config.socialSchedule.enabled)
                    continue;
                const clock = localClock(now, config.socialSchedule.timezoneOffsetMinutes);
                const active = isMinuteWithin(clock.minute, config.socialSchedule.activeStartMinute, config.socialSchedule.activeEndMinute);
                const earlyMorning = minutesSince(clock.minute, config.socialSchedule.activeStartMinute) < 120;
                if (active && !earlyMorning)
                    await this.#runColdParticipation(config, managed, now);
                const goodnightWindow = config.socialSchedule.goodnightEnabled &&
                    isMinuteWithin(clock.minute, config.socialSchedule.goodnightMinute, config.socialSchedule.goodnightMinute + 45);
                if (goodnightWindow)
                    await this.#runGoodnight(config, managed, now, clock.dateKey);
            }
        }
        catch (error) {
            this.#log("error", "system", "social_schedule.failed", errorMessage(error));
        }
        finally {
            this.#socialPollRunning = false;
        }
    }
    async #runGoodnight(config, managed, now, dateKey) {
        const day = localDay(now, config.socialSchedule.timezoneOffsetMinutes);
        const groups = managed.core.listGroupActivity(day.startAt, now + 1, config.socialSchedule.activeGroupMinMessages);
        for (const group of groups) {
            const canonical = canonicalConversationId(group.conversationId);
            const claimKey = `goodnight:${dateKey}:${canonical}`;
            if (!this.#store.claimProactive({
                claimKey,
                canonicalConversationId: canonical,
                botId: config.id,
                reason: "goodnight",
                createdAt: now,
                ambient: false,
            }))
                continue;
            const request = {
                id: scheduledEventId("goodnight", dateKey, canonical),
                kind: "goodnight",
                conversationId: group.conversationId,
                prompt: "这是今日活跃群的晚安定时消息。",
                timestamp: now,
            };
            try {
                const result = await managed.runtime.sendProactiveText(request, goodnightText(canonical, dateKey));
                this.#log("info", "agent", "social.goodnight", "已向今日活跃群发送晚安并进入夜间静默", { conversationId: group.conversationId, delivered: result.delivery.delivered.length }, config.id);
            }
            catch (error) {
                this.#store.releaseProactiveClaim(claimKey, config.id);
                this.#log("error", "agent", "social.goodnight_failed", errorMessage(error), { conversationId: group.conversationId }, config.id);
            }
        }
    }
    async #runColdParticipation(config, managed, now) {
        const schedule = config.socialSchedule;
        const warmupPlugin = config.plugins.find((plugin) => plugin.type === "cold-chat-warmup");
        if (!warmupPlugin)
            return;
        const groups = managed.core.listColdGroups(now - schedule.coldChatAfterMs, now - 7 * 24 * 60 * 60_000, 20);
        const day = localDay(now, schedule.timezoneOffsetMinutes);
        for (const group of groups) {
            if (!agentPluginEnabled(config, warmupPlugin, group.conversationId))
                continue;
            const canonical = canonicalConversationId(group.conversationId);
            const claimKey = `cold:${config.id}:${now}:${canonical}`;
            if (!this.#store.claimProactive({
                claimKey,
                canonicalConversationId: canonical,
                botId: config.id,
                reason: "cold-chat",
                createdAt: now,
                ambient: true,
                cooldownMs: schedule.coldChatCooldownMs,
                botCooldownMs: schedule.hotChatCooldownMs,
                dailyLimit: schedule.maxDailyAmbientMessages,
                dayStartAt: day.startAt,
            }))
                continue;
            const silentHours = Math.max(1, Math.floor((now - group.lastMessageAt) / (60 * 60_000)));
            const request = {
                id: scheduledEventId("cold-chat", String(now), `${config.id}:${canonical}`),
                kind: "cold-chat",
                conversationId: group.conversationId,
                prompt: `该群已经约 ${silentHours} 小时没有新消息。请结合近期真实上下文判断现在是否适合用一句自然的话暖场；没有好切入点就调用 skip_reply。`,
                timestamp: now,
            };
            try {
                const result = await managed.runtime.participate(request);
                this.#log("info", "agent", "social.cold_chat", result.handling.status === "replied" ? "冷群暖场已发送" : "冷群暖场判断后保持沉默", { conversationId: group.conversationId, silentHours, delivered: result.delivery.delivered.length }, config.id);
            }
            catch (error) {
                this.#store.releaseProactiveClaim(claimKey, config.id);
                this.#log("error", "agent", "social.cold_chat_failed", errorMessage(error), { conversationId: group.conversationId }, config.id);
            }
            break;
        }
    }
    #snapshot(state) {
        return {
            ...state,
            metrics: { ...state.metrics, lastModelRoute: [...state.metrics.lastModelRoute] },
            webhookAddress: state.webhookAddress ? { ...state.webhookAddress } : null,
        };
    }
    async #pollGatewayHealth() {
        await Promise.allSettled([...this.#runtimes.keys()].map(async (id) => {
            try {
                await this.#probeGateway(id, false);
            }
            catch {
                // #probeGateway records the transition and health state.
            }
        }));
        this.#rebalanceFusionScheduledTasks();
    }
    #rebalanceFusionScheduledTasks() {
        let reassigned = 0;
        for (const [roomId] of this.#roomBots) {
            const participants = this.#fusionBotsForRoom(roomId);
            if (participants.length < 2)
                continue;
            const selected = participants.find((bot) => bot.enabled && this.#runtimes.has(bot.id) && this.#states.get(bot.id)?.gatewayHealthy === true);
            if (!selected)
                continue;
            const participantIds = new Set(participants.map((bot) => bot.id));
            for (const task of this.#store.listScheduledTasks()) {
                if (canonicalConversationId(task.conversationId) !== roomId ||
                    !participantIds.has(task.botId) || task.botId === selected.id)
                    continue;
                if (this.#store.assignScheduledTask(task.id, selected.id, this.#localConversationId(selected, roomId))) {
                    reassigned += 1;
                }
            }
        }
        if (reassigned > 0) {
            this.#log("info", "system", "fusion.scheduled_tasks_reassigned", "定时任务已转交当前健康的主备账号", {
                reassigned,
            });
        }
    }
    async #probeGateway(id, forceLog) {
        const managed = this.#runtimes.get(id);
        const config = this.#store.getBot(id);
        if (!managed || !config)
            throw new Error(`Bot ${id} is not running`);
        const previous = this.#states.get(id)?.gatewayHealthy;
        try {
            const health = await managed.channel.health();
            const healthy = gatewayHealthReady(config, health);
            this.#setGatewayHealth(id, healthy);
            if (forceLog || previous !== healthy) {
                this.#log(healthy ? "info" : "warn", "channel", healthy ? "channel.healthy" : "channel.unhealthy", healthy ? "通道健康检查通过" : "通道报告不可用", health, id);
            }
            return { health, healthy };
        }
        catch (error) {
            this.#setGatewayHealth(id, false);
            if (forceLog || previous !== false)
                this.#log("error", "channel", "channel.health_failed", errorMessage(error), undefined, id);
            throw error;
        }
    }
    #setGatewayHealth(id, healthy) {
        const state = this.#states.get(id);
        if (!state)
            return;
        state.gatewayHealthy = healthy;
        state.gatewayCheckedAt = Date.now();
    }

    #log(level, scope, event, message, details, botId) {
        try {
            this.#store.appendLog({ level, scope, event, message, ...(details ? { details } : {}), ...(botId ? { botId } : {}) });
        }
        catch {
            // Control-plane observability must not break bot message handling.
        }
    }
    #assertOpen() {
        if (this.#closed)
            throw new Error("AgentSupervisor is closed");
    }
}
function modelLabel(runtime) {
    return `${runtime.providerProfile.provider}/${runtime.model.id}`;
}
function normalizedGeminiModelId(value) {
    const id = (value.normalize("NFKC").toLocaleLowerCase().split("/").at(-1) ?? value).replace(/-high$/u, "");
    return id;
}
/** Uses every configured chat-capable Gemini before crossing to another Provider. */
export function orderedGeminiFallbackProfileIds(primary, profiles) {
    const primaryModelId = normalizedGeminiModelId(primary.modelId);
    if (!isChatGeminiModelId(primaryModelId))
        return [];
    const order = [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
    ];
    const candidates = profiles.filter((candidate) => candidate.id !== primary.id && isChatGeminiModelId(normalizedGeminiModelId(candidate.modelId)));
    const byModelId = new Map();
    for (const candidate of candidates) {
        const modelId = normalizedGeminiModelId(candidate.modelId);
        if (!byModelId.has(modelId))
            byModelId.set(modelId, candidate);
    }
    const primaryIndex = order.indexOf(primaryModelId);
    const preferredOrder = primaryIndex >= 0
        ? [...order.slice(primaryIndex + 1), ...order.slice(0, primaryIndex)]
        : order;
    const selected = preferredOrder.flatMap((modelId) => {
        const match = byModelId.get(modelId);
        return match ? [match.id] : [];
    });
    return [
        ...selected,
        ...[...byModelId.entries()]
            .filter(([modelId]) => !order.includes(modelId))
            .sort(([leftId, left], [rightId, right]) => leftId.localeCompare(rightId) || left.id.localeCompare(right.id))
            .map(([, candidate]) => candidate.id),
    ];
}
function isChatGeminiModelId(modelId) {
    return modelId.startsWith("gemini-") &&
        !/(?:embedding|imagen|veo|tts|robotics|computer-use)/u.test(modelId);
}
function isGeminiChatProfile(profile, provider) {
    return profile.enabled &&
        profile.input.includes("text") &&
        provider?.enabled === true &&
        isChatGeminiModelId(normalizedGeminiModelId(profile.modelId));
}
function isGeminiVisionProfile(profile, provider) {
    return isGeminiChatProfile(profile, provider) && profile.input.includes("image");
}
function selectGeminiVisionProfileId(preferredIds, profiles) {
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const id of preferredIds) {
        if (id && byId.has(id))
            return id;
    }
    const order = [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
    ];
    return profiles
        .slice()
        .sort((left, right) => {
        const leftModelId = normalizedGeminiModelId(left.modelId);
        const rightModelId = normalizedGeminiModelId(right.modelId);
        const leftRank = order.indexOf(leftModelId);
        const rightRank = order.indexOf(rightModelId);
        return (leftRank < 0 ? order.length : leftRank) - (rightRank < 0 ? order.length : rightRank) ||
            leftModelId.localeCompare(rightModelId) ||
            left.id.localeCompare(right.id);
    })[0]?.id;
}
function selectParticipationProfileId(preferredIds, profiles) {
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const id of preferredIds) {
        if (id && byId.has(id))
            return id;
    }
    return profiles
        .slice()
        .sort((left, right) => normalizedGeminiModelId(left.modelId).localeCompare(normalizedGeminiModelId(right.modelId)) || left.id.localeCompare(right.id))[0]?.id;
}
/** Routes only obviously bounded social turns to the optional low-cost fast model. */
export function shouldUseFastChatModel(event) {
    if (event.metadata?.proactiveKind || event.replyTo || (event.attachments?.length ?? 0) > 0)
        return false;
    if (event.parts?.some((part) => part.type !== "text"))
        return false;
    const text = event.text.normalize("NFKC").trim();
    if (!text || [...text].length > 120)
        return false;
    return !/(?:分析|推理|比较|对比|总结|复盘|计划|方案|代码|编程|调试|排查|研究|搜索|搜一下|查一下|查证|最新|实时|现在|目前|今天|明天|天气|新闻|股价|汇率|数据|表格|文件|视频|图片|表情|斗图|emoji|gif|翻译全文|详细|一步一步|为什么|证明|计算|提醒|定时|日程|记住|别忘|忘掉|忘记|纠正|记错|以后(?:要|别|不要)|继续|接着|然后|刚才|上面|前面)/iu.test(text);
}
function chatroomValue(values, event) {
    if (event.conversation.kind !== "group")
        return undefined;
    const exact = values.get(event.conversation.id);
    if (exact)
        return exact;
    for (const [chatroomId, value] of values) {
        if (event.conversation.id.endsWith(`:${chatroomId}`))
            return value;
    }
    return undefined;
}
function canonicalConversationId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function safeNotificationName(value) {
    const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return [...normalized].slice(0, 80).join("") || "未命名成员";
}
function botConfiguredForRoom(bot, roomId) {
    const canonical = canonicalConversationId(roomId);
    return bot.chatroomModelOverrides.some((item) => canonicalConversationId(item.chatroomId) === canonical);
}
function fusionBotPriority(left, right) {
    return left.id.localeCompare(right.id);
}
function fusedBotConfiguration(source, target, sharedRoomIds) {
    const sourceByRoom = new Map(source.chatroomModelOverrides.map((item) => [canonicalConversationId(item.chatroomId), item]));
    const sharedRooms = new Set(sharedRoomIds.map(canonicalConversationId));
    const chatroomModelOverrides = [
        ...target.chatroomModelOverrides.filter((item) => !sharedRooms.has(canonicalConversationId(item.chatroomId))),
        ...[...sharedRooms].flatMap((roomId) => {
            const item = sourceByRoom.get(roomId);
            return item ? [cloneChatroomOverride(item, roomId)] : [];
        }),
    ];
    const fused = {
        ...target,
        wakeWords: [...new Set([...source.wakeWords, source.displayName, ...target.wakeWords])],
        operatorIds: [...source.operatorIds],
        ...(source.personaProfileId !== undefined ? { personaProfileId: source.personaProfileId } : {}),
        defaultGroupActivation: source.defaultGroupActivation,
        chatModelProfileId: source.chatModelProfileId,
        fastChatModelProfileId: source.fastChatModelProfileId,
        participationJudgeModelProfileId: source.participationJudgeModelProfileId,
        fallbackChatModelProfileIds: [...source.fallbackChatModelProfileIds],
        visionModelProfileId: source.visionModelProfileId,
        chatroomModelOverrides,
        imageUnderstandingEnabled: source.imageUnderstandingEnabled,
        limits: { ...source.limits },
        socialSchedule: { ...source.socialSchedule },
        plugins: source.plugins.map((plugin) => ({ ...plugin, settings: { ...plugin.settings } })),
    };
    if (source.soul)
        fused.soul = source.soul;
    else
        delete fused.soul;
    return fused;
}
function cloneChatroomOverride(override, roomId) {
    return {
        ...override,
        chatroomId: canonicalConversationId(roomId),
        managerIds: [...override.managerIds],
        redEnvelopeTargetIds: [...override.redEnvelopeTargetIds],
        pluginOverrides: override.pluginOverrides.map((plugin) => ({ ...plugin })),
    };
}
function chatroomOverrideEmpty(override) {
    return !override.label && !override.chatModelProfileId && !override.visionModelProfileId &&
        !override.personaProfileId && !override.ttsVoice && !override.ttsStyle && !override.participationIntensity &&
        override.managerIds.length === 0 && override.redEnvelopeTargetIds.length === 0 &&
        override.pluginOverrides.length === 0;
}
export function gatewayHealthReady(config, health) {
    void config;
    if (typeof health.healthy === "boolean")
        return health.healthy;
    if (typeof health.ok === "boolean")
        return health.ok;
    return true;
}
export function selectReplyBot(bots, healthyBotIds, mentionedIdentityIds) {
    const healthy = bots.filter((bot) => healthyBotIds.has(bot.id)).sort(fusionBotPriority);
    void mentionedIdentityIds;
    return healthy[0];
}
function canonicalIdentityId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function explicitlyAddressesBot(event, identityIds, wakeWords) {
    const botIds = new Set(identityIds.map(canonicalIdentityId));
    if (event.mentions?.some((mention) => botIds.has(canonicalIdentityId(mention.id))))
        return true;
    if (event.replyTo?.senderId && botIds.has(canonicalIdentityId(event.replyTo.senderId)))
        return true;
    const text = event.text.normalize("NFKC").toLocaleLowerCase();
    return wakeWords.some((word) => {
        const normalized = word.normalize("NFKC").trim().toLocaleLowerCase();
        return normalized.length > 0 && text.includes(normalized);
    });
}
function conversationManagerIds(config, conversationId) {
    const canonicalRoom = canonicalConversationId(conversationId);
    const override = config.chatroomModelOverrides.find((item) => canonicalConversationId(item.chatroomId) === canonicalRoom);
    return [...(override?.managerIds ?? [])];
}
function isConversationManager(config, conversationId, senderId) {
    const actor = canonicalIdentityId(senderId);
    return [...config.operatorIds, ...conversationManagerIds(config, conversationId)]
        .some((id) => canonicalIdentityId(id) === actor);
}
export function sharedReplyFingerprint(event) {
    const content = (event.text ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    const payload = event.transportMessageId
        ? [canonicalConversationId(event.conversation.id), `transport:${event.transportMessageId}`]
        : [
            canonicalConversationId(event.conversation.id),
            canonicalIdentityId(event.sender.id),
            String(Math.floor((event.timestamp ?? 0) / 2000)),
            String(event.metadata?.messageType ?? ""),
            content,
        ];
    return createHash("sha256").update(payload.join("\u0000")).digest("hex");
}
/** Thinking feedback is only for the first model reply after an explicit group @mention. */
export function shouldSendThinkingEmoji(event, botIdentityId, recentMessages, continuationWindowMs) {
    if (event.conversation.kind !== "group")
        return false;
    const botIds = new Set((typeof botIdentityId === "string" ? [botIdentityId] : botIdentityId).map(canonicalIdentityId));
    if (!(event.mentions ?? []).some((mention) => botIds.has(canonicalIdentityId(mention.id))))
        return false;
    if (continuationWindowMs <= 0)
        return true;
    const now = event.timestamp ?? Date.now();
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
        const message = recentMessages[index];
        if (message.direction !== "outbound" || !botIds.has(canonicalIdentityId(message.senderId)))
            continue;
        if (now < message.timestamp || now - message.timestamp > continuationWindowMs)
            return true;
        return recentMessages.length - index - 1 > 12;
    }
    return true;
}
function isNativeGeminiGateway(runtime) {
    const modelId = runtime.profile.modelId.normalize("NFKC").toLocaleLowerCase();
    const provider = runtime.providerProfile.provider.normalize("NFKC").toLocaleLowerCase();
    return /^(?:models\/)?gemini(?:[-_.]|$)/u.test(modelId) &&
        (provider === "aistudio" || provider === "cliproxyapi");
}
function agentPluginEnabled(config, plugin, conversationId) {
    const chatroom = config.chatroomModelOverrides.find((override) => conversationId === override.chatroomId || conversationId.endsWith(`:${override.chatroomId}`));
    return chatroom?.pluginOverrides.find((item) => item.pluginType === plugin.type)?.enabled ?? plugin.enabled;
}
function localDay(timestamp, timezoneOffsetMinutes) {
    const offsetMs = timezoneOffsetMinutes * 60_000;
    const dayMs = 24 * 60 * 60_000;
    const shifted = timestamp + offsetMs;
    const startAt = Math.floor(shifted / dayMs) * dayMs - offsetMs;
    return { startAt, dateKey: new Date(shifted).toISOString().slice(0, 10) };
}
function localClock(timestamp, timezoneOffsetMinutes) {
    const shifted = new Date(timestamp + timezoneOffsetMinutes * 60_000);
    return {
        minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        dateKey: shifted.toISOString().slice(0, 10),
    };
}
function isMinuteWithin(value, start, end) {
    const day = 24 * 60;
    const minute = ((value % day) + day) % day;
    const normalizedStart = ((start % day) + day) % day;
    const normalizedEnd = ((end % day) + day) % day;
    if (normalizedStart === normalizedEnd)
        return true;
    if (normalizedStart < normalizedEnd)
        return minute >= normalizedStart && minute < normalizedEnd;
    return minute >= normalizedStart || minute < normalizedEnd;
}
function minutesSince(value, start) {
    return ((value - start) % (24 * 60) + 24 * 60) % (24 * 60);
}
function scheduledEventId(kind, dateKey, identity) {
    const digest = createHash("sha256").update(`${kind}\u0000${dateKey}\u0000${identity}`).digest("hex").slice(0, 24);
    return `proactive:${kind}:${dateKey}:${digest}`;
}
function goodnightText(conversationId, dateKey) {
    const options = [
        "今天群里挺热闹，大家早点休息，晚安 🌙",
        "差不多该收工啦，大家晚安，明天见 🌙",
        "夜深了，今天先聊到这儿，大家晚安～",
    ];
    const index = Number.parseInt(createHash("sha256").update(`${conversationId}:${dateKey}`).digest("hex").slice(0, 8), 16) % options.length;
    return options[index];
}
function requiredSecret(env, name) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(`Required secret environment variable ${name} is not set`);
    return value;
}
function channelTimeoutMs(channel) {
    const value = channel.settings?.timeoutMs;
    return Number.isSafeInteger(value) && value > 0 ? value : 120_000;
}
function hasEmojiImage(event) {
    return (event.parts ?? []).some((part) => part.type === "image" && part.asset.metadata?.kind === "emoji");
}
function safeDataPath(dataDirectory, relativePath) {
    const path = resolve(dataDirectory, relativePath);
    const pathRelative = relative(dataDirectory, path);
    if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
        throw new Error("Configured data path escapes the data directory");
    }
    return path;
}
function emptyMetrics() {
    return {
        inboundMessages: 0,
        agentRuns: 0,
        replies: 0,
        agentFailures: 0,
        imageCalls: 0,
        imageFailures: 0,
        deliveries: 0,
        lastAgentDurationMs: null,
        totalAgentDurationMs: 0,
        llmCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        fallbackHops: 0,
        lastModelRoute: [],
        lastTimeToFirstTokenMs: null,
    };
}
function traceMessage(event) {
    switch (event.type) {
        case "agent.finished":
            return `Agent 完成，用时 ${event.durationMs}ms${event.replied ? "，已回复" : "，保持沉默"}`;
        case "agent.failed":
        case "image.understanding.failed":
            return event.error;
        case "agent.output_blocked":
            return event.reason === "upstream-error"
                ? "已阻止上游模型错误信息进入聊天出站"
                : "已阻止疑似模型内部分析进入聊天出站";
        case "trigger.decided":
            return event.respond ? `触发 Agent：${event.reason}` : `未触发：${event.reason}`;
        case "outbox.acked":
            return `已确认发送 ${event.actionIds.length} 条 action`;
        default:
            return event.type;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isTransientAudioTranscriptionError(error) {
    return /(?:\b(?:429|500|502|503|504)\b|fetch failed|network|econn|timed?\s*out|temporar|rate limit|too many requests)/iu.test(errorMessage(error));
}
function isTransientVoiceMediaError(error) {
    return /(?:contains no Base64 data|empty media|\b(?:429|500|502|503|504)\b|fetch failed|network|econn|timed?\s*out|temporar)/iu.test(errorMessage(error));
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function boundedInteger(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Value must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=supervisor.js.map
