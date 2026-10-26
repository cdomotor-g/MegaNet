// MegaNet — group-plots.js
//
//   GroupPlots   A station's neighbours, plotted together. Every river height
//                gauge along a river — from a click on the river, or from a
//                gauge's own card — and every rain gauge within a distance of a
//                station, each two ways: in ARRO, on one graph, and out of the
//                Flood-Net datastore in a dialog of strips that hands the same
//                gauges and window to the Field Data tab.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, pillText,
// stationSensors, buildArroUrl, acmaHaversineKm and fmtKm; across to
// map-river-lines.js for MapRiverLines (riverOf, stationsAlong, near,
// riverKey); to sensor-sparks.js for SensorSparks (readWindow, seriesOf and
// xTicks — the readings are read and turned into a line exactly as a sensor
// row's sparkline is); to sensor-values.js for SensorValues.kindOf; to
// health-analysis.js for HealthAnalysis.fmtWhen; to modal.js for Modal; to
// app.js for switchTab and toggleMapFullscreen; and to arro-data.js for
// ArroData.fieldChannelId and ArroData.fieldOpenGroup, the dialog's door.
// All at call time; nothing here runs at load (`npm run toplevel`).
// map-river-lines.js places riverHtml() in a river's callout; app.js places
// cardHtml() on the station card and calls cardAsk() once it is painted.
//
// ── What a group is ─────────────────────────────────────────────────────────
//
//   river   the stations along a river (MapRiverLines.stationsAlong: the ones
//           whose stream names it, and the ones with no stream recorded that
//           stand within 300 m of its line) that carry a river height sensor.
//           From a gauge's card, the river is the one MapRiverLines finds it
//           on; with the rivers not loaded, or a stream the Geofabric does not
//           draw, the gauges whose stream has the same name within NAME_KM —
//           "DEEP CREEK" is several creeks, and the card says it matched by
//           name alone.
//   rain    every station with a rain gauge within a distance of a station
//           with one, nearest first. 25 km to start, 5 to 100 by the slider,
//           remembered on this device.
//
// A gauge is a measurement, not a sensor row: "Rainfall" and "Rainfall
// Increment" on one ALERT address are one gauge, and a level's AHD row on its
// own address is the same water. ARRO is handed one device a gauge — the
// Rainfall Increment for rain, the plain Water Level for a level — and the
// datastore its address, exactly as Field Data addresses it.
//
// ── The two plots ───────────────────────────────────────────────────────────
//
// ARRO's graph takes the devices as `devices[]=site|device` and draws them on
// one chart (buildArroUrl, core.js), at most ARRO_CAP of them — the nearest,
// or the highest ground, and the pill says when it was cut.
//
// The Flood-Net plot is a dialog of strips on one time axis — a strip a gauge,
// because a river's gauges each read against their own zero and a raw count
// is a different number at every site, so one axis would draw a flat line
// under a mountain (design-system.md, *Charts*). Levels go highest ground
// first, which is roughly upstream to downstream, so a flood is seen going
// down the river; rain goes nearest first, on one millimetre scale for every
// strip so the bars compare. The pointer or the arrow keys read every strip
// at one instant; the readings are a table one press away; **Open in Field
// Data** takes the gauges and the window to the tab that filters, inspects
// and exports them.

