import test from "node:test";
import assert from "node:assert/strict";
import { detectResearchIntents, selectAgentSkills } from "../src/agent-skills.js";

test("plain reading request does not imply chart generation", () => {
  const intents = detectResearchIntents("先看看这个附件里讲了什么");
  assert.ok(intents.some((intent) => intent.id === "file_intake"));
  assert.equal(intents.some((intent) => intent.id === "chart_creation"), false);
});

test("compound research request keeps comparison, weighting, chart and report intents", () => {
  const ids = detectResearchIntents("比较三种材料在 8-12 μm、500 K 下的加权表现，画同图并写组会报告").map((intent) => intent.id);
  assert.ok(ids.includes("comparison_screening"));
  assert.ok(ids.includes("weighted_physics"));
  assert.ok(ids.includes("chart_creation"));
  assert.ok(ids.includes("report_creation"));
});

test("report skill requires a real chart", () => {
  const skills = selectAgentSkills({ task: "生成一份科研报告", files: [{ confirmation: { unit: "um" } }] });
  const reporting = skills.find((skill) => skill.id === "scientific-reporting");
  assert.match(reporting.instruction, /真实谱图/);
});

test("every Agent run includes AI-led context memory", () => {
  const skills = selectAgentSkills({ task: "300", requirements: { bandText: "3-5" } });
  const memory = skills.find((skill) => skill.id === "context-memory");
  assert.match(memory.instruction, /update_task_context/);
  assert.match(memory.instruction, /不替模型解释自然语言/);
});
