import test from "node:test";
import assert from "node:assert/strict";
import { formatModelReply } from "../src/reply-format.js";

test("Markdown pipe tables render as semantic HTML tables", () => {
  const html = formatModelReply("| 文件 | 点数 | 单位 |\n|---|---:|:---|\n| 样品 A | 936 | **cm⁻¹** |");
  assert.match(html, /<table class="reply-table">/);
  assert.match(html, /<th scope="col">文件<\/th>/);
  assert.match(html, /<td><strong>cm⁻¹<\/strong><\/td>/);
  assert.doesNotMatch(html, /\|---/);
});

test("ordinary text containing a pipe is not mistaken for a table", () => {
  const html = formatModelReply("A | B 只是普通文字");
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /A \| B/);
});
