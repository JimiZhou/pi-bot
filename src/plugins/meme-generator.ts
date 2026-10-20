import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlugin, AgentPluginContext, AgentPluginFactory, AgentPluginInboundAction } from "../agent-plugin.js";
import type { InboundMessageEvent, MessagePart } from "../types.js";
import { MEDIA_RESOLVE_CAPABILITY } from "../channel-capabilities.js";
import type { BotPluginConfig } from "../config.js";
import type { ResolvedAsset } from "../asset-store.js";
import { customMemeInfo, getCustomMeme, listCustomMemes } from "../meme-custom.js";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:2233";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SEND_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 6;
const MAX_COMMAND_LENGTH = 4_000;
const MAX_TEXT_LENGTH = 1_000;
const MAX_ERROR_TEXT = 180;
const MEME_CATALOG_CACHE_MS = 5 * 60_000;
const MEME_MENU_PAGE_SIZE = 36;

const DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  out: "出去",
  osu: "音游",
  google: "谷歌",
  youtube: "油管",
  pornhub: "片站",
  douyin: "抖音",
  intel_inside: "英特尔",
};

type MemeCategory = "单图" | "多图" | "图文" | "文字" | "无需输入";

interface MemeDefinition {
  key: string;
  keywords: string[];
  defaultTexts: string[];
  minImages: number;
  maxImages: number;
  minTexts: number;
  maxTexts: number;
}

export interface MemeGeneratorSettings {
  apiBaseUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxInputBytes: number;
  maxSendBytes: number;
  maxImages: number;
  defaultArgs: Readonly<Record<string, unknown>>;
}

export type MemeCommand =
  | { kind: "help" }
  | { kind: "list"; page?: number }
  | { kind: "info"; key: string }
  | { kind: "generate"; key: string; texts: string[]; args: Readonly<Record<string, unknown>> };

export interface MemeGeneratorOptions {
  fetch?: typeof globalThis.fetch;
}

/** Bridges the upstream meme-generator FastAPI service into the standard media outbox. */
export class MemeGeneratorPlugin implements AgentPlugin {
  readonly id: string;
  readonly type = "meme-generator";
  readonly #context: AgentPluginContext;
  readonly #settings: MemeGeneratorSettings;
  readonly #fetch: typeof globalThis.fetch;
  #catalog: MemeDefinition[] | undefined;
  #catalogExpiresAt = 0;

  constructor(config: BotPluginConfig, context: AgentPluginContext, options: MemeGeneratorOptions = {}) {
    this.id = config.id;
    this.#context = context;
    this.#settings = parseSettings(config.settings);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async handleInbound(event: InboundMessageEvent): Promise<AgentPluginInboundAction | undefined> {
    if (event.sender.isBot) return undefined;
    if (!this.#context.isEnabledForConversation(this.type, event.conversation.id)) return undefined;
    const command = parseMemeCommand(memeCommandText(event, this.#context));
    if (!command) return undefined;
    const preferredBotId = event.conversation.kind === "group"
      ? this.#context.preferredGroupBotId?.(event.conversation.id)
      : undefined;
    if (
      event.conversation.kind === "group" &&
      preferredBotId !== undefined &&
      preferredBotId !== this.#context.botId
    ) {
      this.#context.log("debug", "plugin.meme_generator_routed", "共享群里的 meme 请求交给首选机器人处理", {
        conversationId: event.conversation.id,
        preferredBotId,
        currentBotId: this.#context.botId,
      });
      return undefined;
    }

    if (!this.#context.claim({
      claimKey: `meme-generator:${this.#context.botId}:${event.id}`,
      canonicalConversationId: canonicalConversationId(event.conversation.id),
      reason: `meme-generator-${command.kind}`,
      createdAt: event.timestamp ?? Date.now(),
      ambient: false,
    })) return undefined;

