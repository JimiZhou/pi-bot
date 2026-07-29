import type { ReactNode } from "react"
import { ArrowDownRight, ArrowUpRight, Inbox } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { ConsoleMetric, HealthTone } from "@/types/console"

const toneClasses: Record<HealthTone, string> = {
  positive:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  neutral:
    "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300",
  warning:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  muted: "border-border bg-muted text-muted-foreground",
}

export function StatusPill({
  label,
  tone = "positive",
  dot = true,
}: {
  label: string
  tone?: HealthTone
  dot?: boolean
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", toneClasses[tone])}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {label}
    </Badge>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <p className="mb-2 text-xs font-semibold tracking-[0.14em] text-primary uppercase">{eyebrow}</p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

export function MetricCard({ metric, icon }: { metric: ConsoleMetric; icon: ReactNode }) {
  const trendIsDown = metric.trend?.startsWith("-")

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-sm font-medium">{metric.label}</span>
          <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-foreground">
            {icon}
          </span>
        </div>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div>
            <p className="font-heading text-2xl font-semibold tracking-tight">{metric.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p>
          </div>
          {metric.trend ? (
            <span
              className={cn(
                "mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold",
                metric.tone === "positive" ? "text-emerald-600" : "text-indigo-600",
                trendIsDown && "text-rose-600"
              )}
            >
              {trendIsDown ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
              {metric.trend}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center">
      <span className="mb-3 flex size-10 items-center justify-center rounded-xl border bg-background">
        <Inbox className="size-5 text-muted-foreground" />
      </span>
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}
