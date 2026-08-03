# PageForge Local 2.1

PageForge is a private, browser-based PDF, ebook, and photo conversion studio. Conversion happens on the device: files are not uploaded to a server and the converter does not require an account or external API.

## Formats and tools

- Photos → PDF with rotation, ordering, quality controls, and progressive disk saving in supported browsers.
- PDF → JPEG, PNG, or WebP pages, with page-range export, per-page keep checkboxes, exact blank-page cleanup, customizable blankness thresholds, and blue-reference similarity matching.
- PDF, EPUB, MOBI, AZW, AZW3, and AZM3-compatible input.
- PDF, EPUB, classic MOBI, AZW3/KF8, and AZM3-compatible output.
- Text + photos, text-only, and photos-only ebook editions; sections that become empty are removed automatically.
- Password entry for protected PDFs. Publisher DRM is not removed.

Photos, PDFs, EPUBs, MOBIs, and AZW3 books all enter through one upload box; PageForge shows only the applicable choices. Blankness and similarity analysis mark proposed PDF removals in red and wait for explicit confirmation. Confirmation prepares a cleaned result without auto-downloading; the user then chooses PDF, EPUB, MOBI, AZW3, AZM3, JPEG, PNG, or WebP. `PageForge-Local 2.1.html` is the versioned standalone offline file and intentionally omits the support section. `index.html` is the website edition and includes Richard Jiang’s GitHub link and the optional Bitcoin support panel.

## Run locally

```bash
npm install
npm run dev
```

## Build and test

```bash
npm run build
npm test
```

The converter build embeds its PDF worker, libraries, styles, scripts, and website QR code into the generated HTML files.

Created by [Richard Jiang](https://github.com/richardjiangs).
