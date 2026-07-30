import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHANNEL_FEATURE_RECEIVE_FILE, CHANNEL_FEATURE_RECEIVE_IMAGE, CHANNEL_FEATURE_RECEIVE_VIDEO, CHANNEL_FEATURE_RECEIVE_VOICE, CHANNEL_FEATURE_SEND_AUDIO, CHANNEL_FEATURE_SEND_FILE, CHANNEL_FEATURE_SEND_IMAGE, CHANNEL_FEATURE_SEND_MENTION, CHANNEL_FEATURE_SEND_VIDEO, CHANNEL_FEATURE_SEND_VOICE, CHANNEL_PLUGIN_API_VERSION, MEDIA_RESOLVE_CAPABILITY, defineChannelPlugin, provideChannelCapability, } from "../channel.js";
import { parseRedEnvelopeMetadata } from "../red-envelope.js";
import { runWechatIpadProtocolRequest } from "../wechat-ipad-request-queue.js";
import { wechatEmojiSendReference } from "../wechat-emoji.js";
const DEFAULT_API_TIMEOUT_MS = 35_000;
const DEFAULT_CALLBACK_PATH_PREFIX = "/api/v1/wechat-client";
const DEFAULT_BODY_LIMIT = 16 * 1024 * 1024;
const DEFAULT_INGEST_RETRY_MS = 2_000;
const DEFAULT_REGISTER_INTERVAL_MS = 60_000;
const DEFAULT_STARTUP_REPLAY_GRACE_MS = 2 * 60_000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const WECHAT_IPAD_SILK_SAMPLE_RATE = 24_000;
const WECHAT_IPAD_SILK_MAX_BITRATE = 24_000;
const WECHAT_IPAD_SILK_MIN_BITRATE = 6_000;
// The deployed iPad protocol splits SILK payloads at exactly 65,000 bytes. Its
// later fragments can be acknowledged but remain unavailable to WeChat, which
// leaves a voice bubble playable only up to the first roughly ten seconds.
// Keep encoded output below one protocol fragment with some framing headroom.
const WECHAT_IPAD_SILK_SAFE_BYTES = 60_000;
const WECHAT_IPAD_SILK_FRAGMENT_BYTES = 65_000;
const WECHAT_IPAD_SILK_FRAMING_BYTES_PER_SECOND = 100;
export class WechatIpadApiError extends Error {
    status;
    code;
    response;
    constructor(message, status, code, response) {
        super(message);
        this.name = "WechatIpadApiError";
        this.status = status;
        this.code = code;
        this.response = response;
    }
}
/** A narrow allowlist client for the raw iPad protocol. It never exposes arbitrary endpoints to Pi. */
export class WechatIpadApiClient {
    accountWxid;
    #voiceTranscoder;
    #baseUrl;
    #apiToken;
    #timeoutMs;
    #fetch;
    #onSessionInvalid;
    constructor(options) {
        this.#baseUrl = normalizedApiUrl(options.baseUrl);
        this.accountWxid = requiredNativeId(options.accountWxid, "accountWxid");
        this.#apiToken = options.apiToken?.trim() || undefined;
        this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS, "api timeoutMs");
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.#onSessionInvalid = options.onSessionInvalid;
        this.#voiceTranscoder = options.voiceTranscoder ?? transcodeCommonAudioToSilk;
    }
    async health() {
        let heartbeatAlive = false;
        let heartbeatCode = "unknown";
        try {
            await this.#request(`/Login/AutoHeartBeat?wxid=${encodeURIComponent(this.accountWxid)}`, {}, Math.min(this.#timeoutMs, 5_000));
            heartbeatAlive = true;
            heartbeatCode = "ok";
        }
        catch (error) {
            heartbeatCode = error instanceof WechatIpadApiError ? error.code : "probe_failed";
        }
        let response;
        try {
            response = await this.#request(`/Login/GetCacheInfo?wxid=${encodeURIComponent(this.accountWxid)}`, {}, Math.min(this.#timeoutMs, 5_000));
        }
        catch {
            // A stale or unavailable cache must not turn a failed live probe into an online status.
        }
        const data = isRecord(response?.Data) ? response.Data : undefined;
        const cachedWxid = nativeString(data?.Wxid) ?? nativeString(data?.WxId);
        const nickname = nativeString(data?.NickName);
        return {
            service: "wechat-ipad",
            loggedIn: heartbeatAlive && response?.Success === true && cachedWxid === this.accountWxid,
            sessionAlive: heartbeatAlive,
            heartbeatCode,
            accountWxid: this.accountWxid,
            ...(nickname ? { nickname } : {}),
        };
    }
    async listGroupMembers(roomId) {
        const response = await this.#request("/Group/GetChatRoomMemberDetail", {
            Wxid: this.accountWxid,
            QID: requiredNativeId(roomId, "room id"),
        });
        const data = isRecord(response.Data) ? response.Data : undefined;
        const roomData = isRecord(data?.NewChatroomData) ? data.NewChatroomData : undefined;
        const members = Array.isArray(roomData?.ChatRoomMember) ? roomData.ChatRoomMember : [];
        return members.flatMap((value) => {
            if (!isRecord(value))
                return [];
            const id = nativeString(value.UserName);
            if (!id)
                return [];
            const nickname = nativeString(value.NickName);
            const displayName = nativeString(value.DisplayName);
            return [{ id, ...(nickname ? { nickname } : {}), ...(displayName ? { displayName } : {}) }];
        });
    }
    async getGroupInfo(roomId) {
        const id = requiredNativeId(roomId, "room id");
        const response = await this.#request("/Group/GetChatRoomInfo", {
            Wxid: this.accountWxid,
            QID: id,
        });
        const data = isRecord(response.Data) ? response.Data : undefined;
        const contacts = Array.isArray(data?.ContactList) ? data.ContactList : [];
        const contact = contacts.find((value) => isRecord(value) && nativeString(value.UserName) === id);
        const title = isRecord(contact) ? nativeString(contact.NickName)?.trim() : undefined;
        return { id, ...(title ? { title } : {}) };
    }
    async getAccountProfile() {
        return (await this.#request("/User/GetContractProfile", { Wxid: this.accountWxid })).Data;
    }
    async updateAccountProfile(input) {
        const nickname = optionalNativeText(input.nickname, "nickname", 32);
        const country = optionalNativeText(input.country, "country", 32);
        const province = optionalNativeText(input.province, "province", 64);
        const city = optionalNativeText(input.city, "city", 64);
        const signature = optionalNativeText(input.signature, "signature", 120);
        if (nickname === undefined && input.sex === undefined && country === undefined && province === undefined &&
            city === undefined && signature === undefined) {
            throw new Error("wechat-ipad profile update has no fields");
        }
        if (input.sex !== undefined && ![0, 1, 2].includes(input.sex))
            throw new Error("wechat-ipad profile sex is invalid");
        return (await this.#request("/User/UpdateProfile", {
            Wxid: this.accountWxid,
            ...(nickname === undefined ? {} : { NickName: nickname }),
            ...(input.sex === undefined ? {} : { Sex: input.sex }),
            ...(country === undefined ? {} : { Country: country }),
            ...(province === undefined ? {} : { Province: province }),
            ...(city === undefined ? {} : { City: city }),
            ...(signature === undefined ? {} : { Signature: signature }),
        })).Data;
    }
    async uploadHeadImage(data) {
        if (data.byteLength < 16 || data.byteLength > 5 * 1024 * 1024) {
            throw new Error("wechat-ipad avatar size must be between 16 bytes and 5 MiB");
        }
        return (await this.#request("/User/UploadHeadImage", {
            Wxid: this.accountWxid,
            Base64: encodeMedia(data),
        })).Data;
    }
    async getAccountQrCode(style = 0) {
        if (!Number.isInteger(style) || style < 0 || style > 2)
            throw new Error("wechat-ipad QR style is invalid");
        return (await this.#request("/User/GetQRCode", { Wxid: this.accountWxid, Style: style })).Data;
    }
    async getGroupDetails(roomId) {
        return (await this.#request("/Group/GetChatRoomInfoDetail", {
            Wxid: this.accountWxid,
            QID: requiredGroupId(roomId),
        })).Data;
    }
    async getGroupQrCode(roomId) {
        return (await this.#request("/Group/GetQRCode", {
            Wxid: this.accountWxid,
            QID: requiredGroupId(roomId),
        })).Data;
    }
    async setGroupRemarks(roomId, value) {
        return this.#setGroupText("/Group/SetChatRoomRemarks", roomId, value, "group remarks", 64, true);
    }
    async setGroupName(roomId, value) {
        return this.#setGroupText("/Group/SetChatRoomName", roomId, value, "group name", 64, false);
    }
    async setGroupAnnouncement(roomId, value) {
        return this.#setGroupText("/Group/SetChatRoomAnnouncement", roomId, value, "group announcement", 2_000, true);
    }
    async saveGroupToContacts(roomId, enabled) {
        return (await this.#request("/Group/MoveContractList", {
            Wxid: this.accountWxid,
            QID: requiredGroupId(roomId),
            Val: enabled ? 1 : 0,
        })).Data;
    }
    async manageGroupMembers(roomId, action, memberIds) {
        const endpoint = action === "add" ? "/Group/AddChatRoomMember"
            : action === "invite" ? "/Group/InviteChatRoomMember"
                : action === "remove" ? "/Group/DelChatRoomMember" : undefined;
        if (!endpoint)
            throw new Error("wechat-ipad group member action is invalid");
        const members = uniqueNativeIds(memberIds, "group member", 100);
        return (await this.#request(endpoint, {
            Wxid: this.accountWxid,
            ChatRoomName: requiredGroupId(roomId),
            ToWxids: members.join(","),
        })).Data;
    }
    async operateGroupAdmin(roomId, action, memberIds) {
        const val = action === "add" ? 1 : action === "remove" ? 2 : action === "transfer" ? 3 : undefined;
        if (!val)
            throw new Error("wechat-ipad group admin action is invalid");
        const members = uniqueNativeIds(memberIds, "group administrator", action === "transfer" ? 1 : 10);
        if (action === "transfer" && members.length !== 1)
            throw new Error("wechat-ipad ownership transfer requires one member");
        return (await this.#request("/Group/OperateChatRoomAdmin", {
            Wxid: this.accountWxid,
            QID: requiredGroupId(roomId),
            ToWxids: members.join(","),
            Val: val,
        })).Data;
    }
    async listContacts() {
        return (await this.#request("/Friend/GetContractList", {
            Wxid: this.accountWxid,
            CurrentWxcontactSeq: 0,
            CurrentChatRoomContactSeq: 0,
        })).Data;
    }
    async getContactDetails(contactIds, chatRoomId = "") {
        return (await this.#request("/Friend/GetContractDetail", {
            Wxid: this.accountWxid,
            ChatRoom: chatRoomId ? requiredGroupId(chatRoomId) : "",
            Towxids: uniqueNativeIds(contactIds, "contact", 100).join(","),
        })).Data;
    }
    async searchContact(query) {
        return (await this.#request("/Friend/Search", {
            Wxid: this.accountWxid,
            ToUserName: requiredText(query, "contact search query").slice(0, 64),
            FromScene: 0,
            SearchScene: 1,
        })).Data;
    }
    async getFriendState(contactId) {
        return (await this.#request("/Friend/GetFriendstate", {
            Wxid: this.accountWxid,
            UserName: requiredNativeId(contactId, "contact id"),
        })).Data;
    }
    async setContactRemark(contactId, remarks) {
        return (await this.#request("/Friend/SetRemarks", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(contactId, "contact id"),
            Remarks: boundedNativeText(remarks, "contact remarks", 64, true),
        })).Data;
    }
    async approveFriendRequest(scene, v1, v2) {
        if (!Number.isSafeInteger(scene) || scene < 0 || scene > 10_000)
            throw new Error("wechat-ipad friend request scene is invalid");
        return (await this.#request("/Friend/PassVerify", {
            Wxid: this.accountWxid,
            Scene: scene,
            V1: requiredText(v1, "friend request V1"),
            V2: requiredText(v2, "friend request V2"),
        })).Data;
    }
    async listLabels() {
        return (await this.#request("/Label/GetList", { Wxid: this.accountWxid })).Data;
    }
    async addLabel(name) {
        return (await this.#request("/Label/Add", {
            Wxid: this.accountWxid,
            LabelName: boundedNativeText(name, "label name", 32),
        })).Data;
    }
    async renameLabel(labelId, name) {
        const parsedId = Number(labelId);
        if (!Number.isSafeInteger(parsedId) || parsedId < 1)
            throw new Error("wechat-ipad label id is invalid");
        return (await this.#request("/Label/UpdateName", {
            Wxid: this.accountWxid,
            LabelID: parsedId,
            NewName: boundedNativeText(name, "label name", 32),
        })).Data;
    }
    async updateLabelMembers(labelId, contactIds) {
        return (await this.#request("/Label/UpdateList", {
            Wxid: this.accountWxid,
            LabelID: requiredText(labelId, "label id"),
            ToWxids: uniqueNativeIds(contactIds, "contact", 500).join(","),
        })).Data;
    }
    async deleteLabel(labelId) {
        return (await this.#request("/Label/Delete", {
            Wxid: this.accountWxid,
            LabelID: requiredText(labelId, "label id"),
        })).Data;
    }
    async listMoments() {
        return (await this.#request("/FriendCircle/GetList", {
            Wxid: this.accountWxid,
            Fristpagemd5: "",
            Maxid: 0,
        })).Data;
    }
    async publishTextMoment(content, privacy = "public") {
        const text = boundedNativeText(content, "moment content", 2_000);
        const privateValue = privacy === "private" ? 1 : privacy === "public" ? 0 : undefined;
        if (privateValue === undefined)
            throw new Error("wechat-ipad moment privacy is invalid");
        const xml = textMomentXml(this.accountWxid, text, privateValue);
        return (await this.#request("/FriendCircle/Messages", {
            Wxid: this.accountWxid,
            Content: xml,
            Privacy: privateValue,
            WithUserList: "",
            GroupUser: "",
            BlackList: "",
        })).Data;
    }
    async likeMoment(momentId) {
        return this.#commentMoment(momentId, 1, "");
    }
    async commentMoment(momentId, content) {
        return this.#commentMoment(momentId, 2, boundedNativeText(content, "moment comment", 500));
    }
    async #commentMoment(momentId, type, content) {
        return (await this.#request("/FriendCircle/Comment", {
            Wxid: this.accountWxid,
            Id: requiredDecimalId(momentId, "moment id"),
            Type: type,
            Content: content,
            ReplyCommnetId: 0,
        })).Data;
    }
    async #setGroupText(endpoint, roomId, value, label, max, allowEmpty) {
        return (await this.#request(endpoint, {
            Wxid: this.accountWxid,
            QID: requiredGroupId(roomId),
            Content: boundedNativeText(value, label, max, allowEmpty),
        })).Data;
    }
    async sendText(to, content, at = []) {
        const target = requiredNativeId(to, "recipient");
        if (!content.trim())
            throw new Error("wechat-ipad text content cannot be empty");
        await this.#request("/Msg/SendTxt", {
            Wxid: this.accountWxid,
            ToWxid: target,
            Content: content,
            Type: 1,
            At: [...new Set(at.map((value) => requiredNativeId(value, "mention id")))].join(","),
        });
    }
    /** Sends text as a native quote reply (appmsg type 57 with a refermsg block). */
    async sendReferText(to, content, quote) {
        const target = requiredNativeId(to, "recipient");
        if (!content.trim())
            throw new Error("wechat-ipad text content cannot be empty");
        await this.#request("/Msg/SendApp", {
            Wxid: this.accountWxid,
            ToWxid: target,
            Type: 57,
            Xml: referMsgXml(content, target, quote),
        });
    }
    async sendImage(to, data) {
        await this.#request("/Msg/UploadImg", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Base64: encodeMedia(data),
        });
    }
    async sendEmoji(to, data) {
        if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES)
            throw new Error("wechat-ipad emoji size is invalid");
        await this.#request("/Msg/SendEmoji", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Md5: createHash("md5").update(data).digest("hex"),
            TotalLen: data.byteLength,
            Base64: encodeMedia(data),
        });
    }
    async sendEmojiReference(to, md5, totalLen) {
        if (!/^[a-f\d]{32}$/iu.test(md5) || !Number.isSafeInteger(totalLen) || totalLen <= 0 || totalLen > MAX_MEDIA_BYTES) {
            throw new Error("wechat-ipad native emoji reference is invalid");
        }
        await this.#request("/Msg/SendEmoji", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Md5: md5.toLocaleLowerCase(),
            TotalLen: totalLen,
        });
    }
    async sendVoice(to, data, mimeType, durationMs) {
        const voice = await reliableVoicePayload(data, mimeType, this.#voiceTranscoder);
        await this.#request("/Msg/SendVoice", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Base64: encodeMedia(voice.data),
            Type: nativeVoiceType(voice.mimeType),
            VoiceTime: positiveDuration(durationMs),
        });
    }
    async sendVideo(to, data, durationMs) {
        await this.#request("/Msg/SendVideo", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Base64: encodeMedia(data),
            ImageBase64: "",
            PlayLength: Math.max(0, Math.ceil((durationMs ?? 0) / 1000)),
        });
    }
    async sendFile(to, data, name, mimeType) {
        const upload = await this.#request("/Tools/UploadFile", {
            Wxid: this.accountWxid,
            Base64: encodeMedia(data),
        });
        const uploadData = isRecord(upload.Data) ? upload.Data : undefined;
        const mediaId = nativeString(uploadData?.mediaId) ?? nativeString(uploadData?.MediaId);
        if (!mediaId)
            throw new WechatIpadApiError("wechat-ipad file upload returned no mediaId", 200, "invalid_response", upload);
        const fileName = safeFileDisplayName(name, mimeType);
        const xml = fileAppXml(fileName, data.byteLength, mediaId);
        await this.#request("/Msg/SendApp", {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Type: 6,
            Xml: xml,
        });
    }
    async forwardMedia(to, nativeType, nativeContent) {
        const endpoint = nativeType === "3"
            ? "/Msg/SendCDNImg"
            : nativeType === "43" || nativeType === "62"
                ? "/Msg/SendCDNVideo"
                : nativeType === "49"
                    ? "/Msg/SendCDNFile"
                    : undefined;
        if (!endpoint)
            throw new Error(`wechat-ipad cannot forward native media type ${nativeType}`);
        await this.#request(endpoint, {
            Wxid: this.accountWxid,
            ToWxid: requiredNativeId(to, "recipient"),
            Content: nativeContent,
        });
    }
    async downloadImage(fileAesKey, fileNo) {
        const response = await this.#request("/Tools/CdnDownloadImage", {
            Wxid: this.accountWxid,
            FileAesKey: requiredText(fileAesKey, "image AES key"),
            FileNo: requiredText(fileNo, "image CDN file number"),
        });
        return decodedProtocolMedia(response.Data, ["Image", "image", "Base64", "base64"], "image/jpeg");
    }
    async downloadVoice(metadata) {
        const msgId = protocolInt32(metadata.msgId, "voice MsgId");
        const totalLength = requiredPositiveNumber(metadata.dataLen, "voice length");
        const chunks = [];
        for (let offset = 0; offset < totalLength; offset += 60 * 1024) {
            const length = Math.min(60 * 1024, totalLength - offset);
            const response = await this.#request("/Tools/DownloadVoice", {
                Wxid: this.accountWxid,
                MsgId: msgId,
                Bufid: requiredText(metadata.bufId, "voice bufid"),
                FromUserName: requiredNativeId(metadata.fromUserName, "voice sender"),
                Offset: offset,
                Length: length,
            });
            const decoded = decodedProtocolMedia(response.Data, ["Voice", "voice", "Base64", "base64", "Data", "buffer"], "audio/silk");
            chunks.push(Buffer.from(decoded.data));
        }
        const data = Buffer.concat(chunks);
        if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
            throw new Error("wechat-ipad downloaded voice size is invalid");
        }
        return { data, mimeType: sniffMimeType(data) ?? "audio/silk" };
    }
    async downloadVideo(metadata) {
        const length = requiredPositiveNumber(metadata.dataLen, "video length");
        const response = await this.#request("/Tools/DownloadVideo", {
            Wxid: this.accountWxid,
            MsgId: protocolInt32(metadata.msgId, "video MsgId"),
            ToWxid: requiredNativeId(metadata.fromUserName ?? metadata.toUserName, "video peer"),
            DataLen: length,
            CompressType: 0,
            Section: { StartPos: 0, DataLen: length },
        });
        return decodedProtocolMedia(response.Data, ["Video", "video", "Base64", "base64", "Data"], "video/mp4");
    }
    async downloadFile(metadata) {
        const length = requiredPositiveNumber(metadata.dataLen, "file length");
        const response = await this.#request("/Tools/DownloadFile", {
            Wxid: this.accountWxid,
            AppID: metadata.appId ?? "",
            AttachId: requiredText(metadata.attachId, "file attach id"),
            DataLen: length,
            UserName: requiredNativeId(metadata.userName ?? metadata.fromUserName, "file sender"),
            Section: { StartPos: 0, DataLen: length },
        });
        return decodedProtocolMedia(response.Data, ["File", "file", "Base64", "base64", "Data"], "application/octet-stream");
    }
    async #request(path, body, timeoutMs = this.#timeoutMs) {
        return runWechatIpadProtocolRequest(this.#baseUrl.toString(), this.accountWxid, () => this.#requestNow(path, body, timeoutMs));
    }
    async #requestNow(path, body, timeoutMs) {
        const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8" });
        if (this.#apiToken)
            headers.set("Authorization", `Bearer ${this.#apiToken}`);
        let response;
        try {
            response = await this.#fetch(new URL(path.replace(/^\//, ""), this.#baseUrl), {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (error) {
            throw new WechatIpadApiError(`wechat-ipad API request failed: ${errorMessage(error)}`, 0, "network_error", undefined);
        }
        const raw = await response.text();
        let payload;
        try {
            payload = raw ? JSON.parse(preserveLargeIntegerFields(raw)) : {};
        }
        catch {
            throw new WechatIpadApiError("wechat-ipad API returned non-JSON data", response.status, "invalid_response", raw);
        }
        if (!isRecord(payload)) {
            throw new WechatIpadApiError("wechat-ipad API returned a non-object response", response.status, "invalid_response", payload);
        }
        const envelope = payload;
        if (!response.ok || envelope.Success !== true) {
            const code = nativeString(envelope.Code) ?? `http_${response.status}`;
            const message = nativeString(envelope.Message) ?? code;
            const error = new WechatIpadApiError(`wechat-ipad API rejected the request: ${message}`, response.status, code, payload);
            if (isWechatIpadSessionInvalidError(error)) {
                try {
                    this.#onSessionInvalid?.(error);
                }
                catch {
                    // Session-state reporting must never replace the original protocol error.
                }
            }
            throw error;
        }
        return envelope;
    }
}
/** Matches terminal authentication/session responses without treating ordinary API failures as logout. */
export function isWechatIpadSessionInvalidError(error) {
    if (!(error instanceof WechatIpadApiError))
        return false;
    const response = isRecord(error.response) ? error.response : undefined;
    const message = [
        error.message,
        error.code,
        nativeString(response?.Message),
        nativeString(response?.message),
    ].filter((value) => Boolean(value)).join(" ").normalize("NFKC").toLocaleLowerCase();
    // The upstream service also returns “用户可能退出” for individual
    // management-route failures while heartbeat, callbacks and messaging remain
    // healthy. “可能” is not terminal session evidence; live health and message
    // activity must remain authoritative in that case.
    return /用户已退出|账号已退出|未登录|登录已失效|登录失效|会话已失效|会话失效|session\s*(?:is\s*)?(?:expired|invalid)|not[ _-]?logged[ _-]?in|login[ _-]?(?:expired|invalid)|invalid[ _-]?session/u.test(message);
}
/** Create a callback/spool ChannelPlugin for the raw iPad protocol service. */
export function createWechatIpadChannel(options) {
    const controller = new WechatIpadController(options);
    return defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: controller.pluginId,
        displayName: options.displayName ?? "WeChat iPad",
        features: controller.features,
        capabilities: [provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, ({ asset }) => controller.resolveMedia(asset))],
        client: controller.client,
        start: (context) => controller.start(context),
        send: (action) => controller.send(action),
        stop: () => controller.stop(),
        callbackAddress: () => controller.callbackAddress(),
        registerCallback: () => controller.registerCallback(),
    });
}
/** Convert one iPad AddMsgs item. Unsupported/system/self messages return null. */
export function normalizeWechatIpadMessage(message, options) {
    const nativeType = nativeString(message.MsgType);
    const msgId = nativeString(message.MsgId);
    const newMsgId = nativeString(message.NewMsgId);
    const nativeMessageId = newMsgId || msgId;
    if (!nativeType || !nativeMessageId || nativeType === "51")
        return null;
    const from = nativeString(message.FromUserName);
    const to = nativeString(message.ToUserName);
    const rawContent = nativeString(message.Content) ?? "";
    if (!from || !to)
        return null;
    // Different iPad protocol builds report pat XML as 10000 or 10002. The XML is authoritative.
    const pat = parsePatInteraction(rawContent);
    const systemEvent = (nativeType === "10000" || nativeType === "10002") && !pat
        ? parseWechatSystemEvent(rawContent, endsWithChatroom(from) ?? endsWithChatroom(to))
        : undefined;
    if ((nativeType === "10000" || nativeType === "10002") && !pat && !systemEvent)
        return null;
    const roomId = pat?.chatroomId ?? systemEvent?.roomId ?? endsWithChatroom(from) ?? endsWithChatroom(to);
    const isGroup = roomId !== undefined;
    const prefix = isGroup ? splitGroupPrefix(rawContent) : undefined;
    const content = prefix?.body ?? rawContent;
    const nativeSender = pat?.senderId ?? systemEvent?.senderId ?? (isGroup ? prefix?.sender : from);
    if (!nativeSender || nativeSender === options.accountWxid || (!isGroup && from === options.accountWxid))
        return null;
    if (options.isBotSender?.(nativeSender))
        return null;
    const nativeConversation = roomId ?? nativeSender;
    const accountPrefix = options.accountId?.trim() ? `${options.accountId.trim()}:` : "";
    const msgSource = nativeString(message.MsgSource) ?? "";
    const mentions = parseMentions(msgSource, accountPrefix);
    const metadata = {
        channel: "wechat-ipad",
        nativeType,
        ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    };
    if (pat) {
        metadata.interaction = "pat";
        metadata.interactionSenderId = accountPrefix + pat.senderId;
        metadata.interactionTargetId = accountPrefix + pat.targetId;
        metadata.interactionTargetIsBot = pat.targetId === options.accountWxid;
        if (pat.template)
            metadata.interactionTemplate = pat.template;
    }
    if (systemEvent) {
        metadata.interaction = "system-event";
        metadata.systemEventKind = systemEvent.kind;
        metadata.passiveContext = true;
        if (systemEvent.referenceMessageId)
            metadata.referenceMessageId = `${accountPrefix}ipadmsg:${systemEvent.referenceMessageId}`;
        if (systemEvent.memberIds.length > 0)
            metadata.systemEventMemberIds = systemEvent.memberIds.map((id) => accountPrefix + id);
        if (systemEvent.memberNames.length > 0)
            metadata.systemEventMemberNames = systemEvent.memberNames;
    }
    const base = {
        type: "message",
        id: `${accountPrefix}ipadmsg:${nativeMessageId}`,
        conversation: { id: accountPrefix + nativeConversation, kind: isGroup ? "group" : "direct" },
        sender: { id: accountPrefix + nativeSender, displayName: systemEvent ? "微信系统" : nativeSender },
        timestamp: timestampMilliseconds(message.CreateTime),
        ...(mentions.length > 0 ? { mentions } : {}),
        metadata,
    };
    if (pat) {
        const text = pat.template?.trim() || `${nativeSender} 拍了拍 ${pat.targetId}`;
        return { ...base, text, parts: [{ type: "text", text }] };
    }
    if (systemEvent) {
        return { ...base, text: systemEvent.text, parts: [{ type: "text", text: systemEvent.text }] };
    }
    switch (nativeType) {
        case "10000": {
            return null;
        }
        case "1": {
            const text = content.trim();
            return text ? { ...base, text, parts: [{ type: "text", text }] } : null;
        }
        case "3":
        case "47": {
            const media = imageMetadata(message, content, nativeType, from, to);
            return mediaEvent(base, "image", platformAsset(nativeMessageId, options.pluginId, media), content, "微信图片");
        }
        case "34": {
            const media = voiceMetadata(message, content, nativeType, from, to);
            return mediaEvent(base, "voice", platformAsset(nativeMessageId, options.pluginId, media), content);
        }
        case "37":
            return normalizeFriendRequest(base, content);
        case "42":
            return normalizeContactCard(base, content);
        case "43":
        case "62": {
            const media = videoMetadata(message, content, nativeType, from, to);
            return mediaEvent(base, "video", platformAsset(nativeMessageId, options.pluginId, media), content);
        }
        case "48":
            return normalizeLocation(base, content);
        case "49":
            return normalizeAppMessage(base, message, content, nativeMessageId, options.pluginId, accountPrefix, from, to);
        default: {
            const text = content.trim();
            return text ? { ...base, text, parts: [{ type: "text", text }], metadata: { ...metadata, unsupportedNativeType: true } } : null;
        }
    }
}
export function parseWechatIpadSyncEnvelope(body) {
    const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
    let value;
    try {
        value = JSON.parse(preserveLargeIntegerFields(text));
    }
    catch {
        throw new Error("Invalid wechat-ipad callback JSON");
    }
    if (!isRecord(value))
        throw new Error("wechat-ipad callback must be an object");
    return value;
}
export function wechatIpadCallbackMessages(envelope) {
    if (!isRecord(envelope.Data))
        return [];
    const messages = envelope.Data.AddMsgs;
    if (!Array.isArray(messages))
        return [];
    return messages.filter(isRecord);
}
/** Extracts group-directory changes carried beside AddMsgs in an iPad sync callback. */
export function wechatIpadCallbackGroupContactChanges(envelope) {
    if (!isRecord(envelope.Data))
        return [];
    const changes = new Map();
    const collect = (value, kind) => {
        if (!Array.isArray(value))
            return;
        for (const contact of value) {
            if (!isRecord(contact))
                continue;
            const roomId = nativeString(contact.UserName)?.normalize("NFKC").trim().toLocaleLowerCase();
            if (!roomId?.endsWith("@chatroom"))
                continue;
            const previous = changes.get(roomId);
            if (!previous || kind === "deleted")
                changes.set(roomId, { roomId, kind });
        }
    };
    collect(envelope.Data.ModContacts, "modified");
    collect(envelope.Data.DelContacts, "deleted");
    return [...changes.values()];
}
export function isWechatIpadCallbackSourceAllowed(remoteAddress, rules) {
    if (!remoteAddress || rules.length === 0)
        return false;
    const normalized = normalizeIp(remoteAddress);
    return rules.some((rule) => ipRuleMatches(normalized, rule.trim()));
}
class WechatIpadController {
    pluginId;
    client;
    features;
    #callback;
    #stateDirectory;
    #inboxDirectory;
    #processedDirectory;
    #failedDirectory;
    #sentDirectory;
    #accountId;
    #isBotSender;
    #resolveGroupMemberName;
    #onGroupContactChanged;
    #onSessionActivity;
    #ingestRetryMs;
    #outboundMediaResolver;
    #onError;
    #fetch;
    #context;
    #server;
    #running = false;
    #draining;
    #retryTimer;
    #registerTimer;
    #sendTail = Promise.resolve();
    #acceptEventsAfterMs = 0;
    constructor(options) {
        this.pluginId = options.pluginId?.trim() || "wechat-ipad";
        this.client = new WechatIpadApiClient(options.api);
        const allowedSourceIps = options.callback.allowedSourceIps ?? ["127.0.0.1", "::1"];
        if (allowedSourceIps.length === 0)
            throw new Error("wechat-ipad callback source allowlist cannot be empty");
        for (const rule of allowedSourceIps)
            assertIpRule(rule);
        const routerBaseUrl = options.callback.routerBaseUrl
            ? normalizedHttpUrl(options.callback.routerBaseUrl).toString().replace(/\/$/, "")
            : undefined;
        const advertiseHost = options.callback.advertiseHost?.trim() || undefined;
        if (advertiseHost && !/^[a-zA-Z0-9._:-]+$/.test(advertiseHost))
            throw new Error("wechat-ipad advertiseHost is invalid");
        if (options.callback.autoRegister && (!routerBaseUrl || !advertiseHost)) {
            throw new Error("wechat-ipad autoRegister requires routerBaseUrl and advertiseHost");
        }
        this.#callback = {
            host: options.callback.host ?? "127.0.0.1",
            port: nonNegativeInteger(options.callback.port, "callback port"),
            pathPrefix: normalizedPathPrefix(options.callback.pathPrefix ?? DEFAULT_CALLBACK_PATH_PREFIX),
            allowedSourceIps,
            maxBodyBytes: positiveInteger(options.callback.maxBodyBytes ?? DEFAULT_BODY_LIMIT, "callback maxBodyBytes"),
            autoRegister: options.callback.autoRegister ?? false,
            registerIntervalMs: positiveInteger(options.callback.registerIntervalMs ?? DEFAULT_REGISTER_INTERVAL_MS, "callback registerIntervalMs"),
            ...(routerBaseUrl ? { routerBaseUrl } : {}),
            ...(advertiseHost ? { advertiseHost } : {}),
        };
        this.#stateDirectory = resolve(options.stateDirectory ?? join("data", "channels", safeFileName(this.pluginId)));
        this.#inboxDirectory = join(this.#stateDirectory, "inbox");
        this.#processedDirectory = join(this.#stateDirectory, "processed");
        this.#failedDirectory = join(this.#stateDirectory, "failed");
        this.#sentDirectory = join(this.#stateDirectory, "sent");
        this.#accountId = options.accountId?.trim() || undefined;
        this.#isBotSender = options.isBotSender;
        this.#resolveGroupMemberName = options.resolveGroupMemberName;
        this.#onGroupContactChanged = options.onGroupContactChanged;
        this.#onSessionActivity = options.onSessionActivity;
        this.#ingestRetryMs = positiveInteger(options.ingestRetryMs ?? DEFAULT_INGEST_RETRY_MS, "ingestRetryMs");
        this.#outboundMediaResolver = options.outboundMediaResolver;
        this.#onError = options.onError;
        this.#fetch = options.api.fetch ?? globalThis.fetch.bind(globalThis);
        this.features = [
            CHANNEL_FEATURE_RECEIVE_IMAGE,
            CHANNEL_FEATURE_RECEIVE_VOICE,
            CHANNEL_FEATURE_RECEIVE_VIDEO,
            CHANNEL_FEATURE_RECEIVE_FILE,
            CHANNEL_FEATURE_SEND_MENTION,
            ...(this.#outboundMediaResolver
                ? [
                    CHANNEL_FEATURE_SEND_IMAGE,
                    CHANNEL_FEATURE_SEND_AUDIO,
                    CHANNEL_FEATURE_SEND_VOICE,
                    CHANNEL_FEATURE_SEND_VIDEO,
                    CHANNEL_FEATURE_SEND_FILE,
                ]
                : []),
        ];
    }
    async start(context) {
        if (this.#running)
            return;
        await Promise.all([
            mkdir(this.#inboxDirectory, { recursive: true }),
            mkdir(this.#processedDirectory, { recursive: true }),
            mkdir(this.#failedDirectory, { recursive: true }),
            mkdir(this.#sentDirectory, { recursive: true }),
        ]);
        // iPad sync envelopes are cumulative and may contain hours of messages that
        // predate this process. A restart must never turn unseen historical @mentions
        // or management commands into fresh replies. Keep a short grace window for
        // messages that arrived while the service itself was restarting.
        this.#acceptEventsAfterMs = Date.now() - DEFAULT_STARTUP_REPLAY_GRACE_MS;
        this.#context = context;
        this.#running = true;
        const server = createServer((request, response) => {
            void this.#handleCallback(request, response).catch((error) => {
                this.#report(error, { phase: "callback" });
                if (!response.headersSent) {
                    if (error instanceof HttpInputError)
                        replyJson(response, error.status, { code: error.status, data: null, message: error.code });
                    else
                        replyJson(response, 500, { code: 500, data: null, message: "internal_error" });
                }
                else
                    response.destroy();
            });
        });
        server.requestTimeout = 10_000;
        server.headersTimeout = 10_000;
        this.#server = server;
        try {
            await listen(server, this.#callback.port, this.#callback.host);
            if (this.#callback.autoRegister) {
                await this.registerCallback();
                this.#registerTimer = setInterval(() => {
                    void this.registerCallback().catch((error) => this.#report(error, { phase: "register" }));
                }, this.#callback.registerIntervalMs);
                this.#registerTimer.unref();
            }
        }
        catch (error) {
            this.#server = undefined;
            this.#running = false;
            this.#context = undefined;
            await close(server).catch(() => undefined);
            throw error;
        }
        this.#kickDrain();
    }
    send(action) {
        const operation = this.#sendTail.then(() => this.#sendAction(action));
        this.#sendTail = operation.catch(() => undefined);
        return operation;
    }
    async stop() {
        if (!this.#running)
            return;
        this.#running = false;
        if (this.#retryTimer)
            clearTimeout(this.#retryTimer);
        if (this.#registerTimer)
            clearInterval(this.#registerTimer);
        this.#retryTimer = undefined;
        this.#registerTimer = undefined;
        const server = this.#server;
        this.#server = undefined;
        if (server)
            await close(server);
        if (this.#draining)
            await this.#draining;
        await this.#sendTail;
        this.#context = undefined;
    }
    callbackAddress() {
        const address = this.#server?.address();
        if (!address || typeof address === "string")
            return undefined;
        return {
            host: this.#callback.host,
            port: address.port,
            path: callbackPath(this.#callback.pathPrefix, this.client.accountWxid),
        };
    }
    async registerCallback() {
        const address = this.callbackAddress();
        if (!address)
            throw new Error("wechat-ipad callback listener is not ready");
        if (!this.#callback.routerBaseUrl || !this.#callback.advertiseHost) {
            throw new Error("wechat-ipad callback router registration is not configured");
        }
        const clientHost = `${this.#callback.advertiseHost}:${address.port}`;
        let response;
        try {
            response = await this.#fetch(new URL("/register", this.#callback.routerBaseUrl), {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({ wxid: this.client.accountWxid, client_host: clientHost }),
                signal: AbortSignal.timeout(10_000),
            });
        }
        catch (error) {
            throw new Error(`wechat-ipad callback registration failed: ${errorMessage(error)}`);
        }
        const payload = await response.json().catch(() => undefined);
        if (!response.ok || !isRecord(payload) || payload.success !== true) {
            throw new Error(`wechat-ipad callback router rejected registration (HTTP ${response.status})`);
        }
        return { accountWxid: this.client.accountWxid, clientHost };
    }
    async resolveMedia(asset) {
        if (asset.source !== "platform" || asset.ownerPluginId !== this.pluginId) {
            throw new Error("wechat-ipad can resolve only platform assets owned by this channel");
        }
        const metadata = parseNativeMediaMetadata(asset.metadata);
        let media;
        switch (metadata.nativeType) {
            case "3":
                media = await this.client.downloadImage(requiredText(metadata.fileAesKey, "image AES key"), requiredText(metadata.fileNo, "image CDN file number"));
                break;
            case "47":
                media = await this.#downloadWechatCdnImage(requiredText(metadata.fileNo, "emoji CDN URL"));
                break;
            case "34":
                media = metadata.inlineDataBase64
                    ? decodedProtocolMedia(metadata.inlineDataBase64, [], "audio/silk")
                    : await this.client.downloadVoice(metadata);
                break;
            case "43":
            case "62":
                media = await this.client.downloadVideo(metadata);
                break;
            case "49":
                media = await this.client.downloadFile(metadata);
                break;
            default:
                throw new Error(`wechat-ipad cannot resolve native media type ${metadata.nativeType}`);
        }
        const sha256 = createHash("sha256").update(media.data).digest("hex");
        return {
            asset: { ...asset, mimeType: media.mimeType, size: media.data.byteLength, sha256 },
            content: singleChunk(media.data),
        };
    }
    async #downloadWechatCdnImage(locator) {
        const url = trustedWechatCdnUrl(locator);
        const response = await this.#fetch(url, {
            method: "GET",
            headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5" },
            redirect: "follow",
            signal: AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS),
        });
        if (!response.ok)
            throw new Error(`wechat-ipad CDN image download failed (HTTP ${response.status})`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
            throw new Error("wechat-ipad CDN image exceeds the media byte limit");
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
            throw new Error("wechat-ipad CDN image size is invalid");
        }
        const mimeType = sniffMimeType(data);
        if (!mimeType?.startsWith("image/"))
            throw new Error("wechat-ipad CDN response is not a supported image");
        return { data, mimeType };
    }
    async #sendAction(action) {
        try {
            const operations = outboundOperations(action);
            const digest = sha256(JSON.stringify(operations));
            const journalPath = join(this.#sentDirectory, `${sha256(action.id)}.json`);
            const existing = await readJsonIfExists(journalPath);
            if (existing && (existing.actionId !== action.id || existing.digest !== digest)) {
                throw new Error(`wechat-ipad outbound action id collision: ${action.id}`);
            }
            if (existing?.done === true)
                return;
            let completed = numberValue(existing?.completed) ?? 0;
            const resumedFrom = completed;
            await atomicReplaceJson(journalPath, { actionId: action.id, digest, completed, done: false });
            for (let index = completed; index < operations.length; index += 1) {
                const operation = operations[index];
                // Pace follow-up bubbles like a person typing; the first operation of a
                // fresh action goes out immediately.
                if (index > resumedFrom && operation.kind === "text") {
                    await sleep(outboundPacingDelayMs(operation.content));
                }
                await this.#executeOutbound(action.conversationId, operation);
                completed = index + 1;
                await atomicReplaceJson(journalPath, {
                    actionId: action.id,
                    digest,
                    completed,
                    done: completed === operations.length,
                });
            }
        }
        catch (error) {
            this.#report(error, { phase: "send", actionId: action.id });
            throw error;
        }
    }
    async #executeOutbound(conversationId, operation) {
        const target = stripAccountPrefix(conversationId, this.#accountId);
        if (operation.kind === "text") {
            if (operation.quote) {
                try {
                    await this.client.sendReferText(target, operation.content, operation.quote);
                    return;
                }
                catch (error) {
                    // The reply must still land even on protocol builds without SendApp
                    // quote support; degrade to plain text.
                    this.#report(error, { phase: "send-quote" });
                }
            }
            await this.client.sendText(target, operation.content, operation.at.map((id) => stripAccountPrefix(id, this.#accountId)));
            return;
        }
        if (operation.part.type === "image" && operation.part.asset.metadata?.kind === "emoji") {
            const nativeEmoji = wechatEmojiSendReference(operation.part.asset);
            if (nativeEmoji) {
                await this.client.sendEmojiReference(target, nativeEmoji.md5, nativeEmoji.totalLen);
                return;
            }
        }
        const metadata = operation.part.asset.source === "platform"
            ? parseNativeMediaMetadata(operation.part.asset.metadata)
            : undefined;
        if (metadata?.nativeContent &&
            operation.part.asset.ownerPluginId === this.pluginId &&
            (operation.part.type === "image" || operation.part.type === "video" || operation.part.type === "file")) {
            await this.client.forwardMedia(target, metadata.nativeType, metadata.nativeContent);
            return;
        }
        if (!this.#outboundMediaResolver)
            throw new Error("wechat-ipad outbound media resolver is not configured");
        const resolved = await this.#outboundMediaResolver.resolve(operation.part.asset);
        const bytes = await collectMedia(resolved.content, MAX_MEDIA_BYTES);
        switch (operation.part.type) {
            case "image":
                if (operation.part.asset.metadata?.kind === "emoji")
                    await this.client.sendEmoji(target, bytes);
                else
                    await this.client.sendImage(target, bytes);
                return;
            case "audio":
            case "voice":
                await this.client.sendVoice(target, bytes, resolved.asset.mimeType, operation.part.durationMs);
                return;
            case "video":
                await this.client.sendVideo(target, bytes, operation.part.durationMs);
                return;
            case "file":
                await this.client.sendFile(target, bytes, operation.part.name ?? resolved.asset.name, resolved.asset.mimeType);
                return;
            default:
                return assertNever(operation.part);
        }
    }
    async #handleCallback(request, response) {
        const url = new URL(request.url ?? "/", "http://wechat-ipad.local");
        const expectedPath = callbackPath(this.#callback.pathPrefix, this.client.accountWxid);
        if (request.method === "GET" && url.pathname === expectedPath) {
            replyJson(response, 200, { code: 200, data: { service: this.pluginId }, message: "" });
            return;
        }
        if (request.method !== "POST" || url.pathname !== expectedPath) {
            replyJson(response, 404, { code: 404, data: null, message: "not_found" });
            return;
        }
        if (!this.#running) {
            replyJson(response, 503, { code: 503, data: null, message: "channel_stopped" });
            return;
        }
        if (!isWechatIpadCallbackSourceAllowed(request.socket.remoteAddress, this.#callback.allowedSourceIps)) {
            throw new HttpInputError(403, "source_not_allowed");
        }
        const contentLength = numberHeader(request, "content-length");
        if (contentLength !== undefined && contentLength > this.#callback.maxBodyBytes) {
            throw new HttpInputError(413, "body_too_large");
        }
        const body = await readRequestBody(request, this.#callback.maxBodyBytes);
        // The native iPad service occasionally POSTs a zero-byte sync heartbeat.
        // Acknowledge it without creating a spool entry; non-empty malformed
        // payloads still go through strict envelope validation below.
        if (body.byteLength === 0) {
            replyJson(response, 200, { code: 200, data: null, message: "" });
            return;
        }
        parseWechatIpadSyncEnvelope(body);
        const deliveryId = sha256(body);
        const file = `${deliveryId}.json`;
        const processedPath = join(this.#processedDirectory, file);
        const inboxPath = join(this.#inboxDirectory, file);
        const duplicate = await exists(processedPath) || await exists(inboxPath);
        if (!duplicate)
            await atomicCreateBuffer(inboxPath, body);
        replyJson(response, 200, { code: 200, data: null, message: "" });
        if (!duplicate)
            this.#kickDrain();
    }
    #kickDrain() {
        if (!this.#running || this.#draining)
            return;
        this.#draining = this.#drainInbox().finally(() => {
            this.#draining = undefined;
        });
    }
    async #drainInbox() {
        let retry = false;
        try {
            // Sync callbacks can be cumulative. Prefer the newest envelope so a large
            // historical backlog cannot delay today's mentions behind old snapshots.
            const files = (await orderSpoolFiles(this.#inboxDirectory, (await readdir(this.#inboxDirectory)).filter((file) => /^[a-f\d]{64}\.json$/.test(file)))).reverse();
            for (const file of files) {
                if (!this.#running || !this.#context)
                    break;
                const path = join(this.#inboxDirectory, file);
                let envelope;
                try {
                    envelope = parseWechatIpadSyncEnvelope(await readFile(path));
                }
                catch (error) {
                    this.#report(error, { phase: "spool" });
                    await rename(path, join(this.#failedDirectory, `${Date.now()}-${file}`));
                    continue;
                }
                const deliveryId = file.slice(0, -5);
                try {
                    const messages = wechatIpadCallbackMessages(envelope);
                    for (const message of messages) {
                        let event = normalizeWechatIpadMessage(message, {
                            pluginId: this.pluginId,
                            accountWxid: this.client.accountWxid,
                            deliveryId,
                            ...(this.#accountId ? { accountId: this.#accountId } : {}),
                            ...(this.#isBotSender ? { isBotSender: this.#isBotSender } : {}),
                        });
                        if (event?.timestamp !== undefined && event.timestamp < this.#acceptEventsAfterMs)
                            continue;
                        if (event) {
                            try {
                                this.#onSessionActivity?.(Date.now());
                            }
                            catch {
                                // Positive session reporting must never block message ingestion.
                            }
                        }
                        if (event && this.#context.hasSeenEvent?.(event.id))
                            continue;
                        if (event && event.conversation.kind === "group" && event.metadata?.interaction !== "system-event" && this.#resolveGroupMemberName) {
                            event = await enrichSenderDisplayName(event, this.#accountId, this.#resolveGroupMemberName);
                        }
                        if (event) {
                            try {
                                await this.#context.ingest(event);
                            }
                            catch (error) {
                                // Core persists inbound state before model generation. Retrying an
                                // already-seen event cannot recreate the failed reply and used to
                                // stall every later message in this ordered spool for retryMs.
                                // Continue only when persistence is confirmed; pre-store failures
                                // still retry the envelope normally.
                                if (!this.#context.hasSeenEvent?.(event.id))
                                    throw error;
                                this.#report(error, { phase: "ingest", deliveryId });
                            }
                        }
                    }
                    const groupChanges = wechatIpadCallbackGroupContactChanges(envelope);
                    for (const change of groupChanges) {
                        if (!this.#onGroupContactChanged)
                            continue;
                        try {
                            await this.#onGroupContactChanged(change.roomId, change.kind);
                        }
                        catch (error) {
                            // Directory enrichment must never stall or replay ordinary messages.
                            this.#report(error, { phase: "contact-change", deliveryId });
                        }
                    }
                    await atomicCreateJson(join(this.#processedDirectory, file), {
                        deliveryId,
                        messageCount: messages.length,
                        groupChangeCount: groupChanges.length,
                        processedAt: Date.now(),
                    });
                    await unlink(path);
                }
                catch (error) {
                    retry = true;
                    this.#report(error, { phase: "ingest", deliveryId });
                    break;
                }
            }
        }
        finally {
            if (retry && this.#running && !this.#retryTimer) {
                this.#retryTimer = setTimeout(() => {
                    this.#retryTimer = undefined;
                    this.#kickDrain();
                }, this.#ingestRetryMs);
                this.#retryTimer.unref();
            }
        }
    }
    #report(error, context) {
        this.#onError?.(error, context);
    }
}
function outboundOperations(action) {
    const operations = [];
    let text = [];
    let at = [];
    let quote;
    const flushText = () => {
        const content = text.join("\n").replaceAll("\t", "    ").trim();
        if (content) {
            const mentions = [...new Set(at)];
            // Native quote replies cannot carry an at-list; an explicit @ already
            // anchors the reply, so mentions win when both decorations are present.
            const applied = mentions.length === 0 ? quote : undefined;
            const segments = splitOutboundText(content);
            segments.forEach((segment, index) => {
                operations.push({
                    kind: "text",
                    content: segment,
                    at: index === 0 ? mentions : [],
                    ...(index === 0 && applied ? { quote: applied } : {}),
                });
            });
            if (applied || mentions.length > 0)
                quote = undefined;
        }
        text = [];
        at = [];
    };
    const parts = action.parts?.length ? action.parts : [{ type: "text", text: action.text }];
    for (const part of parts) {
        switch (part.type) {
            case "text":
                text.push(part.text);
                break;
            case "link":
                text.push(part.title ? `${part.title}\n${part.url}` : part.url);
                break;
            case "mention":
                text.push(`@${part.displayName ?? part.memberId}`);
                at.push(part.memberId);
                break;
            case "quote": {
                const svrid = nativeQuoteSvrid(part.messageId);
                if (svrid && part.senderId) {
                    quote = {
                        svrid,
                        chatusr: part.senderId.split(":").at(-1) || part.senderId,
                        displayname: part.senderName ?? "",
                        excerpt: part.excerpt ?? "",
                    };
                }
                break;
            }
            case "image":
            case "audio":
            case "voice":
            case "video":
            case "file":
                flushText();
                operations.push({ kind: "media", part });
                break;
            default:
                assertNever(part);
        }
    }
    flushText();
    if (operations.length === 0 && action.text.trim()) {
        operations.push({ kind: "text", content: action.text.replaceAll("\t", "    ").trim(), at: [] });
    }
    if (operations.length === 0)
        throw new Error("wechat-ipad outbound action has no sendable content");
    return operations;
}
/** Extracts the native message id from a `<account>:ipadmsg:<svrid>` event id. */
function nativeQuoteSvrid(messageId) {
    const marker = messageId.lastIndexOf("ipadmsg:");
    if (marker < 0)
        return undefined;
    const svrid = messageId.slice(marker + "ipadmsg:".length).trim();
    return /^\d{1,25}$/.test(svrid) ? svrid : undefined;
}
/**
 * Splits a long reply into a few chat-sized bubbles at paragraph and sentence
 * boundaries. One giant zero-delay wall of text is the clearest bot tell in a
 * group; a couple of naturally paced messages reads like a person typing.
 */
export function splitOutboundText(content) {
    const MAX_SEGMENTS = 4;
    const SEGMENT_TARGET = 220;
    if ([...content].length <= 120)
        return [content];
    const paragraphs = content.split(/\n{2,}/u).map((value) => value.trim()).filter(Boolean);
    const segments = [];
    for (const paragraph of paragraphs) {
        if ([...paragraph].length <= SEGMENT_TARGET) {
            segments.push(paragraph);
            continue;
        }
        let current = "";
        for (const sentence of paragraph.split(/(?<=[。！？!?；;])\s*/u)) {
            if (!sentence)
                continue;
            if (current && [...current].length + [...sentence].length > SEGMENT_TARGET) {
                segments.push(current);
                current = sentence;
                continue;
            }
            current = current ? current + sentence : sentence;
        }
        if (current)
            segments.push(current);
    }
    // Fold fragments that are too short to stand alone into their predecessor.
    const merged = [];
    for (const segment of segments) {
        if (merged.length > 0 && [...segment].length < 15) {
            merged[merged.length - 1] = `${merged[merged.length - 1]}\n${segment}`;
            continue;
        }
        merged.push(segment);
    }
    if (merged.length > MAX_SEGMENTS) {
        merged[MAX_SEGMENTS - 1] = merged.slice(MAX_SEGMENTS - 1).join("\n\n");
        merged.length = MAX_SEGMENTS;
    }
    return merged.length > 0 ? merged : [content];
}
/** Human-feeling delay before a follow-up bubble, proportional to its length. */
export function outboundPacingDelayMs(content) {
    return Math.min(600 + [...content].length * 35, 4_000);
}
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function normalizeFriendRequest(base, xml) {
    const nickname = xmlAttribute(xml, "fromnickname")?.trim() || "微信用户";
    const greeting = xmlAttribute(xml, "content")?.trim();
    const username = xmlAttribute(xml, "fromusername")?.trim();
    const text = `[好友申请] ${nickname}${greeting ? `：${greeting}` : ""}`;
    return {
        ...base,
        text,
        parts: [{ type: "text", text }],
        metadata: {
            ...base.metadata,
            interaction: "friend-request",
            passiveContext: true,
            ...(username ? { requestedFriendId: username } : {}),
            ...(xmlAttribute(xml, "ticket") ? { friendRequestTicket: xmlAttribute(xml, "ticket") } : {}),
        },
    };
}
function normalizeContactCard(base, xml) {
    const nickname = xmlAttribute(xml, "nickname")?.trim();
    const alias = xmlAttribute(xml, "alias")?.trim();
    const username = xmlAttribute(xml, "username")?.trim();
    if (!nickname && !alias && !username)
        return null;
    const identity = alias || username;
    const text = `[微信名片] ${nickname || identity || "未命名联系人"}${identity ? `（微信号：${identity}）` : ""}`;
    return {
        ...base,
        text,
        parts: [{ type: "text", text }],
        metadata: {
            ...base.metadata,
            interaction: "contact-card",
            ...(nickname ? { contactCardNickname: nickname } : {}),
            ...(alias ? { contactCardAlias: alias } : {}),
            ...(username ? { contactCardUsername: username } : {}),
            ...(xmlAttribute(xml, "province") ? { contactCardProvince: xmlAttribute(xml, "province") } : {}),
            ...(xmlAttribute(xml, "city") ? { contactCardCity: xmlAttribute(xml, "city") } : {}),
        },
    };
}
function normalizeLocation(base, xml) {
    const latitudeText = xmlAttribute(xml, "x")?.trim();
    const longitudeText = xmlAttribute(xml, "y")?.trim();
    const latitude = latitudeText === undefined ? undefined : Number(latitudeText);
    const longitude = longitudeText === undefined ? undefined : Number(longitudeText);
    const label = xmlAttribute(xml, "label")?.trim();
    const poiName = xmlAttribute(xml, "poiname")?.trim();
    if (!label && !poiName && (!Number.isFinite(latitude) || !Number.isFinite(longitude)))
        return null;
    const place = poiName || label || "共享位置";
    const detail = label && label !== place ? `，${label}` : "";
    const coordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? `（${latitude.toFixed(6)}, ${longitude.toFixed(6)}）`
        : "";
    const text = `[位置] ${place}${detail}${coordinates}`;
    const mapUrl = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? `https://uri.amap.com/marker?position=${longitude},${latitude}&name=${encodeURIComponent(place)}`
        : undefined;
    return {
        ...base,
        text,
        parts: [
            { type: "text", text },
            ...(mapUrl ? [{ type: "link", url: mapUrl, title: place }] : []),
        ],
        metadata: {
            ...base.metadata,
            interaction: "location",
            ...(Number.isFinite(latitude) ? { latitude } : {}),
            ...(Number.isFinite(longitude) ? { longitude } : {}),
            ...(label ? { locationLabel: label } : {}),
            ...(poiName ? { locationPoiName: poiName } : {}),
        },
    };
}
function normalizeAppMessage(base, message, xml, nativeMessageId, pluginId, accountPrefix, from, to) {
    const appType = xmlTagText(xml, "type")?.trim();
    const title = xmlTagText(xml, "title")?.trim() ?? "";
    const redEnvelope = parseRedEnvelopeMetadata(xml, appType);
    if (redEnvelope) {
        return {
            ...base,
            text: title || (redEnvelope.redEnvelopeKind === "gift" ? "[微信礼物]" : "[微信红包]"),
            parts: title ? [{ type: "text", text: title }] : [],
            metadata: { ...base.metadata, ...redEnvelope },
        };
    }
    if (appType === "57") {
        const quotedId = xmlTagText(xml, "svrid");
        const quotedSender = xmlTagText(xml, "chatusr");
        const replyText = title || xmlTagText(xml, "content")?.trim() || "";
        const parts = [];
        if (replyText)
            parts.push({ type: "text", text: replyText });
        if (quotedId) {
            parts.push({
                type: "quote",
                messageId: `${accountPrefix}ipadmsg:${quotedId}`,
                ...(quotedSender ? { senderId: accountPrefix + quotedSender } : {}),
            });
        }
        if (!replyText && !quotedId)
            return null;
        return {
            ...base,
            text: replyText || "[引用消息]",
            parts,
            ...(quotedId
                ? {
                    replyTo: {
                        messageId: `${accountPrefix}ipadmsg:${quotedId}`,
                        ...(quotedSender ? { senderId: accountPrefix + quotedSender } : {}),
                    },
                }
                : {}),
        };
    }
    const url = xmlTagText(xml, "url");
    if (url && appType !== "6") {
        const description = xmlTagText(xml, "des")?.trim();
        return {
            ...base,
            text: title || url,
            parts: [{ type: "link", url, ...(title ? { title } : {}), ...(description ? { description } : {}) }],
        };
    }
    if (appType === "6" || xmlTagText(xml, "attachid")) {
        const fileExt = xmlTagText(xml, "fileext")?.trim();
        const name = title || (fileExt ? `微信附件.${fileExt}` : "微信附件");
        const metadata = compactRecord({
            nativeType: "49",
            msgId: nativeString(message.MsgId),
            newMsgId: nativeString(message.NewMsgId),
            fromUserName: from,
            toUserName: to,
            attachId: xmlTagText(xml, "attachid") ?? xmlTagText(xml, "cdnattachurl"),
            appId: xmlTagText(xml, "appid"),
            dataLen: positiveNumber(xmlTagText(xml, "totallen")),
            userName: from,
            nativeContent: xml,
        });
        return {
            ...base,
            text: "",
            parts: [{ type: "file", asset: platformAsset(nativeMessageId, pluginId, metadata), name }],
        };
    }
    return title ? { ...base, text: title, parts: [{ type: "text", text: title }] } : null;
}
function mediaEvent(base, type, asset, xml, alt) {
    const width = positiveXmlInteger(xml, "cdnthumbwidth");
    const height = positiveXmlInteger(xml, "cdnthumbheight");
    const durationMs = positiveXmlInteger(xml, type === "voice" ? "voicelength" : "playlength");
    let part;
    if (type === "image") {
        part = { type, asset, ...(alt ? { alt } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) };
    }
    else if (type === "video") {
        part = {
            type,
            asset,
            ...(durationMs ? { durationMs: durationMs * (durationMs < 1000 ? 1000 : 1) } : {}),
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
        };
    }
    else {
        part = { type, asset, ...(durationMs ? { durationMs } : {}) };
    }
    return { ...base, text: "", parts: [part] };
}
function imageMetadata(message, xml, nativeType, from, to) {
    return compactRecord({
        nativeType,
        msgId: nativeString(message.MsgId),
        newMsgId: nativeString(message.NewMsgId),
        fromUserName: from,
        toUserName: to,
        fileAesKey: xmlAttribute(xml, "aeskey") ?? xmlAttribute(xml, "cdnthumbaeskey"),
        fileNo: xmlAttribute(xml, "cdnmidimgurl") ?? xmlAttribute(xml, "cdnbigimgurl") ?? xmlAttribute(xml, "cdnurl") ?? xmlAttribute(xml, "cdnthumburl"),
        dataLen: positiveNumber(xmlAttribute(xml, "length")),
        nativeContent: xml,
    });
}
function voiceMetadata(message, xml, nativeType, from, to) {
    return compactRecord({
        nativeType,
        msgId: nativeString(message.MsgId),
        newMsgId: nativeString(message.NewMsgId),
        fromUserName: from,
        toUserName: to,
        bufId: xmlAttribute(xml, "bufid"),
        dataLen: positiveNumber(xmlAttribute(xml, "length")),
        inlineDataBase64: inlineVoiceDataBase64(message.ImgBuf),
        nativeContent: xml,
    });
}
function videoMetadata(message, xml, nativeType, from, to) {
    return compactRecord({
        nativeType,
        msgId: nativeString(message.MsgId),
        newMsgId: nativeString(message.NewMsgId),
        fromUserName: from,
        toUserName: to,
        dataLen: positiveNumber(xmlAttribute(xml, "length")),
        nativeContent: xml,
    });
}
function platformAsset(nativeMessageId, pluginId, metadata) {
    return {
        id: `wechat-ipad:${nativeMessageId}:${metadata.nativeType}`,
        source: "platform",
        locator: `message:${nativeMessageId}`,
        ownerPluginId: pluginId,
        metadata: compactRecord({ ...metadata }),
    };
}
function parseNativeMediaMetadata(value) {
    if (!value)
        throw new Error("wechat-ipad asset has no native metadata");
    const nativeType = nativeString(value.nativeType);
    if (!nativeType)
        throw new Error("wechat-ipad asset native type is missing");
    return {
        nativeType,
        ...(nativeString(value.msgId) ? { msgId: nativeString(value.msgId) } : {}),
        ...(nativeString(value.newMsgId) ? { newMsgId: nativeString(value.newMsgId) } : {}),
        ...(nativeString(value.fromUserName) ? { fromUserName: nativeString(value.fromUserName) } : {}),
        ...(nativeString(value.toUserName) ? { toUserName: nativeString(value.toUserName) } : {}),
        ...(nativeString(value.fileAesKey) ? { fileAesKey: nativeString(value.fileAesKey) } : {}),
        ...(nativeString(value.fileNo) ? { fileNo: nativeString(value.fileNo) } : {}),
        ...(nativeString(value.bufId) ? { bufId: nativeString(value.bufId) } : {}),
        ...(positiveNumber(value.dataLen) ? { dataLen: positiveNumber(value.dataLen) } : {}),
        ...(nativeString(value.attachId) ? { attachId: nativeString(value.attachId) } : {}),
        ...(nativeString(value.appId) ? { appId: nativeString(value.appId) } : {}),
        ...(nativeString(value.userName) ? { userName: nativeString(value.userName) } : {}),
        ...(nativeString(value.nativeContent) ? { nativeContent: nativeString(value.nativeContent) } : {}),
        ...(nativeString(value.inlineDataBase64) ? { inlineDataBase64: nativeString(value.inlineDataBase64) } : {}),
    };
}
function inlineVoiceDataBase64(value) {
    if (!isRecord(value))
        return undefined;
    const encoded = nativeString(value.buffer) ?? nativeString(value.Buffer);
    if (!encoded)
        return undefined;
    const normalized = encoded.replace(/^data:[^;,]+;base64,/iu, "").replace(/\s+/gu, "");
    if (normalized.length === 0 ||
        normalized.length > 48_000 ||
        normalized.length % 4 === 1 ||
        !/^[a-zA-Z\d+/]*={0,2}$/u.test(normalized))
        return undefined;
    const declaredLength = positiveNumber(value.iLen) ?? positiveNumber(value.length);
    const decodedLength = Buffer.from(normalized, "base64").byteLength;
    if (decodedLength === 0 || (declaredLength !== undefined && declaredLength !== decodedLength))
        return undefined;
    return normalized;
}
function decodedProtocolMedia(value, preferredKeys, fallbackMimeType) {
    const encoded = findBase64(value, preferredKeys);
    if (!encoded)
        throw new WechatIpadApiError("wechat-ipad media response contains no Base64 data", 200, "invalid_response", undefined);
    const normalized = encoded.replace(/^data:[^;,]+;base64,/i, "").replace(/\s+/g, "");
    if (!/^[a-zA-Z\d+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
        throw new WechatIpadApiError("wechat-ipad media response contains invalid Base64", 200, "invalid_response", undefined);
    }
    const data = Buffer.from(normalized, "base64");
    if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
        throw new WechatIpadApiError("wechat-ipad media response has an invalid size", 200, "invalid_response", undefined);
    }
    return { data, mimeType: sniffMimeType(data) ?? fallbackMimeType };
}
function findBase64(value, preferredKeys, depth = 0) {
    if (depth > 4)
        return undefined;
    if (typeof value === "string")
        return value;
    if (!isRecord(value))
        return undefined;
    for (const key of preferredKeys) {
        const direct = value[key];
        if (typeof direct === "string" && direct.trim())
            return direct;
    }
    for (const child of Object.values(value)) {
        const found = findBase64(child, preferredKeys, depth + 1);
        if (found)
            return found;
    }
    return undefined;
}
function sniffMimeType(data) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 16));
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
        return "image/jpeg";
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")
        return "image/gif";
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp")
        return "video/mp4";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF")
        return "audio/wav";
    if (bytes.subarray(0, 3).toString("ascii") === "ID3")
        return "audio/mpeg";
    return undefined;
}
function trustedWechatCdnUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("wechat-ipad emoji CDN URL is invalid");
    }
    const hostname = url.hostname.toLowerCase();
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        !(hostname === "qq.com" || hostname.endsWith(".qq.com") || hostname.endsWith(".qpic.cn"))) {
        throw new Error("wechat-ipad emoji CDN URL is not an approved WeChat host");
    }
    url.username = "";
    url.password = "";
    return url;
}
function parseMentions(xml, prefix) {
    const list = xmlTagText(xml, "atuserlist");
    if (!list)
        return [];
    return [...new Set(list.split(/[,;]/).map((item) => item.trim()).filter(Boolean))].map((id) => ({ id: prefix + id }));
}
function splitGroupPrefix(content) {
    const match = /^([^\r\n]{1,256}):\r?\n([\s\S]*)$/.exec(content);
    const sender = match?.[1]?.trim();
    return sender ? { sender, body: match[2] } : undefined;
}
function endsWithChatroom(value) {
    return value?.endsWith("@chatroom") ? value : undefined;
}
function xmlTagText(xml, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(xml);
    if (!match)
        return undefined;
    const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(match[1].trim());
    return decodeXmlEntities(cdata?.[1] ?? match[1]);
}
function parsePatInteraction(xml) {
    if (!/<sysmsg\b[^>]*\btype\s*=\s*["']pat["']|<pat>/iu.test(xml))
        return undefined;
    const senderId = xmlTagText(xml, "fromusername")?.trim();
    const targetId = xmlTagText(xml, "pattedusername")?.trim();
    if (!senderId || !targetId)
        return undefined;
    const chatroomId = xmlTagText(xml, "chatusername")?.trim();
    const template = xmlTagText(xml, "template")?.trim();
    return {
        senderId,
        targetId,
        ...(chatroomId?.endsWith("@chatroom") ? { chatroomId } : {}),
        ...(template ? { template } : {}),
    };
}
function parseWechatSystemEvent(rawContent, fallbackRoomId) {
    const prefixed = /^(\S+@chatroom):\r?\n([\s\S]*)$/u.exec(rawContent.trim());
    const xml = prefixed?.[2] ?? rawContent.trim();
    const session = xmlTagText(xml, "session")?.trim();
    const roomId = prefixed?.[1] ?? (session?.endsWith("@chatroom") ? session : fallbackRoomId);
    const memberIds = allXmlTagTexts(xml, "username").filter((id) => id && !id.endsWith("@chatroom"));
    const memberNames = systemEventMemberNames(xml);
    if (/<sysmsg\b[^>]*\btype\s*=\s*["']revokemsg["']/iu.test(xml) || /<revokemsg>/iu.test(xml)) {
        const replacement = xmlTagText(xml, "replacemsg")?.trim();
        const referenceMessageId = xmlTagText(xml, "newmsgid")?.trim();
        return {
            ...(roomId ? { roomId } : {}),
            senderId: "weixin",
            kind: "message-recalled",
            text: replacement || "[系统事件] 有人撤回了一条消息",
            memberIds,
            memberNames,
            ...(referenceMessageId ? { referenceMessageId } : {}),
        };
    }
    if (/<sysmsg\b[^>]*\btype\s*=\s*["']sysmsgtemplate["']/iu.test(xml) || /<sysmsgtemplate>/iu.test(xml)) {
        const template = xmlTagText(xml, "template")?.trim();
        const plain = xmlTagText(xml, "plain")?.trim();
        const rendered = renderWechatSystemTemplate(template || plain || "", memberNames);
        if (!rendered)
            return undefined;
        return {
            ...(roomId ? { roomId } : {}),
            senderId: "weixin",
            kind: classifyWechatSystemEvent(rendered),
            text: `[系统事件] ${rendered}`,
            memberIds,
            memberNames,
        };
    }
    if (/<sysmsg\b[^>]*\btype\s*=\s*["']mmchatroombarannouncememt["']/iu.test(xml)) {
        const announcement = xmlTagText(xml, "content")?.trim() || xmlTagText(xml, "datadesc")?.trim();
        if (!announcement)
            return undefined;
        const fromUser = xmlTagText(xml, "fromusr")?.trim();
        return {
            ...(roomId ? { roomId } : {}),
            senderId: "weixin",
            kind: "group-announcement-changed",
            text: `[群公告] ${announcement}`,
            memberIds: fromUser ? [...new Set([...memberIds, fromUser])] : memberIds,
            memberNames,
        };
    }
    if (/<sysmsg\b[^>]*\btype\s*=\s*["']roomtoolstips["']/iu.test(xml)) {
        const title = xmlTagText(xml, "title")?.trim() || xmlTagText(xml, "content")?.trim() || "群待办有更新";
        return {
            ...(roomId ? { roomId } : {}),
            senderId: "weixin",
            kind: "group-todo-changed",
            text: `[群待办] ${title}`,
            memberIds,
            memberNames,
        };
    }
    if (roomId && xml && !xml.includes("<")) {
        const text = xml.normalize("NFKC").replace(/\s+/gu, " ").trim();
        if (text)
            return {
                roomId,
                senderId: "weixin",
                kind: classifyWechatSystemEvent(text),
                text: `[系统事件] ${text}`,
                memberIds,
                memberNames,
            };
    }
    return undefined;
}
function systemEventMemberNames(xml) {
    const preferredLink = /<link\b[^>]*\bname\s*=\s*["'](?:names|kickoutname)["'][^>]*>([\s\S]*?)<\/link>/iu.exec(xml)?.[1];
    const structured = allXmlTagTexts(preferredLink ?? xml, "nickname");
    if (structured.length > 0)
        return structured;
    return [...xml.matchAll(/["“]([^"”]{1,200})["”]/gu)].map((match) => match[1].trim()).filter(Boolean);
}
function allXmlTagTexts(xml, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "giu");
    const values = [];
    for (const match of xml.matchAll(pattern)) {
        const body = match[1]?.trim() ?? "";
        const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/u.exec(body);
        const value = decodeXmlEntities(cdata?.[1] ?? body).trim();
        if (value)
            values.push(value);
    }
    return [...new Set(values)];
}
function renderWechatSystemTemplate(template, nicknames) {
    const names = nicknames.map((value) => value.normalize("NFKC").trim()).filter(Boolean);
    let index = 0;
    return template
        .replace(/\$[^$]{1,80}\$/gu, () => names[Math.min(index++, Math.max(0, names.length - 1))] || "群成员")
        .replace(/["“”]{2}/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
}
function classifyWechatSystemEvent(text) {
    if (/撤回|recalled/iu.test(text))
        return "message-recalled";
    if (/你被.+移出群聊|you were removed from (?:the )?group/iu.test(text))
        return "bot-removed-from-group";
    if (/加入了群聊|加入群聊|joined (?:the )?group/iu.test(text))
        return "group-member-joined";
    if (/移出了群聊|移出群聊|removed .* from (?:the )?group/iu.test(text))
        return "group-member-removed";
    if (/退出了群聊|退出群聊|left (?:the )?group/iu.test(text))
        return "group-member-left";
    if (/解散.*群聊|dissolved (?:the )?group/iu.test(text))
        return "group-dissolved";
    if (/群聊名称|群名|group name/iu.test(text))
        return "group-name-changed";
    if (/群公告|announcement/iu.test(text))
        return "group-announcement-changed";
    if (/群主|owner/iu.test(text))
        return "group-owner-changed";
    return "group-system-notice";
}
function xmlAttribute(xml, attribute) {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i").exec(xml);
    return match?.[1] ? decodeXmlEntities(match[1]) : undefined;
}
function positiveXmlInteger(xml, attribute) {
    return positiveNumber(xmlAttribute(xml, attribute));
}
function decodeXmlEntities(value) {
    return value
        .replace(/&#x([a-f\d]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
}
function fileAppXml(name, size, mediaId) {
    const extension = name.includes(".") ? name.split(".").at(-1).slice(0, 20) : "bin";
    return `<appmsg appid="" sdkver="0"><title>${escapeXml(name)}</title><des></des><action></action>` +
        `<type>6</type><content></content><url></url><lowurl></lowurl><appattach>` +
        `<totallen>${size}</totallen><attachid>${escapeXml(mediaId)}</attachid><fileext>${escapeXml(extension)}</fileext>` +
        `</appattach><extinfo></extinfo></appmsg>`;
}
function referMsgXml(content, conversation, quote) {
    return `<appmsg appid="" sdkver="0"><title>${escapeXml(content)}</title><des></des><action></action>` +
        `<type>57</type><showtype>0</showtype><soundtype>0</soundtype><content></content><contentattr>0</contentattr>` +
        `<url></url><lowurl></lowurl><appattach><totallen>0</totallen><attachid></attachid><fileext></fileext></appattach>` +
        `<refermsg><type>1</type><svrid>${escapeXml(quote.svrid)}</svrid><fromusr>${escapeXml(conversation)}</fromusr>` +
        `<chatusr>${escapeXml(quote.chatusr)}</chatusr><displayname>${escapeXml(quote.displayname)}</displayname>` +
        `<content>${escapeXml(quote.excerpt)}</content></refermsg><extinfo></extinfo></appmsg>`;
}
function escapeXml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function safeFileDisplayName(name, mimeType) {
    const normalized = name?.replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").trim().slice(0, 180);
    if (normalized)
        return normalized;
    const extension = mimeType === "application/pdf" ? "pdf" : mimeType === "text/plain" ? "txt" : "bin";
    return `文件.${extension}`;
}
function nativeVoiceType(mimeType) {
    const normalized = mimeType?.toLowerCase() ?? "";
    if (normalized.includes("silk"))
        return 4;
    if (normalized.includes("mpeg") || normalized.includes("mp3"))
        return 2;
    if (normalized.includes("wav"))
        return 3;
    if (normalized.includes("speex"))
        return 1;
    return 0;
}
async function reliableVoicePayload(data, mimeType, transcode) {
    if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
        throw new Error("wechat-ipad voice size is invalid");
    }
    const normalized = mimeType?.normalize("NFKC").trim().toLocaleLowerCase() ?? "";
    const requiresSilk = normalized.includes("wav") ||
        normalized.includes("wave") ||
        normalized.includes("mpeg") ||
        normalized.includes("mp3") ||
        isWave(data) ||
        isMp3(data);
    if (!requiresSilk) {
        return { data, mimeType: normalized || "application/octet-stream" };
    }
    const output = await transcode(data, normalized || "audio/wav");
    const outputMime = output.mimeType.normalize("NFKC").trim().toLocaleLowerCase();
    if (output.data.byteLength === 0 ||
        output.data.byteLength > MAX_MEDIA_BYTES ||
        !outputMime.includes("silk") ||
        !isSilk(output.data)) {
        throw new Error("wechat-ipad voice transcoder returned invalid Tencent SILK data");
    }
    return { data: output.data, mimeType: outputMime };
}
async function transcodeCommonAudioToSilk(data, mimeType) {
    const directory = await mkdtemp(join(tmpdir(), "pi-wechat-silk-"));
    const suffix = mimeType.includes("mpeg") || mimeType.includes("mp3") || isMp3(data) ? ".mp3" : ".wav";
    const inputPath = join(directory, `input${suffix}`);
    const pcmPath = join(directory, "voice.pcm");
    const silkPath = join(directory, "voice.silk");
    try {
        await writeFile(inputPath, data, { mode: 0o600 });
        await runVoiceCommand(process.env.PI_FFMPEG_PATH?.trim() || "ffmpeg", [
            "-nostdin",
            "-hide_banner",
            "-loglevel", "error",
            "-i", inputPath,
            "-t", "59",
            "-vn",
            "-ac", "1",
            "-ar", String(WECHAT_IPAD_SILK_SAMPLE_RATE),
            "-acodec", "pcm_s16le",
            "-f", "s16le",
            pcmPath,
            "-y",
        ], "FFmpeg PCM conversion");
        const pcmSize = (await stat(pcmPath)).size;
        if (!Number.isSafeInteger(pcmSize) || pcmSize <= 0) {
            throw new Error("wechat-ipad PCM conversion returned no audio data");
        }
        let bitrate = wechatIpadSilkBitrateForPcmBytes(pcmSize);
        let silk = await encodeTencentSilk(pcmPath, silkPath, bitrate);
        for (let attempt = 0; silk.byteLength > WECHAT_IPAD_SILK_SAFE_BYTES && bitrate > WECHAT_IPAD_SILK_MIN_BITRATE && attempt < 3; attempt += 1) {
            const scaled = Math.floor(bitrate * (WECHAT_IPAD_SILK_SAFE_BYTES / silk.byteLength) * 0.9 / 1_000) * 1_000;
            bitrate = Math.max(WECHAT_IPAD_SILK_MIN_BITRATE, Math.min(bitrate - 1_000, scaled));
            silk = await encodeTencentSilk(pcmPath, silkPath, bitrate);
        }
        if (silk.byteLength > WECHAT_IPAD_SILK_FRAGMENT_BYTES) {
            throw new Error("wechat-ipad encoded voice exceeds the reliable single-fragment limit");
        }
        return { data: silk, mimeType: "audio/silk" };
    }
    finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** Selects the highest useful SILK bitrate that stays within one iPad protocol fragment. */
export function wechatIpadSilkBitrateForPcmBytes(pcmBytes) {
    if (!Number.isSafeInteger(pcmBytes) || pcmBytes <= 0) {
        throw new Error("wechat-ipad PCM byte length must be a positive safe integer");
    }
    const durationSeconds = pcmBytes / (WECHAT_IPAD_SILK_SAMPLE_RATE * 2);
    const payloadBytesPerSecond = Math.max(0, WECHAT_IPAD_SILK_SAFE_BYTES / durationSeconds - WECHAT_IPAD_SILK_FRAMING_BYTES_PER_SECOND);
    const chunkLimitedBitrate = Math.floor(payloadBytesPerSecond * 8 / 1_000) * 1_000;
    return Math.max(WECHAT_IPAD_SILK_MIN_BITRATE, Math.min(WECHAT_IPAD_SILK_MAX_BITRATE, chunkLimitedBitrate));
}
async function encodeTencentSilk(pcmPath, silkPath, bitrate) {
    await unlink(silkPath).catch(() => undefined);
    await runVoiceCommand(process.env.PI_SILK_ENCODER_PATH?.trim() || "/usr/local/bin/silk/encoder", [
        pcmPath,
        silkPath,
        "-tencent",
        "-Fs_API", String(WECHAT_IPAD_SILK_SAMPLE_RATE),
        "-rate", String(bitrate),
        "-quiet",
    ], "Tencent SILK encoding");
    return new Uint8Array(await readFile(silkPath));
}
function runVoiceCommand(executable, args, label) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
        const stderr = [];
        let stderrBytes = 0;
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                rejectPromise(error);
            else
                resolvePromise();
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error(`wechat-ipad ${label} timed out`));
        }, 60_000);
        timer.unref();
        child.stderr.on("data", (chunk) => {
            if (stderrBytes >= 8_000)
                return;
            const remaining = 8_000 - stderrBytes;
            const captured = Buffer.from(chunk).subarray(0, remaining);
            stderr.push(captured);
            stderrBytes += captured.byteLength;
        });
        child.once("error", (error) => finish(new Error(`wechat-ipad ${label} failed to start: ${error.message}`)));
        child.once("close", (code) => {
            if (code !== 0) {
                finish(new Error(`wechat-ipad ${label} failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 1_000)}`));
                return;
            }
            finish();
        });
    });
}
function isWave(data) {
    return data.byteLength >= 12 &&
        Buffer.from(data.buffer, data.byteOffset, 4).toString("ascii") === "RIFF" &&
        Buffer.from(data.buffer, data.byteOffset + 8, 4).toString("ascii") === "WAVE";
}
function isMp3(data) {
    if (data.byteLength < 4)
        return false;
    if (Buffer.from(data.buffer, data.byteOffset, 3).toString("ascii") === "ID3")
        return true;
    for (let index = 0; index < Math.min(data.byteLength - 1, 4_096); index += 1) {
        if (data[index] === 0xff && (data[index + 1] & 0xe0) === 0xe0)
            return true;
    }
    return false;
}
function isSilk(data) {
    const offset = data[0] === 0x02 ? 1 : 0;
    if (data.byteLength < offset + 9)
        return false;
    return Buffer.from(data.buffer, data.byteOffset + offset, 9).toString("ascii") === "#!SILK_V3";
}
function positiveDuration(value) {
    return value && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 59_000) : 1000;
}
function preserveLargeIntegerFields(value) {
    return value.replace(/("(?:NewMsgId|MsgId|MsgSeq|Id|Maxid|ReferId|CommentId2|ReplyCommentId2)"\s*:\s*)(-?\d{16,})/g, '$1"$2"');
}
function timestampMilliseconds(value) {
    const numeric = Number(nativeString(value));
    if (!Number.isFinite(numeric) || numeric <= 0)
        return Date.now();
    return Math.round(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
}
function callbackPath(prefix, accountWxid) {
    return `${prefix}/${encodeURIComponent(accountWxid)}/sync-message`;
}
function normalizedPathPrefix(value) {
    const normalized = value.trim().replace(/\/$/, "");
    if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#") || normalized.length > 300) {
        throw new Error("wechat-ipad callback pathPrefix is invalid");
    }
    return normalized;
}
function normalizedApiUrl(value) {
    const url = normalizedHttpUrl(value);
    const path = url.pathname.replace(/\/$/, "");
    url.pathname = `${path}/`;
    return url;
}
function normalizedHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`Invalid HTTP URL: ${value}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("URL must use HTTP or HTTPS");
    if (url.username || url.password)
        throw new Error("URL cannot contain credentials");
    return url;
}
function assertIpRule(value) {
    const rule = value.trim();
    if (!rule)
        throw new Error("wechat-ipad callback source rule cannot be empty");
    if (rule.includes("/")) {
        const [address, bits, extra] = rule.split("/");
        if (extra !== undefined || !isIpv4(address ?? "") || !bits || !/^\d+$/.test(bits) || Number(bits) > 32) {
            throw new Error(`Invalid IPv4 CIDR rule: ${value}`);
        }
        return;
    }
    if (!isIpv4(normalizeIp(rule)) && rule !== "::1" && !/^[a-f\d:]+$/i.test(rule)) {
        throw new Error(`Invalid callback source IP: ${value}`);
    }
}
function ipRuleMatches(address, rule) {
    if (!rule.includes("/"))
        return address === normalizeIp(rule);
    const [network, bitsText] = rule.split("/");
    if (!network || !bitsText || !isIpv4(address) || !isIpv4(network))
        return false;
    const bits = Number(bitsText);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}
function normalizeIp(value) {
    return value.startsWith("::ffff:") ? value.slice(7) : value;
}
function isIpv4(value) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function ipv4Number(value) {
    return value.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}
function stripAccountPrefix(value, accountId) {
    if (!accountId)
        return value;
    const prefix = `${accountId}:`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
async function enrichSenderDisplayName(event, accountId, resolver) {
    const roomId = stripAccountPrefix(event.conversation.id, accountId);
    const senderId = stripAccountPrefix(event.sender.id, accountId);
    const displayName = (await resolver(roomId, senderId))?.trim();
    if (!displayName || displayName === event.sender.displayName)
        return event;
    return { ...event, sender: { ...event.sender, displayName } };
}
async function collectMedia(content, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of content) {
        if (!(chunk instanceof Uint8Array))
            throw new Error("Media resolver returned a non-byte chunk");
        size += chunk.byteLength;
        if (size > maxBytes)
            throw new Error(`wechat-ipad outbound media exceeds ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
    }
    if (size === 0)
        throw new Error("wechat-ipad outbound media is empty");
    return Buffer.concat(chunks, size);
}
async function* singleChunk(value) {
    yield value;
}
function encodeMedia(data) {
    if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES)
        throw new Error("wechat-ipad media size is invalid");
    return Buffer.from(data).toString("base64");
}
function protocolInt32(value, name) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < -2_147_483_648 || numeric > 2_147_483_647) {
        throw new Error(`${name} must fit a signed 32-bit integer`);
    }
    return numeric;
}
function requiredPositiveNumber(value, name) {
    if (!value || !Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function positiveNumber(value) {
    const numeric = Number(nativeString(value));
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}
function requiredNativeId(value, name) {
    const normalized = requiredText(value, name);
    if (normalized.length > 300 || /[\u0000-\u001f\s]/u.test(normalized))
        throw new Error(`${name} is invalid`);
    return normalized;
}
function requiredGroupId(value) {
    const normalized = requiredNativeId(value, "room id");
    if (!normalized.endsWith("@chatroom"))
        throw new Error("room id must end with @chatroom");
    return normalized;
}
function uniqueNativeIds(values, name, max) {
    if (!Array.isArray(values))
        throw new Error(`${name} ids must be an array`);
    const normalized = [...new Set(values.map((value) => requiredNativeId(value, `${name} id`)))];
    if (normalized.length < 1 || normalized.length > max) {
        throw new Error(`${name} ids must contain between 1 and ${max} entries`);
    }
    return normalized;
}
function boundedNativeText(value, name, max, allowEmpty = false) {
    const normalized = value?.normalize("NFKC").trim();
    if (!normalized && !allowEmpty)
        throw new Error(`${name} cannot be empty`);
    if ((normalized?.length ?? 0) > max)
        throw new Error(`${name} cannot exceed ${max} characters`);
    return normalized ?? "";
}
function optionalNativeText(value, name, max) {
    if (value === undefined)
        return undefined;
    return boundedNativeText(value, name, max, true);
}
function requiredDecimalId(value, name) {
    const normalized = requiredText(value, name);
    if (!/^\d{1,30}$/u.test(normalized))
        throw new Error(`${name} must be a decimal string`);
    return normalized;
}
function textMomentXml(accountWxid, content, privacy) {
    return `<TimelineObject><id>0</id><username>${escapeXml(accountWxid)}</username>` +
        `<createTime>${Math.floor(Date.now() / 1000)}</createTime><contentDesc>${escapeXml(content)}</contentDesc>` +
        `<contentDescShowType>0</contentDescShowType><contentDescScene>0</contentDescScene>` +
        `<private>${privacy}</private><sightFolded>0</sightFolded><showFlag>0</showFlag>` +
        `<contentattr></contentattr><sourceUserName></sourceUserName><sourceNickName></sourceNickName>` +
        `<publicUserName></publicUserName><publicBrandContactType>0</publicBrandContactType>` +
        `<statisticsData></statisticsData><statExtStr></statExtStr><canvasInfoXml></canvasInfoXml>` +
        `<appInfo><isForceUpdate>0</isForceUpdate><isHidden>0</isHidden></appInfo>` +
        `<ContentObject><contentStyle>2</contentStyle><contentSubStyle>0</contentSubStyle>` +
        `<title></title><description></description><contentUrl></contentUrl><mediaList></mediaList></ContentObject>` +
        `</TimelineObject>`;
}
function requiredText(value, name) {
    const normalized = value?.trim();
    if (!normalized)
        throw new Error(`${name} cannot be empty`);
    return normalized;
}
function nativeString(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    if (isRecord(value)) {
        if (typeof value.string === "string")
            return value.string;
        if (typeof value.String === "string")
            return value.String;
    }
    return undefined;
}
function compactRecord(value) {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberValue(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
        throw new Error(`${name} must be between 0 and 65535`);
    return value;
}
function safeFileName(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
async function orderSpoolFiles(directory, files) {
    const entries = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(join(directory, file))).mtimeMs })));
    entries.sort((left, right) => left.modified - right.modified || left.file.localeCompare(right.file));
    return entries.map((entry) => entry.file);
}
async function atomicCreateBuffer(path, value) {
    const temporary = `${path}.tmp-${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(value);
        await file.sync();
    }
    finally {
        await file.close();
    }
    try {
        await link(temporary, path);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
async function atomicCreateJson(path, value) {
    return atomicCreateBuffer(path, Buffer.from(JSON.stringify(value)));
}
async function atomicReplaceJson(path, value) {
    const temporary = `${path}.tmp-${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
    }
    finally {
        await file.close();
    }
    try {
        await rename(temporary, path);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
async function readJsonIfExists(path) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        return isRecord(value) ? value : undefined;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function readRequestBody(request, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit)
            throw new HttpInputError(413, "body_too_large");
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
}
function numberHeader(request, name) {
    const value = request.headers[name];
    if (typeof value !== "string" || !/^\d+$/.test(value))
        return undefined;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : undefined;
}
class HttpInputError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function replyJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    response.end(body);
}
function listen(server, port, host) {
    return new Promise((resolvePromise, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
            server.off("error", onError);
            resolvePromise();
        });
    });
}
function close(server) {
    return new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function assertNever(value) {
    throw new Error(`Unsupported message part: ${JSON.stringify(value)}`);
}
//# sourceMappingURL=wechat-ipad.js.map