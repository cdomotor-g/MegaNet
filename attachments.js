// MegaNet — attachments.js
//
//   Attachments   the photo, the screenshot and the pasted terminal dump: one
//                 uploader, one thumbnail list and one remove button, rendered
//                 into whichever section of whichever form asks for them.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc and escAttr; to datastore.js for
// dbSelect, dbRpc, dbCanWrite, dbUploadObject, dbSignedUrl and dbRemoveObject;
// and to auth.js for Auth. Two files reach into this one: inspections.js and
// maintenance.js, each from a section that prints something this app could not
// hold until now.
//
// The IIFE body builds a couple of constants and calls nothing, so this file's
// position among the modules is free — checked, not reasoned about
// (`npm run toplevel`). It builds no Leaflet map and starts no timer, so it
// registers neither a map nor a teardown.
//
// ── Why this is one file and not two panels ──────────────────────────────────
//
// Three sections across two tabs print something that is an image rather than a
// field, and #113's constraint 2 says a tab owns its own file. A panel copied
// into both would be two copies of an upload path, a signed-URL cache and a
// compensating delete — and the compensating delete is the half that is easy to
// get subtly different and impossible to notice.
//
// So this is the shape the rest of the app already uses for something two tabs
// share: its own file, its own slice of `state`, and the hosts call it. What the
// hosts keep is *where* an attachment belongs on their sheet, which is a fact
// about the paper and genuinely theirs:
//
//   inspections.js   Photos & Admin — "Photos taken?" is a tick recording the
//                    claim that photos exist. Now the photos can too.
//   maintenance.js   ALERT Canister Configuration, which in the one filled sheet
//                    in the workbook is a pasted screenshot of a terminal dump;
//                    and Gauge Boards, where "(if yes take photo)" is printed
//                    beside Bench Mark present.
//
// ── What is enforced here and what is enforced in the database ───────────────
//
// Everything that matters is enforced in `meganet.attach_file()` — the path
// convention, the type list, the size limit, the role, that the owner exists and
// is not deleted, and who gets recorded as having uploaded it. This file checks
// the type and the size *as well*, and that is not belt-and-braces: the point of
// checking here is to refuse a 40 MB video **before** spending a paddock's worth
// of signal uploading it, not to be the thing that decides. Where the two could
// disagree they cannot, because both read `meganet.attachment_type` — the same
// rows, one source (0010).
//
// The object's name is a fresh uuid rather than the file's own name, and the
// database refuses anything else. That is a security property rather than a
// tidiness one: the bucket is private and read through signed URLs, and a signed
// URL is only ever as private as the path it signs. `IMG_0042.jpg` under a known
// inspection id is a name somebody can try. The file's own name is kept, in
// `title`, where it is a label and not an address.
//
// ── The order the two halves happen in ───────────────────────────────────────
//
// Bytes first, index second, and a failed index deletes the bytes again. The
// alternative — row first, upload second — fails as a broken thumbnail on a form
// somebody is relying on; this one fails as a few kilobytes nothing points at.
// 0010's header makes the same argument from the other side.
//
// ── Attachments need a saved record, and say so ──────────────────────────────
//
// `meganet.attachment` hangs off an inspection or a maintenance activity by
// foreign key, so there has to be a row to point at. An unsaved form says that
// plainly rather than offering an uploader that could only fail — the same rule,
// for the same reason, as the Council-form button at the foot of an inspection
// (#117).
//
// Issue #149, sub-issue of #78. Schema: db/migrations/0010_attachments.sql.
// Bucket and policies: tools/storage_bucket.sql.

