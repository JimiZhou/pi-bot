/** Text-only adapter for the source used by the retained legacy framework. */
export class SuxunMorningNewsSource {
    #url;
    #timeoutMs;
    #maxBytes;
    #fetch;
    constructor(options) {
        this.#url = new URL(options.url);
        if (this.#url.protocol !== "http:" && this.#url.protocol !== "https:") {
            throw new Error("Morning news URL must use HTTP or HTTPS");
        }
        if (this.#url.username || this.#url.password)
            throw new Error("Morning news URL cannot contain credentials");
        this.#timeoutMs = bounded(options.timeoutMs ?? 8000, 500, 60_000, "morning news timeout");
        this.#maxBytes = bounded(options.maxBytes ?? 512 * 1024, 1024, 2 * 1024 * 1024, "morning news max bytes");
        this.#fetch = options.fetch ?? fetch;
    }
    async fetch(signal) {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.#fetch(this.#url, {
            method: "GET",
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: combined,
        });
        if (!response.ok)
            throw new Error(`Morning news source returned HTTP ${response.status}`);
        const text = await boundedResponseText(response, this.#maxBytes);
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            throw new Error("Morning news source returned invalid JSON");
        }
        if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.news)) {
            throw new Error("Morning news source returned an unexpected payload");
        }
        const headlines = value.news
            .filter((item) => typeof item === "string")
            .map(normalizeLine)
            .filter(Boolean)
            .slice(0, 15);
        if (headlines.length === 0)
            throw new Error("Morning news source returned no headlines");
        const date = typeof value.date === "string" ? normalizeLine(value.date).slice(0, 32) : undefined;
        const dailyWords = typeof value.weiyu === "string" ? normalizeLine(value.weiyu).slice(0, 300) : undefined;
        return {
            ...(date ? { date } : {}),
            headlines,
            ...(dailyWords ? { dailyWords } : {}),
            source: this.#url.origin,
        };
    }
}
async function boundedResponseText(response, maxBytes) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
        throw new Error("Morning news response is too large");
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
        const item = await reader.read();
        if (item.done)
            break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error("Morning news response is too large");
        }
        text += decoder.decode(item.value, { stream: true });
    }
    return text + decoder.decode();
}
function normalizeLine(value) {
    return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=morning-news.js.map