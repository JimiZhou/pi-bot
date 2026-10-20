import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MediaResolver } from "./asset-store.js";
import type { SqliteStore } from "./sqlite-store.js";

export type ConversationKind = "direct" | "group";
export type GroupActivation = "mention" | "always" | "off";

export interface ConversationRef {
  id: string;
  kind: ConversationKind;
  title?: string;
}

export interface SenderRef {
  id: string;
  displayName: string;
  isBot?: boolean;
}

export interface MentionRef {
  id: string;
  displayName?: string;
}

export interface ReplyRef {
  messageId: string;
  /** Stable provider-side id when local adapter event ids differ. */
  transportMessageId?: string;
  senderId?: string;
}

/** Legacy metadata-only attachment. Prefer MessagePart with AssetRef. */
export interface AttachmentRef {
  kind: "image" | "audio" | "video" | "file" | "link";
  mimeType?: string;
  name?: string;
  description?: string;
  url?: string;
}

export type AssetSource = "platform" | "local" | "url";

/** Durable metadata for media content. Binary bytes live outside SQLite. */
export interface AssetRef {
  id: string;
  source: AssetSource;
  locator: string;
  ownerPluginId?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  sha256?: string;
  expiresAt?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; asset: AssetRef; alt?: string; width?: number; height?: number }
  | { type: "audio"; asset: AssetRef; durationMs?: number }
  | { type: "voice"; asset: AssetRef; durationMs?: number; transcript?: string }
  | { type: "video"; asset: AssetRef; durationMs?: number; width?: number; height?: number }
  | { type: "file"; asset: AssetRef; name?: string }
  | { type: "link"; url: string; title?: string; description?: string }
  | { type: "mention"; memberId: string; displayName?: string }
  | {
      type: "quote";
      messageId: string;
      senderId?: string;
      /** Sender display name of the quoted message, for adapters that render native quotes. */
      senderName?: string;
      /** Short excerpt of the quoted message text, for native quote previews. */
      excerpt?: string;
    };

