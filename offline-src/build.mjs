import { build } from "esbuild";
import { copyFile, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const result = await build({
  entryPoints: [resolve(root, "offline-src/app.js")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  conditions: ["browser", "import", "default"],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

const template = await readFile(resolve(root, "offline-src/template.html"), "utf8");
const worker = await readFile(resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), "utf8");
const bitcoinQr = (await readFile(resolve(root, "offline-src/assets/bitcoin-qr.png"))).toString("base64");
const bundle = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = template
  .replace("/*__PDF_WORKER__*/", () => worker)
  .replace("/*__APP_BUNDLE__*/", () => bundle)
  .replace("/*__BITCOIN_QR__*/", bitcoinQr);
const standaloneHtml = html.replace(/\s*<!--__WEBSITE_ONLY_START__-->[\s\S]*?<!--__WEBSITE_ONLY_END__-->/g, "");
const websiteHtml = html.replaceAll("<!--__WEBSITE_ONLY_START__-->", "").replaceAll("<!--__WEBSITE_ONLY_END__-->", "");
await mkdir(resolve(root, "outputs"), { recursive: true });
await mkdir(resolve(root, "public"), { recursive: true });
await mkdir(resolve(root, "docs"), { recursive: true });
await mkdir(resolve(root, "work"), { recursive: true });
await writeFile(resolve(root, "outputs/PageForge.html"), standaloneHtml);
await writeFile(resolve(root, "outputs/PageForge-Local 2.0.html"), standaloneHtml);
await writeFile(resolve(root, "outputs/PageForge-Local 2.0.1.html"), standaloneHtml);
await writeFile(resolve(root, "outputs/PageForge-Local 2.1.html"), standaloneHtml);
await writeFile(resolve(root, "public/PageForge.html"), standaloneHtml);
await writeFile(resolve(root, "index.html"), websiteHtml);
await writeFile(resolve(root, "public/index.html"), websiteHtml);
await writeFile(resolve(root, "public/PageForge-Website.html"), websiteHtml);
await writeFile(resolve(root, "docs/index.html"), websiteHtml);
await writeFile(resolve(root, "docs/PageForge.html"), standaloneHtml);
await writeFile(resolve(root, "docs/.nojekyll"), "");
await copyFile(resolve(root, "public/og.png"), resolve(root, "docs/og.png"));
await copyFile(resolve(root, "public/favicon.png"), resolve(root, "docs/favicon.png"));
await writeFile(resolve(root, "work/pageforge.bundle.js"), bundle);
console.log(`Built PageForge-Local 2.1.html (${(standaloneHtml.length / 1048576).toFixed(2)} MB), website, and GitHub Pages edition`);
