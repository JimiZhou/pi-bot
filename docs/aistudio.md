# Model and media services

Pi Bot 支持通过 `@earendil-works/pi-ai` 使用多种模型 Provider。聊天、视觉理解、图像生成、语音生成和转写是相互独立的能力；应用可以为每项能力选择不同模型。

## Chat

`PiAgentRunner` 接收模型、API key 解析函数、思考级别、调用预算和可选 fallback runner。重试与 fallback 共用同一个绝对 deadline 和剩余调用预算。

## Vision

`PiImageUnderstandingProvider` 只在 Pi 调用 `understand_image` 时解析媒体。适配器必须声明 `media.resolve@1`，并且资源属于当前插件实例。

## Speech

语音生成通过受限工具把文字合成为本地资产，再由适配器依据 `message.send.voice@1` 转为平台支持的格式。Core 不假设具体编码或消息气泡协议。

## Transcription

`AudioTranscriptionProvider` 负责把受限音频字节转换成可信转写。转写结果进入标准 voice part；原始音频仍保留在 AssetStore 边界。

## 安全与成本

- 每轮共享 LLM 调用数、工具调用数和绝对超时。
- 图片候选数、解析字节数、视觉调用数和证据字符数均有上限。
- 媒体工具先落盘，再把 AssetRef 原子提交到 outbox。
- Provider 凭据不得写入模型输入、event metadata 或日志。
