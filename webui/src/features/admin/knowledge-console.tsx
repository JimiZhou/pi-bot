import { useCallback, useState, type FormEvent } from "react"
import { Edit3, Globe2, Plus, SearchCheck } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  CheckboxField,
  ConfirmButton,
  FormField,
  ReloadButton,
  SelectField,
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
import type { KnowledgeProviderProfile } from "@/types/admin"

const kindOptions = [
  { value: "searxng", label: "SearXNG" },
  { value: "brave", label: "Brave Search" },
  { value: "tavily", label: "Tavily" },
]

export default function KnowledgeConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => (await client.bootstrap()).knowledgeProviders, [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<KnowledgeProviderProfile | "new" | null>(null)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const profile: KnowledgeProviderProfile & { apiKey?: string } = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      kind: formText(data, "kind") as KnowledgeProviderProfile["kind"],
      baseUrl: formText(data, "baseUrl"),
      timeoutMs: formNumber(data, "timeoutMs"),
      maxResults: formNumber(data, "maxResults"),
      enabled: formBoolean(data, "enabled"),
      ...(formText(data, "apiKeyEnv") ? { apiKeyEnv: formText(data, "apiKeyEnv") } : {}),
      ...(formText(data, "apiKey") ? { apiKey: formText(data, "apiKey") } : {}),
    }
    const result = await resource.mutate(() => client.saveKnowledgeProvider(profile), "联网检索配置已保存")
    if (result) {
      setEditing(null)
      await refreshSnapshot()
    }
  }

  const providers = resource.data ?? []
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI 配置"
        title="联网检索"
        description="管理提供时效性证据的搜索服务；返回内容始终作为不可信外部证据处理。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => setEditing("new")}><Plus data-icon="inline-start" /> 新增检索源</Button>
          </>
        }
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载检索源" /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((provider) => (
          <Card key={provider.id} className="shadow-none">
            <CardHeader>
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">
                <Globe2 className="size-5" />
              </span>
              <CardTitle>{provider.label}</CardTitle>
              <CardDescription className="font-mono">{provider.id}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{provider.kind}</Badge>
                <StatusPill label={provider.enabled ? "已启用" : "已停用"} tone={provider.enabled ? "positive" : "muted"} />
                <Badge variant="outline">{provider.maxResults} 条 / {provider.timeoutMs} ms</Badge>
              </div>
              <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">{provider.baseUrl}</p>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void resource.mutate(() => client.testKnowledgeProvider(provider.id), `${provider.label} 测试成功`)}>
                  <SearchCheck data-icon="inline-start" /> 测试
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(provider)}>
                  <Edit3 data-icon="inline-start" /> 编辑
                </Button>
              </div>
              <ConfirmButton
                title={`删除 ${provider.label}？`}
                description="全局默认检索源不能删除。"
                onConfirm={() => void resource.mutate(() => client.deleteKnowledgeProvider(provider.id), "检索源已删除")}
              />
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "新增检索源" : "编辑检索源"}</DialogTitle>
            <DialogDescription>SearXNG 可以不配置密钥；Brave 和 Tavily 必须提供密钥或环境变量。</DialogDescription>
          </DialogHeader>
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={save}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="配置 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <SelectField label="检索服务" name="kind" defaultValue={editing === "new" ? "searxng" : editing?.kind} options={kindOptions} />
              <FormField label="Base URL" name="baseUrl" type="url" defaultValue={editing === "new" ? "" : editing?.baseUrl} required />
              <FormField label="超时（ms）" name="timeoutMs" type="number" min={1000} defaultValue={editing === "new" ? 15000 : editing?.timeoutMs} required />
              <FormField label="最大结果数" name="maxResults" type="number" min={1} max={20} defaultValue={editing === "new" ? 5 : editing?.maxResults} required />
              <FormField label="API Key 环境变量" name="apiKeyEnv" defaultValue={editing === "new" ? "" : editing?.apiKeyEnv} />
              <FormField label="API Key" name="apiKey" type="password" placeholder={editing !== "new" && editing?.hasApiKey ? "留空保留现有密钥" : "可选"} />
              <div className="sm:col-span-2">
                <CheckboxField label="启用此检索源" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
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
