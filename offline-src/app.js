import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import JSZip from "jszip";
import html2canvas from "html2canvas";
import { initMobiFile, initKf8File } from "@lingo-reader/mobi-parser";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const enc = new TextEncoder();
const state = { photos: [], pdfFile: null, pdfBytes: null, pdf: null, pdfPending: null, pdfPassword: "", pdfBlankness: new Map(), bookFile: null, book: null, bookPending: null, bookPassword: "" };
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
const safeName = (name, fallback = "pageforge") => (name || fallback).trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 100) || fallback;
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

// Photos → PDF
wireDrop($("#photo-drop"), $("#photo-input"), addPhotos);
function addPhotos(files) {
  const incoming = files.filter(f => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
  if (!incoming.length) return fail(new Error("Choose image files such as JPEG, PNG, WebP, GIF, or BMP."));
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
    $(".remove", card).onclick = () => { URL.revokeObjectURL(item.url); state.photos = state.photos.filter(x => x !== item); renderPhotos(); };
    cards.append(card);
  });
  $("#photo-queue").classList.toggle("show", !!state.photos.length);
  $("#photo-count").textContent = `${state.photos.length} photo${state.photos.length === 1 ? "" : "s"}`;
  $("#photos-convert").disabled = !state.photos.length;
}
$("#photo-clear").addEventListener("click", () => {
  state.photos.forEach(x => URL.revokeObjectURL(x.url));
  state.photos = [];
  renderPhotos();
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
wireDrop($("#pdf-drop"), $("#pdf-input"), files => loadPdf(files[0]));
async function loadPdf(file, password = "", existingBytes = null) {
  if (!file || !(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) return fail(new Error("Choose a PDF file."));
  try {
    status(password ? "Unlocking PDF locally" : "Reading PDF locally", 8); const bytes = existingBytes || new Uint8Array(await file.arrayBuffer());
    const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined }); const pdf = await task.promise;
    state.pdfFile = file; state.pdfBytes = bytes; state.pdf = pdf; state.pdfPending = null; state.pdfPassword = password; state.pdfBlankness.clear();
    $("#pdf-password-box").classList.remove("show"); $("#pdf-password").value = "";
    $("#pdf-drop").style.display = "none"; $("#pdf-queue").classList.add("show"); $("#pdf-count").textContent = `${pdf.numPages} pages · ${formatBytes(file.size)}`;
    ["#pdf-to-images", "#pdf-delete", "#pdf-analyze", "#pdf-threshold-uncheck", "#pdf-auto-blank", "#pdf-delete-unchecked"].forEach(id => $(id).disabled = false);
    renderPdfPlaceholders(); status("PDF ready · every page is kept until you untick it", 100, true);
  } catch (e) {
    if (isPasswordError(e)) {
      const bytes = existingBytes || new Uint8Array(await file.arrayBuffer()); state.pdfPending = { file, bytes }; state.pdfFile = file;
      $("#pdf-drop").style.display = "none"; $("#pdf-queue").classList.add("show"); $("#pdf-pages").textContent = ""; $("#pdf-count").textContent = `Locked · ${file.name}`; $("#pdf-password-box").classList.add("show");
      status(password ? "Incorrect password — try again" : "Password required", 100, true); setTimeout(() => $("#pdf-password").focus(), 50); return;
    }
    fail(new Error(`Could not open PDF: ${e.message}`));
  }
}
$("#pdf-unlock").addEventListener("click", () => { if (state.pdfPending) loadPdf(state.pdfPending.file, $("#pdf-password").value, state.pdfPending.bytes); });
$("#pdf-password").addEventListener("keydown", e => { if (e.key === "Enter") $("#pdf-unlock").click(); });
$("#pdf-reset").addEventListener("click", () => {
  thumbObserver?.disconnect();
  state.pdf?.destroy?.();
  state.pdfFile = state.pdfBytes = state.pdf = state.pdfPending = null; state.pdfPassword = ""; state.pdfBlankness.clear();
  $("#pdf-pages").textContent = "";
  $("#pdf-queue").classList.remove("show");
  $("#pdf-drop").style.display = "flex";
  $("#pdf-password-box").classList.remove("show"); $("#pdf-password").value = "";
  ["#pdf-to-images", "#pdf-delete", "#pdf-analyze", "#pdf-threshold-uncheck", "#pdf-auto-blank", "#pdf-delete-unchecked"].forEach(id => $(id).disabled = true);
});
let thumbObserver;
function renderPdfPlaceholders() {
  const host = $("#pdf-pages"); host.textContent = ""; thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(entries => entries.filter(x => x.isIntersecting).forEach(x => { thumbObserver.unobserve(x.target); renderPdfThumb(x.target); }), { rootMargin: "500px" });
  for (let n = 1; n <= state.pdf.numPages; n++) {
    const card = document.createElement("div"); card.className = "card"; card.dataset.page = n;
    card.innerHTML = `<div class="thumb"><span class="page-no">PAGE ${n}</span></div><div class="card-meta"><span class="filename">Page ${n}</span><span class="page-no">PDF</span></div><label class="page-keep"><input class="page-keep-check" type="checkbox" checked aria-label="Keep page ${n}"><span>Keep page</span></label><div class="blank-score">Not analyzed</div>`;
    $(".page-keep-check", card).addEventListener("change", e => card.classList.toggle("page-removed", !e.target.checked));
    host.append(card); thumbObserver.observe(card);
  }
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
  const page = await state.pdf.getPage(pageNo), base = page.getViewport({ scale: 1 }), scale = Math.min(.45, 420 / Math.max(base.width, base.height)), viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx, viewport, canvas }).promise; page.cleanup();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let blank = 0, total = 0;
  for (let i = 0; i < pixels.length; i += 16) { total++; if (pixels[i + 3] < 12 || (pixels[i] >= 245 && pixels[i + 1] >= 245 && pixels[i + 2] >= 245)) blank++; }
  const score = total ? blank / total * 100 : 100; state.pdfBlankness.set(pageNo, score);
  const label = $(`.card[data-page="${pageNo}"] .blank-score`, $("#pdf-pages")); if (label) label.textContent = `${score.toFixed(1)}% blank`;
  return score;
}
async function analyzePdfBlankness() {
  if (!state.pdf) throw new Error("Choose a PDF first.");
  const scores = [];
  for (let pageNo = 1; pageNo <= state.pdf.numPages; pageNo++) { status(`Analyzing blank space · page ${pageNo} of ${state.pdf.numPages}`, 5 + pageNo / state.pdf.numPages * 90); scores.push(await getPageBlankness(pageNo)); await tick(); }
  status("Blank-space analysis complete", 100, true); return scores;
}
function setPageKept(pageNo, kept) {
  const card = $(`.card[data-page="${pageNo}"]`, $("#pdf-pages")), check = card && $(".page-keep-check", card); if (!check) return;
  check.checked = kept; card.classList.toggle("page-removed", !kept);
}
function uncheckedPdfPages() { return new Set($$(".card", $("#pdf-pages")).filter(card => !$(".page-keep-check", card).checked).map(card => +card.dataset.page)); }
async function downloadPdfWithDeleted(deleted) {
  if (!deleted.size) throw new Error("No pages are marked for deletion. Enter a range or untick one or more page cards.");
  if (deleted.size === state.pdf.numPages) throw new Error("A PDF needs at least one page. Keep one or more pages.");
  status("Rebuilding PDF without the marked pages", 25); const keep = Array.from({ length: state.pdf.numPages }, (_, i) => i + 1).filter(n => !deleted.has(n)); let bytes, flattened = false;
  try {
    if (state.pdfPassword) throw new Error("Protected document requires flattening");
    const src = await PDFDocument.load(state.pdfBytes.slice(), { ignoreEncryption: false }), out = await PDFDocument.create(), copied = await out.copyPages(src, keep.map(n => n - 1)); copied.forEach(p => out.addPage(p)); bytes = await out.save({ useObjectStreams: true });
  } catch { bytes = await flattenPdfPages(state.pdf, keep); flattened = true; }
  const stem = safeName(state.pdfFile.name.replace(/\.pdf$/i, "")); downloadBlob(bytesToBlob(bytes, "application/pdf"), `${stem}-pages-removed.pdf`); status(`${deleted.size} page${deleted.size === 1 ? "" : "s"} removed${flattened ? " · secured PDF flattened" : ""}`, 100, true);
}
$("#pdf-to-images").addEventListener("click", async () => {
  try {
    const pages = parseRange($("#pdf-export-range").value, state.pdf.numPages, true), type = $("#pdf-image-format").value, scale = +$("#pdf-scale").value, streamFolder = $("#pdf-photo-save").value === "auto" && canStreamFolder() && pages.length > 1;
    if (!pages.length) throw new Error("That range contains no pages.");
    const stem = safeName(state.pdfFile.name.replace(/\.pdf$/i, "")), ext = type === "jpeg" ? "jpg" : type;
    if (streamFolder) {
      const directory = await window.showDirectoryPicker({ mode: "readwrite" });
      for (let i = 0; i < pages.length; i++) { status(`Streaming page ${i + 1} of ${pages.length} to folder`, (i / pages.length) * 94); await tick(); const blob = await renderPdfPage(state.pdf, pages[i], scale, type); const handle = await directory.getFileHandle(`${stem}-page-${String(pages[i]).padStart(4, "0")}.${ext}`, { create: true }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); }
      status("Photos saved to folder", 100, true); return;
    }
    if (pages.length === 1) { status("Rendering page", 35); const blob = await renderPdfPage(state.pdf, pages[0], scale, type); downloadBlob(blob, `${stem}-page-${pages[0]}.${ext}`); }
    else { const zip = new JSZip(); for (let i = 0; i < pages.length; i++) { status(`Rendering page ${i + 1} of ${pages.length}`, (i / pages.length) * 88); await tick(); const blob = await renderPdfPage(state.pdf, pages[i], scale, type); zip.file(`${stem}-page-${String(pages[i]).padStart(4, "0")}.${type === "jpeg" ? "jpg" : type}`, blob); } status("Packing photo archive", 92); downloadBlob(await zip.generateAsync({ type: "blob", compression: "STORE" }), `${stem}-photos.zip`); }
    status("Photos downloaded", 100, true);
  } catch (e) { if (e?.name === "AbortError") status("Save canceled", 100, true); else fail(e); }
});
$("#pdf-delete").addEventListener("click", async () => {
  try { await downloadPdfWithDeleted(new Set(parseRange($("#pdf-delete-range").value, state.pdf.numPages))); } catch (e) { fail(e); }
});
$("#pdf-analyze").addEventListener("click", () => analyzePdfBlankness().catch(fail));
$("#pdf-threshold-uncheck").addEventListener("click", async () => {
  try {
    const threshold = +$("#pdf-blank-threshold").value; if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Blank threshold must be between 0 and 100%.");
    const scores = await analyzePdfBlankness(); scores.forEach((score, i) => setPageKept(i + 1, score < threshold)); status(`Pages at least ${threshold}% blank are unticked · review the page cards`, 100, true);
  } catch (e) { fail(e); }
});
$("#pdf-auto-blank").addEventListener("click", async () => {
  try { const scores = await analyzePdfBlankness(), deleted = new Set(scores.map((score, i) => score >= 99.5 ? i + 1 : 0).filter(Boolean)); await downloadPdfWithDeleted(deleted); } catch (e) { fail(e); }
});
$("#pdf-delete-unchecked").addEventListener("click", async () => { try { await downloadPdfWithDeleted(uncheckedPdfPages()); } catch (e) { fail(e); } });

