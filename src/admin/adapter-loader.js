import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelAdapterRegistry } from "../channel-adapter.js";

/**
 * Loads trusted channel adapters supplied by the deployment. The public
 * package intentionally ships with an empty registry.
 */
export async function loadChannelAdapterRegistry(options = {}) {
    const registry = new ChannelAdapterRegistry();
    const moduleName = (options.moduleName ?? process.env.PI_CHANNEL_ADAPTER_MODULE)?.trim();
    if (!moduleName)
        return registry;
    const moduleUrl = moduleName.startsWith(".") || isAbsolute(moduleName)
        ? pathToFileURL(resolve(process.cwd(), moduleName)).href
        : moduleName;
    const loaded = await import(moduleUrl);
    const definitions = Array.isArray(loaded.adapters)
        ? loaded.adapters
        : loaded.adapter
            ? [loaded.adapter]
            : [];
    if (definitions.length === 0)
        throw new Error("PI_CHANNEL_ADAPTER_MODULE must export adapter or adapters");
    for (const definition of definitions)
        registry.register(definition);
    return registry;
}
