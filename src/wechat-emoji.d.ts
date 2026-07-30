import type { AssetRef } from "./types.js";
export declare const WX_SOURCE_EMOJI_XML_PREFIX = "[[wx_source_emoji_xml]]";
/** Returns replayable type=47 XML without any group-sender prefix. */
export declare function wechatEmojiXmlFromAsset(asset: AssetRef): string | undefined;
export declare function attachWechatEmojiXml(asset: AssetRef, source: AssetRef): AssetRef;
export declare function wechatEmojiCdnUrl(asset: AssetRef): URL | undefined;
/** Returns the fields required by WeChat's native /Msg/SendEmoji replay API. */
export declare function wechatEmojiSendReference(asset: AssetRef): {
    md5: string;
    totalLen: number;
} | undefined;
//# sourceMappingURL=wechat-emoji.d.ts.map