const GroupPlots = (function () {
  const HOUR = 3600000, DAY = 86400000;
  const KM = { def: 25, min: 5, max: 100, step: 5 };
  const KM_KEY      = 'mn-group-rain-km';
  const NAME_KM     = 60;     // a stream matched by its name alone, this far from the gauge at most
  const ARRO_CAP    = 40;     // devices one ARRO graph is handed
  const STRIP_CAP   = 30;     // strips one dialog draws; Field Data takes them all
  const NAMES_SHOWN = 8;      // names listed under a pair of pills before "+N more"
  const AT_ONCE     = 4;      // addresses read at a time
  const TTL         = 120000; // a strip's readings are reused this long

  // Field Data's own window keys, so the door hands the same window over.
  const WINS = [
    { k: '24h',  label: '24 hours',  days: 1,   res: 'raw' },
    { k: '7d',   label: '7 days',    days: 7,   res: 'hourly' },
    { k: '30d',  label: '30 days',   days: 30,  res: 'hourly' },
    { k: '90d',  label: '90 days',   days: 90,  res: 'daily' },
    { k: '12mo', label: '12 months', days: 365, res: 'daily' },
  ];
  const RES_WORDS = {
    raw:    'every reading',
    hourly: 'the reading at the end of each hour, and every reading of the last few hours',
    daily:  'the reading at the end of each day, and every reading of the last few hours',
  };

  // The dialog's strips, in px: drawn at the width the dialog gives them.
  const CH = { W: 680, H: 50, L: 50, R: 10, T: 5, B: 5, AX: 22 };

  const groups = new Map();   // key -> () => group, for the inline handlers
  const cache = new Map();    // 'win|addr' -> { at, promise, data }
  let km = null;              // the rain radius, read from this device once
  let dlg = null;             // the dialog's state while it is open

  // ── words ─────────────────────────────────────────────────────────────────

  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;
  const title = s => String(s || '').toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const keyOf = s => (typeof MapRiverLines !== 'undefined' && MapRiverLines.riverKey
    ? MapRiverLines.riverKey(s) : String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const when = t => (typeof HealthAnalysis !== 'undefined' ? HealthAnalysis.fmtWhen(t) : new Date(t).toLocaleString());
  const stationById = id => ((state.data && state.data.stations) || []).find(s => s.id === id) || null;
  const located = s => !!s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);

  // ── the rain radius ───────────────────────────────────────────────────────

  function kmNow() {
    if (km == null) {
      let v = NaN;
      try { v = Number(localStorage.getItem(KM_KEY)); } catch (_) {}
      km = isFinite(v) && v >= KM.min && v <= KM.max ? v : KM.def;
    }
    return km;
  }

  function clampKm(v) {
    const n = Math.round(Number(v) / KM.step) * KM.step;
    return isFinite(n) ? Math.max(KM.min, Math.min(KM.max, n)) : KM.def;
  }

  // ── gauges ────────────────────────────────────────────────────────────────

  function kindOf(type) {
    if (typeof SensorValues !== 'undefined' && SensorValues.kindOf) return SensorValues.kindOf(type || '');
    const t = String(type || '').toLowerCase();
    return /rain/.test(t) ? 'rain' : /level|stage|ahd|height/.test(t) ? 'level' : 'other';
  }

  // The address the datastore files a sensor's readings under, by the
  // precedence meganet.reading uses (0024): its ALERT address; else its ALERT2
  // slot under the station's ALERT2 address; else its channel under the
  // station number. Null when it has none of the three.
  function addrOf(st, se) {
    if (se.alert_id != null && se.alert_id !== '') return `a:${se.alert_id}`;
    if (se.alert2_sensor_id != null && st.alert2_station_id != null) return `a2:${st.alert2_station_id}/${se.alert2_sensor_id}`;
    const chan = typeof ArroData !== 'undefined' && ArroData.fieldChannelId ? ArroData.fieldChannelId(se) : null;
    const num = String(st.station_number || '');
    return chan && num ? `s:${num}/${chan}` : null;
  }

  // A station's gauges of a kind: [{ arro, addr, type, sensor }], one a
  // measurement — the rows on one address are one gauge — with the row ARRO
  // graphs (`arro`, or null when none has a device) and the datastore's
  // address (`addr`, or null).
  function gaugesOf(st, kind) {
    const by = new Map();
    for (const se of stationSensors(st)) {
      if (kindOf(se.type) !== kind) continue;
      const k = se.alert_id != null ? `a${se.alert_id}`
        : se.alert2_sensor_id != null ? `b${se.alert2_sensor_id}` : `s${se.sensor_id || se.type}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(se);
    }
    const pref = kind === 'rain' ? /increment/i : /^water level$/i;
    return [...by.values()].map(rows => {
      const dev = rows.filter(se => se.device_id != null && se.device_id !== '');
      // The datastore's line is read off the plain row: a rain gauge's
      // counter, not its increments; a level as the gauge reads it.
      const main = rows.find(se => kind === 'rain' ? !/increment/i.test(se.type) : /^water level$/i.test(se.type)) || rows[0];
      return {
        arro:   dev.find(se => pref.test(se.type)) || dev[0] || null,
        addr:   addrOf(st, main),
        type:   main.type || (kind === 'rain' ? 'Rainfall' : 'Water Level'),
        sensor: main,
      };
    });
  }

  function membersOf(list, kind) {
    const out = [];
    for (const m of list) {
      const gauges = gaugesOf(m.st, kind);
      if (gauges.length) out.push({ ...m, gauges });
    }
    return out;
  }

  const arroKey = (st, ga) => (ga.arro && st.site && st.site.db_id != null ? `${st.site.db_id}|${ga.arro.device_id}` : null);

  // One gauge once. The register holds a few stations twice — two records on
  // one ALERT address, or on one ARRO device — and those are one gauge, not
  // two strips drawing the same readings. The station the group is about
  // keeps its own; otherwise the first in the group's order does, and a
  // record left with nothing of its own is not in the group.
  function onceEach(members, anchorId) {
    const seen = new Set(), keep = new Set();
    const order = members.filter(m => m.st.id === anchorId).concat(members.filter(m => m.st.id !== anchorId));
    for (const m of order) {
      m.gauges = m.gauges.filter(ga => {
        const keys = [ga.addr, arroKey(m.st, ga)].filter(Boolean);
        if (keys.some(k => seen.has(k))) return false;
        keys.forEach(k => seen.add(k));
        return true;
      });
      if (m.gauges.length) keep.add(m);
    }
    return members.filter(m => keep.has(m));
  }

  // Highest ground first — roughly upstream to downstream — then by name.
  function byHeight(a, b) {
    const ea = a.st.elevation_ahd, eb = b.st.elevation_ahd;
    if (ea != null && eb != null && ea !== eb) return eb - ea;
    if (ea != null && eb == null) return -1;
    if (eb != null && ea == null) return 1;
    return String(a.st.name).localeCompare(String(b.st.name));
  }

  // ── groups ────────────────────────────────────────────────────────────────

  // The gauges along a river the callout or the card found.
  function riverGroup(key, riverTitle, along, { anchorId = null, how = 'river' } = {}) {
    const seen = new Set(), list = [];
    for (const m of along) if (m && m.st && !seen.has(m.st.id)) { seen.add(m.st.id); list.push(m); }
    const anchor = anchorId ? stationById(anchorId) : null;
    if (anchor && !seen.has(anchor.id)) list.push({ st: anchor, how: 'self' });
    const members = onceEach(membersOf(list, 'level').sort(byHeight), anchorId);
    return {
      key, kind: 'level', how, anchorId,
      title: riverTitle,
      heading: `${riverTitle} — river height`,
      stationCount: list.length,
      members,
    };
  }

  // The river a gauge's card plots: the one MapRiverLines finds it on, else
  // the gauges whose stream has its stream's name, within NAME_KM.
  function streamGroup(st) {
    const key = `stream:${st.id}`;
    const R = typeof MapRiverLines !== 'undefined' && MapRiverLines.riverOf ? MapRiverLines.riverOf(st) : null;
    if (R) return riverGroup(key, R.title, MapRiverLines.stationsAlong(R.id), { anchorId: st.id, how: R.how === 'line' ? 'line' : 'river' });
    if (!st.stream || !located(st)) return null;
    const k = keyOf(st.stream);
    const along = ((state.data && state.data.stations) || []).filter(x => x.stream && located(x)
      && keyOf(x.stream) === k && acmaHaversineKm(st.lat, st.lon, x.lat, x.lon) <= NAME_KM)
      .map(x => ({ st: x, how: 'name' }));
    return riverGroup(key, title(st.stream), along, { anchorId: st.id, how: 'name' });
  }

  // Every rain gauge within `radius` km of a station, nearest first.
  function rainGroup(st, radius) {
    const r = clampKm(radius == null ? kmNow() : radius);
    const list = [];
    if (located(st)) {
      for (const x of (state.data && state.data.stations) || []) {
        if (!located(x)) continue;
        const d = x.id === st.id ? 0 : acmaHaversineKm(st.lat, st.lon, x.lat, x.lon);
        if (d <= r) list.push({ st: x, km: d, how: x.id === st.id ? 'self' : 'near' });
      }
    }
    const members = onceEach(membersOf(list, 'rain')
      .sort((a, b) => a.km - b.km || String(a.st.name).localeCompare(String(b.st.name))), st.id);
    return {
      key: `rain:${st.id}`, kind: 'rain', how: 'near', anchorId: st.id, km: r,
      title: `Rain within ${r} km of ${st.name}`,
      heading: `Rain within ${r} km of ${st.name}`,
      stationCount: list.length,
      members,
    };
  }

  function groupOf(key) {
    const make = groups.get(key);
    if (make) return make();
    // A key whose builder went with a repaint: the station ones rebuild.
    const [kind, id] = String(key).split(/:(.*)/s);
    const st = stationById(id);
    if (!st) return null;
    return kind === 'rain' ? rainGroup(st) : kind === 'stream' ? streamGroup(st) : null;
  }

  // ── what a group hands over ──────────────────────────────────────────────

  function arroOf(g) {
    const have = [];
    for (const m of g.members) for (const ga of m.gauges) if (arroKey(m.st, ga)) have.push({ station: m.st, sensor: ga.arro });
    const built = typeof buildArroUrl === 'function' ? buildArroUrl(have.slice(0, ARRO_CAP)) : null;
    return built ? { url: built.url, count: built.count, of: have.length } : null;
  }

  function stripsOf(g) {
    const out = [];
    for (const m of g.members) {
      for (const ga of m.gauges) {
        if (ga.addr) out.push({ st: m.st, km: m.km, self: m.st.id === g.anchorId, addr: ga.addr, type: ga.type, sensor: ga.sensor });
      }
    }
    return out;
  }

  // ── the pills, and the names they capture ────────────────────────────────

  function namesHtml(g) {
    const ms = g.members;
    const shown = ms.slice(0, NAMES_SHOWN).map(m => {
      const tags = [];
      if (m.st.id === g.anchorId) tags.push('this one');
      else if (g.kind === 'rain' && isFinite(m.km)) tags.push(fmtKm(m.km));
      if (m.how === 'line') tags.push('on its line');
      return `${esc(m.st.name)}${tags.length ? ` <span class="txt-muted">(${esc(tags.join(', '))})</span>` : ''}`;
    });
    const more = ms.length - shown.length;
    return `<span class="small gplot-names">${shown.join(', ')}${more > 0 ? ` <span class="txt-muted">+${more} more</span>` : ''}</span>`;
  }

  // The pair, for a group of two or more gauges. `where` is the ARRO pill's
  // own words ("this river", "rain").
  function pillsHtml(g, where) {
    const a = arroOf(g);
    const strips = stripsOf(g).length;
    const n = g.members.length;
    const arroPill = a
      ? `<a class="pill gplot-arro" href="${escAttr(a.url)}" target="_blank" rel="noopener"
           title="${escAttr(`Open ARRO's graph with ${a.count === 1 ? 'this gauge' : `these ${a.count} gauges`} on one chart${a.of > a.count ? ` — the first ${a.count} of ${a.of}` : ''}`)}"
           >${pillText('📈', `ARRO ${esc(where)} · ${a.count}${a.of > a.count ? ` of ${a.of}` : ''}`, '↗')}</a>`
      : '';
    const fnPill = strips && typeof Modal !== 'undefined'
      ? `<button type="button" class="pill gplot-fn" data-key="${escAttr(g.key)}" onclick="GroupPlots.plot(this.dataset.key)"
           title="${escAttr(`Plot ${strips === 1 ? 'this gauge' : `these ${strips} gauges`} out of the Flood-Net datastore, a strip each on one time axis`)}"
           >${pillText('📉', `Flood-Net plot · ${strips}`)}</button>`
      : '';
    // Which of the stations named below each plot leaves out, and why.
    const noArro = g.members.filter(m => !(m.st.site && m.st.site.db_id != null) || !m.gauges.some(ga => ga.arro)).length;
    const noAddr = g.members.filter(m => !m.gauges.some(ga => ga.addr)).length;
    const gaps = [];
    if (noArro) gaps.push(noArro === n ? 'none is in ARRO' : `${plural(noArro, 'is', 'are')} not in ARRO`);
    if (noAddr) gaps.push(noAddr === n ? 'none has an address the datastore files readings under'
      : `${plural(noAddr, 'has', 'have')} no address the datastore files readings under`);
    return `<div class="pill-row gplot-pills">${arroPill}${fnPill}</div>${namesHtml(g)}${
      gaps.length ? `<span class="small txt-muted gplot-gaps">Of these, ${esc(gaps.join('; '))}.</span>` : ''}`;
  }

  // ── a river's callout (map-river-lines.js) ───────────────────────────────

  function riverHtml(id, riverTitle, along) {
    const key = `river:${id}`;
    const snapshot = along.slice();
    groups.set(key, () => riverGroup(key, riverTitle, snapshot));
    const g = riverGroup(key, riverTitle, snapshot);
    const n = g.members.length;
    if (!n) {
      return `<span class="mn-pop-line txt-muted gplot-callout">No river height gauge along it to plot.</span><br>`;
    }
    const line = snapshot.some(m => m.how === 'line') ? ', with the gauges on its line that record no stream' : '';
    return `<div class="gplot-callout">
      <span class="mn-pop-line">${esc(`${plural(n, 'river height gauge')} along it${line} — plot ${n === 1 ? 'it' : 'them'} together:`)}</span>
      ${pillsHtml(g, 'this river')}
    </div>`;
  }

  // ── the station card (app.js) ────────────────────────────────────────────

  // Why a gauge has no river to plot, in the words that fit: the rivers are
  // switched off, still on their way, or here and none passes near it.
  function noRiverHtml(failed) {
    const R = typeof MapRiverLines !== 'undefined' ? MapRiverLines : null;
    const why = R && R.loaded()
      ? `No stream is recorded for this gauge, and no river drawn on the map passes within ${R.NEAR_M} m of it.`
      : !R || !state.mapRiverLines
        ? 'No stream is recorded for this gauge. With the rivers switched on (Map display), the one it stands on is found from the map.'
        : failed ? 'No stream is recorded for this gauge, and the rivers could not be loaded to find the one it stands on.'
          : 'No stream is recorded for this gauge — finding the river it stands on…';
    return `<div class="gplot-row-head"><b>River</b></div><span class="small txt-muted">${esc(why)}</span>`;
  }

  function riverRowHtml(st) {
    if (!gaugesOf(st, 'level').length) return '';
    return `<div class="gplot-row" id="gplot-river-${escAttr(String(st.id))}">${riverRowInner(st)}</div>`;
  }

  function riverRowInner(st, failed = false) {
    const g = streamGroup(st);
    if (!g) return noRiverHtml(failed);
    groups.set(g.key, () => streamGroup(stationById(st.id) || st));
    const n = g.members.length;
    const how = g.how === 'name'
      ? ` <span class="small txt-muted">— matched by the stream's name within ${NAME_KM} km</span>`
      : g.how === 'line' ? ` <span class="small txt-muted">— the river drawn nearest it; no stream is recorded</span>` : '';
    return `<div class="gplot-row-head"><b>River</b> · ${esc(n === 1 ? 'the only river height gauge' : plural(n, 'river height gauge'))} on the ${esc(g.title)}${how}</div>
      ${n > 1 ? pillsHtml(g, 'this river') : '<span class="small txt-muted">No other gauge on it to plot beside this one.</span>'}`;
  }

  function rainBodyHtml(st) {
    const g = rainGroup(st);
    groups.set(g.key, () => rainGroup(stationById(st.id) || st));
    const n = g.members.length;
    if (n > 1) return pillsHtml(g, 'rain');
    return `<span class="small txt-muted">No other rain gauge within ${g.km} km${g.km < KM.max ? ' — widen it' : ''}.</span>`;
  }

  function rainRowHtml(st) {
    if (!gaugesOf(st, 'rain').length || !located(st)) return '';
    const r = kmNow(), id = `gplot-km-${st.id}`;
    return `<div class="gplot-row">
      <div class="gplot-row-head gplot-km">
        <label for="${escAttr(id)}"><b>Rain</b> within <output id="${escAttr(id)}-out" for="${escAttr(id)}">${r} km</output></label>
        <input type="range" id="${escAttr(id)}" class="gplot-range" min="${KM.min}" max="${KM.max}" step="${KM.step}" value="${r}"
               aria-valuetext="${r} km" data-id="${escAttr(st.id)}" oninput="GroupPlots.setKm(this.value, this.dataset.id)">
      </div>
      <div id="gplot-rain-${escAttr(st.id)}">${rainBodyHtml(st)}</div>
    </div>`;
  }

  function sectionInner(st) {
    const rows = riverRowHtml(st) + rainRowHtml(st);
    if (!rows) return '';
    return `<span class="small txt-muted stn-card-rhs-head"
        title="This station's neighbours plotted with it — in ARRO on one graph, or out of the Flood-Net datastore a strip each">Plot with its neighbours</span>${rows}`;
  }

  function cardHtml(st) {
    if (!st || (!gaugesOf(st, 'level').length && !gaugesOf(st, 'rain').length)) return '';
    const inner = sectionInner(st);
    return inner ? `<div class="acma-sect stn-card-gplots" id="mn-gplots-card-${escAttr(String(st.id))}"
      data-mn-gplots="${escAttr(String(st.id))}">${inner}</div>` : '';
  }

  // Once the card is painted: the rivers and the tiles around the gauge, and
  // the river row again with them — the river it stands on can change from a
  // name match to the river itself. The row alone, so a thumb on the rain
  // slider below it is not lifted off. Only while the rivers are switched on:
  // the national file is 1.5 MB, and somebody who turned them off has said
  // what they think of it.
  function cardAsk(st) {
    if (!st || !located(st) || !gaugesOf(st, 'level').length) return;
    if (typeof MapRiverLines === 'undefined' || !MapRiverLines.near || !state.mapRiverLines) return;
    const refill = failed => {
      const el = document.getElementById(`gplot-river-${st.id}`);
      if (!el) return;
      const keep = el.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      el.innerHTML = riverRowInner(stationById(st.id) || st, failed);
      if (keep) el.querySelector(`[data-key="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    };
    MapRiverLines.near(st.lat, st.lon).then(() => refill(false), () => refill(true));
  }

  // The slider, on the card or in the dialog: the radius for every station,
  // remembered on this device.
  function setKm(v, id) {
    km = clampKm(v);
    try { localStorage.setItem(KM_KEY, String(km)); } catch (_) {}
    const st = stationById(id);
    const out = document.getElementById(`gplot-km-${id}-out`);
    if (out) out.textContent = `${km} km`;
    const range = document.getElementById(`gplot-km-${id}`);
    if (range) range.setAttribute('aria-valuetext', `${km} km`);
    const body = document.getElementById(`gplot-rain-${id}`);
    if (st && body) body.innerHTML = rainBodyHtml(st);
  }

  // ── the dialog ────────────────────────────────────────────────────────────

  function winOf(k) { return WINS.find(w => w.k === k) || WINS[1]; }

  function plot(key) {
    const g = groupOf(key);
    if (!g || typeof Modal === 'undefined') return;
    Modal.open({
      title: g.heading,
      wide: true,
      onClose: () => { dlg = null; },
      html: `
        <div class="gplot-modal">
          <p class="small gplot-sub" id="gplot-sub"></p>
          ${g.kind === 'rain' ? `
            <div class="gplot-km gplot-km--dlg">
              <label for="gplot-dlg-km">Within <output id="gplot-dlg-km-out" for="gplot-dlg-km">${g.km} km</output></label>
              <input type="range" id="gplot-dlg-km" class="gplot-range" min="${KM.min}" max="${KM.max}" step="${KM.step}" value="${g.km}"
                     aria-valuetext="${g.km} km" oninput="GroupPlots.dlgKm(this.value, false)" onchange="GroupPlots.dlgKm(this.value, true)">
            </div>` : ''}
          <div class="hl-seg gplot-wins" role="group" aria-label="Over the last">
            ${WINS.map(w => `<button type="button" class="hl-chip" data-win="${w.k}" aria-pressed="false"
              onclick="GroupPlots.setWin('${w.k}')">${esc(w.label)}</button>`).join('')}
          </div>
          <div id="gplot-body"></div>
          <div class="sspk-foot gplot-foot">
            <span class="small txt-muted">The Field Data tab filters, inspects and exports these readings.</span>
            <span id="gplot-arro"></span>
            <button type="button" class="primary" onclick="GroupPlots.toField()"
              title="Open these gauges on the Field Data tab over the same window">📈 Open in Field Data →</button>
          </div>
        </div>`,
    });
    // After open(): a dialog it replaced is told it closed, which clears dlg.
    dlg = { key, g, win: '7d', seq: 0, strips: [], at: null, W: CH.W };
    setWin('7d');
  }

  // The rain radius from inside the dialog: the words follow the thumb, the
  // gauges follow the release.
  function dlgKm(v, commit) {
    if (!dlg || dlg.g.kind !== 'rain') return;
    const r = clampKm(v);
    const out = document.getElementById('gplot-dlg-km-out');
    if (out) out.textContent = `${r} km`;
    document.getElementById('gplot-dlg-km')?.setAttribute('aria-valuetext', `${r} km`);
    if (!commit) return;
    setKm(r, dlg.g.anchorId);
    const st = stationById(dlg.g.anchorId);
    if (!st) return;
    dlg.g = rainGroup(st, r);
    const h = document.getElementById('app-modal-title');
    if (h) h.textContent = dlg.g.heading;
    setWin(dlg.win);
  }

  function setWin(k) {
    if (!dlg) return;
    const w = winOf(k);
    dlg.win = w.k;
    document.querySelectorAll('.gplot-wins [data-win]').forEach(b => {
      const on = b.dataset.win === w.k;
      b.classList.toggle('hl-chip--on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const seq = ++dlg.seq;
    const t1 = Date.now();
    dlg.t0 = t1 - w.days * DAY;
    dlg.t1 = t1;
    dlg.at = null;
    const all = stripsOf(dlg.g);
    dlg.strips = all.slice(0, STRIP_CAP).map(s => ({ ...s, state: 'wait', S: null, err: '' }));
    dlg.cut = all.length - dlg.strips.length;
    const body = document.getElementById('gplot-body');
    if (body) dlg.W = Math.max(300, Math.min(CH.W, Math.round(body.clientWidth || CH.W)));
    paintFrame();
    const a = arroOf(dlg.g);
    const arro = document.getElementById('gplot-arro');
    if (arro) {
      arro.innerHTML = a ? `<a class="pill" href="${escAttr(a.url)}" target="_blank" rel="noopener"
        title="${escAttr(`The same gauges on ARRO's graph${a.of > a.count ? ` — the first ${a.count} of ${a.of}` : ''}`)}">${pillText('📈', 'Open in ARRO', '↗')}</a>` : '';
    }
    // A few at a time, each strip drawn as it lands.
    let next = 0;
    const me = dlg;
    const pump = () => {
      if (dlg !== me || me.seq !== seq) return;
      const i = next++;
      if (i >= me.strips.length) return;
      loadStrip(me, i, w).finally(pump);
    };
    for (let k2 = 0; k2 < AT_ONCE; k2++) pump();
  }

  function read(addr, w) {
    const key = `${w.k}|${addr}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = SensorSparks.readWindow([addr], Date.now() - w.days * DAY, w.res)
      .catch(err => { cache.delete(key); throw err; });
    cache.set(key, entry);
    return entry.promise;
  }

  function loadStrip(me, i, w) {
    const s = me.strips[i];
    const seq = me.seq;
    s.state = 'wait'; s.err = '';
    return read(s.addr, w).then(data => {
      if (dlg !== me || me.seq !== seq) return;
      const kind = me.g.kind;
      s.S = SensorSparks.seriesOf({ kind, incr: kind === 'rain', st: s.st, addr: s.addr },
        data.pts[s.addr] || [], me.t0, me.t1, false);
      s.capped = data.capped;
      s.res = data.res;
      s.state = 'ok';
      paintStrips();
    }, err => {
      if (dlg !== me || me.seq !== seq) return;
      s.state = 'err';
      s.err = err && err.message || String(err);
      paintStrips();
    });
  }

  function retry(i) {
    if (!dlg || !dlg.strips[i]) return;
    loadStrip(dlg, i, winOf(dlg.win));
    paintStrips();
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  const has = S => !!S && (S.shape === 'bars' ? S.n > 0 : S.pts.length > 0);
  const f1 = v => v.toFixed(1);

  function X(t) {
    const W = dlg.W;
    return CH.L + (W - CH.L - CH.R) * (t - dlg.t0) / ((dlg.t1 - dlg.t0) || 1);
  }

  // One millimetre scale for every rain strip, so the bars compare; each
  // level on its own, because its zero is its own.
  function rangeOf(S) {
    if (dlg.g.kind === 'rain') {
      let hi = 1;
      for (const s of dlg.strips) if (s.S && s.S.shape === 'bars') for (const b of s.S.bars) if (b.v > hi) hi = b.v;
      return [0, hi];
    }
    return [S.lo, S.hi];
  }

  function stripSvg(s, i) {
    const S = s.S, W = dlg.W;
    const [lo, hi] = rangeOf(S);
    const Y = v => CH.T + (CH.H - CH.T - CH.B) * (1 - (v - lo) / ((hi - lo) || 1));
    let g = '';
    for (const tk of xTicks()) {
      const x = X(tk.t);
      if (x >= CH.L && x <= W - CH.R) g += `<line class="sspk-grid sspk-grid--x" x1="${f1(x)}" x2="${f1(x)}" y1="${CH.T}" y2="${CH.H - CH.B}"/>`;
    }
    g += `<line class="sspk-grid" x1="${CH.L}" x2="${W - CH.R}" y1="${CH.H - CH.B}" y2="${CH.H - CH.B}"/>`;
    g += `<text class="sspk-tick" x="${CH.L - 6}" y="${CH.T + 8}" text-anchor="end">${esc(S.fmt(hi).replace(/ .*$/, ''))}</text>`
       + `<text class="sspk-tick" x="${CH.L - 6}" y="${CH.H - CH.B}" text-anchor="end">${esc(S.fmt(lo).replace(/ .*$/, ''))}</text>`;
    if (S.shape === 'bars') {
      const base = Y(0);
      for (const b of S.bars) {
        if (!b.v) continue;
        const x = X(b.t), wd = Math.max(1, X(b.t1) - x - 0.6), y = Y(b.v);
        g += `<rect class="sspk-bar" x="${f1(x)}" y="${f1(y)}" width="${f1(wd)}" height="${f1(Math.max(1, base - y))}"/>`;
      }
    } else {
      const gap = gapOf(S.pts);
      let d = '';
      S.pts.forEach((p, k) => {
        const q = S.pts[k - 1], n = S.pts[k + 1];
        const start = !q || p.t - q.t > gap;
        d += `${start ? 'M' : 'L'}${f1(X(p.t))} ${f1(Y(p.v))}`;
        if (start && (!n || n.t - p.t > gap)) d += 'h0.1';
      });
      g += `<path class="sspk-line" d="${d}"/>`;
      const last = S.pts[S.pts.length - 1];
      g += `<circle class="sspk-end" cx="${f1(X(last.t))}" cy="${f1(Y(last.v))}" r="3"/>`;
    }
    g += `<line class="sspk-cross" id="gplot-cross-${i}" x1="0" x2="0" y1="${CH.T}" y2="${CH.H - CH.B}" visibility="hidden"/>`
       + `<circle class="sspk-dot" id="gplot-dot-${i}" cx="0" cy="0" r="3.5" visibility="hidden"/>`;
    return `<svg class="gplot-chart" viewBox="0 0 ${W} ${CH.H}" role="img"
      aria-label="${escAttr(`${s.st.name}, ${s.type}: ${said(s)}`)}">${g}</svg>`;
  }

  function xTicks() {
    return typeof SensorSparks !== 'undefined' && SensorSparks.xTicks
      ? SensorSparks.xTicks(dlg.t0, dlg.t1, dlg.W < 520 ? 4 : 7) : [];
  }

  function axisSvg() {
    const W = dlg.W;
    let g = '';
    for (const tk of xTicks()) {
      const x = X(tk.t);
      if (x < CH.L - 0.5 || x > W - CH.R + 0.5) continue;
      g += `<text class="sspk-tick" x="${f1(x)}" y="14" text-anchor="middle">${esc(tk.text)}</text>`;
    }
    return `<svg class="gplot-axis" viewBox="0 0 ${W} ${CH.AX}" aria-hidden="true">${g}</svg>`;
  }

  // Three times the usual gap between readings, never tighter than an hour or
  // two buckets: a line lifts across a silence rather than ruling over it.
  function gapOf(pts) {
    const floor = dlg && winOf(dlg.win).res === 'raw' ? HOUR : dlg && winOf(dlg.win).res === 'hourly' ? 6 * HOUR : 2.5 * DAY;
    const d = [];
    for (let i = 1; i < pts.length; i++) { const g = pts[i].t - pts[i - 1].t; if (g > 0) d.push(g); }
    if (d.length < 3) return Infinity;
    d.sort((a, b) => a - b);
    return Math.max(3 * d[d.length >> 1], floor);
  }

  // What a strip says when nothing points at it: a level's latest, the rain
  // in the window.
  function restValue(s) {
    const S = s.S;
    if (!has(S)) return '—';
    if (S.shape === 'bars') return `${S.fmt(S.total || 0)}`;
    const last = S.pts[S.pts.length - 1];
    return `${S.fmt(last.v)}${S.counts ? ' raw' : ''}`;
  }

  function said(s) {
    const S = s.S, w = winOf(dlg.win);
    if (!has(S)) return `nothing in the last ${w.label}`;
    if (S.shape === 'bars') return `${S.total ? S.fmt(S.total) : 'no rain'} in the last ${w.label}`;
    const last = S.pts[S.pts.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (const p of S.pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    return `${S.fmt(last.v)}${S.counts ? ' raw' : ''} at ${when(last.t)}; ${lo === hi ? 'steady' : `${S.fmt(lo)} to ${S.fmt(hi)}`} over the last ${w.label}`;
  }

  // The frame: the headline, the stage and its strips, the words under it.
  function paintFrame() {
    const g = dlg.g;
    const sub = document.getElementById('gplot-sub');
    if (sub) {
      sub.textContent = g.kind === 'rain'
        ? `What each rain gauge within ${g.km} km has sent, out of the Flood-Net datastore — nearest first, on one millimetre scale so the bars compare.`
        : `What each river height gauge along the ${g.title} has sent, out of the Flood-Net datastore — highest ground first, roughly upstream to downstream, each on its own scale because each reads against its own zero.`;
    }
    const body = document.getElementById('gplot-body');
    if (!body) return;
    if (!dlg.strips.length) {
      body.innerHTML = `<p class="sspk-none">None of these gauges has an address the datastore files readings under.</p>`;
      return;
    }
    body.innerHTML = `
      <p class="gplot-head" id="gplot-head"></p>
      <div class="gplot-stage" tabindex="0" role="group"
           aria-label="The strips, one a gauge — the arrow keys step through time, Home and End go to the ends"
           onkeydown="GroupPlots.key(event)" onpointermove="GroupPlots.point(event)" onpointerleave="GroupPlots.unpoint()">
        <div id="gplot-strips"></div>
        ${axisSvg()}
      </div>
      <p class="small gplot-read" id="gplot-read" aria-live="polite"></p>
      <p class="small txt-muted sspk-how" id="gplot-how"></p>
      <div id="gplot-table"></div>`;
    paintStrips();
  }

  function paintStrips() {
    if (!dlg) return;
    const box = document.getElementById('gplot-strips');
    if (!box) return;
    box.innerHTML = dlg.strips.map((s, i) => {
      const tags = [];
      if (s.self) tags.push('this station');
      else if (dlg.g.kind === 'rain' && isFinite(s.km)) tags.push(fmtKm(s.km));
      tags.push(SensorSparks.addrLabel ? SensorSparks.addrLabel(s.addr) : s.addr);
      const head = `<div class="gplot-strip-head">
          <span class="gplot-name">${esc(s.st.name)}</span>
          <span class="small txt-muted">${esc(tags.join(' · '))}</span>
          <span class="gplot-val" id="gplot-v-${i}">${s.state === 'ok' ? esc(restValue(s)) : ''}</span>
        </div>`;
      let chart;
      if (s.state === 'wait') chart = `<div class="gplot-hold small txt-muted">Reading…</div>`;
      else if (s.state === 'err') {
        chart = `<div class="gplot-hold small sspk-err" role="alert">Could not be read — ${esc(s.err)}.
          <button type="button" class="link-btn" onclick="GroupPlots.retry(${i})">Try again</button></div>`;
      } else if (!has(s.S)) chart = `<div class="gplot-hold small txt-muted">Nothing in the last ${esc(winOf(dlg.win).label)}.</div>`;
      else chart = stripSvg(s, i);
      return `<div class="gplot-strip" data-i="${i}">${head}${chart}</div>`;
    }).join('');
    paintWords();
    if (dlg.at != null) mark(dlg.at);
  }

  function paintWords() {
    const w = winOf(dlg.win);
    const done = dlg.strips.filter(s => s.state === 'ok');
    const sent = done.filter(s => has(s.S));
    const waiting = dlg.strips.length - done.length - dlg.strips.filter(s => s.state === 'err').length;
    const head = document.getElementById('gplot-head');
    if (head) {
      let t = `${sent.length} of ${plural(dlg.strips.length, 'gauge')} sent readings in the last ${w.label}`;
      if (dlg.g.kind === 'rain' && sent.length) {
        const top = sent.reduce((a, b) => ((b.S.total || 0) > (a.S.total || 0) ? b : a));
        if (top.S.total) t += `; the most, ${top.S.fmt(top.S.total)} at ${top.st.name}`;
      }
      head.innerHTML = `<b>${esc(t)}${waiting > 0 ? '' : '.'}</b>${waiting > 0 ? ` <span class="small txt-muted">— ${waiting} still reading…</span>` : ''}`;
    }
    const how = document.getElementById('gplot-how');
    if (how) {
      const bits = [];
      const res = done[0] ? done[0].res : w.res;
      bits.push(`Drawn from ${RES_WORDS[res] || RES_WORDS.raw}`);
      if (dlg.g.kind === 'rain') bits.push('the rain in each stretch from each gauge\'s tips, its counter\'s wraps and resets taken out');
      else if (sent.some(s => s.S.counts)) bits.push('a gauge with no conversion recorded is drawn in raw counts, and says so');
      if (dlg.g.how === 'name') bits.push(`the gauges were matched by the stream's name within ${NAME_KM} km — the river itself is not drawn here`);
      if (dlg.cut > 0) bits.push(`${plural(dlg.cut, 'more gauge')} than one dialog draws (${STRIP_CAP}) — Field Data takes them all`);
      if (done.some(s => s.capped)) bits.push('a gauge sent more than one look reads — Field Data has the rest');
      how.textContent = `${bits.join('; ')}.`;
    }
    const table = document.getElementById('gplot-table');
    if (table) table.innerHTML = tableHtml();
  }

  // The data as a table (design-system.md, *Charts*, part 3): a row a gauge.
  function tableHtml() {
    const rain = dlg.g.kind === 'rain';
    const rows = dlg.strips.map(s => {
      const S = s.S;
      const n = S ? S.n : 0;
      let value = '—', at = '—';
      if (has(S)) {
        if (S.shape === 'bars') {
          value = S.fmt(S.total || 0);
          const top = S.bars.reduce((a, b) => (b.v > a.v ? b : a), S.bars[0]);
          at = top && top.v ? `${S.fmt(top.v)} from ${when(top.t)}` : '—';
        } else {
          const last = S.pts[S.pts.length - 1];
          value = `${S.fmt(last.v)}${S.counts ? ' raw' : ''}`;
          at = when(last.t);
        }
      } else if (s.state === 'wait') value = 'reading…';
      else if (s.state === 'err') value = 'could not be read';
      return `<tr><td>${esc(s.st.name)}</td>${rain ? `<td class="num">${s.self ? '—' : esc(fmtKm(s.km))}</td>` : ''}
        <td class="mono">${esc(s.addr)}</td><td class="num">${n.toLocaleString()}</td>
        <td class="num">${esc(value)}</td><td>${esc(at)}</td></tr>`;
    }).join('');
    return `
      <details class="sspk-data">
        <summary>The ${esc(plural(dlg.strips.length, 'gauge'))}, as a table</summary>
        <div class="table-wrap sspk-table-wrap" role="region" tabindex="0" aria-label="The gauges">
          <table class="sspk-table"><thead><tr><th scope="col">Station</th>${rain ? '<th scope="col">Away</th>' : ''}
            <th scope="col">Address</th><th scope="col">Readings</th>
            <th scope="col">${rain ? 'Rain in the window' : 'Latest'}</th><th scope="col">${rain ? 'Wettest stretch' : 'When'}</th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div>
      </details>`;
  }

  // ── reading every strip at one instant ───────────────────────────────────

  function valueAt(s, t) {
    const S = s.S;
    if (!has(S)) return null;
    if (S.shape === 'bars') {
      const b = S.bars.find(x => t >= x.t && t < x.t1);
      return b ? { t: (b.t + b.t1) / 2, v: b.v, text: S.fmt(b.v) } : null;
    }
    const pts = S.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m + 1; else hi = m; }
    const a = pts[lo - 1], b = pts[lo];
    const p = a && (!b || t - a.t < b.t - t) ? a : b;
    const tol = Math.max(gapOf(pts) === Infinity ? (dlg.t1 - dlg.t0) / 40 : gapOf(pts) / 2, (dlg.t1 - dlg.t0) / 300);
    return p && Math.abs(p.t - t) <= tol ? { t: p.t, v: p.v, text: `${S.fmt(p.v)}${S.counts ? ' raw' : ''}` } : null;
  }

  function mark(t) {
    if (!dlg) return;
    t = Math.max(dlg.t0, Math.min(dlg.t1, t));
    dlg.at = t;
    dlg.strips.forEach((s, i) => {
      const cross = document.getElementById(`gplot-cross-${i}`), dot = document.getElementById(`gplot-dot-${i}`);
      const val = document.getElementById(`gplot-v-${i}`);
      if (!cross) { if (val && s.state === 'ok') val.textContent = '—'; return; }
      const x = X(t);
      cross.setAttribute('x1', f1(x)); cross.setAttribute('x2', f1(x)); cross.setAttribute('visibility', 'visible');
      const hit = valueAt(s, t);
      if (hit && dot) {
        const [lo, hi] = rangeOf(s.S);
        const y = CH.T + (CH.H - CH.T - CH.B) * (1 - (hit.v - lo) / ((hi - lo) || 1));
        dot.setAttribute('cx', f1(X(hit.t))); dot.setAttribute('cy', f1(y)); dot.setAttribute('visibility', 'visible');
      } else if (dot) dot.setAttribute('visibility', 'hidden');
      if (val) val.textContent = hit ? hit.text : '—';
    });
    const read = document.getElementById('gplot-read');
    if (read) read.textContent = when(t);
  }

  function point(e) {
    if (!dlg) return;
    const svg = e.currentTarget && e.currentTarget.querySelector('svg.gplot-chart, svg.gplot-axis');
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const W = dlg.W;
    const px = (e.clientX - box.left) * W / (box.width || W);
    mark(dlg.t0 + (px - CH.L) / (W - CH.L - CH.R) * (dlg.t1 - dlg.t0));
  }

  function unpoint() {
    if (!dlg) return;
    dlg.at = null;
    dlg.strips.forEach((s, i) => {
      document.getElementById(`gplot-cross-${i}`)?.setAttribute('visibility', 'hidden');
      document.getElementById(`gplot-dot-${i}`)?.setAttribute('visibility', 'hidden');
      const val = document.getElementById(`gplot-v-${i}`);
      if (val && s.state === 'ok') val.textContent = restValue(s);
    });
    const read = document.getElementById('gplot-read');
    if (read) read.textContent = '';
  }

  function key(e) {
    if (!dlg) return;
    const span = dlg.t1 - dlg.t0;
    const step = span / (e.shiftKey ? 10 : 100);
    const at = dlg.at == null ? dlg.t1 : dlg.at;
    const to = { ArrowLeft: at - step, ArrowRight: at + step, Home: dlg.t0, End: dlg.t1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    mark(to);
  }

  // ── the door ──────────────────────────────────────────────────────────────

  // The same gauges and window on the Field Data tab — every one of them,
  // past the dialog's cap. Out of full screen first and the tab switched
  // before the picker is set, as the station card's Field data → does
  // (fieldDataFromCard, app.js).
  function toField() {
    if (!dlg || typeof ArroData === 'undefined' || !ArroData.fieldOpenGroup) return;
    const { g, win } = dlg;
    const items = stripsOf(g).map(s => ({ addr: s.addr, station: s.st, sensor: s.sensor, label: s.type }));
    Modal.close();
    if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    switchTab('field');
    ArroData.fieldOpenGroup({ title: g.heading, items, win });
    if (typeof announce === 'function') announce(`Field Data: ${g.heading}, ${winOf(win).label}`);
  }

  return {
    riverHtml, cardHtml, cardAsk, setKm,
    plot, dlgKm, setWin, retry, point, unpoint, key, toField,
    // for test/groupplots.mjs
    gaugesOf, streamGroup, rainGroup, groupOf, arroOf, stripsOf, KM, WINS,
  };
})();

if (typeof window !== 'undefined') window.GroupPlots = GroupPlots;
