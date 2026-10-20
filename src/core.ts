import { KeyedQueue } from "./keyed-queue.js";
import type { MediaResolver } from "./asset-store.js";
import { attachmentPartsForEvent, createAttachmentInspectionTool } from "./attachment-inspection.js";
import {
  createImageUnderstandingTool,
  type ImageUnderstandingCandidate,
  type ImageUnderstandingProvider,
} from "./image-understanding.js";
import { renderMessageParts, textPart, validateMessageParts } from "./message-parts.js";
import { buildSystemPrompt, buildTurnPrompt, DEFAULT_SOUL, shouldAutoLookupKnowledge } from "./prompt.js";
import { SqliteStore, type ConversationContextReset } from "./sqlite-store.js";
import { SharedConversationState } from "./shared-conversation-state.js";
import { replaceTransportIds, safeGroupDisplayName } from "./display-name.js";
import { emojiToolRecommendation } from "./emoji-library.js";
import { preferredVoiceReplyMode, WHISPER_TTS_STYLE, type ConversationVoiceMode } from "./reply-modality.js";
import { createCoreTools } from "./tools.js";
import { formatBeijingTimestamp } from "./time.js";
import { SocialTriggerPolicy } from "./trigger.js";
import { extractSearchTerms } from "./search-terms.js";
import { toChatPlainText } from "./chat-text.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCallStart,
  AgentToolProvider,
  BotIdentity,
  GroupActivation,
  GroupActivityDigest,
  GroupActivitySummary,
  HandleResult,
  InboundMessageEvent,
  KnowledgeRetriever,
  LearningAuditRecord,
  MemoryEmbeddingProvider,
  MemoryRecord,
  MessagePart,
  OutboundMessageAction,
  ParticipationCase,
  ParticipationCaseQuery,
  ParticipationLabel,
  ReplyQualityLabel,
  ParticipationSummary,
  ProactiveParticipationRequest,
  RememberInput,
  StoredMessage,
  TraceEvent,
  TraceListener,
  TriggerPolicy,
} from "./types.js";

export interface GroupAgentCoreOptions {
  bot: BotIdentity;
  /** Conversation-scoped display name and wake-word overrides, normally supplied by the active persona. */
  botIdentityResolver?: (
    event: InboundMessageEvent,
  ) => Partial<Pick<BotIdentity, "displayName" | "wakeWords">> | undefined;
  runner: AgentRunner;
  runnerResolver?: (event: InboundMessageEvent) => AgentRunner;
  /** Marks short, low-risk turns that may use a smaller prompt/tool surface. */
  fastTurnResolver?: (event: InboundMessageEvent) => boolean;
  /** Cheap runner used only for the JSON-only participation judge; falls back to the chat runner. */
  participationJudgeRunner?: AgentRunner;
  /** Local runner used to choose a semantic emoji response without invoking the commercial chat model. */
  emojiBattleRunner?: AgentRunner;
  identityAliasesResolver?: (event: InboundMessageEvent) => string[];
  sharedConversationState?: SharedConversationState;
  /** Stable per-Bot namespace so two accounts in one room never share provider affinity. */
  sessionNamespace?: string;
  /** Adds persona/config epochs to the provider session affinity key. */
  sessionKeyResolver?: (event: InboundMessageEvent) => string | undefined;
  databasePath?: string;
  soul?: string;
  soulResolver?: (event: InboundMessageEvent) => string | undefined;
  defaultGroupActivation?: GroupActivation;
  historyLimit?: number;
  maxHistoryChars?: number;
  memoryLimit?: number;
  behaviorLimit?: number;
  continuationWindowMs?: number;
  maxReplyChars?: number;
  maxAgentLlmCalls?: number;
  maxAgentToolCalls?: number;
  agentTimeoutMs?: number;
  maxKnowledgeChars?: number;
  knowledgeRetriever?: KnowledgeRetriever;
  operatorIds?: string[];
  triggerPolicy?: TriggerPolicy;
  onTrace?: TraceListener;
  toolProviders?: AgentToolProvider[];
  imageUnderstandingProvider?: ImageUnderstandingProvider;
  imageUnderstandingProviderResolver?: (event: InboundMessageEvent) => ImageUnderstandingProvider | undefined;
  maxImageUnderstandingCalls?: number;
  maxImageBytes?: number;
  maxImageEvidenceChars?: number;
  imageUnderstandingTimeoutMs?: number;
  imageContextMessageLimit?: number;
  imageContextWindowMs?: number;
  maxAvailableImagesPerTurn?: number;
  socialSchedule?: {
    enabled: boolean;
    timezoneOffsetMinutes: number;
    activeStartMinute: number;
    activeEndMinute: number;
    hotChatWindowMs: number;
    hotChatMinMessages: number;
    hotChatMinParticipants: number;
  };
  proactiveGate?: (event: InboundMessageEvent, reason: "ambient-hot-chat") => boolean | Promise<boolean>;
  autoParticipationGate?: (event: InboundMessageEvent) => boolean | Promise<boolean>;
  participationIntensityResolver?: (event: InboundMessageEvent) => ParticipationIntensity;
  /** Cross-runtime arbitration, evaluated only after this Core has decided it wants to reply. */
  responseGate?: (event: InboundMessageEvent, reason: string) => boolean | Promise<boolean>;
  /** Releases a cross-runtime reply claim when this Core fails after acquiring it. */
  responseGateRelease?: (event: InboundMessageEvent, reason: string) => void | Promise<void>;
  /** Optional Gemini semantic memory index layered over the local exact-term search. */
  memoryEmbeddingProvider?: MemoryEmbeddingProvider;
  /** Starts optional ephemeral feedback after the model has selected a long-running tool. */
  toolCallFeedback?: (context: ToolCallFeedbackContext) => void;
  /** @deprecated Use toolCallFeedback; retained for embedding compatibility. */
  pendingFeedback?: (context: PendingFeedbackContext) => void | (() => void);
  /** Persistent user-controlled reply modality, stored outside the model transcript. */
  voiceModeResolver?: (event: InboundMessageEvent) => ConversationVoiceMode;
}

export type ParticipationIntensity = "conservative" | "standard" | "active";

const PARTICIPATION_INTENSITY = {
  conservative: { threshold: 0.85, initialBackoffMs: 45_000 },
  standard: { threshold: 0.75, initialBackoffMs: 20_000 },
  active: { threshold: 0.62, initialBackoffMs: 8_000 },
} as const satisfies Record<ParticipationIntensity, { threshold: number; initialBackoffMs: number }>;

export interface ChatSessionDescriptor {
  sessionId: string;
  sessionScope: string;
  contextEpoch: number;
}

export interface PendingFeedbackContext {
  event: InboundMessageEvent;
  triggerReason: string;
  recentMessages: readonly StoredMessage[];
}

export interface ToolCallFeedbackContext extends AgentToolCallStart {
  event: InboundMessageEvent;
  triggerReason: string;
}

export interface AgentReceiveContext {
  /** Supplied by ChannelRuntime only for the plugin that owns this inbound event. */
  mediaResolver?: MediaResolver;
}

export class GroupAgentCore {
  readonly #bot: BotIdentity;
  readonly #botIdentityResolver: GroupAgentCoreOptions["botIdentityResolver"];
  readonly #runner: AgentRunner;
  readonly #runnerResolver: ((event: InboundMessageEvent) => AgentRunner) | undefined;
  readonly #fastTurnResolver: ((event: InboundMessageEvent) => boolean) | undefined;
  readonly #participationJudgeRunner: AgentRunner | undefined;
  readonly #emojiBattleRunner: AgentRunner | undefined;
  readonly #identityAliasesResolver: ((event: InboundMessageEvent) => string[]) | undefined;
  readonly #sharedConversationState: SharedConversationState | undefined;
  readonly #sessionNamespace: string;
  readonly #sessionKeyResolver: ((event: InboundMessageEvent) => string | undefined) | undefined;
  readonly #store: SqliteStore;
  readonly #queue = new KeyedQueue();
  readonly #triggerPolicy: TriggerPolicy;
  readonly #baseSoul: string;
  readonly #soulResolver: ((event: InboundMessageEvent) => string | undefined) | undefined;
  readonly #defaultActivation: GroupActivation;
  readonly #historyLimit: number;
  readonly #maxHistoryChars: number;
  readonly #memoryLimit: number;
  readonly #behaviorLimit: number;
  readonly #continuationWindowMs: number;
  readonly #maxReplyChars: number;
  readonly #maxAgentLlmCalls: number;
  readonly #maxAgentToolCalls: number;
  readonly #agentTimeoutMs: number;
  readonly #maxKnowledgeChars: number;
  readonly #knowledgeRetriever: KnowledgeRetriever | undefined;
  readonly #operatorIds: ReadonlySet<string>;
  readonly #onTrace: TraceListener | undefined;
  readonly #toolProviders: readonly AgentToolProvider[];
  readonly #imageUnderstandingProvider: ImageUnderstandingProvider | undefined;
  readonly #imageUnderstandingProviderResolver:
    | ((event: InboundMessageEvent) => ImageUnderstandingProvider | undefined)
    | undefined;
  readonly #maxImageUnderstandingCalls: number;
  readonly #maxImageBytes: number;
  readonly #maxImageEvidenceChars: number;
  readonly #imageUnderstandingTimeoutMs: number;
  readonly #imageContextMessageLimit: number;
  readonly #imageContextWindowMs: number;
  readonly #maxAvailableImagesPerTurn: number;
  readonly #socialSchedule: GroupAgentCoreOptions["socialSchedule"];
  readonly #proactiveGate: GroupAgentCoreOptions["proactiveGate"];
  readonly #autoParticipationGate: GroupAgentCoreOptions["autoParticipationGate"];
  readonly #participationIntensityResolver: GroupAgentCoreOptions["participationIntensityResolver"];
  readonly #responseGate: GroupAgentCoreOptions["responseGate"];
  readonly #responseGateRelease: GroupAgentCoreOptions["responseGateRelease"];
  readonly #memoryEmbeddingProvider: MemoryEmbeddingProvider | undefined;
  readonly #toolCallFeedback: GroupAgentCoreOptions["toolCallFeedback"];
  readonly #voiceModeResolver: GroupAgentCoreOptions["voiceModeResolver"];
  /** Per-conversation judge throttle: negative verdicts back off exponentially. */
  readonly #judgeState = new Map<string, { until: number; misses: number }>();
  /** Query-embedding LRU keyed by model + normalized query text. */
  readonly #queryEmbeddingCache = new Map<string, number[]>();
  #closed = false;