const Attachments = (function () {

  const BUCKET = 'inspections';

  // How long a thumbnail's URL is good for. An hour outlives any form-filling
  // session and is short enough that a URL copied out of the page is not a
  // lasting way around the bucket being private.
  const SIGNED_FOR = 3600;

  // Which owner column a kind lands in, and the prefix its objects live under.
  // Both halves are the database's, restated here only so the request can be
  // built — attach_file() refuses a path that disagrees with the id.
  const OWNERS = {
    inspection:  { arg: 'p_inspection_id',           prefix: 'inspection' },
    maintenance: { arg: 'p_maintenance_activity_id', prefix: 'maintenance' },
  };

  const S = () => state.attach;

  // ── The type vocabulary ────────────────────────────────────────────────────
  // Public, like every other vocabulary in this domain — it is the list of what
  // a blank form accepts and says nothing about any site — so this loads signed
  // out and signing in adds nothing to it. Never rejects: every caller wants to
  // render the failure rather than catch it.

  function loadTypes() {
    const s = S();
    if (s.types || s.typesLoading) return;
    s.typesLoading = true;
    s.typesError = null;
    dbSelect('attachment_type?select=*&order=ord')
      .then(rows => { s.types = rows; s.typesLoading = false; repaint(); })
      .catch(err => {
        s.typesLoading = false;
        s.typesError = (err && err.message) || String(err);
        repaint();
      });
  }

  // What a file is, as far as the database is concerned. The browser's own
  // `file.type` is the first answer and the extension is the fallback, because a
  // phone handing over a .heic often reports an empty type and "I could not tell
  // what this is" is a worse message than the one the extension supports.
  function typeFor(file) {
    const types = S().types || [];
    const mime = (file.type || '').toLowerCase();
    if (mime) {
      const hit = types.find(t => t.content_type === mime);
      if (hit) return hit;
    }
    const ext = extensionOf(file.name);
    return types.find(t => (t.extensions || []).includes(ext)) || null;
  }

  function extensionOf(name) {
    const bits = String(name || '').toLowerCase().split('.');
    return bits.length > 1 ? bits.pop() : '';
  }

  // The `accept=` list the file picker opens with. Built from the vocabulary
  // rather than written out, so adding HEIC to the database is the whole change.
  function acceptList() {
    const types = S().types || [];
    return types.map(t => t.content_type)
      .concat(types.flatMap(t => (t.extensions || []).map(e => `.${e}`)))
      .join(',');
  }

  function mb(bytes) {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB`
         : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  // ── The list, per record ───────────────────────────────────────────────────
  // One record's worth at a time. Both form tabs can hold a document at once, so
  // the slot is keyed and re-fetched when the other one asks — which is also the
  // honest behaviour, because somebody else may have added a photo since.

  function keyFor(kind, id) { return `${kind}:${id}`; }

  function ensure(kind, id) {
    const s = S();
    const key = keyFor(kind, id);
    if (s.ownerKey === key && (s.list || s.listLoading)) return;
    s.ownerKey = key;
    s.list = null;
    s.error = null;
    s.listLoading = true;
    const col = kind === 'inspection' ? 'inspection_id' : 'maintenance_activity_id';
    dbSelect(`attachment?select=*&${col}=eq.${encodeURIComponent(id)}&order=ord`)
      .then(rows => {
        if (S().ownerKey !== key) return;      // the operator moved on
        S().listLoading = false;
        S().list = rows;
        repaint();
      })
      .catch(err => {
        if (S().ownerKey !== key) return;
        S().listLoading = false;
        S().list = [];
        S().error = (err && err.message) || String(err);
        repaint();
      });
  }

  function listed(kind, id, role) {
    const s = S();
    if (s.ownerKey !== keyFor(kind, id) || !s.list) return null;
    return s.list.filter(r => r.role_key === role);
  }

  function rowById(id) {
    return (S().list || []).find(r => r.id === id) || null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  //
  // One panel per role, because the three places this appears are asking for
  // different things and a single undifferentiated pile of files would lose
  // which. The host says which role its section is for; everything else is here.
  //
  //   opts.kind   'inspection' | 'maintenance'
  //   opts.id     the saved record's id, or null/'' if it has not been saved
  //   opts.role   a key in meganet.attachment_role
  //   opts.label  what to call them on this sheet ("Photos", "Screenshot")
  //   opts.note   the sheet's own words for why this box is here, if any

  function sectionHtml(opts) {
    const kind = opts.kind;
    const id   = opts.id || '';
    const role = opts.role;
    const body = panelBodyHtml(kind, id, role, opts);
    return `
      <div class="att-panel" data-att-kind="${escAttr(kind)}"
           data-att-id="${escAttr(id)}" data-att-role="${escAttr(role)}"
           data-att-label="${escAttr(opts.label || 'Attachments')}"
           data-att-note="${escAttr(opts.note || '')}">
        ${body}
      </div>`;
  }

  function panelBodyHtml(kind, id, role, opts) {
    const s = S();
    const head = `<h4 class="att-head">${esc(opts.label || 'Attachments')}</h4>`
               + (opts.note ? `<p class="small att-muted">${esc(opts.note)}</p>` : '');

    if (s.typesError) {
      return `${head}
        <p class="small att-bad">The list of what may be attached could not be loaded —
          ${esc(s.typesError)}. Nothing can be uploaded until it can.</p>`;
    }
    if (!s.types) return `${head}<p class="small att-muted">Loading…</p>`;

    // Editors only, both halves: the index is granted to `authenticated` and the
    // bucket's policies ask meganet.is_editor(). Say so before the file picker
    // rather than after the upload.
    if (!dbCanWrite()) {
      return `${head}
        <p class="small att-muted">Attachments need a signed-in session — the bucket is private and
          the database refuses anonymous writes.
          <a href="#" onclick="Auth.open();return false">Sign in</a> to add one.</p>`;
    }

    if (!id) {
      return `${head}
        <p class="small att-muted">Save this record first. An attachment hangs off it by foreign key,
          so there has to be a saved row for the file to belong to — the same reason the Council-form
          link waits for a save. Nothing typed is lost by saving now and attaching after.</p>`;
    }

    const rows = listed(kind, id, role);
    return `${head}
      ${uploaderHtml(kind, id, role)}
      ${s.error ? `<p class="small att-bad">${esc(s.error)}
          <button class="btn-link" onclick="Attachments.retry()">Try again</button></p>` : ''}
      ${rows === null ? `<p class="small att-muted">Loading…</p>` : filesHtml(rows)}
      ${s.msg && s.msg.role === role
        ? `<p class="small ${s.msg.kind === 'error' ? 'att-bad' : 'att-ok'}">${esc(s.msg.text)}</p>`
        : ''}`;
  }

  function uploaderHtml(kind, id, role) {
    const s = S();
    const limits = (s.types || []).map(t => `${t.label} to ${mb(t.max_bytes)}`).join(' · ');
    return `
      <div class="att-add">
        <label class="att-file">
          <span>Add ${esc(role === 'canister_config' ? 'a screenshot or dump' : 'a file')}</span>
          <input type="file" multiple accept="${escAttr(acceptList())}"
                 ${s.busy ? 'disabled' : ''}
                 onchange="Attachments.upload(this,'${escAttr(kind)}','${escAttr(id)}','${escAttr(role)}')">
        </label>
        ${s.busy ? `<span class="small att-muted">Uploading…</span>` : ''}
      </div>
      <p class="small att-muted att-limits">${esc(limits)}. Files are stored in a private bucket and
        are only ever shown through a link that expires — nothing here is on the open web.</p>`;
  }

  function filesHtml(rows) {
    if (!rows.length) {
      return `<p class="small att-muted">Nothing attached here yet.</p>`;
    }
    return `<div class="att-list">${rows.map(fileHtml).join('')}</div>`;
  }

  function fileHtml(r) {
    const isImage = String(r.content_type || '').startsWith('image/');
    // The thumbnail's URL is signed and fetched after this string is on screen —
    // see paintThumb(). Rendering the node first and filling it in second keeps
    // the panel synchronous, which is what lets the host build its form as one
    // string like every other section on it.
    const thumb = isImage
      ? `<img class="att-thumb" alt="" data-att-path="${escAttr(r.storage_path)}">`
      : `<span class="att-thumb att-thumb-file" aria-hidden="true">${
           esc((extensionOf(r.title) || extensionOf(r.storage_path) || 'file').toUpperCase())}</span>`;
    return `
      <div class="att-item" data-att-item="${escAttr(r.id)}">
        ${thumb}
        <div class="att-meta">
          <div class="att-name">${esc(r.title || r.storage_path.split('/').pop())}</div>
          <div class="small att-muted">${esc(r.content_type)} · ${esc(mb(r.byte_size || 0))}${
            r.uploaded_by ? ` · ${esc(r.uploaded_by)}` : ''}</div>
          <input type="text" class="att-caption" placeholder="Caption (optional)"
                 value="${escAttr(r.caption || '')}"
                 onchange="Attachments.caption('${escAttr(r.id)}',this.value)">
        </div>
        <div class="att-actions">
          <button onclick="Attachments.open('${escAttr(r.id)}')">Open</button>
          <button onclick="Attachments.remove('${escAttr(r.id)}')">Remove</button>
        </div>
      </div>`;
  }

  // Repaint the panels and nothing else. The host tabs re-render whole forms for
  // a structural change and a keystroke never triggers one; this file follows
  // the same rule, and repainting only its own nodes is what keeps an upload
  // from redrawing a form somebody is typing into.
  function repaint() {
    const panels = document.querySelectorAll('.att-panel');
    for (const el of panels) {
      el.innerHTML = panelBodyHtml(
        el.dataset.attKind, el.dataset.attId, el.dataset.attRole,
        { label: el.dataset.attLabel, note: el.dataset.attNote });
    }
    paintThumbs();
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────
  // A private bucket has no permanent URL, so every image on screen is signed
  // for this session. Cached per object path: the same thumbnail surviving a
  // repaint should not be a second round trip.

  function paintThumbs() {
    for (const img of document.querySelectorAll('img[data-att-path]')) {
      const path = img.dataset.attPath;
      const cached = S().urls[path];
      if (cached) { img.src = cached; continue; }
      if (img.dataset.attPending) continue;
      img.dataset.attPending = '1';
      dbSignedUrl(BUCKET, path, SIGNED_FOR)
        .then(url => {
          S().urls[path] = url;
          for (const el of document.querySelectorAll(`img[data-att-path="${cssEscape(path)}"]`)) {
            el.src = url;
          }
        })
        .catch(() => {
          // A thumbnail that cannot be signed is not worth an error banner over
          // a form — the file is still listed, named and openable, and Open
          // reports properly when it fails.
          img.removeAttribute('data-att-pending');
          img.classList.add('att-thumb-file');
        });
    }
  }

  // Object paths are `<kind>/<uuid>/<uuid>.<ext>` — no quotes, no backslashes,
  // enforced by meganet.attach_file(). This is here so that stays true by
  // construction rather than by the selector happening to work.
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ── Uploading ──────────────────────────────────────────────────────────────

  async function upload(input, kind, id, role) {
    const files = Array.from(input.files || []);
    input.value = '';                       // so the same file can be picked twice
    if (!files.length) return;

    const s = S();
    s.busy = true;
    s.msg = { role, kind: 'busy', text: `Uploading ${files.length} file(s)…` };
    repaint();

    const failed = [];
    let added = 0;
    for (const file of files) {
      try {
        await uploadOne(file, kind, id, role);
        added++;
      } catch (err) {
        failed.push(`${file.name} — ${(err && err.message) || err}`);
      }
    }

    s.busy = false;
    s.msg = failed.length
      ? { role, kind: 'error',
          text: `${added} attached, ${failed.length} refused. ${failed.join(' · ')}` }
      : { role, kind: 'ok', text: `${added} file(s) attached.` };

    // Re-read rather than push what was sent: the index row carries the `ord`
    // and the `uploaded_by` the database decided, and guessing them here would
    // make the panel disagree with the record the next time it is opened.
    reload(kind, id);
  }

  async function uploadOne(file, kind, id, role) {
    const type = typeFor(file);
    if (!type) {
      throw new Error(`${file.type || extensionOf(file.name) || 'that'} is not a kind of file this `
                    + `form accepts`);
    }
    if (file.size > type.max_bytes) {
      throw new Error(`${mb(file.size)} is over the ${mb(type.max_bytes)} limit for ${type.label}`);
    }
    if (!file.size) throw new Error('that file is empty');

    const owner = OWNERS[kind];
    const ext = type.extensions.includes(extensionOf(file.name))
      ? extensionOf(file.name) : type.extensions[0];
    const path = `${owner.prefix}/${id}/${uuid()}.${ext}`;

    await dbUploadObject(BUCKET, path, file);

    try {
      await dbRpc('attach_file', Object.assign({
        p_role_key:     role,
        p_storage_path: path,
        p_content_type: type.content_type,
        p_byte_size:    file.size,
        p_title:        file.name,
        p_taken_at:     file.lastModified ? new Date(file.lastModified).toISOString() : null,
      }, { [owner.arg]: id }));
    } catch (err) {
      // The compensating half. The bytes are up and nothing points at them, so
      // take them down again — best effort, because an orphaned object is a
      // cheaper wrong state than the error the operator actually needs to read
      // being replaced by a second one about the cleanup.
      try { await dbRemoveObject(BUCKET, path); } catch (_) { /* swept later */ }
      throw err;
    }
  }

  // crypto.randomUUID() everywhere it exists — every browser this app supports,
  // over https and over localhost. The fallback is here so a page served from
  // somewhere that is neither still names its objects unguessably rather than
  // throwing halfway through an upload.
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(b)
      : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ── The other three verbs ──────────────────────────────────────────────────

  // On `change` rather than on `input`, deliberately: it means there is no timer
  // in this file, so nothing to register a teardown for — and a caption is saved
  // when the crew moves off it, which is when they have finished typing it.
  function caption(id, text) {
    const row = rowById(id);
    if (!row || (row.caption || '') === text) return;
    dbRpc('update_attachment', { p_id: id, p_patch: { caption: text } })
      .then(saved => {
        row.caption = (saved && saved.caption) || '';
        say(row.role_key, { kind: 'ok', text: 'Caption saved.' });
      })
      .catch(err => say(row.role_key,
        { kind: 'error', text: `Caption not saved — ${(err && err.message) || err}` }));
  }

  async function open(id) {
    const row = rowById(id);
    if (!row) return;
    try {
      const url = await dbSignedUrl(BUCKET, row.storage_path, SIGNED_FOR);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      say(row.role_key, { kind: 'error', text: `Could not open it — ${(err && err.message) || err}` });
    }
  }

  // Index row first, bytes second — attach_file()'s ordering read backwards, and
  // for the same reason. If the object delete fails the file has still gone from
  // the form, which is what was asked for; what is left behind is invisible.
  async function remove(id) {
    const row = rowById(id);
    if (!row) return;
    if (!window.confirm(`Remove ${row.title || 'this file'}? The file itself is deleted, not just `
                      + `the link to it, and it cannot be recovered.`)) return;

    const [kind, ownerId] = String(S().ownerKey || ':').split(':');
    try {
      const out = await dbRpc('detach_file', { p_id: id });
      if (out && out.storage_path) {
        try { await dbRemoveObject(out.storage_bucket || BUCKET, out.storage_path); }
        catch (_) { /* the record no longer points at it; swept later */ }
      }
      say(row.role_key, { kind: 'ok', text: 'Removed.' });
    } catch (err) {
      say(row.role_key, { kind: 'error', text: `Not removed — ${(err && err.message) || err}` });
    }
    reload(kind, ownerId);
  }

  function say(role, msg) {
    S().msg = Object.assign({ role }, msg);
    repaint();
  }

  function reload(kind, id) {
    S().ownerKey = null;          // force ensure() to fetch rather than keep
    ensure(kind, id);
    repaint();
  }

  function retry() {
    const [kind, id] = String(S().ownerKey || ':').split(':');
    if (kind && id) reload(kind, id);
  }

  // ── The host's entry point ─────────────────────────────────────────────────
  // Called from a form's render, once per record. Idempotent: the vocabulary
  // loads once for the session, and the list only refetches when the record on
  // screen changes.

  function forRecord(kind, id) {
    loadTypes();
    if (id && dbCanWrite()) ensure(kind, id);
  }

  return {
    forRecord, sectionHtml, repaint,
    upload, caption, open, remove, retry,
  };
})();
