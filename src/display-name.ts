/** Transport-independent identity helpers used at model boundaries. */
export function safeGroupDisplayName(
  value: string | undefined,
  identityId: string,
  fallback = "群友",
): string {
  const identity = canonicalIdentity(identityId);
  const identityFallback = identity && isReadableIdentity(identity) ? identity : fallback;
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized) return identityFallback;
  if (isPlaceholderDisplayName(normalized)) return identityFallback;
  if (!isReadableIdentity(normalized)) return identityFallback;
  if (canonicalIdentity(normalized) === identity) return identityFallback;
  return normalized;
}

export function replaceTransportIds(
  value: string,
  members: ReadonlyArray<{ id: string; displayName: string }> = [],
): string {
  const names = new Map(
    members.map((member) => [
      canonicalIdentity(member.id),
      safeGroupDisplayName(member.displayName, member.id),
    ]),
  );
  let result = value;
  for (const [id, name] of names) {
    if (!id || id === name) continue;
    result = result.replace(new RegExp(escapeRegExp(id), "giu"), name);
  }
  return result;
}

export function canonicalIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function isPlaceholderDisplayName(value: string): boolean {
  return /^(?:群友|群成员|未知(?:群友|成员|用户)|好友|用户|unknown|member)$/iu.test(value);
}

function isReadableIdentity(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > 80) return false;
  if (/^[a-z]{2,8}[_:-][a-z\d_-]{3,}$/iu.test(normalized)) return false;
  if (/[@:\\/]|\s{2,}/u.test(normalized)) return false;
  if (/^[a-f\d]{20,}$/iu.test(normalized)) return false;
  return !/^[a-z\d_-]{24,}$/iu.test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
