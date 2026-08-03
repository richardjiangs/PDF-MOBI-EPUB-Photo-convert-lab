import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(html, /<title>PageForge Local<\/title>/i);
  assert.match(html, /<iframe[^>]+src="\/PageForge-Website\.html"/i);
  assert.match(html, /PageForge Local preview/i);
});

test("ships separate standalone and website editions", async () => {
  const [output, served, website, publicWebsite, hostedWebsite, source] = await Promise.all([
    readFile(new URL("../outputs/PageForge.html", import.meta.url), "utf8"),
    readFile(new URL("../public/PageForge.html", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/PageForge-Website.html", import.meta.url), "utf8"),
    readFile(new URL("../offline-src/app.js", import.meta.url), "utf8"),
  ]);
  assert.equal(served, output);
  assert.equal(publicWebsite, website);
  assert.equal(hostedWebsite, website);
  assert.match(output, /PAGEFORGE LOCAL/);
  assert.match(output, /id="photo-input"[^>]+multiple/i);
  assert.match(output, /id="pdf-password"/i);
  assert.match(output, /id="book-password"/i);
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
  assert.match(source, /initKf8File/);
  assert.doesNotMatch(output, /<(?:script|img|link|iframe)[^>]+(?:src|href)=["']https?:\/\//i);
});
