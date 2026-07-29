import { randomUUID } from "node:crypto";
import type { GroupAgentCore } from "./core.js";
import type {
  HandleResult,
  InboundMessageEvent,
  MessagePart,
  OutboundMessageAction,
  ProactiveParticipationRequest,
} from "./types.js";
import { validateMessageParts } from "./message-parts.js";
import {
  assertFeature,
  featureKey,
  MEDIA_RESOLVE_CAPABILITY,
  requiredReceiveFeature,
  requiredSendFeature,
  type ChannelCapabilityBinding,
  type ChannelCapabilityToken,
  type ChannelFeature,
} from "./channel-capabilities.js";

export type {
  AssetRef,
  AssetSource,
  HandleResult,
  InboundMessageEvent,
  MessagePart,
  OutboundMessageAction,
} from "./types.js";
export {
  CHANNEL_FEATURE_RECEIVE_AUDIO,
  CHANNEL_FEATURE_RECEIVE_FILE,
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_RECEIVE_VIDEO,
  CHANNEL_FEATURE_RECEIVE_VOICE,
  CHANNEL_FEATURE_SEND_AUDIO,
  CHANNEL_FEATURE_SEND_FILE,
  CHANNEL_FEATURE_SEND_IMAGE,
  CHANNEL_FEATURE_SEND_MENTION,
  CHANNEL_FEATURE_SEND_VIDEO,
  CHANNEL_FEATURE_SEND_VOICE,
  MEDIA_RESOLVE_CAPABILITY,
  defineChannelCapability,
  defineChannelFeature,
  provideChannelCapability,
  type ChannelCapabilityBinding,
  type ChannelCapabilityToken,
  type ChannelFeature,
  type ChannelFeatureValue,
  type ResolveMediaRequest,
} from "./channel-capabilities.js";

export const CHANNEL_PLUGIN_API_VERSION = 1 as const;

export interface ChannelPluginContext {
  readonly pluginId: string;
  /** Fast idempotency probe for adapters that receive cumulative/replayed batches. */
  hasSeenEvent?(eventId: string): boolean;
  ingest(event: InboundMessageEvent): Promise<ChannelIngestResult>;
  flushOutbox(limit?: number): Promise<OutboxDeliveryReport>;
}

/**
 * The only contract a bot framework adapter has to implement.
 *
 * `start` converts framework-native inbound messages into InboundMessageEvent.
 * `send` converts a durable OutboundMessageAction into a framework-native send.
 */
export interface ChannelPlugin {
  readonly apiVersion: typeof CHANNEL_PLUGIN_API_VERSION;
  readonly id: string;
  readonly displayName?: string;
  readonly features?: readonly ChannelFeature[];
  readonly capabilities?: readonly ChannelCapabilityBinding[];
  start(context: ChannelPluginContext): void | Promise<void>;
  send(action: OutboundMessageAction): Promise<void>;
  stop(): void | Promise<void>;
}

export interface ChannelIngestResult {
  handling: HandleResult;
  delivery: OutboxDeliveryReport;
}

export interface ChannelDeliveryFailure {
  actionId: string;
  error: string;
}

export interface OutboxDeliveryReport {
  attempted: string[];
  delivered: string[];
  failed: ChannelDeliveryFailure[];
}

export type ChannelRuntimePhase = "start" | "ingest" | "send" | "capability" | "stop";

export interface ChannelRuntimeErrorContext {
  pluginId: string;
  phase: ChannelRuntimePhase;
  eventId?: string;
  actionId?: string;
  capabilityId?: string;
}

export interface ChannelRuntimeOptions {
  core: GroupAgentCore;
  plugin: ChannelPlugin;
  startupOutboxLimit?: number;
  /** Social replies older than this are acknowledged without being sent. */
  maxOutboxAgeMs?: number;
  /** Ambient same-sender group message window. Zero disables ambient coalescing. */
  messageBurstDebounceMs?: number;
  /** Short response window used once a burst explicitly addresses this Bot. */
  explicitMessageBurstDebounceMs?: number;
  /** Resolves Bot-specific mentions, replies and wake words without coupling Channel to Core policy. */
  messageBurstExplicitSignal?: (event: InboundMessageEvent) => boolean;
  onError?: (error: unknown, context: ChannelRuntimeErrorContext) => void;
}

