export function escapeBookHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function cleanChapterTitle(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

export function chapterNavigationLabel(chapter, index) {
  return cleanChapterTitle(chapter?.title) || cleanChapterTitle(chapter?.navLabel) || `Section ${index + 1}`;
}

export function removeBookPages(chapters = [], deletedPages = new Set()) {
  return chapters.filter((_, index) => !deletedPages.has(index + 1));
}

function normalizedLine(line) {
  if (typeof line === "string") return { text: cleanChapterTitle(line), fontSize: 0 };
  return {
    text: cleanChapterTitle(line?.text),
    fontSize: Number.isFinite(Number(line?.fontSize)) ? Math.abs(Number(line.fontSize)) : 0,
  };
}

export function detectChapterTitle(lines = []) {
  const normalized = lines.map(normalizedLine).filter(line => line.text);
  if (!normalized.length) return "";
  const sizes = normalized.map(line => line.fontSize).filter(size => size > 0).sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2), medianSize = sizes.length ? sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2 : 0;
  const explicitChapter = /^(?:(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+|[a-z])\b|(?:prologue|epilogue|introduction|preface|foreword|afterword|conclusion|appendix(?:\s+[a-z0-9]+)?|acknowledg(?:e)?ments)\b|第.{1,12}[章节篇部]\b)/i;
  const candidates = normalized.slice(0, 10);
  if (/^(?:contents|table of contents)$/i.test(candidates[0].text)) return "";
  for (const line of candidates) if (line.text.length <= 120 && explicitChapter.test(line.text)) return line.text;
  for (const line of candidates) {
    if (/^(?:contents|table of contents)$/i.test(line.text)) continue;
    const words = line.text.split(/\s+/).filter(Boolean);
    const isShort = line.text.length >= 2 && line.text.length <= 90 && words.length <= 14;
    const sentenceLike = /[.!?。！？]$/.test(line.text);
    const significantlyLarger = medianSize > 0 && line.fontSize >= Math.max(11, medianSize * 1.22);
    if (isShort && !sentenceLike && significantlyLarger) return line.text;
  }
  return "";
}

export function finalizePdfBookChapters(chapters = []) {
  const seenTitles = new Set();
  let foundChapter = false;
  const finalized = chapters.map(chapter => {
    const title = cleanChapterTitle(chapter?.title);
    const key = title.toLocaleLowerCase();
    const includeInToc = Boolean(title && !seenTitles.has(key));
    if (includeInToc) { seenTitles.add(key); foundChapter = true; }
    return { ...chapter, title, includeInToc };
  });
  return foundChapter ? finalized : finalized.map(chapter => ({ ...chapter, includeInToc: true }));
}

export function tableOfContentsEntries(chapters = []) {
  const selected = chapters.some(chapter => chapter?.includeInToc)
    ? chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => chapter.includeInToc)
    : chapters.map((chapter, index) => ({ chapter, index }));
  return selected.map(({ chapter, index }) => ({ index, id: `pf-chapter-${index + 1}`, label: chapterNavigationLabel(chapter, index) }));
}

export function buildVisibleTableOfContents(chapters = []) {
  const entries = tableOfContentsEntries(chapters);
  if (entries.length < 2) return "";
  return `<nav class="pageforge-toc"><h1>Contents</h1><ol>${entries.map(entry => `<li><a href="#${entry.id}">${escapeBookHtml(entry.label)}</a></li>`).join("")}</ol></nav>`;
}

export function composeLegacyBookBody({ chapters = [], sections = [], filterMode = "all", separator = "", tocSeparator = separator } = {}) {
  const toc = filterMode === "images" ? "" : buildVisibleTableOfContents(chapters);
  return `${toc}${toc ? tocSeparator : ""}${sections.join(separator)}`;
}

export function createPdfBookChapter({ pageNo, lines = [], hasVisualArt = false, imageData = "" }) {
  const title = detectChapterTitle(lines), navLabel = title || `Page ${pageNo}`;
  if (hasVisualArt && imageData) {
    return {
      title,
      navLabel,
      kind: "page-image",
      html: `<div class="pdf-page-art" style="text-align:center"><img data-page-render="content" alt="PDF page ${pageNo}" src="${imageData}"></div>`,
      assets: [imageData],
    };
  }
  const cleanLines = lines.map(normalizedLine).map(line => line.text).filter(Boolean);
  if (cleanLines.length) {
    return {
      title,
      navLabel,
      kind: "reflow-text",
      html: `<div class="pdf-page-text">${cleanLines.map(value => `<p>${escapeBookHtml(value)}</p>`).join("")}</div>`,
      assets: [],
    };
  }
  return null;
}

export function wrapMobiChapter(body = "", id = "") {
  return `${id ? `<a id="${escapeBookHtml(id)}"></a>` : ""}${body}`;
}

export function wrapKf8Chapter(body = "", id = "") {
  return `<section${id ? ` id="${escapeBookHtml(id)}"` : ""}>${body}</section>`;
}
