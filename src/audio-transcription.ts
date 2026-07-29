import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaResolver } from "./asset-store.js";
import type { InboundMessageEvent, MessagePart } from "./types.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 8_000;

export interface AudioTranscriptionRequest {
  data: Uint8Array;
  mimeType: string;
  conversationId: string;
  senderId: string;
  messageId: string;
  durationMs?: number;
}

export interface AudioTranscriptionResult {
  text: string;
  model?: string;
}

export interface AudioTranscriptionProvider {
  transcribe(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
}

export interface VoiceTranscriptCache {
  get(key: string): string | undefined;
  set(key: string, transcript: string): void;
}

export class MemoryVoiceTranscriptCache implements VoiceTranscriptCache {
  readonly #entries = new Map<string, string>();
  readonly #maxEntries: number;

  constructor(maxEntries = 1_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new Error("Voice transcript cache size is invalid");
    }
    this.#maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, transcript: string): void {
    this.#entries.delete(key);
    this.#entries.set(key, transcript);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }
}

export interface EnrichedVoiceEvent {
  event: InboundMessageEvent;
  transcribed: number;
  cacheHits: number;
}

/** Downloads and transcribes only voice parts that do not already contain a transcript. */
export async function enrichInboundVoiceTranscripts(options: {
  event: InboundMessageEvent;
  mediaResolver: MediaResolver;
  provider: AudioTranscriptionProvider;
  cache?: VoiceTranscriptCache;
}): Promise<EnrichedVoiceEvent> {
  const voiceParts = (options.event.parts ?? []).filter(
    (part): part is Extract<MessagePart, { type: "voice" }> => part.type === "voice" && !part.transcript?.trim(),
  );
  if (voiceParts.length === 0) return { event: options.event, transcribed: 0, cacheHits: 0 };

  let transcribed = 0;
  let cacheHits = 0;
  const replacements = new Map<Extract<MessagePart, { type: "voice" }>, Extract<MessagePart, { type: "voice" }>>();
  for (const part of voiceParts.slice(0, 2)) {
    const assetKey = `asset:${part.asset.id}`;
    let transcript = options.cache?.get(assetKey);
    if (transcript) {
      cacheHits += 1;
    } else {
      const resolved = await options.mediaResolver.resolve(part.asset);
      if (resolved.asset.id !== part.asset.id) throw new Error("Voice media resolver returned a different asset id");
      const collected = await collectAudio(resolved.content, MAX_AUDIO_BYTES);
      const sha256 = createHash("sha256").update(collected).digest("hex");
      const contentKey = `sha256:${sha256}`;
      transcript = options.cache?.get(contentKey);
      if (transcript) {
        cacheHits += 1;
      } else {
        const normalized = await normalizeAudioForGemini(
          collected,
          resolved.asset.mimeType ?? part.asset.mimeType ?? "application/octet-stream",
        );
        const result = await options.provider.transcribe({
          data: normalized.data,
          mimeType: normalized.mimeType,
          conversationId: options.event.conversation.id,
          senderId: options.event.sender.id,
          messageId: options.event.id,
          ...(part.durationMs ? { durationMs: part.durationMs } : {}),
        });
        transcript = boundedTranscript(result.text);
        options.cache?.set(contentKey, transcript);
        transcribed += 1;
      }
      options.cache?.set(assetKey, transcript);
    }
    replacements.set(part, { ...part, transcript });
  }
  const parts = (options.event.parts ?? []).map((part) =>
    part.type === "voice" ? replacements.get(part) ?? part : part);
  return { event: { ...options.event, parts }, transcribed, cacheHits };
}

async function collectAudio(content: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Resolved voice chunks must be Uint8Array values");
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`Voice exceeds the configured ${maxBytes} byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new Error("Resolved voice is empty");
  return Buffer.concat(chunks);
}

async function normalizeAudioForGemini(
  data: Uint8Array,
  mimeType: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  const normalizedMime = mimeType.split(";", 1)[0]!.normalize("NFKC").trim().toLocaleLowerCase();
  if ((normalizedMime === "audio/wav" || normalizedMime === "audio/wave") && isWave(data)) {
    return { data, mimeType: "audio/wav" };
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-bot-stt-"));
  const inputPath = join(directory, isSilk(data) || normalizedMime.includes("silk") ? "voice.silk" : "voice.input");
  const pcmPath = join(directory, "voice.pcm");
  const wavPath = join(directory, "voice.wav");
  try {
    await writeFile(inputPath, data, { mode: 0o600 });
    if (isSilk(data) || normalizedMime.includes("silk")) {
      await runCommand(process.env.PI_SILK_DECODER_PATH?.trim() || "/usr/local/bin/silk/decoder", [
        inputPath,
        pcmPath,
        "-Fs_API", "24000",
        "-quiet",
      ], "Tencent SILK decoding");
      await runCommand(process.env.PI_FFMPEG_PATH?.trim() || "ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmPath,
        "-t", "300", "-acodec", "pcm_s16le", wavPath, "-y",
      ], "decoded PCM conversion");
    } else {
      await runCommand(process.env.PI_FFMPEG_PATH?.trim() || "ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-i", inputPath,
        "-t", "300", "-vn", "-ac", "1", "-ar", "24000", "-acodec", "pcm_s16le", wavPath, "-y",
      ], "audio conversion");
    }
    const wav = new Uint8Array(await readFile(wavPath));
    if (!isWave(wav)) throw new Error("Audio converter returned an invalid WAV file");
    return { data: wav, mimeType: "audio/wav" };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runCommand(executable: string, args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${label} timed out`));
    }, 60_000);
    timer.unref();
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 8_000) return;
      const captured = Buffer.from(chunk).subarray(0, 8_000 - stderrBytes);
      stderr.push(captured);
      stderrBytes += captured.byteLength;
    });
    child.once("error", (error) => finish(new Error(`${label} failed to start: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`${label} failed with exit code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      finish();
    });
  });
}

function boundedTranscript(value: string): string {
  const normalized = value.normalize("NFKC").replace(/^[\s“”"']+|[\s“”"']+$/gu, "").trim();
  if (!normalized) throw new Error("Audio transcription returned empty text");
  return [...normalized].slice(0, MAX_TRANSCRIPT_CHARS).join("");
}

function isWave(data: Uint8Array): boolean {
  return data.byteLength >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WAVE";
}

function isSilk(data: Uint8Array): boolean {
  const header = Buffer.from(data.subarray(0, 16)).toString("ascii");
  return header.startsWith("#!SILK_V3") || header.startsWith("\u0002#!SILK_V3");
}
