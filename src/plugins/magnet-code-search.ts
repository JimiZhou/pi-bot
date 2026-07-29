import type { AgentPlugin, AgentPluginContext, AgentPluginFactory, AgentPluginInboundAction } from "../agent-plugin.js";
import type { BotPluginConfig } from "../config.js";
import type { InboundMessageEvent } from "../types.js";

const SEARCH_ORIGIN = "https://cilisousuo.cc";
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface MagnetCodeSearchSettings {
  timeoutMs: number;
  maxResults: number;
}

export interface MagnetCodeSearchOptions {
  fetch?: typeof globalThis.fetch;
}

/** Resolves exact catalog-code messages to bounded, canonical BTIH magnet links. */
export class MagnetCodeSearchPlugin implements AgentPlugin {
  readonly id: string;
  readonly type = "magnet-code-search";
  readonly #context: AgentPluginContext;
  readonly #settings: MagnetCodeSearchSettings;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: BotPluginConfig, context: AgentPluginContext, options: MagnetCodeSearchOptions = {}) {
    this.id = config.id;
    this.#context = context;
    this.#settings = parseSettings(config.settings);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async handleInbound(event: InboundMessageEvent): Promise<AgentPluginInboundAction | undefined> {
    if (event.conversation.kind !== "group" || event.sender.isBot) return undefined;
    if (!this.#context.isEnabledForConversation(this.type, event.conversation.id)) return undefined;
    const code = parseCatalogCode(event.text);
    if (!code) return undefined;
    if (!this.#context.claim({
      claimKey: `magnet-code-search:${this.#context.botId}:${event.id}`,
      canonicalConversationId: canonicalConversationId(event.conversation.id),
      reason: "magnet-code-search",
      createdAt: event.timestamp ?? Date.now(),
      ambient: false,
    })) return undefined;

    try {
      const magnets = await searchMagnets(code, this.#settings, this.#fetch);
      this.#context.log("info", "plugin.magnet_code_searched", "已按编号查询磁力链接", {
        conversationId: event.conversation.id,
        senderId: event.sender.id,
        code,
        resultCount: magnets.length,
      });
      const text = magnets.length === 0
        ? `未找到 ${code} 的精确磁力链接。`
        : `${code} 查询结果（${magnets.length} 条）：\n${magnets.join("\n")}`;
      return {
        kind: "direct-reply",
        text,
        parts: [{ type: "quote", messageId: event.id, senderId: event.sender.id }, { type: "text", text }],
        reason: "plugin-magnet-code-search",
      };
    } catch (error) {
      this.#context.log("warn", "plugin.magnet_code_search_failed", "磁力编号查询失败", {
        conversationId: event.conversation.id,
        senderId: event.sender.id,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: "direct-reply",
        text: `查询 ${code} 失败，请稍后再试。`,
        parts: [
          { type: "quote", messageId: event.id, senderId: event.sender.id },
          { type: "text", text: `查询 ${code} 失败，请稍后再试。` },
        ],
        reason: "plugin-magnet-code-search-failed",
      };
    }
  }

  tick(): void {
    // Event-driven plugin; no polling work.
  }
}

export const magnetCodeSearchPluginFactory: AgentPluginFactory = {
  type: "magnet-code-search",
  create: (config, context) => new MagnetCodeSearchPlugin(config, context),
};

export function parseCatalogCode(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim().toLocaleUpperCase("en-US");
  return /^[A-Z]{2,12}-\d{2,6}$/u.test(normalized) ? normalized : undefined;
}

export async function searchMagnets(
  code: string,
  settings: MagnetCodeSearchSettings,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  const searchUrl = new URL("/search", SEARCH_ORIGIN);
  searchUrl.searchParams.set("q", code);
  const searchHtml = await fetchHtml(searchUrl, settings.timeoutMs, fetchImpl);
  const detailPaths = exactDetailPaths(searchHtml, code).slice(0, settings.maxResults);
  const details = await Promise.all(detailPaths.map((path) =>
    fetchHtml(new URL(path, SEARCH_ORIGIN), settings.timeoutMs, fetchImpl)
  ));
  return [...new Set(details.map(extractCanonicalMagnet).filter((item): item is string => Boolean(item)))];
}

function exactDetailPaths(html: string, code: string): string[] {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactCode = new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:[^A-Z0-9]|$)`, "iu");
  const paths: string[] = [];
  for (const match of html.matchAll(/<li\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/giu)) {
    const item = match[1] ?? "";
    const searchable = decodeHtml(stripTags(item)).normalize("NFKC");
    if (!exactCode.test(searchable)) continue;
    const href = /<a\b[^>]*class=["'][^"']*\blink\b[^"']*["'][^>]*href=["'](\/magnet\/[a-zA-Z0-9_-]+)["']/iu.exec(item)?.[1]
      ?? /<a\b[^>]*href=["'](\/magnet\/[a-zA-Z0-9_-]+)["'][^>]*class=["'][^"']*\blink\b/iu.exec(item)?.[1];
    if (href && !paths.includes(href)) paths.push(href);
  }
  return paths;
}

function extractCanonicalMagnet(html: string): string | undefined {
  const input = /<input\b[^>]*\bid=["']input-magnet["'][^>]*>/iu.exec(html)?.[0];
  if (!input) return undefined;
  const value = /\bvalue=["']([^"']+)["']/iu.exec(input)?.[1];
  if (!value) return undefined;
  const decoded = decodeHtml(decodeHtml(value));
  const hash = /magnet:\?xt=urn:btih:([a-f\d]{40}|[a-z2-7]{32})(?:&|$)/iu.exec(decoded)?.[1];
  return hash ? `magnet:?xt=urn:btih:${hash.toLocaleLowerCase("en-US")}` : undefined;
}

async function fetchHtml(url: URL, timeoutMs: number, fetchImpl: typeof globalThis.fetch): Promise<string> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "pi-bot/0.2",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`cilisousuo returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLocaleLowerCase().includes("text/html")) {
    throw new Error("cilisousuo returned a non-HTML response");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("cilisousuo response is too large");
  }
  return readLimitedText(response, MAX_RESPONSE_BYTES);
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("cilisousuo response is too large");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function canonicalConversationId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function parseSettings(value: Readonly<Record<string, unknown>>): MagnetCodeSearchSettings {
  return {
    timeoutMs: integer(value.timeoutSeconds ?? 8, 2, 30, "timeoutSeconds") * 1000,
    maxResults: integer(value.maxResults ?? 1, 1, 3, "maxResults"),
  };
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`magnet-code-search ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
