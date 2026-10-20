import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import {
  Bot,
  Cable,
  Edit3,
  HeartPulse,
  Play,
  Plus,
  Power,
  RotateCw,
  ScanLine,
} from "lucide-react"

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formNumber, formText, lines } from "@/lib/form-data"
import type {
  BotAgentLimits,
  BotConfig,
  BootstrapPayload,
  GroupActivation,
  RuntimeBotStatus,
  SocialScheduleConfig,
} from "@/types/admin"
import { createDefaultBot, defaultBotLimits, defaultSocialSchedule } from "@/features/admin/bot-defaults"
import { IpadLoginDialog } from "@/features/admin/ipad-login-dialog"

const limitFields: Array<{ key: keyof BotAgentLimits; label: string; min: number }> = [
  { key: "historyLimit", label: "历史消息条数", min: 1 },
  { key: "maxHistoryChars", label: "历史上下文字符上限", min: 100 },
  { key: "memoryLimit", label: "记忆条数", min: 0 },
  { key: "behaviorLimit", label: "行为样本条数", min: 0 },
  { key: "continuationWindowMs", label: "连续对话窗口（ms）", min: 0 },
  { key: "messageBurstDebounceMs", label: "消息合并等待（ms）", min: 0 },
  { key: "explicitMessageBurstDebounceMs", label: "显式触发等待（ms）", min: 0 },
  { key: "maxAgentLlmCalls", label: "单轮最大模型调用", min: 1 },
  { key: "maxAgentToolCalls", label: "单轮最大工具调用", min: 0 },
  { key: "agentTimeoutMs", label: "Agent 超时（ms）", min: 1000 },
  { key: "maxReplyChars", label: "回复字符上限", min: 1 },
  { key: "maxImageUnderstandingCalls", label: "单轮图片理解次数", min: 0 },
  { key: "maxImageBytes", label: "单图字节上限", min: 1024 },
  { key: "maxImageEvidenceChars", label: "图片证据字符上限", min: 0 },
  { key: "imageUnderstandingTimeoutMs", label: "图片理解超时（ms）", min: 1000 },
  { key: "imageContextMessageLimit", label: "图片上下文消息数", min: 0 },
  { key: "imageContextWindowMs", label: "图片上下文窗口（ms）", min: 0 },
  { key: "maxAvailableImagesPerTurn", label: "单轮可用图片数", min: 0 },
]

const socialFields: Array<{ key: keyof SocialScheduleConfig; label: string; min: number }> = [
  { key: "timezoneOffsetMinutes", label: "时区偏移（分钟）", min: -720 },
  { key: "activeStartMinute", label: "活跃开始（当天分钟）", min: 0 },
  { key: "activeEndMinute", label: "活跃结束（当天分钟）", min: 0 },
  { key: "hotChatWindowMs", label: "热聊窗口（ms）", min: 0 },
  { key: "hotChatMinMessages", label: "热聊最少消息", min: 1 },
  { key: "hotChatMinParticipants", label: "热聊最少成员", min: 1 },
  { key: "hotChatCooldownMs", label: "热聊冷却（ms）", min: 0 },
  { key: "coldChatAfterMs", label: "冷群判定（ms）", min: 0 },
  { key: "coldChatCooldownMs", label: "冷群暖场冷却（ms）", min: 0 },
  { key: "maxDailyAmbientMessages", label: "每日主动消息上限", min: 0 },
  { key: "goodnightMinute", label: "晚安时间（当天分钟）", min: 0 },
  { key: "activeGroupMinMessages", label: "活跃群最少消息", min: 0 },
]

function phaseTone(phase?: RuntimeBotStatus["phase"]): "positive" | "warning" | "muted" {
  if (phase === "running") return "positive"
  if (phase === "error" || phase === "starting" || phase === "stopping") return "warning"
  return "muted"
}

