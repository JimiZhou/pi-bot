import type { AdapterAdminExtension } from "@/console/adapter-admin-extension"
import {
  defaultWechatIpadChannel,
  defaultWxHookChannel,
  readWechatIpadChannel,
  readWxHookChannel,
} from "@/extensions/wechat/channel-config"
import {
  WechatIpadConfigFields,
  WxHookConfigFields,
} from "@/extensions/wechat/channel-fields"

export const adapterAdminExtensions: AdapterAdminExtension[] = [
  {
    type: "wx-hook-http",
    label: "wx_hook_bridge",
    description: "通过 HTTP 网关与 Webhook 接入微信桌面协议。",
    ConfigFields: WxHookConfigFields,
    createDefault: defaultWxHookChannel,
    readConfig: readWxHookChannel,
  },
  {
    type: "wechat-ipad",
    label: "WeChat iPad",
    description: "通过标准 iPad API 和 Callback Router 接入微信。",
    ConfigFields: WechatIpadConfigFields,
    createDefault: defaultWechatIpadChannel,
    readConfig: readWechatIpadChannel,
  },
]
