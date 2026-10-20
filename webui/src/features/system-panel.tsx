import {
  Activity,
  Braces,
  CheckCircle2,
  CircleAlert,
  Database,
  HardDrive,
  KeyRound,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from "lucide-react"

import { PageHeader, StatusPill } from "@/components/console-primitives"
import { Badge } from "@/components/ui/badge"
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
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { RuntimeInfo, SystemCheck } from "@/types/console"

const runtimeItems = [
  { key: "coreVersion", label: "Core 版本", icon: Braces },
  { key: "apiVersion", label: "管理 API", icon: ServerCog },
  { key: "runtime", label: "运行环境", icon: Activity },
  { key: "database", label: "持久化", icon: Database },
] as const

const apiResources = [
  { resource: "/api/status", method: "GET", description: "运行状态与健康摘要" },
  { resource: "/api/bots", method: "GET", description: "Bot 实例与编排配置" },
  { resource: "/api/adapters", method: "GET", description: "适配器注册与能力声明" },
  { resource: "/api/chatrooms", method: "GET", description: "会话索引、群配置与上下文状态" },
]

export function SystemPanel({ runtime, checks }: { runtime: RuntimeInfo; checks: SystemCheck[] }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="系统"
        title="运行、存储与管理接口"
        description="查看核心服务健康状态、版本信息和平台中性的管理 API。"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {runtimeItems.map((item) => {
          const Icon = item.icon
          const value = runtime[item.key]
          return (
            <Card key={item.key} size="sm" className="shadow-none">
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <StatusPill label="正常" />
                </div>
                <p className="mt-5 text-xs text-muted-foreground">{item.label}</p>
                <p className="mt-1 font-mono text-sm font-semibold">{value}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle>健康检查</CardTitle>
            <CardDescription>最近一次自动检查：刚刚</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" disabled>
                <RefreshCw data-icon="inline-start" />
                随页面刷新
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {checks.map((check, index) => (
              <div key={check.id}>
                <div className="flex items-center gap-3 py-3">
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
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
                    <p className="font-medium">{check.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{check.value}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{check.status}</p>
                  </div>
                </div>
                {index < checks.length - 1 ? <Separator /> : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="shadow-none">
            <CardHeader>
              <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950">
                <HardDrive className="size-4" />
              </div>
              <CardTitle>存储与队列</CardTitle>
              <CardDescription>运行数据使用情况</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">本地存储</span>
                  <span className="font-medium">{runtime.storageLabel}</span>
                </div>
                <Progress value={runtime.storageUsage} />
              </div>
              <div className="grid grid-cols-2 divide-x rounded-lg border bg-muted/20">
                <div className="p-3">
                  <p className="text-xs text-muted-foreground">待处理事件</p>
                  <p className="mt-1 text-lg font-semibold">{runtime.queueDepth}</p>
                </div>
                <div className="p-3">
                  <p className="text-xs text-muted-foreground">连续运行</p>
                  <p className="mt-1 text-sm font-semibold">{runtime.uptime}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-emerald-200 bg-emerald-50/50 shadow-none dark:border-emerald-900 dark:bg-emerald-950/20">
            <CardContent className="flex items-start gap-3 p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div>
                <p className="font-medium">安全检查已通过</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  管理令牌、敏感配置与运行数据均未进入前端构建产物。
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <CardTitle>管理 API</CardTitle>
          <CardDescription>WebUI 通过可替换数据源调用这些中性资源</CardDescription>
          <CardAction>
            <Badge variant="outline" className="font-mono">v1</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">资源</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>用途</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiResources.map((item) => (
                <TableRow key={item.resource}>
                  <TableCell className="pl-4 font-mono text-xs text-indigo-600 dark:text-indigo-300">
                    {item.resource}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono font-normal">{item.method}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        <CardFooter className="justify-between text-xs text-muted-foreground">
          <span>所有写操作需要管理权限</span>
          <span>API {runtime.apiVersion}</span>
        </CardFooter>
      </Card>
    </div>
  )
}
