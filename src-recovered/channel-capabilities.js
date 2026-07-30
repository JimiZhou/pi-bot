export function defineChannelFeature(id, version, options) {
    assertFeatureIdentity(id, version);
    return Object.freeze({ id, version, ...(options ? { options: Object.freeze({ ...options }) } : {}) });
}
export function defineChannelCapability(id, version) {
    return defineChannelFeature(id, version);
}
export function provideChannelCapability(capability, handler) {
    return {
        capability,
        async invoke(request) {
            return handler(request);
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
export const MEDIA_RESOLVE_CAPABILITY = defineChannelCapability("media.resolve", 1);
export function requiredSendFeature(part) {
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
export function requiredReceiveFeature(part) {
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
export function featureKey(feature) {
    return `${feature.id}@${feature.version}`;
}
export function assertFeature(feature) {
    assertFeatureIdentity(feature.id, feature.version);
    if (feature.options) {
        for (const [key, value] of Object.entries(feature.options)) {
            if (!key.trim())
                throw new Error("Channel feature option name cannot be empty");
            if (typeof value !== "string" &&
                (typeof value !== "number" || !Number.isFinite(value)) &&
                typeof value !== "boolean" &&
                !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
                throw new Error(`Invalid option for channel feature ${feature.id}: ${key}`);
            }
        }
    }
}
function assertFeatureIdentity(id, version) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(id)) {
        throw new Error(`Invalid channel feature id: ${id}`);
    }
    if (!Number.isSafeInteger(version) || version < 1)
        throw new Error("Channel feature version must be positive");
}
function assertNever(value) {
    throw new Error(`Unsupported message part: ${JSON.stringify(value)}`);
}
//# sourceMappingURL=channel-capabilities.js.map