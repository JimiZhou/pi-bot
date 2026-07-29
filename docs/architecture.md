# Architecture

## 核心原则

Pi Bot 的核心拥有对话语义，不拥有传输生命周期。

```text
ChannelAdapter manifest
        ↓ create
ChannelPlugin ⇄ ChannelRuntime ⇄ GroupAgentCore ⇄ SqliteStore
                                      ↓
                                  Pi Agent
```

### ChannelAdapter

描述一个可替换 IM 适配器的类型、版本和最大能力集合，并创建具体插件实例。应用只加载明确注册的可信适配包。

### ChannelPlugin

负责连接原生 SDK、把事件映射成 `InboundMessageEvent`，并把 `OutboundMessageAction` 映射为平台发送调用。

### ChannelRuntime

拥有固定循环：

```text
ingest → core.receive → durable action → plugin.send → acknowledge
```

它还负责 feature 校验、capability 路由、并发发送合并、启动恢复和短消息片段合并。

### GroupAgentCore

负责入站幂等、触发策略、上下文/记忆检索、工具边界、Pi 调用、回复清洗和 outbox 原子提交。

## 可靠性不变量

1. 入站消息在触发判断和模型 I/O 前持久化。
2. 已完成的事件 id 不会触发第二次模型运行。
3. assistant transcript 与 outbox 在同一事务提交。
4. 动作在调用方确认前始终保持 pending。
5. 同一会话的本地 Agent 运行严格串行。
6. 插件未声明的媒体能力在边界处失败。
7. 平台资源只能由其 `ownerPluginId` 对应插件解析。
8. 原始媒体字节不写入 SQLite 和主提示词。
9. capability 不自动变成 Agent 工具。
10. 可观测性失败不能破坏消息热路径。

## 状态范围

- Channel SDK 状态：插件实例生命周期。
- 入站事件和 outbox：一个 Bot 数据库。
- 会话队列：进程内 `KeyedQueue`。
- Pi transcript：一次模型请求重建。
- 长期 memory：SQLite 中按人、会话或全局隔离。
- 媒体字节：独立 `AssetStore`。

## 扩展点

- `AgentRunner`：替换模型执行或增加受控降级链。
- `TriggerPolicy`：替换群聊参与策略。
- `KnowledgeRetriever`：接入搜索、本地文档或 RAG。
- `ImageUnderstandingProvider`：接入视觉模型。
- `AgentToolProvider`：增加经过审查的应用工具。
- `AgentPlugin`：增加定时或确定性群聊功能。
- `ChannelAdapterDefinition`：接入新的 IM 平台。
- `ChannelCapabilityToken`：增加版本化可选操作。

## 信任边界

适配器是部署者主动安装的可信代码，但模型无法直接调用适配器原生 API。事件 metadata、外部检索结果、附件正文和 MCP 返回值都视为不可信数据，不能提升为系统指令。