  constructor(options: GroupAgentCoreOptions) {
    assertIdentity(options.bot);
    this.#bot = options.bot;
    this.#botIdentityResolver = options.botIdentityResolver;
    this.#runner = options.runner;
    this.#runnerResolver = options.runnerResolver;
    this.#fastTurnResolver = options.fastTurnResolver;
    this.#participationJudgeRunner = options.participationJudgeRunner;
    this.#emojiBattleRunner = options.emojiBattleRunner;
    this.#identityAliasesResolver = options.identityAliasesResolver;
    this.#sharedConversationState = options.sharedConversationState;
    this.#sessionNamespace = options.sessionNamespace ?? options.bot.id;
    this.#sessionKeyResolver = options.sessionKeyResolver;
    this.#store = new SqliteStore(options.databasePath ?? "./data/pi-bot.sqlite");
    this.#triggerPolicy = options.triggerPolicy ?? new SocialTriggerPolicy();
    this.#baseSoul = options.soul ?? DEFAULT_SOUL;
    this.#soulResolver = options.soulResolver;
    this.#defaultActivation = options.defaultGroupActivation ?? "mention";
    this.#historyLimit = boundedInteger(options.historyLimit ?? 50, 1, 500, "historyLimit");
    this.#maxHistoryChars = boundedInteger(options.maxHistoryChars ?? 12_000, 1_000, 200_000, "maxHistoryChars");
    this.#memoryLimit = boundedInteger(options.memoryLimit ?? 12, 0, 100, "memoryLimit");
    this.#behaviorLimit = boundedInteger(options.behaviorLimit ?? 12, 0, 100, "behaviorLimit");
    this.#continuationWindowMs = boundedInteger(
      options.continuationWindowMs ?? 5 * 60 * 1000,
      0,
      24 * 60 * 60 * 1000,
      "continuationWindowMs",
    );
    this.#maxReplyChars = boundedInteger(options.maxReplyChars ?? 2000, 100, 100_000, "maxReplyChars");
    this.#maxAgentLlmCalls = boundedInteger(options.maxAgentLlmCalls ?? 6, 1, 30, "maxAgentLlmCalls");
    this.#maxAgentToolCalls = boundedInteger(options.maxAgentToolCalls ?? 8, 0, 50, "maxAgentToolCalls");
    this.#agentTimeoutMs = boundedInteger(options.agentTimeoutMs ?? 120_000, 5_000, 10 * 60_000, "agentTimeoutMs");
    this.#maxKnowledgeChars = boundedInteger(
      options.maxKnowledgeChars ?? 6000,
      500,
      100_000,
      "maxKnowledgeChars",
    );
    this.#knowledgeRetriever = options.knowledgeRetriever;
    this.#operatorIds = new Set(options.operatorIds ?? []);
    this.#onTrace = options.onTrace;
    this.#toolProviders = [...(options.toolProviders ?? [])];
    this.#imageUnderstandingProvider = options.imageUnderstandingProvider;
    this.#imageUnderstandingProviderResolver = options.imageUnderstandingProviderResolver;
    this.#maxImageUnderstandingCalls = boundedInteger(
      options.maxImageUnderstandingCalls ?? 2,
      1,
      10,
      "maxImageUnderstandingCalls",
    );
    this.#maxImageBytes = boundedInteger(options.maxImageBytes ?? 10 * 1024 * 1024, 1, 100 * 1024 * 1024, "maxImageBytes");
    this.#maxImageEvidenceChars = boundedInteger(
      options.maxImageEvidenceChars ?? 4000,
      100,
      50_000,
      "maxImageEvidenceChars",
    );
    this.#imageUnderstandingTimeoutMs = boundedInteger(
      options.imageUnderstandingTimeoutMs ?? 45_000,
      1,
      10 * 60_000,
      "imageUnderstandingTimeoutMs",
    );
    this.#imageContextMessageLimit = boundedInteger(
      options.imageContextMessageLimit ?? 8,
      0,
      50,
      "imageContextMessageLimit",
    );
    this.#imageContextWindowMs = boundedInteger(
      options.imageContextWindowMs ?? 10 * 60_000,
      0,
      24 * 60 * 60_000,
      "imageContextWindowMs",
    );
    this.#maxAvailableImagesPerTurn = boundedInteger(
      options.maxAvailableImagesPerTurn ?? 4,
      1,
      20,
      "maxAvailableImagesPerTurn",
    );
    this.#socialSchedule = options.socialSchedule;
    this.#proactiveGate = options.proactiveGate;
    this.#autoParticipationGate = options.autoParticipationGate;
    this.#participationIntensityResolver = options.participationIntensityResolver;
    this.#responseGate = options.responseGate;
    this.#responseGateRelease = options.responseGateRelease;
    this.#memoryEmbeddingProvider = options.memoryEmbeddingProvider;
    this.#toolCallFeedback = options.toolCallFeedback;
    this.#voiceModeResolver = options.voiceModeResolver;
  }

  async receive(event: InboundMessageEvent, context: AgentReceiveContext = {}): Promise<HandleResult> {
    this.#assertOpen();
    validateEvent(event);
    return this.#queue.run(event.conversation.id, () => this.#handle(event, context));
  }

  async receiveDirect(
    event: InboundMessageEvent,
    text: string,
    reason: string,
    parts: MessagePart[] = [],
  ): Promise<HandleResult> {
    this.#assertOpen();
    validateEvent(event);
    const normalized = cleanReply(text, this.#maxReplyChars);
    const normalizedParts = parts.map((part) =>
      part.type === "text" ? { ...part, text: cleanReply(part.text, this.#maxReplyChars) ?? "" } : part,
    ).filter((part) => part.type !== "text" || part.text.length > 0);
    validateMessageParts(normalizedParts);
    if (!normalized && normalizedParts.length === 0) throw new Error("Direct plugin reply cannot be empty");
    const normalizedReason = reason.normalize("NFKC").trim();
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(normalizedReason)) throw new Error("Direct plugin reply reason is invalid");
    return this.#queue.run(event.conversation.id, () =>
      this.#handleDirect(event, normalized ?? "", normalizedReason, normalizedParts));
  }

  async receiveWithPrompt(event: InboundMessageEvent, prompt: string, reason: string): Promise<HandleResult> {
    this.#assertOpen();
    validateEvent(event);
    const normalizedPrompt = prompt.normalize("NFKC").trim();
    if (!normalizedPrompt) throw new Error("Plugin agent prompt cannot be empty");
    const normalizedReason = reason.normalize("NFKC").trim();
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(normalizedReason)) throw new Error("Plugin agent prompt reason is invalid");
    return this.#queue.run(event.conversation.id, () =>
      this.#handleWithPrompt(event, normalizedPrompt, normalizedReason));
  }

  async receiveIgnored(event: InboundMessageEvent, reason: string): Promise<HandleResult> {
    this.#assertOpen();
    validateEvent(event);
    const normalizedReason = reason.normalize("NFKC").trim();
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(normalizedReason)) throw new Error("Ignored event reason is invalid");
    return this.#queue.run(event.conversation.id, () => this.#handleIgnored(event, normalizedReason));
  }

  setGroupActivation(conversationId: string, activation: GroupActivation): void {
    this.#assertOpen();
    if (!conversationId.trim()) throw new Error("conversationId cannot be empty");
    this.#store.setGroupActivation(conversationId, activation);
  }

  pendingOutbox(limit = 100): OutboundMessageAction[] {
    this.#assertOpen();
    return this.#store.pendingOutbox(boundedInteger(limit, 1, 10_000, "limit"));
  }

  /** True once this Core has durably ingested the native event id. */
  hasSeenEvent(eventId: string): boolean {
    this.#assertOpen();
    if (!eventId.trim()) return false;
    return this.#store.hasSeenEvent(eventId);
  }

  acknowledgeOutbox(actionIds: string[]): void {
    this.#assertOpen();
    this.#store.acknowledgeOutbox(actionIds);
    this.#trace({ type: "outbox.acked", actionIds: [...actionIds] });
  }

  remember(input: RememberInput): MemoryRecord {
    this.#assertOpen();
    const memory = this.#store.remember(input);
    this.#trace({ type: "memory.saved", memoryId: memory.id, scope: memory.scope, scopeId: memory.scopeId });
    return memory;
  }

  listLearningAudit(conversationId: string, limit = 100): LearningAuditRecord[] {
    this.#assertOpen();
    if (!conversationId.trim()) throw new Error("conversationId cannot be empty");
    return this.#store.listLearningAudit(conversationId, boundedInteger(limit, 1, 10_000, "limit"));
  }

  listParticipationCases(query: ParticipationCaseQuery = {}): ParticipationCase[] {
    this.#assertOpen();
    return this.#store.listParticipationCases(query);
  }

  participationSummary(): ParticipationSummary {
    this.#assertOpen();
    return this.#store.participationSummary();
  }

  labelParticipationCase(eventId: string, label: ParticipationLabel, reason?: string): ParticipationCase {
    this.#assertOpen();
    return this.#store.labelParticipationCase(eventId, label, reason);
  }

  labelReplyQualityCase(eventId: string, label: ReplyQualityLabel, reason?: string): ParticipationCase {
    this.#assertOpen();
    return this.#store.labelReplyQualityCase(eventId, label, reason);
  }

  pruneParticipationCases(retentionDays: number, maxCases: number): { deleted: number } {
    this.#assertOpen();
    return this.#store.pruneParticipationCases(retentionDays, maxCases);
  }

  listGroupActivity(startAt: number, endAt: number, minInboundMessages = 1): GroupActivitySummary[] {
    this.#assertOpen();
    return this.#store.listGroupActivity(startAt, endAt, minInboundMessages).filter(
      (group) => (this.#store.getGroupActivation(group.conversationId) ?? this.#defaultActivation) === "always",
    );
  }

  listConversationMessages(
    conversationId: string,
    options: { limit?: number; beforeSequence?: number } = {},
  ): StoredMessage[] {
    this.#assertOpen();
    return this.#store.listConversationMessages(conversationId, options);
  }

  inboundImages(eventId: string): Array<{
    messageId: string;
    senderId: string;
    timestamp: number;
    part: Extract<MessagePart, { type: "image" }>;
  }> {
    this.#assertOpen();
    if (!eventId.trim()) throw new Error("eventId cannot be empty");
    return this.#store.getInboundImages(eventId);
  }

  resetConversationContext(conversationId: string, actorId: string, sourceEventId: string): ConversationContextReset {
    this.#assertOpen();
    const local = this.#store.resetConversationContext(conversationId, actorId, sourceEventId);
    if (!this.#sharedConversationState?.hasConversation(conversationId)) return local;
    return this.#sharedConversationState?.resetContext(conversationId, actorId, sourceEventId) ?? local;
  }

  conversationContextReset(conversationId: string): ConversationContextReset | undefined {
    this.#assertOpen();
    if (!this.#sharedConversationState?.hasConversation(conversationId)) {
      return this.#store.getConversationContextReset(conversationId);
    }
    return this.#sharedConversationState?.contextReset(conversationId) ??
      this.#store.getConversationContextReset(conversationId);
  }

  listColdGroups(cutoffAt: number, earliestAt: number, limit = 20): GroupActivitySummary[] {
    this.#assertOpen();
    return this.#store.listColdGroups(cutoffAt, earliestAt, limit).filter(
      (group) => (this.#store.getGroupActivation(group.conversationId) ?? this.#defaultActivation) === "always",
    );
  }

  getGroupActivityDigest(conversationId: string, startAt: number, endAt: number): GroupActivityDigest | undefined {
    this.#assertOpen();
    return this.#store.getGroupActivityDigest(conversationId, startAt, endAt);
  }

  async participate(request: ProactiveParticipationRequest): Promise<HandleResult> {
    this.#assertOpen();
    if (!request.id.trim() || !request.conversationId.trim() || !request.prompt.trim()) {
      throw new Error("Proactive participation requires id, conversationId, and prompt");
    }
    return this.#queue.run(request.conversationId, () => this.#handleProactive(request));
  }

  async sendProactiveText(request: ProactiveParticipationRequest, text: string): Promise<HandleResult> {
    return this.sendProactiveMessage(request, text);
  }

  async sendProactiveMessage(
    request: ProactiveParticipationRequest,
    text: string,
    parts: MessagePart[] = [],
  ): Promise<HandleResult> {
    this.#assertOpen();
    validateMessageParts(parts);
    const normalized = text.trim() ? cleanReply(text, this.#maxReplyChars) ?? "" : "";
    if (!normalized && parts.length === 0) throw new Error("Proactive message cannot be empty");
    const outboundParts = parts.length > 0 ? [...parts] : [textPart(normalized)];
    const participationSummary = normalized || renderMessageParts(outboundParts, true).join("\n");
    return this.#queue.run(request.conversationId, async () => {
      const recent = this.#recent(request.conversationId);
      const prepared = this.#store.beginProactiveEvent(request, this.#bot.id, recent);
      if (!prepared.inserted) {
        const completed = this.#store.getOutcome(request.id, true);
        if (completed) return completed;
      }
      if (!this.#store.claimProcessing(request.id, `proactive-${request.kind}`)) {
        const completed = this.#store.getOutcome(request.id, true);
        if (completed) return completed;
        throw new Error(`Proactive event ${request.id} is already being processed`);
      }
      this.#store.completeParticipationCase(request.id, "replied", participationSummary);
      return this.#completeWithReply(
        prepared.event,
        normalized,
        outboundParts,
        `proactive-${request.kind}`,
      );
    });
  }

  #recentBefore(event: InboundMessageEvent): StoredMessage[] {
    if (event.conversation.kind === "group" && this.#sharedConversationState) {
      return this.#sharedConversationState.recentBefore(event, this.#historyLimit, this.#bot);
    }
    return this.#store.getRecentBefore(event.conversation.id, event.id, this.#historyLimit);
  }

  #recent(conversationId: string): StoredMessage[] {
    if (this.#sharedConversationState?.hasConversation(conversationId)) {
      return this.#sharedConversationState.recent(conversationId, this.#historyLimit, this.#bot);
    }
    return this.#store.getRecent(conversationId, this.#historyLimit);
  }

  #botFor(event: InboundMessageEvent): BotIdentity {
    const resolved = this.#botIdentityResolver?.(event);
    const base = resolved
      ? {
          ...this.#bot,
          ...(resolved.displayName?.trim() ? { displayName: resolved.displayName.trim() } : {}),
          ...(resolved.wakeWords ? { wakeWords: [...new Set(resolved.wakeWords.map((word) => word.trim()).filter(Boolean))] } : {}),
        }
      : this.#bot;
    const aliases = this.#identityAliasesResolver?.(event) ?? [];
    return aliases.length > 0 ? { ...base, aliasIds: aliases } : base;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  async #handle(event: InboundMessageEvent, context: AgentReceiveContext): Promise<HandleResult> {
    const ingested = this.#store.ingest(event);
    if (!ingested.inserted) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) {
        this.#trace({ type: "inbound.replayed", eventId: event.id, conversationId: event.conversation.id });
        return completed;
      }
    } else {
      this.#trace({ type: "inbound.stored", eventId: event.id, conversationId: event.conversation.id });
    }

    this.#sharedConversationState?.prepareInbound(event);

    this.#learnImplicitParticipationFeedback(event);

    const triggerMessages = this.#recentBefore(event);
    const activation =
      event.conversation.kind === "group"
        ? (this.#store.getGroupActivation(event.conversation.id) ?? this.#defaultActivation)
        : "always";
    const quietHours =
      event.conversation.kind === "group" &&
      this.#socialSchedule?.enabled === true &&
      !isWithinActiveHours(
        event.timestamp ?? Date.now(),
        this.#socialSchedule.timezoneOffsetMinutes,
        this.#socialSchedule.activeStartMinute,
        this.#socialSchedule.activeEndMinute,
      );
    let baseDecision = await this.#triggerPolicy.decide({
      event,
      bot: this.#botFor(event),
      activation,
      recentMessages: triggerMessages,
      continuationWindowMs: this.#continuationWindowMs,
      ...(quietHours ? { quietHours: true } : {}),
      ...(this.#socialSchedule?.enabled && !quietHours
        ? {
            hotChat: {
              windowMs: this.#socialSchedule.hotChatWindowMs,
              minMessages: this.#socialSchedule.hotChatMinMessages,
              minParticipants: this.#socialSchedule.hotChatMinParticipants,
            },
          }
        : {}),
    });
    const autoParticipationAllowed = event.conversation.kind !== "group" || !this.#autoParticipationGate
      ? true
      : await this.#autoParticipationGate(event);
    let participationModelUsed = false;
    if (
      event.conversation.kind === "group" &&
      (activation === "always" || activation === "mention") &&
      !quietHours &&
      !baseDecision.respond &&
      (baseDecision.reason === "ambient-no-signal" || baseDecision.reason === "not-addressed") &&
      autoParticipationAllowed &&
      this.#participationJudgeRunner &&
      this.#judgeCooldownExpired(event) &&
      recentConversationThread(triggerMessages, this.#bot.id, event.timestamp ?? Date.now(), this.#continuationWindowMs)
    ) {
      participationModelUsed = true;
      const intensity = this.#participationIntensity(event);
      baseDecision = await this.#judgeConversationContinuation(event, triggerMessages, intensity).catch((error) => {
        this.#trace({ type: "agent.failed", eventId: event.id, error: `participation-judge: ${error instanceof Error ? error.message : String(error)}` });
        return baseDecision;
      });
      this.#recordJudgeOutcome(event, baseDecision.respond, intensity);
    }
    let decision = this.#applyParticipationGuidance(event, activation, baseDecision);
    if (decision.respond && isAutomaticParticipationReason(decision.reason) && !autoParticipationAllowed) {
      decision = { respond: false, reason: "auto-participation-disabled" };
    }
    if (
      decision.respond &&
      decision.reason === "ambient-hot-chat" &&
      this.#proactiveGate &&
      !(await this.#proactiveGate(event, "ambient-hot-chat"))
    ) {
      decision = { respond: false, reason: "ambient-rate-limited" };
    }
    this.#store.recordParticipationCase({
      event,
      context: triggerMessages,
      activation,
      decision,
    });
    if (participationModelUsed) this.#store.markParticipationModelUsed(event.id);
    this.#trace({ type: "trigger.decided", eventId: event.id, respond: decision.respond, reason: decision.reason });

    if (!this.#store.claimProcessing(event.id, decision.reason)) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) return completed;
      throw new Error(`Event ${event.id} is already being processed`);
    }

    if (!decision.respond) {
      this.#store.completeParticipationCase(event.id, "ignored");
      return this.#store.completeWithoutReply(event.id, decision.reason);
    }

    if (this.#responseGate && !(await this.#responseGate(event, decision.reason))) {
      const reason = "shared-reply-arbitrated";
      this.#store.completeParticipationCase(event.id, "ignored");
      this.#trace({ type: "trigger.decided", eventId: event.id, respond: false, reason });
      return this.#store.completeWithoutReply(event.id, reason);
    }

    return this.#runAgent(event, activation, triggerMessages, decision.reason, context);
  }

  #judgeCooldownExpired(event: InboundMessageEvent): boolean {
    const state = this.#judgeState.get(event.conversation.id);
    return !state || (event.timestamp ?? Date.now()) >= state.until;
  }

  #participationIntensity(event: InboundMessageEvent): ParticipationIntensity {
    return this.#participationIntensityResolver?.(event) ?? "standard";
  }

  #recordJudgeOutcome(event: InboundMessageEvent, responded: boolean, intensity: ParticipationIntensity): void {
    const now = event.timestamp ?? Date.now();
    if (responded) {
      this.#judgeState.delete(event.conversation.id);
      return;
    }
    const misses = (this.#judgeState.get(event.conversation.id)?.misses ?? 0) + 1;
    const backoffMs = Math.min(PARTICIPATION_INTENSITY[intensity].initialBackoffMs * 2 ** (misses - 1), 5 * 60_000);
    this.#judgeState.set(event.conversation.id, { until: now + backoffMs, misses });
    if (this.#judgeState.size > 500) {
      const oldest = this.#judgeState.keys().next().value;
      if (oldest !== undefined) this.#judgeState.delete(oldest);
    }
  }

  async #judgeConversationContinuation(
    event: InboundMessageEvent,
    messages: StoredMessage[],
    intensity: ParticipationIntensity,
  ): Promise<{ respond: boolean; reason: string }> {
    const activeBot = this.#botFor(event);
    const thread = recentConversationThread(
      messages,
      this.#bot.id,
      event.timestamp ?? Date.now(),
      this.#continuationWindowMs,
    );
    if (!thread) return { respond: false, reason: "ambient-no-signal" };
    const runner = this.#participationJudgeRunner;
    if (!runner) return { respond: false, reason: "ambient-no-signal" };
    const transcript = [...thread.slice(-6), {
      sequence: Number.MAX_SAFE_INTEGER,
      id: event.id,
      conversationId: event.conversation.id,
      direction: "inbound" as const,
      senderId: event.sender.id,
      senderName: event.sender.displayName,
      text: event.text,
      timestamp: event.timestamp ?? Date.now(),
    }].map((message) => ({
      speaker: message.direction === "outbound" ? activeBot.displayName : message.senderName,
      role: message.direction === "outbound" ? "bot" : "human",
      text: message.text.slice(0, 160),
    }));
    const result = await runner.run({
      systemPrompt: participationJudgeSystemPrompt(intensity),
      prompt: JSON.stringify({
        // Keep the schema before the changing transcript so Gemini's implicit
        // prompt cache can reuse the largest possible prefix.
        outputSchema: {
          decision: "speak | silent",
          reason: "followup | correction | new_info | ack_only | human_to_human | topic_shift | no_value | uncertain",
          confidence: "number between 0 and 1",
        },
        recentConversation: transcript,
      }),
      // Keep the provider affinity key stable for this Bot and room. The
      // transcript is already the changing suffix of the prompt.
      sessionId: `participation-judge:${this.#sessionNamespace}:${event.conversation.id}:intensity:${intensity}`,
      tools: [],
      budget: { maxLlmCalls: 1, maxToolCalls: 0, timeoutMs: 20_000 },
    });
    const decision = parseConversationJudge(result.text);
    if (decision.decision === "speak" && decision.confidence >= PARTICIPATION_INTENSITY[intensity].threshold) {
      return {
        respond: true,
        reason: `conversation-followup:${decision.reason}:${decision.confidence.toFixed(2)}`,
      };
    }
    return {
      respond: false,
      reason: decision.decision === "speak"
        ? `conversation-silent:low_confidence:${decision.confidence.toFixed(2)}`
        : `conversation-silent:${decision.reason}:${decision.confidence.toFixed(2)}`,
    };
  }

  async #handleDirect(
    event: InboundMessageEvent,
    text: string,
    reason: string,
    parts: MessagePart[],
  ): Promise<HandleResult> {
    const ingested = this.#store.ingest(event);
    if (!ingested.inserted) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) {
        this.#trace({ type: "inbound.replayed", eventId: event.id, conversationId: event.conversation.id });
        return completed;
      }
    } else {
      this.#trace({ type: "inbound.stored", eventId: event.id, conversationId: event.conversation.id });
    }
    this.#sharedConversationState?.prepareInbound(event);
    const recent = this.#recentBefore(event);
    const activation = event.conversation.kind === "group"
      ? (this.#store.getGroupActivation(event.conversation.id) ?? this.#defaultActivation)
      : "always";
    this.#store.recordParticipationCase({
      event,
      context: recent,
      activation,
      decision: { respond: true, reason },
    });
    this.#trace({ type: "trigger.decided", eventId: event.id, respond: true, reason });
    if (this.#responseGate && !(await this.#responseGate(event, reason))) {
      const gateReason = "shared-reply-arbitrated";
      this.#store.completeParticipationCase(event.id, "ignored");
      this.#trace({ type: "trigger.decided", eventId: event.id, respond: false, reason: gateReason });
      return this.#store.completeWithoutReply(event.id, gateReason);
    }
    if (!this.#store.claimProcessing(event.id, reason)) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) return completed;
      throw new Error(`Event ${event.id} is already being processed`);
    }
    const replyText = text || renderMessageParts(parts, true).join("\n");
    this.#store.completeParticipationCase(event.id, "replied", replyText);
    return this.#completeWithReply(
      event,
      replyText,
      parts.length > 0 ? parts : [textPart(replyText)],
      reason,
    );
  }

  async #handleWithPrompt(event: InboundMessageEvent, prompt: string, reason: string): Promise<HandleResult> {
    const ingested = this.#store.ingest(event);
    if (!ingested.inserted) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) {
        this.#trace({ type: "inbound.replayed", eventId: event.id, conversationId: event.conversation.id });
        return completed;
      }
    } else {
      this.#trace({ type: "inbound.stored", eventId: event.id, conversationId: event.conversation.id });
    }
    this.#sharedConversationState?.prepareInbound(event);
    const recent = this.#recentBefore(event);
    const activation = event.conversation.kind === "group"
      ? (this.#store.getGroupActivation(event.conversation.id) ?? this.#defaultActivation)
      : "always";
    this.#store.recordParticipationCase({
      event,
      context: recent,
      activation,
      decision: { respond: true, reason },
    });
    this.#trace({ type: "trigger.decided", eventId: event.id, respond: true, reason });
    if (this.#responseGate && !(await this.#responseGate(event, reason))) {
      const gateReason = "shared-reply-arbitrated";
      this.#store.completeParticipationCase(event.id, "ignored");
      this.#trace({ type: "trigger.decided", eventId: event.id, respond: false, reason: gateReason });
      return this.#store.completeWithoutReply(event.id, gateReason);
    }
    if (!this.#store.claimProcessing(event.id, reason)) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) return completed;
      throw new Error(`Event ${event.id} is already being processed`);
    }
    return this.#runAgent(event, activation, recent, reason, {}, prompt);
  }

  async #handleIgnored(event: InboundMessageEvent, reason: string): Promise<HandleResult> {
    const ingested = this.#store.ingest(event);
    if (!ingested.inserted) {
      const completed = this.#store.getOutcome(event.id, true);
      if (completed) {
        this.#trace({ type: "inbound.replayed", eventId: event.id, conversationId: event.conversation.id });
        return completed;
      }
    } else {
      this.#trace({ type: "inbound.stored", eventId: event.id, conversationId: event.conversation.id });
    }
    this.#sharedConversationState?.prepareInbound(event);
    this.#trace({ type: "trigger.decided", eventId: event.id, respond: false, reason });
    return this.#store.completeWithoutReply(event.id, reason);
  }

  async #handleProactive(request: ProactiveParticipationRequest): Promise<HandleResult> {
    const triggerMessages = this.#recent(request.conversationId);
    const prepared = this.#store.beginProactiveEvent(request, this.#bot.id, triggerMessages);
    if (!prepared.inserted) {
      const completed = this.#store.getOutcome(request.id, true);
      if (completed) return completed;
    }
    const reason = `proactive-${request.kind}`;
    if (!this.#store.claimProcessing(request.id, reason)) {
      const completed = this.#store.getOutcome(request.id, true);
      if (completed) return completed;
      throw new Error(`Proactive event ${request.id} is already being processed`);
    }
    return this.#runAgent(prepared.event, "always", triggerMessages, reason, {});
  }

  async #findRelevantMemories(
    event: InboundMessageEvent,
    store: SqliteStore,
    conversationId: string,
    personId: string,
    query: string,
    limit: number,
  ): Promise<MemoryRecord[]> {
    const lexicalLimit = Math.max(limit * 4, 48);
    const lexical = store.findRelevantMemories(conversationId, personId, query, lexicalLimit);
    if (limit === 0 || !this.#memoryEmbeddingProvider) return lexical.slice(0, limit);

    const candidates = store.listMemoriesForEmbedding(conversationId, personId, 500);
    if (candidates.length === 0) return lexical.slice(0, limit);
    // With few enough memories every candidate ships anyway; semantic reranking
    // would only reorder them at the cost of one embedding call per turn.
    if (candidates.length <= limit) {
      return [...candidates].sort((left, right) => right.importance - left.importance);
    }
    try {
      const provider = this.#memoryEmbeddingProvider;
      const queryVector = await this.#embedQuery(provider, query.slice(0, 8_000));
      if (!queryVector || queryVector.length === 0) throw new Error("embedding provider returned no query vector");

      const missing = candidates.filter((memory) => !store.getMemoryEmbedding(memory.id, provider.model));
      if (missing.length > 0) {
        const vectors = await provider.embed(
          missing.map((memory) => memory.content.slice(0, 8_000)),
          "retrieval_document",
        );
        if (vectors.length !== missing.length) throw new Error("embedding provider returned an incomplete document batch");
        for (let index = 0; index < missing.length; index += 1) {
          store.saveMemoryEmbedding(missing[index]!.id, provider.model, vectors[index]!);
        }
      }

      const lexicalRanks = new Map(lexical.map((memory, index) => [memory.id, index]));
      return candidates
        .map((memory) => {
          const vector = store.getMemoryEmbedding(memory.id, provider.model);
          const semantic = vector ? normalizedCosine(queryVector, vector) : 0;
          const lexicalIndex = lexicalRanks.get(memory.id);
          const lexicalScore = lexicalIndex === undefined ? 0 : 1 - lexicalIndex / Math.max(1, lexical.length);
          return {
            memory,
            score: semantic * 0.65 + lexicalScore * 0.30 + memory.importance * 0.05,
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((item) => item.memory);
    } catch (error) {
      this.#trace({
        type: "memory.embedding.failed",
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return lexical.slice(0, limit);
    }
  }

  async #embedQuery(provider: MemoryEmbeddingProvider, query: string): Promise<number[] | undefined> {
    const key = `${provider.model}\u0000${query.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase()}`;
    const cached = this.#queryEmbeddingCache.get(key);
    if (cached) {
      // Refresh LRU position.
      this.#queryEmbeddingCache.delete(key);
      this.#queryEmbeddingCache.set(key, cached);
      return cached;
    }
    const [vector] = await provider.embed([query], "retrieval_query");
    if (vector && vector.length > 0) {
      this.#queryEmbeddingCache.set(key, vector);
      if (this.#queryEmbeddingCache.size > 200) {
        const oldest = this.#queryEmbeddingCache.keys().next().value;
        if (oldest !== undefined) this.#queryEmbeddingCache.delete(oldest);
      }
    }
    return vector;
  }

  async #runAgent(
    event: InboundMessageEvent,
    activation: GroupActivation,
    triggerMessages: StoredMessage[],
    triggerReason: string,
    context: AgentReceiveContext,
    pluginInstruction?: string,
  ): Promise<HandleResult> {
    const activeBot = this.#botFor(event);
    // Digest-style scheduled turns already carry their full source material in
    // the event text; recent history and memory recall would only duplicate it.
    const digestTurn = event.metadata?.proactiveKind === "morning-brief" ||
      event.metadata?.proactiveKind === "group-summary";
    const fastTurn = this.#fastTurnResolver?.(event) === true;
    const contextMessages = digestTurn
      ? []
      : event.conversation.kind === "group"
        ? selectGroupTurnContext(triggerMessages, event, this.#continuationWindowMs)
        : triggerMessages;
    const recentMessages = fitRecentMessages(
      contextMessages,
      fastTurn
        ? Math.min(this.#maxHistoryChars, event.conversation.kind === "group" ? 2_400 : 3_000)
        : event.conversation.kind === "group" ? Math.min(this.#maxHistoryChars, 6_000) : this.#maxHistoryChars,
    );
    const startedAt = Date.now();
    const contextReset = this.conversationContextReset(event.conversation.id);
    const { sessionId, sessionScope, contextEpoch } = createChatSessionDescriptor({
      conversationKind: event.conversation.kind,
      conversationId: event.conversation.id,
      sessionNamespace: this.#sessionNamespace,
      sessionScope: this.#sessionKeyResolver?.(event) ?? "default",
      ...(contextReset ? { contextReset } : {}),
    });
    this.#store.markParticipationModelUsed(event.id);
    this.#trace({
      type: "agent.started",
      eventId: event.id,
      conversationId: event.conversation.id,
      sessionId,
      sessionScope,
      contextEpoch,
    });
    try {
      const stateEvent = event.conversation.kind === "group" && this.#sharedConversationState
        ? this.#sharedConversationState.mapEvent(event)
        : event;
      const stateStore = event.conversation.kind === "group" && this.#sharedConversationState
        ? this.#sharedConversationState.store
        : this.#store;
      const memoryQuery = buildMemoryRetrievalQuery(event, recentMessages);
      const memories = digestTurn ? [] : await this.#findRelevantMemories(
        event,
        stateStore,
        stateEvent.conversation.id,
        stateEvent.sender.id,
        memoryQuery,
        fastTurn ? Math.min(this.#memoryLimit, 4) : this.#memoryLimit,
      );
      const members = stateStore.listMembers(stateEvent.conversation.id).map((member) => ({
        ...member,
        displayName: safeGroupDisplayName(member.displayName, member.id, member.isBot ? "机器人" : "群友"),
      }));
      const behaviors = stateStore.getBehaviorRules(
        stateEvent.conversation.id,
        stateEvent.sender.id,
        fastTurn ? Math.min(this.#behaviorLimit, 4) : this.#behaviorLimit,
      );
      const preverifiedKnowledge = fastTurn
        ? undefined
        : await this.#autoLookupKnowledge(stateEvent, recentMessages, triggerReason);
      const stagedParts: MessagePart[] = [];
      let tools = createCoreTools({
        store: stateStore,
        event: stateEvent,
        trace: (traceEvent) => this.#trace(traceEvent),
        canManageConversationBehavior: this.#operatorIds.has(event.sender.id),
        ...(this.#knowledgeRetriever ? { knowledgeRetriever: this.#knowledgeRetriever } : {}),
        maxKnowledgeChars: this.#maxKnowledgeChars,
      });
      if (requiresExplicitGroupReply(event, triggerReason)) {
        tools = tools.filter((tool) => tool.name !== "skip_reply");
      }
      const imageUnderstandingProvider =
        this.#imageUnderstandingProviderResolver?.(event) ?? this.#imageUnderstandingProvider;
      if (imageUnderstandingProvider && context.mediaResolver) {
        const availableImages = collectAvailableImages(
          this.#store,
          event,
          triggerMessages,
          this.#imageContextMessageLimit,
          this.#imageContextWindowMs,
          this.#maxAvailableImagesPerTurn,
        );
        const imageTool = createImageUnderstandingTool({
          event,
          images: availableImages,
          mediaResolver: context.mediaResolver,
          provider: imageUnderstandingProvider,
          trace: (traceEvent) => this.#trace(traceEvent),
          maxCalls: this.#maxImageUnderstandingCalls,
          maxImageBytes: this.#maxImageBytes,
          maxEvidenceChars: this.#maxImageEvidenceChars,
          timeoutMs: this.#imageUnderstandingTimeoutMs,
          cache: this.#store,
        });
        if (imageTool) tools.push(imageTool);
      }
      const imageUnderstandingAvailable = tools.some((tool) => tool.name === "understand_image");
      if (context.mediaResolver) {
        const attachmentParts = attachmentPartsForEvent(this.#store, event);
        const attachmentEvent = attachmentParts.length > 0 ? { ...event, parts: attachmentParts } : event;
        const attachmentTool = createAttachmentInspectionTool({ event: attachmentEvent, mediaResolver: context.mediaResolver });
        if (attachmentTool) tools.push(attachmentTool);
      }
      appendProvidedTools(tools, this.#toolProviders, event, this.#store, (part) => {
        if (stagedParts.length >= 20) throw new Error("A turn cannot stage more than 20 outbound message parts");
        validateMessageParts([part]);
        stagedParts.push(part);
      }, context, fastTurn);
      if (fastTurn) {
        const fastToolNames = new Set(["memory", "behavior", "recall_history", "synthesize_speech"]);
        if (event.conversation.kind === "group" && !requiresExplicitGroupReply(event, triggerReason)) {
          fastToolNames.add("skip_reply");
        }
        tools = tools.filter((tool) => fastToolNames.has(tool.name));
      }
      if (event.metadata?.proactiveKind !== undefined) {
        // Scheduled/plugin participation is text-only unless a future request
        // type explicitly models an approved output modality. Tool prose is not
        // a security boundary: remove TTS before the model can call it.
        tools = tools.filter((tool) => tool.name !== "synthesize_speech");
      }
      if (digestTurn) {
        // Digest output is plain text; the emoji catalog would only add prompt weight.
        tools = tools.filter((tool) => tool.name !== "send_emoji" && tool.name !== "search_emojis");
      }
      const voiceReplyMode = preferredVoiceReplyMode(
        event,
        triggerReason,
        tools.some((tool) => tool.name === "synthesize_speech"),
        this.#voiceModeResolver?.(event) ?? "text",
      );
      const semanticEmojiBattle = triggerReason === "ambient-emoji-battle" &&
        typeof event.metadata?.emojiBattleDescription === "string" &&
        event.metadata.emojiBattleDescription.trim().length > 0;
      if (triggerReason === "ambient-emoji-battle") {
        tools = tools.filter((tool) => tool.name === "send_emoji" || tool.name === "search_emojis");
      }
      const runner = semanticEmojiBattle && this.#emojiBattleRunner
        ? this.#emojiBattleRunner
        : this.#runnerResolver?.(event) ?? this.#runner;
      const turnPrompt = buildTurnPrompt({
        event,
        activation,
        recentMessages,
        memories,
        behaviors,
        members,
        triggerReason,
        knowledgeAvailable: this.#knowledgeRetriever !== undefined,
        ...(preverifiedKnowledge ? { preverifiedKnowledge } : {}),
        emojiAvailable: tools.some((tool) => tool.name === "send_emoji"),
        imageSendingAvailable: tools.some((tool) => tool.name === "generate_image" || tool.name === "download_image"),
        imageUnderstandingAvailable,
        recentReplyStyle: recentReplyStyleFingerprint(recentMessages),
        ...(voiceReplyMode ? { voiceReplyMode } : {}),
      });
      const emojiTool = tools.find((tool) => tool.name === "send_emoji");
      const emojiRecommendation = emojiTool ? emojiToolRecommendation(emojiTool) : undefined;
      let toolCallFeedbackSent = false;
      const onToolCallStart = this.#toolCallFeedback
        ? ({ toolName, args, modelText }: AgentToolCallStart) => {
            if (toolCallFeedbackSent || !isLongRunningAgentTool(toolName)) return;
            toolCallFeedbackSent = true;
            this.#toolCallFeedback?.({
              event,
              triggerReason,
              toolName,
              args,
              ...(modelText ? { modelText } : {}),
            });
          }
        : undefined;
      const result: AgentRunResult = triggerReason === "ambient-emoji-battle" && !semanticEmojiBattle
        ? { text: "" }
        : await runner.run({
            systemPrompt: buildSystemPrompt(activeBot, this.#soulResolver?.(event) ?? this.#baseSoul),
            prompt: pluginInstruction
              ? `${turnPrompt}\n\n<trusted_plugin_instruction>\n${pluginInstruction}\n</trusted_plugin_instruction>`
              : turnPrompt,
            sessionId,
            tools,
            budget: {
              maxLlmCalls: this.#maxAgentLlmCalls,
              maxToolCalls: this.#maxAgentToolCalls,
              timeoutMs: this.#agentTimeoutMs,
            },
            ...(onToolCallStart ? { onToolCallStart } : {}),
          });
      let guarded = guardAgentText(result.text, event.text);
      if (guarded.blocked) {
        this.#trace({ type: "agent.output_blocked", eventId: event.id, reason: guarded.reason ?? "internal-deliberation" });
      }
      // An explicitly addressed turn must not go silent because the output
      // guard tripped: retry once, text-only, with a corrective instruction.
      if (guarded.blocked && guarded.reason !== "upstream-error" && requiresExplicitGroupReply(event, triggerReason)) {
        const retried = await runner.run({
          systemPrompt: buildSystemPrompt(activeBot, this.#soulResolver?.(event) ?? this.#baseSoul),
          prompt: `${turnPrompt}\n\n<output_correction>你上一次的输出因为混入了内部分析、元话语或工具说明而被拦截，没有发出去。当前群友在等待回应。现在只输出要直接发到聊天里的最终自然回复（一两句即可），不要任何标题、前缀、分析过程或对规则的引用。</output_correction>`,
          sessionId,
          tools: [],
          budget: { maxLlmCalls: 1, maxToolCalls: 0, timeoutMs: Math.min(this.#agentTimeoutMs, 30_000) },
        }).catch((error) => {
          this.#trace({
            type: "agent.failed",
            eventId: event.id,
            error: `guard-retry: ${error instanceof Error ? error.message : String(error)}`,
          });
          return undefined;
        });
        if (retried) {
          guarded = guardAgentText(retried.text, event.text);
          if (guarded.blocked) {
            this.#trace({ type: "agent.output_blocked", eventId: event.id, reason: guarded.reason ?? "internal-deliberation" });
          }
        }
      }
      let replyText = triggerReason === "ambient-emoji-battle" ? null : guarded.text;
      let suppliedParts = [...stagedParts, ...(result.parts ?? [])];
      if (
        !guarded.blocked &&
        !voiceReplyMode &&
        replyText &&
        suppliedParts.length === 0 &&
        emojiTool &&
        emojiRecommendation?.autoAllowed &&
        shouldReplaceShortReactionWithEmoji(replyText)
      ) {
        await emojiTool.execute(`emoji-policy:${event.id}`, { emojiId: emojiRecommendation.emojiId });
        suppliedParts = [...stagedParts, ...(result.parts ?? [])];
        replyText = null;
      }
      if (!guarded.blocked && voiceReplyMode && replyText && !hasOutboundVoice(suppliedParts)) {
        const speechText = cleanReply(replyText, Math.min(this.#maxReplyChars, 8_000));
        const speechTool = tools.find((tool) => tool.name === "synthesize_speech");
        if (speechText && speechTool) {
          await speechTool.execute(`voice-policy:${event.id}`, {
            text: speechText,
            ...(voiceReplyMode === "whisper" ? { style: WHISPER_TTS_STYLE } : {}),
          });
          suppliedParts = [...stagedParts, ...(result.parts ?? [])];
        }
      }
      if (voiceReplyMode && hasOutboundVoice(suppliedParts)) replyText = null;
      const reply = sanitizeReplyIdentities(
        cleanAgentReply(replyText, suppliedParts, this.#maxReplyChars),
        members,
      );
      this.#store.completeParticipationCase(
        event.id,
        guarded.blocked ? "blocked" : reply === null ? "silent" : "replied",
        reply?.text,
      );
      this.#trace({
        type: "agent.finished",
        eventId: event.id,
        replied: reply !== null,
        durationMs: Date.now() - startedAt,
        ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      });
      if (reply === null) return this.#store.completeWithoutReply(event.id, "agent-silent");
      const outboundParts = decorateReplyParts(
        event,
        [activeBot.id, ...(this.#identityAliasesResolver?.(event) ?? [])],
        triggerReason,
        reply.parts,
      );
      return this.#completeWithReply(
        event,
        reply.text,
        outboundParts,
        triggerReason,
        activeBot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.completeParticipationCase(event.id, "failed");
      this.#store.markFailed(event.id, message);
      this.#trace({ type: "agent.failed", eventId: event.id, error: message });
      if (this.#responseGateRelease) {
        try {
          await this.#responseGateRelease(event, triggerReason);
        } catch (releaseError) {
          this.#trace({
            type: "agent.failed",
            eventId: event.id,
            error: `response-gate-release: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          });
        }
      }
      throw error;
    }
  }

  #completeWithReply(
    event: InboundMessageEvent,
    text: string,
    parts: MessagePart[],
    reason: string,
    activeBot = this.#botFor(event),
  ): HandleResult {
    const result = this.#store.completeWithReply(
      event,
      activeBot.id,
      activeBot.displayName,
      text,
      parts,
      reason,
    );
    const action = result.actions[0];
    if (action) {
      const historyText = text || renderMessageParts(parts, true).join("\n");
      this.#sharedConversationState?.appendOutbound(
        event,
        activeBot,
        action.id,
        historyText,
        action.createdAt,
      );
    }
    return result;
  }

  #applyParticipationGuidance(
    event: InboundMessageEvent,
    activation: GroupActivation,
    decision: { respond: boolean; reason: string },
  ): { respond: boolean; reason: string } {
    if (event.conversation.kind !== "group" || activation !== "always") return decision;
    const guidance = this.#store.participationGuidance(event.conversation.id, event.text);
    if (!guidance) return decision;
    const suffix = `${guidance.evidence}:${guidance.confidence.toFixed(2)}`;
    if (guidance.label === "silent" && (decision.reason === "ambient-question" || decision.reason === "ambient-hot-chat")) {
      return { respond: false, reason: `learned-silent:${suffix}` };
    }
    if (
      guidance.label === "speak" &&
      decision.reason === "ambient-no-signal" &&
      guidance.confidence >= PARTICIPATION_INTENSITY[this.#participationIntensity(event)].threshold
    ) {
      return { respond: true, reason: `learned-speak:${suffix}` };
    }
    return decision;
  }

  #learnImplicitParticipationFeedback(event: InboundMessageEvent): void {
    if (event.conversation.kind !== "group") return;
    const bot = this.#botFor(event);
    const feedback = classifyParticipationFeedback(event, bot);
    const quality = classifyReplyQualityFeedback(event, bot);
    if (!feedback && !quality) return;
    const target = this.#store.participationFeedbackTarget(
      event.conversation.id,
      event.replyTo?.messageId,
      (event.timestamp ?? Date.now()) - 10 * 60_000,
    );
    if (!target) return;
    if (feedback) {
      this.#store.recordParticipationFeedback({
        eventId: target,
        label: feedback.label,
        reason: feedback.reason,
        sourceEventId: event.id,
      });
    }
    if (quality) {
      this.#store.recordReplyQualityFeedback({
        eventId: target,
        label: quality.label,
        reason: quality.reason,
        sourceEventId: event.id,
      });
    }
  }

  async #autoLookupKnowledge(
    event: InboundMessageEvent,
    recentMessages: StoredMessage[],
    triggerReason: string,
  ): Promise<string | undefined> {
    if (!this.#knowledgeRetriever || event.metadata?.proactiveKind) return undefined;
    const query = automaticKnowledgeQuery(event, recentMessages, triggerReason);
    if (!query) return undefined;
    const startedAt = Date.now();
    this.#trace({ type: "knowledge.lookup.started", eventId: event.id, query, automatic: true });
    try {
      const items = await this.#knowledgeRetriever.search({
        query,
        conversationId: event.conversation.id,
        senderId: event.sender.id,
        limit: 5,
      });
      this.#trace({
        type: "knowledge.lookup.finished",
        eventId: event.id,
        count: items.length,
        durationMs: Date.now() - startedAt,
        automatic: true,
      });
      if (items.length === 0) return "自动查证未找到结果；不要仅凭旧知识给出确定结论，可继续调用 lookup_knowledge 精确搜索。";
      const text = items.slice(0, 5).map((item, index) => {
        const source = item.source ? ` | 来源: ${item.source}` : "";
        const updated = item.updatedAt ? ` | 时间: ${formatBeijingTimestamp(item.updatedAt)}` : "";
        return `[${index + 1}] ${item.title}${source}${updated}\n${item.content}`;
      }).join("\n\n");
      return text.length <= this.#maxKnowledgeChars ? text : `${text.slice(0, this.#maxKnowledgeChars)}\n[证据已截断]`;
    } catch (error) {
      this.#trace({
        type: "knowledge.lookup.failed",
        eventId: event.id,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        automatic: true,
      });
      return "自动查证失败；不得假装已联网或凭旧知识给出确定结论，可尝试调用 lookup_knowledge，仍失败则说明不确定。";
    }
  }

  #trace(event: TraceEvent): void {
    try {
      this.#onTrace?.(event);
    } catch {
      // Observability must never break message handling.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("GroupAgentCore is closed");
  }
}

function collectAvailableImages(
  store: SqliteStore,
  event: InboundMessageEvent,
  recentMessages: StoredMessage[],
  messageLimit: number,
  windowMs: number,
  maxImages: number,
): ImageUnderstandingCandidate[] {
  const current = (event.parts ?? [])
    .filter((part): part is Extract<MessagePart, { type: "image" }> => part.type === "image")
    .slice(0, maxImages)
    .map((part, index) => ({
      part,
      messageId: event.id,
      senderId: event.sender.id,
      contextLabel: event.parts?.filter((candidate) => candidate.type === "image").length === 1
        ? "current_message 的图片"
        : `current_message 的第 ${index + 1} 张图片`,
    }));
  if (current.length >= maxImages) return current;

  const referenced = event.replyTo?.messageId
    ? inboundImagesForMessage(
        store,
        event.conversation.id,
        event.replyTo.messageId,
        event.replyTo.transportMessageId,
      ).map((image) => ({
        part: image.part,
        messageId: image.messageId,
        senderId: image.senderId,
        contextLabel: "引用消息中的图片",
      }))
    : [];
  if (current.length + referenced.length >= maxImages) {
    return [...referenced.slice(-(maxImages - current.length)), ...current];
  }
  const implicitRecentImage = current.length === 0 &&
    referenced.length === 0 &&
    referencesImplicitVisualContext(event.text) &&
    hasImmediateRecentImage(store, event, recentMessages, messageLimit, windowMs);
  if (current.length === 0 && referenced.length === 0 && !referencesVisualContext(event.text) && !implicitRecentImage) return [];
  if (messageLimit === 0 || windowMs === 0) return [...referenced, ...current];

  const recent = recentMessages.slice(-messageLimit);
  const previous: ImageUnderstandingCandidate[] = [];
  const currentTimestamp = event.timestamp ?? Date.now();
  for (const [index, message] of recent.entries()) {
    if (message.direction !== "inbound" || Math.abs(currentTimestamp - message.timestamp) > windowMs) continue;
    const messagesAgo = recent.length - index;
    for (const image of inboundImagesForMessage(
      store,
      event.conversation.id,
      message.sourceEventId ?? message.id,
      message.transportMessageId,
    )) {
      previous.push({
        part: image.part,
        messageId: image.messageId,
        senderId: image.senderId,
        contextLabel: `${messagesAgo} 条消息前的图片`,
      });
    }
  }
  const remaining = Math.min(1, maxImages - current.length - referenced.length);
  const seen = new Set(referenced.map((image) => image.messageId));
  const uniquePrevious = previous.filter((image) => !seen.has(image.messageId));
  return [...uniquePrevious.slice(-remaining), ...referenced, ...current];
}

function inboundImagesForMessage(
  store: SqliteStore,
  conversationId: string,
  sourceEventId: string,
  transportMessageId?: string,
): ReturnType<SqliteStore["getInboundImages"]> {
  const pending = [sourceEventId];
  if (transportMessageId) {
    const local = store.getInboundMessageByTransportMessageId(conversationId, transportMessageId);
    if (local?.id) pending.push(local.id);
  }
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < 4) {
    const eventId = pending.shift();
    if (!eventId || visited.has(eventId)) continue;
    visited.add(eventId);
    const message = store.getInboundMessage(eventId);
    if (!message || message.conversation.id !== conversationId) continue;
    const direct = store.getInboundImages(eventId);
    if (direct.length > 0) return direct;
    if (message.replyTo?.messageId) pending.push(message.replyTo.messageId);
    if (message.replyTo?.transportMessageId) {
      const quoted = store.getInboundMessageByTransportMessageId(
        conversationId,
        message.replyTo.transportMessageId,
      );
      if (quoted?.id) pending.push(quoted.id);
    }
    for (const part of message.parts ?? []) {
      if (part.type === "quote") pending.push(part.messageId);
    }
  }
  return [];
}

/**
 * A short text immediately following an image or a quote of an image is
 * commonly the actual image question (for example, "看看图片"). The text
 * does not have to carry the attachment itself, so keep the latest referenced
 * inbound image available for this narrow, bounded continuation case.
 */
function hasImmediateRecentImage(
  store: SqliteStore,
  event: InboundMessageEvent,
  recentMessages: StoredMessage[],
  messageLimit: number,
  windowMs: number,
): boolean {
  if (messageLimit === 0 || windowMs === 0) return false;
  const latestInbound = [...recentMessages].reverse().find((message) => message.direction === "inbound");
  if (!latestInbound) return false;
  const now = event.timestamp ?? Date.now();
  const age = now - latestInbound.timestamp;
  if (age < 0 || age > Math.min(windowMs, 5 * 60_000)) return false;
  return inboundImagesForMessage(
    store,
    event.conversation.id,
    latestInbound.sourceEventId ?? latestInbound.id,
    latestInbound.transportMessageId,
  ).length > 0;
}

function classifyParticipationFeedback(
  event: InboundMessageEvent,
  bot: BotIdentity,
): { label: "speak" | "silent"; reason: string } | undefined {
  const text = event.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const botIds = new Set([bot.id, ...(bot.aliasIds ?? [])].map(canonicalIdentityId));
  const addressed =
    (event.replyTo?.senderId ? botIds.has(canonicalIdentityId(event.replyTo.senderId)) : false) ||
    (event.mentions?.some((mention) => botIds.has(canonicalIdentityId(mention.id))) ?? false) ||
    [bot.displayName, ...(bot.wakeWords ?? [])].some((word) => word.trim() && text.toLocaleLowerCase().includes(word.trim().toLocaleLowerCase()));
  if (!addressed) return undefined;
  if (
    /(?:闭嘴|别(?:再|老是|总是)?(?:插话|接话|抢话|回复|回话|说话)|没(?:人|谁)?问你|谁问你(?:了)?|不需要你(?:回答|回复)?|少说(?:两句|话)?|不要每条都回|别刷屏)/u.test(text)
  ) {
    return { label: "silent", reason: "群友明确表示这次不应参与" };
  }
  if (
    /(?:说得对|正解|靠谱|有用|帮大忙|谢谢|多谢|好评|厉害|牛(?:逼|啊|哇)?|可以的|回答得好|就是这个)/u.test(text)
  ) {
    return { label: "speak", reason: "群友明确肯定这次参与" };
  }
  return undefined;
}

function classifyReplyQualityFeedback(
  event: InboundMessageEvent,
  bot: BotIdentity,
): { label: "helpful" | "unhelpful"; reason: string } | undefined {
  const text = event.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text || !isFeedbackAddressedToBot(event, bot, text)) return undefined;
  if (
    /(?:答错|说错|不对|不是这个|胡说|瞎说|编的|没用|没帮助|没看懂|看不懂|太长|太啰嗦|又重复|重复了|文不对题|答非所问|过时了|链接错|数据错)/u.test(text)
  ) {
    return { label: "unhelpful", reason: "群友明确指出回复质量问题" };
  }
  if (
    /(?:说得对|正解|靠谱|有用|帮大忙|解决了|谢谢|多谢|好评|厉害|回答得好|讲清楚了|就是这个|找到了|学到了)/u.test(text)
  ) {
    return { label: "helpful", reason: "群友明确肯定回复有帮助" };
  }
  return undefined;
}

function isFeedbackAddressedToBot(event: InboundMessageEvent, bot: BotIdentity, text: string): boolean {
  const botIds = new Set([bot.id, ...(bot.aliasIds ?? [])].map(canonicalIdentityId));
  return (
    (event.replyTo?.senderId ? botIds.has(canonicalIdentityId(event.replyTo.senderId)) : false) ||
    (event.mentions?.some((mention) => botIds.has(canonicalIdentityId(mention.id))) ?? false) ||
    [bot.displayName, ...(bot.wakeWords ?? [])].some((word) =>
      word.trim() && text.toLocaleLowerCase().includes(word.trim().toLocaleLowerCase()))
  );
}

function canonicalIdentityId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function cleanReply(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  const text = toChatPlainText(value.replace(/^NO_REPLY$/i, ""));
  if (!text) return null;
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export function shouldReplaceShortReactionWithEmoji(value: string): boolean {
  const normalized = toChatPlainText(value).replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > 18) return false;
  if (/[?？:：]/u.test(normalized)) return false;
  return /(?:哈哈|笑死|笑不活|绷不住|确实|没错|收到|好嘞|可以|无语|离谱|逆天|服了|牛(?:逼|啊|哇)?|厉害|绝了|太棒|恭喜|抱抱|晚安|早安|可爱|爱了|666)/iu.test(normalized);
}

function guardAgentText(
  value: string | null,
  sourceText: string,
): { text: string | null; blocked: boolean; reason?: "internal-deliberation" | "source-echo" | "upstream-error" } {
  if (value === null) return { text: null, blocked: false };
  const withoutClosedReasoning = value
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/giu, "")
    .trim();
  if (!withoutClosedReasoning) return { text: null, blocked: false };
  let candidate = withoutClosedReasoning;
  if (
    /^\s*\[(?:proxysystem|provider|upstream)\s+error\]/iu.test(candidate) ||
    /request blocked due to safety settings|finish reason\s*:\s*(?:prohibited_content|safety|blocklist|recitation)/iu.test(candidate)
  ) {
    return { text: null, blocked: true, reason: "upstream-error" };
  }
  const explicitFinal = extractExplicitFinalSection(candidate);
  if (explicitFinal !== undefined) {
    if (!explicitFinal) return { text: null, blocked: true };
    candidate = explicitFinal;
  }
  const source = sourceText.trim();
  if (source && normalizeEchoText(candidate) === normalizeEchoText(source)) {
    return { text: null, blocked: true, reason: "source-echo" };
  }
  if (source && candidate.startsWith(source) && candidate.length > source.length) {
    candidate = candidate.slice(source.length).replace(/^\s*(?:---+)?\s*/u, "").trim();
  }
  const markers = [
    /<(?:think|analysis)\b|<\/(?:think|analysis)>/iu,
    /<(?:tool_uses?|tool_calls?|function_calls?)\b|<\/(?:tool_uses?|tool_calls?|function_calls?)>/iu,
    /<\/?trusted_plugin_instruction>/iu,
    /<!--[\s\S]*?(?:分析|思考|工具|调用|回复)[\s\S]*?-->/iu,
    /(?:调用|使用)\s*`?skip_reply|skip_reply\s*工具/iu,
    /根据规则\s*[:：]\s*\n\s*\d+[.、]/u,
    /(?:^|\n)\s*直接(?:自然)?回答\s*[:：]/u,
    /根据(?:群聊|系统|上述).{0,24}(?:规则|指令)/u,
    /(?:这条|当前)消息.{0,180}(?:没有明确|不需要我|是在|是对)/su,
    /我作为(?:群成员|被吐槽对象)|我会用.{0,48}(?:回复|回应)/su,
    /没有(?:明确的)?问题需要我回答/u,
    /(?:^|\n)\s*回复\s*[:：]/u,
    /<chat_context>|<current_message>|current_message/iu,
    /(?:^|\n)\s*(?:analysis|reasoning)\s*[:：]/iu,
    /(?:^|\n)\s*#{1,6}\s*(?:分析|思考(?:过程)?|场景判断|回复策略|最终回复|回复)\s*$/mu,
    /(?:^|\n)\s*(?:场景判断|回复策略)\s*[:：]/mu,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{1,2})?(?:思考过程|场景判断|回复策略|最终回复)(?:\*{1,2})?\s*[:：]?\s*(?:\n|$)/mu,
    /(?:记忆|行为|知识查询|图片理解)\s*工具/u,
    /\b(?:recall_history|lookup_knowledge|understand_image|generate_image|synthesize_speech|skip_reply)\b/iu,
    /(?:调用|使用)\s*`?\b(?:memory|behavior)\b|\b(?:memory|behavior)\b\s*(?:工具|\()/iu,
    /(?:无需|不需要|不必|需要|准备|将要|我会).{0,24}(?:调用|使用).{0,16}(?:工具|函数)/su,
    /系统(?:提示|指令|规则)|内部(?:分析|判断|规则)|输出策略/u,
    /(?:这个|当前).{0,12}(?:@|点名|提问).{0,80}(?:直接|回复|回答|自我介绍)/su,
    /(?:当前|相关)?记忆.{0,80}(?:无需|不需要|没有).{0,40}(?:修正|修改|保存|处理)/su,
    /直接给(?:一个|出|他|她)?.{0,60}(?:回复|回答|自我介绍).{0,24}(?:就好|即可)/su,
    /保持(?:群聊|私聊|聊天)(?:的)?(?:氛围|语气|风格)/u,
    /\bI (?:should|will|need to) (?:respond|reply|call|stay silent)\b/iu,
  ];
  if (markers.some((pattern) => pattern.test(candidate))) {
    return { text: null, blocked: true, reason: "internal-deliberation" };
  }
  return { text: candidate, blocked: false };
}

function normalizeEchoText(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase();
}

function extractExplicitFinalSection(value: string): string | null | undefined {
  const lines = value.split(/\r?\n/u);
  const marker = /^\s*(?:#{1,6}\s*)?(?:\*{1,2})?(?:最终回复|回复|直接(?:自然)?回答)\s*[:：]?(?:\*{1,2})?\s*$/u;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!marker.test(lines[index] ?? "")) continue;
    const finalText = lines
      .slice(index + 1)
      .join("\n")
      .replace(/^\s*(?:(?:-{3,}|_{3,}|\*{3,})\s*)+/u, "")
      .trim();
    return finalText || null;
  }
  return undefined;
}

function cleanAgentReply(
  value: string | null,
  suppliedParts: MessagePart[] | undefined,
  maxChars: number,
): { text: string; parts: MessagePart[] } | null {
  const text = cleanReply(value, maxChars);
  const parts = (suppliedParts ?? []).map((part) =>
    part.type === "text" ? { ...part, text: cleanReply(part.text, maxChars) ?? "" } : part,
  );
  const nonEmptyParts = parts.filter((part) => part.type !== "text" || part.text.length > 0);
  validateMessageParts(nonEmptyParts);
  if (text && !nonEmptyParts.some((part) => part.type === "text")) nonEmptyParts.unshift(textPart(text));
  if (nonEmptyParts.length === 0) return null;
  return { text: text ?? renderMessageParts(nonEmptyParts, true).join("\n"), parts: nonEmptyParts };
}

function requiresExplicitGroupReply(event: InboundMessageEvent, triggerReason: string): boolean {
  return event.conversation.kind === "group" &&
    (triggerReason === "mention" || triggerReason === "wake-word" || triggerReason === "reply-to-bot");
}

function sanitizeReplyIdentities(
  reply: { text: string; parts: MessagePart[] } | null,
  members: ReadonlyArray<{ id: string; displayName: string }>,
): { text: string; parts: MessagePart[] } | null {
  if (!reply) return null;
  return {
    text: replaceTransportIds(reply.text, members),
    parts: reply.parts.map((part) => part.type === "text"
      ? { ...part, text: replaceTransportIds(part.text, members) }
      : part),
  };
}

function decorateReplyParts(
  event: InboundMessageEvent,
  botIds: readonly string[],
  triggerReason: string,
  parts: MessagePart[],
): MessagePart[] {
  if (event.conversation.kind !== "group") return parts;
  const decorated = [...parts];
  const identities = new Set(botIds.map(canonicalIdentityId));
  const explicitlyMentioned = (event.mentions ?? []).some((mention) =>
    identities.has(canonicalIdentityId(mention.id)));
  if (shouldQuoteInbound(triggerReason)) {
    decorated.unshift({
      type: "quote",
      messageId: event.id,
      senderId: event.sender.id,
      senderName: event.sender.displayName,
      excerpt: [...event.text.normalize("NFKC").replace(/\s+/gu, " ").trim()].slice(0, 60).join(""),
    });
  }
  if (explicitlyMentioned) {
    decorated.unshift({ type: "mention", memberId: event.sender.id, displayName: event.sender.displayName });
  }
  validateMessageParts(decorated);
  return decorated;
}

function shouldQuoteInbound(triggerReason: string): boolean {
  if (triggerReason.startsWith("proactive-")) return false;
  if (triggerReason === "ambient-hot-chat" || triggerReason === "ambient-voice" || triggerReason.startsWith("learned-speak:")) return false;
  return true;
}

function isAutomaticParticipationReason(triggerReason: string): boolean {
  return triggerReason === "ambient-question" ||
    triggerReason === "ambient-hot-chat" ||
    triggerReason === "ambient-voice" ||
    triggerReason === "ambient-voice-request" ||
    triggerReason === "ambient-name-mention" ||
    triggerReason === "continuation" ||
    triggerReason.startsWith("conversation-followup:") ||
    triggerReason.startsWith("learned-speak:");
}

function hasOutboundVoice(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => part.type === "voice" || part.type === "audio");
}

function automaticKnowledgeQuery(
  event: InboundMessageEvent,
  recentMessages: StoredMessage[],
  triggerReason: string,
): string | undefined {
  const current = event.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (current && shouldAutoLookupKnowledge(current)) return [...current].slice(0, 500).join("");
  if (!isAutomaticParticipationReason(triggerReason) || triggerReason === "ambient-voice") return undefined;
  const context = [...recentMessages.slice(-5).map((message) => message.text), current]
    .map((text) => text.normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("；");
  if (!context) return undefined;
  const boundedContext = [...context].slice(-1_800).join("");
  if (!shouldAutoLookupKnowledge(boundedContext)) return undefined;
  return [...boundedContext].slice(-500).join("");
}

function fitRecentMessages(messages: StoredMessage[], maxChars: number): StoredMessage[] {
  const selected: StoredMessage[] = [];
  let remaining = maxChars;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const metadataAllowance = 120;
    if (remaining <= metadataAllowance) break;
    const text = clipText(message.text, remaining - metadataAllowance);
    selected.push(text === message.text ? message : { ...message, text });
    remaining -= [...text].length + metadataAllowance;
  }
  return selected.reverse();
}

/**
 * Group questions often use short anaphora such as "他之前说什么" or "那个
 * 人叫什么". Include a small amount of recent inbound context so the local
 * memory index and semantic index can resolve the entity the user omitted from
 * the current sentence.
 */
function buildMemoryRetrievalQuery(event: InboundMessageEvent, recentMessages: StoredMessage[]): string {
  const values = [
    event.text,
    ...recentMessages
      .filter((message) => message.direction === "inbound")
      .slice(-8)
      .map((message) => message.text.slice(0, 500)),
  ]
    .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  return values.join("；").slice(0, 4_000);
}

function recentReplyStyleFingerprint(messages: StoredMessage[]): string {
  const replies = messages.filter((message) => message.direction === "outbound").slice(-5);
  if (replies.length === 0) return "近期没有机器人回复样本。";
  const openers = replies.map((message) => message.text.normalize("NFKC").trim().slice(0, 12)).filter(Boolean);
  const averageLength = Math.round(replies.reduce((sum, message) => sum + [...message.text].length, 0) / replies.length);
  const questions = replies.filter((message) => /[？?]\s*$/u.test(message.text)).length;
  return [
    `最近 ${replies.length} 条回复的平均长度约 ${averageLength} 字，${questions} 条以问句收尾。`,
    `近期起句：${openers.map((value) => `“${value}”`).join("、")}。`,
    "本轮不要逐字重复近期回复，也不要机械复用相同起句、结尾反问或固定段落结构；内容确实相同也要针对当前消息直接表达。",
  ].join(" ");
}

/** Selects the likely local sub-thread while retaining a small amount of ambient context. */
function selectGroupTurnContext(
  messages: StoredMessage[],
  event: InboundMessageEvent,
  continuationWindowMs: number,
): StoredMessage[] {
  const now = event.timestamp ?? Date.now();
  // Adapt the context window to the room's pace: in a slow room the span of
  // the last 15 messages keeps older-but-live topics visible, while a busy
  // room naturally tightens back towards the 3-minute floor.
  const paceSample = messages.slice(-15);
  const paceSpanMs = paceSample.length >= 2 ? now - paceSample[0]!.timestamp : 0;
  const windowMs = Math.min(Math.max(Math.min(continuationWindowMs, 3 * 60_000), paceSpanMs), 30 * 60_000);
  const cutoff = now - windowMs;
  const recent = messages
    .filter((message) => message.timestamp >= cutoff && message.timestamp <= now)
    .slice(-20);
  const referenced = event.replyTo?.messageId
    ? messages.find((message) =>
        message.id === event.replyTo?.messageId || message.sourceEventId === event.replyTo?.messageId)
    : undefined;
  const followup = event.replyTo !== undefined || /(?:刚才|继续|接着|重新|再说|上面|前面|那个|这个|这张|图片|图里|下图|好好说|详细分析)/u.test(event.text);
  const selected = new Map<number, StoredMessage>();
  const add = (message: StoredMessage | undefined): void => {
    if (message) selected.set(message.sequence, message);
  };

  // Always preserve the immediate room atmosphere; when the adaptive window is
  // sparse, fall back to the latest messages but never resurface anything
  // older than the 30-minute ceiling.
  const baseline = recent.length >= 5
    ? recent.slice(-5)
    : messages.filter((message) => message.timestamp >= now - 30 * 60_000 && message.timestamp <= now).slice(-5);
  baseline.forEach(add);
  let chain = referenced;
  for (let depth = 0; chain && depth < 4; depth += 1) {
    add(chain);
    const parentId: string | undefined = chain.replyToMessageId;
    chain = parentId
      ? messages.find((message) => message.id === parentId || message.sourceEventId === parentId)
      : undefined;
  }

  const currentTerms = new Set(extractSearchTerms(event.text).slice(0, 24));
  const ranked = recent
    .filter((message) => !selected.has(message.sequence))
    .map((message, index) => {
      const overlap = extractSearchTerms(message.text).reduce(
        (count, term) => count + (currentTerms.has(term) ? 1 : 0),
        0,
      );
      const sameSender = message.senderId === event.sender.id ? 2.5 : 0;
      const botTurn = message.direction === "outbound" ? 1 : 0;
      const recency = (index + 1) / Math.max(1, recent.length);
      return { message, score: overlap * 2.5 + sameSender + botTurn + recency + (followup ? 0.5 : 0) };
    })
    .sort((left, right) => right.score - left.score || right.message.sequence - left.message.sequence);
  for (const candidate of ranked) {
    if (selected.size >= (followup ? 10 : 8)) break;
    if (candidate.score < 1.25 && selected.size >= 6) break;
    add(candidate.message);
  }
  return [...selected.values()].sort((left, right) => left.sequence - right.sequence);
}

function referencesVisualContext(value: string): boolean {
  return /(?:图片|图里|图中|这图|那图|这张|截图|照片|画面|看图|下图|上图|配图|表情包|视觉|识图)/u.test(
    value.normalize("NFKC"),
  );
}

function referencesImplicitVisualContext(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return /(?:分析|判断|评价|描述|识别|看看|说说|这个|那个|它)/u.test(normalized) ||
    /(?:我在|我正在|你在|他在|她在|做什么|干什么|干嘛|在干嘛)/u.test(normalized);
}

function recentConversationThread(
  messages: StoredMessage[],
  botId: string,
  now: number,
  windowMs: number,
): StoredMessage[] | undefined {
  if (windowMs <= 0) return undefined;
  let botIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction === "outbound" && message.senderId === botId) {
      botIndex = index;
      break;
    }
  }
  if (botIndex < 0) return undefined;
  const botMessage = messages[botIndex]!;
  if (now < botMessage.timestamp || now - botMessage.timestamp > windowMs) return undefined;
  const messagesAfterBot = messages.length - botIndex - 1;
  if (messagesAfterBot > 12) return undefined;
  return messages.slice(Math.max(0, botIndex - 6));
}

function participationJudgeSystemPrompt(intensity: ParticipationIntensity): string {
  const policy = intensity === "conservative"
    ? "当前为保守档：仅在明确追问、纠正机器人，或机器人有明显关键新信息时 speak；有一点不确定就 silent。"
    : intensity === "active"
      ? "当前为积极档：除了明确追问和纠正，自然延续机器人刚参与的话题、合适的轻松接梗、或能提供实际帮助时也可 speak；但不要打断群友之间的私聊，不要只做无信息量附和。"
      : "当前为标准档：追问、纠正机器人或机器人确实能补充有用新信息时 speak；不确定时 silent。";
  return `你是群聊接话门控分类器，不负责回答问题。${policy} 只有笑声、感谢、收到、纯附和，群友之间互相对话，明显话题转移，以及机器人只能重复或礼貌应和时选择 silent。confidence 表示分类正确性的把握，不表示接话意愿。

固定规则：speak 只能搭配 followup、correction 或 new_info；silent 只能搭配 ack_only、human_to_human、topic_shift、no_value 或 uncertain。不确定当前消息是不是在对机器人说时选择 silent/uncertain；不要因为关键词相似就认定同一话题，要结合说话人和语义关系。
参考：机器人回答后群友追问属于 followup；群友指出机器人信息有误属于 correction；群友只说“好的谢谢”属于 ack_only；群友改聊晚饭属于 topic_shift。只输出一行 JSON，不输出解释、Markdown、代码围栏或工具调用。`;
}

function parseConversationJudge(value: string | null): {
  decision: "speak" | "silent";
  reason: "followup" | "correction" | "new_info" | "ack_only" | "human_to_human" | "topic_shift" | "no_value" | "uncertain";
  confidence: number;
} {
  if (!value) throw new Error("Participation judge returned no JSON");
  const candidate = /\{[\s\S]*\}/u.exec(value)?.[0];
  if (!candidate || candidate.length > 2000) throw new Error("Participation judge returned invalid JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Participation judge returned malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Participation judge returned a non-object");
  }
  const record = parsed as Record<string, unknown>;
  const speakReasons = new Set(["followup", "correction", "new_info"]);
  const silentReasons = new Set(["ack_only", "human_to_human", "topic_shift", "no_value", "uncertain"]);
  if (
    (record.decision !== "speak" && record.decision !== "silent") ||
    typeof record.reason !== "string" ||
    !(record.decision === "speak" ? speakReasons : silentReasons).has(record.reason) ||
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error("Participation judge JSON does not match the schema");
  }
  return {
    decision: record.decision,
    reason: record.reason as "followup" | "correction" | "new_info" | "ack_only" | "human_to_human" | "topic_shift" | "no_value" | "uncertain",
    confidence: record.confidence,
  };
}

function clipText(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  const available = maxChars - 1;
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return `${chars.slice(0, headLength).join("")}…${chars.slice(chars.length - tailLength).join("")}`;
}

function validateEvent(event: InboundMessageEvent): void {
  if (event.type !== "message") throw new Error("Unsupported event type");
  if (!event.id.trim()) throw new Error("event.id cannot be empty");
  if (!event.conversation.id.trim()) throw new Error("event.conversation.id cannot be empty");
  if (!event.sender.id.trim()) throw new Error("event.sender.id cannot be empty");
  if (!event.sender.displayName.trim()) throw new Error("event.sender.displayName cannot be empty");
  validateMessageParts(event.parts);
  if (!event.text.trim() && (event.attachments?.length ?? 0) === 0 && (event.parts?.length ?? 0) === 0) {
    throw new Error("Message must have text, parts, or attachments");
  }
  if (event.timestamp !== undefined && (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0)) {
    throw new Error("event.timestamp must be a non-negative Unix timestamp in milliseconds");
  }
}

export function createChatSessionDescriptor(input: {
  conversationKind: "direct" | "group";
  conversationId: string;
  sessionNamespace: string;
  sessionScope: string;
  contextReset?: ConversationContextReset;
}): ChatSessionDescriptor {
  const sessionScope = sessionKeySegment(input.sessionScope);
  const sessionNamespace = sessionKeySegment(input.sessionNamespace);
  const contextEpoch = input.contextReset?.resetAt ?? 0;
  return {
    sessionId: `chat:${input.conversationKind}:${sessionNamespace}:${input.conversationId}:scope:${sessionScope}:epoch:${contextEpoch}`,
    sessionScope,
    contextEpoch,
  };
}

function sessionKeySegment(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalized) return "default";
  const safe = normalized.replace(/[^a-z\d._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120);
  return safe || "default";
}

function assertIdentity(bot: BotIdentity): void {
  if (!bot.id.trim()) throw new Error("bot.id cannot be empty");
  if (!bot.displayName.trim()) throw new Error("bot.displayName cannot be empty");
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizedCosine(left: readonly number[], right: readonly number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

export function isWithinActiveHours(
  timestamp: number,
  timezoneOffsetMinutes: number,
  startMinute: number,
  endMinute: number,
): boolean {
  const dayMinutes = 24 * 60;
  const localMinute = Math.floor((timestamp + timezoneOffsetMinutes * 60_000) / 60_000) % dayMinutes;
  const normalizedMinute = localMinute < 0 ? localMinute + dayMinutes : localMinute;
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return normalizedMinute >= startMinute && normalizedMinute < endMinute;
  return normalizedMinute >= startMinute || normalizedMinute < endMinute;
}

function appendProvidedTools(
  tools: AgentRunRequest["tools"],
  providers: readonly AgentToolProvider[],
  event: InboundMessageEvent,
  store: SqliteStore,
  stagePart: (part: MessagePart) => void,
  context: AgentReceiveContext,
  fastTurn: boolean,
): void {
  const names = new Set(tools.map((tool) => tool.name));
  for (const provider of providers) {
    const provided = provider({
      event,
      stagePart,
      store,
      fastTurn,
      ...(context.mediaResolver ? { mediaResolver: context.mediaResolver } : {}),
    });
    if (tools.length + provided.length > 64) throw new Error("A turn cannot expose more than 64 tools");
    for (const tool of provided) {
      if (!tool.name.trim()) throw new Error("Provided Agent tool name cannot be empty");
      if (names.has(tool.name)) throw new Error(`Duplicate Agent tool name: ${tool.name}`);
      names.add(tool.name);
      tools.push(tool);
    }
  }
}

const SHORT_AGENT_TOOLS = new Set([
  "memory",
  "behavior",
  "recall_history",
  "skip_reply",
  "search_emojis",
  "send_emoji",
]);

function isLongRunningAgentTool(toolName: string): boolean {
  return !SHORT_AGENT_TOOLS.has(toolName);
}
