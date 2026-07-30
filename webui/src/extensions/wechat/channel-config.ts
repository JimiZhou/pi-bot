import type { AdapterAdminExtension } from "@/console/adapter-admin-extension"
import type { BotChannelConfig, WechatIpadChannelConfig, WxHookChannelConfig } from "@/types/admin"
import { formBoolean, formNumber, formText, lines } from "@/lib/form-data"

export function defaultWxHookChannel(port: number): WxHookChannelConfig {
  return {
    type: "wx-hook-http",
    gatewayBaseUrl: "http://192.168.31.200:8080",
    apiTokenEnv: "WX_HOOK_API_TOKEN",
    gatewayTimeoutMs: 10000,
    webhookHost: "0.0.0.0",
    webhookPort: port,
    webhookPath: "/wechat/events",
    webhookSecretEnv: "WX_HOOK_WEBHOOK_SECRET",
    acceptUnknownGroupSenders: true,
    nativeQuoteReplies: true,
    ingestRetryMs: 2000,
  }
}

export function defaultWechatIpadChannel(port: number): WechatIpadChannelConfig {
  return {
    type: "wechat-ipad",
    apiBaseUrl: "http://wechat-ipad-874-api:8062/api",
    accountWxid: "",
    apiTimeoutMs: 35000,
    callbackHost: "0.0.0.0",
    callbackPort: port,
    callbackPathPrefix: "/api/v1/wechat-client",
    callbackAllowedSourceIps: ["172.23.0.0/16"],
    callbackMaxBodyBytes: 16777216,
    callbackRouterBaseUrl: "http://wechat-874-callback-router:9000",
    callbackAdvertiseHost: "pi-wechat-agent",
    autoRegisterCallback: true,
    registerIntervalMs: 60000,
    ingestRetryMs: 2000,
  }
}

function optional(value: string) {
  return value || undefined
}

export function readWxHookChannel(form: FormData): WxHookChannelConfig {
  return {
    type: "wx-hook-http",
    gatewayBaseUrl: formText(form, "gatewayBaseUrl"),
    apiTokenEnv: formText(form, "apiTokenEnv"),
    gatewayTimeoutMs: formNumber(form, "gatewayTimeoutMs"),
    webhookHost: formText(form, "webhookHost"),
    webhookPort: formNumber(form, "webhookPort"),
    webhookPath: formText(form, "webhookPath"),
    webhookSecretEnv: formText(form, "webhookSecretEnv"),
    accountId: optional(formText(form, "accountId")),
    acceptUnknownGroupSenders: formBoolean(form, "acceptUnknownGroupSenders"),
    nativeQuoteReplies: formBoolean(form, "nativeQuoteReplies"),
    ingestRetryMs: formNumber(form, "ingestRetryMs"),
  }
}

export function readWechatIpadChannel(form: FormData): WechatIpadChannelConfig {
  return {
    type: "wechat-ipad",
    apiBaseUrl: formText(form, "ipadApiBaseUrl"),
    accountWxid: formText(form, "ipadAccountWxid"),
    apiTokenEnv: optional(formText(form, "ipadApiTokenEnv")),
    apiTimeoutMs: formNumber(form, "ipadApiTimeoutMs"),
    callbackHost: formText(form, "ipadCallbackHost"),
    callbackPort: formNumber(form, "ipadCallbackPort"),
    callbackPathPrefix: formText(form, "ipadCallbackPathPrefix"),
    callbackAllowedSourceIps: lines(formText(form, "ipadCallbackAllowedSourceIps")),
    callbackMaxBodyBytes: formNumber(form, "ipadCallbackMaxBodyBytes"),
    callbackRouterBaseUrl: formText(form, "ipadCallbackRouterBaseUrl"),
    callbackAdvertiseHost: formText(form, "ipadCallbackAdvertiseHost"),
    autoRegisterCallback: formBoolean(form, "ipadAutoRegisterCallback"),
    registerIntervalMs: formNumber(form, "ipadRegisterIntervalMs"),
    accountId: optional(formText(form, "accountId")),
    ingestRetryMs: formNumber(form, "ingestRetryMs"),
  }
}

export function adapterPort(channel: BotChannelConfig): number {
  return channel.type === "wx-hook-http" ? channel.webhookPort : channel.callbackPort
}

export function extensionFor(
  extensions: AdapterAdminExtension[],
  type: string,
): AdapterAdminExtension | undefined {
  return extensions.find((extension) => extension.type === type)
}
