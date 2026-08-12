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
  return cleanChapterTitle(chapter?.manualTocTitle) || cleanChapterTitle(chapter?.title) || cleanChapterTitle(chapter?.navLabel) || `Section ${index + 1}`;
}

export function isGenericNavigationLabel(value = "") {
  return /^(?:section|page)\s+\d+$/i.test(cleanChapterTitle(value));
}

export function finalizeAutomaticTocChapters(chapters = []) {
  const manual = chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => Number(chapter?.manualTocLevel) >= 1);
  if (manual.length) return chapters.map(chapter => ({ ...chapter, includeInToc: Number(chapter.manualTocLevel) >= 1, tocLevel: Math.min(3, Math.max(1, Number(chapter.manualTocLevel) || 1)), tocSource: Number(chapter.manualTocLevel) >= 1 ? "manual" : chapter.tocSource }));
  const publisherSeen = new Set();
  const publisher = chapters.map((chapter, index) => ({ chapter, index, label: chapterNavigationLabel(chapter, index) })).filter(({ chapter, label }) => {
    const key = cleanChapterTitle(label).toLocaleLowerCase();
    if (chapter?.tocSource !== "publisher" || !key || publisherSeen.has(key) || isGenericNavigationLabel(label) || /^cover$/i.test(label)) return false;
    publisherSeen.add(key); return true;
  });
  if (publisher.length) return chapters.map((chapter, index) => ({ ...chapter, includeInToc: publisher.some(entry => entry.index === index), tocLevel: Math.min(3, Math.max(1, Number(chapter.tocLevel) || 1)) }));
  const titleFrequency = new Map();
  for (const chapter of chapters) if (chapter?.tocSource === "detected") { const key = cleanChapterTitle(chapter.title).toLocaleLowerCase(); if (key) titleFrequency.set(key, (titleFrequency.get(key) || 0) + 1); }
  const seenDetected = new Set();
  const recognized = chapters.map((chapter, index) => ({ chapter, index, label: chapterNavigationLabel(chapter, index) })).filter(({ chapter, label }) => {
    const key = cleanChapterTitle(chapter?.title).toLocaleLowerCase(), repeatedRunningHeader = (titleFrequency.get(key) || 0) >= Math.max(3, Math.ceil(chapters.length * .25));
    if (chapter?.tocSource !== "detected" || !key || seenDetected.has(key) || repeatedRunningHeader || isGenericNavigationLabel(label) || /^cover$/i.test(label)) return false;
    seenDetected.add(key); return true;
  });
  const selected = recognized.length ? new Set(recognized.map(entry => entry.index)) : new Set(chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter, index }) => !/^cover$/i.test(chapterNavigationLabel(chapter, index))).slice(0, 1).map(entry => entry.index));
  return chapters.map((chapter, index) => ({ ...chapter, includeInToc: selected.has(index), tocLevel: Math.min(3, Math.max(1, Number(chapter.tocLevel) || 1)) }));
}

export function removeBookPages(chapters = [], deletedPages = new Set()) {
  return chapters.filter((_, index) => !deletedPages.has(index + 1));
}

function normalizedLine(line) {
  if (typeof line === "string") return { text: cleanChapterTitle(line), fontSize: 0, fontWeight: 0, headingLevel: 0 };
  return {
    text: cleanChapterTitle(line?.text),
    fontSize: Number.isFinite(Number(line?.fontSize)) ? Math.abs(Number(line.fontSize)) : 0,
    fontWeight: Number.isFinite(Number(line?.fontWeight)) ? Number(line.fontWeight) : 0,
    headingLevel: Number.isFinite(Number(line?.headingLevel)) ? Number(line.headingLevel) : 0,
  };
}

