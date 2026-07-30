export const WX_SOURCE_EMOJI_XML_PREFIX = "[[wx_source_emoji_xml]]";
const MAX_NATIVE_EMOJI_XML_BYTES = 58_000;
/** Returns replayable type=47 XML without any group-sender prefix. */
export function wechatEmojiXmlFromAsset(asset) {
    const candidate = asset.metadata?.wechatEmojiXml ?? asset.metadata?.nativeContent;
    if (typeof candidate !== "string")
        return undefined;
    const start = candidate.search(/<msg\b/iu);
    if (start < 0)
        return undefined;
    const xml = candidate.slice(start).trim();
    if (!/<emoji\b/iu.test(xml) || xml.includes("\t") || Buffer.byteLength(xml, "utf8") > MAX_NATIVE_EMOJI_XML_BYTES) {
        return undefined;
    }
    return xml;
}
export function attachWechatEmojiXml(asset, source) {
    const xml = wechatEmojiXmlFromAsset(source);
    if (!xml)
        return asset;
    return {
        ...asset,
        metadata: {
            ...(asset.metadata ?? {}),
            nativeType: "47",
            wechatEmojiXml: xml,
        },
    };
}
export function wechatEmojiCdnUrl(asset) {
    const xml = wechatEmojiXmlFromAsset(asset);
    if (!xml)
        return undefined;
    const encoded = xmlAttribute(xml, "cdnurl") ?? xmlAttribute(xml, "externurl");
    if (!encoded)
        return undefined;
    let url;
    try {
        url = new URL(decodeXmlAttribute(encoded));
    }
    catch {
        return undefined;
    }
    const hostname = url.hostname.toLocaleLowerCase();
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        !(hostname === "qq.com" || hostname.endsWith(".qq.com") || hostname.endsWith(".qpic.cn"))) {
        return undefined;
    }
    url.username = "";
    url.password = "";
    return url;
}
/** Returns the fields required by WeChat's native /Msg/SendEmoji replay API. */
export function wechatEmojiSendReference(asset) {
    const xml = wechatEmojiXmlFromAsset(asset);
    if (!xml)
        return undefined;
    const md5 = xmlAttribute(xml, "md5")?.trim().toLocaleLowerCase();
    const length = xmlAttribute(xml, "len") ?? xmlAttribute(xml, "androidlen");
    const totalLen = length ? Number(length.trim()) : Number.NaN;
    if (!md5 || !/^[a-f\d]{32}$/u.test(md5) || !Number.isSafeInteger(totalLen) || totalLen <= 0)
        return undefined;
    return { md5, totalLen };
}
function xmlAttribute(xml, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "iu").exec(xml)?.[1];
}
function decodeXmlAttribute(value) {
    return value
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", "\"")
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
}
//# sourceMappingURL=wechat-emoji.js.map