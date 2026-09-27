#!/usr/bin/env node
// tools/field-photos/sync.mjs — the Dropbox → MegaNet field photo sync.
//
// Run by .github/workflows/field-photos-dropbox.yml every fifteen minutes, and
// by hand from there (Run workflow) or from a checkout:
//
//   cd tools/field-photos && npm ci
//   DROPBOX_APP_KEY=… DROPBOX_REFRESH_TOKEN=… SUPABASE_SECRET_KEY=… node sync.mjs
//
// What it reads from the environment:
//
//   DROPBOX_APP_KEY        the Dropbox app's key (App Console → the app → Settings)
//   DROPBOX_REFRESH_TOKEN  from the Field Photos tab's "Link a Dropbox folder" — see
//                          docs/field-photos.md, which has every click
//   DROPBOX_APP_SECRET     only for a refresh token made the classic way, with
//                          the app's secret; the tab's (PKCE) one needs none
//   DROPBOX_FOLDER         the folder to read: in the app folder ('' — all of it),
//                          or anywhere for an app made with Full Dropbox access
//   SUPABASE_SECRET_KEY    the project's secret (service role) key
//   SUPABASE_URL           the project, if not MegaNet's own
//   MAX_FILES, TIME_BUDGET_S   how much one run may do (150 photos, 600 s)
//
// A photo is read here by the same photo-meta.js the browser runs (lib/read.mjs
// says how), so it is placed by one set of rules whichever door it came in by.
// lib/run.mjs is the run itself; this file only wires it to the world and to
// the OCR engine, which is started the first time a photo needs it and not
// before — a folder of phone photos with GPS in them never pays for it.

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run } from './lib/run.mjs';

const require = createRequire(import.meta.url);

let workerP = null;
function worker() {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = await import('tesseract.js');
      const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
      return createWorker('eng', 1, { langPath, gzip: true, cachePath: os.tmpdir() });
    })();
  }
  return workerP;
}

// readPhoto takes a worker or a promise of one; this hands it a lazy one.
const lazy = {
  async setParameters(p) { return (await worker()).setParameters(p); },
  async recognize(...a) { return (await worker()).recognize(...a); },
};

const t0 = Date.now();
const { ok, report } = await run({ env: process.env, fetch: globalThis.fetch, log: s => console.log(s), worker: lazy });
if (workerP) { try { await (await workerP).terminate(); } catch (_) { /* exiting anyway */ } }

console.log(`\n${report.seen} seen, ${report.imported} imported (${report.unplaced} unplaced), ${report.skipped} skipped, ${report.failed} failed — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (report.last_error) console.log(`::error::${report.last_error}`);
else if (report.failed) console.log(`::warning::${report.failed} photo(s) could not be imported — see the log above`);
process.exitCode = ok ? 0 : 1;
