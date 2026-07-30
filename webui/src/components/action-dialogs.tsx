import { Bot, BrainCircuit, Cable, MessageSquarePlus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"

type ResourceKind = "bot" | "adapter" | "session" | "model"

const actionCopy = {
  bot: { label: "管理 Bot", icon: Bot },
  adapter: { label: "管理适配器", icon: Cable },
  session: { label: "管理会话", icon: MessageSquarePlus },
  model: { label: "管理模型", icon: BrainCircuit },
} satisfies Record<ResourceKind, { label: string; icon: typeof Bot }>

export function ResourceDialog({ kind, compact = false }: { kind: ResourceKind; compact?: boolean }) {
  const action = actionCopy[kind]
  const Icon = compact ? Plus : action.icon
  return (
    <Button size={compact ? "sm" : "default"} asChild>
      <a href={`#${kind === "session" ? "chatrooms" : kind === "model" ? "models" : kind === "adapter" ? "adapters" : "bots"}`}>
        <Icon data-icon="inline-start" />
        {action.label}
      </a>
    </Button>
  )
}