    try {
      switch (command.kind) {
        case "help":
          return textReply(memeHelpText(), "plugin-meme-generator-help", event);
        case "list":
          return textReply(await this.#listMemes(command.page), "plugin-meme-generator-list", event);
        case "info":
          return textReply(await this.#memeInfo(command.key), "plugin-meme-generator-info", event);
        case "generate":
          return await this.#generate(event, command);
        default:
          return assertNever(command);
      }
    } catch (error) {
      const message = errorMessage(error);
      this.#context.log("warn", "plugin.meme_generator_failed", "表情包生成失败", {
        conversationId: event.conversation.id,
        senderId: event.sender.id,
        command: event.text.slice(0, MAX_COMMAND_LENGTH),
        error: message,
      });
      return textReply(`表情包生成失败：${message}`, "plugin-meme-generator-failed", event);
    }
  }

  tick(): void {
    // Event-driven plugin; no polling work.
  }

  async #listMemes(page = 1): Promise<string> {
    const definitions = (await this.#getCatalog()).slice().sort(compareMemeDefinitions);
    if (definitions.length === 0) {
      return "【表情包菜单】\n当前没有可用表情包。";
    }
    const pageCount = Math.max(1, Math.ceil(definitions.length / MEME_MENU_PAGE_SIZE));
    const currentPage = Math.min(Math.max(page, 1), pageCount);
    const shown = definitions.slice((currentPage - 1) * MEME_MENU_PAGE_SIZE, currentPage * MEME_MENU_PAGE_SIZE);
    const grouped = new Map<MemeCategory, MemeDefinition[]>();
    for (const definition of shown) {
      const category = memeCategory(definition);
      const group = grouped.get(category) ?? [];
      group.push(definition);
      grouped.set(category, group);
    }
    const categoryOrder: MemeCategory[] = ["单图", "多图", "图文", "文字", "无需输入"];
    return [
      `【表情包菜单】第 ${currentPage}/${pageCount} 页，共 ${definitions.length} 个`,
      "发送：meme 中文名称 [文字1 | 文字2]；括号内是兼容 key。",
      ...categoryOrder.flatMap((category) => {
        const group = grouped.get(category);
        return group?.length ? [`\n${category}（${group.length}）`, formatMemeDefinitions(group)] : [];
      }),
      "\n示例：发送 meme 摸摸 会先看动态预览；回复或附上图片后再次发送，才会生成你的版本。",
      `\n查看详情：meme 详情 中文名称${pageCount > 1 ? `；下一页：meme 菜单 ${currentPage >= pageCount ? 1 : currentPage + 1}` : ""}`,
    ].join("\n");
  }

  async #memeInfo(input: string): Promise<string> {
    const definition = await this.#resolveMeme(input);
    return [
      `【${displayName(definition)}】`,
      `key：${definition.key}`,
      definition.keywords.length > 0 ? `中文关键词：${definition.keywords.join("、")}` : "",
      `图片数：${rangeText(definition.minImages, definition.maxImages)}`,
      `文字数：${rangeText(definition.minTexts, definition.maxTexts)}`,
      definition.defaultTexts.length > 0 ? `默认文字：${definition.defaultTexts.join(" | ")}` : "",
      `示例：meme ${displayName(definition)}`,
      `生成：meme ${displayName(definition)}`,
    ].filter(Boolean).join("\n");
  }

  async #generate(event: InboundMessageEvent, command: Extract<MemeCommand, { kind: "generate" }>): Promise<AgentPluginInboundAction> {
    const assets = this.#context.assets;
    if (!assets) throw new Error("Bot 没有配置本地媒体仓库");

    const definition = await this.#resolveMeme(command.key);
    const custom = await getCustomMeme(definition.key);
    const imageParts = inputImageParts(event, this.#context);
    let result: { bytes: Uint8Array; mimeType: string };
    let imageCount = 0;
    if (custom) {
      if (Object.keys(command.args).length > 0 || imageParts.length > 0) {
        return textReply(`“${displayName(definition)}”不需要参数或输入图片，直接发送 meme ${displayName(definition)} 即可。`, "plugin-meme-generator-custom-no-inputs", event);
      }
      result = { bytes: custom.bytes, mimeType: custom.mimeType };
    } else {
      // A zero-text meme should be forgiving in group chats: adapter mention
      // decorations or casual words after the key must not turn into a hard
      // "provided 1 text" error. Text-bearing memes still keep their inputs.
      const texts = definition.maxTexts === 0
        ? []
        : command.texts.length === 0 ? definition.defaultTexts : command.texts;
      if (imageParts.length === 0 && texts.length === 0 && Object.keys(command.args).length === 0) {
        return await this.#previewMeme(definition);
      }
      if (imageParts.length < definition.minImages || imageParts.length > definition.maxImages) {
        return textReply(
          `“${displayName(definition)}”需要 ${rangeText(definition.minImages, definition.maxImages)} 张图片，你提供了 ${imageParts.length} 张。请回复或附上符合数量的图片后重试。`,
          "plugin-meme-generator-invalid-image-count",
          event,
        );
      }
      if (texts.length < definition.minTexts || texts.length > definition.maxTexts) {
        return textReply(
          `“${displayName(definition)}”需要 ${rangeText(definition.minTexts, definition.maxTexts)} 段文字，你提供了 ${texts.length} 段。用“ | ”分隔多段文字。`,
          "plugin-meme-generator-invalid-text-count",
          event,
        );
      }
      if (imageParts.length > this.#settings.maxImages) {
        return textReply(`这次最多使用 ${this.#settings.maxImages} 张图片，请减少附件后重试。`, "plugin-meme-generator-too-many-images", event);
      }
      const images = await Promise.all(imageParts.map((part, index) => this.#resolveImage(part, index)));
      result = await this.#postMeme({ ...command, key: definition.key, texts }, images);
      imageCount = images.length;
    }
    const compressed = await compressForChat(result.bytes, result.mimeType, this.#settings.maxSendBytes);
    const asset = await assets.put({
      data: compressed.bytes,
      mimeType: compressed.mimeType,
      name: `meme-${safeFileName(definition.key)}.${extensionForMime(compressed.mimeType)}`,
      metadata: {
        kind: compressed.mimeType === "image/gif" ? "emoji" : "meme-generator",
        memeKey: definition.key,
        collectedByBotId: this.#context.botId,
      },
    });
    this.#context.log("info", "plugin.meme_generated", "已生成表情包", {
      conversationId: event.conversation.id,
      senderId: event.sender.id,
      memeKey: definition.key,
      imageCount,
      outputBytes: compressed.bytes.byteLength,
      originalBytes: result.bytes.byteLength,
      compressed: compressed.bytes.byteLength < result.bytes.byteLength,
      mimeType: compressed.mimeType,
    });
    return {
      kind: "direct-reply",
      text: "",
      parts: [{ type: "image", asset, alt: `表情包 ${displayName(definition)}` }],
      reason: "plugin-meme-generator",
    };
  }

  async #previewMeme(definition: MemeDefinition): Promise<AgentPluginInboundAction> {
    const assets = this.#context.assets;
    if (!assets) throw new Error("Bot 没有配置本地媒体仓库");
    const response = await this.#fetch(apiUrl(this.#settings.apiBaseUrl, `memes/${encodeURIComponent(definition.key)}/preview`), {
      method: "GET",
      signal: AbortSignal.timeout(this.#settings.timeoutMs),
    });
    const result = await this.#readMemeImageResponse(response);
    const compressed = await compressForChat(result.bytes, result.mimeType, this.#settings.maxSendBytes);
    const asset = await assets.put({
      data: compressed.bytes,
      mimeType: compressed.mimeType,
      name: `meme-preview-${safeFileName(definition.key)}.${extensionForMime(compressed.mimeType)}`,
      metadata: {
        kind: compressed.mimeType === "image/gif" ? "emoji" : "meme-generator",
        memeKey: definition.key,
        preview: true,
        collectedByBotId: this.#context.botId,
      },
    });
    const text = `【${displayName(definition)} 示例】这是模板预览。${definition.minImages > 0 ? `回复或附上 ${rangeText(definition.minImages, definition.maxImages)} 张图片后发送 meme ${displayName(definition)}，即可生成你的版本。` : `发送 meme ${displayName(definition)} 加上文字即可生成你的版本。`}`;
    return {
      kind: "direct-reply",
      text,
      parts: [{ type: "text", text }, { type: "image", asset, alt: `${displayName(definition)} 示例` }],
      reason: "plugin-meme-generator-preview",
    };
  }

  async #resolveImage(part: Extract<MessagePart, { type: "image" }>, index: number): Promise<Uint8Array> {
    let resolved: ResolvedAsset;
    if (part.asset.source === "local") {
      if (!this.#context.assets) throw new Error("Bot 没有配置本地媒体仓库");
      resolved = await this.#context.assets.resolve(part.asset);
    } else if (part.asset.source === "platform") {
      resolved = await this.#context.runtime.invoke(MEDIA_RESOLVE_CAPABILITY, { asset: part.asset });
    } else {
      throw new Error("表情包输入图片必须来自当前聊天或本地媒体仓库");
    }
    return collectBytes(resolved.content, this.#settings.maxInputBytes, `第 ${index + 1} 张输入图片`);
  }

  async #postMeme(
    command: Extract<MemeCommand, { kind: "generate" }>,
    images: readonly Uint8Array[],
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const form = new FormData();
    images.forEach((image, index) => {
      form.append(
        "images",
        new Blob([Buffer.from(image)], { type: "application/octet-stream" }),
        `input-${index + 1}.bin`,
      );
    });
    for (const text of command.texts) form.append("texts", text);
    form.append("args", JSON.stringify({ ...this.#settings.defaultArgs, ...command.args }));

    const response = await this.#fetch(memeUrl(this.#settings.apiBaseUrl, command.key), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.#settings.timeoutMs),
    });
    return await this.#readMemeImageResponse(response);
  }

  async #readMemeImageResponse(response: Response): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const bytes = await readBoundedResponse(response, this.#settings.maxResponseBytes);
    if (!response.ok) throw upstreamError(response.status, bytes);
    const mimeType = sniffImageMimeType(bytes) ?? response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase();
    if (!mimeType?.startsWith("image/")) throw new Error("表情服务没有返回可发送的图片");
    return { bytes, mimeType };
  }

  async #getJson(path: string): Promise<unknown> {
    const response = await this.#fetch(apiUrl(this.#settings.apiBaseUrl, path), {
      method: "GET",
      signal: AbortSignal.timeout(this.#settings.timeoutMs),
    });
    const bytes = await readBoundedResponse(response, Math.min(this.#settings.maxResponseBytes, 4 * 1024 * 1024));
    if (!response.ok) throw upstreamError(response.status, bytes);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error("表情服务返回了无效 JSON");
    }
  }

  async #getCatalog(): Promise<MemeDefinition[]> {
    if (this.#catalog && this.#catalogExpiresAt > Date.now()) return this.#catalog;
    const customMemes = await listCustomMemes();
    let value: unknown = [];
    try {
      value = await this.#getJson("memes/keys");
    } catch (error) {
      if (customMemes.length === 0) throw error;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error("表情服务返回的列表格式无效");
    }
    const keys = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    const definitions = await mapConcurrent(keys, 8, async (key) => {
      try {
        return normalizeMemeDefinition(key, await this.#getJson(`memes/${encodeURIComponent(key)}/info`));
      } catch {
        return fallbackMemeDefinition(key);
      }
    });
    this.#catalog = [
      ...customMemes.map((meme) => normalizeMemeDefinition(meme.key, customMemeInfo(meme))),
      ...definitions.filter((definition) => !customMemes.some((meme) => meme.key === definition.key)),
    ];
    this.#catalogExpiresAt = Date.now() + MEME_CATALOG_CACHE_MS;
    return this.#catalog;
  }

  async #resolveMeme(input: string): Promise<MemeDefinition> {
    const customMemes = await listCustomMemes();
    const normalized = normalizeMemeLookup(input);
    const exactCustom = customMemes
      .map((meme) => normalizeMemeDefinition(meme.key, customMemeInfo(meme)))
      .find((definition) => definition.key === input
        || normalizeMemeLookup(definition.key) === normalized
        || definition.keywords.some((keyword) => normalizeMemeLookup(keyword) === normalized));
    if (exactCustom) return exactCustom;
    if (isMemeKey(input)) {
      try {
        return normalizeMemeDefinition(input, await this.#getJson(`memes/${encodeURIComponent(input)}/info`));
      } catch {
        // Try case-insensitive keys and Chinese keywords from the complete catalog below.
      }
    }
    const definitions = await this.#getCatalog();
    const exact = definitions.find((definition) => definition.key === input)
      ?? definitions.find((definition) => normalizeMemeLookup(definition.key) === normalized)
      ?? definitions.find((definition) => definition.keywords.some((keyword) => normalizeMemeLookup(keyword) === normalized));
    if (exact) return exact;
    const suggestions = definitions
      .filter((definition) => definition.keywords.some((keyword) => normalizeMemeLookup(keyword).includes(normalized)) || normalizeMemeLookup(definition.key).includes(normalized))
      .slice(0, 5)
      .map((definition) => `${displayName(definition)}（${definition.key}）`);
    throw new Error([
      `找不到表情包“${input}”`,
      suggestions.length > 0 ? `你是不是想用：${suggestions.join("、")}` : "请发送 meme 菜单查看可用中文名称",
    ].join("。"));
  }
}

