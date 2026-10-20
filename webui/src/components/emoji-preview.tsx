import { useEffect, useState } from "react"
import { ImageOff, LoaderCircle } from "lucide-react"

import { useAdmin } from "@/lib/admin-context"
import { cn } from "@/lib/utils"
import type { EmojiRecord } from "@/types/admin"

export function EmojiPreview({
  emoji,
  className,
}: {
  emoji: Pick<EmojiRecord, "id" | "description">
  className?: string
}) {
  const { client } = useAdmin()
  const [preview, setPreview] = useState<{ id: string; source: string; failed: boolean }>({
    id: "",
    source: "",
    failed: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ""
    void client.emojiContent(emoji.id, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setPreview({ id: emoji.id, source: objectUrl, failed: false })
      },
      (cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setPreview({ id: emoji.id, source: "", failed: true })
        }
      },
    )
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [client, emoji.id])

  if (preview.id === emoji.id && preview.failed) {
    return (
      <span className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageOff className="size-5" aria-label="预览加载失败" />
      </span>
    )
  }
  if (preview.id !== emoji.id || !preview.source) {
    return (
      <span className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <LoaderCircle className="size-5 animate-spin" aria-label="正在加载预览" />
      </span>
    )
  }
  return <img src={preview.source} alt={emoji.description || "表情包"} loading="lazy" className={cn("object-contain", className)} />
}
