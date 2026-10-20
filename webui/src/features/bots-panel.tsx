import { useState } from "react"
import {
  Bot,
  Cable,
  ChevronRight,
  Clock3,
  ExternalLink,
  MessageSquareText,
  MoreHorizontal,
  Route,
  Settings2,
} from "lucide-react"

import { ResourceDialog } from "@/components/action-dialogs"
import { PageHeader, StatusPill } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { BotProfile } from "@/types/console"

const botDetails = [
  { label: "模型路由", key: "model", icon: Route },
  { label: "适配器", key: "adapter", icon: Cable },
  { label: "触发方式", key: "trigger", icon: MessageSquareText },
] as const

export function BotsPanel({ bots }: { bots: BotProfile[] }) {
  const [selectedId, setSelectedId] = useState(bots[0]?.id ?? "")
  const selectedBot = bots.find((bot) => bot.id === selectedId) ?? bots[0]

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Bot 管理"
        title="编排 Bot 的行为与能力"
        description="Bot 只关注对话、模型和工具逻辑，消息收发由可替换的适配器提供。"
        action={<ResourceDialog kind="bot" />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)]">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle>Bot 实例</CardTitle>
            <CardDescription>{bots.length} 个实例 · 全部已部署</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 px-2">
            {bots.map((bot) => (
              <button
                type="button"
                key={bot.id}
                onClick={() => setSelectedId(bot.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  bot.id === selectedBot?.id && "bg-muted"
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  <Bot className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{bot.name}</span>
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    今日 {bot.sessionsToday.toLocaleString()} 个会话
                  </span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            ))}
          </CardContent>
          <CardFooter className="justify-between text-xs text-muted-foreground">
            <span>实例上限</span>
            <span>{bots.length} / 10</span>
          </CardFooter>
        </Card>

        {selectedBot ? (
          <Card className="shadow-none">
            <CardHeader className="border-b">
              <div className="mb-2 flex items-center gap-2">
                <StatusPill label={selectedBot.status} tone={selectedBot.status === "运行中" ? "positive" : "muted"} />
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock3 className="size-3" />
                  更新于 {selectedBot.updatedAt}
                </span>
              </div>
              <CardTitle className="text-lg">{selectedBot.name}</CardTitle>
              <CardDescription className="max-w-xl leading-6">{selectedBot.description}</CardDescription>
              <CardAction>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label={`${selectedBot.name}操作菜单`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <a href="#bots">
                        <ExternalLink /> 在 Bot 模块管理
                      </a>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-3">
                {botDetails.map((detail) => {
                  const Icon = detail.icon
                  const value =
                    detail.key === "model"
                      ? selectedBot.modelRoute
                      : detail.key === "adapter"
                        ? `${selectedBot.adapterCount} 个已绑定`
                        : selectedBot.triggerMode
                  return (
                    <div key={detail.key} className="rounded-xl border bg-muted/20 p-3.5">
                      <Icon className="size-4 text-muted-foreground" />
                      <p className="mt-3 text-xs text-muted-foreground">{detail.label}</p>
                      <p className="mt-1 truncate text-sm font-medium" title={value}>
                        {value}
                      </p>
                    </div>
                  )
                })}
              </div>

              <div>
                <div className="mb-4 flex items-center gap-2">
                  <Settings2 className="size-4 text-muted-foreground" />
                  <h2 className="font-medium">基础行为</h2>
                </div>
                <div className="space-y-4 rounded-xl border p-4">
                  <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
                    <Label htmlFor="trigger-mode">触发策略</Label>
                    <Select defaultValue="explicit" disabled>
                      <SelectTrigger id="trigger-mode" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="explicit">显式触发 + 私有会话</SelectItem>
                        <SelectItem value="all">处理所有可见消息</SelectItem>
                        <SelectItem value="command">仅命令触发</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Separator />
                  <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
                    <Label htmlFor="context-policy">上下文策略</Label>
                    <Select defaultValue="shared" disabled>
                      <SelectTrigger id="context-policy" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="shared">按会话共享上下文</SelectItem>
                        <SelectItem value="participant">按参与者隔离</SelectItem>
                        <SelectItem value="stateless">无状态处理</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label htmlFor="tool-confirmation">敏感工具二次确认</Label>
                      <p className="mt-1 text-xs text-muted-foreground">执行高影响操作前请求用户确认</p>
                    </div>
                    <Switch id="tool-confirmation" defaultChecked disabled />
                  </div>
                </div>
              </div>
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">请在 Bot 模块管理完整配置</span>
              <Button asChild>
                <a href="#bots">
                  在 Bot 模块修改
                  <ExternalLink data-icon="inline-end" />
                </a>
              </Button>
            </CardFooter>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
