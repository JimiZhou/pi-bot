import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AdminStore } from "./admin-store.js";
import { AdminServer } from "./server.js";
import { AgentSupervisor } from "./supervisor.js";
import { loadChannelAdapterRegistry } from "./adapter-loader.js";
const dataDirectory = resolve(process.env.PI_AGENT_DATA_DIR ?? "./data");
const databasePath = resolve(dataDirectory, "admin.sqlite");
const token = await loadAdminToken(dataDirectory);
const secretKey = await loadAdminSecretKey(dataDirectory);
const store = new AdminStore(databasePath, { secretKey });
const adapterRegistry = await loadChannelAdapterRegistry();
const supervisor = new AgentSupervisor({
    store,
    dataDirectory,
    adapterRegistry,
    healthIntervalMs: environmentInteger("PI_GATEWAY_HEALTH_INTERVAL_MS", 30_000, 5000, 10 * 60_000),
});
const server = new AdminServer({
    store,
    supervisor,
    token,
    host: process.env.PI_WEBUI_HOST ?? "0.0.0.0",
    port: environmentInteger("PI_WEBUI_PORT", 8787, 1, 65_535),
    allowPublicClients: process.env.PI_WEBUI_ALLOW_PUBLIC === "true",
    adapterRegistry,
});
let stopping = false;
async function shutdown(signal) {
    if (stopping)
        return;
    stopping = true;
    store.appendLog({ level: "info", scope: "system", event: "process.shutdown", message: `收到 ${signal}，正在停止` });
    await server.close().catch(() => undefined);
    await supervisor.close().catch(() => undefined);
    store.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
try {
    await supervisor.start();
    const address = await server.start();
    process.stdout.write(`pi-bot WebUI listening on ${address.host}:${address.port}\n`);
    process.stdout.write(`Admin token file: ${resolve(dataDirectory, "admin-token.txt")}\n`);
}
catch (error) {
    process.stderr.write(`Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await shutdown("startup failure");
    process.exitCode = 1;
}
async function loadAdminToken(directory) {
    const configured = process.env.PI_ADMIN_TOKEN?.trim();
    if (configured) {
        if (configured.length < 24)
            throw new Error("PI_ADMIN_TOKEN must contain at least 24 characters");
        return configured;
    }
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "admin-token.txt");
    try {
        const existing = (await readFile(path, "utf8")).trim();
        if (existing.length < 24)
            throw new Error("Existing admin-token.txt is too short");
        return existing;
    }
    catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    }
    const generated = randomBytes(32).toString("hex");
    const file = await open(path, "wx", 0o600);
    try {
        await file.writeFile(`${generated}\n`, "utf8");
    }
    finally {
        await file.close();
    }
    return generated;
}
async function loadAdminSecretKey(directory) {
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "admin-secret.key");
    try {
        const existing = await readFile(path);
        if (existing.byteLength !== 32)
            throw new Error("Existing admin-secret.key must contain exactly 32 bytes");
        return existing;
    }
    catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    }
    const generated = randomBytes(32);
    const file = await open(path, "wx", 0o600);
    try {
        await file.writeFile(generated);
    }
    finally {
        await file.close();
    }
    return generated;
}
function environmentInteger(name, fallback, min, max) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
//# sourceMappingURL=main.js.map
