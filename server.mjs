import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { analyzeSpectrum, convertToMicrons, inferSpectrumMetadata, linearInterpolate, parseSpectrumText, planckRadianceMicron, trapezoidIntegral } from "./src/spectral-core.js";
import { selectAgentSkills } from "./src/agent-skills.js";
import { applyStructuredContextUpdate, mergeCalculationRequirements } from "./src/conversation-memory.js";
import { mandatoryCalculationQuestion } from "./src/agent-guards.js";
import { applyArtifactReplacements, readableArtifactHtml, taskExplicitlyEditsText, visibleArtifactText } from "./src/artifact-editor.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicWebMode = process.env.SPECTRA_MODE === "public";
const desktopRoot = path.resolve(process.env.SPECTRA_DESKTOP_ROOT ?? path.join(homedir(), "Desktop"));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? (publicWebMode ? "0.0.0.0" : "127.0.0.1");
const allowedExtensions = new Set([".csv", ".txt", ".tsv", ".dpt", ".xlsx"]);
const maxFileBytes = 20 * 1024 * 1024;
const temporaryDataTtlMs = 2 * 60 * 60 * 1000;
const uploadedFiles = new Map();
const generatedArtifacts = new Map();
const artifactDirectory = path.join(projectRoot, ".spectra-artifacts");
const legacyDemoPath = process.env.SPECTRA_LEGACY_DEMO_PATH ?? path.join(projectRoot, "assets", "光谱计算器（最终版）.html");

async function loadLegacyAstmg173() {
  try {
    const text = await readFile(legacyDemoPath, "utf8");
    const start = text.indexOf("Dn=[["), end = text.indexOf("],x3=", start);
    if (start < 0 || end < 0) throw new Error("未找到 ASTM G173 数据表。");
    // 仅解析用户提供的旧版离线 Demo 中的固定数值表；不执行其中任何脚本。
    const literal = text.slice(start + 3, end + 1).replace(/(^|[,[\s])\.(\d)/g, "$10.$2");
    const rows = JSON.parse(literal);
    return rows.filter((row) => Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]));
  } catch (error) {
    console.warn(`无法读取旧版 Demo 的 ASTM G173 表：${error.message}`);
    return [];
  }
}

const legacyAstmgG173 = await loadLegacyAstmg173();
const legacyAstmgPoints = legacyAstmgG173.map(([x, y]) => ({ x, y }));
const legacyAstmgWavelengths = legacyAstmgG173.map(([x]) => x);

function send(response, status, body, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", ...extraHeaders });
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) chunks.push(chunk);
  for (const chunk of chunks) total += chunk.length;
  if (total > 8 * 1024 * 1024) throw new Error("请求内容超过 8 MB。请减少图片数量或大小后重试。");
  const raw = Buffer.concat(chunks, total).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readUploadBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxFileBytes) throw new Error("上传文件超过 20 MB。\n".trim());
    chunks.push(chunk);
  }
  if (!total) throw new Error("上传文件为空。\n".trim());
  return Buffer.concat(chunks);
}

function resolveDesktopFile(relativePath) {
  if (publicWebMode) throw new Error("在线演示版只读取用户主动上传的文件，不会扫描电脑目录。");
  if (typeof relativePath !== "string" || !relativePath) throw new Error("请先选择一个桌面文件。");
  const resolved = path.resolve(desktopRoot, relativePath);
  const relative = path.relative(desktopRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("本地 Agent 只能读取已授权桌面目录中的文件。");
  }
  if (!allowedExtensions.has(path.extname(resolved).toLowerCase())) throw new Error("仅支持 CSV、TXT、TSV、DPT、XLSX 光谱文件。");
  return resolved;
}

function uploadedFile(reference) {
  const item = uploadedFiles.get(reference);
  if (!item) throw new Error("这份上传文件已过期；请重新上传。\n".trim());
  if (Date.now() - item.createdAt > temporaryDataTtlMs) {
    uploadedFiles.delete(reference);
    throw new Error("这份上传文件已在 2 小时后自动删除；请重新上传。");
  }
  return item;
}

function pruneTemporaryData() {
  const expiresBefore = Date.now() - temporaryDataTtlMs;
  for (const [reference, item] of uploadedFiles) if (item.createdAt < expiresBefore) uploadedFiles.delete(reference);
  for (const [id, artifact] of generatedArtifacts) if (artifact.createdAt < expiresBefore) generatedArtifacts.delete(id);
}

function validateDataReference(reference) {
  if (typeof reference === "string" && reference.startsWith("upload:")) return uploadedFile(reference);
  resolveDesktopFile(reference);
  return null;
}

async function findDesktopFiles(directory = desktopRoot, depth = 0, found = []) {
  if (depth > 4 || found.length >= 1000) return found;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await findDesktopFiles(candidate, depth + 1, found);
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      const details = await stat(candidate);
      if (details.size <= maxFileBytes) found.push({ path: path.relative(desktopRoot, candidate), name: entry.name, size: details.size });
    }
    if (found.length >= 1000) break;
  }
  return found;
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

function decodeXml(value) {
  return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
}

function columnNumber(reference = "") {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1]?.toUpperCase();
  return letters ? [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1 : -1;
}

function readXlsx(buffer) {
  const archive = unzipSync(new Uint8Array(buffer));
  const text = (name) => archive[name] ? strFromU8(archive[name]) : "";
  const workbook = text("xl/workbook.xml");
  const relations = text("xl/_rels/workbook.xml.rels");
  const relationId = /<sheet\b[^>]*\br:id="([^"]+)"/i.exec(workbook)?.[1];
  const target = relationId ? new RegExp(`<Relationship\\b(?=[^>]*\\bId="${relationId}")[^>]*\\bTarget="([^"]+)"`, "i").exec(relations)?.[1] : undefined;
  const worksheet = target ? path.posix.normalize(path.posix.join("xl", target)) : Object.keys(archive).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name)).sort()[0];
  if (!worksheet || !/^xl\/worksheets\/[^/]+\.xml$/i.test(worksheet)) throw new Error("XLSX 中没有可读取的首个工作表。");
  const sharedStrings = [...text("xl/sharedStrings.xml").matchAll(/<si[^>]*>([\s\S]*?)<\/si>/gi)].map((entry) => decodeXml([...entry[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gi)].map((textEntry) => textEntry[1]).join("")));
  const rows = [];
  for (const row of text(worksheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const values = ["", ""];
    let fallback = 0;
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = /\br="([^"]+)"/i.exec(cell[1])?.[1];
      const column = columnNumber(reference) >= 0 ? columnNumber(reference) : fallback;
      fallback = column + 1;
      if (column > 1) continue;
      const type = /\bt="([^"]+)"/i.exec(cell[1])?.[1];
      const value = /<v[^>]*>([\s\S]*?)<\/v>/i.exec(cell[2])?.[1] ?? "";
      const inline = [...cell[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gi)].map((entry) => entry[1]).join("");
      values[column] = type === "s" ? sharedStrings[Number(value)] ?? "" : type === "inlineStr" ? decodeXml(inline) : decodeXml(value);
    }
    rows.push(values);
  }
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  return { parsed: parseSpectrumText(csv), headerText: rows.slice(0, 8).flat().join(" ") };
}

async function inspectFile(relativePath) {
  const uploaded = validateDataReference(relativePath);
  const absolute = uploaded ? null : resolveDesktopFile(relativePath);
  const details = uploaded ? { size: uploaded.buffer.length } : await stat(absolute);
  if (details.size > maxFileBytes) throw new Error("文件超过 20 MB，本机 Agent 不会读取。`".replace("`", ""));
  const buffer = uploaded ? uploaded.buffer : await readFile(absolute);
  const extension = uploaded ? path.extname(uploaded.name).toLowerCase() : path.extname(absolute).toLowerCase();
  const source = extension === ".xlsx"
    ? readXlsx(buffer)
    : (() => { const content = decodeText(buffer); return { parsed: parseSpectrumText(content), headerText: content.split(/\r?\n/).slice(0, 8).join(" ") }; })();
  const name = uploaded ? uploaded.name : path.basename(absolute);
  const metadata = inferSpectrumMetadata({ fileName: name, headerText: source.headerText, points: source.parsed.points });
  return {
    file: { path: relativePath, name, size: details.size, origin: uploaded ? "upload" : "desktop" },
    parsed: source.parsed,
    headerText: String(source.headerText ?? "").slice(0, 1200),
    metadata,
    analysis: analyzeSpectrum(source.parsed.points, metadata.wavelength.unit),
  };
}

function uniqueApprovedPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error("请至少选择一个桌面光谱文件。\n".trim());
  if (paths.length > 30) throw new Error("一次最多分析 30 个文件，请分批处理。\n".trim());
  return [...new Set(paths)].map((item) => {
    if (typeof item !== "string") throw new Error("文件路径格式不正确。\n".trim());
    validateDataReference(item);
    return item;
  });
}

function buildTaskPlan({ task = "", files = [] }) {
  const text = String(task).trim();
  const asksComparison = /比较|对比|差异|排序|筛选|最佳|最好/.test(text);
  const asksChart = /图|曲线|可视化|绘图/.test(text);
  const asksReport = /报告|总结|结论|论文|汇报/.test(text);
  const asksTable = /表格|csv|数据表|导出数据/.test(text);
  const deliverables = [
    ...(asksChart || asksComparison ? ["可下载的对比谱图 SVG"] : []),
    ...(asksTable || asksComparison ? ["样品覆盖范围与数据质量汇总表"] : []),
    ...(asksReport || (!asksChart && !asksTable) ? ["可编辑的分析说明 / 报告"] : []),
  ];
  const sourceKinds = new Set(files.map((file) => file.confirmation?.unit ?? file.metadata.wavelength.unit));
  const questions = [];
  if (![...files].every((file) => file.confirmation)) questions.push("请逐个确认每个文件的横坐标单位、Y 值含义和比例/百分比。");
  if (sourceKinds.size > 1) questions.push("这批数据混有 nm、μm 或波数。建议先分别计算，再由 Agent 汇总对比，避免混用太阳与黑体权重。");
  if (!text) questions.push("请说明你真正想得到的结论或交付物，例如“筛选 8–13 μm 发射率最高的样品，并生成汇报用的三张图”。");
  return {
    task: text || "尚未描述任务",
    fileCount: files.length,
    deliverables,
    steps: ["读取与清洗每个文件的前两列数据", "依据每个文件的确认信息统一单位并检查覆盖范围", asksComparison ? "建立可比较的公共波段并输出差异" : "根据任务选择绘图、积分或数据摘要", "生成可下载成果，并记录假设与不能外推的范围"],
    questions,
    modelInputPolicy: "模型只接收文件摘要、确认信息和计算结果；原始桌面文件始终由本机工具读取。",
  };
}

function parseBandRanges(text) {
  const matches = String(text ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|~|到)\s*(\d+(?:\.\d+)?)/g);
  const bands = [...matches].map((match) => ({ minMicrons: Math.min(Number(match[1]), Number(match[2])), maxMicrons: Math.max(Number(match[1]), Number(match[2])) }))
    .filter((band) => Number.isFinite(band.minMicrons) && Number.isFinite(band.maxMicrons) && band.minMicrons < band.maxMicrons);
  return bands.filter((band, index) => !bands.slice(0, index).some((item) => item.minMicrons === band.minMicrons && item.maxMicrons === band.maxMicrons));
}

function physicalPoints(file) {
  const unit = file.confirmation.unit;
  const valueScale = file.confirmation.valueUnit === "percent" ? 0.01 : 1;
  return file.parsed.points.map((point) => ({ x: convertToMicrons(point.x, unit), y: point.y * valueScale }))
    .filter((point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y)).sort((left, right) => left.x - right.x);
}