export interface InboundMessageEvent {
  type: "message";
  id: string;
  /** Stable provider-side id used only for optional cross-adapter fusion. */
  transportMessageId?: string;
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  parts?: MessagePart[];
  timestamp?: number;
  mentions?: MentionRef[];
  replyTo?: ReplyRef;
  attachments?: AttachmentRef[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface BotIdentity {
  id: string;
  displayName: string;
  wakeWords?: string[];
  /** Equivalent bot account ids that this runtime may cover during failover. */
  aliasIds?: string[];
}

export interface OutboundMessageAction {
  id: string;
  type: "message";
  conversationId: string;
  text: string;
  parts?: MessagePart[];
  replyToMessageId: string;
  createdAt: number;
}

export type ProactiveParticipationKind =
  | "cold-chat"
  | "morning-brief"
  | "group-summary"
  | "scheduled-task"
  | "goodnight"
  | "admin-message";

export interface ProactiveParticipationRequest {
  id: string;
  kind: ProactiveParticipationKind;
  conversationId: string;
  prompt: string;
  timestamp: number;
}

export interface GroupActivitySummary {
  conversationId: string;
  conversationTitle?: string;
  inboundMessages: number;
  activeMembers: number;
  lastMessageAt: number;
}

export interface GroupActivityDigest extends GroupActivitySummary {
  ranking: Array<{ senderId: string; senderName: string; messages: number }>;
  messages: StoredMessage[];
}

export interface HandleResult {
  eventId: string;
  status: "ignored" | "replied";
  triggerReason: string;
  actions: OutboundMessageAction[];
  replayed: boolean;
}

export interface StoredMessage {
  sequence: number;
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: string;
  /** Original channel event id when this message was copied into shared conversation state. */
  sourceEventId?: string;
  /** Stable transport-side id used to resolve the local copy of a fused inbound message. */
  transportMessageId?: string;
}

export type MemoryScope = "global" | "conversation" | "person";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  conversationId?: string;
  kind: string;
  content: string;
  importance: number;
  lastConfirmedAt: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Optional semantic index used alongside the local exact-term memory search. */
export type MemoryEmbeddingTask = "retrieval_query" | "retrieval_document";

export interface MemoryEmbeddingProvider {
  readonly model: string;
  embed(texts: string[], task: MemoryEmbeddingTask): Promise<number[][]>;
}

export interface RememberInput {
  scope: MemoryScope;
  scopeId: string;
  conversationId?: string;
  kind: string;
  content: string;
  importance: number;
  sourceEventId?: string;
  actorId?: string;
  /** Optional expiry for temporary plans or facts; omitted means durable until corrected or forgotten. */
  expiresAt?: number;
}

export type BehaviorScope = "conversation" | "person";

export interface BehaviorRule {
  id: string;
  scope: BehaviorScope;
  scopeId: string;
  conversationId: string;
  rule: string;
  createdAt: number;
  updatedAt: number;
}

export interface SetBehaviorInput {
  scope: BehaviorScope;
  scopeId: string;
  conversationId: string;
  rule: string;
  sourceEventId?: string;
  actorId?: string;
}

export interface LearningAuditRecord {
  id: string;
  conversationId: string;
  entityType: "memory" | "behavior";
  entityId: string;
  action: "saved" | "corrected" | "forgotten" | "restored";
  actorId?: string;
  sourceEventId?: string;
  beforeValue?: string;
  afterValue?: string;
  reason?: string;
  createdAt: number;
}

export type ParticipationLabel = "speak" | "silent" | "unsure";
export type ReplyQualityLabel = "helpful" | "unhelpful" | "unsure";
export type ParticipationOutcome = "pending" | "ignored" | "silent" | "replied" | "blocked" | "failed";

export interface ParticipationCase {
  eventId: string;
  sampleFingerprint: string;
  conversationId: string;
  conversationTitle?: string;
  senderId: string;
  senderName: string;
  messageText: string;
  context: StoredMessage[];
  activation: GroupActivation;
  policyRespond: boolean;
  policyReason: string;
  modelUsed: boolean;
  outcome: ParticipationOutcome;
  replyText?: string;
  implicitLabel?: Exclude<ParticipationLabel, "unsure">;
  implicitReason?: string;
  implicitSourceEventId?: string;
  adminLabel?: ParticipationLabel;
  adminReason?: string;
  adminLabeledAt?: number;
  implicitQualityLabel?: Exclude<ReplyQualityLabel, "unsure">;
  implicitQualityReason?: string;
  implicitQualitySourceEventId?: string;
  adminQualityLabel?: ReplyQualityLabel;
  adminQualityReason?: string;
  adminQualityLabeledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ParticipationCaseQuery {
  conversationId?: string;
  review?: "all" | "unrated" | ParticipationLabel;
  qualityReview?: "all" | "unrated" | ReplyQualityLabel;
  limit?: number;
  beforeCreatedAt?: number;
}

export interface ParticipationSummary {
  total: number;
  unrated: number;
  speak: number;
  silent: number;
  unsure: number;
  implicitPositive: number;
  implicitNegative: number;
  helpful: number;
  unhelpful: number;
  qualityUnsure: number;
  implicitHelpful: number;
  implicitUnhelpful: number;
}

export interface KnowledgeItem {
  title: string;
  content: string;
  source?: string;
  updatedAt?: number;
}

export interface KnowledgeSearchRequest {
  query: string;
  conversationId: string;
  senderId: string;
  limit: number;
  signal?: AbortSignal;
}

export interface KnowledgeRetriever {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeItem[]>;
}

export interface AgentRunRequest {
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  tools: AgentTool[];
  budget?: AgentRunBudget;
  /** Called after the model has selected a tool and immediately before execution. */
  onToolCallStart?: (context: AgentToolCallStart) => void;
}

export interface AgentToolCallStart {
  toolName: string;
  args: unknown;
  /** Bounded natural-language lead-in emitted by the model before the tool call, if any. */
  modelText?: string;
}

export interface AgentRunBudget {
  maxLlmCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
  /** Shared absolute deadline preserved across model fallback hops. */
  deadlineAt?: number;
}

export interface AgentRunResult {
  text: string | null;
  parts?: MessagePart[];
  /** Every configured Gemini model failed and the externally configured final fallback answered. */
  degradedMode?: boolean;
  telemetry?: AgentRunTelemetry;
}

export interface AgentRunTelemetry {
  model: string;
  provider: string;
  modelRoute: string[];
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  fallbackHops: number;
  durationMs: number;
  timeToFirstTokenMs?: number;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface AgentToolProviderContext {
  event: InboundMessageEvent;
  stagePart(part: MessagePart): void;
  /** Marks a bounded low-latency turn; providers should skip expensive catalog/index work. */
  fastTurn?: boolean;
  /** Resolver owned by the active channel; it can read platform attachments for this turn. */
  mediaResolver?: MediaResolver;
  /** The active bot's durable store; providers must not substitute the admin control-plane store. */
  store?: SqliteStore;
}

/** Explicit allowlist seam for app- or channel-specific Pi tools. */
export type AgentToolProvider = (context: AgentToolProviderContext) => AgentTool[];

export interface TriggerDecision {
  respond: boolean;
  reason: string;
}

export interface TriggerContext {
  event: InboundMessageEvent;
  bot: BotIdentity;
  activation: GroupActivation;
  recentMessages: StoredMessage[];
  continuationWindowMs: number;
  quietHours?: boolean;
  hotChat?: {
    windowMs: number;
    minMessages: number;
    minParticipants: number;
  };
}

export interface TriggerPolicy {
  decide(context: TriggerContext): TriggerDecision | Promise<TriggerDecision>;
}

export type TraceEvent =
  | { type: "inbound.stored"; eventId: string; conversationId: string }
  | { type: "inbound.replayed"; eventId: string; conversationId: string }
  | { type: "trigger.decided"; eventId: string; respond: boolean; reason: string }
  | {
      type: "agent.started";
      eventId: string;
      conversationId: string;
      sessionId: string;
      sessionScope: string;
      contextEpoch: number;
    }
  | { type: "agent.finished"; eventId: string; replied: boolean; durationMs: number; telemetry?: AgentRunTelemetry }
  | {
      type: "agent.output_blocked";
      eventId: string;
      reason: "internal-deliberation" | "source-echo" | "upstream-error";
    }
  | { type: "agent.failed"; eventId: string; error: string }
  | { type: "memory.embedding.failed"; eventId: string; error: string }
  | { type: "knowledge.lookup.started"; eventId: string; query: string; automatic: true }
  | { type: "knowledge.lookup.finished"; eventId: string; count: number; durationMs: number; automatic: true }
  | { type: "knowledge.lookup.failed"; eventId: string; durationMs: number; error: string; automatic: true }
  | {
      type: "image.understanding.started";
      eventId: string;
      sourceMessageId: string;
      assetId: string;
      imageIndex: number;
    }
  | {
      type: "image.understanding.finished";
      eventId: string;
      sourceMessageId: string;
      assetId: string;
      imageIndex: number;
      durationMs: number;
      bytes: number;
      evidenceChars: number;
    }
  | {
      type: "image.understanding.failed";
      eventId: string;
      sourceMessageId: string;
      assetId: string;
      imageIndex: number;
      durationMs: number;
      error: string;
    }
  | {
      type: "image.understanding.cache_hit";
      eventId: string;
      sourceMessageId: string;
      assetId: string;
      imageIndex: number;
      sha256: string;
    }
  | { type: "memory.saved"; memoryId: string; scope: MemoryScope; scopeId: string }
  | { type: "memory.corrected"; memoryId: string; replacementMemoryId: string; eventId: string }
  | { type: "memory.forgotten"; memoryId: string; eventId: string }
  | { type: "behavior.saved"; behaviorId: string; scope: BehaviorScope; scopeId: string }
  | { type: "behavior.corrected"; behaviorId: string; replacementBehaviorId: string; eventId: string }
  | { type: "behavior.forgotten"; behaviorId: string; eventId: string }
  | { type: "outbox.acked"; actionIds: string[] };

export type TraceListener = (event: TraceEvent) => void;
