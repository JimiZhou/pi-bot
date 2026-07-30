import type { ComponentType } from "react"

import type { BotChannelConfig } from "@/types/admin"

export interface AdapterConfigFieldsProps {
  channel?: BotChannelConfig
}

export interface AdapterAdminExtension {
  type: BotChannelConfig["type"]
  label: string
  description: string
  ConfigFields: ComponentType<AdapterConfigFieldsProps>
  createDefault(port: number): BotChannelConfig
  readConfig(form: FormData): BotChannelConfig
}
