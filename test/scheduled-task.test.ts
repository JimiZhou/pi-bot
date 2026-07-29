import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentPluginContext } from "../src/agent-plugin.js";
import type { BotPluginConfig } from "../src/config.js";
import type { ChannelRuntime } from "../src/channel.js";
import type { GroupAgentCore } from "../src/core.js";
import {
  ScheduledTaskPlugin,
  createScheduledTaskToolProvider,
} from "../src/plugins/scheduled-task.js";
import {
  nextScheduledTaskRun,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskDraft,
  type ScheduledTaskRepository,
  type ScheduledTaskUpdateInput,
} from "../src/scheduled-task.js";
import type { InboundMessageEvent } from "../src/types.js";

const CONFIG: BotPluginConfig = {
  id: "scheduled-task",
  type: "scheduled-task",
  enabled: true,
  settings: { draftTimeoutMinutes: 30, maxTasksPerGroup: 20, dueBatchSize: 10 },
};

test("scheduled task recurrence uses the configured local timezone", () => {
  const after = Date.UTC(2026, 6, 19, 23, 30);
  assert.equal(nextScheduledTaskRun({ type: "once", runAt: after + 60_000 }, 480, after), after + 60_000);
  assert.equal(nextScheduledTaskRun({ type: "once", runAt: after }, 480, after), null);
  assert.equal(nextScheduledTaskRun({ type: "daily", minute: 8 * 60 }, 480, after), Date.UTC(2026, 6, 20, 0, 0));
  assert.equal(
    nextScheduledTaskRun({ type: "weekly", minute: 9 * 60, weekdays: [2] }, 480, after),
    Date.UTC(2026, 6, 21, 1, 0),
  );
});

test("the scheduling dialog accepts only explicitly addressed group messages", () => {
  const repository = new MemoryTaskRepository();
  const plugin = new ScheduledTaskPlugin(CONFIG, pluginContext(repository));
  assert.equal(plugin.handleInbound(event("明天提醒大家提交周报", false)), undefined);

  const first = plugin.handleInbound(event("明天提醒大家提交周报"));
  assert.equal(first?.kind, "agent-prompt");
  assert.ok(repository.getScheduledTaskDraft("bot-1", "group-1", "member-1"));

  const cancelled = plugin.handleInbound(event("算了"));
  assert.deepEqual(cancelled, {
    kind: "direct-reply",
    reason: "plugin-scheduled-task-cancelled",
    text: "好，这个定时任务不建了。",
  });
  assert.equal(repository.getScheduledTaskDraft("bot-1", "group-1", "member-1"), undefined);
});

test("the scheduling tool preserves confirmation state before creating a risky task", async () => {
  const repository = new MemoryTaskRepository();
  const provider = createScheduledTaskToolProvider({
    botId: "bot-1",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    config: CONFIG,
    repository,
    isEnabled: () => true,
    log: () => undefined,
  });
  const tool = provider({ event: event("创建定时任务"), stagePart: () => undefined })[0]!;
  const runAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const first = await tool.execute("risk", {
    action: "create",
    title: "清理文件",
    content: "删除群文件",
    scheduleType: "once",
    runAt,
    riskLevel: "needs_confirmation",
    riskReason: "删除操作不可逆",
  });
  assert.equal(first.details.action, "confirm");
  assert.equal(repository.listScheduledTasks().length, 0);

  const created = await tool.execute("confirmed", {
    action: "create",
    title: "清理文件",
    content: "删除群文件",
    scheduleType: "once",
    runAt,
    riskLevel: "safe",
    confirmed: true,
  });
  assert.equal(created.details.action, "created");
  assert.equal(repository.listScheduledTasks().length, 1);
});

function event(text: string, mentioned = true): InboundMessageEvent {
  return {
    type: "message",
    id: randomUUID(),
    conversation: { id: "group-1", kind: "group", title: "测试群" },
    sender: { id: "member-1", displayName: "阿青" },
    text,
    timestamp: Date.now(),
    ...(mentioned ? { mentions: [{ id: "bot-identity", displayName: "测试机器人" }] } : {}),
  };
}

function pluginContext(repository: ScheduledTaskRepository): AgentPluginContext {
  return {
    botId: "bot-1",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    core: {} as GroupAgentCore,
    runtime: {} as ChannelRuntime,
    scheduledTasks: repository,
    claim: () => true,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
  };
}

class MemoryTaskRepository implements ScheduledTaskRepository {
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #drafts = new Map<string, ScheduledTaskDraft>();

  listScheduledTasks(query: { botId?: string; conversationId?: string } = {}): ScheduledTask[] {
    return [...this.#tasks.values()].filter((task) =>
      (!query.botId || task.botId === query.botId) &&
      (!query.conversationId || task.conversationId === query.conversationId));
  }

  createScheduledTask(input: ScheduledTaskCreateInput): ScheduledTask {
    const now = Date.now();
    const task: ScheduledTask = {
      ...input,
      id: randomUUID(),
      enabled: input.enabled ?? true,
      nextRunAt: nextScheduledTaskRun(input.schedule, input.timezoneOffsetMinutes, now),
      lastRunAt: null,
      lastStatus: "never",
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.id, task);
    return task;
  }

  updateScheduledTask(id: string, input: ScheduledTaskUpdateInput): ScheduledTask {
    const current = this.#requiredTask(id);
    const updated = { ...current, ...input, updatedAt: Date.now() };
    this.#tasks.set(id, updated);
    return updated;
  }

  deleteScheduledTask(id: string): boolean {
    return this.#tasks.delete(id);
  }

  claimDueScheduledTasks(botId: string, now: number, limit = 20): ScheduledTask[] {
    return this.listScheduledTasks({ botId }).filter((task) => task.enabled && (task.nextRunAt ?? Infinity) <= now).slice(0, limit);
  }

  completeScheduledTaskRun(
    id: string,
    scheduledFor: number,
    result: { success: boolean; error?: string; completedAt: number },
  ): ScheduledTask {
    const current = this.#requiredTask(id);
    const nextRunAt = nextScheduledTaskRun(current.schedule, current.timezoneOffsetMinutes, result.completedAt);
    const updated: ScheduledTask = {
      ...current,
      enabled: nextRunAt !== null,
      nextRunAt,
      lastRunAt: scheduledFor,
      lastStatus: result.success ? "succeeded" : "failed",
      ...(result.error ? { lastError: result.error } : {}),
      updatedAt: result.completedAt,
    };
    this.#tasks.set(id, updated);
    return updated;
  }

  getScheduledTaskDraft(botId: string, conversationId: string, creatorId: string, now = Date.now()): ScheduledTaskDraft | undefined {
    const draft = this.#drafts.get(this.#draftKey(botId, conversationId, creatorId));
    return draft && draft.expiresAt > now ? draft : undefined;
  }

  saveScheduledTaskDraft(input: Omit<ScheduledTaskDraft, "createdAt" | "updatedAt">): ScheduledTaskDraft {
    const now = Date.now();
    const key = this.#draftKey(input.botId, input.conversationId, input.creatorId);
    const draft = { ...input, createdAt: this.#drafts.get(key)?.createdAt ?? now, updatedAt: now };
    this.#drafts.set(key, draft);
    return draft;
  }

  deleteScheduledTaskDraft(botId: string, conversationId: string, creatorId: string): boolean {
    return this.#drafts.delete(this.#draftKey(botId, conversationId, creatorId));
  }

  #requiredTask(id: string): ScheduledTask {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  #draftKey(botId: string, conversationId: string, creatorId: string): string {
    return `${botId}\u0000${conversationId}\u0000${creatorId}`;
  }
}
