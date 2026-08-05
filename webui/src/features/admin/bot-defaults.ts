import type { BotAgentLimits, BotConfig, SocialScheduleConfig } from "@/types/admin"

export const defaultBotLimits: BotAgentLimits = {
  historyLimit: 50,
  maxHistoryChars: 12000,
  memoryLimit: 12,
  behaviorLimit: 12,
  continuationWindowMs: 300000,
  messageBurstDebounceMs: 8000,
  explicitMessageBurstDebounceMs: 900,
  maxAgentLlmCalls: 6,
  maxAgentToolCalls: 8,
  agentTimeoutMs: 120000,
  maxReplyChars: 2000,
  maxImageUnderstandingCalls: 2,
  maxImageBytes: 10485760,
  maxImageEvidenceChars: 4000,
  imageUnderstandingTimeoutMs: 45000,
  imageContextMessageLimit: 8,
  imageContextWindowMs: 600000,
  maxAvailableImagesPerTurn: 4,
}

export const defaultSocialSchedule: SocialScheduleConfig = {
  enabled: false,
  timezoneOffsetMinutes: 480,
  activeStartMinute: 420,
  activeEndMinute: 1380,
  hotChatWindowMs: 180000,
  hotChatMinMessages: 10,
  hotChatMinParticipants: 4,
  hotChatCooldownMs: 1800000,
  coldChatAfterMs: 14400000,
  coldChatCooldownMs: 86400000,
  maxDailyAmbientMessages: 3,
  goodnightEnabled: true,
  goodnightMinute: 1380,
  activeGroupMinMessages: 5,
}

export function createDefaultBot(id: string): BotConfig {
  return {
    id,
    enabled: false,
    identityId: id,
    displayName: id,
    wakeWords: [],
    operatorIds: [],
    defaultGroupActivation: "mention",
    chatModelProfileId: null,
    fastChatModelProfileId: null,
    participationJudgeModelProfileId: null,
    fallbackChatModelProfileIds: [],
    visionModelProfileId: null,
    personaProfileId: null,
    chatroomModelOverrides: [],
    imageUnderstandingEnabled: true,
    databaseFile: `bots/${id}/agent.sqlite`,
    channel: { type: "example", settings: {} },
    limits: { ...defaultBotLimits },
    socialSchedule: { ...defaultSocialSchedule },
    plugins: [],
  }
}
