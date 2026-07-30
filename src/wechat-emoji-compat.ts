import type { EmojiRecord, EmojiRepository } from "./emoji-library.js";
import type { MessagePart } from "./types.js";
import { attachWechatEmojiXml, wechatEmojiXmlFromAsset } from "./wechat-emoji.js";

interface WechatEmojiRepository extends EmojiRepository {
  updateEmojiAsset(id: string, asset: EmojiRecord["asset"]): EmojiRecord;
}

/** Restores native emoji XML for assets collected before it was persisted. */
export function backfillEmojiNativeMetadata(
  store: WechatEmojiRepository,
  botId: string,
  inboundImages: (sourceEventId: string) => Array<{ part: Extract<MessagePart, { type: "image" }> }>,
): number {
  let updated = 0;
  for (const emoji of store.listEmojis(botId)) {
    if (wechatEmojiXmlFromAsset(emoji.asset) || !emoji.sourceMessageId) continue;
    const source = inboundImages(emoji.sourceMessageId)
      .map((item) => item.part)
      .find((part) => wechatEmojiXmlFromAsset(part.asset));
    if (!source) continue;
    store.updateEmojiAsset(emoji.id, attachWechatEmojiXml(emoji.asset, source.asset));
    updated += 1;
  }
  return updated;
}
