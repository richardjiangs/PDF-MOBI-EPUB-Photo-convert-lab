import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateBlankPercentage } from "../offline-src/blankness.mjs";

test("blank-page analysis returns exact percentages for threshold marking", () => {
  const pixels = new Uint8ClampedArray(10 * 4);
  for (let i = 0; i < 10; i++) pixels.set(i < 7 ? [255, 255, 255, 255] : [30, 30, 30, 255], i * 4);
  assert.equal(calculateBlankPercentage(pixels), 70);
  pixels.fill(255);
  assert.equal(calculateBlankPercentage(pixels), 100);
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
  assert.match(html, /<title>PageForge Local 2\.0\.1<\/title>/i);
  assert.match(html, /<iframe[^>]+src="\/PageForge-Website\.html"/i);
  assert.match(html, /PageForge Local preview/i);
});

test("ships separate standalone and website editions", async () => {
  const [output, versionedOutput, served, website, publicWebsite, hostedWebsite, githubPages, source, template] = await Promise.all([
    readFile(new URL("../outputs/PageForge.html", import.meta.url), "utf8"),
    readFile(new URL("../outputs/PageForge-Local%202.0.1.html", import.meta.url), "utf8"),
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
  assert.match(output, /PAGEFORGE LOCAL 2\.0\.1/);
  assert.match(output, /id="unified-input"[^>]+multiple/i);
  assert.match(output, /Drop photos, a PDF, or an ebook here/i);
  assert.doesNotMatch(output, /id="(?:photo|pdf|book)-drop"/i);
  assert.match(output, /id="pdf-password"/i);
  assert.match(output, /id="book-password"/i);
  assert.match(output, /id="pdf-blank-threshold"[^>]+value="70"/i);
  assert.match(output, /id="pdf-delete-unchecked"/i);
  assert.match(output, /Analyze &amp; mark matching pages|Analyze & mark matching pages/i);
  assert.match(output, /Confirm deletion of marked pages/i);
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
  assert.match(source, /marked in red · confirm before deletion/);
  assert.match(source, /function handleUnifiedFiles/);
  assert.match(source, /data-page-render/);
  assert.match(source, /initKf8File/);
  const controlIds = [...source.matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(controlIds)].filter(id => !new RegExp(`id=["']${id}["']`).test(template)), []);
  assert.doesNotMatch(output, /<(?:script|img|link|iframe)[^>]+(?:src|href)=["']https?:\/\//i);
});
