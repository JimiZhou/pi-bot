import {
  Activity,
  Bot,
  Cable,
  CheckCircle2,
  CircleAlert,
  Clock3,
  MessageSquareText,
  MoreHorizontal,
  Route,
} from "lucide-react"

import { ResourceDialog } from "@/components/action-dialogs"
import { MetricCard, PageHeader, StatusPill } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import type { ConsoleSnapshot } from "@/types/console"

const metricIcons = [
  <Bot className="size-4" key="bot" />,
  <Cable className="size-4" key="adapter" />,
  <MessageSquareText className="size-4" key="session" />,
  <Activity className="size-4" key="success" />,
]

const flowSteps = [
  { label: "消息事件", icon: MessageSquareText },
  { label: "能力适配", icon: Cable },
  { label: "Bot 编排", icon: Bot },
  { label: "模型路由", icon: Route },
]

export function OverviewPanel({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="运行总览"
        title="系统运行稳定"
        description="在一个视图中掌握 Bot、适配器、模型路由和会话处理状态。"
        action={<ResourceDialog kind="session" />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {snapshot.metrics.map((metric, index) => (
          <MetricCard key={metric.label} metric={metric} icon={metricIcons[index]} />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(19rem,1fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Bot 入站负载</CardTitle>
            <CardDescription>当前进程启动以来，各 Bot 接收的消息量对比</CardDescription>
            <CardAction>
              <StatusPill label="实时" tone="neutral" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex h-56 items-end gap-1.5 border-b border-border/80 pb-3" aria-label="过去 24 小时消息处理量柱状图">
              {snapshot.volume.map((value, index) => (
                <div
                  key={`${index}-${value}`}
                  className="group relative flex h-full min-w-0 flex-1 items-end"
                  title={`${snapshot.volumeLabels?.[index] ?? `Bot ${index + 1}`} · ${snapshot.volumeCounts?.[index] ?? value} 条`}
                >
                  <div
                    className="w-full rounded-t-sm bg-indigo-200 transition-colors group-hover:bg-indigo-500 dark:bg-indigo-900 dark:group-hover:bg-indigo-500"
                    style={{ height: `${value}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-around gap-2 text-xs text-muted-foreground">
              {snapshot.volumeLabels?.map((label, index) => (
                <span key={label} className="truncate" title={label}>
                  {label} · {(snapshot.volumeCounts?.[index] ?? 0).toLocaleString()}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>系统健康</CardTitle>
            <CardDescription>核心依赖与处理链路</CardDescription>
            <CardAction>
              <StatusPill label={`${snapshot.checks.filter((check) => check.status === "正常").length} 正常`} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {snapshot.checks.map((check, index) => (
              <div key={check.id}>
                <div className="flex items-center gap-3 py-3">
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                      check.status === "正常"
                        ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950"
                        : "bg-amber-50 text-amber-600 dark:bg-amber-950"
                    }`}
                  >
                    {check.status === "正常" ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      <CircleAlert className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{check.name}</p>
                      <span className="text-xs font-medium text-muted-foreground">{check.value}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{check.detail}</p>
                  </div>
                </div>
                {index < snapshot.checks.length - 1 ? <Separator /> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.35fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>处理链路</CardTitle>
            <CardDescription>平台无关 Core + 外部 Adapter</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {flowSteps.map((step, index) => {
                const Icon = step.icon
                return (
                  <div key={step.label} className="relative flex items-center gap-3 py-2.5">
                    {index < flowSteps.length - 1 ? (
                      <span className="absolute top-10 bottom-[-0.45rem] left-[1.05rem] w-px bg-border" />
                    ) : null}
                    <span className="relative z-10 flex size-9 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="font-medium">{step.label}</span>
                      <span className="text-xs text-muted-foreground">{index === 0 ? "标准事件" : "已就绪"}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>最近动态</CardTitle>
            <CardDescription>配置与运行事件</CardDescription>
            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="动态菜单">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>查看全部事件</DropdownMenuItem>
                  <DropdownMenuItem>导出运行日志</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {snapshot.activities.map((activity, index) => (
              <div key={activity.id}>
                <div className="flex items-start gap-3 py-3">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      activity.type === "success"
                        ? "bg-emerald-500"
                        : activity.type === "warning"
                          ? "bg-amber-500"
                          : "bg-indigo-500"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{activity.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{activity.detail}</p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="size-3" />
                    {activity.time}
                  </span>
                </div>
                {index < snapshot.activities.length - 1 ? <Separator /> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="border-indigo-200 bg-indigo-50/50 shadow-none dark:border-indigo-900 dark:bg-indigo-950/20">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <p className="font-medium">运行时 Heap 使用 {snapshot.runtime.storageUsage}%</p>
            <p className="mt-1 text-xs text-muted-foreground">{snapshot.runtime.storageLabel}</p>
          </div>
          <div className="w-full sm:w-64">
            <Progress value={snapshot.runtime.storageUsage} aria-label="存储空间使用率" />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
