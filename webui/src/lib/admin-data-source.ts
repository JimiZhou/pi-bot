import { demoSnapshot } from "@/data/demo-console"
import type { ConsoleSnapshot } from "@/types/console"

export interface AdminDataSource {
  getSnapshot(): Promise<ConsoleSnapshot>
}

export class DemoAdminDataSource implements AdminDataSource {
  async getSnapshot(): Promise<ConsoleSnapshot> {
    return structuredClone(demoSnapshot)
  }
}

export const adminDataSource: AdminDataSource = new DemoAdminDataSource()
