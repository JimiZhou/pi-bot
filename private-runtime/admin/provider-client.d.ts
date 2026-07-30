import type { ManagedProviderApi, ProviderProfile } from "./config.js";
type ConcreteProviderApi = Exclude<ManagedProviderApi, "auto">;
export interface DiscoveredProviderModel {
    id: string;
    name: string;
    input: Array<"text" | "image">;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    metadataSource: "provider" | "models.dev" | "heuristic" | "default";
}
export interface ProviderProbeResult {
    ok: true;
    latencyMs: number;
    detectedApi: ConcreteProviderApi;
    compatibleApis: ConcreteProviderApi[];
    detection: "manual" | "url-and-endpoint";
    modelCount: number;
    models: DiscoveredProviderModel[];
}
export interface ProviderProbeOptions {
    timeoutMs?: number;
    fetch?: typeof fetch;
    metadataFetch?: typeof fetch;
    includePublicMetadata?: boolean;
}
/** Tests credentials and discovers models without consulting Pi's bundled catalog. */
export declare function probeProvider(profile: ProviderProfile, apiKey: string, options?: ProviderProbeOptions): Promise<ProviderProbeResult>;
export {};
//# sourceMappingURL=provider-client.d.ts.map