const contentsPattern = /^(?:table\s+of\s+contents|contents|sommaire|indice|índice|inhalt(?:sverzeichnis)?|目录|目錄|目次|оглавление)$/iu;
const frontBackPattern = /^(?:prologue|epilogue|introduction|preface|foreword|afterword|conclusion|acknowledg(?:e)?ments|bibliography|glossary|index)(?:\b|\s*[:.—–-])/iu;
const numberWord = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)";
const numberedHeadingPattern = new RegExp(`^(?:(?:chapter|chapitre|cap[ií]tulo|capitolo|kapitel|hoofdstuk|rozdzia[lł]|глава|κεφάλαιο)\\s+(?:\\d+|[ivxlcdm]+|[a-z]|${numberWord})\\b|(?:part|book|volume|tome|livre|parte|teil|band)\\s+(?:\\d+|[ivxlcdm]+|[a-z]|${numberWord})\\b|(?:section|scene|lesson|unit)\\s+(?:\\d+|[ivxlcdm]+|[a-z]|${numberWord})\\b|(?:\\d{1,3}|[ivxlcdm]{1,10})[.):—–-]\\s+\\S|第.{1,12}[章节篇部卷回])`, "iu");

function classifiedHeadingLevel(text = "", requested = 0) {
  if (requested >= 1 && requested <= 3) return requested;
  if (/^(?:(?:part|book|volume|tome|livre|parte|teil|band)\b|第.{1,12}[部卷])/iu.test(text)) return 1;
  if (/^(?:(?:section|scene|lesson|unit)\b|第.{1,12}节)/iu.test(text)) return 3;
  return 2;
}

function chapterCandidate(lines = []) {
  const normalized = lines.map(normalizedLine).filter(line => line.text);
  if (!normalized.length) return { title: "", level: 1, confidence: 0 };
  const sizes = normalized.map(line => line.fontSize).filter(size => size > 0).sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2), medianSize = sizes.length ? sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2 : 0;
  const candidates = normalized.slice(0, 14);
  if (contentsPattern.test(candidates[0].text) || candidates.slice(0, 8).filter(line => /\.{3,}\s*\d+$|\s\d+$/.test(line.text)).length >= 3) return { title: "", level: 1, confidence: 0 };
  for (let index = 0; index < candidates.length; index++) {
    const line = candidates[index], text = line.text;
    if (text.length > 140 || contentsPattern.test(text)) continue;
    const bareNumber = /^(?:\d{1,3}|[ivxlcdm]{1,10})$/iu.test(text), numberedSubtitle = candidates[index + 1], subtitleWords = numberedSubtitle?.text.split(/\s+/).filter(Boolean) || [];
    if (bareNumber && numberedSubtitle && numberedSubtitle.text.length <= 100 && subtitleWords.length <= 16 && !/[.!?。！？]$/.test(numberedSubtitle.text)) return { title: `${text}: ${numberedSubtitle.text}`, level: 2, confidence: .9 };
    if (numberedHeadingPattern.test(text) || frontBackPattern.test(text) || /^(?:appendix|annex)(?:\s+[a-z0-9]+)?(?:\b|\s*[:.—–-])/iu.test(text)) {
      const next = candidates[index + 1], nextWords = next?.text.split(/\s+/).filter(Boolean) || [];
      const nextIsSubtitle = next && next.text.length <= 100 && nextWords.length <= 16 && !/[.!?。！？]$/.test(next.text) && !numberedHeadingPattern.test(next.text) && !frontBackPattern.test(next.text) && (next.fontSize >= Math.max(10, line.fontSize * .68) || next.headingLevel === line.headingLevel);
      return { title: nextIsSubtitle && text.length <= 48 ? `${text}: ${next.text}` : text, level: classifiedHeadingLevel(text, line.headingLevel), confidence: 1 };
    }
  }
  for (const line of candidates.slice(0, 8)) {
    if (contentsPattern.test(line.text)) continue;
    const words = line.text.split(/\s+/).filter(Boolean);
    const isShort = line.text.length >= 2 && line.text.length <= 90 && words.length <= 14 && !/^\d+$/.test(line.text);
    const sentenceLike = /[.!?。！？]$/.test(line.text) || /^(?:copyright|all rights reserved|published by)\b/iu.test(line.text);
    const semanticHeading = line.headingLevel >= 1 && line.headingLevel <= 3;
    const significantlyLarger = medianSize > 0 && line.fontSize >= Math.max(12, medianSize * 1.32);
    const emphasized = line.fontWeight >= 600 && medianSize > 0 && line.fontSize >= medianSize * 1.12;
    if (isShort && !sentenceLike && (semanticHeading || significantlyLarger || emphasized)) return { title: line.text, level: classifiedHeadingLevel(line.text, line.headingLevel), confidence: semanticHeading ? .94 : .78 };
  }
  return { title: "", level: 1, confidence: 0 };
}

