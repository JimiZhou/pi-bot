import { useCallback, useState, type ChangeEvent, type FormEvent } from "react"
import { ImagePlus, Plus, Sparkles, UserRoundCog } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formText, lines } from "@/lib/form-data"
import type { BootstrapPayload, PersonaProfile } from "@/types/admin"

async function imageDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件")
  if (file.size > 5 * 1024 * 1024) throw new Error("头像图片不能超过 5 MiB")
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("头像读取失败"))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

export default function PersonasConsole() {
  const { client } = useAdmin()
  const load = useCallback(async () => client.bootstrap(), [client])
  const resource = useAdminResource(load)
  const [editing, setEditing] = useState<PersonaProfile | "new" | null>(null)
  const [avatarDataUrl, setAvatarDataUrl] = useState("")
  const [applying, setApplying] = useState<PersonaProfile | null>(null)

  function openEditor(persona: PersonaProfile | "new") {
    setEditing(persona)
    setAvatarDataUrl(persona === "new" ? "" : persona.avatarDataUrl ?? "")
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    try {
      setAvatarDataUrl(await imageDataUrl(file))
    } catch (error) {
      await resource.mutate(() => Promise.reject(error))
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const persona: PersonaProfile = {
      id: formText(data, "id"),
      label: formText(data, "label"),
      prompt: formText(data, "prompt"),
      wakeWords: lines(formText(data, "wakeWords")),
      autoApplyAccountProfile: formBoolean(data, "autoApplyAccountProfile"),
      enabled: formBoolean(data, "enabled"),
      ...(formText(data, "accountNickname") ? { accountNickname: formText(data, "accountNickname") } : {}),
      ...(formText(data, "groupNickname") ? { groupNickname: formText(data, "groupNickname") } : {}),
      ...(avatarDataUrl ? { avatarDataUrl } : {}),
    }
    const result = await resource.mutate(() => client.savePersona(persona), "人设已保存")
    if (result) setEditing(null)
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!applying) return
    const data = new FormData(event.currentTarget)
    const result = await resource.mutate(
      () => client.applyPersona(applying.id, formText(data, "botId"), formText(data, "conversationId") || undefined),
      `${applying.label} 已应用`,
    )
    if (result) setApplying(null)
  }

  const payload: BootstrapPayload | null = resource.data
  const personas = payload?.personas ?? []
  const bots = payload?.bots ?? []
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI 配置"
        title="人设"
        description="维护可复用的身份、系统提示词、唤醒词和可选账号形象。"
        action={
          <>
            <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
            <Button onClick={() => openEditor("new")}><Plus data-icon="inline-start" /> 新增人设</Button>
          </>
        }
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载人设" /> : null}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {personas.map((persona) => (
          <Card key={persona.id} className="shadow-none">
            <CardHeader>
              <div className="mb-2 flex items-center gap-3">
                {persona.avatarDataUrl ? (
                  <img src={persona.avatarDataUrl} alt="" className="size-11 rounded-xl object-cover" />
                ) : (
                  <span className="flex size-11 items-center justify-center rounded-xl bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300">
                    <UserRoundCog className="size-5" />
                  </span>
                )}
                <div>
                  <CardTitle>{persona.label}</CardTitle>
                  <CardDescription className="mt-1 font-mono">{persona.id}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">{persona.prompt}</p>
              <div className="flex flex-wrap gap-1.5">
                <StatusPill label={persona.enabled ? "已启用" : "已停用"} tone={persona.enabled ? "positive" : "muted"} />
                {persona.wakeWords.slice(0, 4).map((word) => <Badge key={word} variant="outline">{word}</Badge>)}
              </div>
            </CardContent>
            <CardFooter className="flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setApplying(persona)} disabled={bots.length === 0}>
                  <Sparkles data-icon="inline-start" /> 应用
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEditor(persona)}>编辑</Button>
              </div>
              <ConfirmButton
                title={`删除 ${persona.label}？`}
                description="正在被全局、Bot 或会话引用的人设无法删除。"
                onConfirm={() => void resource.mutate(() => client.deletePersona(persona.id), "人设已删除")}
              />
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "新增人设" : "编辑人设"}</DialogTitle>
            <DialogDescription>人设提示词会进入系统上下文；请勿放入不必要的密钥或个人隐私。</DialogDescription>
          </DialogHeader>
          <form key={editing === "new" ? "new" : editing?.id} onSubmit={save}>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <FormField label="人设 ID" name="id" defaultValue={editing === "new" ? "" : editing?.id} required readOnly={editing !== "new"} />
              <FormField label="显示名称" name="label" defaultValue={editing === "new" ? "" : editing?.label} required />
              <FormField label="账号昵称" name="accountNickname" defaultValue={editing === "new" ? "" : editing?.accountNickname} />
              <FormField label="群内昵称" name="groupNickname" defaultValue={editing === "new" ? "" : editing?.groupNickname} />
              <div className="sm:col-span-2">
                <TextareaField label="唤醒词" name="wakeWords" defaultValue={editing === "new" ? "" : editing?.wakeWords.join(", ")} rows={2} />
              </div>
              <div className="sm:col-span-2">
                <TextareaField label="系统提示词" name="prompt" defaultValue={editing === "new" ? "" : editing?.prompt} rows={10} required />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="avatar-file">头像</Label>
                <div className="flex items-center gap-3">
                  {avatarDataUrl ? <img src={avatarDataUrl} alt="头像预览" className="size-16 rounded-xl object-cover" /> : null}
                  <Input id="avatar-file" type="file" accept="image/*" onChange={(event) => void chooseAvatar(event)} />
                  {avatarDataUrl ? <Button type="button" variant="outline" onClick={() => setAvatarDataUrl("")}>移除</Button> : <ImagePlus className="size-5 text-muted-foreground" />}
                </div>
              </div>
              <CheckboxField label="应用时同步账号资料" name="autoApplyAccountProfile" defaultChecked={editing === "new" ? false : editing?.autoApplyAccountProfile} />
              <CheckboxField label="启用此人设" name="enabled" defaultChecked={editing === "new" ? true : editing?.enabled} />
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={applying !== null} onOpenChange={(open) => { if (!open) setApplying(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>应用 {applying?.label}</DialogTitle>
            <DialogDescription>可应用到整个 Bot，或指定一个会话 ID。</DialogDescription>
          </DialogHeader>
          <form onSubmit={apply}>
            <div className="space-y-4 py-2">
              <SelectField label="Bot" name="botId" defaultValue={bots[0]?.id} options={bots.map((bot) => ({ value: bot.id, label: bot.displayName }))} />
              <FormField label="会话 ID" name="conversationId" placeholder="留空表示账号级应用" />
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setApplying(null)}>取消</Button>
              <Button type="submit">确认应用</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
