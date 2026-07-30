import { useCallback, useMemo, useRef, useState, type FormEvent } from "react"
import { ContactRound, Search, Tags } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  ConfirmButton,
  FormField,
  ReloadButton,
  TextareaField,
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
import { formText, lines } from "@/lib/form-data"

export default function ContactsConsole() {
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
    const [contacts, labels] = await Promise.all([
      client.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/wechat/contacts`),
      client.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/wechat/labels`),
    ])
    return { contacts: contacts.contacts, labels: labels.labels }
  }, [botId, client])
  const resource = useAdminResource(load)
  const [result, setResult] = useState<unknown>(null)
  const labelFormRef = useRef<HTMLFormElement>(null)

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const response = await resource.mutate(
      () => client.request<Record<string, unknown>>(`/api/bots/${encodeURIComponent(botId)}/wechat/contacts/search`, {
        method: "POST",
        body: { query: formText(data, "query") },
      }),
      "联系人搜索完成",
    )
    if (response) setResult(response.contact)
  }

  async function saveRemark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const response = await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/contacts/remark`, {
        method: "POST",
        body: { contactId: formText(data, "contactId"), remarks: formText(data, "remarks") },
      }),
      "联系人备注已保存",
    )
    if (response) setResult(response)
  }

  async function labelAction(form: HTMLFormElement, action: "add" | "rename" | "members") {
    const data = new FormData(form)
    const labelId = formText(data, "labelId")
    const response = await resource.mutate(
      () => {
        if (action === "add") {
          return client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/labels`, {
            method: "POST",
            body: { name: formText(data, "name") },
          })
        }
        return client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/labels/${encodeURIComponent(labelId)}`, {
          method: "PATCH",
          body: action === "rename"
            ? { name: formText(data, "name") }
            : { contactIds: lines(formText(data, "contactIds")) },
        })
      },
      action === "add" ? "标签已新增" : action === "rename" ? "标签已改名" : "标签成员已更新",
    )
    if (response) setResult(response)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="微信扩展"
        title="联系人与标签"
        description="查看、搜索、修改备注和维护标签；不提供通讯录上传或批量加删好友。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error || bootstrapResource.error} notice={resource.notice} />
      {ipadBots.length === 0 && !bootstrapResource.loading ? (
        <EmptyState title="没有 iPad Bot" description="联系人管理仅适用于 wechat-ipad Adapter。" />
      ) : null}
      {ipadBots.length > 0 ? (
        <Card className="shadow-none">
          <CardContent className="flex items-center gap-3">
            <ContactRound className="size-4 text-muted-foreground" />
            <select value={botId} onChange={(event) => setSelectedId(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
              {ipadBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}
            </select>
          </CardContent>
        </Card>
      ) : null}
      {resource.loading || bootstrapResource.loading ? <AdminLoading label="正在加载联系人" /> : null}
      {resource.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="shadow-none">
            <form onSubmit={search}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Search className="size-4" /> 搜索联系人</CardTitle>
                <CardDescription>使用微信号、手机号或 QQ 查询。</CardDescription>
              </CardHeader>
              <CardContent><FormField label="查询内容" name="query" required /></CardContent>
              <CardFooter className="justify-end"><Button type="submit">搜索</Button></CardFooter>
            </form>
            <form onSubmit={saveRemark}>
              <CardContent className="grid gap-4 border-t sm:grid-cols-2">
                <FormField label="联系人 wxid" name="contactId" required />
                <FormField label="新备注" name="remarks" />
              </CardContent>
              <CardFooter className="justify-end"><Button type="submit" variant="outline">保存备注</Button></CardFooter>
            </form>
          </Card>
          <Card className="shadow-none">
            <form ref={labelFormRef} onSubmit={(event) => { event.preventDefault(); void labelAction(event.currentTarget, "add") }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Tags className="size-4" /> 标签维护</CardTitle>
                <CardDescription>新增、改名、更新成员或删除联系人标签。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <FormField label="标签 ID" name="labelId" />
                <FormField label="标签名称" name="name" />
                <div className="sm:col-span-2"><TextareaField label="成员 wxid" name="contactIds" rows={3} /></div>
              </CardContent>
              <CardFooter className="flex-wrap justify-end gap-2">
                <Button type="submit" variant="outline">新增</Button>
                <Button type="button" variant="outline" onClick={(event) => {
                  const form = event.currentTarget.form
                  if (form) void labelAction(form, "rename")
                }}>改名</Button>
                <Button type="button" variant="outline" onClick={(event) => {
                  const form = event.currentTarget.form
                  if (form) void labelAction(form, "members")
                }}>更新成员</Button>
                <ConfirmButton
                  title="删除这个标签？"
                  description="只删除标签，不删除联系人。"
                  onConfirm={() => {
                    const form = labelFormRef.current
                    const labelId = form ? formText(new FormData(form), "labelId") : ""
                    if (!labelId) return
                    void resource.mutate(
                      () => client.request(`/api/bots/${encodeURIComponent(botId)}/wechat/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" }),
                      "标签已删除",
                    )
                  }}
                />
              </CardFooter>
            </form>
          </Card>
          <Card className="shadow-none xl:col-span-2">
            <CardHeader><CardTitle>协议数据</CardTitle></CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">{JSON.stringify(resource.data.contacts, null, 2)}</pre>
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/20 p-3 text-xs">{JSON.stringify(result ?? resource.data.labels, null, 2)}</pre>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
