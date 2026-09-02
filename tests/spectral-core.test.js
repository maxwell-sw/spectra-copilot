import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSpectrum, blackbodyWeightedAverage, calculateMissingComponent, inferSpectrumMetadata, parseSpectrumText } from "../src/spectral-core.js";

test("parses a CSV with a header", () => {
  const result = parseSpectrumText("Wavelength,Reflectance\n0.3,0.9\n8,0.2\n13,0.1");
  assert.equal(result.points.length, 3);
  assert.equal(result.points[1].x, 8);
});

test("finds duplicate wavelengths and atmospheric-window coverage", () => {
  const result = analyzeSpectrum([{ x: 0.3, y: 0.9 }, { x: 8, y: 0.2 }, { x: 8, y: 0.3 }, { x: 13, y: 0.1 }]);
  assert.equal(result.coversAtmosphericWindow, true);
  assert.equal(result.warnings.length, 1);
});

test("calculates an A/T/R missing component on the first spectrum grid", () => {
  const result = calculateMissingComponent({ first: [{ x: 1, y: 0.3 }, { x: 2, y: 0.4 }], second: [{ x: 1, y: 0.2 }, { x: 2, y: 0.1 }] });
  assert.deepEqual(result.points.map((point) => point.x), [1, 2]);
  assert.ok(result.points.every((point) => Math.abs(point.y - 0.5) < 1e-12));
});

test("keeps a constant emissivity under blackbody weighting", () => {
  const result = blackbodyWeightedAverage({ points: [{ x: 8, y: 0.8 }, { x: 10, y: 0.8 }, { x: 13, y: 0.8 }], minMicron: 8, maxMicron: 13, temperatureKelvin: 300 });
  assert.ok(Math.abs(result.value - 0.8) < 1e-10);
});

test("asks for confirmation when hundreds or thousands lack a unit marker", () => {
  const metadata = inferSpectrumMetadata({ fileName: "raw-data.csv", headerText: "column 1, column 2", points: [{ x: 500, y: 0.2 }, { x: 1500, y: 0.4 }] });
  assert.equal(metadata.wavelength.unit, "nm");
  assert.equal(metadata.wavelength.confidence, "低");
  assert.match(metadata.wavelength.reason, /必须由你确认/);
});

test("uses an explicit wavenumber label instead of a numeric guess", () => {
  const metadata = inferSpectrumMetadata({ fileName: "样品（波数）.csv", headerText: "cm-1,R", points: [{ x: 500, y: 20 }, { x: 1500, y: 40 }] });
  assert.equal(metadata.wavelength.unit, "wavenumber");
  assert.equal(metadata.wavelength.confidence, "高");
});
