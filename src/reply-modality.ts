import type { InboundMessageEvent } from "./types.js";

export type ConversationVoiceMode = "text" | "voice" | "whisper";
export type VoiceReplyMode = "user-requested" | "match-inbound-voice" | "conversation-voice" | "whisper";

export const WHISPER_TTS_STYLE =
  "年轻、温柔、贴近麦克风的女性耳语，音量轻柔、气声自然、速度稍慢，像在安静地说悄悄话，感情细腻但吐字清楚";

export interface ConversationVoiceModeCommand {
  mode: ConversationVoiceMode;
  label: string;
}

export function hasInboundVoice(event: InboundMessageEvent): boolean {
  return event.parts?.some((part) => part.type === "voice") ?? false;
}

/** Conservative command detection: capability questions may demonstrate voice, diagnostics must stay text. */
export function isExplicitVoiceReplyRequest(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, "").trim();
  if (!text) return false;
  if (/(?:不要|别|不用|无需|禁止).{0,8}(?:语音|声音)/u.test(text)) return false;
  const diagnostic = /(?:为什么|为何|怎么|不能|无法|没法|杂音|噪音|听不到|没声音|故障|问题)/u.test(text);
  const explicitCommand = /(?:请|麻烦|给我|帮我|这次|现在|接下来|以后|改用|换成)/u.test(text);
  if (diagnostic && !explicitCommand) return false;
  return /(?:用|改用|换成)(?:一段|一条)?(?:语音|声音)(?:来)?(?:回复|回答|说|讲|读|念)?/u.test(text) ||
    /(?:发|回)(?:一段|一条|一个|一|个|条)?语音/u.test(text) ||
    /(?:语音|声音)(?:回复|回答|发|回)/u.test(text) ||
    /(?:朗读|播报|说给我听|读(?:一下|一遍|出来|给我听)|念(?:一下|一遍|出来|给我听))/u.test(text);
}

export function isExplicitWhisperReplyRequest(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, "").trim();
  if (!text || /(?:不要|别|不用|停止|取消).{0,6}(?:耳语|小声|悄悄)/u.test(text)) return false;
  return /(?:用|改用|换成)?(?:耳语|悄悄话)(?:模式|语气|声音)?(?:来)?(?:回复|回答|说|讲)?/u.test(text) ||
    /(?:小声|轻声|悄悄地?)(?:回复|回答|说|讲|告诉我|念|读)/u.test(text);
}

export function isExplicitTextReplyRequest(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, "").trim();
  return /(?:这次|本次|现在)?(?:用|改用|换成)(?:文字|打字)(?:来)?(?:回复|回答)?/u.test(text) ||
    /(?:不要|别|不用)(?:再)?发语音(?:了)?[，,。.!！]?(?:用)?(?:文字|打字)?/u.test(text);
}

/** Strict persistent-mode commands, used by the management plugin before the model runs. */
export function parseConversationVoiceModeCommand(value: string): ConversationVoiceModeCommand | undefined {
  const text = value
    .normalize("NFKC")
    .replace(/[\u2005\u2009\u200a\u200b\u200e\u200f\u2060\ufeff]/gu, " ")
    .replace(/^(?:@[^\s@]{1,100}\s+)+/u, "")
    .replace(/\s+/gu, "")
    .replace(/[！!。]+$/gu, "")
    .trim();
  if (!text) return undefined;
  if (/^(?:退出|关闭|结束|取消)(?:语音|语音对话|语音回复)(?:模式)?$/u.test(text) ||
      /^(?:恢复|切回|改回)(?:文字|打字)(?:回复|模式)?$/u.test(text)) {
    return { mode: "text", label: "文字模式" };
  }
  if (/^(?:退出|关闭|结束|取消)(?:耳语|悄悄话)(?:模式)?$/u.test(text) ||
      /^(?:恢复|切回)(?:正常声音|正常语音|正常说话)$/u.test(text)) {
    return { mode: "voice", label: "正常语音模式" };
  }
  if (/^(?:进入|开启|打开|切换到|改成)(?:耳语|悄悄话|小声说话)(?:模式)?$/u.test(text) ||
      /^(?:以后|接下来)(?:都)?(?:用)?(?:耳语|悄悄话|小声)(?:和我)?(?:对话|回复|说话)$/u.test(text)) {
    return { mode: "whisper", label: "耳语模式" };
  }
  if (/^(?:进入|开启|打开|切换到|改成)(?:持续)?(?:语音|语音对话|语音回复)(?:模式)?$/u.test(text) ||
      /^(?:以后|接下来)(?:都)?用语音(?:和我)?(?:对话|回复|回答|说话)$/u.test(text)) {
    return { mode: "voice", label: "语音模式" };
  }
  return undefined;
}

export function preferredVoiceReplyMode(
  event: InboundMessageEvent,
  triggerReason: string,
  voiceToolAvailable: boolean,
  conversationMode: ConversationVoiceMode = "text",
): VoiceReplyMode | undefined {
  if (!voiceToolAvailable) return undefined;
  if (isExplicitTextReplyRequest(event.text) && !parseConversationVoiceModeCommand(event.text)) return undefined;
  if (conversationMode === "whisper" || isExplicitWhisperReplyRequest(event.text)) return "whisper";
  if (isExplicitVoiceReplyRequest(event.text)) return "user-requested";
  if (conversationMode === "voice") return "conversation-voice";
  if (event.conversation.kind === "group" && triggerReason === "ambient-voice" && hasInboundVoice(event)) {
    return "match-inbound-voice";
  }
  return undefined;
}
