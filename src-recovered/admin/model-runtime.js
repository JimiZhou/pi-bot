import { completeSimple } from "@earendil-works/pi-ai";
const TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVRIx+3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/ehR5RwAAAABJRU5ErkJggg==";
/** Builds a pi-ai runtime model without consulting Pi's bundled provider/model catalog. */
export function resolveCustomModel(profile, providerProfile) {
    return resolveCustomModelWithApi(profile, providerProfile, effectiveModelApi(profile, providerProfile));
}
/** Resolves the concrete protocol used by a bot without consulting Pi's bundled catalog. */
export function effectiveModelApi(profile, providerProfile) {
    if (profile.api !== "inherit" && profile.api !== "auto")
        return profile.api;
    if (profile.api === "inherit" && providerProfile.api !== "auto")
        return providerProfile.api;
    return inferredModelApi(profile.modelId);
}
/** Adapts a shared gateway URL to the path convention expected by each native SDK. */
export function modelProtocolBaseUrl(baseUrl, api) {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    if (api === "google-generative-ai") {
        if (path.endsWith("/v1"))
            url.pathname = `${path.slice(0, -3)}/v1beta`;
        else
            url.pathname = path || "/v1beta";
    }
    else if (api === "anthropic-messages" && path.endsWith("/v1")) {
        url.pathname = path.slice(0, -3) || "/";
    }
    else {
        url.pathname = path || "/";
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
}
function resolveCustomModelWithApi(profile, providerProfile, api) {
    const compat = api === "openai-completions"
        ? {
            ...(profile.openaiThinkingFormat ? { thinkingFormat: profile.openaiThinkingFormat } : {}),
            ...(profile.openaiThinkingFormat === "qwen-chat-template"
                ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" }
                : {}),
        }
        : undefined;
    return {
        id: profile.modelId,
        name: profile.label,
        api,
        provider: providerProfile.provider,
        baseUrl: modelProtocolBaseUrl(providerProfile.baseUrl, api),
        reasoning: profile.reasoning,
        input: profile.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxTokens,
        ...(compat && Object.keys(compat).length > 0 ? { compat } : {}),
    };
}
/** Performs a real, bounded inference through the exact runtime path used by bots. */
export async function testModelConnection(profile, providerProfile, apiKey, options = {}) {
    const candidates = testProtocolCandidates(profile, providerProfile);
    const failures = [];
    for (const api of candidates) {
        try {
            return await testModelConnectionWithApi(profile, providerProfile, apiKey, api, options);
        }
        catch (error) {
            failures.push(`${api}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`模型无法通过候选协议连接（${failures.join("；")}）`);
}
async function testModelConnectionWithApi(profile, providerProfile, apiKey, api, options) {
    const model = resolveCustomModelWithApi(profile, providerProfile, api);
    const image = options.image ?? false;
    if (image && !model.input.includes("image")) {
        throw new Error(`Model ${profile.id} is not configured for image input`);
    }
    const timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1000, 120_000);
    const startedAt = Date.now();
    const reasoning = runtimeThinkingLevel(profile);
    const response = await completeSimple(model, {
        systemPrompt: "You are a connectivity test. Follow the user instruction exactly and answer briefly.",
        messages: [{
                role: "user",
                content: image
                    ? [
                        { type: "text", text: "Reply with the single word RED if you can inspect this test image." },
                        { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" },
                    ]
                    : "Reply with the single word OK.",
                timestamp: Date.now(),
            }],
    }, {
        apiKey,
        maxTokens: Math.min(profile.maxTokens, 32),
        timeoutMs,
        maxRetryDelayMs: Math.min(profile.maxRetryDelayMs, 5000),
        ...(reasoning ? { reasoning } : {}),
    });
    assertSuccessfulResponse(response);
    const responseText = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("")
        .trim();
    if (!responseText)
        throw new Error("Model returned no text");
    return {
        ok: true,
        mode: image ? "image" : "text",
        api,
        latencyMs: Date.now() - startedAt,
        responseText: [...responseText].slice(0, 300).join(""),
        responseModel: response.responseModel || response.model,
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
    };
}
function testProtocolCandidates(profile, providerProfile) {
    if (profile.api !== "auto")
        return [effectiveModelApi(profile, providerProfile)];
    const inferred = inferredModelApi(profile.modelId);
    const providerDefault = providerProfile.api === "auto" ? undefined : providerProfile.api;
    return uniqueProtocols([
        inferred,
        providerDefault,
        "openai-completions",
        "openai-responses",
        "google-generative-ai",
        "anthropic-messages",
    ]);
}
function inferredModelApi(modelId) {
    const id = modelId.normalize("NFKC").toLocaleLowerCase().split("/").at(-1) ?? modelId;
    if (/^(?:models\/)?gemini(?:[-_.]|$)/u.test(id))
        return "google-generative-ai";
    if (/^(?:claude|anthropic)(?:[-_.]|$)/u.test(id))
        return "anthropic-messages";
    return "openai-completions";
}
function uniqueProtocols(values) {
    return [...new Set(values.filter((value) => value !== undefined))];
}
function runtimeThinkingLevel(profile) {
    if (!profile.reasoning || profile.thinkingLevel === "off")
        return undefined;
    return profile.thinkingLevel;
}
function assertSuccessfulResponse(response) {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `Model test stopped with ${response.stopReason}`);
    }
}
function boundedInteger(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Value must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=model-runtime.js.map