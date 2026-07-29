import {
  ArrowUpRight,
  Braces,
  Cable,
  CheckCircle2,
  CircleDot,
  FileJson2,
  MoreHorizontal,
  RadioTower,
  RefreshCw,
  TerminalSquare,
} from "lucide-react"

import { ResourceDialog } from "@/components/action-dialogs"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AdapterInstance } from "@/types/console"

const adapterIcons = [RadioTower, Cable, TerminalSquare]

const contractRows = [
  { field: "manifest.id", required: "必需", description: "全局唯一的适配器标识" },
  { field: "apiVersion", required: "必需", description: "核心兼容版本，用于协商行为" },
  { field: "capabilities", required: "必需", description: "入站、出站与媒体能力声明" },
  { field: "limits", required: "可选", description: "消息长度、速率与资源约束" },
]

export function AdaptersPanel({ adapters }: { adapters: AdapterInstance[] }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="适配器"
        title="连接任意消息通道"
        description="适配器通过统一能力声明接入消息事件；具体协议、鉴权和传输细节留在独立实现中。"
        action={<ResourceDialog kind="adapter" />}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {adapters.map((adapter, index) => {
          const Icon = adapterIcons[index % adapterIcons.length]
          return (
            <Card key={adapter.id} className="shadow-none">
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                    <Icon className="size-5" />
                  </span>
                  <StatusPill
                    label={adapter.status}
                    tone={adapter.status === "在线" ? "positive" : adapter.status === "待配置" ? "warning" : "muted"}
                  />
                </div>
                <CardTitle>{adapter.name}</CardTitle>
                <CardDescription>{adapter.transport} · v{adapter.version}</CardDescription>
                <CardAction className="mt-13">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${adapter.name}操作菜单`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>
                        <RefreshCw /> 重新同步能力
                      </DropdownMenuItem>
                      <DropdownMenuItem>编辑连接配置</DropdownMenuItem>
                      <DropdownMenuItem>查看事件日志</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border bg-muted/30 px-3 py-2.5 font-mono text-xs text-muted-foreground">
                  {adapter.endpoint}
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">已声明能力</p>
                  <div className="flex flex-wrap gap-1.5">
                    {adapter.capabilities.map((capability) => (
                      <Badge key={capability} variant="secondary" className="font-mono font-normal">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="justify-between text-xs text-muted-foreground">
                <span>{adapter.eventsToday} 个事件</span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="size-3 text-emerald-500" /> {adapter.lastSeen}
                </span>
              </CardFooter>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.75fr)]">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileJson2 className="size-4" />
            </div>
            <CardTitle>能力声明规范</CardTitle>
            <CardDescription>核心只依赖以下中性字段，不感知底层消息平台或通信协议。</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">字段</TableHead>
                  <TableHead>要求</TableHead>
                  <TableHead>用途</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contractRows.map((row) => (
                  <TableRow key={row.field}>
                    <TableCell className="pl-4 font-mono text-xs text-indigo-600 dark:text-indigo-300">
                      {row.field}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.required === "必需" ? "secondary" : "outline"}>{row.required}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.description}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-indigo-200 bg-indigo-50/40 shadow-none dark:border-indigo-900 dark:bg-indigo-950/20">
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">
              <Braces className="size-4" />
            </div>
            <CardTitle>开发适配器</CardTitle>
            <CardDescription className="leading-6">
              实现标准生命周期、事件收发和能力描述接口，即可被 Core 自动发现。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              "声明可处理的消息与媒体类型",
              "实现统一入站事件转换",
              "提供出站派发与健康检查",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-indigo-600" />
                <span>{item}</span>
              </div>
            ))}
          </CardContent>
          <CardFooter className="border-indigo-200 bg-indigo-100/60 dark:border-indigo-900 dark:bg-indigo-900/30">
            <Button variant="outline" className="w-full justify-between bg-background">
              查看开发文档
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