function weightedResult(points, band, weightAt, supportPoints = []) {
  if (band.minMicrons < points[0].x || band.maxMicrons > points.at(-1).x) return { error: "不适用：超出样品测量范围" };
  const grid = [...new Set([band.minMicrons, band.maxMicrons, ...points.map((point) => point.x).filter((x) => x > band.minMicrons && x < band.maxMicrons), ...supportPoints.filter((x) => x > band.minMicrons && x < band.maxMicrons)])].sort((left, right) => left - right);
  const weights = grid.map(weightAt);
  const numerator = trapezoidIntegral(grid, grid.map((x, index) => linearInterpolate(x, points) * weights[index]));
  const denominator = trapezoidIntegral(grid, weights);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return { error: "不适用：该波段辐射权重不足" };
  return { value: numerator / denominator, gridCount: grid.length };
}

function calculateWeightedMetrics(files, { bands, source = "auto", temperatures = [] }) {
  const requestedBands = parseBandRanges(bands);
  if (!requestedBands.length) throw new Error("请提供波段，例如 3-5；8-12（单位 μm）。");
  const cleanTemperatures = [...new Set((Array.isArray(temperatures) ? temperatures : String(temperatures ?? "").split(/[，,;；\s]+/)).map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 5000))];
  const rows = [];
  for (const file of files) {
    const points = physicalPoints(file);
    const effectiveSource = source === "auto" ? (file.confirmation.unit === "nm" ? "solar" : "blackbody") : source;
    if (effectiveSource === "blackbody" && !cleanTemperatures.length) throw new Error("黑体辐射需要温度（K），例如 300 或 300, 500。");
    if (effectiveSource === "solar" && !legacyAstmgG173.length) throw new Error("本机没有加载旧版 Demo 的 ASTM G173 数据，无法按 Demo 计算太阳加权值。");
    for (const band of requestedBands) {
      const cases = effectiveSource === "solar" ? [{ label: "ASTM G173 AM1.5G", weightAt: (x) => linearInterpolate(x, legacyAstmgPoints), support: legacyAstmgWavelengths }] : cleanTemperatures.map((temperature) => ({ label: `${temperature}K`, weightAt: (x) => planckRadianceMicron(x, temperature), support: [] }));
      for (const item of cases) {
        if (effectiveSource === "solar" && (band.minMicrons < legacyAstmgG173[0][0] || band.maxMicrons > legacyAstmgG173.at(-1)[0])) {
          rows.push({ file: file.file.name, source: item.label, band, value: null, error: "不适用：超出 ASTM G173 数据范围" });
          continue;
        }
        const result = weightedResult(points, band, item.weightAt, item.support);
        rows.push({ file: file.file.name, source: item.label, band, value: result.value ?? null, error: result.error ?? null, gridCount: result.gridCount });
      }
    }
  }
  return rows;
}

