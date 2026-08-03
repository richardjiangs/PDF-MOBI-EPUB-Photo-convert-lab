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

export function createPdfBookChapter({ pageNo, lines = [], hasVisualArt = false, imageData = "" }) {
  const navLabel = `Page ${pageNo}`;
  if (hasVisualArt && imageData) {
    return {
      title: "",
      navLabel,
      kind: "page-image",
      html: `<div class="pdf-page-art" style="text-align:center"><img data-page-render="content" alt="PDF page ${pageNo}" src="${imageData}"></div>`,
      assets: [imageData],
    };
  }
  const cleanLines = lines.map(cleanChapterTitle).filter(Boolean);
  if (cleanLines.length) {
    return {
      title: "",
      navLabel,
      kind: "reflow-text",
      html: `<div class="pdf-page-text">${cleanLines.map(value => `<p>${escapeBookHtml(value)}</p>`).join("")}</div>`,
      assets: [],
    };
  }
  return null;
}

export function wrapMobiChapter(body = "") {
  return body;
}

export function wrapKf8Chapter(body = "") {
  return `<section>${body}</section>`;
}
