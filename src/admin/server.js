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
import { AgentSupervisor } from "./supervisor.js";
import { WechatIpadLoginManager } from "./wechat-ipad-login.js";
import { AISTUDIO_TTS_VOICES, DEFAULT_TTS_STYLE, DEFAULT_TTS_VOICE, TTS_VOICE_PRESETS, } from "../voice-style.js";
import { createWechatAdapterRegistry } from "../adapters/definitions.js";
// Persona avatar presets are stored as data URLs; keep this below the hard 10 MiB constructor bound.
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../webui/", import.meta.url));
const CHANNEL_ADAPTERS = createWechatAdapterRegistry();
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
    #ipadLoginManager;
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
        this.#ipadLoginManager = options.ipadLoginManager;
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
        if (url.pathname.startsWith("/ipad-login/slider/")) {
            await this.#handlePublicSlider(request, response, url);
            return;
        }
        if (url.pathname.startsWith("/ipad-login/slider-submit/")) {
            await this.#handlePublicSliderSubmit(request, response, url);
            return;
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
                modules: ["core", "wechat"],
                adapters: CHANNEL_ADAPTERS.list(),
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
                manifests: CHANNEL_ADAPTERS.list(),
                instances: this.#store.listBots().map((bot) => {
                    const runtime = statusByBotId.get(bot.id);
                    const manifest = CHANNEL_ADAPTERS.manifest(bot.channel.type);
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
        if (method === "GET" && url.pathname === "/api/emojis") {
            const botId = url.searchParams.get("botId")?.trim() || undefined;
            replyJson(response, 200, {
                emojis: this.#store.listEmojis(botId).map(({ asset, ...emoji }) => ({
                    ...emoji,
                    mimeType: asset.mimeType,
                    size: asset.size,
                })),
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
            if (profile.authType !== "none" && !secret)
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
            if (profile.authType !== "none" && secretUpdate === undefined && !existing?.hasSecret) {
                throw new HttpError(400, "secret_required", "MCP authentication secret is required");
            }
            const saved = this.#store.saveMcpServerProfile(profile, profile.authType === "none" ? null : secretUpdate);
            this.#log("info", "config.mcp_server_saved", `MCP 服务 ${saved.id} 已保存`);
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { server: saved, status: this.#supervisor.status() });
            return;
        }
        const mcpServerMatch = /^\/api\/mcp-servers\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
        if (method === "DELETE" && mcpServerMatch) {
            const id = mcpServerMatch[1];
            if (!this.#store.deleteMcpServerProfile(id))
                throw new HttpError(404, "not_found", "MCP server not found");
            this.#log("warn", "config.mcp_server_deleted", `MCP 服务 ${id} 已删除`);
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { deleted: true });
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
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { provider: saved, status: this.#supervisor.status() });
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
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { provider: saved, status: this.#supervisor.status() });
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
            const result = await this.#wechat(() => this.#supervisor.applyPersonaIdentity(botId, personaId, {
                force: true,
                ...(conversationId ? { conversationId } : {}),
            }));
            this.#log("info", "wechat.persona_applied", `人设 ${personaId} 已手动应用到微信账号`, botId);
            replyJson(response, 200, { result, capabilities: this.#supervisor.wechatCapabilities(botId) });
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
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { model: profile, status: this.#supervisor.status() });
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
                    await this.#supervisor.reconcileAll();
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
        const wechatCapabilityMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/capabilities$/.exec(url.pathname);
        if (method === "GET" && wechatCapabilityMatch) {
            replyJson(response, 200, { capabilities: this.#supervisor.wechatCapabilities(wechatCapabilityMatch[1]) });
            return;
        }
        const wechatProfileMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/(profile|avatar|qrcode)$/.exec(url.pathname);
        if (wechatProfileMatch) {
            const botId = wechatProfileMatch[1];
            const action = wechatProfileMatch[2];
            const client = await this.#wechat(() => Promise.resolve(this.#supervisor.wechatClient(botId)));
            if (method === "GET" && action === "profile") {
                replyJson(response, 200, { profile: await this.#wechat(() => client.getAccountProfile()) });
                return;
            }
            if (method === "PATCH" && action === "profile") {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const sexValue = body.sex;
                if (sexValue !== undefined && sexValue !== 0 && sexValue !== 1 && sexValue !== 2) {
                    throw new HttpError(400, "invalid_profile", "sex must be 0, 1 or 2");
                }
                const result = await this.#wechat(() => client.updateAccountProfile({
                    ...(optionalBodyText(body, "nickname", 32) !== undefined ? { nickname: optionalBodyText(body, "nickname", 32) } : {}),
                    ...(sexValue === undefined ? {} : { sex: sexValue }),
                    ...(optionalBodyText(body, "country", 32) !== undefined ? { country: optionalBodyText(body, "country", 32) } : {}),
                    ...(optionalBodyText(body, "province", 64) !== undefined ? { province: optionalBodyText(body, "province", 64) } : {}),
                    ...(optionalBodyText(body, "city", 64) !== undefined ? { city: optionalBodyText(body, "city", 64) } : {}),
                    ...(optionalBodyText(body, "signature", 120) !== undefined ? { signature: optionalBodyText(body, "signature", 120) } : {}),
                }));
                this.#log("info", "wechat.profile_updated", "已从 WebUI 修改微信账号资料", botId);
                replyJson(response, 200, { result });
                return;
            }
            if (method === "POST" && action === "avatar") {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const avatar = requiredImageDataUrl(body.avatarDataUrl);
                const result = await this.#wechat(() => client.uploadHeadImage(avatar));
                this.#log("info", "wechat.avatar_updated", "已从 WebUI 修改微信账号头像", botId);
                replyJson(response, 200, { result });
                return;
            }
            if (method === "GET" && action === "qrcode") {
                replyJson(response, 200, { qrcode: await this.#wechat(() => client.getAccountQrCode()) });
                return;
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported WeChat profile operation");
        }
        const wechatGroupMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/groups\/([^/]+)(?:\/(qrcode|members|admin))?$/.exec(url.pathname);
        if (wechatGroupMatch) {
            const botId = wechatGroupMatch[1];
            const roomId = canonicalChatroomId(decodeURIComponent(wechatGroupMatch[2]));
            const action = wechatGroupMatch[3];
            const client = await this.#wechat(() => Promise.resolve(this.#supervisor.wechatClient(botId)));
            if (method === "GET" && !action) {
                replyJson(response, 200, {
                    roomId,
                    details: await this.#wechat(() => client.getGroupDetails(roomId)),
                    members: await this.#wechat(() => client.listGroupMembers(roomId)),
                    capabilities: this.#supervisor.wechatCapabilities(botId),
                });
                return;
            }
            if (method === "GET" && action === "qrcode") {
                replyJson(response, 200, { roomId, qrcode: await this.#wechat(() => client.getGroupQrCode(roomId)) });
                return;
            }
            if (method === "PATCH" && !action) {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const operation = requiredBodyText(body, "operation", 32);
                let result;
                if (operation === "remarks")
                    result = await this.#wechat(() => client.setGroupRemarks(roomId, bodyText(body, "value", 64, true)));
                else if (operation === "name")
                    result = await this.#wechat(() => client.setGroupName(roomId, requiredBodyText(body, "value", 64)));
                else if (operation === "announcement")
                    result = await this.#wechat(() => client.setGroupAnnouncement(roomId, bodyText(body, "value", 2_000, true)));
                else if (operation === "saveToContacts") {
                    if (typeof body.enabled !== "boolean")
                        throw new HttpError(400, "invalid_group_operation", "enabled must be a boolean");
                    result = await this.#wechat(() => client.saveGroupToContacts(roomId, body.enabled));
                }
                else
                    throw new HttpError(400, "invalid_group_operation", "Unsupported group operation");
                this.#log("info", `wechat.group_${operation}`, `已从 WebUI 执行群设置：${operation}`, botId);
                replyJson(response, 200, { roomId, result });
                return;
            }
            if (method === "POST" && action === "members") {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const memberAction = requiredBodyText(body, "action", 16);
                if (memberAction !== "add" && memberAction !== "invite" && memberAction !== "remove") {
                    throw new HttpError(400, "invalid_group_member_action", "action must be add, invite or remove");
                }
                const memberIds = bodyStringArray(body, "memberIds", 100);
                const result = await this.#wechat(() => client.manageGroupMembers(roomId, memberAction, memberIds));
                this.#log("warn", `wechat.group_members_${memberAction}`, `已从 WebUI 执行群成员操作：${memberAction}`, botId);
                replyJson(response, 200, { roomId, result });
                return;
            }
            if (method === "POST" && action === "admin") {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const adminAction = requiredBodyText(body, "action", 16);
                if (adminAction !== "add" && adminAction !== "remove" && adminAction !== "transfer") {
                    throw new HttpError(400, "invalid_group_admin_action", "action must be add, remove or transfer");
                }
                const memberIds = bodyStringArray(body, "memberIds", adminAction === "transfer" ? 1 : 10);
                const result = await this.#wechat(() => client.operateGroupAdmin(roomId, adminAction, memberIds));
                this.#log("warn", `wechat.group_admin_${adminAction}`, `已从 WebUI 执行群管理员操作：${adminAction}`, botId);
                replyJson(response, 200, { roomId, result });
                return;
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported WeChat group operation");
        }
        const wechatContactsMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/contacts(?:\/(search|details|remark|friend-state|approve))?$/.exec(url.pathname);
        if (wechatContactsMatch) {
            const botId = wechatContactsMatch[1];
            const action = wechatContactsMatch[2];
            const client = await this.#wechat(() => Promise.resolve(this.#supervisor.wechatClient(botId)));
            if (method === "GET" && !action) {
                replyJson(response, 200, { contacts: await this.#wechat(() => client.listContacts()) });
                return;
            }
            const body = inputRecord(await readJson(request, this.#maxBodyBytes));
            if (method === "POST" && action === "search") {
                replyJson(response, 200, { contact: await this.#wechat(() => client.searchContact(requiredBodyText(body, "query", 64))) });
                return;
            }
            if (method === "POST" && action === "details") {
                replyJson(response, 200, { contacts: await this.#wechat(() => client.getContactDetails(bodyStringArray(body, "contactIds", 100))) });
                return;
            }
            if (method === "POST" && action === "friend-state") {
                replyJson(response, 200, { state: await this.#wechat(() => client.getFriendState(requiredBodyText(body, "contactId", 300))) });
                return;
            }
            if (method === "POST" && action === "remark") {
                const result = await this.#wechat(() => client.setContactRemark(requiredBodyText(body, "contactId", 300), bodyText(body, "remarks", 64, true)));
                this.#log("info", "wechat.contact_remark_updated", "已从 WebUI 修改联系人备注", botId);
                replyJson(response, 200, { result });
                return;
            }
            if (method === "POST" && action === "approve") {
                const scene = body.scene;
                if (!Number.isSafeInteger(scene) || scene < 0)
                    throw new HttpError(400, "invalid_friend_request", "scene is invalid");
                const result = await this.#wechat(() => client.approveFriendRequest(scene, requiredBodyText(body, "v1", 2_000), requiredBodyText(body, "v2", 2_000)));
                this.#log("info", "wechat.friend_request_approved", "已从 WebUI 通过好友请求", botId);
                replyJson(response, 200, { result });
                return;
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported contact operation");
        }
        const wechatLabelsMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/labels(?:\/([^/]+))?$/.exec(url.pathname);
        if (wechatLabelsMatch) {
            const botId = wechatLabelsMatch[1];
            const labelId = wechatLabelsMatch[2] ? decodeURIComponent(wechatLabelsMatch[2]) : undefined;
            const client = await this.#wechat(() => Promise.resolve(this.#supervisor.wechatClient(botId)));
            if (method === "GET" && !labelId) {
                replyJson(response, 200, { labels: await this.#wechat(() => client.listLabels()) });
                return;
            }
            const body = method === "DELETE" ? {} : inputRecord(await readJson(request, this.#maxBodyBytes));
            let result;
            if (method === "POST" && !labelId)
                result = await this.#wechat(() => client.addLabel(requiredBodyText(body, "name", 32)));
            else if (method === "PATCH" && labelId && body.name !== undefined)
                result = await this.#wechat(() => client.renameLabel(labelId, requiredBodyText(body, "name", 32)));
            else if (method === "PATCH" && labelId)
                result = await this.#wechat(() => client.updateLabelMembers(labelId, bodyStringArray(body, "contactIds", 500)));
            else if (method === "DELETE" && labelId)
                result = await this.#wechat(() => client.deleteLabel(labelId));
            else
                throw new HttpError(405, "method_not_allowed", "Unsupported label operation");
            this.#log(method === "DELETE" ? "warn" : "info", `wechat.label_${method.toLowerCase()}`, "已从 WebUI 修改联系人标签", botId);
            replyJson(response, 200, { result });
            return;
        }
        const wechatMomentAutomationMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/moments\/automation$/.exec(url.pathname);
        if (wechatMomentAutomationMatch) {
            const botId = wechatMomentAutomationMatch[1];
            const bot = this.#store.getBot(botId);
            if (!bot)
                throw new HttpError(404, "not_found", "Bot not found");
            if (bot.channel.type !== "wechat-ipad")
                throw new HttpError(400, "invalid_channel", "Moment automation requires an iPad bot");
            if (method === "GET") {
                replyJson(response, 200, {
                    settings: this.#store.getWechatMomentAutomation(botId),
                    actions: this.#store.listWechatMomentActions(botId, 100),
                });
                return;
            }
            if (method === "PUT") {
                const body = await readJson(request, this.#maxBodyBytes);
                let settings;
                try {
                    settings = this.#store.saveWechatMomentAutomation(botId, body);
                }
                catch (error) {
                    throw new HttpError(400, "invalid_moment_automation", error instanceof Error ? error.message : String(error));
                }
                this.#log(settings.enabled && !settings.dryRun ? "warn" : "info", "wechat.moment_automation_saved", `朋友圈自动互动策略已${settings.enabled ? "启用" : "停用"}`, botId);
                replyJson(response, 200, { settings, actions: this.#store.listWechatMomentActions(botId, 100) });
                return;
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported moment automation operation");
        }
        const wechatMomentsMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/wechat\/moments(?:\/([^/]+)\/(like|comment))?$/.exec(url.pathname);
        if (wechatMomentsMatch) {
            const botId = wechatMomentsMatch[1];
            const momentId = wechatMomentsMatch[2] ? decodeURIComponent(wechatMomentsMatch[2]) : undefined;
            const action = wechatMomentsMatch[3];
            const client = await this.#wechat(() => Promise.resolve(this.#supervisor.wechatClient(botId)));
            if (method === "GET" && !momentId) {
                replyJson(response, 200, { moments: await this.#wechat(() => client.listMoments()) });
                return;
            }
            if (method === "POST" && !momentId) {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const privacy = body.privacy === "private" ? "private" : body.privacy === "public" || body.privacy === undefined ? "public" : undefined;
                if (!privacy)
                    throw new HttpError(400, "invalid_moment", "privacy must be public or private");
                const result = await this.#wechat(() => client.publishTextMoment(requiredBodyText(body, "content", 2_000), privacy));
                this.#log("warn", "wechat.moment_published", "已从 WebUI 手动发布朋友圈", botId);
                replyJson(response, 200, { result });
                return;
            }
            if (method === "POST" && momentId && action === "like") {
                const result = await this.#wechat(() => client.likeMoment(momentId));
                this.#log("info", "wechat.moment_liked", "已从 WebUI 点赞朋友圈", botId);
                replyJson(response, 200, { result });
                return;
            }
            if (method === "POST" && momentId && action === "comment") {
                const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                const result = await this.#wechat(() => client.commentMoment(momentId, requiredBodyText(body, "content", 500)));
                this.#log("info", "wechat.moment_commented", "已从 WebUI 评论朋友圈", botId);
                replyJson(response, 200, { result });
                return;
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported moment operation");
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
                    plugins: bot.plugins,
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
            await Promise.all(affectedBotIds.map((botId) => this.#supervisor.reconcileBot(botId)));
            replyJson(response, 200, {
                bot: { id: bot.id, displayName: bot.displayName, plugins: bot.plugins },
                status: this.#supervisor.status().bots.find((item) => item.id === bot.id),
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
            await Promise.all([...affectedBotIds].map((botId) => this.#supervisor.reconcileBot(botId)));
            let identitySyncs = 0;
            if (hasPersonaChange && personaProfileId) {
                const persona = this.#store.getPersonaProfile(personaProfileId);
                if (persona?.autoApplyAccountProfile) {
                    for (const target of body.targets) {
                        try {
                            await this.#supervisor.applyPersonaIdentity(target.botId, persona.id, { conversationId: target.chatroomId });
                            identitySyncs += 1;
                        }
                        catch (error) {
                            this.#log("warn", "wechat.persona_identity_apply_failed", error instanceof Error ? error.message : String(error), target.botId);
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
            await Promise.all(affectedBotIds.map((botId) => this.#supervisor.reconcileBot(botId)));
            let identitySync;
            const selectedPersonaId = nextOverride?.personaProfileId ?? null;
            const selectedPersona = selectedPersonaId ? this.#store.getPersonaProfile(selectedPersonaId) : undefined;
            if (personaChanged && selectedPersona?.autoApplyAccountProfile) {
                try {
                    identitySync = await this.#supervisor.applyPersonaIdentity(id, selectedPersona.id, { conversationId: canonicalId });
                }
                catch (error) {
                    this.#log("warn", "wechat.persona_identity_apply_failed", error instanceof Error ? error.message : String(error), id);
                }
            }
            replyJson(response, 200, {
                bot: this.#store.getBot(id) ?? bot,
                contextReset,
                ...(identitySync ? { identitySync } : {}),
                chatrooms: await this.#supervisor.listChatrooms(),
            });
            return;
        }
        const ipadLoginMatch = /^\/api\/bots\/([a-zA-Z0-9._-]+)\/login(?:\/(qr|poll|security-code|slider|session))?$/.exec(url.pathname);
        if (ipadLoginMatch) {
            const manager = this.#ipadLoginManager;
            if (!manager)
                throw new HttpError(503, "ipad_login_unavailable", "wechat-ipad login management is unavailable");
            const id = ipadLoginMatch[1];
            const action = ipadLoginMatch[2];
            try {
                if (method === "GET" && !action) {
                    replyJson(response, 200, { login: await manager.status(id) });
                    return;
                }
                if (method === "POST" && action === "qr") {
                    const body = await readJson(request, this.#maxBodyBytes);
                    const object = inputRecord(body);
                    const loginType = typeof object.loginType === "string" ? object.loginType : undefined;
                    const deviceName = typeof object.deviceName === "string" ? object.deviceName : undefined;
                    replyJson(response, 200, {
                        login: await manager.start(id, {
                            ...(loginType ? { loginType: loginType } : {}),
                            ...(deviceName ? { deviceName } : {}),
                        }),
                    });
                    return;
                }
                if (method === "POST" && action === "poll") {
                    replyJson(response, 200, { login: await manager.poll(id) });
                    return;
                }
                if (method === "POST" && action === "security-code") {
                    const body = inputRecord(await readJson(request, this.#maxBodyBytes));
                    if (typeof body.code !== "string")
                        throw new Error("请输入六位安全码");
                    replyJson(response, 200, { login: await manager.submitSecurityCode(id, body.code) });
                    return;
                }
                if (method === "POST" && action === "slider") {
                    replyJson(response, 200, { url: manager.createSliderUrl(id) });
                    return;
                }
                if (method === "DELETE" && action === "session") {
                    replyJson(response, 200, { login: manager.cancel(id) });
                    return;
                }
            }
            catch (error) {
                throw new HttpError(422, "ipad_login_failed", error instanceof Error ? error.message : String(error));
            }
            throw new HttpError(405, "method_not_allowed", "Unsupported login operation");
        }
        if (method === "POST" && url.pathname === "/api/bots") {
            const body = await readJson(request, this.#maxBodyBytes);
            const bot = parseInput(() => parseBotConfig(body));
            this.#assertBotReferences(bot);
            this.#assertUniqueWebhook(bot);
            this.#store.saveBot(bot);
            const affectedBotIds = [bot.id, ...this.#supervisor.synchronizeAgentConfiguration(bot.id)];
            this.#log("info", "config.bot_saved", `机器人配置 ${bot.id} 已保存`, bot.id);
            await Promise.all(affectedBotIds.map((botId) => this.#supervisor.reconcileBot(botId)));
            replyJson(response, 200, { bot, status: this.#supervisor.status().bots.find((item) => item.id === bot.id) });
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
            await this.#supervisor.reconcileBot(id);
            replyJson(response, 200, { status: this.#supervisor.status().bots.find((item) => item.id === id) });
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
            await this.#supervisor.reconcileAll();
            replyJson(response, 200, { settings, status: this.#supervisor.status() });
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
    async #handlePublicSlider(request, response, url) {
        if (request.method !== "GET")
            throw new HttpError(405, "method_not_allowed", "Only GET is allowed");
        const nonce = url.pathname.slice("/ipad-login/slider/".length);
        try {
            const html = await this.#ipadLoginManager?.sliderPage(nonce);
            if (!html)
                throw new Error("滑块登录服务不可用");
            replySliderHtml(response, html);
        }
        catch {
            throw new HttpError(404, "slider_session_invalid", "滑块验证会话无效或已过期");
        }
    }
    async #handlePublicSliderSubmit(request, response, url) {
        if (request.method !== "GET")
            throw new HttpError(405, "method_not_allowed", "Only GET is allowed");
        const nonce = url.pathname.slice("/ipad-login/slider-submit/".length);
        try {
            const result = await this.#ipadLoginManager?.submitSlider(nonce, url.searchParams);
            if (result === undefined)
                throw new Error("滑块登录服务不可用");
            replyJson(response, 200, result);
        }
        catch {
            throw new HttpError(422, "slider_submit_failed", "滑块验证提交失败，请关闭页面后重试");
        }
    }
    #assertModelReference(model) {
        const providerProfile = this.#store.getProviderProfile(model.providerProfileId);
        if (!providerProfile) {
            throw new HttpError(400, "missing_provider", `Provider profile ${model.providerProfileId} does not exist`);
        }
    }
    async #wechat(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof HttpError)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            if (/用户可能退出|账号可能退出/u.test(message.normalize("NFKC"))) {
                throw new HttpError(422, "wechat_operation_temporarily_rejected", "iPad 管理接口暂时拒绝了此操作，但账号仍在线；请稍后重试或改用另一个 Bot。");
            }
            throw new HttpError(422, "wechat_operation_failed", message);
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
    #assertUniqueWebhook(bot) {
        const port = bot.channel.type === "wx-hook-http" ? bot.channel.webhookPort : bot.channel.callbackPort;
        const conflict = this.#store
            .listBots()
            .find((candidate) => {
            const candidatePort = candidate.channel.type === "wx-hook-http"
                ? candidate.channel.webhookPort
                : candidate.channel.callbackPort;
            return candidate.id !== bot.id && candidatePort === port;
        });
        if (conflict) {
            throw new HttpError(409, "webhook_port_conflict", `Webhook port is already used by bot ${conflict.id}`);
        }
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
        if (!/^(?:index\.html|pi-bot\.svg|assets\/[a-zA-Z0-9._-]+|legacy\/(?:index\.html|app\.js|styles\.css))$/u.test(file))
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
            "Cache-Control": "no-store",
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
    if (!normalized.endsWith("@chatroom") || /\s|[\u0000-\u001f]/u.test(normalized)) {
        throw new HttpError(400, "invalid_chatroom", "chatroomId must be a WeChat @chatroom id");
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
