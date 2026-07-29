import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentPluginContext } from "../src/agent-plugin.js";
import { GroupAgentCore } from "../src/core.js";
import { RepeaterPlugin } from "../src/plugins/repeater.js";
import type { InboundMessageEvent, MessagePart } from "../src/types.js";

test("repeater joins after two different people repeat text but ignores one-person repeats and bot mentions", async (context) => {
  const fixture = createRepeaterFixture(context);
  await fixture.core.receiveIgnored(message("repeat-1", "member-a", "甲", "好耶"), "seed");

  assert.equal(fixture.plugin.handleInbound(message("repeat-same-person", "member-a", "甲", "好耶")), undefined);
  const action = fixture.plugin.handleInbound(message("repeat-2", "member-b", "乙", "好耶"));
  assert.deepEqual(action, { kind: "direct-reply", text: "好耶", reason: "plugin-repeater-text" });
  assert.equal(fixture.plugin.handleInbound(message("repeat-command", "member-a", "甲", "菜单", {
    mentions: [{ id: "bot-identity" }],
  })), undefined);
});

test("repeater preserves a normalized emoji part so animation metadata is retained", async (context) => {
  const fixture = createRepeaterFixture(context);
  const first = emojiMessage("emoji-1", "member-a", "甲");
  const current = emojiMessage("emoji-2", "member-b", "乙");
  await fixture.core.receiveIgnored(first, "seed");

  const action = fixture.plugin.handleInbound(current);
  assert.equal(action?.kind, "direct-reply");
  assert.equal(action?.kind === "direct-reply" ? action.reason : "", "plugin-repeater-emoji");
  const part = action?.kind === "direct-reply" ? action.parts?.[0] : undefined;
  assert.equal(part?.type, "image");
  assert.equal(part?.type === "image" ? part.asset.source : "", "platform");
  assert.equal(part?.type === "image" ? part.asset.sha256 : "", "a".repeat(64));

  const handled = await fixture.core.receiveDirect(
    current,
    action?.kind === "direct-reply" ? action.text : "",
    "plugin-repeater-emoji",
    action?.kind === "direct-reply" ? action.parts : undefined,
  );
  assert.equal(handled.actions[0]?.parts?.length, 1);
  assert.equal(handled.actions[0]?.parts?.[0]?.type, "image");
});

function createRepeaterFixture(context: test.TestContext): { core: GroupAgentCore; plugin: RepeaterPlugin } {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-repeater-test-"));
  const core = new GroupAgentCore({
    bot: { id: "bot-identity", displayName: "欧本克劳" },
    runner: { run: async () => ({ text: null }) },
    databasePath: join(directory, "agent.sqlite"),
  });
  context.after(() => {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const plugin = new RepeaterPlugin({
    id: "repeater",
    type: "repeater",
    enabled: true,
    settings: { cooldownMinutes: 8 },
  }, {
    botId: "bot-main",
    identityId: "bot-identity",
    timezoneOffsetMinutes: 480,
    core,
    runtime: {} as AgentPluginContext["runtime"],
    claim: () => true,
    releaseClaim: () => true,
    isEnabledForConversation: () => true,
    log: () => undefined,
  });
  return { core, plugin };
}

function message(
  id: string,
  senderId: string,
  displayName: string,
  text: string,
  overrides: Partial<InboundMessageEvent> = {},
): InboundMessageEvent {
  return {
    type: "message",
    id,
    conversation: { id: "account:room-group", kind: "group" },
    sender: { id: senderId, displayName },
    text,
    timestamp: Date.now(),
    ...overrides,
  };
}

function emojiMessage(id: string, senderId: string, displayName: string): InboundMessageEvent {
  const part: MessagePart = {
    type: "image",
    asset: {
      id: `adapter-a:${id}`,
      source: "platform",
      locator: `message:${id}`,
      ownerPluginId: "adapter-a-bot-main",
      sha256: "a".repeat(64),
      metadata: { kind: "emoji" },
    },
    alt: "平台动态表情",
  };
  return message(id, senderId, displayName, "", { metadata: { interaction: "emoji" }, parts: [part] });
}
