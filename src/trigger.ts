import type { StoredMessage, TriggerContext, TriggerDecision, TriggerPolicy } from "./types.js";
import { hasInboundVoice, isExplicitVoiceReplyRequest } from "./reply-modality.js";

export class SocialTriggerPolicy implements TriggerPolicy {
  decide(context: TriggerContext): TriggerDecision {
    const { event, bot, activation, recentMessages } = context;

    if (event.sender.isBot || event.sender.id === bot.id) return ignore("bot-message");
    if (event.conversation.kind === "direct") return respond("direct-message");
    if (activation === "off") return ignore("activation-off");

    const botIds = new Set([bot.id, ...(bot.aliasIds ?? [])].map(canonicalIdentityId));
    const mentioned = event.mentions?.some((mention) => botIds.has(canonicalIdentityId(mention.id))) ?? false;
    if (mentioned) return respond("mention");
    if (event.replyTo?.senderId && botIds.has(canonicalIdentityId(event.replyTo.senderId))) return respond("reply-to-bot");

    const burstPreviousTexts = Array.isArray(event.metadata?.burstPreviousTexts)
      ? event.metadata.burstPreviousTexts.filter((value): value is string => typeof value === "string").slice(-5)
      : [];
    const combinedText = [...burstPreviousTexts, event.text].join("\n");
    const text = combinedText.normalize("NFKC").toLocaleLowerCase();
    const wakeWords = new Set([bot.displayName, ...(bot.wakeWords ?? [])]);
    let wakeWordMentionedMidSentence = false;
    for (const word of wakeWords) {
      const normalizedWord = word.normalize("NFKC").toLocaleLowerCase().trim();
      if (!normalizedWord || !text.includes(normalizedWord)) continue;
      if (isAddressedWakeWord(text, normalizedWord)) return respond("wake-word");
      wakeWordMentionedMidSentence = true;
    }

    // The bot keeps human hours for unsolicited participation. Explicit calls
    // still work at night, but ambient questions, continuations and hot-chat
    // heuristics do not wake it.
    if (context.quietHours) return ignore("quiet-hours");

    if (isNaturalContinuation(recentMessages, event.sender.id, bot.id, event.timestamp ?? Date.now(), context.continuationWindowMs)) {
      return respond("continuation");
    }

    if (activation === "always") {
      if (event.mentions?.length) return ignore("addressed-to-other");
      if (event.replyTo?.senderId && event.replyTo.senderId !== bot.id) return ignore("reply-to-other");
      if (isInboundEmoji(event)) return respond("ambient-emoji-battle");
      if (isExplicitVoiceReplyRequest(combinedText)) return respond("ambient-voice-request");
      if (hasInboundVoice(event)) return respond("ambient-voice");
      if (wakeWordMentionedMidSentence) return respond("ambient-name-mention");
      if (looksLikeAmbientQuestion(combinedText)) return respond("ambient-question");
      if (!event.text.normalize("NFKC").trim() && event.parts?.some((part) => part.type !== "text")) {
        return ignore("ambient-media-only");
      }
      if (context.hotChat && isHotChat(event, recentMessages, context.hotChat)) return respond("ambient-hot-chat");
      return ignore("ambient-no-signal");
    }
    return ignore("not-addressed");
  }
}

function isInboundEmoji(event: TriggerContext["event"]): boolean {
  if (event.metadata?.interaction === "emoji") return true;
  return (event.parts ?? []).some((part) =>
    part.type === "image" && part.asset.metadata?.kind === "emoji");
}

function canonicalIdentityId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.split(":").at(-1) || normalized;
}

function isHotChat(
  event: TriggerContext["event"],
  recentMessages: StoredMessage[],
  settings: NonNullable<TriggerContext["hotChat"]>,
): boolean {
  const now = event.timestamp ?? Date.now();
  const cutoff = now - settings.windowMs;
  const recentInbound = recentMessages.filter(
    (message) => message.direction === "inbound" && message.timestamp >= cutoff && message.timestamp <= now,
  );
  const messageCount = recentInbound.length + 1;
  if (messageCount < settings.minMessages) return false;
  const participants = new Set(recentInbound.map((message) => message.senderId));
  participants.add(event.sender.id);
  return participants.size >= settings.minParticipants;
}

function looksLikeAmbientQuestion(value: string): boolean {
  const text = value.normalize("NFKC").trim();
  if ([...text].length < 4) return false;
  if (/[?？]/u.test(text) || /(?:吗|么|嘛|呢)[。！]?$/.test(text)) return true;
  return /(?:^|[，。！；、\s])(?:谁|什么|怎么|为什么|为何|哪(?:个|里|儿)?|多少|多久|能不能|可不可以|有没有|是不是|知不知道|请问|求助|求推荐)(?:$|[呢吗呀啊，。！；、\s])/u.test(text);
}

/**
 * A wake word only counts as being addressed when it sits in a vocative
 * position: sentence start/end, flanked by punctuation, prefixed with @, or
 * directly followed by a second-person pronoun. Third-person mentions buried
 * inside a sentence ("我同事小明今天…") stay ambient signals.
 */
function isAddressedWakeWord(text: string, word: string): boolean {
  const boundary = (char: string | undefined): boolean =>
    char === undefined || /[\s@，。！？；、：,.!?;:~～…()（）\[\]【】"'“”‘’]/u.test(char);
  for (let from = text.indexOf(word); from >= 0; from = text.indexOf(word, from + 1)) {
    const before = from > 0 ? text[from - 1] : undefined;
    const afterIndex = from + word.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    if (boundary(before)) return true;
    // “这 bot / 那个机器人” describes the bot in the third person; a
    // sentence boundary after the name must not turn it into a vocative call.
    // This is especially important for the generic wake word “bot”.
    const prefix = text.slice(Math.max(0, from - 4), from);
    const demonstrativeReference = /(?:这|那|此|这个|那个|这种|那种|这台|那台)$/u.test(prefix);
    if (boundary(after) && !demonstrativeReference) return true;
    if (after === "你" || after === "您") return true;
  }
  return false;
}

/**
 * Natural continuation: the bot recently answered in this thread and the
 * sender is following up. A single interjection from a third member no longer
 * breaks the chain, but the sender must have participated around the bot's
 * turn (or be the one the bot replied to).
 */
function isNaturalContinuation(
  messages: StoredMessage[],
  senderId: string,
  botId: string,
  now: number,
  windowMs: number,
): boolean {
  if (windowMs <= 0) return false;
  let botIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction === "outbound" && message.senderId === botId) {
      botIndex = index;
      break;
    }
  }
  if (botIndex < 0) return false;
  const botMessage = messages[botIndex]!;
  if (now < botMessage.timestamp || now - botMessage.timestamp > windowMs) return false;
  const after = messages.slice(botIndex + 1);
  if (after.length > 6) return false;
  if (botMessage.replyToMessageId) {
    const repliedTo = messages.find((message) => message.id === botMessage.replyToMessageId);
    if (repliedTo?.senderId === senderId) return true;
  }
  const nearby = [...messages.slice(Math.max(0, botIndex - 3), botIndex), ...after];
  return nearby.some((message) => message.direction === "inbound" && message.senderId === senderId);
}

function respond(reason: string): TriggerDecision {
  return { respond: true, reason };
}

function ignore(reason: string): TriggerDecision {
  return { respond: false, reason };
}
