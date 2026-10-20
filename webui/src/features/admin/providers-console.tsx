import { useCallback, useState, type FormEvent } from "react"
import { Cloud, Edit3, Plus, RadioTower, TestTube2 } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  AdminSubmitButton,
  CheckboxField,
  ConfirmButton,
  FormField,
  ReloadButton,
  SelectField,
} from "@/components/admin-primitives"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formText } from "@/lib/form-data"
import type { ManagedProviderApi, ProviderProfile } from "@/types/admin"

const providerApiOptions = [
  { value: "auto", label: "自动探测（保存前需测试）" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
]

export default function ProvidersConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => (await client.bootstrap()).providers, [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<ProviderProfile | "new" | null>(null)

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const profile: ProviderProfile & { apiKey?: string } = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      provider: formText(data, "provider"),
      api: formText(data, "api") as ManagedProviderApi,
      baseUrl: formText(data, "baseUrl"),
      enabled: formBoolean(data, "enabled"),
      ...(formText(data, "apiKeyEnv") ? { apiKeyEnv: formText(data, "apiKeyEnv") } : {}),
      ...(formText(data, "apiKey") ? { apiKey: formText(data, "apiKey") } : {}),
    }
    const saved = await resource.mutate(() => client.saveProvider(profile), "Provider 已保存，正在后台应用到 Bot")
    if (saved) {
      setEditing(null)
      await refreshSnapshot()
    }
  }

  const providers = resource.data ?? []
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI 配置"
        title="Provider"
        description="管理模型服务连接、协议和加密凭据。API Key 不会回传到浏览器。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" /> 新增 Provider
            </Button>
          </>
        }
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载 Provider" /> : null}
      {!resource.loading ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <Card key={provider.id} className="shadow-none">
              <CardHeader>
                <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  <Cloud className="size-5" />
                </span>
                <CardTitle>{provider.label}</CardTitle>
                <CardDescription className="font-mono">{provider.id}</CardDescription>
                <CardAction>
                  <StatusPill label={provider.enabled ? "已启用" : "已停用"} tone={provider.enabled ? "positive" : "muted"} />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{provider.provider}</Badge>
                  <Badge variant="outline">{provider.api}</Badge>
                  <Badge variant={provider.hasApiKey ? "secondary" : "outline"}>
                    {provider.hasApiKey || provider.apiKeyEnv ? "凭据已配置" : "无凭据"}
                  </Badge>
                </div>
                <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground" title={provider.baseUrl}>
                  {provider.baseUrl}
                </p>
              </CardContent>
              <CardFooter className="flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void resource.mutate(() => client.testProvider(provider.id), `${provider.label} 连接测试成功`)}
                  >
                    <TestTube2 data-icon="inline-start" /> 测试
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(provider)}>
                    <Edit3 data-icon="inline-start" /> 编辑
                  </Button>
                </div>
                <ConfirmButton
                  title={`删除 ${provider.label}？`}
                  description="只有未被模型引用的 Provider 才能删除。此操作不会删除环境变量中的密钥。"
                  onConfirm={() => void resource.mutate(() => client.deleteProvider(provider.id), "Provider 已删除")}
                />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : null}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "新增 Provider" : "编辑 Provider"}</DialogTitle>
            <DialogDescription>可以先使用自动探测，确认协议后再保存。保存会立即返回，受影响的 Bot 将在后台重启应用。</DialogDescription>
          </DialogHeader>
          <AdminFeedback error={resource.error} notice={resource.notice} />
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={saveProvider}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="配置 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <FormField label="Provider 标识" name="provider" defaultValue={editing === "new" ? "" : editing?.provider} required placeholder="openai / google / local" />
              <SelectField label="API 协议" name="api" defaultValue={editing === "new" ? "auto" : editing?.api} options={providerApiOptions} />
              <div className="sm:col-span-2">
                <FormField label="Base URL" name="baseUrl" type="url" defaultValue={editing === "new" ? "" : editing?.baseUrl} required />
              </div>
              <FormField label="API Key 环境变量" name="apiKeyEnv" defaultValue={editing === "new" ? "" : editing?.apiKeyEnv} placeholder="可选，例如 OPENAI_API_KEY" />
              <FormField
                label="API Key"
                name="apiKey"
                type="password"
                placeholder={editing !== "new" && editing?.hasApiKey ? "留空保留现有密钥" : "输入密钥"}
                description="密钥使用服务端加密保存，不会出现在后续响应中。"
              />
              <div className="sm:col-span-2">
                <CheckboxField label="启用此 Provider" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button
                type="button"
                variant="outline"
                onClick={(event) => {
                  const form = event.currentTarget.form
                  if (!form) return
                  const data = new FormData(form)
                  const profile = {
                    id: formText(data, "id"),
                    label: formText(data, "label"),
                    provider: formText(data, "provider"),
                    api: formText(data, "api") as ManagedProviderApi,
                    baseUrl: formText(data, "baseUrl"),
                    enabled: formBoolean(data, "enabled"),
                    ...(formText(data, "apiKeyEnv") ? { apiKeyEnv: formText(data, "apiKeyEnv") } : {}),
                    ...(formText(data, "apiKey") ? { apiKey: formText(data, "apiKey") } : {}),
                  }
                  void resource.mutate(() => client.probeProvider(profile), "协议探测成功")
                }}
              >
                <RadioTower data-icon="inline-start" /> 探测
              </Button>
              <AdminSubmitButton pending={resource.mutating}>保存并应用</AdminSubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
