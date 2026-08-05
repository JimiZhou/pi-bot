import type {
  AdapterInstance,
  AdapterManifest,
  BootstrapPayload,
  BotConfig,
  ChatroomMemoryPayload,
  ChatroomRecord,
  CustomMemeRecord,
  EmojiRecord,
  ConsoleManifest,
  GlobalSettings,
  KnowledgeProviderProfile,
  MemeGenerationResult,
  MemeInfo,
  McpServerProfile,
  ModelProfile,
  PersonaProfile,
  ParticipationCase,
  ParticipationLabel,
  ParticipationSummary,
  PluginsPayload,
  ProviderProfile,
  ScheduledTask,
  StoredMessage,
  SupervisorStatus,
} from "@/types/admin"

export class AdminApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(message: string, status: number, code = "request_failed", details?: unknown) {
    super(message)
    this.name = "AdminApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

export class AdminClient {
  readonly #token: string

  constructor(token: string) {
    this.#token = token.trim()
  }

  get session() {
    return this.request<{ ok: true }>("/api/session")
  }

  bootstrap() {
    return this.request<BootstrapPayload>("/api/bootstrap")
  }

  status() {
    return this.request<SupervisorStatus>("/api/status")
  }

  adapters() {
    return this.request<{ manifests: AdapterManifest[]; instances: AdapterInstance[] }>("/api/adapters")
  }

  plugins() {
    return this.request<PluginsPayload>("/api/plugins")
  }

  scheduledTasks() {
    return this.request<{ tasks: ScheduledTask[] }>("/api/scheduled-tasks")
  }

  chatrooms() {
    return this.request<{ chatrooms: ChatroomRecord[] }>("/api/chatrooms")
  }

  chatroomMessages(botId: string, chatroomId: string, beforeSequence?: number) {
    const query = new URLSearchParams({ limit: "100" })
    if (beforeSequence) query.set("beforeSequence", String(beforeSequence))
    return this.request<{ chatroomId: string; messages: StoredMessage[]; hasMore: boolean }>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/messages?${query}`,
    )
  }

  sendChatroomMessage(botId: string, chatroomId: string, input: { text: string } | { emojiId: string }) {
    return this.request<{ eventId: string; delivered: number; botId: string; kind: "text" | "emoji" }>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/send`,
      { method: "POST", body: input },
    )
  }

