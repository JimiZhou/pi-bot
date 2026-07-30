import { useCallback, useMemo, useState, type ChangeEvent, type FormEvent } from "react"
import { AtSign, ImageUp, QrCode, Save } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  FormField,
  ReloadButton,
  SelectField,
} from "@/components/admin-primitives"
import { EmptyState, PageHeader } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formText } from "@/lib/form-data"

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("头像读取失败"))
    reader.readAsDataURL(file)
  })
}

export default function IdentityConsole() {
  const { client } = useAdmin()
  const bootstrapLoad = useCallback(() => client.bootstrap(), [client])
  const bootstrapResource = useAdminResource(bootstrapLoad)
  const ipadBots = useMemo(
    () => (bootstrapResource.data?.bots ?? []).filter((bot) => bot.channel.type === "wechat-ipad"),
    [bootstrapResource.data?.bots],
  )
  const [selectedId, setSelectedId] = useState("")
  const botId = selectedId || ipadBots[0]?.id || ""
  const load = useCallback(async () => {
    if (!botId) return null
    const [profile, capabilities] = await Promise.all([
      client.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/wechat/profile`),
      client.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/wechat/capabilities`),
    ])
    return { profile: profile.profile as Record<string, unknown>, capabilities: capabilities.capabilities }
  }, [botId, client])
  const resource = useAdminResource(load)
  const [avatarDataUrl, setAvatarDataUrl] = useState("")
  const [qrcode, setQrcode] = useState<unknown>(null)
  const profile = resource.data?.profile ?? {}

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const sex = formText(data, "sex")
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/profile`, {
        method: "PATCH",
        body: {
          nickname: formText(data, "nickname"),
          signature: formText(data, "signature"),
          ...(sex ? { sex: Number(sex) } : {}),
          city: formText(data, "city"),
          province: formText(data, "province"),
          country: formText(data, "country"),
        },
      }),
      "微信账号资料已保存",
    )
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return
    setAvatarDataUrl(await fileDataUrl(file))
  }

  async function uploadAvatar() {
    if (!avatarDataUrl) return
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/avatar`, {
        method: "POST",
        body: { avatarDataUrl },
      }),
      "微信头像已上传",
    )
  }

  async function loadQrCode() {
    const result = await resource.mutate(
      () => client.request<{ qrcode: unknown }>(`/api/bots/${encodeURIComponent(botId)}/wechat/qrcode`),
      "二维码已刷新",
    )
    if (result) setQrcode(result.qrcode)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="微信扩展"
        title="微信身份"
        description="管理 iPad 协议账号的昵称、签名、地区、头像和账号二维码。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error || bootstrapResource.error} notice={resource.notice} />
      {ipadBots.length === 0 && !bootstrapResource.loading ? (
        <EmptyState title="没有 iPad Bot" description="此功能仅适用于 wechat-ipad Adapter。" />
      ) : null}
      {ipadBots.length > 0 ? (
        <Card className="shadow-none">
          <CardContent className="flex flex-wrap items-center gap-3">
            <AtSign className="size-4 text-muted-foreground" />
            <select value={botId} onChange={(event) => setSelectedId(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
              {ipadBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">账号资料会影响该微信账号所在的全部群聊。</span>
          </CardContent>
        </Card>
      ) : null}
      {resource.loading || bootstrapResource.loading ? <AdminLoading label="正在加载微信身份" /> : null}
      {resource.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="shadow-none">
            <form onSubmit={saveProfile}>
              <CardHeader>
                <CardTitle>账号资料</CardTitle>
                <CardDescription>只提交需要保持的资料；保存后会直接调用微信协议。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <FormField label="微信昵称" name="nickname" defaultValue={String(profile.nickname ?? "")} />
                <FormField label="个性签名" name="signature" defaultValue={String(profile.signature ?? "")} />
                <SelectField
                  label="性别"
                  name="sex"
                  defaultValue={profile.sex === undefined ? "" : String(profile.sex)}
                  options={[
                    { value: "", label: "保持不变" },
                    { value: "0", label: "未设置" },
                    { value: "1", label: "男" },
                    { value: "2", label: "女" },
                  ]}
                />
                <FormField label="城市" name="city" defaultValue={String(profile.city ?? "")} />
                <FormField label="省份" name="province" defaultValue={String(profile.province ?? "")} />
                <FormField label="国家" name="country" defaultValue={String(profile.country ?? "")} />
              </CardContent>
              <CardFooter className="justify-end">
                <Button type="submit"><Save data-icon="inline-start" /> 保存账号资料</Button>
              </CardFooter>
            </form>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>头像与二维码</CardTitle>
              <CardDescription>支持 JPEG、PNG 和 WebP，最大 5 MiB。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseAvatar(event)} />
              {avatarDataUrl ? <img src={avatarDataUrl} alt="待上传头像" className="size-24 rounded-xl border object-cover" /> : null}
              {qrcode ? (
                <pre className="max-h-48 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">{JSON.stringify(qrcode, null, 2)}</pre>
              ) : null}
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Button variant="outline" onClick={() => void loadQrCode()}><QrCode data-icon="inline-start" /> 获取二维码</Button>
              <Button onClick={() => void uploadAvatar()} disabled={!avatarDataUrl}><ImageUp data-icon="inline-start" /> 上传头像</Button>
            </CardFooter>
          </Card>
          <Card className="shadow-none xl:col-span-2">
            <CardHeader><CardTitle>协议返回</CardTitle></CardHeader>
            <CardContent>
              <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">
                {JSON.stringify(resource.data, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
