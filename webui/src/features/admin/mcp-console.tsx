import { useCallback, useState, type FormEvent } from "react"
import { Braces, Edit3, Plus, TestTube2 } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  AdminSubmitButton,
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
const transportOptions = [
  { value: "http", label: "Streamable HTTP" },
  { value: "stdio", label: "本地 stdio" },
]

function parseStringRecord(value: string, label: string): Record<string, string> {
  const text = value.trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`)
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
}

function parseArgs(value: string): string[] {
  const text = value.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("命令参数必须是字符串 JSON 数组")
  return parsed
}

export default function McpConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => (await client.bootstrap()).mcpServers, [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<McpServerProfile | "new" | null>(null)
  const [transport, setTransport] = useState<McpServerProfile["transport"]>("http")

  function edit(server: McpServerProfile | "new") {
    setTransport(server === "new" ? "http" : server.transport ?? "http")
    setEditing(server)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    let headers: Record<string, string> = {}
    let env: Record<string, string> = {}
    let args: string[] = []
    try {
      if (transport === "http") headers = parseStringRecord(formText(data, "headers"), "自定义 Header")
      else {
        env = parseStringRecord(formText(data, "env"), "环境变量")
        args = parseArgs(formText(data, "args"))
      }
    } catch (error) {
      await resource.mutate(() => Promise.reject(error))
      return
    }
    const profile: McpServerProfile & { secret?: string } = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      transport,
      url: transport === "http" ? formText(data, "url") : "",
      command: transport === "stdio" ? formText(data, "command") : "",
      args,
      ...(transport === "stdio" && formText(data, "cwd") ? { cwd: formText(data, "cwd") } : {}),
      env,
      ...(transport === "stdio" && formText(data, "secretEnv") ? { secretEnv: formText(data, "secretEnv") } : {}),
      authType: transport === "http" ? formText(data, "authType") as McpServerProfile["authType"] : "none",
      authHeader: transport === "http" ? formText(data, "authHeader") : "Authorization",
      headers,
      timeoutMs: formNumber(data, "timeoutMs"),
      maxTools: formNumber(data, "maxTools"),
      enabled: formBoolean(data, "enabled"),
      ...(formText(data, "secret") ? { secret: formText(data, "secret") } : {}),
    }
    const result = await resource.mutate(() => client.saveMcpServer(profile), "MCP 服务已保存，正在后台应用到 Bot")
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
        description="管理受信任的 Streamable HTTP 或本地 stdio MCP 服务；认证密钥只在服务端加密保存。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => edit("new")}><Plus data-icon="inline-start" /> 新增 MCP</Button>
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
                <Badge variant="outline">{server.transport ?? "http"}</Badge>
                {server.transport === "stdio" ? null : <Badge variant="outline">{server.authType}</Badge>}
                <Badge variant="secondary">最多 {server.maxTools} 个工具</Badge>
              </div>
              <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
                {server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}
              </p>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void resource.mutate(() => client.testMcpServer(server.id), `${server.label} 测试成功`)}>
                  <TestTube2 data-icon="inline-start" /> 测试
                </Button>
                <Button variant="outline" size="sm" onClick={() => edit(server)}>
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
            <DialogDescription>stdio 会在 Bot 主机内启动受信任命令；只配置你审核过的程序和参数。</DialogDescription>
          </DialogHeader>
          <AdminFeedback error={resource.error} notice={resource.notice} />
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={save}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="配置 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <SelectField
                label="传输方式"
                name="transport"
                value={transport}
                options={transportOptions}
                onValueChange={(value) => setTransport(value as McpServerProfile["transport"])}
              />
              <div />
              {transport === "http" ? <>
              <div className="sm:col-span-2">
                <FormField label="Streamable HTTP URL" name="url" type="url" defaultValue={editing === "new" ? "" : editing?.url} required />
              </div>
              <SelectField label="认证方式" name="authType" defaultValue={editing === "new" ? "none" : editing?.authType} options={authOptions} />
              <FormField label="认证 Header" name="authHeader" defaultValue={editing === "new" ? "Authorization" : editing?.authHeader} required />
              <FormField label="认证密钥" name="secret" type="password" placeholder={editing !== "new" && editing?.hasSecret ? "留空保留现有密钥" : "按认证方式填写"} />
              <div className="sm:col-span-2">
                <TextareaField
                  label="附加 Headers（JSON）"
                  name="headers"
                  rows={4}
                  defaultValue={JSON.stringify(editing === "new" ? {} : editing?.headers ?? {}, null, 2)}
                />
              </div>
              </> : <>
                <div className="sm:col-span-2">
                  <FormField label="命令" name="command" defaultValue={editing === "new" ? "" : editing?.command} required placeholder="uvx" />
                </div>
                <div className="sm:col-span-2">
                  <TextareaField
                    label="命令参数（JSON 数组）"
                    name="args"
                    rows={5}
                    defaultValue={JSON.stringify(editing === "new" ? [] : editing?.args ?? [], null, 2)}
                    description={'例如 ["--from", "package[extra]", "server-command"]；不会经过 shell 展开。'}
                  />
                </div>
                <FormField label="工作目录（可选）" name="cwd" defaultValue={editing === "new" ? "" : editing?.cwd} placeholder="/app" />
                <FormField label="密钥环境变量（可选）" name="secretEnv" defaultValue={editing === "new" ? "" : editing?.secretEnv} placeholder="API_KEY" />
                <div className="sm:col-span-2">
                  <TextareaField
                    label="环境变量（JSON）"
                    name="env"
                    rows={4}
                    defaultValue={JSON.stringify(editing === "new" ? {} : editing?.env ?? {}, null, 2)}
                    description="这里保存非敏感变量；敏感值请填写上面的环境变量名，并在密钥框输入值。"
                  />
                </div>
                <div className="sm:col-span-2">
                  <FormField label="加密密钥" name="secret" type="password" placeholder={editing !== "new" && editing?.hasSecret ? "留空保留现有密钥" : "仅在配置了密钥环境变量时需要"} />
                </div>
              </>}
              <FormField label="超时（ms）" name="timeoutMs" type="number" min={500} max={600000} defaultValue={editing === "new" ? 15000 : editing?.timeoutMs} required />
              <FormField label="最大工具数" name="maxTools" type="number" min={1} max={40} defaultValue={editing === "new" ? 20 : editing?.maxTools} required />
              <div className="sm:col-span-2">
                <CheckboxField label="启用此 MCP 服务" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <AdminSubmitButton pending={resource.mutating}>保存并应用</AdminSubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