function weightedResultsReport(rows) {
  const table = rows.map((row) => `<tr><td>${escapeXml(row.file)}</td><td>${escapeXml(row.source)}</td><td>${row.band.minMicrons}–${row.band.maxMicrons} μm</td><td>${row.error ? escapeXml(row.error) : row.value.toFixed(4)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>加权物理指标</title><style>body{max-width:1100px;margin:42px auto;padding:0 24px;font:16px/1.7 Inter,Arial,"PingFang SC";color:#172033}h1{color:#172554}table{width:100%;border-collapse:collapse}th,td{padding:11px;border:1px solid #d8e1ef;text-align:left}th{background:#f3f7ff}</style><h1>加权物理指标</h1><p>计算方法与原始光谱计算器一致：在样品点、波段边界及 ASTM G173 支撑点的并集上插值，再进行梯形积分。</p><table><thead><tr><th>样品</th><th>辐射源</th><th>波段</th><th>Weighted 平均值</th></tr></thead><tbody>${table}</tbody></table></html>`;
}

function weightedRowsForExport(rows) {
  // 加入单位并使用短横线以外的字符，避免 Excel/Numbers 把 3-6 自动解析为 3 月 6 日。
  return [["样品", "辐射源", "波段（μm）", "Weighted 平均值", "说明"], ...rows.map((row) => [row.file, row.source, `${row.band.minMicrons}–${row.band.maxMicrons} μm`, row.error ? "" : row.value.toFixed(4), row.error ?? ""])];
}

function csvEscape(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

function weightedCsv(rows) {
  return `\uFEFF${weightedRowsForExport(rows).map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
}

function xmlEscape(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }

function weightedXlsx(rows) {
  const sheetRows = weightedRowsForExport(rows).map((row, index) => `<row r="${index + 1}">${row.map((value, column) => typeof value === "number" ? `<c r="${String.fromCharCode(65 + column)}${index + 1}"><v>${value}</v></c>` : `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`).join("")}</row>`).join("");
  const archive = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Weighted 结果" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(archive, { level: 6 }));
}

function aiFileSummary(file) {
  return {
    reference: file.file.path,
    name: file.file.name,
    pointCount: file.analysis.validPointCount,
    wavelengthUnit: file.confirmation?.unit ?? file.metadata.wavelength.unit,
    valueType: file.confirmation?.valueType ?? file.metadata.valueType,
    valueUnit: file.confirmation?.valueUnit ?? file.metadata.valueUnit,
    rangeMicron: file.analysis.rangeUm.map((value) => Number(value.toPrecision(6))),
    warnings: file.analysis.warnings.slice(0, 4),
  };
}

function resolveModelProvider({ provider = "deepseek", endpoint = "", model = "" }) {
  if (provider === "deepseek") return { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: model || "deepseek-v4-flash" };
  if (provider === "compatible") {
    if (process.env.SPECTRA_ALLOW_CUSTOM_PROVIDER === "0") throw new Error("公开部署未开放自定义模型服务，请选择已支持的服务商。\n".trim());
    let url;
    try { url = new URL(endpoint); } catch { throw new Error("兼容服务地址不是有效 URL。\n".trim()); }
    if (url.protocol !== "https:" || !url.hostname || /^(localhost|127\.|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) throw new Error("兼容服务地址必须是公开 HTTPS 地址。\n".trim());
    return { label: "兼容服务", endpoint: url.toString(), model: model || "default" };
  }
  throw new Error("不支持的模型服务商。\n".trim());
}

function requireSafeApiKey(apiKey, provider) {
  const key = String(apiKey ?? "").trim();
  if (key.length < 12) throw new Error("请输入完整的模型 API Key。\n".trim());
  if (/[^\x21-\x7e]/.test(key) || /\s/.test(key)) throw new Error("API Key 中包含中文、空格或换行。请只粘贴 Key 本身，不要包含“API Key：”等文字。\n".trim());
  if (provider === "deepseek" && !/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error("DeepSeek API Key 应以 sk- 开头。请在 AI 设置中重新粘贴平台生成的 Key。\n".trim());
  return key;
}

function modelConnectionError(error, providerLabel) {
  const code = error?.cause?.code;
  if (code === "ECONNRESET") return new Error(`无法连接 ${providerLabel}：本机到服务的安全网络连接被中途重置。请检查 VPN、代理、校园/公司网络限制，或切换网络后重试。`);
  if (code === "ENOTFOUND") return new Error(`无法连接 ${providerLabel}：找不到服务地址。请检查网络或 DNS 设置。`);
  if (code === "ETIMEDOUT" || error?.name === "TimeoutError") return new Error(`连接 ${providerLabel} 超时。请检查网络后重试。`);
  return new Error(`无法连接 ${providerLabel}。请检查网络、代理或 VPN 后重试。`);
}

async function fetchModelWithRetry(endpoint, options, { timeoutMs = 120_000, attempts = 2, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const transientStatus = [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (!transientStatus || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => {});
      onRetry({ attempt, reason: `模型服务暂时返回 ${response.status}` });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      onRetry({ attempt, reason: error?.name === "TimeoutError" ? "模型响应超时" : "网络连接中断" });
    }
    await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
  }
  throw lastError ?? new Error("模型请求失败。");
}

async function askDeepSeekForPlan({ apiKey, provider, endpoint, model, task, files, localPlan }) {
  const key = requireSafeApiKey(apiKey, provider);
  const selectedProvider = resolveModelProvider({ provider, endpoint, model });
  const payload = {
    task: String(task ?? "").slice(0, 4000),
    files: files.map(aiFileSummary),
    localPlan: { deliverables: localPlan.deliverables, steps: localPlan.steps, questions: localPlan.questions },
  };
  let response;
  try {
    response = await fetch(selectedProvider.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: selectedProvider.model,
        stream: false,
        messages: [
          { role: "system", content: "你是严谨的材料光谱分析 Agent 规划助手。原始文件只在用户电脑，本次只给你数据摘要。不要虚构数值、单位、实验结论或已执行的计算。请用中文简洁的自然段和短列表输出，不要使用 Markdown 标记字符。内容包括：任务理解、建议步骤、交付物、必要澄清问题、数据限制与假设。若 nm、μm、波数混合，明确要求分源计算。" },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) { throw modelConnectionError(error, selectedProvider.label); }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const providerMessage = String(details?.error?.message ?? "").replace(/sk-[\w-]+/gi, "[已隐藏]").slice(0, 280);
    throw new Error(`${selectedProvider.label} 调用失败（${response.status}）：${providerMessage || "请检查 Key、余额和网络。"}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 没有返回可用的任务计划，请稍后重试。\n".trim());
  return { advice: content.trim(), model: selectedProvider.model, usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : null };
}

const unitLabels = { um: "微米（μm）", nm: "纳米（nm）", wavenumber: "波数（cm⁻¹）" };
const valueTypes = new Set(["reflectance", "emissivity", "transmission", "absorption"]);
const valueUnits = new Set(["ratio", "percent"]);

function parseModelJson(text) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回可读取的单位判断。");
  return JSON.parse(raw.slice(start, end + 1));
}

async function askModelForUnitInference({ apiKey, provider, endpoint, model, files }) {
  const key = requireSafeApiKey(apiKey, provider);
  const selectedProvider = resolveModelProvider({ provider, endpoint, model });
  const payload = files.map((file) => ({
    reference: file.file.path,
    name: file.file.name,
    localGuess: {
      wavelengthUnit: file.metadata.wavelength.unit,
      valueType: file.metadata.valueType,
      valueUnit: file.metadata.valueUnit,
      reason: file.metadata.wavelength.reason,
    },
    xRange: file.parsed.points.length ? [file.parsed.points[0].x, file.parsed.points.at(-1).x] : [],
    yRange: file.analysis.yRange,
    headerText: file.headerText,
    firstPoints: file.parsed.points.slice(0, 12),
  }));
  let response;
  try {
    response = await fetch(selectedProvider.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: selectedProvider.model,
        stream: false,
        messages: [
          { role: "system", content: "你是谨慎的光谱数据单位识别助手。根据文件名、前两列前 12 个点、范围和本地初判，猜测横坐标是 um、nm 还是 wavenumber，Y 值类型与数值尺度是 ratio 或 percent。不能根据样品厚度中的 nm 误判横坐标。0–20 通常是 um；几百或几千可能是 nm 或 cm⁻¹，必须结合文件名/表头和范围。只返回严格 JSON：{\"files\":[{\"reference\":\"...\",\"wavelengthUnit\":\"um|nm|wavenumber\",\"valueType\":\"reflectance|emissivity|transmission|absorption\",\"valueUnit\":\"ratio|percent\",\"confidence\":\"high|medium|low\",\"reason\":\"不超过80字的中文理由\"}]}。这是待用户确认的建议，不是最终结论。" },
          { role: "user", content: JSON.stringify({ files: payload }) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) { throw modelConnectionError(error, selectedProvider.label); }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const providerMessage = String(details?.error?.message ?? "").replace(/sk-[\w-]+/gi, "[已隐藏]").slice(0, 280);
    throw new Error(`${selectedProvider.label} 单位初判失败（${response.status}）：${providerMessage || "请检查 Key、余额和网络。"}`);
  }
  const data = await response.json();
  const decoded = parseModelJson(data?.choices?.[0]?.message?.content);
  const byReference = new Map((Array.isArray(decoded.files) ? decoded.files : []).map((item) => [item?.reference, item]));
  return files.map((file) => {
    const item = byReference.get(file.file.path) ?? {};
    const wavelengthUnit = unitLabels[item.wavelengthUnit] ? item.wavelengthUnit : file.metadata.wavelength.unit;
    const valueType = valueTypes.has(item.valueType) ? item.valueType : file.metadata.valueType;
    const valueUnit = valueUnits.has(item.valueUnit) ? item.valueUnit : file.metadata.valueUnit;
    return {
      path: file.file.path,
      wavelengthUnit,
      valueType,
      valueUnit,
      confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "low",
      reason: String(item.reason ?? "模型未给出额外理由，保留本地初判。").slice(0, 160),
      analysis: analyzeSpectrum(file.parsed.points, wavelengthUnit),
    };
  });
}

async function askModelForSessionGuide({ apiKey, provider, endpoint, model, phase = "intake", userMessage = "", missingDetails = "", requirements = {}, files = [] }) {
  const key = requireSafeApiKey(apiKey, provider);
  const selectedProvider = resolveModelProvider({ provider, endpoint, model });
  const phases = {
    welcome: "刚进入会话。请自然地欢迎用户，并请其上传文件或说出桌面文件名；不要虚构已经读取文件。",
    intake: "刚读取文件、尚未由用户确认单位。解释你的初判和不确定性，提醒用户在确认卡中核对；不要要求波段或温度。",
    confirmed: "文件刚刚全部确认。根据单位说明接下来的辐射源规则，并只询问波段（μm）；不要先问黑体温度。",
    "need-input": "用户刚回答或提出分析任务，但仍缺少必要条件。请准确理解用户自然语言中的波段；只追问 missingDetails 中指定的那一项，不能重问已有条件。",
  };
  let response;
  try {
    response = await fetch(selectedProvider.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: selectedProvider.model,
        stream: false,
        messages: [
          { role: "system", content: "你是光谱计算 Agent 的对话前台。你从会话开始就参与理解用户，但受控本地工具才可以读文件和计算。请用自然、简洁的中文回答，最多三小段，不用 Markdown 标记。只陈述提供的文件摘要、确认条件和本次阶段允许的信息；不编造数值或说已经计算。" },
          { role: "user", content: JSON.stringify({ phaseInstruction: phases[phase] ?? phases.intake, userMessage: String(userMessage).slice(0, 2000), missingDetails, confirmedConditions: { bandsMicron: requirements.bandText || "", blackbodyTemperaturesKelvin: requirements.temperatureText || requirements.temperatureKelvin || "" }, files: files.map(aiFileSummary) }) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) { throw modelConnectionError(error, selectedProvider.label); }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const providerMessage = String(details?.error?.message ?? "").replace(/sk-[\w-]+/gi, "[已隐藏]").slice(0, 280);
    throw new Error(`${selectedProvider.label} 对话引导失败（${response.status}）：${providerMessage || "请检查 Key、余额和网络。"}`);
  }
  const data = await response.json();
  const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("模型没有返回会话引导内容。");
  return { answer, model: selectedProvider.model };
}

async function askModelForContextInterpretation({ key, selectedProvider, task = "", conversation = [], requirements = {}, fileInterpretations = [], files = [] }) {
  const response = await fetch(selectedProvider.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: selectedProvider.model,
      stream: false,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是光谱 Agent 的上下文解析器。结合当前消息、最近对话、上一轮追问和 AI 单位初判，提取用户明确给出或可由上下文唯一确定的计算条件。上一轮询问温度后用户只答‘300’，表示 300 K；‘3到5还有9到12’表示两个 μm 波段；样品名中的 50 nm、150 nm 通常是厚度，不能当横轴单位。只有用户明确确认或纠正文件含义时才填写 confirmations；不确定则留空，不能猜。只返回 JSON：{\"bandsMicron\":[{\"min\":3,\"max\":5}],\"temperaturesKelvin\":[300],\"confirmations\":[{\"file_reference\":\"...\",\"wavelength_unit\":\"um|nm|wavenumber\",\"value_type\":\"reflectance|emissivity|transmission|absorption\",\"value_unit\":\"ratio|percent\",\"opaque\":false}],\"interpretation\":\"不超过80字的公开理解摘要\"}。没有新增信息的字段返回空数组。" },
        { role: "user", content: JSON.stringify({ currentUserMessage: String(task).slice(0, 4000), currentRequirements: requirements, recentConversation: conversation.slice(-30), aiUnitSuggestionsAwaitingUserConfirmation: fileInterpretations }) },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const providerMessage = String(details?.error?.message ?? "").replace(/sk-[\w-]+/gi, "[已隐藏]").slice(0, 280);
    throw new Error(`${selectedProvider.label} 上下文理解失败（${response.status}）：${providerMessage || "请检查模型兼容性。"}`);
  }
  const data = await response.json();
  const decoded = parseModelJson(data?.choices?.[0]?.message?.content);
  const nextRequirements = applyStructuredContextUpdate(requirements, { bandsMicron: decoded.bandsMicron, temperaturesKelvin: decoded.temperaturesKelvin });
  const allowedPaths = new Set(files.map((file) => file.file.path));
  const allowedUnits = new Set(["um", "nm", "wavenumber"]), allowedTypes = new Set(["reflectance", "emissivity", "transmission", "absorption"]), allowedScales = new Set(["ratio", "percent"]);
  const confirmations = (Array.isArray(decoded.confirmations) ? decoded.confirmations : []).map((candidate) => {
    if (!allowedPaths.has(candidate?.file_reference) || !allowedUnits.has(candidate?.wavelength_unit) || !allowedTypes.has(candidate?.value_type) || !allowedScales.has(candidate?.value_unit)) return null;
    return { path: candidate.file_reference, unit: candidate.wavelength_unit, valueType: candidate.value_type, valueUnit: candidate.value_unit, opaque: candidate.opaque === true };
  }).filter(Boolean);
  return { requirements: nextRequirements, confirmations, interpretation: safeArtifactText(decoded.interpretation, "AI 已检查本轮单位、波段和温度上下文。", 80), usage: data.usage ?? null };
}

const agentTools = [
  { type: "function", function: { name: "update_task_context", description: "把模型结合当前消息和最近对话理解出的计算条件写入任务记忆。用户说出、补充、纠正或用上下文指代波段/温度时必须先调用；例如上一轮刚询问黑体温度，用户只回答“300”，应记录为 300 K。不要从样品名中的 50 nm、150 nm 厚度推断计算条件。", parameters: { type: "object", properties: { bands_micron: { type: "array", items: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } }, required: ["min", "max"] }, description: "用户要求计算或框选的一个或多个 μm 波段。未提及则省略。" }, temperatures_kelvin: { type: "array", items: { type: "number" }, description: "用户指定的一个或多个黑体温度 K。未提及则省略。" }, interpretation: { type: "string", description: "不超过80字的公开解释，说明理解了什么，不展示私密推理。" } } } } },
  { type: "function", function: { name: "confirm_spectrum_meanings", description: "当用户在对话中确认或纠正一份或多份文件的横轴单位、Y物理量和数值尺度时调用。可以根据最近对话理解“是的”“都对”“第一个是波数，第二个是微米”；但不确定时必须询问，不能擅自确认。", parameters: { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { file_reference: { type: "string" }, wavelength_unit: { type: "string", enum: ["um", "nm", "wavenumber"] }, value_type: { type: "string", enum: ["reflectance", "emissivity", "transmission", "absorption"] }, value_unit: { type: "string", enum: ["ratio", "percent"] }, opaque: { type: "boolean" } }, required: ["file_reference", "wavelength_unit", "value_type", "value_unit"] } }, interpretation: { type: "string", description: "不超过80字的公开确认摘要。" } }, required: ["files"] } } },
  { type: "function", function: { name: "get_selected_spectrum_summaries", description: "获取用户已授权并选中的光谱文件摘要。用于确认文件、单位、范围和数据质量；不会返回原始数据。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "scan_raw_spectrum_rows", description: "在用户授权的原始数据中扫描或定位行。用于回答“哪一行超过 100%”“最大值在哪里”“把前几行给我看”等问题；可在单位尚未确认时调用，返回原始 X/Y 与近似源文件行号。", parameters: { type: "object", properties: { file_reference: { type: "string" }, mode: { type: "string", enum: ["above", "below", "largest", "first"], description: "above/ below 按 Y 阈值筛选；largest 返回最大 Y 行；first 返回最前几行。" }, threshold: { type: "number", description: "above 或 below 的 Y 原始数值阈值，例如 100。" }, limit: { type: "number", description: "最多返回 30 行。" } }, required: ["file_reference"] } } },
  { type: "function", function: { name: "get_legacy_demo_contract", description: "读取本机旧版光谱 Demo 的计算和绘图约定摘要：单位换算、百分比缩放、默认坐标范围、波段阴影、Weighted 积分规则。用于解释或让新图复现 Demo。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_local_analysis_plan", description: "获取本地规则层生成的分析计划、建议交付物与必须追问的问题。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_current_artifact", description: "读取用户当前点名或正在预览的交付物当前版本。修改现有 HTML 或网页前必须先调用。返回现有 HTML、可见正文和版本信息；大型 SVG 曲线数据会折叠，但其标签属性和外层布局仍可编辑。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "patch_current_html_artifact", description: "对刚读取的现有 HTML 做精确局部替换，并保存为同一交付物的下一版本。不能用整份新 HTML 覆盖旧内容。用户只要求改图片、尺寸、颜色或排版时，工具会校验正文完全不变。", parameters: { type: "object", properties: { replacements: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: { find: { type: "string", description: "从 read_current_artifact 返回内容中复制的、能在原 HTML 中唯一定位的短片段。" }, replace: { type: "string", description: "替换后的短片段。" }, replace_all: { type: "boolean", description: "只有确实要替换全部相同片段时设为 true。" } }, required: ["find", "replace"] } }, summary: { type: "string", description: "不超过80字，准确说明只改了哪些局部项目。" } }, required: ["replacements"] } } },
  { type: "function", function: { name: "summarize_band_features", description: "确定性计算指定样品在一个或多个 μm 波段内的均值、最小值、最大值、极值位置和端点变化。用于回答峰谷、平台、趋势、材料差异、波段表现等科研问题；不会生成交付物。", parameters: { type: "object", properties: { file_reference: { type: "string", description: "来自文件摘要的 reference。" }, bands: { type: "string", description: "可选的 μm 波段，例如 3-5；8-12。未提供时总结完整测量范围。" } }, required: ["file_reference"] } } },
  { type: "function", function: { name: "generate_spectrum_chart", description: "为已授权且已确认的单个光谱文件生成可下载 SVG 谱图。默认复现旧版光谱计算器的 Plotly 白底、浅蓝网格、坐标轴和线条风格。用户要求图片、谱图、曲线，或要求修改现有谱图时调用。", parameters: { type: "object", properties: { file_reference: { type: "string", description: "来自文件摘要的 reference。" }, title: { type: "string", description: "可选：图标题，最多 80 个字。" }, style: { type: "object", description: "可选：在数据不变前提下可修改任何列出的视觉项。", properties: { line_color: { type: "string" }, line_width: { type: "number" }, line_dash: { type: "string", enum: ["solid", "dash", "dot", "dashdot"] }, opacity: { type: "number" }, show_markers: { type: "boolean" }, marker_size: { type: "number" }, fill: { type: "string", enum: ["none", "tozeroy"] }, background_color: { type: "string" }, font_color: { type: "string" }, grid_color: { type: "string" }, axis_color: { type: "string" }, x_label: { type: "string" }, y_label: { type: "string" }, display_unit: { type: "string", enum: ["um", "nm", "wavenumber"] }, x_min: { type: "number" }, x_max: { type: "number" }, y_min: { type: "number" }, y_max: { type: "number" }, bands: { type: "string" }, metric_note: { type: "string", description: "仅填写已由 calculate_weighted_metrics 返回的最终 Weighted 数值说明，会标在图中。" }, show_grid: { type: "boolean" }, width: { type: "number" }, height: { type: "number" } } } }, required: ["file_reference"] } } },
  { type: "function", function: { name: "generate_comparison_chart", description: "将多个已确认材料画在同一张谱图中进行真实数据对比。只在用户明确要求同图比较、叠加多条曲线或生成对比图时调用。", parameters: { type: "object", properties: { file_references: { type: "array", items: { type: "string" }, description: "至少两个来自文件摘要的 reference。" }, title: { type: "string" }, style: { type: "object", description: "可选视觉设置；与单条谱图相同，默认延用旧 Demo。", properties: { display_unit: { type: "string", enum: ["um", "nm", "wavenumber"] }, bands: { type: "string" }, metric_note: { type: "string", description: "仅填写已计算的 Weighted 数值说明。" }, line_width: { type: "number" }, background_color: { type: "string" }, grid_color: { type: "string" }, axis_color: { type: "string" }, x_label: { type: "string" }, y_label: { type: "string" }, width: { type: "number" }, height: { type: "number" } } } }, required: ["file_references"] } } },
  { type: "function", function: { name: "generate_analysis_report", description: "为已授权且已确认的单个光谱文件生成可下载 HTML 分析报告。用户要求报告，或要求修改现有报告的标题、重点、配色、版式时调用。", parameters: { type: "object", properties: { file_reference: { type: "string", description: "来自文件摘要的 reference。" }, title: { type: "string", description: "可选：报告标题，最多 80 个字。" }, focus: { type: "string", description: "可选：用户希望在报告中强调的角度，例如答辩用、数据质量、8–13 μm。最多 160 个字。" }, style: { type: "object", description: "可选：报告外观与结构。", properties: { accent_color: { type: "string", description: "主题色，六位十六进制。" }, layout: { type: "string", enum: ["brief", "standard", "presentation"], description: "精简、标准或答辩展示版式。" }, summary: { type: "string", description: "用户希望放在开头的摘要或说明。" } } } }, required: ["file_reference"] } } },
  { type: "function", function: { name: "generate_custom_html_deliverable", description: "生成用户指定结构与视觉的独立 HTML 网页交付物，例如自定义科研报告、答辩单页、项目页面、摘要卡片页、实验记录页。HTML 只能包含从工具确认的事实，不能包含脚本、外链或虚构数值。document_type=report 时，本机工具会强制加入由原始数据绘制的真实谱图。", parameters: { type: "object", properties: { file_reference: { type: "string", description: "来自文件摘要的 reference。" }, filename: { type: "string", description: "输出文件名，不含路径。" }, document_type: { type: "string", enum: ["report", "webpage"], description: "科研分析报告必须填 report；其他独立网页填 webpage。" }, html_body: { type: "string", description: "完整的 body 内 HTML 和内联样式，不含 script/iframe。报告中可以写 {{SPECTRUM_CHART}} 指定真实谱图位置；未写则自动追加。最多 18000 个字符。" } }, required: ["file_reference", "document_type", "html_body"] } } },
  { type: "function", function: { name: "calculate_weighted_metrics", description: "按旧版光谱计算器的梯形积分逻辑计算 Weighted 平均值。波数会先转成 μm；纳米样品默认用 ASTM G173 AM1.5G，微米/波数样品默认用黑体辐射。用户请求加权值、太阳/黑体加权、3-5 或 8-12 μm 指标时必须调用。", parameters: { type: "object", properties: { bands: { type: "string", description: "波段，单位 μm，例如 3-5；8-12。" }, source: { type: "string", enum: ["auto", "solar", "blackbody"], description: "默认 auto：nm→太阳；μm/波数→黑体。" }, temperatures: { type: "array", items: { type: "number" }, description: "黑体温度（K）；黑体模式必填，例如 [300,500]。" } }, required: ["bands"] } } },
];

function saveGeneratedArtifact({ filename, content, contentType, kind, plotly = null }) {
  const id = randomUUID();
  const artifact = { filename, content, contentType, kind: kind ?? (filename.endsWith(".svg") ? "chart" : "report"), plotly, createdAt: Date.now() };
  if (!publicWebMode) {
    mkdirSync(artifactDirectory, { recursive: true });
    const binary = Buffer.isBuffer(content);
    writeFileSync(path.join(artifactDirectory, `${id}.content`), content, binary ? undefined : "utf8");
    writeFileSync(path.join(artifactDirectory, `${id}.json`), JSON.stringify({ filename, contentType, kind: artifact.kind, plotly, binary, createdAt: artifact.createdAt }), "utf8");
  }
  generatedArtifacts.set(id, artifact);
  pruneTemporaryData();
  while (generatedArtifacts.size > 80) generatedArtifacts.delete(generatedArtifacts.keys().next().value);
  return { id, filename, kind: artifact.kind, url: `/api/artifacts/${id}` };
}

function loadGeneratedArtifact(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const cached = generatedArtifacts.get(id);
  if (cached) return cached;
  if (publicWebMode) return null;
  const metadataPath = path.join(artifactDirectory, `${id}.json`);
  const contentPath = path.join(artifactDirectory, `${id}.content`);
  if (!existsSync(metadataPath) || !existsSync(contentPath)) return null;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (typeof metadata.filename !== "string" || typeof metadata.contentType !== "string") return null;
    const artifact = { ...metadata, content: metadata.binary ? readFileSync(contentPath) : readFileSync(contentPath, "utf8") };
    generatedArtifacts.set(id, artifact);
    return artifact;
  } catch { return null; }
}

function parseToolArguments(call) {
  try { return JSON.parse(call.function?.arguments || "{}"); } catch { return {}; }
}

function safeArtifactText(value, fallback, maxLength) {
  const text = String(value ?? "").replace(/[<>]/g, "").trim().slice(0, maxLength);
  return text || fallback;
}

function safeChartColor(value) {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
}

function safeCustomHtml(value) {
  return String(value ?? "").slice(0, 18_000)
    .replace(/<\/?(?:script|iframe|object|embed|link|meta|base)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:javascript|data):/gi, "");
}

function safeNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function chartStyleFromArgs(args, file) {
  const style = args.style && typeof args.style === "object" ? args.style : {};
  const unit = ["um", "nm", "wavenumber"].includes(style.display_unit) ? style.display_unit : file.confirmation.unit === "wavenumber" ? "um" : file.confirmation.unit;
  const label = unit === "nm" ? "波长（nm）" : unit === "wavenumber" ? "波数（cm⁻¹）" : "波长（μm）";
  return {
    lineColor: safeChartColor(style.line_color ?? args.line_color),
    lineWidth: safeNumber(style.line_width, 2, 1, 8),
    backgroundColor: safeChartColor(style.background_color || "#fbfcff"),
    fontColor: safeChartColor(style.font_color || "#334155"),
    gridColor: safeChartColor(style.grid_color || "#e7edf6"),
    axisColor: safeChartColor(style.axis_color || "#94a3b8"),
    xLabel: safeArtifactText(style.x_label, label, 60),
    // 旧版 Demo 会把百分比导入值转为 0–1 后再绘图与积分，因此默认轴也固定显示 0–1。
    yLabel: safeArtifactText(style.y_label, "反射率（0–1）", 60),
    displayUnit: unit,
    bands: parseBandRanges(style.bands),
    showGrid: style.show_grid !== false,
    width: safeNumber(style.width, 800, 500, 1600),
    height: safeNumber(style.height, 500, 360, 1200),
    xMin: safeNumber(style.x_min, 0, -1_000_000, 1_000_000),
    xMax: safeNumber(style.x_max, 20, -1_000_000, 1_000_000),
    yMin: safeNumber(style.y_min, 0, -100, 100),
    yMax: safeNumber(style.y_max, 1, -100, 100),
    lineDash: ["solid", "dash", "dot", "dashdot"].includes(style.line_dash) ? style.line_dash : "solid",
    opacity: safeNumber(style.opacity, 1, 0.05, 1),
    showMarkers: style.show_markers === true,
    markerSize: safeNumber(style.marker_size, 5, 2, 14),
    fill: style.fill === "tozeroy" ? "tozeroy" : "none",
    metricNote: safeArtifactText(style.metric_note, "", 220),
  };
}

function weightedMetricNote(rows) {
  const valid = rows.filter((row) => Number.isFinite(row.value)).slice(0, 4);
  if (!valid.length) return "Weighted：不适用（见计算结果）";
  return valid.map((row) => `Weighted ${row.source}，${row.band.minMicrons}–${row.band.maxMicrons} μm = ${row.value.toFixed(4)}`).join("\n");
}

function summarizeBandFeatures(file, bandsText = "") {
  const points = physicalPoints(file);
  const requested = parseBandRanges(bandsText);
  const bands = requested.length ? requested : [{ minMicrons: points[0].x, maxMicrons: points.at(-1).x }];
  return bands.map((band) => {
    if (band.minMicrons < points[0].x || band.maxMicrons > points.at(-1).x) return { band, error: "不适用：超出样品测量范围" };
    const grid = [...new Set([band.minMicrons, band.maxMicrons, ...points.map((point) => point.x).filter((x) => x > band.minMicrons && x < band.maxMicrons)])].sort((left, right) => left - right);
    const values = grid.map((x) => ({ x, y: linearInterpolate(x, points) }));
    const minimum = values.reduce((best, item) => item.y < best.y ? item : best, values[0]);
    const maximum = values.reduce((best, item) => item.y > best.y ? item : best, values[0]);
    const mean = trapezoidIntegral(grid, values.map((item) => item.y)) / (band.maxMicrons - band.minMicrons);
    return { band, pointCount: grid.length, mean, minimum, maximum, endpointChange: values.at(-1).y - values[0].y };
  });
}

const comparisonColors = ["#2563eb", "#0f766e", "#7c3aed", "#dc2626", "#ea580c", "#0891b2", "#be123c", "#4d7c0f"];

function makeComparisonPlotlyFigure({ files, title = "", style = {} }) {
  const base = makeLegacyPlotlyFigure({ points: files[0].parsed.points, title, sampleName: files[0].file.name, unit: files[0].confirmation.unit, valueUnit: files[0].confirmation.valueUnit, style });
  base.data = files.map((file, index) => {
    const data = displayPoints(file.parsed.points, file.confirmation.unit, style.displayUnit, file.confirmation.valueUnit);
    return { x: data.map((point) => point.x), y: data.map((point) => point.y), type: "scatter", mode: "lines", name: file.file.name, line: { color: comparisonColors[index % comparisonColors.length], width: style.lineWidth ?? 2 }, hovertemplate: `<b>λ：</b>%{x:.2f}<br><b>数值：</b>%{y:.4f}<extra>${escapeXml(file.file.name)}</extra>` };
  });
  base.exportOptions.filename = title || "光谱对比图";
  return base;
}

function makeComparisonSvg({ files, title = "", style = {} }) {
  const comparisonStyle = { ...style, legendEntries: files.map((file, index) => ({ label: file.file.name, color: comparisonColors[index % comparisonColors.length] })) };
  const base = makeChartSvg({ points: files[0].parsed.points, title, unit: files[0].confirmation.unit, valueUnit: files[0].confirmation.valueUnit, style: comparisonStyle });
  const width = style.width ?? 800, height = style.height ?? 500, left = 70, top = title ? 48 : 24, right = 66, bottom = 104;
  const xMin = style.xMin ?? 0, xMax = style.xMax ?? 20, yMin = style.yMin ?? 0, yMax = style.yMax ?? 1;
  const sx = (x) => left + ((x - xMin) / (xMax - xMin || 1)) * (width - left - right);
  const sy = (y) => height - bottom - ((y - yMin) / (yMax - yMin || 1)) * (height - top - bottom);
  const paths = files.slice(1).map((file, index) => {
    const data = displayPoints(file.parsed.points, file.confirmation.unit, style.displayUnit, file.confirmation.valueUnit);
    const pathData = data.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${sx(point.x).toFixed(2)},${sy(point.y).toFixed(2)}`).join(" ");
    return `<path clip-path="url(#plot-area)" d="${pathData}" fill="none" stroke="${comparisonColors[(index + 1) % comparisonColors.length]}" stroke-width="${style.lineWidth ?? 2}"/>`;
  }).join("");
  return base.replace("</svg>", `${paths}</svg>`);
}

function runAgentTool(call, { files, localPlan, requirements = {}, agentState = {}, activeArtifact = null, task = "" }) {
  const tool = call.function?.name;
  const args = parseToolArguments(call);
  if (tool === "update_task_context") {
    const previous = { ...requirements };
    Object.assign(requirements, applyStructuredContextUpdate(requirements, { bandsMicron: args.bands_micron, temperaturesKelvin: args.temperatures_kelvin }));
    agentState.requirements = { ...requirements };
    const changed = [];
    if (requirements.bandText && requirements.bandText !== previous.bandText) changed.push(`波段 ${requirements.bandText} μm`);
    if ((requirements.temperatureText || requirements.temperatureKelvin) && (requirements.temperatureText !== previous.temperatureText || requirements.temperatureKelvin !== previous.temperatureKelvin)) changed.push(`黑体温度 ${requirements.temperatureText || requirements.temperatureKelvin} K`);
    const interpretation = safeArtifactText(args.interpretation, "", 80);
    return { summary: changed.length ? `AI 已记录${changed.join("、")}` : "AI 检查了任务条件，没有覆盖已有记忆", value: { requirements: agentState.requirements, changed, interpretation } };
  }
  if (tool === "confirm_spectrum_meanings") {
    const allowedUnits = new Set(["um", "nm", "wavenumber"]), allowedTypes = new Set(["reflectance", "emissivity", "transmission", "absorption"]), allowedScales = new Set(["ratio", "percent"]);
    const confirmations = (Array.isArray(args.files) ? args.files : []).map((candidate) => {
      const file = files.find((item) => item.file.path === candidate?.file_reference);
      if (!file || !allowedUnits.has(candidate.wavelength_unit) || !allowedTypes.has(candidate.value_type) || !allowedScales.has(candidate.value_unit)) return null;
      const confirmation = { path: file.file.path, unit: candidate.wavelength_unit, valueType: candidate.value_type, valueUnit: candidate.value_unit, opaque: candidate.opaque === true };
      file.confirmation = confirmation;
      return confirmation;
    }).filter(Boolean);
    agentState.confirmations = [...new Map([...(agentState.confirmations ?? []), ...confirmations].map((item) => [item.path, item])).values()];
    return { summary: confirmations.length ? `AI 根据对话确认了 ${confirmations.length} 份文件的数据含义` : "没有可安全确认的文件含义", value: { confirmations, interpretation: safeArtifactText(args.interpretation, "", 80) } };
  }
  if (tool === "get_selected_spectrum_summaries") return { summary: `返回 ${files.length} 个文件摘要`, value: { files: files.map(aiFileSummary) } };
  if (tool === "get_legacy_demo_contract") return { summary: "返回旧版 Demo 的绘图与计算约定", value: { chart: "Plotly 2.27；默认波长显示为 μm、X=0–20、Y=0–1；百分比导入值先除以 100；浅蓝网格、灰蓝坐标边框、绿色半透明波段框选。", weighted: "波数转换为 μm；样品点、波段边界与 ASTM G173 支撑点取并集后线性插值，并以梯形积分计算分子/分母。nm 默认太阳 ASTM G173，μm/波数默认黑体。", implementation: "本机服务 server.mjs 的 makeLegacyPlotlyFigure、makeChartSvg、calculateWeightedMetrics 负责实现；模型可要求受控工具生成或修改图，但不能改写原始点。" } };
  if (tool === "scan_raw_spectrum_rows") {
    const file = files.find((item) => item.file.path === args.file_reference);
    if (!file) return { summary: "拒绝未授权文件引用", value: { error: "文件不在本次用户授权范围内。" } };
    const mode = ["above", "below", "largest", "first"].includes(args.mode) ? args.mode : "first";
    const limit = safeNumber(args.limit, 12, 1, 30);
    const threshold = Number(args.threshold);
    let rows = file.parsed.points.map((point, index) => ({ sourceRow: file.parsed.firstDataRow + index, x: point.x, y: point.y }));
    if (mode === "above" && Number.isFinite(threshold)) rows = rows.filter((row) => row.y > threshold);
    if (mode === "below" && Number.isFinite(threshold)) rows = rows.filter((row) => row.y < threshold);
    if (mode === "largest") rows = [...rows].sort((left, right) => right.y - left.y);
    const returned = rows.slice(0, limit);
    return { summary: `扫描原始数据：${returned.length} 行`, value: { file: file.file.name, mode, threshold: Number.isFinite(threshold) ? threshold : null, matchedCount: rows.length, rows: returned, note: "sourceRow 为依据首个数据行推算的近似源文件行号；若文件中夹杂非数值行，请以 X/Y 数值复核。" } };
  }
  if (tool === "get_local_analysis_plan") return { summary: "返回本地分析计划", value: localPlan };
  if (tool === "read_current_artifact") {
    const artifact = activeArtifact?.id ? loadGeneratedArtifact(activeArtifact.id) : null;
    if (!artifact) return { summary: "无法读取当前交付物", value: { error: "当前消息没有绑定可读取的交付物版本。请在侧边预览或使用 @ 选择产物后重试。" } };
    const isHtml = /text\/html/i.test(artifact.contentType) && typeof artifact.content === "string";
    const editableHtml = isHtml ? readableArtifactHtml(artifact.content) : "";
    return { summary: `读取现有交付物 ${artifact.filename}`, value: { artifact: { id: activeArtifact.id, filename: artifact.filename, kind: artifact.kind, contentType: artifact.contentType, version: activeArtifact.version }, editableHtml: editableHtml.slice(0, 36_000), truncated: editableHtml.length > 36_000, visibleText: isHtml ? visibleArtifactText(artifact.content).slice(0, 12_000) : "", editingRule: "只提交需要变化的短片段；不要重建整份 HTML。SPECTRA_PROTECTED_SVG 内部是真实曲线数据，不可改写。" } };
  }
  if (tool === "patch_current_html_artifact") {
    const current = activeArtifact?.id ? loadGeneratedArtifact(activeArtifact.id) : null;
    if (!current || !/text\/html/i.test(current.contentType) || typeof current.content !== "string") return { summary: "拒绝修改非 HTML 交付物", value: { error: "请先选择并读取一个 HTML 网页或报告交付物。" } };
    try {
      const preserveVisibleText = !taskExplicitlyEditsText(task);
      const patched = applyArtifactReplacements(current.content, args.replacements, { preserveVisibleText });
      const artifact = saveGeneratedArtifact({ filename: current.filename, content: patched.content, contentType: current.contentType, kind: current.kind, plotly: current.plotly ?? null });
      return { summary: safeArtifactText(args.summary, `局部修改现有 HTML（${patched.applied.length} 处）`, 80), artifact, value: { artifact, applied: patched.applied, preservedVisibleText: preserveVisibleText, message: "已在原文件上应用局部补丁，并保存为下一版本。" } };
    } catch (error) {
      return { summary: "局部补丁未通过完整性校验", value: { error: error.message } };
    }
  }
  if (tool === "summarize_band_features") {
    const file = files.find((item) => item.file.path === args.file_reference);
    if (!file) return { summary: "拒绝未授权文件引用", value: { error: "文件不在本次用户授权范围内。" } };
    if (!file.confirmation) return { summary: "波段特征等待单位确认", value: { error: "计算真实波段特征前，请先确认该文件的单位和 Y 值。" } };
    const features = summarizeBandFeatures(file, args.bands || requirements.bandText);
    return { summary: `总结 ${features.length} 个波段的极值、均值与趋势`, value: { file: file.file.name, features, valueUnit: "0–1", method: "边界线性插值；区间均值采用梯形积分除以波段宽度。" } };
  }
  if (tool === "generate_comparison_chart") {
    const chosen = [...new Set(Array.isArray(args.file_references) ? args.file_references : [])].map((reference) => files.find((file) => file.file.path === reference)).filter(Boolean);
    if (chosen.length < 2) return { summary: "对比图至少需要两个已授权文件", value: { error: "请选择至少两个文件生成同图对比。" } };
    if (!chosen.every((file) => file.confirmation)) return { summary: "对比图等待单位确认", value: { error: "生成真实对比图前，请先确认每个文件的单位和 Y 值。" } };
    const title = safeArtifactText(args.title, "材料光谱对比", 80);
    const style = chartStyleFromArgs(args, chosen[0]);
    if (!style.bands.length && requirements.bandText) style.bands = parseBandRanges(requirements.bandText);
    if (!style.metricNote && agentState.lastWeightedNote) style.metricNote = agentState.lastWeightedNote;
    const plotly = makeComparisonPlotlyFigure({ files: chosen, title, style });
    const artifact = saveGeneratedArtifact({ filename: `材料对比谱图-${Date.now()}.svg`, content: makeComparisonSvg({ files: chosen, title, style }), contentType: "image/svg+xml; charset=utf-8", kind: "chart", plotly });
    return { summary: `生成 ${chosen.length} 条曲线的同图对比`, artifact, value: { artifact, files: chosen.map((file) => file.file.name) } };
  }
  if (tool === "calculate_weighted_metrics") {
    const temperatures = args.temperatures?.length ? args.temperatures : (requirements.temperatureText || requirements.temperatureKelvin);
    const hasBlackbodyFile = files.some((item) => item.confirmation && item.confirmation.unit !== "nm");
    const validTemperatures = (Array.isArray(temperatures) ? temperatures : String(temperatures ?? "").split(/[，,;；\s]+/)).map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 5000);
    if (hasBlackbodyFile && !validTemperatures.length) return { summary: "已阻止缺少黑体温度的加权计算", value: { error: "当前包含微米或波数数据。计算前必须先询问并取得用户确认的黑体温度（K）。", missing: "blackbody_temperature_kelvin" } };
    const rows = calculateWeightedMetrics(files, { bands: args.bands || requirements.bandText, source: args.source, temperatures });
    agentState.lastWeightedNote = weightedMetricNote(rows);
    agentState.lastWeightedRows = rows;
    return { summary: `计算 ${rows.length} 项 Weighted 指标`, value: { rows, method: "与旧版 Demo 一致：在样品点、波段边界和 ASTM G173 支撑点的并集上插值并梯形积分。" } };
  }
  const file = files.find((item) => item.file.path === args.file_reference);
  if (!file) return { summary: "拒绝未授权文件引用", value: { error: "文件不在本次用户授权范围内。" } };
  if (!file.confirmation) return { summary: "文件尚未确认", value: { error: "请先确认该文件的单位和 Y 值含义。" } };
  if (tool === "generate_spectrum_chart") {
    const title = safeArtifactText(args.title, "", 80);
    const style = chartStyleFromArgs(args, file);
    if (!style.bands.length && requirements.bandText) style.bands = parseBandRanges(requirements.bandText);
    if (!style.metricNote && agentState.lastWeightedNote) style.metricNote = agentState.lastWeightedNote;
    const plotly = makeLegacyPlotlyFigure({ points: file.parsed.points, title, sampleName: file.file.name, unit: file.confirmation.unit, valueUnit: file.confirmation.valueUnit, style });
    const artifact = saveGeneratedArtifact({ filename: `${path.basename(file.file.name, path.extname(file.file.name))}-谱图-${Date.now()}.svg`, content: makeChartSvg({ points: file.parsed.points, title, unit: file.confirmation.unit, valueUnit: file.confirmation.valueUnit, style: { ...style, legendEntries: [{ label: file.file.name, color: style.lineColor }] } }), contentType: "image/svg+xml; charset=utf-8", kind: "chart", plotly });
    return { summary: `生成 SVG 谱图（标题：${title}）`, artifact, value: { artifact, message: "已生成可下载谱图。" } };
  }
  if (tool === "generate_analysis_report") {
    const title = safeArtifactText(args.title, "光谱数据分析报告", 80);
    const focus = safeArtifactText(args.focus, "数据质量与适用范围", 160);
    const reportStyle = args.style && typeof args.style === "object" ? args.style : {};
    const artifact = saveGeneratedArtifact({ filename: `${path.basename(file.file.name, path.extname(file.file.name))}-分析报告-${Date.now()}.html`, content: makeReport(file, file.confirmation, { title, focus, accentColor: safeChartColor(reportStyle.accent_color || "#2563eb"), layout: ["brief", "standard", "presentation"].includes(reportStyle.layout) ? reportStyle.layout : "standard", summary: safeArtifactText(reportStyle.summary, "", 900), bands: requirements.bandText }), contentType: "text/html; charset=utf-8" });
    return { summary: `生成 HTML 分析报告（重点：${focus}）`, artifact, value: { artifact, message: "已生成可下载分析报告。" } };
  }
  if (tool === "generate_custom_html_deliverable") {
    const filename = `${safeArtifactText(args.filename, "自定义光谱交付物", 80).replace(/\.html?$/i, "")}.html`;
    let body = safeCustomHtml(args.html_body);
    if (!body.trim()) return { summary: "拒绝空白网页内容", value: { error: "自定义 HTML 内容不能为空。" } };
    const isReport = args.document_type === "report" || /报告|report/i.test(filename);
    if (isReport) {
      const reportChart = `<section class="spectra-controlled-chart" style="max-width:1000px;margin:32px auto;padding:0 20px"><h2>光谱图</h2>${makeChartSvg({ points: file.parsed.points, title: file.file.name, unit: file.confirmation.unit, valueUnit: file.confirmation.valueUnit, style: { displayUnit: file.confirmation.unit === "wavenumber" ? "um" : file.confirmation.unit, backgroundColor: "#fbfcff", xLabel: file.confirmation.unit === "nm" ? "波长（nm）" : "波长（μm）", yLabel: "反射率（0–1）", bands: parseBandRanges(requirements.bandText), legendEntries: [{ label: file.file.name, color: "#2563eb" }] } })}</section>`;
      body = body.includes("{{SPECTRUM_CHART}}") ? body.replace("{{SPECTRUM_CHART}}", reportChart) : `${body}${reportChart}`;
    }
    const artifact = saveGeneratedArtifact({ filename, content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(filename.replace(/\.html$/i, ""))}</title><body>${body}</body></html>`, contentType: "text/html; charset=utf-8" });
    return { summary: isReport ? "生成含真实谱图的自定义 HTML 报告" : "生成自定义 HTML 网页交付物", artifact, value: { artifact, message: isReport ? "已生成含真实谱图的报告。" : "已生成独立网页交付物。" } };
  }
  return { summary: "拒绝未知工具", value: { error: "该工具不在授权工具列表中。" } };
}