export const memeGeneratorPluginFactory: AgentPluginFactory = {
  type: "meme-generator",
  create: (config, context) => new MemeGeneratorPlugin(config, context),
};

export function parseMemeCommand(value: string): MemeCommand | undefined {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > MAX_COMMAND_LENGTH) return undefined;
  const match = /^(?:\/?(?:meme|表情|生成表情))(?:\s+([\s\S]*))?$/iu.exec(normalized);
  if (!match) return undefined;
  const body = match[1]?.trim() ?? "";
  if (!body || /^(?:help|帮助)$/iu.test(body)) return { kind: "help" };

  const keyMatch = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(body);
  if (!keyMatch) return { kind: "help" };
  const key = keyMatch[1]!;
  const commandKey = key.toLocaleLowerCase();
  if (commandKey === "list" || key === "列表" || key === "菜单" || commandKey === "menu") {
    const pageText = keyMatch[2]?.trim() ?? "";
    if (!pageText) return { kind: "list" };
    if (!/^\d{1,3}$/u.test(pageText)) return { kind: "help" };
    return { kind: "list", page: Number(pageText) };
  }
  if (commandKey === "info" || key === "详情") {
    const infoKey = keyMatch[2]?.trim() ?? "";
    return isMemeLookupToken(infoKey) ? { kind: "info", key: infoKey } : { kind: "help" };
  }
  if (!isMemeLookupToken(key)) return { kind: "help" };

  let rest = keyMatch[2]?.trim() ?? "";
  let args: Readonly<Record<string, unknown>> = {};
  const argsMatch = /(?:^|\s)--args(?:=|\s+)(\{[\s\S]*\})\s*$/u.exec(rest);
  if (argsMatch) {
    try {
      const parsed = JSON.parse(argsMatch[1]!) as unknown;
      if (!isRecord(parsed)) return { kind: "help" };
      args = parsed;
      rest = rest.slice(0, argsMatch.index).trim();
    } catch {
      return { kind: "help" };
    }
  }
  const texts = rest
    ? rest.split(/\s*\|\s*/u).map((item) => item.trim()).filter(Boolean)
    : [];
  if (texts.some((text) => [...text].length > MAX_TEXT_LENGTH)) return { kind: "help" };
  return { kind: "generate", key, texts, args };
}

