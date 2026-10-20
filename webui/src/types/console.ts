export type HealthTone = "positive" | "neutral" | "warning" | "muted"

export interface ConsoleMetric {
  label: string
  value: string
  detail: string
  trend?: string
  tone?: HealthTone
}

export interface BotProfile {
  id: string
  name: string
  description: string
  status: "运行中" | "已暂停"
  adapterCount: number
  modelRoute: string
  triggerMode: string
  sessionsToday: number
  updatedAt: string
}

export interface AdapterInstance {
  id: string
  name: string
  transport: string
  version: string
  status: "在线" | "待配置" | "已停用"
  endpoint: string
  capabilities: string[]
  eventsToday: string
  lastSeen: string
}

export interface ModelRoute {
  id: string
  name: string
  purpose: string
  primaryModel: string
  fallbackModel: string
  successRate: number
  latency: string
  requestsToday: string
  status: "健康" | "降级"
}

export interface ProviderConnection {
  id: string
  name: string
  protocol: string
  modelCount: number
  status: "已连接" | "需关注"
  latency: string
  quota: string
}

export interface PluginModule {
  id: string
  name: string
  description: string
  category: string
  version: string
  enabled: boolean
  scope: string
  callsToday: string
}

export interface SessionRecord {
  id: string
  bot: string
  channel: string
  participant: string
  mode: string
  status: "活跃" | "等待" | "已归档"
  turns: number
  contextUsage: number
  updatedAt: string
}

export interface ActivityEvent {
  id: string
  title: string
  detail: string
  time: string
  type: "success" | "info" | "warning"
}

export interface SystemCheck {
  id: string
  name: string
  detail: string
  status: "正常" | "需关注"
  value: string
}

export interface RuntimeInfo {
  coreVersion: string
  apiVersion: string
  runtime: string
  uptime: string
  database: string
  queueDepth: number
  storageUsage: number
  storageLabel: string
}

export interface ConsoleSnapshot {
  generatedAt: string
  environment: string
  metrics: ConsoleMetric[]
  volume: number[]
  volumeLabels?: string[]
  volumeCounts?: number[]
  bots: BotProfile[]
  adapters: AdapterInstance[]
  modelRoutes: ModelRoute[]
  providers: ProviderConnection[]
  plugins: PluginModule[]
  sessions: SessionRecord[]
  activities: ActivityEvent[]
  checks: SystemCheck[]
  runtime: RuntimeInfo
}
