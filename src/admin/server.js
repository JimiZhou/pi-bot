import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { AdminStore } from "./admin-store.js";
import { parseBotConfig, parseGlobalSettings, parseKnowledgeProviderProfile, parseMcpServerProfile, parseModelProfile, parsePersonaProfile, parseProviderProfile, } from "./config.js";
import { probeProvider } from "./provider-client.js";
import { testModelConnection } from "./model-runtime.js";
import { probeKnowledgeProvider } from "../knowledge-retriever.js";
import { probeMcpServer } from "../mcp.js";
import { BUILT_IN_PLUGIN_DEFINITIONS, withImplicitBuiltInPlugins } from "../plugins/catalog.js";
import { compressForChat } from "../plugins/meme-generator.js";
import { customMemeInfo, getCustomMeme, listCustomMemes, saveCustomMeme } from "../meme-custom.js";
import { AgentSupervisor } from "./supervisor.js";
import { AISTUDIO_TTS_VOICES, DEFAULT_TTS_STYLE, DEFAULT_TTS_VOICE, TTS_VOICE_PRESETS, } from "../voice-style.js";
import { ChannelAdapterRegistry } from "../channel-adapter.js";
// Persona avatar presets are stored as data URLs; keep this below the hard 10 MiB constructor bound.
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MEME_API_BASE_URL = "http://127.0.0.1:2233";
const MEME_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
const MEME_INPUT_MAX_BYTES = 20 * 1024 * 1024;
const MEME_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const MEME_SEND_MAX_BYTES = 8 * 1024 * 1024;
const MEME_TIMEOUT_MS = 60_000;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../webui/", import.meta.url));
const BUILT_IN_PLUGINS = Object.freeze(BUILT_IN_PLUGIN_DEFINITIONS.map((plugin) => ({
    type: plugin.type,
    name: plugin.label,
    description: plugin.description,
})));
export class AdminServer {
    #store;
    #supervisor;
    #token;
    #host;
    #port;
    #allowPublicClients;
    #maxBodyBytes;
    #webRoot;
    #adapterRegistry;
    #server;
    constructor(options) {
        if (options.token.length < 24)
            throw new Error("Admin token must contain at least 24 characters");
        this.#store = options.store;
        this.#supervisor = options.supervisor;
        this.#token = Buffer.from(options.token);
        this.#host = options.host ?? "0.0.0.0";
        this.#port = boundedInteger(options.port ?? 8787, 0, 65_535, "admin port");
        this.#allowPublicClients = options.allowPublicClients ?? false;
        this.#maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 1024, 10 * 1024 * 1024, "maxBodyBytes");
        this.#webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
        this.#adapterRegistry = options.adapterRegistry ?? new ChannelAdapterRegistry();
    }
    async start() {
        if (this.#server)
            return this.address();
        const server = createServer((request, response) => {
            void this.#handle(request, response).catch((error) => this.#handleError(error, request, response));
        });
        server.requestTimeout = 15_000;
        server.headersTimeout = 10_000;
        server.keepAliveTimeout = 5000;
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.#port, this.#host, () => {
                server.off("error", reject);
                resolve();
            });
        });
        this.#server = server;
        const address = this.address();
        this.#log("info", "web.started", `管理界面已监听 ${address.host}:${address.port}`);
        return address;
    }
    async close() {
        const server = this.#server;
        if (!server)
            return;
        this.#server = undefined;
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    address() {
        const address = this.#server?.address();
        if (!address || typeof address === "string")
            return { host: this.#host, port: this.#port };
        return { host: address.address, port: address.port };
    }
    async #handle(request, response) {
        setSecurityHeaders(response);
        const url = new URL(request.url ?? "/", "http://admin.local");
        if (url.pathname === "/healthz") {
            replyJson(response, 200, { ok: true, uptimeMs: process.uptime() * 1000 });
            return;
        }
        if (!this.#allowPublicClients && !isPrivateClient(request.socket.remoteAddress)) {
            throw new HttpError(403, "private_network_required", "WebUI only accepts private-network clients");
        }
        if (!url.pathname.startsWith("/api/")) {
            await this.#serveStatic(url.pathname, response);
            return;
        }
        this.#assertSameOrigin(request);
        this.#authenticate(request);
        await this.#handleApi(request, response, url);
    }
    async #handleApi(request, response, url) {
        const method = request.method ?? "GET";
        if (method === "GET" && url.pathname === "/api/session") {
            replyJson(response, 200, { ok: true });
            return;
        }
        if (method === "GET" && url.pathname === "/api/v1/console-manifest") {
            replyJson(response, 200, {
                apiVersion: 1,
                modules: ["core", "adapters"],
                adapters: this.#adapterRegistry.list(),
            });
            return;
        }
        if (method === "GET" && url.pathname === "/api/bootstrap") {
            replyJson(response, 200, {
                settings: this.#store.getGlobalSettings(),
                providers: this.#store.listProviderProfiles(),
                knowledgeProviders: this.#store.listKnowledgeProviderProfiles(),
                mcpServers: this.#store.listMcpServerProfiles(),
                models: this.#store.listModelProfiles(),
                personas: this.#store.listPersonaProfiles(),
                bots: this.#store.listBots(),
                status: this.#supervisor.status(),
                tts: {
                    voices: AISTUDIO_TTS_VOICES,
                    presets: TTS_VOICE_PRESETS,
                    defaultVoice: DEFAULT_TTS_VOICE,
                    defaultStyle: DEFAULT_TTS_STYLE,
                },
            });
            return;
        }
        if (method === "GET" && url.pathname === "/api/status") {
            replyJson(response, 200, this.#supervisor.status());
            return;
        }
        if (method === "GET" && url.pathname === "/api/adapters") {
            const status = this.#supervisor.status();
            const statusByBotId = new Map(status.bots.map((bot) => [bot.id, bot]));
            replyJson(response, 200, {
                manifests: this.#adapterRegistry.list(),
                instances: this.#store.listBots().map((bot) => {
                    const runtime = statusByBotId.get(bot.id);
                    const manifest = this.#adapterRegistry.manifest(bot.channel.type);
                    return {
                        id: bot.id,
                        botId: bot.id,
                        type: bot.channel.type,
                        displayName: `${bot.displayName} · ${manifest?.displayName ?? bot.channel.type}`,
                        enabled: bot.enabled,
                        phase: runtime?.phase ?? "stopped",
                        healthy: runtime?.gatewayHealthy ?? false,
                        lastEventAt: runtime?.lastEventAt ?? null,
                        endpoint: runtime?.webhookAddress
                            ? `${runtime.webhookAddress.host}:${runtime.webhookAddress.port}${runtime.webhookAddress.path}`
                            : null,
                        features: manifest?.features ?? [],
                        capabilities: manifest?.capabilities ?? [],
                    };
                }),
            });
            return;
        }
        if (method === "GET" && url.pathname === "/api/meme-generator/memes") {
            const customMemes = await listCustomMemes();
            let payload = [];
            try {
                payload = await fetchMemeJson("memes/keys");
            }
            catch (error) {
                if (customMemes.length === 0)
                    throw error;
            }
            if (!Array.isArray(payload) || payload.some((item) => typeof item !== "string")) {
                throw new HttpError(502, "meme_service_invalid_response", "Meme service returned an invalid key list");
            }
            replyJson(response, 200, {
                keys: [...new Set([...customMemes.map((meme) => meme.key), ...payload.map((item) => item.trim()).filter(Boolean)])],
            });
            return;
        }
        const memeInfoMatch = /^\/api\/meme-generator\/memes\/([a-zA-Z0-9_-]{1,64})\/info$/.exec(url.pathname);
        if (method === "GET" && memeInfoMatch) {
            const key = memeInfoMatch[1];
            const custom = (await listCustomMemes()).find((meme) => meme.key === key);
            if (custom) {
                replyJson(response, 200, customMemeInfo(custom));
                return;
            }
            const payload = await fetchMemeJson(`memes/${encodeURIComponent(key)}/info`);
            replyJson(response, 200, normalizeMemeInfo(key, payload));
            return;
        }
        if (method === "POST" && url.pathname === "/api/meme-generator/custom") {
            const body = inputRecord(await readJson(request, Math.max(this.#maxBodyBytes, MEME_REQUEST_MAX_BYTES)));
            const key = requiredMemeKey(body.key);
            const [image] = memeInputImages([{ dataUrl: body.dataUrl }]);
            if (!image)
                throw new HttpError(400, "invalid_custom_meme", "Custom meme image is required");
            try {
                const saved = await saveCustomMeme({
                    key,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                    ...(optionalBodyText(body, "title", 120) ? { title: optionalBodyText(body, "title", 120) } : {}),
                    keywords: memeKeywords(body.keywords),
                });
                replyJson(response, 201, { meme: { ...saved, ...customMemeInfo(saved) } });
            }
            catch (error) {
                throw new HttpError(400, "custom_meme_save_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/meme-generator/generate") {
            const body = inputRecord(await readJson(request, Math.max(this.#maxBodyBytes, MEME_REQUEST_MAX_BYTES)));
            const key = requiredMemeKey(body.key);
            const images = memeInputImages(body.images);
            const texts = memeTexts(body.texts);
            const args = body.args === undefined ? {} : inputRecord(body.args);
            const custom = await getCustomMeme(key);
            if (custom) {
                if (images.length > 0 || texts.length > 0 || Object.keys(args).length > 0) {
                    throw new HttpError(400, "custom_meme_no_inputs", "Uploaded custom meme images do not accept extra input images, text, or arguments");
                }
                const compressed = await compressMemeForChat(custom.bytes, custom.mimeType);
                replyJson(response, 200, {
                    mimeType: compressed.mimeType,
                    size: compressed.bytes.byteLength,
                    data: Buffer.from(compressed.bytes).toString("base64"),
                });
                return;
            }
            const info = normalizeMemeInfo(key, await fetchMemeJson(`memes/${encodeURIComponent(key)}/info`));
            if (images.length < info.minImages || images.length > info.maxImages) {
                throw new HttpError(400, "meme_invalid_image_count", `“${memeDisplayName(info)}”需要 ${memeRangeText(info.minImages, info.maxImages)} 张图片，当前提供 ${images.length} 张`);
            }
            const effectiveTexts = texts.length === 0 ? info.defaultTexts : texts;
            if (effectiveTexts.length < info.minTexts || effectiveTexts.length > info.maxTexts) {
                throw new HttpError(400, "meme_invalid_text_count", `“${memeDisplayName(info)}”需要 ${memeRangeText(info.minTexts, info.maxTexts)} 段文字，当前提供 ${effectiveTexts.length} 段`);
            }
            const form = new FormData();
            images.forEach((image, index) => {
                form.append("images", new Blob([image.bytes], { type: image.mimeType }), `input-${index + 1}.${memeExtension(image.mimeType)}`);
            });
            effectiveTexts.forEach((text) => form.append("texts", text));
            form.append("args", JSON.stringify(args));
            const { response: upstream, bytes } = await fetchMemeResponse(`memes/${encodeURIComponent(key)}/`, {
                method: "POST",
                body: form,
            });
            if (!upstream.ok) throw memeUpstreamError(upstream.status, bytes);
            const mimeType = sniffMemeMimeType(bytes) ?? upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
            if (!mimeType?.startsWith("image/")) {
                throw new HttpError(502, "meme_service_invalid_response", "Meme service did not return an image");
            }
            const compressed = await compressMemeForChat(bytes, mimeType);
            replyJson(response, 200, {
                mimeType: compressed.mimeType,
                size: compressed.bytes.byteLength,
                data: Buffer.from(compressed.bytes).toString("base64"),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/meme-generator/save") {
            const body = inputRecord(await readJson(request, Math.max(this.#maxBodyBytes, MEME_REQUEST_MAX_BYTES)));
            const botId = requiredBodyText(body, "botId", 200);
            const key = requiredMemeKey(body.key);
            const [image] = memeInputImages([{ dataUrl: body.dataUrl }]);
            if (!image)
                throw new HttpError(400, "invalid_meme_image", "Generated meme image is required");
            const description = optionalBodyText(body, "description", 500) ?? `Meme ${key}`;
            const compressed = await compressMemeForChat(image.bytes, image.mimeType);
            try {
                const saved = await this.#supervisor.saveGeneratedEmoji(botId, {
                    data: compressed.bytes,
                    mimeType: compressed.mimeType,
                    name: `meme-${key}.${memeExtension(compressed.mimeType)}`,
                    description,
                    memeKey: key,
                });
                const { asset, ...emoji } = saved;
                replyJson(response, 200, { emoji: { ...emoji, mimeType: asset.mimeType, size: asset.size } });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new HttpError(/does not exist/u.test(message) ? 404 : 400, "meme_save_failed", message);
            }
            return;
        }
        if (method === "GET" && url.pathname === "/api/emojis") {
            const limitValue = Number(url.searchParams.get("limit") ?? "24");
            const offsetValue = Number(url.searchParams.get("offset") ?? "0");
            if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 48 ||
                !Number.isSafeInteger(offsetValue) || offsetValue < 0 || offsetValue > 1_000_000) {
                throw new HttpError(400, "invalid_pagination", "limit must be 1-48 and offset must be a non-negative integer");
            }
            const botId = url.searchParams.get("botId")?.trim() || undefined;
            const query = url.searchParams.get("q")?.normalize("NFKC").trim().toLocaleLowerCase().slice(0, 120) ?? "";
            const filtered = this.#store.listEmojis(botId).filter((emoji) =>
                !query || emoji.id.toLocaleLowerCase().includes(query) || emoji.description.toLocaleLowerCase().includes(query));
            const page = filtered.slice(offsetValue, offsetValue + limitValue);
            replyJson(response, 200, {
                emojis: page.map(({ asset, ...emoji }) => ({
                    ...emoji,
                    mimeType: asset.mimeType,
                    size: asset.size,
                })),
                total: filtered.length,
                limit: limitValue,
                offset: offsetValue,
                hasMore: offsetValue + page.length < filtered.length,
            });
            return;
        }
        const emojiContentMatch = /^\/api\/emojis\/([a-f\d-]+)\/content$/.exec(url.pathname);
        if (method === "GET" && emojiContentMatch) {
            try {
                const content = await this.#supervisor.emojiContent(emojiContentMatch[1]);
                response.writeHead(200, {
                    "Content-Type": content.mimeType,
                    "Content-Length": content.data.byteLength,
                    "Cache-Control": "private, max-age=300",
                    "X-Content-Type-Options": "nosniff",
                });
                response.end(content.data);
            }
            catch (error) {
                throw new HttpError(404, "emoji_not_found", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        const emojiMatch = /^\/api\/emojis\/([a-f\d-]+)$/.exec(url.pathname);
        if (method === "PATCH" && emojiMatch) {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const description = optionalBodyText(body, "description", 500);
            const enabled = optionalBodyBoolean(body, "enabled");
            const isThinking = optionalBodyBoolean(body, "isThinking");
            if (description === undefined && enabled === undefined && isThinking === undefined) {
                throw new HttpError(400, "invalid_config", "At least one emoji field is required");
            }
            try {
                const { asset, ...emoji } = this.#store.updateEmoji(emojiMatch[1], {
                    ...(description === undefined ? {} : { description }),
                    ...(enabled === undefined ? {} : { enabled }),
                    ...(isThinking === undefined ? {} : { isThinking }),
                });
                replyJson(response, 200, { emoji: { ...emoji, mimeType: asset.mimeType, size: asset.size } });
            }
            catch (error) {
                throw new HttpError(404, "emoji_not_found", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "DELETE" && emojiMatch) {
            if (!this.#store.deleteEmoji(emojiMatch[1]))
                throw new HttpError(404, "emoji_not_found", "Emoji not found");
            replyJson(response, 200, { deleted: true });
            return;
        }
        if (method === "GET" && url.pathname === "/api/participation/summary") {
            const botId = requiredQuery(url, "botId");
            replyJson(response, 200, { botId, summary: this.#supervisor.participationSummary(botId) });
            return;
        }
        if (method === "GET" && url.pathname === "/api/participation") {
            const botId = requiredQuery(url, "botId");
            const reviewValue = url.searchParams.get("review") ?? "unrated";
            if (!isParticipationReview(reviewValue)) {
                throw new HttpError(400, "invalid_review", "review must be all, unrated, speak, silent, or unsure");
            }
            const qualityReviewValue = url.searchParams.get("qualityReview") ?? "all";
            if (!isQualityReview(qualityReviewValue)) {
                throw new HttpError(400, "invalid_quality_review", "qualityReview must be all, unrated, helpful, unhelpful, or unsure");
            }
            const limit = optionalInteger(url.searchParams.get("limit"));
            const beforeCreatedAt = optionalInteger(url.searchParams.get("beforeCreatedAt"));
            replyJson(response, 200, {
                botId,
                cases: this.#supervisor.listParticipationCases(botId, {
                    review: reviewValue,
                    qualityReview: qualityReviewValue,
                    ...(url.searchParams.get("conversationId")
                        ? { conversationId: url.searchParams.get("conversationId") }
                        : {}),
                    ...(limit === undefined ? {} : { limit }),
                    ...(beforeCreatedAt === undefined ? {} : { beforeCreatedAt }),
                }),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/participation/label") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const botId = requiredBodyText(body, "botId", 128);
            const eventId = requiredBodyText(body, "eventId", 500);
            const label = body.label;
            if (label !== "speak" && label !== "silent" && label !== "unsure") {
                throw new HttpError(400, "invalid_label", "label must be speak, silent, or unsure");
            }
            const reason = optionalBodyText(body, "reason", 500);
            replyJson(response, 200, {
                case: this.#supervisor.labelParticipationCase(botId, eventId, label, reason),
                summary: this.#supervisor.participationSummary(botId),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/participation/quality") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const botId = requiredBodyText(body, "botId", 128);
            const eventId = requiredBodyText(body, "eventId", 500);
            const label = body.label;
            if (label !== "helpful" && label !== "unhelpful" && label !== "unsure") {
                throw new HttpError(400, "invalid_quality_label", "label must be helpful, unhelpful, or unsure");
            }
            const reason = optionalBodyText(body, "reason", 500);
            replyJson(response, 200, {
                case: this.#supervisor.labelReplyQualityCase(botId, eventId, label, reason),
                summary: this.#supervisor.participationSummary(botId),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/participation/prune") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const botId = requiredBodyText(body, "botId", 128);
            replyJson(response, 200, this.#supervisor.pruneParticipationCases(botId));
            return;
        }
        if (method === "GET" && url.pathname === "/api/catalog/providers") {
            replyJson(response, 200, {
                providers: [],
                apis: ["auto", "openai-completions", "openai-responses", "google-generative-ai", "anthropic-messages"],
            });
            return;
        }
        if (method === "GET" && url.pathname === "/api/catalog/models") {
            replyJson(response, 200, { models: [], source: "custom-provider-discovery" });
            return;
        }
        if (method === "GET" && url.pathname === "/api/providers") {
            replyJson(response, 200, { providers: this.#store.listProviderProfiles() });
            return;
        }
        if (method === "GET" && url.pathname === "/api/knowledge-providers") {
            replyJson(response, 200, { providers: this.#store.listKnowledgeProviderProfiles() });
            return;
        }
        if (method === "GET" && url.pathname === "/api/mcp-servers") {
            replyJson(response, 200, { servers: this.#store.listMcpServerProfiles() });
            return;
        }
        if (method === "POST" && url.pathname === "/api/mcp-servers/probe") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseMcpServerProfile(body));
            const secret = parseInput(() => mcpInputSecret(body)) ?? this.#store.getMcpServerSecret(profile.id);
            if (mcpProfileNeedsSecret(profile) && !secret)
                throw new HttpError(400, "secret_required", "MCP authentication secret is required");
            try {
                replyJson(response, 200, await probeMcpServer(profile, secret));
            }
            catch (error) {
                throw new HttpError(422, "mcp_probe_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/mcp-servers") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseMcpServerProfile(body));
            const secretUpdate = parseInput(() => mcpSecretUpdate(body));
            const existing = this.#store.getMcpServerProfile(profile.id);
            if (mcpProfileNeedsSecret(profile) && secretUpdate === undefined && !existing?.hasSecret) {
                throw new HttpError(400, "secret_required", "MCP authentication secret is required");
            }
            const saved = this.#store.saveMcpServerProfile(profile, mcpProfileNeedsSecret(profile) ? secretUpdate : null);
            this.#log("info", "config.mcp_server_saved", `MCP 服务 ${saved.id} 已保存`);
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { server: saved, status, applying: true });
            return;
        }
        const mcpServerMatch = /^\/api\/mcp-servers\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && mcpServerMatch) {
            const id = mcpServerMatch[1];
            if (!this.#store.deleteMcpServerProfile(id))
                throw new HttpError(404, "not_found", "MCP server not found");
            this.#log("warn", "config.mcp_server_deleted", `MCP 服务 ${id} 已删除`);
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { deleted: true, status, applying: true });
            return;
        }
        const mcpServerTestMatch = /^\/api\/mcp-servers\/([a-zA-Z0-9._-]+)\/test$/.exec(url.pathname);
        if (method === "POST" && mcpServerTestMatch) {
            const id = mcpServerTestMatch[1];
            const profile = this.#store.getMcpServerProfile(id);
            if (!profile)
                throw new HttpError(404, "not_found", "MCP server not found");
            try {
                const result = await probeMcpServer(profile, this.#store.getMcpServerSecret(id));
                this.#log("info", "mcp.probe_succeeded", `MCP 服务 ${id} 测试成功，发现 ${result.tools.length} 个工具`);
                replyJson(response, 200, result);
            }
            catch (error) {
                throw new HttpError(422, "mcp_probe_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/knowledge-providers/probe") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseKnowledgeProviderProfile(body));
            const apiKey = this.#knowledgeProviderApiKey(profile, body);
            const query = typeof inputRecord(body).query === "string" ? String(inputRecord(body).query).trim().slice(0, 500) : undefined;
            try {
                replyJson(response, 200, await probeKnowledgeProvider(profile, apiKey, query));
            }
            catch (error) {
                throw new HttpError(422, "knowledge_probe_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/knowledge-providers") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseKnowledgeProviderProfile(body));
            const apiKeyUpdate = parseInput(() => providerApiKeyUpdate(body));
            const existing = this.#store.getKnowledgeProviderProfile(profile.id);
            if (profile.kind !== "searxng" &&
                !profile.apiKeyEnv &&
                apiKeyUpdate === undefined &&
                !existing?.hasApiKey) {
                throw new HttpError(400, "api_key_required", "Enter an API key or configure an API key environment variable");
            }
            const saved = this.#store.saveKnowledgeProviderProfile(profile, apiKeyUpdate);
            this.#log("info", "config.knowledge_provider_saved", `联网检索配置 ${saved.id} 已保存`);
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { provider: saved, status, applying: true });
            return;
        }
        const knowledgeProviderMatch = /^\/api\/knowledge-providers\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && knowledgeProviderMatch) {
            const id = knowledgeProviderMatch[1];
            if (this.#store.getGlobalSettings().defaultKnowledgeProfileId === id) {
                throw new HttpError(409, "provider_in_use", "Knowledge provider is the global default");
            }
            if (!this.#store.deleteKnowledgeProviderProfile(id)) {
                throw new HttpError(404, "not_found", "Knowledge provider not found");
            }
            this.#log("warn", "config.knowledge_provider_deleted", `联网检索配置 ${id} 已删除`);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const knowledgeProviderTestMatch = /^\/api\/knowledge-providers\/([a-zA-Z0-9._-]+)\/test$/.exec(url.pathname);
        if (method === "POST" && knowledgeProviderTestMatch) {
            const id = knowledgeProviderTestMatch[1];
            const profile = this.#store.getKnowledgeProviderProfile(id);
            if (!profile)
                throw new HttpError(404, "not_found", "Knowledge provider not found");
            const apiKey = this.#knowledgeProviderApiKey(profile);
            try {
                const result = await probeKnowledgeProvider(profile, apiKey);
                this.#log("info", "knowledge.probe_succeeded", `联网检索 ${id} 测试成功，返回 ${result.resultCount} 条`);
                replyJson(response, 200, result);
            }
            catch (error) {
                throw new HttpError(422, "knowledge_probe_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/providers/probe") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseProviderProfile(body));
            const apiKey = this.#providerApiKey(profile, body);
            try {
                replyJson(response, 200, await probeProvider(profile, apiKey));
            }
            catch (error) {
                throw new HttpError(422, "provider_probe_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/providers") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parseProviderProfile(body));
            if (profile.api === "auto") {
                throw new HttpError(400, "protocol_not_selected", "Test auto detection or manually select an API protocol before saving");
            }
            const apiKeyUpdate = parseInput(() => providerApiKeyUpdate(body));
            const existing = this.#store.getProviderProfile(profile.id);
            if (!profile.apiKeyEnv && apiKeyUpdate === undefined && !existing?.hasApiKey) {
                throw new HttpError(400, "api_key_required", "Enter an API key or configure an API key environment variable");
            }
            const saved = this.#store.saveProviderProfile(profile, apiKeyUpdate);
            this.#log("info", "config.provider_saved", `Provider 配置 ${saved.id} 已保存`);
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { provider: saved, status, applying: true });
            return;
        }
        const providerMatch = /^\/api\/providers\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && providerMatch) {
            const id = providerMatch[1];
            const usage = this.#store.providerUsage(id);
            if (usage.modelIds.length > 0) {
                throw new HttpError(409, "provider_in_use", "Provider profile is still referenced", usage);
            }
            if (!this.#store.deleteProviderProfile(id))
                throw new HttpError(404, "not_found", "Provider profile not found");
            this.#log("warn", "config.provider_deleted", `Provider 配置 ${id} 已删除`);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const providerTestMatch = /^\/api\/providers\/([a-zA-Z0-9._-]+)\/test$/.exec(url.pathname);
        if (method === "POST" && providerTestMatch) {
            const id = providerTestMatch[1];
            const profile = this.#store.getProviderProfile(id);
            if (!profile)
                throw new HttpError(404, "not_found", "Provider profile not found");
            const apiKey = this.#providerApiKey(profile);
            try {
                const result = await probeProvider(profile, apiKey);
                this.#log("info", "provider.probe_succeeded", `Provider ${id} 测试成功，发现 ${result.modelCount} 个模型`);
                replyJson(response, 200, result);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.#log("warn", "provider.probe_failed", `Provider ${id} 测试失败`);
                throw new HttpError(422, "provider_probe_failed", message);
            }
            return;
        }
        if (method === "GET" && url.pathname === "/api/models") {
            replyJson(response, 200, { models: this.#store.listModelProfiles() });
            return;
        }
        if (method === "GET" && url.pathname === "/api/personas") {
            replyJson(response, 200, { personas: this.#store.listPersonaProfiles() });
            return;
        }
        if (method === "POST" && url.pathname === "/api/personas") {
            const body = await readJson(request, this.#maxBodyBytes);
            const profile = parseInput(() => parsePersonaProfile(body));
            const saved = this.#store.savePersonaProfile(profile);
            this.#log("info", "config.persona_saved", `人设 ${saved.label} 已保存`);
            replyJson(response, 200, { persona: saved, personas: this.#store.listPersonaProfiles() });
            return;
        }
        const personaMatch = /^\/api\/personas\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && personaMatch) {
            const id = personaMatch[1];
            const usage = this.#store.personaUsage(id);
            if (usage.global || usage.botIds.length > 0 || usage.chatrooms.length > 0) {
                throw new HttpError(409, "persona_in_use", "人设仍被全局配置、机器人、群聊或私聊会话使用", usage);
            }
            if (!this.#store.deletePersonaProfile(id))
                throw new HttpError(404, "not_found", "Persona not found");
            this.#log("warn", "config.persona_deleted", `人设 ${id} 已删除`);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const personaApplyMatch = /^\/api\/personas\/([a-zA-Z0-9._-]+)\/apply$/.exec(url.pathname);
        if (method === "POST" && personaApplyMatch) {
            const personaId = personaApplyMatch[1];
            if (!this.#store.getPersonaProfile(personaId))
                throw new HttpError(404, "not_found", "Persona not found");
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const botId = requiredBodyText(body, "botId", 64);
            const conversationId = optionalBodyText(body, "conversationId", 300);
            const result = await this.#supervisor.applyChannelIdentity(botId, personaId, {
                force: true,
                ...(conversationId ? { conversationId } : {}),
            });
            this.#log("info", "channel.persona_applied", `人设 ${personaId} 已手动应用到通道`, botId);
            replyJson(response, 200, { result, capabilities: this.#supervisor.channelCapabilities(botId) });
            return;
        }
        if (method === "POST" && url.pathname === "/api/models/test") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const profile = parseInput(() => parseModelProfile(body));
            this.#assertModelReference(profile);
            const provider = this.#store.getProviderProfile(profile.providerProfileId);
            const apiKey = this.#providerApiKey(provider);
            const image = body.testImage === true;
            try {
                replyJson(response, 200, await testModelConnection(profile, provider, apiKey, { image }));
            }
            catch (error) {
                throw new HttpError(422, "model_test_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "POST" && url.pathname === "/api/models") {
            const body = await readJson(request, this.#maxBodyBytes);
            const parsed = parseInput(() => parseModelProfile(body));
            this.#assertModelReference(parsed);
            const profile = this.#store.saveModelProfile(parsed);
            this.#log("info", "config.model_saved", `模型配置 ${profile.id} 已保存`);
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { model: profile, status, applying: true });
            return;
        }
        const modelMatch = /^\/api\/models\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && modelMatch) {
            const id = modelMatch[1];
            const usage = this.#store.modelUsage(id);
            if (usage.global || usage.botIds.length > 0) {
                throw new HttpError(409, "model_in_use", "Model profile is still referenced", usage);
            }
            if (!this.#store.deleteModelProfile(id))
                throw new HttpError(404, "not_found", "Model profile not found");
            this.#log("warn", "config.model_deleted", `模型配置 ${id} 已删除`);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const modelTestMatch = /^\/api\/models\/([a-zA-Z0-9._-]+)\/test$/.exec(url.pathname);
        if (method === "POST" && modelTestMatch) {
            const id = modelTestMatch[1];
            const profile = this.#store.getModelProfile(id);
            if (!profile)
                throw new HttpError(404, "not_found", "Model profile not found");
            this.#assertModelReference(profile);
            const provider = this.#store.getProviderProfile(profile.providerProfileId);
            const apiKey = this.#providerApiKey(provider);
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            try {
                const result = await testModelConnection(profile, provider, apiKey, { image: body.testImage === true });
                if (profile.api === "auto") {
                    this.#store.saveModelProfile({ ...profile, api: result.api });
                    this.#scheduleReconcileAll();
                }
                this.#log("info", "model.test_succeeded", `模型 ${id} 使用 ${result.api} 测试成功`);
                replyJson(response, 200, result);
            }
            catch (error) {
                this.#log("warn", "model.test_failed", `模型 ${id} 测试失败`);
                throw new HttpError(422, "model_test_failed", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "GET" && url.pathname === "/api/bots") {
            replyJson(response, 200, { bots: this.#store.listBots(), status: this.#supervisor.status().bots });
            return;
        }
        if (method === "GET" && url.pathname === "/api/chatrooms") {
            replyJson(response, 200, { chatrooms: await this.#supervisor.listChatrooms() });
            return;
        }
        const chatroomMessagesMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/chatrooms\/([^/]+)\/messages$/.exec(url.pathname);
        if (method === "GET" && chatroomMessagesMatch) {
            const botId = chatroomMessagesMatch[1];
            if (!this.#store.getBot(botId))
                throw new HttpError(404, "not_found", "Bot not found");
            const chatroomId = canonicalChatroomId(decodeURIComponent(chatroomMessagesMatch[2]));
            const limitValue = Number(url.searchParams.get("limit") ?? "50");
            const beforeValue = url.searchParams.get("beforeSequence");
            if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 200) {
                throw new HttpError(400, "invalid_limit", "limit must be an integer between 1 and 200");
            }
            const beforeSequence = beforeValue === null ? undefined : Number(beforeValue);
            if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
                throw new HttpError(400, "invalid_before_sequence", "beforeSequence must be a positive integer");
            }
            try {
                replyJson(response, 200, this.#supervisor.listChatroomMessages(botId, chatroomId, {
                    limit: limitValue,
                    ...(beforeSequence !== undefined ? { beforeSequence } : {}),
                }));
            }
            catch (error) {
                throw new HttpError(404, "chatroom_not_found", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        const chatroomSendMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/chatrooms\/([^/]+)\/send$/.exec(url.pathname);
        if (method === "POST" && chatroomSendMatch) {
            const botId = chatroomSendMatch[1];
            if (!this.#store.getBot(botId))
                throw new HttpError(404, "not_found", "Bot not found");
            const chatroomId = canonicalChatroomId(decodeURIComponent(chatroomSendMatch[2]));
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            if (body.text !== undefined && typeof body.text !== "string") {
                throw new HttpError(400, "invalid_message", "text must be a string");
            }
            if (body.emojiId !== undefined && typeof body.emojiId !== "string") {
                throw new HttpError(400, "invalid_message", "emojiId must be a string");
            }
            const text = typeof body.text === "string" ? body.text.normalize("NFKC").trim() : "";
            const emojiId = typeof body.emojiId === "string" ? body.emojiId.normalize("NFKC").trim() : "";
            if ((!text && !emojiId) || (text && emojiId)) {
                throw new HttpError(400, "invalid_message", "Choose exactly one of text or emojiId");
            }
            try {
                replyJson(response, 200, await this.#supervisor.sendChatroomMessage(botId, chatroomId, {
                    ...(text ? { text } : {}),
                    ...(emojiId ? { emojiId } : {}),
                }));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const status = /not running|not healthy/u.test(message) ? 409 : /has not been discovered|does not exist/u.test(message) ? 404 : 400;
                throw new HttpError(status, "chatroom_send_failed", message);
            }
            return;
        }
        const chatroomMemoriesMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/chatrooms\/([^/]+)\/memories(?:\/([^/]+))?$/.exec(url.pathname);
        if (chatroomMemoriesMatch && (method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE")) {
            const botId = chatroomMemoriesMatch[1];
            if (!this.#store.getBot(botId))
                throw new HttpError(404, "not_found", "Bot not found");
            const chatroomId = canonicalChatroomId(decodeURIComponent(chatroomMemoriesMatch[2]));
            try {
                if (method === "GET") {
                    if (chatroomMemoriesMatch[3])
                        throw new HttpError(405, "method_not_allowed", "Memory id is not valid for GET");
                    replyJson(response, 200, this.#supervisor.listChatroomMemories(botId, chatroomId));
                    return;
                }
                if (method === "POST") {
                    if (chatroomMemoriesMatch[3])
                        throw new HttpError(405, "method_not_allowed", "Memory id is not valid for POST");
                    const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                    if (body.scope !== "conversation" && body.scope !== "person") {
                        throw new HttpError(400, "invalid_memory", "scope must be conversation or person");
                    }
                    const importance = body.importance ?? 0.7;
                    if (typeof importance !== "number")
                        throw new HttpError(400, "invalid_memory", "importance must be a number");
                    const expiresInDays = body.expiresInDays;
                    if (expiresInDays !== undefined && typeof expiresInDays !== "number") {
                        throw new HttpError(400, "invalid_memory", "expiresInDays must be a number");
                    }
                    const memory = this.#supervisor.createChatroomMemory(botId, chatroomId, {
                        scope: body.scope,
                        ...(typeof body.personId === "string" ? { personId: body.personId } : {}),
                        kind: optionalBodyText(body, "kind", 80) ?? "fact",
                        content: requiredBodyText(body, "content", 1000),
                        importance,
                        ...(typeof expiresInDays === "number" ? { expiresInDays } : {}),
                    });
                    this.#log("info", "memory.admin_saved", `管理员为群聊 ${chatroomId} 新增持久记忆`, botId);
                    replyJson(response, 200, { memory, ...this.#supervisor.listChatroomMemories(botId, chatroomId) });
                    return;
                }
                const encodedMemoryId = chatroomMemoriesMatch[3];
                if (!encodedMemoryId)
                    throw new HttpError(400, "invalid_memory", "Memory id is required");
                const memoryId = decodeURIComponent(encodedMemoryId);
                if (!/^mem:[a-fA-F0-9-]{16,80}$/u.test(memoryId)) {
                    throw new HttpError(400, "invalid_memory", "Memory id is invalid");
                }
                if (method === "PATCH") {
                    const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                    const extendDays = body.extendDays;
                    if (extendDays !== undefined && typeof extendDays !== "number") {
                        throw new HttpError(400, "invalid_memory", "extendDays must be a number");
                    }
                    const memory = this.#supervisor.confirmChatroomMemory(botId, chatroomId, memoryId, typeof extendDays === "number" ? extendDays : undefined);
                    this.#log("info", "memory.admin_confirmed", `管理员确认了群聊 ${chatroomId} 的持久记忆`, botId);
                    replyJson(response, 200, { memory, ...this.#supervisor.listChatroomMemories(botId, chatroomId) });
                    return;
                }
                this.#supervisor.deleteChatroomMemory(botId, chatroomId, memoryId);
                this.#log("warn", "memory.admin_deleted", `管理员删除了群聊 ${chatroomId} 的持久记忆`, botId);
                replyJson(response, 200, { deleted: true, ...this.#supervisor.listChatroomMemories(botId, chatroomId) });
            }
            catch (error) {
                if (error instanceof HttpError)
                    throw error;
                const message = error instanceof Error ? error.message : String(error);
                const status = /not been discovered|does not exist|not found/iu.test(message) ? 404 : 400;
                throw new HttpError(status, "chatroom_memory_failed", message);
            }
            return;
        }
        if (method === "GET" && url.pathname === "/api/plugins") {
            replyJson(response, 200, {
                catalog: BUILT_IN_PLUGINS,
                bots: this.#store.listBots().map((bot) => ({
                    id: bot.id,
                    displayName: bot.displayName,
                    plugins: withImplicitBuiltInPlugins(bot.plugins),
                })),
            });
            return;
        }
        if (method === "GET" && url.pathname === "/api/scheduled-tasks") {
            const botId = url.searchParams.get("botId") || undefined;
            const conversationId = url.searchParams.get("conversationId") || undefined;
            replyJson(response, 200, {
                tasks: this.#store.listScheduledTasks({ ...(botId ? { botId } : {}), ...(conversationId ? { conversationId } : {}) }),
            });
            return;
        }
        const scheduledTaskMatch = /^\/api\/scheduled-tasks\/(task-[a-fA-F0-9-]+)$/.exec(url.pathname);
        if (method === "PUT" && scheduledTaskMatch) {
            const id = scheduledTaskMatch[1];
            if (!this.#store.listScheduledTasks().some((task) => task.id === id)) {
                throw new HttpError(404, "not_found", "Scheduled task not found");
            }
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const input = {
                ...(typeof body.title === "string" ? { title: body.title } : {}),
                ...(typeof body.content === "string" ? { content: body.content } : {}),
                ...(body.schedule === undefined
                    ? {}
                    : { schedule: parseInput(() => parseScheduledTaskSchedule(body.schedule)) }),
                ...(typeof body.timezoneOffsetMinutes === "number" ? { timezoneOffsetMinutes: body.timezoneOffsetMinutes } : {}),
                ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            };
            try {
                const task = this.#store.updateScheduledTask(id, input);
                this.#log("info", "scheduled_task.updated", `定时任务 ${task.title} 已更新`, task.botId);
                replyJson(response, 200, { task });
            }
            catch (error) {
                throw new HttpError(400, "invalid_scheduled_task", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "DELETE" && scheduledTaskMatch) {
            const id = scheduledTaskMatch[1];
            const existing = this.#store.listScheduledTasks().find((task) => task.id === id);
            if (!existing)
                throw new HttpError(404, "not_found", "Scheduled task not found");
            this.#store.deleteScheduledTask(id);
            this.#log("warn", "scheduled_task.deleted", `定时任务 ${existing.title} 已删除`, existing.botId);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const botPluginsMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/plugins$/.exec(url.pathname);
        if (method === "PUT" && botPluginsMatch) {
            const id = botPluginsMatch[1];
            const existing = this.#store.getBot(id);
            if (!existing)
                throw new HttpError(404, "not_found", "Bot not found");
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            const bot = parseInput(() => parseBotConfig({ ...existing, plugins: body.plugins }));
            const knownTypes = new Set(BUILT_IN_PLUGINS.map((plugin) => plugin.type));
            const unknown = bot.plugins.find((plugin) => !knownTypes.has(plugin.type));
            if (unknown)
                throw new HttpError(400, "unknown_plugin", `Unknown built-in plugin type: ${unknown.type}`);
            this.#store.saveBot(bot);
            this.#log("info", "config.plugins_saved", `机器人 ${id} 的插件配置已保存`, id);
            const affectedBotIds = [id, ...this.#supervisor.synchronizeAgentConfiguration(id)];
            const status = this.#scheduleReconcile(affectedBotIds);
            replyJson(response, 200, {
                bot: { id: bot.id, displayName: bot.displayName, plugins: bot.plugins },
                status: status.bots.find((item) => item.id === bot.id),
                applying: true,
            });
            return;
        }
        const botChatroomsMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/chatrooms$/.exec(url.pathname);
        if (method === "POST" && url.pathname === "/api/chatrooms/context-reset") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 200) {
                throw new HttpError(400, "invalid_targets", "targets must contain 1-200 chatrooms");
            }
            const targets = [];
            const seen = new Set();
            for (const [index, raw] of body.targets.entries()) {
                const target = inputRecord(raw);
                if (typeof target.botId !== "string" || typeof target.chatroomId !== "string") {
                    throw new HttpError(400, "invalid_target", `targets[${index}] is invalid`);
                }
                if (!this.#store.getBot(target.botId))
                    throw new HttpError(404, "not_found", `Bot ${target.botId} not found`);
                const chatroomId = canonicalChatroomId(target.chatroomId);
                const key = chatroomId;
                if (seen.has(key))
                    continue;
                seen.add(key);
                targets.push({ botId: target.botId, chatroomId });
            }
            try {
                for (const target of targets)
                    this.#supervisor.listChatroomMemories(target.botId, target.chatroomId);
                const resets = targets.map((target) => this.#supervisor.resetChatroomContext(target.botId, target.chatroomId));
                for (const botId of new Set(targets.map((target) => target.botId))) {
                    this.#log("warn", "context.admin_reset", `管理员通过 Web 重置了 ${targets.filter((item) => item.botId === botId).length} 个群聊上下文`, botId);
                }
                replyJson(response, 200, {
                    reset: resets.length,
                    resets,
                    chatrooms: await this.#supervisor.listChatrooms(),
                });
            }
            catch (error) {
                throw new HttpError(404, "chatroom_not_found", error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (method === "PUT" && url.pathname === "/api/chatrooms/bulk") {
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 200) {
                throw new HttpError(400, "invalid_targets", "targets must contain 1-200 chatrooms");
            }
            const hasPersonaChange = Object.prototype.hasOwnProperty.call(body, "personaProfileId");
            const hasParticipationIntensityChange = Object.prototype.hasOwnProperty.call(body, "participationIntensity");
            const rawParticipationIntensity = body.participationIntensity;
            if (hasParticipationIntensityChange &&
                rawParticipationIntensity !== "conservative" && rawParticipationIntensity !== "standard" && rawParticipationIntensity !== "active") {
                throw new HttpError(400, "invalid_participation_intensity", "participationIntensity must be conservative, standard, or active");
            }
            const participationIntensity = rawParticipationIntensity === "conservative" || rawParticipationIntensity === "standard" || rawParticipationIntensity === "active"
                ? rawParticipationIntensity
                : undefined;
            const personaProfileId = body.personaProfileId === null ? null
                : typeof body.personaProfileId === "string" ? body.personaProfileId : undefined;
            if (hasPersonaChange && personaProfileId === undefined) {
                throw new HttpError(400, "invalid_persona", "personaProfileId must be a persona id or null");
            }
            if (personaProfileId && !this.#store.getPersonaProfile(personaProfileId)) {
                throw new HttpError(400, "missing_persona", `Persona profile ${personaProfileId} does not exist`);
            }
            const rawPluginChanges = body.pluginChanges === undefined ? {} : inputRecord(body.pluginChanges);
            const knownPluginTypes = new Set(BUILT_IN_PLUGINS.map((plugin) => plugin.type));
            const pluginChanges = Object.entries(rawPluginChanges).map(([pluginType, enabled]) => {
                if (!knownPluginTypes.has(pluginType) || typeof enabled !== "boolean") {
                    throw new HttpError(400, "invalid_plugin_change", `Invalid plugin change: ${pluginType}`);
                }
                return { pluginType, enabled };
            });
            if (!hasPersonaChange && !hasParticipationIntensityChange && pluginChanges.length === 0) {
                throw new HttpError(400, "empty_bulk_change", "Select a persona or at least one plugin change");
            }
            const grouped = new Map();
            const personaResetTargets = [];
            for (const [index, raw] of body.targets.entries()) {
                const target = inputRecord(raw);
                if (typeof target.botId !== "string" || typeof target.chatroomId !== "string") {
                    throw new HttpError(400, "invalid_target", `targets[${index}] is invalid`);
                }
                const roomId = canonicalChatroomId(target.chatroomId);
                const rooms = grouped.get(target.botId) ?? [];
                if (!rooms.includes(roomId))
                    rooms.push(roomId);
                grouped.set(target.botId, rooms);
            }
            for (const [botId, roomIds] of grouped) {
                const bot = this.#store.getBot(botId);
                if (!bot)
                    throw new HttpError(404, "not_found", `Bot ${botId} not found`);
                const overrides = [...bot.chatroomModelOverrides];
                for (const roomId of roomIds) {
                    const index = overrides.findIndex((item) => canonicalChatroomId(item.chatroomId) === roomId);
                    const existing = index >= 0 ? overrides[index] : {
                        chatroomId: roomId,
                        chatModelProfileId: null,
                        visionModelProfileId: null,
                        personaProfileId: null,
                        managerIds: [],
                        redEnvelopeTargetIds: [],
                        pluginOverrides: [],
                    };
                    if (hasPersonaChange && (existing.personaProfileId ?? null) !== personaProfileId) {
                        personaResetTargets.push({ botId, chatroomId: roomId });
                    }
                    const byType = new Map(existing.pluginOverrides.map((item) => [item.pluginType, item]));
                    for (const change of pluginChanges)
                        byType.set(change.pluginType, change);
                    const updated = {
                        ...existing,
                        ...(hasPersonaChange ? { personaProfileId: personaProfileId } : {}),
                        ...(hasParticipationIntensityChange ? { participationIntensity: participationIntensity } : {}),
                        pluginOverrides: [...byType.values()],
                    };
                    if (index >= 0)
                        overrides[index] = updated;
                    else
                        overrides.push(updated);
                }
                const parsed = parseInput(() => parseBotConfig({ ...bot, chatroomModelOverrides: overrides }));
                this.#assertBotReferences(parsed);
                this.#store.saveBot(parsed);
            }
            const affectedBotIds = new Set(grouped.keys());
            for (const [botId, roomIds] of grouped) {
                for (const roomId of roomIds) {
                    for (const peerId of this.#supervisor.synchronizeChatroomConfiguration(botId, roomId)) {
                        affectedBotIds.add(peerId);
                    }
                }
            }
            let contextResets = 0;
            for (const target of personaResetTargets) {
                try {
                    this.#supervisor.resetChatroomContext(target.botId, target.chatroomId);
                    contextResets += 1;
                }
                catch (error) {
                    this.#log("warn", "context.auto_reset_failed", `群聊 ${target.chatroomId} 切换人设后的上下文自动重置失败：${error instanceof Error ? error.message : String(error)}`, target.botId);
                }
            }
            this.#scheduleReconcile([...affectedBotIds]);
            let identitySyncs = 0;
            if (hasPersonaChange && personaProfileId) {
                const persona = this.#store.getPersonaProfile(personaProfileId);
                if (persona?.autoApplyAccountProfile) {
                    for (const target of body.targets) {
                        try {
                            await this.#supervisor.applyChannelIdentity(target.botId, persona.id, { conversationId: target.chatroomId });
                            identitySyncs += 1;
                        }
                        catch (error) {
                            this.#log("warn", "channel.persona_identity_apply_failed", error instanceof Error ? error.message : String(error), target.botId);
                        }
                    }
                }
            }
            this.#log("info", "config.chatrooms_bulk_saved", `已批量更新 ${body.targets.length} 个群聊`);
            replyJson(response, 200, {
                updated: body.targets.length,
                contextResets,
                identitySyncs,
                chatrooms: await this.#supervisor.listChatrooms(),
            });
            return;
        }
        if (botChatroomsMatch && (method === "PUT" || method === "DELETE")) {
            const id = botChatroomsMatch[1];
            const existing = this.#store.getBot(id);
            if (!existing)
                throw new HttpError(404, "not_found", "Bot not found");
            const body = method === "PUT" ? inputRecord(await readJson(request, this.#maxBodyBytes)) : undefined;
            const requestedId = method === "DELETE" ? url.searchParams.get("chatroomId") : body?.chatroomId;
            if (typeof requestedId !== "string" || !requestedId.trim()) {
                throw new HttpError(400, "invalid_chatroom", "chatroomId is required");
            }
            const canonicalId = canonicalChatroomId(requestedId);
            const previousOverride = existing.chatroomModelOverrides.find((override) => canonicalChatroomId(override.chatroomId) === canonicalId);
            const previousPersonaProfileId = previousOverride?.personaProfileId ?? null;
            let overrides = existing.chatroomModelOverrides.filter((override) => canonicalChatroomId(override.chatroomId) !== canonicalId);
            if (method === "PUT") {
                const candidate = {
                    chatroomId: canonicalId,
                    ...(typeof body.label === "string" && body.label.trim() ? { label: body.label } : {}),
                    chatModelProfileId: body.chatModelProfileId ?? null,
                    visionModelProfileId: body.visionModelProfileId ?? null,
                    personaProfileId: body.personaProfileId ?? null,
                    ttsVoice: body.ttsVoice ?? null,
                    ttsStyle: body.ttsStyle ?? null,
                    participationIntensity: body.participationIntensity ?? "standard",
                    managerIds: body.managerIds ?? [],
                    redEnvelopeTargetIds: body.redEnvelopeTargetIds ?? [],
                    pluginOverrides: body.pluginOverrides ?? [],
                };
                const parsed = parseInput(() => parseBotConfig({ ...existing, chatroomModelOverrides: [...overrides, candidate] }));
                const parsedOverride = parsed.chatroomModelOverrides.find((item) => canonicalChatroomId(item.chatroomId) === canonicalId);
                if (parsedOverride.managerIds.length > 0 || parsedOverride.redEnvelopeTargetIds.length > 0) {
                    const members = this.#supervisor.listChatroomMemories(id, canonicalId).members.filter((member) => !member.isBot);
                    const known = new Set(members.map((member) => canonicalIdentityId(member.id)));
                    const unknown = parsedOverride.managerIds.find((managerId) => !known.has(canonicalIdentityId(managerId)));
                    if (unknown) {
                        throw new HttpError(400, "unknown_chatroom_manager", `${unknown} is not a known non-bot member of this chatroom`);
                    }
                    const unknownTarget = parsedOverride.redEnvelopeTargetIds.find((targetId) => !known.has(canonicalIdentityId(targetId)));
                    if (unknownTarget) {
                        throw new HttpError(400, "unknown_red_envelope_target", `${unknownTarget} is not a known non-bot member of this chatroom`);
                    }
                }
                overrides = parsed.chatroomModelOverrides;
            }
            const bot = parseInput(() => parseBotConfig({ ...existing, chatroomModelOverrides: overrides }));
            const nextOverride = bot.chatroomModelOverrides.find((override) => canonicalChatroomId(override.chatroomId) === canonicalId);
            const personaChanged = previousPersonaProfileId !== (nextOverride?.personaProfileId ?? null);
            this.#assertBotReferences(bot);
            this.#store.saveBot(bot);
            const affectedBotIds = [id, ...this.#supervisor.synchronizeChatroomConfiguration(id, canonicalId)];
            this.#log("info", "config.chatroom_saved", `机器人 ${id} 的群聊 ${canonicalId} 配置已${method === "DELETE" ? "删除" : "保存"}`, id);
            let contextReset = false;
            if (personaChanged) {
                try {
                    this.#supervisor.resetChatroomContext(id, canonicalId);
                    contextReset = true;
                }
                catch (error) {
                    this.#log("warn", "context.auto_reset_failed", `群聊 ${canonicalId} 切换人设后的上下文自动重置失败：${error instanceof Error ? error.message : String(error)}`, id);
                }
            }
            const status = this.#scheduleReconcile(affectedBotIds);
            let identitySync;
            const selectedPersonaId = nextOverride?.personaProfileId ?? null;
            const selectedPersona = selectedPersonaId ? this.#store.getPersonaProfile(selectedPersonaId) : undefined;
            if (personaChanged && selectedPersona?.autoApplyAccountProfile) {
                try {
                    identitySync = await this.#supervisor.applyChannelIdentity(id, selectedPersona.id, { conversationId: canonicalId });
                }
                catch (error) {
                    this.#log("warn", "channel.persona_identity_apply_failed", error instanceof Error ? error.message : String(error), id);
                }
            }
            replyJson(response, 200, {
                bot: this.#store.getBot(id) ?? bot,
                contextReset,
                status: status.bots.find((item) => item.id === id),
                applying: true,
                ...(identitySync ? { identitySync } : {}),
                chatrooms: await this.#supervisor.listChatrooms(),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/bots") {
            const body = await readJson(request, this.#maxBodyBytes);
            const bot = parseInput(() => parseBotConfig(body));
            this.#assertBotReferences(bot);
            this.#store.saveBot(bot);
            const affectedBotIds = [bot.id, ...this.#supervisor.synchronizeAgentConfiguration(bot.id)];
            this.#log("info", "config.bot_saved", `机器人配置 ${bot.id} 已保存`, bot.id);
            const status = this.#scheduleReconcile(affectedBotIds);
            replyJson(response, 200, {
                bot,
                status: status.bots.find((item) => item.id === bot.id),
                applying: true,
            });
            return;
        }
        const botMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && botMatch) {
            const id = botMatch[1];
            if (!this.#store.getBot(id))
                throw new HttpError(404, "not_found", "Bot not found");
            await this.#supervisor.stopBot(id);
            this.#store.deleteBot(id);
            await this.#supervisor.reconcileBot(id);
            this.#log("warn", "config.bot_deleted", `机器人配置 ${id} 已删除`, id);
            replyJson(response, 200, { deleted: true });
            return;
        }
        const actionMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/(start|stop|restart|gateway-check|webhook-register|webhook-test)$/.exec(url.pathname);
        if (method === "POST" && actionMatch) {
            const id = actionMatch[1];
            const action = actionMatch[2];
            const bot = this.#store.getBot(id);
            if (!bot)
                throw new HttpError(404, "not_found", "Bot not found");
            if (action === "gateway-check") {
                replyJson(response, 200, { health: await this.#supervisor.checkGateway(id) });
                return;
            }
            if (action === "webhook-test") {
                replyJson(response, 200, await this.#supervisor.testWebhook(id));
                return;
            }
            if (action === "webhook-register") {
                const body = await readJson(request, this.#maxBodyBytes);
                if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
                    throw new HttpError(400, "invalid_webhook_url", "Webhook URL is required");
                }
                replyJson(response, 200, await this.#supervisor.ensureWebhook(id, body.url));
                return;
            }
            if (action === "start" && !bot.enabled)
                this.#store.saveBot({ ...bot, enabled: true });
            if (action === "stop" && bot.enabled)
                this.#store.saveBot({ ...bot, enabled: false });
            const status = this.#scheduleReconcile([id]);
            replyJson(response, 200, { status: status.bots.find((item) => item.id === id), applying: true });
            return;
        }
        if (method === "GET" && url.pathname === "/api/settings") {
            replyJson(response, 200, { settings: this.#store.getGlobalSettings() });
            return;
        }
        if (method === "PUT" && url.pathname === "/api/settings") {
            const body = await readJson(request, this.#maxBodyBytes);
            const settings = parseInput(() => parseGlobalSettings(body));
            for (const id of [settings.defaultChatModelProfileId, settings.defaultVisionModelProfileId]) {
                if (id && !this.#store.getModelProfile(id))
                    throw new HttpError(400, "missing_model", `Model profile ${id} does not exist`);
            }
            if (settings.defaultKnowledgeProfileId && !this.#store.getKnowledgeProviderProfile(settings.defaultKnowledgeProfileId)) {
                throw new HttpError(400, "missing_knowledge_provider", "Default knowledge provider does not exist");
            }
            if (settings.defaultPersonaProfileId && !this.#store.getPersonaProfile(settings.defaultPersonaProfileId)) {
                throw new HttpError(400, "missing_persona", "Default persona does not exist");
            }
            this.#store.saveGlobalSettings(settings);
            this.#store.pruneLogs(settings);
            this.#log("info", "config.settings_saved", "全局设置已保存");
            const status = this.#scheduleReconcileAll();
            replyJson(response, 200, { settings, status, applying: true });
            return;
        }
        if (method === "GET" && url.pathname === "/api/logs") {
            const levelValue = url.searchParams.get("level") || undefined;
            if (levelValue !== undefined && !isLogLevel(levelValue)) {
                throw new HttpError(400, "invalid_level", "Invalid log level");
            }
            const limit = optionalInteger(url.searchParams.get("limit"));
            const beforeId = optionalInteger(url.searchParams.get("beforeId"));
            replyJson(response, 200, {
                logs: this.#store.listLogs({
                    ...(limit === undefined ? {} : { limit }),
                    ...(beforeId === undefined ? {} : { beforeId }),
                    ...(levelValue ? { level: levelValue } : {}),
                    ...(url.searchParams.get("botId") ? { botId: url.searchParams.get("botId") } : {}),
                    ...(url.searchParams.get("q") ? { query: url.searchParams.get("q") } : {}),
                }),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/api/logs/prune") {
            replyJson(response, 200, this.#store.pruneLogs());
            return;
        }
        throw new HttpError(404, "not_found", "API route not found");
    }
    #scheduleReconcile(botIds) {
        const ids = [...new Set(botIds)];
        if (typeof this.#supervisor.scheduleReconcile === "function") {
            return this.#supervisor.scheduleReconcile(ids);
        }
        const operation = Promise.all(ids.map((id) => this.#supervisor.reconcileBot(id)));
        void operation.catch((error) => {
            this.#log("error", "bot.reconcile_failed", error instanceof Error ? error.message : String(error));
        });
        return this.#supervisor.status();
    }
    #scheduleReconcileAll() {
        if (typeof this.#supervisor.scheduleReconcileAll === "function") {
            return this.#supervisor.scheduleReconcileAll();
        }
        return this.#scheduleReconcile(this.#store.listBots().map((bot) => bot.id));
    }
    #assertBotReferences(bot) {
        const ids = [
            bot.chatModelProfileId,
            bot.fastChatModelProfileId,
            bot.participationJudgeModelProfileId,
            ...bot.fallbackChatModelProfileIds,
            bot.visionModelProfileId,
            ...bot.chatroomModelOverrides.flatMap((override) => [
                override.chatModelProfileId,
                override.visionModelProfileId,
            ]),
        ];
        for (const id of ids) {
            if (id && !this.#store.getModelProfile(id))
                throw new HttpError(400, "missing_model", `Model profile ${id} does not exist`);
        }
        const primaryId = bot.chatModelProfileId ?? this.#store.getGlobalSettings().defaultChatModelProfileId;
        if (primaryId && bot.fallbackChatModelProfileIds.includes(primaryId)) {
            throw new HttpError(400, "invalid_model_chain", "Primary chat model cannot also appear in the fallback chain");
        }
        let previousTier = -1;
        for (const id of bot.fallbackChatModelProfileIds) {
            const profile = this.#store.getModelProfile(id);
            const provider = this.#store.getProviderProfile(profile.providerProfileId);
            const tier = modelFallbackTier(profile, provider);
            if (tier < previousTier) {
                throw new HttpError(400, "invalid_model_chain", "Fallback order must keep Gemini first, remote GPT/compatible models next, and local models last");
            }
            previousTier = tier;
        }
        if (bot.personaProfileId && !this.#store.getPersonaProfile(bot.personaProfileId)) {
            throw new HttpError(400, "missing_persona", `Persona profile ${bot.personaProfileId} does not exist`);
        }
        for (const override of bot.chatroomModelOverrides) {
            if (override.personaProfileId && !this.#store.getPersonaProfile(override.personaProfileId)) {
                throw new HttpError(400, "missing_persona", `Persona profile ${override.personaProfileId} does not exist`);
            }
        }
        const configuredPluginTypes = new Set(withImplicitBuiltInPlugins(bot.plugins).map((plugin) => plugin.type));
        for (const override of bot.chatroomModelOverrides) {
            const missing = override.pluginOverrides.find((plugin) => !configuredPluginTypes.has(plugin.pluginType));
            if (missing) {
                throw new HttpError(400, "missing_plugin_config", `Chatroom ${override.chatroomId} references plugin ${missing.pluginType} without a Bot plugin configuration`);
            }
        }
    }
    #assertModelReference(model) {
        const providerProfile = this.#store.getProviderProfile(model.providerProfileId);
        if (!providerProfile) {
            throw new HttpError(400, "missing_provider", `Provider profile ${model.providerProfileId} does not exist`);
        }
    }
    #providerApiKey(profile, input) {
        let supplied;
        if (typeof input === "object" && input !== null && !Array.isArray(input) && "apiKey" in input) {
            const value = input.apiKey;
            if (value !== undefined && typeof value !== "string")
                throw new HttpError(400, "invalid_config", "apiKey must be a string");
            supplied = typeof value === "string" ? value.trim() || undefined : undefined;
        }
        const apiKey = supplied ?? this.#store.getProviderApiKey(profile.id) ??
            (profile.apiKeyEnv ? process.env[profile.apiKeyEnv]?.trim() : undefined);
        if (!apiKey)
            throw new HttpError(400, "api_key_required", `Provider ${profile.id} has no API key configured`);
        return apiKey;
    }
    #knowledgeProviderApiKey(profile, input) {
        let supplied;
        if (typeof input === "object" && input !== null && !Array.isArray(input) && "apiKey" in input) {
            const value = input.apiKey;
            if (value !== undefined && typeof value !== "string")
                throw new HttpError(400, "invalid_config", "apiKey must be a string");
            supplied = typeof value === "string" ? value.trim() || undefined : undefined;
        }
        const apiKey = supplied ?? this.#store.getKnowledgeProviderApiKey(profile.id) ??
            (profile.apiKeyEnv ? process.env[profile.apiKeyEnv]?.trim() : undefined);
        if (!apiKey && profile.kind !== "searxng") {
            throw new HttpError(400, "api_key_required", `Knowledge provider ${profile.id} has no API key configured`);
        }
        return apiKey;
    }
    #authenticate(request) {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer "))
            throw new HttpError(401, "unauthorized", "Admin token required");
        const supplied = Buffer.from(authorization.slice(7));
        if (supplied.length !== this.#token.length || !timingSafeEqual(supplied, this.#token)) {
            throw new HttpError(401, "unauthorized", "Invalid admin token");
        }
    }
    #assertSameOrigin(request) {
        const origin = request.headers.origin;
        if (!origin)
            return;
        const host = request.headers.host;
        if (!host || (origin !== `http://${host}` && origin !== `https://${host}`)) {
            throw new HttpError(403, "cross_origin_denied", "Cross-origin admin requests are denied");
        }
    }
    async #serveStatic(pathname, response) {
        const file = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/u, "");
        if (!/^(?:index\.html|pi-bot\.svg|assets\/[a-zA-Z0-9._-]+)$/u.test(file))
            throw new HttpError(404, "not_found", "Page not found");
        let body;
        try {
            body = await readFile(`${this.#webRoot}/${file}`);
        }
        catch {
            throw new HttpError(500, "web_assets_missing", "WebUI assets are missing");
        }
        response.writeHead(200, {
            "Content-Type": staticContentType(file),
            "Content-Length": body.byteLength,
            "Cache-Control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        });
        response.end(body);
    }
    #handleError(error, request, response) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : "internal_error";
        const message = error instanceof Error ? error.message : String(error);
        if (request.url?.startsWith("/api/") && status >= 400) {
            this.#log(status >= 500 ? "error" : "warn", `web.${code}`, message);
        }
        if (response.headersSent) {
            response.destroy();
            return;
        }
        setSecurityHeaders(response);
        replyJson(response, status, {
            ok: false,
            error: code,
            message: status >= 500 ? "Internal server error" : message,
            ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
        });
    }
    #log(level, event, message, botId) {
        try {
            this.#store.appendLog({ level, scope: "web", event, message, ...(botId ? { botId } : {}) });
        }
        catch {
            // Logging cannot break management requests.
        }
    }
}
class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
function memeApiBaseUrl() {
    const value = process.env.PI_MEME_API_BASE_URL?.trim() || DEFAULT_MEME_API_BASE_URL;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new HttpError(500, "meme_service_config_invalid", "PI_MEME_API_BASE_URL is invalid");
    }
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || url.search || url.hash) {
        throw new HttpError(500, "meme_service_config_invalid", "PI_MEME_API_BASE_URL must be a credential-free HTTP(S) URL");
    }
    if (!url.pathname.endsWith("/"))
        url.pathname += "/";
    return url;
}
function memeApiUrl(path) {
    return new URL(path.replace(/^\/+/, ""), memeApiBaseUrl());
}
async function fetchMemeJson(path) {
    const { response, bytes } = await fetchMemeResponse(path);
    if (!response.ok)
        throw memeUpstreamError(response.status, bytes);
    try {
        return JSON.parse(Buffer.from(bytes).toString("utf8"));
    }
    catch {
        throw new HttpError(502, "meme_service_invalid_response", "Meme service returned invalid JSON");
    }
}
async function compressMemeForChat(bytes, mimeType) {
    try {
        return await compressForChat(bytes, mimeType, MEME_SEND_MAX_BYTES);
    }
    catch (error) {
        throw new HttpError(422, "meme_compression_failed", error instanceof Error ? error.message : String(error));
    }
}
async function fetchMemeResponse(path, init = {}) {
    let response;
    try {
        response = await fetch(memeApiUrl(path), {
            ...init,
            signal: init.signal ?? AbortSignal.timeout(MEME_TIMEOUT_MS),
        });
    }
    catch (error) {
        throw new HttpError(502, "meme_service_unavailable", `Meme service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { response, bytes: await readMemeResponse(response) };
}
async function readMemeResponse(response) {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MEME_RESPONSE_MAX_BYTES)
        throw new HttpError(502, "meme_response_too_large", "Meme service response is too large");
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MEME_RESPONSE_MAX_BYTES)
            throw new HttpError(502, "meme_response_too_large", "Meme service response is too large");
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > MEME_RESPONSE_MAX_BYTES)
                throw new HttpError(502, "meme_response_too_large", "Meme service response is too large");
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
function memeUpstreamError(status, bytes) {
    const detail = Buffer.from(bytes).toString("utf8").replace(/\s+/gu, " ").trim().slice(0, 240);
    if (status === 404)
        return new HttpError(400, "meme_not_found", "没有找到这个表情模板，请刷新菜单后选择可用名称");
    if (status === 541)
        return new HttpError(400, "meme_invalid_input", "表情模板的图片或文字数量不符合要求，请先查看模板详情");
    return new HttpError(502, "meme_service_failed", detail ? `Meme service HTTP ${status}: ${detail}` : `Meme service HTTP ${status}`);
}
function normalizeMemeInfo(key, value) {
    const object = isRecordValue(value) ? value : {};
    const params = isRecordValue(object.params_type) ? object.params_type : {};
    return {
        key,
        keywords: Array.isArray(object.keywords) ? object.keywords.filter((item) => typeof item === "string").slice(0, 32) : [],
        defaultTexts: Array.isArray(params.default_texts) ? params.default_texts.filter((item) => typeof item === "string").slice(0, 12) : [],
        minImages: memeInfoInteger(params.min_images),
        maxImages: memeInfoInteger(params.max_images),
        minTexts: memeInfoInteger(params.min_texts),
        maxTexts: memeInfoInteger(params.max_texts),
    };
}
function memeDisplayName(info) {
    return info.keywords.find((keyword) => /[\u3400-\u9fff]/u.test(keyword)) || info.key;
}
function memeRangeText(min, max) {
    return min === max ? String(min) : `${min} ~ ${max}`;
}
function memeInfoInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 12 ? value : 0;
}
function requiredMemeKey(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value.trim()))
        throw new HttpError(400, "invalid_meme_key", "Meme key is invalid");
    return value.trim();
}
function memeInputImages(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 12)
        throw new HttpError(400, "invalid_meme_images", "At most 12 meme input images are allowed");
    return value.map((item) => {
        if (!isRecordValue(item) || typeof item.dataUrl !== "string")
            throw new HttpError(400, "invalid_meme_images", "Each meme input must be an image data URL");
        const match = /^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(item.dataUrl);
        if (!match)
            throw new HttpError(400, "invalid_meme_images", "Only JPEG, PNG, GIF and WebP images are supported");
        const mimeType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
        const bytes = Buffer.from(match[2].replace(/\s+/gu, ""), "base64");
        if (bytes.byteLength < 16 || bytes.byteLength > MEME_INPUT_MAX_BYTES)
            throw new HttpError(400, "invalid_meme_images", "Each meme input image must be between 16 bytes and 20 MiB");
        return { bytes, mimeType };
    });
}
function memeTexts(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 12 || value.some((item) => typeof item !== "string" || item.length > 1_000))
        throw new HttpError(400, "invalid_meme_texts", "Meme texts must contain at most 12 strings of 1000 characters");
    return value.map((item) => item.normalize("NFKC").trim()).filter(Boolean);
}
function memeKeywords(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 12 || value.some((item) => typeof item !== "string" || item.length > 40))
        throw new HttpError(400, "invalid_custom_meme", "Custom meme keywords must contain at most 12 short strings");
    return value.map((item) => item.normalize("NFKC").trim()).filter(Boolean);
}
function memeExtension(mimeType) {
    return mimeType === "image/gif" ? "gif" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
}
function sniffMemeMimeType(data) {
    if (data.length >= 6) {
        const header = Buffer.from(data.subarray(0, 6)).toString("ascii");
        if (header === "GIF87a" || header === "GIF89a")
            return "image/gif";
    }
    if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return "image/jpeg";
    if (data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP")
        return "image/webp";
    return undefined;
}
function isRecordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readJson(request, maxBytes) {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json")
        throw new HttpError(415, "json_required", "Content-Type must be application/json");
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes)
        throw new HttpError(413, "body_too_large", "Request body is too large");
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        length += bytes.byteLength;
        if (length > maxBytes)
            throw new HttpError(413, "body_too_large", "Request body is too large");
        chunks.push(bytes);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new HttpError(400, "invalid_json", "Request body contains invalid JSON");
    }
}
function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
function staticContentType(file) {
    if (file.endsWith(".html"))
        return "text/html; charset=utf-8";
    if (file.endsWith(".js"))
        return "text/javascript; charset=utf-8";
    if (file.endsWith(".css"))
        return "text/css; charset=utf-8";
    if (file.endsWith(".svg"))
        return "image/svg+xml";
    if (file.endsWith(".woff2"))
        return "font/woff2";
    return "application/octet-stream";
}
function replyJson(response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.byteLength,
        "Cache-Control": "no-store",
    });
    response.end(body);
}
function replySliderHtml(response, value) {
    const body = Buffer.from(value);
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Content-Security-Policy", "default-src 'self' https: data:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'none'; form-action 'self' https:");
    response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.byteLength,
        "Cache-Control": "no-store, private",
    });
    response.end(body);
}
function isPrivateClient(value) {
    if (!value)
        return false;
    const address = value.startsWith("::ffff:") ? value.slice(7) : value.split("%", 1)[0];
    if (address === "::1" || address === "127.0.0.1")
        return true;
    if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:"))
        return true;
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255))
        return false;
    return (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254));
}
function optionalInteger(value) {
    if (!value)
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new HttpError(400, "invalid_number", "Query integer is invalid");
    return parsed;
}
function isLogLevel(value) {
    return value === "debug" || value === "info" || value === "warn" || value === "error";
}
function isParticipationReview(value) {
    return value === "all" || value === "unrated" || value === "speak" || value === "silent" || value === "unsure";
}
function isQualityReview(value) {
    return value === "all" || value === "unrated" || value === "helpful" || value === "unhelpful" || value === "unsure";
}
function requiredQuery(url, name) {
    const value = url.searchParams.get(name)?.trim();
    if (!value)
        throw new HttpError(400, "missing_query", `${name} is required`);
    if (value.length > 500)
        throw new HttpError(400, "invalid_query", `${name} is too long`);
    return value;
}
function requiredBodyText(object, name, maxLength) {
    const value = object[name];
    if (typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, "invalid_config", `${name} must be a non-empty string`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength)
        throw new HttpError(400, "invalid_config", `${name} is too long`);
    return normalized;
}
function bodyText(object, name, maxLength, allowEmpty = false) {
    const value = object[name];
    if (typeof value !== "string")
        throw new HttpError(400, "invalid_config", `${name} must be a string`);
    const normalized = value.normalize("NFKC").trim();
    if (!normalized && !allowEmpty)
        throw new HttpError(400, "invalid_config", `${name} cannot be empty`);
    if (normalized.length > maxLength)
        throw new HttpError(400, "invalid_config", `${name} is too long`);
    return normalized;
}
function bodyStringArray(object, name, maxItems) {
    const value = object[name];
    if (!Array.isArray(value) || value.length < 1 || value.length > maxItems ||
        value.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
        throw new HttpError(400, "invalid_config", `${name} must contain between 1 and ${maxItems} non-empty strings`);
    }
    return [...new Set(value.map((item) => item.normalize("NFKC").trim()))];
}
function requiredImageDataUrl(value) {
    if (typeof value !== "string")
        throw new HttpError(400, "invalid_avatar", "avatarDataUrl must be an image data URL");
    const match = /^data:image\/(?:jpeg|png|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(value);
    if (!match)
        throw new HttpError(400, "invalid_avatar", "Only JPEG, PNG and WebP avatar data URLs are supported");
    const bytes = Buffer.from(match[1].replace(/\s+/gu, ""), "base64");
    if (bytes.byteLength < 16 || bytes.byteLength > 5 * 1024 * 1024) {
        throw new HttpError(400, "invalid_avatar", "Avatar must be between 16 bytes and 5 MiB");
    }
    return bytes;
}
function optionalBodyText(object, name, maxLength) {
    const value = object[name];
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string")
        throw new HttpError(400, "invalid_config", `${name} must be a string`);
    const normalized = value.trim();
    if (normalized.length > maxLength)
        throw new HttpError(400, "invalid_config", `${name} is too long`);
    return normalized || undefined;
}
function optionalBodyBoolean(object, name) {
    const value = object[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new HttpError(400, "invalid_config", `${name} must be a boolean`);
    return value;
}
function parseInput(parser) {
    try {
        return parser();
    }
    catch (error) {
        throw new HttpError(400, "invalid_config", error instanceof Error ? error.message : String(error));
    }
}
function inputRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "invalid_config", "Request body must be an object");
    }
    return value;
}
function canonicalChatroomId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase().split(":").at(-1) || "";
    if (!normalized || /\s|[\u0000-\u001f]/u.test(normalized)) {
        throw new HttpError(400, "invalid_chatroom", "chatroomId must be a non-empty conversation id");
    }
    return normalized;
}
function canonicalIdentityId(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function providerApiKeyUpdate(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("provider profile must be an object");
    }
    const object = value;
    if (object.clearApiKey !== undefined && typeof object.clearApiKey !== "boolean") {
        throw new Error("clearApiKey must be boolean");
    }
    if (object.apiKey !== undefined && typeof object.apiKey !== "string") {
        throw new Error("apiKey must be a string");
    }
    const apiKey = typeof object.apiKey === "string" ? object.apiKey.trim() : "";
    if (apiKey && object.clearApiKey === true)
        throw new Error("apiKey and clearApiKey cannot be used together");
    if (apiKey)
        return apiKey;
    return object.clearApiKey === true ? null : undefined;
}
function mcpInputSecret(value) {
    const object = inputRecord(value);
    if (object.secret !== undefined && typeof object.secret !== "string")
        throw new Error("secret must be a string");
    return typeof object.secret === "string" ? object.secret.trim() || undefined : undefined;
}
function mcpSecretUpdate(value) {
    const object = inputRecord(value);
    if (object.clearSecret !== undefined && typeof object.clearSecret !== "boolean")
        throw new Error("clearSecret must be boolean");
    const secret = mcpInputSecret(value);
    if (secret && object.clearSecret === true)
        throw new Error("secret and clearSecret cannot be used together");
    if (secret)
        return secret;
    return object.clearSecret === true ? null : undefined;
}
function mcpProfileNeedsSecret(profile) {
    return profile.transport === "stdio" ? Boolean(profile.secretEnv) : profile.authType !== "none";
}
function parseScheduledTaskSchedule(value) {
    const object = inputRecord(value);
    if (object.type === "once") {
        if (typeof object.runAt !== "number")
            throw new Error("once schedule requires numeric runAt");
        return { type: "once", runAt: object.runAt };
    }
    if (object.type === "daily") {
        if (typeof object.minute !== "number")
            throw new Error("daily schedule requires numeric minute");
        return { type: "daily", minute: object.minute };
    }
    if (object.type === "weekly") {
        if (typeof object.minute !== "number" || !Array.isArray(object.weekdays)) {
            throw new Error("weekly schedule requires minute and weekdays");
        }
        if (object.weekdays.some((day) => typeof day !== "number"))
            throw new Error("weekdays must be numbers");
        return { type: "weekly", minute: object.minute, weekdays: object.weekdays };
    }
    throw new Error("Unsupported scheduled task schedule type");
}
function boundedInteger(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function modelFallbackTier(model, provider) {
    const providerName = provider.provider.normalize("NFKC").toLocaleLowerCase();
    const modelId = model.modelId.normalize("NFKC").toLocaleLowerCase().split("/").at(-1) ?? "";
    if (providerName === "aistudio" || modelId.startsWith("gemini-"))
        return 0;
    if (isLocalModelProvider(provider))
        return 2;
    return 1;
}
function isLocalModelProvider(provider) {
    const name = `${provider.id} ${provider.label} ${provider.provider}`.normalize("NFKC").toLocaleLowerCase();
    if (/(?:^|[\s._-])(?:local|ollama|lmstudio|llama\.cpp)(?:$|[\s._-])/u.test(name))
        return true;
    try {
        const hostname = new URL(provider.baseUrl).hostname.toLocaleLowerCase();
        if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "::1")
            return true;
        if (/^127\./u.test(hostname) || /^10\./u.test(hostname) || /^192\.168\./u.test(hostname))
            return true;
        const match = /^172\.(\d{1,2})\./u.exec(hostname);
        return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=server.js.map
