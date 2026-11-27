#!/usr/bin/env node
// tools/photo-upload/send.mjs — send a folder of field photos to Flood-Net
// through the photo upload API (docs/agent-api.md, "Sending field photos").
// An example client: Node 18 or later, nothing to install.
//
//   FLOODNET_UPLOAD_KEY=fnp_… node send.mjs <folder> [--station <id>] [--caption <text>]
//   FLOODNET_UPLOAD_KEY=fnp_… node send.mjs <folder> --status
//
// Every JPEG, PNG, WebP and HEIC in the folder (not below it) is sent once.
// What was sent is remembered in <folder>/.floodnet-sent.json — each photo's
// SHA-256 and its receipt — so running it again sends only new photos, and
// --status asks what became of each one. Sending a photo twice is harmless
// anyway: the API answers with the receipt it already has.
//
// The key is read from the environment and never printed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = (process.env.FLOODNET_UPLOAD_URL || 'https://floodwarning.net/api/upload/v1').replace(/\/+$/, '');
const KEY = process.env.FLOODNET_UPLOAD_KEY || '';
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' };

const args = process.argv.slice(2);
const opts = {};
let folder = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--station' || args[i] === '--caption') opts[args[i]] = args[++i];
  else if (args[i].startsWith('--')) opts[args[i]] = true;
  else if (!folder) folder = args[i];
}
const opt = name => opts[name];
if (!folder || !KEY) {
  console.error('usage: FLOODNET_UPLOAD_KEY=fnp_… node send.mjs <folder> [--station <id>] [--caption <text>] [--status]');
  process.exit(2);
}

const ledgerPath = path.join(folder, '.floodnet-sent.json');
let ledger = {};
try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (_) { /* first run */ }
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
const auth = { Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (opts['--status']) {
  for (const [name, x] of Object.entries(ledger)) {
    const res = await fetch(`${BASE}/photos/${x.receipt}`, { headers: auth });
    const r = await res.json();
    console.log(`${name}: ${r.state || res.status}${r.reason ? ` — ${r.reason}` : ''}${r.station_id ? ` [${r.station_id}]` : ''}`);
  }
  process.exit(0);
}

const q = new URLSearchParams();
if (opt('--station')) q.set('station', opt('--station'));
if (opt('--caption')) q.set('caption', opt('--caption'));

let failed = 0;
for (const name of fs.readdirSync(folder).sort()) {
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type) continue;
  const bytes = fs.readFileSync(path.join(folder, name));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (ledger[name] && ledger[name].sha256 === sha) continue;

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/photos${q.size ? `?${q}` : ''}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': type, 'X-Content-SHA256': sha, 'X-FloodNet-File-Name': encodeURIComponent(name) },
        body: bytes,
      });
    } catch (err) {
      if (attempt < 4) { await sleep(2000 * attempt); continue; }    // safe to resend: same photo, same receipt
      console.log(`${name}: could not reach Flood-Net — ${err.message}`); failed++; break;
    }
    const r = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status === 409) && attempt < 4) {
      await sleep(1000 * Number(res.headers.get('Retry-After') || 60)); continue;
    }
    if (res.status === 202 || res.status === 200) {
      ledger[name] = { sha256: sha, receipt: r.receipt };
      save();
      console.log(`${name}: ${r.state}${r.repeat ? ' (sent before)' : ''} — receipt ${r.receipt}`);
    } else {
      console.log(`${name}: refused (${res.status}) — ${r.error || 'no reason given'}`);
      failed++;
    }
    break;
  }
}
process.exitCode = failed ? 1 : 0;
