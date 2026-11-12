// MegaNet — tdma-slots.js
//
// TdmaSlots — the ALERT2 slot table on file (0120): which transmitter owns
// which half-second of the frame on each channel, under which ALERT2 ID, and
// which register station that is.
//
// Shown in two places:
//   · the ⏱️ TDMA Planner tab, as its first panel — one channel at a time: the
//     frame as a strip, one row a site with its slots, its station, what the
//     base stations heard of its ID, and the checks; editors change a site,
//     put a site into a run of slots, or make slots spare again;
//   · a station's card, in its radio section — its ALERT2 ID and its slots.
//
// The checks, worked in the browser from the table, the register and
// tdma_heard() (what the base stations decoded of each ID by channel over 30
// days, from the daily reception rollup):
//   · a slot with no ALERT2 ID;
//   · one ID under two site names;
//   · a site not linked to a register station, or linked to one whose own
//     ALERT2 ID is another, or an ID the register gives a different station;
//   · an ID no base station has decoded on its channel in 30 days (only on a
//     channel the base stations hear at all), or heard on another channel;
//   · IDs heard on a channel that no slot on file holds.
//
// The pure parts (runs, sites, checks) take plain arrays, for test/tdma-slots.mjs.
//
// Exposes: TdmaSlots.
// Requires at call time: core.js (esc, escAttr, termHtml, csvEscape, dlText,
// announce), datastore.js (dbSelect, dbRpc), auth.js (Auth.mayWrite), app.js
// (state, goToStation, repaint of the station card).

