#!/usr/bin/env node
/*
 * Inlines styles.css into every page at deploy time.
 *
 * Why: styles.css is the only render-blocking request left on the site.
 * Fetching it costs a round trip before anything paints, which measured as
 * ~0.7s of First Contentful Paint on a throttled mobile connection
 * (Lighthouse mobile: 92 -> 95, FCP 2.7s -> 2.0s).
 *
 * How: Netlify runs this against its own fresh clone before publishing, so
 * styles.css stays the single source of truth in git and normal local
 * development is unaffected. Edit styles.css as usual; never edit the
 * <style> block this produces.
 *
 * Running it locally rewrites your working copy. That is reversible with
 * `git checkout -- '*.html'`, and re-running is a no-op.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CSS_FILE = 'styles.css';
const LINK_TAG = '<link rel="stylesheet" href="styles.css">';
const MARKER = 'data-inlined-from="styles.css"';

function fail(message) {
  console.error(`\n[build] FAILED: ${message}\n`);
  process.exit(1);
}

const cssPath = path.join(ROOT, CSS_FILE);
if (!fs.existsSync(cssPath)) fail(`${CSS_FILE} not found in ${ROOT}`);

let css = fs.readFileSync(cssPath, 'utf8');

// A literal </style in the CSS would close the tag early and break the page.
if (/<\/style/i.test(css)) fail(`${CSS_FILE} contains a "</style" sequence and cannot be inlined safely`);

// Relative url() paths resolve against the stylesheet when linked, but against
// the page once inlined. Making them root-absolute keeps them correct either
// way, including for any page added in a subdirectory later.
//
// Each quoting style is handled separately and matched to its closing quote.
// A single combined pattern with an optional quote group is not safe here:
// it backtracks past the quote on data: URIs and corrupts them.
const isAbsolute = (u) => /^(data:|https?:|\/\/|\/|#)/.test(u);
const urlCount = (s) => (s.match(/url\(/g) || []).length;

const originalUrls = urlCount(css);
let rewritten = 0;

const rewrite = (quote) => (match, url) => {
  if (isAbsolute(url)) return match;
  rewritten++;
  return `url(${quote}/${url}${quote})`;
};

css = css
  .replace(/url\(\s*"([^"]*)"\s*\)/g, rewrite('"'))
  .replace(/url\(\s*'([^']*)'\s*\)/g, rewrite("'"))
  .replace(/url\(\s*([^'"()\s]+)\s*\)/g, rewrite(''));

// A rewrite must never add, drop, or merge a url() reference.
if (urlCount(css) !== originalUrls) {
  fail(`url() rewrite changed the reference count (${originalUrls} -> ${urlCount(css)})`);
}
if (/url\(\/["']/.test(css)) {
  fail('url() rewrite produced a slash before a quote, which would corrupt the value');
}

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
if (pages.length === 0) fail('no .html files found to build');

let inlined = 0;
let skipped = 0;

for (const page of pages) {
  const file = path.join(ROOT, page);
  const html = fs.readFileSync(file, 'utf8');

  if (html.includes(MARKER)) {
    console.log(`[build]  skip   ${page} (already inlined)`);
    skipped++;
    continue;
  }

  if (!html.includes(LINK_TAG)) {
    fail(`${page} has no ${LINK_TAG} to replace. If the page intentionally ` +
         `omits the stylesheet, add it to an ignore list here; otherwise the ` +
         `page would ship unstyled.`);
  }

  const styleBlock = `<style ${MARKER}>\n${css}\n  </style>`;
  fs.writeFileSync(file, html.replace(LINK_TAG, styleBlock), 'utf8');
  console.log(`[build]  inline ${page}`);
  inlined++;
}

console.log(
  `\n[build] done: ${inlined} inlined, ${skipped} skipped, ` +
  `${(css.length / 1024).toFixed(1)} KiB CSS, ${rewritten} url() paths made absolute\n`
);
