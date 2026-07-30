import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CHANNEL_FEATURE_RECEIVE_FILE, CHANNEL_FEATURE_RECEIVE_IMAGE, CHANNEL_FEATURE_RECEIVE_VIDEO, CHANNEL_FEATURE_RECEIVE_VOICE, CHANNEL_FEATURE_SEND_IMAGE, CHANNEL_FEATURE_SEND_MENTION, CHANNEL_PLUGIN_API_VERSION, MEDIA_RESOLVE_CAPABILITY, defineChannelPlugin, provideChannelCapability, } from "../channel.js";
import { parseRedEnvelopeMetadata } from "../red-envelope.js";
import { safeGroupDisplayName } from "../display-name.js";
import { wechatEmojiCdnUrl } from "../wechat-emoji.js";
const DEFAULT_WEBHOOK_PATH = "/wechat/events";
const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 35_000;
const DEFAULT_INGEST_RETRY_MS = 2_000;
const MAX_GATEWAY_MEDIA_BYTES = 64 * 1024 * 1024;
export class WxHookGatewayError extends Error {
    status;
    code;
    response;
    constructor(message, status, code, response) {
        super(message);
        this.name = "WxHookGatewayError";
        this.status = status;
        this.code = code;
        this.response = response;
    }
}
/** Narrow client for the documented LAN gateway. It never exposes arbitrary native commands. */
export class WxHookGatewayClient {
    #baseUrl;
    #apiToken;
    #timeoutMs;
    #fetch;
    constructor(options) {
        this.#baseUrl = normalizedHttpUrl(options.baseUrl);
        if (!options.apiToken.trim())
            throw new Error("wx-hook API token cannot be empty");
        this.#apiToken = options.apiToken;
        this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS, "gateway timeoutMs");
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    }
    health() {
        return this.#request("/health", { authenticated: false });
    }
    send(request) {
        if (!request.to.trim())
            throw new Error("wx-hook send recipient cannot be empty");
        if (!request.content)
            throw new Error("wx-hook send content cannot be empty");
        return this.#request("/api/send", {
            method: "POST",
            body: {
                to: request.to,
                content: request.content,
                type: request.type ?? 1,
                ...(request.at_user_list?.length ? { at_user_list: request.at_user_list } : {}),
                ...(request.quote ? { quote: request.quote } : {}),
            },
        });
    }
    async listMessages(limit = 20) {
        const bounded = Math.max(1, Math.min(200, positiveInteger(limit, "message limit")));
        const response = await this.#request(`/api/messages?limit=${bounded}`);
        return Array.isArray(response.messages) ? response.messages : [];
    }
    async listContacts() {
        const response = await this.#request("/api/contacts");
        const contacts = Array.isArray(response.contacts) ? response.contacts : [];
        return contacts.flatMap((value) => {
            if (!isRecord(value))
                return [];
            const id = stringValue(value.id)?.trim();
            const displayName = stringValue(value.display_name)?.trim();
            return id && displayName ? [{ id, displayName }] : [];
        });
    }
    async getMessage(messageId) {
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(messageId))
            throw new Error("Invalid wx-hook message id");
        const response = await this.#request(`/api/messages/${encodeURIComponent(messageId)}`);
        if (!isRecord(response.payload))
            throw new Error("wx-hook gateway returned an invalid message payload");
        return response.payload;
    }
    async resolveMedia(messageId, variant = "medium") {
        if (!/^\d{1,128}$/.test(messageId))
            throw new Error("Invalid wx-hook media message id");
        const response = await this.#request("/api/media/resolve", {
            method: "POST",
            body: { message_id: messageId, variant },
        });
        const asset = parseResolvedMediaAsset(response.asset);
        if (!asset || asset.message_id !== messageId) {
            throw new WxHookGatewayError("wx-hook gateway returned invalid media metadata", 200, "invalid_response", response);
        }
        return asset;
    }
    async downloadMedia(asset) {
        if (asset.download_url !== `/api/media/${asset.id}`) {
            throw new Error("wx-hook media download URL does not match its asset id");
        }
        const headers = new Headers({
            Accept: asset.mime_type,
            Authorization: `Bearer ${this.#apiToken}`,
        });
        let response;
        try {
            response = await this.#fetch(new URL(asset.download_url, this.#baseUrl), {
                headers,
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        }
        catch (error) {
            throw new WxHookGatewayError(`wx-hook media download failed: ${errorMessage(error)}`, 0, "network_error", undefined);
        }
        if (!response.ok) {
            const raw = await response.text();
            let payload = raw;
            try {
                payload = raw ? JSON.parse(raw) : {};
            }
            catch {
                // Preserve the raw gateway response in the structured error.
            }
            const code = isRecord(payload)
                ? stringValue(payload.error) ?? `http_${response.status}`
                : `http_${response.status}`;
            throw new WxHookGatewayError(`wx-hook gateway rejected the media download: ${code}`, response.status, code, payload);
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        const contentLength = Number(response.headers.get("content-length"));
        const contentSha256 = response.headers.get("x-media-sha256")?.trim().toLowerCase();
        if (contentType !== asset.mime_type ||
            !Number.isSafeInteger(contentLength) ||
            contentLength !== asset.size ||
            contentSha256 !== asset.sha256 ||
            !response.body) {
            await response.body?.cancel().catch(() => undefined);
            throw new WxHookGatewayError("wx-hook gateway returned inconsistent media headers", response.status, "invalid_response", { contentType, contentLength, contentSha256 });
        }
        return verifiedMediaContent(response.body, asset.size, asset.sha256);
    }
    async stageImage(data, mimeType, sha256) {
        const normalizedMime = mimeType.normalize("NFKC").trim().toLowerCase();
        const normalizedHash = sha256.trim().toLowerCase();
        if (!data.byteLength || data.byteLength > MAX_GATEWAY_MEDIA_BYTES) {
            throw new Error("wx-hook staged image has an invalid size");
        }
        if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalizedMime)) {
            throw new Error(`wx-hook cannot stage unsupported image type ${normalizedMime || "unknown"}`);
        }
        if (!/^[a-f0-9]{64}$/.test(normalizedHash))
            throw new Error("wx-hook staged image SHA-256 is invalid");
        const response = await this.#request("/api/media/stage", {
            method: "POST",
            rawBody: data,
            contentType: normalizedMime,
            sha256: normalizedHash,
        });
        const asset = parseStagedImageAsset(response.asset);
        if (!asset || asset.sha256 !== normalizedHash || asset.size !== data.byteLength || asset.mime_type !== normalizedMime) {
            throw new WxHookGatewayError("wx-hook gateway returned invalid staged image metadata", 200, "invalid_response", response);
        }
        return asset;
    }
    async listWebhooks() {
        const response = await this.#request("/api/webhooks");
        return Array.isArray(response.webhooks) ? response.webhooks : [];
    }
    async registerWebhook(input) {
        if (input.secret.length < 16)
            throw new Error("wx-hook webhook secret must contain at least 16 characters");
        normalizedHttpUrl(input.url);
        const response = await this.#request("/api/webhooks", {
            method: "POST",
            body: {
                url: input.url,
                secret: input.secret,
                events: input.events ?? ["message.received"],
                enabled: input.enabled ?? true,
            },
        });
        if (!isRecord(response.webhook))
            throw new Error("wx-hook gateway returned an invalid webhook registration");
        return response.webhook;
    }
    async testWebhook(webhookId) {
        const response = await this.#request(`/api/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" });
        return stringValue(response.delivery_id) ?? "";
    }
    async deleteWebhook(webhookId) {
        await this.#request(`/api/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
    }
    async #request(path, options = {}) {
        const headers = new Headers({ Accept: "application/json" });
        if (options.authenticated !== false)
            headers.set("Authorization", `Bearer ${this.#apiToken}`);
        if (options.body && options.rawBody)
            throw new Error("wx-hook request cannot contain JSON and raw bodies together");
        let body;
        if (options.body) {
            headers.set("Content-Type", "application/json; charset=utf-8");
            body = JSON.stringify(options.body);
        }
        else if (options.rawBody) {
            headers.set("Content-Type", options.contentType ?? "application/octet-stream");
            if (options.sha256)
                headers.set("X-Asset-Sha256", options.sha256);
            body = options.rawBody;
        }
        let response;
        try {
            response = await this.#fetch(new URL(path, this.#baseUrl), {
                method: options.method ?? "GET",
                headers,
                ...(body === undefined ? {} : { body }),
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        }
        catch (error) {
            throw new WxHookGatewayError(`wx-hook gateway request failed: ${errorMessage(error)}`, 0, "network_error", undefined);
        }
        const raw = await response.text();
        let payload;
        try {
            payload = raw ? JSON.parse(raw) : {};
        }
        catch {
            throw new WxHookGatewayError("wx-hook gateway returned non-JSON data", response.status, "invalid_response", raw);
        }
        if (!isRecord(payload)) {
            throw new WxHookGatewayError("wx-hook gateway returned a non-object response", response.status, "invalid_response", payload);
        }
        if (!response.ok || payload.ok !== true) {
            const code = stringValue(payload.error) ?? `http_${response.status}`;
            throw new WxHookGatewayError(`wx-hook gateway rejected the request: ${code}`, response.status, code, payload);
        }
        return payload;
    }
}
/** Create a self-contained ChannelPlugin backed by the wx_hook_bridge HTTP API and signed webhook. */
export function createWxHookHttpChannel(options) {
    const controller = new WxHookHttpController(options);
    return defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: controller.pluginId,
        displayName: options.displayName ?? "wx_hook_bridge HTTP",
        features: controller.features,
        capabilities: [
            provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, ({ asset }) => controller.resolveMedia(asset)),
        ],
        gateway: controller.gateway,
        start: (context) => controller.start(context),
        send: (action) => controller.send(action),
        stop: () => controller.stop(),
        webhookAddress: () => controller.webhookAddress(),
    });
}
/** Convert one verified native message. Unsupported/system/self messages return null. */
export function normalizeWxHookMessage(payload, options) {
    const msgId = stringValue(payload.msgId);
    const nativeType = stringValue(payload.type);
    const rawContent = stringValue(payload.content) ?? "";
    if (!msgId || !nativeType)
        return null;
    // Bridge versions may expose pat XML under either 10000 or 10002.
    const pat = parsePatInteraction(rawContent);
    if ((nativeType === "10000" || nativeType === "10002") && !pat)
        return null;
    const roomId = firstNonEmpty(pat?.chatroomId, payload.roomId, endsWithChatroom(payload.from), endsWithChatroom(payload.peerWxId));
    const isGroup = roomId !== undefined;
    const prefix = isGroup ? splitGroupPrefix(rawContent) : undefined;
    const content = prefix?.body ?? rawContent;
    const selfWxId = stringValue(payload.selfWxId);
    const xmlSender = isGroup ? xmlTagText(content, "fromusername") : undefined;
    const explicitSender = nonRoomId(stringValue(payload.senderWxId), roomId);
    const nativeSender = firstNonEmpty(pat?.senderId, explicitSender, xmlSender, prefix?.sender, isGroup ? undefined : payload.fromWxId, payload.from);
    if (!nativeSender)
        return null;
    if (selfWxId && nativeSender === selfWxId)
        return null;
    if (options.isBotSender?.(nativeSender))
        return null;
    if (payload.isSendMsg === true)
        return null;
    const knownIncoming = payload.isIncoming === true || payload.direction === "incoming";
    const allowUnknown = options.acceptUnknownGroupSenders ?? true;
    if (!knownIncoming && !pat && !(isGroup && allowUnknown && prefix))
        return null;
    const nativeConversation = isGroup
        ? roomId
        : firstNonEmpty(payload.peerWxId, payload.from, payload.rawFrom, nativeSender);
    if (!nativeConversation)
        return null;
    const accountPrefix = options.accountId?.trim() ? `${options.accountId.trim()}:` : "";
    const senderId = accountPrefix + nativeSender;
    const conversationId = accountPrefix + nativeConversation;
    const payloadDisplayName = firstNonEmpty(payload.senderDisplayName, payload.senderName, payload.memberName, payload.nickName, payload.nickname);
    const displayName = safeGroupDisplayName(payloadDisplayName && payloadDisplayName !== nativeSender
        ? payloadDisplayName
        : prefix?.sender && prefix.sender !== nativeSender ? prefix.sender : nativeSender, senderId);
    const subType = firstNonEmpty(payload.subType, payload.subtype);
    const metadata = {
        channel: "wx-hook-http",
        nativeType,
        ...(nativeType === "47" ? { interaction: "emoji" } : {}),
        senderIdentity: explicitSender || xmlSender ? "native" : "content-prefix",
    };
    if (subType)
        metadata.nativeSubType = subType;
    if (options.deliveryId)
        metadata.deliveryId = options.deliveryId;
    if (pat) {
        metadata.interaction = "pat";
        metadata.interactionSenderId = accountPrefix + pat.senderId;
        metadata.interactionTargetId = accountPrefix + pat.targetId;
        metadata.interactionTargetIsBot = selfWxId ? pat.targetId === selfWxId : false;
        if (pat.template)
            metadata.interactionTemplate = pat.template;
    }
    const mentions = parseMentions(stringValue(payload.signature), accountPrefix);
    const base = {
        type: "message",
        id: `${accountPrefix}wxmsg:${msgId}`,
        conversation: { id: conversationId, kind: isGroup ? "group" : "direct" },
        sender: { id: senderId, displayName },
        timestamp: timestampMilliseconds(payload.timestamp),
        ...(mentions.length === 0 ? {} : { mentions }),
        metadata,
    };
    if (pat) {
        const text = pat.template?.trim() || `${nativeSender} 拍了拍 ${pat.targetId}`;
        return { ...base, text, parts: [{ type: "text", text }] };
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
            return mediaEvent(base, "image", platformAsset(msgId, options.pluginId, nativeType), "微信图片", content);
        case "34":
            return mediaEvent(base, "voice", platformAsset(msgId, options.pluginId, nativeType), undefined, content);
        case "43":
            return mediaEvent(base, "video", platformAsset(msgId, options.pluginId, nativeType), undefined, content);
        case "47":
            return mediaEvent(base, "image", platformAsset(msgId, options.pluginId, nativeType, content), "微信表情", content);
        case "49":
            return normalizeAppMessage(base, content, subType, msgId, options.pluginId, accountPrefix);
        default: {
            const text = content.trim();
            return text ? { ...base, text, parts: [{ type: "text", text }], metadata: { ...metadata, unsupportedNativeType: true } } : null;
        }
    }
}
class WxHookHttpController {
    pluginId;
    gateway;
    features;
    #webhook;
    #stateDirectory;
    #inboxDirectory;
    #processedDirectory;
    #failedDirectory;
    #sentDirectory;
    #accountId;
    #acceptUnknownGroupSenders;
    #nativeQuoteReplies;
    #ingestRetryMs;
    #isBotSender;
    #resolveGroupMemberName;
    #resolveWindowsImagePath;
    #outboundMediaResolver;
    #fetch;
    #onError;
    #context;
    #server;
    #running = false;
    #draining;
    #retryTimer;
    #sendTail = Promise.resolve();
    constructor(options) {
        this.pluginId = options.pluginId?.trim() || "wx-hook-http";
        this.gateway = new WxHookGatewayClient(options.gateway);
        if (options.webhook.secret.length < 16)
            throw new Error("wx-hook webhook secret must contain at least 16 characters");
        const path = normalizedWebhookPath(options.webhook.path ?? DEFAULT_WEBHOOK_PATH);
        this.#webhook = {
            secret: options.webhook.secret,
            port: nonNegativeInteger(options.webhook.port, "webhook port"),
            host: options.webhook.host ?? "127.0.0.1",
            path,
            maxBodyBytes: positiveInteger(options.webhook.maxBodyBytes ?? DEFAULT_BODY_LIMIT, "webhook maxBodyBytes"),
            maxTimestampSkewMs: positiveInteger(options.webhook.maxTimestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS, "webhook maxTimestampSkewMs"),
        };
        this.#stateDirectory = resolve(options.stateDirectory ?? join("data", "channels", safeFileName(this.pluginId)));
        this.#inboxDirectory = join(this.#stateDirectory, "inbox");
        this.#processedDirectory = join(this.#stateDirectory, "processed");
        this.#failedDirectory = join(this.#stateDirectory, "failed");
        this.#sentDirectory = join(this.#stateDirectory, "sent");
        this.#accountId = options.accountId?.trim() || undefined;
        this.#acceptUnknownGroupSenders = options.acceptUnknownGroupSenders ?? true;
        this.#nativeQuoteReplies = options.nativeQuoteReplies ?? true;
        this.#ingestRetryMs = positiveInteger(options.ingestRetryMs ?? DEFAULT_INGEST_RETRY_MS, "ingestRetryMs");
        this.#isBotSender = options.isBotSender;
        this.#resolveGroupMemberName = options.resolveGroupMemberName;
        this.#resolveWindowsImagePath = options.resolveWindowsImagePath;
        this.#outboundMediaResolver = options.outboundMediaResolver;
        this.#fetch = options.gateway.fetch ?? globalThis.fetch.bind(globalThis);
        this.#onError = options.onError;
        this.features = [
            CHANNEL_FEATURE_RECEIVE_IMAGE,
            CHANNEL_FEATURE_RECEIVE_VOICE,
            CHANNEL_FEATURE_RECEIVE_VIDEO,
            CHANNEL_FEATURE_RECEIVE_FILE,
            // The bridge has no native At field, but the adapter deliberately
            // sends both visible @群昵称 text and the native member id list.
            CHANNEL_FEATURE_SEND_MENTION,
            ...(this.#resolveWindowsImagePath || this.#outboundMediaResolver ? [CHANNEL_FEATURE_SEND_IMAGE] : []),
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
        this.#context = context;
        this.#running = true;
        const server = createServer((request, response) => {
            void this.#handleWebhook(request, response).catch((error) => {
                this.#report(error, { phase: "webhook" });
                if (!response.headersSent) {
                    if (error instanceof HttpInputError)
                        replyJson(response, error.status, { ok: false, error: error.code });
                    else
                        replyJson(response, 500, { ok: false, error: "internal_error" });
                }
                else
                    response.destroy();
            });
        });
        server.requestTimeout = 10_000;
        server.headersTimeout = 10_000;
        this.#server = server;
        try {
            await listen(server, this.#webhook.port, this.#webhook.host);
        }
        catch (error) {
            this.#server = undefined;
            this.#running = false;
            this.#context = undefined;
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
        this.#retryTimer = undefined;
        const server = this.#server;
        this.#server = undefined;
        if (server)
            await close(server);
        if (this.#draining)
            await this.#draining;
        await this.#sendTail;
        this.#context = undefined;
    }
    webhookAddress() {
        const address = this.#server?.address();
        if (!address || typeof address === "string")
            return undefined;
        return { host: this.#webhook.host, port: address.port, path: this.#webhook.path };
    }
    async resolveMedia(asset) {
        const nativeType = stringValue(asset.metadata?.nativeType);
        const match = /^message:(\d{1,128})$/.exec(asset.locator);
        if (asset.source === "platform" &&
            asset.ownerPluginId === this.pluginId &&
            nativeType === "47" &&
            match) {
            const url = wechatEmojiCdnUrl(asset);
            if (!url)
                throw new Error("wx-hook emoji asset has no trusted native CDN URL");
            const response = await this.#fetch(url, {
                method: "GET",
                headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5" },
                redirect: "follow",
                signal: AbortSignal.timeout(DEFAULT_GATEWAY_TIMEOUT_MS),
            });
            if (!response.ok)
                throw new Error(`wx-hook emoji CDN download failed (HTTP ${response.status})`);
            const declaredLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_GATEWAY_MEDIA_BYTES) {
                throw new Error("wx-hook emoji exceeds the media byte limit");
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength === 0 || bytes.byteLength > MAX_GATEWAY_MEDIA_BYTES) {
                throw new Error("wx-hook emoji has an invalid media size");
            }
            const mimeType = sniffImageMimeType(bytes);
            if (!mimeType)
                throw new Error("wx-hook emoji CDN response is not a supported image");
            const digest = createHash("sha256").update(bytes).digest("hex");
            return {
                asset: { ...asset, mimeType, size: bytes.byteLength, sha256: digest },
                content: (async function* () { yield bytes; })(),
            };
        }
        if (asset.source !== "platform" ||
            asset.ownerPluginId !== this.pluginId ||
            nativeType !== "3" ||
            !match) {
            throw new Error("wx-hook media.resolve supports only owned native type=3 images or type=47 emojis");
        }
        const media = await this.gateway.resolveMedia(match[1], "medium");
        const content = await this.gateway.downloadMedia(media);
        return {
            asset: {
                ...asset,
                mimeType: media.mime_type,
                size: media.size,
                sha256: media.sha256,
                metadata: {
                    ...(asset.metadata ?? {}),
                    nativeType: "3",
                    gatewayMediaId: media.id,
                    variant: media.variant,
                },
            },
            content,
        };
    }
    async #sendAction(action) {
        try {
            const target = stripAccountPrefix(action.conversationId, this.#accountId);
            const journalPath = join(this.#sentDirectory, `${sha256(action.id)}.json`);
            const existing = await readJsonIfExists(journalPath);
            let operations = parseNativeSendOperations(existing?.operations);
            if (!operations) {
                const resolveImage = this.#resolveWindowsImagePath ?? (this.#outboundMediaResolver
                    ? (asset) => this.#stageOutboundImage(asset)
                    : undefined);
                const prefersNativeQuote = this.#nativeQuoteReplies && hasReplyQuote(action);
                operations = await outboundOperations(action, resolveImage, this.#accountId, !prefersNativeQuote);
                if (this.#nativeQuoteReplies)
                    operations = await this.#applyNativeQuote(action, operations);
            }
            const digest = sha256(JSON.stringify(operations));
            if (existing && (existing.actionId !== action.id || existing.digest !== digest)) {
                throw new Error(`wx-hook outbound action id collision: ${action.id}`);
            }
            if (existing?.done === true)
                return;
            let completed = numberValue(existing?.completed) ?? 0;
            await atomicReplaceJson(journalPath, { actionId: action.id, digest, operations, completed, done: false });
            for (let index = completed; index < operations.length; index += 1) {
                const operation = operations[index];
                await this.#sendWithBusyRetry(target, operation);
                completed = index + 1;
                await atomicReplaceJson(journalPath, {
                    actionId: action.id,
                    digest,
                    operations,
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
    async #stageOutboundImage(asset) {
        if (!this.#outboundMediaResolver)
            throw new Error("wx-hook outbound media resolver is not configured");
        const resolved = await this.#outboundMediaResolver.resolve(asset);
        const bytes = await collectMediaBytes(resolved.content, MAX_GATEWAY_MEDIA_BYTES);
        const mimeType = sniffImageMimeType(bytes) ?? resolved.asset.mimeType ?? asset.mimeType;
        if (!mimeType)
            throw new Error(`wx-hook image asset ${asset.id} has no recognized MIME type`);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const staged = await this.gateway.stageImage(bytes, mimeType, digest);
        return staged.windows_path;
    }
    async #applyNativeQuote(action, operations) {
        const quotePart = action.parts?.find((part) => part.type === "quote" && part.messageId === action.replyToMessageId);
        if (!quotePart)
            return operations;
        const nativeMessageId = nativeMessageIdFromEventId(action.replyToMessageId);
        const textIndex = operations.findIndex((operation) => operation.type === 1);
        if (!nativeMessageId || textIndex < 0)
            return operations;
        // Fresh quote operations omit mention parts before reaching this method.
        // Keep the guard for any legacy/persisted operation that still carries one.
        if (operations[textIndex].atUserList?.length)
            return operations;
        let payload;
        try {
            payload = await this.gateway.getMessage(nativeMessageId);
        }
        catch (error) {
            if (error instanceof WxHookGatewayError && error.code === "message_not_found")
                return operations;
            throw error;
        }
        const quote = quoteRequestFromPayload(payload);
        if (!quote)
            return operations;
        const upgraded = [...operations];
        upgraded[textIndex] = { type: 5, content: operations[textIndex].content, quote };
        return upgraded;
    }
    async #sendWithBusyRetry(to, operation) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                await this.gateway.send({
                    to,
                    content: operation.content,
                    type: operation.type,
                    ...(operation.atUserList?.length ? { at_user_list: operation.atUserList } : {}),
                    ...(operation.quote ? { quote: operation.quote } : {}),
                });
                return;
            }
            catch (error) {
                if (!(error instanceof WxHookGatewayError) || error.code !== "outbox_busy" || attempt === 3)
                    throw error;
                await delay(150 * 2 ** attempt);
            }
        }
    }
    async #handleWebhook(request, response) {
        const url = new URL(request.url ?? "/", "http://wx-hook.local");
        if (request.method === "GET" && url.pathname === this.#webhook.path) {
            replyJson(response, 200, { ok: true, service: this.pluginId });
            return;
        }
        if (request.method !== "POST" || url.pathname !== this.#webhook.path) {
            replyJson(response, 404, { ok: false, error: "not_found" });
            return;
        }
        if (!this.#running) {
            replyJson(response, 503, { ok: false, error: "channel_stopped" });
            return;
        }
        const contentLength = numberHeader(request, "content-length");
        if (contentLength !== undefined && contentLength > this.#webhook.maxBodyBytes) {
            replyJson(response, 413, { ok: false, error: "body_too_large" });
            return;
        }
        const body = await readRequestBody(request, this.#webhook.maxBodyBytes);
        const timestamp = header(request, "x-wxbridge-timestamp");
        const signature = header(request, "x-wxbridge-signature");
        if (!verifyWebhookSignature(body, timestamp, signature, this.#webhook.secret, this.#webhook.maxTimestampSkewMs)) {
            replyJson(response, 401, { ok: false, error: "invalid_signature" });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body.toString("utf8"));
        }
        catch {
            replyJson(response, 400, { ok: false, error: "invalid_json" });
            return;
        }
        const envelope = parseEnvelope(parsed);
        if (!envelope) {
            replyJson(response, 400, { ok: false, error: "invalid_envelope" });
            return;
        }
        const headerDelivery = header(request, "x-wxbridge-delivery");
        const headerEvent = header(request, "x-wxbridge-event");
        if (headerDelivery !== envelope.id || headerEvent !== envelope.event) {
            replyJson(response, 400, { ok: false, error: "header_envelope_mismatch" });
            return;
        }
        if (envelope.event === "webhook.test") {
            replyJson(response, 202, { ok: true, accepted: true, test: true });
            return;
        }
        if (envelope.event !== "message.received") {
            replyJson(response, 202, { ok: true, accepted: false, ignored: true });
            return;
        }
        const duplicate = await this.#spool(envelope);
        replyJson(response, 202, { ok: true, accepted: true, duplicate });
        this.#kickDrain();
    }
    async #spool(envelope) {
        const key = sha256(envelope.id);
        if (await exists(join(this.#processedDirectory, `${key}.json`)))
            return true;
        const path = join(this.#inboxDirectory, `${key}.json`);
        const created = await atomicCreateJson(path, { receivedAt: Date.now(), envelope });
        return !created;
    }
    #kickDrain() {
        if (!this.#running || this.#draining || this.#retryTimer)
            return;
        this.#draining = this.#drain().finally(() => {
            this.#draining = undefined;
            if (this.#running && !this.#retryTimer) {
                void readdir(this.#inboxDirectory).then((files) => {
                    if (files.some((file) => file.endsWith(".json")))
                        this.#kickDrain();
                }).catch((error) => this.#report(error, { phase: "spool" }));
            }
        });
    }
    async #drain() {
        let retry = false;
        try {
            const files = (await readdir(this.#inboxDirectory)).filter((file) => file.endsWith(".json"));
            const ordered = await orderSpoolFiles(this.#inboxDirectory, files);
            for (const file of ordered) {
                if (!this.#running)
                    break;
                const path = join(this.#inboxDirectory, file);
                let record;
                try {
                    record = JSON.parse(await readFile(path, "utf8"));
                }
                catch (error) {
                    this.#report(error, { phase: "spool" });
                    await rename(path, join(this.#failedDirectory, `${Date.now()}-${file}`));
                    continue;
                }
                const envelope = isRecord(record) ? parseEnvelope(record.envelope) : undefined;
                if (!envelope) {
                    await rename(path, join(this.#failedDirectory, `${Date.now()}-${file}`));
                    continue;
                }
                try {
                    let event = normalizeWxHookMessage(envelope.data, {
                        pluginId: this.pluginId,
                        deliveryId: envelope.id,
                        ...(this.#accountId ? { accountId: this.#accountId } : {}),
                        acceptUnknownGroupSenders: this.#acceptUnknownGroupSenders,
                        ...(this.#isBotSender ? { isBotSender: this.#isBotSender } : {}),
                    });
                    if (event && this.#context.hasSeenEvent?.(event.id)) {
                        await atomicCreateJson(join(this.#processedDirectory, file), {
                            deliveryId: envelope.id,
                            eventId: event.id,
                            processedAt: Date.now(),
                            replayed: true,
                        });
                        await unlink(path);
                        continue;
                    }
                    if (event && event.conversation.kind === "group" && this.#resolveGroupMemberName) {
                        event = await enrichSenderDisplayName(event, this.#accountId, this.#resolveGroupMemberName);
                    }
                    if (event)
                        await this.#context.ingest(event);
                    await atomicCreateJson(join(this.#processedDirectory, file), {
                        deliveryId: envelope.id,
                        eventId: event?.id ?? null,
                        processedAt: Date.now(),
                    });
                    await unlink(path);
                }
                catch (error) {
                    retry = true;
                    this.#report(error, { phase: "ingest", deliveryId: envelope.id });
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
async function outboundOperations(action, resolveImage, accountId, includeMentions = true) {
    const operations = [];
    let text = [];
    let atUserList = [];
    const flushText = () => {
        const content = text.join("\n").replaceAll("\t", "    ").trim();
        if (content)
            operations.push({
                type: 1,
                content,
                ...(atUserList.length ? { atUserList: [...new Set(atUserList)] } : {}),
            });
        text = [];
        atUserList = [];
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
                if (includeMentions) {
                    text.push(`@${part.displayName ?? part.memberId}`);
                    atUserList.push(stripAccountPrefix(part.memberId, accountId));
                }
                break;
            case "quote":
                break;
            case "image": {
                flushText();
                if (!resolveImage)
                    throw new Error("wx-hook image sending is not configured");
                const windowsPath = await resolveImage(part.asset);
                if (!windowsPath || !isWindowsAbsolutePath(windowsPath)) {
                    throw new Error(`wx-hook image asset ${part.asset.id} did not resolve to a Windows absolute path`);
                }
                operations.push({ type: 3, content: windowsPath });
                break;
            }
            case "audio":
            case "voice":
            case "video":
            case "file":
                throw new Error(`wx-hook gateway cannot send ${part.type}`);
            default:
                assertNever(part);
        }
    }
    flushText();
    if (operations.length === 0 && action.text.trim())
        operations.push({ type: 1, content: action.text.replaceAll("\t", "    ") });
    if (operations.length === 0)
        throw new Error("wx-hook outbound action has no sendable content");
    return operations;
}
function hasReplyQuote(action) {
    return Boolean(action.replyToMessageId && action.parts?.some((part) => part.type === "quote" && part.messageId === action.replyToMessageId));
}
function normalizeAppMessage(base, xml, subType, msgId, pluginId, accountPrefix) {
    const title = xmlTagText(xml, "title")?.trim() ?? "";
    const redEnvelope = parseRedEnvelopeMetadata(xml, subType);
    if (redEnvelope) {
        return {
            ...base,
            text: title || (redEnvelope.redEnvelopeKind === "gift" ? "[微信礼物]" : "[微信红包]"),
            parts: title ? [{ type: "text", text: title }] : [],
            metadata: { ...base.metadata, ...redEnvelope },
        };
    }
    if (subType === "57") {
        const quotedId = xmlTagText(xml, "svrid");
        const quotedSender = xmlTagText(xml, "chatusr");
        const parts = [];
        if (title)
            parts.push({ type: "text", text: title });
        if (quotedId)
            parts.push({ type: "quote", messageId: `${accountPrefix}wxmsg:${quotedId}`, ...(quotedSender ? { senderId: accountPrefix + quotedSender } : {}) });
        if (!title && !quotedId)
            return null;
        return {
            ...base,
            text: title || "[引用消息]",
            parts,
            ...(quotedId
                ? { replyTo: { messageId: `${accountPrefix}wxmsg:${quotedId}`, ...(quotedSender ? { senderId: accountPrefix + quotedSender } : {}) } }
                : {}),
        };
    }
    const url = xmlTagText(xml, "url");
    if (url) {
        const description = xmlTagText(xml, "des")?.trim();
        const link = {
            type: "link",
            url,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
        };
        return { ...base, text: title || url, parts: [link] };
    }
    if (subType === "6" || subType === "8") {
        const fileExt = xmlTagText(xml, "fileext")?.trim();
        const name = title || (fileExt ? `微信附件.${fileExt}` : "微信附件");
        return {
            ...base,
            text: "",
            parts: [{ type: "file", asset: platformAsset(msgId, pluginId, `49:${subType}`), name }],
        };
    }
    return title ? { ...base, text: title, parts: [{ type: "text", text: title }] } : null;
}
function mediaEvent(base, type, asset, alt, xml) {
    const width = positiveXmlInteger(xml, "cdnthumbwidth");
    const height = positiveXmlInteger(xml, "cdnthumbheight");
    let part;
    if (type === "image")
        part = { type, asset, ...(alt ? { alt } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) };
    else if (type === "video")
        part = { type, asset, ...(width ? { width } : {}), ...(height ? { height } : {}) };
    else
        part = { type, asset };
    return { ...base, text: "", parts: [part] };
}
function platformAsset(msgId, pluginId, nativeType, nativeContent) {
    return {
        id: `wx-hook:${msgId}:${nativeType}`,
        source: "platform",
        locator: `message:${msgId}`,
        ownerPluginId: pluginId,
        metadata: { nativeType, ...(nativeType === "47" ? { kind: "emoji" } : {}), ...(nativeContent ? { nativeContent } : {}) },
    };
}
function nativeMessageIdFromEventId(eventId) {
    const marker = "wxmsg:";
    const markerIndex = eventId.lastIndexOf(marker);
    if (markerIndex < 0)
        return undefined;
    const nativeId = eventId.slice(markerIndex + marker.length);
    return /^\d{1,128}$/.test(nativeId) ? nativeId : undefined;
}
function quoteRequestFromPayload(payload) {
    const messageId = stringValue(payload.msgId);
    const localId = firstNonEmpty(payload.localId, payload.msgLocalId) ?? "0";
    const nativeType = stringValue(payload.type);
    const timestamp = stringValue(payload.timestamp);
    const roomId = firstNonEmpty(payload.roomId, endsWithChatroom(payload.from), endsWithChatroom(payload.peerWxId));
    const rawContent = typeof payload.content === "string" ? payload.content : "";
    const prefix = roomId ? splitGroupPrefix(rawContent) : undefined;
    const content = prefix?.body ?? rawContent;
    const xmlSender = xmlTagText(content, "fromusername");
    const sender = firstNonEmpty(nonRoomId(stringValue(payload.senderWxId), roomId), xmlSender, prefix?.sender, payload.from);
    const conversationId = firstNonEmpty(roomId, payload.peerWxId, payload.from, payload.rawFrom);
    if (!messageId || !/^\d+$/.test(messageId) || !nativeType || !timestamp || !content || !sender || !conversationId) {
        return undefined;
    }
    const signature = typeof payload.signature === "string" ? payload.signature : undefined;
    const sourceTo = firstNonEmpty(payload.selfWxId, payload.rawTo, payload.fromWxId);
    return {
        message_id: messageId,
        local_id: localId,
        content,
        sender_id: sender,
        type: nativeType,
        timestamp,
        conversation_id: conversationId,
        ...(signature ? { signature } : {}),
        ...(sourceTo ? { source_to: sourceTo } : {}),
    };
}
function parseNativeSendOperations(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const operations = [];
    for (const item of value) {
        if (!isRecord(item) || (item.type !== 1 && item.type !== 3 && item.type !== 5) || typeof item.content !== "string") {
            return undefined;
        }
        if (item.type === 5) {
            const quote = parseQuoteRequest(item.quote);
            if (!quote)
                return undefined;
            operations.push({ type: 5, content: item.content, quote });
        }
        else {
            const atUserList = parseAtUserList(item.atUserList);
            if (item.atUserList !== undefined && !atUserList)
                return undefined;
            operations.push({
                type: item.type,
                content: item.content,
                ...(atUserList?.length ? { atUserList } : {}),
            });
        }
    }
    return operations;
}
function parseAtUserList(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        return undefined;
    const result = [];
    for (const item of value) {
        if (typeof item !== "string")
            return undefined;
        const id = item.trim();
        if (!id || id.length > 256 || /[\t\r\n]/u.test(id))
            return undefined;
        result.push(id);
    }
    return [...new Set(result)];
}
function parseQuoteRequest(value) {
    if (!isRecord(value))
        return undefined;
    const messageId = stringValue(value.message_id);
    const localId = stringValue(value.local_id);
    const content = typeof value.content === "string" ? value.content : undefined;
    const senderId = stringValue(value.sender_id);
    const nativeType = stringValue(value.type);
    const timestamp = stringValue(value.timestamp);
    const conversationId = stringValue(value.conversation_id);
    if (!messageId || !localId || content === undefined || !senderId || !nativeType || !timestamp || !conversationId)
        return undefined;
    const signature = typeof value.signature === "string" ? value.signature : undefined;
    const sourceTo = stringValue(value.source_to);
    return {
        message_id: messageId,
        local_id: localId,
        content,
        sender_id: senderId,
        type: nativeType,
        timestamp,
        conversation_id: conversationId,
        ...(signature ? { signature } : {}),
        ...(sourceTo ? { source_to: sourceTo } : {}),
    };
}
export function verifyWxHookWebhookSignature(input) {
    return verifyWebhookSignature(Buffer.from(input.body), input.timestamp, input.signature, input.secret, input.maxTimestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS, input.now);
}
function verifyWebhookSignature(body, timestamp, signature, secret, maxTimestampSkewMs, now = Date.now()) {
    if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^sha256=[a-f\d]{64}$/i.test(signature))
        return false;
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds * 1000) > maxTimestampSkewMs)
        return false;
    const expected = `sha256=${createHmac("sha256", secret).update(timestamp, "ascii").update(".").update(body).digest("hex")}`;
    const suppliedBytes = Buffer.from(signature.toLowerCase(), "ascii");
    const expectedBytes = Buffer.from(expected, "ascii");
    return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}
function parseEnvelope(value) {
    if (!isRecord(value) || !isRecord(value.data))
        return undefined;
    const id = stringValue(value.id);
    const event = stringValue(value.event);
    const createdAt = stringValue(value.created_at);
    if (!id || id.length > 256 || !event || !createdAt)
        return undefined;
    return { id, event, created_at: createdAt, data: value.data };
}
function splitGroupPrefix(content) {
    const match = /^([^\r\n]{1,256}):\r?\n([\s\S]*)$/.exec(content);
    const sender = match?.[1]?.trim();
    return sender ? { sender, body: match[2] } : undefined;
}
function parseMentions(signature, prefix) {
    const list = signature ? xmlTagText(signature, "atuserlist") : undefined;
    if (!list)
        return [];
    return [...new Set(list.split(/[,;]/).map((item) => item.trim()).filter(Boolean))].map((id) => ({ id: prefix + id }));
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
function positiveXmlInteger(xml, attribute) {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\s*=\\s*["'](\\d+)["']`, "i").exec(xml);
    const value = match?.[1] ? Number(match[1]) : 0;
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function timestampMilliseconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return Date.now();
    return Math.round(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
}
async function orderSpoolFiles(directory, files) {
    const entries = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(join(directory, file))).mtimeMs })));
    entries.sort((left, right) => left.modified - right.modified || left.file.localeCompare(right.file));
    return entries.map((entry) => entry.file);
}
async function atomicCreateJson(path, value) {
    const temp = `${path}.tmp-${randomUUID()}`;
    await writeFile(temp, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
        await link(temp, path);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
    finally {
        await unlink(temp).catch(() => undefined);
    }
}
async function atomicReplaceJson(path, value) {
    const temp = `${path}.tmp-${randomUUID()}`;
    await writeFile(temp, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
        await rename(temp, path);
    }
    finally {
        await unlink(temp).catch(() => undefined);
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
function normalizedHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`Invalid HTTP URL: ${value}`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
        throw new Error(`Invalid HTTP URL: ${value}`);
    }
    if (!url.pathname.endsWith("/"))
        url.pathname += "/";
    return url;
}
function normalizedWebhookPath(value) {
    if (!value.startsWith("/") || value.includes("?") || value.includes("#"))
        throw new Error("webhook path must be an absolute URL path");
    return value.length > 1 ? value.replace(/\/+$/, "") : value;
}
function numberHeader(request, name) {
    const raw = header(request, name);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function header(request, name) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function firstNonEmpty(...values) {
    for (const value of values) {
        const normalized = stringValue(value);
        if (normalized)
            return normalized;
    }
    return undefined;
}
function endsWithChatroom(value) {
    const text = stringValue(value);
    return text?.endsWith("@chatroom") ? text : undefined;
}
function nonRoomId(value, roomId) {
    return value && value !== roomId && !value.endsWith("@chatroom") ? value : undefined;
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
    const displayName = safeGroupDisplayName((await resolver(roomId, senderId))?.trim(), event.sender.id);
    if (!displayName || displayName === event.sender.displayName)
        return event;
    return { ...event, sender: { ...event.sender, displayName } };
}
function parseResolvedMediaAsset(value) {
    if (!isRecord(value))
        return undefined;
    const id = stringValue(value.id);
    const messageId = stringValue(value.message_id);
    const variant = stringValue(value.variant);
    const mimeType = stringValue(value.mime_type)?.toLowerCase();
    const size = numberValue(value.size);
    const sha256 = stringValue(value.sha256)?.toLowerCase();
    const downloadUrl = stringValue(value.download_url);
    if (!id ||
        !/^[a-f0-9]{64}$/.test(id) ||
        !messageId ||
        !/^\d{1,128}$/.test(messageId) ||
        (variant !== "medium" && variant !== "thumbnail" && variant !== "original") ||
        !mimeType ||
        !["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(mimeType) ||
        size === undefined ||
        size < 1 ||
        size > MAX_GATEWAY_MEDIA_BYTES ||
        !sha256 ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        downloadUrl !== `/api/media/${id}`) {
        return undefined;
    }
    return {
        id,
        message_id: messageId,
        variant,
        mime_type: mimeType,
        size,
        sha256,
        download_url: downloadUrl,
    };
}
function parseStagedImageAsset(value) {
    if (!isRecord(value))
        return undefined;
    const id = stringValue(value.id)?.toLowerCase();
    const mimeType = stringValue(value.mime_type)?.toLowerCase();
    const size = numberValue(value.size);
    const sha256 = stringValue(value.sha256)?.toLowerCase();
    const windowsPath = stringValue(value.windows_path);
    if (!id || !/^[a-f0-9]{64}$/.test(id) ||
        !mimeType || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ||
        size === undefined || size < 1 || size > MAX_GATEWAY_MEDIA_BYTES ||
        !sha256 || !/^[a-f0-9]{64}$/.test(sha256) || sha256 !== id ||
        !windowsPath || !isWindowsAbsolutePath(windowsPath))
        return undefined;
    return { id, mime_type: mimeType, size, sha256, windows_path: windowsPath };
}
async function collectMediaBytes(content, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of content) {
        size += chunk.byteLength;
        if (size > maxBytes)
            throw new Error(`wx-hook outbound image exceeds the ${maxBytes} byte limit`);
        chunks.push(Buffer.from(chunk));
    }
    if (size === 0)
        throw new Error("wx-hook outbound image is empty");
    return Buffer.concat(chunks);
}
function sniffImageMimeType(data) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 16));
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
        return "image/jpeg";
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")
        return "image/gif";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
        return "image/webp";
    return undefined;
}
async function* verifiedMediaContent(body, expectedSize, expectedSha256) {
    const reader = body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    let complete = false;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done)
                break;
            const chunk = result.value;
            size += chunk.byteLength;
            if (size > expectedSize)
                throw new Error("wx-hook media body exceeds its declared size");
            hash.update(chunk);
            yield chunk;
        }
        if (size !== expectedSize)
            throw new Error("wx-hook media body size does not match its declaration");
        if (hash.digest("hex") !== expectedSha256)
            throw new Error("wx-hook media body failed SHA-256 verification");
        complete = true;
    }
    finally {
        if (!complete)
            await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
function stringValue(value) {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWindowsAbsolutePath(value) {
    return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
function safeFileName(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wx-hook-http";
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
        throw new Error(`${name} must be an integer between 0 and 65535`);
    return value;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function assertNever(value) {
    throw new Error(`Unsupported outbound message part: ${JSON.stringify(value)}`);
}
//# sourceMappingURL=wx-hook-http.js.map
