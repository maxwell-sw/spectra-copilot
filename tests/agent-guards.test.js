import test from "node:test";
import assert from "node:assert/strict";
import { mandatoryCalculationQuestion } from "../src/agent-guards.js";

test("requires a band before physical calculation", () => {
  assert.match(mandatoryCalculationQuestion({ task: "生成加权谱图", hasFiles: true, hasBlackbodySource: true }), /波段/);
});

test("requires blackbody temperature for micron or wavenumber data", () => {
  assert.match(mandatoryCalculationQuestion({ task: "计算并画图", hasFiles: true, hasBlackbodySource: true, bandText: "3-5" }), /黑体温度/);
});

test("does not require temperature for nanometre-only solar calculation", () => {
  assert.equal(mandatoryCalculationQuestion({ task: "计算加权值", hasFiles: true, hasBlackbodySource: false, bandText: "0.3-2.5" }), "");
});

test("plain data reading does not trigger calculation questions", () => {
  assert.equal(mandatoryCalculationQuestion({ task: "帮我看看文件里有什么", hasFiles: true, hasBlackbodySource: true }), "");
});
