import { useState } from "react"
import {
  Archive,
  Clock3,
  ListFilter,
  MessageSquareText,
  MoreHorizontal,
  Search,
  UsersRound,
} from "lucide-react"

import { ResourceDialog } from "@/components/action-dialogs"
import { EmptyState, PageHeader, StatusPill } from "@/components/console-primitives"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { HealthTone, SessionRecord } from "@/types/console"

function sessionTone(status: SessionRecord["status"]): HealthTone {
  if (status === "活跃") return "positive"
  if (status === "等待") return "warning"
  return "muted"
}

export function SessionsPanel({ sessions }: { sessions: SessionRecord[] }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredSessions = sessions.filter((session) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      session.id.toLocaleLowerCase().includes(normalizedQuery) ||
      session.participant.toLocaleLowerCase().includes(normalizedQuery) ||
      session.bot.toLocaleLowerCase().includes(normalizedQuery)
    return matchesQuery && (status === "all" || session.status === status)
  })
  const activeCount = sessions.filter((session) => session.status === "活跃").length
  const averageContext = Math.round(
    sessions.reduce((total, session) => total + session.contextUsage, 0) / Math.max(sessions.length, 1)
  )

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="会话"
        title="查看对话状态与上下文"
        description="会话记录使用统一身份与消息模型，不依赖任一消息通道的内部字段。"
        action={<ResourceDialog kind="session" />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card size="sm" className="shadow-none">
          <CardContent className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950">
              <MessageSquareText className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">{activeCount}</p>
              <p className="text-xs text-muted-foreground">当前活跃</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm" className="shadow-none">
          <CardContent className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950">
              <UsersRound className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">1,284</p>
              <p className="text-xs text-muted-foreground">今日新增</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm" className="shadow-none">
          <CardContent className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Clock3 className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">{averageContext}%</p>
              <p className="text-xs text-muted-foreground">平均上下文占用</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle>最近会话</CardTitle>
          <CardDescription>统一查看所有 Bot 和通道的会话活动</CardDescription>
          <CardAction className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话"
                className="w-52 pl-8"
                aria-label="搜索会话"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-30" aria-label="按会话状态筛选">
                <ListFilter className="size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="活跃">活跃</SelectItem>
                <SelectItem value="等待">等待</SelectItem>
                <SelectItem value="已归档">已归档</SelectItem>
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <div className="border-b p-3 sm:hidden">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              className="pl-8"
              aria-label="搜索会话"
            />
          </div>
        </div>
        <CardContent className="px-0">
          {filteredSessions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">参与者</TableHead>
                  <TableHead>Bot</TableHead>
                  <TableHead className="hidden lg:table-cell">通道</TableHead>
                  <TableHead className="hidden md:table-cell">模式</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="hidden xl:table-cell">上下文</TableHead>
                  <TableHead className="hidden sm:table-cell">最后活动</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="pl-4">
                      <p className="font-medium">{session.participant}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{session.id}</p>
                    </TableCell>
                    <TableCell>{session.bot}</TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{session.channel}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{session.mode}</TableCell>
                    <TableCell>
                      <StatusPill label={session.status} tone={sessionTone(session.status)} />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <div className="flex w-28 items-center gap-2">
                        <Progress value={session.contextUsage} className="h-1.5" />
                        <span className="w-8 text-right text-xs text-muted-foreground">{session.contextUsage}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{session.updatedAt}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${session.participant}会话操作`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>查看消息记录</DropdownMenuItem>
                          <DropdownMenuItem>重置上下文</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>
                            <Archive /> 归档会话
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState title="没有匹配的会话" description="调整搜索词或状态筛选，查看其他会话记录。" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
