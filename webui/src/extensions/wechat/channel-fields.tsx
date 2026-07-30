import { CheckboxField, FormField, TextareaField } from "@/components/admin-primitives"
import type { AdapterConfigFieldsProps } from "@/console/adapter-admin-extension"
import { defaultWechatIpadChannel, defaultWxHookChannel } from "@/extensions/wechat/channel-config"

export function WxHookConfigFields({ channel }: AdapterConfigFieldsProps) {
  const value = channel?.type === "wx-hook-http" ? channel : defaultWxHookChannel(9010)
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FormField label="网关 Base URL" name="gatewayBaseUrl" type="url" defaultValue={value.gatewayBaseUrl} required />
      </div>
      <FormField label="API Token 环境变量" name="apiTokenEnv" defaultValue={value.apiTokenEnv} required />
      <FormField label="网关超时（ms）" name="gatewayTimeoutMs" type="number" min={1000} defaultValue={value.gatewayTimeoutMs} required />
      <FormField label="Webhook 监听地址" name="webhookHost" defaultValue={value.webhookHost} required />
      <FormField label="Webhook 端口" name="webhookPort" type="number" min={1} max={65535} defaultValue={value.webhookPort} required />
      <FormField label="Webhook 路径" name="webhookPath" defaultValue={value.webhookPath} required />
      <FormField label="Webhook Secret 环境变量" name="webhookSecretEnv" defaultValue={value.webhookSecretEnv} required />
      <CheckboxField label="接受未知群成员消息" name="acceptUnknownGroupSenders" defaultChecked={value.acceptUnknownGroupSenders} />
      <CheckboxField label="使用微信原生引用回复" name="nativeQuoteReplies" defaultChecked={value.nativeQuoteReplies} />
    </div>
  )
}

export function WechatIpadConfigFields({ channel }: AdapterConfigFieldsProps) {
  const value = channel?.type === "wechat-ipad" ? channel : defaultWechatIpadChannel(9010)
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FormField label="iPad API Base URL" name="ipadApiBaseUrl" type="url" defaultValue={value.apiBaseUrl} required />
      </div>
      <FormField label="账号 wxid" name="ipadAccountWxid" defaultValue={value.accountWxid} required />
      <FormField label="API Token 环境变量" name="ipadApiTokenEnv" defaultValue={value.apiTokenEnv} />
      <FormField label="API 超时（ms）" name="ipadApiTimeoutMs" type="number" min={1000} defaultValue={value.apiTimeoutMs} required />
      <FormField label="Callback 监听地址" name="ipadCallbackHost" defaultValue={value.callbackHost} required />
      <FormField label="Callback 端口" name="ipadCallbackPort" type="number" min={1} max={65535} defaultValue={value.callbackPort} required />
      <FormField label="Callback 路径前缀" name="ipadCallbackPathPrefix" defaultValue={value.callbackPathPrefix} required />
      <div className="sm:col-span-2">
        <TextareaField
          label="允许的 Callback 来源 IP"
          name="ipadCallbackAllowedSourceIps"
          rows={3}
          defaultValue={value.callbackAllowedSourceIps.join("\n")}
          required
        />
      </div>
      <FormField label="Callback 最大请求体（bytes）" name="ipadCallbackMaxBodyBytes" type="number" min={1024} defaultValue={value.callbackMaxBodyBytes} required />
      <FormField label="自动注册间隔（ms）" name="ipadRegisterIntervalMs" type="number" min={1000} defaultValue={value.registerIntervalMs} required />
      <div className="sm:col-span-2">
        <FormField label="Callback Router Base URL" name="ipadCallbackRouterBaseUrl" type="url" defaultValue={value.callbackRouterBaseUrl} required />
      </div>
      <FormField label="Callback 对外主机名" name="ipadCallbackAdvertiseHost" defaultValue={value.callbackAdvertiseHost} required />
      <CheckboxField label="自动注册 Callback" name="ipadAutoRegisterCallback" defaultChecked={value.autoRegisterCallback} />
    </div>
  )
}
