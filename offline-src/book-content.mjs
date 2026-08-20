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

export function finalizeAutomaticTocChapters(chapters = [], { autoEnabled = true } = {}) {
  const manual = chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => Number(chapter?.manualTocLevel) >= 1);
  if (manual.length) return chapters.map(chapter => ({ ...chapter, includeInToc: Number(chapter.manualTocLevel) >= 1, tocLevel: Math.min(3, Math.max(1, Number(chapter.manualTocLevel) || 1)), tocSource: Number(chapter.manualTocLevel) >= 1 ? "manual" : chapter.tocSource }));
  if (!autoEnabled) return chapters.map(chapter => ({ ...chapter, includeInToc: false }));
  const publisherSeen = new Set();
  const publisher = chapters.map((chapter, index) => ({ chapter, index, label: chapterNavigationLabel(chapter, index) })).filter(({ chapter, label }) => {
    const key = cleanChapterTitle(label).toLocaleLowerCase();
    if (chapter?.tocSource !== "publisher" || !key || publisherSeen.has(key) || isGenericNavigationLabel(label) || /^cover$/i.test(label)) return false;
    publisherSeen.add(key); return true;
  });
  const detectedTitleFor = chapter => cleanChapterTitle(chapter?.detectedTitle) || (chapter?.tocSource === "detected" ? cleanChapterTitle(chapter.title) : "");
  const titleFrequency = new Map();
  for (const chapter of chapters) { const key = detectedTitleFor(chapter).toLocaleLowerCase(); if (key) titleFrequency.set(key, (titleFrequency.get(key) || 0) + 1); }
  const seenDetected = new Set();
  const recognized = chapters.map((chapter, index) => ({ chapter, index, label: detectedTitleFor(chapter) })).filter(({ label }) => {
    const key = cleanChapterTitle(label).toLocaleLowerCase(), repeatedRunningHeader = (titleFrequency.get(key) || 0) >= Math.max(3, Math.ceil(chapters.length * .25));
    if (!key || seenDetected.has(key) || repeatedRunningHeader || isGenericNavigationLabel(label) || /^cover$/i.test(label)) return false;
    seenDetected.add(key); return true;
  });
  // A single broken publisher entry used to suppress every good detected chapter.
  // Prefer publisher navigation only when it has useful coverage, or when detection
  // genuinely found nothing. This is especially important for damaged EPUB files.
  if (publisher.length && (publisher.length >= 2 || !recognized.length)) return chapters.map((chapter, index) => ({ ...chapter, includeInToc: publisher.some(entry => entry.index === index), tocLevel: Math.min(3, Math.max(1, Number(chapter.tocLevel) || 1)) }));
  const selected = recognized.length ? new Set(recognized.map(entry => entry.index)) : new Set(chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter, index }) => !/^cover$/i.test(chapterNavigationLabel(chapter, index))).slice(0, 1).map(entry => entry.index));
  return chapters.map((chapter, index) => { const detected = recognized.find(entry => entry.index === index), useDetected = selected.has(index) && detected; return { ...chapter, ...(useDetected ? { title: detected.label, navLabel: detected.label, tocSource: "detected" } : {}), includeInToc: selected.has(index), tocLevel: Math.min(3, Math.max(1, Number(chapter.tocLevel) || 1)) }; });
}

export function removeBookPages(chapters = [], deletedPages = new Set()) {
  return chapters.filter((_, index) => !deletedPages.has(index + 1));
}

function normalizedLine(line) {
  if (typeof line === "string") return { text: cleanChapterTitle(line), fontSize: 0, fontWeight: 0, headingLevel: 0, x: 0, y: 0, pageHeight: 0, topRatio: 0 };
  return {
    text: cleanChapterTitle(line?.text),
    fontSize: Number.isFinite(Number(line?.fontSize)) ? Math.abs(Number(line.fontSize)) : 0,
    fontWeight: Number.isFinite(Number(line?.fontWeight)) ? Number(line.fontWeight) : 0,
    headingLevel: Number.isFinite(Number(line?.headingLevel)) ? Number(line.headingLevel) : 0,
    x: Number.isFinite(Number(line?.x)) ? Number(line.x) : 0,
    y: Number.isFinite(Number(line?.y)) ? Number(line.y) : 0,
    pageHeight: Number.isFinite(Number(line?.pageHeight)) ? Math.abs(Number(line.pageHeight)) : 0,
    topRatio: Number.isFinite(Number(line?.topRatio)) ? Number(line.topRatio) : Number(line?.pageHeight) > 0 ? Math.max(0, Math.min(1, (Number(line.pageHeight) - Number(line.y || 0)) / Number(line.pageHeight))) : 0,
  };
}

function joinPdfFragments(fragments) {
  let value = "", previousEnd = -Infinity;
  for (const fragment of fragments) {
    const text = cleanChapterTitle(fragment.text); if (!text) continue;
    const gap = fragment.x - previousEnd, needsSpace = value && gap > Math.max(1.2, fragment.fontSize * .08) && !/[-‐‑‒–—(\[/]$/.test(value) && !/^[,.;:!?)}\]’”。，、；：！？]/u.test(text);
    value += `${needsSpace ? " " : ""}${text}`; previousEnd = Math.max(previousEnd, fragment.x + Math.max(0, fragment.width));
  }
  return cleanChapterTitle(value);
}

