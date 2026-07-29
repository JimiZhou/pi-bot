import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentInspectionTool } from "../src/attachment-inspection.js";
import type { InboundMessageEvent } from "../src/types.js";

test("attachment inspection reads bounded text files and never fetches link URLs", async () => {
  let resolves = 0;
  const event: InboundMessageEvent = {
    type: "message",
    id: "attachments",
    conversation: { id: "g1", kind: "group" },
    sender: { id: "u1", displayName: "阿青" },
    text: "帮我看看",
    parts: [
      {
        type: "file",
        name: "notes.md",
        asset: { id: "file-1", source: "platform", locator: "native-file", mimeType: "text/markdown" },
      },
      { type: "link", url: "https://example.test/private", title: "预览标题", description: "预览描述" },
    ],
  };
  const tool = createAttachmentInspectionTool({
    event,
    mediaResolver: {
      async resolve(asset) {
        resolves += 1;
        return { asset, content: chunks(new TextEncoder().encode("# 周报\n本周完成了模型降级链。")) };
      },
    },
  });
  assert.ok(tool);
  const file = await tool.execute("file-call", { attachmentIndex: 1, question: "完成了什么？" });
  assert.match(String((file.details as { textExcerpt?: string }).textExcerpt), /模型降级链/u);
  const link = await tool.execute("link-call", { attachmentIndex: 2, question: "链接是什么？" });
  assert.equal((link.details as { title?: string }).title, "预览标题");
  assert.match(String((link.details as { note?: string }).note), /未联网/u);
  assert.equal(resolves, 1);
});

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
