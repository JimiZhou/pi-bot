import type { MediaResolver } from "../asset-store.js";
import { type ChannelPlugin } from "../channel.js";
import type { InboundMessageEvent } from "../types.js";
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface WechatIpadVoicePayload {
    data: Uint8Array;
    mimeType: string;
}
export type WechatIpadVoiceTranscoder = (data: Uint8Array, mimeType: string) => Promise<WechatIpadVoicePayload>;
export interface WechatIpadApiClientOptions {
    baseUrl: string;
    accountWxid: string;
    apiToken?: string;
    timeoutMs?: number;
    fetch?: FetchLike;
    /** Reports protocol responses that conclusively indicate the account session is no longer valid. */
    onSessionInvalid?: (error: WechatIpadApiError) => void;
    /** Converts common audio containers into Tencent SILK for a native WeChat voice bubble. */
    voiceTranscoder?: WechatIpadVoiceTranscoder;
}
export interface WechatIpadGroupMember {
    id: string;
    nickname?: string;
    displayName?: string;
}
export interface WechatIpadGroupInfo {
    id: string;
    title?: string;
}
export interface WechatIpadAccountProfileUpdate {
    nickname?: string;
    sex?: 0 | 1 | 2;
    country?: string;
    province?: string;
    city?: string;
    signature?: string;
}
export type WechatIpadGroupMemberAction = "add" | "invite" | "remove";
export type WechatIpadGroupAdminAction = "add" | "remove" | "transfer";
export interface WechatIpadCallbackOptions {
    host?: string;
    port: number;
    pathPrefix?: string;
    allowedSourceIps?: string[];
    maxBodyBytes?: number;
    routerBaseUrl?: string;
    advertiseHost?: string;
    autoRegister?: boolean;
    registerIntervalMs?: number;
}
export interface WechatIpadChannelErrorContext {
    phase: "callback" | "spool" | "ingest" | "contact-change" | "send" | "send-quote" | "register";
    deliveryId?: string;
    actionId?: string;
}
export interface NormalizeWechatIpadMessageOptions {
    pluginId: string;
    accountWxid: string;
    deliveryId?: string;
    accountId?: string;
    isBotSender?: (nativeSenderId: string) => boolean;
}
export interface WechatIpadChannelOptions {
    api: WechatIpadApiClientOptions;
    callback: WechatIpadCallbackOptions;
    pluginId?: string;
    displayName?: string;
    accountId?: string;
    stateDirectory?: string;
    ingestRetryMs?: number;
    isBotSender?: (nativeSenderId: string) => boolean;
    resolveGroupMemberName?: (roomId: string, nativeSenderId: string) => Promise<string | undefined>;
    /** Receives native ModContacts signals after the callback envelope is durable. */
    onGroupContactChanged?: (roomId: string, kind: WechatIpadGroupContactChange["kind"]) => void | Promise<void>;
    /** Reports a fresh, valid native inbound event as positive account-session evidence. */
    onSessionActivity?: (observedAt: number) => void;
    outboundMediaResolver?: MediaResolver;
    onError?: (error: unknown, context: WechatIpadChannelErrorContext) => void;
}
export interface WechatIpadCallbackAddress {
    host: string;
    port: number;
    path: string;
}
export interface WechatIpadChannel extends ChannelPlugin {
    readonly client: WechatIpadApiClient;
    callbackAddress(): WechatIpadCallbackAddress | undefined;
    registerCallback(): Promise<{
        accountWxid: string;
        clientHost: string;
    }>;
}
export interface WechatIpadNativeMessage extends Readonly<Record<string, unknown>> {
    MsgId?: string | number;
    NewMsgId?: string | number;
    FromUserName?: unknown;
    ToUserName?: unknown;
    MsgType?: string | number;
    Content?: unknown;
    Status?: string | number;
    ImgStatus?: string | number;
    ImgBuf?: unknown;
    CreateTime?: string | number;
    MsgSource?: unknown;
    MsgSeq?: string | number;
}
export interface WechatIpadSyncEnvelope extends Readonly<Record<string, unknown>> {
    Code?: string | number;
    Success?: boolean;
    Message?: string;
    Data?: unknown;
    Data62?: unknown;
    Debug?: unknown;
    ID?: unknown;
}
export interface WechatIpadGroupContactChange {
    roomId: string;
    kind: "modified" | "deleted";
}
interface NativeMediaMetadata {
    nativeType: string;
    msgId?: string;
    newMsgId?: string;
    fromUserName?: string;
    toUserName?: string;
    fileAesKey?: string;
    fileNo?: string;
    bufId?: string;
    dataLen?: number;
    attachId?: string;
    appId?: string;
    userName?: string;
    nativeContent?: string;
    inlineDataBase64?: string;
}
interface DecodedMedia {
    data: Uint8Array;
    mimeType: string;
}
export declare class WechatIpadApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly response: unknown;
    constructor(message: string, status: number, code: string, response: unknown);
}
/** A narrow allowlist client for the raw iPad protocol. It never exposes arbitrary endpoints to Pi. */
export declare class WechatIpadApiClient {
    #private;
    readonly accountWxid: string;
    constructor(options: WechatIpadApiClientOptions);
    health(): Promise<Record<string, unknown>>;
    listGroupMembers(roomId: string): Promise<WechatIpadGroupMember[]>;
    getGroupInfo(roomId: string): Promise<WechatIpadGroupInfo>;
    getAccountProfile(): Promise<unknown>;
    updateAccountProfile(input: WechatIpadAccountProfileUpdate): Promise<unknown>;
    uploadHeadImage(data: Uint8Array): Promise<unknown>;
    getAccountQrCode(style?: number): Promise<unknown>;
    getGroupDetails(roomId: string): Promise<unknown>;
    getGroupQrCode(roomId: string): Promise<unknown>;
    setGroupRemarks(roomId: string, value: string): Promise<unknown>;
    setGroupName(roomId: string, value: string): Promise<unknown>;
    setGroupAnnouncement(roomId: string, value: string): Promise<unknown>;
    saveGroupToContacts(roomId: string, enabled: boolean): Promise<unknown>;
    manageGroupMembers(roomId: string, action: WechatIpadGroupMemberAction, memberIds: string[]): Promise<unknown>;
    operateGroupAdmin(roomId: string, action: WechatIpadGroupAdminAction, memberIds: string[]): Promise<unknown>;
    listContacts(): Promise<unknown>;
    getContactDetails(contactIds: string[], chatRoomId?: string): Promise<unknown>;
    searchContact(query: string): Promise<unknown>;
    getFriendState(contactId: string): Promise<unknown>;
    setContactRemark(contactId: string, remarks: string): Promise<unknown>;
    approveFriendRequest(scene: number, v1: string, v2: string): Promise<unknown>;
    listLabels(): Promise<unknown>;
    addLabel(name: string): Promise<unknown>;
    renameLabel(labelId: string, name: string): Promise<unknown>;
    updateLabelMembers(labelId: string, contactIds: string[]): Promise<unknown>;
    deleteLabel(labelId: string): Promise<unknown>;
    listMoments(): Promise<unknown>;
    publishTextMoment(content: string, privacy?: "public" | "private"): Promise<unknown>;
    likeMoment(momentId: string): Promise<unknown>;
    commentMoment(momentId: string, content: string): Promise<unknown>;
    sendText(to: string, content: string, at?: string[]): Promise<void>;
    /** Sends text as a native quote reply (appmsg type 57 with a refermsg block). */
    sendReferText(to: string, content: string, quote: {
        svrid: string;
        chatusr: string;
        displayname: string;
        excerpt: string;
    }): Promise<void>;
    sendImage(to: string, data: Uint8Array): Promise<void>;
    sendEmoji(to: string, data: Uint8Array): Promise<void>;
    sendEmojiReference(to: string, md5: string, totalLen: number): Promise<void>;
    sendVoice(to: string, data: Uint8Array, mimeType: string | undefined, durationMs: number | undefined): Promise<void>;
    sendVideo(to: string, data: Uint8Array, durationMs: number | undefined): Promise<void>;
    sendFile(to: string, data: Uint8Array, name: string | undefined, mimeType: string | undefined): Promise<void>;
    forwardMedia(to: string, nativeType: string, nativeContent: string): Promise<void>;
    downloadImage(fileAesKey: string, fileNo: string): Promise<DecodedMedia>;
    downloadVoice(metadata: NativeMediaMetadata): Promise<DecodedMedia>;
    downloadVideo(metadata: NativeMediaMetadata): Promise<DecodedMedia>;
    downloadFile(metadata: NativeMediaMetadata): Promise<DecodedMedia>;
}
/** Matches terminal authentication/session responses without treating ordinary API failures as logout. */
export declare function isWechatIpadSessionInvalidError(error: unknown): error is WechatIpadApiError;
/** Create a callback/spool ChannelPlugin for the raw iPad protocol service. */
export declare function createWechatIpadChannel(options: WechatIpadChannelOptions): WechatIpadChannel;
/** Convert one iPad AddMsgs item. Unsupported/system/self messages return null. */
export declare function normalizeWechatIpadMessage(message: WechatIpadNativeMessage, options: NormalizeWechatIpadMessageOptions): InboundMessageEvent | null;
export declare function parseWechatIpadSyncEnvelope(body: Uint8Array | string): WechatIpadSyncEnvelope;
export declare function wechatIpadCallbackMessages(envelope: WechatIpadSyncEnvelope): WechatIpadNativeMessage[];
/** Extracts group-directory changes carried beside AddMsgs in an iPad sync callback. */
export declare function wechatIpadCallbackGroupContactChanges(envelope: WechatIpadSyncEnvelope): WechatIpadGroupContactChange[];
export declare function isWechatIpadCallbackSourceAllowed(remoteAddress: string | undefined, rules: readonly string[]): boolean;
/**
 * Splits a long reply into a few chat-sized bubbles at paragraph and sentence
 * boundaries. One giant zero-delay wall of text is the clearest bot tell in a
 * group; a couple of naturally paced messages reads like a person typing.
 */
export declare function splitOutboundText(content: string): string[];
/** Human-feeling delay before a follow-up bubble, proportional to its length. */
export declare function outboundPacingDelayMs(content: string): number;
/** Selects the highest useful SILK bitrate that stays within one iPad protocol fragment. */
export declare function wechatIpadSilkBitrateForPcmBytes(pcmBytes: number): number;
export {};
//# sourceMappingURL=wechat-ipad.d.ts.map