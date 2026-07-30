import type {
  ActivityEvent,
  AdapterInstance,
  BotProfile,
  ConsoleSnapshot,
  ModelRoute,
  PluginModule,
  ProviderConnection,
  SessionRecord,
  SystemCheck,
} from "@/types/console"
import { AdminApiError } from "@/lib/admin-client"

const TOKEN_STORAGE_KEY = "pi-admin-token"

interface RuntimeBot {
  id: string
  displayName: string
  phase: string
  enabled: boolean
  since: number
  lastEventAt: number | null
  lastError: string | null
  gatewayHealthy: boolean
  pendingOutbox: number
  chatModel: string
  metrics: {
    inboundMessages: number
    agentRuns: number
    replies: number
    agentFailures: number
    deliveries: number
    totalAgentDurationMs: number
    llmCalls: number
  }
}

interface StatusResponse {
  startedAt: number
  uptimeMs: number
  process: {
    node: string
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
  }
  bots: RuntimeBot[]
  logCounts: Record<string, number>
}

interface BotConfig {
  id: string
  displayName: string
  enabled: boolean
  defaultGroupActivation: string
  chatModelProfileId: string | null
  fallbackChatModelProfileIds: string[]
  channel: { type: string }
}

interface ModelProfile {
  id: string
  label: string
  providerProfileId: string
  modelId: string
  api: string
  input: string[]
  enabled: boolean
}

interface ProviderProfile {
  id: string
  label: string
  provider: string
  api: string
  enabled: boolean
}

interface AdapterResponse {
  manifests: Array<{
    apiVersion: number
    type: string
    displayName: string
    description?: string
    features?: Array<{ id: string; version: number }>
    capabilities?: Array<{ id: string; version: number }>
  }>
  instances: Array<{
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
  }>
}

interface PluginsResponse {
  catalog: Array<{ type: string; name: string; description: string }>
  bots: Array<{
    id: string
    displayName: string
    plugins: Array<{ type: string; enabled: boolean }>
  }>
}

interface Chatroom {
  botId: string
  botDisplayName: string
  chatroomId: string
  title?: string
  label?: string
  inboundMessages: number
  activeMembers: number
  lastMessageAt: number
  participationIntensity?: string
  bots?: Array<{ id: string; channelType: string; running: boolean; healthy: boolean }>
}

export interface AdminDataSource {
  authenticate(token: string): Promise<void>
  getSnapshot(token: string): Promise<ConsoleSnapshot>
}

class HttpAdminDataSource implements AdminDataSource {
  async authenticate(token: string): Promise<void> {
    await request<{ ok: true }>("/api/session", token)
  }

  async getSnapshot(token: string): Promise<ConsoleSnapshot> {
    const [status, botsPayload, modelsPayload, providersPayload, adapters, plugins, chatroomsPayload] =
      await Promise.all([
        request<StatusResponse>("/api/status", token),
        request<{ bots: BotConfig[] }>("/api/bots", token),
        request<{ models: ModelProfile[] }>("/api/models", token),
        request<{ providers: ProviderProfile[] }>("/api/providers", token),
        request<AdapterResponse>("/api/adapters", token),
        request<PluginsResponse>("/api/plugins", token),
        request<{ chatrooms: Chatroom[] }>("/api/chatrooms", token),
      ])

    return mapSnapshot(
      status,
      botsPayload.bots,
      modelsPayload.models,
      providersPayload.providers,
      adapters,
      plugins,
      chatroomsPayload.chatrooms,
    )
  }
}