function phaseLabel(phase?: RuntimeBotStatus["phase"]): string {
  return phase === "running" ? "运行中"
    : phase === "starting" ? "应用中"
      : phase === "stopping" ? "停止中"
        : phase === "error" ? "错误"
          : "已停止"
}

function nullable(value: string) {
  return value || null
}

function modelOptions(payload: BootstrapPayload, emptyLabel: string) {
  return [
    { value: "", label: emptyLabel },
    ...payload.models.map((model) => ({
      value: model.id,
      label: `${model.label}${model.enabled ? "" : "（停用）"}`,
    })),
  ]
}

function participationModelOptions(payload: BootstrapPayload) {
  return [
    { value: "", label: "不启用" },
    ...payload.models
      .filter((model) => model.input.includes("text"))
      .map((model) => ({ value: model.id, label: `${model.label}${model.enabled ? "" : "（停用）"}` })),
  ]
}

function parseSettings(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("通道 settings 必须是合法 JSON 对象")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("通道 settings 必须是 JSON 对象")
  }
  return parsed as Record<string, unknown>
}

function channelSettings(channel: BotConfig["channel"]): Record<string, unknown> {
  if (channel.settings && typeof channel.settings === "object") return channel.settings
  const legacySettings: Record<string, unknown> = { ...channel }
  delete legacySettings.type
  delete legacySettings.accountId
  delete legacySettings.settings
  return legacySettings
}

function channelHasNestedSettings(channel: BotConfig["channel"]): boolean {
  return Object.prototype.hasOwnProperty.call(channel, "settings")
}

