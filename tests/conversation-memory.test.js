import test from "node:test";
import assert from "node:assert/strict";
import { applyStructuredContextUpdate, mergeCalculationRequirements, rebuildCalculationRequirements } from "../src/conversation-memory.js";

test("remembers a bare temperature answer when temperature is the missing slot", () => {
  const result = mergeCalculationRequirements({ bandText: "3-5", temperatureKelvin: "", temperatureText: "" }, "300", { expectsTemperature: true, hasBlackbodySource: true });
  assert.equal(result.temperatureKelvin, "300");
  assert.equal(result.temperatureText, "300");
});

test("understands a natural bare temperature answer without forgetting the band", () => {
  const result = mergeCalculationRequirements({ bandText: "3-5", temperatureKelvin: "", temperatureText: "" }, "就 300，不用其他温度了", { expectsTemperature: true, hasBlackbodySource: true });
  assert.deepEqual(result, { bandText: "3-5", temperatureKelvin: "300", temperatureText: "300" });
});

test("does not mistake a band range for a blackbody temperature", () => {
  const result = mergeCalculationRequirements({ bandText: "", temperatureKelvin: "", temperatureText: "" }, "3-5，还有9-12", { hasBlackbodySource: true });
  assert.equal(result.bandText, "3-5;9-12");
  assert.equal(result.temperatureText, "");
});

test("keeps an existing temperature when the user says no other temperatures", () => {
  const result = mergeCalculationRequirements({ bandText: "3-5", temperatureKelvin: "300", temperatureText: "300" }, "不用其他温度了", { hasBlackbodySource: true });
  assert.equal(result.temperatureText, "300");
});

test("supports explicitly labelled temperature without K", () => {
  const result = mergeCalculationRequirements({}, "温度用300，500", { hasBlackbodySource: true });
  assert.equal(result.temperatureText, "300,500");
  assert.equal(result.temperatureKelvin, "300");
});

test("repairs an older conversation where 300 was only present as a bare reply", () => {
  const result = rebuildCalculationRequirements(
    { bandText: "", temperatureKelvin: "", temperatureText: "" },
    ["3到5呢", "300", "不用其他温度了"],
    { hasBlackbodySource: true },
  );
  assert.deepEqual(result, { bandText: "3-5", temperatureKelvin: "300", temperatureText: "300" });
});

test("validates and applies structured conditions selected by the Agent", () => {
  const result = applyStructuredContextUpdate({}, {
    bandsMicron: [{ min: 3, max: 5 }, { min: 9, max: 12 }],
    temperaturesKelvin: [300],
  });
  assert.deepEqual(result, { bandText: "3-5;9-12", temperatureKelvin: "300", temperatureText: "300" });
});

test("deterministic guard rejects invalid Agent conditions without erasing memory", () => {
  const result = applyStructuredContextUpdate({ bandText: "3-5", temperatureKelvin: "300", temperatureText: "300" }, {
    bandsMicron: [{ min: 9, max: 2 }],
    temperaturesKelvin: [-20, 9000],
  });
  assert.deepEqual(result, { bandText: "3-5", temperatureKelvin: "300", temperatureText: "300" });
});
