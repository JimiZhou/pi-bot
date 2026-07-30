import type { ComponentType, LazyExoticComponent } from "react"
import type { LucideIcon } from "lucide-react"

import type { ConsoleSnapshot } from "@/types/console"

export type ConsoleModuleGroup = "runtime" | "intelligence" | "conversations" | "wechat" | "system"

export interface ConsoleModuleProps {
  snapshot: ConsoleSnapshot
}

export interface ConsoleModule {
  id: string
  label: string
  description: string
  group: ConsoleModuleGroup
  icon: LucideIcon
  component: ComponentType<ConsoleModuleProps> | LazyExoticComponent<ComponentType<ConsoleModuleProps>>
  order?: number
}
