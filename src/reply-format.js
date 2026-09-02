function escaped(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function formatModelReply(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const output = [];
  let list = [];
  const flushList = () => {
    if (list.length) output.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    list = [];
  };
  const inline = (value) => escaped(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const isTableDivider = (value) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value);
  const tableCells = (value) => value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) { flushList(); continue; }

    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      flushList();
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = tableCells(lines[index]).slice(0, headers.length);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells);
        index += 1;
      }
      index -= 1;
      output.push(`<div class="reply-table-wrap"><table class="reply-table"><thead><tr>${headers.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const bullet = /^(?:[-*•]|\d+[.)、])\s+(.+)/.exec(line);
    if (bullet) { list.push(inline(bullet[1])); continue; }
    flushList();
    const heading = /^#{1,4}\s+(.+)/.exec(line);
    output.push(`<p>${heading ? `<strong>${inline(heading[1])}</strong>` : inline(line)}</p>`);
  }
  flushList();
  return output.join("") || "<p>模型没有返回可显示的内容。</p>";
}