// PDF.js often reports words in drawing order and hasEOL is frequently absent.
// Rebuild actual visual lines from coordinates before chapter recognition.
export function extractPdfTextLines(items = [], pageHeight = 0) {
  const fragments = items.map((item, order) => {
    const text = cleanChapterTitle(item?.str), transform = item?.transform || [], fontSize = Math.abs(Number(transform[3]) || Number(item?.height) || 0), x = Number(transform[4]) || 0, y = Number(transform[5]) || 0;
    return { text, x, y, width: Math.abs(Number(item?.width) || 0), fontSize, fontWeight: /(?:bold|black|heavy|semibold|demi)/i.test(String(item?.fontName || "")) ? 700 : 0, order };
  }).filter(item => item.text && item.fontSize >= 0).sort((a, b) => Math.abs(b.y - a.y) > Math.max(2, Math.min(a.fontSize || 10, b.fontSize || 10) * .32) ? b.y - a.y : a.x - b.x || a.order - b.order);
  const rows = [];
  for (const fragment of fragments) {
    const tolerance = Math.max(2, fragment.fontSize * .36), row = rows.find(candidate => Math.abs(candidate.y - fragment.y) <= Math.max(tolerance, candidate.tolerance));
    if (row) { row.fragments.push(fragment); row.y = (row.y * row.count + fragment.y) / ++row.count; row.tolerance = Math.max(row.tolerance, tolerance); }
    else rows.push({ y: fragment.y, tolerance, count: 1, fragments: [fragment] });
  }
  return rows.sort((a, b) => b.y - a.y).map(row => {
    const sorted = row.fragments.sort((a, b) => a.x - b.x || a.order - b.order), fontSize = Math.max(...sorted.map(item => item.fontSize), 0), y = row.y;
    return { text: joinPdfFragments(sorted), fontSize, fontWeight: Math.max(...sorted.map(item => item.fontWeight), 0), x: Math.min(...sorted.map(item => item.x)), y, pageHeight, topRatio: pageHeight > 0 ? Math.max(0, Math.min(1, (pageHeight - y) / pageHeight)) : 0 };
  }).filter(line => line.text);
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
  if (!normalized.length) return { title: "", level: 1, confidence: 0, reason: "none", lineIndex: -1, fontSize: 0, topRatio: 0 };
  const sizes = normalized.map(line => line.fontSize).filter(size => size > 0).sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2), medianSize = sizes.length ? sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2 : 0;
  const candidates = normalized.slice(0, 14);
  if (contentsPattern.test(candidates[0].text) || candidates.slice(0, 10).filter(line => /\.{3,}\s*\d+$|\s\d+$/.test(line.text)).length >= 3) return { title: "", level: 1, confidence: 0, reason: "contents", lineIndex: -1, fontSize: 0, topRatio: 0 };
  for (let index = 0; index < candidates.length; index++) {
    const line = candidates[index], text = line.text;
    if (text.length > 110 || contentsPattern.test(text) || /(?:https?:\/\/|www\.|@|isbn|all rights reserved)/iu.test(text) || (line.topRatio > .58 && line.pageHeight)) continue;
    const bareNumber = /^(?:\d{1,3}|[ivxlcdm]{1,10})$/iu.test(text), numberedSubtitle = candidates[index + 1], subtitleWords = numberedSubtitle?.text.split(/\s+/).filter(Boolean) || [];
    if (bareNumber && numberedSubtitle && numberedSubtitle.text.length <= 100 && subtitleWords.length <= 16 && !/[.!?。！？]$/.test(numberedSubtitle.text) && (!line.pageHeight || numberedSubtitle.topRatio - line.topRatio < .16)) return { title: `${text}: ${numberedSubtitle.text}`, level: 2, confidence: .9, reason: "numbered", lineIndex: index, fontSize: line.fontSize, topRatio: line.topRatio };
    if (numberedHeadingPattern.test(text) || frontBackPattern.test(text) || /^(?:appendix|annex)(?:\s+[a-z0-9]+)?(?:\b|\s*[:.—–-])/iu.test(text)) {
      const next = candidates[index + 1], nextWords = next?.text.split(/\s+/).filter(Boolean) || [];
      const nextIsSubtitle = next && next.text.length <= 100 && nextWords.length <= 16 && !/[.!?。！？]$/.test(next.text) && !numberedHeadingPattern.test(next.text) && !frontBackPattern.test(next.text) && (next.fontSize >= Math.max(10, line.fontSize * .68) || line.headingLevel > 0 && next.headingLevel === line.headingLevel) && (!line.pageHeight || next.topRatio - line.topRatio < .16);
      return { title: nextIsSubtitle && text.length <= 48 ? `${text}: ${next.text}` : text, level: classifiedHeadingLevel(text, line.headingLevel), confidence: 1, reason: "numbered", lineIndex: index, fontSize: line.fontSize, topRatio: line.topRatio };
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
    const nearStart = !line.pageHeight || line.topRatio <= .42;
    if (isShort && !sentenceLike && nearStart && (semanticHeading || significantlyLarger || emphasized)) return { title: line.text, level: classifiedHeadingLevel(line.text, line.headingLevel), confidence: semanticHeading ? .94 : significantlyLarger ? .84 : .76, reason: semanticHeading ? "semantic" : "typographic", lineIndex: normalized.indexOf(line), fontSize: line.fontSize, topRatio: line.topRatio };
  }
  return { title: "", level: 1, confidence: 0, reason: "none", lineIndex: -1, fontSize: 0, topRatio: 0 };
}

