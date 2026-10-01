// MegaNet — log-follow.js
//
//   LogFollow   follows a log file as it grows: the stand-in for a serial port
//               on a computer that will not hand the browser one. PuTTY (or any
//               terminal) logs the port to a file; this re-reads that file every
//               second and passes on whatever has been appended.
//
// After core.js (esc), before alert2.js and serial.js, which use it. Neither it
// nor they run anything at load, so the order states the dependency rather than
// enforcing one — index.html holds the order.
//
// The obvious way does not work, and that is the reason this file exists. Pick
// the log once, keep the File, read it again a second later: Chromium refuses
// the second read as soon as the file on disk has changed — NotReadableError,
// "the requested file could not be read, typically due to permission problems
// that have occurred after a reference to a file was acquired". A File from an
// <input type=file> or from a drop is a snapshot, and a snapshot of a growing
// log is stale the moment PuTTY writes the next line. Every way in below exists
// to get a fresh snapshot on each tick instead:
//
//   picker   the File System Access API. showOpenFilePicker() hands back a
//            handle, and handle.getFile() is a new snapshot every time. One
//            click — but it is the API a managed Chrome or Edge switches off
//            (DefaultFileSystemReadGuardSetting = 2, or the site listed under
//            FileSystemReadBlockedForUrls), and then the picker, and getFile()
//            on any handle at all, fail with NotAllowedError.
//   drop     the log dragged in from File Explorer, read through the older File
//            and Directory Entries API: webkitGetAsEntry() during the drop,
//            then entry.file() on every tick — again a new snapshot each time.
//            That API is not the one the policy governs. Measured on Chromium
//            141 with DefaultFileSystemReadGuardSetting = 2: the picker refused,
//            getFile() on the handle from the very same drop refused, and
//            entry.file() kept returning the file as it grew and when it was
//            truncated. Firefox and Safari carry the same API.
//   folder   the folder PuTTY logs into, dropped the same way. Its listing is
//            live, so this follows whichever log in it was written last — what
//            a PuTTY log name with &Y&M&D&T in it needs, a new file a session.
//   manual   where none of that is on offer: one more pick (or drop) per read.
//            Each pick is a fresh snapshot, and only the bytes past what was
//            already read are passed on, so the reader never sees a line twice.
//
// What comes out is bytes (onData), in order, never repeated. A file that gets
// shorter was started again (PuTTY's "overwrite" on a new session) and is read
// from the top, said through onReset. What the bytes are is the caller's
// business: the Serial Monitor runs them through the same pipeline a port's
// bytes take, and the ALERT2 tab appends them to its capture.