export interface ChannelInboundDirectReply {
  kind: "direct-reply";
  text: string;
  parts?: MessagePart[];
  reason: string;
}

export interface ChannelInboundAgentPrompt {
  kind: "agent-prompt";
  prompt: string;
  reason: string;
}

export interface ChannelInboundIgnore {
  kind: "ignore";
  reason: string;
}

export type ChannelInboundAction = ChannelInboundDirectReply | ChannelInboundAgentPrompt | ChannelInboundIgnore;

export type ChannelInboundHandler = (
  event: InboundMessageEvent,
) => ChannelInboundAction | undefined | Promise<ChannelInboundAction | undefined>;

export type ChannelInboundTransformer = (
  event: InboundMessageEvent,
) => InboundMessageEvent | Promise<InboundMessageEvent>;

type RuntimeState = "idle" | "starting" | "running" | "stopping";
type DeliveryOutcome =
  | { actionId: string; status: "delivered" }
  | { actionId: string; status: "failed"; error: string };

interface PendingMessageBurstItem {
  event: InboundMessageEvent;
  resolve: (result: ChannelIngestResult) => void;
  reject: (error: unknown) => void;
}

interface PendingMessageBurst {
  items: PendingMessageBurstItem[];
  timer: ReturnType<typeof setTimeout>;
  explicit: boolean;
}

/** Owns the invariant channel loop: ingest -> core -> send -> acknowledge. */
export class ChannelRuntime {
  readonly #core: GroupAgentCore;
  readonly #plugin: ChannelPlugin;
  readonly #startupOutboxLimit: number;
  readonly #maxOutboxAgeMs: number;
  readonly #messageBurstDebounceMs: number;
  readonly #explicitMessageBurstDebounceMs: number;
  readonly #messageBurstExplicitSignal: NonNullable<ChannelRuntimeOptions["messageBurstExplicitSignal"]>;
  readonly #onError: ChannelRuntimeOptions["onError"];
  readonly #sending = new Map<string, Promise<DeliveryOutcome>>();
  readonly #ingesting = new Set<Promise<ChannelIngestResult>>();
  readonly #activeEventIds = new Set<string>();
  readonly #features = new Map<string, ChannelFeature>();
  readonly #capabilities = new Map<string, ChannelCapabilityBinding>();
  readonly #pendingMessageBursts = new Map<string, PendingMessageBurst>();
  readonly #context: ChannelPluginContext;
  #inboundHandlers: readonly ChannelInboundHandler[] = [];
  #inboundTransformers: readonly ChannelInboundTransformer[] = [];
  #state: RuntimeState = "idle";

