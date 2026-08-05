import { Suspense, useEffect, useState } from "react"
import {
  Check,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Sun,
} from "lucide-react"

import { StatusPill } from "@/components/console-primitives"
import { useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ConsoleModule, ConsoleModuleGroup } from "@/console/types"
import type { ConsoleSnapshot } from "@/types/console"

const groupLabels: Record<ConsoleModuleGroup, string> = {
  runtime: "运行",
  intelligence: "AI 配置",
  conversations: "对话与数据",
  system: "系统",
}

const groupOrder: ConsoleModuleGroup[] = [
  "runtime",
  "intelligence",
  "conversations",
  "system",
]

function moduleFromHash(modules: ConsoleModule[]): string {
  const candidate = location.hash.replace(/^#/u, "")
  return modules.some((module) => module.id === candidate) ? candidate : modules[0]?.id ?? ""
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={isDark ? "切换到浅色模式" : "切换到深色模式"}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isDark ? "浅色模式" : "深色模式"}</TooltipContent>
    </Tooltip>
  )
}

function ModuleNavigation({
  modules,
  activeId,
  onSelect,
}: {
  modules: ConsoleModule[]
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <nav className="space-y-5 p-3" aria-label="控制台模块">
      {groupOrder.map((group) => {
        const items = modules
          .filter((module) => module.group === group)
          .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
        if (items.length === 0) return null
        return (
          <div key={group}>
            <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.13em] text-muted-foreground uppercase">
              {groupLabels[group]}
            </p>
            <div className="space-y-0.5">
              {items.map((module) => {
                const Icon = module.icon
                const active = module.id === activeId
                return (
                  <button
                    key={module.id}
                    type="button"
                    onClick={() => onSelect(module.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      active
                        ? "bg-primary/9 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-current">{module.label}</span>
                    </span>
                    {active ? <Check className="size-3.5" /> : null}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function MobileNavigation({
  modules,
  activeId,
  snapshot,
  open,
  onOpenChange,
  onSelect,
}: {
  modules: ConsoleModule[]
  activeId: string
  snapshot: ConsoleSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[19rem] gap-0 overflow-y-auto p-0" showCloseButton>
        <SheetHeader className="border-b px-5 py-5 text-left">
          <div className="mb-2 flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
              π
            </span>
            <div>
              <SheetTitle>Pi Bot Console</SheetTitle>
              <SheetDescription>能力编排与运行管理</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <ModuleNavigation
          modules={modules}
          activeId={activeId}
          onSelect={(id) => {
            onSelect(id)
            onOpenChange(false)
          }}
        />
        <div className="mt-auto border-t p-4">
          <div className="flex items-center justify-between rounded-lg bg-muted/60 p-3">
            <div>
              <p className="text-xs font-medium">Core v{snapshot.runtime.coreVersion}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{snapshot.runtime.uptime} 连续运行</p>
            </div>
            <StatusPill label="正常" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function ConsoleShell({
  modules,
  snapshot,
  refreshing,
  onRefresh,
  onLogout,
}: {
  modules: ConsoleModule[]
  snapshot: ConsoleSnapshot
  refreshing: boolean
  onRefresh: () => void
  onLogout: () => void
}) {
  const [activeId, setActiveId] = useState(() => moduleFromHash(modules))
  const [mobileOpen, setMobileOpen] = useState(false)
  const activeModule = modules.find((module) => module.id === activeId) ?? modules[0]
  const unhealthyChecks = snapshot.checks.filter((check) => check.status !== "正常").length

  useEffect(() => {
    const handleHash = () => setActiveId(moduleFromHash(modules))
    window.addEventListener("hashchange", handleHash)
    return () => window.removeEventListener("hashchange", handleHash)
  }, [modules])

  function selectModule(id: string) {
    setActiveId(id)
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`)
  }

  if (!activeModule) return null
  const ActiveComponent = activeModule.component

  return (
    <div className="min-h-svh bg-muted/25">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="打开模块导航"
          >
            <Menu />
          </Button>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden size-9 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground sm:flex">
              π
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-heading text-sm font-semibold sm:text-base">Pi Bot Console</span>
                <Badge variant="secondary" className="hidden font-mono text-[10px] sm:inline-flex">v0.3</Badge>
              </div>
              <p className="truncate text-[11px] text-muted-foreground sm:text-xs">模块化控制面 · Adapter API v1</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div className="mr-1 hidden items-center gap-2 text-xs text-muted-foreground xl:flex">
              <span className={cn("size-1.5 rounded-full", unhealthyChecks ? "bg-amber-500" : "bg-emerald-500")} />
              <span>{unhealthyChecks ? `${unhealthyChecks} 项需关注` : "全部服务正常"}</span>
              <span className="text-border">·</span>
              <span>同步于 {snapshot.generatedAt}</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="刷新控制台数据">
                  <RefreshCw className={cn(refreshing && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新总览数据</TooltipContent>
            </Tooltip>
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多选项">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => selectModule("settings")}>
                  <KeyRound /> 管理设置
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLogout}>
                  <LogOut /> 锁定控制台
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[108rem] lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="sticky top-16 hidden h-[calc(100svh-4rem)] overflow-y-auto border-r bg-background lg:block">
          <ModuleNavigation modules={modules} activeId={activeModule.id} onSelect={selectModule} />
          <div className="m-3 mt-5 rounded-lg border bg-muted/35 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">Core v{snapshot.runtime.coreVersion}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{snapshot.runtime.uptime} 连续运行</p>
              </div>
              <StatusPill label={unhealthyChecks ? "关注" : "正常"} tone={unhealthyChecks ? "warning" : "positive"} />
            </div>
          </div>
        </aside>

        <main className="min-w-0 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
          <Suspense
            fallback={
              <div className="flex min-h-72 items-center justify-center" role="status">
                <LoaderCircle className="size-6 animate-spin text-primary" />
                <span className="sr-only">正在加载模块</span>
              </div>
            }
          >
            <ActiveComponent snapshot={snapshot} />
          </Suspense>
        </main>
      </div>

      <MobileNavigation
        modules={modules}
        activeId={activeModule.id}
        snapshot={snapshot}
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        onSelect={selectModule}
      />
    </div>
  )
}
