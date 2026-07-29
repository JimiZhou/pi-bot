import type { GeneratedSpeech } from "./aistudio.js";

export interface SpeechSynthesisOptions {
  model?: string;
  voice?: string;
  style?: string;
}

export interface SpeechSynthesizer {
  synthesizeSpeech(text: string, options?: SpeechSynthesisOptions): Promise<GeneratedSpeech>;
}

export interface SpeechFallbackEntry {
  label: string;
  synthesizer: SpeechSynthesizer;
  /** Binds this entry to one provider model while preserving voice/style. */
  model?: string;
}

export interface ResilientSpeechSynthesizerOptions {
  entries: readonly SpeechFallbackEntry[];
  retryDelaysMs?: readonly number[];
  circuitBreakerCooldownMs?: number;
  onFallback?: (details: { error: string; from: string; to: string }) => void;
}

/** TTS health is independent from the text/vision model circuit. */
export class ResilientSpeechSynthesizer implements SpeechSynthesizer {
  readonly #options: ResilientSpeechSynthesizerOptions;
  readonly #unavailableUntil = new Map<number, number>();
  readonly #lastErrors = new Map<number, string>();

  constructor(options: ResilientSpeechSynthesizerOptions) {
    if (options.entries.length === 0) throw new Error("Speech fallback chain cannot be empty");
    const cooldown = options.circuitBreakerCooldownMs ?? 60_000;
    boundedInteger(cooldown, 1_000, 10 * 60_000, "speech circuit breaker cooldown");
    for (const delay of options.retryDelaysMs ?? [500, 1_500]) {
      boundedInteger(delay, 0, 60_000, "speech retry delay");
    }
    this.#options = { ...options, entries: [...options.entries] };
  }

  async synthesizeSpeech(text: string, options: SpeechSynthesisOptions = {}): Promise<GeneratedSpeech> {
    let latestError = "Speech provider is unavailable";
    for (let index = 0; index < this.#options.entries.length; index += 1) {
      const entry = this.#options.entries[index]!;
      const next = this.#options.entries[index + 1];
      if (next && Date.now() < (this.#unavailableUntil.get(index) ?? 0)) {
        latestError = this.#lastErrors.get(index) ?? latestError;
        this.#options.onFallback?.({ error: latestError, from: entry.label, to: next.label });
        continue;
      }
      const delays = index === 0 ? (this.#options.retryDelaysMs ?? [500, 1_500]) : [];
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await entry.synthesizer.synthesizeSpeech(text, {
            ...options,
            ...(entry.model ? { model: entry.model } : {}),
          });
          this.#unavailableUntil.delete(index);
          this.#lastErrors.delete(index);
          return result;
        } catch (error) {
          latestError = error instanceof Error ? error.message : String(error);
          if (!isTransientSpeechError(latestError)) throw error;
          const retryDelay = delays[attempt];
          if (retryDelay !== undefined && !isModelPermissionUnavailable(latestError)) {
            if (retryDelay > 0) await delay(retryDelay);
            continue;
          }
          if (!next) throw error;
          this.#lastErrors.set(index, latestError);
          this.#unavailableUntil.set(index, Date.now() + (this.#options.circuitBreakerCooldownMs ?? 60_000));
          this.#options.onFallback?.({ error: latestError, from: entry.label, to: next.label });
          break;
        }
      }
    }
    throw new Error(latestError);
  }
}

export type TtsApiEngine = "edge" | "kokoro";

export interface TtsApiClientOptions {
  baseUrl: string;
  engine: TtsApiEngine;
  voice: string;
  timeoutMs?: number;
  speed?: number;
  apiKey?: string;
}

/** Client for babutree/TTS-API's streaming MP3 REST endpoint. */
export class TtsApiClient implements SpeechSynthesizer {
  readonly #baseUrl: string;
  readonly #engine: TtsApiEngine;
  readonly #voice: string;
  readonly #timeoutMs: number;
  readonly #speed: number;
  readonly #apiKey?: string;

