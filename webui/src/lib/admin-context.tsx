/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, type ReactNode } from "react"

import { AdminClient } from "@/lib/admin-client"

interface AdminContextValue {
  client: AdminClient
  refreshSnapshot: () => Promise<void>
}

const AdminContext = createContext<AdminContextValue | null>(null)

export function AdminProvider({
  token,
  refreshSnapshot,
  children,
}: {
  token: string
  refreshSnapshot: () => Promise<void>
  children: ReactNode
}) {
  const client = useMemo(() => new AdminClient(token), [token])
  const value = useMemo(() => ({ client, refreshSnapshot }), [client, refreshSnapshot])
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export function useAdmin(): AdminContextValue {
  const context = useContext(AdminContext)
  if (!context) throw new Error("useAdmin must be used inside AdminProvider")
  return context
}
