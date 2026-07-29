import type { ResolvedAsset } from "./asset-store.js";
import type { AssetRef, MessagePart } from "./types.js";

export type ChannelFeatureValue = string | number | boolean | readonly string[];

export interface ChannelFeature {
  readonly id: string;
  readonly version: number;
  readonly options?: Readonly<Record<string, ChannelFeatureValue>>;
}

export interface ChannelCapabilityToken<TRequest, TResult> extends ChannelFeature {
  /** Type-only marker; it is never present at runtime. */
  readonly __channelCapabilityTypes?: {
    request: TRequest;
    result: TResult;
  };
}

export interface ChannelCapabilityBinding {
  readonly capability: ChannelFeature;
  invoke(request: unknown): Promise<unknown>;
}

export function defineChannelFeature(
  id: string,
  version: number,
  options?: Readonly<Record<string, ChannelFeatureValue>>,
): ChannelFeature {
  assertFeatureIdentity(id, version);
  return Object.freeze({ id, version, ...(options ? { options: Object.freeze({ ...options }) } : {}) });
}

export function defineChannelCapability<TRequest, TResult>(
  id: string,
  version: number,
): ChannelCapabilityToken<TRequest, TResult> {
  return defineChannelFeature(id, version) as ChannelCapabilityToken<TRequest, TResult>;
}

export function provideChannelCapability<TRequest, TResult>(
  capability: ChannelCapabilityToken<TRequest, TResult>,
  handler: (request: TRequest) => TResult | Promise<TResult>,
): ChannelCapabilityBinding {
  return {
    capability,
    async invoke(request) {
      return handler(request as TRequest);
    },
  };
}

export const CHANNEL_FEATURE_SEND_IMAGE = defineChannelFeature("message.send.image", 1);
export const CHANNEL_FEATURE_SEND_AUDIO = defineChannelFeature("message.send.audio", 1);
export const CHANNEL_FEATURE_SEND_VOICE = defineChannelFeature("message.send.voice", 1);
export const CHANNEL_FEATURE_SEND_VIDEO = defineChannelFeature("message.send.video", 1);
export const CHANNEL_FEATURE_SEND_FILE = defineChannelFeature("message.send.file", 1);
export const CHANNEL_FEATURE_SEND_MENTION = defineChannelFeature("message.send.mention", 1);
export const CHANNEL_FEATURE_RECEIVE_IMAGE = defineChannelFeature("message.receive.image", 1);
export const CHANNEL_FEATURE_RECEIVE_AUDIO = defineChannelFeature("message.receive.audio", 1);
export const CHANNEL_FEATURE_RECEIVE_VOICE = defineChannelFeature("message.receive.voice", 1);
export const CHANNEL_FEATURE_RECEIVE_VIDEO = defineChannelFeature("message.receive.video", 1);
export const CHANNEL_FEATURE_RECEIVE_FILE = defineChannelFeature("message.receive.file", 1);

export interface ResolveMediaRequest {
  asset: AssetRef;
}

export const MEDIA_RESOLVE_CAPABILITY = defineChannelCapability<ResolveMediaRequest, ResolvedAsset>(
  "media.resolve",
  1,
);

export function requiredSendFeature(part: MessagePart): ChannelFeature | undefined {
  switch (part.type) {
    case "image":
      return CHANNEL_FEATURE_SEND_IMAGE;
    case "audio":
      return CHANNEL_FEATURE_SEND_AUDIO;
    case "voice":
      return CHANNEL_FEATURE_SEND_VOICE;
    case "video":
      return CHANNEL_FEATURE_SEND_VIDEO;
    case "file":
      return CHANNEL_FEATURE_SEND_FILE;
    case "mention":
      return CHANNEL_FEATURE_SEND_MENTION;
    case "text":
    case "link":
    case "quote":
      return undefined;
    default:
      return assertNever(part);
  }
}

export function requiredReceiveFeature(part: MessagePart): ChannelFeature | undefined {
  switch (part.type) {
    case "image":
      return CHANNEL_FEATURE_RECEIVE_IMAGE;
    case "audio":
      return CHANNEL_FEATURE_RECEIVE_AUDIO;
    case "voice":
      return CHANNEL_FEATURE_RECEIVE_VOICE;
    case "video":
      return CHANNEL_FEATURE_RECEIVE_VIDEO;
    case "file":
      return CHANNEL_FEATURE_RECEIVE_FILE;
    case "text":
    case "link":
    case "mention":
    case "quote":
      return undefined;
    default:
      return assertNever(part);
  }
}

export function featureKey(feature: ChannelFeature): string {
  return `${feature.id}@${feature.version}`;
}

export function assertFeature(feature: ChannelFeature): void {
  assertFeatureIdentity(feature.id, feature.version);
  if (feature.options) {
    for (const [key, value] of Object.entries(feature.options)) {
      if (!key.trim()) throw new Error("Channel feature option name cannot be empty");
      if (
        typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value)) &&
        typeof value !== "boolean" &&
        !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
      ) {
        throw new Error(`Invalid option for channel feature ${feature.id}: ${key}`);
      }
    }
  }
}

function assertFeatureIdentity(id: string, version: number): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(id)) {
    throw new Error(`Invalid channel feature id: ${id}`);
  }
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Channel feature version must be positive");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported message part: ${JSON.stringify(value)}`);
}
