/* eslint-disable react-refresh/only-export-components */
import { lazy } from "react"
import {
  Activity,
  Bot,
  Boxes,
  Braces,
  BrainCircuit,
  Cable,
  ClipboardCheck,
  Cloud,
  FileClock,
  Globe2,
  MessageSquareText,
  Settings2,
  SmilePlus,
  SlidersHorizontal,
  UserRoundCog,
} from "lucide-react"

import type { ConsoleModule, ConsoleModuleProps } from "@/console/types"
import { OverviewPanel } from "@/features/overview-panel"
import { SystemPanel } from "@/features/system-panel"
import type { ConsoleManifest } from "@/types/admin"

const ProvidersConsole = lazy(() => import("@/features/admin/providers-console"))
const BotsConsole = lazy(() => import("@/features/admin/bots-console"))
const AdaptersConsole = lazy(() => import("@/features/admin/adapters-console"))
const PluginsConsole = lazy(() => import("@/features/admin/plugins-console"))
const ChatroomsConsole = lazy(() => import("@/features/admin/chatrooms-console"))
const EmojisConsole = lazy(() => import("@/features/admin/emojis-console"))
const ParticipationConsole = lazy(() => import("@/features/admin/participation-console"))
const ModelsConsole = lazy(() => import("@/features/admin/models-console"))
const KnowledgeConsole = lazy(() => import("@/features/admin/knowledge-console"))
const McpConsole = lazy(() => import("@/features/admin/mcp-console"))
const PersonasConsole = lazy(() => import("@/features/admin/personas-console"))
const SettingsConsole = lazy(() => import("@/features/admin/settings-console"))
const LogsConsole = lazy(() => import("@/features/admin/logs-console"))

function OverviewModule({ snapshot }: ConsoleModuleProps) {
  return <OverviewPanel snapshot={snapshot} />
}

function SystemModule({ snapshot }: ConsoleModuleProps) {
  return <SystemPanel runtime={snapshot.runtime} checks={snapshot.checks} />
}

const registeredConsoleModules: ConsoleModule[] = [
  {
    id: "overview",
    label: "总览",
    description: "运行状态与关键指标",
    group: "runtime",
    icon: Activity,
    component: OverviewModule,
  },
  {
    id: "bots",
    label: "Bot",
    description: "实例、行为与触发规则",
    group: "runtime",
    icon: Bot,
    component: BotsConsole,
    order: 10,
  },
  {
    id: "adapters",
    label: "适配器",
    description: "消息通道与能力声明",
    group: "runtime",
    icon: Cable,
    component: AdaptersConsole,
    order: 20,
  },
  {
    id: "providers",
    label: "Provider",
    description: "模型服务与连接凭据",
    group: "intelligence",
    icon: Cloud,
    component: ProvidersConsole,
    order: 10,
  },
  {
    id: "models",
    label: "模型",
    description: "模型服务与路由策略",
    group: "intelligence",
    icon: BrainCircuit,
    component: ModelsConsole,
    order: 20,
  },
  {
    id: "knowledge",
    label: "知识服务",
    description: "检索与知识库连接",
    group: "intelligence",
    icon: Globe2,
    component: KnowledgeConsole,
    order: 30,
  },
  {
    id: "mcp",
    label: "MCP",
    description: "外部工具服务器",
    group: "intelligence",
    icon: Braces,
    component: McpConsole,
    order: 40,
  },
  {
    id: "personas",
    label: "人格",
    description: "系统提示词与身份模板",
    group: "intelligence",
    icon: UserRoundCog,
    component: PersonasConsole,
    order: 50,
  },
  {
    id: "plugins",
    label: "插件",
    description: "工具能力与权限范围",
    group: "intelligence",
    icon: Boxes,
    component: PluginsConsole,
    order: 60,
  },
  {
    id: "chatrooms",
    label: "群聊",
    description: "配置、历史、任务与记忆",
    group: "conversations",
    icon: MessageSquareText,
    component: ChatroomsConsole,
  },
  {
    id: "participation",
    label: "参与学习",
    description: "接话决策与回复质量复核",
    group: "conversations",
    icon: ClipboardCheck,
    component: ParticipationConsole,
    order: 20,
  },
  {
    id: "emojis",
    label: "表情包",
    description: "素材、描述与思考反馈",
    group: "conversations",
    icon: SmilePlus,
    component: EmojisConsole,
  },
  {
    id: "settings",
    label: "设置",
    description: "全局默认值与保留策略",
    group: "system",
    icon: SlidersHorizontal,
    component: SettingsConsole,
    order: 10,
  },
  {
    id: "logs",
    label: "日志",
    description: "筛选、排障与日志清理",
    group: "system",
    icon: FileClock,
    component: LogsConsole,
    order: 20,
  },
  {
    id: "system",
    label: "系统",
    description: "运行时、存储与接口",
    group: "system",
    icon: Settings2,
    component: SystemModule,
    order: 30,
  },
]

export const coreConsoleModules = registeredConsoleModules

export function consoleModulesFor(manifest: ConsoleManifest): ConsoleModule[] {
  return manifest.modules.includes("core") ? coreConsoleModules : []
}
