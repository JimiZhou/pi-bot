import { useCallback, useState, type FormEvent } from "react"
import { Blocks, Bot, Braces, Save } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  ReloadButton,
} from "@/components/admin-primitives"
import { EmptyState, PageHeader, StatusPill } from "@/components/console-primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import type { BotPluginConfig, PluginsPayload } from "@/types/admin"

type PluginBot = PluginsPayload["bots"][number]

function PluginEditor({
  payload,
  bot,
  onSave,
}: {
  payload: PluginsPayload
  bot: PluginBot
  onSave: (plugins: BotPluginConfig[]) => Promise<void>
}) {
  const configured = new Map(bot.plugins.map((plugin) => [plugin.type, plugin]))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const known = payload.catalog.map((definition) => {
        const existing = configured.get(definition.type)
        const rawSettings = String(data.get(`settings:${definition.type}`) ?? "{}")
        const settings = JSON.parse(rawSettings) as unknown
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          throw new Error(`${definition.name} 的设置必须是 JSON 对象`)
        }
        return {
          id: existing?.id ?? definition.type,
          type: definition.type,
          enabled: data.get(`enabled:${definition.type}`) === "on",
          settings: settings as Record<string, unknown>,
        }
      })
      const knownTypes = new Set(payload.catalog.map((item) => item.type))
      await onSave([...bot.plugins.filter((plugin) => !knownTypes.has(plugin.type)), ...known])
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {payload.catalog.map((definition) => {
          const plugin = configured.get(definition.type)
          return (
            <Card key={definition.type} className="shadow-none">
              <CardHeader>
                <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  <Blocks className="size-4" />
                </span>
                <CardTitle>{definition.name}</CardTitle>
                <CardDescription className="min-h-10 leading-5">{definition.description}</CardDescription>
                <CardAction>
                  <StatusPill label={plugin?.enabled ? "已启用" : "未启用"} tone={plugin?.enabled ? "positive" : "muted"} />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={`settings-${definition.type}`}>设置 JSON</Label>
                    <Badge variant="outline" className="font-mono">{definition.type}</Badge>
                  </div>
                  <Textarea
                    id={`settings-${definition.type}`}
                    name={`settings:${definition.type}`}
                    rows={5}
                    defaultValue={JSON.stringify(plugin?.settings ?? {}, null, 2)}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                </div>
              </CardContent>
              <CardFooter>
                <label className="flex w-full cursor-pointer items-center justify-between gap-3">
                  <span className="text-sm font-medium">为此 Bot 启用</span>
                  <input
                    type="checkbox"
                    name={`enabled:${definition.type}`}
                    defaultChecked={plugin?.enabled ?? false}
                    className="size-4 accent-primary"
                  />
                </label>
              </CardFooter>
            </Card>
          )
        })}
      </div>
      <div className="sticky bottom-3 flex justify-end rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
        <Button type="submit"><Save data-icon="inline-start" /> 保存并应用全部插件</Button>
      </div>
    </form>
  )
}

export default function PluginsConsole() {
  const { client, refreshSnapshot } = useAdmin()
  const load = useCallback(() => client.plugins(), [client])
  const resource = useAdminResource(load)
  const [selectedId, setSelectedId] = useState("")
  const selected = resource.data?.bots.find((bot) => bot.id === selectedId)
    ?? resource.data?.bots[0]

  async function save(plugins: BotPluginConfig[]) {
    if (!selected) return
    const result = await resource.mutate(
      () => client.saveBotPlugins(selected.id, plugins),
      `${selected.displayName} 的插件已保存并应用`,
    )
    if (result) await refreshSnapshot()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="插件"
        title="按 Bot 配置能力"
        description="插件属于标准 Bot 配置；微信通道只负责传输，不把业务能力写进 Adapter。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error} notice={resource.notice} />
      {resource.loading ? <AdminLoading label="正在加载插件" /> : null}
      {resource.data && resource.data.bots.length === 0 ? (
        <EmptyState title="还没有 Bot" description="新增 Bot 后即可启用插件。" />
      ) : null}
      {resource.data && selected ? (
        <>
          <Card className="shadow-none">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2"><Bot className="size-4" /> 选择 Bot</CardTitle>
              <CardDescription>每个 Bot 独立保存启用状态和设置。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {resource.data.bots.map((bot) => (
                  <Button
                    key={bot.id}
                    variant={selected.id === bot.id ? "default" : "outline"}
                    onClick={() => setSelectedId(bot.id)}
                  >
                    {bot.displayName}
                  </Button>
                ))}
              </div>
            </CardContent>
            <CardFooter className="text-xs text-muted-foreground">
              <Braces className="mr-2 size-3.5" />
              未提供专用表单的插件设置可直接编辑 JSON，未知自定义插件会原样保留。
            </CardFooter>
          </Card>
          <PluginEditor
            key={`${selected.id}:${JSON.stringify(selected.plugins)}`}
            payload={resource.data}
            bot={selected}
            onSave={save}
          />
        </>
      ) : null}
    </div>
  )
}
