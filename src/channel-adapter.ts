import {
  defineChannelPlugin,
  type ChannelPlugin,
} from "./channel.js";
import {
  assertFeature,
  featureKey,
  type ChannelFeature,
} from "./channel-capabilities.js";

export const CHANNEL_ADAPTER_API_VERSION = 1 as const;

/**
 * Static, serializable description of one replaceable IM adapter.
 *
 * `features` and `capabilities` are the maximum set an adapter implementation
 * may expose. A configured plugin instance may advertise a smaller subset.
 */
export interface ChannelAdapterManifest {
  readonly apiVersion: typeof CHANNEL_ADAPTER_API_VERSION;
  readonly type: string;
  readonly displayName: string;
  readonly description?: string;
  readonly features?: readonly ChannelFeature[];
  readonly capabilities?: readonly ChannelFeature[];
}

/** Factory boundary used by applications that select an IM adapter at runtime. */
export interface ChannelAdapterDefinition<TOptions = unknown> {
  readonly manifest: ChannelAdapterManifest;
  create(options: TOptions): ChannelPlugin | Promise<ChannelPlugin>;
}

export interface ChannelPluginDescription {
  instanceId: string;
  displayName?: string;
  features: ChannelFeature[];
  capabilities: ChannelFeature[];
}

export function defineChannelAdapter<TOptions>(
  definition: ChannelAdapterDefinition<TOptions>,
): ChannelAdapterDefinition<TOptions> {
  assertChannelAdapterManifest(definition.manifest);
  if (typeof definition.create !== "function") throw new Error("Channel adapter must implement create");
  return definition;
}

/**
 * Registry for trusted adapter packages. Registration is explicit: importing
 * an npm package never grants it transport or model-tool access by itself.
 */
export class ChannelAdapterRegistry {
  readonly #definitions = new Map<string, ChannelAdapterDefinition<unknown>>();

  register<TOptions>(definition: ChannelAdapterDefinition<TOptions>): this {
    const validated = defineChannelAdapter(definition);
    const type = validated.manifest.type;
    if (this.#definitions.has(type)) throw new Error(`Duplicate channel adapter type: ${type}`);
    this.#definitions.set(type, {
      manifest: cloneManifest(validated.manifest),
      create: (options) => validated.create(options as TOptions),
    });
    return this;
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  list(): ChannelAdapterManifest[] {
    return [...this.#definitions.values()].map((definition) => cloneManifest(definition.manifest));
  }

  manifest(type: string): ChannelAdapterManifest | undefined {
    const manifest = this.#definitions.get(type)?.manifest;
    return manifest ? cloneManifest(manifest) : undefined;
  }

  async create<TOptions>(type: string, options: TOptions): Promise<ChannelPlugin> {
    const definition = this.#definitions.get(type);
    if (!definition) throw new Error(`Unknown channel adapter type: ${type}`);
    const plugin = defineChannelPlugin(await definition.create(options));
    assertPluginMatchesManifest(plugin, definition.manifest);
    return plugin;
  }
}

/** Safe runtime view for health pages and diagnostics. Contains no handlers. */
export function describeChannelPlugin(plugin: ChannelPlugin): ChannelPluginDescription {
  defineChannelPlugin(plugin);
  return {
    instanceId: plugin.id,
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    features: [...(plugin.features ?? [])].map(cloneFeature),
    capabilities: (plugin.capabilities ?? []).map((binding) => cloneFeature(binding.capability)),
  };
}

function assertPluginMatchesManifest(plugin: ChannelPlugin, manifest: ChannelAdapterManifest): void {
  const allowedFeatures = new Set((manifest.features ?? []).map(featureKey));
  const allowedCapabilities = new Set((manifest.capabilities ?? []).map(featureKey));
  for (const feature of plugin.features ?? []) {
    if (!allowedFeatures.has(featureKey(feature))) {
      throw new Error(
        `Channel adapter ${manifest.type} created plugin ${plugin.id} with undeclared feature ${featureKey(feature)}`,
      );
    }
  }
  for (const binding of plugin.capabilities ?? []) {
    if (!allowedCapabilities.has(featureKey(binding.capability))) {
      throw new Error(
        `Channel adapter ${manifest.type} created plugin ${plugin.id} with undeclared capability ${featureKey(binding.capability)}`,
      );
    }
  }
}

function assertChannelAdapterManifest(manifest: ChannelAdapterManifest): void {
  if (manifest.apiVersion !== CHANNEL_ADAPTER_API_VERSION) {
    throw new Error(`Unsupported channel adapter API version: ${String(manifest.apiVersion)}`);
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(manifest.type)) {
    throw new Error(`Invalid channel adapter type: ${manifest.type}`);
  }
  if (!manifest.displayName.trim()) throw new Error("Channel adapter displayName cannot be empty");
  if (manifest.description !== undefined && !manifest.description.trim()) {
    throw new Error("Channel adapter description cannot be empty");
  }
  assertUniqueFeatures(manifest.features ?? [], "feature");
  assertUniqueFeatures(manifest.capabilities ?? [], "capability");
  const featureKeys = new Set((manifest.features ?? []).map(featureKey));
  for (const capability of manifest.capabilities ?? []) {
    const key = featureKey(capability);
    if (featureKeys.has(key)) throw new Error(`Duplicate channel adapter feature or capability: ${key}`);
  }
}

function assertUniqueFeatures(features: readonly ChannelFeature[], kind: string): void {
  const seen = new Set<string>();
  for (const feature of features) {
    assertFeature(feature);
    const key = featureKey(feature);
    if (seen.has(key)) throw new Error(`Duplicate channel adapter ${kind}: ${key}`);
    seen.add(key);
  }
}

function cloneManifest(manifest: ChannelAdapterManifest): ChannelAdapterManifest {
  return {
    apiVersion: manifest.apiVersion,
    type: manifest.type,
    displayName: manifest.displayName,
    ...(manifest.description ? { description: manifest.description } : {}),
    features: (manifest.features ?? []).map(cloneFeature),
    capabilities: (manifest.capabilities ?? []).map(cloneFeature),
  };
}

function cloneFeature(feature: ChannelFeature): ChannelFeature {
  return {
    id: feature.id,
    version: feature.version,
    ...(feature.options
      ? {
          options: Object.fromEntries(
            Object.entries(feature.options).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
          ),
        }
      : {}),
  };
}
