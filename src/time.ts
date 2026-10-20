/**
 * Chat-facing timestamps use Beijing time regardless of the host/container
 * timezone. Persisted timestamps remain Unix milliseconds/UTC elsewhere.
 */
export const BEIJING_TIMEZONE = "Asia/Shanghai";
export const BEIJING_OFFSET_MINUTES = 8 * 60;

export function formatBeijingTimestamp(timestamp: number): string {
  return formatWithOffset(timestamp, true);
}

export function formatBeijingMinute(timestamp: number): string {
  return formatWithOffset(timestamp, false);
}

function formatWithOffset(timestamp: number, includeSeconds: boolean): string {
  const date = new Date(timestamp + BEIJING_OFFSET_MINUTES * 60_000);
  if (Number.isNaN(date.valueOf())) return "无效时间";
  const iso = date.toISOString();
  return `${iso.slice(0, includeSeconds ? 19 : 16)}+08:00`;
}
