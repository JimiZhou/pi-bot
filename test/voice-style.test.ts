import assert from "node:assert/strict";
import test from "node:test";
import { shouldReplaceShortReactionWithEmoji } from "../src/core.js";
import {
  DEFAULT_TTS_STYLE,
  matchingTtsVoicePreset,
  resolveTtsVoiceStyleQuery,
} from "../src/voice-style.js";

test("voice style presets and natural descriptions resolve without a model call", () => {
  assert.deepEqual(resolveTtsVoiceStyleQuery("温暖温柔女声"), {
    voice: "Sulafat",
    style: "温暖、温柔、细腻、富有同理心的女性语气，语速舒缓，感情真诚自然",
    presetId: "warm-gentle",
    presetLabel: "温暖温柔女声",
  });
  assert.deepEqual(resolveTtsVoiceStyleQuery("Aoede，温柔活泼一点", {
    voice: "Leda",
    style: DEFAULT_TTS_STYLE,
  }), {
    voice: "Aoede",
    style: "温柔活泼一点",
    presetId: null,
    presetLabel: null,
  });
  const custom = resolveTtsVoiceStyleQuery("年轻、温柔、有笑意且感情丰富", { voice: "Leda" });
  assert.equal(custom.voice, "Leda");
  assert.equal(custom.style, "年轻、温柔、有笑意且感情丰富");
  assert.equal(matchingTtsVoicePreset("Leda", DEFAULT_TTS_STYLE)?.id, "young-pleasant");
});

test("only short attitude replies are eligible for automatic emoji replacement", () => {
  assert.equal(shouldReplaceShortReactionWithEmoji("哈哈哈，确实离谱"), true);
  assert.equal(shouldReplaceShortReactionWithEmoji("收到，好嘞～"), true);
  assert.equal(shouldReplaceShortReactionWithEmoji("这个问题需要先核对接口文档再回答。"), false);
  assert.equal(shouldReplaceShortReactionWithEmoji("为什么会这样？"), false);
});
