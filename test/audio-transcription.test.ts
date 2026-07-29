import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryVoiceTranscriptCache,
  enrichInboundVoiceTranscripts,
  type AudioTranscriptionProvider,
  type InboundMessageEvent,
} from "../src/index.js";

const WAV_BYTES = (() => {
  const value = Buffer.alloc(48);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(40, 4);
  value.write("WAVE", 8, "ascii");
  value.write("fmt ", 12, "ascii");
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(24_000, 24);
  value.writeUInt32LE(48_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36, "ascii");
  value.writeUInt32LE(4, 40);
  return value;
})();

test("inbound voice transcription enriches the event and reuses the bounded cache", async () => {
  const requests: Parameters<AudioTranscriptionProvider["transcribe"]>[0][] = [];
  const provider: AudioTranscriptionProvider = {
    async transcribe(request) {
      requests.push(request);
      return { text: "今天晚上吃火锅。", model: "test/audio" };
    },
  };
  let resolves = 0;
  const event: InboundMessageEvent = {
    type: "message",
    id: "voice-1",
    conversation: { id: "direct-1", kind: "direct" },
    sender: { id: "user-1", displayName: "阿青" },
    text: "",
    timestamp: Date.now(),
    parts: [{
      type: "voice",
      asset: { id: "voice-asset-1", source: "platform", locator: "message:voice-1", ownerPluginId: "test" },
      durationMs: 2_000,
    }],
  };
  const cache = new MemoryVoiceTranscriptCache(10);
  const mediaResolver = {
    async resolve(asset: Extract<NonNullable<InboundMessageEvent["parts"]>[number], { type: "voice" }>["asset"]) {
      resolves += 1;
      return {
        asset: { ...asset, mimeType: "audio/wav", size: WAV_BYTES.byteLength },
        content: oneChunk(WAV_BYTES),
      };
    },
  };

  const first = await enrichInboundVoiceTranscripts({ event, mediaResolver, provider, cache });
  const second = await enrichInboundVoiceTranscripts({ event, mediaResolver, provider, cache });
  const firstVoice = first.event.parts?.[0];
  const secondVoice = second.event.parts?.[0];
  assert.equal(firstVoice?.type === "voice" ? firstVoice.transcript : undefined, "今天晚上吃火锅。");
  assert.equal(secondVoice?.type === "voice" ? secondVoice.transcript : undefined, "今天晚上吃火锅。");
  assert.equal(first.transcribed, 1);
  assert.equal(second.cacheHits, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.mimeType, "audio/wav");
  assert.equal(resolves, 1);
});

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
