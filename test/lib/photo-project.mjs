// The field photos' fake Supabase project, for the checks that came after
// test/photos.mjs: its Data API answered from rows this file keeps — the
// photos (0035) and the upload log, the equipment register and its
// suggestions (0036) — and Storage's signed links answered with the bytes that
// were uploaded, so a check can read a photo back the way the tab does.
//
// Written after photos.mjs and on its terms, which it states at its head: the
// fake does only what the pages downstream of it need to draw — an id, a
// station by distance, a live row per hash, a pending suggestion per unit —
// and **records what the browser sent**, which is the thing under test.
// 0035's and 0036's rules are tools/check_field_photos.sql's and
// tools/check_photo_review.sql's, against a real Postgres; a JavaScript copy
// of them here would be a fixture testing itself. (photos.mjs keeps its own
// copy of the 0035 half; moving it here is a refactor for another day, not a
// reason to touch a check that passes.)

import fs from 'node:fs';
import { repo } from './paths.mjs';

const J = v => JSON.stringify(v);

export const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations
  .filter(s => s.lat != null && s.lon != null);
const metres = (a, b) => Math.hypot((b.lat - a.lat) * 110574, (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
export function nearestStation(p, within = 1000) {
  let best = null, bd = Infinity;
  for (const s of STATIONS) {
    if (Math.abs(s.lat - p.lat) > 0.05 || Math.abs(s.lon - p.lon) > 0.06) continue;
    const d = metres(p, s);
    if (d <= within && d < bd) { best = s; bd = d; }
  }
  return best;
}

// ── PostgREST, as far as these pages ask it ──────────────────────────────────
// A select list with aliases into JSON; eq, neq, gte, lte, is.null and in.(…);
// an order with nulls placement; a limit.

function project(row, select) {
  if (!select || select === '*') return { ...row };
  const out = {};
  for (const part of select.split(',')) {
    const [alias, expr] = part.includes(':') ? part.split(':') : [null, part];
    const pathOf = expr.split(/->>|->/);
    let v = row[pathOf[0]];
    for (const k of pathOf.slice(1)) v = v && typeof v === 'object' ? v[k] : undefined;
    if (v === undefined) v = null;
    if (expr.includes('->>') && v !== null && typeof v !== 'string') v = typeof v === 'object' ? J(v) : String(v);
    out[alias || pathOf[pathOf.length - 1]] = v;
  }
  return out;
}
function inValues(arg) {
  const inner = arg.replace(/^\(/, '').replace(/\)$/, '');
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (c === '\\' && quoted) { cur += inner[++i]; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function matches(row, key, cond) {
  const v = row[key];
  if (cond === 'is.null') return v === null || v === undefined;
  const dot = cond.indexOf('.');
  const op = cond.slice(0, dot), arg = cond.slice(dot + 1);
  if (op === 'eq') return v != null && String(v) === arg;
  if (op === 'neq') return v != null && String(v) !== arg;
  if (op === 'gte') return v != null && +v >= +arg;
  if (op === 'lte') return v != null && +v <= +arg;
  if (op === 'in') return v != null && inValues(arg).includes(String(v));
  throw new Error(`the photo project fixture does not do ${op}`);
}
function ordered(rows, order) {
  const keys = (order || '').split(',').filter(Boolean).map(k => {
    const [col, ...mods] = k.split('.');
    const desc = mods.includes('desc');
    return { col, desc, nullsLast: mods.includes('nullslast') ? true : mods.includes('nullsfirst') ? false : !desc };
  });
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x == null && y == null) continue;
      if (x == null) return k.nullsLast ? 1 : -1;
      if (y == null) return k.nullsLast ? -1 : 1;
      if (x < y) return k.desc ? 1 : -1;
      if (x > y) return k.desc ? -1 : 1;
    }
    return 0;
  });
}

const serialKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const identity = (serial, model) => (serialKey(serial) ? `sn:${serialKey(serial)}` : `model:${serialKey(model)}`);

