import { type Api, type Model } from "@earendil-works/pi-ai";
import type { ManagedProviderApi, ModelProfile, ProviderProfileSummary } from "./config.js";
export type ConcreteProviderApi = Exclude<ManagedProviderApi, "auto">;
export interface ModelConnectionTestOptions {
    image?: boolean;
    timeoutMs?: number;
}
export interface ModelConnectionTestResult {
    ok: true;
    mode: "text" | "image";
    api: ConcreteProviderApi;
    latencyMs: number;
    responseText: string;
    responseModel: string;
    inputTokens: number;
    outputTokens: number;
}
/** Builds a pi-ai runtime model without consulting Pi's bundled provider/model catalog. */
export declare function resolveCustomModel(profile: ModelProfile, providerProfile: ProviderProfileSummary): Model<Api>;
/** Resolves the concrete protocol used by a bot without consulting Pi's bundled catalog. */
export declare function effectiveModelApi(profile: ModelProfile, providerProfile: ProviderProfileSummary): ConcreteProviderApi;
/** Adapts a shared gateway URL to the path convention expected by each native SDK. */
export declare function modelProtocolBaseUrl(baseUrl: string, api: ConcreteProviderApi): string;
/** Performs a real, bounded inference through the exact runtime path used by bots. */
export declare function testModelConnection(profile: ModelProfile, providerProfile: ProviderProfileSummary, apiKey: string, options?: ModelConnectionTestOptions): Promise<ModelConnectionTestResult>;
//# sourceMappingURL=model-runtime.d.ts.map