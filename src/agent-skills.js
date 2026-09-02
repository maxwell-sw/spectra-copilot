// Spectra Copilot 的轻量意图路由与按需 Skill 装配。
// 模型负责理解自然语言；这里提供可审计的候选意图、工具边界和专业 SOP，不直接替模型作答。

const intentCatalog = [
  { id: "conversation", pattern: /^(你好|嗨|谢谢|为什么|是什么|解释|介绍|先看看|读一下|告诉我)/i, route: "自然语言回答；必要时只读摘要", tools: ["get_selected_spectrum_summaries"] },
  { id: "file_intake", pattern: /(上传|附件|文件|读取|打开|范例|参考|格式)/i, route: "读取摘要、判断文件用途；范例文件不自动计算", tools: ["get_selected_spectrum_summaries", "scan_raw_spectrum_rows"] },
  { id: "unit_semantics", pattern: /(单位|微米|纳米|波数|cm|百分比|0\s*[-–到]\s*1|反射率|透射率|吸收率|发射率)/i, route: "给出 AI 初判证据，物理计算前由用户批量确认", tools: ["get_selected_spectrum_summaries", "scan_raw_spectrum_rows", "get_legacy_demo_contract"] },
  { id: "data_quality", pattern: /(异常|超出|超过|缺失|重复|噪声|离群|质量|哪一行|最大值|最小值)/i, route: "先定位原始行，再解释异常；不自动修数据", tools: ["get_selected_spectrum_summaries", "scan_raw_spectrum_rows"] },
  { id: "spectral_features", pattern: /(峰|谷|平台|拐点|趋势|均值|特征|波段表现|变化)/i, route: "调用确定性波段特征工具后解释", tools: ["summarize_band_features"] },
  { id: "weighted_physics", pattern: /(weighted|加权|积分|太阳|黑体|am1\.5|astm|普朗克|温度)/i, route: "检查波段和辐射源条件，再做确定性加权", tools: ["calculate_weighted_metrics", "get_legacy_demo_contract"] },
  { id: "comparison_screening", pattern: /(比较|对比|同图|叠加|排序|筛选|最佳|最好|优于|差异)/i, route: "先建立公共波段与可比条件，再计算特征或画同图", tools: ["get_selected_spectrum_summaries", "summarize_band_features", "calculate_weighted_metrics", "generate_comparison_chart"] },
  { id: "chart_creation", pattern: /(画图|绘图|出图|画.*图|谱图|曲线|可视化|图片|图形)/i, route: "仅在用户明确要图时生成；单样品与多样品分流", tools: ["generate_spectrum_chart", "generate_comparison_chart"] },
  { id: "report_creation", pattern: /(报告|论文|摘要|结论|汇报|答辩|科研记录)/i, route: "先取得工具事实，再生成必须含真实谱图的报告", tools: ["summarize_band_features", "calculate_weighted_metrics", "generate_screening_report", "generate_analysis_report", "generate_custom_html_deliverable"] },
  { id: "artifact_revision", pattern: /(@|修改|改成|调整|美化|换色|标题|坐标轴|图例|版式)/i, route: "锁定被引用交付物，只追加同一交付物的新版本", tools: ["generate_spectrum_chart", "generate_comparison_chart", "generate_analysis_report", "generate_custom_html_deliverable"] },
  { id: "data_export", pattern: /(导出|下载|csv|excel|xlsx)/i, route: "已有计算结果直接显示导出按钮，不创建预览物", tools: ["calculate_weighted_metrics"] },
  { id: "experiment_design", pattern: /(实验设计|下一步实验|测量方案|参数优化|材料设计|选材|制备建议)/i, route: "区分数据支持的结论与研究建议；不给虚构数值", tools: ["get_selected_spectrum_summaries", "summarize_band_features", "calculate_weighted_metrics"] },
];

export function detectResearchIntents(task = "") {
  const text = String(task).trim();
  const matched = intentCatalog.filter((intent) => intent.pattern.test(text)).map(({ pattern, ...intent }) => intent);
  return matched.length ? matched : [{ id: "conversation", route: "先理解并自然语言回答；没有明确生成动词就不创建交付物", tools: ["get_selected_spectrum_summaries"] }];
}

