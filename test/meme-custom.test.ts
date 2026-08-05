import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { customMemeInfo, getCustomMeme, listCustomMemes, saveCustomMeme } from "../src/meme-custom.js";
import { withImplicitBuiltInPlugins } from "../src/plugins/catalog.js";

test("custom meme assets persist as fixed image memes", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-pi-bot-custom-meme-"));
  const previousDirectory = process.env.PI_MEME_CUSTOM_DIR;
  process.env.PI_MEME_CUSTOM_DIR = directory;
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  try {
    const saved = await saveCustomMeme({
      key: "my-reaction",
      title: "我的反应",
      keywords: ["反应", "反应"],
      bytes,
      mimeType: "image/png",
    });
    assert.equal(saved.filename, "my-reaction.png");
    assert.deepEqual((await listCustomMemes()).map((item) => item.key), ["my-reaction"]);
    assert.deepEqual(await getCustomMeme("my-reaction"), { ...saved, bytes });
    assert.deepEqual(customMemeInfo(saved), {
      key: "my-reaction",
      keywords: ["我的反应", "反应"],
      minImages: 0,
      maxImages: 0,
      minTexts: 0,
      maxTexts: 0,
    });
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_MEME_CUSTOM_DIR;
    else process.env.PI_MEME_CUSTOM_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("meme-generator is enabled for bots without an explicit plugin override", () => {
  const plugins = withImplicitBuiltInPlugins([]);
  const meme = plugins.find((plugin) => plugin.type === "meme-generator");
  assert.equal(meme?.enabled, true);
  assert.equal(withImplicitBuiltInPlugins([{ id: "meme-generator", type: "meme-generator", enabled: false, settings: {} }]).find((plugin) => plugin.type === "meme-generator")?.enabled, false);
});
