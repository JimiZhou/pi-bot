import type { AssetRef, AttachmentRef, MessagePart } from "./types.js";

export function validateMessageParts(parts: MessagePart[] | undefined): void {
  if (!parts) return;
  if (parts.length > 100) throw new Error("A message cannot contain more than 100 parts");
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (!part.text.trim()) throw new Error("Text message part cannot be empty");
        break;
      case "image":
        validateAssetRef(part.asset);
        validateOptionalInteger(part.width, "Image width");
        validateOptionalInteger(part.height, "Image height");
        break;
      case "audio":
      case "voice":
        validateAssetRef(part.asset);
        validateOptionalInteger(part.durationMs, `${part.type} durationMs`);
        break;
      case "video":
        validateAssetRef(part.asset);
        validateOptionalInteger(part.durationMs, "Video durationMs");
        validateOptionalInteger(part.width, "Video width");
        validateOptionalInteger(part.height, "Video height");
        break;
      case "file":
        validateAssetRef(part.asset);
        if (part.name !== undefined && !part.name.trim()) throw new Error("File part name cannot be empty");
        break;
      case "link":
        if (!part.url.trim()) throw new Error("Link message part URL cannot be empty");
        break;
      case "mention":
        if (!part.memberId.trim()) throw new Error("Mention memberId cannot be empty");
        break;
      case "quote":
        if (!part.messageId.trim()) throw new Error("Quote messageId cannot be empty");
        break;
      default:
        assertNever(part);
    }
  }
}

export function validateAssetRef(asset: AssetRef): void {
  if (!asset.id.trim()) throw new Error("Asset id cannot be empty");
  if (!asset.locator.trim()) throw new Error("Asset locator cannot be empty");
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 0)) {
    throw new Error("Asset size must be a non-negative safe integer");
  }
  if (asset.expiresAt !== undefined && (!Number.isSafeInteger(asset.expiresAt) || asset.expiresAt < 0)) {
    throw new Error("Asset expiresAt must be a non-negative Unix timestamp in milliseconds");
  }
  if (asset.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(asset.sha256)) {
    throw new Error("Asset sha256 must contain 64 hexadecimal characters");
  }
  if (asset.metadata) {
    let serialized: string;
    try {
      serialized = JSON.stringify(asset.metadata);
    } catch {
      throw new Error("Asset metadata must be JSON serializable");
    }
    if (serialized.length > 64_000) throw new Error("Asset metadata cannot exceed 64000 characters");
  }
}

export function renderMessageParts(parts: MessagePart[] | undefined, includeText: boolean): string[] {
  if (!parts) return [];
  return parts.flatMap((part) => {
    switch (part.type) {
      case "text":
        return includeText ? [part.text] : [];
      case "image":
        return [`[图片: ${part.alt ?? assetLabel(part.asset)}]`];
      case "audio":
        return [`[音频: ${assetLabel(part.asset)}${durationLabel(part.durationMs)}]`];
      case "voice":
        return [part.transcript ? `[语音转写: ${part.transcript}]` : `[语音: ${assetLabel(part.asset)}${durationLabel(part.durationMs)}]`];
      case "video":
        return [`[视频: ${assetLabel(part.asset)}${durationLabel(part.durationMs)}]`];
      case "file":
        return [`[文件: ${part.name ?? assetLabel(part.asset)}]`];
      case "link":
        return [`[链接: ${part.title ?? part.url}${part.description ? ` - ${part.description}` : ""}]`];
      case "mention":
        return [`@${part.displayName ?? part.memberId}`];
      case "quote":
        return [`[引用消息: ${part.messageId}]`];
      default:
        return assertNever(part);
    }
  });
}

export function renderLegacyAttachments(attachments: AttachmentRef[] | undefined): string[] {
  return (attachments ?? []).map((item) => {
    const detail = item.description ?? item.name ?? item.mimeType ?? item.kind;
    return `[附件:${item.kind} ${detail}]`;
  });
}

export function textPart(text: string): MessagePart {
  return { type: "text", text };
}

function assetLabel(asset: AssetRef): string {
  return asset.name ?? asset.mimeType ?? asset.id;
}

function durationLabel(durationMs: number | undefined): string {
  return durationMs === undefined ? "" : `, ${Math.round(durationMs / 100) / 10}s`;
}

function validateOptionalInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported message part: ${JSON.stringify(value)}`);
}
