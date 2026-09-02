const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function numberOrNull(value) {
  const text = String(value ?? "").trim();
  if (!NUMERIC.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function detectDelimiter(line) {
  const candidates = [",", "\t", ";"];
  const selected = candidates.reduce((best, item) =>
    line.split(item).length > best.line.split(best.item).length ? { item, line } : best,
    { item: ",", line },
  );
  return selected.line.split(selected.item).length > 1 ? selected.item : "whitespace";
}

function splitLine(line, delimiter) {
  return delimiter === "whitespace" ? line.trim().split(/\s+/) : line.split(delimiter).map((cell) => cell.trim());
}

export function parseSpectrumText(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("文件为空。");

  const delimiter = detectDelimiter(lines[0]);
  const points = [];
  let skippedRows = 0;
  let firstDataRow = null;

  lines.forEach((line, index) => {
    const [rawX, rawY] = splitLine(line, delimiter);
    const x = numberOrNull(rawX);
    const y = numberOrNull(rawY);
    if (x === null || y === null) {
      if (index > 0 || rawX || rawY) skippedRows += 1;
      return;
    }
    if (firstDataRow === null) firstDataRow = index + 1;
    points.push({ x, y });
  });

  if (!points.length) throw new Error("未能在文件前两列识别出有效的数值数据。");
  return { points, skippedRows, delimiter, firstDataRow };
}

export function inferWavelengthUnit(points) {
  const xs = points.map((point) => point.x).filter((x) => x > 0).sort((a, b) => a - b);
  if (!xs.length) return { unit: null, label: "无法判断", confidence: "低", reason: "波长必须为正数。" };
  const median = xs[Math.floor(xs.length / 2)];
  if (median < 50) return { unit: "um", label: "可能是 μm（微米）", confidence: "中", reason: `中位数为 ${median.toPrecision(4)}，与常见微米光谱范围相符。` };
  if (median > 4000) return { unit: "wavenumber", label: "可能是 cm⁻¹（波数）", confidence: "中", reason: `中位数为 ${median.toPrecision(4)}，与常见红外波数范围相符。` };
  return { unit: "nm", label: "可能是 nm（纳米），也可能是 cm⁻¹（波数）", confidence: "低", reason: `中位数为 ${median.toPrecision(4)}；数值范围不足以可靠区分纳米和波数，必须由你确认。` };
}

export function inferSpectrumMetadata({ fileName = "", headerText = "", points }) {
  const context = `${fileName} ${headerText}`.toLowerCase();
  const namedCandidate = [
    // 文件名常出现“50 nm MXene”这样的厚度，而波数才是横坐标单位；
    // 因而带有 cm⁻¹ / 波数标记时应优先采用它。
    { unit: "wavenumber", label: "波数（cm⁻¹）", pattern: /(?:cm\s*(?:\^?\s*-?\s*1|⁻¹)|wavenumber|波数)/i },
    { unit: "um", label: "微米（μm）", pattern: /(?:μm|\bum\b|micron|微米)/i },
    { unit: "nm", label: "纳米（nm）", pattern: /(?:\bnm\b|纳米)/i },
  ].find((candidate) => candidate.pattern.test(context));
  const namedUnit = namedCandidate && { unit: namedCandidate.unit, label: namedCandidate.label };
  const numeric = inferWavelengthUnit(points);
  const wavelength = namedUnit ?? {
    unit: numeric.unit ?? "nm",
    label: numeric.label.replace("可能是 ", ""),
    reason: numeric.reason,
  };
  const valueType = /emiss|发射率|\bepsilon\b|ε/i.test(context) ? "emissivity"
    : /transmi|透射率|\btrans\b/i.test(context) ? "transmission"
      : /absor|吸收率/i.test(context) ? "absorption" : "reflectance";
  const valueUnit = Math.max(...points.map((point) => point.y)) > 1.2 || /%|percent|百分比/i.test(context) ? "percent" : "ratio";
  return {
    wavelength: { ...wavelength, confidence: namedUnit ? "高" : numeric.confidence, reason: namedUnit ? "从文件名或表头识别到单位标记。" : wavelength.reason },
    valueType,
    valueUnit,
    needsConfirmation: true,
  };
}

export function convertToMicrons(value, unit) {
  if (unit === "nm") return value / 1000;
  if (unit === "wavenumber") return value > 0 ? 10000 / value : NaN;
  return value;
}

export function linearInterpolate(x, points) {
  if (!points.length || x < points[0].x || x > points[points.length - 1].x) return NaN;
  if (x === points[0].x) return points[0].y;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (x === right.x) return right.y;
    if (x < right.x) return left.y + ((x - left.x) * (right.y - left.y)) / (right.x - left.x);
  }
  return points[points.length - 1].y;
}

export function trapezoidIntegral(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  return xs.slice(1).reduce((total, x, index) => total + 0.5 * (ys[index] + ys[index + 1]) * (x - xs[index]), 0);
}

export function planckRadianceMicron(wavelengthMicron, temperatureKelvin) {
  if (wavelengthMicron <= 0 || temperatureKelvin <= 0) return 0;
  const h = 6.62607015e-34;
  const c = 299792458;
  const k = 1.380649e-23;
  const wavelengthMeters = wavelengthMicron * 1e-6;
  const exponent = (h * c) / (wavelengthMeters * k * temperatureKelvin);
  if (exponent > 700) return 0;
  return (2 * h * c ** 2) / (wavelengthMeters ** 5 * Math.expm1(exponent));
}

export function weightedAverage({ points, minMicron, maxMicron, weightAt }) {
  const sorted = [...points].filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => a.x - b.x);
  if (sorted.length < 2 || minMicron >= maxMicron) throw new Error("加权积分需要至少两个数据点和有效波段。");
  if (minMicron < sorted[0].x || maxMicron > sorted[sorted.length - 1].x) {
    throw new Error(`样品数据未完整覆盖 ${minMicron}–${maxMicron} μm，不能外推计算。`);
  }
  const grid = [...new Set([minMicron, maxMicron, ...sorted.map((point) => point.x).filter((x) => x > minMicron && x < maxMicron)])].sort((a, b) => a - b);
  const weights = grid.map(weightAt);
  const weightedValues = grid.map((x, index) => linearInterpolate(x, sorted) * weights[index]);
  const denominator = trapezoidIntegral(grid, weights);
  const numerator = trapezoidIntegral(grid, weightedValues);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) throw new Error("该波段的辐射权重无效。");
  return { value: numerator / denominator, numerator, denominator, gridCount: grid.length };
}

