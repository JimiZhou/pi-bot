import { createHash } from "node:crypto";
import type { AgentPlugin, AgentPluginContext, AgentPluginFactory } from "../agent-plugin.js";
import type { BotPluginConfig } from "../config.js";

interface MorningBriefSettings {
  minute: number;
  activeGroupMinMessages: number;
}

export class MorningBriefPlugin implements AgentPlugin {
  readonly id: string;
  readonly type = "morning-brief";
  readonly #context: AgentPluginContext;
  readonly #settings: MorningBriefSettings;

  constructor(config: BotPluginConfig, context: AgentPluginContext) {
    this.id = config.id;
    this.#context = context;
    this.#settings = parseSettings(config.settings);
  }

  async tick(now: number): Promise<void> {
    const clock = localClock(now, this.#context.timezoneOffsetMinutes);
    if (!isMinuteWithin(clock.minute, this.#settings.minute, this.#settings.minute + 120)) return;
    const day = localDay(now, this.#context.timezoneOffsetMinutes);
    const previousStart = day.startAt - 24 * 60 * 60_000;
    const groups = this.#context.core.listGroupActivity(
      previousStart,
      day.startAt,
      this.#settings.activeGroupMinMessages,
    );
    if (groups.length === 0) return;
    for (const group of groups) {
      if (!this.#context.isEnabledForConversation(this.type, group.conversationId)) continue;
      const canonical = canonicalConversationId(group.conversationId);
      const claimKey = `morning-brief:${clock.dateKey}:${canonical}`;
      if (!this.#context.claim({
        claimKey,
        canonicalConversationId: canonical,
        reason: "morning-brief",
        createdAt: now,
        ambient: false,
      })) continue;
      try {
        const result = await this.#context.runtime.sendProactiveText({
          id: scheduledEventId(this.id, clock.dateKey, canonical),
          kind: "morning-brief",
          conversationId: group.conversationId,
          prompt: "这是每日早安问候任务。只发送一句简短自然的早安，不总结昨日聊天，不列活跃排名，不发送新闻。",
          timestamp: now,
        }, morningGreeting());
        this.#context.log(
          "info",
          "plugin.morning_brief",
          "已发送群聊早安",
          {
            conversationId: group.conversationId,
            delivered: result.delivery.delivered.length,
          },
        );
      } catch (error) {
        this.#context.releaseClaim(claimKey);
        this.#context.log("error", "plugin.morning_brief_failed", errorMessage(error), {
          conversationId: group.conversationId,
        });
      }
    }
  }
}

export const morningBriefPluginFactory: AgentPluginFactory = {
  type: "morning-brief",
  create: (config, context) => new MorningBriefPlugin(config, context),
};

function parseSettings(value: Readonly<Record<string, unknown>>): MorningBriefSettings {
  const minute = integer(value.minute ?? 7 * 60 + 15, 0, 1439, "morning-brief minute");
  const activeGroupMinMessages = integer(
    value.activeGroupMinMessages ?? 5,
    1,
    1000,
    "morning-brief activeGroupMinMessages",
  );
  return { minute, activeGroupMinMessages };
}

function canonicalConversationId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function localDay(timestamp: number, timezoneOffsetMinutes: number): { startAt: number } {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const dayMs = 24 * 60 * 60_000;
  return { startAt: Math.floor((timestamp + offsetMs) / dayMs) * dayMs - offsetMs };
}

function localClock(timestamp: number, timezoneOffsetMinutes: number): { minute: number; dateKey: string } {
  const shifted = new Date(timestamp + timezoneOffsetMinutes * 60_000);
  return { minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), dateKey: shifted.toISOString().slice(0, 10) };
}

function isMinuteWithin(value: number, start: number, end: number): boolean {
  const day = 24 * 60;
  const minute = ((value % day) + day) % day;
  const normalizedStart = ((start % day) + day) % day;
  const normalizedEnd = ((end % day) + day) % day;
  if (normalizedStart === normalizedEnd) return true;
  if (normalizedStart < normalizedEnd) return minute >= normalizedStart && minute < normalizedEnd;
  return minute >= normalizedStart || minute < normalizedEnd;
}

function scheduledEventId(pluginId: string, dateKey: string, identity: string): string {
  const digest = createHash("sha256").update(`${pluginId}\u0000${dateKey}\u0000${identity}`).digest("hex").slice(0, 24);
  return `plugin:${pluginId}:${dateKey}:${digest}`;
}

function morningGreeting(): string {
  return "早安，大家！新的一天顺顺利利，心情愉快～";
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
