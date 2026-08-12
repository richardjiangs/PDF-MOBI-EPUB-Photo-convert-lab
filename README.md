# PageForge Local 3.2

PageForge is a private, browser-based PDF, ebook, and photo conversion studio. Conversion happens on the device: files are not uploaded to a server and the converter does not require an account or external API.

## Formats and tools

- Photos → PDF with rotation, ordering, quality controls, and progressive disk saving in supported browsers.
- PDF → JPEG, PNG, or WebP pages, with page-range export, per-page keep checkboxes, exact blank-page cleanup, customizable blankness thresholds, and blue-reference similarity matching.
- PDF, EPUB, MOBI, AZW, AZW3, and AZM3-compatible input.
- PDF, EPUB, classic MOBI, AZW3/KF8, and AZM3-compatible output.
- Fast ebook opening: EPUB package images and MOBI/KF8 spine sections are loaded only when their page card becomes visible or an analysis/export needs them.
- EPUB, MOBI, AZW3, and AZM3 use the same page-card review tools as PDF: per-page keep checkboxes, orange range marking, automatic per-page blank percentages, customizable blankness review, blue similarity reference, purple combined matching, and confirmation before removal.
- Text + photos, text-only, and photos-only ebook editions; sections that become empty are removed automatically.
- Editable Author metadata for PDF and ebook exports.
- Smart offline table-of-contents generation prefers the publisher's real hierarchy. When navigation is absent, version 3.2 combines semantic H1/H2/H3 markup, typography, multilingual chapter labels, numbered headings, subtitles, and part/chapter/section classification while rejecting contents pages, duplicates, and repeated running headers. Users can override it by manually marking page cards as green first-class, yellow second-class, or black third-class chapters and editing every title. Nested levels become expandable reader navigation in EPUB and nested linked contents in MOBI/KF8/PDF. No OCR service or network call is used.
- EPUB/MOBI/AZW3 page cards render the complete isolated book page—including text placed over, beside, or below images—instead of replacing mixed pages with a thumbnail of their first image.
- Password entry for protected PDFs. Publisher DRM is not removed.

Photos, PDFs, EPUBs, MOBIs, and AZW3 books all enter through one upload box. PDFs use one Download-as selector for PDF, EPUB, MOBI, AZW3, AZM3, JPEG, PNG, and WebP. Blank percentages are calculated in the background and displayed without marking pages. PDF and ebook cleanup proposals are color coded: blue reference, orange range, purple blank + similar, and red for other marked pages. If a download is started while marks remain, PageForge asks whether to delete the marked pages and continue, continue without deleting, or cancel.

Version 3.2 uses mutually exclusive PDF page conversion: text-only pages become reflowable text, pages containing artwork are preserved once as page images, and empty pages are omitted from ebook exports. MOBI, AZW3, AZM3, EPUB, and ebook-to-PDF exports do not insert visible synthetic page or section headings. Photos-only output does not receive generated body text. Temporary ebook rendering is style-isolated, so a publisher's `body`, `header`, `img`, fixed-position, animation, or transition rules cannot restyle the PageForge interface during analysis and packaging.

`PageForge-Local 3.2.html` is the versioned standalone offline file and intentionally omits the support section. `index.html` is the website edition and includes Richard Jiang’s GitHub link and the optional Bitcoin support panel.

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
