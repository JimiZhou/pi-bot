import type { BotPluginConfig } from "../config.js";

export interface BuiltInPluginDefinition {
  type: string;
  label: string;
  description: string;
  defaultConfig: BotPluginConfig;
}

export const BUILT_IN_PLUGIN_DEFINITIONS: readonly BuiltInPluginDefinition[] = Object.freeze([
  {
    type: "morning-brief",
    label: "晨报",
    description: "按 Bot 的本地时间向前一天活跃过的群发送简短早安问候。",
    defaultConfig: { id: "morning-brief", type: "morning-brief", enabled: false, settings: {} },
  },
  {
    type: "pat-reply",
    label: "拍一拍",
    description: "机器人被拍一拍时直接回复自定义内容，不调用模型。",
    defaultConfig: { id: "pat-reply", type: "pat-reply", enabled: false, settings: {} },
  },
  {
    type: "group-summary",
    label: "群聊总结",
    description: "响应群友的总结请求，并可定时总结当天群聊。",
    defaultConfig: { id: "group-summary", type: "group-summary", enabled: false, settings: {} },
  },
  {
    type: "scheduled-task",
    label: "定时任务",
    description: "群友通过自然语言补全并创建定时任务，执行前进行模型风险判断。",
    defaultConfig: { id: "scheduled-task", type: "scheduled-task", enabled: false, settings: {} },
  },
  {
    type: "auto-participation",
    label: "自动接话",
    description: "控制环境提问、热聊插话、话题延续和学习得到的主动发言；遇到群友语音时可跟随语音回复，时效话题会结合近期上下文自动联网查证。",
    defaultConfig: { id: "auto-participation", type: "auto-participation", enabled: false, settings: {} },
  },
  {
    type: "cold-chat-warmup",
    label: "冷群暖场",
    description: "控制群聊长时间沉寂后的主动暖场，与自动接话独立开关。",
    defaultConfig: { id: "cold-chat-warmup", type: "cold-chat-warmup", enabled: false, settings: {} },
  },
  {
    type: "red-envelope-notify",
    label: "红包提醒",
    description: "识别群红包或礼物事件并 @ 指定成员；只提醒，不执行领取动作。",
    defaultConfig: { id: "red-envelope-notify", type: "red-envelope-notify", enabled: false, settings: {} },
  },
  {
    type: "group-event-notify",
    label: "入退群通知",
    description: "通过标准化系统事件欢迎新成员并通知成员退群；确定性处理，不调用模型。",
    defaultConfig: { id: "group-event-notify", type: "group-event-notify", enabled: true, settings: {} },
  },
  {
    type: "repeater",
    label: "复读机",
    description: "连续两位不同群友发送相同短文字或表情包后参与复读。",
    defaultConfig: {
      id: "repeater",
      type: "repeater",
      enabled: false,
      settings: {
        cooldownMinutes: 8,
      },
    },
  },
  {
    type: "magnet-code-search",
    label: "编号磁力搜索",
    description: "群友发送纯英文-数字编号时查询 cilisousuo.cc，并返回精确匹配的磁力链接。",
    defaultConfig: {
      id: "magnet-code-search",
      type: "magnet-code-search",
      enabled: false,
      settings: {
        timeoutSeconds: 8,
        maxResults: 1,
      },
    },
  },
  {
    type: "meme-generator",
    label: "表情包生成",
    description: "通过 meme-generator 服务响应 meme 指令，生成并发送 GIF 或其他图片格式的表情包。",
    defaultConfig: {
      id: "meme-generator",
      type: "meme-generator",
      enabled: true,
      settings: {
        timeoutSeconds: 60,
        maxResponseMb: 64,
        maxInputMb: 20,
        maxSendMb: 8,
        maxImages: 6,
      },
    },
  },
]);

export function builtInPluginDefinition(type: string): BuiltInPluginDefinition | undefined {
  return BUILT_IN_PLUGIN_DEFINITIONS.find((item) => item.type === type);
}

export function withImplicitBuiltInPlugins(plugins: readonly BotPluginConfig[]): BotPluginConfig[] {
  const result = plugins.map((plugin) => ({ ...plugin, settings: { ...plugin.settings } }));
  for (const definition of BUILT_IN_PLUGIN_DEFINITIONS) {
    if (result.some((plugin) => plugin.type === definition.type)) continue;
    result.push({
      ...definition.defaultConfig,
      settings: { ...definition.defaultConfig.settings },
    });
  }
  return result;
}
