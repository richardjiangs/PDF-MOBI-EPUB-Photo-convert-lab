import { PDFDocument } from "pdf-lib";

export async function buildPdfFromKeptPages(sourceBytes, keepPages) {
  if (!keepPages.length) throw new Error("A PDF needs at least one page.");
  const source = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: false });
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, keepPages.map(pageNo => pageNo - 1));
  copied.forEach(page => output.addPage(page));
  return output.save({ useObjectStreams: true });
}
