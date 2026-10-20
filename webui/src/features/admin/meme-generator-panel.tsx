import { useCallback, useMemo, useState, type ChangeEvent, type FormEvent } from "react"
import { Download, ImagePlus, LoaderCircle, RefreshCw, Search, Sparkles, X } from "lucide-react"

import { AdminFeedback, AdminLoading } from "@/components/admin-primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import type { BotConfig, ChatroomRecord, EmojiRecord, MemeGenerationResult } from "@/types/admin"

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function fileToDataUrl(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return `data:${file.type};base64,${btoa(binary)}`
  })
}

function extensionForMime(mimeType: string) {
  return mimeType === "image/gif" ? "gif" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"
}

export default function MemeGeneratorPanel({ onEmojiSaved }: { onEmojiSaved?: () => void }) {
  const { client } = useAdmin()
  const load = useCallback(() => client.memeKeys(), [client])
  const resource = useAdminResource(load)
  const botResource = useAdminResource(useCallback(() => client.bootstrap(), [client]))
  const chatroomResource = useAdminResource(useCallback(() => client.chatrooms(), [client]))
  const [selectedKey, setSelectedKey] = useState("")
  const activeKey = selectedKey && (resource.data?.keys ?? []).includes(selectedKey) ? selectedKey : resource.data?.keys?.[0] ?? ""
  const infoResource = useAdminResource(useCallback(async () => activeKey ? client.memeInfo(activeKey) : {
    key: "",
    keywords: [],
    minImages: 0,
    maxImages: 0,
    minTexts: 0,
    maxTexts: 0,
  }, [activeKey, client]))
  const keys = useMemo(() => resource.data?.keys ?? [], [resource.data])
  const bots = botResource.data?.bots ?? []
  const chatrooms = useMemo(() => chatroomResource.data?.chatrooms ?? [], [chatroomResource.data])
  const [query, setQuery] = useState("")
  const [selectedBotId, setSelectedBotId] = useState("")
  const [selectedChatroomId, setSelectedChatroomId] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [texts, setTexts] = useState<string[]>([])
  const [argsText, setArgsText] = useState("{}")
  const [generated, setGenerated] = useState<{ url: string; result: MemeGenerationResult } | null>(null)
  const [savedEmoji, setSavedEmoji] = useState<EmojiRecord | null>(null)
  const [description, setDescription] = useState("")
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [formError, setFormError] = useState("")
  const [customKey, setCustomKey] = useState("")
  const [customTitle, setCustomTitle] = useState("")
  const [customKeywords, setCustomKeywords] = useState("")
  const [customFile, setCustomFile] = useState<File | null>(null)
  const [uploadingCustom, setUploadingCustom] = useState(false)
  const [uploadNotice, setUploadNotice] = useState("")

  const filteredKeys = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return keys.filter((key) => !normalized || key.toLocaleLowerCase().includes(normalized))
  }, [keys, query])

  const activeBotId = selectedBotId && bots.some((bot) => bot.id === selectedBotId) ? selectedBotId : bots[0]?.id ?? ""
  const roomOptions = useMemo(
    () => chatrooms.filter((room) => room.botId === activeBotId),
    [activeBotId, chatrooms],
  )
  const activeChatroomId = selectedChatroomId && roomOptions.some((room) => room.chatroomId === selectedChatroomId)
    ? selectedChatroomId
    : roomOptions[0]?.chatroomId ?? ""

  const info = activeKey && infoResource.data?.key === activeKey ? infoResource.data : null
  const infoLoading = Boolean(activeKey) && infoResource.loading

  function selectKey(key: string) {
    setSelectedKey(key)
    setTexts([])
    setFiles([])
    setGenerated(null)
    setSavedEmoji(null)
    setFormError("")
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? [])
    event.target.value = ""
    const invalid = chosen.find((file) => !SUPPORTED_IMAGE_TYPES.has(file.type))
    if (invalid) {
      setFormError("只支持 JPEG、PNG、GIF 和 WebP 图片。")
      return
    }
    const total = chosen.reduce((sum, file) => sum + file.size, 0)
    const maxImages = info?.maxImages ?? 12
    if (chosen.length > maxImages) {
      setFormError(`这个模板最多需要 ${maxImages} 张图片。`)
      return
    }
    if (total > MAX_INPUT_BYTES) {
      setFormError(`输入图片总大小不能超过 ${formatBytes(MAX_INPUT_BYTES)}。`)
      return
    }
    setFormError("")
    setFiles(chosen)
  }

  function chooseCustomFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ""
    if (!file) return
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      setFormError("只支持 JPEG、PNG、GIF 和 WebP 图片。")
      return
    }
    if (file.size > MAX_INPUT_BYTES) {
      setFormError(`自定义图片不能超过 ${formatBytes(MAX_INPUT_BYTES)}。`)
      return
    }
    setFormError("")
    setUploadNotice("")
    setCustomFile(file)
  }

  async function uploadCustom() {
    const key = customKey.normalize("NFKC").trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(key)) {
      setFormError("key 只能以字母或数字开头，并包含字母、数字、下划线或短横线。")
      return
    }
    if (!customFile) {
      setFormError("请先选择要上传的图片。")
      return
    }
    setUploadingCustom(true)
    setFormError("")
    setUploadNotice("")
    try {
      const result = await client.uploadCustomMeme({
        key,
        ...(customTitle.trim() ? { title: customTitle.trim() } : {}),
        keywords: customKeywords.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean),
        dataUrl: await fileToDataUrl(customFile),
      })
      await resource.reload()
      setSelectedKey(result.meme.key)
      setCustomFile(null)
      setUploadNotice(`已上传「${result.meme.title}」，现在可以直接使用 meme ${result.meme.key}。`)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUploadingCustom(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!info) return
    setFormError("")
    const selectedTexts = texts.map((text) => text.trim()).filter(Boolean)
    if (files.length < info.minImages || files.length > info.maxImages) {
      setFormError(`这个模板需要 ${info.minImages} 到 ${info.maxImages} 张图片。`)
      return
    }
    if (selectedTexts.length < info.minTexts || selectedTexts.length > info.maxTexts) {
      setFormError(`这个模板需要 ${info.minTexts} 到 ${info.maxTexts} 段文字。`)
      return
    }
    let args: Record<string, unknown>
    try {
      const parsed = JSON.parse(argsText) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("高级参数必须是 JSON 对象")
      args = parsed as Record<string, unknown>
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "高级参数 JSON 格式不正确")
      return
    }
    setGenerating(true)
    try {
      const result = await client.generateMeme({
        key: info.key,
        images: await Promise.all(files.map(async (file) => ({ mimeType: file.type, dataUrl: await fileToDataUrl(file) }))),
        texts: selectedTexts,
        args,
      })
      setGenerated({ result, url: `data:${result.mimeType};base64,${result.data}` })
      setSavedEmoji(null)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGenerating(false)
    }
  }

  async function saveGenerated() {
    if (!generated || !activeBotId) {
      setFormError("请先选择 Bot，并生成一个结果。")
      return undefined
    }
    setSaving(true)
    setFormError("")
    try {
      const result = await client.saveMemeEmoji({
        botId: activeBotId,
        key: activeKey,
        dataUrl: generated.url,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      setSavedEmoji(result.emoji)
      onEmojiSaved?.()
      return result.emoji
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      setSaving(false)
    }
  }

  async function sendGenerated() {
    if (!generated || !activeBotId || !activeChatroomId) {
      setFormError("请先选择 Bot 和群聊，并生成一个结果。")
      return
    }
    setSending(true)
    setFormError("")
    try {
      const emoji = savedEmoji?.botId === activeBotId ? savedEmoji : await saveGenerated()
      if (!emoji) return
      await client.sendChatroomMessage(activeBotId, activeChatroomId, { emojiId: emoji.id })
      setFormError("")
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }

  const textCount = Math.max(info?.maxTexts ?? 0, info?.minTexts ?? 0)

  return (
    <Card className="shadow-none">
      <CardHeader>
        <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300">
          <Sparkles className="size-4" />
        </span>
        <CardTitle>Meme 生成器</CardTitle>
        <CardDescription>在表情包模块中查看模板、上传图片、填写文字并生成 GIF 或图片。</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => void resource.reload()} disabled={resource.refreshing}>
            <RefreshCw className={resource.refreshing ? "animate-spin" : ""} data-icon="inline-start" /> 刷新模板
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <AdminFeedback error={resource.error || botResource.error || chatroomResource.error || infoResource.error || formError} />
        <div className="mb-6 rounded-xl border border-dashed p-4">
          <div className="mb-3">
            <p className="text-sm font-medium">上传自定义 meme 图片</p>
            <p className="text-xs text-muted-foreground">上传后立即出现在模板列表，无需进入容器或重启服务；支持 JPEG、PNG、GIF、WebP，最大 20 MiB。</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="custom-meme-key">key</Label>
              <Input id="custom-meme-key" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="例如：my-reaction" maxLength={64} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-meme-title">标题（可选）</Label>
              <Input id="custom-meme-title" value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} placeholder="例如：我的反应" maxLength={120} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-meme-keywords">关键词（可选）</Label>
              <Input id="custom-meme-keywords" value={customKeywords} onChange={(event) => setCustomKeywords(event.target.value)} placeholder="逗号分隔" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="custom-meme-file" className="flex min-w-52 cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/40">
              <ImagePlus className="size-4" /> {customFile ? `${customFile.name} · ${formatBytes(customFile.size)}` : "选择图片"}
            </label>
            <input id="custom-meme-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="sr-only" onChange={chooseCustomFile} />
            <Button type="button" onClick={() => void uploadCustom()} disabled={uploadingCustom || !customFile}>
              {uploadingCustom ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
              {uploadingCustom ? "上传中…" : "上传并立即使用"}
            </Button>
          </div>
          {uploadNotice ? <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{uploadNotice}</p> : null}
        </div>
        {resource.loading ? <AdminLoading label="正在加载 meme 模板" /> : null}
        {!resource.loading && keys.length === 0 && !resource.error ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">meme-generator 没有返回可用模板。</p>
        ) : null}
        {keys.length > 0 ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.3fr)]">
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索模板（${keys.length} 个）`} className="pl-8" />
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
                {filteredKeys.map((key) => (
                  <Button
                    key={key}
                    type="button"
                    variant={activeKey === key ? "default" : "ghost"}
                    className="w-full justify-start font-mono text-xs"
                    onClick={() => selectKey(key)}
                  >
                    {key}
                  </Button>
                ))}
                {filteredKeys.length === 0 ? <p className="p-2 text-xs text-muted-foreground">没有匹配模板。</p> : null}
              </div>
            </div>
            <div className="min-w-0">
              {infoLoading ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> 正在读取模板参数</div>
              ) : info ? (
                <form onSubmit={submit} className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="font-mono">{info.key}</Badge>
                    <Badge variant="outline">图片 {info.minImages}–{info.maxImages}</Badge>
                    <Badge variant="outline">文字 {info.minTexts}–{info.maxTexts}</Badge>
                    {info.keywords.map((keyword) => <Badge key={keyword} variant="outline">{keyword}</Badge>)}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="meme-images">输入图片</Label>
                    <label htmlFor="meme-images" className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground hover:bg-muted/40">
                      <ImagePlus className="size-4" /> 选择图片（最多 {info.maxImages} 张，合计不超过 20 MiB）
                    </label>
                    <input id="meme-images" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple className="sr-only" onChange={chooseFiles} />
                    {files.length > 0 ? (
                      <div className="space-y-1">
                        {files.map((file) => (
                          <div key={`${file.name}:${file.lastModified}`} className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
                            <span className="truncate">{file.name} · {formatBytes(file.size)}</span>
                            <Button type="button" variant="ghost" size="icon" className="size-6" onClick={() => setFiles((current) => current.filter((item) => item !== file))} aria-label={`移除 ${file.name}`}>
                              <X className="size-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {textCount > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {Array.from({ length: textCount }, (_, index) => (
                        <div key={index} className="space-y-2">
                          <Label htmlFor={`meme-text-${index}`}>文字 {index + 1}{index < info.minTexts ? "（必填）" : "（可选）"}</Label>
                          <Input id={`meme-text-${index}`} value={texts[index] ?? ""} onChange={(event) => setTexts((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item).concat(current.length <= index ? [event.target.value] : []))} placeholder="输入文字" />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="meme-args">高级参数 JSON（可选）</Label>
                    <Textarea id="meme-args" value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} className="font-mono text-xs" spellCheck={false} placeholder='例如 {"circle":true}' />
                  </div>
                  <Button type="submit" disabled={generating}>
                    {generating ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
                    {generating ? "生成中…" : "生成预览"}
                  </Button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}
        {generated ? (
          <div className="mt-6 rounded-xl border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">生成结果</p>
                <p className="text-xs text-muted-foreground">{formatBytes(generated.result.size)} · {generated.result.mimeType}</p>
              </div>
              <Button asChild size="sm" variant="outline">
                <a href={generated.url} download={`meme-${activeKey}.${extensionForMime(generated.result.mimeType)}`}><Download data-icon="inline-start" /> 下载</a>
              </Button>
            </div>
            <div className="flex min-h-48 items-center justify-center rounded-lg bg-background p-3">
              <img src={generated.url} alt={`生成的 ${activeKey} 表情`} className="max-h-[28rem] max-w-full object-contain" />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="meme-save-bot">保存/发送使用的 Bot</Label>
                <select id="meme-save-bot" value={activeBotId} onChange={(event) => setSelectedBotId(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm">
                  {bots.length === 0 ? <option value="">没有 Bot</option> : bots.map((bot: BotConfig) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="meme-send-room">发送到群聊</Label>
                <select id="meme-send-room" value={activeChatroomId} onChange={(event) => setSelectedChatroomId(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm">
                  {roomOptions.length === 0 ? <option value="">没有可用群聊</option> : roomOptions.map((room: ChatroomRecord) => <option key={room.chatroomId} value={room.chatroomId}>{room.title || room.label || room.chatroomId}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              <Label htmlFor="meme-save-description">保存描述</Label>
              <Input id="meme-save-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder={`例如：${activeKey} 表情`} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void saveGenerated()} disabled={saving || sending || !activeBotId}>
                {saving ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
                {savedEmoji?.botId === activeBotId ? "已保存到表情库" : "保存到表情库"}
              </Button>
              <Button type="button" onClick={() => void sendGenerated()} disabled={saving || sending || !activeBotId || !activeChatroomId}>
                {sending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <ImagePlus data-icon="inline-start" />}
                保存并发送到群聊
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        上游模板和 WebUI 上传的自定义图片都会显示在这里；上传的图片会持久化保存，刷新页面或重启服务后仍可使用。
      </CardFooter>
    </Card>
  )
}
