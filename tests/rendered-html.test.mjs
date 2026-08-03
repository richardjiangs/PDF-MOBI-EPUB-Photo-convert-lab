import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateBlankPercentage } from "../offline-src/blankness.mjs";
import { calculateFingerprintSimilarity, matchesBlankAndSimilar } from "../offline-src/similarity.mjs";
import { buildPdfFromKeptPages } from "../offline-src/pdf-pages.mjs";
import { chapterNavigationLabel, createPdfBookChapter, wrapKf8Chapter, wrapMobiChapter } from "../offline-src/book-content.mjs";
import { PDFDocument } from "pdf-lib";

test("blank-page analysis returns exact percentages for threshold marking", () => {
  const pixels = new Uint8ClampedArray(10 * 4);
  for (let i = 0; i < 10; i++) pixels.set(i < 7 ? [255, 255, 255, 255] : [30, 30, 30, 255], i * 4);
  assert.equal(calculateBlankPercentage(pixels), 70);
  pixels.fill(255);
  assert.equal(calculateBlankPercentage(pixels), 100);
});

test("purple candidates must pass both blankness and similarity thresholds", () => {
  assert.equal(matchesBlankAndSimilar(70, 70, 96, 96), true);
  assert.equal(matchesBlankAndSimilar(69.9, 70, 99, 96), false);
  assert.equal(matchesBlankAndSimilar(90, 70, 95.9, 96), false);
});

test("page fingerprint similarity distinguishes matching and different pages", () => {
  const white = new Uint8Array(48).fill(255), same = new Uint8Array(48).fill(255), black = new Uint8Array(48);
  assert.equal(calculateFingerprintSimilarity(white, same), 100);
  assert.equal(calculateFingerprintSimilarity(white, black), 0);
  same[0] = 0;
  assert.ok(calculateFingerprintSimilarity(white, same) < 96);
  assert.equal(calculateFingerprintSimilarity(white, new Uint8Array(4)), 0);
});

test("confirmed PDF deletion creates a PDF containing only kept pages", async () => {
  const source = await PDFDocument.create();
  source.addPage([100, 200]); source.addPage([200, 300]); source.addPage([300, 400]);
  const output = await buildPdfFromKeptPages(await source.save(), [1, 3]);
  const cleaned = await PDFDocument.load(output);
  assert.equal(cleaned.getPageCount(), 2);
  assert.deepEqual(cleaned.getPages().map(page => page.getSize()), [
    { width: 100, height: 200 },
    { width: 300, height: 400 },
  ]);
});

test("PDF book conversion never duplicates extracted text and a page image", () => {
  const text = createPdfBookChapter({ pageNo: 1, lines: ["SOURCE TEXT ALPHA"], hasVisualArt: false });
  assert.equal(text.kind, "reflow-text");
  assert.match(text.html, /SOURCE TEXT ALPHA/);
  assert.doesNotMatch(text.html, /<img\b|Page 1/i);

  const image = createPdfBookChapter({ pageNo: 2, lines: ["TEXT INSIDE A VISUAL PAGE"], hasVisualArt: true, imageData: "data:image/jpeg;base64,AAAA" });
  assert.equal(image.kind, "page-image");
  assert.match(image.html, /<img\b/);
  assert.doesNotMatch(image.html, /TEXT INSIDE A VISUAL PAGE|<h[1-6]\b/i);
  assert.equal(chapterNavigationLabel(image, 1), "Page 2");

  assert.equal(createPdfBookChapter({ pageNo: 3, lines: [], hasVisualArt: false }), null);
});

test("ebook writers do not inject visible page or section headings", () => {
  const body = '<img alt="Artwork" src="data:image/png;base64,AAAA">';
  assert.equal(wrapMobiChapter(body), body);
  assert.equal(wrapKf8Chapter(body), `<section>${body}</section>`);
  assert.doesNotMatch(wrapMobiChapter(body), /<h[1-6]\b|Page \d+|Section \d+/i);
  assert.doesNotMatch(wrapKf8Chapter(body), /<h[1-6]\b|Page \d+|Section \d+/i);
  assert.equal(chapterNavigationLabel({ title: "Original Chapter", navLabel: "Section 9" }, 8), "Original Chapter");
});

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the PageForge preview wrapper", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>PageForge Local 3\.0<\/title>/i);
  assert.match(html, /<iframe[^>]+src="\/PageForge-Website\.html"/i);
  assert.match(html, /PageForge Local preview/i);
});

