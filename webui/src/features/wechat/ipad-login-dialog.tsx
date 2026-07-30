import { useCallback, useEffect, useState, type FormEvent } from "react"
import { LogIn, QrCode, RefreshCw, ShieldCheck, XCircle } from "lucide-react"

import { AdminFeedback, AdminLoading, FormField, SelectField } from "@/components/admin-primitives"
import { StatusPill } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import { formText } from "@/lib/form-data"
import type { BotConfig } from "@/types/admin"

type LoginPhase =
  | "offline"
  | "qr"
  | "scanned"
  | "verification"
  | "waiting-confirmation"
  | "online"
  | "expired"
  | "error"

interface LoginStatus {
  phase: LoginPhase
  accountWxid?: string
  nickname?: string
  headImageUrl?: string
  qrImage?: string
  qrContent?: string
  expiresInSeconds?: number
  loginType?: string
  sliderAvailable: boolean
  message: string
}

const activePhases = new Set<LoginPhase>(["qr", "scanned", "verification", "waiting-confirmation"])

export function IpadLoginDialog({ bot, onClose }: { bot: BotConfig; onClose: () => void }) {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(async () => (
    await client.request<{ login: LoginStatus }>(`/api/bots/${encodeURIComponent(bot.id)}/login`)
  ).login, [bot.id, client])
  const resource = useAdminResource(load)
  const reload = resource.reload
  const [sliderUrl, setSliderUrl] = useState("")
  const login = resource.data

  useEffect(() => {
    if (!login || !activePhases.has(login.phase)) return
    const timer = window.setTimeout(() => void reload(), login.phase === "verification" ? 4500 : 3000)
    return () => window.clearTimeout(timer)
  }, [login, reload])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(bot.id)}/login/qr`, {
        method: "POST",
        body: {
          loginType: formText(data, "loginType"),
          ...(formText(data, "deviceName") ? { deviceName: formText(data, "deviceName") } : {}),
        },
      }),
      "登录二维码已创建",
    )
  }

  async function securityCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = formText(new FormData(event.currentTarget), "code")
    if (!/^\d{6}$/u.test(code)) return
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(bot.id)}/login/security-code`, {
        method: "POST",
        body: { code },
      }),
      "安全码已提交",
    )
  }

  async function openSlider() {
    const response = await resource.mutate(
      () => client.request<{ url: string }>(`/api/bots/${encodeURIComponent(bot.id)}/login/slider`, { method: "POST" }),
    )
    if (response) setSliderUrl(response.url)
  }

  async function cancel() {
    await resource.mutate(
      () => client.request(`/api/bots/${encodeURIComponent(bot.id)}/login/session`, { method: "DELETE" }),
      "登录会话已取消",
    )
  }

  useEffect(() => {
    if (login?.phase === "online") void refreshSnapshot()
  }, [login?.phase, refreshSnapshot])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[94svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{bot.displayName} · 微信登录</DialogTitle>
          <DialogDescription>{bot.id} · wechat-ipad</DialogDescription>
        </DialogHeader>
        <AdminFeedback error={resource.error} notice={resource.notice} />
        {resource.loading ? <AdminLoading label="正在检查登录状态" /> : null}
        {login ? (
          <div className="space-y-5">
            <div className="flex items-center gap-4 rounded-xl border bg-muted/20 p-4">
              {login.headImageUrl ? (
                <img src={login.headImageUrl} alt="" className="size-14 rounded-xl object-cover" />
              ) : (
                <span className="flex size-14 items-center justify-center rounded-xl bg-indigo-100 text-xl font-semibold text-indigo-700">
                  {(login.nickname || "微").slice(0, 1)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{login.nickname || login.accountWxid || "未登录账号"}</p>
                <p className="mt-1 text-sm text-muted-foreground">{login.message || "等待操作"}</p>
              </div>
              <StatusPill
                label={login.phase}
                tone={login.phase === "online" ? "positive" : login.phase === "error" || login.phase === "expired" ? "warning" : login.phase === "offline" ? "muted" : "warning"}
              />
            </div>
            {activePhases.has(login.phase) ? (
              <div className="rounded-xl border p-4 text-center">
                {login.qrImage ? <img src={login.qrImage} alt="微信登录二维码" className="mx-auto max-h-72 rounded-lg" /> : null}
                {!login.qrImage && login.qrContent ? (
                  <Button asChild variant="outline"><a href={login.qrContent} target="_blank" rel="noreferrer"><QrCode data-icon="inline-start" /> 打开二维码</a></Button>
                ) : null}
                <p className="mt-3 text-sm text-muted-foreground">
                  {login.phase === "scanned" ? "已扫码，请在手机上确认" : login.phase === "verification" ? "需要完成安全验证" : `二维码剩余 ${login.expiresInSeconds ?? "—"} 秒`}
                </p>
              </div>
            ) : null}
            {["offline", "expired", "error"].includes(login.phase) ? (
              <form onSubmit={start} className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
                <SelectField
                  label="登录设备类型"
                  name="loginType"
                  defaultValue={login.loginType ?? "ipad"}
                  options={[
                    { value: "ipad", label: "iPad" },
                    { value: "win", label: "Windows" },
                    { value: "mac", label: "Mac" },
                    { value: "car", label: "车机" },
                    { value: "android-pad", label: "Android Pad" },
                  ]}
                />
                <FormField label="设备名称（可选）" name="deviceName" />
                <div className="sm:col-span-2 flex justify-end">
                  <Button type="submit"><LogIn data-icon="inline-start" /> 获取登录二维码</Button>
                </div>
              </form>
            ) : null}
            {login.phase === "verification" ? (
              <form onSubmit={securityCode} className="flex flex-wrap gap-2 rounded-xl border p-4">
                <div className="min-w-52 flex-1"><FormField label="手机显示的六位安全码" name="code" required /></div>
                <div className="flex items-end gap-2">
                  <Button type="submit"><ShieldCheck data-icon="inline-start" /> 提交安全码</Button>
                  <Button type="button" variant="outline" disabled={!login.sliderAvailable} onClick={() => void openSlider()}>打开滑块验证</Button>
                </div>
              </form>
            ) : null}
            {sliderUrl ? <iframe title="微信滑块验证" src={sliderUrl} className="h-96 w-full rounded-xl border" /> : null}
          </div>
        ) : null}
        <DialogFooter>
          {login && login.phase !== "online" ? (
            <Button variant="outline" onClick={() => void cancel()}><XCircle data-icon="inline-start" /> 取消登录</Button>
          ) : null}
          <Button variant="outline" onClick={() => void resource.reload()}><RefreshCw data-icon="inline-start" /> 刷新状态</Button>
          <Button onClick={onClose}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