async function request<T>(path: string, token: string): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token.trim()}`,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string
  }
  if (!response.ok) {
    throw new AdminApiError(payload.message ?? `请求失败（HTTP ${response.status}）`, response.status)
  }
  return payload as T
}

function mapSnapshot(
  status: StatusResponse,
  configs: BotConfig[],
  models: ModelProfile[],
  providers: ProviderProfile[],
  adapters: AdapterResponse,
  plugins: PluginsResponse,
  chatrooms: Chatroom[],
): ConsoleSnapshot {
  const runtimeById = new Map(status.bots.map((bot) => [bot.id, bot]))
  const modelById = new Map(models.map((model) => [model.id, model]))
  const totalRuns = sum(status.bots, (bot) => bot.metrics.agentRuns)
  const totalFailures = sum(status.bots, (bot) => bot.metrics.agentFailures)
  const totalInbound = sum(status.bots, (bot) => bot.metrics.inboundMessages)
  const healthyBots = status.bots.filter((bot) => bot.phase === "running" && bot.gatewayHealthy).length
  const maxInbound = Math.max(1, ...status.bots.map((bot) => bot.metrics.inboundMessages))

  const botProfiles: BotProfile[] = configs.map((config) => {
    const runtime = runtimeById.get(config.id)
    const model = config.chatModelProfileId ? modelById.get(config.chatModelProfileId) : undefined
    return {
      id: config.id,
      name: config.displayName,
      description: `${adapterLabel(config.channel.type, adapters)} · ${config.id}`,
      status: runtime?.phase === "running" ? "运行中" : "已暂停",
      adapterCount: 1,
      modelRoute: model?.label ?? runtime?.chatModel ?? "继承全局路由",
      triggerMode: activationLabel(config.defaultGroupActivation),
      sessionsToday: runtime?.metrics.inboundMessages ?? 0,
      updatedAt: relativeTime(runtime?.lastEventAt ?? runtime?.since),
    }
  })

  const configuredAdapterTypes = new Set(adapters.instances.map((adapter) => adapter.type))
  const configuredAdapters: AdapterInstance[] = adapters.instances.map((adapter) => ({
    id: adapter.id,
    name: adapter.displayName,
    transport: adapterLabel(adapter.type, adapters),
    version: "1 · Adapter API",
    status: adapter.healthy ? "在线" : adapter.enabled ? "待配置" : "已停用",
    endpoint: adapter.endpoint ?? "未监听",
    capabilities: [...adapter.features, ...adapter.capabilities].map((feature) => feature.id),
    eventsToday: formatCount(runtimeById.get(adapter.botId)?.metrics.inboundMessages ?? 0),
    lastSeen: relativeTime(adapter.lastEventAt),
  }))
  const availableAdapters: AdapterInstance[] = adapters.manifests
    .filter((manifest) => !configuredAdapterTypes.has(manifest.type))
    .map((manifest) => ({
      id: `manifest:${manifest.type}`,
      name: manifest.displayName,
      transport: manifest.type,
      version: `${manifest.apiVersion} · Adapter API`,
      status: "待配置",
      endpoint: manifest.description ?? "尚未配置实例",
      capabilities: [...(manifest.features ?? []), ...(manifest.capabilities ?? [])].map(
        (feature) => feature.id,
      ),
      eventsToday: "0",
      lastSeen: "尚未连接",
    }))
  const adapterInstances = [...configuredAdapters, ...availableAdapters]

  const modelRoutes: ModelRoute[] = models.map((model) => {
    const consumers = configs.filter((config) => config.chatModelProfileId === model.id)
    const runtimes = consumers.flatMap((config) => {
      const runtime = runtimeById.get(config.id)
      return runtime ? [runtime] : []
    })
    const runs = sum(runtimes, (runtime) => runtime.metrics.agentRuns)
    const failures = sum(runtimes, (runtime) => runtime.metrics.agentFailures)
    const durations = sum(runtimes, (runtime) => runtime.metrics.totalAgentDurationMs)
    return {
      id: model.id,
      name: model.label,
      purpose: `${model.input.join(" + ")} · ${model.api}`,
      primaryModel: model.modelId,
      fallbackModel: fallbackLabel(consumers, modelById),
      successRate: percentage(runs - failures, runs),
      latency: runs > 0 ? formatDuration(durations / runs) : "暂无调用",
      requestsToday: formatCount(sum(runtimes, (runtime) => runtime.metrics.llmCalls)),
      status: model.enabled && failures <= Math.max(1, runs * 0.2) ? "健康" : "降级",
    }
  })

  const providerConnections: ProviderConnection[] = providers.map((provider) => ({
    id: provider.id,
    name: provider.label,
    protocol: `${provider.provider} · ${provider.api}`,
    modelCount: models.filter((model) => model.providerProfileId === provider.id).length,
    status: provider.enabled ? "已连接" : "需关注",
    latency: "按需探测",
    quota: provider.enabled ? "配置已启用" : "已停用",
  }))

  const pluginModules: PluginModule[] = plugins.catalog.map((plugin) => {
    const enabledFor = plugins.bots.filter((bot) =>
      bot.plugins.some((item) => item.type === plugin.type && item.enabled),
    )
    return {
      id: plugin.type,
      name: plugin.name,
      description: plugin.description,
      category: "内置",
      version: "Core",
      enabled: enabledFor.length > 0,
      scope: enabledFor.length === plugins.bots.length ? "全部 Bot" : `${enabledFor.length} 个 Bot`,
      callsToday: "按事件触发",
    }
  })

  const sessions: SessionRecord[] = chatrooms.slice(0, 100).map((room) => ({
    id: room.chatroomId,
    bot: room.botDisplayName,
    channel: room.bots?.map((bot) => bot.channelType).join(" + ") || "WeChat",
    participant: room.title || room.label || room.chatroomId,
    mode: room.participationIntensity ? `群组 · ${room.participationIntensity}` : "群组会话",
    status: Date.now() - room.lastMessageAt < 30 * 60_000 ? "活跃" : "等待",
    turns: room.inboundMessages,
    contextUsage: Math.min(100, room.activeMembers * 5),
    updatedAt: relativeTime(room.lastMessageAt),
  }))

  return {
    generatedAt: new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date()),
    environment: "本地 WeChat 部署",
    metrics: [
      {
        label: "Bot 实例",
        value: String(configs.length),
        detail: `${healthyBots} 个健康运行`,
        trend: `${healthyBots} / ${configs.length}`,
        tone: healthyBots === configs.length ? "positive" : "warning",
      },
      {
        label: "适配器实例",
        value: String(adapterInstances.length),
        detail: `${adapters.manifests.length} 种标准 Adapter`,
        trend: "API v1",
        tone: "positive",
      },
      {
        label: "本次运行入站",
        value: formatCount(totalInbound),
        detail: "进程启动以来",
        trend: `${chatrooms.length} 个群聊`,
        tone: "neutral",
      },
      {
        label: "Agent 成功率",
        value: `${percentage(totalRuns - totalFailures, totalRuns).toFixed(1)}%`,
        detail: `${totalRuns} 次运行`,
        trend: totalFailures > 0 ? `${totalFailures} 次失败` : "无失败",
        tone: totalFailures <= Math.max(1, totalRuns * 0.1) ? "positive" : "warning",
      },
    ],
    volume: status.bots.map((bot) => Math.max(4, Math.round((bot.metrics.inboundMessages / maxInbound) * 100))),
    volumeLabels: status.bots.map((bot) => bot.displayName),
    volumeCounts: status.bots.map((bot) => bot.metrics.inboundMessages),
    bots: botProfiles,
    adapters: adapterInstances,
    modelRoutes,
    providers: providerConnections,
    plugins: pluginModules,
    sessions,
    activities: status.bots.map<ActivityEvent>((bot) => ({
      id: bot.id,
      title: `${bot.displayName} · ${bot.phase === "running" ? "运行中" : bot.phase}`,
      detail: bot.lastError ?? `${formatCount(bot.metrics.deliveries)} 次投递 · ${bot.pendingOutbox} 条待发送`,
      time: relativeTime(bot.lastEventAt ?? bot.since),
      type: bot.lastError ? "warning" : bot.gatewayHealthy ? "success" : "info",
    })),
    checks: buildChecks(status),
    runtime: {
      coreVersion: "0.2.0-wechat",
      apiVersion: "Adapter v1",
      runtime: `Node.js ${status.process.node.replace(/^v/u, "")}`,
      uptime: formatUptime(status.uptimeMs),
      database: "SQLite · WAL",
      queueDepth: sum(status.bots, (bot) => bot.pendingOutbox),
      storageUsage: Math.round((status.process.heapUsedBytes / Math.max(1, status.process.heapTotalBytes)) * 100),
      storageLabel: `${formatBytes(status.process.heapUsedBytes)} / ${formatBytes(status.process.heapTotalBytes)} Heap`,
    },
  }
}

function buildChecks(status: StatusResponse): SystemCheck[] {
  const unhealthy = status.bots.filter((bot) => !bot.gatewayHealthy)
  const queueDepth = sum(status.bots, (bot) => bot.pendingOutbox)
  return [
    {
      id: "runtime",
      name: "核心运行时",
      detail: "Node.js 事件循环与 Supervisor",
      status: "正常",
      value: formatUptime(status.uptimeMs),
    },
    {
      id: "adapters",
      name: "通道适配器",
      detail: unhealthy.length > 0 ? `${unhealthy.length} 个网关需关注` : "全部网关健康",
      status: unhealthy.length > 0 ? "需关注" : "正常",
      value: `${status.bots.length - unhealthy.length} / ${status.bots.length}`,
    },
    {
      id: "outbox",
      name: "持久化 Outbox",
      detail: "等待通道投递的动作",
      status: queueDepth > 20 ? "需关注" : "正常",
      value: `${queueDepth} 条`,
    },
    {
      id: "logs",
      name: "运行日志",
      detail: "当前保留的错误日志",
      status: (status.logCounts.error ?? 0) > 0 ? "需关注" : "正常",
      value: formatCount(status.logCounts.error ?? 0),
    },
  ]
}

function adapterLabel(type: string, adapters: AdapterResponse): string {
  return adapters.manifests.find((manifest) => manifest.type === type)?.displayName ?? type
}

function activationLabel(value: string): string {
  return {
    off: "仅显式触发",
    mentions: "提及与唤醒词",
    always: "智能主动参与",
  }[value] ?? value
}

function fallbackLabel(configs: BotConfig[], models: Map<string, ModelProfile>): string {
  const id = configs.flatMap((config) => config.fallbackChatModelProfileIds).find(Boolean)
  return (id ? models.get(id)?.label : undefined) ?? "未配置"
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 100
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0)
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard" }).format(value)
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function formatUptime(value: number): string {
  const minutes = Math.floor(value / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const remainder = minutes % 60
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${remainder} 分`
}

function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "暂无事件"
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

export function storedAdminToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""
}

export function storeAdminToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token.trim())
}

export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
}

export const adminDataSource: AdminDataSource = new HttpAdminDataSource()
