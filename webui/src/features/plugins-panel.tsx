import { useState } from "react"
import {
  Blocks,
  BookOpenText,
  CalendarClock,
  Image,
  LayoutGrid,
  MoreHorizontal,
  PackagePlus,
  Search,
  Sparkles,
} from "lucide-react"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { PluginModule } from "@/types/console"

const pluginIcons = [BookOpenText, CalendarClock, Image, Sparkles]

export function PluginsPanel({ plugins }: { plugins: PluginModule[] }) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredPlugins = plugins.filter((plugin) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      plugin.name.toLocaleLowerCase().includes(normalizedQuery) ||
      plugin.description.toLocaleLowerCase().includes(normalizedQuery)
    const matchesCategory = category === "all" || plugin.category === category
    return matchesQuery && matchesCategory
  })
  const enabledCount = plugins.filter((plugin) => plugin.enabled).length

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="插件"
        title="按需扩展 Bot 能力"
        description="插件封装工具和业务能力，并通过权限范围决定哪些 Bot 可以调用。"
        action={
          <Button asChild>
            <a href="#plugins">
              <PackagePlus data-icon="inline-start" />
              管理插件
            </a>
          </Button>
        }
      />

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 px-1">
          <span className="flex size-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
            <Blocks className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">{enabledCount} 个插件已启用</p>
            <p className="text-xs text-muted-foreground">共 {plugins.length} 个已安装插件</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索插件"
              className="pl-8"
              aria-label="搜索插件"
            />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full sm:w-36" aria-label="按插件分类筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              <SelectItem value="知识">知识</SelectItem>
              <SelectItem value="自动化">自动化</SelectItem>
              <SelectItem value="多模态">多模态</SelectItem>
              <SelectItem value="内容">内容</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {filteredPlugins.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredPlugins.map((plugin) => {
            const originalIndex = plugins.findIndex((item) => item.id === plugin.id)
            const Icon = pluginIcons[originalIndex % pluginIcons.length] ?? LayoutGrid
            const isEnabled = plugin.enabled
            return (
              <Card key={plugin.id} className="shadow-none">
                <CardHeader>
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <CardTitle>{plugin.name}</CardTitle>
                        <Badge variant="outline" className="font-mono font-normal">v{plugin.version}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{plugin.category}</p>
                    </div>
                  </div>
                  <CardDescription className="min-h-10 leading-5">{plugin.description}</CardDescription>
                  <CardAction>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${plugin.name}操作菜单`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <a href="#plugins">在插件模块管理</a>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex items-center justify-between rounded-lg border bg-muted/20 p-3">
                  <div>
                    <p className="text-xs text-muted-foreground">可用范围</p>
                    <p className="mt-1 text-sm font-medium">{isEnabled ? plugin.scope : "已停用"}</p>
                  </div>
                  <StatusPill label={isEnabled ? "已启用" : "未启用"} tone={isEnabled ? "positive" : "muted"} />
                </CardContent>
                <CardFooter className="justify-between">
                  <span className="text-xs text-muted-foreground">今日调用 {isEnabled ? plugin.callsToday : "—"}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{isEnabled ? "启用" : "停用"}</span>
                    <Switch
                      checked={isEnabled}
                      disabled
                      aria-label={`${plugin.name}当前${isEnabled ? "已启用" : "未启用"}，请在插件模块修改`}
                    />
                  </div>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      ) : (
        <EmptyState title="没有匹配的插件" description="调整搜索词或分类筛选，即可查看其他已安装插件。" />
      )}
    </div>
  )
}
