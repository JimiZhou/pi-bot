/** Reminds configured members about a normalized red-envelope event; it never claims the envelope. */
export class RedEnvelopeNotifyPlugin {
    id;
    type = "red-envelope-notify";
    #context;
    constructor(config, context) {
        this.id = config.id;
        this.#context = context;
    }
    handleInbound(event) {
        if (event.conversation.kind !== "group" || event.sender.isBot)
            return undefined;
        if (event.metadata?.interaction !== "red-envelope")
            return undefined;
        if (!this.#context.isEnabledForConversation(this.type, event.conversation.id))
            return undefined;
        const targets = this.#context.management?.redEnvelopeTargetIds(event.conversation.id) ?? [];
        const sender = canonicalId(event.sender.id);
        const exclusive = typeof event.metadata.exclusiveReceiverId === "string"
            ? canonicalId(event.metadata.exclusiveReceiverId)
            : undefined;
        const selected = unique(targets).filter((id) => canonicalId(id) !== sender && (!exclusive || canonicalId(id) === exclusive));
        if (selected.length === 0)
            return undefined;
        const nativeMessageId = event.id.split(":").at(-1) || event.id;
        if (!this.#context.claim({
            claimKey: `red-envelope:${canonicalId(event.conversation.id)}:${nativeMessageId}`,
            canonicalConversationId: canonicalId(event.conversation.id),
            reason: "red-envelope-notify",
            createdAt: event.timestamp ?? Date.now(),
            ambient: false,
        }))
            return undefined;
        const kind = event.metadata.redEnvelopeKind === "gift" ? "礼物" : "红包";
        const parts = selected.map((id) => {
            const displayName = this.#context.management?.memberDisplayName(event.conversation.id, id);
            return { type: "mention", memberId: id, ...(displayName ? { displayName } : {}) };
        });
        parts.push({ type: "text", text: ` 有${exclusive ? "专属" : "新"}${kind}，快来看看！` });
        this.#context.log("info", "plugin.red_envelope_notified", "已提醒群成员查看红包", {
            conversationId: event.conversation.id,
            senderId: event.sender.id,
            targetIds: selected,
            kind,
            exclusive: Boolean(exclusive),
        });
        return { kind: "direct-reply", text: `有${exclusive ? "专属" : "新"}${kind}，快来看看！`, parts, reason: "plugin-red-envelope-notify" };
    }
    tick() { }
}
export const redEnvelopeNotifyPluginFactory = {
    type: "red-envelope-notify",
    create: (config, context) => new RedEnvelopeNotifyPlugin(config, context),
};
function canonicalId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
        const key = canonicalId(value);
        if (!key || seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
//# sourceMappingURL=red-envelope-notify.js.map