  constructor(options: TtsApiClientOptions) {
    const url = new URL(options.baseUrl);
    url.search = "";
    url.hash = "";
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#engine = options.engine;
    this.#voice = requiredText(options.voice, `${options.engine} TTS voice`, 200);
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 180_000, 1_000, 10 * 60_000, "TTS-API timeout");
    this.#speed = boundedNumber(options.speed ?? 1, 0.5, 3, "TTS-API speed");
    const apiKey = options.apiKey?.trim();
    if (apiKey) this.#apiKey = apiKey;
  }

  async synthesizeSpeech(text: string): Promise<GeneratedSpeech> {
    const speechText = requiredText(text, "TTS-API speech text", 8_000);
    const headers: Record<string, string> = {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
    };
    if (this.#apiKey) headers["X-API-Key"] = this.#apiKey;
    const response = await fetch(`${this.#baseUrl}/api/tts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: speechText,
        engine: this.#engine,
        voice: this.#voice,
        speed: this.#speed,
        ssml: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const error = (await response.text()).slice(0, 2_000);
      throw new Error(`TTS-API ${this.#engine} request failed (HTTP ${response.status}): ${error}`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength === 0) throw new Error(`TTS-API ${this.#engine} returned no audio data`);
    if (raw.byteLength > 40 * 1024 * 1024) throw new Error("TTS-API audio response is too large");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase();
    if (mimeType !== "audio/mpeg" && mimeType !== "audio/mp3") {
      throw new Error(`TTS-API ${this.#engine} returned unsupported content type: ${mimeType || "missing"}`);
    }
    return {
      data: raw,
      mimeType: "audio/mpeg",
      durationMs: mp3DurationMs(raw) ?? estimatedSpeechDurationMs(speechText, this.#speed),
      model: `tts-api/${this.#engine}/${this.#voice}`,
    };
  }
}

export function isTransientSpeechError(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  if (/(?:safety|content.?filter|policy.?violation|prohibited|安全策略|内容政策|违规内容)/u.test(normalized)) {
    return false;
  }
  if (isModelPermissionUnavailable(normalized)) return true;
  if (/\b(?:400|401|403|404|422)\b/u.test(normalized)) return false;
  return /(?:\b(?:408|409|425|429|500|502|503|504)\b|no audio data|unsupported content type|fetch failed|network|econnreset|econnrefused|etimedout|socket hang up|connection reset|timed?\s*out|temporar(?:y|ily) unavailable|service unavailable|rate limit|too many requests)/u.test(normalized);
}

function isModelPermissionUnavailable(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  return /\b403\b.{0,240}(?:permission_denied|caller does not have permission)/u.test(normalized);
}

function requiredText(value: string, label: string, maxChars: number): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  if ([...normalized].length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return normalized;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boundedNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return value;
}

function estimatedSpeechDurationMs(text: string, speed: number): number {
  const cjkCharacters = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const latinWords = (text.match(/[a-z\d]+(?:['’-][a-z\d]+)*/giu) ?? []).length;
  const seconds = (cjkCharacters / 4.2 + latinWords / 2.7 + 0.35) / speed;
  return Math.max(1_000, Math.round(seconds * 1_000));
}

/** Reads MPEG audio frames so IM receives a useful voice duration for VBR MP3 output. */
function mp3DurationMs(data: Uint8Array): number | undefined {
  let offset = id3v2End(data);
  let totalSeconds = 0;
  let frames = 0;
  while (offset + 4 <= data.byteLength) {
    const frame = mp3Frame(data, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    totalSeconds += frame.samples / frame.sampleRate;
    frames += 1;
    offset += frame.length;
  }
  return frames > 0 && totalSeconds > 0 ? Math.max(1, Math.round(totalSeconds * 1_000)) : undefined;
}

function id3v2End(data: Uint8Array): number {
  if (data.byteLength < 10 || data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
  const size = ((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) |
    ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f);
  return Math.min(data.byteLength, 10 + size);
}

function mp3Frame(data: Uint8Array, offset: number): { length: number; sampleRate: number; samples: number } | undefined {
  const header = ((data[offset]! << 24) | (data[offset + 1]! << 16) |
    (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
  if ((header & 0xffe0_0000) !== 0xffe0_0000) return undefined;
  const versionBits = (header >>> 19) & 0x3;
  const layerBits = (header >>> 17) & 0x3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const sampleRateIndex = (header >>> 10) & 0x3;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return undefined;
  }
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const version1Bitrates = layer === 1
    ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
    : layer === 2
      ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
      : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const version2Bitrates = layer === 1
    ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = (version === 1 ? version1Bitrates : version2Bitrates)[bitrateIndex - 1]! * 1_000;
  const baseSampleRates = [44_100, 48_000, 32_000];
  const sampleRate = baseSampleRates[sampleRateIndex]! / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const padding = (header >>> 9) & 0x1;
  const length = layer === 1
    ? Math.floor((12 * bitrate / sampleRate + padding) * 4)
    : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate / sampleRate) + padding);
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1_152 : 576;
  if (length < 4 || offset + length > data.byteLength) return undefined;
  return { length, sampleRate, samples };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
