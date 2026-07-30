import {
  CHANNEL_ADAPTER_API_VERSION,
  ChannelAdapterRegistry,
  defineChannelAdapter,
} from "../channel-adapter.js";
import {
  CHANNEL_FEATURE_RECEIVE_FILE,
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_RECEIVE_VIDEO,
  CHANNEL_FEATURE_RECEIVE_VOICE,
  CHANNEL_FEATURE_SEND_AUDIO,
  CHANNEL_FEATURE_SEND_FILE,
  CHANNEL_FEATURE_SEND_IMAGE,
  CHANNEL_FEATURE_SEND_MENTION,
  CHANNEL_FEATURE_SEND_VIDEO,
  CHANNEL_FEATURE_SEND_VOICE,
  MEDIA_RESOLVE_CAPABILITY,
} from "../channel-capabilities.js";
import {
  createWechatIpadChannel,
  type WechatIpadChannelOptions,
} from "./wechat-ipad.js";
import {
  createWxHookHttpChannel,
  type WxHookHttpChannelOptions,
} from "./wx-hook-http.js";

const WECHAT_RECEIVE_FEATURES = [
  CHANNEL_FEATURE_RECEIVE_IMAGE,
  CHANNEL_FEATURE_RECEIVE_VOICE,
  CHANNEL_FEATURE_RECEIVE_VIDEO,
  CHANNEL_FEATURE_RECEIVE_FILE,
] as const;

export const wechatIpadAdapter = defineChannelAdapter<WechatIpadChannelOptions>({
  manifest: {
    apiVersion: CHANNEL_ADAPTER_API_VERSION,
    type: "wechat-ipad",
    displayName: "WeChat iPad",
    description: "Raw WeChat iPad protocol callback and media adapter.",
    features: [
      ...WECHAT_RECEIVE_FEATURES,
      CHANNEL_FEATURE_SEND_MENTION,
      CHANNEL_FEATURE_SEND_IMAGE,
      CHANNEL_FEATURE_SEND_AUDIO,
      CHANNEL_FEATURE_SEND_VOICE,
      CHANNEL_FEATURE_SEND_VIDEO,
      CHANNEL_FEATURE_SEND_FILE,
    ],
    capabilities: [MEDIA_RESOLVE_CAPABILITY],
  },
  create: createWechatIpadChannel,
});

export const wxHookHttpAdapter = defineChannelAdapter<WxHookHttpChannelOptions>({
  manifest: {
    apiVersion: CHANNEL_ADAPTER_API_VERSION,
    type: "wx-hook-http",
    displayName: "wx_hook_bridge HTTP",
    description: "Signed webhook and HTTP gateway adapter for wx_hook_bridge.",
    features: [
      ...WECHAT_RECEIVE_FEATURES,
      CHANNEL_FEATURE_SEND_MENTION,
      CHANNEL_FEATURE_SEND_IMAGE,
    ],
    capabilities: [MEDIA_RESOLVE_CAPABILITY],
  },
  create: createWxHookHttpChannel,
});

export function createWechatAdapterRegistry(): ChannelAdapterRegistry {
  return new ChannelAdapterRegistry()
    .register(wechatIpadAdapter)
    .register(wxHookHttpAdapter);
}