const TdmaSlots = (function () {
  const HEARD_DAYS = 30;
  const FRESH_MS = 5 * 60 * 1000;
  const HEARD_MIN = 3;          // decoded this often, an ID is really on the channel

  // The words on the panel that mean something particular here. One list:
  // hover reads it (termHtml), and so does the fold at the panel's foot.
  const WORDS = {
    slot: 'A time slot: the half-second of every frame in which one transmitter, and only that one, may send. "Slot 8.5 s" starts 8.5 seconds into the frame.',
    frame: 'The stretch of time the slots are laid out in, repeating. On a 60 s frame each transmitter\'s slots come round once a minute.',
    spare: 'A slot no transmitter on the slot table holds.',
    a2id: 'The ALERT2 address a transmitter sends under (1–65534). The base stations decode it from every message, so it says which transmitter was heard.',
    station: 'The station in Flood-Net\'s station register this site is. Linked, the station\'s own page shows its ALERT2 ID and slots.',
    onair: `What the base stations decoded of this ID on this channel in the last ${HEARD_DAYS} days: sent by it, or passed on by it as a repeater.`,
    unheard: `No base station decoded this ID on this channel in the last ${HEARD_DAYS} days. It may be off air, out of every base station's range, or on another ID.`,
    notOnFile: `IDs the base stations decoded on this channel at least ${HEARD_MIN} times in ${HEARD_DAYS} days that no slot on this channel holds.`,
    run: 'Slots next to each other held by one site. A repeater usually holds a run, long enough for everything it passes on.',
  };
  const GLOSSARY = [['slot', 'Slot'], ['frame', 'Frame'], ['spare', 'Spare'], ['a2id', 'ALERT2 ID'], ['station', 'Station'],
                    ['run', 'Run'], ['onair', 'On air'], ['unheard', 'Not heard'], ['notOnFile', 'Heard, not on file']];

  // ── 1. pure ────────────────────────────────────────────────────────────────
  const fkey = f => Number(f).toFixed(4);
  const fmtMhz = f => { const s = Number(f).toFixed(4).replace(/0+$/, ''); return s.endsWith('.') ? s + '0' : s; };
  const fmtS = v => { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); };
  const siteKey = (site, id) => `${site}\u0000${id == null ? '' : id}`;

  // Contiguous runs of one site's slots on one channel.
  function runsOf(starts, slotS) {
    const xs = [...starts].map(Number).sort((a, b) => a - b), out = [];
    for (const x of xs) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.start + last.n * slotS - x) < 1e-6) last.n++;
      else out.push({ start: x, n: 1 });
    }
    return out;
  }
  function runText(r, slotS) {
    const end = r.start + (r.n - 1) * slotS;
    return r.n === 1 ? `${fmtS(r.start)} s` : `${fmtS(r.start)}–${fmtS(end)} s`;
  }

  // One entry a site (name + ID) on a channel, in frame order of its first slot.
  function sitesOn(slots, freq, slotS) {
    const by = new Map();
    for (const s of slots) {
      if (fkey(s.freq_mhz) !== fkey(freq)) continue;
      const k = siteKey(s.site, s.alert2_id);
      if (!by.has(k)) by.set(k, { site: s.site, alert2_id: s.alert2_id ?? null, station_id: s.station_id || null, starts: [] });
      const e = by.get(k);
      e.starts.push(Number(s.slot_s));
      if (!e.station_id && s.station_id) e.station_id = s.station_id;
    }
    const out = [...by.values()].map(e => ({ ...e, runs: runsOf(e.starts, slotS), count: e.starts.length }));
    out.sort((a, b) => Math.min(...a.starts) - Math.min(...b.starts));
    return out;
  }

  // heard: rows of tdma_heard() — { alert2_id, freq_mhz, as_source, as_relay, last_heard }.
  function heardIndex(heard) {
    const by = new Map(), chans = new Set();
    for (const h of heard || []) {
      const k = `${h.alert2_id}@${fkey(h.freq_mhz)}`;
      by.set(k, h);
      if ((Number(h.as_source) || 0) + (Number(h.as_relay) || 0) > 0) chans.add(fkey(h.freq_mhz));
    }
    return { by, chans, get: (id, f) => by.get(`${id}@${fkey(f)}`) || null,
             on: id => [...by.values()].filter(h => Number(h.alert2_id) === Number(id)) };
  }

  // Every check for one channel. stations: [{ id, name, alert2_station_id }].
  function checks(o) {
    const { channel, slots, heard, stations } = o;
    const f = fkey(channel.freq_mhz), slotS = Number(channel.slot_s) || 0.5;
    const H = heardIndex(heard);
    const byId = new Map((stations || []).map(s => [String(s.id), s]));
    const holder = new Map();
    for (const s of stations || []) if (s.alert2_station_id != null) holder.set(Number(s.alert2_station_id), s);
    const namesOfId = new Map();
    for (const s of slots) if (s.alert2_id != null) {
      if (!namesOfId.has(Number(s.alert2_id))) namesOfId.set(Number(s.alert2_id), new Set());
      namesOfId.get(Number(s.alert2_id)).add(s.site);
    }
    const channelHeard = H.chans.has(f);
    const sites = sitesOn(slots, channel.freq_mhz, slotS).map(e => {
      const notes = [];
      const st = e.station_id ? byId.get(String(e.station_id)) : null;
      if (e.alert2_id == null) notes.push({ k: 'no-id', level: 'warn', text: 'No ALERT2 ID on the sheet' });
      else {
        const others = [...(namesOfId.get(Number(e.alert2_id)) || [])].filter(n => n !== e.site);
        if (others.length) notes.push({ k: 'two-sites', level: 'warn', text: `ID ${e.alert2_id} is also on file as ${others.join(', ')}` });
      }
      if (e.station_id && !st) notes.push({ k: 'gone', level: 'warn', text: `Linked to ${e.station_id}, which is not in the register` });
      if (st && e.alert2_id != null && st.alert2_station_id != null && Number(st.alert2_station_id) !== Number(e.alert2_id)) {
        notes.push({ k: 'station-other-id', level: 'warn', text: `The register gives ${st.name || st.id} ALERT2 ID ${st.alert2_station_id}` });
      }
      if (st && e.alert2_id != null && st.alert2_station_id == null) {
        const h = holder.get(Number(e.alert2_id));
        notes.push(h ? { k: 'id-elsewhere', level: 'warn', text: `The register gives ID ${e.alert2_id} to ${h.name || h.id}` }
                     : { k: 'station-no-id', level: 'info', text: `${st.name || st.id} has no ALERT2 ID in the register yet` });
      }
      if (!e.station_id) {
        const h = e.alert2_id != null ? holder.get(Number(e.alert2_id)) : null;
        notes.push(h ? { k: 'unlinked-held', level: 'info', text: `Not linked; the register gives ID ${e.alert2_id} to ${h.name || h.id}` }
                     : { k: 'unlinked', level: 'info', text: 'Not linked to a register station' });
      }
      let air = null;
      if (e.alert2_id != null) {
        const h = H.get(e.alert2_id, channel.freq_mhz);
        const n = h ? (Number(h.as_source) || 0) + (Number(h.as_relay) || 0) : 0;
        if (n > 0) air = { source: Number(h.as_source) || 0, relay: Number(h.as_relay) || 0, last: h.last_heard || null };
        else {
          const elsewhere = H.on(e.alert2_id).filter(x => fkey(x.freq_mhz) !== f && (Number(x.as_source) || 0) + (Number(x.as_relay) || 0) > 0);
          if (elsewhere.length) notes.push({ k: 'other-channel', level: 'warn', text: `Heard on ${elsewhere.map(x => `${fmtMhz(x.freq_mhz)} MHz`).join(', ')} instead` });
          else if (channelHeard) notes.push({ k: 'unheard', level: 'warn', text: `Not heard in ${HEARD_DAYS} days` });
        }
      }
      return { ...e, station: st || null, air, notes };
    });
    const onFile = new Set(slots.filter(s => fkey(s.freq_mhz) === f && s.alert2_id != null).map(s => Number(s.alert2_id)));
    const strangers = [...H.by.values()]
      .filter(h => fkey(h.freq_mhz) === f && (Number(h.as_source) || 0) >= HEARD_MIN && !onFile.has(Number(h.alert2_id)))
      .map(h => ({ alert2_id: Number(h.alert2_id), source: Number(h.as_source) || 0, relay: Number(h.as_relay) || 0, last: h.last_heard || null,
                   station: holder.get(Number(h.alert2_id)) || null }))
      .sort((a, b) => b.source - a.source);
    const used = slots.filter(s => fkey(s.freq_mhz) === f).length;
    const total = Math.round((Number(channel.frame_s) || 0) / slotS);
    return { sites, strangers, channelHeard, used, total, spare: Math.max(0, total - used) };
  }

  // What a save would take over: slots in the run held by a different site.
  function takenBy(slots, freq, start, n, slotS, site, id) {
    const lo = Number(start) - 1e-6, hi = Number(start) + (n - 1) * slotS + 1e-6;
    return slots.filter(s => fkey(s.freq_mhz) === fkey(freq) && Number(s.slot_s) >= lo && Number(s.slot_s) <= hi
      && (s.site !== site || (s.alert2_id ?? null) !== (id ?? null)));
  }

  // ── 2. state ───────────────────────────────────────────────────────────────
  let D = null;           // { channels, slots, heard, at }
  let pending = null;
  let failed = '';
  let chan = null;        // fkey of the channel shown
  let form = null;        // { kind: 'site'|'add'|'remove', ... }

  function stations() { return (typeof state !== 'undefined' && state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => String(s.id) === String(id)) || null; }
  function editor() {
    if (!(typeof dbCanWrite === 'function' && dbCanWrite())) return false;
    return typeof Auth === 'undefined' || typeof Auth.mayWrite !== 'function' || !!Auth.mayWrite();
  }

  function ask(force) {
    if (!force && D && Date.now() - D.at < FRESH_MS) return Promise.resolve(D);
    if (pending) return pending;
    if (typeof dbSelect !== 'function') { failed = 'The database is not reachable from this page.'; return Promise.resolve(null); }
    pending = Promise.all([
      dbSelect('tdma_channel?select=freq_mhz,label,frame_s,slot_s,notes,ord&order=ord,freq_mhz'),
      dbSelect('tdma_slot?select=freq_mhz,slot_s,alert2_id,site,station_id,notes,updated_at,updated_by&order=freq_mhz,slot_s'),
      typeof dbRpc === 'function' ? dbRpc('tdma_heard', { p_days: HEARD_DAYS }).catch(() => null) : Promise.resolve(null),
    ]).then(([c, s, h]) => {
      D = { channels: c || [], slots: s || [], heard: Array.isArray(h) ? h : null, at: Date.now() };
      failed = '';
      if (!chan && D.channels.length) chan = fkey(D.channels[0].freq_mhz);
      return D;
    }, err => {
      failed = /404|does not exist|42P01/.test(String(err && (err.message || err))) ? 'The slot table is not in the database yet.' : 'Could not read the slot table.';
      return null;
    }).finally(() => { pending = null; repaint(); });
    return pending;
  }

  // ── 3. the panel on the TDMA Planner tab ───────────────────────────────────
  function panelHtml() {
    if (!D && !pending && !failed) ask();
    return `<section class="panel tds-panel" id="tds-panel" aria-labelledby="tds-h">${panelBodyHtml()}</section>`;
  }
  function panelBodyHtml() {
    const head = `<div class="panel-header"><h2 id="tds-h">📋 The slot table on file</h2>${D && D.slots.length ? `
      <div class="button-group"><button type="button" onclick="TdmaSlots.exportCsv()">⤓ Slot table CSV</button></div>` : ''}</div>
      <p class="small">The ${termHtml('slots', WORDS.slot)} the network actually runs — the slot sheet supplied for the Mt Glorious ALERT2 network —
        with each transmitter's ${termHtml('ALERT2 ID', WORDS.a2id)} and the register ${termHtml('station', WORDS.station)} it is, checked against what
        the base stations hear. The planner below works out a plan from first principles; this is the one on file.</p>`;
    if (!D) return `${head}<p class="small txt-muted" role="status">${failed ? esc(failed) : 'Reading the slot table…'}</p>`;
    if (!D.channels.length) return `${head}<p class="small txt-muted">No channels on file.</p>`;
    const C = D.channels.find(c => fkey(c.freq_mhz) === chan) || D.channels[0];
    chan = fkey(C.freq_mhz);
    const K = checks({ channel: C, slots: D.slots, heard: D.heard || [], stations: stations() });
    const tabs = `<div class="tds-chans" role="group" aria-label="Channel">${D.channels.map(c => {
      const n = D.slots.filter(s => fkey(s.freq_mhz) === fkey(c.freq_mhz)).length;
      return `<button type="button" class="tds-chan${fkey(c.freq_mhz) === chan ? ' active' : ''}" aria-pressed="${fkey(c.freq_mhz) === chan}"
        onclick="TdmaSlots.pick('${fkey(c.freq_mhz)}')"><strong>${esc(fmtMhz(c.freq_mhz))} MHz</strong><span class="small">${esc(c.label)} · ${n} slots</span></button>`;
    }).join('')}</div>`;
    const sum = `<p class="small tds-sum"><strong>${esc(fmtMhz(C.freq_mhz))} MHz</strong> — ${esc(C.label)}.
      A ${termHtml(`${fmtS(C.frame_s)} s frame`, WORDS.frame)} of ${K.total} × ${fmtS(C.slot_s)} s slots: ${K.used} held by ${K.sites.length} site${K.sites.length === 1 ? '' : 's'},
      ${termHtml(`${K.spare} spare`, WORDS.spare)}.${C.notes ? ` <span class="txt-muted">${esc(C.notes)}</span>` : ''}
      ${D.heard == null ? '<br><span class="txt-muted">What the base stations heard could not be read, so the on-air checks are left out.</span>'
        : !K.channelHeard ? `<br><span class="txt-muted">No base station decoded anything on this channel in ${HEARD_DAYS} days, so nothing here can be checked on air.</span>` : ''}</p>`;
    return `${head}${tabs}${sum}${stripHtml(C, K)}${formHtml(C)}${tableHtml(C, K)}${strangersHtml(C, K)}${wordsHtml()}`;
  }

  // A steady colour for a site, from its name; a repeater's run is outlined.
  function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
  function stripHtml(C, K) {
    const slotS = Number(C.slot_s) || 0.5, frame = Number(C.frame_s) || 60, W = 960, H = 34;
    const x = t => (W * t / frame).toFixed(1);
    const bars = [];
    for (const e of K.sites) for (const r of e.runs) {
      const w = (W * r.n * slotS / frame - 1).toFixed(1);
      bars.push(`<rect x="${x(r.start)}" y="2" width="${w}" height="${H - 4}" rx="2" fill="hsl(${hue(e.site)} 55% 52%)"${e.notes.some(n => n.level === 'warn') ? ' class="tds-bar-warn"' : ''}>
        <title>${esc(`${runText(r, slotS)}: ${e.site}${e.alert2_id != null ? ` (${e.alert2_id})` : ''}`)}</title></rect>`);
    }
    const ticks = [];
    const step = frame > 30 ? 10 : 5;
    for (let t = 0; t <= frame; t += step) ticks.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${H}" y2="${H + 4}" class="tds-tick"/><text x="${x(t)}" y="${H + 15}" class="tds-tick-t"${t === 0 ? ' text-anchor="start"' : t >= frame ? ' text-anchor="end"' : ''}>${t} s</text>`);
    return `<figure class="tds-fig"><svg viewBox="0 -1 ${W} ${H + 19}" role="img" aria-label="${esc(`The ${fmtS(frame)} s frame on ${fmtMhz(C.freq_mhz)} MHz: ${K.used} slots held, ${K.spare} spare`)}">
      <rect x="0" y="2" width="${W}" height="${H - 4}" class="tds-spare-bg"/>${bars.join('')}${ticks.join('')}</svg>
      <figcaption class="small txt-muted">The frame, left to right; each block a site's run of slots (hover for whose). The gaps are spare.</figcaption></figure>`;
  }

  const fmtN = n => Number(n).toLocaleString('en-AU');
  function dmy(iso) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(iso || '')); return m ? `${Number(m[3])}/${Number(m[2])}` : ''; }
  function airHtml(e) {
    if (e.alert2_id == null) return '—';
    if (!e.air) return D.heard == null ? '<span class="txt-muted">—</span>' : `<span class="txt-muted">${termHtml('not heard', WORDS.unheard)}</span>`;
    const parts = [];
    if (e.air.source) parts.push(`${fmtN(e.air.source)} sent`);
    if (e.air.relay) parts.push(`${fmtN(e.air.relay)} passed on`);
    return `${parts.join('<br>')}${e.air.last ? `<br><span class="small txt-muted">last ${esc(dmy(e.air.last))}</span>` : ''}`;
  }
  function stationCell(e) {
    if (e.station) return `<button type="button" class="link-btn" onclick="goToStation('${escAttr(e.station.id)}')">${esc(e.station.name || e.station.id)}</button>`;
    return e.station_id ? esc(e.station_id) : '<span class="txt-muted">—</span>';
  }
  function notesHtml(e) {
    return e.notes.map(n => `<span class="${n.level === 'warn' ? 'txt-warn' : 'txt-muted'}">${esc(n.text)}</span>`).join('<br>') || '<span class="txt-muted">—</span>';
  }
  function tableHtml(C, K) {
    const slotS = Number(C.slot_s) || 0.5, ed = editor();
    const rows = K.sites.map((e, i) => `<tr>
        <th scope="row">${esc(e.site)}</th>
        <td class="tdp-num">${e.alert2_id ?? '<span class="txt-warn">none</span>'}</td>
        <td>${stationCell(e)}</td>
        <td>${e.runs.map(r => `${esc(runText(r, slotS))}${ed ? ` <button type="button" class="link-btn small" onclick="TdmaSlots.openRemove(${r.start}, ${r.n})" aria-label="${escAttr(`Make ${runText(r, slotS)} spare`)}">✕</button>` : ''}`).join('<br>')}
          <span class="small txt-muted">(${e.count} slot${e.count === 1 ? '' : 's'})</span></td>
        <td class="tdp-num tds-air">${airHtml(e)}</td>
        <td class="small">${notesHtml(e)}</td>
        ${ed ? `<td><button type="button" class="link-btn" onclick="TdmaSlots.openSite(${i})">Change</button></td>` : ''}
      </tr>`).join('');
    return `<div class="table-wrap"><table class="tdp-table tds-table">
      <thead><tr><th scope="col">Site, as on the sheet</th><th scope="col" class="tdp-num">${termHtml('ALERT2 ID', WORDS.a2id)}</th>
        <th scope="col">${termHtml('Station', WORDS.station)}</th><th scope="col">${termHtml('Slots', WORDS.slot)}</th>
        <th scope="col" class="tdp-num">${termHtml('On air', WORDS.onair)}</th><th scope="col">Checks</th>${ed ? '<th scope="col"><span class="sr-only">Change</span></th>' : ''}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${ed ? 7 : 6}" class="txt-muted">No slots on file on this channel.</td></tr>`}</tbody></table></div>
      ${ed && !form ? `<p><button type="button" onclick="TdmaSlots.openAdd()">＋ Put a site into slots</button></p>` : ''}`;
  }
  function strangersHtml(C, K) {
    if (!K.strangers.length) return '';
    return `<details class="tdp-more tds-strangers" open><summary>${termHtml(`Heard on ${fmtMhz(C.freq_mhz)} MHz, not on file`, WORDS.notOnFile)} — ${K.strangers.length}</summary>
      <ul class="small">${K.strangers.map(h => `<li><strong>${h.alert2_id}</strong>: ${fmtN(h.source)} sent${h.relay ? `, ${fmtN(h.relay)} passed on` : ''}${
        h.last ? `, last ${esc(dmy(h.last))}` : ''}${h.station ? ` — the register's ${esc(h.station.name || h.station.id)}` : ''}</li>`).join('')}</ul></details>`;
  }
  function wordsHtml() {
    return `<details class="tdp-more"><summary>What the words on this panel mean</summary>
      <dl class="tds-words small">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl></details>`;
  }

  // ── 4. editing ─────────────────────────────────────────────────────────────
  function stationOptions() {
    return stations().filter(s => s && s.id && s.name).map(s => `<option value="${escAttr(s.id)}">${esc(s.name)}</option>`).join('');
  }
  function formHtml(C) {
    if (!form || form.freq !== fkey(C.freq_mhz)) return '';
    const slotS = Number(C.slot_s) || 0.5;
    const busy = form.busy ? ' disabled' : '';
    const err = form.error ? `<p class="txt-bad small" role="alert">${esc(form.error)}</p>` : '';
    const stationField = (val) => `<label class="tdp-ctl">Register station (its id; type to search)
        <input id="tds-f-st" list="tds-st-list" value="${escAttr(val || '')}" placeholder="none"><datalist id="tds-st-list">${stationOptions()}</datalist></label>`;
    if (form.kind === 'remove') {
      return `<div class="panel tds-form" role="group" aria-label="Make slots spare">
        <p>Make ${esc(runText({ start: form.start, n: form.n }, slotS))} on ${esc(fmtMhz(C.freq_mhz))} MHz spare? The site keeps its other slots.</p>${err}
        <div class="button-group"><button type="button" class="primary" onclick="TdmaSlots.saveRemove()"${busy}>${form.busy ? 'Saving…' : 'Make them spare'}</button>
        <button type="button" onclick="TdmaSlots.closeForm()"${busy}>Keep</button></div></div>`;
    }
    if (form.kind === 'site') {
      return `<div class="panel tds-form" role="group" aria-label="Change a site">
        <h3 class="tds-form-h">Change ${esc(form.match_site)}${form.match_id != null ? ` (${form.match_id})` : ''}, on every channel</h3>
        <div class="tds-form-grid">
          <label class="tdp-ctl">Site name<input id="tds-f-site" value="${escAttr(form.match_site)}"></label>
          <label class="tdp-ctl">ALERT2 ID<input id="tds-f-id" type="number" min="1" max="65534" value="${form.match_id ?? ''}" placeholder="none"></label>
          ${stationField(form.station_id)}
        </div>
        <p class="small txt-muted">Linking a station that has no ALERT2 ID gives it this one, unless another station holds it.</p>${err}
        <div class="button-group"><button type="button" class="primary" onclick="TdmaSlots.saveSite()"${busy}>${form.busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onclick="TdmaSlots.closeForm()"${busy}>Cancel</button></div></div>`;
    }
    // add
    const taken = takenBy(D.slots, C.freq_mhz, form.start, form.n, slotS, form.site, form.alert2_id);
    return `<div class="panel tds-form" role="group" aria-label="Put a site into slots">
      <h3 class="tds-form-h">Put a site into slots on ${esc(fmtMhz(C.freq_mhz))} MHz</h3>
      <div class="tds-form-grid" oninput="TdmaSlots.formInput()">
        <label class="tdp-ctl">First slot (s)<input id="tds-f-start" type="number" min="0" max="${Number(C.frame_s) - slotS}" step="${slotS}" value="${form.start}"></label>
        <label class="tdp-ctl">How many in a row<input id="tds-f-n" type="number" min="1" max="40" step="1" value="${form.n}"></label>
        <label class="tdp-ctl">Site name<input id="tds-f-site" value="${escAttr(form.site)}"></label>
        <label class="tdp-ctl">ALERT2 ID<input id="tds-f-id" type="number" min="1" max="65534" value="${form.alert2_id ?? ''}" placeholder="none"></label>
        ${stationField(form.station_id)}
      </div>
      <p class="small" id="tds-f-taken">${takenText(taken, slotS)}</p>${err}
      <div class="button-group"><button type="button" class="primary" onclick="TdmaSlots.saveAdd()"${busy}>${form.busy ? 'Saving…' : 'Save'}</button>
      <button type="button" onclick="TdmaSlots.closeForm()"${busy}>Cancel</button></div></div>`;
  }
  function takenText(taken, slotS) {
    if (!taken.length) return '<span class="txt-muted">Those slots are spare.</span>';
    const by = new Map();
    for (const s of taken) { const k = siteKey(s.site, s.alert2_id); if (!by.has(k)) by.set(k, { s, starts: [] }); by.get(k).starts.push(Number(s.slot_s)); }
    return `<span class="txt-warn">This takes over ${[...by.values()].map(v => `${esc(runsOf(v.starts, slotS).map(r => runText(r, slotS)).join(', '))} from ${esc(v.s.site)}`).join('; ')}.</span>`;
  }
  const val = id => { const el = typeof document !== 'undefined' && document.getElementById(id); return el ? el.value : ''; };
  const intOrNull = v => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) ? n : null; };
  function readForm() {
    if (!form) return;
    if (form.kind === 'add') {
      form.start = Number(val('tds-f-start')) || 0;
      form.n = Math.max(1, intOrNull(val('tds-f-n')) || 1);
    }
    form.site = val('tds-f-site').trim();
    form.alert2_id = intOrNull(val('tds-f-id'));
    form.station_id = val('tds-f-st').trim() || null;
  }
  function formInput() {
    readForm();
    const C = D && D.channels.find(c => fkey(c.freq_mhz) === chan);
    const el = typeof document !== 'undefined' && document.getElementById('tds-f-taken');
    if (C && el && form && form.kind === 'add') el.innerHTML = takenText(takenBy(D.slots, C.freq_mhz, form.start, form.n, Number(C.slot_s) || 0.5, form.site, form.alert2_id), Number(C.slot_s) || 0.5);
  }
  function current() { return D && D.channels.find(c => fkey(c.freq_mhz) === chan); }
  function openSite(i) {
    const C = current(); if (!C) return;
    const e = checks({ channel: C, slots: D.slots, heard: D.heard || [], stations: stations() }).sites[i]; if (!e) return;
    form = { kind: 'site', freq: chan, match_site: e.site, match_id: e.alert2_id, station_id: e.station_id };
    repaint(); focus('tds-f-site');
  }
  function openAdd() {
    const C = current(); if (!C) return;
    const slotS = Number(C.slot_s) || 0.5, held = new Set(D.slots.filter(s => fkey(s.freq_mhz) === chan).map(s => Number(s.slot_s)));
    let start = 0; while (held.has(start) && start < Number(C.frame_s)) start += slotS;
    form = { kind: 'add', freq: chan, start, n: 1, site: '', alert2_id: null, station_id: null };
    repaint(); focus('tds-f-start');
  }
  function openRemove(start, n) { form = { kind: 'remove', freq: chan, start: Number(start), n: Number(n) }; repaint(); }
  function closeForm() { form = null; repaint(); }
  function focus(id) { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { const el = document.getElementById(id); if (el) el.focus(); }); }
  function stationOk(id) { return !id || !!stationById(id); }
  async function run(fn, args, said) {
    form.busy = true; form.error = ''; repaint();
    try {
      const out = await dbRpc(fn, args);
      form = null;
      await ask(true);
      if (typeof announce === 'function') announce(said(out));
      // The station list in the page learns the ID too, so its card says so
      // before the next load.
      if (out && out.station_given_id && args.p && args.p.station_id) {
        const st = stationById(args.p.station_id);
        if (st && st.alert2_station_id == null) st.alert2_station_id = args.p.alert2_id;
        repaint();
      }
    } catch (err) {
      if (form) { form.busy = false; form.error = err && err.denied ? 'Only editors can change the slot table. Sign in with an address on the editors list.' : String((err && err.message) || err); }
      repaint();
    }
  }
  function saveSite() {
    readForm();
    if (!form.site) { form.error = 'A site needs a name.'; repaint(); return; }
    if (!stationOk(form.station_id)) { form.error = `No station ${form.station_id} in the register.`; repaint(); return; }
    run('tdma_site_save', { p: { match_site: form.match_site, match_alert2_id: form.match_id, site: form.site, alert2_id: form.alert2_id, station_id: form.station_id } },
        o => `Saved: ${o && o.saved} slots changed${o && o.station_given_id ? ', and the station has the ALERT2 ID now' : ''}.`);
  }
  function saveAdd() {
    readForm();
    if (!form.site) { form.error = 'A slot needs the site that transmits in it.'; repaint(); return; }
    if (!stationOk(form.station_id)) { form.error = `No station ${form.station_id} in the register.`; repaint(); return; }
    run('tdma_slot_save', { p: { freq_mhz: Number(chan), slot_s: form.start, slots: form.n, site: form.site, alert2_id: form.alert2_id, station_id: form.station_id } },
        o => `Saved ${o && o.saved} slot${o && o.saved === 1 ? '' : 's'}${o && o.replaced && o.replaced.length ? `, taking over ${o.replaced.length}` : ''}.`);
  }
  function saveRemove() {
    run('tdma_slot_remove', { p_freq: Number(chan), p_slot: form.start, p_slots: form.n }, n => `${n} slot${n === 1 ? '' : 's'} made spare.`);
  }

  function pick(f) { chan = fkey(f); form = null; repaint(); }

  function exportCsv() {
    if (!D) return;
    const rows = [['Frequency MHz', 'Channel', 'Frame s', 'Slot s', 'Site', 'ALERT2 ID', 'Station id', 'Station']];
    for (const s of D.slots) {
      const c = D.channels.find(x => fkey(x.freq_mhz) === fkey(s.freq_mhz)) || {};
      const st = s.station_id ? stationById(s.station_id) : null;
      rows.push([fmtMhz(s.freq_mhz), c.label || '', c.frame_s ?? '', fmtS(s.slot_s), s.site, s.alert2_id ?? '', s.station_id || '', st ? st.name : '']);
    }
    dlText('tdma-slots.csv', rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n');
    if (typeof announce === 'function') announce('Saved the slot table as CSV.');
  }

  // ── 5. the station card ────────────────────────────────────────────────────
  // Its ALERT2 ID (0024) and every slot on file under that ID or linked to it.
  function cardBodyHtml(s) {
    const id = s.alert2_station_id != null ? Number(s.alert2_station_id) : null;
    const mine = D ? D.slots.filter(x => String(x.station_id || '') === String(s.id) || (id != null && Number(x.alert2_id) === id)) : [];
    if (id == null && !mine.length) return '';
    const ids = [...new Set([id, ...mine.map(x => x.alert2_id)].filter(v => v != null))];
    const lines = [];
    for (const c of D ? D.channels : []) {
      const on = mine.filter(x => fkey(x.freq_mhz) === fkey(c.freq_mhz));
      if (!on.length) continue;
      const slotS = Number(c.slot_s) || 0.5;
      lines.push(`${esc(fmtMhz(c.freq_mhz))} MHz: ${esc(runsOf(on.map(x => x.slot_s), slotS).map(r => runText(r, slotS)).join(', '))} of a ${esc(fmtS(c.frame_s))} s frame`);
    }
    return `<div class="acma-row"><span>${termHtml('ALERT2 ID', WORDS.a2id)}</span><span>${esc(ids.join(', '))}</span></div>${lines.length
      ? `<div class="acma-row"><span>${termHtml('Time slots', WORDS.slot)}</span><span>${lines.join('<br>')}</span></div>` : ''}`;
  }
  function cardHtml(s) {
    if (!s || !s.id) return '';
    // Nothing at all for a station with no ID and no slots, so its radio
    // section is not opened for an empty row.
    const body = D ? cardBodyHtml(s) : '';
    if (!body && s.alert2_station_id == null) return '';
    return `<div class="tds-card" data-mn-tds="${escAttr(s.id)}">${body || cardBodyHtml(s)}</div>`;
  }
  function cardAsk(s) { if (s && s.id) ask(); }

  function repaint() {
    if (typeof document === 'undefined') return;
    const p = document.getElementById('tds-panel');
    if (p) {
      const had = document.activeElement && p.contains(document.activeElement) ? document.activeElement.id : '';
      p.innerHTML = panelBodyHtml();
      if (had) { const el = document.getElementById(had); if (el) el.focus(); }
    }
    document.querySelectorAll('[data-mn-tds]').forEach(el => {
      const s = stationById(el.dataset.mnTds);
      if (s) el.innerHTML = cardBodyHtml(s);
    });
  }

  return {
    WORDS, panelHtml, cardHtml, cardAsk, ask, pick, exportCsv,
    openSite, openAdd, openRemove, closeForm, formInput, saveSite, saveAdd, saveRemove,
    // Pure, for the tests.
    runsOf, runText, sitesOn, checks, takenBy, fmtMhz,
    data: () => D,
  };
})();
if (typeof window !== 'undefined') window.TdmaSlots = TdmaSlots;
