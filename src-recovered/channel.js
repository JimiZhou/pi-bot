import { randomUUID } from "node:crypto";
import { validateMessageParts } from "./message-parts.js";
import { assertFeature, featureKey, MEDIA_RESOLVE_CAPABILITY, requiredReceiveFeature, requiredSendFeature, } from "./channel-capabilities.js";
export { CHANNEL_FEATURE_RECEIVE_AUDIO, CHANNEL_FEATURE_RECEIVE_FILE, CHANNEL_FEATURE_RECEIVE_IMAGE, CHANNEL_FEATURE_RECEIVE_VIDEO, CHANNEL_FEATURE_RECEIVE_VOICE, CHANNEL_FEATURE_SEND_AUDIO, CHANNEL_FEATURE_SEND_FILE, CHANNEL_FEATURE_SEND_IMAGE, CHANNEL_FEATURE_SEND_MENTION, CHANNEL_FEATURE_SEND_VIDEO, CHANNEL_FEATURE_SEND_VOICE, MEDIA_RESOLVE_CAPABILITY, defineChannelCapability, defineChannelFeature, provideChannelCapability, } from "./channel-capabilities.js";
export const CHANNEL_PLUGIN_API_VERSION = 1;
/** Owns the invariant channel loop: ingest -> core -> send -> acknowledge. */
export class ChannelRuntime {
    #core;
    #plugin;
    #startupOutboxLimit;
    #maxOutboxAgeMs;
    #messageBurstDebounceMs;
    #explicitMessageBurstDebounceMs;
    #messageBurstExplicitSignal;
    #onError;
    #sending = new Map();
    #ingesting = new Set();
    #activeEventIds = new Set();
    #features = new Map();
    #capabilities = new Map();
    #pendingMessageBursts = new Map();
    #context;
    #inboundHandlers = [];
    #inboundTransformers = [];
    #state = "idle";
    constructor(options) {
        assertChannelPlugin(options.plugin);
        this.#core = options.core;
        this.#plugin = options.plugin;
        this.#startupOutboxLimit = boundedLimit(options.startupOutboxLimit ?? 100);
        this.#maxOutboxAgeMs = boundedOutboxAge(options.maxOutboxAgeMs ?? 10 * 60_000);
        this.#messageBurstDebounceMs = boundedMessageBurstDebounce(options.messageBurstDebounceMs ?? 0);
        this.#explicitMessageBurstDebounceMs = boundedExplicitMessageBurstDebounce(options.explicitMessageBurstDebounceMs ?? Math.min(900, this.#messageBurstDebounceMs));
        this.#messageBurstExplicitSignal = options.messageBurstExplicitSignal ?? defaultExplicitMessageBurstSignal;
        this.#onError = options.onError;
        for (const feature of options.plugin.features ?? [])
            this.#registerFeature(feature);
        for (const binding of options.plugin.capabilities ?? []) {
            this.#registerFeature(binding.capability);
            this.#capabilities.set(featureKey(binding.capability), binding);
        }
        this.#context = Object.freeze({
            pluginId: options.plugin.id,
            hasSeenEvent: (eventId) => this.#core.hasSeenEvent(eventId),
            ingest: (event) => this.ingest(event),
            flushOutbox: (limit) => this.flushOutbox(limit),
        });
    }
    get pluginId() {
        return this.#plugin.id;
    }
    get running() {
        return this.#state === "running";
    }
    setInboundHandlers(handlers) {
        if (this.#state !== "idle")
            throw new Error("Inbound handlers must be configured before the channel starts");
        this.#inboundHandlers = [...handlers];
    }
    setInboundTransformers(transformers) {
        if (this.#state !== "idle")
            throw new Error("Inbound transformers must be configured before the channel starts");
        this.#inboundTransformers = [...transformers];
    }
    listFeatures() {
        return [...this.#features.values()];
    }
    supports(feature) {
        return this.#features.has(featureKey(feature));
    }
    async invoke(capability, request) {
        if (this.#state === "idle") {
            throw new Error(`Cannot invoke channel capability while ${this.#plugin.id} is ${this.#state}`);
        }
        const binding = this.#capabilities.get(featureKey(capability));
        if (!binding)
            throw new Error(`Channel ${this.#plugin.id} does not provide ${featureKey(capability)}`);
        try {
            if (capability.id === MEDIA_RESOLVE_CAPABILITY.id)
                this.#assertMediaOwnership(request);
            return (await binding.invoke(request));
        }
        catch (error) {
            this.#reportError(error, { phase: "capability", capabilityId: featureKey(capability) });
            throw error;
        }
    }
    async start() {
        if (this.#state === "running")
            return emptyDeliveryReport();
        if (this.#state !== "idle")
            throw new Error(`Cannot start channel while it is ${this.#state}`);
        this.#state = "starting";
        try {
            await this.#plugin.start(this.#context);
            this.#state = "running";
            return await this.flushOutbox(this.#startupOutboxLimit);
        }
        catch (error) {
            this.#state = "idle";
            this.#reportError(error, { phase: "start" });
            throw error;
        }
    }
    ingest(event) {
        if (this.#state !== "starting" && this.#state !== "running") {
            return Promise.reject(new Error(`Channel ${this.#plugin.id} is not accepting messages while ${this.#state}`));
        }
        const burstEligible = isBurstEligible(event);
        const explicit = burstEligible && this.#messageBurstExplicitSignal(event);
        const debounceMs = explicit ? this.#explicitMessageBurstDebounceMs : this.#messageBurstDebounceMs;
        const hasPendingBurst = burstEligible && this.#pendingMessageBursts.has(event.conversation.id);
        const operation = burstEligible && (debounceMs > 0 || hasPendingBurst)
            ? this.#queueMessageBurst(event, explicit)
            : this.#ingest(event);
        this.#ingesting.add(operation);
        operation.then(() => this.#ingesting.delete(operation), () => this.#ingesting.delete(operation));
        return operation;
    }
    async participate(request) {
        if (this.#state !== "running") {
            throw new Error(`Channel ${this.#plugin.id} cannot participate while ${this.#state}`);
        }
        const handling = await this.#core.participate(request);
        return { handling, delivery: await this.#deliver(handling.actions) };
    }
    async sendProactiveText(request, text) {
        return this.sendProactiveMessage(request, text);
    }
    async sendProactiveMessage(request, text, parts = []) {
        if (this.#state !== "running") {
            throw new Error(`Channel ${this.#plugin.id} cannot participate while ${this.#state}`);
        }
        const handling = await this.#core.sendProactiveMessage(request, text, parts);
        return { handling, delivery: await this.#deliver(handling.actions) };
    }
    /** Sends non-durable UI feedback (for example a thinking emoji) without adding it to chat history. */
    async sendTransient(conversationId, parts, text = "") {
        if (this.#state !== "running")
            throw new Error(`Channel ${this.#plugin.id} cannot send while ${this.#state}`);
        const action = {
            id: `transient:${randomUUID()}`,
            type: "message",
            conversationId,
            text,
            ...(parts && parts.length > 0 ? { parts } : {}),
            replyToMessageId: "",
            createdAt: Date.now(),
        };
        this.#assertSendSupported(action);
        await this.#plugin.send(action);
    }
    async flushOutbox(limit = 100) {
        if (this.#state !== "starting" && this.#state !== "running") {
            throw new Error(`Cannot flush outbox while channel ${this.#plugin.id} is ${this.#state}`);
        }
        const pending = this.#core.pendingOutbox(boundedLimit(limit));
        const cutoff = Date.now() - this.#maxOutboxAgeMs;
        const expired = pending.filter((action) => action.createdAt < cutoff);
        if (expired.length > 0)
            this.#core.acknowledgeOutbox(expired.map((action) => action.id));
        const report = await this.#deliver(pending.filter((action) => action.createdAt >= cutoff));
        for (const action of expired) {
            report.attempted.unshift(action.id);
            report.failed.unshift({ actionId: action.id, error: "stale outbox action expired before delivery" });
        }
        return report;
    }
    async stop() {
        if (this.#state === "idle")
            return;
        if (this.#state !== "running")
            throw new Error(`Cannot stop channel while it is ${this.#state}`);
        this.#state = "stopping";
        await this.#flushAllMessageBursts();
        await Promise.allSettled([...this.#ingesting]);
        try {
            await this.#plugin.stop();
        }
        catch (error) {
            this.#reportError(error, { phase: "stop" });
            throw error;
        }
        finally {
            this.#state = "idle";
        }
    }
    async #ingest(event, forcedIgnoreReason) {
        let handling;
        const skipHandlers = this.#activeEventIds.has(event.id) || this.#core.hasSeenEvent(event.id);
        this.#activeEventIds.add(event.id);
        try {
            this.#assertReceiveSupported(event);
            let enrichedEvent = event;
            if (!skipHandlers && !forcedIgnoreReason) {
                for (const transformer of this.#inboundTransformers) {
                    const transformed = await transformer(enrichedEvent);
                    assertStableInboundTransformation(event, transformed);
                    enrichedEvent = transformed;
                }
            }
            let inboundAction;
            if (!skipHandlers && !forcedIgnoreReason) {
                const handlerEvent = handlerEventForBurst(enrichedEvent);
                for (const handler of this.#inboundHandlers) {
                    inboundAction = await handler(handlerEvent);
                    if (inboundAction)
                        break;
                }
            }
            handling = forcedIgnoreReason
                ? await this.#core.receiveIgnored(enrichedEvent, forcedIgnoreReason)
                : inboundAction?.kind === "direct-reply"
                    ? await this.#core.receiveDirect(enrichedEvent, inboundAction.text, inboundAction.reason, inboundAction.parts)
                    : inboundAction?.kind === "agent-prompt"
                        ? await this.#core.receiveWithPrompt(enrichedEvent, inboundAction.prompt, inboundAction.reason)
                        : inboundAction?.kind === "ignore"
                            ? await this.#core.receiveIgnored(enrichedEvent, inboundAction.reason)
                            : enrichedEvent.metadata?.passiveContext === true
                                ? await this.#core.receiveIgnored(enrichedEvent, "protocol-passive-context")
                                : enrichedEvent.metadata?.interaction === "pat"
                                    ? await this.#core.receiveIgnored(enrichedEvent, "plugin-pat-ignored")
                                    : await this.#core.receive(enrichedEvent, this.supports(MEDIA_RESOLVE_CAPABILITY)
                                        ? {
                                            mediaResolver: {
                                                resolve: (asset) => this.invoke(MEDIA_RESOLVE_CAPABILITY, { asset }),
                                            },
                                        }
                                        : {});
        }
        catch (error) {
            this.#reportError(error, { phase: "ingest", eventId: event.id });
            throw error;
        }
        finally {
            this.#activeEventIds.delete(event.id);
        }
        let actions = handling.actions;
        if (handling.replayed && actions.length > 0) {
            const pending = new Set(this.#core.pendingOutbox(10_000).map((action) => action.id));
            actions = actions.filter((action) => pending.has(action.id));
        }
        return { handling, delivery: await this.#deliver(actions) };
    }
    #queueMessageBurst(event, explicit) {
        const key = event.conversation.id;
        const existing = this.#pendingMessageBursts.get(key);
        if (existing && existing.items.at(-1)?.event.sender.id !== event.sender.id) {
            clearTimeout(existing.timer);
            this.#pendingMessageBursts.delete(key);
            void this.#flushMessageBurst(existing);
        }
        return new Promise((resolve, reject) => {
            let burst = this.#pendingMessageBursts.get(key);
            if (!burst) {
                burst = { items: [], timer: setTimeout(() => undefined, 0), explicit };
                this.#pendingMessageBursts.set(key, burst);
            }
            clearTimeout(burst.timer);
            burst.explicit ||= explicit;
            burst.items.push({ event, resolve, reject });
            if (burst.items.length >= 6) {
                this.#pendingMessageBursts.delete(key);
                void this.#flushMessageBurst(burst);
                return;
            }
            const debounceMs = burst.explicit ? this.#explicitMessageBurstDebounceMs : this.#messageBurstDebounceMs;
            burst.timer = setTimeout(() => {
                if (this.#pendingMessageBursts.get(key) !== burst)
                    return;
                this.#pendingMessageBursts.delete(key);
                void this.#flushMessageBurst(burst);
            }, debounceMs);
        });
    }
    async #flushMessageBurst(burst) {
        clearTimeout(burst.timer);
        const previousTexts = burst.items.slice(0, -1).map((item) => item.event.text).filter(Boolean);
        for (let index = 0; index < burst.items.length; index += 1) {
            const item = burst.items[index];
            const isLast = index === burst.items.length - 1;
            const event = isLast && previousTexts.length > 0
                ? mergeBurstSignals(item.event, burst.items.slice(0, -1).map((entry) => entry.event), previousTexts)
                : item.event;
            try {
                item.resolve(await this.#ingest(event, isLast ? undefined : "message-burst-fragment"));
            }
            catch (error) {
                item.reject(error);
            }
        }
    }
    async #flushAllMessageBursts() {
        const bursts = [...this.#pendingMessageBursts.values()];
        this.#pendingMessageBursts.clear();
        await Promise.allSettled(bursts.map((burst) => this.#flushMessageBurst(burst)));
    }
    async #deliver(actions) {
        const outcomes = await Promise.all(actions.map((action) => this.#deliverOne(action)));
        const report = emptyDeliveryReport();
        for (const outcome of outcomes) {
            report.attempted.push(outcome.actionId);
            if (outcome.status === "delivered")
                report.delivered.push(outcome.actionId);
            else
                report.failed.push({ actionId: outcome.actionId, error: outcome.error });
        }
        return report;
    }
    #deliverOne(action) {
        const active = this.#sending.get(action.id);
        if (active)
            return active;
        const operation = (async () => {
            try {
                this.#assertSendSupported(action);
                await this.#plugin.send(action);
                this.#core.acknowledgeOutbox([action.id]);
                return { actionId: action.id, status: "delivered" };
            }
            catch (error) {
                const message = errorMessage(error);
                this.#reportError(error, { phase: "send", actionId: action.id });
                return { actionId: action.id, status: "failed", error: message };
            }
        })();
        this.#sending.set(action.id, operation);
        operation.then(() => this.#sending.delete(action.id), () => this.#sending.delete(action.id));
        return operation;
    }
    #registerFeature(feature) {
        assertFeature(feature);
        const key = featureKey(feature);
        if (this.#features.has(key))
            throw new Error(`Duplicate channel feature: ${key}`);
        this.#features.set(key, feature);
    }
    #assertSendSupported(action) {
        validateMessageParts(action.parts);
        for (const part of action.parts ?? []) {
            const feature = requiredSendFeature(part);
            if (feature && !this.supports(feature)) {
                throw new Error(`Channel ${this.#plugin.id} does not support ${featureKey(feature)}`);
            }
        }
    }
    #assertReceiveSupported(event) {
        validateMessageParts(event.parts);
        for (const part of event.parts ?? []) {
            const feature = requiredReceiveFeature(part);
            if (feature && !this.supports(feature)) {
                throw new Error(`Channel ${this.#plugin.id} emitted ${part.type} without declaring ${featureKey(feature)}`);
            }
            if ((part.type === "image" ||
                part.type === "audio" ||
                part.type === "voice" ||
                part.type === "video" ||
                part.type === "file") &&
                part.asset.source === "platform" &&
                part.asset.ownerPluginId !== this.#plugin.id) {
                throw new Error(`Platform asset ${part.asset.id} must be owned by channel plugin ${this.#plugin.id}`);
            }
        }
    }
    #assertMediaOwnership(request) {
        if (typeof request !== "object" || request === null || !("asset" in request)) {
            throw new Error("media.resolve requires an asset");
        }
        const asset = request.asset;
        if (typeof asset !== "object" || asset === null)
            throw new Error("media.resolve asset is invalid");
        if ("ownerPluginId" in asset && asset.ownerPluginId && asset.ownerPluginId !== this.#plugin.id) {
            throw new Error(`Asset belongs to channel plugin ${String(asset.ownerPluginId)}, not ${this.#plugin.id}`);
        }
        if ("expiresAt" in asset && typeof asset.expiresAt === "number" && asset.expiresAt < Date.now()) {
            throw new Error("Platform asset reference has expired");
        }
    }
    #reportError(error, context) {
        try {
            this.#onError?.(error, { pluginId: this.#plugin.id, ...context });
        }
        catch {
            // Channel observability must never break state handling or outbox retries.
        }
    }
}
function assertStableInboundTransformation(original, transformed) {
    if (transformed.id !== original.id ||
        transformed.type !== original.type ||
        transformed.conversation.id !== original.conversation.id ||
        transformed.sender.id !== original.sender.id) {
        throw new Error("Inbound transformers cannot change event, conversation, or sender identity");
    }
}
export function defineChannelPlugin(plugin) {
    assertChannelPlugin(plugin);
    return plugin;
}
function assertChannelPlugin(plugin) {
    if (plugin.apiVersion !== CHANNEL_PLUGIN_API_VERSION) {
        throw new Error(`Unsupported channel plugin API version: ${String(plugin.apiVersion)}`);
    }
    if (!plugin.id.trim())
        throw new Error("Channel plugin id cannot be empty");
    if (plugin.displayName !== undefined && !plugin.displayName.trim()) {
        throw new Error("Channel plugin displayName cannot be empty");
    }
    if (typeof plugin.start !== "function" || typeof plugin.send !== "function" || typeof plugin.stop !== "function") {
        throw new Error("Channel plugin must implement start, send, and stop");
    }
    for (const feature of plugin.features ?? [])
        assertFeature(feature);
    for (const binding of plugin.capabilities ?? []) {
        assertFeature(binding.capability);
        if (typeof binding.invoke !== "function")
            throw new Error("Channel capability binding must implement invoke");
    }
}
function boundedLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error("Channel outbox limit must be an integer between 1 and 10000");
    }
    return value;
}
function boundedOutboxAge(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000) {
        throw new Error("Channel maxOutboxAgeMs must be an integer between 1 and 86400000");
    }
    return value;
}
function boundedMessageBurstDebounce(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) {
        throw new Error("Channel messageBurstDebounceMs must be an integer between 0 and 30000");
    }
    return value;
}
function boundedExplicitMessageBurstDebounce(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 5_000) {
        throw new Error("Channel explicitMessageBurstDebounceMs must be an integer between 0 and 5000");
    }
    return value;
}
function defaultExplicitMessageBurstSignal(event) {
    return (event.mentions?.length ?? 0) > 0 || event.replyTo !== undefined;
}
function isBurstEligible(event) {
    if (event.conversation.kind !== "group" || event.sender.isBot || !event.text.trim())
        return false;
    if (event.metadata?.passiveContext === true || event.metadata?.proactiveKind || event.metadata?.interaction)
        return false;
    if ((event.attachments?.length ?? 0) > 0)
        return false;
    return !(event.parts ?? []).some((part) => part.type === "image" || part.type === "audio" || part.type === "voice" ||
        part.type === "video" || part.type === "file" || part.type === "link");
}
function mergeBurstSignals(current, previous, previousTexts) {
    const mentions = [...previous.flatMap((event) => event.mentions ?? []), ...(current.mentions ?? [])];
    const uniqueMentions = [...new Map(mentions.map((mention) => [mention.id, mention])).values()];
    const replyTo = current.replyTo ?? [...previous].reverse().find((event) => event.replyTo)?.replyTo;
    return {
        ...current,
        ...(uniqueMentions.length > 0 ? { mentions: uniqueMentions } : {}),
        ...(replyTo ? { replyTo } : {}),
        metadata: {
            ...(current.metadata ?? {}),
            burstPreviousTexts: previousTexts.slice(-5),
            burstSize: previousTexts.length + 1,
        },
    };
}
function handlerEventForBurst(event) {
    const previous = event.metadata?.burstPreviousTexts;
    if (!Array.isArray(previous) || previous.some((item) => typeof item !== "string") || previous.length === 0) {
        return event;
    }
    return { ...event, text: [...previous, event.text].filter(Boolean).join("\n") };
}
function emptyDeliveryReport() {
    return { attempted: [], delivered: [], failed: [] };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=channel.js.map