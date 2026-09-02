import { mergeCalculationRequirements, rebuildCalculationRequirements } from "./conversation-memory.js";
import { formatModelReply } from "./reply-format.js";

const messages = document.querySelector("#messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const artifactMentions = document.querySelector("#artifact-mentions");
const fileUpload = document.querySelector("#file-upload");
const taskStatus = document.querySelector("#task-status");
const apiSettingsButton = document.querySelector("#api-settings");
const clearSessionButton = document.querySelector("#clear-session");
const apiDialog = document.querySelector("#api-dialog");
const historyDialog = document.querySelector("#history-dialog");
const historyButton = document.querySelector("#history-button");
const historyList = document.querySelector("#history-list");
const closeHistoryButton = document.querySelector("#close-history");
const apiKeyInput = document.querySelector("#api-key-input");
const aiProvider = document.querySelector("#ai-provider");
const aiModel = document.querySelector("#ai-model");
const aiEndpoint = document.querySelector("#ai-endpoint");
const endpointField = document.querySelector("#endpoint-field");
const apiStatus = document.querySelector("#api-status");
const saveApiKeyButton = document.querySelector("#save-api-key");
const clearApiKeyButton = document.querySelector("#clear-api-key");
const cancelApiKeyButton = document.querySelector("#cancel-api-key");
const togglePreviewButton = document.querySelector("#toggle-preview");
const artifactPanel = document.querySelector("#artifact-panel");
const workbench = document.querySelector(".workbench");
const workspaceSplitter = document.querySelector("#workspace-splitter");
const imageTray = document.querySelector("#image-tray");
const fileTray = document.querySelector("#file-tray");
const sendButton = document.querySelector("#send-button");

const sessionKey = "spectra-copilot-session-v2";
const historyKey = "spectra-copilot-history-v1";
const apiProfileKey = "spectra-copilot-api-profile-v1";
const layoutKey = "spectra-copilot-layout-v1";
const previewKey = "spectra-copilot-preview-open-v1";
const selectedFiles = new Map();
const requirements = { bandText: "", temperatureKelvin: "", temperatureText: "" };
const aiSession = { provider: "deepseek", model: "deepseek-v4-flash", endpoint: "", apiKey: "" };
let messageHistory = [];
let artifactGroups = [];
let activeArtifactGroupId = "";
let pendingRevisionGroupId = "";
let previewIsOpen = localStorage.getItem(previewKey) !== "closed";
let currentSessionId = sessionStorage.getItem("spectra-copilot-current-session") || crypto.randomUUID();
let closedArtifactGroupIds = new Set();
let pendingImages = [];
let stagedSpectrumFiles = [];
let pendingTaskAfterConfirmation = "";
sessionStorage.setItem("spectra-copilot-current-session", currentSessionId);

try { Object.assign(aiSession, JSON.parse(localStorage.getItem(apiProfileKey) || "{}")); } catch { /* 本机 API 配置读取失败时保留默认值 */ }

function saveApiProfile() {
  localStorage.setItem(apiProfileKey, JSON.stringify(aiSession));
}

function escaped(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function closeModal(dialog) {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function renderImageTray() {
  imageTray.innerHTML = pendingImages.map((image, index) => `<span class="image-chip"><img src="${escaped(image.dataUrl)}" alt="待发送图片 ${index + 1}"/><button type="button" data-remove-image="${index}" aria-label="移除图片">×</button></span>`).join("");
  imageTray.querySelectorAll("[data-remove-image]").forEach((button) => button.addEventListener("click", () => { pendingImages.splice(Number(button.dataset.removeImage), 1); renderImageTray(); }));
}

async function attachClipboardImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (pendingImages.length >= 3) throw new Error("一次最多发送 3 张图片。");
    if (file.size > 4 * 1024 * 1024) throw new Error("单张粘贴图片不能超过 4 MB。");
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    pendingImages.push({ dataUrl, name: file.name || "粘贴图片" });
  }
  renderImageTray();
}

function renderFileTray() {
  const statusLabel = (entry) => ({ queued: "准备加载 0%", uploading: `正在上传 ${Math.round(entry.progress)}%`, parsing: `正在解析 ${Math.round(entry.progress)}%`, inferring: `AI 单位初判 ${Math.round(entry.progress)}%`, ready: "加载完成 100%，可以发送", error: entry.error || "上传失败" }[entry.status] ?? "等待上传");
  fileTray.innerHTML = stagedSpectrumFiles.map((entry) => `<span class="file-chip file-chip-${escaped(entry.status)}"><span class="file-chip-main"><span class="file-chip-name">${escaped(entry.file.name)}</span><small>${escaped(statusLabel(entry))}</small>${["queued", "uploading", "parsing", "inferring"].includes(entry.status) ? `<span class="file-progress" aria-label="${escaped(entry.file.name)} 加载进度 ${Math.round(entry.progress)}%"><i style="width:${Math.max(0, Math.min(100, entry.progress))}%"></i></span>` : ""}</span><button type="button" data-remove-file="${escaped(entry.id)}" aria-label="移除 ${escaped(entry.file.name)}">×</button></span>`).join("");
  fileTray.querySelectorAll("[data-remove-file]").forEach((button) => button.addEventListener("click", () => {
    const entry = stagedSpectrumFiles.find((item) => item.id === button.dataset.removeFile);
    if (entry) { entry.cancelled = true; entry.xhr?.abort(); }
    stagedSpectrumFiles = stagedSpectrumFiles.filter((item) => item.id !== button.dataset.removeFile);
    renderFileTray();
  }));
  updateSendAvailability();
}

function updateSendAvailability() {
  const busy = stagedSpectrumFiles.filter((entry) => ["queued", "uploading", "parsing", "inferring"].includes(entry.status));
  sendButton.disabled = busy.length > 0;
  if (!busy.length) {
    const readyCount = stagedSpectrumFiles.filter((entry) => entry.status === "ready").length;
    sendButton.textContent = readyCount ? `发送（${readyCount}）` : "发送";
    return;
  }
  const uploading = busy.filter((entry) => entry.status === "uploading");
  if (uploading.length) {
    const progress = Math.round(uploading.reduce((sum, entry) => sum + entry.progress, 0) / uploading.length);
    sendButton.textContent = `上传 ${progress}%`;
  } else {
    const progress = Math.round(busy.reduce((sum, entry) => sum + entry.progress, 0) / busy.length);
    sendButton.textContent = `加载 ${progress}%`;
  }
}

function uploadFileWithProgress(entry) {
  return new Promise((resolve, reject) => {
    const file = entry.file;
    if (file.size > 20 * 1024 * 1024) return reject(new Error(`${file.name} 超过 20 MB，无法上传。`));
    const xhr = new XMLHttpRequest();
    entry.xhr = xhr;
    entry.status = "uploading";
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-Spectra-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) entry.progress = Math.min(99, event.loaded / event.total * 100);
      renderFileTray();
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* 由下方统一报告 */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `${file.name} 上传失败（${xhr.status}）。`));
      entry.progress = 82;
      entry.status = "parsing";
      renderFileTray();
      resolve(Array.isArray(data.files) ? data.files : []);
    });
    xhr.addEventListener("error", () => reject(new Error(`${file.name} 上传时网络连接中断。`)));
    xhr.addEventListener("abort", () => reject(new Error("已取消上传。")));
    xhr.send(file);
    renderFileTray();
  });
}

async function stageAndUploadFiles(files) {
  const entries = [...files].map((file) => ({ id: crypto.randomUUID(), file, status: "queued", progress: 0, inspections: [], error: "", xhr: null, cancelled: false }));
  if (!entries.length) return;
  stagedSpectrumFiles.push(...entries);
  renderFileTray();
  await Promise.all(entries.map(async (entry) => {
    try { entry.inspections = await uploadFileWithProgress(entry); }
    catch (error) {
      if (entry.cancelled) return;
      entry.status = "error";
      entry.error = error.message;
      entry.progress = 0;
      renderFileTray();
    }
  }));
  const analyzable = entries.filter((entry) => !entry.cancelled && entry.status === "parsing" && entry.inspections.length);
  if (!analyzable.length) return renderFileTray();
  analyzable.forEach((entry) => { entry.status = "inferring"; entry.progress = 90; });
  renderFileTray();
  const inferred = await applyAiUnitInference(analyzable.flatMap((entry) => entry.inspections));
  const byPath = new Map(inferred.map((inspection) => [inspection.file.path, inspection]));
  analyzable.forEach((entry) => {
    if (entry.cancelled) return;
    entry.inspections = entry.inspections.map((inspection) => byPath.get(inspection.file.path) ?? inspection);
    entry.status = "ready";
    entry.progress = 100;
  });
  renderFileTray();
}

