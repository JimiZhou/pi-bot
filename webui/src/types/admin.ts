export type ManagedProviderApi =
  | "auto"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai"
  | "anthropic-messages"

export type ManagedModelApi = ManagedProviderApi | "inherit"
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type GroupActivation = "off" | "mention" | "always"

export interface ProviderProfile {
  id: string
  label: string
  provider: string
  api: ManagedProviderApi
  apiKeyEnv?: string
  baseUrl: string
  enabled: boolean
  hasApiKey?: boolean
}

export interface KnowledgeProviderProfile {
  id: string
  label: string
  kind: "searxng" | "brave" | "tavily"
  baseUrl: string
  apiKeyEnv?: string
  timeoutMs: number
  maxResults: number
  enabled: boolean
  hasApiKey?: boolean
}

export interface McpServerProfile {
  id: string
  label: string
  url: string
  authType: "none" | "bearer" | "api-key"
  authHeader: string
  headers: Record<string, string>
  timeoutMs: number
  maxTools: number
  enabled: boolean
  hasSecret?: boolean
}

export interface ModelProfile {
  id: string
  label: string
  providerProfileId: string
  modelId: string
  api: ManagedModelApi
  input: Array<"text" | "image">
  reasoning: boolean
  contextWindow: number
  maxTokens: number
  thinkingLevel: ThinkingLevel
  openaiThinkingFormat?: string
  maxRetryDelayMs: number
  enabled: boolean
}

export interface PersonaProfile {
  id: string
  label: string
  prompt: string
  accountNickname?: string
  groupNickname?: string
  wakeWords: string[]
  avatarDataUrl?: string
  autoApplyAccountProfile: boolean
  enabled: boolean
}

export interface BotChannelConfig {
  type: string
  accountId?: string
  settings: Record<string, unknown>
}

export interface BotAgentLimits {
  historyLimit: number
  maxHistoryChars: number
  memoryLimit: number
  behaviorLimit: number
  continuationWindowMs: number
  messageBurstDebounceMs: number
  explicitMessageBurstDebounceMs: number
  maxAgentLlmCalls: number
  maxAgentToolCalls: number
  agentTimeoutMs: number
  maxReplyChars: number
  maxImageUnderstandingCalls: number
  maxImageBytes: number
  maxImageEvidenceChars: number
  imageUnderstandingTimeoutMs: number
  imageContextMessageLimit: number
  imageContextWindowMs: number
  maxAvailableImagesPerTurn: number
}

export interface SocialScheduleConfig {
  enabled: boolean
  timezoneOffsetMinutes: number
  activeStartMinute: number
  activeEndMinute: number
  hotChatWindowMs: number
  hotChatMinMessages: number
  hotChatMinParticipants: number
  hotChatCooldownMs: number
  coldChatAfterMs: number
  coldChatCooldownMs: number
  maxDailyAmbientMessages: number
  goodnightEnabled: boolean
  goodnightMinute: number
  activeGroupMinMessages: number
}

export interface BotPluginConfig {
  id: string
  type: string
  enabled: boolean
  settings: Record<string, unknown>
}

export interface ChatroomPluginOverride {
  pluginType: string
  enabled: boolean
}

export interface ChatroomOverride {
  chatroomId: string
  label?: string
  chatModelProfileId: string | null
  visionModelProfileId: string | null
  personaProfileId?: string | null
  ttsVoice?: string
  ttsStyle?: string
  participationIntensity?: "conservative" | "standard" | "active"
  managerIds: string[]
  redEnvelopeTargetIds: string[]
  pluginOverrides: ChatroomPluginOverride[]
}

export interface BotConfig {
  id: string
  enabled: boolean
  identityId: string
  displayName: string
  wakeWords: string[]
  operatorIds: string[]
  soul?: string
  personaProfileId?: string | null
  defaultGroupActivation: GroupActivation
  chatModelProfileId: string | null
  fastChatModelProfileId: string | null
  participationJudgeModelProfileId: string | null
  fallbackChatModelProfileIds: string[]
  visionModelProfileId: string | null
  chatroomModelOverrides: ChatroomOverride[]
  imageUnderstandingEnabled: boolean
  databaseFile: string
  channel: BotChannelConfig
  limits: BotAgentLimits
  socialSchedule: SocialScheduleConfig
  plugins: BotPluginConfig[]
}

export interface GlobalSettings {
  defaultChatModelProfileId: string | null
  defaultVisionModelProfileId: string | null
  defaultKnowledgeProfileId: string | null
  defaultPersonaProfileId: string | null
  logRetentionDays: number
  maxLogRows: number
  statusRefreshMs: number
  participationRetentionDays: number
  maxParticipationCasesPerBot: number
}

export interface RuntimeBotStatus {
  id: string
  displayName: string
  enabled: boolean
  phase: "stopped" | "starting" | "running" | "stopping" | "error"
  since: number
  startedAt: number | null
  lastEventAt: number | null
  lastError: string | null
  gatewayHealthy: boolean | null
  gatewayCheckedAt: number | null
  webhookAddress: { host: string; port: number; path: string } | null
  pendingOutbox: number
  chatModel: string | null
  visionModel: string | null
  chatroomModelOverrides: number
  metrics: Record<string, number | string[] | null>
}

export interface SupervisorStatus {
  startedAt: number
  uptimeMs: number
  process: {
    pid: number
    node: string
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
  }
  bots: RuntimeBotStatus[]
  logCounts: Record<string, number>
}