function parseSettings(value: Readonly<Record<string, unknown>>): MemeGeneratorSettings {
  const apiBaseUrl = typeof value.apiBaseUrl === "string" && value.apiBaseUrl.trim()
    ? value.apiBaseUrl.trim()
    : process.env.PI_MEME_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const url = new URL(apiBaseUrl);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    throw new Error("meme-generator apiBaseUrl 必须是无凭据、无查询参数的 HTTP(S) URL");
  }
  const defaultArgs = value.defaultArgs === undefined ? {} : value.defaultArgs;
  if (!isRecord(defaultArgs)) throw new Error("meme-generator defaultArgs 必须是 JSON 对象");
  try {
    JSON.stringify(defaultArgs);
  } catch {
    throw new Error("meme-generator defaultArgs 必须可序列化为 JSON");
  }
  return {
    apiBaseUrl,
    timeoutMs: integer(value.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000, 1, 300, "timeoutSeconds") * 1_000,
    maxResponseBytes: integer(value.maxResponseMb ?? DEFAULT_MAX_RESPONSE_BYTES / 1024 / 1024, 1, 256, "maxResponseMb") * 1024 * 1024,
    maxInputBytes: integer(value.maxInputMb ?? DEFAULT_MAX_INPUT_BYTES / 1024 / 1024, 1, 64, "maxInputMb") * 1024 * 1024,
    maxSendBytes: integer(value.maxSendMb ?? DEFAULT_MAX_SEND_BYTES / 1024 / 1024, 1, 32, "maxSendMb") * 1024 * 1024,
    maxImages: integer(value.maxImages ?? DEFAULT_MAX_IMAGES, 1, 12, "maxImages"),
    defaultArgs,
  };
}

