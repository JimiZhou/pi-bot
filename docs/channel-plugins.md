# Channel Plugin v1

## 边界

`ChannelPlugin` 是 Pi Bot 与任意 IM 传输之间的唯一运行时边界：

```text
native event ⇄ ChannelPlugin v1 ⇄ ChannelRuntime ⇄ GroupAgentCore
```

Core 不负责登录、重连、回调认证、媒体下载或平台风控；插件不负责记忆、触发判断、模型调用和 durable outbox。

## 生命周期契约

```ts
interface ChannelPlugin {
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName?: string;
  readonly features?: readonly ChannelFeature[];
  readonly capabilities?: readonly ChannelCapabilityBinding[];
  start(context: ChannelPluginContext): void | Promise<void>;
  send(action: OutboundMessageAction): Promise<void>;
  stop(): void | Promise<void>;
}
```

`context.ingest(event)` 负责持久化标准事件、运行 Core 并投递新动作。`context.flushOutbox()` 用于连接恢复后重试尚未确认的动作。

`send()` 失败时必须 reject。Runtime 只会在 resolve 后确认 outbox。

## 入站标准化

- `id`：本地稳定事件 id，同一上游重投必须相同。
- `transportMessageId`：可选的上游稳定消息 id，用于跨适配器显式融合。
- `conversation`：不透明的稳定会话 id、`direct | group` 类型和可选标题。
- `sender`：不透明的稳定成员 id、显示名称和可选 Bot 标记。
- `text`：用于检索和兼容的纯文字投影。
- `parts`：标准富媒体内容。
- `mentions`、`replyTo`：结构化点名和引用信息。
- `metadata`：少量无凭据的标准化扩展数据。

平台媒体必须设置 `ownerPluginId`。Runtime 会阻止一个插件解析另一个插件拥有的资源。

Core 不解析或改写任何 id。需要跨适配器共享状态时，适配器必须为同一会话和成员输出相同 id，并为同一条消息提供相同的 `transportMessageId`；缺少显式稳定标识时不会用时间和文本近似去重。

## 出站标准化

`OutboundMessageAction` 包含会话 id、文本投影、消息 parts、引用 id、创建时间和 durable action id。

适配器应：

1. 按 parts 顺序转换原生消息；
2. 使用 `action.id` 作为客户端幂等键；
3. 仅在平台接受全部必要内容后 resolve；
4. 对不支持的原生形态抛出明确错误；
5. 不在插件内部绕过 outbox 发送 Agent 最终回复。

## Feature

Feature 是版本化的常见收发能力。`options` 可声明 MIME 类型、大小或格式限制。

```ts
features: [
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  {
    ...CHANNEL_FEATURE_SEND_IMAGE,
    options: {
      maxBytes: 20_000_000,
      mimeTypes: ["image/jpeg", "image/png"],
    },
  },
]
```

Runtime 会在入站和出站两侧强制执行声明。未声明的媒体不会静默降级。

## Capability

Capability 是带请求/结果类型的可选应用操作：

```ts
const RecallMessage = defineChannelCapability<
  { conversationId: string; messageId: string },
  { recalled: boolean }
>("example.message.recall", 1);

capabilities: [
  provideChannelCapability(RecallMessage, (request) => client.recall(request)),
]
```

Capability 不是模型工具。应用必须另行构造权限受限的 `AgentToolProvider`，才能把某个安全子集交给 Pi。

## Adapter manifest

独立适配包应导出 `ChannelAdapterDefinition`。Manifest 描述适配器可能启用的最大能力集合，具体实例可以按账号配置启用其中的子集。

应用显式调用 `ChannelAdapterRegistry.register()`。注册表不会扫描磁盘、自动 import 包或执行未授权代码。

## Callback 安全

若插件拥有 HTTP 回调服务，应至少实现：

- 请求体大小限制；
- 签名和时间窗校验；
- delivery id 去重；
- 确认前持久化，或明确记录可接受的崩溃窗口；
- 有界重试与失败隔离；
- 日志脱敏；
- 监听地址和来源限制。

## 可靠性

Pi Bot 提供本地 at-least-once 基础。最终发送与本地确认之间仍存在不可消除的崩溃窗口；平台侧幂等键是消除重复消息的正确位置。

一个 `ChannelRuntime` 绑定一个 Core 和一个插件实例。多个账号应使用独立 Runtime；若共享数据库，必须增加持久化路由字段，禁止根据 id 格式猜测出站目标。
