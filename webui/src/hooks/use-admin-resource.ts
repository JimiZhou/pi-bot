import { useCallback, useEffect, useRef, useState } from "react"

export interface AdminResource<T> {
  data: T | null
  error: string
  loading: boolean
  refreshing: boolean
  mutating: boolean
  reload: () => Promise<void>
  mutate: <R>(operation: () => Promise<R>, successMessage?: string) => Promise<R | undefined>
  notice: string
  clearNotice: () => void
}

export function useAdminResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
): AdminResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [refreshing, setRefreshing] = useState(true)
  const [mutating, setMutating] = useState(false)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    setRefreshing(true)
    setError("")
    try {
      const next = await load(new AbortController().signal)
      if (mounted.current) setData(next)
    } catch (cause) {
      if (mounted.current && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "数据加载失败")
      }
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [load])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    load(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setData(next)
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "数据加载失败")
      },
    ).finally(() => {
      if (!controller.signal.aborted) setRefreshing(false)
    })
    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [load])

  const mutate = useCallback(async <R,>(operation: () => Promise<R>, successMessage?: string) => {
    setError("")
    setNotice("")
    setMutating(true)
    try {
      const result = await operation()
      if (!mounted.current) return result
      if (successMessage) setNotice(successMessage)
      await reload()
      return result
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败")
      return undefined
    } finally {
      if (mounted.current) setMutating(false)
    }
  }, [reload])

  return {
    data,
    error,
    loading: data === null && refreshing,
    refreshing,
    mutating,
    reload,
    mutate,
    notice,
    clearNotice: () => setNotice(""),
  }
}