export function detectChapter(lines = []) {
  return chapterCandidate(lines);
}

export function detectChapterTitle(lines = []) {
  return chapterCandidate(lines).title;
}

export function finalizePdfBookChapters(chapters = []) {
  const seenTitles = new Set();
  let foundChapter = false;
  const finalized = chapters.map(chapter => {
    const title = cleanChapterTitle(chapter?.title);
    const key = title.toLocaleLowerCase();
    const includeInToc = Boolean(title && !seenTitles.has(key));
    if (includeInToc) { seenTitles.add(key); foundChapter = true; }
    return { ...chapter, title, includeInToc, tocLevel: Math.min(3, Math.max(1, Number(chapter.tocLevel) || 1)), tocSource: includeInToc ? "detected" : chapter.tocSource };
  });
  return foundChapter ? finalized : finalized.map((chapter, index) => ({ ...chapter, includeInToc: index === 0, tocLevel: 1, tocSource: index === 0 ? "fallback" : chapter.tocSource }));
}

export function tableOfContentsEntries(chapters = []) {
  const hasManual = chapters.some(chapter => Number(chapter?.manualTocLevel) >= 1);
  const selected = hasManual
    ? chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => Number(chapter.manualTocLevel) >= 1)
    : chapters.some(chapter => chapter?.includeInToc)
    ? chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => chapter.includeInToc)
    : chapters.map((chapter, index) => ({ chapter, index }));
  return selected.map(({ chapter, index }) => ({ index, id: `pf-chapter-${index + 1}`, label: chapterNavigationLabel(chapter, index), level: Math.min(3, Math.max(1, Number(hasManual ? chapter.manualTocLevel : chapter.tocLevel) || 1)) }));
}

export function tableOfContentsTree(entries = []) {
  const roots = [], stack = [];
  for (const entry of entries) {
    const requested = Math.min(3, Math.max(1, Number(entry.level) || 1)), level = roots.length ? Math.min(requested, stack.length + 1) : 1, node = { ...entry, level, children: [] };
    if (level === 1) roots.push(node); else stack[level - 2].children.push(node);
    stack[level - 1] = node; stack.length = level;
  }
  return roots;
}

export function buildNestedTocList(entries = [], linkFor = entry => `#${entry.id}`) {
  const render = nodes => `<ol>${nodes.map(node => `<li><a href="${escapeBookHtml(linkFor(node))}">${escapeBookHtml(node.label)}</a>${node.children.length ? `<span class="pageforge-toc-expand" aria-hidden="true"> ›</span>${render(node.children)}` : ""}</li>`).join("")}</ol>`;
  return render(tableOfContentsTree(entries));
}

export function buildVisibleTableOfContents(chapters = []) {
  const entries = tableOfContentsEntries(chapters);
  if (entries.length < 2) return "";
  return `<nav class="pageforge-toc"><h1>Contents</h1>${buildNestedTocList(entries)}</nav>`;
}

export function composeLegacyBookBody({ chapters = [], sections = [], filterMode = "all", separator = "", tocSeparator = separator } = {}) {
  const toc = filterMode === "images" ? "" : buildVisibleTableOfContents(chapters);
  return `${toc}${toc ? tocSeparator : ""}${sections.join(separator)}`;
}

export function createPdfBookChapter({ pageNo, lines = [], hasVisualArt = false, imageData = "" }) {
  const detected = detectChapter(lines), title = detected.title, navLabel = title || `Page ${pageNo}`;
  if (hasVisualArt && imageData) {
    return {
      sourcePageNo: pageNo,
      title,
      navLabel,
      tocLevel: detected.level,
      kind: "page-image",
      html: `<div class="pdf-page-art" style="text-align:center"><img data-page-render="content" alt="PDF page ${pageNo}" src="${imageData}"></div>`,
      assets: [imageData],
    };
  }
  const cleanLines = lines.map(normalizedLine).map(line => line.text).filter(Boolean);
  if (cleanLines.length) {
    return {
      sourcePageNo: pageNo,
      title,
      navLabel,
      tocLevel: detected.level,
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
