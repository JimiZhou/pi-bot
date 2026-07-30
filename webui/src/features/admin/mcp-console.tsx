import { useCallback, useState, type FormEvent } from "react"
import { Braces, Edit3, Plus, TestTube2 } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  CheckboxField,
  ConfirmButton,
  FormField,
  ReloadButton,
  SelectField,
  TextareaField,
} from "@/components/admin-primitives"
import { PageHeader, StatusPill } from "@/components/console-primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formNumber, formText } from "@/lib/form-data"
import type { McpServerProfile } from "@/types/admin"

const authOptions = [
  { value: "none", label: "无认证" },
  { value: "bearer", label: "Bearer Token" },
  { value: "api-key", label: "API Key Header" },
]

function parseHeaders(value: string): Record<string, string> {
  const text = value.trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("自定义 Header 必须是 JSON 对象")
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
}

export default function McpConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => (await client.bootstrap()).mcpServers, [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<McpServerProfile | "new" | null>(null)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    let headers: Record<string, string>
    try {
      headers = parseHeaders(formText(data, "headers"))
    } catch (error) {
      await resource.mutate(() => Promise.reject(error))
      return
    }
    const profile: McpServerProfile & { secret?: string } = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      url: formText(data, "url"),
      authType: formText(data, "authType") as McpServerProfile["authType"],
      authHeader: formText(data, "authHeader"),
      headers,
      timeoutMs: formNumber(data, "timeoutMs"),
      maxTools: formNumber(data, "maxTools"),
      enabled: formBoolean(data, "enabled"),
      ...(formText(data, "secret") ? { secret: formText(data, "secret") } : {}),
    }
    const result = await resource.mutate(() => client.saveMcpServer(profile), "MCP 服务已保存")
    if (result) {
      setEditing(null)
      await refreshSnapshot()
    }
  }

  const servers = resource.data ?? []
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI 配置"
        title="MCP 服务"
        description="管理受信任的 Streamable HTTP MCP 服务和工具上限；认证密钥只在服务端保存。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => setEditing("new")}><Plus data-icon="inline-start" /> 新增 MCP</Button>
          </>
        }
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载 MCP 服务" /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {servers.map((server) => (
          <Card key={server.id} className="shadow-none">
            <CardHeader>
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                <Braces className="size-5" />
              </span>
              <CardTitle>{server.label}</CardTitle>
              <CardDescription className="font-mono">{server.id}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <StatusPill label={server.enabled ? "已启用" : "已停用"} tone={server.enabled ? "positive" : "muted"} />
                <Badge variant="outline">{server.authType}</Badge>
                <Badge variant="secondary">最多 {server.maxTools} 个工具</Badge>
              </div>
              <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">{server.url}</p>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void resource.mutate(() => client.testMcpServer(server.id), `${server.label} 测试成功`)}>
                  <TestTube2 data-icon="inline-start" /> 测试
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(server)}>
                  <Edit3 data-icon="inline-start" /> 编辑
                </Button>
              </div>
              <ConfirmButton
                title={`删除 ${server.label}？`}
                description="删除后，所有 Bot 将不再加载该 MCP 服务提供的工具。"
                onConfirm={() => void resource.mutate(() => client.deleteMcpServer(server.id), "MCP 服务已删除")}
              />
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "新增 MCP 服务" : "编辑 MCP 服务"}</DialogTitle>
            <DialogDescription>当前只允许远程 HTTP 服务，不会执行服务端 stdio 命令。</DialogDescription>
          </DialogHeader>
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={save}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="配置 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <div className="sm:col-span-2">
                <FormField label="Streamable HTTP URL" name="url" type="url" defaultValue={editing === "new" ? "" : editing?.url} required />
              </div>
              <SelectField label="认证方式" name="authType" defaultValue={editing === "new" ? "none" : editing?.authType} options={authOptions} />
              <FormField label="认证 Header" name="authHeader" defaultValue={editing === "new" ? "Authorization" : editing?.authHeader} required />
              <FormField label="认证密钥" name="secret" type="password" placeholder={editing !== "new" && editing?.hasSecret ? "留空保留现有密钥" : "按认证方式填写"} />
              <FormField label="超时（ms）" name="timeoutMs" type="number" min={1000} defaultValue={editing === "new" ? 15000 : editing?.timeoutMs} required />
              <FormField label="最大工具数" name="maxTools" type="number" min={1} max={100} defaultValue={editing === "new" ? 20 : editing?.maxTools} required />
              <div className="sm:col-span-2">
                <TextareaField
                  label="附加 Headers（JSON）"
                  name="headers"
                  rows={4}
                  defaultValue={JSON.stringify(editing === "new" ? {} : editing?.headers ?? {}, null, 2)}
                />
              </div>
              <div className="sm:col-span-2">
                <CheckboxField label="启用此 MCP 服务" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button type="submit">保存并应用</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