export function detectChapter(lines = []) {
  const { title, level, confidence } = chapterCandidate(lines); return { title, level, confidence };
}

export function detectChapterCandidate(lines = []) { return chapterCandidate(lines); }

export function detectChapterTitle(lines = []) {
  return chapterCandidate(lines).title;
}

export function analyzeChapterPages(pages = []) {
  const detected = pages.map((page, index) => ({ pageNo: Number(page?.pageNo) || index + 1, lines: page?.lines || [], candidate: chapterCandidate(page?.lines || []) }));
  const titleFrequency = new Map(), styleFrequency = new Map();
  for (const item of detected) {
    const key = cleanChapterTitle(item.candidate.title).toLocaleLowerCase(); if (key) titleFrequency.set(key, (titleFrequency.get(key) || 0) + 1);
    if (item.candidate.reason === "typographic") { const style = Math.round(item.candidate.fontSize * 2) / 2; styleFrequency.set(style, (styleFrequency.get(style) || 0) + 1); }
  }
  const selected = [], seen = new Set();
  for (const item of detected) {
    const candidate = item.candidate, key = cleanChapterTitle(candidate.title).toLocaleLowerCase(), style = Math.round(candidate.fontSize * 2) / 2;
    if (!key || seen.has(key) || (titleFrequency.get(key) || 0) >= Math.max(3, Math.ceil(pages.length * .2))) continue;
    const reliableTypography = candidate.reason !== "typographic" || candidate.confidence >= .88 || (styleFrequency.get(style) || 0) >= 2;
    if (!reliableTypography) continue;
    seen.add(key); selected.push({ pageNo: item.pageNo, title: candidate.title, level: candidate.level, confidence: candidate.confidence, source: candidate.reason });
  }
  return selected;
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

export function tableOfContentsEntries(chapters = [], { autoEnabled = true } = {}) {
  const hasManual = chapters.some(chapter => Number(chapter?.manualTocLevel) >= 1);
  if (!hasManual && !autoEnabled) return [];
  const selected = hasManual
    ? chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => Number(chapter.manualTocLevel) >= 1)
    : chapters.some(chapter => chapter?.includeInToc)
    ? chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => chapter.includeInToc)
    : chapters.map((chapter, index) => ({ chapter, index }));
  return selected.map(({ chapter, index }) => ({ index, id: `pf-chapter-${index + 1}`, label: chapterNavigationLabel(chapter, index), level: Math.min(3, Math.max(1, Number(hasManual ? chapter.manualTocLevel : chapter.tocLevel) || 1)) }));
}

export function tableOfContentsTree(entries = []) {
  const roots = [], stack = [], floor = entries.length ? Math.min(...entries.map(entry => Math.min(3, Math.max(1, Number(entry.level) || 1)))) : 1;
  for (const entry of entries) {
    const requested = Math.min(3, Math.max(1, Number(entry.level) || 1)) - floor + 1, level = roots.length ? Math.min(requested, stack.length + 1) : 1, node = { ...entry, level, children: [] };
    if (level === 1) roots.push(node); else stack[level - 2].children.push(node);
    stack[level - 1] = node; stack.length = level;
  }
  return roots;
}

export function buildNestedTocList(entries = [], linkFor = entry => `#${entry.id}`) {
  const render = nodes => `<ol>${nodes.map(node => `<li><a href="${escapeBookHtml(linkFor(node))}">${escapeBookHtml(node.label)}</a>${node.children.length ? `<span class="pageforge-toc-expand" aria-hidden="true"> ›</span>${render(node.children)}` : ""}</li>`).join("")}</ol>`;
  return render(tableOfContentsTree(entries));
}

export function buildVisibleTableOfContents(chapters = [], options = {}) {
  const entries = tableOfContentsEntries(chapters, options);
  if (entries.length < 2) return "";
  return `<nav class="pageforge-toc"><h1>Contents</h1>${buildNestedTocList(entries)}</nav>`;
}

export function composeLegacyBookBody({ chapters = [], sections = [], filterMode = "all", separator = "", tocSeparator = separator, autoTocEnabled = true } = {}) {
  const toc = filterMode === "images" ? "" : buildVisibleTableOfContents(chapters, { autoEnabled: autoTocEnabled });
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
