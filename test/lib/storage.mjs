// The Storage API and the three attachment RPCs, faked (#149).
//
// Both form checks need this and neither should own it, for the same reason
// lib/migration.mjs is shared: two copies of an upload fake would be two things
// to keep in step, and the half that drifts is always the compensating delete.
//
// ── What this deliberately does not do ───────────────────────────────────────
//
// It does not re-implement `meganet.attach_file()`. Every rule that function
// enforces — the path prefix, the uuid leaf, the extension against the content
// type, the size against the type's limit, the role, that the owner exists and
// is not soft-deleted — is proven against a real Postgres by
// `tools/check_attachments.sql`, 47 checks of it. A JavaScript copy of those
// rules here would be exactly the "fixture that tests the copy" that
// lib/migration.mjs exists to avoid: it would pass while the database refused,
// or refuse while the database accepted, and either way the check would be about
// this file.
//
// So the fake accepts and **records**. What the browser sent is the thing under
// test: which object path, in which order, with which owner id and role, and —
// the part that only a browser can answer — whether the bytes went up before the
// index row, and whether a refused index row took the bytes down again.

/** A fresh recorder. Pass the same one to installStorage() and attachmentRpc(). */
export function storageStore() {
  return {
    uploads: [],   // { path, contentType, bytes } in the order they were sent
    signed: [],    // paths a signed URL was asked for
    removed: [],   // paths deleted from the bucket
    rows: [],      // the index, as meganet.attachment rows
    calls: [],     // { fn, body } for every attachment RPC, in order
    seq: 0,
  };
}

/**
 * Serve `…/storage/v1/**`. Installed after the network policy, like the
 * datastore route, so Playwright reaches it before the abort.
 */
export function installStorage(page, store) {
  return page.route('**://*.supabase.co/storage/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const after = url.pathname.replace(/^.*\/storage\/v1\//, '');
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // POST /object/sign/<bucket>/<path>
    if (req.method() === 'POST' && after.startsWith('object/sign/')) {
      const path = after.replace(/^object\/sign\/[^/]+\//, '');
      store.signed.push(path);
      return json(200, { signedURL: `/object/sign/inspections/${path}?token=fixture` });
    }

    // GET of a signed URL — an <img> resolving. One transparent GIF, because a
    // thumbnail that 404s would put an error in the console the check reads.
    if (req.method() === 'GET' && after.startsWith('object/sign/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      });
    }

    // POST /object/<bucket>/<path> — the bytes.
    if (req.method() === 'POST' && after.startsWith('object/')) {
      const path = after.replace(/^object\/[^/]+\//, '');
      store.uploads.push({
        path,
        contentType: req.headers()['content-type'] || '',
        bytes: (req.postDataBuffer() || Buffer.alloc(0)).length,
      });
      return json(200, { Key: after });
    }

    // DELETE /object/<bucket>/<path>
    if (req.method() === 'DELETE' && after.startsWith('object/')) {
      store.removed.push(after.replace(/^object\/[^/]+\//, ''));
      return json(200, { message: 'Successfully deleted' });
    }

    return json(404, { message: `the storage fixture does not serve ${req.method()} ${after}` });
  });
}

/**
 * The three RPCs 0010 adds. Returns a response body, or `undefined` if `fn` is
 * not one of them — so a test's own route can fall through to its other
 * functions.
 */
export function attachmentRpc(fn, body, store) {
  if (fn !== 'attach_file' && fn !== 'update_attachment' && fn !== 'detach_file') return undefined;
  store.calls.push({ fn, body });

  if (fn === 'attach_file') {
    // ord and uploaded_by are the database's to decide, so the fixture decides
    // them too — the panel re-reads the list after an upload precisely because
    // it must not guess these, and a fixture that echoed what was sent would
    // make that re-read look unnecessary.
    const row = {
      id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`,
      inspection_id: body.p_inspection_id || null,
      maintenance_activity_id: body.p_maintenance_activity_id || null,
      role_key: body.p_role_key,
      ord: store.rows.length + 1,
      title: body.p_title || '',
      caption: body.p_caption || '',
      storage_bucket: 'inspections',
      storage_path: body.p_storage_path,
      content_type: body.p_content_type,
      byte_size: body.p_byte_size,
      taken_at: body.p_taken_at || null,
      uploaded_by: 'fixture@example.test',
      created_at: '2026-08-13T03:00:00Z',
    };
    store.rows.push(row);
    return row;
  }

  if (fn === 'update_attachment') {
    const row = store.rows.find(r => r.id === body.p_id);
    if (!row) return { message: 'no such attachment' };
    Object.assign(row, body.p_patch);
    return row;
  }

  const i = store.rows.findIndex(r => r.id === body.p_id);
  if (i < 0) return { removed: false };
  const [row] = store.rows.splice(i, 1);
  return { removed: true, storage_bucket: row.storage_bucket, storage_path: row.storage_path };
}

/** The index, as `GET /attachment?…` would answer it. */
export function attachmentRows(store, query) {
  const insp = /inspection_id=eq\.([^&]+)/.exec(query);
  const act  = /maintenance_activity_id=eq\.([^&]+)/.exec(query);
  return store.rows.filter(r =>
    (insp && r.inspection_id === decodeURIComponent(insp[1]))
    || (act && r.maintenance_activity_id === decodeURIComponent(act[1])));
}

/** A file for setInputFiles(), sized to order. */
export function fileOf(name, mimeType, bytes) {
  return { name, mimeType, buffer: Buffer.alloc(bytes, 0x41) };
}
