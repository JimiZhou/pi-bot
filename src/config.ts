/** Configuration shared by transport-independent feature plugins. */
export interface BotPluginConfig {
  id: string;
  type: string;
  enabled: boolean;
  settings: Readonly<Record<string, unknown>>;
}

export interface PersonaProfile {
  id: string;
  label: string;
  prompt: string;
  accountDisplayName?: string;
  conversationDisplayName?: string;
  wakeWords: string[];
  avatarDataUrl?: string;
  autoApplyChannelProfile: boolean;
  enabled: boolean;
}

export type KnowledgeProviderKind = "searxng" | "brave" | "tavily";

export interface KnowledgeProviderProfile {
  id: string;
  label: string;
  kind: KnowledgeProviderKind;
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
  enabled: boolean;
}

export type McpAuthType = "none" | "bearer" | "api-key";

export interface McpServerProfile {
  id: string;
  label: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxTools: number;
  enabled: boolean;
}