// EPUB / MOBI / PDF conversion
wireDrop($("#book-drop"), $("#book-input"), files => loadBook(files[0]));
async function loadBook(file, password = "") {
  if (!file || !/\.(epub|mobi|azw3?|azm3|pdf)$/i.test(file.name)) return fail(new Error("Choose a PDF, EPUB, MOBI, AZW, AZW3, or AZM3 file."));
  try {
    status("Opening book locally", 8); state.bookFile = file; const type = file.name.toLowerCase().split(".").pop();
    let book;
    if (type === "epub") book = await parseEpub(file);
    else if (type === "pdf") book = await pdfAsBook(file, false, password);
    else book = await parseMobi(file);
    state.book = book; state.bookPending = null; state.bookPassword = password; $("#book-password-box").classList.remove("show"); $("#book-password").value = ""; $("#book-drop").style.display = "none"; $("#book-summary").classList.add("show"); $("#book-title").textContent = book.title || file.name; $("#book-meta").textContent = `${book.chapters?.length || book.pageCount || 0} ${book.pageCount ? "pages" : "sections"} · ${book.assets?.length || (book.sourceType === "pdf" ? book.pageCount : 0)} visuals · ${formatBytes(file.size)}${book.author ? ` · ${book.author}` : ""}`; $("#book-type").textContent = book.sourceType.toUpperCase(); $("#book-name").value = book.title || file.name.replace(/\.[^.]+$/, ""); $("#book-author").value = book.author || ""; $("#book-convert").disabled = false; status("Book ready", 100, true);
  } catch (e) {
    if (file.name.toLowerCase().endsWith(".pdf") && isPasswordError(e)) {
      state.book = null; state.bookPending = { file }; state.bookFile = file;
      $("#book-drop").style.display = "none"; $("#book-summary").classList.add("show"); $("#book-title").textContent = file.name; $("#book-meta").textContent = "Locked PDF · enter its password to continue"; $("#book-type").textContent = "LOCKED";
      $("#book-password-box").classList.add("show"); $("#book-convert").disabled = true;
      status(password ? "Incorrect password — try again" : "Password required for this PDF", 100, true); setTimeout(() => $("#book-password").focus(), 50); return;
    }
    state.book = null; fail(new Error(`Could not open this book. ${e.message}`));
  }
}
$("#book-unlock").addEventListener("click", () => { if (state.bookPending) loadBook(state.bookPending.file, $("#book-password").value); });
$("#book-password").addEventListener("keydown", e => { if (e.key === "Enter") $("#book-unlock").click(); });
$("#book-reset").addEventListener("click", () => {
  state.book?.pdf?.destroy?.();
  state.bookFile = state.book = state.bookPending = null; state.bookPassword = "";
  $("#book-summary").classList.remove("show");
  $("#book-drop").style.display = "flex";
  $("#book-password-box").classList.remove("show"); $("#book-password").value = "";
  $("#book-convert").disabled = true;
  $("#book-name").value = $("#book-author").value = "";
});
async function zipAssetData(zip, path, assets) {
  const clean = normalizePath(decodeURIComponent(path.split("#")[0])), entry = zip.file(clean); if (!entry) return null;
  const data = await blobToDataURL(new Blob([await entry.async("blob")], { type: mimeFromPath(clean) })); if (data.startsWith("data:image/")) assets.add(data); return data;
}
async function inlineCssResources(css, cssPath, zip, assets) {
  css = css.replace(/@import[^;]+;/gi, ""); const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi; let out = "", at = 0, match;
  while ((match = re.exec(css))) {
    out += css.slice(at, match.index); const raw = match[2].trim(); let replacement = "none";
    if (/^data:/i.test(raw)) { replacement = `url("${raw}")`; if (/^data:image\//i.test(raw)) assets.add(raw); }
    else if (!/^(https?:|\/\/|#)/i.test(raw)) { const data = await zipAssetData(zip, dirname(cssPath) + raw, assets); if (data) replacement = `url("${data}")`; }
    out += replacement; at = re.lastIndex;
  }
  return out + css.slice(at);
}
async function inlineEpubChapter(html, chapterPath, zip, assets) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const source of $$("source[srcset]", doc)) {
    const candidates = source.getAttribute("srcset").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean), picture = source.closest("picture"), img = picture?.querySelector("img");
    for (const raw of candidates) if (!/^data:/i.test(raw) && !/^(https?:)?\/\//i.test(raw)) await zipAssetData(zip, dirname(chapterPath) + raw, assets);
    if (img && candidates[0]) img.setAttribute("src", candidates[0]);
  }
  for (const img of $$("img[srcset]", doc)) {
    const candidates = img.getAttribute("srcset").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
    for (const raw of candidates) if (!/^data:/i.test(raw) && !/^(https?:)?\/\//i.test(raw)) await zipAssetData(zip, dirname(chapterPath) + raw, assets);
    if (candidates[0]) img.setAttribute("src", candidates[0]);
  }
  for (const link of $$("link[rel~='stylesheet'][href]", doc)) { const cssPath = normalizePath(dirname(chapterPath) + link.getAttribute("href").split("#")[0]), css = await zip.file(cssPath)?.async("text"); if (css) { const style = doc.createElement("style"); style.textContent = await inlineCssResources(css, cssPath, zip, assets); link.replaceWith(style); } else link.remove(); }
  for (const style of $$("style", doc)) style.textContent = await inlineCssResources(style.textContent, chapterPath, zip, assets);
  for (const node of $$("[style*='url(']", doc)) node.setAttribute("style", await inlineCssResources(node.getAttribute("style"), chapterPath, zip, assets));
  for (const node of $$("img,image,video[poster],object[data]", doc)) {
    const attr = node.hasAttribute("src") ? "src" : node.hasAttribute("poster") ? "poster" : node.hasAttribute("data") ? "data" : node.hasAttribute("href") ? "href" : node.hasAttribute("xlink:href") ? "xlink:href" : ""; const raw = attr && node.getAttribute(attr); if (!raw) continue;
    if (/^data:/i.test(raw)) { if (/^data:image\//i.test(raw)) assets.add(raw); continue; }
    if (/^(https?:)?\/\//i.test(raw)) { node.remove(); continue; }
    const data = await zipAssetData(zip, dirname(chapterPath) + raw, assets); if (data) node.setAttribute(attr, data); else node.removeAttribute(attr);
  }
  for (const svg of $$("svg", doc)) { const data = await blobToDataURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" })); assets.add(data); const img = doc.createElement("img"); img.src = data; img.alt = svg.getAttribute("aria-label") || "SVG artwork"; svg.replaceWith(img); }
  $$('script,iframe,object,embed,link,source', doc).forEach(x => x.remove());
  const styles = $$("style", doc.head).map(x => x.outerHTML).join(""); return styles + doc.body.innerHTML;
}
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file), container = await zip.file("META-INF/container.xml")?.async("text"); if (!container) throw new Error("EPUB container.xml is missing.");
  const cdoc = new DOMParser().parseFromString(container, "application/xml"), opfPath = cdoc.querySelector("rootfile")?.getAttribute("full-path"); if (!opfPath) throw new Error("EPUB package path is missing.");
  const opfText = await zip.file(opfPath)?.async("text"), opf = new DOMParser().parseFromString(opfText, "application/xml"), base = dirname(opfPath), manifest = new Map($$("manifest item", opf).map(x => [x.getAttribute("id"), { id: x.getAttribute("id"), href: normalizePath(base + x.getAttribute("href")), type: x.getAttribute("media-type") || "", properties: x.getAttribute("properties") || "" }]));
  const title = opf.querySelector("metadata title, metadata dc\\:title")?.textContent?.trim() || file.name.replace(/\.epub$/i, ""), author = opf.querySelector("metadata creator, metadata dc\\:creator")?.textContent?.trim() || "", chapters = [], assets = new Set(), refs = $$("spine itemref", opf);
  for (let i = 0; i < refs.length; i++) { status(`Reading EPUB section ${i + 1} of ${refs.length}`, 10 + (i / Math.max(1, refs.length)) * 75); const item = manifest.get(refs[i].getAttribute("idref")); if (!item) continue; const chapter = await zip.file(item.href)?.async("text"); if (!chapter) continue; chapters.push({ title: `Section ${i + 1}`, html: await inlineEpubChapter(chapter, item.href, zip, assets) }); await tick(); }
  // Inventory every packaged image, including unreferenced plates and covers outside the spine.
  for (const item of manifest.values()) if (item.type.startsWith("image/") || mimeFromPath(item.href).startsWith("image/")) await zipAssetData(zip, item.href, assets);
  const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute("content"), guideHref = opf.querySelector('guide reference[type~="cover"]')?.getAttribute("href"), cover = [...manifest.values()].find(x => x.properties.split(/\s+/).includes("cover-image")) || manifest.get(coverId) || [...manifest.values()].find(x => /cover/i.test(x.id || "") && x.type.startsWith("image/"));
  const coverPath = cover?.href || (guideHref ? normalizePath(base + guideHref) : "");
  if (coverPath && mimeFromPath(coverPath).startsWith("image/")) { const data = await zipAssetData(zip, coverPath, assets); if (data && !chapters.some(ch => ch.html.includes(data))) chapters.unshift({ title: "Cover", html: `<div style="text-align:center"><img alt="Cover" src="${data}"></div>` }); }
  else if (coverPath) { const coverMarkup = await zip.file(coverPath)?.async("text"); if (coverMarkup) chapters.unshift({ title: "Cover", html: await inlineEpubChapter(coverMarkup, coverPath, zip, assets) }); }
  if (!chapters.length) throw new Error("No readable EPUB chapters were found."); return { sourceType: "epub", title, author, chapters, assets: [...assets] };
}
async function parseMobi(file) {
  let mobi; const sourceExt = file.name.toLowerCase().split(".").pop(), preferKf8 = sourceExt === "azw3" || sourceExt === "azm3";
  try { mobi = preferKf8 ? await initKf8File(file) : await initMobiFile(file); } catch { mobi = preferKf8 ? await initMobiFile(file) : await initKf8File(file); }
  const meta = mobi.getMetadata(), spine = mobi.getSpine(), chapters = [], assets = new Set();
  for (let i = 0; i < spine.length; i++) { status(`Reading MOBI section ${i + 1} of ${spine.length}`, 10 + (i / Math.max(1, spine.length)) * 75); const loaded = mobi.loadChapter(spine[i].id); if (!loaded) continue; let html = loaded.html; for (const css of loaded.css || []) { try { html = `<style>${await (await realFetch(css.href)).text()}</style>` + html; } catch {} } html = await inlineBlobImages(html, assets); chapters.push({ title: `Section ${i + 1}`, html }); await tick(); }
  const cover = mobi.getCoverImage?.(); if (cover) { try { const data = await blobToDataURL(await (await realFetch(cover)).blob()); assets.add(data); if (!chapters.some(ch => ch.html.includes(data))) chapters.unshift({ title: "Cover", html: `<img alt="Cover" src="${data}">` }); } catch {} }
  mobi.destroy(); if (!chapters.length) throw new Error("No readable MOBI/KF8 sections were found."); return { sourceType: sourceExt === "azm3" ? "azm3" : preferKf8 ? "azw3" : "mobi", title: meta.title || file.name.replace(/\.[^.]+$/, ""), author: (meta.author || []).join(", "), chapters, assets: [...assets] };
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
  const bytes = existingBytes || new Uint8Array(await file.arrayBuffer()), pdf = await pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined }).promise; const book = { sourceType: "pdf", title: file.name.replace(/\.pdf$/i, ""), author: "", pageCount: pdf.numPages, pdf, chapters: [], bytes, password, assets: [] };
  if (renderPages) for (let i = 1; i <= pdf.numPages; i++) {
    status(`Extracting text and artwork from PDF page ${i} of ${pdf.numPages}`, 8 + (i / pdf.numPages) * 80);
    const page = await pdf.getPage(i), content = await page.getTextContent(), operators = await page.getOperatorList(), lines = []; let line = [];
    for (const item of content.items || []) { const value = String(item.str || "").trim(); if (value) line.push(value); if (item.hasEOL && line.length) { lines.push(line.join(" ")); line = []; } }
    if (line.length) lines.push(line.join(" "));
    const imageOps = new Set([pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintImageMaskXObject].filter(Number.isFinite)), hasRasterArt = operators.fnArray.some(op => imageOps.has(op)), pageKind = hasRasterArt ? "content" : lines.length ? "text-only" : "blank"; page.cleanup();
    const blob = await renderPdfPage(pdf, i, 1.45, "jpeg", .88), data = await blobToDataURL(blob), textHtml = lines.length ? `<div class="pdf-page-text">${lines.map(value => `<p>${escapeHtml(value)}</p>`).join("")}</div>` : "";
    if (hasRasterArt) book.assets.push(data); book.chapters.push({ title: `Page ${i}`, html: `${textHtml}<div class="pdf-page-art" style="text-align:center"><img data-page-render="${pageKind}" alt="Rendered PDF page ${i}" src="${data}"></div>` }); await tick();
  }
  return book;
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
    if (missing.length) chapters.push({ title: "Recovered artwork", html: missing.map((src, i) => `<div style="text-align:center;margin:0 0 24px"><img alt="Recovered artwork ${i + 1}" src="${src}"></div>`).join("") });
  }
  return { ...book, chapters };
}

if (!canStreamFile()) $("#photo-engine-note").textContent = "This browser does not expose direct disk streaming. PageForge will use universal memory mode; Chrome or Edge can write progressively to disk on Windows and macOS.";
$("#book-convert").addEventListener("click", async () => {
  try {
    let book = state.book; if (book.sourceType === "pdf" && !book.chapters.length) book = await pdfAsBook(state.bookFile, true, book.password || state.bookPassword, book.bytes);
    const title = safeName($("#book-name").value, book.title || "pageforge-book"), author = $("#book-author").value.trim(), mode = $("#book-filter").value, output = $("#book-output").value;
    const filtered = { ...filteredBook(book, mode), title, author };
    if (!filtered.chapters.length) throw new Error("No non-empty sections remain after applying that filter.");
    if (mode === "images" && !filtered.chapters.some(ch => hasVisualContent(ch.html))) throw new Error("No visual assets were found after checking covers, SVGs, responsive images, and CSS backgrounds.");
    if (mode === "text" && !filtered.chapters.some(ch => hasTextContent(ch.html))) throw new Error("No extractable text was found. This book may contain scanned page images only; choose Photos only instead.");
    if (output === "pdf") downloadBlob(await bookToPdf(filtered), `${title}.pdf`);
    else if (output === "epub") {
      const epub = await buildEpub(filtered);
      const check = await JSZip.loadAsync(epub);
      if (!check.file("META-INF/container.xml")) throw new Error("EPUB package verification failed.");
      downloadBlob(epub, `${title}.epub`);
    } else if (output === "mobi") {
      const mobiBytes = buildMobi(filtered);
      const check = await initMobiFile(new File([mobiBytes], `${title}.mobi`, { type: "application/x-mobipocket-ebook" }));
      if (!check.getSpine().length) throw new Error("MOBI package verification failed.");
      check.destroy();
      downloadBlob(bytesToBlob(mobiBytes, "application/x-mobipocket-ebook"), `${title}.mobi`);
    } else {
      const azwBytes = buildAzw3(filtered), extension = output === "azm3" ? "azm3" : "azw3";
      const check = await initKf8File(new File([azwBytes], `${title}.${extension}`, { type: "application/vnd.amazon.ebook" }));
      const first = check.getSpine()[0]; if (!first || !check.loadChapter(first.id)?.html) throw new Error("KF8 package verification failed.");
      check.destroy(); downloadBlob(bytesToBlob(azwBytes, "application/vnd.amazon.ebook"), `${title}.${extension}`);
    }
    status(`${output.toUpperCase()} downloaded`, 100, true);
  } catch (e) { fail(e); }
});

async function waitForImages(root) { await Promise.all($$("img", root).map(img => img.complete ? img.decode?.().catch(() => {}) : new Promise(resolve => { img.onload = img.onerror = resolve; }))); }
async function makePrintPages(chapter, index) {
  const host = $("#render-host"), doc = new DOMParser().parseFromString(chapter.html, "text/html"), styles = $$("style", doc).map(x => x.cloneNode(true)); $$('script,iframe,object,embed', doc).forEach(x => x.remove());
  const sourceNodes = [...doc.body.childNodes].filter(n => n.nodeType !== 3 || n.textContent.trim()); const pages = [];
  const newPage = () => { const p = document.createElement("div"); p.className = "print-page"; styles.forEach(s => p.append(s.cloneNode(true))); host.append(p); pages.push(p); return p; };
  let page = newPage(), contentCount = 0;
  if (index === 0 && chapter.title) { const h = document.createElement("h1"); h.textContent = chapter.title; page.append(h); contentCount++; }
  for (const original of sourceNodes) { const node = original.cloneNode(true); page.append(node); contentCount++; await waitForImages(node.nodeType === 1 ? node : page); if (page.scrollHeight > page.clientHeight && contentCount > 1) { node.remove(); page = newPage(); page.append(node); contentCount = 1; await waitForImages(page); } }
  return pages;
}
async function bookToPdf(book) {
  const pdf = await PDFDocument.create(); const total = book.chapters.length;
  for (let i = 0; i < total; i++) {
    status(`Typesetting section ${i + 1} of ${total}`, (i / total) * 88); const pages = await makePrintPages(book.chapters[i], i); await tick();
    for (const element of pages) { const canvas = await html2canvas(element, { backgroundColor: "#ffffff", scale: 1.35, logging: false, useCORS: false, imageTimeout: 0 }); const jpg = dataUrlToBytes(canvas.toDataURL("image/jpeg", .9)).bytes; const image = await pdf.embedJpg(jpg); const page = pdf.addPage([595.28, 841.89]); page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 }); element.remove(); }
  }
  if (!pdf.getPageCount()) pdf.addPage([595.28, 841.89]); status("Finalizing PDF", 94); return bytesToBlob(await pdf.save({ useObjectStreams: true }), "application/pdf");
}
function xhtmlDocument(title, body) { return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><style>body{font-family:serif;line-height:1.55;margin:5%;}img{max-width:100%;height:auto;}svg{max-width:100%;}</style></head><body>${body}</body></html>`; }
async function buildEpub(book) {
  status("Packaging EPUB", 20); const zip = new JSZip(); zip.file("mimetype", "application/epub+zip", { compression: "STORE" }); zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const imageItems = [], chapterItems = [], navLinks = []; let imageNo = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    const doc = new DOMParser().parseFromString(book.chapters[i].html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes, mime } = dataUrlToBytes(img.getAttribute("src")); const ext = extFromMime(mime); const name = `image-${++imageNo}.${ext}`; zip.file(`OEBPS/images/${name}`, bytes); img.setAttribute("src", `../images/${name}`); imageItems.push(`<item id="img${imageNo}" href="images/${name}" media-type="${mime}"/>`); }
    $$('script,iframe,object,embed', doc).forEach(x => x.remove()); const id = `ch${i + 1}`, name = `chapter-${i + 1}.xhtml`; zip.file(`OEBPS/text/${name}`, xhtmlDocument(book.chapters[i].title || `Section ${i + 1}`, doc.body.innerHTML)); chapterItems.push(`<item id="${id}" href="text/${name}" media-type="application/xhtml+xml"/>`); navLinks.push(`<li><a href="text/${name}">${escapeHtml(book.chapters[i].title || `Section ${i + 1}`)}</a></li>`); status(`Packaging section ${i + 1} of ${book.chapters.length}`, 20 + (i / book.chapters.length) * 60); await tick();
  }
  const uid = `urn:uuid:${crypto.randomUUID()}`; zip.file("OEBPS/nav.xhtml", xhtmlDocument("Contents", `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>Contents</h1><ol>${navLinks.join("")}</ol></nav>`));
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
  for (const chapter of book.chapters) {
    const doc = new DOMParser().parseFromString(chapter.html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes } = dataUrlToBytes(img.getAttribute("src")); images.push(bytes); img.removeAttribute("src"); img.setAttribute("recindex", String(++imageNo)); }
    $$('style,script,iframe,object,embed,svg', doc).forEach(x => x.remove()); sections.push(`<h2>${escapeHtml(chapter.title || "")}</h2>${doc.body.innerHTML}`);
  }
  const html = `<html><head><title>${escapeHtml(book.title)}</title></head><body>${sections.join("<mbp:pagebreak/>")}</body></html>`, text = enc.encode(html), chunks = []; for (let at = 0; at < text.length; at += 4096) chunks.push(text.slice(at, at + 4096)); if (!chunks.length) chunks.push(new Uint8Array());
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
  for (const chapter of book.chapters) {
    const doc = new DOMParser().parseFromString(chapter.html, "text/html");
    for (const img of $$("img[src^='data:']", doc)) { const { bytes, mime } = dataUrlToBytes(img.getAttribute("src")); images.push(bytes); const id = (++imageNo).toString(36).toUpperCase().padStart(4, "0"); img.setAttribute("src", `kindle:embed:${id}?mime=${mime}`); }
    $$('style,script,iframe,object,embed,svg', doc).forEach(x => x.remove()); sections.push(`<section><h2>${escapeHtml(chapter.title || "")}</h2>${doc.body.innerHTML}</section>`);
  }
  const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeHtml(book.title)}</title></head><body>${sections.join("")}</body></html>`, text = enc.encode(html), chunks = []; for (let at = 0; at < text.length; at += 4096) chunks.push(text.slice(at, at + 4096)); if (!chunks.length) chunks.push(new Uint8Array());
  const fdstIndex = 1 + chunks.length, skelIndex = fdstIndex + 1, fragIndex = skelIndex + 2, resourceStart = fragIndex + 1;
  const fdst = makeFdst(text.length), skelMaster = makeIndexMaster([[1, 1, 1, 0], [6, 2, 2, 0]], 1, 1), skelData = makeIndexRecord([{ name: "skel00000000", control: 3, values: [0, 0, text.length] }]), fragMaster = makeIndexMaster([[2, 1, 1, 0], [4, 1, 2, 0], [6, 2, 4, 0]], 0, 0);
  const exth = makeExth(book), titleBytes = enc.encode(book.title || "PageForge book"), record0 = new Uint8Array(264 + exth.length + titleBytes.length), view = new DataView(record0.buffer); writeU16(view, 0, 1); writeU32(view, 4, text.length); writeU16(view, 8, chunks.length); writeU16(view, 10, 4096); writeU16(view, 12, 0); writeAscii(record0, 16, "MOBI"); writeU32(view, 20, 248); writeU32(view, 24, 2); writeU32(view, 28, 65001); writeU32(view, 32, Math.floor(Date.now() / 1000)); writeU32(view, 36, 8);
  [40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 112, 116, 164, 168, 172, 176, 180, 184, 188, 200, 204, 208, 212, 216, 220, 224, 228, 232, 236, 244, 256, 260].forEach(at => writeU32(view, at, 0xffffffff)); writeU32(view, 84, 264 + exth.length); writeU32(view, 88, titleBytes.length); writeU32(view, 92, 0x00000409); writeU32(view, 104, 8); writeU32(view, 108, resourceStart); writeU32(view, 128, 0x40); writeU32(view, 192, fdstIndex); writeU32(view, 196, 1); writeU32(view, 240, 0); writeU32(view, 248, fragIndex); writeU32(view, 252, skelIndex); record0.set(exth, 264); record0.set(titleBytes, 264 + exth.length);
  return makePalmDatabase(book.title || "PageForge", [record0, ...chunks, fdst, skelMaster, skelData, fragMaster, ...images]);
}
function formatBytes(size) { if (size < 1024) return `${size} B`; if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`; return `${(size / 1048576).toFixed(1)} MB`; }

window.addEventListener("offline", () => $("#network-proof").textContent = "Connection off · fully operational");
if (!navigator.onLine) $("#network-proof").textContent = "Connection off · fully operational";
window.__pageforgeTest = { parseRange, buildMobi, buildAzw3, buildEpub, filterHtml, version: "2.0.0" };
