import {
  ArrowRight,
  BrainCircuit,
  CircleAlert,
  Cloud,
  Cpu,
  Gauge,
  MoreHorizontal,
  Route,
  Server,
  Zap,
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
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ModelRoute, ProviderConnection } from "@/types/console"

const routeIcons = [BrainCircuit, Gauge, Zap]
const providerIcons = [Cloud, Cloud, Server]

export function ModelsPanel({ routes, providers }: { routes: ModelRoute[]; providers: ProviderConnection[] }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="模型"
        title="统一模型路由与故障转移"
        description="按用途配置主模型和备用模型，让 Bot 依赖稳定路由而不是单一服务商。"
        action={<ResourceDialog kind="model" />}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {routes.map((route, index) => {
          const Icon = routeIcons[index % routeIcons.length]
          return (
            <Card key={route.id} className="shadow-none">
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Icon className="size-5" />
                  </span>
                  <StatusPill label={route.status} tone={route.status === "健康" ? "positive" : "warning"} />
                </div>
                <CardTitle>{route.name}</CardTitle>
                <CardDescription>{route.purpose}</CardDescription>
                <CardAction className="mt-13">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${route.name}操作菜单`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>编辑路由</DropdownMenuItem>
                      <DropdownMenuItem>查看请求日志</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border p-3.5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>主模型</span>
                    <ArrowRight className="size-3" />
                    <span>备用模型</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 font-mono text-xs font-medium">
                    <span className="min-w-0 flex-1 truncate">{route.primaryModel}</span>
                    <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{route.fallbackModel}</span>
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">请求成功率</span>
                    <span className="font-semibold">{route.successRate}%</span>
                  </div>
                  <Progress value={route.successRate} />
                </div>
              </CardContent>
              <CardFooter className="grid grid-cols-2 divide-x p-0">
                <div className="px-4 py-3">
                  <p className="text-[11px] text-muted-foreground">今日请求</p>
                  <p className="mt-1 text-sm font-semibold">{route.requestsToday}</p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-[11px] text-muted-foreground">P50 延迟</p>
                  <p className="mt-1 text-sm font-semibold">{route.latency}</p>
                </div>
              </CardFooter>
            </Card>
          )
        })}
      </div>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Cpu className="size-4" />
          </div>
          <CardTitle>模型服务连接</CardTitle>
          <CardDescription>兼容原生接口与通用协议的模型服务</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm">添加连接</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">服务</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>延迟</TableHead>
                <TableHead>资源</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider, index) => {
                const Icon = providerIcons[index % providerIcons.length]
                return (
                  <TableRow key={provider.id}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 items-center justify-center rounded-lg border bg-background">
                          <Icon className="size-4 text-muted-foreground" />
                        </span>
                        <span className="font-medium">{provider.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono font-normal">{provider.protocol}</Badge>
                    </TableCell>
                    <TableCell>{provider.modelCount}</TableCell>
                    <TableCell>{provider.latency}</TableCell>
                    <TableCell className="text-muted-foreground">{provider.quota}</TableCell>
                    <TableCell>
                      <StatusPill
                        label={provider.status}
                        tone={provider.status === "已连接" ? "positive" : "warning"}
                      />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={`${provider.name}设置`}>
                        {provider.status === "需关注" ? <CircleAlert /> : <Route />}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
