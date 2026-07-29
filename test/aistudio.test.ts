import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AistudioClient } from "../src/aistudio.js";

test("AIStudio native client decodes Gemini image and converts L16 TTS to WAV", async () => {
  let speechRequest: Record<string, any> | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("flash-image")) {
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("png").toString("base64") } }] } }] }));
      return;
    }
    assert.match(body, /AUDIO/u);
    speechRequest = JSON.parse(body) as Record<string, any>;
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new AistudioClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const image = await client.generateImage("一只猫", "flash-image");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual([...image.data], [...Buffer.from("png")]);
    const speech = await client.synthesizeSpeech("你好");
    assert.equal(speech.mimeType, "audio/wav");
    assert.equal(speech.durationMs, 1);
    assert.equal(String.fromCharCode(...speech.data.slice(0, 4)), "RIFF");
    assert.equal(speech.data.byteLength, 52);
    assert.equal(speechRequest?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, "Leda");
    assert.match(speechRequest?.contents?.[0]?.parts?.[0]?.text ?? "", /年轻、愉悦/);
    assert.match(speechRequest?.contents?.[0]?.parts?.[0]?.text ?? "", /你好/);
    await assert.rejects(client.synthesizeSpeech("你好", { voice: "not-a-real-voice" }), /unsupported/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AIStudio native client batches Gemini embeddings with retrieval task types", async () => {
  let requestBody: unknown;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requestBody = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ embeddings: [{ values: [1, 0.5] }, { values: [0.25, 1] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new AistudioClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    assert.deepEqual(
      await client.embedContents(["第一条记忆", "第二条记忆"], {
        model: "gemini-embedding-2",
        taskType: "RETRIEVAL_DOCUMENT",
      }),
      [[1, 0.5], [0.25, 1]],
    );
    assert.deepEqual(requestBody, {
      requests: [
        {
          model: "models/gemini-embedding-2",
          content: { parts: [{ text: "第一条记忆" }] },
          taskType: "RETRIEVAL_DOCUMENT",
        },
        {
          model: "models/gemini-embedding-2",
          content: { parts: [{ text: "第二条记忆" }] },
          taskType: "RETRIEVAL_DOCUMENT",
        },
      ],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AIStudio native client sends inline audio and returns a strict transcript", async () => {
  let requestBody: Record<string, any> | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requestBody = JSON.parse(body) as Record<string, any>;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "今天晚上吃火锅。" }] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new AistudioClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const result = await client.transcribeAudio(Buffer.from("RIFF....WAVE"), "audio/wav", "gemini-audio");
    assert.deepEqual(result, { text: "今天晚上吃火锅。", model: "gemini-audio" });
    assert.equal(requestBody?.contents?.[0]?.parts?.[1]?.inlineData?.mimeType, "audio/wav");
    assert.match(requestBody?.contents?.[0]?.parts?.[0]?.text ?? "", /只输出转写正文/u);
    assert.equal(requestBody?.generationConfig?.temperature, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
