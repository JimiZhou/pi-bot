import { createHash } from "node:crypto";
/** Joins a repeat chain only after two different people send the same safe content. */
export class RepeaterPlugin {
    id;
    type = "repeater";
    #context;
    #settings;
    constructor(config, context) {
        this.id = config.id;
        this.#context = context;
        this.#settings = parseSettings(config.settings);
    }
    handleInbound(event) {
        if (event.conversation.kind !== "group" || event.sender.isBot)
            return undefined;
        if (!this.#context.isEnabledForConversation(this.type, event.conversation.id))
            return undefined;
        if (event.metadata?.interaction || mentionsIdentity(event, [this.#context.identityId, ...(this.#context.identityAliases?.(event.conversation.id) ?? [])]))
            return undefined;
        const candidate = repeatCandidate(event);
        if (!candidate)
            return undefined;
        const recent = this.#context.core.listConversationMessages(event.conversation.id, { limit: 8 });
        const chain = this.#matchingTail(recent, candidate);
        const collective = chain.length >= 1 && new Set([...chain.map((item) => item.senderId), event.sender.id]).size >= 2;
        if (!collective)
            return undefined;
        const now = event.timestamp ?? Date.now();
        const claimKey = `repeater:${this.#context.botId}:${event.id}`;
        if (!this.#context.claim({
            claimKey,
            canonicalConversationId: canonicalConversationId(event.conversation.id),
            reason: "repeater-chain",
            createdAt: now,
            ambient: true,
            cooldownMs: Math.min(this.#settings.cooldownMs, 2 * 60_000),
            botCooldownMs: 30_000,
            dailyLimit: 30,
            dayStartAt: localDayStart(now, this.#context.timezoneOffsetMinutes),
        }))
            return undefined;
        this.#context.log("info", "plugin.repeated", "机器人参与了群聊复读", {
            conversationId: event.conversation.id,
            senderId: event.sender.id,
            contentType: candidate.kind,
            collective,
        });
        return candidate.kind === "emoji"
            ? { kind: "direct-reply", text: "", parts: [candidate.part], reason: "plugin-repeater-emoji" }
            : { kind: "direct-reply", text: candidate.text, reason: "plugin-repeater-text" };
    }
    tick() {
        // Event-driven plugin; no polling work.
    }
    #matchingTail(recent, candidate) {
        const matches = [];
        for (let index = recent.length - 1; index >= 0 && matches.length < 3; index -= 1) {
            const message = recent[index];
            if (message.direction !== "inbound")
                break;
            const fingerprint = candidate.kind === "text"
                ? textFingerprint(message.text)
                : this.#storedEmojiFingerprint(message.id);
            if (fingerprint !== candidate.fingerprint)
                break;
            matches.push(message);
        }
        return matches;
    }
    #storedEmojiFingerprint(eventId) {
        const image = this.#context.core.inboundImages(eventId)[0];
        return image ? emojiFingerprint(image.part) : undefined;
    }
}
export const repeaterPluginFactory = {
    type: "repeater",
    create: (config, context) => new RepeaterPlugin(config, context),
};
function repeatCandidate(event) {
    const image = (event.parts ?? []).find((part) => part.type === "image");
    if (event.metadata?.nativeType === "47" && image) {
        const fingerprint = emojiFingerprint(image);
        return fingerprint ? { kind: "emoji", fingerprint, part: image } : undefined;
    }
    const text = event.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!safeRepeatText(text))
        return undefined;
    return { kind: "text", fingerprint: textFingerprint(text), text };
}
function safeRepeatText(text) {
    const length = [...text].length;
    if (length < 1 || length > 40)
        return false;
    if (/https?:\/\/|www\.|(?:^|\s)[/@#]|[？?]\s*$/iu.test(text))
        return false;
    if (/(?:密码|验证码|口令|银行卡|转账|付款|身份证|手机号|住址|开启插件|关闭插件|切换人设|重置上下文|管理员列表)/u.test(text))
        return false;
    return !/^(?:菜单|帮助|人设列表|当前人设|上下文状态)[！!。\s]*$/u.test(text);
}
function textFingerprint(value) {
    const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
    return normalized ? `text:${normalized}` : undefined;
}
function emojiFingerprint(part) {
    const metadata = part.asset.metadata;
    const nativeContent = typeof metadata?.nativeContent === "string" ? metadata.nativeContent : "";
    const md5 = /\bmd5\s*=\s*["']([a-f\d]{16,64})["']/iu.exec(nativeContent)?.[1]
        ?? (typeof metadata?.md5 === "string" ? metadata.md5 : undefined);
    if (md5)
        return `emoji:md5:${md5.toLocaleLowerCase()}`;
    if (part.asset.sha256)
        return `emoji:sha256:${part.asset.sha256.toLocaleLowerCase()}`;
    if (!nativeContent)
        return undefined;
    return `emoji:xml:${createHash("sha256").update(nativeContent).digest("hex")}`;
}
function mentionsIdentity(event, identityIds) {
    const canonical = new Set(identityIds.map(canonicalIdentityId));
    return (event.mentions ?? []).some((mention) => canonical.has(canonicalIdentityId(mention.id)));
}
function canonicalIdentityId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function canonicalConversationId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function localDayStart(timestamp, timezoneOffsetMinutes) {
    const offsetMs = timezoneOffsetMinutes * 60_000;
    return Math.floor((timestamp + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
}
function parseSettings(value) {
    return {
        cooldownMs: integer(value.cooldownMinutes ?? 8, 1, 1440, "cooldownMinutes") * 60_000,
    };
}
function integer(value, min, max, name) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`repeater ${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=repeater.js.map