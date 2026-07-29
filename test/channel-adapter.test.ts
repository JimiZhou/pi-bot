import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_ADAPTER_API_VERSION,
  ChannelAdapterRegistry,
  defineChannelAdapter,
  describeChannelPlugin,
} from "../src/channel-adapter.js";
import {
  CHANNEL_PLUGIN_API_VERSION,
  defineChannelPlugin,
} from "../src/channel.js";
import {
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_SEND_IMAGE,
  MEDIA_RESOLVE_CAPABILITY,
} from "../src/channel-capabilities.js";

test("an explicitly registered adapter creates only manifest-declared plugin features", async () => {
  const definition = defineChannelAdapter<{ accountId: string }>({
    manifest: {
      apiVersion: CHANNEL_ADAPTER_API_VERSION,
      type: "example.im",
      displayName: "Example IM",
      features: [CHANNEL_FEATURE_RECEIVE_IMAGE, CHANNEL_FEATURE_SEND_IMAGE],
      capabilities: [],
    },
    create(options) {
      return defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: `example-${options.accountId}`,
        features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
        start() {},
        async send() {},
        stop() {},
      });
    },
  });
  const registry = new ChannelAdapterRegistry();
  assert.equal(registry.has("example.im"), false);
  registry.register(definition);
  const plugin = await registry.create("example.im", { accountId: "account-1" });
  assert.deepEqual(describeChannelPlugin(plugin), {
    instanceId: "example-account-1",
    features: [{ id: "message.receive.image", version: 1 }],
    capabilities: [],
  });

  const manifests = registry.list();
  assert.equal(manifests[0]?.type, "example.im");
  Reflect.set(manifests[0]!.features![0]!, "id", "changed.locally");
  assert.equal(registry.manifest("example.im")?.features?.[0]?.id, "message.receive.image");
});

test("adapter registration rejects duplicate types and undeclared runtime features", async () => {
  const invalid = defineChannelAdapter({
    manifest: {
      apiVersion: CHANNEL_ADAPTER_API_VERSION,
      type: "invalid.im",
      displayName: "Invalid IM",
      features: [],
      capabilities: [],
    },
    create() {
      return defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: "invalid-instance",
        features: [CHANNEL_FEATURE_SEND_IMAGE],
        start() {},
        async send() {},
        stop() {},
      });
    },
  });
  const registry = new ChannelAdapterRegistry().register(invalid);
  assert.throws(() => registry.register(invalid), /Duplicate channel adapter type/u);
  await assert.rejects(registry.create("invalid.im", {}), /undeclared feature message\.send\.image@1/u);
  await assert.rejects(registry.create("missing.im", {}), /Unknown channel adapter type/u);
});

test("registration snapshots the manifest before external code can mutate it", async () => {
  const manifest = {
    apiVersion: CHANNEL_ADAPTER_API_VERSION,
    type: "snapshot.im",
    displayName: "Snapshot IM",
    features: [CHANNEL_FEATURE_RECEIVE_IMAGE],
    capabilities: [],
  };
  const definition = defineChannelAdapter({
    manifest,
    create() {
      return defineChannelPlugin({
        apiVersion: CHANNEL_PLUGIN_API_VERSION,
        id: "snapshot-instance",
        features: [CHANNEL_FEATURE_SEND_IMAGE],
        start() {},
        async send() {},
        stop() {},
      });
    },
  });
  const registry = new ChannelAdapterRegistry().register(definition);
  manifest.features[0] = CHANNEL_FEATURE_SEND_IMAGE;

  assert.equal(registry.manifest("snapshot.im")?.features?.[0]?.id, "message.receive.image");
  await assert.rejects(registry.create("snapshot.im", {}), /undeclared feature message\.send\.image@1/u);
});

test("a manifest cannot declare one identity as both a feature and capability", () => {
  assert.throws(() => defineChannelAdapter({
    manifest: {
      apiVersion: CHANNEL_ADAPTER_API_VERSION,
      type: "ambiguous.im",
      displayName: "Ambiguous IM",
      features: [MEDIA_RESOLVE_CAPABILITY],
      capabilities: [MEDIA_RESOLVE_CAPABILITY],
    },
    create() {
      throw new Error("not reached");
    },
  }), /Duplicate channel adapter feature or capability: media\.resolve@1/u);
});