test("ships separate standalone and website editions", async () => {
  const [output, versionedOutput, served, website, publicWebsite, hostedWebsite, githubPages, source, template] = await Promise.all([
    readFile(new URL("../outputs/PageForge.html", import.meta.url), "utf8"),
    readFile(new URL("../outputs/PageForge-Local%203.0.html", import.meta.url), "utf8"),
    readFile(new URL("../public/PageForge.html", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/PageForge-Website.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../offline-src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../offline-src/template.html", import.meta.url), "utf8"),
  ]);
  assert.equal(versionedOutput, output);
  assert.equal(served, output);
  assert.equal(publicWebsite, website);
  assert.equal(hostedWebsite, website);
  assert.equal(githubPages, website);
  assert.match(output, /PAGEFORGE LOCAL/);
  assert.match(output, /PAGEFORGE LOCAL 3\.0/);
  assert.match(output, /id="unified-input"[^>]+multiple/i);
  assert.match(output, /Drop photos, a PDF, or an ebook here/i);
  assert.doesNotMatch(output, /id="(?:photo|pdf|book)-drop"/i);
  assert.match(output, /id="pdf-password"/i);
  assert.match(output, /id="book-password"/i);
  assert.match(output, /id="pdf-blank-threshold"[^>]+value="70"/i);
  assert.match(output, /id="pdf-delete-unchecked"/i);
  assert.match(output, /id="pdf-similarity-threshold"[^>]+value="96"/i);
  assert.match(output, /id="pdf-find-similar"/i);
  assert.match(output, /id="pdf-result-format"/i);
  assert.match(output, /id="pdf-result-photo-quality"/i);
  assert.match(output, /id="pdf-direct-format"/i);
  assert.match(output, /id="pdf-direct-download"/i);
  assert.match(output, /Download as selected format/i);
  assert.match(output, /Mark range in green/i);
  assert.match(output, /blank \+ similar/i);
  assert.doesNotMatch(output, /Go to PDF format conversion/i);
  assert.doesNotMatch(output, /id="pdf-jump-convert"/i);
  assert.match(output, /Find blank or blank \+ similar pages/i);
  assert.match(output, /Confirm &amp; prepare cleaned result|Confirm & prepare cleaned result/i);
  assert.doesNotMatch(output, /class="tabs"/i);
  assert.match(output, /value="azw3"/i);
  assert.match(output, /value="azm3"/i);
  assert.match(output, /Richard Jiang/);
  assert.doesNotMatch(output, /id="support"/i);
  assert.match(website, /id="support"/i);
  assert.match(website, /bitcoin:1G3owA2kPUuYS45XGyj8p8M3kgdHQzePBs/i);
  assert.match(website, /data:image\/png;base64,[A-Za-z0-9+/]{100}/i);
  assert.match(source, /showSaveFilePicker/);
  assert.match(source, /showDirectoryPicker/);
  assert.match(source, /Inventory every packaged image/);
  assert.match(source, /Incorrect password/);
  assert.match(source, /function buildAzw3/);
  assert.match(source, /chapters = chapters\.filter/);
  assert.match(source, /async function analyzePdfBlankness/);
  assert.match(source, /calculateFingerprintSimilarity/);
  assert.match(source, /async function preparePdfWithDeleted/);
  assert.match(source, /state\.pdf = cleanedPdf/);
  assert.match(source, /renderPdfPlaceholders\(\); updatePdfConfirmation\(\); stagePdfForBook/);
  assert.match(source, /async function markPdfBlankCandidates/);
  assert.match(source, /"combined"/);
  assert.match(source, /"range"/);
  assert.doesNotMatch(source, /downloadPdfWithDeleted/);
  assert.doesNotMatch(source, /pdf-jump-convert/);
  assert.match(source, /function handleUnifiedFiles/);
  assert.match(source, /data-page-render/);
  assert.match(source, /createPdfBookChapter/);
  assert.match(source, /wrapMobiChapter/);
  assert.match(source, /wrapKf8Chapter/);
  assert.doesNotMatch(source, /sections\.push\(`<h2>/);
  assert.doesNotMatch(source, /sections\.push\(`<section><h2>/);
  assert.match(source, /initKf8File/);
  const controlIds = [...source.matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(controlIds)].filter(id => !new RegExp(`id=["']${id}["']`).test(template)), []);
  assert.doesNotMatch(output, /<(?:script|img|link|iframe)[^>]+(?:src|href)=["']https?:\/\//i);
});
