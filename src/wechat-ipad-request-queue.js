const DEFAULT_MINIMUM_GAP_MS = 250;
const requestTails = new Map();
const lastCompletedAt = new Map();
/**
 * Serializes every raw iPad protocol request for one account, even when the
 * callers use different client instances (health, metadata, media and login).
 */
export async function runWechatIpadProtocolRequest(apiBaseUrl, accountWxid, operation, minimumGapMs = DEFAULT_MINIMUM_GAP_MS) {
    const key = protocolQueueKey(apiBaseUrl, accountWxid);
    const previous = requestTails.get(key) ?? Promise.resolve();
    const queued = previous.then(async () => {
        const waitMs = Math.max(0, (lastCompletedAt.get(key) ?? 0) + minimumGapMs - Date.now());
        if (waitMs > 0)
            await delay(waitMs);
        try {
            return await operation();
        }
        finally {
            lastCompletedAt.set(key, Date.now());
        }
    });
    const tail = queued.then(() => undefined, () => undefined);
    requestTails.set(key, tail);
    try {
        return await queued;
    }
    finally {
        if (requestTails.get(key) === tail)
            requestTails.delete(key);
    }
}
function protocolQueueKey(apiBaseUrl, accountWxid) {
    const url = new URL(apiBaseUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${path}|${accountWxid.normalize("NFKC").trim().toLocaleLowerCase()}`;
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}
//# sourceMappingURL=wechat-ipad-request-queue.js.map