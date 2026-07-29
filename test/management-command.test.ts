import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPluginContext } from "../src/agent-plugin.js";
import type { BotPluginConfig, PersonaProfile } from "../src/config.js";
import { PersonaCommandPlugin, parseManagementCommand } from "../src/plugins/persona-command.js";
import type { InboundMessageEvent } from "../src/types.js";

const CONFIG: BotPluginConfig = {
  id: "persona-command",
  type: "persona-command",
  enabled: true,
  settings: {},
};

const PERSONA: PersonaProfile = {
  id: "quiet-friend",
  label: "安静朋友",
  prompt: "简短自然地回复。",
  wakeWords: [],
  autoApplyChannelProfile: false,
  enabled: true,
};

test("management command parser only accepts an explicit command body", () => {
  assert.deepEqual(parseManagementCommand("@欧本克劳\u2005菜单"), { action: "menu" });
  assert.deepEqual(parseManagementCommand("重置上下文。"), { action: "context-reset" });
  assert.deepEqual(parseManagementCommand("@欧本克劳 切换人设 安静朋友"), {
    action: "switch",
    query: "安静朋友",
  });
  assert.deepEqual(parseManagementCommand("@欧本克劳 插件状态"), { action: "plugin-status" });
  assert.deepEqual(parseManagementCommand("@欧本克劳 开启插件 复读机"), {
    action: "plugin-enable",
    query: "复读机",
  });
  assert.deepEqual(parseManagementCommand("@欧本克劳 把本群音色改成年轻愉悦女声"), {
    action: "voice-set",
    query: "年轻愉悦女声",
  });
  assert.deepEqual(parseManagementCommand("@欧本克劳 以后用年轻、温柔、有笑意的女声回复语音"), {
    action: "voice-set",
    query: "年轻、温柔、有笑意的女声",
  });
  assert.deepEqual(parseManagementCommand("@欧本克劳 当前音色"), { action: "voice-current" });
  assert.equal(parseManagementCommand("我想到一个菜单设计，你看看"), undefined);
  assert.equal(parseManagementCommand("能不能顺便重置上下文"), undefined);
});

test("mutating room commands require whitelist permission and reset context after persona changes", () => {
  let personaId: string | null = null;
  let resetCount = 0;
  let authorized = false;
  let repeaterEnabled = false;
  let voiceStyle = {
    voice: "Leda",
    style: "年轻愉悦",
    presetId: "young-pleasant" as string | null,
    presetLabel: "年轻愉悦女声" as string | null,
    overridden: false,
  };
  const context = {
    botId: "bot-main",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    personas: {
      list: () => [PERSONA],
      current: () => personaId ? PERSONA : undefined,
      set: (_conversationId: string, selected: string | null) => {
        personaId = selected;
        return selected ? PERSONA : undefined;
      },
    },
    management: {
      isManager: () => authorized,
      listManagerIds: () => ["member-admin"],
      resetContext: (conversationId: string, actorId: string, sourceEventId: string) => {
        resetCount += 1;
        return { conversationId, afterSequence: 0, afterTimestamp: 0, resetBy: actorId, sourceEventId, resetAt: Date.now() };
      },
      contextReset: () => undefined,
      sessionStatuses: () => [{
        botId: "bot-main",
        displayName: "测试机器人",
        personaProfileId: personaId,
        sessionId: `session:${personaId ?? "default"}`,
        sessionScope: personaId ?? "default",
        contextEpoch: resetCount,
      }],
      listPlugins: () => [{
        type: "repeater",
        label: "复读机",
        enabled: repeaterEnabled,
        defaultEnabled: false,
        overridden: repeaterEnabled,
      }],
      setPlugin: (_conversationId: string, pluginType: string, enabled: boolean) => {
        assert.equal(pluginType, "repeater");
        repeaterEnabled = enabled;
        return {
          type: "repeater",
          label: "复读机",
          enabled,
          defaultEnabled: false,
          overridden: true,
        };
      },
      voiceStyle: () => voiceStyle,
      setVoiceStyle: (_conversationId: string, query: string | null) => {
        voiceStyle = query === null
          ? { ...voiceStyle, overridden: false }
          : {
              voice: "Sulafat",
              style: query,
              presetId: null,
              presetLabel: null,
              overridden: true,
            };
        return voiceStyle;
      },
      historyLimit: 50,
      maxHistoryChars: 12_000,
    },
    claim: () => true,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
  } as unknown as AgentPluginContext;
  const plugin = new PersonaCommandPlugin(CONFIG, context);
  const event: InboundMessageEvent = {
    type: "message",
    id: "command-1",
    conversation: { id: "room-group", kind: "group" },
    sender: { id: "member-user", displayName: "普通群友" },
    text: "@欧本克劳 切换人设 安静朋友",
    mentions: [{ id: "bot-identity" }],
    timestamp: 1_700_000_000_000,
  };

  const denied = plugin.handleInbound(event);
  assert.equal(denied?.kind, "direct-reply");
  assert.match(denied?.kind === "direct-reply" ? denied.text : "", /不在.*白名单/u);
  assert.equal(personaId, null);
  assert.equal(resetCount, 0);

  authorized = true;
  const switched = plugin.handleInbound({ ...event, id: "command-2", sender: { id: "member-admin", displayName: "管理员" } });
  assert.equal(switched?.kind, "direct-reply");
  assert.match(switched?.kind === "direct-reply" ? switched.text : "", /切换.*重置短期/u);
  assert.equal(personaId, PERSONA.id);
  assert.equal(resetCount, 1);

  const pluginChanged = plugin.handleInbound({
    ...event,
    id: "command-3",
    text: "@欧本克劳 开启插件 复读机",
    sender: { id: "member-admin", displayName: "管理员" },
  });
  assert.equal(pluginChanged?.kind, "direct-reply");
  assert.match(pluginChanged?.kind === "direct-reply" ? pluginChanged.text : "", /已开启.*复读机.*立即生效/u);
  assert.equal(repeaterEnabled, true);

  const voiceChanged = plugin.handleInbound({
    ...event,
    id: "command-voice",
    text: "@欧本克劳 设置音色 温柔、细腻、感情丰富的年轻女声",
    sender: { id: "member-admin", displayName: "管理员" },
  });
  assert.match(voiceChanged?.kind === "direct-reply" ? voiceChanged.text : "", /自定义风格.*立即生效.*不影响其他群/su);
  assert.equal(voiceStyle.overridden, true);

  assert.equal(plugin.handleInbound({ ...event, id: "no-mention", mentions: [] }), undefined);
});

