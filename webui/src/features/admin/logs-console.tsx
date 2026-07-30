import { useCallback, useDeferredValue, useState } from "react"
import { FileClock, Search, Trash2 } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  ConfirmButton,
  ReloadButton,
} from "@/components/admin-primitives"
import { PageHeader } from "@/components/console-primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"

function levelVariant(level: string): "secondary" | "outline" | "destructive" {
  if (level === "error") return "destructive"
  if (level === "warn") return "secondary"
  return "outline"
}

export default function LogsConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState("")
  const [botId, setBotId] = useState("")
  const deferredQuery = useDeferredValue(query)
  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" })
    if (deferredQuery.trim()) params.set("q", deferredQuery.trim())
    if (level) params.set("level", level)
    if (botId) params.set("botId", botId)
    return client.logs(`?${params}`)
  }, [botId, client, deferredQuery, level])
  const resource = useAdminResource(load)
  const logs = resource.data?.logs ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="系统"
        title="日志"
        description="查询结构化生命周期、通道、Agent 和配置审计记录。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件或消息" className="pl-8" />
            </div>
            <select value={level} onChange={(event) => setLevel(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
              <option value="">全部等级</option>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <Input value={botId} onChange={(event) => setBotId(event.target.value)} placeholder="Bot ID" className="lg:w-48" />
            <ConfirmButton
              title="立即清理过期日志？"
              description="将按照全局保留天数和最大行数执行清理。"
              confirmLabel="确认清理"
              onConfirm={() => void resource.mutate(async () => {
                const result = await client.pruneLogs()
                await refreshSnapshot()
                return result
              }, "日志清理完成")}
            >
              <Trash2 data-icon="inline-start" /> 清理
            </ConfirmButton>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {resource.loading ? <AdminLoading label="正在加载日志" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">时间</TableHead>
                  <TableHead>等级</TableHead>
                  <TableHead>范围</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>消息</TableHead>
                  <TableHead>Bot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="pl-4 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell><Badge variant={levelVariant(log.level)}>{log.level}</Badge></TableCell>
                    <TableCell className="text-xs">{log.scope}</TableCell>
                    <TableCell className="font-mono text-xs">{log.event}</TableCell>
                    <TableCell className="max-w-xl whitespace-normal">{log.message}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{log.botId ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!resource.loading && logs.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-muted-foreground">
              <FileClock className="mb-3 size-8" />
              <p className="text-sm">没有匹配的日志</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => void resource.reload()} disabled={resource.refreshing}>重新加载最近 200 条</Button>
      </div>
    </div>
  )
}
