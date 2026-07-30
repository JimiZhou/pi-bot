/**
 * Serializes every raw iPad protocol request for one account, even when the
 * callers use different client instances (health, metadata, media and login).
 */
export declare function runWechatIpadProtocolRequest<T>(apiBaseUrl: string, accountWxid: string, operation: () => Promise<T>, minimumGapMs?: number): Promise<T>;
//# sourceMappingURL=wechat-ipad-request-queue.d.ts.map