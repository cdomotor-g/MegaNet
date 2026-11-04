#!/usr/bin/env node
// Flood-Net — the investigations' PDFs.
//
//   node tools/investigations/pdf.mjs            every report
//   node tools/investigations/pdf.mjs 03         just investigation 03
//
// Prints each report in investigations/ (every page but the list) the way a
// browser prints it — its own print styles, A4, its two sheets — into
// investigations/pdf/floodnet-investigation-<nn>-<name>.pdf, the file the
// Download PDF button at the top of the report and its card on the
// Investigations tab link to. Run it after the report's script, in the same
// push: a PDF made before a change is the old report.
//
// The number comes from the page's <title> ("… Flood-Net investigation 03"),
// the name from its file less the date ("2026-11-hillcrest-wine-glass" →
// "hillcrest-wine-glass"). A report that prints to more than two pages fails:
// the list asks for two.
//
// Needs Playwright's Chromium (preinstalled in a cloud session; elsewhere
// `cd test && npm install && npx playwright install chromium`).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'investigations');
const OUT = path.join(DIR, 'pdf');
const MAX_PAGES = 2;

function playwright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch (_) { /* fall through to the test suite's copy */ }
  return createRequire(path.join(ROOT, 'test', 'package.json'))('playwright');
}

export function pdfName(file, html) {
  const m = /investigation\s+(\d{2,})/i.exec((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '');
  if (!m) throw new Error(`${file}: its <title> carries no investigation number`);
  const name = path.basename(file, '.html').replace(/^\d{4}-\d{2}-/, '');
  return `floodnet-investigation-${m[1]}-${name}.pdf`;
}

function pages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
}

async function main() {
  const only = process.argv.slice(2);
  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-[a-z0-9-]+\.html$/.test(f)).sort();
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = playwright();
  const browser = await chromium.launch();
  let bad = 0;
  try {
    for (const file of files) {
      const html = fs.readFileSync(path.join(DIR, file), 'utf8');
      const name = pdfName(file, html);
      if (only.length && !only.some(o => name.includes(`-${o}-`) || file.includes(o))) continue;
      if (!html.includes(`pdf/${name}`)) {
        console.log(`✗ ${file}: no Download PDF button linking pdf/${name}`);
        bad++;
      }
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path.join(DIR, file)).href);
      await page.emulateMedia({ media: 'print' });
      const buf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      await page.close();
      fs.writeFileSync(path.join(OUT, name), buf);
      const n = pages(buf);
      const ok = n <= MAX_PAGES;
      if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${path.relative(ROOT, path.join(OUT, name))}: ${n} page${n === 1 ? '' : 's'}, ` +
                  `${Math.round(buf.length / 1024)} kB${ok ? '' : ` — over ${MAX_PAGES}; tighten the report`}`);
    }
  } finally {
    await browser.close();
  }
  if (bad) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
