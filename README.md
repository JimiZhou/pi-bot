# Pi Bot

Pi Bot 是一个与聊天平台无关的持久化 Agent 核心。它只处理对话语义、模型调用、记忆、多模态引用和可靠出站队列，不包含任何具体 IM SDK、登录协议或消息网关实现。

```text
IM SDK / Gateway
       ↕
ChannelAdapter + ChannelPlugin v1
       ↕
ChannelRuntime
       ↕
GroupAgentCore → Pi Agent → durable outbox
```

具体平台通过仓库外的适配包接入。适配器负责原生事件转换和消息发送；核心只接收标准事件、输出标准动作，并按适配器声明的能力做运行时校验。

## 特性

- 完整保存未触发机器人的群聊消息，后续回复仍能理解真实上下文。
- transcript、长期 memory、behavior 三层状态相互独立且可审计。
- 入站事件幂等、同会话串行、回复与 outbox 原子提交。
- 支持文本、图片、音频、语音、视频、文件、链接、引用和成员提及。
- 媒体只保存 `AssetRef`，二进制内容位于独立的 `AssetStore`。
- 适配器用版本化 feature 声明收发能力，用强类型 capability 暴露可选操作。
- capability 不会自动成为模型工具；只有显式配置的 `toolProviders` 能进入 Pi。
- 支持按需图片理解、附件检查、知识检索、MCP 工具和语音生成。
- 群聊触发支持点名、唤醒词、引用、自然续聊、always-on 和关闭模式。
- 模型可选择沉默，不会向群聊发送内部占位符。

## 环境

- Node.js `>= 22.13`
- 一个 Pi 支持的模型 API key

```bash
npm ci
npm run check
```

## 最小用法

```ts
import { getModel } from "@earendil-works/pi-ai";
import {
  CHANNEL_PLUGIN_API_VERSION,
  ChannelRuntime,
  GroupAgentCore,
  PiAgentRunner,
  defineChannelPlugin,
} from "pi-bot";

const core = new GroupAgentCore({
  bot: {
    id: "bot-1",
    displayName: "小派",
    wakeWords: ["派派", "小派"],
  },
  runner: new PiAgentRunner({
    model: getModel("anthropic", "claude-sonnet-4-6"),
    apiKey: () => process.env.ANTHROPIC_API_KEY,
    thinkingLevel: "low",
  }),
  databasePath: "./data/agent.sqlite",
  defaultGroupActivation: "mention",
  operatorIds: ["operator-1"],
});

const plugin = defineChannelPlugin({
  apiVersion: CHANNEL_PLUGIN_API_VERSION,
  id: "example-adapter-instance",

  async start(context) {
    sdk.onMessage(async (raw) => {
      await context.ingest({
        type: "message",
        id: raw.eventId,
        transportMessageId: raw.messageId,
        conversation: {
          id: raw.conversationId,
          kind: raw.isGroup ? "group" : "direct",
          title: raw.conversationTitle,
        },
        sender: {
          id: raw.senderId,
          displayName: raw.senderName,
        },
        text: raw.text,
        timestamp: raw.timestamp,
        mentions: raw.mentionedBot ? [{ id: "bot-1" }] : [],
      });
    });
  },

  async send(action) {
    await sdk.send({
      conversationId: action.conversationId,
      text: action.text,
      parts: action.parts,
      replyTo: action.replyToMessageId,
      idempotencyKey: action.id,
    });
  },

  async stop() {
    await sdk.close();
  },
});

const runtime = new ChannelRuntime({ core, plugin });
await runtime.start();
```

这里的 `sdk` 是任意 IM 客户端。切换平台时只替换插件，Core、数据库和模型配置保持不变。

## 标准化适配器

可发布的适配包应同时提供静态 manifest 和实例工厂：

