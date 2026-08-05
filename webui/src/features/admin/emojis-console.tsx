import { useCallback, useState, type FormEvent } from "react"
import { Edit3, Search } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  CheckboxField,
  ConfirmButton,
  ReloadButton,
  TextareaField,
} from "@/components/admin-primitives"
import { EmptyState, PageHeader, StatusPill } from "@/components/console-primitives"
import { EmojiPreview } from "@/components/emoji-preview"
import MemeGeneratorPanel from "@/features/admin/meme-generator-panel"
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
import { Input } from "@/components/ui/input"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formBoolean, formText } from "@/lib/form-data"
import type { EmojiRecord } from "@/types/admin"

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export default function EmojisConsole() {
  const { client } = useAdmin()
  const load = useCallback(async () => (await client.emojis()).emojis, [client])
  const resource = useAdminResource(load)
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<EmojiRecord | null>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const emojis = (resource.data ?? []).filter((emoji) =>
    !normalized || emoji.description.toLocaleLowerCase().includes(normalized) || emoji.id.includes(normalized))

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    const data = new FormData(event.currentTarget)
    const saved = await resource.mutate(
      () => client.updateEmoji(editing.id, {
        description: formText(data, "description"),
        enabled: formBoolean(data, "enabled"),
        isThinking: formBoolean(data, "isThinking"),
      }),
      "表情包配置已保存",
    )
    if (saved) setEditing(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="微信扩展"
        title="表情包管理"
        description="管理运行时收集的微信动态表情描述、启用状态，以及思考反馈用途。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      <MemeGeneratorPanel onEmojiSaved={() => void resource.reload()} />
      <div className="relative max-w-lg">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索描述或 ID" className="pl-8" />
      </div>
      {resource.loading ? <AdminLoading label="正在加载表情包" /> : null}
      {!resource.loading && emojis.length === 0 ? (
        <EmptyState title="没有匹配的表情包" description="Bot 收到支持的动态表情后会自动进入素材库。" />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {emojis.map((emoji) => (
          <Card key={emoji.id} className="shadow-none">
            <CardHeader>
              <EmojiPreview emoji={emoji} className="mb-2 size-28 rounded-xl border" />
              <CardTitle>{emoji.description || "未命名表情"}</CardTitle>
              <CardDescription className="truncate font-mono">{emoji.id}</CardDescription>
              <CardAction><StatusPill label={emoji.enabled ? "已启用" : "已停用"} tone={emoji.enabled ? "positive" : "muted"} /></CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Badge variant="outline">{emoji.mimeType}</Badge>
              <Badge variant="outline">{formatBytes(emoji.size)}</Badge>
              <Badge variant={emoji.status === "failed" ? "destructive" : "outline"}>
                {emoji.status === "failed" ? "识别失败·自动重试" : emoji.status === "analyzing" ? "识别中" : "已识别"}
              </Badge>
              {emoji.isThinking ? <Badge variant="secondary">思考反馈</Badge> : null}
            </CardContent>
            <CardFooter className="justify-between">
              <Button size="sm" variant="outline" onClick={() => setEditing(emoji)}>
                <Edit3 data-icon="inline-start" /> 编辑
              </Button>
              <ConfirmButton
                title="删除这个表情包？"
                description="素材及其描述会从表情库删除。"
                onConfirm={() => void resource.mutate(() => client.deleteEmoji(emoji.id), "表情包已删除")}
              />
            </CardFooter>
          </Card>
        ))}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑表情包</DialogTitle>
            <DialogDescription className="font-mono">{editing?.id}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <form onSubmit={save} className="space-y-4">
              <TextareaField label="语义描述" name="description" rows={4} defaultValue={editing.description} required />
              <CheckboxField label="允许 Bot 发送" name="enabled" defaultChecked={editing.enabled} />
              <CheckboxField label="可用于思考反馈" name="isThinking" defaultChecked={editing.isThinking} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
