import assert from "node:assert/strict";
import test from "node:test";
import {
  hasInboundVoice,
  isExplicitVoiceReplyRequest,
  parseConversationVoiceModeCommand,
  preferredVoiceReplyMode,
} from "../src/reply-modality.js";
import type { InboundMessageEvent } from "../src/types.js";

test("voice reply commands are distinguished from diagnostics and opt-outs", () => {
  assert.equal(isExplicitVoiceReplyRequest("请用语音回复我"), true);
  assert.equal(isExplicitVoiceReplyRequest("给我发一条语音"), true);
  assert.equal(isExplicitVoiceReplyRequest("把这段话朗读出来"), true);
  assert.equal(isExplicitVoiceReplyRequest("为什么发语音会有杂音？"), false);
  assert.equal(isExplicitVoiceReplyRequest("不要发语音，用文字就行"), false);
});

test("persistent voice and whisper commands are strict and unambiguous", () => {
  assert.deepEqual(parseConversationVoiceModeCommand("进入语音模式"), { mode: "voice", label: "语音模式" });
  assert.deepEqual(parseConversationVoiceModeCommand("以后都用语音回复"), { mode: "voice", label: "语音模式" });
  assert.deepEqual(parseConversationVoiceModeCommand("进入耳语模式"), { mode: "whisper", label: "耳语模式" });
  assert.deepEqual(parseConversationVoiceModeCommand("恢复正常声音"), { mode: "voice", label: "正常语音模式" });
  assert.deepEqual(parseConversationVoiceModeCommand("退出语音模式"), { mode: "text", label: "文字模式" });
  assert.equal(parseConversationVoiceModeCommand("语音怎么有杂音"), undefined);
});

test("an ambient group voice prefers a voice reply only when the TTS tool is available", () => {
  const event: InboundMessageEvent = {
    type: "message",
    id: "voice-1",
    conversation: { id: "g1", kind: "group" },
    sender: { id: "u1", displayName: "阿青" },
    text: "",
    parts: [{
      type: "voice",
      asset: { id: "voice-in", source: "platform", locator: "message:voice-1", ownerPluginId: "test" },
      durationMs: 2_000,
    }],
  };
  assert.equal(hasInboundVoice(event), true);
  assert.equal(preferredVoiceReplyMode(event, "ambient-voice", true), "match-inbound-voice");
  assert.equal(preferredVoiceReplyMode(event, "ambient-voice", false), undefined);
  assert.equal(preferredVoiceReplyMode({ ...event, text: "普通问题" }, "direct", true, "voice"), "conversation-voice");
  assert.equal(preferredVoiceReplyMode({ ...event, text: "悄悄告诉我" }, "direct", true), "whisper");
});
