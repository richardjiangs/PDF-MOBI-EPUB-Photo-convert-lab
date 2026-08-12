import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import JSZip from "jszip";
import html2canvas from "html2canvas";
import { initMobiFile, initKf8File } from "@lingo-reader/mobi-parser";
import { calculateBlankPercentage } from "./blankness.mjs";
import { calculateFingerprintSimilarity, matchesBlankAndSimilar } from "./similarity.mjs";
import { buildPdfFromKeptPages } from "./pdf-pages.mjs";
import { buildNestedTocList, buildVisibleTableOfContents, chapterNavigationLabel, cleanChapterTitle, composeLegacyBookBody, createPdfBookChapter, finalizeAutomaticTocChapters, finalizePdfBookChapters, removeBookPages, tableOfContentsEntries, tableOfContentsTree, wrapKf8Chapter, wrapMobiChapter } from "./book-content.mjs";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const enc = new TextEncoder();
const state = { photos: [], pdfFile: null, pdfBytes: null, pdf: null, pdfPending: null, pdfPassword: "", pdfBlankness: new Map(), pdfBlanknessJobs: new Map(), pdfFingerprints: new Map(), pdfReferencePage: null, pdfResult: null, pdfBlankScanId: 0, pdfChapterMarkLevel: 0, pdfChapterMarks: new Map(), bookFile: null, book: null, bookPending: null, bookPassword: "", bookBlankness: new Map(), bookAnalysisJobs: new Map(), bookFingerprints: new Map(), bookReferencePage: null, bookPageObserver: null, bookBlankScanId: 0, bookChapterMarkLevel: 0 };
const workerSource = $("#pdf-worker-source").textContent;
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));

// A local-only firewall: ebook content cannot silently request remote images, CSS, or fonts.
const realFetch = window.fetch.bind(window);
window.fetch = (resource, options) => {
  const raw = typeof resource === "string" ? resource : resource?.url || "";
  const url = new URL(raw, location.href);
  if (["blob:", "data:", "file:"].includes(url.protocol) || url.origin === location.origin) return realFetch(resource, options);
  return Promise.reject(new Error("PageForge blocked a network request: " + url.hostname));
};

let statusTimer;
function status(message, pct = 0, finish = false) {
  clearTimeout(statusTimer);
  $("#status-text").textContent = message;
  $("#status-pct").textContent = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
  $("#status-bar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $("#status").classList.add("show");
  if (finish) statusTimer = setTimeout(() => $("#status").classList.remove("show"), 2400);
}
function fail(error) {
  console.error(error);
  status(error?.message || String(error), 100, true);
}
const tick = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
const idleTick = (timeout = 250) => new Promise(resolve => typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout }) : setTimeout(resolve, 24));
const safeName = (name, fallback = "pageforge") => (name || fallback).trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 100) || fallback;
function stopBackgroundAnalysis() { state.pdfBlankScanId++; state.bookBlankScanId++; }
function askAboutMarkedPages(kind, count) {
  const dialog = $("#marked-pages-dialog");
  $("#marked-pages-message").textContent = `${count} ${kind} page${count === 1 ? " is" : "s are"} still marked in red, orange, or purple. Delete them before downloading, keep them in this download, or cancel.`;
  return new Promise(resolve => {
    let settled = false;
    const finish = choice => { if (settled) return; settled = true; dialog.close(); resolve(choice); };
    $("#marked-delete-continue").onclick = () => finish("delete");
    $("#marked-continue").onclick = () => finish("continue");
    $("#marked-cancel").onclick = () => finish("cancel");
    dialog.oncancel = event => { event.preventDefault(); finish("cancel"); };
    dialog.showModal();
  });
}
const chapterLevelName = level => ["", "first-class", "second-class", "third-class"][level] || "chapter";
function syncChapterCard(card, level = 0, title = "") {
  card.classList.remove("chapter-marked", "chapter-level-1", "chapter-level-2", "chapter-level-3");
  if (level) card.classList.add("chapter-marked", `chapter-level-${level}`);
  const badge = $(".chapter-badge", card), input = $(".chapter-title-input", card);
  if (badge) badge.textContent = level ? `${chapterLevelName(level)} chapter` : "Not in manual contents";
  if (input && title && input !== document.activeElement) input.value = title;
}
function setChapterMarkMode(kind, level) {
  const key = kind === "pdf" ? "pdfChapterMarkLevel" : "bookChapterMarkLevel", next = state[key] === level ? 0 : level; state[key] = next;
  for (let value = 1; value <= 3; value++) $(`#${kind}-chapter-level-${value}`).classList.toggle("active", next === value);
  const statusLabel = $(`#${kind}-chapter-mark-status`); statusLabel.textContent = next ? `${chapterLevelName(next)} marking is on · click page previews · click this level again to stop.` : "Chapter marking is off.";
}
for (const kind of ["pdf", "book"]) for (let level = 1; level <= 3; level++) $(`#${kind}-chapter-level-${level}`).addEventListener("click", () => setChapterMarkMode(kind, level));
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function bytesToBlob(bytes, type) { return new Blob([bytes], { type }); }
const canStreamFile = () => window.isSecureContext && typeof window.showSaveFilePicker === "function";
const canStreamFolder = () => window.isSecureContext && typeof window.showDirectoryPicker === "function";
const isPasswordError = error => error?.name === "PasswordException" || error?.code === 1 || error?.code === 2 || /password/i.test(error?.message || "");
function escapeHtml(value = "") { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function dirname(path) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""; }
function normalizePath(path) {
  const out = [];
  for (const bit of path.replace(/\\/g, "/").split("/")) {
    if (!bit || bit === ".") continue;
    if (bit === "..") out.pop(); else out.push(bit);
  }
  return out.join("/");
}
function extFromMime(type = "") { return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" })[type.split(";")[0]] || "bin"; }
function mimeFromPath(path = "") {
  const e = path.toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", css: "text/css", xhtml: "application/xhtml+xml", html: "text/html" })[e] || "application/octet-stream";
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
}
function dataUrlToBytes(url) {
  const [head, data] = url.split(",");
  const mime = head.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  if (head.includes(";base64")) {
    const raw = atob(data); const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: enc.encode(decodeURIComponent(data)), mime };
}
function parseRange(input, max, blankMeansAll = false) {
  const value = input.trim();
  if (!value) return blankMeansAll ? Array.from({ length: max }, (_, i) => i + 1) : [];
  const found = new Set();
  for (const part of value.split(",")) {
    const clean = part.trim(); if (!clean) continue;
    const m = clean.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) if (n >= 1 && n <= max) found.add(n);
    } else if (/^\d+$/.test(clean)) { const n = +clean; if (n >= 1 && n <= max) found.add(n); }
    else throw new Error(`Invalid page range: “${clean}”`);
  }
  return [...found].sort((a, b) => a - b);
}

