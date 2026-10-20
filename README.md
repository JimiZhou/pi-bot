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
npm start
```

首次启动会在 `data/admin-token.txt` 生成 WebUI 管理令牌，打开
`http://127.0.0.1:8787/` 后输入令牌即可。也可以通过 `PI_ADMIN_TOKEN` 固定令牌。

### v0.3 开箱配置

仓库现在包含可直接运行的 Core、ChannelRuntime、Admin API 和 React WebUI，但不捆绑任何聊天平台客户端。没有外部 Adapter 时，Bot 可以创建和配置，但启用后会提示通道未注册；这是有意保留的接入边界。

通过 `PI_CHANNEL_ADAPTER_MODULE` 加载你自己的 ES Module：

```bash
PI_CHANNEL_ADAPTER_MODULE=./adapters/example-adapter.mjs npm start
```

模块需要导出 `adapter`（或 `adapters` 数组），每个 Adapter 提供 `manifest.type` 和 `create(context)`。`create()` 返回的插件负责：

- 登录、扫码、cookie、签名和平台 SDK 生命周期；
- 把平台事件转换成 `ChannelPlugin` 的标准入站事件；
- 把 Core 的文本、媒体、引用、提及和语音动作转换成平台发送 API；
- 媒体下载/上传、资产解析、健康检查、回调注册和平台特有管理能力。

wxhook、iPad 协议客户端、账号登录服务、平台凭据和平台特有群管理都需要用户在仓库外自行实现；本仓库不会读取或保存这些协议字段。

Docker 用户可以直接运行 `docker compose up --build`。Compose 会把本地 `./adapters` 只读挂载到容器的 `/app/adapters`；如果设置 `PI_CHANNEL_ADAPTER_MODULE=./adapters/your-adapter.mjs`，即可在容器启动时加载它。

### v0.3 能力

- 多模型 Provider、主模型/备用模型链、视觉理解、语音转写与 TTS。
- 对话历史、长期记忆、行为学习、群聊参与判断、主动参与和定时任务。
- 插件目录、MCP、知识检索、表情库、自定义 meme 和 meme-generator 集成。
- 入站幂等、同会话串行、可靠 outbox、媒体资产隔离、审计日志和 Admin WebUI。

## 表情包插件

仓库内置了 `meme-generator` 插件，所有没有显式配置的 Bot 默认启用；仍可在插件管理页或群聊设置中关闭。启用后可发送 `meme 中文名称 [文字1 | 文字2]`；只发送 `meme 摸摸` 会先返回动态示例，回复或附上一张图片后再次发送即可生成你的版本，也支持英文 key（`meme petpet`）和 `@Bot meme 摸摸`。插件会按上游模板详情预先校验图片、文字数量，不符合要求时不会请求上游。发送 `meme 菜单` 查看按输入类型整理的中文名称，`meme 详情 中文名称` 查看所需图片和文字数量；菜单支持分页。

Docker Compose 已包含上游 `meetwq/meme-generator` 服务，插件默认通过 `http://meme-generator:2233` 调用；发送前默认将结果压缩到 8 MB 以内，超大 GIF 会降低帧率、尺寸和色彩数，最终由外部 Adapter 负责转换成目标平台支持的消息格式。WebUI 的“表情包”模块中可以刷新模板列表、查看图片/文字参数、生成预览、保存到选定 Bot 的表情库，或发送到选定群聊；WebUI 发送同样会先压缩。可在插件设置 JSON 中用 `maxSendMb` 调整命令发送上限，也可以填写 `apiBaseUrl` 或用 `PI_MEME_API_BASE_URL` 覆盖地址。上游项目的 API 约定见 [meme-generator Wiki](https://github.com/MemeCrafters/meme-generator/wiki/%E9%80%9A%E8%BF%87-api-%E6%96%B9%E5%BC%8F%E8%B0%83%E7%94%A8)。

在 WebUI 的表情包模块可以直接上传 JPEG、PNG、GIF 或 WebP 图片，填写 key、标题和关键词；上传后会立即出现在模板列表，无需进入容器或重启服务。这类自定义图片 meme 直接使用原图，不需要额外文字或输入图片。需要上游 Python 模板能力时，仍可把模板放在 `data/meme-generator/memes/<your-key>/`，按上游格式提供 `__init__.py` 和素材文件并重启 `meme-generator` 服务；编写格式参考 [新表情编写指北](https://github.com/MemeCrafters/meme-generator/wiki/%E6%96%B0%E8%A1%A8%E6%83%85%E7BC%96%E5%86%99%E6%8C%87%E5%8C%97)。

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
