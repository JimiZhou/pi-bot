const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_MODELS_DEV_CHARS = 6_000_000;
const MAX_MODELS = 2000;
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_MS = 24 * 60 * 60_000;
let modelsDevCache;
let modelsDevInflight;
/** Tests credentials and discovers models without consulting Pi's bundled catalog. */
export async function probeProvider(profile, apiKey, options = {}) {
    if (!profile.baseUrl)
        throw new Error("Provider Base URL is required for connection testing");
    if (!apiKey.trim())
        throw new Error("Provider API key is required for connection testing");
    const timeoutMs = boundedInteger(options.timeoutMs ?? 12_000, 1000, 60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const fetchImpl = options.fetch ?? fetch;
    const candidates = protocolCandidates(profile);
    const failures = [];
    try {
        for (const api of candidates) {
            const candidate = { ...profile, api };
            try {
                const response = await fetchImpl(modelsEndpoint(candidate), {
                    method: "GET",
                    headers: discoveryHeaders(candidate, apiKey),
                    redirect: "error",
                    signal: controller.signal,
                });
                const payload = await boundedResponseJson(response, apiKey);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${providerError(JSON.stringify(payload), apiKey)}`);
                }
                const records = modelRecords(candidate, payload);
                if (records.length === 0)
                    throw new Error("returned no usable models");
                const publicMetadata = options.includePublicMetadata === false
                    ? new Map()
                    : await loadModelsDevMetadata(options.metadataFetch ?? fetch).catch(() => new Map());
                const models = discoverModels(candidate, records, publicMetadata);
                if (models.length === 0)
                    throw new Error("returned no usable models");
                const routeProtocols = profile.api === "auto" && api === "openai-completions"
                    ? await probeOpenAIRoutes(profile, apiKey, fetchImpl, controller.signal)
                    : [];
                const compatibleApis = routeProtocols.length > 0 ? routeProtocols : compatibleProtocols(api);
                const detectedApi = profile.api === "auto"
                    ? preferredCompatibleApi(profile.baseUrl, api, compatibleApis)
                    : api;
                const orderedCompatibleApis = [detectedApi, ...compatibleApis.filter((item) => item !== detectedApi)];
                return {
                    ok: true,
                    latencyMs: Date.now() - startedAt,
                    detectedApi,
                    compatibleApis: orderedCompatibleApis,
                    detection: profile.api === "auto" ? "url-and-endpoint" : "manual",
                    modelCount: models.length,
                    models,
                };
            }
            catch (error) {
                if (error instanceof Error && error.name === "AbortError")
                    throw error;
                failures.push(`${api}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        throw new Error(`Unable to detect a supported provider protocol (${failures.join("; ")})`);
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Provider connection timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
function protocolCandidates(profile) {
    if (profile.api !== "auto")
        return [profile.api];
    const value = profile.baseUrl.toLocaleLowerCase();
    if (/(?:generativelanguage\.googleapis\.com|gemini)/u.test(value)) {
        return ["google-generative-ai", "openai-completions", "anthropic-messages"];
    }
    if (/anthropic/u.test(value)) {
        return ["anthropic-messages", "openai-completions", "google-generative-ai"];
    }
    return ["openai-completions", "anthropic-messages", "google-generative-ai"];
}
function preferredCompatibleApi(baseUrl, discovered, compatible) {
    if (discovered !== "openai-completions" && discovered !== "openai-responses")
        return discovered;
    if (compatible.length === 1)
        return compatible[0];
    try {
        const hostname = new URL(baseUrl).hostname.toLocaleLowerCase();
        if (hostname === "api.openai.com" || hostname.endsWith(".openai.com"))
            return "openai-responses";
    }
    catch {
        // Base URL was already validated; retain the safest OpenAI-compatible default.
    }
    return "openai-completions";
}
async function probeOpenAIRoutes(profile, apiKey, fetchImpl, signal) {
    const routes = [
        { api: "openai-responses", path: "responses" },
        { api: "openai-completions", path: "chat/completions" },
    ];
    const supported = [];
    for (const route of routes) {
        try {
            const response = await fetchImpl(providerEndpoint(profile.baseUrl, route.path), {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
                body: "{}",
                redirect: "error",
                signal,
            });
            const text = (await response.text()).slice(0, 4096);
            if (routeExists(response.status, text))
                supported.push(route.api);
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                throw error;
            // Route-level probing is best effort; the authenticated model listing remains authoritative.
        }
    }
    return supported;
}
function routeExists(status, responseText) {
    if (status !== 404)
        return status >= 200 && status < 500;
    const text = responseText.toLocaleLowerCase();
    if (/(?:model|input|messages).{0,80}(?:required|missing)|(?:required|missing).{0,80}(?:model|input|messages)/u.test(text)) {
        return true;
    }
    return !/(?:not found|unknown (?:route|endpoint)|cannot post|no route)/u.test(text);
}
function providerEndpoint(baseUrl, path) {
    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/${path}`.replace(/\/+/g, "/");
    base.search = "";
    base.hash = "";
    return base.toString();
}
function compatibleProtocols(api) {
    return api === "openai-completions" || api === "openai-responses"
        ? ["openai-completions", "openai-responses"]
        : [api];
}
function modelsEndpoint(profile) {
    const base = new URL(`${profile.baseUrl.replace(/\/+$/, "")}/`);
    const path = base.pathname.replace(/\/+$/, "");
    if (path.endsWith("/models"))
        return base.toString();
    if (profile.api === "anthropic-messages" && !path.endsWith("/v1")) {
        base.pathname = `${path}/v1/models`.replace(/\/+/g, "/");
    }
    else {
        base.pathname = `${path}/models`.replace(/\/+/g, "/");
    }
    base.search = "";
    base.hash = "";
    return base.toString();
}
function discoveryHeaders(profile, apiKey) {
    const headers = { Accept: "application/json" };
    if (profile.api === "anthropic-messages") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
    }
    else if (profile.api === "google-generative-ai") {
        headers["x-goog-api-key"] = apiKey;
    }
    else {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}
async function boundedResponseJson(response, apiKey) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARS) {
        throw new Error("Provider model response is too large");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS)
        throw new Error("Provider model response is too large");
    if (!response.ok)
        throw new Error(`Provider returned HTTP ${response.status}: ${providerError(text, apiKey)}`);
    return parseJson(text);
}
function discoverModels(profile, records, publicMetadata) {
    const seen = new Set();
    const result = [];
    for (const record of records) {
        const rawId = stringValue(record.id) ?? stringValue(record.name);
        if (!rawId)
            continue;
        const id = profile.api === "google-generative-ai" ? rawId.replace(/^models\//u, "") : rawId;
        if (!id || id.length > 200 || seen.has(id))
            continue;
        seen.add(id);
        const providerMetadata = metadataFromProviderRecord(record);
        const publicModel = publicMetadata.get(id) ?? publicMetadata.get(id.split("/").at(-1) ?? id);
        const heuristic = heuristicMetadata(id);
        const merged = mergeMetadata(providerMetadata, publicModel, heuristic);
        result.push({
            id,
            name: stringValue(record.display_name) ?? stringValue(record.displayName) ?? merged.name ?? id,
            input: merged.input ?? ["text"],
            reasoning: merged.reasoning ?? false,
            contextWindow: merged.contextWindow ?? 128_000,
            maxTokens: merged.maxTokens ?? 8192,
            metadataSource: merged.source,
        });
        if (result.length >= MAX_MODELS)
            break;
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
}
function modelRecords(profile, payload) {
    if (!isRecord(payload))
        throw new Error("Provider returned invalid model JSON");
    const value = profile.api === "google-generative-ai" ? payload.models : payload.data;
    if (!Array.isArray(value))
        throw new Error("Provider model response does not contain a model list");
    return value.filter(isRecord);
}
function metadataFromProviderRecord(record) {
    const contextWindow = positiveInteger(record.context_window) ??
        positiveInteger(record.contextWindow) ?? positiveInteger(record.inputTokenLimit);
    const maxTokens = positiveInteger(record.max_output_tokens) ??
        positiveInteger(record.maxTokens) ?? positiveInteger(record.outputTokenLimit);
    const modalities = isRecord(record.modalities) && Array.isArray(record.modalities.input)
        ? record.modalities.input.filter((item) => typeof item === "string")
        : undefined;
    const input = modalities?.includes("image") ? ["text", "image"] : undefined;
    const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : undefined;
    if (!contextWindow && !maxTokens && !input && reasoning === undefined)
        return undefined;
    return {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(input ? { input: [...input] } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
        source: "provider",
    };
}
function heuristicMetadata(id) {
    const value = id.toLocaleLowerCase();
    const image = /(?:vision|[-_.]vl(?:[-_.]|$)|pixtral|minicpm-v|gemini|claude-(?:3|4)|gpt-(?:4o|4\.1|5)|o[134](?:[-_.]|$)|grok-(?:2-vision|3|4))/u.test(value);
    const reasoning = /(?:^|[/_.-])(?:o[134]|r1|qwq)(?:[/_.-]|$)|deepseek-r1|qwen3|gpt-5|gemini-(?:2\.5|3)|grok-(?:3|4)|claude-(?:3-7|4)/u.test(value);
    return {
        input: image ? ["text", "image"] : ["text"],
        reasoning,
        source: image || reasoning ? "heuristic" : "default",
    };
}
function mergeMetadata(...items) {
    const result = { source: "default" };
    for (const item of items.reverse()) {
        if (!item)
            continue;
        if (item.name !== undefined)
            result.name = item.name;
        if (item.input !== undefined)
            result.input = item.input;
        if (item.reasoning !== undefined)
            result.reasoning = item.reasoning;
        if (item.contextWindow !== undefined)
            result.contextWindow = item.contextWindow;
        if (item.maxTokens !== undefined)
            result.maxTokens = item.maxTokens;
        result.source = item.source;
    }
    return result;
}
async function loadModelsDevMetadata(fetchImpl) {
    const now = Date.now();
    if (modelsDevCache && modelsDevCache.expiresAt > now)
        return modelsDevCache.models;
    if (modelsDevInflight)
        return modelsDevInflight;
    modelsDevInflight = fetchModelsDevMetadata(fetchImpl).then((models) => {
        modelsDevCache = { expiresAt: Date.now() + MODELS_DEV_CACHE_MS, models };
        return models;
    }).finally(() => {
        modelsDevInflight = undefined;
    });
    return modelsDevInflight;
}
async function fetchModelsDevMetadata(fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetchImpl(MODELS_DEV_URL, {
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`models.dev returned HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_DEV_CHARS) {
            throw new Error("models.dev response is too large");
        }
        const text = await response.text();
        if (text.length > MAX_MODELS_DEV_CHARS)
            throw new Error("models.dev response is too large");
        const payload = parseJson(text);
        if (!isRecord(payload))
            throw new Error("models.dev returned invalid JSON");
        const models = new Map();
        for (const provider of Object.values(payload)) {
            if (!isRecord(provider) || !isRecord(provider.models))
                continue;
            for (const [key, value] of Object.entries(provider.models)) {
                if (!isRecord(value))
                    continue;
                const id = stringValue(value.id) ?? key;
                const limit = isRecord(value.limit) ? value.limit : {};
                const modalities = isRecord(value.modalities) && Array.isArray(value.modalities.input)
                    ? value.modalities.input.filter((item) => typeof item === "string")
                    : [];
                const name = stringValue(value.name);
                const contextWindow = positiveInteger(limit.context);
                const maxTokens = positiveInteger(limit.output);
                const metadata = {
                    ...(name ? { name } : {}),
                    input: modalities.includes("image") ? ["text", "image"] : ["text"],
                    reasoning: value.reasoning === true,
                    ...(contextWindow ? { contextWindow } : {}),
                    ...(maxTokens ? { maxTokens } : {}),
                    source: "models.dev",
                };
                models.set(id, metadata);
                const tail = id.split("/").at(-1);
                if (tail && !models.has(tail))
                    models.set(tail, metadata);
            }
        }
        return models;
    }
    finally {
        clearTimeout(timer);
    }
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        throw new Error("Provider returned invalid JSON");
    }
}
function providerError(value, apiKey) {
    let message = value.trim();
    try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)) {
            const error = isRecord(parsed.error) ? parsed.error : parsed;
            message = stringValue(error.message) ?? stringValue(error.status) ?? message;
        }
    }
    catch {
        // Plain-text provider errors are still useful after clipping and redaction.
    }
    const redacted = message.replaceAll(apiKey, "[REDACTED]").replace(/[\r\n\t]+/g, " ").trim();
    return [...redacted].slice(0, 500).join("") || "request failed";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function boundedInteger(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Value must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=provider-client.js.map