function mentionItems() {
  const staged = stagedSpectrumFiles.map((entry) => ({ kind: entry.status === "ready" ? "待发送文件" : "上传中文件", label: entry.file.name }));
  const files = [...selectedFiles.values()].map((item) => ({ kind: "文件", label: item.file.name }));
  const artifacts = artifactGroups.map((group) => ({ kind: group.kind === "chart" ? "图片" : "网页", label: group.label }));
  return [...staged, ...files, ...artifacts].filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label) === index);
}

function addMessage(role, html, { remember = true } = {}) {
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;
  article.innerHTML = `${role === "assistant" ? "<b>光谱 Agent</b>" : ""}<div class="message-content">${html}</div><button class="message-copy" type="button" title="复制这条消息">复制</button>`;
  article.querySelector(".message-copy").addEventListener("click", async () => {
    const button = article.querySelector(".message-copy");
    try {
      await navigator.clipboard.writeText(article.querySelector(".message-content").innerText);
      button.textContent = "已复制";
      setTimeout(() => { button.textContent = "复制"; }, 1200);
    } catch { button.textContent = "复制失败"; }
  });
  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (remember) {
    messageHistory.push({ role, html });
    messageHistory = messageHistory.slice(-80);
    saveSession();
  }
  return article;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 模型内容先以纯文本逐步出现，再替换为安全的富文本格式；运行轨迹仍独立实时更新。
async function addTypedAssistantMessage(answer, { footer = "" } = {}) {
  const safeAnswer = String(answer ?? "").trim() || "我已完成本次处理。";
  const article = addMessage("assistant", '<div class="model-reply"><p class="typing-reply"></p></div>', { remember: false });
  const target = article.querySelector(".typing-reply");
  const step = safeAnswer.length > 1400 ? 32 : 14;
  for (let index = step; index < safeAnswer.length + step; index += step) {
    target.textContent = safeAnswer.slice(0, index);
    messages.scrollTop = messages.scrollHeight;
    await wait(safeAnswer.length > 1400 ? 8 : 18);
  }
  const html = `<div class="model-reply">${formatModelReply(safeAnswer)}</div>${footer}`;
  article.querySelector(".message-content").innerHTML = html;
  bindArtifactPreviewControls(article);
  messageHistory.push({ role: "assistant", html });
  messageHistory = messageHistory.slice(-80);
  saveSession();
  return article;
}

async function typeIntoRunMessage(article, answer, { footer = "" } = {}) {
  const safeAnswer = String(answer ?? "").trim() || "我已完成本次处理。";
  const content = article.querySelector(".message-content");
  content.insertAdjacentHTML("beforeend", '<div class="model-reply run-final-reply"><p class="typing-reply"></p></div>');
  const target = content.querySelector(".typing-reply");
  const step = safeAnswer.length > 1400 ? 32 : 14;
  for (let index = step; index < safeAnswer.length + step; index += step) {
    target.textContent = safeAnswer.slice(0, index);
    messages.scrollTop = messages.scrollHeight;
    await wait(safeAnswer.length > 1400 ? 8 : 18);
  }
  target.parentElement.innerHTML = formatModelReply(safeAnswer);
  content.insertAdjacentHTML("beforeend", footer);
  bindArtifactPreviewControls(article);
  messageHistory.push({ role: "assistant", html: content.innerHTML });
  messageHistory = messageHistory.slice(-80);
  saveSession();
  return article;
}

function openArtifactInPreview(artifactId) {
  const group = artifactGroups.find((candidate) => candidate.versions.some((artifact) => artifact.id === artifactId));
  if (!group) return;
  group.activeIndex = group.versions.findIndex((artifact) => artifact.id === artifactId);
  activeArtifactGroupId = group.id;
  closedArtifactGroupIds.delete(group.id);
  setPreviewOpen(true);
  saveSession();
  renderArtifactPanel();
}

function bindArtifactPreviewControls(article) {
  article.querySelectorAll("[data-open-artifact-id]").forEach((button) => button.addEventListener("click", () => openArtifactInPreview(button.dataset.openArtifactId)));
}

async function downloadWeightedExport(rows, format) {
  const response = await request("/api/weighted-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, format }) });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `加权物理指标.${format === "xlsx" ? "xlsx" : "csv"}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function bindWeightedExportControls(article, rows = []) {
  article.querySelectorAll("[data-weighted-export]").forEach((button) => button.addEventListener("click", async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "正在导出…";
    try { await downloadWeightedExport(rows, button.dataset.weightedExport); button.textContent = "已开始下载"; }
    catch (error) { button.textContent = error.message || "导出失败"; }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 1400);
  }));
}

function restoreMessages() {
  messages.innerHTML = "";
  messageHistory.forEach((item) => addMessage(item.role, item.html, { remember: false }));
}

function serializableFiles() {
  return [...selectedFiles.values()].map((item) => ({ path: item.file.path, confirmation: item.confirmation ?? null }));
}

function textFromHtml(html) {
  const element = document.createElement("div");
  element.innerHTML = String(html ?? "");
  return element.textContent.replace(/\s+/g, " ").trim();
}

function recoverRequirementsFromHistory() {
  const userMessages = messageHistory.filter((item) => item.role === "user").map((item) => textFromHtml(item.html));
  Object.assign(requirements, rebuildCalculationRequirements(requirements, userMessages, { hasBlackbodySource: hasBlackbodySource() }));
}

function historyEntries() {
  try { return JSON.parse(localStorage.getItem(historyKey) || "[]"); } catch { return []; }
}

function sessionTitle() {
  const firstUser = messageHistory.find((item) => item.role === "user");
  return (firstUser ? textFromHtml(firstUser.html) : "新的光谱分析会话").slice(0, 48) || "新的光谱分析会话";
}

function saveHistorySnapshot() {
  const snapshot = { id: currentSessionId, title: sessionTitle(), updatedAt: Date.now(), messageHistory, files: serializableFiles(), requirements, artifactGroups, closedArtifactGroupIds: [...closedArtifactGroupIds] };
  const next = [snapshot, ...historyEntries().filter((item) => item?.id !== currentSessionId)].slice(0, 30);
  localStorage.setItem(historyKey, JSON.stringify(next));
}

function renderHistory() {
  const entries = historyEntries();
  historyList.innerHTML = entries.length ? entries.map((entry) => `<article class="history-item"><div><b>${escaped(entry.title || "未命名会话")}</b><span>${new Date(entry.updatedAt).toLocaleString("zh-CN")} · ${(entry.artifactGroups ?? []).length} 个交付物</span></div><div class="history-actions"><button class="secondary" data-history-open="${escaped(entry.id)}" type="button">打开</button><button class="secondary danger" data-history-delete="${escaped(entry.id)}" type="button">删除</button></div></article>`).join("") : "<p class=\"muted\">还没有可保存的历史会话。</p>";
  historyList.querySelectorAll("[data-history-delete]").forEach((button) => button.addEventListener("click", () => {
    localStorage.setItem(historyKey, JSON.stringify(historyEntries().filter((entry) => entry.id !== button.dataset.historyDelete)));
    renderHistory();
  }));
  historyList.querySelectorAll("[data-history-open]").forEach((button) => button.addEventListener("click", () => loadHistorySession(button.dataset.historyOpen)));
}

async function restoreFiles(files = []) {
  if (!files.length) return;
  const response = await request("/api/inspect-many", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: files.map((file) => file.path) }) });
  const data = await response.json();
  data.files.forEach((item) => selectedFiles.set(item.file.path, { ...item, confirmation: files.find((file) => file.path === item.file.path)?.confirmation ?? null }));
}