  constructor(options: ChannelRuntimeOptions) {
    assertChannelPlugin(options.plugin);
    this.#core = options.core;
    this.#plugin = options.plugin;
    this.#startupOutboxLimit = boundedLimit(options.startupOutboxLimit ?? 100);
    this.#maxOutboxAgeMs = boundedOutboxAge(options.maxOutboxAgeMs ?? 10 * 60_000);
    this.#messageBurstDebounceMs = boundedMessageBurstDebounce(options.messageBurstDebounceMs ?? 0);
    this.#explicitMessageBurstDebounceMs = boundedExplicitMessageBurstDebounce(
      options.explicitMessageBurstDebounceMs ?? Math.min(900, this.#messageBurstDebounceMs),
    );
    this.#messageBurstExplicitSignal = options.messageBurstExplicitSignal ?? defaultExplicitMessageBurstSignal;
    this.#onError = options.onError;
    for (const feature of options.plugin.features ?? []) this.#registerFeature(feature);
    for (const binding of options.plugin.capabilities ?? []) {
      this.#registerFeature(binding.capability);
      this.#capabilities.set(featureKey(binding.capability), binding);
    }
    this.#context = Object.freeze({
      pluginId: options.plugin.id,
      hasSeenEvent: (eventId: string) => this.#core.hasSeenEvent(eventId),
      ingest: (event: InboundMessageEvent) => this.ingest(event),
      flushOutbox: (limit?: number) => this.flushOutbox(limit),
    });
  }

  get pluginId(): string {
    return this.#plugin.id;
  }

  get running(): boolean {
    return this.#state === "running";
  }

  setInboundHandlers(handlers: readonly ChannelInboundHandler[]): void {
    if (this.#state !== "idle") throw new Error("Inbound handlers must be configured before the channel starts");
    this.#inboundHandlers = [...handlers];
  }

  setInboundTransformers(transformers: readonly ChannelInboundTransformer[]): void {
    if (this.#state !== "idle") throw new Error("Inbound transformers must be configured before the channel starts");
    this.#inboundTransformers = [...transformers];
  }

  listFeatures(): ChannelFeature[] {
    return [...this.#features.values()];
  }

  supports(feature: ChannelFeature): boolean {
    return this.#features.has(featureKey(feature));
  }

  async invoke<TRequest, TResult>(
    capability: ChannelCapabilityToken<TRequest, TResult>,
    request: TRequest,
  ): Promise<TResult> {
    if (this.#state === "idle") {
      throw new Error(`Cannot invoke channel capability while ${this.#plugin.id} is ${this.#state}`);
    }
    const binding = this.#capabilities.get(featureKey(capability));
    if (!binding) throw new Error(`Channel ${this.#plugin.id} does not provide ${featureKey(capability)}`);
    try {
      if (capability.id === MEDIA_RESOLVE_CAPABILITY.id) this.#assertMediaOwnership(request);
      return (await binding.invoke(request)) as TResult;
    } catch (error) {
      this.#reportError(error, { phase: "capability", capabilityId: featureKey(capability) });
      throw error;
    }
  }

  async start(): Promise<OutboxDeliveryReport> {
    if (this.#state === "running") return emptyDeliveryReport();
    if (this.#state !== "idle") throw new Error(`Cannot start channel while it is ${this.#state}`);
    this.#state = "starting";
    try {
      await this.#plugin.start(this.#context);
      this.#state = "running";
      return await this.flushOutbox(this.#startupOutboxLimit);
    } catch (error) {
      this.#state = "idle";
      this.#reportError(error, { phase: "start" });
      throw error;
    }
  }

  ingest(event: InboundMessageEvent): Promise<ChannelIngestResult> {
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
    operation.then(
      () => this.#ingesting.delete(operation),
      () => this.#ingesting.delete(operation),
    );
    return operation;
  }

  async participate(request: ProactiveParticipationRequest): Promise<ChannelIngestResult> {
    if (this.#state !== "running") {
      throw new Error(`Channel ${this.#plugin.id} cannot participate while ${this.#state}`);
    }
    const handling = await this.#core.participate(request);
    return { handling, delivery: await this.#deliver(handling.actions) };
  }

  async sendProactiveText(request: ProactiveParticipationRequest, text: string): Promise<ChannelIngestResult> {
    return this.sendProactiveMessage(request, text);
  }

  async sendProactiveMessage(
    request: ProactiveParticipationRequest,
    text: string,
    parts: MessagePart[] = [],
  ): Promise<ChannelIngestResult> {
    if (this.#state !== "running") {
      throw new Error(`Channel ${this.#plugin.id} cannot participate while ${this.#state}`);
    }
    const handling = await this.#core.sendProactiveMessage(request, text, parts);
    return { handling, delivery: await this.#deliver(handling.actions) };
  }

  /** Sends non-durable UI feedback (for example a thinking emoji) without adding it to chat history. */
  async sendTransient(conversationId: string, parts: OutboundMessageAction["parts"], text = ""): Promise<void> {
    if (this.#state !== "running") throw new Error(`Channel ${this.#plugin.id} cannot send while ${this.#state}`);
    const action: OutboundMessageAction = {
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

  async flushOutbox(limit = 100): Promise<OutboxDeliveryReport> {
    if (this.#state !== "starting" && this.#state !== "running") {
      throw new Error(`Cannot flush outbox while channel ${this.#plugin.id} is ${this.#state}`);
    }
    const pending = this.#core.pendingOutbox(boundedLimit(limit));
    const cutoff = Date.now() - this.#maxOutboxAgeMs;
    const expired = pending.filter((action) => action.createdAt < cutoff);
    if (expired.length > 0) this.#core.acknowledgeOutbox(expired.map((action) => action.id));
    const report = await this.#deliver(pending.filter((action) => action.createdAt >= cutoff));
    for (const action of expired) {
      report.attempted.unshift(action.id);
      report.failed.unshift({ actionId: action.id, error: "stale outbox action expired before delivery" });
    }
    return report;
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    if (this.#state !== "running") throw new Error(`Cannot stop channel while it is ${this.#state}`);
    this.#state = "stopping";
    await this.#flushAllMessageBursts();
    await Promise.allSettled([...this.#ingesting]);
    try {
      await this.#plugin.stop();
    } catch (error) {
      this.#reportError(error, { phase: "stop" });
      throw error;
    } finally {
      this.#state = "idle";
    }
  }

  async #ingest(event: InboundMessageEvent, forcedIgnoreReason?: string): Promise<ChannelIngestResult> {
    let handling: HandleResult;
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
      let inboundAction: ChannelInboundAction | undefined;
      if (!skipHandlers && !forcedIgnoreReason) {
        const handlerEvent = handlerEventForBurst(enrichedEvent);
        for (const handler of this.#inboundHandlers) {
          inboundAction = await handler(handlerEvent);
          if (inboundAction) break;
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
        : await this.#core.receive(
            enrichedEvent,
            this.supports(MEDIA_RESOLVE_CAPABILITY)
              ? {
                  mediaResolver: {
                    resolve: (asset) => this.invoke(MEDIA_RESOLVE_CAPABILITY, { asset }),
                  },
                }
              : {},
          );
    } catch (error) {
      this.#reportError(error, { phase: "ingest", eventId: event.id });
      throw error;
    } finally {
      this.#activeEventIds.delete(event.id);
    }

    let actions = handling.actions;
    if (handling.replayed && actions.length > 0) {
      const pending = new Set(this.#core.pendingOutbox(10_000).map((action) => action.id));
      actions = actions.filter((action) => pending.has(action.id));
    }
    return { handling, delivery: await this.#deliver(actions) };
  }

  #queueMessageBurst(event: InboundMessageEvent, explicit: boolean): Promise<ChannelIngestResult> {
    const key = event.conversation.id;
    const existing = this.#pendingMessageBursts.get(key);
    if (existing && existing.items.at(-1)?.event.sender.id !== event.sender.id) {
      clearTimeout(existing.timer);
      this.#pendingMessageBursts.delete(key);
      void this.#flushMessageBurst(existing);
    }
    return new Promise<ChannelIngestResult>((resolve, reject) => {
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
        if (this.#pendingMessageBursts.get(key) !== burst) return;
        this.#pendingMessageBursts.delete(key);
        void this.#flushMessageBurst(burst);
      }, debounceMs);
    });
  }

  async #flushMessageBurst(burst: PendingMessageBurst): Promise<void> {
    clearTimeout(burst.timer);
    const previousTexts = burst.items.slice(0, -1).map((item) => item.event.text).filter(Boolean);
    for (let index = 0; index < burst.items.length; index += 1) {
      const item = burst.items[index]!;
      const isLast = index === burst.items.length - 1;
      const event = isLast && previousTexts.length > 0
        ? mergeBurstSignals(item.event, burst.items.slice(0, -1).map((entry) => entry.event), previousTexts)
        : item.event;
      try {
        item.resolve(await this.#ingest(event, isLast ? undefined : "message-burst-fragment"));
      } catch (error) {
        item.reject(error);
      }
    }
  }

  async #flushAllMessageBursts(): Promise<void> {
    const bursts = [...this.#pendingMessageBursts.values()];
    this.#pendingMessageBursts.clear();
    await Promise.allSettled(bursts.map((burst) => this.#flushMessageBurst(burst)));
  }

  async #deliver(actions: OutboundMessageAction[]): Promise<OutboxDeliveryReport> {
    const outcomes = await Promise.all(actions.map((action) => this.#deliverOne(action)));
    const report = emptyDeliveryReport();
    for (const outcome of outcomes) {
      report.attempted.push(outcome.actionId);
      if (outcome.status === "delivered") report.delivered.push(outcome.actionId);
      else report.failed.push({ actionId: outcome.actionId, error: outcome.error });
    }
    return report;
  }

  #deliverOne(action: OutboundMessageAction): Promise<DeliveryOutcome> {
    const active = this.#sending.get(action.id);
    if (active) return active;

    const operation = (async (): Promise<DeliveryOutcome> => {
      try {
        this.#assertSendSupported(action);
        await this.#plugin.send(action);
        this.#core.acknowledgeOutbox([action.id]);
        return { actionId: action.id, status: "delivered" };
      } catch (error) {
        const message = errorMessage(error);
        this.#reportError(error, { phase: "send", actionId: action.id });
        return { actionId: action.id, status: "failed", error: message };
      }
    })();
    this.#sending.set(action.id, operation);
    operation.then(
      () => this.#sending.delete(action.id),
      () => this.#sending.delete(action.id),
    );
    return operation;
  }

  #registerFeature(feature: ChannelFeature): void {
    assertFeature(feature);
    const key = featureKey(feature);
    if (this.#features.has(key)) throw new Error(`Duplicate channel feature: ${key}`);
    this.#features.set(key, feature);
  }

  #assertSendSupported(action: OutboundMessageAction): void {
    validateMessageParts(action.parts);
    for (const part of action.parts ?? []) {
      const feature = requiredSendFeature(part);
      if (feature && !this.supports(feature)) {
        throw new Error(`Channel ${this.#plugin.id} does not support ${featureKey(feature)}`);
      }
    }
  }

  #assertReceiveSupported(event: InboundMessageEvent): void {
    validateMessageParts(event.parts);
    for (const part of event.parts ?? []) {
      const feature = requiredReceiveFeature(part);
      if (feature && !this.supports(feature)) {
        throw new Error(`Channel ${this.#plugin.id} emitted ${part.type} without declaring ${featureKey(feature)}`);
      }
      if (
        (part.type === "image" ||
          part.type === "audio" ||
          part.type === "voice" ||
          part.type === "video" ||
          part.type === "file") &&
        part.asset.source === "platform" &&
        part.asset.ownerPluginId !== this.#plugin.id
      ) {
        throw new Error(`Platform asset ${part.asset.id} must be owned by channel plugin ${this.#plugin.id}`);
      }
    }
  }

  #assertMediaOwnership(request: unknown): void {
    if (typeof request !== "object" || request === null || !("asset" in request)) {
      throw new Error("media.resolve requires an asset");
    }
    const asset = request.asset;
    if (typeof asset !== "object" || asset === null) throw new Error("media.resolve asset is invalid");
    if ("ownerPluginId" in asset && asset.ownerPluginId && asset.ownerPluginId !== this.#plugin.id) {
      throw new Error(`Asset belongs to channel plugin ${String(asset.ownerPluginId)}, not ${this.#plugin.id}`);
    }
    if ("expiresAt" in asset && typeof asset.expiresAt === "number" && asset.expiresAt < Date.now()) {
      throw new Error("Platform asset reference has expired");
    }
  }

  #reportError(error: unknown, context: Omit<ChannelRuntimeErrorContext, "pluginId">): void {
    try {
      this.#onError?.(error, { pluginId: this.#plugin.id, ...context });
    } catch {
      // Channel observability must never break state handling or outbox retries.
    }
  }
}

function assertStableInboundTransformation(original: InboundMessageEvent, transformed: InboundMessageEvent): void {
  if (
    transformed.id !== original.id ||
    transformed.type !== original.type ||
    transformed.conversation.id !== original.conversation.id ||
    transformed.sender.id !== original.sender.id
  ) {
    throw new Error("Inbound transformers cannot change event, conversation, or sender identity");
  }
}

export function defineChannelPlugin<T extends ChannelPlugin>(plugin: T): T {
  assertChannelPlugin(plugin);
  return plugin;
}

function assertChannelPlugin(plugin: ChannelPlugin): void {
  if (plugin.apiVersion !== CHANNEL_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported channel plugin API version: ${String(plugin.apiVersion)}`);
  }
  if (!plugin.id.trim()) throw new Error("Channel plugin id cannot be empty");
  if (plugin.displayName !== undefined && !plugin.displayName.trim()) {
    throw new Error("Channel plugin displayName cannot be empty");
  }
  if (typeof plugin.start !== "function" || typeof plugin.send !== "function" || typeof plugin.stop !== "function") {
    throw new Error("Channel plugin must implement start, send, and stop");
  }
  const declared = new Set<string>();
  for (const feature of plugin.features ?? []) {
    assertFeature(feature);
    const key = featureKey(feature);
    if (declared.has(key)) throw new Error(`Duplicate channel feature: ${key}`);
    declared.add(key);
  }
  for (const binding of plugin.capabilities ?? []) {
    assertFeature(binding.capability);
    if (typeof binding.invoke !== "function") throw new Error("Channel capability binding must implement invoke");
    const key = featureKey(binding.capability);
    if (declared.has(key)) throw new Error(`Duplicate channel feature or capability: ${key}`);
    declared.add(key);
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Channel outbox limit must be an integer between 1 and 10000");
  }
  return value;
}

function boundedOutboxAge(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000) {
    throw new Error("Channel maxOutboxAgeMs must be an integer between 1 and 86400000");
  }
  return value;
}

function boundedMessageBurstDebounce(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) {
    throw new Error("Channel messageBurstDebounceMs must be an integer between 0 and 30000");
  }
  return value;
}

function boundedExplicitMessageBurstDebounce(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5_000) {
    throw new Error("Channel explicitMessageBurstDebounceMs must be an integer between 0 and 5000");
  }
  return value;
}

function defaultExplicitMessageBurstSignal(event: InboundMessageEvent): boolean {
  return (event.mentions?.length ?? 0) > 0 || event.replyTo !== undefined;
}

function isBurstEligible(event: InboundMessageEvent): boolean {
  if (event.conversation.kind !== "group" || event.sender.isBot || !event.text.trim()) return false;
  if (event.metadata?.passiveContext === true || event.metadata?.proactiveKind || event.metadata?.interaction) return false;
  if ((event.attachments?.length ?? 0) > 0) return false;
  return !(event.parts ?? []).some((part) =>
    part.type === "image" || part.type === "audio" || part.type === "voice" ||
    part.type === "video" || part.type === "file" || part.type === "link");
}

function mergeBurstSignals(
  current: InboundMessageEvent,
  previous: InboundMessageEvent[],
  previousTexts: string[],
): InboundMessageEvent {
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

function handlerEventForBurst(event: InboundMessageEvent): InboundMessageEvent {
  const previous = event.metadata?.burstPreviousTexts;
  if (!Array.isArray(previous) || previous.some((item) => typeof item !== "string") || previous.length === 0) {
    return event;
  }
  return { ...event, text: [...previous, event.text].filter(Boolean).join("\n") };
}

function emptyDeliveryReport(): OutboxDeliveryReport {
  return { attempted: [], delivered: [], failed: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
