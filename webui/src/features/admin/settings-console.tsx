import { useCallback, type FormEvent } from "react"
import { Save, SlidersHorizontal } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  FormField,
  ReloadButton,
  SelectField,
} from "@/components/admin-primitives"
import { PageHeader } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formNumber, formText } from "@/lib/form-data"
import type { BootstrapPayload, GlobalSettings } from "@/types/admin"

function nullable(value: string): string | null {
  return value || null
}

export default function SettingsConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => client.bootstrap(), [client])
  const resource = useAdminResource(load)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const settings: GlobalSettings = {
      defaultChatModelProfileId: nullable(formText(data, "defaultChatModelProfileId")),
      defaultVisionModelProfileId: nullable(formText(data, "defaultVisionModelProfileId")),
      defaultKnowledgeProfileId: nullable(formText(data, "defaultKnowledgeProfileId")),
      defaultPersonaProfileId: nullable(formText(data, "defaultPersonaProfileId")),
      logRetentionDays: formNumber(data, "logRetentionDays"),
      maxLogRows: formNumber(data, "maxLogRows"),
      statusRefreshMs: formNumber(data, "statusRefreshMs"),
      participationRetentionDays: formNumber(data, "participationRetentionDays"),
      maxParticipationCasesPerBot: formNumber(data, "maxParticipationCasesPerBot"),
    }
    const result = await resource.mutate(() => client.saveSettings(settings), "全局设置已保存并应用")
    if (result) await refreshSnapshot()
  }

  const payload: BootstrapPayload | null = resource.data
  const settings = payload?.settings
  const modelOptions = [
    { value: "", label: "未配置" },
    ...(payload?.models ?? []).map((model) => ({ value: model.id, label: model.label })),
  ]
  const visionModelOptions = [
    { value: "", label: "自动选择 Gemini 视觉模型" },
    ...(payload?.models ?? [])
      .filter((model) => model.input.includes("image"))
      .map((model) => ({ value: model.id, label: model.label })),
  ]
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="系统"
        title="全局设置"
        description="为没有单独覆盖的 Bot 设置默认模型、人设、检索和数据保留策略。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading || !settings ? <AdminLoading label="正在加载全局设置" /> : (
        <form key={JSON.stringify(settings)} onSubmit={save} className="space-y-4">
          <Card className="shadow-none">
            <CardHeader>
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                <SlidersHorizontal className="size-5" />
              </span>
              <CardTitle>默认能力</CardTitle>
              <CardDescription>Bot 和会话未指定时继承以下配置。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <SelectField label="默认聊天模型" name="defaultChatModelProfileId" defaultValue={settings.defaultChatModelProfileId ?? ""} options={modelOptions} />
              <SelectField label="默认视觉模型" name="defaultVisionModelProfileId" defaultValue={settings.defaultVisionModelProfileId ?? ""} options={visionModelOptions} />
              <SelectField
                label="默认联网检索"
                name="defaultKnowledgeProfileId"
                defaultValue={settings.defaultKnowledgeProfileId ?? ""}
                options={[
                  { value: "", label: "未配置" },
                  ...(payload?.knowledgeProviders ?? []).map((provider) => ({ value: provider.id, label: provider.label })),
                ]}
              />
              <SelectField
                label="默认人设"
                name="defaultPersonaProfileId"
                defaultValue={settings.defaultPersonaProfileId ?? ""}
                options={[
                  { value: "", label: "未配置" },
                  ...(payload?.personas ?? []).map((persona) => ({ value: persona.id, label: persona.label })),
                ]}
              />
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>控制面与数据保留</CardTitle>
              <CardDescription>这些设置不改变消息热路径的可靠性约束。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="日志保留天数" name="logRetentionDays" type="number" min={1} defaultValue={settings.logRetentionDays} required />
              <FormField label="最大日志行数" name="maxLogRows" type="number" min={100} defaultValue={settings.maxLogRows} required />
              <FormField label="状态刷新间隔（ms）" name="statusRefreshMs" type="number" min={1000} defaultValue={settings.statusRefreshMs} required />
              <FormField label="参与案例保留天数" name="participationRetentionDays" type="number" min={1} defaultValue={settings.participationRetentionDays} required />
              <FormField label="每 Bot 最大参与案例" name="maxParticipationCasesPerBot" type="number" min={100} defaultValue={settings.maxParticipationCasesPerBot} required />
            </CardContent>
          </Card>
          <div className="flex justify-end">
            <Button type="submit"><Save data-icon="inline-start" /> 保存并应用</Button>
          </div>
        </form>
      )}
    </div>
  )
}
