// MegaNet — flip-sources.js
//
//   FlipSources   the Bit-Flip Sources tab: who is corrupting the network's
//                 ALERT readings. Every corrupted copy a base station has
//                 heard (0078), weighed two ways and put on a map —
//                   * by carrier fingerprint: the transmitter whose carrier a
//                     corrupted copy came on sent it. Definite, but only for
//                     bursts heard since RPi ALERT 0.14 measured carriers;
//                   * by pass range: a corrupted copy is the work of one of the
//                     repeaters that pass its address. Circumstantial, but
//                     available for every one — and it says something once a
//                     repeater's share is set against how much it carries
//                     (its rate) and counted where it was the only one that
//                     could have (only it).
//                 Then which stations are being corrupted, into what, and at
//                 what hours — interference keeps hours, a failing radio does
//                 not.
//
// Reads meganet.flip_sources (0079), one public row per period, rebuilt hourly
// on the server. After core.js, datastore.js, app.js (switchTab, addBaseLayers)
// and bit-flipper.js (openBitFlipper), all read at call time; before init.js.
// Nothing runs at load: app.js's renderMain calls render() and init().

const FlipSources = (() => {

  const S = {
    period: 7,
    rows: null,          // period → { data, built_at }
    err: '',
    loading: false,
    selected: null,      // repeater id
    allSuspects: false,
    allStations: false,
    map: null, layer: null,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const pct = r => (r == null || !Number.isFinite(Number(r)) ? '—' : `${(Number(r) * 100).toFixed(Number(r) < 0.1 ? 1 : 0)}%`);
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  const stationById = id => stations().find(s => s.id === id) || null;
  const stationOfAddr = a => stations().find(s => (s.sensors || []).some(x => Number(x.alert_id) === Number(a))) || null;
  const data = () => (S.rows && S.rows[S.period] ? S.rows[S.period].data : null);
  const when = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };

  function txName(tx) {
    if (!tx) return '';
    if (tx.startsWith('st:')) { const st = stationById(tx.slice(3)); return st ? st.name : tx.slice(3); }
    if (tx.startsWith('a:')) return `ALERT ${tx.slice(2)}`;
    return tx;
  }
  function addrBtn(a) {
    const st = stationOfAddr(a);
    return `<button class="link-btn" onclick="openBitFlipper(${Number(a)}, { bits: 2 })" title="Open ${escAttr(String(a))} in the Bit Flipper">${esc(String(a))}</button>${st ? ` <span class="small">${esc(st.name)}</span>` : ' <span class="small txt-muted">no station</span>'}`;
  }

  // How a suspect stands against the network.
  function ratio(c, d) {
    const nr = Number(d && d.network_rate);
    return c.rate != null && nr > 0 ? Number(c.rate) / nr : null;
  }
  function verdict(c, d) {
    if (Number(c.clear) >= 5) return { cls: 'txt-bad', word: 'Caught by its carrier', rank: 0 };
    if (Number(c.by_carrier) > 0) return { cls: 'txt-warn', word: 'Seen by its carrier', rank: 1 };
    const r = ratio(c, d);
    if (r != null && r >= 2 && Number(c.blame) >= 10) return { cls: 'txt-warn', word: `${r.toFixed(1)}× the network's rate`, rank: 2 };
    if (r != null && r >= 1.3 && Number(c.blame) >= 5) return { cls: '', word: 'Above the network', rank: 3 };
    return { cls: 'txt-muted', word: 'Within the usual', rank: 4 };
  }
  function ranked(d) {
    return (d.candidates || []).slice().sort((a, b) => verdict(a, d).rank - verdict(b, d).rank
      || Number(b.clear) - Number(a.clear) || (ratio(b, d) || 0) - (ratio(a, d) || 0) || Number(b.blame) - Number(a.blame));
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  async function load() {
    if (S.loading || typeof dbSelect !== 'function') return;
    S.loading = true; S.err = '';
    try {
      const rows = await dbSelect('flip_sources?select=period_days,data,built_at');
      S.rows = {};
      (rows || []).forEach(r => { S.rows[r.period_days] = r; });
    } catch (err) {
      const missing = (err && (err.code === 'PGRST205' || err.code === '42P01' || err.status === 404))
        || /Could not find the table|does not exist/.test(String((err && err.message) || err));
      S.err = missing ? 'This database does not keep the bit-flip evidence yet (migration 0079).' : `Could not read the bit-flip evidence — ${(err && err.message) || err}.`;
    }
    S.loading = false;
    redraw();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function periodHtml() {
    return `<div class="control-row" role="group" aria-label="Period">
      ${[7, 30].map(p => `<button class="btn${S.period === p ? ' btn-primary' : ''}" aria-pressed="${S.period === p}" onclick="FlipSources.setPeriod(${p})">Last ${p} days</button>`).join('')}
    </div>`;
  }

  function leadHtml(d) {
    const by = d.by_how || {};
    const total = Number(d.corrupted) || 0;
    const top = ranked(d).filter(c => verdict(c, d).rank <= 2).slice(0, 3);
    return `<p><b>${num(total)} corrupted cop${total === 1 ? 'y' : 'ies'}</b> in the last ${num(d.days)} days, out of ${num(d.heard)} legacy bursts heard
      (${pct(d.network_rate)}). ${num(by.carrier || 0)} were put down to the transmitter that sent them by its carrier;
      ${num(by['no-carrier'] || 0)} came before carriers were measured, and are weighed by pass range below.</p>
      ${top.length ? `<p><b>Look first at:</b> ${top.map(c => `${esc(c.name || c.rid)} (${esc(verdict(c, d).word.toLowerCase())})`).join('; ')}.</p>` : ''}`;
  }

  function suspectsHtml(d) {
    const rows = ranked(d);
    const shown = S.allSuspects ? rows : rows.slice(0, 25);
    if (!rows.length) return '<p class="small">No repeater passes any corrupted address in this period.</p>';
    return `<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="fs-h-suspects">
      <table class="hl-table fs-suspects">
        <caption class="sr-only">Repeaters that could have corrupted the readings, most suspect first: what the carrier fingerprint charged to each, its share by pass range, the copies only it could have carried, stations hit, what it carried and its rate against the network</caption>
        <thead><tr><th scope="col">Repeater</th><th scope="col" class="num">By carrier</th><th scope="col" class="num">Share by pass range</th>
          <th scope="col" class="num">Only it could have</th><th scope="col" class="num">Stations hit</th><th scope="col" class="num">Carried</th>
          <th scope="col" class="num">Rate</th><th scope="col">Verdict</th></tr></thead>
        <tbody>${shown.map(c => {
          const v = verdict(c, d), r = ratio(c, d), sel = S.selected === c.rid;
          return `<tr class="${sel ? 'is-selected' : ''}">
            <th scope="row"><button class="link-btn" aria-pressed="${sel}" onclick="FlipSources.select('${escAttr(c.rid)}')">${esc(c.name || c.rid)}</button></th>
            <td class="num">${num(c.by_carrier)}${Number(c.by_carrier) ? `<br><span class="small">${num(c.clear)} clear</span>` : ''}</td>
            <td class="num">${num(c.blame)}</td>
            <td class="num">${num(c.only_it)}</td>
            <td class="num">${num(c.stations)}</td>
            <td class="num">${num(c.carried)}</td>
            <td class="num">${pct(c.rate)}${r != null ? `<br><span class="small">${r.toFixed(1)}×</span>` : ''}</td>
            <td><span class="${v.cls}">${esc(v.word)}</span></td>
          </tr>`;
        }).join('')}</tbody></table></div>
      ${rows.length > shown.length ? `<p><button class="btn" onclick="FlipSources.showAll('suspects')">Show all ${num(rows.length)}</button></p>` : ''}`;
  }

  function selectedHtml(d) {
    if (!S.selected) return '<p class="small txt-muted">Pick a repeater above to see the corrupted stations it could have carried, and draw them on the map.</p>';
    const c = (d.candidates || []).find(x => x.rid === S.selected);
    const hit = (d.stations || []).filter(s => (s.candidates || []).includes(S.selected));
    const byCar = hit.filter(s => s.senders && s.senders['st:' + S.selected]);
    return `<h4>${esc(c ? c.name : S.selected)}</h4>
      <p class="small">${num(hit.length)} corrupted address${hit.length === 1 ? '' : 'es'} it passes${byCar.length ? `; the carrier fingerprint caught it on ${num(byCar.length)}` : ''}.
        ${stationById(S.selected) && typeof goToStation === 'function' ? `<button class="link-btn" onclick="goToStation('${escAttr(S.selected)}')">Open it in Stations</button>` : ''}</p>
      ${hit.length ? `<ul class="hl-plain">${hit.slice(0, 40).map(s => `<li>${addrBtn(s.addr)} — ${num(s.n)} corrupted${s.senders && s.senders['st:' + S.selected] ? `, <b>${num(s.senders['st:' + S.selected])} by its carrier</b>` : ''}${(s.candidates || []).length === 1 ? ' <span class="small">(only it passes this)</span>' : ` <span class="small">(${num((s.candidates || []).length)} repeaters pass it)</span>`}</li>`).join('')}</ul>` : ''}`;
  }

  function stationsHtml(d) {
    const rows = d.stations || [];
    const shown = S.allStations ? rows : rows.slice(0, 50);
    if (!rows.length) return '<p class="small">No corrupted copies in this period.</p>';
    return `<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="fs-h-stations">
      <table class="hl-table fs-stations">
        <caption class="sr-only">The readings being corrupted, most first: how many copies, how many into another address, what they became, who the carrier fingerprint says sent them, and the repeaters that could have</caption>
        <thead><tr><th scope="col">Address</th><th scope="col" class="num">Corrupted</th><th scope="col" class="num">Into another address</th>
          <th scope="col">Became</th><th scope="col">Sent by (carrier)</th><th scope="col">Could have been</th><th scope="col">Last</th></tr></thead>
        <tbody>${shown.map(s => {
          const senders = Object.entries(s.senders || {}).sort((a, b) => b[1] - a[1]);
          const cands = (s.candidates || []).map(id => txName('st:' + id));
          return `<tr>
            <th scope="row">${addrBtn(s.addr)}</th>
            <td class="num">${num(s.n)}</td>
            <td class="num">${num(s.addr_flips)}</td>
            <td class="small">${(s.targets || []).slice(0, 4).map(t => `${esc(String(t.addr))} ×${num(t.n)}`).join(', ') || 'its value'}</td>
            <td class="small">${senders.length ? senders.map(([tx, n]) => `${esc(txName(tx))} ×${num(n)}`).join(', ') : '<span class="txt-muted">not measured</span>'}</td>
            <td class="small">${cands.length ? `${cands.slice(0, 3).map(esc).join(', ')}${cands.length > 3 ? ` +${cands.length - 3}` : ''}` : '<span class="txt-muted">no repeater passes it</span>'}</td>
            <td class="small">${esc(when(s.last_at))}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
      ${rows.length > shown.length ? `<p><button class="btn" onclick="FlipSources.showAll('stations')">Show all ${num(rows.length)}</button></p>` : ''}`;
  }

  function barsSvg(values, labels, title) {
    const W = 480, H = 90, n = values.length, max = Math.max(1, ...values);
    const bw = (W - 20) / n;
    const peak = values.indexOf(Math.max(...values));
    return `<svg class="fs-bars" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="${escAttr(`${title}: most at ${labels[peak]} (${values[peak]})`)}">
      ${values.map((v, i) => `<rect x="${(10 + i * bw + 1).toFixed(1)}" y="${(H - (v / max) * (H - 4)).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${((v / max) * (H - 4)).toFixed(1)}" fill="currentColor" opacity="${i === peak ? 0.9 : 0.5}"><title>${esc(`${labels[i]}: ${v}`)}</title></rect>`).join('')}
      ${labels.map((l, i) => (n <= 24 ? i % 3 === 0 : i % Math.ceil(n / 8) === 0) ? `<text x="${(10 + i * bw + bw / 2).toFixed(1)}" y="${H + 14}" font-size="10" text-anchor="middle" fill="currentColor">${esc(l)}</text>` : '').join('')}
    </svg>`;
  }

  function whenHtml(d) {
    const hours = (d.hours || []).map(Number);
    const days = (d.per_day || []);
    if (!hours.length) return '';
    const total = hours.reduce((a, b) => a + b, 0);
    const night = hours.slice(0, 6).reduce((a, b) => a + b, 0) + hours.slice(18).reduce((a, b) => a + b, 0);
    return `<div class="fs-when">
      <figure><figcaption class="small">By hour of day, Brisbane time</figcaption>${barsSvg(hours, hours.map((_, h) => `${String(h).padStart(2, '0')}:00`), 'Corrupted copies by hour')}</figure>
      ${days.length ? `<figure><figcaption class="small">By day</figcaption>${barsSvg(days.map(x => Number(x.n)), days.map(x => String(x.day).slice(5)), 'Corrupted copies by day')}</figure>` : ''}
      <p class="small">${total ? `${pct(night / total)} of them between 18:00 and 06:00.` : ''} Interference keeps hours — a neighbour's transmitter, a motor, intermodulation
        when two others key up — and a failing radio does not; a temperature fault shows in the afternoons.</p>
    </div>`;
  }

  function render() {
    const d = data();
    const body = S.err ? `<p class="txt-bad" role="alert">${esc(S.err)}</p><p><button class="btn" onclick="FlipSources.load()">Try again</button></p>`
      : !S.rows ? '<p class="small">Asking the server for the bit-flip evidence…</p>'
      : !d ? '<p class="small">The server has not built this period yet.</p>'
      : `${leadHtml(d)}
        <p class="small txt-muted">Built by the server at ${esc(when(S.rows[S.period].built_at))}; rebuilt every hour.</p>`;
    return `
    <div class="page" style="--page-max:1200px">
      <div class="panel">
        <div class="panel-header"><h2>Bit-Flip Sources</h2></div>
        <p class="small txt-muted">Who is corrupting the network's ALERT readings: every corrupted copy a base station has heard — a reading one or two bits from
          a real one, a moment after it — weighed by the carrier it came on and by the repeaters that could have carried it.</p>
        ${periodHtml()}
        ${body}
      </div>
      ${d ? `
      <div class="panel">
        <div class="panel-header"><h3 id="fs-h-suspects">Suspects</h3><span class="small">repeaters, most suspect first</span></div>
        <p class="small"><b>By carrier</b> is definite: the corrupted copy arrived on that repeater's carrier (clear ones as strong as the clean copy, so it
          sent the wrong bits). <b>Share by pass range</b> splits each corrupted copy between every repeater that passes its address — a broad range collects
          a big share just by passing many stations, so read it against <b>Carried</b> (everything heard from the addresses it passes, split the same way):
          the <b>Rate</b> is the one to compare, against the network's ${pct(d.network_rate)}. <b>Only it could have</b> counts copies no other repeater passes.</p>
        ${suspectsHtml(d)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="fs-h-map">Map</h3><span class="small">suspects by rate, corrupted stations by how many</span></div>
        <div id="fs-map" class="bf-map" aria-label="Map of the repeaters that could have corrupted readings, coloured by their rate against the network, and the corrupted stations, sized by how many; the selected repeater's stations joined to it. The Suspects table holds the same."></div>
        <p class="small"><span class="txt-bad">●</span> twice the network's rate or caught by its carrier · <span class="txt-warn">●</span> above it ·
          <span class="txt-muted">●</span> within the usual · small dots: corrupted stations. Pick a repeater to join it to its stations.</p>
        <div id="fs-selected">${selectedHtml(d)}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="fs-h-stations">Corrupted readings</h3><span class="small">by address, most first</span></div>
        ${stationsHtml(d)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="fs-h-when">When</h3></div>
        ${whenHtml(d)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="fs-h-read">Reading it</h3></div>
        <p class="small">A pair of bursts one or two bits apart is told apart by the first of: an address no station has; a station not otherwise heard for a
          week; the value that does not fit its address's last reading; the version heard more often — or left undecided, never guessed. It narrows; it does
          not convict: a repeater whose receiver hears interference passes on what it heard, so the corruption entered at its site, which is where to look,
          but its radio may be fine. Confirm with a receiver parked beside it. Station Health has the same evidence by transmitter and each transmitter's
          drift; the Bit Flipper shows what one address was corrupted into and who sent it.</p>
        <p class="small"><button class="link-btn" onclick="switchTab('health')">Station Health</button> ·
          <button class="link-btn" onclick="switchTab('bitflipper')">Bit Flipper</button> ·
          <button class="link-btn" onclick="switchTab('reception')">Reception Map</button></p>
      </div>` : ''}
    </div>`;
  }

  function redraw() {
    const host = typeof state !== 'undefined' && state.activeTab === 'flipsources' ? document.getElementById('main-content') : null;
    if (!host) return;
    host.innerHTML = render();
    initMap();
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function stopMap() {
    if (S.map) { try { removeMap(S.map); } catch (_) { /* gone */ } }
    S.map = null; S.layer = null;
  }

  function initMap() {
    registerTabTeardown('FlipSources', stopMap);
    stopMap();
    const el = document.getElementById('fs-map');
    if (!el || typeof L === 'undefined') return;
    S.map = L.map('fs-map').setView([-27.6, 152.9], 8);
    registerLiveMap('FlipSources', () => S.map);
    addBaseLayers(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    drawMap();
  }

  function colourOf(c, d) {
    const v = verdict(c, d);
    return v.rank <= 2 ? cssVarOr('--bad', '#c7401a') : v.rank === 3 ? cssVarOr('--warn', '#9e5e00') : cssVarOr('--muted', '#7a8794');
  }
  function cssVarOr(name, dflt) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt; } catch (_) { return dflt; }
  }

  function drawMap() {
    const d = data();
    if (!S.map || !S.layer || !d) return;
    S.layer.clearLayers();
    const pts = [];
    // Corrupted stations: small dots, sized by how many.
    const placed = new Map();
    (d.stations || []).forEach(s => {
      const st = s.station_id ? stationById(s.station_id) : stationOfAddr(s.addr);
      if (!st || st.lat == null || st.lon == null) return;
      placed.set(s.addr, st);
      const m = L.circleMarker([st.lat, st.lon], { radius: 2 + Math.min(8, Math.sqrt(Number(s.n))), weight: 1,
        color: cssVarOr('--accent', '#0b5cab'), fillOpacity: 0.35 });
      m.bindTooltip(`${st.name} (${s.addr}): ${s.n} corrupted`);
      m.addTo(S.layer);
      pts.push([st.lat, st.lon]);
    });
    // The selected repeater's stations, joined to it.
    const sel = S.selected ? (d.candidates || []).find(c => c.rid === S.selected) : null;
    const selSt = sel ? stationById(sel.rid) : null;
    const sLat = sel && sel.lat != null ? sel.lat : selSt && selSt.lat, sLon = sel && sel.lon != null ? sel.lon : selSt && selSt.lon;
    if (sel && sLat != null && sLon != null) {
      (d.stations || []).filter(s => (s.candidates || []).includes(sel.rid)).forEach(s => {
        const st = placed.get(s.addr);
        if (!st) return;
        const caught = s.senders && s.senders['st:' + sel.rid];
        L.polyline([[sLat, sLon], [st.lat, st.lon]], { weight: caught ? 3 : 1, opacity: caught ? 0.9 : 0.4,
          dashArray: caught ? null : '4 4', color: colourOf(sel, d) }).addTo(S.layer);
      });
    }
    // Suspects: larger, coloured by verdict.
    ranked(d).forEach(c => {
      const st = stationById(c.rid);
      const lat = c.lat != null ? c.lat : st && st.lat, lon = c.lon != null ? c.lon : st && st.lon;
      if (lat == null || lon == null) return;
      const m = L.circleMarker([lat, lon], { radius: 5 + Math.min(10, Math.sqrt(Number(c.blame) || 0)), weight: S.selected === c.rid ? 3 : 1.5,
        color: colourOf(c, d), fillOpacity: 0.7 });
      m.bindTooltip(`${c.name || c.rid}: ${verdict(c, d).word} — ${c.by_carrier} by carrier, ${c.blame} by pass range, rate ${pct(c.rate)}`);
      m.on('click', () => select(c.rid));
      m.addTo(S.layer);
      pts.push([lat, lon]);
    });
    if (pts.length && !S.fitted) { try { S.map.fitBounds(pts, { padding: [20, 20], maxZoom: 10 }); S.fitted = true; } catch (_) { /* one point */ } }
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  function setPeriod(p) { S.period = p === 30 ? 30 : 7; S.selected = null; S.fitted = false; redraw(); }
  function select(rid) {
    S.selected = S.selected === rid ? null : rid;
    redraw();
  }
  function showAll(which) { if (which === 'suspects') S.allSuspects = true; else S.allStations = true; redraw(); }

  // app.js's renderMain: the page, then the map and the data.
  function init() {
    if (!S.rows && !S.loading) load(); else initMap();
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportCsv() {
    const d = data();
    if (!d || !(d.candidates || []).length) return;
    const head = ['repeater', 'station_id', 'verdict', 'by_carrier', 'clear', 'share_by_pass_range', 'only_it', 'stations_hit', 'carried', 'rate', 'times_network'];
    const lines = [head.join(',')].concat(ranked(d).map(c => {
      const r = ratio(c, d);
      return [c.name, c.rid, verdict(c, d).word, c.by_carrier, c.clear, c.blame, c.only_it, c.stations, c.carried, c.rate ?? '', r != null ? r.toFixed(2) : '']
        .map(csvEscape).join(',');
    }));
    dlText(`bit-flip-suspects-${d.days}d.csv`, lines.join('\n') + '\n');
  }
  function exportStationsCsv() {
    const d = data();
    if (!d || !(d.stations || []).length) return;
    const head = ['address', 'station', 'corrupted', 'into_another_address', 'became', 'sent_by_carrier', 'could_have_been', 'first', 'last'];
    const lines = [head.join(',')].concat((d.stations || []).map(s => {
      const st = s.station_id ? stationById(s.station_id) : stationOfAddr(s.addr);
      return [s.addr, st ? st.name : '', s.n, s.addr_flips, (s.targets || []).map(t => `${t.addr}x${t.n}`).join(' '),
        Object.entries(s.senders || {}).map(([tx, n]) => `${txName(tx)}x${n}`).join(' '),
        (s.candidates || []).map(id => txName('st:' + id)).join('; '), s.first_at || '', s.last_at || ''].map(csvEscape).join(',');
    }));
    dlText(`bit-flip-stations-${d.days}d.csv`, lines.join('\n') + '\n');
  }

  // For the tests: fill it without the server.
  function adopt(rows) {
    S.rows = {};
    (rows || []).forEach(r => { S.rows[r.period_days] = r; });
    S.err = ''; S.loading = false; S.fitted = false;
    redraw();
  }
  function state_() { return { period: S.period, selected: S.selected, data: data(), err: S.err }; }

  return { render, init, load, setPeriod, select, showAll, exportCsv, exportStationsCsv, adopt, state: state_ };
})();
