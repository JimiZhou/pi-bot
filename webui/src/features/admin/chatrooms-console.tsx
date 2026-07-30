import { useCallback, useMemo, useState, type FormEvent } from "react"
import {
  Brain,
  MessageSquareText,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Users,
} from "lucide-react"

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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formNumber, formText, lines } from "@/lib/form-data"
import type { BootstrapPayload, ChatroomRecord, ScheduledTask, StoredMessage } from "@/types/admin"
import { GroupManagement } from "@/features/wechat/group-management"

function roomTitle(room: ChatroomRecord) {
  return room.label || room.title || room.chatroomId
}

function canonicalRoomId(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().split(":").at(-1) ?? ""
}

type TaskScheduleType = "once" | "daily" | "weekly"

function scheduleType(task: ScheduledTask): TaskScheduleType {
  const value = task.schedule.type
  return value === "daily" || value === "weekly" ? value : "once"
}

function minuteToTime(value: unknown) {
  const minute = Math.max(0, Math.min(1439, Number(value) || 0))
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
}

function timeToMinute(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0
}

function timestampToLocalInput(timestamp: unknown, timezoneOffsetMinutes: number) {
  const value = typeof timestamp === "number" ? timestamp : Date.now()
  return new Date(value + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 16)
}

function localInputToTimestamp(value: string, timezoneOffsetMinutes: number) {
  return Date.parse(`${value}:00Z`) - timezoneOffsetMinutes * 60_000
}

