import { useCallback } from "react"
import {
  Activity,
  Bot,
  Cable,
  CheckCircle2,
  FileJson2,
  RadioTower,
  Settings2,
} from "lucide-react"

import { AdminFeedback, AdminLoading, ReloadButton } from "@/components/admin-primitives"
import { EmptyState, PageHeader, StatusPill } from "@/components/console-primitives"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { adapterAdminExtensions } from "@/extensions/adapter-admin-registry"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"

export default function AdaptersConsole() {
  const { client } = useAdmin()
  const load = useCallback(() => client.adapters(), [client])
  const resource = useAdminResource(load)
  const payload = resource.data

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="适配器"
        title="标准化消息通道"
        description="Core 只读取 Adapter Manifest 和统一生命周期；协议表单由独立 Console 扩展注册。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载 Adapter" /> : null}
      {payload && payload.instances.length === 0 ? (
        <EmptyState title="没有 Adapter 实例" description="进入 Bot 页面新增实例并选择通道类型。" />
      ) : null}
      {payload ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {payload.instances.map((adapter) => (
            <Card key={adapter.id} className="shadow-none">
              <CardHeader>
                <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  <RadioTower className="size-5" />
                </span>
                <CardTitle>{adapter.displayName}</CardTitle>
                <CardDescription>{adapter.id} · {adapter.botId}</CardDescription>
                <CardAction>
                  <StatusPill
                    label={adapter.phase}
                    tone={adapter.healthy ? "positive" : adapter.enabled ? "warning" : "muted"}
                  />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{adapter.type}</Badge>
                  {adapter.capabilities.map((capability) => (
                    <Badge key={capability.id} variant="outline" className="font-mono">
                      {capability.id}@{capability.version}
                    </Badge>
                  ))}
                </div>
                <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
                  {adapter.endpoint ?? "未公布 Endpoint"}
                </p>
              </CardContent>
              <CardFooter className="justify-between">
                <span className="text-xs text-muted-foreground">
                  {adapter.lastEventAt ? `最后事件 ${new Date(adapter.lastEventAt).toLocaleString("zh-CN")}` : "暂无事件"}
                </span>
                <Button asChild variant="outline" size="sm">
                  <a href="#bots"><Settings2 data-icon="inline-start" /> 配置</a>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : null}

      {payload ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
          <Card className="shadow-none">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2"><FileJson2 className="size-4" /> Adapter Manifest</CardTitle>
              <CardDescription>这些声明来自运行时注册表，不由前端硬编码。</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">类型</TableHead>
                    <TableHead>API</TableHead>
                    <TableHead>Feature</TableHead>
                    <TableHead>Capability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payload.manifests.map((manifest) => (
                    <TableRow key={manifest.type}>
                      <TableCell className="pl-4">
                        <p className="font-medium">{manifest.displayName}</p>
                        <p className="font-mono text-xs text-muted-foreground">{manifest.type}</p>
                      </TableCell>
                      <TableCell><Badge variant="secondary">v{manifest.apiVersion}</Badge></TableCell>
                      <TableCell>{manifest.features?.length ?? 0}</TableCell>
                      <TableCell>{manifest.capabilities?.length ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="border-indigo-200 bg-indigo-50/40 shadow-none dark:border-indigo-900 dark:bg-indigo-950/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Cable className="size-4" /> Console 扩展</CardTitle>
              <CardDescription>本地微信版本提供以下配置编辑器，Core Console 无需理解协议字段。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {adapterAdminExtensions.map((extension) => (
                <div key={extension.type} className="rounded-lg border bg-background/70 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="size-4 text-emerald-600" /> {extension.label}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{extension.description}</p>
                </div>
              ))}
            </CardContent>
            <CardFooter>
              <Button asChild className="w-full">
                <a href="#bots"><Bot data-icon="inline-start" /> 在 Bot 中绑定 Adapter</a>
              </Button>
            </CardFooter>
          </Card>
        </div>
      ) : null}

      <div className="flex items-center gap-2 rounded-xl border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <Activity className="size-4" />
        生命周期、健康检查与消息能力由 Adapter API v1 统一；新增其他平台时只需注册 Manifest 和 Console 扩展。
      </div>
    </div>
  )
}