export interface BootstrapPayload {
  settings: GlobalSettings
  providers: ProviderProfile[]
  knowledgeProviders: KnowledgeProviderProfile[]
  mcpServers: McpServerProfile[]
  models: ModelProfile[]
  personas: PersonaProfile[]
  bots: BotConfig[]
  status: SupervisorStatus
  tts: {
    voices: string[]
    presets: Array<{ id?: string; label?: string; voice?: string; style?: string }>
    defaultVoice: string
    defaultStyle: string
  }
}

export interface PluginCatalogEntry {
  type: string
  name: string
  description: string
}

export interface PluginsPayload {
  catalog: PluginCatalogEntry[]
  bots: Array<{
    id: string
    displayName: string
    plugins: BotPluginConfig[]
  }>
}

export interface ScheduledTask {
  id: string
  botId: string
  conversationId: string
  creatorId: string
  creatorName: string
  title: string
  content: string
  schedule: Record<string, unknown>
  timezoneOffsetMinutes: number
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ChatroomRecord {
  botId: string
  botDisplayName: string
  botIds: string[]
  bots?: Array<{ id: string; channelType: string; running: boolean; healthy: boolean }>
  chatroomId: string
  title?: string
  label?: string
  inboundMessages: number
  activeMembers: number
  lastMessageAt: number | null
  chatModelProfileId: string | null
  visionModelProfileId: string | null
  personaProfileId: string | null
  ttsVoice?: string
  ttsStyle?: string
  ttsPresetId?: string
  participationIntensity?: "conservative" | "standard" | "active"
  managerIds: string[]
  redEnvelopeTargetIds: string[]
  plugins: Array<{
    type: string
    defaultEnabled: boolean
    override: boolean | null
    enabled: boolean
  }>
}

export interface StoredMessage {
  sequence: number
  id: string
  conversationId: string
  direction: "inbound" | "outbound"
  senderId: string
  senderName: string
  text: string
  timestamp: number
}

export interface MemoryRecord {
  id: string
  scope: "global" | "conversation" | "person"
  scopeId: string
  conversationId?: string
  kind: string
  content: string
  importance: number
  lastConfirmedAt: number
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface ChatroomMemoryPayload {
  chatroomId: string
  memories: MemoryRecord[]
  members: Array<{ id: string; displayName: string; isBot: boolean }>
  audit: Array<{
    id: string
    entityType: "memory" | "behavior"
    entityId: string
    action: "saved" | "corrected" | "forgotten" | "restored"
    reason?: string
    createdAt: number
  }>
}

export type ParticipationLabel = "speak" | "silent" | "unsure"
export type ReplyQualityLabel = "helpful" | "unhelpful" | "unsure"

export interface ParticipationCase {
  eventId: string
  conversationId: string
  conversationTitle?: string
  senderId: string
  senderName: string
  messageText: string
  context: StoredMessage[]
  activation: GroupActivation
  policyRespond: boolean
  policyReason: string
  modelUsed: boolean
  outcome: "pending" | "ignored" | "silent" | "replied" | "blocked" | "failed"
  replyText?: string
  implicitLabel?: Exclude<ParticipationLabel, "unsure">
  adminLabel?: ParticipationLabel
  adminReason?: string
  implicitQualityLabel?: Exclude<ReplyQualityLabel, "unsure">
  adminQualityLabel?: ReplyQualityLabel
  adminQualityReason?: string
  createdAt: number
  updatedAt: number
}

export interface ParticipationSummary {
  total: number
  unrated: number
  speak: number
  silent: number
  unsure: number
  implicitPositive: number
  implicitNegative: number
  helpful: number
  unhelpful: number
  qualityUnsure: number
  implicitHelpful: number
  implicitUnhelpful: number
}

export interface EmojiRecord {
  id: string
  botId: string
  description: string
  status: "analyzing" | "ready" | "failed"
  enabled: boolean
  isThinking: boolean
  mimeType: string
  size: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface MemeInfo {
  key: string
  keywords: string[]
  minImages: number
  maxImages: number
  minTexts: number
  maxTexts: number
}

export interface CustomMemeRecord {
  key: string
  title: string
  keywords: string[]
  mimeType: string
  size: number
  filename: string
  createdAt: number
  updatedAt: number
  minImages: 0
  maxImages: 0
  minTexts: 0
  maxTexts: 0
}

export interface MemeGenerationResult {
  mimeType: string
  size: number
  data: string
}

export interface AdminLogRecord {
  id: number
  level: "debug" | "info" | "warn" | "error"
  scope: "system" | "web" | "bot" | "channel" | "agent"
  event: string
  message: string
  botId?: string
  details?: Record<string, unknown>
  createdAt: number
}

export interface AdapterManifest {
  apiVersion: 1
  type: string
  displayName: string
  description?: string
  features?: Array<{ id: string; version: number }>
  capabilities?: Array<{ id: string; version: number }>
}

export interface AdapterInstance {
  id: string
  botId: string
  type: string
  displayName: string
  enabled: boolean
  phase: string
  healthy: boolean
  lastEventAt: number | null
  endpoint: string | null
  features: Array<{ id: string; version: number }>
  capabilities: Array<{ id: string; version: number }>
}

export interface ConsoleManifest {
  apiVersion: 1
  modules: string[]
  adapters: AdapterManifest[]
}