function safeImageInputs(images) {
  return (Array.isArray(images) ? images : []).filter((value) => typeof value === "string" && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 5_600_000).slice(0, 3);
}

async function runDeepSeekAgent({ apiKey, provider, endpoint, model, task, images = [], conversation = [], requirements = {}, fileInterpretations = [], activeArtifact = null, files, localPlan, onEvent = () => {} }) {
  const key = requireSafeApiKey(apiKey, provider);
  const imageInputs = safeImageInputs(images);
  let selectedProvider = resolveModelProvider({ provider, endpoint, model });
  const startedAt = Date.now();
  const trace = [];
  const agentState = { lastWeightedNote: "", lastWeightedRows: [], requirements: { ...requirements }, confirmations: [] };
  try {
    if (provider === "deepseek" && imageInputs.length && selectedProvider.model !== "deepseek-v4-flash-vision-exp") {
      selectedProvider = { ...selectedProvider, model: "deepseek-v4-flash-vision-exp", label: "DeepSeek Vision" };
      trace.push({ tool: "视觉模型路由", resultSummary: `检测到 ${imageInputs.length} 张图片，本轮自动使用 deepseek-v4-flash-vision-exp`, elapsedMs: 0 });
      onEvent({ type: "model_note", label: `检测到 ${imageInputs.length} 张图片，本轮自动切换到 DeepSeek 视觉模型` });
    }
    let interpretedConfirmations = [];
  try {
    onEvent({ type: "decision", round: 0, label: "AI 正在结合对话理解单位、波段和温度" });
    const context = await askModelForContextInterpretation({ key, selectedProvider, task, conversation, requirements, fileInterpretations, files });
    Object.assign(requirements, context.requirements);
    interpretedConfirmations = context.confirmations;
    for (const confirmation of interpretedConfirmations) {
      const file = files.find((item) => item.file.path === confirmation.path);
      if (file) file.confirmation = confirmation;
    }
    agentState.requirements = { ...requirements };
    agentState.confirmations = interpretedConfirmations;
    trace.push({ tool: "AI上下文理解", resultSummary: context.interpretation, elapsedMs: Date.now() - startedAt });
    onEvent({ type: "model_note", label: context.interpretation });
  } catch (error) {
    const fallbackHasBlackbody = files.some((file) => (file.confirmation?.unit ?? file.metadata?.wavelength?.unit) !== "nm");
    Object.assign(requirements, mergeCalculationRequirements(requirements, task, { hasBlackbodySource: fallbackHasBlackbody, expectsTemperature: Boolean(requirements.bandText && fallbackHasBlackbody && !(requirements.temperatureText || requirements.temperatureKelvin)) }));
    agentState.requirements = { ...requirements };
    trace.push({ tool: "AI上下文理解", resultSummary: `未能单独解析条件，转由主 Agent 继续理解：${error.message}`, elapsedMs: Date.now() - startedAt });
    onEvent({ type: "model_note", label: "独立条件解析暂时不可用，主 Agent 将继续结合对话处理" });
  }
  const blackbodyPresent = files.some((file) => (file.confirmation?.unit ?? file.metadata?.wavelength?.unit) !== "nm");
  const mandatoryQuestion = mandatoryCalculationQuestion({
    task,
    hasFiles: files.length > 0,
    hasBlackbodySource: blackbodyPresent,
    bandText: requirements.bandText,
    temperatureText: requirements.temperatureText || requirements.temperatureKelvin,
  });
  if (mandatoryQuestion) {
    trace.push({ tool: "计算条件检查", resultSummary: blackbodyPresent && requirements.bandText ? "检测到微米/波数数据，等待黑体温度" : "等待用户指定计算波段", elapsedMs: Date.now() - startedAt });
    onEvent({ type: "answer", label: "缺少必要计算条件，先向用户确认" });
    return { answer: mandatoryQuestion, model: selectedProvider.model, trace, artifacts: [], weightedRows: [], requirements: agentState.requirements, confirmations: agentState.confirmations, durationMs: Date.now() - startedAt, usage: null };
  }
  const activeSkills = selectAgentSkills({ task, activeArtifact, files, requirements });
  const userPayload = { currentUserMessage: String(task ?? "请分析已选光谱文件。").slice(0, 4000), activeArtifact, activeSkills, aiUnitSuggestionsAwaitingUserConfirmation: fileInterpretations, confirmedCalculationConditions: { bandsMicron: requirements.bandText || "", blackbodyTemperaturesKelvin: requirements.temperatureText || requirements.temperatureKelvin || "" }, recentConversation: conversation.slice(-30) };
  const messages = [
    { role: "system", content: "你是 Spectra Copilot 的任务编排 Agent。AI 上下文解析器已经先检查了当前消息与最近对话，confirmedCalculationConditions 是当前结构化记忆；如果你发现用户在本轮进一步纠正了条件，可调用 update_task_context。用户确认或纠正文件含义时调用 confirm_spectrum_meanings，不确定则一次性追问。你不能读取电脑、不能执行代码、不能编造计算结果。只能调用声明的受控工具，并且只能使用用户本次授权的文件 reference。取得任务条件后再选择摘要、原始行、特征、加权、绘图或报告工具。单位尚未确认时仍可读取和解释；只有物理计算或真实谱图等待确认。普通提问只自然语言回答，绝不自行生成产物。只有用户明确要求生成、画、制作、导出或创建时才调用生成工具。Weighted 必须调用 calculate_weighted_metrics；nm 默认太阳 ASTM G173，μm/波数默认黑体。缺少条件时只问真正缺少的一项。activeArtifact.isRevisionTarget 为 true 时，这是修改现有产物：必须先调用 read_current_artifact，再调用 patch_current_html_artifact 做局部补丁；严禁调用任何 generate_* 工具重建整份产物。用户只要求修改图片或排版时，正文、章节顺序和其他视觉内容必须保持逐字不变。报告必须含真实谱图与工具事实。图和网页可修改视觉与文案，但不得改变原始数据或编造数值。清楚区分事实、建议和待确认项；用简洁中文回答。面向用户的回答不得显示 upload: 开头的内部 reference 或 UUID，始终使用对应文件名。调用工具前可写一句不超过50字的公开行动说明，只描述将做什么，不披露私密思维链。" },
    { role: "user", content: imageInputs.length ? [{ type: "text", text: JSON.stringify({ ...userPayload, attachedImages: imageInputs.length }) }, ...imageInputs.map((url) => ({ type: "image_url", image_url: { url } }))] : JSON.stringify(userPayload) },
  ];
  let lastUsage = null;
  for (let round = 0; round < 5; round += 1) {
    onEvent({ type: "decision", round: round + 1, label: round === 0 ? "读取任务、文件摘要与已确认条件" : "检查已返回的工具结果" });
    let response;
    try {
      response = await fetchModelWithRetry(selectedProvider.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: selectedProvider.model, stream: false, messages, tools: agentTools }),
      }, { timeoutMs: 120_000, attempts: 2, onRetry: ({ attempt, reason }) => {
        const label = `${reason}，正在进行第 ${attempt + 1} 次尝试`;
        trace.push({ tool: "模型请求重试", resultSummary: label, elapsedMs: Date.now() - startedAt });
        onEvent({ type: "retry", label });
      } });
    } catch (error) { throw modelConnectionError(error, selectedProvider.label); }
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      const providerMessage = String(details?.error?.message ?? "").replace(/sk-[\w-]+/gi, "[已隐藏]").slice(0, 280);
      throw new Error(`${selectedProvider.label} Agent 调用失败（${response.status}）：${providerMessage || "请检查 Key、余额和网络。"}`);
    }
    const data = await response.json();
    lastUsage = data.usage ?? lastUsage;
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("DeepSeek 没有返回 Agent 消息，请稍后重试。\n".trim());
    const publicNote = String(message.content ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
    if (publicNote && message.tool_calls?.length) {
      trace.push({ tool: "模型说明", resultSummary: publicNote, elapsedMs: Date.now() - startedAt });
      onEvent({ type: "model_note", label: publicNote });
    }
    if (!message.tool_calls?.length) {
      onEvent({ type: "answer", label: "工具结果已足够，正在整理最终答复" });
      return { answer: String(message.content ?? "Agent 没有给出可显示的回答。"), model: selectedProvider.model, trace, artifacts: trace.flatMap((item) => item.artifacts ?? (item.artifact ? [item.artifact] : [])), weightedRows: agentState.lastWeightedRows, requirements: agentState.requirements, confirmations: agentState.confirmations, durationMs: Date.now() - startedAt, usage: lastUsage ? { promptTokens: lastUsage.prompt_tokens, completionTokens: lastUsage.completion_tokens, totalTokens: lastUsage.total_tokens } : null };
    }
    messages.push({ role: "assistant", content: message.content ?? "", ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      onEvent({ type: "tool_start", tool: call.function?.name ?? "unknown", label: `调用 ${call.function?.name ?? "工具"}` });
      let result;
      if (activeArtifact?.isRevisionTarget && /^generate_/.test(call.function?.name ?? "")) {
        result = { summary: "已阻止重建现有交付物", value: { error: "这是现有交付物的修改任务。请先调用 read_current_artifact，再用 patch_current_html_artifact 仅修改目标片段。" } };
      } else {
        result = runAgentTool(call, { files, localPlan, requirements, agentState, activeArtifact, task });
      }
      trace.push({ tool: call.function?.name ?? "unknown", resultSummary: result.summary, artifact: result.artifact, artifacts: result.artifacts, elapsedMs: Date.now() - startedAt });
      onEvent({ type: "tool_done", tool: call.function?.name ?? "unknown", label: result.summary, artifact: result.artifact });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.value) });
    }
  }
  throw new Error("Agent 在限定轮次内没有完成，请缩短任务描述后重试。\n".trim());
  } catch (error) {
    error.agentPartial = {
      trace,
      artifacts: trace.flatMap((item) => item.artifacts ?? (item.artifact ? [item.artifact] : [])),
      weightedRows: agentState.lastWeightedRows,
      requirements: agentState.requirements,
      confirmations: agentState.confirmations,
      durationMs: Date.now() - startedAt,
    };
    throw error;
  }
}

