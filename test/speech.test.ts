import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  ResilientSpeechSynthesizer,
  TtsApiClient,
  type SpeechSynthesisOptions,
  type SpeechSynthesizer,
} from "../src/speech.js";

test("TTS-API client selects the configured engine and returns streaming MP3", async (context) => {
  let received: {
    body: Record<string, unknown> | undefined;
    apiKey: string | undefined;
    path: string | undefined;
  } = { body: undefined, apiKey: undefined, path: undefined };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        path: request.url,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.end(Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");

  const client = new TtsApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    engine: "edge",
    voice: "zh-CN-XiaoxiaoNeural",
    speed: 1.2,
    apiKey: "secret",
  });
  const result = await client.synthesizeSpeech("你好，世界");

  assert.deepEqual(received, {
    path: "/api/tts",
    apiKey: "secret",
    body: {
      text: "你好,世界",
      engine: "edge",
      voice: "zh-CN-XiaoxiaoNeural",
      speed: 1.2,
      ssml: false,
    },
  });
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.model, "tts-api/edge/zh-CN-XiaoxiaoNeural");
  assert.ok(result.durationMs >= 1_000);
  assert.equal(result.data.byteLength, 13);
});

test("speech fallback consumes Gemini, Edge and then local Kokoro", async () => {
  const calls: Array<{ provider: string; model?: string }> = [];
  const gemini: SpeechSynthesizer = {
    async synthesizeSpeech(_text: string, options: SpeechSynthesisOptions = {}) {
      calls.push({ provider: "gemini", ...(options.model ? { model: options.model } : {}) });
      throw new Error("Gemini TTS request failed (HTTP 429): RESOURCE_EXHAUSTED");
    },
  };
  const edge: SpeechSynthesizer = {
    async synthesizeSpeech() {
      calls.push({ provider: "edge" });
      throw new Error("TTS-API edge request failed (HTTP 502): upstream unavailable");
    },
  };
  const local: SpeechSynthesizer = {
    async synthesizeSpeech() {
      calls.push({ provider: "kokoro" });
      return {
        data: new Uint8Array([1, 2]),
        mimeType: "audio/mpeg",
        durationMs: 1,
        model: "tts-api/kokoro/test",
      };
    },
  };
  const fallbacks: string[] = [];
  const synthesizer = new ResilientSpeechSynthesizer({
    entries: [
      { label: "gemini/3.1", model: "gemini-3.1-flash-tts-preview", synthesizer: gemini },
      { label: "gemini/2.5-flash", model: "gemini-2.5-flash-preview-tts", synthesizer: gemini },
      { label: "gemini/2.5-pro", model: "gemini-2.5-pro-preview-tts", synthesizer: gemini },
      { label: "tts-api/edge", synthesizer: edge },
      { label: "tts-api/kokoro", synthesizer: local },
    ],
    retryDelaysMs: [],
    onFallback: ({ from, to }) => fallbacks.push(`${from}->${to}`),
  });

  const result = await synthesizer.synthesizeSpeech("你好", { voice: "Leda", style: "温柔" });

  assert.equal(result.model, "tts-api/kokoro/test");
  assert.deepEqual(calls, [
    { provider: "gemini", model: "gemini-3.1-flash-tts-preview" },
    { provider: "gemini", model: "gemini-2.5-flash-preview-tts" },
    { provider: "gemini", model: "gemini-2.5-pro-preview-tts" },
    { provider: "edge" },
    { provider: "kokoro" },
  ]);
  assert.deepEqual(fallbacks, [
    "gemini/3.1->gemini/2.5-flash",
    "gemini/2.5-flash->gemini/2.5-pro",
    "gemini/2.5-pro->tts-api/edge",
    "tts-api/edge->tts-api/kokoro",
  ]);
});
