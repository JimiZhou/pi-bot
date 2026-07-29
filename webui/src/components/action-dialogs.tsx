import { useState, type FormEvent } from "react"
import { Bot, BrainCircuit, Cable, MessageSquarePlus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

type ResourceKind = "bot" | "adapter" | "session" | "model"

const dialogCopy: Record<
  ResourceKind,
  { title: string; description: string; button: string; field: string; placeholder: string }
> = {
  bot: {
    title: "创建 Bot",
    description: "创建运行实例，并在稍后绑定模型路由与适配器。",
    button: "新建 Bot",
    field: "Bot 名称",
    placeholder: "例如：知识助手",
  },
  adapter: {
    title: "接入适配器",
    description: "按照能力声明规范注册一个可替换的消息通道适配器。",
    button: "接入适配器",
    field: "适配器名称",
    placeholder: "例如：Team Gateway",
  },
  session: {
    title: "开始测试会话",
    description: "通过已启用的 Bot 和适配器验证完整消息处理链路。",
    button: "测试会话",
    field: "会话备注",
    placeholder: "例如：回归测试 01",
  },
  model: {
    title: "测试模型路由",
    description: "发送一条测试输入，检查主模型、备用策略和响应耗时。",
    button: "测试路由",
    field: "测试输入",
    placeholder: "输入一条用于验证路由的消息",
  },
}

const dialogIcons = {
  bot: Bot,
  adapter: Cable,
  session: MessageSquarePlus,
  model: BrainCircuit,
}

export function ResourceDialog({ kind, compact = false }: { kind: ResourceKind; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const copy = dialogCopy[kind]
  const Icon = dialogIcons[kind]

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={compact ? "sm" : "default"}>
          {compact ? <Plus data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
          {copy.button}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </div>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5">
            <div className="grid gap-2">
              <Label htmlFor={`${kind}-name`}>{copy.field}</Label>
              <Input id={`${kind}-name`} name="name" placeholder={copy.placeholder} required autoFocus />
            </div>
            {kind === "adapter" ? (
              <div className="grid gap-2">
                <Label htmlFor="adapter-endpoint">事件入口</Label>
                <Input id="adapter-endpoint" name="endpoint" placeholder="https://gateway.example/events" required />
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor={`${kind}-route`}>
                  {kind === "session" ? "使用 Bot" : kind === "model" ? "测试路由" : "默认模型路由"}
                </Label>
                <Select name="route" defaultValue="primary">
                  <SelectTrigger id={`${kind}-route`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">{kind === "session" ? "主助手" : "通用对话路由"}</SelectItem>
                    <SelectItem value="secondary">{kind === "session" ? "运维助手" : "快速响应路由"}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor={`${kind}-description`}>说明</Label>
              <Textarea
                id={`${kind}-description`}
                name="description"
                placeholder="补充用途、范围或接入说明（可选）"
                className="min-h-20 resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit">确认创建</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
