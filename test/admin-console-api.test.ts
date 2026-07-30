import assert from "node:assert/strict"
import test from "node:test"

import { AdminServer } from "../src/admin/server.js"

const TOKEN = "test-admin-token-0123456789"

test("console manifest exposes the versioned core and adapter extension contract", async (context) => {
  const server = new AdminServer({
    store: { appendLog() {} } as never,
    supervisor: {} as never,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    allowPublicClients: true,
  })
  context.after(() => server.close())
  const address = await server.start()
  const base = `http://127.0.0.1:${address.port}`

  const unauthorized = await fetch(`${base}/api/v1/console-manifest`)
  assert.equal(unauthorized.status, 401)

  const response = await fetch(`${base}/api/v1/console-manifest`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")

  const manifest = await response.json() as {
    apiVersion: number
    modules: string[]
    adapters: Array<{ apiVersion: number; type: string; displayName: string }>
  }
  assert.equal(manifest.apiVersion, 1)
  assert.deepEqual(manifest.modules, ["core", "wechat"])
  assert.deepEqual(
    manifest.adapters.map((adapter) => adapter.type).sort(),
    ["wechat-ipad", "wx-hook-http"],
  )
  assert.ok(manifest.adapters.every((adapter) => adapter.apiVersion === 1 && adapter.displayName))
})
