import { useCallback, useEffect, useState, type FormEvent } from "react"
import { KeyRound, LoaderCircle } from "lucide-react"

import { ConsoleShell } from "@/console/console-shell"
import { consoleModulesFor } from "@/console/core-modules"
import { ThemeProvider } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  adminDataSource,
  clearAdminToken,
  storedAdminToken,
  storeAdminToken,
} from "@/lib/admin-data-source"
import { AdminClient, AdminApiError } from "@/lib/admin-client"
import { AdminProvider } from "@/lib/admin-context"
import type { ConsoleSnapshot } from "@/types/console"
import type { ConsoleManifest } from "@/types/admin"

function LoginScreen({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const candidate = token.trim()
    if (!candidate) {
      setError("请输入管理令牌")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await new AdminClient(candidate).session
      storeAdminToken(candidate)
      onAuthenticated(candidate)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接管理 API")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThemeProvider defaultTheme="light" storageKey="pi-bot-console-theme">
      <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md shadow-none">
          <CardHeader>
            <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <KeyRound className="size-5" />
            </span>
            <CardTitle>解锁 Pi WeChat Console</CardTitle>
            <CardDescription>令牌仅保存在当前浏览器，用于访问本机 Admin API。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="admin-token">管理令牌</Label>
                <Input
                  id="admin-token"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "login-error" : undefined}
                  autoFocus
                />
                {error ? <p id="login-error" className="text-sm text-destructive">{error}</p> : null}
              </div>
              <Button className="w-full" type="submit" disabled={submitting}>
                {submitting ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                {submitting ? "正在验证" : "进入控制台"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </ThemeProvider>
  )
}

function LoadingScreen({
  error,
  onLogout,
  onRetry,
}: {
  error: string
  onLogout: () => void
  onRetry: () => void
}) {
  return (
    <ThemeProvider defaultTheme="light" storageKey="pi-bot-console-theme">
      <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
        <div className="text-center" role="status" aria-live="polite">
          <LoaderCircle className="mx-auto size-7 animate-spin text-primary" />
          <p className="mt-3 text-sm font-medium">正在加载本地运行状态</p>
          {error ? (
            <>
              <p className="mt-2 text-sm text-destructive">{error}</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="outline" onClick={onLogout}>重新登录</Button>
                <Button onClick={onRetry}>重试</Button>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </ThemeProvider>
  )
}

export default function App() {
  const [token, setToken] = useState(storedAdminToken)
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null)
  const [manifest, setManifest] = useState<ConsoleManifest | null>(null)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(() => Boolean(storedAdminToken()))

  const logout = useCallback(() => {
    clearAdminToken()
    setToken("")
    setSnapshot(null)
    setManifest(null)
  }, [])

  const loadSnapshot = useCallback(async () => {
    if (!token) return
    setRefreshing(true)
    setError("")
    try {
      const [nextSnapshot, nextManifest] = await Promise.all([
        adminDataSource.getSnapshot(token),
        new AdminClient(token).manifest(),
      ])
      setSnapshot(nextSnapshot)
      setManifest(nextManifest)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401) {
        logout()
      } else {
        setError(cause instanceof Error ? cause.message : "控制台数据加载失败")
      }
    } finally {
      setRefreshing(false)
    }
  }, [logout, token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    Promise.all([adminDataSource.getSnapshot(token), new AdminClient(token).manifest()]).then(
      ([nextSnapshot, nextManifest]) => {
        if (cancelled) return
        setSnapshot(nextSnapshot)
        setManifest(nextManifest)
        setError("")
        setRefreshing(false)
      },
      (cause: unknown) => {
        if (cancelled) return
        if (cause instanceof AdminApiError && cause.status === 401) logout()
        else setError(cause instanceof Error ? cause.message : "控制台数据加载失败")
        setRefreshing(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [logout, token])

  if (!token) return <LoginScreen onAuthenticated={setToken} />
  if (!snapshot || !manifest) {
    return <LoadingScreen error={error} onLogout={logout} onRetry={() => void loadSnapshot()} />
  }

  return (
    <ThemeProvider defaultTheme="light" storageKey="pi-bot-console-theme">
      <AdminProvider token={token} refreshSnapshot={loadSnapshot}>
        <ConsoleShell
          modules={consoleModulesFor(manifest)}
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={() => void loadSnapshot()}
          onLogout={logout}
        />
      </AdminProvider>
    </ThemeProvider>
  )
}
