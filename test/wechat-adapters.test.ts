import assert from "node:assert/strict";
import test from "node:test";

import {
  createWechatAdapterRegistry,
  wechatIpadAdapter,
  wxHookHttpAdapter,
} from "../src/adapters/definitions.js";
import { describeChannelPlugin } from "../src/channel-adapter.js";

test("WeChat adapters expose explicit versioned manifests", () => {
  const registry = createWechatAdapterRegistry();
  assert.deepEqual(registry.list().map((manifest) => manifest.type), [
    "wechat-ipad",
    "wx-hook-http",
  ]);
  assert.equal(wechatIpadAdapter.manifest.capabilities?.[0]?.id, "media.resolve");
  assert.equal(wxHookHttpAdapter.manifest.features?.some((feature) => feature.id === "message.send.voice"), false);
});

test("registered WeChat adapters create manifest-constrained plugins", async () => {
  const registry = createWechatAdapterRegistry();
  const ipad = await registry.create("wechat-ipad", {
    api: {
      baseUrl: "http://wechat-ipad.invalid/api",
      accountWxid: "wxid_test",
    },
    callback: { port: 9001 },
    pluginId: "wechat-ipad-test",
  });
  const hook = await registry.create("wx-hook-http", {
    gateway: {
      baseUrl: "http://wx-hook.invalid",
      apiToken: "test-token",
    },
    webhook: {
      port: 9000,
      secret: "test-secret-value",
    },
    pluginId: "wx-hook-test",
  });

  assert.equal(describeChannelPlugin(ipad).instanceId, "wechat-ipad-test");
  assert.equal(describeChannelPlugin(hook).instanceId, "wx-hook-test");
});