function BotEditor({
  payload,
  value,
  onClose,
  onSave,
  pending,
  error,
  notice,
}: {
  payload: BootstrapPayload
  value: BotConfig | "new"
  onClose: () => void
  onSave: (bot: BotConfig) => Promise<void>
  pending: boolean
  error: string
  notice: string
}) {
  const initial = value === "new" ? createDefaultBot("") : value
  const channelType = initial.channel.type
  const settingsText = JSON.stringify(channelSettings(initial.channel), null, 2)
  const chatModels = modelOptions(payload, "继承全局")
  const optionalModels = modelOptions(payload, "不启用")
  const participationModels = participationModelOptions(payload)
  const visionModels = [
    { value: "", label: "自动选择 Gemini 视觉模型" },
    ...payload.models
      .filter((model) => model.input.includes("image"))
      .map((model) => ({ value: model.id, label: model.label })),
  ]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const id = formText(data, "id")
    const limits = Object.fromEntries(limitFields.map(({ key }) => [key, formNumber(data, key)])) as unknown as BotAgentLimits
    const socialSchedule = {
      ...Object.fromEntries(socialFields.map(({ key }) => [key, formNumber(data, key)])),
      enabled: formBoolean(data, "socialScheduleEnabled"),
      goodnightEnabled: formBoolean(data, "goodnightEnabled"),
    } as SocialScheduleConfig
    const nextChannelType = formText(data, "channelType")
    const accountId = formText(data, "accountId")
    const parsedChannelSettings = parseSettings(formText(data, "channelSettings"))
    const chatModelProfileId = nullable(formText(data, "chatModelProfileId"))
    const effectiveChatModelProfileId = chatModelProfileId ?? payload.settings.defaultChatModelProfileId
    const fallbackChatModelProfileIds = lines(formText(data, "fallbackChatModelProfileIds"))
      .filter((modelId) => modelId !== effectiveChatModelProfileId)
    const channel = channelHasNestedSettings(initial.channel)
      ? {
          type: nextChannelType,
          ...(accountId ? { accountId } : {}),
          settings: parsedChannelSettings,
        }
      : {
          type: nextChannelType,
          ...(accountId ? { accountId } : {}),
          ...parsedChannelSettings,
        }
    await onSave({
      ...initial,
      id,
      enabled: formBoolean(data, "enabled"),
      identityId: formText(data, "identityId"),
      displayName: formText(data, "displayName"),
      wakeWords: lines(formText(data, "wakeWords")),
      operatorIds: lines(formText(data, "operatorIds")),
      personaProfileId: nullable(formText(data, "personaProfileId")),
      defaultGroupActivation: formText(data, "defaultGroupActivation") as GroupActivation,
      chatModelProfileId,
      fastChatModelProfileId: nullable(formText(data, "fastChatModelProfileId")),
      participationJudgeModelProfileId: nullable(formText(data, "participationJudgeModelProfileId")),
      fallbackChatModelProfileIds,
      emojiMode: formText(data, "emojiMode") as BotConfig["emojiMode"],
      emojiCandidateLimit: formNumber(data, "emojiCandidateLimit"),
      visionModelProfileId: nullable(formText(data, "visionModelProfileId")),
      imageUnderstandingEnabled: formBoolean(data, "imageUnderstandingEnabled"),
      databaseFile: value === "new" ? `bots/${id}/agent.sqlite` : initial.databaseFile,
      channel,
      limits,
      socialSchedule,
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[94svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{value === "new" ? "新增 Bot" : `编辑 ${value.displayName}`}</DialogTitle>
          <DialogDescription>
            Core 不内置任何 wxhook 或 iPad 客户端。请在外部实现 Adapter，并在 settings 中填写它需要的参数。
          </DialogDescription>
        </DialogHeader>
        {pending ? <p className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary" role="status"><RotateCw className="size-4 animate-spin" /> 配置已提交，正在后台重启受影响的 Bot…</p> : null}
        <AdminFeedback error={error} notice={notice} />
        <form onSubmit={submit}>
          <Tabs defaultValue="basic">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="basic">基础与模型</TabsTrigger>
              <TabsTrigger value="channel">消息通道</TabsTrigger>
              <TabsTrigger value="limits">资源限制</TabsTrigger>
              <TabsTrigger value="social">主动参与</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="grid gap-4 py-4 sm:grid-cols-2">
              <FormField label="Bot ID" name="id" defaultValue={initial.id} required readOnly={value !== "new"} />
              <FormField label="Identity ID" name="identityId" defaultValue={initial.identityId} required />
              <FormField label="显示名称" name="displayName" defaultValue={initial.displayName} required />
              <SelectField label="默认群聊触发" name="defaultGroupActivation" defaultValue={initial.defaultGroupActivation} options={[
                { value: "mention", label: "被提及或唤醒词" },
                { value: "always", label: "处理所有群消息" },
                { value: "off", label: "默认关闭" },
              ]} />
              <SelectField label="主对话模型" name="chatModelProfileId" defaultValue={initial.chatModelProfileId ?? ""} options={chatModels} />
              <SelectField label="快速任务模型" name="fastChatModelProfileId" defaultValue={initial.fastChatModelProfileId ?? ""} options={optionalModels} />
              <SelectField label="接话判断模型" name="participationJudgeModelProfileId" defaultValue={initial.participationJudgeModelProfileId ?? ""} options={participationModels} />
              <SelectField label="表情包策略" name="emojiMode" defaultValue={initial.emojiMode} options={[
                { value: "explicit", label: "仅明确需要时加载（推荐）" },
                { value: "auto", label: "自动参与轻松对话" },
                { value: "disabled", label: "关闭表情包工具" },
              ]} />
              <FormField label="首轮表情候选数" name="emojiCandidateLimit" type="number" min={2} max={16} defaultValue={initial.emojiCandidateLimit} description="候选越少，模型提示越轻；完整库仍可按需检索。" />
              <SelectField label="视觉模型" name="visionModelProfileId" defaultValue={initial.visionModelProfileId ?? ""} options={visionModels} />
              <SelectField label="人格模板" name="personaProfileId" defaultValue={initial.personaProfileId ?? ""} options={[
                { value: "", label: "继承全局" },
                ...payload.personas.map((persona) => ({ value: persona.id, label: persona.label })),
              ]} />
              <div className="sm:col-span-2">
              <TextareaField label="备用模型链" name="fallbackChatModelProfileIds" rows={3} defaultValue={initial.fallbackChatModelProfileIds.join("\n")} description="每行一个模型配置 ID，按顺序故障转移；主模型不能同时出现在这里，保存时会自动去重。" />
              </div>
              <TextareaField label="唤醒词" name="wakeWords" rows={3} defaultValue={initial.wakeWords.join(", ")} />
              <TextareaField label="管理员 ID" name="operatorIds" rows={3} defaultValue={initial.operatorIds.join("\n")} />
              <CheckboxField label="保存后启用 Bot" name="enabled" defaultChecked={initial.enabled} />
              <CheckboxField label="启用图片理解" name="imageUnderstandingEnabled" defaultChecked={initial.imageUnderstandingEnabled} />
            </TabsContent>
            <TabsContent value="channel" className="space-y-5 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Adapter 类型" name="channelType" defaultValue={channelType} required description="必须与 PI_CHANNEL_ADAPTER_MODULE 导出的 Adapter type 一致。" />
                <FormField label="账号标识（可选）" name="accountId" defaultValue={initial.channel.accountId} />
              </div>
              <TextareaField
                label="Adapter settings（JSON）"
                name="channelSettings"
                rows={12}
                defaultValue={settingsText}
                required
                description="Core 不解释这些字段；由你接入的 Adapter 负责读取、鉴权、收发消息和回调注册。"
              />
              <div className="rounded-xl border bg-muted/20 p-4 text-sm leading-6 text-muted-foreground">
                需要自己对接：协议客户端、登录/扫码、消息事件转换、媒体下载上传、发送 API、健康检查，以及平台特有的群管理能力。Core 只提供统一会话、记忆、插件、LLM 与 WebUI 编排。
              </div>
            </TabsContent>
            <TabsContent value="limits" className="grid gap-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
              {limitFields.map((field) => <FormField key={field.key} label={field.label} name={field.key} type="number" min={field.min} defaultValue={initial.limits[field.key] ?? defaultBotLimits[field.key]} required />)}
            </TabsContent>
            <TabsContent value="social" className="space-y-4 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <CheckboxField label="启用主动参与调度" name="socialScheduleEnabled" defaultChecked={initial.socialSchedule.enabled} />
                <CheckboxField label="启用晚安消息" name="goodnightEnabled" defaultChecked={initial.socialSchedule.goodnightEnabled} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {socialFields.map((field) => <FormField key={field.key} label={field.label} name={field.key} type="number" min={field.min} defaultValue={typeof initial.socialSchedule[field.key] === "number" ? initial.socialSchedule[field.key] as number : defaultSocialSchedule[field.key] as number} required />)}
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <AdminSubmitButton pending={pending}>保存并应用</AdminSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function BotsConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(() => client.bootstrap(), [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<BotConfig | "new" | null>(null)
  const [loginBot, setLoginBot] = useState<BotConfig | null>(null)
  const payload = resource.data
  const statuses = useMemo(() => new Map(payload?.status.bots.map((status) => [status.id, status]) ?? []), [payload])
  const applying = Boolean(payload?.status.bots.some((status) => status.phase === "starting" || status.phase === "stopping"))
  const { reload } = resource

  useEffect(() => {
    if (!applying) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await reload()
      if (!cancelled) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 800)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [applying, reload])

  async function save(bot: BotConfig) {
    const result = await resource.mutate(() => client.saveBot(bot), "Bot 配置已保存，正在后台应用")
    if (result) {
      // Keep the dialog open so the success message is not hidden behind the
      // dialog overlay. The user can close it after seeing the save/apply state.
      setEditing(result.bot)
      await refreshSnapshot()
    }
  }

  async function action(bot: BotConfig, name: "start" | "stop" | "restart" | "gateway-check") {
    const labels = { start: "已启动", stop: "已停止", restart: "已重启", "gateway-check": "网关检查成功" }
    await resource.mutate(() => client.botAction(bot.id, name), `${bot.displayName}${labels[name]}`)
    await refreshSnapshot()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Bot 管理"
        title="编排 Bot 的行为与能力"
        description="Core 负责对话、记忆、模型、插件与生命周期；消息平台由外部 Adapter 接入。"
        action={<><ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} /><Button onClick={() => setEditing("new")} disabled={!payload}><Plus data-icon="inline-start" /> 新增 Bot</Button></>}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载 Bot 配置" /> : null}
      {payload && payload.bots.length === 0 ? <EmptyState title="还没有 Bot" description="先配置 Provider 和模型，再新增 Bot 实例。" /> : null}
      {payload ? <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {payload.bots.map((bot) => {
          const status = statuses.get(bot.id)
          const settingsPreview = JSON.stringify(channelSettings(bot.channel))
          return <Card key={bot.id} className="shadow-none">
            <CardHeader>
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><Bot className="size-5" /></span>
              <CardTitle>{bot.displayName}</CardTitle>
              <CardDescription>{bot.id} · {bot.identityId}</CardDescription>
              <CardAction><StatusPill label={phaseLabel(status?.phase)} tone={phaseTone(status?.phase)} /></CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary"><Cable className="size-3" /> {bot.channel.type}</Badge>
                <Badge variant="outline">{status?.chatModel ?? bot.chatModelProfileId ?? "继承模型"}</Badge>
                <Badge variant="outline">{bot.plugins.filter((plugin) => plugin.enabled).length} 个插件</Badge>
              </div>
              <p className="truncate rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground" title={settingsPreview}>{settingsPreview || "{}"}</p>
              {status?.lastError ? <p className="text-sm text-destructive">{status.lastError}</p> : null}
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(bot)}><Edit3 data-icon="inline-start" /> 编辑</Button>
              <Button size="sm" variant="outline" onClick={() => void action(bot, bot.enabled ? "stop" : "start")}>{bot.enabled ? <Power data-icon="inline-start" /> : <Play data-icon="inline-start" />}{bot.enabled ? "停止" : "启动"}</Button>
              <Button size="sm" variant="outline" disabled={!bot.enabled} onClick={() => void action(bot, "restart")}><RotateCw data-icon="inline-start" /> 重启</Button>
              <Button size="sm" variant="outline" disabled={status?.phase !== "running"} onClick={() => void action(bot, "gateway-check")}><HeartPulse data-icon="inline-start" /> 健康检查</Button>
              {bot.channel.type === "wechat-ipad" ? <Button size="sm" variant="outline" onClick={() => setLoginBot(bot)}><ScanLine data-icon="inline-start" /> 微信扫码登录</Button> : null}
              <div className="ml-auto"><ConfirmButton title={`删除 ${bot.displayName}？`} description="Bot 将先停止，然后删除配置；独立 SQLite 数据文件不会自动删除。" onConfirm={() => void resource.mutate(async () => { await client.deleteBot(bot.id); await refreshSnapshot() }, "Bot 已删除")} /></div>
            </CardFooter>
          </Card>
        })}
      </div> : null}
      {payload && editing ? <BotEditor
        key={editing === "new" ? "new" : editing.id}
        payload={payload}
        value={editing}
        onClose={() => setEditing(null)}
        onSave={save}
        pending={resource.mutating}
        error={resource.error}
        notice={resource.notice}
      /> : null}
      {loginBot ? <IpadLoginDialog
        client={client}
        bot={loginBot}
        open
        onOpenChange={(open) => { if (!open) setLoginBot(null) }}
        onOnline={async () => { await resource.reload(); await refreshSnapshot() }}
      /> : null}
    </div>
  )
}
