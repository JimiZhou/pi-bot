import { AdminStore } from "./admin-store.js";
import { AgentSupervisor } from "./supervisor.js";
import { ChannelAdapterRegistry } from "../channel-adapter.js";
export interface AdminServerOptions {
    store: AdminStore;
    supervisor: AgentSupervisor;
    token: string;
    host?: string;
    port?: number;
    allowPublicClients?: boolean;
    maxBodyBytes?: number;
    webRoot?: string;
    adapterRegistry?: ChannelAdapterRegistry;
}
export declare class AdminServer {
    #private;
    constructor(options: AdminServerOptions);
    start(): Promise<{
        host: string;
        port: number;
    }>;
    close(): Promise<void>;
    address(): {
        host: string;
        port: number;
    };
}
//# sourceMappingURL=server.d.ts.map
