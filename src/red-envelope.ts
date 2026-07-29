export type RedEnvelopeKind = "red-envelope" | "gift";

export interface RedEnvelopeMetadata {
  interaction: "red-envelope";
  redEnvelopeKind: RedEnvelopeKind;
  redEnvelopeTitle?: string;
  exclusiveReceiverId?: string;
}

/** Parses IM AppMessage XML without treating group collection (sceneid=1001) as a red envelope. */
export function parseRedEnvelopeMetadata(xml: string, nativeSubType?: string): RedEnvelopeMetadata | undefined {
  const appType = tagText(xml, "type")?.trim() || nativeSubType?.trim();
  const subType = tagText(xml, "subtype")?.trim();
  const title = tagText(xml, "title")?.trim();
  if (tagText(xml, "sceneid")?.trim() === "1001") return undefined;

  if (appType === "2001") {
    const receiver = tagText(xml, "exclusive_recv_username")?.trim();
    return {
      interaction: "red-envelope",
      redEnvelopeKind: "red-envelope",
      ...(title ? { redEnvelopeTitle: title } : {}),
      ...(receiver ? { exclusiveReceiverId: receiver } : {}),
    };
  }

  if (appType === "124" || nativeSubType === "124") {
    const receiver = subType === "1" && tagText(xml, "takemethod")?.trim() === "2"
      ? tagText(xml, "recvusername")?.trim()
      : undefined;
    return {
      interaction: "red-envelope",
      redEnvelopeKind: "gift",
      ...(title ? { redEnvelopeTitle: title } : {}),
      ...(receiver ? { exclusiveReceiverId: receiver } : {}),
    };
  }
  return undefined;
}

function tagText(xml: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${escaped}>`, "iu").exec(xml);
  return match?.[1]?.trim();
}
