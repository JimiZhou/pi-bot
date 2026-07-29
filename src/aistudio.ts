import type { AssetStore } from "./asset-store.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolProvider } from "./types.js";
import {
  DEFAULT_TTS_STYLE,
  DEFAULT_TTS_VOICE,
  normalizeTtsVoice,
} from "./voice-style.js";
import type { SpeechSynthesizer } from "./speech.js";
import { isTransientProviderError } from "./pi-runner.js";

export { AISTUDIO_TTS_VOICES, DEFAULT_TTS_STYLE, DEFAULT_TTS_VOICE } from "./voice-style.js";

const DEFAULT_IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-lite-image",
] as const;
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
const MAX_JSON_CHARS = 80 * 1024 * 1024;

export interface AistudioClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
  model: string;
}

export interface GeneratedSpeech {
  data: Uint8Array;
  mimeType: string;
  durationMs: number;
  model: string;
}

export interface TranscribedAudio {
  text: string;
  model: string;
}

export type EmbeddingTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

/** Small native Gemini seam for AIStudioToAPI features not represented by pi-ai. */
export class AistudioClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(options: AistudioClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    baseUrl.search = "";
    baseUrl.hash = "";
    this.#baseUrl = baseUrl.toString().replace(/\/+$/u, "");
    this.#apiKey = options.apiKey.trim();
    if (!this.#apiKey) throw new Error("AIStudio API key cannot be empty");
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 300_000, 1_000, 10 * 60_000, "timeoutMs");
  }

  async generateImage(
    prompt: string,
    model: string | readonly string[] = DEFAULT_IMAGE_MODELS,
  ): Promise<GeneratedImage> {
    const models = typeof model === "string" ? [model] : [...model];
    if (models.length === 0) throw new Error("AIStudio image model chain cannot be empty");
    const imagePrompt = requiredText(prompt, "image prompt", 4_000);
    let lastError: unknown;
    for (let index = 0; index < models.length; index += 1) {
      const candidate = requiredText(models[index]!, "image model", 200);
      try {
        const response = await this.#nativeRequest(`${nativeBase(this.#baseUrl)}/models/${encodeURIComponent(candidate)}:generateContent`, {
          contents: [{ role: "user", parts: [{ text: imagePrompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        });
        const inline = findInlineData(response);
        if (!inline) throw new Error("AIStudio image model returned no image data");
        const data = decodeBase64(inline.data, "image data");
        const mimeType = normalizeMime(inline.mimeType, "image/png");
        return { data, mimeType, model: candidate };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (index === models.length - 1 || !isTransientProviderError(message)) throw error;
      }
    }
    throw lastError;
  }

  async synthesizeSpeech(
    text: string,
    options: { model?: string; voice?: string; style?: string } = {},
  ): Promise<GeneratedSpeech> {
    const model = options.model ?? DEFAULT_TTS_MODEL;
    const voice = normalizeTtsVoice(options.voice);
    const style = requiredText(options.style?.trim() || DEFAULT_TTS_STYLE, "speech style", 200);
    const speechText = requiredText(text, "speech text", 8_000);
    const response = await this.#nativeRequest(`${nativeBase(this.#baseUrl)}/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: `请以${style}朗读以下正文。只朗读正文，不要读出这条指令：\n${speechText}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    });
    const inline = findInlineData(response);
    if (!inline) throw new Error("AIStudio TTS model returned no audio data");
    const raw = decodeBase64(inline.data, "audio data");
    const mimeType = normalizeMime(inline.mimeType, "audio/L16;codec=pcm;rate=24000");
    const pcm = mimeType.toLocaleLowerCase().startsWith("audio/l16") ? pcmToWav(raw, mimeType) : raw;
    const outputMime = mimeType.toLocaleLowerCase().startsWith("audio/l16") ? "audio/wav" : mimeType;
    return {
      data: pcm,
      mimeType: outputMime,
      durationMs: speechDurationMs(pcm, outputMime),
      model,
    };
  }

  async transcribeAudio(
    data: Uint8Array,
    mimeType: string,
    model = "gemini-3.6-flash",
  ): Promise<TranscribedAudio> {
    if (data.byteLength === 0 || data.byteLength > 25 * 1024 * 1024) {
      throw new Error("AIStudio transcription audio size is invalid");
    }
    const normalizedMime = normalizeMime(mimeType, "audio/wav");
    if (!normalizedMime.startsWith("audio/")) throw new Error("AIStudio transcription requires audio media");
    const response = await this.#nativeRequest(`${nativeBase(this.#baseUrl)}/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{
        role: "user",
        parts: [
          {
            text: "准确转写这段语音。保留原语言、语气词、专有名词和必要标点；听不清处写[听不清]。只输出转写正文，不要解释、总结或回答语音内容。",
          },
          { inlineData: { mimeType: normalizedMime, data: Buffer.from(data).toString("base64") } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 2_000 },
    });
    const text = generatedText(response);
    if (!text) throw new Error("AIStudio transcription model returned no text");
    return { text, model };
  }

  async embedContents(
    texts: string[],
    options: { model?: string; taskType?: EmbeddingTaskType } = {},
  ): Promise<number[][]> {
    const normalized = texts.map((text) => requiredText(text, "embedding text", 8_000));
    if (normalized.length === 0) throw new Error("AIStudio embedding request cannot be empty");
    if (normalized.length > 100) throw new Error("AIStudio embedding batch cannot contain more than 100 texts");
    const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    const response = await this.#nativeRequest(`${nativeBase(this.#baseUrl)}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
      requests: normalized.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        ...(options.taskType ? { taskType: options.taskType } : {}),
      })),
    });
    if (!isRecord(response) || !Array.isArray(response.embeddings)) {
      throw new Error("AIStudio embedding response did not contain embeddings");
    }
    if (response.embeddings.length !== normalized.length) {
      throw new Error("AIStudio embedding response count did not match the request");
    }
    return response.embeddings.map((embedding, index) => {
      if (!isRecord(embedding) || !Array.isArray(embedding.values) || embedding.values.length === 0) {
        throw new Error(`AIStudio embedding ${index + 1} is invalid`);
      }
      const values = embedding.values.map((value) => Number(value));
      if (values.some((value) => !Number.isFinite(value))) throw new Error(`AIStudio embedding ${index + 1} contains non-finite values`);
      return values;
    });
  }

  async #nativeRequest(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await response.text();
    if (text.length > MAX_JSON_CHARS) throw new Error("AIStudio response exceeds the media response limit");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`AIStudio returned non-JSON data (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`AIStudio request failed (HTTP ${response.status}): ${errorText(payload)}`);
    }
    return payload;
  }
}

export interface AistudioMediaToolProviderOptions {
  client: AistudioClient;
  /** Optional independent Gemini -> local speech chain. */
  speechClient?: SpeechSynthesizer;
  assets: AssetStore;
  sendImage: boolean;
  sendVoice: boolean;
  imageModel?: string | readonly string[];
  ttsModel?: string;
  ttsVoice?: string;
  ttsStyle?: string;
  ttsDefaults?: (event: Parameters<AgentToolProvider>[0]["event"]) => { voice?: string; style?: string } | undefined;
  log?: (level: "debug" | "info" | "warn" | "error", event: string, message: string, details?: Readonly<Record<string, unknown>>) => void;
}

const GenerateImageParameters = Type.Object({
  prompt: Type.String({ minLength: 2, maxLength: 4_000, description: "要生成的图片内容和风格" }),
});

const SynthesizeSpeechParameters = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 8_000, description: "要朗读的中文或其他语言文本" }),
  voice: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 32,
    description: "可选音色；默认 Leda（年轻女声）。常用还有 Aoede（轻盈）、Zephyr（明亮）、Sulafat（温暖）、Kore（坚定）和 Puck（活泼）",
  })),
  style: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 200,
    description: "可选表达风格，例如温柔、活泼、兴奋、安慰、新闻播报；默认年轻愉悦且感情自然丰富",
  })),
});

/** Exposes native AIStudio image/TTS operations as explicit, model-selectable Pi tools. */
export function createAistudioMediaToolProvider(options: AistudioMediaToolProviderOptions): AgentToolProvider {
  return ({ event, stagePart }) => {
    const tools: AgentTool[] = [];
    if (options.sendImage) {
      const tool: AgentTool<typeof GenerateImageParameters, { assetId: string; model: string }> = {
        name: "generate_image",
        label: "生成图片",
        description:
          "根据用户明确要求生成一张图片并直接加入本轮回复。只有用户要画图、生成海报、图标、插画或视觉成品时调用；不要为了普通文字回答调用。生成后可以用一句很短的文字说明，不要输出提示词或内部过程。",
        parameters: GenerateImageParameters,
        executionMode: "sequential",
        async execute(_toolCallId, parameters): Promise<AgentToolResult<{ assetId: string; model: string }>> {
          const result = await options.client.generateImage(parameters.prompt, options.imageModel);
          const asset = await options.assets.put({
            data: result.data,
            mimeType: result.mimeType,
            name: "aistudio-generated-image.png",
            metadata: {
              generatedBy: "aistudio",
              model: result.model,
              generationPrompt: parameters.prompt.normalize("NFKC").trim(),
            },
          });
          stagePart({ type: "image", asset, alt: parameters.prompt });
          options.log?.("info", "aistudio.image_generated", "AIStudio 图片已生成并加入回复", {
            eventId: event.id,
            conversationId: event.conversation.id,
            model: result.model,
            assetId: asset.id,
            bytes: result.data.byteLength,
          });
          return {
            content: [{ type: "text", text: "图片已加入本轮回复。" }],
            details: { assetId: asset.id, model: result.model },
            terminate: true,
          };
        },
      };
      tools.push(tool);
    }
    if (options.sendVoice) {
      const tool: AgentTool<typeof SynthesizeSpeechParameters, { assetId: string; model: string }> = {
        name: "synthesize_speech",
        label: "合成语音",
        description:
          "把指定文字合成为语音并加入本轮回复。用户明确要求语音、朗读、播报、用声音回复，或本轮系统要求跟随对方语音形态回复时调用；普通文字对话不要主动发语音。生成后不要重复粘贴完整朗读文本。",
        parameters: SynthesizeSpeechParameters,
        executionMode: "sequential",
        async execute(_toolCallId, parameters): Promise<AgentToolResult<{ assetId: string; model: string }>> {
          const defaults = options.ttsDefaults?.(event);
          const voice = parameters.voice ?? defaults?.voice ?? options.ttsVoice;
          const style = parameters.style ?? defaults?.style ?? options.ttsStyle;
          const result = await (options.speechClient ?? options.client).synthesizeSpeech(parameters.text, {
            ...(options.ttsModel ? { model: options.ttsModel } : {}),
            ...(voice ? { voice } : {}),
            ...(style ? { style } : {}),
          });
          const asset = await options.assets.put({
            data: result.data,
            mimeType: result.mimeType,
            name: "aistudio-generated-voice.wav",
            metadata: { generatedBy: "speech-synthesis", model: result.model },
          });
          stagePart({ type: "voice", asset, durationMs: result.durationMs });
          options.log?.("info", "aistudio.tts_generated", "AIStudio 语音已生成并加入回复", {
            eventId: event.id,
            conversationId: event.conversation.id,
            model: result.model,
            assetId: asset.id,
            durationMs: result.durationMs,
            voice: voice ?? DEFAULT_TTS_VOICE,
            style: style ?? DEFAULT_TTS_STYLE,
          });
          return {
            content: [{ type: "text", text: "语音已加入本轮回复。" }],
            details: { assetId: asset.id, model: result.model },
            terminate: true,
          };
        },
      };
      tools.push(tool);
    }
    return tools;
  };
}

interface InlineData {
  mimeType: string;
  data: string;
}

function findInlineData(value: unknown): InlineData | undefined {
  const found: InlineData[] = [];
  walk(value, found);
  return found.find((item) => item.mimeType.toLocaleLowerCase().startsWith("image/")) ?? found[0];
}

function generatedText(value: unknown): string {
  if (!isRecord(value)) return "";
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
    }
  }
  return texts.join("\n").trim();
}

function walk(value: unknown, found: InlineData[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
    return;
  }
  if (!isRecord(value)) return;
  const inline = value.inlineData ?? value.inline_data;
  if (isRecord(inline) && typeof inline.data === "string" && typeof inline.mimeType === "string") {
    found.push({ mimeType: inline.mimeType, data: inline.data });
  }
  for (const child of Object.values(value)) walk(child, found);
}

function nativeBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/v1") ? `${path.slice(0, -3)}/v1beta` : path.endsWith("/v1beta") ? path : `${path}/v1beta`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function pcmToWav(data: Uint8Array, mimeType: string): Uint8Array {
  const rateMatch = /rate\s*=\s*(\d+)/iu.exec(mimeType);
  const sampleRate = Number(rateMatch?.[1] ?? 24_000);
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("AIStudio TTS returned an invalid sample rate");
  }
  const pcmLength = data.byteLength - (data.byteLength % 2);
  const output = new Uint8Array(44 + pcmLength);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmLength, true);
  output.set(data.subarray(0, pcmLength), 44);
  return output;
}

function speechDurationMs(data: Uint8Array, mimeType: string): number {
  if (mimeType.toLocaleLowerCase() === "audio/wav" && data.byteLength >= 44) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rate = view.getUint32(24, true);
    const bytesPerSecond = view.getUint32(28, true);
    const dataSize = view.getUint32(40, true);
    if (rate > 0 && bytesPerSecond > 0 && dataSize > 0) return Math.max(1, Math.round(dataSize / bytesPerSecond * 1000));
  }
  return Math.max(1, Math.round(data.byteLength / (24_000 * 2) * 1000));
}

function decodeBase64(value: string, label: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, "");
  if (!normalized || !/^[a-z\d+/]+={0,2}$/iu.test(normalized)) throw new Error(`AIStudio ${label} is not valid Base64`);
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength === 0) throw new Error(`AIStudio ${label} is empty`);
  return new Uint8Array(data);
}

function normalizeMime(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").trim();
  return normalized || fallback;
}

function requiredText(value: string, label: string, maxChars: number): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(`AIStudio ${label} cannot be empty`);
  if ([...normalized].length > maxChars) throw new Error(`AIStudio ${label} exceeds ${maxChars} characters`);
  return normalized;
}

function errorText(value: unknown): string {
  if (isRecord(value) && typeof value.error === "string") return value.error.slice(0, 2_000);
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") return value.error.message.slice(0, 2_000);
  return JSON.stringify(value).slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