const LogFollow = (function () {
  const TICK_MS = 1000;
  const FIRST_MAX = 4 * 1024 * 1024;   // the most of an existing file the first read takes
  const CHUNK_MAX = 1024 * 1024;       // the most any one read takes; the rest follows at once
  const RESCAN_TICKS = 5;              // a followed folder is listed again every fifth tick
  const LOG_NAME = /\.(log|txt|csv|dat|hex|cap)$/i;

  function canPick() { return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'; }

  // A drag that is carrying files, as against text or a link. Decides whether a
  // dragover is ours to accept — accepting every drag would swallow text drops.
  function isFileDrag(e) {
    const t = e && e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }

  // ── sources: something that hands out a fresh File on each call ──────────────

  function fileOf(entry) { return new Promise((res, rej) => entry.file(res, rej)); }

  function listDir(dir) {
    return new Promise((res, rej) => {
      const reader = dir.createReader(), out = [];
      const step = () => reader.readEntries(batch => {
        if (!batch.length) { res(out); return; }
        for (let i = 0; i < batch.length; i++) out.push(batch[i]);
        step();
      }, rej);
      step();
    });
  }

  function handleSource(handle) {
    return { via: 'picker', live: true, name: handle.name, latest: () => handle.getFile() };
  }

  function entrySource(entry) {
    return { via: 'drop', live: true, name: entry.name, latest: () => fileOf(entry) };
  }

  // The newest log in the folder: listed again every few ticks, so a new
  // session's file is picked up within seconds of PuTTY creating it.
  function folderSource(dir) {
    const src = { via: 'folder', live: true, folder: dir.name, name: '', entry: null, ticks: 0, switched: false };
    src.latest = async () => {
      if (!src.entry || src.ticks % RESCAN_TICKS === 0) await rescan(src, dir);
      src.ticks++;
      return src.entry ? fileOf(src.entry) : null;
    };
    return src;
  }

  async function rescan(src, dir) {
    const files = (await listDir(dir)).filter(e => e.isFile);
    const logs = files.filter(e => LOG_NAME.test(e.name));
    let best = null, bestT = -Infinity;
    for (const e of (logs.length ? logs : files)) {
      try { const f = await fileOf(e); if (f.lastModified > bestT) { best = e; bestT = f.lastModified; } } catch (_) {}
    }
    if (best && (!src.entry || best.name !== src.entry.name)) {
      if (src.entry) src.switched = true;
      src.entry = best;
      src.name = best.name;
    }
  }

  function fileSource(file) {
    const src = { via: 'manual', live: false, name: file.name, file };
    src.latest = () => Promise.resolve(src.file);
    return src;
  }

  // ── the ways in ─────────────────────────────────────────────────────────────

  // { src } on a pick, null when the dialog was dismissed, { error } when the
  // browser refused — which on a managed machine is the usual answer, and must
  // be said rather than swallowed.
  //
  // A dismissal is told from a suppressed dialog the way serial.js tells a
  // cancelled port picker from a blocked one: by time. Nobody sees a dialog
  // and closes it inside PICKER_INSTANT_MS, so a rejection that fast is the
  // browser declining to show one, and is said as such.
  const PICKER_INSTANT_MS = 350;
  async function pick() {
    if (!canPick()) return { error: { name: 'Unsupported', message: 'showOpenFilePicker is not available in this browser' } };
    const t0 = Date.now();
    try {
      const picked = await window.showOpenFilePicker({ id: 'meganet-log', multiple: false,
        types: [{ description: 'Terminal log', accept: { 'text/plain': ['.log', '.txt', '.csv', '.hex', '.dat'] } }] });
      return picked && picked[0] ? { src: handleSource(picked[0]) } : null;
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotFoundError')) {
        return Date.now() - t0 < PICKER_INSTANT_MS ? { error: { name: 'Suppressed', message: e.message } } : null;
      }
      return { error: e };
    }
  }

  // From a drop event's DataTransfer. Synchronous on purpose: the items are
  // only readable while the drop event is being dispatched, so this has to run
  // inside the handler, before any await.
  function fromDrop(dt) {
    const items = dt && dt.items ? Array.prototype.filter.call(dt.items, i => i.kind === 'file') : [];
    let entry = null;
    for (const it of items) {
      const e = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
      if (e) { entry = e; break; }
    }
    const more = Math.max(0, items.length - 1);
    if (entry && entry.isDirectory) return { src: folderSource(entry), more };
    if (entry && entry.isFile) return { src: entrySource(entry), more };
    const file = dt && dt.files && dt.files[0];
    if (file) return { src: fileSource(file), more };
    return { error: { name: 'NoFile', message: 'Nothing in that drop was a file.' } };
  }

  function fromFile(file) { return { src: fileSource(file) }; }

  // The first `n` bytes of whatever the source points at now — for sniffing
  // what a log holds before deciding what reads it.
  async function peek(src, n) {
    const f = await src.latest();
    return f ? new Uint8Array(await f.slice(0, n || 65536).arrayBuffer()) : new Uint8Array(0);
  }

  // ── the follower ──────────────────────────────────────────────────────────

  // opts: fromStart (read what is already there; else start at its end),
  // offset (resume at this byte instead), intervalMs, onData(u8, { from, size, name }), onReset(why, name),
  // onError(e, fatal), onTick(follower).
  function start(src, opts) {
    opts = opts || {};
    const f = {
      src, offset: 0, size: 0, bytes: 0, reads: 0, ticks: 0, fails: 0,
      started: Date.now(), lastCheck: 0, lastGrow: 0, trimmed: 0, running: true, err: null,
      first: true, busy: false, timer: 0,
      stop() { f.running = false; clearTimeout(f.timer); f.timer = 0; },
      readNow() { clearTimeout(f.timer); return tick(); },
      // Manual: a fresh snapshot of the file, picked or dropped again. A
      // different name is a different file, read from its top.
      feed(file) {
        if (file.name !== src.name) { src.name = file.name; if (!f.first) { f.offset = 0; say('reset', 'switched'); } }
        src.file = file;
        return tick();
      },
    };
    // Following again after a stop: carry on from where it stopped, so what
    // was written in between is read now and nothing is read twice.
    if (opts.offset != null) { f.offset = opts.offset; f.first = false; }
    const say = (what, a, b) => {
      const fn = what === 'reset' ? opts.onReset : what === 'error' ? opts.onError : null;
      if (fn) { try { fn(a, b); } catch (e) { console.warn('[LogFollow]', e); } }
    };

    async function tick() {
      if (f.busy || (!f.running && src.live)) return;
      f.busy = true;
      let more = false;
      try {
        const file = await src.latest();
        f.lastCheck = Date.now();
        f.ticks++;
        if (file) {
          if (src.switched) { src.switched = false; f.offset = 0; f.first = false; say('reset', 'switched', src.name); }
          if (f.first) {
            f.first = false;
            if (!opts.fromStart) f.offset = file.size;
            else if (file.size > FIRST_MAX) { f.offset = file.size - FIRST_MAX; f.trimmed = f.offset; }
          }
          if (file.size < f.offset) { f.offset = 0; say('reset', 'shorter', src.name); }
          f.size = file.size;
          if (file.size > f.offset) {
            const from = f.offset, end = Math.min(file.size, from + CHUNK_MAX);
            const buf = await file.slice(from, end).arrayBuffer();
            f.offset = end; f.bytes += buf.byteLength; f.reads++; f.lastGrow = Date.now();
            more = end < file.size;
            if (opts.onData) opts.onData(new Uint8Array(buf), { from, size: file.size, name: src.name });
          }
        }
        f.fails = 0; f.err = null;
      } catch (e) {
        f.fails++;
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          // Refused outright — a policy, or a permission taken back. Polling
          // a refusal every second helps nobody: stop and say so.
          f.err = e; f.stop(); say('error', e, true);
        } else if (f.fails === 3) {
          // NotReadableError on its own is the snapshot going stale between
          // taking it and reading it, and the next tick takes a fresh one.
          // Three in a row is something else — moved, deleted, locked — and
          // is worth saying, though the follower keeps looking.
          f.err = e; say('error', e, false);
        }
      } finally {
        f.busy = false;
      }
      if (opts.onTick) { try { opts.onTick(f); } catch (e) { console.warn('[LogFollow]', e); } }
      if (f.running && src.live) f.timer = setTimeout(tick, more ? 0 : (opts.intervalMs || TICK_MS));
    }

    f.timer = setTimeout(tick, 0);
    return f;
  }

  // ── words ─────────────────────────────────────────────────────────────────

  // One line on what is being followed and how, for a card's head.
  function describe(src) {
    if (!src) return '';
    if (src.via === 'folder') return 'Log folder ' + src.folder + (src.name ? ' — newest file ' + src.name : ' — no log in it yet');
    if (src.via === 'manual') return 'Log file ' + src.name + ' — read on request';
    return 'Log file ' + src.name;
  }

  // Why a pick failed, as HTML (only `e` is escaped; the rest is ours). Every
  // one ends on the way round it, because there is one — the drop — and an
  // operator cannot be expected to know a refused picker has a way round.
  function refusal(e) {
    const name = (e && e.name) || '';
    const msg = esc((e && e.message) || String(e || ''));
    const drag = ' <b>Drag the log file onto this page from File Explorer instead</b> — a dropped file is followed just '
      + 'the same, and that policy does not cover it.';
    if (name === 'NotAllowedError') return '<b>The browser\'s file picker is switched off on this computer.</b> Chrome and '
      + 'Edge let IT turn the File System Access API off by policy (<code>DefaultFileSystemReadGuardSetting</code>, or this site '
      + 'under <code>FileSystemReadBlockedForUrls</code>), and a blocked picker fails like this, without a dialog.' + drag
      + ' <span class="spec">' + msg + '</span>';
    if (name === 'SecurityError') return '<b>The browser refused the file picker.</b> It needs the page on https or localhost, '
      + 'and not inside a frame that is not allowed one.' + drag + ' <span class="spec">' + msg + '</span>';
    if (name === 'Suppressed') return '<b>No file dialog appeared.</b> The browser closed the picker before anyone could have '
      + 'seen it, which is what a picker blocked on this computer can look like. (If you did see a dialog and closed it, '
      + 'ignore this.)' + drag + ' <span class="spec">' + msg + '</span>';
    if (name === 'Unsupported') return '<b>This browser has no file picker that can follow a file.</b> Drag the log file '
      + 'onto this page from File Explorer instead — that follows it in Chrome, Edge, Firefox and Safari alike.';
    return '<b>Could not pick a file to follow.</b>' + drag + ' <span class="spec">' + esc(name ? name + ': ' : '') + msg + '</span>';
  }

  // Why following stopped or stalled, as plain text.
  function trouble(e, src, fatal) {
    const n = src && src.name ? src.name : 'the log';
    const name = (e && e.name) || '';
    if (fatal && name === 'NotAllowedError') return 'The browser stopped letting this page read ' + n + ' (a policy on this computer). '
      + 'Drag the file onto the card from File Explorer to follow it again — that way is not covered by the policy.';
    if (fatal) return 'Stopped following ' + n + ': ' + ((e && e.message) || e) + '. Drag the file onto the card to follow it again.';
    if (name === 'NotFoundError') return 'Cannot find ' + n + ' — moved, renamed or deleted? Still looking for it every second.';
    return 'Could not read ' + n + ' three times running (' + ((e && e.message) || name || e) + ') — another program may have it '
      + 'locked. Still trying every second.';
  }

  return { canPick, isFileDrag, pick, fromDrop, fromFile, peek, start, describe, refusal, trouble, FIRST_MAX };
})();

if (typeof window !== 'undefined') window.LogFollow = LogFollow;