test("private chats expose menu, persona switching, context reset, and the current session without @", () => {
  let personaId: string | null = null;
  let resetEpoch = 0;
  const context = {
    botId: "bot-main",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    personas: {
      list: () => [PERSONA],
      current: () => personaId ? PERSONA : undefined,
      set: (_conversationId: string, selected: string | null) => {
        personaId = selected;
        return selected ? PERSONA : undefined;
      },
    },
    management: {
      isManager: () => false,
      listManagerIds: () => [],
      memberDisplayName: (_conversationId: string, memberId: string) => memberId,
      resetContext: (conversationId: string, actorId: string, sourceEventId: string) => {
        resetEpoch += 1;
        return {
          conversationId,
          afterSequence: 0,
          afterTimestamp: 0,
          resetBy: actorId,
          sourceEventId,
          resetAt: resetEpoch,
        };
      },
      contextReset: (conversationId: string) => resetEpoch > 0 ? {
        conversationId,
        afterSequence: 0,
        afterTimestamp: 0,
        resetBy: "member-1",
        sourceEventId: "private-command",
        resetAt: resetEpoch,
      } : undefined,
      sessionStatuses: () => [{
        botId: "bot-main",
        displayName: "测试机器人",
        personaProfileId: personaId,
        sessionId: `chat:direct:bot-main:account:member-1:scope:${personaId ?? "default"}:epoch:${resetEpoch}`,
        sessionScope: personaId ?? "default",
        contextEpoch: resetEpoch,
      }],
      listPlugins: () => [],
      setPlugin: () => { throw new Error("private chat must not change group plugins"); },
      voiceStyle: () => ({
        voice: "Leda",
        style: "年轻愉悦",
        presetId: "young-pleasant",
        presetLabel: "年轻愉悦女声",
        overridden: false,
      }),
      setVoiceStyle: () => { throw new Error("private chat must not change group voice style"); },
      historyLimit: 50,
      maxHistoryChars: 12_000,
    },
    claim: () => true,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
  } as unknown as AgentPluginContext;
  const plugin = new PersonaCommandPlugin(CONFIG, context);
  const event: InboundMessageEvent = {
    type: "message",
    id: "private-menu",
    conversation: { id: "account:member-1", kind: "direct" },
    sender: { id: "member-1", displayName: "私聊用户" },
    text: "菜单",
    timestamp: 1_700_000_000_000,
  };

  const menu = plugin.handleInbound(event);
  assert.equal(menu?.kind, "direct-reply");
  assert.match(menu?.kind === "direct-reply" ? menu.text : "", /无需 @/u);
  assert.match(menu?.kind === "direct-reply" ? menu.text : "", /只影响当前私聊/u);

  const switched = plugin.handleInbound({ ...event, id: "private-switch", text: "切换人设 安静朋友" });
  assert.equal(switched?.kind, "direct-reply");
  assert.match(switched?.kind === "direct-reply" ? switched.text : "", /当前私聊已切换/u);
  assert.match(switched?.kind === "direct-reply" ? switched.text : "", /scope:quiet-friend:epoch:1/u);
  assert.equal(personaId, PERSONA.id);
  assert.equal(resetEpoch, 1);

  const status = plugin.handleInbound({ ...event, id: "private-status", text: "上下文状态" });
  assert.equal(status?.kind, "direct-reply");
  assert.match(status?.kind === "direct-reply" ? status.text : "", /当前模型 Session/u);
  assert.match(status?.kind === "direct-reply" ? status.text : "", /scope:quiet-friend:epoch:1/u);

  const reset = plugin.handleInbound({ ...event, id: "private-reset", text: "重置上下文" });
  assert.equal(reset?.kind, "direct-reply");
  assert.match(reset?.kind === "direct-reply" ? reset.text : "", /scope:quiet-friend:epoch:2/u);
  assert.equal(resetEpoch, 2);

  const groupOnly = plugin.handleInbound({ ...event, id: "private-plugin", text: "插件状态" });
  assert.match(groupOnly?.kind === "direct-reply" ? groupOnly.text : "", /仅支持群聊/u);
});
