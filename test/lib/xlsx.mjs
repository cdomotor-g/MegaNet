// Reading a sheet out of an .xlsx, with no dependency (#117).
//
// Why this exists at all. `npm run insp` takes its fixture out of
// `db/migrations/0009_inspections.sql` rather than out of a fixture file copied
// from it, and says why: a test that renders the form against a hand-written
// copy of what the database says is testing the copy. The Council Maintenance
// Tasks form has the same problem one layer up — its filled example is a sheet
// in `archive/Inspection sheets for printing.xlsx`, and a fixture typed out of
// that sheet by hand is a test of the typing.
//
// So this reads the workbook. It is not an xlsx library and does not try to be:
// no styles, no formulas, no dates, no formatting — cell references to the text
// Excel would show, which is all a form-fidelity test needs.
//
// An .xlsx is a zip of XML, and both halves are in Node's standard library —
// `zlib.inflateRawSync` does deflate, and the zip container is a header format.
// Adding a dependency to `test/package.json` for this would have been the
// larger change, and the three that are there are there because writing a JS
// parser, a browser or a map library is a different proposition from reading
// 22 bytes of a header.

import fs from 'node:fs';
import zlib from 'node:zlib';

// ── The zip container ────────────────────────────────────────────────────────
// Only what a workbook uses: the end-of-central-directory record, the central
// directory it points at, and stored or deflated entries. No zip64, no
// encryption, no spanning — a spreadsheet that needed any of those would fail
// loudly here rather than quietly returning nothing.

const EOCD_SIG = 0x06054b50;
const CEN_SIG  = 0x02014b50;
const LOC_SIG  = 0x04034b50;

function findEocd(buf) {
  // The record is 22 bytes plus a comment of up to 64 KB, so it is within the
  // last 64 KB + 22 and is found by scanning back for its signature.
  const from = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

/** Every entry in the archive, as { name: Buffer }. */
function unzip(file) {
  const buf = fs.readFileSync(file);
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`central directory entry ${n} has the wrong signature`);
    }
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localAt  = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== LOC_SIG) {
      throw new Error(`${name}: local header has the wrong signature`);
    }
    // The local header's own name and extra lengths, which need not match the
    // central directory's extra length and usually do not.
    const dataAt = localAt + 30
                 + buf.readUInt16LE(localAt + 26)
                 + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);

    if (method === 0) out[name] = Buffer.from(raw);
    else if (method === 8) out[name] = zlib.inflateRawSync(raw);
    else throw new Error(`${name}: compression method ${method} is not supported here`);

    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// ── The XML ──────────────────────────────────────────────────────────────────
// Regex over the parts a worksheet uses, in the same spirit as the migration
// reader in lib/migration.mjs: a reader for the shapes these files actually
// contain, which fails loudly rather than returning an empty sheet.

function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
}

/** The concatenated text of every <t> in a fragment — a run-formatted cell is
 *  several runs of one string, and the sheet shows them joined. */
function textOf(xml) {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out += decodeEntities(m[1] ?? '');
  }
  return out;
}

function sharedStrings(files) {
  const xml = files['xl/sharedStrings.xml'];
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)]
    .map(m => textOf(m[1] ?? ''));
}

/**
 * Open a workbook.
 *
 * @returns {{ names: string[], cells(sheetName: string): Record<string,string> }}
 *   `cells` maps a cell reference ("A15") to the text Excel would show in it.
 *   Empty cells are absent rather than present-and-empty.
 */
export function openWorkbook(file) {
  const files = unzip(file);
  const wb = (files['xl/workbook.xml'] || Buffer.from('')).toString('utf8');
  const rels = (files['xl/_rels/workbook.xml.rels'] || Buffer.from('')).toString('utf8');
  const sst = sharedStrings(files);

  const target = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) target[m[1]] = m[2];

  const sheets = {};
  const names = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="(rId\d+)"[^>]*\/?>/g)) {
    const name = decodeEntities(m[1]);
    names.push(name);
    sheets[name] = 'xl/' + target[m[2]].replace(/^\/?xl\//, '');
  }
  if (!names.length) throw new Error(`${file}: no sheets found`);

  function cells(sheetName) {
    const path = sheets[sheetName];
    if (!path) throw new Error(`${file}: no sheet called "${sheetName}" (have: ${names.join(', ')})`);
    const xml = files[path];
    if (!xml) throw new Error(`${file}: ${sheetName} points at ${path}, which is not in the archive`);

    const out = {};
    for (const m of xml.toString('utf8').matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1] ?? m[2] ?? '';
      const body  = m[3] ?? '';
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';

      let text;
      if (type === 'inlineStr') {
        text = textOf(body);
      } else {
        const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        if (!v) continue;
        const raw = decodeEntities(v[1]);
        text = type === 's' ? (sst[Number(raw)] ?? '') : raw;
      }
      if (text !== '') out[ref] = text;
    }
    return out;
  }

  return { names, cells };
}
