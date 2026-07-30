import { AdminStore } from "./admin-store.js";
import { AgentSupervisor } from "./supervisor.js";
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WechatIpadLoginType = "ipad" | "win" | "mac" | "car" | "android-pad";
export type WechatIpadLoginPhase = "offline" | "qr" | "scanned" | "verification" | "waiting-confirmation" | "online" | "expired" | "error";
export interface WechatIpadLoginStatus {
    phase: WechatIpadLoginPhase;
    accountWxid?: string;
    nickname?: string;
    headImageUrl?: string;
    qrImage?: string;
    qrContent?: string;
    expiresInSeconds?: number;
    loginType?: WechatIpadLoginType;
    sliderAvailable: boolean;
    message: string;
}
export interface WechatIpadLoginManagerOptions {
    store: AdminStore;
    supervisor: AgentSupervisor;
    env?: Readonly<Record<string, string | undefined>>;
    fetch?: FetchLike;
    uuidBaseUrl?: string;
    sliderBaseUrl?: string;
    sliderToken?: string;
    timeoutMs?: number;
    sessionTtlMs?: number;
}
/**
 * Owns short-lived iPad login credentials. Secrets never leave this object and
 * are intentionally discarded when the process restarts or login completes.
 */
export declare class WechatIpadLoginManager {
    #private;
    constructor(options: WechatIpadLoginManagerOptions);
    status(botId: string): Promise<WechatIpadLoginStatus>;
    start(botId: string, input?: {
        loginType?: WechatIpadLoginType;
        deviceName?: string;
    }): Promise<WechatIpadLoginStatus>;
    poll(botId: string): Promise<WechatIpadLoginStatus>;
    submitSecurityCode(botId: string, code: string): Promise<WechatIpadLoginStatus>;
    cancel(botId: string): WechatIpadLoginStatus;
    sliderAvailable(): boolean;
    createSliderUrl(botId: string): string;
    sliderPage(nonce: string): Promise<string>;
    submitSlider(nonce: string, params: URLSearchParams): Promise<unknown>;
}
export {};
//# sourceMappingURL=wechat-ipad-login.d.ts.map