import { useCallback, useState, type FormEvent } from "react"
import { BrainCircuit, Edit3, Image, Plus, TestTube2 } from "lucide-react"

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
import type { BootstrapPayload, ManagedModelApi, ModelProfile, ThinkingLevel } from "@/types/admin"

const apiOptions = [
  { value: "inherit", label: "继承 Provider 协议" },
  { value: "auto", label: "自动探测" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
]

const thinkingOptions = ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
  value,
  label: value,
}))

export default function ModelsConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async (signal: AbortSignal) => {
    void signal
    return client.bootstrap()
  }, [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<ModelProfile | "new" | null>(null)

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const profile: ModelProfile = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      providerProfileId: formText(data, "providerProfileId"),
      modelId: formText(data, "modelId"),
      api: formText(data, "api") as ManagedModelApi,
      input: [
        ...(formBoolean(data, "inputText") ? ["text" as const] : []),
        ...(formBoolean(data, "inputImage") ? ["image" as const] : []),
      ],
      reasoning: formBoolean(data, "reasoning"),
      contextWindow: formNumber(data, "contextWindow"),
      maxTokens: formNumber(data, "maxTokens"),
      thinkingLevel: formText(data, "thinkingLevel") as ThinkingLevel,
      ...(formText(data, "openaiThinkingFormat") ? { openaiThinkingFormat: formText(data, "openaiThinkingFormat") } : {}),
      maxRetryDelayMs: formNumber(data, "maxRetryDelayMs"),
      enabled: formBoolean(data, "enabled"),
    }
    const result = await resource.mutate(() => client.saveModel(profile), "模型配置已保存，正在后台应用到 Bot")
    if (result) {
      setEditing(null)
      await refreshSnapshot()
    }
  }

  const payload: BootstrapPayload | null = resource.data
  const models = payload?.models ?? []
  const providers = payload?.providers ?? []
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI 配置"
        title="模型"
        description="创建可复用模型配置，并明确文本、图像、推理和上下文能力。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => setEditing("new")} disabled={providers.length === 0}>
              <Plus data-icon="inline-start" /> 新增模型
            </Button>
          </>
        }
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载模型配置" /> : null}
      {!resource.loading ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {models.map((model) => {
            const provider = providers.find((item) => item.id === model.providerProfileId)
            return (
              <Card key={model.id} className="shadow-none">
                <CardHeader>
                  <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                    <BrainCircuit className="size-5" />
                  </span>
                  <CardTitle>{model.label}</CardTitle>
                  <CardDescription className="font-mono">{model.modelId}</CardDescription>
                  <div className="absolute top-4 right-4">
                    <StatusPill label={model.enabled ? "已启用" : "已停用"} tone={model.enabled ? "positive" : "muted"} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{provider?.label ?? model.providerProfileId}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{model.api}</Badge>
                    {model.input.map((input) => <Badge key={input} variant="outline">{input}</Badge>)}
                    {model.reasoning ? <Badge variant="outline">reasoning</Badge> : null}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="rounded-lg border bg-muted/20 p-2.5">
                      <p>上下文</p><p className="mt-1 font-mono font-medium text-foreground">{model.contextWindow.toLocaleString()}</p>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-2.5">
                      <p>最大输出</p><p className="mt-1 font-mono font-medium text-foreground">{model.maxTokens.toLocaleString()}</p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="flex-wrap justify-between gap-2">
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void resource.mutate(() => client.testModel(model.id), `${model.label} 文本测试成功`)}>
                      <TestTube2 data-icon="inline-start" /> 文本测试
                    </Button>
                    {model.input.includes("image") ? (
                      <Button variant="outline" size="sm" onClick={() => void resource.mutate(() => client.testModel(model.id, true), `${model.label} 图片测试成功`)}>
                        <Image data-icon="inline-start" /> 图片
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => setEditing(model)}>
                      <Edit3 data-icon="inline-start" /> 编辑
                    </Button>
                  </div>
                  <ConfirmButton
                    title={`删除 ${model.label}？`}
                    description="被全局设置或 Bot 引用的模型无法删除。"
                    onConfirm={() => void resource.mutate(() => client.deleteModel(model.id), "模型已删除")}
                  />
                </CardFooter>
              </Card>
            )
          })}
        </div>
      ) : null}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "新增模型" : "编辑模型"}</DialogTitle>
            <DialogDescription>模型能力必须与服务端真实能力一致。保存会立即返回，受影响的 Bot 将在后台重启应用。</DialogDescription>
          </DialogHeader>
          <AdminFeedback error={resource.error} notice={resource.notice} />
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={saveModel}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="配置 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <SelectField
                label="Provider"
                name="providerProfileId"
                defaultValue={editing === "new" ? providers[0]?.id : editing?.providerProfileId}
                options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
              />
              <FormField label="模型 ID" name="modelId" defaultValue={editing === "new" ? "" : editing?.modelId} required />
              <SelectField label="请求协议" name="api" defaultValue={editing === "new" ? "inherit" : editing?.api} options={apiOptions} />
              <SelectField label="思考等级" name="thinkingLevel" defaultValue={editing === "new" ? "off" : editing?.thinkingLevel} options={thinkingOptions} />
              <FormField label="上下文窗口" name="contextWindow" type="number" min={1024} defaultValue={editing === "new" ? 128000 : editing?.contextWindow} required />
              <FormField label="最大输出 Token" name="maxTokens" type="number" min={1} defaultValue={editing === "new" ? 8192 : editing?.maxTokens} required />
              <FormField label="最大重试等待（ms）" name="maxRetryDelayMs" type="number" min={0} defaultValue={editing === "new" ? 30000 : editing?.maxRetryDelayMs} required />
              <FormField label="OpenAI 思考格式" name="openaiThinkingFormat" defaultValue={editing === "new" ? "" : editing?.openaiThinkingFormat} placeholder="可选" />
              <CheckboxField label="支持文本输入" name="inputText" defaultChecked={editing === "new" ? true : editing?.input.includes("text")} />
              <CheckboxField label="支持图像输入" name="inputImage" defaultChecked={editing === "new" ? false : editing?.input.includes("image")} />
              <CheckboxField label="推理模型" name="reasoning" defaultChecked={editing === "new" ? false : editing?.reasoning} />
              <CheckboxField label="启用此模型" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
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
