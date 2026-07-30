import { useCallback, useMemo, useState, type FormEvent } from "react"
import { Camera, Heart, MessageCircle, Send } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  CheckboxField,
  FormField,
  ReloadButton,
  SelectField,
  TextareaField,
} from "@/components/admin-primitives"
import { EmptyState, PageHeader } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formNumber, formText, lines } from "@/lib/form-data"

interface MomentAutomationSettings {
  enabled: boolean
  dryRun: boolean
  autoLike: boolean
  autoComment: boolean
  allowedAuthorWxids: string[]
  maxActionsPerDay: number
  minIntervalMinutes: number
  lookbackMinutes: number
  commentTemplates: string[]
}

const defaultAutomation: MomentAutomationSettings = {
  enabled: false,
  dryRun: true,
  autoLike: false,
  autoComment: false,
  allowedAuthorWxids: [],
  maxActionsPerDay: 5,
  minIntervalMinutes: 30,
  lookbackMinutes: 180,
  commentTemplates: [],
}

export default function MomentsConsole() {
  const { client } = useAdmin()
  const bootstrapLoad = useCallback(() => client.bootstrap(), [client])
  const bootstrapResource = useAdminResource(bootstrapLoad)
  const ipadBots = useMemo(
    () => (bootstrapResource.data?.bots ?? []).filter((bot) => bot.channel.type === "wechat-ipad"),
    [bootstrapResource.data?.bots],
  )
  const [selectedId, setSelectedId] = useState("")
  const botId = selectedId || ipadBots[0]?.id || ""
  const load = useCallback(async () => {
    if (!botId) return null
    const [moments, automation] = await Promise.all([
      client.request<{ moments: unknown }>(`/api/bots/${encodeURIComponent(botId)}/wechat/moments`),
      client.request<{ settings: MomentAutomationSettings; actions: unknown }>(
        `/api/bots/${encodeURIComponent(botId)}/wechat/moments/automation`,
      ),
    ])
    return { moments: moments.moments, automation }
  }, [botId, client])
  const resource = useAdminResource(load)
  const settings = resource.data?.automation.settings ?? defaultAutomation

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const result = await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/moments`, {
        method: "POST",
        body: { content: formText(data, "content"), privacy: formText(data, "privacy") },
      }),
      "文本朋友圈已发布",
    )
    if (result) event.currentTarget.reset()
  }

  async function interact(form: HTMLFormElement, action: "like" | "comment") {
    const data = new FormData(form)
    const momentId = formText(data, "momentId")
    await resource.mutate(
      () => client.request(
        `/api/bots/${encodeURIComponent(botId)}/wechat/moments/${encodeURIComponent(momentId)}/${action}`,
        { method: "POST", body: action === "comment" ? { content: formText(data, "content") } : {} },
      ),
      action === "like" ? "朋友圈已点赞" : "评论已发送",
    )
  }

  async function saveAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/moments/automation`, {
        method: "PUT",
        body: {
          enabled: formBoolean(data, "enabled"),
          dryRun: formBoolean(data, "dryRun"),
          autoLike: formBoolean(data, "autoLike"),
          autoComment: formBoolean(data, "autoComment"),
          allowedAuthorWxids: lines(formText(data, "allowedAuthorWxids")),
          maxActionsPerDay: formNumber(data, "maxActionsPerDay"),
          minIntervalMinutes: formNumber(data, "minIntervalMinutes"),
          lookbackMinutes: formNumber(data, "lookbackMinutes"),
          commentTemplates: lines(formText(data, "commentTemplates")),
        },
      }),
      "朋友圈自动互动策略已保存",
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="微信扩展"
        title="朋友圈"
        description="手动发布文本朋友圈、执行点赞评论，并管理受白名单和限额约束的自动互动策略。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error || bootstrapResource.error} notice={resource.notice} />
      {ipadBots.length === 0 && !bootstrapResource.loading ? (
        <EmptyState title="没有 iPad Bot" description="朋友圈功能仅适用于 wechat-ipad Adapter。" />
      ) : null}
      {ipadBots.length > 0 ? (
        <Card className="shadow-none">
          <CardContent className="flex items-center gap-3">
            <Camera className="size-4 text-muted-foreground" />
            <select value={botId} onChange={(event) => setSelectedId(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
              {ipadBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}
            </select>
          </CardContent>
        </Card>
      ) : null}
      {resource.loading || bootstrapResource.loading ? <AdminLoading label="正在加载朋友圈" /> : null}
      {resource.data ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="shadow-none">
              <form onSubmit={publish}>
                <CardHeader>
                  <CardTitle>手动发布文本朋友圈</CardTitle>
                  <CardDescription>发布动作只会由管理员在此显式提交，不进入自动化。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <TextareaField label="内容" name="content" rows={6} required />
                  <SelectField
                    label="可见范围"
                    name="privacy"
                    defaultValue="public"
                    options={[
                      { value: "public", label: "公开" },
                      { value: "private", label: "私密" },
                    ]}
                  />
                </CardContent>
                <CardFooter className="justify-end"><Button type="submit"><Send data-icon="inline-start" /> 确认并发布</Button></CardFooter>
              </form>
            </Card>
            <Card className="shadow-none">
              <form onSubmit={(event) => { event.preventDefault(); void interact(event.currentTarget, "comment") }}>
                <CardHeader>
                  <CardTitle>点赞与评论</CardTitle>
                  <CardDescription>朋友圈 ID 按字符串发送，避免 64 位整数精度损失。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField label="朋友圈 ID" name="momentId" required />
                  <TextareaField label="评论内容" name="content" rows={4} />
                </CardContent>
                <CardFooter className="justify-end gap-2">
                  <Button type="button" variant="outline" onClick={(event) => {
                    const form = event.currentTarget.form
                    if (form) void interact(form, "like")
                  }}><Heart data-icon="inline-start" /> 点赞</Button>
                  <Button type="submit"><MessageCircle data-icon="inline-start" /> 评论</Button>
                </CardFooter>
              </form>
            </Card>
          </div>
          <Card className="shadow-none">
            <form key={JSON.stringify(settings)} onSubmit={saveAutomation}>
              <CardHeader>
                <CardTitle>自动点赞／评论策略</CardTitle>
                <CardDescription>默认关闭且默认 Dry-run；仅处理白名单作者，不会自动发布朋友圈。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <CheckboxField label="启用自动互动" name="enabled" defaultChecked={settings.enabled} />
                  <CheckboxField label="Dry-run" name="dryRun" defaultChecked={settings.dryRun} />
                  <CheckboxField label="自动点赞" name="autoLike" defaultChecked={settings.autoLike} />
                  <CheckboxField label="自动评论" name="autoComment" defaultChecked={settings.autoComment} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextareaField label="允许互动的作者 wxid" name="allowedAuthorWxids" rows={4} defaultValue={settings.allowedAuthorWxids.join("\n")} />
                  <TextareaField label="评论模板" name="commentTemplates" rows={4} defaultValue={settings.commentTemplates.join("\n")} />
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <FormField label="每日动作上限" name="maxActionsPerDay" type="number" min={1} max={100} defaultValue={settings.maxActionsPerDay} required />
                  <FormField label="最小间隔（分钟）" name="minIntervalMinutes" type="number" min={1} max={1440} defaultValue={settings.minIntervalMinutes} required />
                  <FormField label="回看窗口（分钟）" name="lookbackMinutes" type="number" min={10} max={1440} defaultValue={settings.lookbackMinutes} required />
                </div>
              </CardContent>
              <CardFooter className="justify-end"><Button type="submit">保存自动互动策略</Button></CardFooter>
            </form>
          </Card>
          <Card className="shadow-none">
            <CardHeader><CardTitle>协议数据与动作审计</CardTitle></CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">{JSON.stringify(resource.data.moments, null, 2)}</pre>
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">{JSON.stringify(resource.data.automation.actions, null, 2)}</pre>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}
