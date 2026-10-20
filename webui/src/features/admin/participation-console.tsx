import { useCallback, useState } from "react"
import { CheckCircle2, MessageCircleQuestion, ThumbsDown, ThumbsUp } from "lucide-react"

import {
  AdminFeedback,
  AdminLoading,
  ConfirmButton,
  ReloadButton,
} from "@/components/admin-primitives"
import { EmptyState, MetricCard, PageHeader, StatusPill } from "@/components/console-primitives"
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
import { useAdminResource } from "@/hooks/use-admin-resource"
import { useAdmin } from "@/lib/admin-context"
import type { ParticipationLabel, ReplyQualityLabel } from "@/types/admin"

export default function ParticipationConsole() {
  const { client } = useAdmin()
  const bootstrapLoad = useCallback(() => client.bootstrap(), [client])
  const bootstrapResource = useAdminResource(bootstrapLoad)
  const [botId, setBotId] = useState("")
  const selectedBotId = botId || bootstrapResource.data?.bots[0]?.id || ""
  const [review, setReview] = useState("unrated")
  const [qualityReview, setQualityReview] = useState("all")
  const load = useCallback(async () => {
    if (!selectedBotId) return { cases: [], summary: null }
    const [cases, summary] = await Promise.all([
      client.participation(selectedBotId, review, qualityReview),
      client.participationSummary(selectedBotId),
    ])
    return { cases: cases.cases, summary: summary.summary }
  }, [client, qualityReview, review, selectedBotId])
  const resource = useAdminResource(load)

  async function label(eventId: string, value: ParticipationLabel) {
    await resource.mutate(
      () => client.labelParticipation(selectedBotId, eventId, value),
      "接话标签已保存",
    )
  }

  async function quality(eventId: string, value: ReplyQualityLabel) {
    await resource.mutate(
      () => client.labelReplyQuality(selectedBotId, eventId, value),
      "回复质量标签已保存",
    )
  }

  const summary = resource.data?.summary
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="评估"
        title="参与学习"
        description="复核 Bot 是否应该接话以及实际回复是否有帮助，为策略演进保留可审计标签。"
        action={<ReloadButton loading={resource.refreshing} onClick={() => void resource.reload()} />}
      />
      <AdminFeedback error={resource.error || bootstrapResource.error} notice={resource.notice} />
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap gap-3">
          <select
            value={selectedBotId}
            onChange={(event) => setBotId(event.target.value)}
            className="h-8 rounded-lg border bg-background px-2.5 text-sm"
          >
            {(bootstrapResource.data?.bots ?? []).map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}
          </select>
          <select value={review} onChange={(event) => setReview(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
            <option value="unrated">待复核接话</option>
            <option value="all">全部接话标签</option>
            <option value="speak">应该接话</option>
            <option value="silent">应该沉默</option>
            <option value="unsure">不确定</option>
          </select>
          <select value={qualityReview} onChange={(event) => setQualityReview(event.target.value)} className="h-8 rounded-lg border bg-background px-2.5 text-sm">
            <option value="all">全部质量标签</option>
            <option value="unrated">待复核质量</option>
            <option value="helpful">有帮助</option>
            <option value="unhelpful">无帮助</option>
            <option value="unsure">质量不确定</option>
          </select>
          <div className="ml-auto">
            <ConfirmButton
              title="清理过期参与样本？"
              description="按照全局保留策略清理，不会删除当前策略配置。"
              confirmLabel="确认清理"
              disabled={!selectedBotId}
              onConfirm={() => void resource.mutate(
                () => client.pruneParticipation(selectedBotId),
                "参与样本已清理",
              )}
            />
          </div>
        </CardContent>
      </Card>
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard metric={{ label: "样本总数", value: summary.total.toLocaleString(), detail: `${summary.unrated} 条待复核` }} icon={<MessageCircleQuestion className="size-4" />} />
          <MetricCard metric={{ label: "应该接话", value: summary.speak.toLocaleString(), detail: `${summary.implicitPositive} 条隐式正反馈` }} icon={<CheckCircle2 className="size-4" />} />
          <MetricCard metric={{ label: "有帮助", value: summary.helpful.toLocaleString(), detail: `${summary.implicitHelpful} 条隐式有帮助` }} icon={<ThumbsUp className="size-4" />} />
          <MetricCard metric={{ label: "无帮助", value: summary.unhelpful.toLocaleString(), detail: `${summary.implicitUnhelpful} 条隐式负反馈` }} icon={<ThumbsDown className="size-4" />} />
        </div>
      ) : null}
      {resource.loading || bootstrapResource.loading ? <AdminLoading label="正在加载参与样本" /> : null}
      {!resource.loading && resource.data?.cases.length === 0 ? (
        <EmptyState title="没有匹配的参与样本" description="调整筛选条件，或等待 Bot 累积新的群聊决策。" />
      ) : null}
      <div className="space-y-4">
        {(resource.data?.cases ?? []).map((item) => (
          <Card key={item.eventId} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">{item.senderName}：{item.messageText}</CardTitle>
              <CardDescription>
                {item.conversationTitle || item.conversationId} · {new Date(item.createdAt).toLocaleString("zh-CN")}
              </CardDescription>
              <CardAction>
                <StatusPill
                  label={item.outcome}
                  tone={item.outcome === "replied" ? "positive" : item.outcome === "failed" ? "warning" : "muted"}
                />
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">触发：{item.activation}</Badge>
                <Badge variant={item.policyRespond ? "secondary" : "outline"}>
                  策略：{item.policyRespond ? "建议接话" : "建议沉默"}
                </Badge>
                <Badge variant="outline">{item.modelUsed ? "使用模型判断" : "确定性策略"}</Badge>
              </div>
              <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">{item.policyReason}</p>
              {item.replyText ? <p className="whitespace-pre-wrap rounded-lg border-l-4 border-l-indigo-400 bg-muted/20 p-3 text-sm">{item.replyText}</p> : null}
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <span className="mr-2 text-xs text-muted-foreground">接话：</span>
              {(["speak", "silent", "unsure"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={item.adminLabel === value ? "default" : "outline"}
                  onClick={() => void label(item.eventId, value)}
                >
                  {value === "speak" ? "应该接话" : value === "silent" ? "应该沉默" : "不确定"}
                </Button>
              ))}
              <span className="ml-3 mr-2 text-xs text-muted-foreground">质量：</span>
              {(["helpful", "unhelpful", "unsure"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={item.adminQualityLabel === value ? "default" : "outline"}
                  disabled={!item.replyText}
                  onClick={() => void quality(item.eventId, value)}
                >
                  {value === "helpful" ? "有帮助" : value === "unhelpful" ? "无帮助" : "不确定"}
                </Button>
              ))}
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}