function inputImageParts(event: InboundMessageEvent, context: AgentPluginContext): Array<Extract<MessagePart, { type: "image" }>> {
  const result: Array<Extract<MessagePart, { type: "image" }>> = [];
  const seen = new Set<string>();
  const add = (part: Extract<MessagePart, { type: "image" }>) => {
    const key = part.asset.sha256 ?? `${part.asset.source}:${part.asset.locator}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(part);
  };
  for (const part of event.parts ?? []) if (part.type === "image") add(part);
  if (event.replyTo?.messageId) {
    try {
      for (const image of context.core.inboundImages(event.replyTo.messageId)) add(image.part);
    } catch {
      // A reply can refer to a message outside this Core's retention window.
    }
  }
  return result;
}

function memeCommandText(event: InboundMessageEvent, context: AgentPluginContext): string {
  if (event.conversation.kind === "group") {
    // Group commands are intentionally ambient: users do not need to mention
    // a specific bot. Ignore anything before the first standalone command
    // token, including native @-mention decorations from the adapter.
    return extractMemeCommand(event.text);
  }
  const identityIds = [context.identityId, ...(context.identityAliases?.(event.conversation.id) ?? [])];
  if (!mentionsIdentity(event, identityIds)) return event.text;
  // Adapters commonly serialize a native @ mention as "@Bot\ncommand"; some use a space or colon.
  return event.text.replace(/^\s*(?:@[^\s\r\n:：]+(?:\s+|[：:]\s*|$))+/u, "").trim();
}

function extractMemeCommand(value: string): string {
  const match = /(?:^|[\s@])((?:\/?meme|表情|生成表情))(?=$|[\s:：])/iu.exec(value.normalize("NFKC"));
  if (!match) return "";
  const rest = value.slice((match.index ?? 0) + match[0].length).replace(/^[：:]\s*/u, "").trim();
  return `${match[1]}${rest ? ` ${rest}` : ""}`;
}

function mentionsIdentity(event: InboundMessageEvent, identityIds: readonly string[]): boolean {
  const canonical = new Set(identityIds.map(canonicalIdentityId));
  return (event.mentions ?? []).some((mention) => canonical.has(canonicalIdentityId(mention.id)));
}

function textReply(text: string, reason: string, event: InboundMessageEvent): AgentPluginInboundAction {
  return {
    kind: "direct-reply",
    text,
    parts: [{ type: "quote", messageId: event.id, senderId: event.sender.id }, { type: "text", text }],
    reason,
  };
}

function memeHelpText(): string {
  return [
    "【表情包】",
    "meme 菜单：查看中文名称和分类菜单",
    "meme 中文名称 [文字1 | 文字2]：按中文名称生成",
    "meme 详情 中文名称：查看所需图片和文字数量",
    "例：发送 meme 摸摸 先看动态示例；回复一张图片后再次发送 meme 摸摸，生成你的版本。",
    "也支持英文 key，例如 meme petpet；多张图请在同一条消息附上，或回复包含图片的消息。",
    "高级参数：末尾追加 --args {\"参数\":值}。",
  ].join("\n");
}

function apiUrl(baseUrl: string, path: string): URL {
  const root = new URL(baseUrl);
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return new URL(path.replace(/^\/+/, ""), root);
}

function memeUrl(baseUrl: string, key: string): URL {
  return apiUrl(baseUrl, `memes/${encodeURIComponent(key)}/`);
}

function normalizeMemeDefinition(key: string, value: unknown): MemeDefinition {
  const object = isRecord(value) ? value : {};
  const params = isRecord(object.params_type) ? object.params_type : object;
  const keywords = Array.isArray(object.keywords)
    ? object.keywords.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  const defaultTexts = Array.isArray(params.default_texts)
    ? params.default_texts.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    key,
    keywords,
    defaultTexts,
    minImages: integerOr(params.min_images, 0),
    maxImages: integerOr(params.max_images, integerOr(params.min_images, 0)),
    minTexts: integerOr(params.min_texts, 0),
    maxTexts: integerOr(params.max_texts, integerOr(params.min_texts, 0)),
  };
}

function fallbackMemeDefinition(key: string): MemeDefinition {
  return { key, keywords: [], defaultTexts: [], minImages: 0, maxImages: 12, minTexts: 0, maxTexts: 12 };
}

function displayName(definition: MemeDefinition): string {
  return definition.keywords.filter((keyword) => /[\u3400-\u9fff]/u.test(keyword)).sort((left, right) => right.length - left.length)[0]
    ?? DISPLAY_NAME_OVERRIDES[definition.key]
    ?? definition.key.replace(/[_-]+/gu, " ");
}

function compareMemeDefinitions(left: MemeDefinition, right: MemeDefinition): number {
  return displayName(left).localeCompare(displayName(right), "zh-Hans") || left.key.localeCompare(right.key);
}

function formatMemeDefinitions(definitions: readonly MemeDefinition[]): string {
  return definitions.map((definition) => `${displayName(definition)}（${definition.key}）`).join("、");
}

function memeCategory(definition: MemeDefinition): MemeCategory {
  if (definition.minImages > 0 && definition.minTexts > 0) return "图文";
  if (definition.minImages > 1) return "多图";
  if (definition.minImages === 1) return "单图";
  if (definition.maxTexts > 0) return "文字";
  return "无需输入";
}

function normalizeMemeLookup(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_-]+/gu, "");
}

function isMemeLookupToken(value: string): boolean {
  return /^[^\s|]{1,64}$/u.test(value) && !value.startsWith("--");
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error("表情服务返回文件过大");
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("表情服务返回文件过大");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks, size);
}

async function collectBytes(content: AsyncIterable<Uint8Array>, maxBytes: number, label: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    if (!(chunk instanceof Uint8Array)) throw new Error(`${label}不是有效的二进制数据`);
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
    chunks.push(chunk);
  }
  if (size === 0) throw new Error(`${label}为空`);
  return concatBytes(chunks, size);
}

interface CompressedMeme {
  bytes: Uint8Array;
  mimeType: string;
}

/** Preserves usable output; oversized media is reduced to the configured send limit. */
export async function compressForChat(bytes: Uint8Array, mimeType: string, maxBytes: number): Promise<CompressedMeme> {
  const isGif = mimeType === "image/gif" || sniffImageMimeType(bytes) === "image/gif";
  if (bytes.byteLength <= maxBytes) return { bytes, mimeType };
  let smallest: CompressedMeme | undefined;
  if (isGif) {
    for (const profile of [
      { width: 200, fps: 8, colors: 128 },
      { width: 160, fps: 8, colors: 96 },
      { width: 128, fps: 8, colors: 64 },
      { width: 96, fps: 6, colors: 48 },
      { width: 80, fps: 5, colors: 32 },
    ]) {
      let candidate: CompressedMeme;
      try {
        candidate = { bytes: await runFfmpeg(bytes, gifCompressionArgs(profile)), mimeType: "image/gif" };
      } catch (error) {
        // Keep malformed test/legacy payloads readable by the caller; real meme
        // responses are valid GIFs and continue through the native-safe profiles.
        if (!smallest && profile.width === 200) {
          if (bytes.byteLength <= maxBytes) return { bytes, mimeType };
          throw error;
        }
        continue;
      }
      if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
      if (candidate.bytes.byteLength <= maxBytes) return candidate;
    }
  } else {
    for (const profile of [
      { width: 1280, quality: 7 },
      { width: 960, quality: 8 },
      { width: 720, quality: 9 },
      { width: 480, quality: 10 },
    ]) {
      const candidate: CompressedMeme = { bytes: await runFfmpeg(bytes, stillImageCompressionArgs(profile)), mimeType: "image/jpeg" };
      if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
      if (candidate.bytes.byteLength <= maxBytes) return candidate;
    }
  }
  throw new Error(`图片压缩后仍有 ${formatBytes(smallest?.bytes.byteLength ?? bytes.byteLength)}，超过 ${formatBytes(maxBytes)} 限制`);
}

function gifCompressionArgs(profile: { width: number; fps: number; colors: number }): string[] {
  const filter = [
    `fps=${profile.fps},scale=w='min(${profile.width},iw)':h=-2:flags=lanczos,split[s0][s1]`,
    `[s0]palettegen=max_colors=${profile.colors}[p]`,
    "[s1][p]paletteuse=dither=bayer",
  ].join(";");
  return ["-filter_complex", filter, "-loop", "0", "-f", "gif", "pipe:1"];
}

function stillImageCompressionArgs(profile: { width: number; quality: number }): string[] {
  return [
    "-vf",
    `scale=w='min(${profile.width},iw)':h=-2:flags=lanczos`,
    "-frames:v",
    "1",
    "-q:v",
    String(profile.quality),
    "-f",
    "mjpeg",
    "pipe:1",
  ];
}

function runFfmpeg(input: Uint8Array, outputArgs: readonly string[]): Promise<Uint8Array> {
  return (async () => {
    const directory = await createMemeTempDirectory();
    const inputPath = join(directory, "input.bin");
    const outputPath = join(directory, "output.bin");
    try {
      await writeFile(inputPath, input);
      await runFfmpegProcess(inputPath, outputPath, outputArgs);
      const outputStat = await stat(outputPath);
      if (outputStat.size === 0) throw new Error("图片压缩没有产生输出");
      if (outputStat.size > DEFAULT_MAX_RESPONSE_BYTES) throw new Error("图片压缩过程输出过大");
      return new Uint8Array(await readFile(outputPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

async function createMemeTempDirectory(): Promise<string> {
  let lastError: unknown;
  for (const base of [...new Set([tmpdir(), "/tmp"])]) {
    try {
      return await mkdtemp(join(base, "pi-bot-meme-"));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法创建图片压缩临时目录");
}

function runFfmpegProcess(inputPath: string, outputPath: string, outputArgs: readonly string[]): Promise<void> {
  const args = [...outputArgs];
  args[args.length - 1] = outputPath;
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      ...args,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once("error", fail);
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").replace(/\s+/gu, " ").trim().slice(0, MAX_ERROR_TEXT);
        reject(new Error(detail ? `图片压缩失败：${detail}` : "图片压缩失败"));
        return;
      }
      resolve();
    });
  });
}

function concatBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sniffImageMimeType(data: Uint8Array): string | undefined {
  if (data.length >= 6) {
    const header = new TextDecoder().decode(data.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (data.length >= 8 && data.subarray(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && new TextDecoder().decode(data.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(data.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function upstreamError(status: number, bytes: Uint8Array): Error {
  const detail = new TextDecoder().decode(bytes).replace(/\s+/gu, " ").trim().slice(0, MAX_ERROR_TEXT);
  if (status === 404) return new Error("没有找到这个表情模板，请发送 meme 菜单查看可用中文名称");
  if (status === 541) return new Error("这个模板的输入数量不符合要求，请发送 meme 详情 中文名称查看需要几张图片或几段文字");
  return new Error(detail ? `上游服务 HTTP ${status}：${detail}` : `上游服务 HTTP ${status}`);
}

function extensionForMime(mimeType: string): string {
  return mimeType === "image/gif" ? "gif" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 64) || "meme";
}

function isMemeKey(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`meme-generator ${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value as number;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function rangeText(min: number, max: number): string {
  return min === max ? String(min) : `${min} ~ ${max}`;
}

function canonicalConversationId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function canonicalIdentityId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_ERROR_TEXT) || "未知错误";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(value / 1024))} KB`;
}

function assertNever(value: never): never {
  throw new Error(`未知 meme 命令：${String(value)}`);
}
