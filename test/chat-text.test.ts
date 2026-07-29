import assert from "node:assert/strict";
import test from "node:test";
import { toChatPlainText } from "../src/chat-text.js";

test("model Markdown is converted into readable chat plain text", () => {
  assert.equal(
    toChatPlainText([
      "# 今日摘要",
      "",
      "- **状态**：正常",
      "- [x] 已完成",
      "1. 查看 [详情](https://example.com/detail)",
      "",
      "| 项目 | 结果 |",
      "| --- | --- |",
      "| 构建 | 通过 |",
    ].join("\n")),
    [
      "今日摘要",
      "",
      "• 状态：正常",
      "☑ 已完成",
      "1、查看 详情：https://example.com/detail",
      "",
      "项目 · 结果",
      "构建 · 通过",
    ].join("\n"),
  );
});

test("code fences, inline markup, images, autolinks, and escapes are flattened", () => {
  assert.equal(
    toChatPlainText([
      "```text",
      "`alpha` 与 ~~beta~~",
      "```",
      "![结构图](https://example.com/image.png)",
      "<mailto:team@example.com>",
      "\\*literal\\*",
    ].join("\n")),
    [
      "alpha 与 beta",
      "结构图：https://example.com/image.png",
      "mailto:team@example.com",
      "*literal*",
    ].join("\n"),
  );
});