async function loadHistorySession(id) {
  const entry = historyEntries().find((item) => item.id === id);
  if (!entry) return;
  currentSessionId = entry.id;
  sessionStorage.setItem("spectra-copilot-current-session", currentSessionId);
  messageHistory = Array.isArray(entry.messageHistory) ? entry.messageHistory : [];
  artifactGroups = normaliseArtifactGroups(entry.artifactGroups);
  activeArtifactGroupId = artifactGroups[0]?.id ?? "";
  closedArtifactGroupIds = new Set(entry.closedArtifactGroupIds ?? []);
  Object.assign(requirements, entry.requirements ?? {});
  selectedFiles.clear();
  restoreMessages();
  closeModal(historyDialog);
  try {
    await restoreFiles(entry.files);
    if (!aiSession.apiKey) recoverRequirementsFromHistory();
  } catch (error) { addMessage("assistant", `<p class="inline-warning">历史已打开，但部分原文件无法重新读取：${escaped(error.message)}</p>`); }
  renderStatus();
  renderArtifactPanel();
  saveSession();
}

function artifactKind(artifact) { return artifact.kind ?? (/\.svg$/i.test(artifact.filename) ? "chart" : "report"); }

function normaliseArtifactGroups(savedGroups, legacyArtifacts = []) {
  if (Array.isArray(savedGroups)) return savedGroups.filter((group) => group?.id && Array.isArray(group.versions) && group.versions.length).map((group) => ({ ...group, activeIndex: Math.min(Math.max(Number(group.activeIndex) || 0, 0), group.versions.length - 1) }));
  return (Array.isArray(legacyArtifacts) ? legacyArtifacts : []).map((artifact) => ({ id: artifact.id, kind: artifactKind(artifact), label: artifact.filename, versions: [artifact], activeIndex: 0 }));
}

function renderArtifactMentions() {
  renderMentionMenu();
}

function mentionContext() {
  const caret = chatInput.selectionStart ?? chatInput.value.length;
  const before = chatInput.value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || before.slice(at + 1).includes("\n")) return null;
  const query = before.slice(at + 1);
  const completed = mentionItems().some((item) => query.startsWith(item.label) && /^\s/.test(query.slice(item.label.length)));
  return completed ? null : { at, caret, query };
}

function closeMentionMenu() {
  artifactMentions.classList.add("hidden");
  artifactMentions.innerHTML = "";
  chatInput.setAttribute("aria-expanded", "false");
}

function renderMentionMenu() {
  const context = mentionContext();
  if (!context) return closeMentionMenu();
  const query = context.query.trim().toLowerCase();
  const matches = mentionItems().filter((item) => !query || item.label.toLowerCase().includes(query)).slice(0, 10);
  if (!matches.length) return closeMentionMenu();
  artifactMentions.innerHTML = matches.map((item) => `<button type="button" role="option" data-mention-label="${escaped(item.label)}"><span>${escaped(item.label)}</span><small>${escaped(item.kind)}</small></button>`).join("");
  artifactMentions.classList.remove("hidden");
  chatInput.setAttribute("aria-expanded", "true");
  artifactMentions.querySelectorAll("[data-mention-label]").forEach((button) => button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const fresh = mentionContext();
    if (!fresh) return;
    const label = button.dataset.mentionLabel;
    chatInput.value = `${chatInput.value.slice(0, fresh.at)}@${label} ${chatInput.value.slice(fresh.caret)}`;
    const nextCaret = fresh.at + label.length + 2;
    chatInput.setSelectionRange(nextCaret, nextCaret);
    closeMentionMenu();
    chatInput.focus();
  }));
}

function activeArtifactGroup() {
  const visible = artifactGroups.filter((group) => !closedArtifactGroupIds.has(group.id));
  return visible.find((group) => group.id === activeArtifactGroupId) ?? visible[0] ?? null;
}

function setPreviewOpen(open) {
  previewIsOpen = Boolean(open);
  workbench.classList.toggle("preview-closed", !previewIsOpen);
  togglePreviewButton.textContent = previewIsOpen ? "隐藏预览" : "交付物预览";
  localStorage.setItem(previewKey, previewIsOpen ? "open" : "closed");
}

async function renderPlotlyPreview(host, artifact) {
  try {
    if (!window.Plotly) throw new Error("Plotly 未加载");
    const response = await request(`${artifact.url}?plotly=1`);
    const figure = await response.json();
    await window.Plotly.react(host, figure.data, figure.layout, figure.config);
    host.dataset.exportOptions = JSON.stringify(figure.exportOptions ?? {});
    host.title = "右键可复制这张图片";
    host.oncontextmenu = (event) => showChartContextMenu(event, host);
  } catch {
    host.innerHTML = `<img src="${escaped(`${artifact.url}?preview=1`)}" alt="${escaped(artifact.filename)} 的静态预览" />`;
  }
}

async function copyPlotlyImage(host) {
  if (!window.Plotly?.toImage || !navigator.clipboard?.write || !window.ClipboardItem) throw new Error("当前浏览器不支持复制图片，请用下载按钮保存。");
  const exportHost = document.createElement("div");
  exportHost.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:760px;background:#fff";
  document.body.append(exportHost);
  try {
    const layout = { ...(host.layout ?? {}), width: 1200, height: 760, autosize: false, paper_bgcolor: "#ffffff", plot_bgcolor: host.layout?.plot_bgcolor || "#fbfcff" };
    await window.Plotly.newPlot(exportHost, host.data ?? [], layout, { displayModeBar: false, displaylogo: false, staticPlot: true });
    const dataUrl = await window.Plotly.toImage(exportHost, { format: "png", width: 1200, height: 760, scale: 1 });
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  } finally {
    window.Plotly.purge(exportHost);
    exportHost.remove();
  }
}

