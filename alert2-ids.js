// MegaNet — alert2-ids.js
//
// Alert2Ids — the ALERT2 half of the 🔗 ALERT IDs tab. Legacy ALERT addresses
// (1–8,191) are the tab's wheel, grid and pass ranges; ALERT2 addresses
// (1–65,534) are a different space and a different question, so they get a
// view of their own behind the tab's ALERT / ALERT2 switch:
//
//   · every ALERT2 ID Flood-Net knows of, from three places — the station
//     register (station.alert2_station_id, and each sensor's ALERT2 slot), the
//     slot table on file (0120, tdma-slots.js) and what the base stations
//     decoded over 90 days (tdma_heard(), from the daily reception rollup);
//   · a row an ID: the station(s) holding it and their sensor numbers, its
//     site and slots on the slot table, what was heard, and the checks;
//   · a free-ID finder: the next IDs no station, no slot and no base station
//     has used, from a starting number.
//
// One ID may belong to several stations at one site (0121) — a weir's HW and
// TW gauges on one logger — told apart by sensor number. The checks say when
// that split is incomplete: a holder with no sensor numbers, whose readings
// would reach no station.
//
// The pure parts (rows, filter, free) take plain arrays, for test/alert2-ids.mjs.
//
// Exposes: Alert2Ids.
// Requires at call time: core.js (esc, escAttr, termHtml, csvEscape, dlText,
// stationSensors, state), datastore.js (dbRpc), tdma-slots.js (TdmaSlots),
// app.js (goToStation, openEditor).