```ts
import {
  CHANNEL_ADAPTER_API_VERSION,
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_SEND_IMAGE,
  CHANNEL_PLUGIN_API_VERSION,
  defineChannelAdapter,
  defineChannelPlugin,
} from "pi-bot";

export const adapter = defineChannelAdapter<{ client: ExampleClient }>({
  manifest: {
    apiVersion: CHANNEL_ADAPTER_API_VERSION,
    type: "example.im",
    displayName: "Example IM",
    description: "Example adapter package",
    features: [
      CHANNEL_FEATURE_RECEIVE_IMAGE,
      CHANNEL_FEATURE_SEND_IMAGE,
    ],
    capabilities: [],
  },

  create({ client }) {
    return defineChannelPlugin({
      apiVersion: CHANNEL_PLUGIN_API_VERSION,
      id: `example-${client.accountId}`,
      features: [
        CHANNEL_FEATURE_RECEIVE_IMAGE,
        CHANNEL_FEATURE_SEND_IMAGE,
      ],
      start(context) {
        client.onEvent((event) => context.ingest(normalizeEvent(event)));
      },
      send(action) {
        return client.send(normalizeAction(action));
      },
      stop() {
        return client.close();
      },
    });
  },
});
```

应用通过显式注册加载可信适配包：

```ts
import { ChannelAdapterRegistry } from "pi-bot";
import { adapter } from "@example/pi-bot-adapter";

const registry = new ChannelAdapterRegistry().register(adapter);
const plugin = await registry.create("example.im", { client });
```

注册表会验证：

- adapter API 版本和类型标识；
- manifest 中 feature/capability 的格式与重复声明；
- 插件实例是否只启用了 manifest 允许的能力；
- 插件实例的生命周期方法是否完整。

## 能力声明

文本、链接和引用属于基础协议。媒体或成员提及必须显式声明对应 feature，例如：

- `message.receive.image@1`
- `message.send.image@1`
- `message.send.voice@1`
- `message.send.file@1`
- `message.send.mention@1`

平台资源解析使用强类型 capability：

```ts
capabilities: [
  provideChannelCapability(MEDIA_RESOLVE_CAPABILITY, ({ asset }) => {
    return client.resolveAsset(asset.locator);
  }),
]
```

适配器未声明对应 feature 时，运行时会拒绝媒体事件或发送动作。发送失败不会确认 outbox，进程重启后仍可重试。

## 接入要求

- `event.id` 必须稳定且可用于入站去重。
- `conversation.id`、`sender.id` 是不透明标识，Core 不会按其格式猜测、截断或改写。
- 需要跨适配器共享状态时，各适配器必须为同一会话和成员输出相同的稳定 id。
- 多账号共用本地状态时必须为本地事件和身份加命名空间。
- `transportMessageId` 可选；多个适配器观察同一上游消息时，必须同时提供相同的会话 id 和该字段才能安全融合。
- `send()` 只有在平台明确接受动作后才能 resolve。
- 平台支持客户端幂等键时应直接使用 `action.id`。
- 原生媒体使用 `source: "platform"`，并把 `ownerPluginId` 设为插件实例 id。
- 凭据、cookie 和签名不得写入会持久化的 event metadata。
- 原生系统事件应由适配器转换为标准 metadata，或直接作为被忽略的上下文入库。

完整规范见 [docs/channel-plugins.md](docs/channel-plugins.md)，架构与可靠性约束见 [docs/architecture.md](docs/architecture.md)。

## 包入口

- `pi-bot`：Core、Runtime、标准类型和常用能力。
- `pi-bot/channel`：最小 ChannelPlugin/Runtime 契约。
- `pi-bot/adapter`：适配器 manifest 与注册表。
- `pi-bot/media`：AssetStore 和媒体解析类型。
- `pi-bot/plugins`：可选的通用群聊功能插件。

## 安全边界

- 适配器代码是可信部署代码，但不会因安装或 import 自动注册。
- capability 仅供应用调用，不自动暴露给模型。
- Agent 工具必须使用固定名称、JSON Schema、权限校验和审计记录。
- 核心不会抓取聊天链接，也不会自动下载每个附件。
- 原始媒体字节不会进入 SQLite 或主提示词。
- 仓库不内置任何具体平台的协议、凭据字段或登录流程。

## License

MIT