function showChartContextMenu(event, host) {
  event.preventDefault();
  document.querySelector(".chart-context-menu")?.remove();
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "chart-context-menu";
  menu.textContent = "复制图片";
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 150)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 52)}px`;
  menu.addEventListener("click", async () => {
    try { await copyPlotlyImage(host); menu.textContent = "已复制图片"; setTimeout(() => menu.remove(), 800); }
    catch (error) { menu.textContent = error.message; setTimeout(() => menu.remove(), 1800); }
  });
  document.body.append(menu);
  setTimeout(() => document.addEventListener("pointerdown", (nextEvent) => { if (nextEvent.target !== menu) menu.remove(); }, { once: true }), 0);
}

function renderArtifactPanel() {
  renderArtifactMentions();
  const group = activeArtifactGroup();
  if (group) activeArtifactGroupId = group.id;
  if (!group) {
    const closed = artifactGroups.filter((item) => closedArtifactGroupIds.has(item.id));
    artifactPanel.innerHTML = closed.length ? `<p class="step">交付物预览</p><h2>预览已关闭</h2><p class="muted">交付物仍被保留；你可以随时重新打开。</p><div class="closed-artifacts">${closed.map((item) => `<button class="secondary" data-reopen-artifact="${escaped(item.id)}">重新打开 ${escaped(item.label)}</button>`).join("")}</div>` : `<p class="step">交付物预览</p><h2>还没有生成内容</h2><p class="muted">当 Agent 生成谱图或报告后，会直接在这里预览。选中预览后，可以继续告诉它如何修改。</p>`;
    artifactPanel.querySelectorAll("[data-reopen-artifact]").forEach((button) => button.addEventListener("click", () => { closedArtifactGroupIds.delete(button.dataset.reopenArtifact); activeArtifactGroupId = button.dataset.reopenArtifact; setPreviewOpen(true); saveSession(); renderArtifactPanel(); }));
    return;
  }
  const active = group.versions[group.activeIndex];
  const previewUrl = `${active.url}?preview=1`;
  const isChart = group.kind === "chart";
  const isData = group.kind === "data";
  const preview = isData
    ? `<div class="data-preview"><p>这是可下载的数据交付物。</p><a class="primary report-open" href="${escaped(active.url)}" download="${escaped(active.filename)}">下载 ${escaped(/\.xlsx$/i.test(active.filename) ? "Excel 表格" : "CSV")}</a></div>`
    : isChart
    ? `<div class="artifact-preview plotly-preview" data-plotly-preview></div>`
    : `<div class="report-open-card"><div class="artifact-preview report-preview"><iframe title="${escaped(active.filename)} 的网页预览" sandbox="" src="${escaped(previewUrl)}"></iframe></div><a class="primary report-open" href="${escaped(previewUrl)}" target="_blank" rel="noopener">在新网页打开完整报告</a></div>`;
  const download = isChart ? `<button class="secondary" type="button" data-download-plotly>下载当前版本（Plotly SVG）</button>` : `<a class="download-link" href="${escaped(active.url)}" download="${escaped(active.filename)}">下载当前版本</a>`;
  const visibleGroups = artifactGroups.filter((item) => !closedArtifactGroupIds.has(item.id));
  const closedGroups = artifactGroups.filter((item) => closedArtifactGroupIds.has(item.id));
  artifactPanel.innerHTML = `<div class="preview-heading"><p class="step">交付物预览 · ${visibleGroups.length} 项打开</p><button class="preview-close" data-close-artifact aria-label="关闭当前交付物" title="关闭当前交付物">×</button></div><details class="artifact-picker" open><summary>展开选择交付物</summary><div class="artifact-tabs">${visibleGroups.map((item) => `<span class="artifact-tab-wrap"><button class="artifact-tab ${item.id === group.id ? "active" : ""}" data-artifact-group="${escaped(item.id)}" title="${escaped(item.label)}">${escaped(item.label)}</button><button class="artifact-tab-close" data-delete-artifact="${escaped(item.id)}" title="关闭此预览（可重新打开）" aria-label="关闭 ${escaped(item.label)}">×</button></span>`).join("")}</div>${closedGroups.length ? `<div class="closed-artifacts"><p class="muted">已关闭的预览</p>${closedGroups.map((item) => `<button class="secondary" data-reopen-artifact="${escaped(item.id)}">重新打开：${escaped(item.label)}</button>`).join("")}</div>` : ""}</details><h2>${escaped(active.filename)}</h2><div class="version-controls"><button class="secondary" data-version-previous ${group.activeIndex === 0 ? "disabled" : ""}>← 上一版</button><span>版本 ${group.activeIndex + 1} / ${group.versions.length}</span><button class="secondary" data-version-next ${group.activeIndex >= group.versions.length - 1 ? "disabled" : ""}>下一版 →</button></div>${preview}<div class="artifact-download">${download}</div><div class="revision-box"><label for="revision-input">继续修改这个交付物</label><textarea id="revision-input" placeholder="例如：把曲线改为红色；把坐标轴和图例做成答辩风格；报告改成论文结果段的结构"></textarea><button id="revision-submit" class="primary" type="button">交给 Agent 修改</button><p class="muted">修改会写入当前交付物的下一版本；可用上方按钮回退或前进。</p></div>`;
  artifactPanel.querySelector("[data-close-artifact]").addEventListener("click", () => { closedArtifactGroupIds.add(group.id); saveSession(); renderArtifactPanel(); });
  artifactPanel.querySelectorAll("[data-artifact-group]").forEach((button) => button.addEventListener("click", () => {
    activeArtifactGroupId = button.dataset.artifactGroup;
    renderArtifactPanel();
  }));
  artifactPanel.querySelectorAll("[data-delete-artifact]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.deleteArtifact;
    closedArtifactGroupIds.add(id);
    if (activeArtifactGroupId === id) activeArtifactGroupId = artifactGroups.find((item) => item.id !== id && !closedArtifactGroupIds.has(item.id))?.id ?? "";
    saveSession();
    renderArtifactPanel();
  }));
  artifactPanel.querySelectorAll("[data-reopen-artifact]").forEach((button) => button.addEventListener("click", () => { closedArtifactGroupIds.delete(button.dataset.reopenArtifact); activeArtifactGroupId = button.dataset.reopenArtifact; saveSession(); renderArtifactPanel(); }));
  artifactPanel.querySelector("[data-version-previous]").addEventListener("click", () => { group.activeIndex -= 1; saveSession(); renderArtifactPanel(); });
  artifactPanel.querySelector("[data-version-next]").addEventListener("click", () => { group.activeIndex += 1; saveSession(); renderArtifactPanel(); });
  if (isChart) {
    const previewHost = artifactPanel.querySelector("[data-plotly-preview]");
    renderPlotlyPreview(previewHost, active);
    artifactPanel.querySelector("[data-download-plotly]").addEventListener("click", () => {
      if (!window.Plotly || !previewHost.data || !previewHost.layout) return window.open(active.url, "_blank", "noopener");
      const options = JSON.parse(previewHost.dataset.exportOptions || "{}");
      window.Plotly.downloadImage(previewHost, { format: "svg", filename: active.filename.replace(/\.svg$/i, ""), height: 500, width: 800, ...options });
    });
  }
  artifactPanel.querySelector("#revision-submit").addEventListener("click", () => {
    const instruction = artifactPanel.querySelector("#revision-input").value.trim();
    if (!instruction) return;
    pendingRevisionGroupId = group.id;
    submitChatMessage(`我正在预览交付物“${active.filename}”。请在保留数据真实性的前提下修改：${instruction}`);
  });
}

function rememberArtifacts(artifacts = []) {
  artifacts = artifacts.filter((artifact) => artifactKind(artifact) !== "data");
  if (!artifacts.length) return;
  const target = artifactGroups.find((group) => group.id === pendingRevisionGroupId);
  artifacts.forEach((artifact) => {
    if (target && target.kind === artifactKind(artifact)) {
      target.versions.push(artifact);
      target.activeIndex = target.versions.length - 1;
      target.label = artifact.filename;
      activeArtifactGroupId = target.id;
    } else {
      const group = { id: artifact.id, kind: artifactKind(artifact), label: artifact.filename, versions: [artifact], activeIndex: 0 };
      artifactGroups.unshift(group);
      activeArtifactGroupId = group.id;
    }
  });
  pendingRevisionGroupId = "";
  saveSession();
  renderArtifactPanel();
}

function saveSession() {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({ messageHistory, files: serializableFiles(), requirements, aiSession, artifactGroups, closedArtifactGroupIds: [...closedArtifactGroupIds], pendingTaskAfterConfirmation }));
    saveHistorySnapshot();
  } catch { /* 会话恢复失败不影响本地分析 */ }
}

function renderStatus() {
  const count = selectedFiles.size;
  const confirmed = [...selectedFiles.values()].filter((item) => item.confirmation).length;
  const model = aiSession.apiKey ? ` · AI：${aiSession.provider === "deepseek" ? "DeepSeek" : "兼容服务"}` : " · 本地规则模式";
  const remembered = [
    requirements.bandText ? `波段 ${requirements.bandText} μm` : "",
    requirements.temperatureText || requirements.temperatureKelvin ? `黑体 ${requirements.temperatureText || requirements.temperatureKelvin} K` : "",
  ].filter(Boolean);
  const memoryStatus = remembered.length ? ` · 已记忆：${remembered.join("，")}` : "";
  taskStatus.textContent = count ? `本任务：${count} 个文件，${confirmed} 个已确认${model}${memoryStatus}` : `把数据和研究任务直接告诉 Agent。${model}${memoryStatus}`;
  apiSettingsButton.textContent = aiSession.apiKey ? "AI 已连接" : "AI 设置";
}

function renderApiSettings() {
  aiProvider.value = aiSession.provider;
  aiModel.value = aiSession.model;
  aiEndpoint.value = aiSession.endpoint;
  endpointField.classList.toggle("hidden", aiSession.provider !== "compatible");
  apiStatus.textContent = aiSession.apiKey
    ? `已启用 ${aiSession.provider === "deepseek" ? "DeepSeek" : "兼容服务"} / ${aiSession.model}。Key 保存在此浏览器、此设备的本机存储中；新任务与刷新不会要求重填。共用电脑时请在离开前清除 Key。`
    : "未连接时，Agent 仍可执行本地规则与计算工具。";
}

function apiKeyProblem(key, provider) {
  if (key.length < 12) return "Key 长度不够，请粘贴完整的 API Key。";
  if (/[^\x21-\x7e]/.test(key) || /\s/.test(key)) return "API Key 中包含中文、空格或换行。请只粘贴 Key 本身，不要包含“API Key：”等文字。";
  if (provider === "deepseek" && !/^sk-[A-Za-z0-9_-]+$/.test(key)) return "DeepSeek API Key 通常以 sk- 开头；请确认粘贴的是平台生成的 Key，而不是聊天内容。";
  return "";
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "本地服务请求失败。");
  }
  return response;
}

function currentConfirmation(path) { return selectedFiles.get(path)?.confirmation ?? null; }

function sourceMode(item) {
  return (item?.confirmation?.unit ?? item?.metadata?.wavelength?.unit) === "nm" ? "太阳光谱 AM1.5G" : "黑体辐射（波数会换算为 μm）";
}

const unitDisplayNames = { um: "微米（μm）", nm: "纳米（nm）", wavenumber: "波数（cm⁻¹）" };
const typeDisplayNames = { reflectance: "反射率 R", emissivity: "发射率 ε", transmission: "透射率 T", absorption: "吸收率 A" };

async function applyAiUnitInference(inspections) {
  if (!aiSession.apiKey || !inspections.length) return inspections;
  try {
    const response = await request("/api/ai/infer-units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: inspections.map((item) => item.file.path), provider: aiSession.provider, endpoint: aiSession.endpoint, apiKey: aiSession.apiKey, model: aiSession.model }),
    });
    const data = await response.json();
    const suggestions = new Map((data.suggestions ?? []).map((item) => [item.path, item]));
    return inspections.map((item) => {
      const suggestion = suggestions.get(item.file.path);
      if (!suggestion) return item;
      const unit = suggestion.wavelengthUnit;
      return {
        ...item,
        metadata: {
          ...item.metadata,
          wavelength: { ...item.metadata.wavelength, unit, label: unitDisplayNames[unit] ?? item.metadata.wavelength.label, confidence: suggestion.confidence, reason: suggestion.reason },
          valueType: suggestion.valueType,
          valueUnit: suggestion.valueUnit,
        },
        analysis: suggestion.analysis ?? item.analysis,
        aiInference: suggestion,
      };
    });
  } catch (error) {
    addMessage("assistant", `<p class="inline-warning">AI 单位初判暂时不可用，已改用本地规则初判。原因：${escaped(error.message)}</p>`);
    return inspections;
  }
}

async function requestSessionGuide({ phase, userMessage = "", missingDetails = "" }) {
  if (!aiSession.apiKey) return false;
  try {
    const response = await request("/api/ai/session-guide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase,
        userMessage,
        missingDetails,
        paths: [...selectedFiles.keys()],
        confirmations: [...selectedFiles.values()].map((item) => item.confirmation).filter(Boolean),
        requirements,
        provider: aiSession.provider,
        endpoint: aiSession.endpoint,
        apiKey: aiSession.apiKey,
        model: aiSession.model,
      }),
    });
    const data = await response.json();
    await addTypedAssistantMessage(data.guide.answer, { footer: `<p class="muted">模型：${escaped(data.guide.model)}</p>` });
    return true;
  } catch (error) {
    addMessage("assistant", `<p class="inline-warning">AI 对话引导暂时不可用，以下先由本地保护规则继续：${escaped(error.message)}</p>`);
    return false;
  }
}

function updateFile(path, update) {
  const item = selectedFiles.get(path);
  if (!item) return;
  selectedFiles.set(path, { ...item, ...update });
  saveSession();
  renderStatus();
}

function confirmationCard(items = null) {
  const pending = (Array.isArray(items) ? items : items ? [items] : [...selectedFiles.values()]).filter((item) => !item.confirmation);
  if (!pending.length) return;
  const rows = pending.map((item, index) => {
    const { file, metadata, analysis } = item;
    const inference = item.aiInference
      ? `<p class="ai-inference"><b>AI 初判（${escaped({ high: "高", medium: "中", low: "低" }[item.aiInference.confidence] ?? "低")}置信度）：</b>${escaped(unitDisplayNames[item.aiInference.wavelengthUnit] ?? metadata.wavelength.label)}；${escaped(typeDisplayNames[item.aiInference.valueType] ?? metadata.valueType)}；${escaped(item.aiInference.valueUnit === "percent" ? "百分比" : "0–1")}。${escaped(item.aiInference.reason)}</p>`
      : `<p class="muted">本次未调用 AI，以下为本地规则初判。</p>`;
    const warning = analysis.warnings.length ? `<p class="inline-warning">提醒：${escaped(analysis.warnings[0])}</p>` : "";
    return `<section class="confirmation-row" data-confirmation-row="${index}"><p><b>${escaped(file.name)}</b> · ${analysis.validPointCount} 点 · 初判范围 ${analysis.rangeUm[0].toPrecision(4)}–${analysis.rangeUm[1].toPrecision(4)} μm</p>${inference}<div class="inline-settings"><label>横坐标<select data-unit><option value="um" ${metadata.wavelength.unit === "um" ? "selected" : ""}>μm</option><option value="nm" ${metadata.wavelength.unit === "nm" ? "selected" : ""}>nm</option><option value="wavenumber" ${metadata.wavelength.unit === "wavenumber" ? "selected" : ""}>波数 cm⁻¹</option></select></label><label>Y 值<select data-type><option value="reflectance" ${metadata.valueType === "reflectance" ? "selected" : ""}>反射率 R</option><option value="emissivity" ${metadata.valueType === "emissivity" ? "selected" : ""}>发射率 ε</option><option value="transmission" ${metadata.valueType === "transmission" ? "selected" : ""}>透射率 T</option><option value="absorption" ${metadata.valueType === "absorption" ? "selected" : ""}>吸收率 A</option></select></label><label>数值<select data-value-unit><option value="ratio" ${metadata.valueUnit === "ratio" ? "selected" : ""}>0–1</option><option value="percent" ${metadata.valueUnit === "percent" ? "selected" : ""}>百分比</option></select></label></div><label class="inline-check"><input data-opaque type="checkbox" /> 样品近似不透明（T≈0）</label>${warning}</section>`;
  }).join("");
  const article = addMessage("assistant", `<p>我已读取这 ${pending.length} 份文件。请一次确认每份数据的含义；确认后不会再逐份重复询问。</p><div class="inline-card bulk-confirmations">${rows}<button class="primary" data-confirm-all>确认以上全部数据</button></div>`, { remember: false });
  article.querySelector("[data-confirm-all]").addEventListener("click", () => {
    article.querySelectorAll("[data-confirmation-row]").forEach((row, index) => {
      const file = pending[index].file;
      updateFile(file.path, { confirmation: { path: file.path, unit: row.querySelector("[data-unit]").value, valueType: row.querySelector("[data-type]").value, valueUnit: row.querySelector("[data-value-unit]").value, opaque: row.querySelector("[data-opaque]").checked } });
    });
    article.querySelector(".bulk-confirmations").innerHTML = `<p>已一次确认 ${pending.length} 份文件的数据含义。</p>`;
    addMessage("user", `<p>已确认以上 ${pending.length} 份文件的数据含义。</p>`);
    const taskToResume = pendingTaskAfterConfirmation;
    pendingTaskAfterConfirmation = "";
    if (taskToResume) runAgent(taskToResume).catch(showError);
    else requestSessionGuide({ phase: "confirmed" }).then((guided) => {
      if (!guided) addMessage("assistant", `<p>所有文件已确认。${[...selectedFiles.values()].map((candidate) => `${escaped(candidate.file.name)}：${escaped(sourceMode(candidate))}`).join("；")}。需要计算时请告诉我波段（μm）。</p>`);
    });
  });
}

function addInspections(inspections, { announce = true, showConfirmation = true } = {}) {
  inspections.forEach((inspected) => selectedFiles.set(inspected.file.path, { ...inspected, confirmation: currentConfirmation(inspected.file.path) }));
  renderStatus();
  renderArtifactMentions();
  saveSession();
  if (announce) addMessage("assistant", `<p>已把 ${inspections.length} 个文件加入同一个任务。我会汇总所有未确认文件，一次请你确认。</p>`);
  if (showConfirmation) confirmationCard();
}

async function inspectPaths(paths, options = {}) {
  const response = await request("/api/inspect-many", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
  const data = await response.json();
  addInspections(await applyAiUnitInference(data.files), options);
  if (options.guide !== false) requestSessionGuide({ phase: "intake" });
}

async function searchFiles(message) {
  const response = await request(`/api/files?q=${encodeURIComponent(message)}`);
  const data = await response.json();
  if (!data.files.length) return addMessage("assistant", "<p>没有找到匹配的桌面光谱文件。请说出文件名中独特的几个字，或以后使用“选择文件/文件夹”入口授权上传。</p>");
  if (data.files.length === 1) return inspectPaths([data.files[0].path]);
  if (/(全部|所有|都|批量)/.test(message)) return inspectPaths(data.files.map((file) => file.path));
  const article = addMessage("assistant", `<p>找到 ${data.files.length} 个可能文件。你可以逐个选择，或全部加入：</p><div class="file-options"><button class="file-option" data-all>全部加入任务</button>${data.files.map((file) => `<button class="file-option" data-path="${escaped(file.path)}">${escaped(file.name)}</button>`).join("")}</div>`);
  article.querySelector("[data-all]").addEventListener("click", () => inspectPaths(data.files.map((file) => file.path)).catch(showError));
  article.querySelectorAll("[data-path]").forEach((button) => button.addEventListener("click", () => inspectPaths([button.dataset.path]).catch(showError)));
}

function taskPayload(task, images = []) {
  const toPlainText = (html) => {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element.textContent.replace(/\s+/g, " ").trim().slice(0, 1200);
  };
  const activeGroup = artifactGroups.find((group) => group.id === pendingRevisionGroupId) ?? activeArtifactGroup();
  const activeArtifact = activeGroup?.versions[activeGroup.activeIndex];
  const fileInterpretations = [...selectedFiles.values()].map((item) => ({
    path: item.file.path,
    name: item.file.name,
    wavelengthUnit: item.aiInference?.wavelengthUnit ?? item.metadata?.wavelength?.unit,
    valueType: item.aiInference?.valueType ?? item.metadata?.valueType,
    valueUnit: item.aiInference?.valueUnit ?? item.metadata?.valueUnit,
    confidence: item.aiInference?.confidence ?? item.metadata?.wavelength?.confidence ?? "low",
    reason: item.aiInference?.reason ?? item.metadata?.wavelength?.reason ?? "",
  }));
  return { task, images: images.map((image) => image.dataUrl).filter((value) => typeof value === "string"), conversation: messageHistory.slice(-30).map((item) => ({ role: item.role, content: toPlainText(item.html) })), paths: [...selectedFiles.keys()], confirmations: [...selectedFiles.values()].map((item) => item.confirmation).filter(Boolean), fileInterpretations, requirements, activeArtifact: activeArtifact ? { id: activeArtifact.id, filename: activeArtifact.filename, kind: activeGroup.kind, version: activeGroup.activeIndex + 1, isRevisionTarget: Boolean(pendingRevisionGroupId) } : null, provider: aiSession.provider, endpoint: aiSession.endpoint, apiKey: aiSession.apiKey, model: aiSession.model };
}

function inferRevisionTarget(message) {
  const text = String(message ?? "");
  const mentioned = [...text.matchAll(/@([^@\n]+)/g)].map((match) => match[1].trim());
  const mentionTarget = artifactGroups.find((group) => mentioned.some((name) => name === group.label || name.startsWith(group.label) || group.versions.some((artifact) => name === artifact.filename || name.startsWith(artifact.filename))));
  if (mentionTarget) return mentionTarget.id;
  const named = artifactGroups.find((group) => group.versions.some((artifact) => text.includes(artifact.filename)));
  if (named) return named.id;
  if (/(修改|改成|调整|变成|换成|美化|标题|颜色|坐标|图例|刚才|刚刚|这个|该)/.test(text)) return activeArtifactGroup()?.id ?? "";
  return "";
}

function renderPlan(plan) {
  addMessage("assistant", `<div class="inline-card"><p><b>我理解的任务：</b>${escaped(plan.task)}</p><p><b>建议交付：</b>${plan.deliverables.map(escaped).join("；") || "分析说明"}</p><ol>${plan.steps.map((step) => `<li>${escaped(step)}</li>`).join("")}</ol>${plan.questions.length ? `<p class="inline-warning">还需确认：${plan.questions.map(escaped).join("；")}</p>` : ""}${plan.ai ? `<details><summary>查看模型建议（${escaped(plan.ai.model)}）</summary><div class="model-reply">${formatModelReply(plan.ai.advice)}</div></details>` : ""}</div>`);
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function createRunTimeline() {
  const article = addMessage("assistant", `<div class="run-card"><p><b>Agent 正在运行</b> <span data-run-clock>00:00</span></p><ol data-run-steps><li><span>00:00</span> 已接收任务</li><li class="active"><span>00:00</span> 正在读取任务条件</li></ol></div>`, { remember: false });
  const startedAt = Date.now();
  const clock = article.querySelector("[data-run-clock]");
  const active = article.querySelector(".active span");
  const timer = setInterval(() => {
    const elapsed = formatElapsed(Date.now() - startedAt);
    clock.textContent = elapsed;
    active.textContent = elapsed;
  }, 250);
  return { article, startedAt, timer, events: [{ label: "已接收任务", kind: "done" }, { label: "正在读取任务条件", kind: "active" }] };
}

function appendRunEvent(timeline, event) {
  const labels = { decision: "准备", model_note: "模型说明", tool_start: "调用", tool_done: "完成", retry: "重试", answer: "整理" };
  timeline.events.forEach((item) => { if (item.kind === "active") item.kind = "done"; });
  timeline.events.push({ label: `${labels[event.type] ?? "Agent"}：${event.label}`, kind: event.type === "answer" ? "done" : "active" });
  const steps = timeline.article.querySelector("[data-run-steps]");
  if (!steps) return;
  steps.innerHTML = timeline.events.map((item) => `<li class="${item.kind}"><span>${formatElapsed(Date.now() - timeline.startedAt)}</span>${escaped(item.label)}</li>`).join("");
  timeline.article.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function streamAgent(task, timeline, images = []) {
  const response = await fetch("/api/agent/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(taskPayload(task, images)) });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Agent 流式连接失败。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", completed = null;
  const consume = (chunk) => {
    for (const block of chunk.split("\n\n")) {
      if (!block.trim()) continue;
      const event = /^event:\s*(.+)$/m.exec(block)?.[1];
      const raw = /^data:\s*(.+)$/m.exec(block)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === "progress") appendRunEvent(timeline, data);
      else if (event === "complete") completed = data.agent;
      else if (event === "error") {
        const error = new Error(data.error || "Agent 运行失败。");
        error.partial = data.partial;
        throw error;
      }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error("Agent 没有返回完成结果。");
  return completed;
}

function hasBlackbodySource() {
  return [...selectedFiles.values()].some((item) => (item.confirmation?.unit ?? item.metadata?.wavelength?.unit) !== "nm");
}

function needsCalculationDetails(task) {
  return Boolean(requirements.bandText) || /(计算|加权|weighted|分析|比较|对比|筛选|图|曲线|绘|报告|结论|生成|太阳|黑体|波段|积分|指标)/i.test(String(task ?? ""));
}

function missingCalculationDetails(task) {
  if (!needsCalculationDetails(task)) return "";
  if (!requirements.bandText) return "开始计算前请先告诉我需要计算或框选的波段（单位统一用 μm），例如“3-5；8-12”。我会把这个条件记住。";
  if (hasBlackbodySource() && !(requirements.temperatureText || requirements.temperatureKelvin)) return `已记住波段 ${escaped(requirements.bandText)} μm。当前有微米或波数数据，按你的规则会用黑体光谱；请再告诉我黑体温度（K），例如“300 K”或“300, 500 K”。纳米数据会自动使用太阳光谱，不需要温度。`;
  return "";
}

async function runAgent(task, images = []) {
  if (!selectedFiles.size && !images.length && !aiSession.apiKey) return addMessage("assistant", "<p>请先告诉我需要读取哪个文件，例如“读取所有 MXene 数据”，或直接粘贴一张图片。</p>");
  const allConfirmed = [...selectedFiles.values()].every((item) => item.confirmation);
  const calculationIntent = /(计算|加权|weighted|分析|比较|对比|筛选|图|曲线|绘|报告|结论|生成|太阳|黑体|波段|积分|指标)/i.test(String(task ?? ""));
  if (!aiSession.apiKey && selectedFiles.size && !allConfirmed && calculationIntent) {
    pendingTaskAfterConfirmation = task;
    saveSession();
    confirmationCard();
    return;
  }
  const missingDetails = !aiSession.apiKey && selectedFiles.size && allConfirmed ? missingCalculationDetails(task) : "";
  if (missingDetails) {
    const guided = await requestSessionGuide({ phase: "need-input", userMessage: task, missingDetails });
    if (!guided) addMessage("assistant", `<p>${missingDetails}</p>`);
    return;
  }
  if (!aiSession.apiKey) return addMessage("assistant", "<p>你现在处于本地规则模式，无法理解“是的”这类依赖上下文的话。请先在右上角 AI 设置中启用自己的模型 Key；之后我会保留对话上下文，并由模型选择工具执行任务。</p>");
  const timeline = createRunTimeline();
  try {
    const agent = await streamAgent(task, timeline, images);
    clearInterval(timeline.timer);
    const total = agent.durationMs ?? Date.now() - timeline.startedAt;
    if (agent.requirements && typeof agent.requirements === "object") Object.assign(requirements, agent.requirements);
    for (const confirmation of Array.isArray(agent.confirmations) ? agent.confirmations : []) {
      const item = selectedFiles.get(confirmation.path);
      if (item) selectedFiles.set(confirmation.path, { ...item, confirmation });
    }
    saveSession();
    renderStatus();
    rememberArtifacts(agent.artifacts);
    timeline.article.querySelector(".run-card").innerHTML = `<p><b>Agent 已完成</b> <span>${formatElapsed(total)}</span></p><details><summary>展开查看执行记录</summary><ol>${agent.trace.map((item) => `<li><span>${formatElapsed(item.elapsedMs ?? total)}</span><b>${escaped(item.tool)}</b>：${escaped(item.resultSummary)}</li>`).join("")}<li><span>${formatElapsed(total)}</span>完成答复整理</li></ol></details><p class="muted">这里只记录做了什么和工具返回什么；不展示模型私密推理。</p>`;
    const artifactItems = (agent.artifacts ?? []).filter((artifact) => artifactKind(artifact) !== "data").map((artifact) => `<button class="secondary inline-preview-button" type="button" data-open-artifact-id="${escaped(artifact.id)}">预览 ${escaped(artifact.filename)}</button>`).join("");
    const artifactActions = artifactItems ? `<div class="artifact-links">${artifactItems}</div>` : "";
    const weightedActions = Array.isArray(agent.weightedRows) && agent.weightedRows.length ? `<div class="weighted-export"><span>导出本次加权计算结果：</span><button class="secondary" type="button" data-weighted-export="csv">下载 CSV</button><button class="secondary" type="button" data-weighted-export="xlsx">下载 Excel</button></div>` : "";
    const finalArticle = await typeIntoRunMessage(timeline.article, agent.answer, { footer: `${artifactActions}${weightedActions}<p class="muted">模型：${escaped(agent.model)}${agent.usage ? ` · ${agent.usage.totalTokens ?? "未知"} tokens` : ""}</p>` });
    bindWeightedExportControls(finalArticle, agent.weightedRows);
  } catch (error) {
    clearInterval(timeline.timer);
    const partial = error.partial && typeof error.partial === "object" ? error.partial : null;
    if (partial?.requirements) Object.assign(requirements, partial.requirements);
    for (const confirmation of Array.isArray(partial?.confirmations) ? partial.confirmations : []) {
      const item = selectedFiles.get(confirmation.path);
      if (item) selectedFiles.set(confirmation.path, { ...item, confirmation });
    }
    if (Array.isArray(partial?.artifacts) && partial.artifacts.length) rememberArtifacts(partial.artifacts);
    saveSession();
    renderStatus();
    const elapsed = partial?.durationMs ?? Date.now() - timeline.startedAt;
    const trace = Array.isArray(partial?.trace) && partial.trace.length
      ? partial.trace.map((item) => `<li><span>${formatElapsed(item.elapsedMs ?? elapsed)}</span><b>${escaped(item.tool)}</b>：${escaped(item.resultSummary)}</li>`).join("")
      : timeline.events.map((item) => `<li><span>${formatElapsed(elapsed)}</span>${escaped(item.label)}</li>`).join("");
    const preserved = partial?.artifacts?.length ? `<p class="muted">失败前已经生成的 ${partial.artifacts.length} 个交付物已保留在侧边预览中。</p>` : "";
    timeline.article.querySelector(".run-card").innerHTML = `<p><b>Agent 运行未完成</b> <span>${formatElapsed(elapsed)}</span></p><p class="error-text">${escaped(error.message)}</p><details open><summary>查看失败前的完整执行记录</summary><ol>${trace}</ol></details>${preserved}<button class="secondary retry-agent" type="button">重试本次任务</button>`;
    timeline.article.querySelector(".retry-agent")?.addEventListener("click", () => runAgent(task, images));
    messageHistory.push({ role: "assistant", html: timeline.article.querySelector(".message-content").innerHTML });
    messageHistory = messageHistory.slice(-80);
    saveSession();
  }
}

async function createArtifact(kind) {
  const first = [...selectedFiles.values()][0];
  if (!first) return addMessage("assistant", "<p>请先读取一个文件。</p>");
  if (!first.confirmation) return addMessage("assistant", "<p>请先确认数据单位，再生成结果。</p>");
  const response = await request(kind === "chart" ? "/api/chart" : "/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: first.file.path, ...first.confirmation, bandText: requirements.bandText, temperatureKelvin: requirements.temperatureKelvin }) });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const label = kind === "chart" ? "谱图 SVG" : "分析报告 HTML";
  addMessage("assistant", `<p>已生成 ${label}：<a class="download-link" href="${url}" download="${kind === "chart" ? "spectrum-chart.svg" : "spectrum-report.html"}">下载</a>${kind === "chart" ? `<br><img class="chart-preview" src="${url}" alt="生成的光谱图" />` : ""}</p>`);
}

function rememberDetails(message) {
  Object.assign(requirements, mergeCalculationRequirements(requirements, message, {
    hasBlackbodySource: hasBlackbodySource(),
    expectsTemperature: Boolean(requirements.bandText && hasBlackbodySource() && !(requirements.temperatureText || requirements.temperatureKelvin)),
  }));
  saveSession();
  renderStatus();
}

function showError(error) { addMessage("assistant", `<p class="error-text">${escaped(error.message)}</p>`); }

function clearSession() {
  if (messageHistory.length || artifactGroups.length) saveHistorySnapshot();
  stagedSpectrumFiles.forEach((entry) => { entry.cancelled = true; entry.xhr?.abort(); });
  sessionStorage.removeItem(sessionKey);
  currentSessionId = crypto.randomUUID();
  sessionStorage.setItem("spectra-copilot-current-session", currentSessionId);
  selectedFiles.clear();
  requirements.bandText = "";
  requirements.temperatureKelvin = "";
  requirements.temperatureText = "";
  messageHistory = [];
  artifactGroups = [];
  closedArtifactGroupIds = new Set();
  activeArtifactGroupId = "";
  pendingRevisionGroupId = "";
  pendingTaskAfterConfirmation = "";
  pendingImages = [];
  stagedSpectrumFiles = [];
  messages.innerHTML = "";
  renderImageTray();
  renderFileTray();
  renderStatus();
  renderArtifactPanel();
  addMessage("assistant", "<p>新任务已开始。你可以说“读取所有 MXene 数据”，或直接告诉我想分析什么。</p>");
}

async function restoreSession() {
  const saved = sessionStorage.getItem(sessionKey);
  if (!saved) return clearSession();
  try {
    const state = JSON.parse(saved);
    messageHistory = Array.isArray(state.messageHistory) ? state.messageHistory : [];
    artifactGroups = normaliseArtifactGroups(state.artifactGroups, state.artifacts);
    activeArtifactGroupId = artifactGroups[0]?.id ?? "";
    closedArtifactGroupIds = new Set(state.closedArtifactGroupIds ?? []);
    pendingTaskAfterConfirmation = typeof state.pendingTaskAfterConfirmation === "string" ? state.pendingTaskAfterConfirmation : "";
    Object.assign(requirements, state.requirements ?? {});
    Object.assign(aiSession, state.aiSession ?? {});
    try { Object.assign(aiSession, JSON.parse(localStorage.getItem(apiProfileKey) || "{}")); } catch { /* 使用会话配置 */ }
    restoreMessages();
    renderStatus();
    renderArtifactPanel();
    const files = Array.isArray(state.files) ? state.files : [];
    if (files.length) {
      await restoreFiles(files);
      if (!aiSession.apiKey) recoverRequirementsFromHistory();
      renderStatus();
      const remembered = [requirements.bandText ? `波段 ${requirements.bandText} μm` : "", requirements.temperatureText || requirements.temperatureKelvin ? `黑体温度 ${requirements.temperatureText || requirements.temperatureKelvin} K` : ""].filter(Boolean);
      addMessage("assistant", `<p>已恢复上次任务：${files.length} 个已授权文件${remembered.length ? `，并恢复了${escaped(remembered.join("、"))}` : ""}。你可以继续告诉我下一步。</p>`);
    }
  } catch {
    clearSession();
  }
}

async function submitChatMessage(message, images = [], attachmentNames = []) {
  message = String(message ?? "").trim();
  if (!message && !images.length && !attachmentNames.length) return;
  pendingRevisionGroupId = inferRevisionTarget(message);
  if (pendingRevisionGroupId) activeArtifactGroupId = pendingRevisionGroupId;
  const attachmentChips = attachmentNames.length ? `<div class="message-file-list">${attachmentNames.map((name) => `<button type="button" class="message-file-chip" data-mention-file="${escaped(name)}">@${escaped(name)}</button>`).join("")}</div>` : "";
  const userArticle = addMessage("user", `<p>${escaped(message || (images.length ? "请分析我附上的图片。" : "我已上传附件，请先阅读并告诉我它们包含什么。"))}</p>${attachmentChips}${images.length ? `<p class="muted">已附上 ${images.length} 张图片供支持视觉的模型分析。</p>` : ""}`);
  userArticle.querySelectorAll("[data-mention-file]").forEach((button) => button.addEventListener("click", () => { chatInput.value = `@${button.dataset.mentionFile} `; chatInput.focus(); }));
  // 已连接模型时，波段、温度和“是的”等上下文确认由 Agent 工具理解并写入；
  // 本地规则仅作为没有模型时的降级方案。
  if (!aiSession.apiKey) rememberDetails(message);
  try {
    if (/(新任务|清空|重置)/.test(message)) clearSession();
    else if (/(读取|查看|打开|文件|数据|桌面)/.test(message) && !selectedFiles.size) await searchFiles(message);
    else await runAgent(message, images);
  } catch (error) { showError(error); }
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (stagedSpectrumFiles.some((entry) => ["queued", "uploading", "parsing", "inferring"].includes(entry.status))) return;
  const message = chatInput.value.trim();
  const images = [...pendingImages];
  const files = stagedSpectrumFiles.filter((entry) => entry.status === "ready");
  if (!message && !images.length && !files.length) return;
  chatInput.value = "";
  pendingImages = [];
  stagedSpectrumFiles = [];
  renderImageTray();
  renderFileTray();
  if (files.length) addInspections(files.flatMap((entry) => entry.inspections), { announce: false, showConfirmation: false });
  await submitChatMessage(message, images, files.map((entry) => entry.file.name));
});

chatInput.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  attachClipboardImages(files).catch(showError);
});

chatInput.addEventListener("input", renderMentionMenu);
chatInput.addEventListener("click", renderMentionMenu);
chatInput.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMentionMenu(); });
chatInput.addEventListener("blur", () => setTimeout(closeMentionMenu, 120));

fileUpload.addEventListener("change", () => {
  stageAndUploadFiles([...fileUpload.files]).catch(showError);
  fileUpload.value = "";
});

apiSettingsButton.addEventListener("click", () => {
  apiKeyInput.value = aiSession.apiKey;
  renderApiSettings();
  if (!apiDialog.open) apiDialog.showModal();
});
aiProvider.addEventListener("change", () => {
  if (aiProvider.value === "deepseek" && aiModel.value === "") aiModel.value = "deepseek-v4-flash";
  endpointField.classList.toggle("hidden", aiProvider.value !== "compatible");
});
saveApiKeyButton.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  const keyProblem = apiKeyProblem(key, aiProvider.value);
  if (keyProblem) { apiStatus.textContent = keyProblem; return; }
  if (aiProvider.value === "compatible" && !aiEndpoint.value.trim()) { apiStatus.textContent = "请填写兼容服务地址。"; return; }
  aiSession.provider = aiProvider.value;
  aiSession.model = aiModel.value.trim() || "deepseek-v4-flash";
  aiSession.endpoint = aiEndpoint.value.trim();
  aiSession.apiKey = key;
  saveApiProfile();
  saveSession();
  closeModal(apiDialog);
  renderStatus();
  addMessage("assistant", "<p>模型已启用。此浏览器上的新任务和刷新页面都会保持连接；如果要移除它，请在 AI 设置里点击“清除 Key”。</p>");
  if (!selectedFiles.size) requestSessionGuide({ phase: "welcome" });
});
clearApiKeyButton.addEventListener("click", () => {
  aiSession.apiKey = "";
  localStorage.removeItem(apiProfileKey);
  saveSession();
  closeModal(apiDialog);
  renderStatus();
  addMessage("assistant", "<p>已清除当前会话的 API Key。</p>");
});
cancelApiKeyButton.addEventListener("click", () => closeModal(apiDialog));
clearSessionButton.addEventListener("click", clearSession);
togglePreviewButton.addEventListener("click", () => setPreviewOpen(!previewIsOpen));
historyButton.addEventListener("click", () => { renderHistory(); if (!historyDialog.open) historyDialog.showModal(); });
closeHistoryButton.addEventListener("click", () => closeModal(historyDialog));

function setPreviewWidth(width) {
  const bounded = Math.max(320, Math.min(760, Math.round(width)));
  workbench.style.setProperty("--preview-width", `${bounded}px`);
  localStorage.setItem(layoutKey, String(bounded));
}

function initialiseResizableWorkbench() {
  setPreviewOpen(previewIsOpen);
  const savedWidth = Number(localStorage.getItem(layoutKey));
  if (Number.isFinite(savedWidth)) setPreviewWidth(savedWidth);
  workspaceSplitter.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 980px)").matches) return;
    event.preventDefault();
    workspaceSplitter.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-workbench");
    const move = (moveEvent) => {
      const bounds = workbench.getBoundingClientRect();
      setPreviewWidth(bounds.right - moveEvent.clientX);
    };
    const finish = () => {
      document.body.classList.remove("is-resizing-workbench");
      workspaceSplitter.removeEventListener("pointermove", move);
      workspaceSplitter.removeEventListener("pointerup", finish);
      workspaceSplitter.removeEventListener("pointercancel", finish);
    };
    workspaceSplitter.addEventListener("pointermove", move);
    workspaceSplitter.addEventListener("pointerup", finish);
    workspaceSplitter.addEventListener("pointercancel", finish);
  });
}

initialiseResizableWorkbench();
restoreSession();
