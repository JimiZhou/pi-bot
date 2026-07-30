/** WeChat identity helpers used at the model and delivery boundaries. */
export function looksLikeWechatId(value) {
    const normalized = canonicalIdentity(value ?? "");
    return /^wxid_[a-z0-9_-]+$/iu.test(normalized) || /^gh_[a-z0-9_-]+$/iu.test(normalized);
}
export function safeGroupDisplayName(value, identityId, fallback = "群友") {
    const identity = canonicalIdentity(identityId);
    const identityFallback = identity && !identity.endsWith("@chatroom") ? identity : fallback;
    const normalized = value?.normalize("NFKC").trim();
    if (!normalized)
        return identityFallback;
    if (isPlaceholderDisplayName(normalized))
        return identityFallback;
    if (looksLikeWechatId(normalized))
        return identityFallback;
    if (canonicalIdentity(normalized) === identity)
        return identityFallback;
    return normalized;
}
export function replaceWechatIds(value, members = []) {
    const names = new Map(members.map((member) => [
        canonicalIdentity(member.id),
        safeGroupDisplayName(member.displayName, member.id),
    ]));
    return value.replace(/(?:[a-z0-9._-]+:)?(?:wxid|gh)_[a-z0-9_-]+/giu, (match) => names.get(canonicalIdentity(match)) ?? canonicalIdentity(match));
}
export function canonicalIdentity(value) {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized.split(":").at(-1) || normalized;
}
function isPlaceholderDisplayName(value) {
    return /^(?:群友|群成员|未知(?:群友|成员|用户)|微信用户|微信好友|好友|用户|unknown|member)$/iu.test(value);
}
//# sourceMappingURL=display-name.js.map