import type { KnowledgeItem, KnowledgeRetriever, KnowledgeSearchRequest } from "./types.js";
import type { KnowledgeProviderProfile } from "./config.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HttpKnowledgeRetriever implements KnowledgeRetriever {
  readonly #profile: KnowledgeProviderProfile;
  readonly #apiKey: string | undefined;

  constructor(profile: KnowledgeProviderProfile, apiKey?: string) {
    this.#profile = profile;
    this.#apiKey = apiKey?.trim() || undefined;
    if ((profile.kind === "brave" || profile.kind === "tavily") && !this.#apiKey) {
      throw new Error(`Knowledge provider ${profile.id} requires an API key`);
    }
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeItem[]> {
    const query = request.query.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!query) throw new Error("Knowledge search query cannot be empty");
    const limit = Math.max(1, Math.min(this.#profile.maxResults, request.limit, 8));
    const timeout = AbortSignal.timeout(this.#profile.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    if (this.#profile.kind === "searxng") return this.#searchSearxng(query, limit, signal);
    if (this.#profile.kind === "brave") return this.#searchBrave(query, limit, signal);
    return this.#searchTavily(query, limit, signal);
  }

  async #searchSearxng(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeItem[]> {
    const url = new URL("search", trailingSlash(this.#profile.baseUrl));
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "zh-CN");
    url.searchParams.set("safesearch", "1");
    const payload = await fetchJson(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    const results = recordArray(payload, "results");
    return results.slice(0, limit).flatMap((item) => {
      const title = stringField(item, "title");
      const content = stringField(item, "content");
      const source = httpSource(item.url);
      if (!title || !content || !source) return [];
      return [{ title: cleanText(title, 300), content: cleanText(content, 1600), source }];
    });
  }

  async #searchBrave(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeItem[]> {
    const url = new URL("res/v1/web/search", trailingSlash(this.#profile.baseUrl));
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("search_lang", "zh-hans");
    const payload = await fetchJson(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.#apiKey! },
      signal,
    });
    const web = recordField(payload, "web");
    const results = web ? recordArray(web, "results") : [];
    return results.slice(0, limit).flatMap((item) => {
      const title = stringField(item, "title");
      const content = stringField(item, "description");
      const source = httpSource(item.url);
      if (!title || !content || !source) return [];
      return [{ title: cleanText(title, 300), content: cleanText(content, 1600), source }];
    });
  }

  async #searchTavily(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeItem[]> {
    const payload = await fetchJson(new URL(this.#profile.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.#apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal,
    });
    const results = recordArray(payload, "results");
    return results.slice(0, limit).flatMap((item) => {
      const title = stringField(item, "title");
      const content = stringField(item, "content");
      const source = httpSource(item.url);
      if (!title || !content || !source) return [];
      return [{ title: cleanText(title, 300), content: cleanText(content, 1600), source }];
    });
  }
}

export async function probeKnowledgeProvider(
  profile: KnowledgeProviderProfile,
  apiKey?: string,
  query = "今天的科技新闻",
): Promise<{ latencyMs: number; resultCount: number; results: Array<{ title: string; source?: string }> }> {
  const startedAt = Date.now();
  const results = await new HttpKnowledgeRetriever(profile, apiKey).search({
    query,
    conversationId: "__probe__",
    senderId: "__admin__",
    limit: Math.min(3, profile.maxResults),
  });
  return {
    latencyMs: Date.now() - startedAt,
    resultCount: results.length,
    results: results.map((item) => ({ title: item.title, ...(item.source ? { source: item.source } : {}) })),
  };
}

async function fetchJson(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error" });
  } catch (error) {
    throw new Error(`Knowledge provider request failed: ${errorMessage(error)}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Knowledge provider response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Knowledge provider response is too large");
  if (!response.ok) throw new Error(`Knowledge provider returned HTTP ${response.status}`);
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new Error(`Knowledge provider returned invalid JSON: ${errorMessage(error)}`);
  }
}

function recordArray(value: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  const candidate = value[name];
  return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
}

function recordField(value: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const candidate = value[name];
  return isRecord(candidate) ? candidate : undefined;
}

function stringField(value: Record<string, unknown>, name: string): string | undefined {
  const candidate = value[name];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function cleanText(value: string, maxChars: number): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function httpSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
