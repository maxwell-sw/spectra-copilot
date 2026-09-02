import test from "node:test";
import assert from "node:assert/strict";
import { applyArtifactReplacements, readableArtifactHtml, taskExplicitlyEditsText, visibleArtifactText } from "../src/artifact-editor.js";

const report = '<!doctype html><style>.hero{max-width:1000px}</style><body><h1>原报告标题</h1><div class="hero"><svg width="1000"><path d="M0 0L1 1"/></svg></div><p>原分析结论保持不变。</p></body>';

test("artifact reader collapses curve data but keeps editable SVG attributes", () => {
  const readable = readableArtifactHtml(report);
  assert.match(readable, /<svg width="1000">/);
  assert.match(readable, /SPECTRA_PROTECTED_SVG/);
  assert.doesNotMatch(readable, /M0 0L1 1/);
});

test("visual-only artifact patch preserves all visible report text", () => {
  const result = applyArtifactReplacements(report, [{ find: ".hero{max-width:1000px}", replace: ".hero{max-width:700px}" }]);
  assert.equal(visibleArtifactText(result.content), visibleArtifactText(report));
  assert.match(result.content, /max-width:700px/);
});

test("visual-only artifact patch rejects accidental wording changes", () => {
  assert.throws(() => applyArtifactReplacements(report, [{ find: "原分析结论保持不变。", replace: "新的分析结论。" }]), /改变了正文文字/);
});

test("only explicit text editing requests unlock wording changes", () => {
  assert.equal(taskExplicitlyEditsText("把主图缩小一点，排版协调"), false);
  assert.equal(taskExplicitlyEditsText("请把正文第一段改写得更简洁"), true);
});