const Alert2Ids = (function () {
  const HEARD_DAYS = 90;
  const HEARD_MIN = 3;
  const A2_MAX = 65534;

  const WORDS = {
    a2id: 'An ALERT2 address (1–65,534): what a transmitter sends under. A different space from legacy ALERT addresses (1–8,191); the same number in each is two different things.',
    slot: 'The sensor number inside an ALERT2 report (0–255). Where stations share an ID, it says which station a value belongs to.',
    shared: 'One ALERT2 ID held by more than one station at one site — usually a weir\'s headwater and tailwater gauges on one logger — told apart by sensor number.',
    heard: `What the base stations decoded of this ID in the last ${HEARD_DAYS} days: reports it sent, and reports from others it passed on as a repeater.`,
    sites: 'Where this ID is on the slot table on file (the ⏱️ TDMA Planner): the site as the slot sheet names it, its channel and time slots.',
    free: `Not held by any station, not on the slot table, and not decoded by any base station in ${HEARD_DAYS} days — as far as Flood-Net knows, nobody uses it.`,
    stranger: `Decoded at least ${HEARD_MIN} times in ${HEARD_DAYS} days, but no station in the register holds it.`,
  };
  const GLOSSARY = [['a2id', 'ALERT2 ID'], ['slot', 'Sensor number'], ['shared', 'Shared'], ['heard', 'Heard'],
                    ['sites', 'Slot table'], ['stranger', 'Heard, no station'], ['free', 'Free']];

  // ── 1. pure ────────────────────────────────────────────────────────────────
  const fkey = f => Number(f).toFixed(4);
  const fmtMhz = f => { const s = Number(f).toFixed(4).replace(/0+$/, ''); return s.endsWith('.') ? s + '0' : s; };
  const sensorsOf = s => (typeof stationSensors === 'function' ? stationSensors(s) : (s && s.sensors) || []) || [];
  const slotsOfStation = s => [...new Set(sensorsOf(s).filter(x => x && x.alert2_sensor_id != null).map(x => Number(x.alert2_sensor_id)))].sort((a, b) => a - b);

  function runsOf(starts, slotS) {
    const xs = [...starts].map(Number).sort((a, b) => a - b), out = [];
    for (const x of xs) { const l = out[out.length - 1]; if (l && Math.abs(l.start + l.n * slotS - x) < 1e-6) l.n++; else out.push({ start: x, n: 1 }); }
    return out;
  }
  const sec = v => (Number.isInteger(Number(v)) ? String(Number(v)) : String(Math.round(Number(v) * 100) / 100));
  const runText = (r, slotS) => (r.n === 1 ? `${sec(r.start)} s` : `${sec(r.start)}–${sec(r.start + (r.n - 1) * slotS)} s`);

  // Every ALERT2 ID from the three sources, a row each, in number order.
  //   stations: [{ id, name, alert2_station_id, sensors }]
  //   slots:    tdma_slot rows; channels: tdma_channel rows
  //   heard:    tdma_heard() rows, or null when it could not be read
  function rows(o) {
    const { stations = [], slots = [], channels = [], heard } = o;
    const by = new Map();
    const row = id => { if (!by.has(id)) by.set(id, { id, holders: [], sites: [], heard: [] }); return by.get(id); };
    for (const s of stations) if (s && s.alert2_station_id != null && s.alert2_station_id !== '') {
      row(Number(s.alert2_station_id)).holders.push({ id: s.id, name: s.name || s.id, slots: slotsOfStation(s) });
    }
    const chan = new Map(channels.map(c => [fkey(c.freq_mhz), c]));
    const siteBy = new Map();
    for (const t of slots) if (t.alert2_id != null) {
      const k = `${t.alert2_id}\u0000${t.site}\u0000${fkey(t.freq_mhz)}`;
      if (!siteBy.has(k)) siteBy.set(k, { id: Number(t.alert2_id), site: t.site, freq: fkey(t.freq_mhz), starts: [] });
      siteBy.get(k).starts.push(Number(t.slot_s));
    }
    for (const v of siteBy.values()) {
      const c = chan.get(v.freq), slotS = c ? Number(c.slot_s) || 0.5 : 0.5;
      row(v.id).sites.push({ site: v.site, freq: v.freq, runs: runsOf(v.starts, slotS).map(r => runText(r, slotS)), count: v.starts.length });
    }
    const heardChans = new Set();
    for (const h of heard || []) {
      const n = (Number(h.as_source) || 0) + (Number(h.as_relay) || 0);
      if (!n) continue;
      heardChans.add(fkey(h.freq_mhz));
      const id = Number(h.alert2_id);
      if (!(id >= 1 && id <= A2_MAX)) continue;
      const known = by.has(id);
      if (!known && (Number(h.as_source) || 0) < HEARD_MIN) continue;   // a stray decode is not an ID in use
      row(id).heard.push({ freq: fkey(h.freq_mhz), source: Number(h.as_source) || 0, relay: Number(h.as_relay) || 0, last: h.last_heard || null });
    }
    const out = [...by.values()].sort((a, b) => a.id - b.id);
    for (const r of out) r.checks = checksOf(r, heard != null, heardChans);
    return out;
  }

  function checksOf(r, haveHeard, heardChans) {
    const c = [];
    const sent = r.heard.reduce((a, h) => a + h.source, 0), passed = r.heard.reduce((a, h) => a + h.relay, 0);
    if (!r.holders.length && sent >= HEARD_MIN) {
      c.push({ k: 'stranger', level: 'warn', text: r.sites.length ? `No station holds it; the slot table calls it ${[...new Set(r.sites.map(s => s.site))].join(', ')}`
                                                              : 'Heard, but no station holds it and it is not on the slot table' });
    } else if (!r.holders.length && r.sites.length) {
      c.push({ k: 'no-station', level: 'info', text: `On the slot table as ${[...new Set(r.sites.map(s => s.site))].join(', ')}; no station holds it` });
    }
    if (r.holders.length > 1) {
      const bare = r.holders.filter(h => !h.slots.length);
      const seen = new Map(), clash = [];
      for (const h of r.holders) for (const n of h.slots) { if (seen.has(n)) clash.push(n); else seen.set(n, h); }
      if (bare.length) c.push({ k: 'shared-bare', level: 'warn', text: `Shared, but ${bare.map(h => h.name).join(', ')} list${bare.length === 1 ? 's' : ''} no sensor numbers: its readings reach no station` });
      else if (clash.length) c.push({ k: 'shared-clash', level: 'warn', text: `Shared, and sensor ${[...new Set(clash)].join(', ')} is on two stations` });
      else c.push({ k: 'shared', level: 'info', text: `Shared by ${r.holders.length} stations, told apart by sensor number` });
    }
    if (haveHeard && r.holders.length && !sent && !passed) {
      const onHeardChan = !r.sites.length || r.sites.some(s => heardChans.has(s.freq));
      if (onHeardChan) c.push({ k: 'unheard', level: 'warn', text: `Not heard in ${HEARD_DAYS} days` });
    }
    if (haveHeard && !sent && passed) c.push({ k: 'relay-only', level: 'info', text: 'Heard only passing others\' reports on — its own were not decoded' });
    const offFile = r.sites.length && r.heard.length && r.heard.some(h => h.source + h.relay > 0) && !r.heard.some(h => r.sites.some(s => s.freq === h.freq));
    if (offFile) c.push({ k: 'other-channel', level: 'warn', text: `Heard on ${[...new Set(r.heard.map(h => fmtMhz(h.freq)))].join(', ')} MHz; the slot table has it on ${[...new Set(r.sites.map(s => fmtMhz(s.freq)))].join(', ')} MHz` });
    if ((r.holders.length || sent) && !r.sites.length) c.push({ k: 'no-slot', level: 'info', text: 'No slot on file' });
    return c;
  }

  // The filter box: an ID, a range "10000-10100", or words in a name.
  function matches(r, q) {
    q = String(q || '').trim();
    if (!q) return true;
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(q);
    if (range) { const lo = Math.min(+range[1], +range[2]), hi = Math.max(+range[1], +range[2]); return r.id >= lo && r.id <= hi; }
    if (/^\d+$/.test(q)) return String(r.id).startsWith(q) || r.holders.some(h => String(h.id) === q);
    const w = q.toLowerCase();
    return r.holders.some(h => `${h.name} ${h.id}`.toLowerCase().includes(w)) || r.sites.some(s => s.site.toLowerCase().includes(w));
  }

  // The next n IDs from `from` that nothing uses.
  function free(all, from, n) {
    const used = new Set(all.map(r => r.id));
    const out = [];
    for (let id = Math.max(1, Math.floor(Number(from) || 1)); id <= A2_MAX && out.length < n; id++) if (!used.has(id)) out.push(id);
    return out;
  }

  // IDs in use, by block of a thousand.
  function blocks(all) {
    const m = new Map();
    for (const r of all) { const b = Math.floor(r.id / 1000) * 1000; m.set(b, (m.get(b) || 0) + 1); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([lo, n]) => ({ lo, hi: lo + 999, n }));
  }

  // ── 2. state ───────────────────────────────────────────────────────────────
  let heard = undefined;   // undefined: not asked; null: failed; array: rows
  let asking = null;
  let filter = '';
  let from = 10000;

  function stations() { return (typeof state !== 'undefined' && state.data && state.data.stations) || []; }
  function ask() {
    if (asking || heard !== undefined) return asking || Promise.resolve();
    const tds = typeof TdmaSlots !== 'undefined' ? TdmaSlots.ask() : Promise.resolve();
    const h = typeof dbRpc === 'function' ? dbRpc('tdma_heard', { p_days: HEARD_DAYS }).then(x => (Array.isArray(x) ? x : null), () => null) : Promise.resolve(null);
    asking = Promise.all([tds, h]).then(([, x]) => { heard = x; }).finally(() => { asking = null; repaint(); });
    return asking;
  }
  function current() {
    const D = typeof TdmaSlots !== 'undefined' && TdmaSlots.data ? TdmaSlots.data() : null;
    return rows({ stations: stations(), slots: D ? D.slots : [], channels: D ? D.channels : [], heard: Array.isArray(heard) ? heard : null });
  }

  // ── 3. the page ────────────────────────────────────────────────────────────
  function pageHtml() {
    ask();
    return `<div id="a2i-root" class="stack">${bodyHtml()}</div>`;
  }
  function bodyHtml() {
    const all = current();
    const shown = all.filter(r => matches(r, filter));
    const n = k => all.filter(r => r.checks.some(c => c.k === k)).length;
    const holders = stations().filter(s => s && s.alert2_station_id != null && s.alert2_station_id !== '').length;
    const loading = heard === undefined || asking;
    return `<div class="panel">
        <div class="panel-header"><h2>ALERT2 IDs</h2>${all.length ? '<div class="button-group"><button type="button" onclick="Alert2Ids.exportCsv()">⤓ ALERT2 IDs CSV</button></div>' : ''}</div>
        <div class="stats stats-row">
          <div>${termHtml('ALERT2 IDs', WORDS.a2id)} known: <strong>${all.length}</strong></div>
          <div>Stations holding one: <strong>${holders}</strong></div>
          <div>On the slot table: <strong>${all.filter(r => r.sites.length).length}</strong></div>
          <div>${termHtml('Heard', WORDS.heard)} (${HEARD_DAYS} days): <strong>${heard == null ? '—' : all.filter(r => r.heard.length).length}</strong></div>
          <div>${termHtml('Shared', WORDS.shared)}: <strong>${all.filter(r => r.holders.length > 1).length}</strong></div>
          <div class="${n('stranger') ? 'stat-bad' : ''}">${termHtml('Heard, no station', WORDS.stranger)}: <strong>${n('stranger')}</strong></div>
        </div>
        <label class="pr-filter">Filter by ALERT2 ID, ID range or station or site name
          <input type="search" id="a2i-filter" value="${escAttr(filter)}" placeholder="e.g. 11047, 10000-10999 or Bromelton…" oninput="Alert2Ids.onFilter(this.value)">
        </label>
        <p class="small">An ALERT2 ID is set on a station in its editor (<em>ALERT2 station address</em>), and each sensor's number beside it
          (<em>A2 slot</em>). Stations at one site may share an ID when their sensor numbers differ. Slots and sites are on the
          <button type="button" class="link-btn" onclick="switchTab('tdma')">⏱️ TDMA Planner</button>.
          ${loading ? '<span class="txt-muted">Reading the slot table and what was heard…</span>' : heard === null ? '<span class="txt-muted">What the base stations heard could not be read, so the on-air checks are left out.</span>' : ''}</p>
        <p id="a2i-found" class="sr-only" role="status" aria-live="polite">${filter ? esc(`${shown.length} of ${all.length} ALERT2 IDs`) : ''}</p>
      </div>
      ${freeHtml(all)}
      <div id="a2i-table">${tableHtml(shown, all.length)}</div>
      ${wordsHtml()}`;
  }

  function holderHtml(h) {
    return `<button type="button" class="link-btn" onclick="goToStation('${escAttr(h.id)}')">${esc(h.name)}</button>${
      h.slots.length ? ` <span class="small txt-muted">sensor${h.slots.length === 1 ? '' : 's'} ${esc(h.slots.join(', '))}</span>` : ''}`;
  }
  const fmtN = v => Number(v).toLocaleString('en-AU');
  function dmy(iso) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(iso || '')); return m ? `${Number(m[3])}/${Number(m[2])}` : ''; }
  function heardHtml(r) {
    if (heard == null) return '<span class="txt-muted">—</span>';
    if (!r.heard.length) return '<span class="txt-muted">not heard</span>';
    return r.heard.map(h => `${esc(fmtMhz(h.freq))} MHz: ${[h.source ? `${fmtN(h.source)} sent` : '', h.relay ? `${fmtN(h.relay)} passed on` : ''].filter(Boolean).join(', ')}${
      h.last ? ` <span class="small txt-muted">last ${esc(dmy(h.last))}</span>` : ''}`).join('<br>');
  }
  function tableHtml(shown, total) {
    const body = shown.map(r => `<tr>
        <th scope="row" class="tdp-num">${r.id}</th>
        <td>${r.holders.map(holderHtml).join('<br>') || '<span class="txt-muted">—</span>'}</td>
        <td>${r.sites.map(s => `${esc(s.site)} <span class="small txt-muted">${esc(fmtMhz(s.freq))} MHz, ${esc(s.runs.join(', '))}</span>`).join('<br>') || '<span class="txt-muted">—</span>'}</td>
        <td>${heardHtml(r)}</td>
        <td class="small">${r.checks.map(c => `<span class="${c.level === 'warn' ? 'txt-warn' : 'txt-muted'}">${esc(c.text)}</span>`).join('<br>') || '<span class="txt-muted">—</span>'}</td>
      </tr>`).join('');
    return `<div class="panel"><h3 id="a2i-h-table">Every ALERT2 ID${shown.length !== total ? ` — ${shown.length} of ${total}` : ''}</h3>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="a2i-h-table"><table class="tdp-table a2i-table">
      <thead><tr><th scope="col" class="tdp-num">${termHtml('ID', WORDS.a2id)}</th><th scope="col">Station (${termHtml('sensor numbers', WORDS.slot)})</th>
        <th scope="col">${termHtml('Slot table', WORDS.sites)}</th><th scope="col">${termHtml('Heard', WORDS.heard)}</th><th scope="col">Checks</th></tr></thead>
      <tbody>${body || `<tr><td colspan="5" class="txt-muted">${total ? 'Nothing matches the filter.' : 'No ALERT2 IDs known yet.'}</td></tr>`}</tbody></table></div></div>`;
  }
  function freeHtml(all) {
    const next = free(all, from, 8);
    const bl = blocks(all);
    return `<div class="panel a2i-free"><h3>Find a ${termHtml('free', WORDS.free)} ALERT2 ID</h3>
      <label class="tdp-ctl a2i-from">Starting from
        <input type="number" id="a2i-from" min="1" max="${A2_MAX}" value="${from}" oninput="Alert2Ids.onFrom(this.value)"></label>
      <p id="a2i-next">${next.length ? `The next free: <strong>${next.join(', ')}</strong>` : 'None free above that number.'}</p>
      ${bl.length ? `<p class="small txt-muted">In use, by thousands: ${bl.map(b => `${fmtN(b.lo)}–${fmtN(b.hi)}: ${b.n}`).join(' · ')}</p>` : ''}
      <p class="small txt-muted">Free here means unused as far as Flood-Net knows. Check with whoever manages the network before you set one.</p></div>`;
  }
  function wordsHtml() {
    return `<details class="panel tdp-more"><summary>What the words on this page mean</summary>
      <dl class="tds-words small">${GLOSSARY.map(([k, l]) => `<dt>${esc(l)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl></details>`;
  }

  function onFilter(v) {
    filter = String(v || '');
    const all = current(), shown = all.filter(r => matches(r, filter));
    const el = document.getElementById('a2i-table'); if (el) el.innerHTML = tableHtml(shown, all.length);
    const f = document.getElementById('a2i-found'); if (f) f.textContent = filter ? `${shown.length} of ${all.length} ALERT2 IDs` : '';
  }
  function onFrom(v) {
    const n = parseInt(v, 10); if (!Number.isFinite(n)) return;
    from = Math.min(A2_MAX, Math.max(1, n));
    const next = free(current(), from, 8);
    const el = document.getElementById('a2i-next');
    if (el) el.innerHTML = next.length ? `The next free: <strong>${next.join(', ')}</strong>` : 'None free above that number.';
  }
  function repaint() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('a2i-root');
    if (!el) return;
    const had = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = bodyHtml();
    if (had) { const x = document.getElementById(had); if (x) { x.focus(); if (x.type === 'search') x.setSelectionRange(x.value.length, x.value.length); } }
  }
  function exportCsv() {
    const lines = [['ALERT2 ID', 'Stations', 'Sensor numbers', 'Slot table', 'Heard', 'Checks']];
    for (const r of current()) lines.push([r.id, r.holders.map(h => h.name).join('; '), r.holders.map(h => h.slots.join(' ')).join('; '),
      r.sites.map(s => `${s.site} ${fmtMhz(s.freq)} MHz ${s.runs.join(' ')}`).join('; '),
      r.heard.map(h => `${fmtMhz(h.freq)} MHz ${h.source} sent ${h.relay} passed on`).join('; '), r.checks.map(c => c.text).join('; ')]);
    dlText('alert2-ids.csv', lines.map(l => l.map(csvEscape).join(',')).join('\r\n') + '\r\n');
    if (typeof announce === 'function') announce('Saved the ALERT2 IDs as CSV.');
  }

  return { WORDS, pageHtml, onFilter, onFrom, exportCsv, repaint,
           // Pure, for the tests.
           rows, matches, free, blocks };
})();
if (typeof window !== 'undefined') window.Alert2Ids = Alert2Ids;
