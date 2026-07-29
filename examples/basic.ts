import { getModel } from "@earendil-works/pi-ai";
import {
  CHANNEL_PLUGIN_API_VERSION,
  ChannelRuntime,
  GroupAgentCore,
  PiAgentRunner,
  defineChannelPlugin,
  type ChannelPluginContext,
} from "../src/index.js";

const core = new GroupAgentCore({
  bot: { id: "bot-1", displayName: "小派", wakeWords: ["派派"] },
  runner: new PiAgentRunner({
    model: getModel("anthropic", "claude-sonnet-4-6"),
    apiKey: () => process.env.ANTHROPIC_API_KEY,
    thinkingLevel: "low",
  }),
  databasePath: "./data/example.sqlite",
  onTrace: (event) => console.log(JSON.stringify(event)),
});

let channel: ChannelPluginContext | undefined;
const plugin = defineChannelPlugin({
  apiVersion: CHANNEL_PLUGIN_API_VERSION,
  id: "example-framework",
  start(context) {
    channel = context;
    // 真实插件在这里注册 framework.on("message", raw => context.ingest(map(raw)))。
  },
  async send(action) {
    // 真实插件在这里调用 framework.sendText，并把 action.id 作为幂等键。
    console.log("SEND", action.conversationId, action.text);
  },
  stop() {
    channel = undefined;
    // 真实插件在这里解除监听并关闭它自己拥有的连接。
  },
});

const runtime = new ChannelRuntime({ core, plugin });

try {
  await runtime.start();
  if (!channel) throw new Error("Example channel failed to start");
  const result = await channel.ingest({
    type: "message",
    id: `demo-${Date.now()}`,
    conversation: { id: "demo-group", kind: "group", title: "演示群" },
    sender: { id: "alice", displayName: "阿青" },
    text: "小派，简单介绍一下你自己",
    timestamp: Date.now(),
    mentions: [{ id: "bot-1" }],
  });
  console.log(result.handling);
} finally {
  await runtime.stop();
  core.close();
}