function ScheduledTaskEditor({
  task,
  onSave,
  onDelete,
}: {
  task: ScheduledTask
  onSave: (input: Partial<ScheduledTask>) => void
  onDelete: () => void
}) {
  const [type, setType] = useState<TaskScheduleType>(() => scheduleType(task))
  const field = (name: string) => `${task.id}:${name}`

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const timezoneOffsetMinutes = task.timezoneOffsetMinutes
    let schedule: Record<string, unknown>
    if (type === "once") {
      const value = formText(data, field("runAt"))
      if (!value) return
      schedule = { type, runAt: localInputToTimestamp(value, timezoneOffsetMinutes) }
    } else {
      const minute = timeToMinute(formText(data, field("localTime")))
      schedule = type === "daily"
        ? { type, minute }
        : {
            type,
            minute,
            weekdays: lines(formText(data, field("weekdays"))).flatMap((value) =>
              value.split(/[,，]/u).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)),
          }
    }
    onSave({
      title: formText(data, field("title")),
      content: formText(data, field("content")),
      enabled: formBoolean(data, field("enabled")),
      timezoneOffsetMinutes,
      schedule,
    })
  }

  return (
    <Card className="shadow-none">
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>{task.title}</CardTitle>
          <CardDescription>
            创建人 {task.creatorName || task.creatorId} · 下次 {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString("zh-CN") : "未安排"}
          </CardDescription>
          <CardAction><StatusPill label={task.enabled ? "已启用" : "已停用"} tone={task.enabled ? "positive" : "muted"} /></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="标题" name={field("title")} defaultValue={task.title} required />
            <TextareaField label="运行内容" name={field("content")} defaultValue={task.content} rows={2} required />
            <SelectField
              label="计划类型"
              name={field("type")}
              value={type}
              onValueChange={(value) => setType(value as TaskScheduleType)}
              options={[
                { value: "once", label: "仅一次" },
                { value: "daily", label: "每天" },
                { value: "weekly", label: "每周" },
              ]}
            />
            {type === "once" ? (
              <FormField
                label="执行时间"
                name={field("runAt")}
                type="datetime-local"
                defaultValue={timestampToLocalInput(task.schedule.runAt, task.timezoneOffsetMinutes)}
                required
              />
            ) : (
              <FormField
                label="执行时间"
                name={field("localTime")}
                type="time"
                defaultValue={minuteToTime(task.schedule.minute)}
                required
              />
            )}
            {type === "weekly" ? (
              <FormField
                label="每周日期"
                name={field("weekdays")}
                defaultValue={Array.isArray(task.schedule.weekdays) ? task.schedule.weekdays.join(",") : ""}
                placeholder="0,1,2… 0 代表周日"
                required
              />
            ) : null}
            <CheckboxField label="启用任务" name={field("enabled")} defaultChecked={task.enabled} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>时区偏移：UTC{task.timezoneOffsetMinutes >= 0 ? "+" : ""}{task.timezoneOffsetMinutes / 60}</span>
            <span>上次：{task.lastStatus ?? "未执行"}</span>
            {task.lastError ? <span className="text-destructive">错误：{task.lastError}</span> : null}
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <ConfirmButton
            title={`删除任务 ${task.title}？`}
            description="删除后不会再按计划执行。"
            onConfirm={onDelete}
          />
          <Button type="submit">保存任务</Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function ChatroomDialog({
  room,
  bootstrap,
  onClose,
}: {
  room: ChatroomRecord
  bootstrap: BootstrapPayload
  onClose: () => void
}) {
  const { client, refreshSnapshot } = useAdmin()
  const [renderedAt] = useState(() => Date.now())
  const [olderMessages, setOlderMessages] = useState<StoredMessage[]>([])
  const [historyHasMore, setHistoryHasMore] = useState<boolean | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState("")
  const bot = bootstrap.bots.find((item) => item.id === room.botId)
  const load = useCallback(async () => {
    const [messages, memories, tasks, emojis] = await Promise.all([
      client.chatroomMessages(room.botId, room.chatroomId),
      client.chatroomMemories(room.botId, room.chatroomId),
      client.scheduledTasks(),
      client.emojis(),
    ])
    return {
      messages,
      memories,
      tasks: tasks.tasks.filter((task) =>
        (room.botIds?.includes(task.botId) ?? task.botId === room.botId)
        && canonicalRoomId(task.conversationId) === canonicalRoomId(room.chatroomId)),
      emojis: emojis.emojis.filter((emoji) => emoji.enabled),
    }
  }, [client, room.botId, room.botIds, room.chatroomId])
  const resource = useAdminResource(load)

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const pluginOverrides = room.plugins.flatMap((plugin) => {
      const value = formText(data, `plugin:${plugin.type}`)
      return value === "" ? [] : [{ pluginType: plugin.type, enabled: value === "on" }]
    })
    await resource.mutate(
      () => client.saveChatroom(room.botId, {
        chatroomId: room.chatroomId,
        label: formText(data, "label"),
        chatModelProfileId: formText(data, "chatModelProfileId") || null,
        visionModelProfileId: formText(data, "visionModelProfileId") || null,
        personaProfileId: formText(data, "personaProfileId") || null,
        ttsVoice: formText(data, "ttsVoice") || null,
        ttsStyle: formText(data, "ttsStyle") || null,
        participationIntensity: formText(data, "participationIntensity"),
        managerIds: lines(formText(data, "managerIds")),
        redEnvelopeTargetIds: lines(formText(data, "redEnvelopeTargetIds")),
        pluginOverrides,
      }),
      "群聊配置已保存并同步到关联账号",
    )
    await refreshSnapshot()
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = formText(data, "message")
    const emojiId = formText(data, "emojiId")
    if (!text && !emojiId) return
    const result = await resource.mutate(
      () => client.sendChatroomMessage(
        room.botId,
        room.chatroomId,
        emojiId ? { emojiId } : { text },
      ),
      emojiId ? "表情包已发送" : "消息已发送",
    )
    if (result) event.currentTarget.reset()
  }

  async function createMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const scope = formText(data, "scope") as "conversation" | "person"
    const result = await resource.mutate(
      () => client.createChatroomMemory(room.botId, room.chatroomId, {
        scope,
        ...(scope === "person" ? { personId: formText(data, "personId") } : {}),
        kind: formText(data, "kind"),
        content: formText(data, "content"),
        importance: formNumber(data, "importance"),
        ...(formText(data, "expiresInDays") ? { expiresInDays: formNumber(data, "expiresInDays") } : {}),
      }),
      "持久记忆已新增",
    )
    if (result) event.currentTarget.reset()
  }

  const messages = [
    ...olderMessages,
    ...(resource.data?.messages.messages ?? []),
  ]
  const canLoadEarlier = historyHasMore ?? resource.data?.messages.hasMore ?? false

  async function loadEarlierMessages() {
    const firstSequence = messages[0]?.sequence
    if (!firstSequence) return
    setHistoryLoading(true)
    setHistoryError("")
    try {
      const result = await client.chatroomMessages(room.botId, room.chatroomId, firstSequence)
      setOlderMessages((current) => [...result.messages, ...current])
      setHistoryHasMore(result.hasMore)
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "更早消息加载失败")
    } finally {
      setHistoryLoading(false)
    }
  }

  const modelOptions = [
    { value: "", label: "继承 Bot / 全局" },
    ...bootstrap.models.map((model) => ({ value: model.id, label: model.label })),
  ]
  const personaOptions = [
    { value: "", label: "继承 Bot / 全局" },
    ...bootstrap.personas.map((persona) => ({ value: persona.id, label: persona.label })),
  ]

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[94svh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{roomTitle(room)}</DialogTitle>
          <DialogDescription>{room.chatroomId} · {room.botDisplayName}</DialogDescription>
        </DialogHeader>
        <AdminFeedback error={resource.error} notice={resource.notice} />
        {resource.loading ? <AdminLoading label="正在加载群聊详情" /> : null}
        {!resource.loading ? (
          <Tabs defaultValue="config">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="config">配置</TabsTrigger>
              <TabsTrigger value="history">历史与发送</TabsTrigger>
              <TabsTrigger value="tasks">定时任务</TabsTrigger>
              <TabsTrigger value="memories">持久记忆</TabsTrigger>
              {bot?.channel.type === "wechat-ipad" ? <TabsTrigger value="wechat">微信群设置</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="config" className="py-4">
              <form onSubmit={saveConfig} className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="群聊别名" name="label" defaultValue={room.label} />
                  <SelectField
                    label="主动参与强度"
                    name="participationIntensity"
                    defaultValue={room.participationIntensity ?? "standard"}
                    options={[
                      { value: "conservative", label: "保守" },
                      { value: "standard", label: "标准" },
                      { value: "active", label: "积极" },
                    ]}
                  />
                  <SelectField label="对话模型" name="chatModelProfileId" defaultValue={room.chatModelProfileId ?? ""} options={modelOptions} />
                  <SelectField label="视觉模型" name="visionModelProfileId" defaultValue={room.visionModelProfileId ?? ""} options={modelOptions} />
                  <SelectField label="人格" name="personaProfileId" defaultValue={room.personaProfileId ?? ""} options={personaOptions} />
                  <SelectField
                    label="TTS 音色"
                    name="ttsVoice"
                    defaultValue={room.ttsVoice ?? ""}
                    options={[
                      { value: "", label: "继承默认" },
                      ...bootstrap.tts.voices.map((voice) => ({ value: voice, label: voice })),
                    ]}
                  />
                  <div className="sm:col-span-2">
                    <FormField label="TTS 风格" name="ttsStyle" defaultValue={room.ttsStyle} description="可输入 200 字以内的语气、年龄感、情绪和节奏。" />
                  </div>
                  <TextareaField label="机器人管理白名单" name="managerIds" rows={3} defaultValue={room.managerIds.join("\n")} />
                  <TextareaField label="红包提醒成员" name="redEnvelopeTargetIds" rows={3} defaultValue={room.redEnvelopeTargetIds.join("\n")} />
                </div>
                <div>
                  <p className="mb-3 text-sm font-medium">群聊插件覆盖</p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {room.plugins.map((plugin) => (
                      <SelectField
                        key={plugin.type}
                        label={plugin.type}
                        name={`plugin:${plugin.type}`}
                        defaultValue={plugin.override === null ? "" : plugin.override ? "on" : "off"}
                        options={[
                          { value: "", label: `继承（当前${plugin.defaultEnabled ? "开" : "关"}）` },
                          { value: "on", label: "强制开启" },
                          { value: "off", label: "强制关闭" },
                        ]}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void resource.mutate(
                      () => client.resetChatroomContext([{ botId: room.botId, chatroomId: room.chatroomId }]),
                      "群聊上下文已重置",
                    )}
                  >
                    <RotateCcw data-icon="inline-start" /> 重置上下文
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void resource.mutate(
                      () => client.deleteChatroomOverride(room.botId, room.chatroomId),
                      "已恢复全部继承",
                    )}
                  >
                    恢复全部继承
                  </Button>
                  <Button type="submit"><Settings2 data-icon="inline-start" /> 保存并应用</Button>
                </div>
              </form>
            </TabsContent>
            <TabsContent value="history" className="space-y-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{messages.length} 条已加载</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canLoadEarlier || historyLoading}
                  onClick={() => void loadEarlierMessages()}
                >
                  {historyLoading ? "加载中…" : canLoadEarlier ? "加载更早消息" : "已到最早"}
                </Button>
              </div>
              {historyError ? <AdminFeedback error={historyError} /> : null}
              <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-xl border bg-muted/20 p-3">
                {messages.map((message) => (
                  <article
                    key={message.sequence}
                    className={`max-w-[85%] rounded-xl border bg-background px-3 py-2 ${message.direction === "outbound" ? "ml-auto border-indigo-200" : ""}`}
                  >
                    <div className="mb-1 flex justify-between gap-4 text-xs text-muted-foreground">
                      <strong>{message.senderName || message.senderId}</strong>
                      <span>{new Date(message.timestamp).toLocaleString("zh-CN")}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{message.text || "[非文本消息]"}</p>
                  </article>
                ))}
                {messages.length === 0 ? (
                  <EmptyState title="暂无聊天记录" description="新消息会进入统一会话存储。" />
                ) : null}
              </div>
              <form onSubmit={sendMessage} className="flex flex-wrap gap-2">
                <Input name="message" placeholder={`以 ${bot?.displayName ?? room.botDisplayName} 身份发送文字`} className="min-w-60 flex-1" />
                <select name="emojiId" className="h-8 max-w-56 rounded-lg border bg-background px-2.5 text-sm">
                  <option value="">不发送表情包</option>
                  {(resource.data?.emojis ?? []).map((emoji) => <option key={emoji.id} value={emoji.id}>{emoji.description}</option>)}
                </select>
                <Button type="submit"><Send data-icon="inline-start" /> 发送</Button>
              </form>
            </TabsContent>
            <TabsContent value="tasks" className="space-y-3 py-4">
              {(resource.data?.tasks ?? []).map((task) => (
                <ScheduledTaskEditor
                  key={`${task.id}:${task.updatedAt}`}
                  task={task}
                  onSave={(input) => void resource.mutate(
                    () => client.updateScheduledTask(task.id, input),
                    "定时任务已更新",
                  )}
                  onDelete={() => void resource.mutate(() => client.deleteScheduledTask(task.id), "任务已删除")}
                />
              ))}
              {resource.data?.tasks.length === 0 ? <EmptyState title="没有定时任务" description="群友可通过自然语言创建任务。" /> : null}
            </TabsContent>
            <TabsContent value="memories" className="space-y-4 py-4">
              <form onSubmit={createMemory} className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
                <SelectField
                  label="范围"
                  name="scope"
                  defaultValue="conversation"
                  options={[
                    { value: "conversation", label: "整个群聊" },
                    { value: "person", label: "指定群友" },
                  ]}
                />
                <SelectField
                  label="群友（个人记忆时）"
                  name="personId"
                  defaultValue=""
                  options={[
                    { value: "", label: "请选择" },
                    ...(resource.data?.memories.members ?? [])
                      .filter((member) => !member.isBot)
                      .map((member) => ({ value: member.id, label: member.displayName || member.id })),
                  ]}
                />
                <FormField label="类型" name="kind" defaultValue="fact" required />
                <FormField label="重要度" name="importance" type="number" min={0} max={1} step={0.1} defaultValue={0.7} required />
                <div className="sm:col-span-2">
                  <TextareaField label="记忆内容" name="content" rows={3} required />
                </div>
                <FormField label="有效期（天，留空长期）" name="expiresInDays" type="number" min={1} />
                <div className="flex items-end justify-end"><Button type="submit"><Brain data-icon="inline-start" /> 新增记忆</Button></div>
              </form>
              {(resource.data?.memories.memories ?? []).map((memory) => {
                const expired = Boolean(memory.expiresAt && memory.expiresAt <= renderedAt)
                return (
                  <Card key={memory.id} className="shadow-none">
                    <CardHeader>
                      <CardTitle className="text-sm">{memory.content}</CardTitle>
                      <CardDescription>{memory.scope === "conversation" ? "整个群聊" : memory.scopeId} · {memory.kind} · 重要度 {memory.importance}</CardDescription>
                      <CardAction><StatusPill label={expired ? "已过期" : "有效"} tone={expired ? "warning" : "positive"} /></CardAction>
                    </CardHeader>
                    <CardFooter className="justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void resource.mutate(
                          () => client.confirmChatroomMemory(room.botId, room.chatroomId, memory.id),
                          "记忆已确认",
                        )}
                      >
                        确认有效
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void resource.mutate(
                          () => client.confirmChatroomMemory(room.botId, room.chatroomId, memory.id, 365),
                          "记忆已续期一年",
                        )}
                      >
                        续期一年
                      </Button>
                      <ConfirmButton
                        title="删除这条记忆？"
                        description="删除会写入学习审计记录。"
                        onConfirm={() => void resource.mutate(
                          () => client.deleteChatroomMemory(room.botId, room.chatroomId, memory.id),
                          "记忆已删除",
                        )}
                      />
                    </CardFooter>
                  </Card>
                )
              })}
              {resource.data?.memories.memories.length === 0 ? (
                <EmptyState title="还没有持久记忆" description="可在上方新增整个群聊或指定群友的长期记忆。" />
              ) : null}
              <details className="rounded-xl border bg-muted/20 p-4">
                <summary className="cursor-pointer text-sm font-medium">最近记忆审计</summary>
                <div className="mt-3 space-y-2">
                  {(resource.data?.memories.audit ?? [])
                    .filter((entry) => entry.entityType === "memory")
                    .map((entry) => (
                      <div key={entry.id} className="grid gap-1 border-t pt-2 text-xs sm:grid-cols-[10rem_5rem_1fr]">
                        <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
                        <strong>{entry.action === "saved" ? "新增" : entry.action === "forgotten" ? "删除" : entry.action === "restored" ? "恢复" : "修正"}</strong>
                        <span className="break-all text-muted-foreground">{entry.reason || entry.entityId}</span>
                      </div>
                    ))}
                  {(resource.data?.memories.audit ?? []).filter((entry) => entry.entityType === "memory").length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无记忆操作记录。</p>
                  ) : null}
                </div>
              </details>
            </TabsContent>
            {bot?.channel.type === "wechat-ipad" ? (
              <TabsContent value="wechat" className="py-4">
                <GroupManagement client={client} botId={bot.id} chatroomId={room.chatroomId} />
              </TabsContent>
            ) : null}
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export default function ChatroomsConsole() {
  const { client } = useAdmin()
  const load = useCallback(async () => {
    const [rooms, bootstrap] = await Promise.all([client.chatrooms(), client.bootstrap()])
    return { rooms: rooms.chatrooms, bootstrap }
  }, [client])
  const resource = useAdminResource(load)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<ChatroomRecord | null>(null)
  const rooms = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return (resource.data?.rooms ?? []).filter((room) =>
      !normalized || roomTitle(room).toLocaleLowerCase().includes(normalized) || room.chatroomId.toLocaleLowerCase().includes(normalized))
  }, [query, resource.data?.rooms])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="会话"
        title="群聊管理"
        description="统一管理模型覆盖、插件、定时任务、持久记忆、上下文和聊天记录。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      <div className="relative max-w-lg">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群名或群 ID" className="pl-8" />
      </div>
      {resource.loading ? <AdminLoading label="正在加载群聊" /> : null}
      {!resource.loading && rooms.length === 0 ? <EmptyState title="没有匹配的群聊" description="群聊会在收到第一条消息后自动发现。" /> : null}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {rooms.map((room) => (
          <Card key={`${room.botId}:${room.chatroomId}`} className="shadow-none">
            <CardHeader>
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                <Users className="size-5" />
              </span>
              <CardTitle>{roomTitle(room)}</CardTitle>
              <CardDescription className="truncate">{room.chatroomId}</CardDescription>
              <CardAction><Badge variant="secondary">{room.botIds?.length ?? 1} 个账号</Badge></CardAction>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border p-2"><strong className="block">{room.inboundMessages}</strong><span className="text-xs text-muted-foreground">消息</span></div>
              <div className="rounded-lg border p-2"><strong className="block">{room.activeMembers}</strong><span className="text-xs text-muted-foreground">成员</span></div>
              <div className="rounded-lg border p-2"><strong className="block">{room.plugins.filter((item) => item.enabled).length}</strong><span className="text-xs text-muted-foreground">插件</span></div>
            </CardContent>
            <CardFooter className="justify-between">
              <span className="text-xs text-muted-foreground">
                {room.lastMessageAt ? new Date(room.lastMessageAt).toLocaleString("zh-CN") : "暂无消息"}
              </span>
              <Button size="sm" onClick={() => setSelected(room)}>
                <MessageSquareText data-icon="inline-start" /> 管理
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {selected && resource.data ? (
        <ChatroomDialog
          key={`${selected.botId}:${selected.chatroomId}`}
          room={selected}
          bootstrap={resource.data.bootstrap}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}
