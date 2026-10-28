// Replays a cleaned PuTTY log through A2Terminal (a2-terminal.js): what the
// technician typed at each prompt is typed into the engine, and every line the
// engine prints is held to the log's. Blank lines and the unit's screen
// clears are left out on both sides — a log holds them as runs of empty lines
// that PuTTY's captures do not keep reliably. Returns { ok, n, at, want, got }:
// n lines matched, and where it parted from the log if it did.

// A PuTTY capture as the lines it would show: escape sequences out,
// backspaces applied, blank lines and PuTTY's own banner dropped.
export function cleanLog(buf) {
  const t = buf.toString('latin1').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const out = [];
  for (const ch of t) { if (ch === '\b') { if (out.length && out[out.length - 1] !== '\n') out.pop(); } else out.push(ch); }
  return out.join('').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() && !/^=~=~=/.test(l));
}

// What differs unit to unit and is not the engine's to know: the clock, the
// address in the header, build numbers, the serial number.
const norm = l => l
  .replace(/^\t\d\d-\w\w\w-\d{4} \d\d:\d\d:\d\d UTC; Station Address: \d+/, '\t<date>; Station Address')
  .replace(/(Host Bootloader: v1\.3 - 9967):[\d:]+/, '$1')
  .replace(/(Radio Firmware: v1\.4) \[[^\]]+\] \(\d+\)/, '$1 [..] (..)')
  .replace(/Serial Number: \d+/, 'Serial Number: N')
  // Tx Power's prompt backspaces over its own value, which a capture erases.
  .replace(/^(\t\tTx Power)\b.*$/, '$1')
  .replace(/\s+$/, '');

export function replay(T, log, opts = {}) {
  const e = T.create({ ...(opts.create || {}), keepAll: true });
  let i = 0, n = 0, printed = 0;
  const seen = () => e.lines.filter(l => !l.clear && l.t.trim() && !/^\[ /.test(l.t));
  // The engine's finished lines held to the log's; its open one as a prefix
  // (at a value prompt, only the prompt before the value it holds).
  function check() {
    const L = seen();
    while (printed < L.length) {
      const l = L[printed];
      const want = log[i];
      if (want == null) return { ok: true, n };
      if (l.open) {
        const head = e.at.k === 'value' && e.ed ? l.t.slice(0, e.ed.base) : e.at.k === 'onekey' ? l.t.slice(0, -2) : l.t;
        if (!norm(want).startsWith(norm(head))) return { ok: false, n, at: i, want, got: l.t };
        return null;
      }
      if (norm(want) !== norm(l.t)) return { ok: false, n, at: i, want, got: l.t };
      printed++; i++; n++;
      if (opts.stop && i >= opts.stop) return { ok: true, n };
    }
    return null;
  }
  T.key(e, 'Enter');
  for (let guard = 0; guard < 50000; guard++) {
    const r = check();
    if (r) return r;
    if (i >= log.length || (opts.stop && i >= opts.stop)) return { ok: true, n };
    if (/^\tTimed out - Exiting$/.test(log[i])) { T.timeout(e); continue; }
    if (!e.link) {
      T.reconnect(e);
      if (opts.resetOnHost && /remove the USB to restart/.test(log[i - 1] || '')) { T.reset(e); T.reconnect(e); }
      T.key(e, 'Enter');
      continue;
    }
    const open = seen()[printed];
    if (!open || !open.open) return { ok: false, n, at: i, want: log[i], got: '(nothing open)' };
    const k = e.at.k;
    // Show I/O Values redraws its Raw row in place: a log holds a line per redraw.
    if (k === 'stream') { while (/^Raw\t/.test(log[i + 1] || '')) i++; }
    const head = k === 'value' && e.ed ? e.ed.base : k === 'onekey' ? open.t.length - 2 : open.t.length;
    const typed = log[i].slice(head);
    if (!typed && /^\tTimed out - Exiting$/.test(log[i + 1] || '')) { T.timeout(e); continue; }
    if (k === 'password') { T.type(e, 'x'.repeat(typed.length || 1)); continue; }
    if (k === 'value') { T.type(e, typed); continue; }
    if (k === 'onekey') { T.key(e, typed ? typed[0] : 'Enter'); continue; }
    if (typed) for (const ch of typed) T.key(e, ch); else T.key(e, 'Enter');
  }
  return { ok: false, n, at: i, want: log[i], got: '(guard)' };
}