export function selectAgentSkills({ task = "", activeArtifact = null, files = [], requirements = {} } = {}) {
  const text = String(task).toLowerCase();
  const intents = detectResearchIntents(task);
  const skills = [{
    id: "intent-router",
    instruction: `本轮候选意图：${intents.map((intent) => intent.id).join("、")}。建议路由：${intents.map((intent) => `${intent.id}→${intent.route}`).join("；")}。候选工具：${[...new Set(intents.flatMap((intent) => intent.tools))].join("、")}。模型应结合对话判断，可选择只回答而不调用工具。`,
  }, {
    id: "context-memory",
    instruction: "本轮首先用 update_task_context 把对话中的波段和温度写入结构化记忆；理解省略回答和上文指代。用户在对话中确认或纠正单位时用 confirm_spectrum_meanings。确定性代码只校验结构和值域，不替模型解释自然语言。",
  }];

  if (files.some((file) => !file.confirmation)) {
    skills.push({
      id: "spectra-intake",
      instruction: "未确认文件可以被阅读、概括、作为范例讨论。只有真实绘图、换算、积分和物理结论才需要确认。把所有待确认文件合并成一次人工确认，不逐份追问。",
    });
  }
  if (intents.some((intent) => ["data_quality", "unit_semantics", "file_intake"].includes(intent.id))) {
    skills.push({
      id: "data-quality-audit",
      instruction: "先区分原始行值、换算后物理值和显示值。异常排查用 scan_raw_spectrum_rows 给出近似源行号与原始 X/Y；未经用户要求不要删除、平滑或截断数据。",
    });
  }
  if (intents.some((intent) => ["spectral_features", "comparison_screening", "experiment_design"].includes(intent.id))) {
    skills.push({
      id: "spectral-feature-analysis",
      instruction: "峰谷、均值、平台与趋势必须来自 summarize_band_features。比较材料前检查公共覆盖波段、单位、Y 含义和测试条件；只在可比范围内下结论。",
    });
  }
  if (intents.some((intent) => ["weighted_physics", "comparison_screening", "report_creation", "experiment_design"].includes(intent.id)) || requirements.bandText) {
    skills.push({
      id: "thermal-weighting",
      instruction: "加权值必须由 calculate_weighted_metrics 返回。波数先换算为 μm；nm 默认太阳 ASTM G173，μm/波数默认黑体。没有波段或所需温度时只追问缺失项，绝不估算。",
    });
  }
  if (intents.some((intent) => ["chart_creation", "comparison_screening"].includes(intent.id))) {
    skills.push({
      id: "scientific-figures",
      instruction: "只有用户明确要求生成图时才调用绘图工具。默认复现旧 Demo；多材料同图用 comparison 工具；图例置底、白色完整画布、真实波段阴影，图中数值只能来自计算工具。",
    });
  }
  if (intents.some((intent) => intent.id === "report_creation")) {
    skills.push({
      id: "scientific-reporting",
      instruction: "报告必须包含：数据与确认条件、由本机原始数据绘制的真实谱图、计算方法、结果、AI 解释、限制与假设。多材料筛选必须先算 Weighted，再用 generate_screening_report；单样品固定模板用 generate_analysis_report；自由版式用 document_type=report 的 custom HTML 工具。",
    });
  }
  if (activeArtifact?.isRevisionTarget) {
    skills.push({
      id: "artifact-revision",
      instruction: `当前严格修订目标是 ${activeArtifact.kind} / ${activeArtifact.filename}。只更新这一种交付物的下一版本；除非用户明确要求重新计算或数据/条件变化，不要创建其他图、报告、CSV 或 Excel。`,
    });
  }
  skills.push({
    id: "research-evidence-boundary",
    instruction: "把内容分成工具事实、AI 解释、研究建议和待确认项。不能把相关性写成机理证明，不能对未覆盖波段外推，不能把不同仪器/条件的数据直接当作严格可比。",
  });
  return skills.slice(0, 7);
}