/** A fresh project. `seed` may carry any of the tables below. */
export function photoProject(seed = {}) {
  return Object.assign({
    photos: [],          // meganet.field_photo, tombstones included
    uploads: [],         // meganet.field_photo_upload
    suggestions: [],     // meganet.equipment_suggestion
    equipment: [],       // meganet.station_equipment
    sync: [],            // meganet.field_photo_sync
    kinds: [],           // meganet.equipment_kind
    types: [],           // meganet.attachment_type
    admin: false,        // what is_admin() answers
    calls: [],           // { fn, body, uploadsBefore } for every RPC, in order
    selects: [],         // { table, search } for every GET
    seq: 10000,          // ids the fake makes start here, clear of any a check writes by hand
    user: 'fixture@example.test',
  }, seed);
}

const nextId = (db, block) => `00000000-0000-4000-${block}-${String(++db.seq).padStart(12, '0')}`;
const now = () => new Date().toISOString();

export function installPhotoProject(page, db, store) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });

    if (req.method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(req.postData() || '{}');
      db.calls.push({ fn, body, uploadsBefore: store ? store.uploads.map(u => u.path) : [] });

      if (fn === 'is_admin') return json(200, db.admin);

      if (fn === 'add_field_photo') {
        const p = body.p_photo;
        const dup = db.photos.find(r => !r.deleted_at && r.sha256 === p.sha256);
        if (dup) return json(409, { code: '23505', message: 'this photo is already in MegaNet', details: dup.id, hint: null });
        let station_id = null, station_auto = false;
        if ('station_id' in p) station_id = p.station_id;
        else if (p.lat != null) { const s = nearestStation(p); if (s) { station_id = s.id; station_auto = true; } }
        const at = now();
        const row = Object.assign({
          id: nextId(db, '8000'), storage_bucket: 'field-photos', title: '', caption: '', thumb_path: null,
          width: null, height: null, taken_at: null, taken_local: null, taken_source: null, lat: null, lon: null,
          placement: null, accuracy_m: null, altitude_m: null, altitude_ref: null, heading_deg: null, heading_ref: null,
          pitch_deg: null, fov_deg: null, meta: {}, origin: 'upload', origin_ref: null,
        }, p, { station_id, station_auto, uploaded_by: db.user, created_at: at, updated_at: at, updated_by: null, deleted_at: null });
        db.photos.push(row);
        return json(200, row);
      }

      if (fn === 'log_field_photo_upload') {
        const rows = body.p_rows || [];
        const batch = (rows[0] && rows[0].batch_id) || nextId(db, 'b000');
        for (const r of rows) {
          db.uploads.push(Object.assign({ id: nextId(db, 'a000'), attempted_at: now(), origin: 'upload', archive_name: null,
                                          sha256: null, byte_size: null, reason: '', photo_id: null, station_id: null },
                                        r, { uploaded_by: db.user }));
        }
        return json(200, { logged: rows.length, batch_id: batch });
      }

      if (fn === 'propose_equipment') {
        const p = body.p || {};
        const photo = p.photo_id ? db.photos.find(r => r.id === p.photo_id && !r.deleted_at) : null;
        if (p.photo_id && !photo) return json(400, { code: '23503', message: `no such field photo: ${p.photo_id}` });
        const station_id = p.station_id || (photo && photo.station_id);
        if (!station_id) return json(400, { code: '22023', message: 'a suggestion has to say which station it is for — the photo is filed under none' });
        const id = identity(p.serial_no, p.model);
        const dup = db.suggestions.find(s => s.status === 'pending' && s.equipment_key === p.equipment_key
          && identity(s.serial_no, s.model) === id && (p.photo_id ? s.photo_id === p.photo_id : (!s.photo_id && s.station_id === station_id)));
        if (dup) return json(409, { code: '23505', message: 'the same unit is already waiting for a decision', details: dup.id });
        const live = serialKey(p.serial_no) && db.equipment.find(u => !u.retired_at && u.station_id === station_id
          && u.equipment_key === p.equipment_key && serialKey(u.serial_no) === serialKey(p.serial_no));
        if (live) return json(409, { code: '23505', message: 'that unit is already on the station\'s register', details: live.id });
        const row = {
          id: nextId(db, 'e000'), station_id, photo_id: p.photo_id || null, equipment_key: p.equipment_key,
          make: p.make || '', model: p.model || '', serial_no: p.serial_no || '', evidence: p.evidence || '',
          confidence: p.confidence ?? null, proposed_by: p.proposed_by || db.user, created_by: db.user, created_at: now(),
          status: 'pending', decided_by: null, decided_at: null, decision_note: null, decision_patch: null, equipment_id: null,
        };
        db.suggestions.push(row);
        return json(200, row);
      }

      if (fn === 'decide_equipment_suggestion') {
        if (!db.admin) {
          return json(403, { code: '42501', message: 'only an administrator may approve or reject equipment suggestions',
                             hint: 'an administrator is an editor whose meganet.app_user row says role = \'admin\'' });
        }
        const s = db.suggestions.find(x => x.id === body.p_id);
        if (!s) return json(400, { code: 'P0002', message: `no such equipment suggestion: ${body.p_id}` });
        if (s.status !== 'pending') return json(400, { code: '55000', message: `that suggestion was already ${s.status}` });
        Object.assign(s, { decided_by: db.user, decided_at: now(), decision_note: body.p_note ?? null });
        if (body.p_decision === 'reject') { s.status = 'rejected'; return json(200, { suggestion: s }); }
        const patch = body.p_patch || {};
        const unit = {
          id: nextId(db, 'f000'), station_id: s.station_id,
          equipment_key: patch.equipment_key || s.equipment_key, make: patch.make ?? s.make, model: patch.model ?? s.model,
          serial_no: patch.serial_no ?? s.serial_no, note: patch.note || '', source: s.proposed_by === 'ocr' ? 'photo' : 'manual',
          photo_id: s.photo_id, suggestion_id: s.id, created_at: now(), updated_at: now(), retired_at: null, replaced_by: null,
        };
        const retired = [];
        if (patch.replaces) {
          const old = db.equipment.find(u => u.id === patch.replaces && !u.retired_at);
          if (old) { old.retired_at = now(); old.replaced_by = unit.id; retired.push(old.id); }
        }
        db.equipment.push(unit);
        Object.assign(s, { status: 'approved', decision_patch: body.p_patch || null, equipment_id: unit.id });
        return json(200, { suggestion: s, equipment: unit, retired, superseded: 0 });
      }

      return route.fallback();
    }

    if (req.method() !== 'GET') return route.fallback();
    const tables = {
      attachment_type: db.types, field_photo: db.photos.filter(r => !r.deleted_at), field_photo_sync: db.sync,
      field_photo_upload: db.uploads, equipment_suggestion: db.suggestions, station_equipment: db.equipment,
      equipment_kind: db.kinds,
    };
    if (!(name in tables)) return route.fallback();
    db.selects.push({ table: name, search: decodeURIComponent(url.search) });
    const q = url.searchParams;
    let rows = tables[name];
    for (const [k, v] of q) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      rows = rows.filter(r => matches(r, k, v));
    }
    rows = ordered(rows, q.get('order'));
    if (q.get('limit')) rows = rows.slice(0, +q.get('limit'));
    return json(200, rows.map(r => project(r, q.get('select'))));
  });
}

/**
 * Answer a signed link's GET with real bytes — the ones uploaded under that
 * path, or `extra[path]` — and CORS, because the tab fetch()es a photo to read
 * its labels, where an <img> would not have needed it. Installed after
 * lib/storage.mjs's route, so it is asked first; anything it has no bytes for
 * falls through to that route's one-pixel GIF.
 */
export function serveObjects(page, store, extra = {}) {
  return page.route('**://*.supabase.co/storage/v1/object/sign/**', route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const path = decodeURIComponent(new URL(req.url()).pathname.replace(/^.*\/object\/sign\/[^/]+\//, ''));
    const up = [...store.uploads].reverse().find(u => u.path === path);
    const bytes = extra[path] || (up && up.data);
    if (!bytes) return route.fallback();
    return route.fulfill({ status: 200, contentType: (up && up.contentType) || 'image/jpeg',
                           headers: { 'Access-Control-Allow-Origin': '*' }, body: bytes });
  });
}
