import { useCallback, useState, type FormEvent } from "react"
import { QrCode, ShieldCheck, UserRoundCog, UsersRound } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  CheckboxField,
  ReloadButton,
  SelectField,
  TextareaField,
} from "@/components/admin-primitives"
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
import type { AdminClient } from "@/lib/admin-client"
import { formBoolean, formText, lines } from "@/lib/form-data"

export function GroupManagement({
  client,
  botId,
  chatroomId,
}: {
  client: AdminClient
  botId: string
  chatroomId: string
}) {
  const base = `/api/bots/${encodeURIComponent(botId)}/wechat/groups/${encodeURIComponent(chatroomId)}`
  const load = useCallback(() => client.request<Record<string, unknown>>(base), [base, client])
  const resource = useAdminResource(load)
  const [qrcode, setQrcode] = useState<unknown>(null)

  async function setting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const operation = formText(data, "operation")
    await resource.mutate(
      () => client.request(base, {
        method: "PATCH",
        body: operation === "saveToContacts"
          ? { operation, enabled: formBoolean(data, "enabled") }
          : { operation, value: formText(data, "value") },
      }),
      "微信群设置已更新",
    )
  }

  async function members(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await resource.mutate(
      () => client.request(`${base}/members`, {
        method: "POST",
        body: { action: formText(data, "action"), memberIds: lines(formText(data, "memberIds")) },
      }),
      "群成员操作已提交",
    )
  }

  async function admins(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await resource.mutate(
      () => client.request(`${base}/admin`, {
        method: "POST",
        body: { action: formText(data, "action"), memberIds: lines(formText(data, "memberIds")) },
      }),
      "群管理员操作已提交",
    )
  }

  async function loadQrCode() {
    const result = await resource.mutate(() => client.request<{ qrcode: unknown }>(`${base}/qrcode`), "群二维码已刷新")
    if (result) setQrcode(result.qrcode)
  }

  return (
    <div className="space-y-4">
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载微信群资料" /> : null}
      {resource.data ? (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="shadow-none">
              <form onSubmit={setting}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><UserRoundCog className="size-4" /> 群设置</CardTitle>
                  <CardDescription>备注、群名、公告或通讯录保存状态。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SelectField
                    label="操作"
                    name="operation"
                    defaultValue="remarks"
                    options={[
                      { value: "remarks", label: "修改备注" },
                      { value: "name", label: "修改群名" },
                      { value: "announcement", label: "修改公告" },
                      { value: "saveToContacts", label: "保存到通讯录" },
                    ]}
                  />
                  <TextareaField label="设置值" name="value" rows={3} />
                  <CheckboxField label="保存到通讯录" name="enabled" />
                </CardContent>
                <CardFooter className="justify-end"><Button type="submit">提交设置</Button></CardFooter>
              </form>
            </Card>
            <Card className="shadow-none">
              <form onSubmit={members}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" /> 群成员</CardTitle>
                  <CardDescription>添加、邀请或移除成员。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SelectField
                    label="操作"
                    name="action"
                    defaultValue="invite"
                    options={[
                      { value: "add", label: "直接添加" },
                      { value: "invite", label: "发送邀请" },
                      { value: "remove", label: "移除成员" },
                    ]}
                  />
                  <TextareaField label="成员 wxid" name="memberIds" rows={4} required />
                </CardContent>
                <CardFooter className="justify-end"><Button type="submit">执行成员操作</Button></CardFooter>
              </form>
            </Card>
            <Card className="shadow-none">
              <form onSubmit={admins}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> 群管理员</CardTitle>
                  <CardDescription>增加、移除管理员或转让群主。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SelectField
                    label="操作"
                    name="action"
                    defaultValue="add"
                    options={[
                      { value: "add", label: "增加管理员" },
                      { value: "remove", label: "移除管理员" },
                      { value: "transfer", label: "转让群主" },
                    ]}
                  />
                  <TextareaField label="成员 wxid" name="memberIds" rows={4} required />
                </CardContent>
                <CardFooter className="justify-end"><Button type="submit">执行管理员操作</Button></CardFooter>
              </form>
            </Card>
          </div>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>协议数据</CardTitle>
              <CardDescription>微信群详情、成员和当前协议能力。</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">
                {JSON.stringify(qrcode ?? resource.data, null, 2)}
              </pre>
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />
              <Button onClick={() => void loadQrCode()}><QrCode data-icon="inline-start" /> 获取群二维码</Button>
            </CardFooter>
          </Card>
        </>
      ) : null}
    </div>
  )
}
