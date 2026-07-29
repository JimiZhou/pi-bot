import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LocalAssetStore } from "../src/asset-store.js";

test("local assets are content-addressed, deduplicated, and streamed back", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-assets-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new LocalAssetStore({ directory });
  const bytes = new TextEncoder().encode("同一张图片的二进制内容");

  const first = await store.put({ data: chunked(bytes), mimeType: "image/png", name: "photo.png" });
  const duplicate = await store.put({ data: bytes, mimeType: "image/png", name: "another-name.png" });

  assert.equal(first.id, duplicate.id);
  assert.equal(first.sha256, duplicate.sha256);
  assert.equal(first.source, "local");
  assert.equal(first.size, bytes.byteLength);
  assert.equal(await store.has(first), true);

  const resolved = await store.resolve(first);
  assert.deepEqual(await collect(resolved.content), bytes);
});

test("asset limits and path ownership are enforced", async (context) => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-bot-assets-limit-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new LocalAssetStore({ directory, maxAssetBytes: 4 });

  await assert.rejects(store.put({ data: new Uint8Array(5) }), /exceeds the configured 4 byte limit/);
  await assert.rejects(
    store.resolve({ id: "remote", source: "url", locator: "https://example.test/file" }),
    /not owned by a local asset store/,
  );
  await assert.rejects(
    store.resolve({ id: "escape", source: "local", locator: "../secret" }),
    /escapes the asset store/,
  );
});

async function* chunked(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 4);
  yield bytes.slice(4);
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