  async emojiContent(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(`/api/emojis/${encodeURIComponent(id)}/content`, {
      signal,
      headers: {
        Accept: "image/*",
        Authorization: `Bearer ${this.#token}`,
      },
    })
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? ""
      const payload = contentType.includes("application/json")
        ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
        : { message: await response.text().catch(() => "") }
      throw new AdminApiError(
        typeof payload.message === "string" && payload.message
          ? payload.message
          : `表情包预览加载失败（HTTP ${response.status}）`,
        response.status,
        typeof payload.error === "string" ? payload.error : "emoji_preview_failed",
        payload.details,
      )
    }
    return response.blob()
  }

  chatroomMemories(botId: string, chatroomId: string) {
    return this.request<ChatroomMemoryPayload>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/memories`,
    )
  }

  createChatroomMemory(
    botId: string,
    chatroomId: string,
    input: {
      scope: "conversation" | "person"
      personId?: string
      kind: string
      content: string
      importance: number
      expiresInDays?: number
    },
  ) {
    return this.request<ChatroomMemoryPayload>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/memories`,
      { method: "POST", body: input },
    )
  }

  confirmChatroomMemory(botId: string, chatroomId: string, memoryId: string, extendDays?: number) {
    return this.request<ChatroomMemoryPayload>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: "PATCH", body: extendDays === undefined ? {} : { extendDays } },
    )
  }

  deleteChatroomMemory(botId: string, chatroomId: string, memoryId: string) {
    return this.request<ChatroomMemoryPayload>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms/${encodeURIComponent(chatroomId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
    )
  }

  saveChatroom(botId: string, input: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/chatrooms`, {
      method: "PUT",
      body: input,
    })
  }

  async bulkChatrooms(
    targets: Array<{ botId: string; chatroomId: string }>,
    pluginChanges: Record<string, boolean>,
  ) {
    let updated = 0
    for (let index = 0; index < targets.length; index += 200) {
      const result = await this.request<{ updated: number }>("/api/chatrooms/bulk", {
        method: "PUT",
        body: {
          targets: targets.slice(index, index + 200),
          pluginChanges,
        },
      })
      updated += result.updated
    }
    return { updated }
  }

  deleteChatroomOverride(botId: string, chatroomId: string) {
    return this.request<Record<string, unknown>>(
      `/api/bots/${encodeURIComponent(botId)}/chatrooms?chatroomId=${encodeURIComponent(chatroomId)}`,
      { method: "DELETE" },
    )
  }

  resetChatroomContext(targets: Array<{ botId: string; chatroomId: string }>) {
    return this.request<Record<string, unknown>>("/api/chatrooms/context-reset", {
      method: "POST",
      body: { targets },
    })
  }

  updateScheduledTask(id: string, input: Partial<ScheduledTask>) {
    return this.request<{ task: ScheduledTask }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: input,
    })
  }

  deleteScheduledTask(id: string) {
    return this.request<{ deleted: true }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  emojis() {
    return this.request<{ emojis: EmojiRecord[] }>("/api/emojis")
  }

  memeKeys() {
    return this.request<{ keys: string[] }>("/api/meme-generator/memes")
  }

  memeInfo(key: string) {
    return this.request<MemeInfo>(`/api/meme-generator/memes/${encodeURIComponent(key)}/info`)
  }

  uploadCustomMeme(input: {
    key: string
    title?: string
    keywords?: string[]
    dataUrl: string
  }) {
    return this.request<{ meme: CustomMemeRecord }>("/api/meme-generator/custom", {
      method: "POST",
      body: input,
    })
  }

  generateMeme(input: {
    key: string
    images: Array<{ mimeType: string; dataUrl: string }>
    texts: string[]
    args: Record<string, unknown>
  }) {
    return this.request<MemeGenerationResult>("/api/meme-generator/generate", {
      method: "POST",
      body: input,
    })
  }

  saveMemeEmoji(input: {
    botId: string
    key: string
    dataUrl: string
    description?: string
  }) {
    return this.request<{ emoji: EmojiRecord }>("/api/meme-generator/save", {
      method: "POST",
      body: input,
    })
  }

  updateEmoji(id: string, input: Partial<Pick<EmojiRecord, "description" | "enabled" | "isThinking">>) {
    return this.request<{ emoji: EmojiRecord }>(`/api/emojis/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    })
  }

  deleteEmoji(id: string) {
    return this.request<{ deleted: true }>(`/api/emojis/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  participation(botId: string, review = "unrated", qualityReview = "all") {
    const query = new URLSearchParams({ botId, review, qualityReview, limit: "100" })
    return this.request<{ botId: string; cases: ParticipationCase[] }>(`/api/participation?${query}`)
  }

  participationSummary(botId: string) {
    return this.request<{ botId: string; summary: ParticipationSummary }>(
      `/api/participation/summary?botId=${encodeURIComponent(botId)}`,
    )
  }

  labelParticipation(
    botId: string,
    eventId: string,
    label: ParticipationLabel,
    reason?: string,
  ) {
    return this.request<Record<string, unknown>>("/api/participation/label", {
      method: "POST",
      body: { botId, eventId, label, ...(reason ? { reason } : {}) },
    })
  }

  labelReplyQuality(
    botId: string,
    eventId: string,
    label: "helpful" | "unhelpful" | "unsure",
    reason?: string,
  ) {
    return this.request<Record<string, unknown>>("/api/participation/quality", {
      method: "POST",
      body: { botId, eventId, label, ...(reason ? { reason } : {}) },
    })
  }

  pruneParticipation(botId: string) {
    return this.request<{ deleted: number }>("/api/participation/prune", {
      method: "POST",
      body: { botId },
    })
  }

  saveProvider(profile: ProviderProfile & { apiKey?: string }) {
    return this.request<{ provider: ProviderProfile; status: SupervisorStatus }>("/api/providers", {
      method: "POST",
      body: profile,
    })
  }

  deleteProvider(id: string) {
    return this.request<{ deleted: true }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  probeProvider(profile: ProviderProfile & { apiKey?: string }) {
    return this.request<Record<string, unknown>>("/api/providers/probe", { method: "POST", body: profile })
  }

  testProvider(id: string) {
    return this.request<Record<string, unknown>>(`/api/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    })
  }

  saveModel(profile: ModelProfile) {
    return this.request<{ model: ModelProfile; status: SupervisorStatus }>("/api/models", {
      method: "POST",
      body: profile,
    })
  }

  deleteModel(id: string) {
    return this.request<{ deleted: true }>(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  testModel(id: string, testImage = false) {
    return this.request<Record<string, unknown>>(`/api/models/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: { testImage },
    })
  }

  saveKnowledgeProvider(profile: KnowledgeProviderProfile & { apiKey?: string }) {
    return this.request<{ provider: KnowledgeProviderProfile }>("/api/knowledge-providers", {
      method: "POST",
      body: profile,
    })
  }

  deleteKnowledgeProvider(id: string) {
    return this.request<{ deleted: true }>(`/api/knowledge-providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  probeKnowledgeProvider(profile: KnowledgeProviderProfile & { apiKey?: string; query?: string }) {
    return this.request<Record<string, unknown>>("/api/knowledge-providers/probe", {
      method: "POST",
      body: profile,
    })
  }

  testKnowledgeProvider(id: string) {
    return this.request<Record<string, unknown>>(`/api/knowledge-providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    })
  }

  saveMcpServer(profile: McpServerProfile & { secret?: string }) {
    return this.request<{ server: McpServerProfile }>("/api/mcp-servers", { method: "POST", body: profile })
  }

  deleteMcpServer(id: string) {
    return this.request<{ deleted: true }>(`/api/mcp-servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  probeMcpServer(profile: McpServerProfile & { secret?: string }) {
    return this.request<Record<string, unknown>>("/api/mcp-servers/probe", { method: "POST", body: profile })
  }

  testMcpServer(id: string) {
    return this.request<Record<string, unknown>>(`/api/mcp-servers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    })
  }

  savePersona(profile: PersonaProfile) {
    return this.request<{ persona: PersonaProfile; personas: PersonaProfile[] }>("/api/personas", {
      method: "POST",
      body: profile,
    })
  }

  deletePersona(id: string) {
    return this.request<{ deleted: true }>(`/api/personas/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  applyPersona(id: string, botId: string, conversationId?: string) {
    return this.request<Record<string, unknown>>(`/api/personas/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: { botId, ...(conversationId ? { conversationId } : {}) },
    })
  }

  saveSettings(settings: GlobalSettings) {
    return this.request<{ settings: GlobalSettings; status: SupervisorStatus }>("/api/settings", {
      method: "PUT",
      body: settings,
    })
  }

  saveBot(bot: BotConfig) {
    return this.request<{ bot: BotConfig; status: unknown }>("/api/bots", { method: "POST", body: bot })
  }

  deleteBot(id: string) {
    return this.request<{ deleted: true }>(`/api/bots/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  botAction(id: string, action: "start" | "stop" | "restart" | "gateway-check" | "webhook-test") {
    return this.request<Record<string, unknown>>(
      `/api/bots/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
      { method: "POST" },
    )
  }

  saveBotPlugins(id: string, plugins: BotConfig["plugins"]) {
    return this.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(id)}/plugins`, {
      method: "PUT",
      body: { plugins },
    })
  }

  logs(query = "") {
    return this.request<{ logs: import("@/types/admin").AdminLogRecord[] }>(`/api/logs${query}`)
  }

  pruneLogs() {
    return this.request<{ deleted: number }>("/api/logs/prune", { method: "POST" })
  }

  async manifest(): Promise<ConsoleManifest> {
    try {
      return await this.request<ConsoleManifest>("/api/v1/console-manifest")
    } catch (error) {
      if (!(error instanceof AdminApiError) || error.status !== 404) throw error
      const adapters = await this.adapters()
      return {
        apiVersion: 1,
        modules: ["core", "adapters"],
        adapters: adapters.manifests,
      }
    }
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
      body?: unknown
      signal?: AbortSignal
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const response = await fetch(path, {
      method: options.method ?? "GET",
      signal: options.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const contentType = response.headers.get("content-type") ?? ""
    const payload = contentType.includes("application/json")
      ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
      : { message: await response.text().catch(() => "") }
    if (!response.ok) {
      throw new AdminApiError(
        typeof payload.message === "string" && payload.message
          ? payload.message
          : `请求失败（HTTP ${response.status}）`,
        response.status,
        typeof payload.error === "string" ? payload.error : "request_failed",
        payload.details,
      )
    }
    return payload as T
  }
}