export function blackbodyWeightedAverage({ points, minMicron, maxMicron, temperatureKelvin }) {
  return weightedAverage({
    points,
    minMicron,
    maxMicron,
    weightAt: (wavelengthMicron) => planckRadianceMicron(wavelengthMicron, temperatureKelvin),
  });
}

export function calculateMissingComponent({ first, second = null }) {
  const primary = [...first].sort((a, b) => a.x - b.x);
  const companion = second ? [...second].sort((a, b) => a.x - b.x) : null;
  if (!primary.length) throw new Error("至少需要一条已知光谱。");
  const overlapMin = companion ? Math.max(primary[0].x, companion[0].x) : primary[0].x;
  const overlapMax = companion ? Math.min(primary.at(-1).x, companion.at(-1).x) : primary.at(-1).x;
  if (overlapMin >= overlapMax) throw new Error("两条光谱没有重叠波段，无法计算。`".replace("`", ""));
  const points = primary.filter((point) => point.x >= overlapMin && point.x <= overlapMax).map((point) => ({
    x: point.x,
    y: 1 - point.y - (companion ? linearInterpolate(point.x, companion) : 0),
  }));
  return { points, range: [overlapMin, overlapMax] };
}

export function analyzeSpectrum(points, wavelengthUnit = "um") {
  const positivePoints = points.filter((point) => point.x > 0);
  const invalidWavelengths = points.length - positivePoints.length;
  const xs = positivePoints.map((point) => point.x);
  const ys = positivePoints.map((point) => point.y);
  const duplicateCount = xs.length - new Set(xs).size;
  const descendingPairs = xs.slice(1).filter((x, index) => x < xs[index]).length;
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const microns = xs.map((x) => convertToMicrons(x, wavelengthUnit));
  const rangeUm = [Math.min(...microns), Math.max(...microns)];
  const yInterpretation = minY >= 0 && maxY <= 1
    ? "数值看起来像比例（0–1）"
    : minY >= 0 && maxY <= 100
      ? "数值可能是百分比（0–100）；请确认"
      : "Y 值超出常见反射率 / 透射率范围；请确认数据类型与单位";

  const warnings = [];
  if (invalidWavelengths) warnings.push(`${invalidWavelengths} 个波长不是正数，无法用于物理计算。`);
  if (duplicateCount) warnings.push(`发现 ${duplicateCount} 个重复波长点，后续积分前应合并或取平均。`);
  if (descendingPairs) warnings.push("波长不是升序；绘图和积分前应排序。`".replace("`", ""));
  if (minY < 0 || maxY > 100) warnings.push("Y 值存在异常范围，不能直接按反射率或透射率解释。`".replace("`", ""));

  return {
    pointCount: points.length,
    validPointCount: positivePoints.length,
    rangeUm,
    yRange: [minY, maxY],
    yInterpretation,
    warnings,
    coversSolar: rangeUm[0] <= 0.3 && rangeUm[1] >= 2.5,
    coversAtmosphericWindow: rangeUm[0] <= 8 && rangeUm[1] >= 13,
  };
}

export function createAgentAssessment({ parsed, analysis, goal }) {
  const steps = [
    `识别到 ${parsed.points.length} 个有效数据点，数据从第 ${parsed.firstDataRow} 行开始。`,
    `分隔符：${parsed.delimiter === "\t" ? "制表符" : parsed.delimiter === "whitespace" ? "空格" : parsed.delimiter}。`,
    `Y 值判断：${analysis.yInterpretation}。`,
  ];
  const nextActions = ["请人工确认波长单位；自动判断只用于提示，不会静默换算数据。"];
  if (goal === "cooling") {
    steps.push(analysis.coversSolar ? "数据覆盖 0.3–2.5 μm，可评估太阳波段。" : "数据未完整覆盖 0.3–2.5 μm，不能给出完整太阳加权结论。");
    steps.push(analysis.coversAtmosphericWindow ? "数据覆盖 8–13 μm，可评估大气窗口。" : "数据未完整覆盖 8–13 μm，不能给出完整大气窗口结论。");
    nextActions.push("若数据为反射率，只有在样品近似不透明或同时给出透射率时，才能可靠推断发射率。");
    nextActions.push("下一版会在确认前提后计算太阳反射率和 8–13 μm 加权发射率。");
  } else {
    nextActions.push("确认单位与 Y 值含义后，可进入绘图、插值和加权积分。`".replace("`", ""));
  }
  return { steps, nextActions };
}
