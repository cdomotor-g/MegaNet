// index.html is the load-order contract (#129). Every check here reads the
// script list out of it rather than keeping its own copy, so that when the
// decomposition milestones add files, the tests follow along without being
// edited — and so that a file added to the repo but *not* wired into
// index.html is invisible to the tests exactly as it is invisible to the app.

import fs from 'node:fs';
import { INDEX_HTML, repo } from './paths.mjs';

// Scripts that live next to index.html but are not part of the app.js lineage.
// maps-data.js predates the split and is its own IIFE with its own namespace;
// concatenating it into the app.js comparison would make the byte diff
// meaningless. Kept here rather than in the baseline manifest so that both the
// duplicate-name check and the concat verifier agree on what "the app" is.
const NOT_APP = new Set(['maps-data.js']);

const SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

/**
 * Every `<script src>` in index.html, in document order.
 * @returns {{src: string, external: boolean, path: string|null, name: string|null}[]}
 */
export function indexScripts() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const out = [];
  for (const m of html.matchAll(SRC_RE)) {
    const src = m[1] ?? m[2];
    const external = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src);
    // The `?v=` cache-buster is part of the URL, not part of the filename.
    const name = external ? null : src.split('?')[0].replace(/^\.\//, '');
    out.push({ src, external, name, path: name ? repo(name) : null });
  }
  return out;
}

/**
 * The app.js lineage, in load order: the local scripts index.html pulls in,
 * minus the ones that were never part of app.js. Pre-split this is `['app.js']`;
 * after #132–#135 it is core.js → …modules… → init.js.
 */
export function appScripts() {
  return indexScripts().filter(s => !s.external && !NOT_APP.has(s.name));
}

/** Local scripts the app actually loads, app.js lineage or not. */
export function localScripts() {
  return indexScripts().filter(s => !s.external);
}
