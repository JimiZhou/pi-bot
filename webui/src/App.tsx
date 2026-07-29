import { useState } from "react"
import {
  Activity,
  Bot,
  Boxes,
  BrainCircuit,
  Cable,
  Check,
  CircleHelp,
  Command,
  Menu,
  MessageSquareText,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Sun,
} from "lucide-react"

import { StatusPill } from "@/components/console-primitives"
import { ThemeProvider, useTheme } from "@/components/theme-provider"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { demoSnapshot } from "@/data/demo-console"
import { AdaptersPanel } from "@/features/adapters-panel"
import { BotsPanel } from "@/features/bots-panel"
import { ModelsPanel } from "@/features/models-panel"
import { OverviewPanel } from "@/features/overview-panel"
import { PluginsPanel } from "@/features/plugins-panel"
import { SessionsPanel } from "@/features/sessions-panel"
import { SystemPanel } from "@/features/system-panel"
import { cn } from "@/lib/utils"

const navItems = [
  { value: "overview", label: "总览", description: "运行状态与关键指标", icon: Activity },
  { value: "bots", label: "Bot", description: "实例、行为与触发规则", icon: Bot },
  { value: "adapters", label: "适配器", description: "消息通道与能力声明", icon: Cable },
  { value: "models", label: "模型", description: "模型服务与路由策略", icon: BrainCircuit },
  { value: "plugins", label: "插件", description: "工具能力与权限范围", icon: Boxes },
  { value: "sessions", label: "会话", description: "上下文与会话记录", icon: MessageSquareText },
  { value: "system", label: "系统", description: "运行时、存储与接口", icon: Settings2 },
] as const

type NavValue = (typeof navItems)[number]["value"]

function MobileNavigation({
  open,
  onOpenChange,
  activeTab,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeTab: NavValue
  onSelect: (value: NavValue) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[19rem] gap-0 p-0" showCloseButton>
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
        <nav className="space-y-1 p-3" aria-label="移动端模块导航">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = item.value === activeTab
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  onSelect(item.value)
                  onOpenChange(false)
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  isActive ? "bg-primary/8 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-current">{item.label}</span>
                  <span className="mt-0.5 block truncate text-xs opacity-75">{item.description}</span>
                </span>
                {isActive ? <Check className="size-4" /> : null}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto border-t p-4">
          <div className="flex items-center justify-between rounded-lg bg-muted/60 p-3">
            <div>
              <p className="text-xs font-medium">Core v{demoSnapshot.runtime.coreVersion}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{demoSnapshot.runtime.uptime} 连续运行</p>
            </div>
            <StatusPill label="正常" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
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

function ConsoleApp() {
  const [activeTab, setActiveTab] = useState<NavValue>("overview")
  const [mobileOpen, setMobileOpen] = useState(false)
  const [lastSynced, setLastSynced] = useState(demoSnapshot.generatedAt)
  const activeItem = navItems.find((item) => item.value === activeTab) ?? navItems[0]
  const ActiveIcon = activeItem.icon

  function handleTabChange(value: string) {
    if (navItems.some((item) => item.value === value)) {
      setActiveTab(value as NavValue)
    }
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="min-h-svh gap-0 bg-muted/25">
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-16 max-w-[92rem] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
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
                <Badge variant="secondary" className="hidden font-mono text-[10px] sm:inline-flex">v0.2</Badge>
              </div>
              <p className="truncate text-[11px] text-muted-foreground sm:text-xs">能力编排与运行管理</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div className="mr-1 hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              <span>全部服务正常</span>
              <span className="text-border">·</span>
              <span>同步于 {lastSynced}</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setLastSynced("刚刚")} aria-label="刷新控制台数据">
                  <RefreshCw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新数据</TooltipContent>
            </Tooltip>
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多选项">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem>
                  <CircleHelp /> 使用文档
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Command /> 快捷操作
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>关于 Pi Bot</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mx-auto hidden max-w-[92rem] px-6 md:block lg:px-8">
          <TabsList variant="line" className="h-auto w-full justify-start gap-7 bg-transparent p-0">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <TabsTrigger key={item.value} value={item.value} className="h-11 flex-none gap-2 px-0">
                  <Icon className="size-4" />
                  {item.label}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>
      </header>

      <div className="border-b bg-background px-4 py-2.5 md:hidden">
        <div className="mx-auto flex max-w-[92rem] items-center gap-2 text-sm">
          <ActiveIcon className="size-4 text-primary" />
          <span className="font-medium">{activeItem.label}</span>
          <span className="text-muted-foreground">· {activeItem.description}</span>
        </div>
      </div>

      <main className="mx-auto w-full max-w-[92rem] flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <TabsContent value="overview">
          <OverviewPanel snapshot={demoSnapshot} />
        </TabsContent>
        <TabsContent value="bots">
          <BotsPanel bots={demoSnapshot.bots} />
        </TabsContent>
        <TabsContent value="adapters">
          <AdaptersPanel adapters={demoSnapshot.adapters} />
        </TabsContent>
        <TabsContent value="models">
          <ModelsPanel routes={demoSnapshot.modelRoutes} providers={demoSnapshot.providers} />
        </TabsContent>
        <TabsContent value="plugins">
          <PluginsPanel plugins={demoSnapshot.plugins} />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsPanel sessions={demoSnapshot.sessions} />
        </TabsContent>
        <TabsContent value="system">
          <SystemPanel runtime={demoSnapshot.runtime} checks={demoSnapshot.checks} />
        </TabsContent>
      </main>

      <footer className="border-t bg-background">
        <div className="mx-auto flex max-w-[92rem] flex-col gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span>Pi Bot · Transport-independent assistant runtime</span>
          <span>{demoSnapshot.environment} · API {demoSnapshot.runtime.apiVersion}</span>
        </div>
      </footer>

      <MobileNavigation
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        activeTab={activeTab}
        onSelect={setActiveTab}
      />
    </Tabs>
  )
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="pi-bot-console-theme">
      <ConsoleApp />
    </ThemeProvider>
  )
}
