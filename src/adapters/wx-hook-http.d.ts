import { type ChannelPlugin } from "../channel.js";
import type { MediaResolver } from "../asset-store.js";
import type { AssetRef, InboundMessageEvent } from "../types.js";
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface WxHookGatewayClientOptions {
    baseUrl: string;
    apiToken: string;
    timeoutMs?: number;
    fetch?: FetchLike;
}
export interface WxHookSendRequest {
    to: string;
    content: string;
    type?: 1 | 3 | 5;
    at_user_list?: string[];
    quote?: WxHookQuoteRequest;
}
export interface WxHookQuoteRequest {
    message_id: string;
    local_id: string;
    content: string;
    sender_id: string;
    type: string;
    timestamp: string;
    conversation_id: string;
    signature?: string;
    source_to?: string;
}
export interface WxHookWebhookRegistration {
    id: string;
    url: string;
    events: string[];
    secret: string;
    enabled: boolean;
    created_at: string;
}
export interface WxHookWebhookSummary extends Omit<WxHookWebhookRegistration, "secret"> {
    secret: string;
}
export type WxHookImageVariant = "medium" | "thumbnail" | "original";
export interface WxHookResolvedMediaAsset {
    id: string;
    message_id: string;
    variant: WxHookImageVariant;
    mime_type: string;
    size: number;
    sha256: string;
    download_url: string;
}
export interface WxHookStagedImageAsset {
    id: string;
    mime_type: string;
    size: number;
    sha256: string;
    windows_path: string;
}
export interface WxHookMessagePayload extends Readonly<Record<string, unknown>> {
    msgId?: string | number;
    localId?: string | number;
    msgLocalId?: string | number;
    type?: string | number;
    subType?: string | number;
    subtype?: string | number;
    timestamp?: string | number;
    from?: string;
    fromWxId?: string;
    rawFrom?: string;
    rawTo?: string;
    isSendMsg?: boolean;
    isIncoming?: boolean;
    direction?: string;
    peerWxId?: string;
    roomId?: string;
    senderWxId?: string;
    senderName?: string;
    senderDisplayName?: string;
    nickname?: string;
    nickName?: string;
    memberName?: string;
    selfWxId?: string;
    content?: string;
    signature?: string;
}
export interface WxHookWebhookEnvelope {
    id: string;
    event: string;
    created_at: string;
    data: WxHookMessagePayload;
}
export interface WxHookContactSummary {
    id: string;
    displayName: string;
}
export interface WxHookWebhookOptions {
    secret: string;
    port: number;
    host?: string;
    path?: string;
    maxBodyBytes?: number;
    maxTimestampSkewMs?: number;
}
export interface WxHookChannelErrorContext {
    phase: "webhook" | "spool" | "ingest" | "send";
    deliveryId?: string;
    actionId?: string;
}
export interface NormalizeWxHookMessageOptions {
    pluginId: string;
    deliveryId?: string;
    accountId?: string;
    acceptUnknownGroupSenders?: boolean;
    isBotSender?: (nativeSenderId: string) => boolean;
}
export interface WxHookHttpChannelOptions {
    gateway: WxHookGatewayClientOptions;
    webhook: WxHookWebhookOptions;
    pluginId?: string;
    displayName?: string;
    accountId?: string;
    stateDirectory?: string;
    acceptUnknownGroupSenders?: boolean;
    nativeQuoteReplies?: boolean;
    ingestRetryMs?: number;
    isBotSender?: (nativeSenderId: string) => boolean;
    resolveGroupMemberName?: (roomId: string, nativeSenderId: string) => Promise<string | undefined>;
    resolveWindowsImagePath?: (asset: AssetRef) => string | undefined | Promise<string | undefined>;
    outboundMediaResolver?: MediaResolver;
    onError?: (error: unknown, context: WxHookChannelErrorContext) => void;
}
export interface WxHookWebhookAddress {
    host: string;
    port: number;
    path: string;
}
export interface WxHookHttpChannel extends ChannelPlugin {
    readonly gateway: WxHookGatewayClient;
    webhookAddress(): WxHookWebhookAddress | undefined;
}
export declare class WxHookGatewayError extends Error {
    readonly status: number;
    readonly code: string;
    readonly response: unknown;
    constructor(message: string, status: number, code: string, response: unknown);
}
/** Narrow client for the documented LAN gateway. It never exposes arbitrary native commands. */
export declare class WxHookGatewayClient {
    #private;
    constructor(options: WxHookGatewayClientOptions);
    health(): Promise<Record<string, unknown>>;
    send(request: WxHookSendRequest): Promise<Record<string, unknown>>;
    listMessages(limit?: number): Promise<unknown[]>;
    listContacts(): Promise<WxHookContactSummary[]>;
    getMessage(messageId: string): Promise<WxHookMessagePayload>;
    resolveMedia(messageId: string, variant?: WxHookImageVariant): Promise<WxHookResolvedMediaAsset>;
    downloadMedia(asset: WxHookResolvedMediaAsset): Promise<AsyncIterable<Uint8Array>>;
    stageImage(data: Uint8Array, mimeType: string, sha256: string): Promise<WxHookStagedImageAsset>;
    listWebhooks(): Promise<WxHookWebhookSummary[]>;
    registerWebhook(input: {
        url: string;
        secret: string;
        events?: string[];
        enabled?: boolean;
    }): Promise<WxHookWebhookRegistration>;
    testWebhook(webhookId: string): Promise<string>;
    deleteWebhook(webhookId: string): Promise<void>;
}
/** Create a self-contained ChannelPlugin backed by the wx_hook_bridge HTTP API and signed webhook. */
export declare function createWxHookHttpChannel(options: WxHookHttpChannelOptions): WxHookHttpChannel;
/** Convert one verified native message. Unsupported/system/self messages return null. */
export declare function normalizeWxHookMessage(payload: WxHookMessagePayload, options: NormalizeWxHookMessageOptions): InboundMessageEvent | null;
export declare function verifyWxHookWebhookSignature(input: {
    body: Uint8Array;
    timestamp: string | undefined;
    signature: string | undefined;
    secret: string;
    maxTimestampSkewMs?: number;
    now?: number;
}): boolean;
export {};
//# sourceMappingURL=wx-hook-http.d.ts.map