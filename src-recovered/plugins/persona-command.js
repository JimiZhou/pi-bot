import { TTS_VOICE_PRESETS } from "../voice-style.js";
import { parseConversationVoiceModeCommand } from "../reply-modality.js";
/** Exact command surface: private chats need no mention; group chats require @bot. */
export class PersonaCommandPlugin {
    id;
    type = "persona-command";
    #context;
    constructor(config, context) {
        this.id = config.id;
        this.#context = context;
        if (!context.personas)
            throw new Error("persona-command plugin requires a persona manager");
        if (!context.management)
            throw new Error("persona-command plugin requires a room management service");
    }
    handleInbound(event) {
        const isGroup = event.conversation.kind === "group";
        if (isGroup && !mentionsIdentity(event, [this.#context.identityId, ...(this.#context.identityAliases?.(event.conversation.id) ?? [])]))
            return undefined;
        const command = parseManagementCommand(event.text);
        if (!command)
            return undefined;
        const manager = this.#context.personas;
        const management = this.#context.management;
        const profiles = manager.list().filter((profile) => profile.enabled);
        const current = manager.current(event.conversation.id);
        const authorized = !isGroup || management.isManager(event.conversation.id, event.sender.id);
        const scope = isGroup ? "本群" : "当前私聊";
        const commandPrefix = isGroup ? "@我 " : "";
        if (command.action === "menu") {
            return {
                kind: "direct-reply",
                reason: "plugin-management-menu",
                text: managementMenu(authorized, isGroup),
            };
        }
        if (command.action === "list") {
            const rows = profiles.map((profile, index) => `${index + 1}. ${profile.label}${profile.id === current?.id ? "（当前）" : ""} · ${profile.id}`);
            const text = rows.length > 0
                ? `可用人设：\n${rows.join("\n")}\n发送“${commandPrefix}切换人设 名称”即可切换。`
                : "管理员还没有启用可切换的人设。";
            return { kind: "direct-reply", reason: "plugin-persona-list", text };
        }
        if (command.action === "current") {
            return {
                kind: "direct-reply",
                reason: "plugin-persona-current",
                text: current ? `${scope}当前人设：${current.label} · ${current.id}` : `${scope}当前使用机器人默认人设。`,
            };
        }
        if (command.action === "voice-list") {
            if (!isGroup)
                return groupOnlyReply("默认语音风格");
            const voiceStyle = management.voiceStyle(event.conversation.id);
            return {
                kind: "direct-reply",
                reason: "plugin-voice-style-list",
                text: [
                    "可用语音预设：",
                    ...TTS_VOICE_PRESETS.map((preset, index) => `${index + 1}. ${preset.label} · ${preset.voice}${preset.id === voiceStyle.presetId ? "（当前）" : ""}`),
                    "管理员可发送“@我 设置音色 <预设名称>”，也可以直接描述自定义风格。",
                    "例如：@我 以后用年轻、温柔、有笑意且感情丰富的女声回复语音",
                ].join("\n"),
            };
        }
        if (command.action === "voice-current") {
            if (!isGroup)
                return groupOnlyReply("默认语音风格");
            const voiceStyle = management.voiceStyle(event.conversation.id);
            return {
                kind: "direct-reply",
                reason: "plugin-voice-style-current",
                text: [
                    `本群默认语音：${voiceStyle.presetLabel ?? "自定义风格"} · ${voiceStyle.voice}`,
                    `表达风格：${voiceStyle.style}`,
                    voiceStyle.overridden ? "这是本群单独配置。" : "当前继承系统默认配置。",
                ].join("\n"),
            };
        }
        if (command.action === "voice-mode-current") {
            const mode = management.voiceMode(event.conversation.id);
            const label = mode === "whisper" ? "耳语模式" : mode === "voice" ? "语音模式" : "文字模式";
            return {
                kind: "direct-reply",
                reason: "plugin-voice-mode-current",
                text: `${scope}当前回复形态：${label}。`,
            };
        }
        if (command.action === "context-status") {
            const reset = management.contextReset(event.conversation.id);
            const sessions = management.sessionStatuses(event.conversation.id);
            return {
                kind: "direct-reply",
                reason: "plugin-context-status",
                text: [
                    `${scope}短期上下文上限：最近 ${management.historyLimit} 条消息、最多 ${management.maxHistoryChars.toLocaleString("zh-CN")} 个字符。`,
                    reset
                        ? `最近一次重置：${formatTimestamp(reset.resetAt, this.#context.timezoneOffsetMinutes)}。完整历史和长期记忆仍保留。`
                        : `${scope}还没有手动重置过上下文。`,
                    "当前模型 Session：",
                    ...sessions.map((session) => `- ${session.displayName}：${session.sessionId}`),
                ].join("\n"),
            };
        }
        if (command.action === "plugin-status") {
            if (!isGroup)
                return groupOnlyReply("插件状态与开关");
            const plugins = management.listPlugins(event.conversation.id);
            return {
                kind: "direct-reply",
                reason: "plugin-management-status",
                text: [
                    "本群插件状态：",
                    ...plugins.map((plugin) => `- ${plugin.enabled ? "已开启" : "已关闭"} ${plugin.label} · ${plugin.type}${plugin.overridden ? "（本群单独配置）" : "（跟随 Bot 默认）"}`),
                    "管理员可发送“@我 开启插件 <名称>”或“@我 关闭插件 <名称>”。",
                ].join("\n"),
            };
        }
        if (!authorized) {
            const configured = management.listManagerIds(event.conversation.id).length;
            return {
                kind: "direct-reply",
                reason: "plugin-management-forbidden",
                text: configured > 0
                    ? "你不在本群的机器人管理白名单中。请让后台管理员在“群聊管理”里添加。"
                    : "本群尚未配置机器人管理白名单。请先在后台“群聊管理”里从群成员中选择管理员。",
            };
        }
        if (command.action === "voice-mode-set") {
            const mode = management.setVoiceMode(event.conversation.id, command.mode);
            this.#context.log("info", "plugin.voice_mode_changed", "用户修改了持续语音回复模式", {
                conversationId: event.conversation.id,
                senderId: event.sender.id,
                mode,
            });
            return {
                kind: "agent-prompt",
                reason: "plugin-voice-mode-changed",
                prompt: mode === "text"
                    ? "用户刚刚退出了持续语音模式。请用一句简短自然的文字确认已经恢复文字回复。"
                    : mode === "whisper"
                        ? "用户刚刚开启了持续耳语模式。请用一句简短、自然、贴近聊天语境的耳语确认已经进入耳语模式。"
                        : "用户刚刚开启了持续语音模式。请用一句简短自然的语音确认，告诉对方接下来会积极使用语音对话。",
            };
        }
        if (command.action === "manager-list") {
            if (!isGroup)
                return groupOnlyReply("机器人管理白名单");
            const ids = management.listManagerIds(event.conversation.id);
            return {
                kind: "direct-reply",
                reason: "plugin-manager-list",
                text: ids.length > 0
                    ? `本群机器人管理白名单（${ids.length} 人）：\n${ids.map((id, index) => `${index + 1}. ${management.memberDisplayName(event.conversation.id, id)}`).join("\n")}`
                    : "本群没有单独配置机器人管理员；仅 Bot 全局操作员可执行管理命令。",
            };
        }
        if (command.action === "voice-set" || command.action === "voice-reset") {
            if (!isGroup)
                return groupOnlyReply("默认语音风格");
            const voiceStyle = management.setVoiceStyle(event.conversation.id, command.action === "voice-reset" ? null : command.query);
            this.#context.log("info", "plugin.voice_style_changed", "群聊管理员修改了本群默认语音风格", {
                conversationId: event.conversation.id,
                senderId: event.sender.id,
                voice: voiceStyle.voice,
                presetId: voiceStyle.presetId,
                overridden: voiceStyle.overridden,
            });
            return {
                kind: "direct-reply",
                reason: "plugin-voice-style-changed",
                text: command.action === "voice-reset"
                    ? `已恢复本群默认语音风格：${voiceStyle.presetLabel ?? voiceStyle.voice}，立即生效。`
                    : `已将本群默认语音设为“${voiceStyle.presetLabel ?? "自定义风格"}” · ${voiceStyle.voice}\n表达风格：${voiceStyle.style}\n立即生效，不影响其他群。`,
            };
        }
        if (command.action === "context-reset") {
            management.resetContext(event.conversation.id, event.sender.id, event.id);
            const sessions = management.sessionStatuses(event.conversation.id);
            this.#context.log("info", "plugin.context_reset", "群聊管理员重置了机器人短期上下文", {
                conversationId: event.conversation.id,
                senderId: event.sender.id,
            });
            return {
                kind: "direct-reply",
                reason: "plugin-context-reset",
                text: [
                    `已重置${scope}的短期对话上下文。完整聊天记录和长期记忆仍然保留。`,
                    ...sessions.map((session) => `${session.displayName} 新 Session：${session.sessionId}`),
                ].join("\n"),
            };
        }
        if (command.action === "plugin-enable" || command.action === "plugin-disable") {
            if (!isGroup)
                return groupOnlyReply("插件开关");
            const plugins = management.listPlugins(event.conversation.id);
            const matched = matchPlugin(plugins, command.query);
            if (!matched) {
                return {
                    kind: "direct-reply",
                    reason: "plugin-management-not-found",
                    text: `没找到插件“${command.query}”。发送“@我 插件状态”查看可管理插件。`,
                };
            }
            const enabled = command.action === "plugin-enable";
            const changed = management.setPlugin(event.conversation.id, matched.type, enabled);
            this.#context.log("info", "plugin.room_setting_changed", "群聊管理员修改了本群插件开关", {
                conversationId: event.conversation.id,
                senderId: event.sender.id,
                pluginType: changed.type,
                enabled,
            });
            return {
                kind: "direct-reply",
                reason: "plugin-management-changed",
                text: `已${enabled ? "开启" : "关闭"}本群的“${changed.label}”插件，立即生效。`,
            };
        }
        if (command.action === "reset") {
            manager.set(event.conversation.id, null);
            management.resetContext(event.conversation.id, event.sender.id, event.id);
            const sessions = management.sessionStatuses(event.conversation.id);
            this.#log(event, undefined);
            return {
                kind: "direct-reply",
                reason: "plugin-persona-reset",
                text: [
                    `已恢复${scope}的机器人默认人设，并重置短期对话上下文。`,
                    ...sessions.map((session) => `${session.displayName} 新 Session：${session.sessionId}`),
                ].join("\n"),
            };
        }
        const matches = matchProfiles(profiles, command.query);
        if (matches.length === 0) {
            return { kind: "direct-reply", reason: "plugin-persona-not-found", text: `没找到“${command.query}”。发送“${commandPrefix}人设列表”查看可用人设。` };
        }
        if (matches.length > 1) {
            return {
                kind: "direct-reply",
                reason: "plugin-persona-ambiguous",
                text: `名称不唯一，请使用完整名称或 ID：\n${matches.map((item) => `${item.label} · ${item.id}`).join("\n")}`,
            };
        }
        const selected = manager.set(event.conversation.id, matches[0].id);
        management.resetContext(event.conversation.id, event.sender.id, event.id);
        const sessions = management.sessionStatuses(event.conversation.id);
        this.#log(event, selected);
        return {
            kind: "direct-reply",
            reason: "plugin-persona-switched",
            text: [
                `${scope}已切换为“${selected.label}”，并重置短期对话上下文，新人设立即生效。`,
                ...sessions.map((session) => `${session.displayName} 新 Session：${session.sessionId}`),
            ].join("\n"),
        };
    }
    tick() {
        // Command-driven plugin; no polling work.
    }
    #log(event, profile) {
        const scope = event.conversation.kind === "group" ? "群聊" : "私聊";
        this.#context.log("info", "plugin.persona_switched", profile ? `用户切换了${scope}人设` : `用户恢复了默认${scope}人设`, {
            conversationId: event.conversation.id,
            senderId: event.sender.id,
            personaProfileId: profile?.id ?? null,
        });
    }
}
export const personaCommandPluginFactory = {
    type: "persona-command",
    create: (config, context) => new PersonaCommandPlugin(config, context),
};
export function parseManagementCommand(value) {
    const text = commandBody(value);
    if (/^(?:菜单|帮助|管理菜单|命令列表)\s*[？?！!。]*$/u.test(text))
        return { action: "menu" };
    if (/^(?:人设列表|列出人设|有哪些人设|可用人设)\s*[？?！!。]*$/u.test(text))
        return { action: "list" };
    if (/^(?:当前人设|现在(?:是|用的)?什么人设)\s*[？?！!。]*$/u.test(text))
        return { action: "current" };
    if (/^(?:上下文状态|当前上下文)\s*[？?！!。]*$/u.test(text))
        return { action: "context-status" };
    if (/^(?:插件状态|插件列表|功能状态|功能列表)\s*[？?！!。]*$/u.test(text))
        return { action: "plugin-status" };
    if (/^(?:音色列表|语音音色列表|语音风格列表|有哪些(?:语音)?音色|有哪些语音风格)\s*[？?！!。]*$/u.test(text)) {
        return { action: "voice-list" };
    }
    if (/^(?:当前|本群当前|查看本群)(?:默认)?(?:语音风格|语音音色|音色|声音)(?:是什么|设置)?\s*[？?！!。]*$/u.test(text)) {
        return { action: "voice-current" };
    }
    if (/^(?:当前|查看)(?:回复)?(?:模式|语音模式)\s*[？?！!。]*$/u.test(text)) {
        return { action: "voice-mode-current" };
    }
    if (/^(?:管理员列表|管理白名单)\s*[？?！!。]*$/u.test(text))
        return { action: "manager-list" };
    if (/^(?:(?:重置|清空|清除)(?:对话)?上下文|忘掉当前对话)\s*[！!。]*$/u.test(text)) {
        return { action: "context-reset" };
    }
    if (/^(?:恢复|重置|取消)(?:为)?默认人设\s*[！!。]*$/u.test(text))
        return { action: "reset" };
    if (/^(?:恢复|重置|取消)(?:本群)?(?:(?:默认)?(?:语音风格|语音音色|音色|声音)(?:为)?(?:系统)?默认|默认(?:语音风格|语音音色|音色|声音)|(?:语音风格|语音音色|音色|声音))\s*[！!。]*$/u.test(text)) {
        return { action: "voice-reset" };
    }
    const pluginMatch = /^(开启|启用|打开|关闭|停用)(?:插件|功能)\s*[：:]?\s*([^\s].*?)\s*[！!。]*$/u.exec(text);
    const pluginQuery = pluginMatch?.[2]?.trim();
    if (pluginQuery) {
        return {
            action: /^(?:关闭|停用)$/u.test(pluginMatch[1]) ? "plugin-disable" : "plugin-enable",
            query: pluginQuery.slice(0, 120),
        };
    }
    const voiceMode = parseConversationVoiceModeCommand(text);
    if (voiceMode)
        return { action: "voice-mode-set", mode: voiceMode.mode };
    const voiceQuery = voiceStyleCommandQuery(text);
    if (voiceQuery)
        return { action: "voice-set", query: voiceQuery };
    const match = /^(?:切换|使用|换成|改成)(?:为|到)?人设\s*[：:]?\s*([^\s].*?)\s*[！!。]*$/u.exec(text);
    const query = match?.[1]?.trim();
    return query ? { action: "switch", query: query.slice(0, 120) } : undefined;
}
/** Backward-compatible name for integrations that imported the old persona-only parser. */
export const parsePersonaCommand = parseManagementCommand;
function mentionsIdentity(event, identityIds) {
    return identityIds.some((identityId) => (event.mentions ?? []).some((mention) => mention.id === identityId || mention.id.endsWith(`:${identityId}`)));
}
function matchProfiles(profiles, query) {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    const exact = profiles.filter((profile) => profile.id.toLocaleLowerCase() === normalized || profile.label.normalize("NFKC").toLocaleLowerCase() === normalized);
    if (exact.length > 0)
        return exact;
    return profiles.filter((profile) => profile.id.toLocaleLowerCase().includes(normalized) ||
        profile.label.normalize("NFKC").toLocaleLowerCase().includes(normalized));
}
function matchPlugin(plugins, query) {
    const normalized = query.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
    const aliases = {
        自动插话: "auto-participation",
        自动接话: "auto-participation",
        暖场: "cold-chat-warmup",
        冷群暖场: "cold-chat-warmup",
        复读: "repeater",
        复读机: "repeater",
        磁力搜索: "magnet-code-search",
        编号磁力搜索: "magnet-code-search",
        晨报: "morning-brief",
        拍一拍: "pat-reply",
        入退群通知: "group-event-notify",
        群事件: "group-event-notify",
        总结: "group-summary",
        群聊总结: "group-summary",
        定时任务: "scheduled-task",
    };
    const aliased = aliases[normalized];
    return plugins.find((plugin) => plugin.type.toLocaleLowerCase() === normalized ||
        plugin.label.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase() === normalized ||
        plugin.type === aliased);
}
function commandBody(value) {
    const normalized = value
        .normalize("NFKC")
        .replace(/[\u2005\u2009\u200a\u200b\u200e\u200f\u2060\ufeff]/gu, " ")
        .trim();
    return normalized.replace(/^(?:@[^\s@]{1,100}\s+)+/u, "").trim();
}
function voiceStyleCommandQuery(value) {
    const patterns = [
        /^(?:把|将)?(?:本群)?(?:默认)?(?:语音风格|语音音色|音色|声音)\s*(?:设置|设定|设|改成|改为|换成|换为|切换成|切换为)\s*[：:]?\s*(.+?)\s*[！!。]*$/u,
        /^(?:设置|设定|修改|更换|切换)(?:本群)?(?:默认)?(?:语音风格|语音音色|音色|声音)\s*[为成到：:]?\s*(.+?)\s*[！!。]*$/u,
        /^以后(?:发|回复)?语音(?:时)?(?:都)?(?:用|使用|改用)\s*[：:]?\s*(.+?)\s*[！!。]*$/u,
        /^以后(?:都)?(?:用|使用|改用)\s*(.+?)(?:来)?(?:发|回复)语音\s*[！!。]*$/u,
    ];
    for (const pattern of patterns) {
        const query = pattern.exec(value)?.[1]?.trim();
        if (query)
            return [...query].slice(0, 200).join("");
    }
    return undefined;
}
function managementMenu(authorized, isGroup) {
    if (!isGroup) {
        return [
            "私聊机器人命令（无需 @，发送明确指令即可）：",
            "- 菜单 / 帮助",
            "- 当前人设 / 人设列表",
            "- 切换人设 <名称或 ID>",
            "- 恢复默认人设",
            "- 上下文状态",
            "- 重置上下文",
            "- 进入语音模式 / 进入耳语模式 / 退出语音模式",
            "",
            "这些操作只影响当前私聊，不会修改其他私聊或群聊。",
        ].join("\n");
    }
    const common = [
        "机器人命令（每条都必须先 @我）：",
        "- 菜单 / 帮助",
        "- 当前人设 / 人设列表",
        "- 上下文状态",
        "- 插件状态",
        "- 当前音色 / 音色列表",
        "- 当前回复模式",
    ];
    const managed = [
        "管理员命令：",
        "- 切换人设 <名称或 ID>",
        "- 恢复默认人设",
        "- 重置上下文",
        "- 管理员列表",
        "- 开启插件 <名称>",
        "- 关闭插件 <名称>",
        "- 设置音色 <预设名称或自定义风格>",
        "- 恢复音色默认",
        "- 进入语音模式 / 进入耳语模式 / 退出语音模式",
    ];
    return [...common, "", ...managed, "", authorized ? "你当前有本群管理权限。" : "你当前没有本群管理权限。"].join("\n");
}
function groupOnlyReply(feature) {
    return {
        kind: "direct-reply",
        reason: "plugin-management-group-only",
        text: `${feature}仅支持群聊配置；请在目标群里 @我 并发送明确命令。`,
    };
}
function formatTimestamp(timestamp, timezoneOffsetMinutes) {
    const shifted = new Date(timestamp + timezoneOffsetMinutes * 60_000).toISOString();
    return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`;
}
//# sourceMappingURL=persona-command.js.map