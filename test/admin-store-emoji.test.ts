import assert from "node:assert/strict"
import test from "node:test"

import { AdminStore } from "../src/admin/admin-store.js"

test("admin emoji storage deduplicates identical bytes across bots", (context) => {
  const store = new AdminStore(":memory:")
  context.after(() => store.close())
  const sha256 = "a".repeat(64)
  const input = {
    asset: {
      id: `asset:sha256:${sha256}`,
      source: "local" as const,
      locator: `aa/${sha256}`,
      sha256,
    },
    sha256,
    sourceConversationId: "room@chatroom",
    sourceSenderId: "member",
    sourceMessageId: "message",
  }

  const first = store.saveCollectedEmoji({ ...input, botId: "primary-bot" })
  const duplicate = store.saveCollectedEmoji({ ...input, botId: "backup-bot" })

  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.emoji.id, first.emoji.id)
  assert.equal(store.listEmojis().length, 1)
})