// Dropzones
function wireDrop(zone, input, handler) {
  ["dragenter", "dragover"].forEach(name => zone.addEventListener(name, e => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(name => zone.addEventListener(name, e => { e.preventDefault(); zone.classList.remove("drag"); }));
  zone.addEventListener("drop", e => handler([...e.dataTransfer.files]));
  input.addEventListener("change", e => { handler([...e.target.files]); input.value = ""; });
}
function showWorkspaceMode(mode) {
  $("#unified-drop").style.display = "none"; $("#job-intro").style.display = "none";
  $("#photo-tools").classList.toggle("active", mode === "photos");
  $("#pdf-tools").classList.toggle("active", mode === "pdf");
  $("#book-tools").classList.toggle("active", mode === "book");
}
function resetWorkspaceDisplay() {
  $("#unified-drop").style.display = "flex"; $("#job-intro").style.display = "flex";
  $$(".context-tools").forEach(section => section.classList.remove("active"));
}
function handleUnifiedFiles(files) {
  if (!files.length) return;
  const images = files.filter(file => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name));
  if (images.length === files.length) return addPhotos(images);
  if (files.length !== 1) return fail(new Error("Choose either a set of photos or one PDF/ebook file at a time."));
  if (/\.pdf$/i.test(files[0].name) || files[0].type === "application/pdf") return loadPdf(files[0]);
  if (/\.(epub|mobi|azw3?|azm3)$/i.test(files[0].name)) return loadBook(files[0]);
  fail(new Error("Choose photos, PDF, EPUB, MOBI, AZW, AZW3, or AZM3."));
}
wireDrop($("#unified-drop"), $("#unified-input"), handleUnifiedFiles);

// Photos → PDF
function addPhotos(files) {
  const incoming = files.filter(f => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
  if (!incoming.length) return fail(new Error("Choose image files such as JPEG, PNG, WebP, GIF, or BMP."));
  showWorkspaceMode("photos");
  for (const file of incoming) state.photos.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), rotation: 0 });
  renderPhotos();
}
function renderPhotos() {
  const cards = $("#photo-cards"); cards.textContent = "";
  state.photos.forEach((item, index) => {
    const card = document.createElement("div"); card.className = "card"; card.draggable = true; card.dataset.id = item.id;
    card.innerHTML = `<div class="thumb"><img alt="" src="${item.url}" style="transform:rotate(${item.rotation}deg)"></div><div class="card-meta"><span class="filename" title="${escapeHtml(item.file.name)}">${index + 1}. ${escapeHtml(item.file.name)}</span><span class="card-tools"><button class="iconbtn rotate" title="Rotate">↻</button><button class="iconbtn remove" title="Remove">×</button></span></div>`;
    card.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", item.id));
    card.addEventListener("dragover", e => e.preventDefault());
    card.addEventListener("drop", e => { e.preventDefault(); const from = state.photos.findIndex(x => x.id === e.dataTransfer.getData("text/plain")); const to = state.photos.findIndex(x => x.id === item.id); if (from < 0 || to < 0) return; const [moved] = state.photos.splice(from, 1); state.photos.splice(to, 0, moved); renderPhotos(); });
    $(".rotate", card).onclick = () => { item.rotation = (item.rotation + 90) % 360; renderPhotos(); };
    $(".remove", card).onclick = () => { URL.revokeObjectURL(item.url); state.photos = state.photos.filter(x => x !== item); renderPhotos(); if (!state.photos.length) resetWorkspaceDisplay(); };
    cards.append(card);
  });
  $("#photo-queue").classList.toggle("show", !!state.photos.length);
  $("#photo-count").textContent = `${state.photos.length} photo${state.photos.length === 1 ? "" : "s"}`;
  $("#photos-convert").disabled = !state.photos.length;
}
$("#photo-clear").addEventListener("click", () => {
  state.photos.forEach(x => URL.revokeObjectURL(x.url));
  state.photos = [];
  renderPhotos(); resetWorkspaceDisplay();
});
async function imageToJpeg(photo, quality) {
  const bitmap = await createImageBitmap(photo.file, { imageOrientation: "from-image" });
  const swap = photo.rotation % 180 !== 0;
  const canvas = document.createElement("canvas"); canvas.width = swap ? bitmap.height : bitmap.width; canvas.height = swap ? bitmap.width : bitmap.height;
  const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(photo.rotation * Math.PI / 180); ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2); bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  return { bytes: await blob.arrayBuffer(), width: canvas.width, height: canvas.height };
}
function photoPageLayout(img, size, margin) {
  let pw, ph;
  if (size === "a4") [pw, ph] = img.width >= img.height ? [841.89, 595.28] : [595.28, 841.89];
  else if (size === "letter") [pw, ph] = img.width >= img.height ? [792, 612] : [612, 792];
  else { const scale = Math.min(1, 1600 / Math.max(img.width, img.height)); pw = img.width * scale + margin * 2; ph = img.height * scale + margin * 2; }
  const fit = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height), w = img.width * fit, h = img.height * fit;
  return { pw, ph, w, h, x: (pw - w) / 2, y: (ph - h) / 2 };
}
async function streamPhotosToPdf(filename, quality, margin, size) {
  const handle = await window.showSaveFilePicker({ suggestedName: `${filename}.pdf`, types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }] });
  const writable = await handle.createWritable(); let offset = 0; const objectCount = 2 + state.photos.length * 3, offsets = new Array(objectCount + 1).fill(0);
  const write = async data => { const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data); await writable.write(bytes); offset += bytes.byteLength; };
  const object = async (number, body) => { offsets[number] = offset; await write(`${number} 0 obj\n${body}\nendobj\n`); };
  try {
    await write("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
    await object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = Array.from({ length: state.photos.length }, (_, i) => `${3 + i * 3} 0 R`).join(" ");
    await object(2, `<< /Type /Pages /Count ${state.photos.length} /Kids [${kids}] >>`);
    for (let i = 0; i < state.photos.length; i++) {
      status(`Streaming photo ${i + 1} of ${state.photos.length} to disk`, (i / state.photos.length) * 92); await tick();
      const img = await imageToJpeg(state.photos[i], quality), layout = photoPageLayout(img, size, margin), pageNo = 3 + i * 3, imageNo = pageNo + 1, contentNo = pageNo + 2;
      await object(pageNo, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${layout.pw.toFixed(3)} ${layout.ph.toFixed(3)}] /Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>`);
      offsets[imageNo] = offset; await write(`${imageNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`); await write(img.bytes); await write("\nendstream\nendobj\n");
      const commands = `q\n${layout.w.toFixed(3)} 0 0 ${layout.h.toFixed(3)} ${layout.x.toFixed(3)} ${layout.y.toFixed(3)} cm\n/Im0 Do\nQ\n`;
      await object(contentNo, `<< /Length ${enc.encode(commands).byteLength} >>\nstream\n${commands}endstream`);
    }
    const xref = offset; await write(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`); let rows = "";
    for (let i = 1; i <= objectCount; i++) { rows += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`; if (rows.length > 64000) { await write(rows); rows = ""; } }
    if (rows) await write(rows); await write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); await writable.close();
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
}
$("#photos-convert").addEventListener("click", async () => {
  try {
    const quality = +$("#photo-quality").value, margin = +$("#photo-margin").value, size = $("#photo-size").value, filename = safeName($("#photo-name").value), useDisk = $("#photo-engine").value === "auto" && canStreamFile();
    if (useDisk) { await streamPhotosToPdf(filename, quality, margin, size); status("PDF saved with disk streaming", 100, true); return; }
    const pdf = await PDFDocument.create();
    for (let i = 0; i < state.photos.length; i++) {
      status(`Placing photo ${i + 1} of ${state.photos.length}`, (i / state.photos.length) * 92); await tick();
      const img = await imageToJpeg(state.photos[i], quality); const embedded = await pdf.embedJpg(img.bytes);
      const layout = photoPageLayout(img, size, margin), page = pdf.addPage([layout.pw, layout.ph]);
      page.drawImage(embedded, { x: layout.x, y: layout.y, width: layout.w, height: layout.h });
    }
    const bytes = await pdf.save({ useObjectStreams: true }); downloadBlob(bytesToBlob(bytes, "application/pdf"), `${filename}.pdf`); status("PDF downloaded", 100, true);
  } catch (e) { if (e?.name === "AbortError") status("Save canceled", 100, true); else fail(e); }
});

// PDF workshop
async function loadPdf(file, password = "", existingBytes = null) {
  if (!file || !(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) return fail(new Error("Choose a PDF file."));
  try {
    showWorkspaceMode("pdf");
    status(password ? "Unlocking PDF locally" : "Reading PDF locally", 8); const bytes = existingBytes || new Uint8Array(await file.arrayBuffer());
    const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined }); const pdf = await task.promise, pdfMetadata = await pdf.getMetadata().catch(() => ({})), detectedAuthor = cleanChapterTitle(pdfMetadata?.info?.Author);
    state.pdfFile = file; state.pdfBytes = bytes; state.pdf = pdf; state.pdfPending = null; state.pdfPassword = password; state.pdfBlankness.clear(); state.pdfBlanknessJobs.clear(); state.pdfFingerprints.clear(); state.pdfReferencePage = null; state.pdfResult = null; state.pdfBlankScanId++; state.pdfChapterMarks.clear(); state.pdfChapterMarkLevel = 0; setChapterMarkMode("pdf", 0);
    invalidatePdfResult(); $("#pdf-reference-status").textContent = "Click a page preview to make it the blue reference."; $("#pdf-find-similar").disabled = true;
    $("#pdf-direct-name").value = safeName(file.name.replace(/\.pdf$/i, "")); $("#pdf-direct-author").value = detectedAuthor; $("#pdf-result-author").value = "";
    $("#pdf-password-box").classList.remove("show"); $("#pdf-password").value = "";
    $("#pdf-queue").classList.add("show"); $("#pdf-count").textContent = `${pdf.numPages} pages · ${formatBytes(file.size)}`;
    ["#pdf-direct-download", "#pdf-delete", "#pdf-analyze", "#pdf-auto-blank"].forEach(id => $(id).disabled = false); $("#pdf-delete-unchecked").disabled = true;
    stagePdfForBook(file, pdf, bytes, password, detectedAuthor);
    renderPdfPlaceholders(); status("PDF ready · every page is kept until you untick it", 100, true);
  } catch (e) {
    if (isPasswordError(e)) {
      const bytes = existingBytes || new Uint8Array(await file.arrayBuffer()); state.pdfPending = { file, bytes }; state.pdfFile = file;
      showWorkspaceMode("pdf"); $("#pdf-queue").classList.add("show"); $("#pdf-pages").textContent = ""; $("#pdf-count").textContent = `Locked · ${file.name}`; $("#pdf-password-box").classList.add("show");
      state.bookFile = file; state.book = null; $("#book-summary").classList.add("show"); $("#book-title").textContent = file.name; $("#book-meta").textContent = "Locked PDF · unlock above before converting"; $("#book-type").textContent = "LOCKED"; $("#book-convert").disabled = true;
      status(password ? "Incorrect password — try again" : "Password required", 100, true); setTimeout(() => $("#pdf-password").focus(), 50); return;
    }
    resetWorkspaceDisplay(); fail(new Error(`Could not open PDF: ${e.message}`));
  }
}
$("#pdf-unlock").addEventListener("click", () => { if (state.pdfPending) loadPdf(state.pdfPending.file, $("#pdf-password").value, state.pdfPending.bytes); });
$("#pdf-password").addEventListener("keydown", e => { if (e.key === "Enter") $("#pdf-unlock").click(); });
$("#pdf-reset").addEventListener("click", () => {
  const resetBookToo = state.book?.sourceType === "pdf" || state.bookFile === state.pdfFile;
  thumbObserver?.disconnect();
  state.pdf?.destroy?.();
  state.pdfFile = state.pdfBytes = state.pdf = state.pdfPending = null; state.pdfPassword = ""; state.pdfBlankness.clear(); state.pdfBlanknessJobs.clear(); state.pdfFingerprints.clear(); state.pdfReferencePage = null; state.pdfResult = null; state.pdfBlankScanId++; state.pdfChapterMarks.clear(); state.pdfChapterMarkLevel = 0; setChapterMarkMode("pdf", 0);
  $("#pdf-pages").textContent = "";
  $("#pdf-queue").classList.remove("show");
  $("#pdf-password-box").classList.remove("show"); $("#pdf-password").value = "";
  $("#pdf-direct-author").value = $("#pdf-result-author").value = "";
  ["#pdf-direct-download", "#pdf-delete", "#pdf-analyze", "#pdf-auto-blank", "#pdf-find-similar", "#pdf-delete-unchecked", "#pdf-result-download"].forEach(id => $(id).disabled = true);
  $("#pdf-reference-status").textContent = "Click a page preview to make it the blue reference."; invalidatePdfResult();
  if (resetBookToo) { state.bookFile = state.book = state.bookPending = null; $("#book-summary").classList.remove("show"); $("#book-convert").disabled = true; }
  resetWorkspaceDisplay();
});
let thumbObserver;
function updatePdfChapterSummary() {
  const count = state.pdfChapterMarks.size, active = state.pdfChapterMarkLevel, label = $("#pdf-chapter-mark-status");
  label.textContent = `${active ? `${chapterLevelName(active)} marking is on` : "Chapter marking is off"} · ${count} manual chapter${count === 1 ? "" : "s"}.`;
}
function markPdfChapter(pageNo) {
  const level = state.pdfChapterMarkLevel; if (!level) return selectPdfReference(pageNo);
  const card = $(`.card[data-page="${pageNo}"]`, $("#pdf-pages")), current = state.pdfChapterMarks.get(pageNo), input = card && $(".chapter-title-input", card);
  if (current?.level === level) state.pdfChapterMarks.delete(pageNo); else state.pdfChapterMarks.set(pageNo, { level, title: cleanChapterTitle(input?.value) || `Page ${pageNo}` });
  const mark = state.pdfChapterMarks.get(pageNo); syncChapterCard(card, mark?.level || 0, mark?.title || `Page ${pageNo}`); updatePdfChapterSummary(); invalidatePdfResult();
}
function renderPdfPlaceholders() {
  const host = $("#pdf-pages"); host.textContent = ""; thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(entries => entries.filter(x => x.isIntersecting).forEach(x => { thumbObserver.unobserve(x.target); renderPdfThumb(x.target); }), { rootMargin: "500px" });
  for (let n = 1; n <= state.pdf.numPages; n++) {
    const card = document.createElement("div"); card.className = "card"; card.dataset.page = n;
    const chapterMark = state.pdfChapterMarks.get(n);
    card.innerHTML = `<button class="thumb pdf-reference-button" type="button" aria-pressed="false" title="Use page ${n} for the active chapter or similarity tool"><span class="page-no">PAGE ${n}</span></button><div class="card-meta"><span class="filename">Page ${n}</span><span class="page-no">PDF</span></div><div class="chapter-editor"><span class="chapter-badge">Not in manual contents</span><input class="chapter-title-input" maxlength="140" value="${escapeHtml(chapterMark?.title || `Page ${n}`)}" aria-label="Chapter title for PDF page ${n}"></div><label class="page-keep"><input class="page-keep-check" type="checkbox" checked aria-label="Keep page ${n}"><span>Keep page</span></label><div class="blank-score">Calculating blank %…</div><div class="similarity-score">Similarity not analyzed</div>`;
    syncChapterCard(card, chapterMark?.level || 0, chapterMark?.title || `Page ${n}`);
    $(".pdf-reference-button", card).addEventListener("click", () => markPdfChapter(n));
    $(".chapter-title-input", card).addEventListener("input", event => { const mark = state.pdfChapterMarks.get(n); if (mark) { mark.title = cleanChapterTitle(event.target.value) || `Page ${n}`; updatePdfChapterSummary(); invalidatePdfResult(); } });
    $(".page-keep-check", card).addEventListener("change", e => { clearPageMark(card); card.classList.toggle("page-removed", !e.target.checked); if (!e.target.checked) card.dataset.mark = "manual"; invalidatePdfResult(); updatePdfConfirmation(); });
    host.append(card); thumbObserver.observe(card);
  }
  updatePdfChapterSummary();
  void schedulePdfBlanknessScan(state.pdf);
}
async function renderPdfThumb(card) {
  try { const page = await state.pdf.getPage(+card.dataset.page); const base = page.getViewport({ scale: 1 }); const scale = 180 / base.width; const viewport = page.getViewport({ scale }); const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise; $(".thumb", card).replaceChildren(canvas); page.cleanup(); } catch {}
}
async function renderPdfPage(pdf, pageNo, scale, type, quality = .9) {
  const page = await pdf.getPage(pageNo), viewport = page.getViewport({ scale }), canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx, viewport, canvas }).promise; page.cleanup();
  const mime = `image/${type}`; const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality)); return blob;
}
async function flattenPdfPages(pdf, keep) {
  const out = await PDFDocument.create();
  for (let i = 0; i < keep.length; i++) {
    status(`Flattening kept page ${i + 1} of ${keep.length}`, 10 + (i / keep.length) * 82); await tick();
    const sourcePage = await pdf.getPage(keep[i]), viewport = sourcePage.getViewport({ scale: 1 }); sourcePage.cleanup();
    const blob = await renderPdfPage(pdf, keep[i], 2, "jpeg", .92), image = await out.embedJpg(await blob.arrayBuffer()), page = out.addPage([viewport.width, viewport.height]);
    page.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  }
  return out.save({ useObjectStreams: true });
}
async function getPageBlankness(pageNo) {
  if (state.pdfBlankness.has(pageNo)) return state.pdfBlankness.get(pageNo);
  if (state.pdfBlanknessJobs.has(pageNo)) return state.pdfBlanknessJobs.get(pageNo);
  const pdf = state.pdf, job = (async () => {
    const page = await pdf.getPage(pageNo), base = page.getViewport({ scale: 1 }), scale = Math.min(.45, 420 / Math.max(base.width, base.height)), viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx, viewport, canvas }).promise; page.cleanup();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data, score = calculateBlankPercentage(pixels);
    if (state.pdf === pdf) { state.pdfBlankness.set(pageNo, score); const label = $(`.card[data-page="${pageNo}"] .blank-score`, $("#pdf-pages")); if (label) label.textContent = `${score.toFixed(1)}% blank`; }
    return score;
  })().finally(() => state.pdfBlanknessJobs.delete(pageNo));
  state.pdfBlanknessJobs.set(pageNo, job); return job;
}
async function schedulePdfBlanknessScan(pdf) {
  if (!pdf) return; const scanId = ++state.pdfBlankScanId; await idleTick(600);
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) { if (scanId !== state.pdfBlankScanId || state.pdf !== pdf) return; try { await getPageBlankness(pageNo); } catch {} await idleTick(); }
}
async function getPageFingerprint(pageNo) {
  if (state.pdfFingerprints.has(pageNo)) return state.pdfFingerprints.get(pageNo);
  const page = await state.pdf.getPage(pageNo), base = page.getViewport({ scale: 1 }), scale = Math.min(.4, 160 / Math.max(base.width, base.height)), viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx, viewport, canvas }).promise; page.cleanup();
  const sample = document.createElement("canvas"); sample.width = 48; sample.height = 48; const sampleCtx = sample.getContext("2d", { alpha: false }); sampleCtx.fillStyle = "#fff"; sampleCtx.fillRect(0, 0, 48, 48); sampleCtx.drawImage(canvas, 0, 0, 48, 48);
  const pixels = sampleCtx.getImageData(0, 0, 48, 48).data, fingerprint = new Uint8Array(48 * 48 * 3);
  for (let src = 0, dst = 0; src < pixels.length; src += 4) { fingerprint[dst++] = pixels[src]; fingerprint[dst++] = pixels[src + 1]; fingerprint[dst++] = pixels[src + 2]; }
  state.pdfFingerprints.set(pageNo, fingerprint); return fingerprint;
}
async function analyzePdfBlankness() {
  if (!state.pdf) throw new Error("Choose a PDF first.");
  const scores = [];
  for (let pageNo = 1; pageNo <= state.pdf.numPages; pageNo++) { status(`Analyzing blank space · page ${pageNo} of ${state.pdf.numPages}`, 5 + pageNo / state.pdf.numPages * 90); scores.push(await getPageBlankness(pageNo)); await tick(); }
  status("Blank-space analysis complete", 100, true); return scores;
}
function clearPageMark(card) {
  card.classList.remove("page-range", "page-combined"); delete card.dataset.mark;
}
function setPageKept(pageNo, kept, markType = "") {
  const card = $(`.card[data-page="${pageNo}"]`, $("#pdf-pages")), check = card && $(".page-keep-check", card); if (!check) return;
  check.checked = kept; card.classList.toggle("page-removed", !kept); clearPageMark(card);
  if (!kept) { card.dataset.mark = markType || "analysis"; card.classList.toggle("page-range", markType === "range"); card.classList.toggle("page-combined", markType === "combined"); }
}
function hasPersistentPageMark(pageNo) {
  const mark = $(`.card[data-page="${pageNo}"]`, $("#pdf-pages"))?.dataset.mark; return mark === "range" || mark === "manual";
}
function selectPdfReference(pageNo) {
  state.pdfReferencePage = pageNo; invalidatePdfResult();
  $$(".card", $("#pdf-pages")).forEach(card => { const selected = +card.dataset.page === pageNo; card.classList.toggle("page-reference", selected); $(".pdf-reference-button", card).setAttribute("aria-pressed", String(selected)); });
  setPageKept(pageNo, true); $("#pdf-find-similar").disabled = false; $("#pdf-reference-status").textContent = `Page ${pageNo} is the blue reference. Similarity-only matches are red; blank + similar matches are purple.`; updatePdfConfirmation();
}
function uncheckedPdfPages() { return new Set($$(".card", $("#pdf-pages")).filter(card => !$(".page-keep-check", card).checked).map(card => +card.dataset.page)); }
function updatePdfConfirmation() {
  const count = uncheckedPdfPages().size, button = $("#pdf-delete-unchecked"); button.disabled = count === 0;
  button.textContent = count ? `Confirm & prepare without ${count} marked page${count === 1 ? "" : "s"}` : "Confirm & prepare cleaned result";
}
function invalidatePdfResult() {
  state.pdfResult = null; $("#pdf-result-box")?.classList.remove("show"); if ($("#pdf-result-download")) $("#pdf-result-download").disabled = true;
}
async function preparePdfWithDeleted(deleted) {
  if (!deleted.size) throw new Error("No pages are marked for deletion. Enter a range or untick one or more page cards.");
  if (deleted.size === state.pdf.numPages) throw new Error("A PDF needs at least one page. Keep one or more pages.");
  status("Rebuilding PDF without the marked pages", 25); const originalPdf = state.pdf, keep = Array.from({ length: originalPdf.numPages }, (_, i) => i + 1).filter(n => !deleted.has(n)), remappedChapterMarks = new Map(); keep.forEach((oldPage, newIndex) => { const mark = state.pdfChapterMarks.get(oldPage); if (mark) remappedChapterMarks.set(newIndex + 1, { ...mark }); }); let bytes, flattened = false;
  try {
    if (state.pdfPassword) throw new Error("Protected document requires flattening");
    bytes = await buildPdfFromKeptPages(state.pdfBytes, keep);
  } catch { bytes = await flattenPdfPages(originalPdf, keep); flattened = true; }

  const cleanedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stem = safeName(state.pdfFile.name.replace(/\.pdf$/i, "").replace(/(?:-cleaned)+$/i, ""));
  const cleanedName = `${stem}-cleaned`;
  const cleanedPdf = await pdfjsLib.getDocument({ data: cleanedBytes.slice() }).promise;
  const cleanedFile = new File([cleanedBytes], `${cleanedName}.pdf`, { type: "application/pdf", lastModified: Date.now() });

  state.pdfFile = cleanedFile; state.pdfBytes = cleanedBytes; state.pdf = cleanedPdf; state.pdfPending = null; state.pdfPassword = "";
  state.pdfBlankness.clear(); state.pdfBlanknessJobs.clear(); state.pdfFingerprints.clear(); state.pdfReferencePage = null; state.pdfBlankScanId++; state.pdfChapterMarks = remappedChapterMarks;
  state.pdfResult = { bytes: cleanedBytes, keep, deleted: new Set(deleted), flattened, stem };
  $("#pdf-reference-status").textContent = "Click a page preview to make it the blue reference."; $("#pdf-find-similar").disabled = true;
  $("#pdf-delete-range").value = ""; $("#pdf-direct-name").value = cleanedName;
  $("#pdf-count").textContent = `${cleanedPdf.numPages} pages · ${formatBytes(cleanedFile.size)}`;
  renderPdfPlaceholders(); updatePdfConfirmation(); stagePdfForBook(cleanedFile, cleanedPdf, cleanedBytes, "", $("#pdf-direct-author").value.trim());
  await originalPdf.destroy?.();

  $("#pdf-result-name").value = cleanedName; $("#pdf-result-author").value = $("#pdf-direct-author").value; $("#pdf-result-summary").textContent = `${cleanedPdf.numPages} page${cleanedPdf.numPages === 1 ? "" : "s"} remain · ${deleted.size} removed${flattened ? " · protected PDF flattened" : ""}`;
  $("#pdf-result-box").classList.add("show"); $("#pdf-result-download").disabled = false;
  status(`${deleted.size} marked page${deleted.size === 1 ? "" : "s"} removed from the workspace · choose a download format`, 100, true);
}
$("#pdf-delete").addEventListener("click", async () => {
  try {
    const pages = parseRange($("#pdf-delete-range").value, state.pdf.numPages); if (!pages.length) throw new Error("Enter one or more page numbers to mark."); invalidatePdfResult(); pages.forEach(pageNo => setPageKept(pageNo, false, "range")); updatePdfConfirmation(); status(`${pages.length} range page${pages.length === 1 ? "" : "s"} marked in orange · confirm before removal`, 100, true);
  } catch (e) { fail(e); }
});
$("#pdf-analyze").addEventListener("click", async () => {
  try {
    const threshold = +$("#pdf-blank-threshold").value; if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Blank threshold must be between 0 and 100%.");
    await markPdfBlankCandidates(threshold);
  } catch (e) { fail(e); }
});
$("#pdf-auto-blank").addEventListener("click", async () => {
  try { await markPdfBlankCandidates(99.5, true); } catch (e) { fail(e); }
});
async function markPdfBlankCandidates(threshold, exactBlank = false) {
  invalidatePdfResult(); const scores = await analyzePdfBlankness(); const hasReference = !!state.pdfReferencePage; let reference = null, similarityThreshold = 0;
  if (hasReference) { similarityThreshold = +$("#pdf-similarity-threshold").value; if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 100) throw new Error("Similarity threshold must be between 0 and 100%."); reference = await getPageFingerprint(state.pdfReferencePage); }
  let count = 0;
  for (let pageNo = 1; pageNo <= scores.length; pageNo++) {
    const blankMatch = scores[pageNo - 1] >= threshold; let similarity = 100;
    if (hasReference) {
      similarity = pageNo === state.pdfReferencePage ? 100 : calculateFingerprintSimilarity(reference, await getPageFingerprint(pageNo));
      const label = $(`.card[data-page="${pageNo}"] .similarity-score`, $("#pdf-pages")); if (label) label.textContent = pageNo === state.pdfReferencePage ? "Blue reference · 100%" : `${similarity.toFixed(1)}% similar`;
    }
    const matched = hasReference ? pageNo !== state.pdfReferencePage && matchesBlankAndSimilar(scores[pageNo - 1], threshold, similarity, similarityThreshold) : blankMatch; if (!hasPersistentPageMark(pageNo)) setPageKept(pageNo, !matched, hasReference ? "combined" : "blank"); if (matched) count++; await tick();
  }
  updatePdfConfirmation();
  if (hasReference) status(`${count} page${count === 1 ? "" : "s"} both ${exactBlank ? "fully blank" : `at least ${threshold}% blank`} and at least ${similarityThreshold}% similar marked in purple`, 100, true);
  else status(`${count} ${exactBlank ? "fully blank" : `at least ${threshold}% blank`} page${count === 1 ? "" : "s"} marked in red · confirm before removal`, 100, true);
}
$("#pdf-find-similar").addEventListener("click", async () => {
  try {
    if (!state.pdfReferencePage) throw new Error("Click a page preview first to choose the blue reference page.");
    const threshold = +$("#pdf-similarity-threshold").value; if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Similarity threshold must be between 0 and 100%.");
    invalidatePdfResult(); const reference = await getPageFingerprint(state.pdfReferencePage); let count = 0;
    for (let pageNo = 1; pageNo <= state.pdf.numPages; pageNo++) {
      status(`Comparing page ${pageNo} of ${state.pdf.numPages} to blue reference`, 5 + pageNo / state.pdf.numPages * 90); const score = pageNo === state.pdfReferencePage ? 100 : calculateFingerprintSimilarity(reference, await getPageFingerprint(pageNo));
      const label = $(`.card[data-page="${pageNo}"] .similarity-score`, $("#pdf-pages")); if (label) label.textContent = pageNo === state.pdfReferencePage ? "Blue reference · 100%" : `${score.toFixed(1)}% similar`;
      if (pageNo === state.pdfReferencePage) setPageKept(pageNo, true); else if (score >= threshold) { if (!hasPersistentPageMark(pageNo)) setPageKept(pageNo, false, "similar"); count++; } else if (!hasPersistentPageMark(pageNo)) setPageKept(pageNo, true); await tick();
    }
    updatePdfConfirmation(); status(`${count} page${count === 1 ? "" : "s"} at least ${threshold}% similar marked in red · confirm before removal`, 100, true);
  } catch (e) { fail(e); }
});
$("#pdf-delete-unchecked").addEventListener("click", async () => { try { await preparePdfWithDeleted(uncheckedPdfPages()); } catch (e) { fail(e); } });

// EPUB / MOBI / PDF conversion
function detectHtmlChapterTitle(doc) {
  const acceptable = value => { const text = cleanChapterTitle(value); return text.length >= 2 && text.length <= 140 && !/^(?:contents|table of contents)$/i.test(text) ? text : ""; };
  const explicitPattern = /^(?:(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+|[a-z])\b|prologue|epilogue|introduction|preface|foreword|afterword|conclusion|appendix\b|第.{1,12}[章节篇部]\b)/i;
  const selectors = ["[epub\\:type~='title']", "h1", "[role='heading'][aria-level='1']", ".chapter-title", ".chapter-heading", ".part-title", "[class*='chapter'][class*='title']", "[id*='chapter'][id*='title']"];
  for (const selector of selectors) { let node; try { node = doc.querySelector(selector); } catch {} const title = acceptable(node?.textContent); if (title) return title; }
  const titleElement = acceptable(doc.querySelector("title")?.textContent); if (titleElement && explicitPattern.test(titleElement)) return titleElement;
  const early = $$('p,div,span', doc.body).slice(0, 18).map(node => ({ text: acceptable(node.textContent), size: parseFloat(node.style?.fontSize) || Number(node.getAttribute?.("size")) || 0 })).filter(item => item.text);
  const explicit = early.find(item => explicitPattern.test(item.text)); if (explicit) return explicit.text;
  const sizes = early.map(item => item.size).filter(Boolean).sort((a, b) => a - b), median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const sized = early.find(item => item.size && item.size >= Math.max(16, median * 1.25) && item.text.length <= 90 && !/[.!?。！？]$/.test(item.text)); return sized?.text || "";
}
function applyDetectedChapterTitle(chapter, doc) {
  const detected = detectHtmlChapterTitle(doc); if (!chapter.title && detected) { chapter.title = detected; chapter.navLabel = detected; chapter.includeInToc = false; chapter.tocSource = "detected"; chapter.tocLevel = 1; } return detected;
}
function automaticTocEntries(chapters) { return tableOfContentsEntries(finalizeAutomaticTocChapters(chapters)); }
function updateBookTocPreview(book = state.book) {
  const list = $("#book-toc-list"), statusLabel = $("#book-toc-status"); if (!list || !statusLabel) return; list.textContent = "";
  if (!book?.chapters?.length || book.sourceType === "pdf") { statusLabel.textContent = "Generated during book export"; return; }
  const entries = automaticTocEntries(book.chapters), tree = tableOfContentsTree(entries), manual = book.chapters.some(chapter => Number(chapter.manualTocLevel) >= 1), append = (parent, nodes) => { for (const node of nodes) { const item = document.createElement("li"); if (node.children.length) { const details = document.createElement("details"), summary = document.createElement("summary"), children = document.createElement("ol"); summary.textContent = node.label; details.append(summary); append(children, node.children); details.append(children); item.append(details); } else { item.className = "toc-leaf"; item.textContent = node.label; } parent.append(item); } }; append(list, tree);
  const analyzed = book.chapters.filter(chapter => chapter.loaded).length; statusLabel.textContent = `${manual ? "MANUAL" : "AUTO"} · ${entries.length} entries · ${analyzed}/${book.chapters.length} pages analyzed`;
}
function markBookChapter(pageNo) {
  const level = state.bookChapterMarkLevel; if (!level) return selectBookReference(pageNo);
  const chapter = state.book?.chapters?.[pageNo - 1], card = $(`.card[data-page="${pageNo}"]`, $("#book-pages")); if (!chapter || !card) return;
  if (Number(chapter.manualTocLevel) === level) { delete chapter.manualTocLevel; delete chapter.manualTocTitle; }
  else { chapter.manualTocLevel = level; chapter.manualTocTitle = cleanChapterTitle($(".chapter-title-input", card)?.value) || chapterNavigationLabel(chapter, pageNo - 1); }
  syncChapterCard(card, Number(chapter.manualTocLevel) || 0, chapter.manualTocTitle || chapterNavigationLabel(chapter, pageNo - 1)); updateBookTocPreview();
  const count = state.book.chapters.filter(item => Number(item.manualTocLevel) >= 1).length; $("#book-chapter-mark-status").textContent = `${chapterLevelName(level)} marking is on · ${count} manual chapter${count === 1 ? "" : "s"} · manual marks replace auto.`;
}
function safeBookRenderDocument(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const styles = $$("style", doc).map(node => node.textContent || "").join("\n");
  $$('style,link,base,script,iframe,object,embed', doc).forEach(node => node.remove());
  $$('*', doc.body).forEach(node => { const style = node.style; if (!style) return; if (["fixed", "sticky"].includes(style.position)) { style.position = "static"; style.inset = "auto"; style.top = style.right = style.bottom = style.left = "auto"; } style.animation = "none"; style.transition = "none"; });
  return { doc, styles };
}
let renderPageId = 0;
function scopeBookStyles(styles, rootSelector) {
  try {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(styles.replace(/position\s*:\s*(?:fixed|sticky)\b/gi, "position:static"));
    const scopeSelector = selector => selector.split(",").map(part => { let value = part.trim().replace(/:root\b/g, rootSelector); if (value.includes(rootSelector)) return value; if (/^(?:html\b[^\s>+~]*)?\s*body\b/i.test(value)) return value.replace(/^(?:html\b[^\s>+~]*)?\s*body\b[^\s>+~]*/i, rootSelector); if (/^html\b/i.test(value)) return value.replace(/^html\b[^\s>+~]*/i, rootSelector); return `${rootSelector} ${value}`; }).join(",");
    const serialize = rule => {
      if (rule.selectorText) return rule.cssText.replace(rule.selectorText, scopeSelector(rule.selectorText));
      if (rule.cssRules) { const open = rule.cssText.indexOf("{"); return open < 0 ? rule.cssText : `${rule.cssText.slice(0, open + 1)}${[...rule.cssRules].map(serialize).join("")}}`; }
      return rule.cssText;
    };
    return [...sheet.cssRules].map(serialize).join("\n");
  } catch { return ""; }
}
function mountIsolatedBookPage(host, className, styles = "") {
  const page = document.createElement("div"), style = document.createElement("style"); page.id = `pf-isolated-render-${++renderPageId}`; page.className = className; const root = `#${page.id}`;
  style.textContent = `${scopeBookStyles(styles, root)}\n${root},${root} *{box-sizing:border-box;animation:none!important;transition:none!important}${root}.print-page{width:794px!important;height:1123px!important;overflow:hidden!important;background:#fff;color:#171717;padding:72px 68px;font:17px/1.58 Georgia,"Times New Roman",serif}${root}.print-page img{max-width:100%;height:auto;max-height:930px;object-fit:contain}${root}.print-page h1,${root}.print-page h2,${root}.print-page h3{line-height:1.15}${root}.book-analysis-page{width:360px!important;height:480px!important;overflow:hidden!important;background:#fff;color:#171717;padding:28px 24px;font:15px/1.5 Georgia,"Times New Roman",serif}${root}.book-analysis-page img{max-width:100%;max-height:400px;object-fit:contain}`;
  page.append(style); host.append(page); return { shell: page, page };
}
function configureBookMode(sourceType) {
  const fromPdf = sourceType === "pdf"; $("#book-step-label").textContent = fromPdf ? "PDF format conversion" : "Ebook format conversion";
  $("#book-action-title").textContent = fromPdf ? "Choose what to download." : "Review every ebook page, then download.";
  $("#book-conversion-heading").textContent = "Download choices";
}
function showBookDetails(book, file) {
  configureBookMode(book.sourceType);
  $("#book-summary").classList.add("show"); $("#book-title").textContent = book.title || file.name;
  const visualLabel = book.sourceType === "pdf" && !book.chapters.length ? "visuals detected during conversion" : Number.isFinite(book.visualCount) ? `${book.visualCount} packaged visuals` : "visuals load on demand";
  $("#book-meta").textContent = `${book.chapters?.length || book.pageCount || 0} ${book.sourceType === "pdf" ? "pages" : "ebook pages"} · ${visualLabel} · ${formatBytes(file.size)}${book.author ? ` · ${book.author}` : ""}`;
  $("#book-type").textContent = book.sourceType.toUpperCase(); $("#book-name").value = book.title || file.name.replace(/\.[^.]+$/, ""); $("#book-author").value = book.author || ""; $("#book-convert").disabled = false;
}
function stagePdfForBook(file, pdf, bytes, password, author = "") {
  const book = { sourceType: "pdf", title: file.name.replace(/\.pdf$/i, ""), author, pageCount: pdf.numPages, pdf, chapters: [], bytes, password, assets: [] };
  state.bookFile = file; state.book = book; state.bookPending = null; state.bookPassword = password; $("#book-password-box").classList.remove("show"); $("#book-password").value = ""; showBookDetails(book, file);
}
async function loadBook(file, password = "") {
  if (!file || !/\.(epub|mobi|azw3?|azm3|pdf)$/i.test(file.name)) return fail(new Error("Choose a PDF, EPUB, MOBI, AZW, AZW3, or AZM3 file."));
  try {
    showWorkspaceMode("book"); configureBookMode(file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "ebook");
    status("Opening book locally", 8); state.bookFile = file; const type = file.name.toLowerCase().split(".").pop();
    let book;
    if (type === "epub") book = await parseEpub(file);
    else if (type === "pdf") book = await pdfAsBook(file, false, password);
    else book = await parseMobi(file);
    state.book = book; state.bookPending = null; state.bookPassword = password; state.bookChapterMarkLevel = 0; setChapterMarkMode("book", 0); $("#book-password-box").classList.remove("show"); $("#book-password").value = ""; showBookDetails(book, file); if (book.sourceType !== "pdf") renderBookPlaceholders(); status("Book ready · complete page previews load locally", 100, true);
  } catch (e) {
    if (file.name.toLowerCase().endsWith(".pdf") && isPasswordError(e)) {
      state.book = null; state.bookPending = { file }; state.bookFile = file;
      showWorkspaceMode("book"); $("#book-summary").classList.add("show"); $("#book-title").textContent = file.name; $("#book-meta").textContent = "Locked PDF · enter its password to continue"; $("#book-type").textContent = "LOCKED";
      $("#book-password-box").classList.add("show"); $("#book-convert").disabled = true;
      status(password ? "Incorrect password — try again" : "Password required for this PDF", 100, true); setTimeout(() => $("#book-password").focus(), 50); return;
    }
    state.book = null; resetWorkspaceDisplay(); fail(new Error(`Could not open this book. ${e.message}`));
  }
}
$("#book-unlock").addEventListener("click", () => { if (state.bookPending) loadBook(state.bookPending.file, $("#book-password").value); });
$("#book-password").addEventListener("keydown", e => { if (e.key === "Enter") $("#book-unlock").click(); });
$("#book-reset").addEventListener("click", () => {
  if ((state.book?.sourceType === "pdf" && state.pdf) || (state.pdfPending && state.bookFile === state.pdfFile)) { $("#pdf-reset").click(); return; }
  state.bookPageObserver?.disconnect(); state.book?.dispose?.(); state.book?.pdf?.destroy?.();
  state.bookFile = state.book = state.bookPending = null; state.bookPassword = ""; state.bookChapterMarkLevel = 0; setChapterMarkMode("book", 0);
  state.bookBlankness.clear(); state.bookAnalysisJobs.clear(); state.bookFingerprints.clear(); state.bookReferencePage = null; state.bookBlankScanId++;
  $("#book-summary").classList.remove("show");
  $("#book-page-queue").classList.remove("show"); $("#book-pages").textContent = "";
  $("#book-password-box").classList.remove("show"); $("#book-password").value = "";
  ["#book-convert", "#book-delete", "#book-analyze", "#book-auto-blank", "#book-find-similar", "#book-delete-unchecked"].forEach(id => $(id).disabled = true);
  $("#book-name").value = $("#book-author").value = "";
  $("#book-delete-range").value = ""; $("#book-reference-status").textContent = "Click a page preview to make it the blue reference.";
  $("#book-toc-list").textContent = ""; $("#book-toc-status").textContent = "Waiting for a book";
  configureBookMode("ebook");
  resetWorkspaceDisplay();
});

function clearBookPageMark(card) { card.classList.remove("page-range", "page-combined"); delete card.dataset.mark; }
function setBookPageKept(pageNo, kept, markType = "") {
  const card = $(`.card[data-page="${pageNo}"]`, $("#book-pages")), check = card && $(".page-keep-check", card); if (!check) return;
  check.checked = kept; card.classList.toggle("page-removed", !kept); clearBookPageMark(card);
  if (!kept) { card.dataset.mark = markType || "analysis"; card.classList.toggle("page-range", markType === "range"); card.classList.toggle("page-combined", markType === "combined"); }
}
function hasPersistentBookPageMark(pageNo) { const mark = $(`.card[data-page="${pageNo}"]`, $("#book-pages"))?.dataset.mark; return mark === "range" || mark === "manual"; }
function uncheckedBookPages() { return new Set($$(".card", $("#book-pages")).filter(card => !$(".page-keep-check", card).checked).map(card => +card.dataset.page)); }
function updateBookConfirmation() {
  const count = uncheckedBookPages().size, button = $("#book-delete-unchecked"); button.disabled = count === 0;
  button.textContent = count ? `Confirm & prepare without ${count} marked page${count === 1 ? "" : "s"}` : "Confirm & prepare cleaned book";
}
function resetBookAnalysis() {
  state.bookBlankness.clear(); state.bookAnalysisJobs.clear(); state.bookFingerprints.clear(); state.bookReferencePage = null; state.bookBlankScanId++;
  $("#book-reference-status").textContent = "Click a page preview to make it the blue reference."; $("#book-find-similar").disabled = true;
}
async function loadBookChapter(book, index) {
  const chapter = book?.chapters?.[index]; if (!chapter) throw new Error("That ebook page is no longer available.");
  if (chapter.loaded) return chapter;
  if (!chapter.loading) chapter.loading = Promise.resolve(book.loadChapter ? book.loadChapter(chapter, index) : chapter).then(loaded => { chapter.loaded = true; chapter.loading = null; return loaded || chapter; }, error => { chapter.loading = null; throw error; });
  return chapter.loading;
}
function renderBookPlaceholders() {
  const book = state.book, host = $("#book-pages"); if (!book || book.sourceType === "pdf") return;
  host.textContent = ""; state.bookPageObserver?.disconnect(); resetBookAnalysis();
  $("#book-page-queue").classList.add("show"); $("#book-page-count").textContent = `${book.chapters.length} ebook page${book.chapters.length === 1 ? "" : "s"}`;
  ["#book-delete", "#book-analyze", "#book-auto-blank"].forEach(id => $(id).disabled = !book.chapters.length); $("#book-delete-unchecked").disabled = true;
  state.bookPageObserver = new IntersectionObserver(entries => entries.filter(entry => entry.isIntersecting).forEach(entry => { state.bookPageObserver.unobserve(entry.target); renderBookThumb(entry.target); }), { rootMargin: "500px" });
  book.chapters.forEach((chapter, index) => {
    const pageNo = index + 1, label = chapterNavigationLabel(chapter, index), card = document.createElement("div"); card.className = "card"; card.dataset.page = pageNo;
    card.innerHTML = `<button class="thumb pdf-reference-button" type="button" aria-pressed="false" title="Use ebook page ${pageNo} for the active chapter or similarity tool"><span class="page-no">PAGE ${pageNo}</span></button><div class="card-meta"><span class="filename" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="page-no">${escapeHtml(book.sourceType.toUpperCase())}</span></div><div class="chapter-editor"><span class="chapter-badge">Not in manual contents</span><input class="chapter-title-input" maxlength="140" value="${escapeHtml(chapter.manualTocTitle || label)}" aria-label="Chapter title for ebook page ${pageNo}"></div><label class="page-keep"><input class="page-keep-check" type="checkbox" checked aria-label="Keep ebook page ${pageNo}"><span>Keep page</span></label><div class="blank-score">Calculating blank %…</div><div class="similarity-score">Similarity not analyzed</div>`;
    syncChapterCard(card, Number(chapter.manualTocLevel) || 0, chapter.manualTocTitle || label);
    $(".pdf-reference-button", card).addEventListener("click", () => markBookChapter(pageNo));
    $(".chapter-title-input", card).addEventListener("input", event => { if (Number(chapter.manualTocLevel) >= 1) { chapter.manualTocTitle = cleanChapterTitle(event.target.value) || label; updateBookTocPreview(); } });
    $(".page-keep-check", card).addEventListener("change", event => { clearBookPageMark(card); card.classList.toggle("page-removed", !event.target.checked); if (!event.target.checked) card.dataset.mark = "manual"; updateBookConfirmation(); });
    host.append(card); state.bookPageObserver.observe(card);
  });
  updateBookTocPreview(book); void scheduleBookBlanknessScan(book);
}
async function renderBookThumb(card) {
  const book = state.book, pageNo = +card.dataset.page;
  try {
    const chapter = await loadBookChapter(book, pageNo - 1); if (book !== state.book || !card.isConnected) return; await getBookPageAnalysis(pageNo);
    const label = chapterNavigationLabel(chapter, pageNo - 1), filename = $(".filename", card), titleInput = $(".chapter-title-input", card); filename.textContent = label; filename.title = label; if (!chapter.manualTocLevel && titleInput !== document.activeElement) titleInput.value = label; updateBookTocPreview(book);
  } catch (error) { const thumb = $(".thumb", card); if (thumb) thumb.textContent = "Preview unavailable"; console.warn(error); }
}
function selectBookReference(pageNo) {
  state.bookReferencePage = pageNo;
  $$(".card", $("#book-pages")).forEach(card => { const selected = +card.dataset.page === pageNo; card.classList.toggle("page-reference", selected); $(".pdf-reference-button", card).setAttribute("aria-pressed", String(selected)); });
  setBookPageKept(pageNo, true); $("#book-find-similar").disabled = false; $("#book-reference-status").textContent = `Ebook page ${pageNo} is the blue reference. Similarity-only matches are red; blank + similar matches are purple.`; updateBookConfirmation();
}
function paintBookPreview(pageNo, sourceCanvas) {
  const card = $(`.card[data-page="${pageNo}"]`, $("#book-pages")), thumb = card && $(".thumb", card); if (!thumb || !sourceCanvas) return;
  const canvas = document.createElement("canvas"), width = 180, height = 240; canvas.className = "book-page-preview"; canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false }); context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(sourceCanvas, 0, 0, width, height); thumb.replaceChildren(canvas);
}
async function getBookPageAnalysis(pageNo) {
  if (state.bookBlankness.has(pageNo) && state.bookFingerprints.has(pageNo)) return { blankness: state.bookBlankness.get(pageNo), fingerprint: state.bookFingerprints.get(pageNo) };
  if (state.bookAnalysisJobs.has(pageNo)) return state.bookAnalysisJobs.get(pageNo);
  const book = state.book, job = (async () => {
    const chapter = await loadBookChapter(book, pageNo - 1), { doc, styles } = safeBookRenderDocument(chapter.html), mounted = mountIsolatedBookPage($("#render-host"), "book-analysis-page", styles), page = mounted.page;
    [...doc.body.childNodes].forEach(node => page.append(node.cloneNode(true))); let canvas;
    try { await waitForImages(page); canvas = await html2canvas(mounted.shell, { backgroundColor: "#ffffff", scale: .5, logging: false, useCORS: false, imageTimeout: 0, width: 360, height: 480 }); }
    finally { mounted.shell.remove(); }
    const context = canvas.getContext("2d", { alpha: false }), pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, blankness = calculateBlankPercentage(pixels), sample = document.createElement("canvas"); sample.width = sample.height = 48;
    const sampleContext = sample.getContext("2d", { alpha: false }); sampleContext.fillStyle = "#fff"; sampleContext.fillRect(0, 0, 48, 48); sampleContext.drawImage(canvas, 0, 0, 48, 48); const samplePixels = sampleContext.getImageData(0, 0, 48, 48).data, fingerprint = new Uint8Array(48 * 48 * 3);
    for (let source = 0, target = 0; source < samplePixels.length; source += 4) { fingerprint[target++] = samplePixels[source]; fingerprint[target++] = samplePixels[source + 1]; fingerprint[target++] = samplePixels[source + 2]; }
    if (state.book === book) { state.bookBlankness.set(pageNo, blankness); state.bookFingerprints.set(pageNo, fingerprint); paintBookPreview(pageNo, canvas); const label = $(`.card[data-page="${pageNo}"] .blank-score`, $("#book-pages")); if (label) label.textContent = `${blankness.toFixed(1)}% blank`; updateBookTocPreview(book); }
    return { blankness, fingerprint };
  })().finally(() => state.bookAnalysisJobs.delete(pageNo));
  state.bookAnalysisJobs.set(pageNo, job); return job;
}
async function scheduleBookBlanknessScan(book) {
  if (!book?.chapters?.length) return; const scanId = ++state.bookBlankScanId; await idleTick(800);
  for (let pageNo = 1; pageNo <= book.chapters.length; pageNo++) { if (scanId !== state.bookBlankScanId || state.book !== book) return; try { await getBookPageAnalysis(pageNo); } catch {} await idleTick(); }
}
async function analyzeBookBlankness() {
  const scores = [];
  for (let pageNo = 1; pageNo <= state.book.chapters.length; pageNo++) { status(`Analyzing ebook blank space · page ${pageNo} of ${state.book.chapters.length}`, 5 + pageNo / state.book.chapters.length * 90); scores.push((await getBookPageAnalysis(pageNo)).blankness); await tick(); }
  return scores;
}
async function markBookBlankCandidates(threshold, exactBlank = false) {
  const scores = await analyzeBookBlankness(), hasReference = !!state.bookReferencePage, reference = hasReference ? (await getBookPageAnalysis(state.bookReferencePage)).fingerprint : null, similarityThreshold = hasReference ? +$("#book-similarity-threshold").value : 0; if (hasReference && (!Number.isFinite(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 100)) throw new Error("Similarity threshold must be between 0 and 100%."); let count = 0;
  for (let pageNo = 1; pageNo <= scores.length; pageNo++) { const fingerprint = hasReference ? (await getBookPageAnalysis(pageNo)).fingerprint : null, similarity = hasReference ? pageNo === state.bookReferencePage ? 100 : calculateFingerprintSimilarity(reference, fingerprint) : 100, matched = hasReference ? pageNo !== state.bookReferencePage && matchesBlankAndSimilar(scores[pageNo - 1], threshold, similarity, similarityThreshold) : scores[pageNo - 1] >= threshold; if (hasReference) { const label = $(`.card[data-page="${pageNo}"] .similarity-score`, $("#book-pages")); if (label) label.textContent = pageNo === state.bookReferencePage ? "Blue reference · 100%" : `${similarity.toFixed(1)}% similar`; } if (!hasPersistentBookPageMark(pageNo)) setBookPageKept(pageNo, !matched, hasReference ? "combined" : "blank"); if (matched) count++; await tick(); }
  updateBookConfirmation(); status(`${count} ebook page${count === 1 ? "" : "s"} ${hasReference ? "matching both thresholds marked in purple" : `${exactBlank ? "fully blank" : `at least ${threshold}% blank`} marked in red`} · confirm before removal`, 100, true);
}
$("#book-delete").addEventListener("click", () => { try { const pages = parseRange($("#book-delete-range").value, state.book.chapters.length); if (!pages.length) throw new Error("Enter one or more ebook page numbers to mark."); pages.forEach(pageNo => setBookPageKept(pageNo, false, "range")); updateBookConfirmation(); status(`${pages.length} ebook page${pages.length === 1 ? "" : "s"} marked in orange · confirm before removal`, 100, true); } catch (error) { fail(error); } });
$("#book-analyze").addEventListener("click", async () => { try { const threshold = +$("#book-blank-threshold").value; if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Blank threshold must be between 0 and 100%."); await markBookBlankCandidates(threshold); } catch (error) { fail(error); } });
$("#book-auto-blank").addEventListener("click", async () => { try { await markBookBlankCandidates(99.5, true); } catch (error) { fail(error); } });
$("#book-find-similar").addEventListener("click", async () => { try { if (!state.bookReferencePage) throw new Error("Click an ebook page preview first to choose the blue reference."); const threshold = +$("#book-similarity-threshold").value; if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Similarity threshold must be between 0 and 100%."); const reference = (await getBookPageAnalysis(state.bookReferencePage)).fingerprint; let count = 0; for (let pageNo = 1; pageNo <= state.book.chapters.length; pageNo++) { status(`Comparing ebook page ${pageNo} of ${state.book.chapters.length}`, 5 + pageNo / state.book.chapters.length * 90); const score = pageNo === state.bookReferencePage ? 100 : calculateFingerprintSimilarity(reference, (await getBookPageAnalysis(pageNo)).fingerprint), label = $(`.card[data-page="${pageNo}"] .similarity-score`, $("#book-pages")); if (label) label.textContent = pageNo === state.bookReferencePage ? "Blue reference · 100%" : `${score.toFixed(1)}% similar`; if (pageNo === state.bookReferencePage) setBookPageKept(pageNo, true); else if (score >= threshold) { if (!hasPersistentBookPageMark(pageNo)) setBookPageKept(pageNo, false, "similar"); count++; } else if (!hasPersistentBookPageMark(pageNo)) setBookPageKept(pageNo, true); await tick(); } updateBookConfirmation(); status(`${count} similar ebook page${count === 1 ? "" : "s"} marked in red · confirm before removal`, 100, true); } catch (error) { fail(error); } });
function removeMarkedBookPages(deleted = uncheckedBookPages()) {
  if (!deleted.size) throw new Error("No ebook pages are marked for removal."); if (deleted.size === state.book.chapters.length) throw new Error("A book needs at least one page. Keep one or more pages.");
  const before = state.book.chapters.length; state.book.chapters = removeBookPages(state.book.chapters, deleted); state.book.cleaned = true; $("#book-delete-range").value = ""; state.bookBlankness.clear(); state.bookAnalysisJobs.clear(); state.bookFingerprints.clear(); state.bookBlankScanId++; renderBookPlaceholders(); showBookDetails(state.book, state.bookFile); status(`${deleted.size} marked ebook page${deleted.size === 1 ? "" : "s"} removed · ${before - deleted.size} remain`, 100, true); return deleted.size;
}
$("#book-delete-unchecked").addEventListener("click", () => { try { removeMarkedBookPages(); } catch (error) { fail(error); } });

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } })); return results;
}
async function zipAssetData(zip, path, assets, cache = new Map()) {
  const clean = normalizePath(decodeURIComponent(path.split("#")[0])); if (!cache.has(clean)) cache.set(clean, (async () => { const entry = zip.file(clean); if (!entry) return null; return blobToDataURL(new Blob([await entry.async("blob")], { type: mimeFromPath(clean) })); })());
  const data = await cache.get(clean); if (data?.startsWith("data:image/")) assets.add(data); return data;
}
async function inlineCssResources(css, cssPath, zip, assets, cache) {
  css = css.replace(/@import[^;]+;/gi, ""); const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi; let out = "", at = 0, match;
  while ((match = re.exec(css))) {
    out += css.slice(at, match.index); const raw = match[2].trim(); let replacement = "none";
    if (/^data:/i.test(raw)) { replacement = `url("${raw}")`; if (/^data:image\//i.test(raw)) assets.add(raw); }
    else if (!/^(https?:|\/\/|#)/i.test(raw)) { const data = await zipAssetData(zip, dirname(cssPath) + raw, assets, cache); if (data) replacement = `url("${data}")`; }
    out += replacement; at = re.lastIndex;
  }
  return out + css.slice(at);
}
async function inlineEpubChapter(html, chapterPath, zip, assets, cache) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const source of $$("source[srcset]", doc)) {
    const candidates = source.getAttribute("srcset").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean), picture = source.closest("picture"), img = picture?.querySelector("img");
    for (const raw of candidates) if (!/^data:/i.test(raw) && !/^(https?:)?\/\//i.test(raw)) await zipAssetData(zip, dirname(chapterPath) + raw, assets, cache);
    if (img && candidates[0]) img.setAttribute("src", candidates[0]);
  }
  for (const img of $$("img[srcset]", doc)) {
    const candidates = img.getAttribute("srcset").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
    for (const raw of candidates) if (!/^data:/i.test(raw) && !/^(https?:)?\/\//i.test(raw)) await zipAssetData(zip, dirname(chapterPath) + raw, assets, cache);
    if (candidates[0]) img.setAttribute("src", candidates[0]);
  }
  for (const link of $$("link[rel~='stylesheet'][href]", doc)) { const cssPath = normalizePath(dirname(chapterPath) + link.getAttribute("href").split("#")[0]), css = await zip.file(cssPath)?.async("text"); if (css) { const style = doc.createElement("style"); style.textContent = await inlineCssResources(css, cssPath, zip, assets, cache); link.replaceWith(style); } else link.remove(); }
  for (const style of $$("style", doc)) style.textContent = await inlineCssResources(style.textContent, chapterPath, zip, assets, cache);
  for (const node of $$("[style*='url(']", doc)) node.setAttribute("style", await inlineCssResources(node.getAttribute("style"), chapterPath, zip, assets, cache));
  for (const node of $$("img,image,video[poster],object[data]", doc)) {
    const attr = node.hasAttribute("src") ? "src" : node.hasAttribute("poster") ? "poster" : node.hasAttribute("data") ? "data" : node.hasAttribute("href") ? "href" : node.hasAttribute("xlink:href") ? "xlink:href" : ""; const raw = attr && node.getAttribute(attr); if (!raw) continue;
    if (/^data:/i.test(raw)) { if (/^data:image\//i.test(raw)) assets.add(raw); continue; }
    if (/^(https?:)?\/\//i.test(raw)) { node.remove(); continue; }
    const data = await zipAssetData(zip, dirname(chapterPath) + raw, assets, cache); if (data) node.setAttribute(attr, data); else node.removeAttribute(attr);
  }
  for (const svg of $$("svg", doc)) { const data = await blobToDataURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" })); assets.add(data); const img = doc.createElement("img"); img.src = data; img.alt = svg.getAttribute("aria-label") || "SVG artwork"; svg.replaceWith(img); }
  $$('script,iframe,object,embed,link,source', doc).forEach(x => x.remove());
  const styles = $$("style", doc.head).map(x => x.outerHTML).join(""); return styles + doc.body.innerHTML;
}
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file), container = await zip.file("META-INF/container.xml")?.async("text"); if (!container) throw new Error("EPUB container.xml is missing.");
  const cdoc = new DOMParser().parseFromString(container, "application/xml"), opfPath = cdoc.querySelector("rootfile")?.getAttribute("full-path"); if (!opfPath) throw new Error("EPUB package path is missing.");
  const opfText = await zip.file(opfPath)?.async("text"), opf = new DOMParser().parseFromString(opfText, "application/xml"), base = dirname(opfPath), manifest = new Map($$("manifest item", opf).map(x => [x.getAttribute("id"), { id: x.getAttribute("id"), href: normalizePath(base + x.getAttribute("href")), type: x.getAttribute("media-type") || "", properties: x.getAttribute("properties") || "" }]));
  const title = opf.querySelector("metadata title, metadata dc\\:title")?.textContent?.trim() || file.name.replace(/\.epub$/i, ""), author = opf.querySelector("metadata creator, metadata dc\\:creator")?.textContent?.trim() || "", chapters = [], refs = $$("spine itemref", opf), tocTitles = new Map();
  const navItem = [...manifest.values()].find(item => item.properties.split(/\s+/).includes("nav"));
  if (navItem) {
    const navMarkup = await zip.file(navItem.href)?.async("text");
    if (navMarkup) { const navDoc = new DOMParser().parseFromString(navMarkup, "text/html"); for (const link of $$("nav a[href]", navDoc)) { const href = normalizePath(dirname(navItem.href) + link.getAttribute("href").split("#")[0]), label = cleanChapterTitle(link.textContent); let level = 1, parent = link.closest("li")?.parentElement?.closest("li"); while (parent) { level++; parent = parent.parentElement?.closest("li"); } if (href && label && !tocTitles.has(href)) tocTitles.set(href, { label, level: Math.min(3, level) }); } }
  }
  const ncxId = opf.querySelector("spine")?.getAttribute("toc"), ncxItem = ncxId ? manifest.get(ncxId) : [...manifest.values()].find(item => item.type === "application/x-dtbncx+xml");
  if (ncxItem) {
    const ncxMarkup = await zip.file(ncxItem.href)?.async("text");
    if (ncxMarkup) { const ncxDoc = new DOMParser().parseFromString(ncxMarkup, "application/xml"); for (const point of $$("navPoint", ncxDoc)) { const raw = point.querySelector("content")?.getAttribute("src"), label = cleanChapterTitle(point.querySelector("navLabel text")?.textContent); let level = 1, parent = point.parentElement?.closest("navPoint"); while (parent) { level++; parent = parent.parentElement?.closest("navPoint"); } const href = raw && normalizePath(dirname(ncxItem.href) + raw.split("#")[0]); if (href && label && !tocTitles.has(href)) tocTitles.set(href, { label, level: Math.min(3, level) }); } }
  }
  for (let i = 0; i < refs.length; i++) { const item = manifest.get(refs[i].getAttribute("idref")); if (!item || !zip.file(item.href)) continue; const tocEntry = tocTitles.get(item.href), chapterTitle = tocEntry?.label || ""; chapters.push({ title: chapterTitle, navLabel: chapterTitle || `Section ${i + 1}`, includeInToc: Boolean(tocEntry), tocSource: tocEntry ? "publisher" : "unknown", tocLevel: tocEntry?.level || 1, html: "", loaded: false, kind: "epub-html", path: item.href, assets: [] }); }
  const imageItems = [...manifest.values()].filter(item => item.type.startsWith("image/") || mimeFromPath(item.href).startsWith("image/"));
  const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute("content"), guideHref = opf.querySelector('guide reference[type~="cover"]')?.getAttribute("href"), cover = [...manifest.values()].find(x => x.properties.split(/\s+/).includes("cover-image")) || manifest.get(coverId) || [...manifest.values()].find(x => /cover/i.test(x.id || "") && x.type.startsWith("image/"));
  const coverPath = cover?.href || (guideHref ? normalizePath(base + guideHref) : "");
  if (coverPath && !chapters.some(chapter => chapter.path === coverPath) && zip.file(coverPath)) chapters.unshift({ title: "Cover", navLabel: "Cover", includeInToc: false, tocSource: "cover", tocLevel: 1, html: "", loaded: false, kind: mimeFromPath(coverPath).startsWith("image/") ? "epub-image" : "epub-html", path: coverPath, assets: [] });
  if (!chapters.length) throw new Error("No readable EPUB chapters were found.");
  const assetCache = new Map(), book = { sourceType: "epub", title, author, chapters, assets: [], visualCount: imageItems.length, lazy: true, source: { zip, assetCache, assetPaths: imageItems.map(item => item.href) } };
  book.loadChapter = async (chapter, index) => {
    const assets = new Set();
    if (chapter.kind === "epub-image") { const data = await zipAssetData(zip, chapter.path, assets, assetCache); chapter.html = data ? `<div style="text-align:center"><img alt="Cover" src="${data}"></div>` : ""; }
    else { const markup = await zip.file(chapter.path)?.async("text"); if (!markup) throw new Error(`EPUB page ${index + 1} is missing.`); const chapterDoc = new DOMParser().parseFromString(markup, "text/html"); applyDetectedChapterTitle(chapter, chapterDoc); chapter.html = await inlineEpubChapter(markup, chapter.path, zip, assets, assetCache); }
    chapter.assets = [...assets]; return chapter;
  };
  return book;
}
async function parseMobi(file) {
  let mobi; const sourceExt = file.name.toLowerCase().split(".").pop(), preferKf8 = sourceExt === "azw3" || sourceExt === "azm3";
  try { mobi = preferKf8 ? await initKf8File(file) : await initMobiFile(file); } catch { mobi = preferKf8 ? await initMobiFile(file) : await initKf8File(file); }
  const meta = mobi.getMetadata(), spine = mobi.getSpine(), chapters = [], tocTitles = new Map(), visitToc = (items, level = 1) => { for (const item of items || []) { const resolved = mobi.resolveHref?.(item.href), label = cleanChapterTitle(item.label); if (resolved?.id != null && label && !tocTitles.has(String(resolved.id))) tocTitles.set(String(resolved.id), { label, level: Math.min(3, level) }); visitToc(item.children, level + 1); } }; visitToc(mobi.getToc?.());
  for (let i = 0; i < spine.length; i++) { const tocEntry = tocTitles.get(String(spine[i].id)), chapterTitle = tocEntry?.label || ""; chapters.push({ title: chapterTitle, navLabel: chapterTitle || `Section ${i + 1}`, includeInToc: Boolean(tocEntry), tocSource: tocEntry ? "publisher" : "unknown", tocLevel: tocEntry?.level || 1, html: "", loaded: false, kind: "mobi-html", mobiId: spine[i].id, assets: [] }); }
  const coverUrl = mobi.getCoverImage?.(); if (coverUrl) chapters.unshift({ title: "Cover", navLabel: "Cover", includeInToc: false, tocSource: "cover", tocLevel: 1, html: "", loaded: false, kind: "mobi-cover", sourceUrl: coverUrl, assets: [] });
  if (!chapters.length) { mobi.destroy(); throw new Error("No readable MOBI/KF8 sections were found."); }
  const authorValues = Array.isArray(meta.author) ? meta.author : meta.author ? [meta.author] : [], book = { sourceType: sourceExt === "azm3" ? "azm3" : preferKf8 ? "azw3" : "mobi", title: meta.title || file.name.replace(/\.[^.]+$/, ""), author: authorValues.join(", "), chapters, assets: [], visualCount: undefined, lazy: true, source: { mobi } };
  book.loadChapter = async (chapter, index) => {
    const assets = new Set();
    if (chapter.kind === "mobi-cover") { const data = await blobToDataURL(await (await realFetch(chapter.sourceUrl)).blob()); if (data.startsWith("data:image/")) assets.add(data); chapter.html = `<img alt="Cover" src="${data}">`; }
    else { const loaded = mobi.loadChapter(chapter.mobiId); if (!loaded) throw new Error(`Ebook page ${index + 1} could not be read.`); const styles = await Promise.all((loaded.css || []).map(async css => { try { return `<style>${await (await realFetch(css.href)).text()}</style>`; } catch { return ""; } })); chapter.html = await inlineBlobImages(styles.join("") + loaded.html, assets); applyDetectedChapterTitle(chapter, new DOMParser().parseFromString(chapter.html, "text/html")); }
    chapter.assets = [...assets]; return chapter;
  };
  let destroyed = false; book.dispose = () => { if (!destroyed) { destroyed = true; mobi.destroy(); } }; return book;
}

async function materializeBook(book) {
  if (!book?.lazy || typeof book.loadChapter !== "function") return book;
  const total = book.chapters.length, concurrency = book.sourceType === "epub" ? 4 : 2;
  await mapWithConcurrency(book.chapters, concurrency, async (_chapter, index) => {
    status(`Preparing selected ebook pages · ${index + 1} of ${total}`, 5 + ((index + 1) / Math.max(1, total)) * 75);
    const chapter = await loadBookChapter(book, index); await tick(); return chapter;
  });
  const assets = new Set(book.chapters.flatMap(chapter => chapter.assets || []));
  if (book.sourceType === "epub" && !book.cleaned && book.source?.assetPaths?.length) {
    const paths = book.source.assetPaths;
    await mapWithConcurrency(paths, 4, async (path, index) => {
      status(`Checking packaged EPUB artwork · ${index + 1} of ${paths.length}`, 80 + ((index + 1) / paths.length) * 15);
      await zipAssetData(book.source.zip, path, assets, book.source.assetCache); await tick();
    });
  }
  return { ...book, chapters: finalizeAutomaticTocChapters(book.chapters.map(chapter => ({ ...chapter, html: chapter.html || "" }))), assets: [...assets], lazy: false };
}
async function inlineBlobCss(css, assets) {
  const re = /url\(\s*(['"]?)(blob:[^)'"]+)\1\s*\)/gi; let out = "", at = 0, match;
  while ((match = re.exec(css))) { out += css.slice(at, match.index); try { const data = await blobToDataURL(await (await realFetch(match[2])).blob()); if (data.startsWith("data:image/")) assets.add(data); out += `url("${data}")`; } catch { out += "none"; } at = re.lastIndex; }
  return out + css.slice(at);
}
async function inlineBlobImages(html, assets = new Set()) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const style of $$("style", doc)) style.textContent = await inlineBlobCss(style.textContent, assets);
  for (const node of $$("img[src],image[href],video[src],video[poster],audio[src]", doc)) { const attr = node.hasAttribute("src") ? "src" : node.hasAttribute("poster") ? "poster" : "href", src = node.getAttribute(attr); if (src?.startsWith("blob:")) try { const data = await blobToDataURL(await (await realFetch(src)).blob()); node.setAttribute(attr, data); if (data.startsWith("data:image/")) assets.add(data); } catch { node.remove(); } else if (src?.startsWith("data:image/")) assets.add(src); else if (src && /^(https?:)?\/\//i.test(src)) node.remove(); }
  for (const svg of $$("svg", doc)) { const data = await blobToDataURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" })); assets.add(data); const img = doc.createElement("img"); img.src = data; img.alt = svg.getAttribute("aria-label") || "SVG artwork"; svg.replaceWith(img); }
  $$('script,iframe,object,embed', doc).forEach(x => x.remove()); return $$("style", doc.head).map(x => x.outerHTML).join("") + doc.body.innerHTML;
}
async function pdfAsBook(file, renderPages = true, password = "", existingBytes = null) {
  const bytes = existingBytes || new Uint8Array(await file.arrayBuffer()), pdf = await pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined }).promise, pdfMetadata = await pdf.getMetadata().catch(() => ({})); const book = { sourceType: "pdf", title: file.name.replace(/\.pdf$/i, ""), author: cleanChapterTitle(pdfMetadata?.info?.Author), pageCount: pdf.numPages, pdf, chapters: [], bytes, password, assets: [] };
  if (renderPages) for (let i = 1; i <= pdf.numPages; i++) {
    status(`Extracting text and artwork from PDF page ${i} of ${pdf.numPages}`, 8 + (i / pdf.numPages) * 80);
    const page = await pdf.getPage(i), content = await page.getTextContent(), operators = await page.getOperatorList(), lines = []; let line = [], lineFontSize = 0;
    for (const item of content.items || []) { const value = String(item.str || "").trim(), fontSize = Math.abs(Number(item.transform?.[3]) || Number(item.height) || 0); if (value) { line.push(value); lineFontSize = Math.max(lineFontSize, fontSize); } if (item.hasEOL && line.length) { lines.push({ text: line.join(" "), fontSize: lineFontSize }); line = []; lineFontSize = 0; } }
    if (line.length) lines.push({ text: line.join(" "), fontSize: lineFontSize });
    const visualOps = new Set([pdfjsLib.OPS.stroke, pdfjsLib.OPS.closeStroke, pdfjsLib.OPS.fill, pdfjsLib.OPS.eoFill, pdfjsLib.OPS.fillStroke, pdfjsLib.OPS.eoFillStroke, pdfjsLib.OPS.closeFillStroke, pdfjsLib.OPS.closeEOFillStroke, pdfjsLib.OPS.shadingFill, pdfjsLib.OPS.paintXObject, pdfjsLib.OPS.paintFormXObjectBegin, pdfjsLib.OPS.paintImageMaskXObject, pdfjsLib.OPS.paintImageMaskXObjectGroup, pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintInlineImageXObjectGroup, pdfjsLib.OPS.paintImageXObjectRepeat, pdfjsLib.OPS.paintImageMaskXObjectRepeat, pdfjsLib.OPS.paintSolidColorImageMask, pdfjsLib.OPS.rawFillPath].filter(Number.isFinite)), hasVisualArt = operators.fnArray.some(op => visualOps.has(op)); page.cleanup();
    const data = hasVisualArt ? await blobToDataURL(await renderPdfPage(pdf, i, 1.45, "jpeg", .9)) : "", chapter = createPdfBookChapter({ pageNo: i, lines, hasVisualArt, imageData: data });
    if (chapter) { book.assets.push(...chapter.assets); book.chapters.push(chapter); } await tick();
  }
  if (state.pdfChapterMarks.size) book.chapters = finalizeAutomaticTocChapters(book.chapters.map(chapter => { const mark = state.pdfChapterMarks.get(chapter.sourcePageNo); return mark ? { ...chapter, manualTocLevel: mark.level, manualTocTitle: mark.title, tocSource: "manual" } : chapter; }));
  else book.chapters = finalizePdfBookChapters(book.chapters); return book;
}
function filterHtml(html, mode) {
  if (mode === "all") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (mode === "text") { $$('img,picture,svg,image,canvas,video,audio,object,embed', doc).forEach(x => x.remove()); $$('[style*="background"]', doc).forEach(x => x.style.backgroundImage = "none"); }
  else {
    $$("img[data-page-render='text-only'],img[data-page-render='blank']", doc).forEach(x => x.remove());
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); const texts = []; while (walker.nextNode()) texts.push(walker.currentNode); texts.forEach(x => x.textContent = "");
    const media = "img,picture,svg,image,canvas,video,[style*='data:image']"; [...doc.body.querySelectorAll("*")].reverse().forEach(x => { if (!x.matches(media) && !x.querySelector(media) && !["STYLE","SOURCE"].includes(x.tagName)) x.remove(); });
  }
  return $$("style", doc.head).map(x => x.outerHTML).join("") + doc.body.innerHTML;
}
function dataImagesIn(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"), found = new Set();
  for (const node of $$("img[src],image[href],video[poster],[style*='data:image']", doc.body)) for (const value of [node.getAttribute("src"), node.getAttribute("href"), node.getAttribute("poster"), node.getAttribute("style")]) for (const data of value?.match(/data:image\/[^\s"'()<>]+/gi) || []) found.add(data);
  return found;
}
function hasVisualContent(html) { const doc = new DOMParser().parseFromString(html, "text/html"); return !!doc.body.querySelector("img,picture,svg,image,canvas,video,[style*='data:image']") || /data:image\//i.test(doc.body.innerHTML); }
function hasTextContent(html) { const doc = new DOMParser().parseFromString(html, "text/html"); return !!doc.body.textContent.trim(); }
function filteredBook(book, mode) {
  let chapters = book.chapters.map(ch => ({ ...ch, html: filterHtml(ch.html, mode) }));
  chapters = chapters.filter(ch => mode === "images" ? hasVisualContent(ch.html) : mode === "text" ? hasTextContent(ch.html) : hasTextContent(ch.html) || hasVisualContent(ch.html));
  if (mode === "images") {
    const present = new Set(chapters.flatMap(ch => [...dataImagesIn(ch.html)])), missing = (book.assets || []).filter(asset => !present.has(asset));
    if (missing.length) chapters.push({ title: "Recovered artwork", includeInToc: false, html: missing.map((src, i) => `<div style="text-align:center;margin:0 0 24px"><img alt="Recovered artwork ${i + 1}" src="${src}"></div>`).join("") });
  }
  return { ...book, chapters, filterMode: mode };
}

if (!canStreamFile()) $("#photo-engine-note").textContent = "This browser does not expose direct disk streaming. PageForge will use universal memory mode; Chrome or Edge can write progressively to disk on Windows and macOS.";
async function downloadBookArtifact(book, output, title) {
  if (output === "pdf") downloadBlob(await bookToPdf(book), `${title}.pdf`);
  else if (output === "epub") {
    const epub = await buildEpub(book), check = await JSZip.loadAsync(epub); if (!check.file("META-INF/container.xml")) throw new Error("EPUB package verification failed."); downloadBlob(epub, `${title}.epub`);
  } else if (output === "mobi") {
    const mobiBytes = buildMobi(book), check = await initMobiFile(new File([mobiBytes], `${title}.mobi`, { type: "application/x-mobipocket-ebook" })); if (!check.getSpine().length) throw new Error("MOBI package verification failed."); check.destroy(); downloadBlob(bytesToBlob(mobiBytes, "application/x-mobipocket-ebook"), `${title}.mobi`);
  } else {
    const azwBytes = buildAzw3(book), extension = output === "azm3" ? "azm3" : "azw3", check = await initKf8File(new File([azwBytes], `${title}.${extension}`, { type: "application/vnd.amazon.ebook" })); const first = check.getSpine()[0]; if (!first || !check.loadChapter(first.id)?.html) throw new Error("KF8 package verification failed."); check.destroy(); downloadBlob(bytesToBlob(azwBytes, "application/vnd.amazon.ebook"), `${title}.${extension}`);
  }
}
$("#book-convert").addEventListener("click", async () => {
  let generatedBook = null;
  try {
    if (!state.book) throw new Error("Choose a PDF or ebook first."); const marked = state.book.sourceType === "pdf" ? new Set() : uncheckedBookPages();
    if (marked.size) { const choice = await askAboutMarkedPages("ebook", marked.size); if (choice === "cancel") { status("Download canceled", 100, true); return; } if (choice === "delete") removeMarkedBookPages(marked); }
    stopBackgroundAnalysis(); let book = state.book; if (book.sourceType === "pdf" && !book.chapters.length) { generatedBook = await pdfAsBook(state.bookFile, true, book.password || state.bookPassword, book.bytes); book = generatedBook; }
    else if (book.lazy) book = await materializeBook(book);
    const title = safeName($("#book-name").value, book.title || "pageforge-book"), author = $("#book-author").value.trim(), mode = $("#book-filter").value, output = $("#book-output").value;
    const filtered = { ...filteredBook(book, mode), title, author };
    if (!filtered.chapters.length) throw new Error("No non-empty sections remain after applying that filter.");
    if (mode === "images" && !filtered.chapters.some(ch => hasVisualContent(ch.html))) throw new Error("No visual assets were found after checking covers, SVGs, responsive images, and CSS backgrounds.");
    if (mode === "text" && !filtered.chapters.some(ch => hasTextContent(ch.html))) throw new Error("No extractable text was found. This book may contain scanned page images only; choose Photos only instead.");
    await downloadBookArtifact(filtered, output, title);
    status(`${output.toUpperCase()} downloaded`, 100, true);
  } catch (e) { fail(e); } finally { generatedBook?.pdf?.destroy?.(); if (state.book?.sourceType !== "pdf") void scheduleBookBlanknessScan(state.book); }
});
async function downloadPdfPhotos(pdf, title, output, scale, compression, streamToFolder = false) {
  const ext = output === "jpeg" ? "jpg" : output;
  if (streamToFolder && canStreamFolder() && pdf.numPages > 1) {
    const directory = await window.showDirectoryPicker({ mode: "readwrite" });
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) { status(`Saving photo ${pageNo} of ${pdf.numPages}`, 5 + pageNo / pdf.numPages * 90); const blob = await renderPdfPage(pdf, pageNo, scale, output, compression), handle = await directory.getFileHandle(`${title}-page-${String(pageNo).padStart(4, "0")}.${ext}`, { create: true }), writable = await handle.createWritable(); await writable.write(blob); await writable.close(); await tick(); }
  } else if (pdf.numPages === 1) downloadBlob(await renderPdfPage(pdf, 1, scale, output, compression), `${title}.${ext}`);
  else {
    const zip = new JSZip(); for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) { status(`Rendering photo ${pageNo} of ${pdf.numPages}`, 5 + pageNo / pdf.numPages * 84); zip.file(`${title}-page-${String(pageNo).padStart(4, "0")}.${ext}`, await renderPdfPage(pdf, pageNo, scale, output, compression)); await tick(); }
    status("Packing photos", 92); downloadBlob(await zip.generateAsync({ type: "blob", compression: "STORE" }), `${title}-${ext}-photos.zip`);
  }
}
async function pdfWithMetadata(bytes, title, author, protectedPdf = null) {
  let pdf;
  try { pdf = await PDFDocument.load(bytes); }
  catch (error) {
    if (!protectedPdf) throw error;
    const pages = Array.from({ length: protectedPdf.numPages }, (_, index) => index + 1);
    pdf = await PDFDocument.load(await flattenPdfPages(protectedPdf, pages));
  }
  pdf.setTitle(title); if (author) pdf.setAuthor(author);
  return bytesToBlob(await pdf.save({ useObjectStreams: true }), "application/pdf");
}
function updatePdfDirectPhotoOptions() {
  $("#pdf-direct-photo-options").classList.toggle("show", ["jpeg", "png", "webp"].includes($("#pdf-direct-format").value));
}
$("#pdf-direct-format").addEventListener("change", updatePdfDirectPhotoOptions);
$("#pdf-direct-download").addEventListener("click", async () => {
  let generatedBook = null;
  try {
    if (!state.pdf) throw new Error("Choose a PDF first."); const marked = uncheckedPdfPages();
    if (marked.size) { const choice = await askAboutMarkedPages("PDF", marked.size); if (choice === "cancel") { status("Download canceled", 100, true); return; } if (choice === "delete") await preparePdfWithDeleted(marked); }
    stopBackgroundAnalysis(); const output = $("#pdf-direct-format").value, title = safeName($("#pdf-direct-name").value, state.pdfFile.name.replace(/\.pdf$/i, "")), author = $("#pdf-direct-author").value.trim();
    if (output === "pdf") downloadBlob(author ? await pdfWithMetadata(state.pdfBytes, title, author, state.pdfPassword ? state.pdf : null) : bytesToBlob(state.pdfBytes, "application/pdf"), `${title}.pdf`);
    else if (["jpeg", "png", "webp"].includes(output)) { const scale = +$("#pdf-direct-photo-quality").value, compression = scale <= 1 ? .8 : scale <= 1.5 ? .88 : scale <= 2 ? .93 : .97; await downloadPdfPhotos(state.pdf, title, output, scale, compression, true); }
    else { generatedBook = await pdfAsBook(state.pdfFile, true, state.pdfPassword, state.pdfBytes); if (!generatedBook.chapters.length) throw new Error("No visible text or artwork remains to convert."); generatedBook.title = title; generatedBook.author = author; await downloadBookArtifact(generatedBook, output, title); }
    status(`${output.toUpperCase()} downloaded`, 100, true);
  } catch (e) { if (e?.name === "AbortError") status("Save canceled", 100, true); else fail(e); } finally { generatedBook?.pdf?.destroy?.(); void schedulePdfBlanknessScan(state.pdf); }
});
function updatePdfResultPhotoOptions() {
  const isPhoto = ["jpeg", "png", "webp"].includes($("#pdf-result-format").value); $("#pdf-result-photo-options").classList.toggle("show", isPhoto);
}
$("#pdf-result-format").addEventListener("change", updatePdfResultPhotoOptions);
$("#pdf-result-download").addEventListener("click", async () => {
  let cleanPdf = null, generatedBook = null;
  try {
    const result = state.pdfResult; if (!result) throw new Error("Confirm the marked-page removal before exporting.");
    const output = $("#pdf-result-format").value, title = safeName($("#pdf-result-name").value, `${result.stem}-cleaned`), author = $("#pdf-result-author").value.trim();
    if (output === "pdf") downloadBlob(await pdfWithMetadata(result.bytes, title, author), `${title}.pdf`);
    else if (["jpeg", "png", "webp"].includes(output)) {
      const scale = +$("#pdf-result-photo-quality").value, compression = scale <= 1 ? .8 : scale <= 1.5 ? .88 : scale <= 2 ? .93 : .97;
      cleanPdf = await pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
      await downloadPdfPhotos(cleanPdf, title, output, scale, compression);
    } else {
      const file = new File([result.bytes], `${title}.pdf`, { type: "application/pdf" }); generatedBook = await pdfAsBook(file, true, "", result.bytes); if (!generatedBook.chapters.length) throw new Error("No visible text or artwork remains to convert."); generatedBook.title = title; generatedBook.author = author; await downloadBookArtifact(generatedBook, output, title);
    }
    status(`${output.toUpperCase()} export downloaded`, 100, true);
  } catch (e) { fail(e); } finally { cleanPdf?.destroy?.(); generatedBook?.pdf?.destroy?.(); }
});

async function waitForImages(root) { await Promise.all($$("img", root).map(img => img.complete ? img.decode?.().catch(() => {}) : new Promise(resolve => { img.onload = img.onerror = resolve; }))); }
async function makePrintPages(chapter) {
  const host = $("#render-host"), { doc, styles } = safeBookRenderDocument(chapter.html);
  const sourceNodes = [...doc.body.childNodes].filter(n => n.nodeType !== 3 || n.textContent.trim()); const pages = [];
  const newPage = () => { const mounted = mountIsolatedBookPage(host, "print-page", styles); mounted.page.pageforgeRenderShell = mounted.shell; pages.push(mounted.page); return mounted.page; };
  let page = newPage(), contentCount = 0;
  for (const original of sourceNodes) { const node = original.cloneNode(true); page.append(node); contentCount++; await waitForImages(node.nodeType === 1 ? node : page); if (page.scrollHeight > page.clientHeight && contentCount > 1) { node.remove(); page = newPage(); page.append(node); contentCount = 1; await waitForImages(page); } }
  return pages;
}
async function bookToPdf(book) {
  const pdf = await PDFDocument.create(); pdf.setTitle(book.title || "PageForge book"); if (book.author) pdf.setAuthor(book.author);
  const visibleToc = book.filterMode === "images" ? "" : buildVisibleTableOfContents(book.chapters);
  const chapters = visibleToc ? [{ title: "Contents", html: visibleToc, includeInToc: false }, ...book.chapters] : book.chapters;
  const total = chapters.length;
  for (let i = 0; i < total; i++) {
    status(`Typesetting section ${i + 1} of ${total}`, (i / total) * 88); const pages = await makePrintPages(chapters[i]); await tick();
    for (const element of pages) {
      try { const canvas = await html2canvas(element.pageforgeRenderShell || element, { backgroundColor: "#ffffff", scale: 1.35, logging: false, useCORS: false, imageTimeout: 0 }); const jpg = dataUrlToBytes(canvas.toDataURL("image/jpeg", .9)).bytes; const image = await pdf.embedJpg(jpg); const page = pdf.addPage([595.28, 841.89]); page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 }); }
      finally { (element.pageforgeRenderShell || element).remove(); }
    }
  }
  if (!pdf.getPageCount()) pdf.addPage([595.28, 841.89]); status("Finalizing PDF", 94); return bytesToBlob(await pdf.save({ useObjectStreams: true }), "application/pdf");
}
function xhtmlDocument(title, body) { return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><style>body{font-family:serif;line-height:1.55;margin:5%;}img{max-width:100%;height:auto;}svg{max-width:100%;}</style></head><body>${body}</body></html>`; }
async function buildEpub(book) {
  status("Packaging EPUB", 20); const zip = new JSZip(); zip.file("mimetype", "application/epub+zip", { compression: "STORE" }); zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const imageItems = [], chapterItems = []; let imageNo = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    const doc = new DOMParser().parseFromString(book.chapters[i].html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes, mime } = dataUrlToBytes(img.getAttribute("src")); const ext = extFromMime(mime); const name = `image-${++imageNo}.${ext}`; zip.file(`OEBPS/images/${name}`, bytes); img.setAttribute("src", `../images/${name}`); imageItems.push(`<item id="img${imageNo}" href="images/${name}" media-type="${mime}"/>`); }
    $$('script,iframe,object,embed', doc).forEach(x => x.remove()); const id = `ch${i + 1}`, name = `chapter-${i + 1}.xhtml`, label = chapterNavigationLabel(book.chapters[i], i); zip.file(`OEBPS/text/${name}`, xhtmlDocument(label, doc.body.innerHTML)); chapterItems.push(`<item id="${id}" href="text/${name}" media-type="application/xhtml+xml"/>`); status(`Packaging section ${i + 1} of ${book.chapters.length}`, 20 + (i / book.chapters.length) * 60); await tick();
  }
  const navLinks = buildNestedTocList(tableOfContentsEntries(book.chapters), entry => `text/chapter-${entry.index + 1}.xhtml`);
  const uid = `urn:uuid:${crypto.randomUUID()}`; zip.file("OEBPS/nav.xhtml", xhtmlDocument("Contents", `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>Contents</h1>${navLinks}</nav>`));
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${escapeHtml(book.title)}</dc:title><dc:creator>${escapeHtml(book.author || "")}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapterItems.join("")}${imageItems.join("")}</manifest><spine>${book.chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join("")}</spine></package>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE", compressionOptions: { level: 6 } }, p => status("Compressing EPUB", 80 + p.percent * .18));
}
function writeU16(view, at, value) { view.setUint16(at, value >>> 0, false); }
function writeU32(view, at, value) { view.setUint32(at, value >>> 0, false); }
function writeAscii(bytes, at, value, max = value.length) { for (let i = 0; i < Math.min(value.length, max); i++) bytes[at + i] = value.charCodeAt(i) & 255; }
function joinBytes(parts) { const length = parts.reduce((n, x) => n + x.length, 0), out = new Uint8Array(length); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; }
function exthRecord(type, value) { const data = typeof value === "number" ? (() => { const b = new Uint8Array(4); writeU32(new DataView(b.buffer), 0, value); return b; })() : enc.encode(value); const out = new Uint8Array(8 + data.length), v = new DataView(out.buffer); writeU32(v, 0, type); writeU32(v, 4, out.length); out.set(data, 8); return out; }
function makeExth(book) {
  const records = [exthRecord(503, book.title || "PageForge book"), exthRecord(524, "en")]; if (book.author) records.unshift(exthRecord(100, book.author));
  const rawLength = 12 + records.reduce((n, x) => n + x.length, 0), padded = (rawLength + 3) & ~3, out = new Uint8Array(padded), v = new DataView(out.buffer); writeAscii(out, 0, "EXTH"); writeU32(v, 4, padded); writeU32(v, 8, records.length); let at = 12; records.forEach(r => { out.set(r, at); at += r.length; }); return out;
}
function buildMobi(book) {
  status("Compiling classic MOBI", 20); const images = []; let imageNo = 0; const sections = [];
  for (let chapterNo = 0; chapterNo < book.chapters.length; chapterNo++) { const chapter = book.chapters[chapterNo];
    const doc = new DOMParser().parseFromString(chapter.html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes } = dataUrlToBytes(img.getAttribute("src")); images.push(bytes); img.removeAttribute("src"); img.setAttribute("recindex", String(++imageNo)); }
    $$('style,script,iframe,object,embed,svg', doc).forEach(x => x.remove()); sections.push(wrapMobiChapter(doc.body.innerHTML, `pf-chapter-${chapterNo + 1}`));
  }
  const body = composeLegacyBookBody({ chapters: book.chapters, sections, filterMode: book.filterMode, separator: "<mbp:pagebreak/>" });
  const html = `<html><head><title>${escapeHtml(book.title)}</title></head><body>${body}</body></html>`, text = enc.encode(html), chunks = []; for (let at = 0; at < text.length; at += 4096) chunks.push(text.slice(at, at + 4096)); if (!chunks.length) chunks.push(new Uint8Array());
  const exth = makeExth(book), titleBytes = enc.encode(book.title || "PageForge book"), record0 = new Uint8Array(248 + exth.length + titleBytes.length), rv = new DataView(record0.buffer), resourceStart = 1 + chunks.length;
  writeU16(rv, 0, 1); writeU32(rv, 4, text.length); writeU16(rv, 8, chunks.length); writeU16(rv, 10, 4096); writeU16(rv, 12, 0); writeAscii(record0, 16, "MOBI"); writeU32(rv, 20, 232); writeU32(rv, 24, 2); writeU32(rv, 28, 65001); writeU32(rv, 32, Math.floor(Date.now() / 1000)); writeU32(rv, 36, 6);
  [40, 44, 48, 52, 64, 68, 72, 112, 164, 244].forEach(at => writeU32(rv, at, 0xffffffff)); writeU32(rv, 84, 248 + exth.length); writeU32(rv, 88, titleBytes.length); writeU32(rv, 92, 0x00000409); writeU32(rv, 104, 6); writeU32(rv, 108, resourceStart); writeU32(rv, 128, 0x40); writeU32(rv, 240, 0); record0.set(exth, 248); record0.set(titleBytes, 248 + exth.length);
  const records = [record0, ...chunks, ...images], headerSize = 78 + records.length * 8 + 2, header = new Uint8Array(headerSize), hv = new DataView(header.buffer); writeAscii(header, 0, (book.title || "PageForge").slice(0, 31), 31); const palmTime = Math.floor(Date.now() / 1000) + 2082844800; writeU32(hv, 36, palmTime); writeU32(hv, 40, palmTime); writeAscii(header, 60, "BOOK"); writeAscii(header, 64, "MOBI"); writeU32(hv, 68, records.length + 1); writeU16(hv, 76, records.length); let offset = headerSize;
  records.forEach((record, i) => { writeU32(hv, 78 + i * 8, offset); header[78 + i * 8 + 4] = 0; header[78 + i * 8 + 5] = (i >>> 16) & 255; header[78 + i * 8 + 6] = (i >>> 8) & 255; header[78 + i * 8 + 7] = i & 255; offset += record.length; }); return joinBytes([header, ...records]);
}
function encodeVarLen(value) {
  value = Math.max(0, Number(value) >>> 0); const groups = [value & 0x7f]; value >>>= 7;
  while (value) { groups.unshift(value & 0x7f); value >>>= 7; }
  groups[groups.length - 1] |= 0x80; return Uint8Array.from(groups);
}
function makeTagx(tags, controlBytes = 1) {
  const out = new Uint8Array(12 + tags.length * 4), view = new DataView(out.buffer); writeAscii(out, 0, "TAGX"); writeU32(view, 4, out.length); writeU32(view, 8, controlBytes);
  tags.forEach((tag, i) => out.set(tag, 12 + i * 4)); return out;
}
function makeIndexMaster(tags, numRecords, totalEntries, controlBytes = 1) {
  const headerLength = 56, tagx = makeTagx(tags, controlBytes), out = new Uint8Array(headerLength + tagx.length), view = new DataView(out.buffer); writeAscii(out, 0, "INDX"); writeU32(view, 4, headerLength); writeU32(view, 8, 0); writeU32(view, 20, 0xffffffff); writeU32(view, 24, numRecords); writeU32(view, 28, 65001); writeU32(view, 32, 0x00000409); writeU32(view, 36, totalEntries); writeU32(view, 40, 0xffffffff); writeU32(view, 44, 0xffffffff); writeU32(view, 48, 0); writeU32(view, 52, 0); out.set(tagx, headerLength); return out;
}
function makeIndexRecord(entries, controlBytes = 1) {
  const encoded = entries.map(entry => {
    const name = enc.encode(entry.name), values = entry.values.map(encodeVarLen), length = 1 + name.length + controlBytes + values.reduce((n, x) => n + x.length, 0), out = new Uint8Array(length); let at = 0; out[at++] = name.length; out.set(name, at); at += name.length; out[at++] = entry.control; for (let i = 1; i < controlBytes; i++) out[at++] = 0; values.forEach(value => { out.set(value, at); at += value.length; }); return out;
  });
  const headerLength = 56, bodyLength = encoded.reduce((n, x) => n + x.length, 0), idxt = headerLength + bodyLength, out = new Uint8Array(idxt + 4 + entries.length * 2), view = new DataView(out.buffer); writeAscii(out, 0, "INDX"); writeU32(view, 4, headerLength); writeU32(view, 8, 1); writeU32(view, 20, idxt); writeU32(view, 24, entries.length); writeU32(view, 28, 65001); writeU32(view, 32, 0x00000409); writeU32(view, 52, 0); let at = headerLength; const offsets = [];
  encoded.forEach(entry => { offsets.push(at); out.set(entry, at); at += entry.length; }); writeAscii(out, idxt, "IDXT"); offsets.forEach((offset, i) => writeU16(view, idxt + 4 + i * 2, offset)); return out;
}
function makeFdst(length) { const out = new Uint8Array(20), view = new DataView(out.buffer); writeAscii(out, 0, "FDST"); writeU32(view, 4, 20); writeU32(view, 8, 1); writeU32(view, 12, 0); writeU32(view, 16, length); return out; }
function makePalmDatabase(title, records) {
  const headerSize = 78 + records.length * 8 + 2, header = new Uint8Array(headerSize), view = new DataView(header.buffer); writeAscii(header, 0, (title || "PageForge").slice(0, 31), 31); const palmTime = Math.floor(Date.now() / 1000) + 2082844800; writeU32(view, 36, palmTime); writeU32(view, 40, palmTime); writeAscii(header, 60, "BOOK"); writeAscii(header, 64, "MOBI"); writeU32(view, 68, records.length + 1); writeU16(view, 76, records.length); let offset = headerSize;
  records.forEach((record, i) => { writeU32(view, 78 + i * 8, offset); header[78 + i * 8 + 5] = (i >>> 16) & 255; header[78 + i * 8 + 6] = (i >>> 8) & 255; header[78 + i * 8 + 7] = i & 255; offset += record.length; }); return joinBytes([header, ...records]);
}
function buildAzw3(book) {
  status("Compiling Kindle Format 8", 20); const images = [], sections = []; let imageNo = 0;
  for (let chapterNo = 0; chapterNo < book.chapters.length; chapterNo++) { const chapter = book.chapters[chapterNo];
    const doc = new DOMParser().parseFromString(chapter.html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes, mime } = dataUrlToBytes(img.getAttribute("src")); images.push(bytes); const id = (++imageNo).toString(36).toUpperCase().padStart(4, "0"); img.setAttribute("src", `kindle:embed:${id}?mime=${mime}`); }
    $$('style,script,iframe,object,embed,svg', doc).forEach(x => x.remove()); sections.push(wrapKf8Chapter(doc.body.innerHTML, `pf-chapter-${chapterNo + 1}`));
  }
  const body = composeLegacyBookBody({ chapters: book.chapters, sections, filterMode: book.filterMode, tocSeparator: '<div style="page-break-after:always"></div>' });
  const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeHtml(book.title)}</title></head><body>${body}</body></html>`, text = enc.encode(html), chunks = []; for (let at = 0; at < text.length; at += 4096) chunks.push(text.slice(at, at + 4096)); if (!chunks.length) chunks.push(new Uint8Array());
  const fdstIndex = 1 + chunks.length, skelIndex = fdstIndex + 1, fragIndex = skelIndex + 2, resourceStart = fragIndex + 1;
  const fdst = makeFdst(text.length), skelMaster = makeIndexMaster([[1, 1, 1, 0], [6, 2, 2, 0]], 1, 1), skelData = makeIndexRecord([{ name: "skel00000000", control: 3, values: [0, 0, text.length] }]), fragMaster = makeIndexMaster([[2, 1, 1, 0], [4, 1, 2, 0], [6, 2, 4, 0]], 0, 0);
  const exth = makeExth(book), titleBytes = enc.encode(book.title || "PageForge book"), record0 = new Uint8Array(264 + exth.length + titleBytes.length), view = new DataView(record0.buffer); writeU16(view, 0, 1); writeU32(view, 4, text.length); writeU16(view, 8, chunks.length); writeU16(view, 10, 4096); writeU16(view, 12, 0); writeAscii(record0, 16, "MOBI"); writeU32(view, 20, 248); writeU32(view, 24, 2); writeU32(view, 28, 65001); writeU32(view, 32, Math.floor(Date.now() / 1000)); writeU32(view, 36, 8);
  [40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 112, 116, 164, 168, 172, 176, 180, 184, 188, 200, 204, 208, 212, 216, 220, 224, 228, 232, 236, 244, 256, 260].forEach(at => writeU32(view, at, 0xffffffff)); writeU32(view, 84, 264 + exth.length); writeU32(view, 88, titleBytes.length); writeU32(view, 92, 0x00000409); writeU32(view, 104, 8); writeU32(view, 108, resourceStart); writeU32(view, 128, 0x40); writeU32(view, 192, fdstIndex); writeU32(view, 196, 1); writeU32(view, 240, 0); writeU32(view, 248, fragIndex); writeU32(view, 252, skelIndex); record0.set(exth, 264); record0.set(titleBytes, 264 + exth.length);
  return makePalmDatabase(book.title || "PageForge", [record0, ...chunks, fdst, skelMaster, skelData, fragMaster, ...images]);
}
function formatBytes(size) { if (size < 1024) return `${size} B`; if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`; return `${(size / 1048576).toFixed(1)} MB`; }

window.addEventListener("offline", () => $("#network-proof").textContent = "Connection off · fully operational");
if (!navigator.onLine) $("#network-proof").textContent = "Connection off · fully operational";
window.__pageforgeTest = { parseRange, buildMobi, buildAzw3, buildEpub, filterHtml, version: "3.0" };
