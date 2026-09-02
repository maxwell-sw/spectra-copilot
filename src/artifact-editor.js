function stripUnsafeMarkup(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|link|base)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:javascript|data):/gi, "");
}

export function readableArtifactHtml(content) {
  return String(content ?? "").replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (_match, attributes) => `<svg${attributes}><!-- SPECTRA_PROTECTED_SVG：曲线数据已折叠；可以修改 svg 标签属性或外层容器，不能改写内部数据 --></svg>`);
}

export function visibleArtifactText(content) {
  return String(content ?? "")
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function taskExplicitlyEditsText(task) {
  const text = String(task ?? "");
  return /(?:把|将|请|需要|要求|帮我).{0,18}(?:正文|文字|文案|段落|章节|内容).{0,18}(?:改成|修改|改写|重写|删除|删掉|增加|新增|替换)|(?:改写|重写|删除|删掉|增加|新增|替换).{0,18}(?:正文|文字|文案|段落|章节|内容)/.test(text);
}

export function applyArtifactReplacements(content, replacements, { preserveVisibleText = true } = {}) {
  const original = String(content ?? "");
  let next = original;
  const applied = [];
  for (const candidate of Array.isArray(replacements) ? replacements.slice(0, 16) : []) {
    const find = String(candidate?.find ?? "");
    const replacement = String(candidate?.replace ?? "");
    if (!find || find.length > 2400 || replacement.length > 5000) throw new Error("局部替换片段为空或过长，请先读取产物并缩小修改范围。");
    if (/SPECTRA_PROTECTED_SVG/.test(find + replacement)) throw new Error("不能改写折叠的曲线数据；请修改 SVG 标签属性或外层布局。");
    const occurrences = next.split(find).length - 1;
    if (!occurrences) throw new Error(`没有在当前版本中找到要替换的片段：${find.slice(0, 80)}`);
    if (occurrences > 1 && candidate?.replace_all !== true) throw new Error(`要替换的片段出现 ${occurrences} 次，请提供更精确的上下文或明确 replace_all。`);
    next = candidate?.replace_all === true ? next.split(find).join(replacement) : next.replace(find, replacement);
    applied.push({ find: find.slice(0, 120), occurrences: candidate?.replace_all === true ? occurrences : 1 });
  }
  if (!applied.length) throw new Error("至少需要提供一个局部替换。");
  next = stripUnsafeMarkup(next);
  if (preserveVisibleText && visibleArtifactText(next) !== visibleArtifactText(original)) {
    throw new Error("本次任务只允许调整图形或排版，但补丁改变了正文文字，已拒绝保存。请缩小替换范围。");
  }
  return { content: next, applied };
}