function escapeXml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

function displayPoints(points, sourceUnit, displayUnit, valueUnit = "ratio") {
  const asMicrons = (value) => sourceUnit === "nm" ? value / 1000 : sourceUnit === "wavenumber" ? 10000 / value : value;
  const fromMicrons = (value) => displayUnit === "nm" ? value * 1000 : displayUnit === "wavenumber" ? 10000 / value : value;
  const scale = valueUnit === "percent" ? 0.01 : 1;
  return points.map(({ x, y }) => ({ x: fromMicrons(asMicrons(x)), y: y * scale }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((left, right) => left.x - right.x);
}

function makeChartSvg({ points, title = "", unit, valueUnit, style = {} }) {
  const data = displayPoints(points, unit, style.displayUnit ?? unit, valueUnit);
  if (data.length < 2) throw new Error("有效数据点不足，无法生成图表。");
  const sampled = data.length > 1800 ? data.filter((_, index) => index % Math.ceil(data.length / 1800) === 0) : data;
  const legendEntries = Array.isArray(style.legendEntries) ? style.legendEntries : [];
  const width = style.width ?? 800, height = style.height ?? 500, left = 70, top = title ? 48 : 24, right = 66, bottom = legendEntries.length ? 104 : 66;
  const xMin = style.xMin ?? 0, xMax = style.xMax ?? 20;
  const yMin = style.yMin ?? 0, yMax = style.yMax ?? 1;
  const sx = (x) => left + ((x - xMin) / (xMax - xMin || 1)) * (width - left - right);
  const sy = (y) => height - bottom - ((y - yMin) / (yMax - yMin || 1)) * (height - top - bottom);
  const line = sampled.map((point, index) => `${index ? "L" : "M"}${sx(point.x).toFixed(2)},${sy(point.y).toFixed(2)}`).join(" ");
  const bandCoordinate = (value) => style.displayUnit === "nm" ? value * 1000 : style.displayUnit === "wavenumber" ? 10000 / value : value;
  const bandMarkup = (style.bands ?? []).map((band) => {
    const leftX = sx(Math.min(bandCoordinate(band.minMicrons), bandCoordinate(band.maxMicrons)));
    const rightX = sx(Math.max(bandCoordinate(band.minMicrons), bandCoordinate(band.maxMicrons)));
    return `<rect x="${leftX.toFixed(2)}" y="${top}" width="${Math.max(0, rightX - leftX).toFixed(2)}" height="${height - top - bottom}" fill="rgba(16,185,129,.14)" stroke="rgba(5,150,105,.65)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }).join("");
  const tickCount = 5;
  const verticalGrid = Array.from({ length: tickCount + 1 }, (_, index) => {
    const x = left + (width - left - right) * index / tickCount;
    const value = xMin + (xMax - xMin) * index / tickCount;
    return `${style.showGrid !== false ? `<line x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}" stroke="${escapeXml(style.gridColor ?? "#e7edf6")}"/>` : ""}<text x="${x}" y="${height - bottom + 23}" text-anchor="middle" font-family="Inter, Arial, PingFang SC" font-size="11" fill="${escapeXml(style.fontColor ?? "#334155")}">${value.toPrecision(4)}</text>`;
  }).join("");
  const horizontalGrid = Array.from({ length: tickCount + 1 }, (_, index) => {
    const y = height - bottom - (height - top - bottom) * index / tickCount;
    const value = yMin + (yMax - yMin) * index / tickCount;
    return `${style.showGrid !== false ? `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="${escapeXml(style.gridColor ?? "#e7edf6")}"/>` : ""}<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-family="Inter, Arial, PingFang SC" font-size="11" fill="${escapeXml(style.fontColor ?? "#334155")}">${value.toPrecision(3)}</text>`;
  }).join("");
  const titleMarkup = title ? `<text x="${left}" y="25" font-family="Inter, SF Pro Display, PingFang SC, Microsoft YaHei, sans-serif" font-size="16" font-weight="600" fill="${escapeXml(style.fontColor ?? "#334155")}">${escapeXml(title)}</text>` : "";
  const metricLines = String(style.metricNote ?? "").split(/\n/).filter(Boolean).slice(0, 4);
  const metricMarkup = metricLines.length ? `<text x="${width - right - 8}" y="${top + 18}" text-anchor="end" font-family="Inter, Arial, PingFang SC" font-size="11" font-weight="600" fill="${escapeXml(style.fontColor ?? "#334155")}">${metricLines.map((line, index) => `<tspan x="${width - right - 8}" dy="${index ? "1.25em" : "0"}">${escapeXml(line)}</tspan>`).join("")}</text>` : "";
  const legendMarkup = legendEntries.map((entry, index) => {
    const x = left + (index % 3) * Math.max(170, (width - left - right) / 3);
    const y = height - 18 - Math.floor(index / 3) * 20;
    return `<line x1="${x}" y1="${y - 4}" x2="${x + 22}" y2="${y - 4}" stroke="${escapeXml(entry.color ?? "#2563eb")}" stroke-width="2"/><text x="${x + 28}" y="${y}" font-family="Inter, Arial, PingFang SC" font-size="11" fill="${escapeXml(style.fontColor ?? "#334155")}">${escapeXml(entry.label)}</text>`;
  }).join("");
  const dash = { dash: "8 5", dot: "2 4", dashdot: "8 4 2 4" }[style.lineDash] ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><rect x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}" fill="${escapeXml(style.backgroundColor ?? "#fbfcff")}"/>${titleMarkup}${verticalGrid}${horizontalGrid}${bandMarkup}<rect x="${left}" y="${top}" width="${width - left - right}" height="${height - top -bottom}" fill="none" stroke="${escapeXml(style.axisColor ?? "#94a3b8")}" stroke-width="1"/><clipPath id="plot-area"><rect x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}"/></clipPath><path clip-path="url(#plot-area)" d="${line}" fill="none" stroke="${escapeXml(style.lineColor ?? "#2563eb")}" stroke-width="${style.lineWidth ?? 2}" stroke-dasharray="${dash}" opacity="${style.opacity ?? 1}"/>${metricMarkup}<text x="${width / 2}" y="${height - bottom + 43}" text-anchor="middle" font-family="Inter, SF Pro Display, PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="${escapeXml(style.fontColor ?? "#334155")}">${escapeXml(style.xLabel ?? "波长（μm）")}</text><text x="18" y="${height / 2}" transform="rotate(-90 18 ${height / 2})" text-anchor="middle" font-family="Inter, SF Pro Display, PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="${escapeXml(style.fontColor ?? "#334155")}">${escapeXml(style.yLabel ?? "反射率（0–1）")}</text>${legendMarkup}</svg>`;
}

function makeLegacyPlotlyFigure({ points, title = "", sampleName, unit, valueUnit, style = {} }) {
  const data = displayPoints(points, unit, style.displayUnit ?? unit, valueUnit);
  const xMin = style.xMin ?? 0, xMax = style.xMax ?? 20;
  const yMin = style.yMin ?? 0, yMax = style.yMax ?? 1;
  const convertBand = (value) => style.displayUnit === "nm" ? value * 1000 : style.displayUnit === "wavenumber" ? 10000 / value : value;
  const shapes = (style.bands ?? []).map((band) => {
    const x0 = convertBand(band.minMicrons), x1 = convertBand(band.maxMicrons);
    return { type: "rect", xref: "x", yref: "paper", x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: 0, y1: 1, fillcolor: "rgba(16, 185, 129, 0.14)", line: { color: "rgba(5, 150, 105, 0.65)", width: 1, dash: "dot" }, layer: "below" };
  });
  return {
    data: [{
      x: data.map((point) => point.x), y: data.map((point) => point.y), type: "scatter", mode: "lines", name: sampleName,
      line: { color: style.lineColor ?? "#2563eb", width: style.lineWidth ?? 2, dash: style.lineDash ?? "solid" },
      opacity: style.opacity ?? 1, fill: style.fill ?? "none", marker: style.showMarkers ? { size: style.markerSize ?? 5 } : undefined,
      hovertemplate: `<b>${style.displayUnit === "wavenumber" ? "ν" : "λ"}：</b>%{x:.2f}<br><b>反射率：</b>%{y:.4f}<extra></extra>`,
    }],
    layout: {
      template: "plotly_white", paper_bgcolor: "#ffffff", plot_bgcolor: style.backgroundColor ?? "#fbfcff",
      font: { family: "Inter, SF Pro Display, PingFang SC, Microsoft YaHei, sans-serif", color: style.fontColor ?? "#334155" },
      title: title ? { text: title, x: 0, xanchor: "left", font: { size: 16 } } : undefined,
      xaxis: { title: style.xLabel ?? (style.displayUnit === "wavenumber" ? "波数（cm⁻¹）" : style.displayUnit === "nm" ? "波长（nm）" : "波长（μm）"), range: [xMin, xMax], ticks: "outside", showgrid: style.showGrid !== false, mirror: true, showline: true, linecolor: style.axisColor ?? "#94a3b8", linewidth: 1, gridcolor: style.gridColor ?? "#e7edf6", zeroline: false, autorange: false },
      yaxis: { title: style.yLabel ?? "反射率（0–1）", range: [yMin, yMax], ticks: "outside", showgrid: style.showGrid !== false, mirror: true, showline: true, linecolor: style.axisColor ?? "#94a3b8", linewidth: 1, gridcolor: style.gridColor ?? "#e7edf6", zeroline: false },
      showlegend: true, legend: { orientation: "h", x: 0, xanchor: "left", y: -0.2, yanchor: "top", bgcolor: "rgba(255, 255, 255, 0.92)", bordercolor: "#dbe5f2", borderwidth: 1 },
      annotations: style.metricNote ? [{ xref: "paper", yref: "paper", x: 1, y: 1, xanchor: "right", yanchor: "top", align: "right", text: escapeXml(style.metricNote).replace(/\n/g, "<br>"), showarrow: false, font: { size: 11, color: style.fontColor ?? "#334155" }, bgcolor: "rgba(255,255,255,.82)", borderpad: 4 }] : [],
      margin: { t: title ? 48 : 24, r: 32, l: 70, b: 108 }, height: style.height ?? 540, hovermode: "closest", shapes,
    },
    config: { responsive: true, displayModeBar: true, displaylogo: false },
    exportOptions: { format: "svg", filename: sampleName || "光谱图", height: 500, width: 800 },
  };
}

function makeReport(inspected, settings, { title = "光谱数据分析报告", focus = "数据质量与适用范围", accentColor = "#2563eb", layout = "standard", summary = "", bands = "" } = {}) {
  const displayUnit = settings.unit === "wavenumber" ? "um" : settings.unit;
  const chart = makeChartSvg({ points: inspected.parsed.points, title: layout === "presentation" ? inspected.file.name : "", unit: settings.unit, valueUnit: settings.valueUnit, style: { displayUnit, backgroundColor: "#fbfcff", lineColor: accentColor, xLabel: displayUnit === "nm" ? "波长（nm）" : "波长（μm）", yLabel: "反射率（0–1）", bands: parseBandRanges(bands), legendEntries: [{ label: inspected.file.name, color: accentColor }] } });
  const warnings = [...inspected.analysis.warnings, "本报告不对未覆盖波段做外推。", "由反射率推断发射率前，必须确认样品近似不透明（T≈0）。"];
  const compact = layout === "brief";
  const presentation = layout === "presentation";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeXml(title)}</title><style>:root{--accent:${escapeXml(accentColor)}}body{max-width:${presentation ? "1180" : "1000"}px;margin:${presentation ? "56" : "40"}px auto;padding:0 24px;font:16px/1.7 Inter,Arial,"PingFang SC";color:#172033}h1{font-size:${presentation ? "42" : "32"}px;color:#172554;letter-spacing:-.03em}h2{margin-top:32px;color:#172554}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:10px;text-align:left}.note{background:#eff6ff;padding:14px;border-left:4px solid var(--accent)}.summary{font-size:${presentation ? "20" : "17"}px;color:#334155;white-space:pre-wrap}.meta{color:#64748b}</style><h1>${escapeXml(title)}</h1><p class="meta">生成时间：${escapeXml(new Date().toLocaleString("zh-CN"))}</p><p class="note"><b>本版重点：</b>${escapeXml(focus)}</p><h2>AI 分析</h2><p class="summary">${escapeXml(summary || "尚未提供模型分析文字。本报告只列出本机确认的文件信息与图形，避免虚构结论。")}</p><h2>文件与确认信息</h2><table><tr><th>文件</th><td>${escapeXml(inspected.file.name)}</td></tr><tr><th>波长单位</th><td>${escapeXml(inspected.metadata.wavelength.label)}（用户确认：${escapeXml(settings.unit)}）</td></tr><tr><th>Y 值</th><td>${escapeXml(settings.valueType)}；${escapeXml(settings.valueUnit)}</td></tr><tr><th>有效数据点</th><td>${inspected.analysis.validPointCount}</td></tr><tr><th>内部波长范围</th><td>${inspected.analysis.rangeUm.map((value) => value.toPrecision(5)).join("–")} μm</td></tr></table><h2>谱图${bands ? `（框选波段：${escapeXml(bands)} μm）` : ""}</h2>${chart}${compact ? "" : `<h2>数据质量与限制</h2><ul>${warnings.map((warning) => `<li>${escapeXml(warning)}</li>`).join("")}</ul>`}<p class="note">所有文件读取、换算和作图均在本机完成。模型分析只基于受控工具返回的摘要与计算结果，不直接读取桌面原始文件。</p></html>`;
}

async function handleApi(request, response, url) {
  pruneTemporaryData();
  if (request.method === "GET" && url.pathname === "/api/config") return send(response, 200, {
    mode: publicWebMode ? "public-web" : "local-desktop",
    allowsDesktopSearch: !publicWebMode,
    uploadOnly: publicWebMode,
    temporaryDataTtlMinutes: temporaryDataTtlMs / 60_000,
  });
  if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true, root: publicWebMode ? "上传文件（公共演示）" : "桌面（已授权）" });
  if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
    const artifact = loadGeneratedArtifact(url.pathname.slice("/api/artifacts/".length));
    if (!artifact) throw new Error("该生成文件已过期，请重新执行任务。\n".trim());
    if (url.searchParams.get("plotly") === "1") {
      if (!artifact.plotly) throw new Error("该交付物没有可用的 Plotly 预览数据。\n".trim());
      return send(response, 200, artifact.plotly);
    }
    const headers = url.searchParams.get("preview") === "1" ? {} : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}` };
    return send(response, 200, artifact.content, artifact.contentType, headers);
  }
  if (request.method === "GET" && url.pathname === "/api/connector/status") return send(response, 200, {
    mode: publicWebMode ? "public-upload-only" : "local-desktop-bridge",
    version: "0.1.0",
    authorizedScope: publicWebMode ? "本轮用户主动上传的文件" : "桌面目录（本地原型固定范围）",
    capabilities: ["search_authorized_files", "inspect_spectrum", "parse_xlsx", "generate_chart", "generate_report"],
    publicWebNote: "公开版只读取用户主动上传的文件，不扫描访问者电脑目录。",
  });
  if (request.method === "POST" && url.pathname === "/api/upload") {
    const rawName = request.headers["x-spectra-filename"];
    const name = path.basename(typeof rawName === "string" ? decodeURIComponent(rawName) : "");
    const extension = path.extname(name).toLowerCase();
    if (!name || !allowedExtensions.has(extension)) throw new Error("仅支持 CSV、TXT、TSV、DPT、XLSX 光谱文件。\n".trim());
    const reference = `upload:${randomUUID()}`;
    uploadedFiles.set(reference, { name, buffer: await readUploadBody(request), createdAt: Date.now() });
    pruneTemporaryData();
    while (uploadedFiles.size > 60) uploadedFiles.delete(uploadedFiles.keys().next().value);
    return send(response, 200, { files: [await inspectFile(reference)] });
  }
  if (request.method === "GET" && url.pathname === "/api/files") {
    if (publicWebMode) throw new Error("在线演示版不扫描访问者电脑。请点击 ＋ 上传光谱文件。");
    const query = url.searchParams.get("q")?.toLowerCase().trim() ?? "";
    const keywords = query.split(/[\s，,。！!？?：:]+/).filter((word) => word.length >= 2).filter((word) => !/^(帮我|请|读取|分析|查看|看看|文件|数据|光谱|生成|图片|报告)$/.test(word));
    const files = await findDesktopFiles();
    const matches = keywords.length ? files.filter((file) => keywords.some((word) => file.name.toLowerCase().includes(word))).slice(0, 12) : files.slice(0, 12);
    return send(response, 200, { files: matches, scannedCount: files.length });
  }
  if (request.method === "POST" && url.pathname === "/api/inspect") return send(response, 200, await inspectFile((await readJson(request)).path));
  if (request.method === "POST" && url.pathname === "/api/inspect-many") {
    const body = await readJson(request);
    const files = await Promise.all(uniqueApprovedPaths(body.paths).map((filePath) => inspectFile(filePath)));
    return send(response, 200, { files });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/infer-units") {
    const body = await readJson(request);
    const paths = uniqueApprovedPaths(body.paths);
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const suggestions = await askModelForUnitInference({ apiKey: body.apiKey, provider: body.provider, endpoint: body.endpoint, model: body.model, files });
    return send(response, 200, { suggestions });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/session-guide") {
    const body = await readJson(request);
    const paths = Array.isArray(body.paths) && body.paths.length ? uniqueApprovedPaths(body.paths) : [];
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    const guide = await askModelForSessionGuide({ apiKey: body.apiKey, provider: body.provider, endpoint: body.endpoint, model: body.model, phase: body.phase, userMessage: body.userMessage, missingDetails: body.missingDetails, requirements: body.requirements, files: withConfirmations });
    return send(response, 200, { guide });
  }
  if (request.method === "POST" && url.pathname === "/api/task-plan") {
    const body = await readJson(request);
    const paths = uniqueApprovedPaths(body.paths);
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    return send(response, 200, buildTaskPlan({ task: body.task, files: withConfirmations }));
  }
  if (request.method === "POST" && url.pathname === "/api/ai/task-plan") {
    const body = await readJson(request);
    const paths = uniqueApprovedPaths(body.paths);
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    const localPlan = buildTaskPlan({ task: body.task, files: withConfirmations });
    const ai = await askDeepSeekForPlan({ apiKey: body.apiKey, provider: body.provider, endpoint: body.endpoint, model: body.model, task: body.task, files: withConfirmations, localPlan });
    return send(response, 200, { ...localPlan, ai });
  }
  if (request.method === "POST" && url.pathname === "/api/agent/run") {
    const body = await readJson(request);
    const paths = Array.isArray(body.paths) && body.paths.length ? uniqueApprovedPaths(body.paths) : [];
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    const localPlan = buildTaskPlan({ task: body.task, files: withConfirmations });
    const agent = await runDeepSeekAgent({ apiKey: body.apiKey, provider: body.provider, endpoint: body.endpoint, model: body.model, task: body.task, images: body.images, conversation: body.conversation, requirements: body.requirements, fileInterpretations: body.fileInterpretations, activeArtifact: body.activeArtifact, files: withConfirmations, localPlan });
    return send(response, 200, { agent });
  }
  if (request.method === "POST" && url.pathname === "/api/agent/stream") {
    const body = await readJson(request);
    const paths = Array.isArray(body.paths) && body.paths.length ? uniqueApprovedPaths(body.paths) : [];
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    const emit = (event, payload) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    try {
      const localPlan = buildTaskPlan({ task: body.task, files: withConfirmations });
      const agent = await runDeepSeekAgent({ apiKey: body.apiKey, provider: body.provider, endpoint: body.endpoint, model: body.model, task: body.task, images: body.images, conversation: body.conversation, requirements: body.requirements, fileInterpretations: body.fileInterpretations, activeArtifact: body.activeArtifact, files: withConfirmations, localPlan, onEvent: (event) => emit("progress", event) });
      emit("complete", { agent });
    } catch (error) { emit("error", { error: error.message || "Agent 运行失败。", partial: error.agentPartial ?? null }); }
    clearInterval(heartbeat);
    response.end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/weighted-export") {
    const body = await readJson(request);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 200).map((row) => ({
      file: safeArtifactText(row?.file, "未命名样品", 160),
      source: safeArtifactText(row?.source, "未指定辐射源", 80),
      band: { minMicrons: safeNumber(row?.band?.minMicrons, 0, 0, 100000), maxMicrons: safeNumber(row?.band?.maxMicrons, 0, 0, 100000) },
      value: Number.isFinite(Number(row?.value)) ? Number(row.value) : null,
      error: row?.error ? safeArtifactText(row.error, "计算不适用", 180) : null,
    })).filter((row) => row.band.maxMicrons > row.band.minMicrons) : [];
    if (!rows.length) throw new Error("没有可导出的加权计算结果。请先完成一次加权计算。");
    if (body.format === "xlsx") return send(response, 200, weightedXlsx(rows), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("加权物理指标.xlsx")}` });
    return send(response, 200, weightedCsv(rows), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("加权物理指标.csv")}` });
  }
  if (request.method === "POST" && url.pathname === "/api/weighted") {
    const body = await readJson(request);
    const paths = uniqueApprovedPaths(body.paths);
    const files = await Promise.all(paths.map((filePath) => inspectFile(filePath)));
    const byPath = new Map((body.confirmations ?? []).filter((item) => item?.path).map((item) => [item.path, item]));
    const withConfirmations = files.map((file) => ({ ...file, confirmation: byPath.get(file.file.path) }));
    if (!withConfirmations.every((file) => file.confirmation)) throw new Error("请先确认每份文件的单位和 Y 值含义。\n".trim());
    return send(response, 200, { rows: calculateWeightedMetrics(withConfirmations, body) });
  }
  if (request.method === "POST" && url.pathname === "/api/chart") {
    const body = await readJson(request), inspected = await inspectFile(body.path);
    return send(response, 200, makeChartSvg({ points: inspected.parsed.points, title: body.title || inspected.file.name, unit: body.unit, valueUnit: body.valueUnit }), "image/svg+xml; charset=utf-8", { "Content-Disposition": 'attachment; filename="spectrum-chart.svg"' });
  }
  if (request.method === "POST" && url.pathname === "/api/report") {
    const body = await readJson(request), inspected = await inspectFile(body.path);
    return send(response, 200, makeReport(inspected, body), "text/html; charset=utf-8", { "Content-Disposition": 'attachment; filename="spectrum-report.html"' });
  }
  return send(response, 404, { error: "未知 API。" });
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const absolute = path.resolve(projectRoot, `.${requested}`);
    if (!absolute.startsWith(projectRoot)) return send(response, 403, "Forbidden", "text/plain");
    return send(response, 200, await readFile(absolute), mime[path.extname(absolute)] ?? "application/octet-stream");
  } catch (error) { return send(response, 400, { error: error.message || "请求失败。" }); }
}).listen(port, host, () => console.log(`Spectra Copilot 已启动：http://${host}:${port}（${publicWebMode ? "公共上传演示模式" : "本地桌面模式"}）`));
