export function isCalculationOrGenerationRequest(task = "") {
  return /(计算|加权|weighted|积分|指标|太阳|黑体|波段|比较|对比|生成|绘|画图|谱图|曲线|报告|结论)/i.test(String(task));
}

export function mandatoryCalculationQuestion({ task = "", hasFiles = false, hasBlackbodySource = false, bandText = "", temperatureText = "" } = {}) {
  if (!hasFiles || !isCalculationOrGenerationRequest(task)) return "";
  if (!String(bandText).trim()) return "开始计算前，请先告诉我需要计算或框选的波段（统一用 μm），例如“3–5，还有 9–12”。";
  if (hasBlackbodySource && !String(temperatureText).trim()) {
    return `已记住波段 ${String(bandText).trim()} μm。当前包含微米或波数数据，必须使用黑体光谱计算；请告诉我黑体温度（K），例如“300 K”。`;
  }
  return "";
}
