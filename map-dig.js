// MegaNet — map-dig.js
//
//   MapDig   🚧 Before you dig: what is in the way of site works at a station
//            — an orifice line trenched to the creek, old footings dug out, a
//            crane set up to lift a mast — read from the open-data maps the
//            Stations map already draws, for one spot or along a line drawn
//            on the map.
//
// Asked for 20 Nov 2026, with the Before you dig view in the Property group
// (map-views.js): "show users anything that might impact a station
// infrastructure in its operation or remediation … where we can't dig and
// where we can't use cranes, or where we need to look into more detail".
//
// What it reads, all through the same services and ways of asking as More map
// layers (map-feeds.js, MapFeeds.digSources()), the property lines
// (the State's cadastre, as map-lots.js draws it), site-exposure.js's acid
// sulfate soil bands and map-wind.js's regions:
//
//   overhead      Geoscience Australia's transmission lines; Energex and
//                 Ergon's lines (Qld) — with the State's exclusion zone for
//                 a crane or other plant beside each.
//   underground   Energex and Ergon's cables; gas and oil pipelines; the
//                 water, sewer and stormwater mains a council or utility
//                 publishes (Brisbane, Unitywater, Melbourne Water, three
//                 Victorian councils).
//   land          the lot it is on and how near its boundary, road reserves,
//                 easements and the lot's tenure (Qld); national parks;
//                 cultural heritage parties; the fire ant zones.
//   ground        acid sulfate soil, the soil type, the wind region, past
//                 flood outlines.
//
// Each finding is banded by how near it is against the ring the panel sets
// (10–100 m): red inside it (stop and look), amber inside twice it (check),
// and the rest left out. A finding about the place itself (a zone, a soil) is
// banded by what it means for the work.
//
// None of this is a locate. Every source says so and so does the panel: the
// open data leaves out telecommunications, gas distribution, most councils'
// pipes and anything private on the property. The panel sends the reader to
// Before You Dig Australia for the owners' own plans, and says so on the
// check sheet it prints.
//
// After core.js, before init.js; every call it makes to another module is at
// run time (MapFeeds, MapWind, SiteExposure, MapChrome, Glyphs, state), so
// its place among the modules is free (npm run toplevel).
//
// Exposes: attach, detach, setEnabled, live, clear, checkAt, checkLine,
//          result, WORDS, and the panel's handlers (_spot, _line, …).

const MapDig = (() => {
  const KEY = 'mn-dig-v1';
  const PANE = 'mnDig', PANE_Z = 640;
  const LOTS = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/4';
  const QLD = { w: 137.9, e: 153.7, s: -29.3, n: -9.0 };
  const BYDA = 'https://www.byda.com.au/';
  const CLR = 'https://www.qld.gov.au/environment/management/environmental/contaminated-land/registers';
  const MAX_LINE_PTS = 12;
  const R_MIN = 10, R_MAX = 100, R_STEP = 5;

  // The State's exclusion zones for a crane or other plant near an overhead
  // line, for a person who is not an authorised electrical worker
  // (Electrical Safety Regulation 2013 (Qld), Schedule 2). A guide: the
  // network owner says what applies to a particular line.
  function exclusionM(kv) {
    if (kv > 330) return 8;
    if (kv > 132) return 6;
    return 3;
  }

  // Plain-words meanings of the soil orders (Australian Soil Classification),
  // as they bear on digging and footings.
  const SOIL = {
    Anthroposol: ['amber', 'Made ground: soil laid or heavily changed by people — fill, spoil, old works. Expect rubble, and possibly contamination.'],
    Arenosol: ['amber', 'Deep sand. Loose: trench walls slump without support, and footings need to go deeper.'],
    Calcarosol: ['info', 'Limey (calcareous) soil of dry country, often over a hard lime layer.'],
    Chromosol: ['info', 'A sandy or loamy topsoil sharply over a clay subsoil that is neither strongly acid nor salty-sodic.'],
    Dermosol: ['info', 'Structured clay-loam that drains reasonably, with no sharp change to clay.'],
    Ferrosol: ['info', 'Red or brown iron-rich clay, usually on basalt; well drained and firm.'],
    Hydrosol: ['amber', 'Wet soil, waterlogged for weeks most years: expect water in the hole, and soft ground for machines.'],
    Kandosol: ['info', 'Earthy red or yellow soil, well drained, with little structure.'],
    Kurosol: ['amber', 'A strongly acid clay subsoil: hard on buried steel and concrete.'],
    Organosol: ['amber', 'Peat: soft, compressible and acid. Footings settle; often goes with acid sulfate soil on the coast.'],
    Podosol: ['info', 'Sandy coastal soil with a hard brown layer (coffee rock) that can hold water above it.'],
    Rudosol: ['info', 'Barely formed: river sands and gravels, or a thin skin over rock.'],
    Sodosol: ['amber', 'Sodic clay subsoil that turns to slurry and washes out when wet: tunnels and gullies around pipes and backfill.'],
    Tenosol: ['info', 'Weakly formed soil, often shallow or sandy, over rock or gravel.'],
    Vertosol: ['amber', 'Cracking clay that swells when wet and shrinks when dry: it moves footings and pulls at pipes.'],
  };

  const WORDS = {
    ring: 'How far round the spot, or either side of the line, a service counts as in the way. Red: inside the ring. '
      + 'Amber: inside twice the ring. Anything further out is left off the list.',
    red: 'Stop and look: inside the ring, or something about the place that needs a permit or a plan before the work.',
    amber: 'Check before the work: inside twice the ring, or something about the place to plan round.',
    info: 'For the record: true of the place, nothing to stop for.',
    clear: 'Asked, and nothing found inside twice the ring in the open data. Not proof that nothing is there.',
    overhead: 'Lines on poles or towers: what a crane, a hiab (a truck-mounted crane), an excavator’s arm or a mast being '
      + 'raised can touch.',
    underground: 'Cables and pipes in the ground: what a trench, a post-hole or an excavator can hit.',
    exclusion: 'How close a crane or other plant may come to a live overhead line when nobody on the job is an authorised '
      + 'electrical worker: 3 m up to 132 kV, 6 m to 330 kV, 8 m above (Electrical Safety Regulation 2013 (Qld), Schedule 2). '
      + 'The line’s owner says what applies to a particular line.',
    easement: 'A strip of a lot that someone other than its owner has a right to use — often for a buried pipe or a power '
      + 'line. Digging in one needs the holder’s say as well as the landholder’s.',
    road: 'Land set aside for a road, from fence to fence, not only the bitumen. Work in it needs the road owner’s '
      + 'permit: the council, or the State for a State road.',
    boundary: 'The edge of the property the spot is on. Within the ring, the work could reach the neighbour’s land.',
    tenure: 'How the land the spot is on is held, and so whose permission the work needs.',
    ass: 'Acid sulfate soil: coastal soil whose iron sulfides turn to sulfuric acid when dug up, drained or dewatered. '
      + 'Digging or dewatering in it needs a plan to treat the soil, and the acid attacks concrete and steel.',
    soil: 'The soil order the State’s best soil map gives for the place (Australian Soil Classification). Often a regional '
      + 'map, so a guide to what to expect, not a test of the ground.',
    wind: 'The wind region of the Australian wind loading standard (AS/NZS 1170.2): what a mast, a frame or a lift must be '
      + 'designed for. C and D are cyclonic.',
    byda: 'Before You Dig Australia: free and national. Lodge the spot or the line and every asset owner registered there '
      + 'sends its own plans. Required before digging in most places.',
  };
  const term = (k, text) => (typeof termHtml === 'function' ? termHtml(text, WORDS[k]) : esc(text));

  // What the open data here never shows, and where to ask instead.
  const NOT_SHOWN = [
    ['Telecommunications', 'NBN, Telstra, Optus and others publish no open maps of their cables: lodge a Before You Dig request.'],
    ['Gas distribution', 'The street gas mains (Australian Gas Networks, Allgas and others) are not in the open data: Before You Dig.'],
    ['Most councils’ water, sewer and drainage', 'Only Brisbane, Unitywater, Melbourne Water and three Victorian councils publish theirs.'],
    ['Private services', 'The landholder’s own power to sheds and pumps, water lines, irrigation and septic: ask the landholder.'],
    ['Contaminated land', 'Queensland’s Environmental Management and Contaminated Land Registers are searched lot by lot, for a fee.'],
    ['Old Flood-Net or Bureau works', 'Earlier orifice lines, cables and footings at a station: its card’s photos and inspection history.'],
  ];

  let P = { r: 30, show: 'both' };
  let map = null, body = null, layer = null;
  let mode = null;          // 'spot' or 'line' while waiting for taps
  let draft = [];           // a line being drawn
  let dig = null;           // the points checked: one, or a line
  let res = null;           // { seq, rows, asked, done, at, r }
  let seq = 0;
  let dblZoom = null;

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && typeof v === 'object') P = { ...P, ...v }; } catch (_) { /* private window */ }
    P.r = Math.max(R_MIN, Math.min(R_MAX, Number(P.r) || 30));
    if (!['both', 'over', 'under'].includes(P.show)) P.show = 'both';
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (_) { /* private window */ } }

  const src = () => (typeof MapFeeds !== 'undefined' && MapFeeds.digSources ? MapFeeds.digSources() : null);
  const inQld = pts => pts.some(([la, lo]) => lo >= QLD.w && lo <= QLD.e && la >= QLD.s && la <= QLD.n);
  const mText = m => (m <= 0.5 ? 'touching' : m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);
  const attr = (a, ...names) => {
    for (const n of names) { const v = a && a[n]; if (v != null && v !== '' && v !== 'Null' && v !== ' ') return String(v); }
    return '';
  };

  function envelope(pts, m) {
    const S = src();
    const b = S ? MapFeeds.boxAround(pts, m) : null;
    return b ? { geometry: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`, geometryType: 'esriGeometryEnvelope' } : {};
  }
  function layerQuery(url, pts, m, fields, extra) {
    const p = new URLSearchParams({
      ...envelope(pts, m), inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: fields, returnGeometry: 'true', geometryPrecision: '6', f: 'json', ...(extra || {}),
    });
    return src().askJson(`${url}/query?${p}`);
  }
  function pointQuery(url, lat, lon, fields) {
    const p = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: fields, returnGeometry: 'false', f: 'json',
    });
    return src().askJson(`${url}/query?${p}`).then(j => (j && j.features) || []);
  }

  // A finding: band, kind ('over', 'under', 'land', 'ground'), what, the
  // detail, who says so, the distance and the shape to draw.
  const row = (band, kind, what, detail, by, m, shape) => ({ band, kind, what, detail: detail || '', by: by || '', m, shape: shape || null });

  function bandOf(m, r, extra) {
    const reach = Math.max(r, extra || 0);
    return m <= reach ? 'red' : m <= 2 * r ? 'amber' : null;
  }

  // ── The checks ───────────────────────────────────────────────────────────
  // Each takes the points and the ring, and answers { rows, none, why }:
  // `none` is the line said when it found nothing, `why` when it could not ask.

  function checkGa(pts, r) {
    const S = src(), far = 2 * r;
    return Promise.all([
      layerQuery(`${S.GA_ELEC}/2`, pts, far + 10, 'feature_name,feature_subtype,capacity_kv').catch(() => null),
      layerQuery(`${S.GA_ELEC}/0`, pts, far, 'feature_name,capacity_kv').catch(() => null),
      layerQuery(`${S.GA_PIPES}/1`, pts, far, 'feature_name,operator').catch(() => null),
      layerQuery(`${S.GA_PIPES}/0`, pts, far, 'feature_name,operator').catch(() => null),
    ]).then(([lines, subs, gas, oil]) => {
      if (!lines && !subs && !gas && !oil) return { why: 'Geoscience Australia’s services did not answer' };
      const out = [];
      for (const f of (lines && lines.features) || []) {
        const a = f.attributes || {}, kv = Number(a.capacity_kv) || 0;
        const shape = MapFeeds.Geo.ofEsri(f.geometry), m = MapFeeds.Geo.dist(pts, shape);
        const under = /under/i.test(a.feature_subtype || '');
        const ex = under ? 0 : exclusionM(kv);
        const band = bandOf(m, r, ex);
        if (!band) continue;
        out.push(row(band, under ? 'under' : 'over', `${under ? 'Transmission cable' : 'Transmission line'}${kv ? ` ${kv} kV` : ''}`,
          `${attr(a, 'feature_name')}${under ? '' : ` · crane exclusion zone ${ex} m`}`, 'Geoscience Australia', m, shape));
      }
      for (const f of (subs && subs.features) || []) {
        const a = f.attributes || {}, shape = MapFeeds.Geo.ofEsri(f.geometry), m = MapFeeds.Geo.dist(pts, shape);
        const band = bandOf(m, r);
        if (band) out.push(row(band, 'over', 'Substation', attr(a, 'feature_name'), 'Geoscience Australia', m, shape));
      }
      for (const [j, what] of [[gas, 'Gas pipeline (high pressure)'], [oil, 'Oil pipeline']]) {
        for (const f of (j && j.features) || []) {
          const a = f.attributes || {}, shape = MapFeeds.Geo.ofEsri(f.geometry), m = MapFeeds.Geo.dist(pts, shape);
          const band = bandOf(m, r);
          if (band) out.push(row(band, 'under', what, [attr(a, 'feature_name', 'name', 'NAME'), attr(a, 'operator') && `run by ${attr(a, 'operator')}`].filter(Boolean).join(' · '), 'Geoscience Australia', m, shape));
        }
      }
      return { rows: out, none: 'no transmission lines or pipelines' };
    });
  }

  function checkNetwork(pts, r) {
    if (!inQld(pts)) return Promise.resolve({ rows: [], skip: true });
    const S = src(), far = 2 * r;
    const box = MapFeeds.boxAround(pts, far + 5);
    return Promise.all(S.NET_SERVICES.map(svc => S.netQuery(svc, [...svc.layers.sub, ...svc.layers.hv, ...svc.layers.lv], box,
      { outFields: 'VOLTAGE,UG_OH', geometryPrecision: '6' }).then(json => ({ svc, json }), () => ({ svc, json: null }))))
      .then(rs => {
        if (rs.every(x => !x.json)) return { why: 'Energex and Ergon’s services did not answer' };
        const groups = new Map();
        for (const { svc, json } of rs) {
          for (const l of (json && json.layers) || []) {
            const k = Object.keys(svc.layers).find(c => svc.layers[c].includes(l.id));
            if (!k) continue;
            const under = svc.cable.has(l.id);
            for (const f of l.features || []) {
              const shape = MapFeeds.Geo.ofEsri(f.geometry), m = MapFeeds.Geo.dist(pts, shape);
              const volts = attr(f.attributes, 'VOLTAGE');
              const kv = k === 'sub' ? (parseFloat(volts) || 132) : k === 'hv' ? 22 : 1;
              const band = bandOf(m, r, under ? 0 : exclusionM(kv));
              if (!band) continue;
              const g = `${svc.name}|${k}|${under}|${volts}`;
              const o = groups.get(g) || { svc, k, under, volts, kv, m: Infinity, n: 0, shapes: [] };
              o.n++; o.m = Math.min(o.m, m); o.shapes.push(...shape);
              groups.set(g, o);
            }
          }
        }
        const out = [...groups.values()].map(o => {
          const band = bandOf(o.m, r, o.under ? 0 : exclusionM(o.kv));
          const what = `${o.under ? 'Underground cable' : 'Overhead line'} — ${S.NET_CLASS[o.k].words.toLowerCase()}`;
          const detail = [o.volts && o.volts !== 'LV' ? o.volts : '', o.n > 1 ? `${o.n} pieces` : '',
            o.under ? '' : `crane exclusion zone ${exclusionM(o.kv)} m`].filter(Boolean).join(' · ');
          return row(band, o.under ? 'under' : 'over', what, detail, o.svc.name, o.m, o.shapes);
        });
        return { rows: out, none: 'no Energex or Ergon lines' };
      });
  }

  function checkPipes(pts, r) {
    const S = src(), far = 2 * r;
    const parts = S.pipeFeeds.filter(f => pts.some(([la, lo]) => S.inBox(f, la, lo))).flatMap(f => f.parts.map(part => ({ f, part })));
    if (!parts.length) return Promise.resolve({ rows: [], none: 'no published pipe records for this area', skip: true });
    return Promise.all(parts.map(({ f, part }) => layerQuery(part.url, pts, far, 'OBJECTID').then(j => ({ f, part, j }), () => ({ f, part, j: null }))))
      .then(rs => {
        if (rs.every(x => !x.j)) return { why: 'the pipe services did not answer' };
        const out = [];
        for (const { f, part, j } of rs) {
          let m = Infinity, n = 0; const shapes = [];
          for (const ft of (j && j.features) || []) {
            const shape = MapFeeds.Geo.ofEsri(ft.geometry), d = MapFeeds.Geo.dist(pts, shape);
            if (d > far) continue;
            n++; m = Math.min(m, d); shapes.push(...shape);
          }
          if (n) out.push(row(bandOf(m, r), 'under', part.words, n > 1 ? `${n} pieces` : '', f.source.by, m, shapes));
        }
        return { rows: out, none: 'no published pipes' };
      });
  }

  function checkLand(pts, r) {
    if (!inQld(pts)) return Promise.resolve({ rows: [], skip: true });
    return layerQuery(LOTS, pts, 2 * r, 'lotplan,parcel_typ,cover_typ,tenure').then(j => {
      const out = [];
      const G = MapFeeds.Geo;
      const lots = [], roads = [], eases = [];
      for (const f of (j && j.features) || []) {
        const a = f.attributes || {}, shape = G.ofEsri(f.geometry);
        const m = G.dist(pts, shape);
        if (a.cover_typ === 'Easement' || a.parcel_typ === 'Easement') eases.push({ a, shape, m });
        else if (/road/i.test(a.parcel_typ || '')) roads.push({ a, shape, m });
        else if (/lot/i.test(a.parcel_typ || '') && a.cover_typ === 'Base') lots.push({ a, shape, m });
      }
      const on = lots.filter(l => l.m === 0);
      const uniqOn = [...new Map(on.map(l => [l.a.lotplan, l])).values()];
      for (const l of uniqOn) {
        const edge = G.dist(pts, l.shape.map(p => ({ pts: [...p.pts, p.pts[0]] })));
        const t = l.a.tenure || 'tenure not given';
        out.push(row('info', 'land', `On lot ${l.a.lotplan || '(no lot on plan)'}`, `${t} — ${tenureWho(t)}`, 'State of Queensland (cadastre)', 0, null));
        if (pts.length === 1 && edge <= r) {
          out.push(row('amber', 'land', 'Lot boundary', 'the work could reach the neighbouring land', 'State of Queensland (cadastre)', edge, l.shape.map(p => ({ pts: [...p.pts, p.pts[0]] }))));
        }
      }
      if (pts.length > 1 && uniqOn.length > 1) {
        out.push(row('amber', 'land', `The line crosses ${uniqOn.length} lots`, 'each landholder’s permission', 'State of Queensland (cadastre)', 0, null));
      }
      const nearRoad = roads.filter(x => x.m <= r).sort((a, b) => a.m - b.m)[0];
      if (nearRoad) out.push(row(nearRoad.m === 0 ? 'red' : 'amber', 'land', nearRoad.m === 0 ? 'In a road reserve' : 'Road reserve',
        'work in it needs the road owner’s permit', 'State of Queensland (cadastre)', nearRoad.m, nearRoad.shape));
      const easeBy = new Map();
      for (const e of eases) {
        if (e.m > 2 * r) continue;
        const k = e.a.lotplan || '?';
        if (!easeBy.has(k) || easeBy.get(k).m > e.m) easeBy.set(k, e);
      }
      for (const e of easeBy.values()) {
        out.push(row(e.m === 0 ? 'red' : bandOf(e.m, r), 'land', e.m === 0 ? 'Inside an easement' : 'Easement',
          `${e.a.lotplan ? `${e.a.lotplan} · ` : ''}often a buried or overhead service`, 'State of Queensland (cadastre)', e.m, e.shape));
      }
      return { rows: out, none: 'no property records' };
    }, () => ({ why: 'the State’s property lines did not answer' }));
  }

  function tenureWho(t) {
    if (/freehold/i.test(t)) return 'the landholder’s permission';
    if (/lease/i.test(t)) return 'the leaseholder’s permission, and the State’s for works beyond the lease';
    if (/national park|forest|protected/i.test(t)) return 'a permit from the Parks and Wildlife Service or the forest’s manager';
    if (/reserve/i.test(t)) return 'the reserve’s trustee (often the council)';
    if (/state land/i.test(t)) return 'the State (Department of Resources)';
    return 'check who holds it';
  }

  // The places a line is asked about as a place: its ends, and its middle.
  const spotsOf = pts => (pts.length === 1 ? pts : [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    .filter((p, i, a) => a.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i));

  function checkGround(pts) {
    const S = src();
    const spots = spotsOf(pts);
    const qld = inQld(spots);
    const level = t => (typeof SiteExposure !== 'undefined' && SiteExposure.assLevel ? SiteExposure.assLevel(t) : 'unclear');
    const NAT = { A: 'likely', B: 'possible', C: 'low' };
    const ass = !qld ? Promise.resolve(null) : Promise.all(spots.map(([la, lo]) => Promise.all([
      ...[1902, 1952, 2002].map(L => pointQuery(`${S.SOILS}/${L}`, la, lo, 'map_code,map_code_meaning').catch(() => null)),
      pointQuery(`${S.SOILS}/2052`, la, lo, 'probclass,probclass_def').catch(() => null),
    ]).then(([a25, a50, a100, nat]) => {
      for (const [fs, scale] of [[a25, '1:25 000'], [a50, '1:50 000'], [a100, '1:100 000']]) {
        const f = fs && fs[0] && fs[0].attributes;
        if (!f) continue;
        const lv = level(f.map_code_meaning);
        if (lv === 'unassessed') continue;
        return { lv, words: f.map_code_meaning || f.map_code, scale };
      }
      const n = nat && nat[0] && nat[0].attributes;
      if (n) return { lv: NAT[n.probclass] || 'unclear', words: n.probclass_def || n.probclass, scale: 'national atlas' };
      return (a25 || a50 || a100 || nat) ? { lv: 'none' } : null;
    })));
    const soil = !qld ? Promise.resolve(null) : Promise.all(spots.map(([la, lo]) =>
      pointQuery(`${S.SOILS}/156`, la, lo, 'asc_ord,map_code_meaning,project_code').then(fs => (fs[0] && fs[0].attributes) || { none: true }, () => null)));
    const wind = (typeof MapWind !== 'undefined' && MapWind.ready)
      ? MapWind.ready().then(() => spots.map(([la, lo]) => MapWind.regionState(la, lo)), () => null) : Promise.resolve(null);
    return Promise.all([ass, soil, wind]).then(([as, so, wi]) => {
      const out = [];
      const QS = 'State of Queensland (soil mapping)';
      if (as) {
        const worst = ['actual', 'likely', 'possible', 'unclear', 'low', 'water', 'none'];
        const got = as.filter(Boolean).sort((a, b) => worst.indexOf(a.lv) - worst.indexOf(b.lv))[0];
        if (!got) out.push(row('info', 'ground', 'Acid sulfate soil', 'could not be read', QS, null));
        else if (got.lv === 'none') out.push(row('info', 'ground', 'Acid sulfate soil', 'not mapped here (the State maps low coastal land)', QS, null));
        else {
          const band = { actual: 'red', likely: 'red', possible: 'amber', unclear: 'amber' }[got.lv] || 'info';
          const lead = { actual: 'Actual acid sulfate soil', likely: 'Likely acid sulfate soil', possible: 'Possible acid sulfate soil', low: 'Acid sulfate soil unlikely' }[got.lv] || 'Acid sulfate soil';
          out.push(row(band, 'ground', lead, `${got.words} (${got.scale})${band === 'red' ? ' · plan to treat dug soil and water' : ''}`, QS, null));
        }
      } else if (!qld) {
        out.push(row('info', 'ground', 'Acid sulfate soil and soil type', 'mapped here for Queensland only', '', null));
      }
      if (so) {
        const seen = new Set();
        for (const a of so.filter(Boolean)) {
          if (a.none || !a.asc_ord) continue;
          if (seen.has(a.asc_ord)) continue;
          seen.add(a.asc_ord);
          const [band, words] = SOIL[a.asc_ord] || ['info', ''];
          out.push(row(band, 'ground', `Soil: ${a.asc_ord}`, words || a.map_code_meaning || '', `${QS}${a.project_code ? `, ${a.project_code}` : ''}`, null));
        }
      }
      if (wi) {
        const regions = [...new Set(wi.map(w => w && w.region).filter(Boolean))];
        if (regions.length) {
          const cyc = regions.some(x => /^[CD]/.test(x));
          out.push(row(cyc ? 'amber' : 'info', 'ground', `Wind region ${regions.join(', ')}`,
            cyc ? 'cyclonic: masts, frames and lifts to the higher design wind' : 'non-cyclonic', 'Geoscience Australia (AS/NZS 1170.2:2021)', null));
        }
      }
      return { rows: out };
    });
  }

  function checkPlace(pts) {
    const S = src();
    const spots = spotsOf(pts);
    const ask = n => Promise.all(spots.map(([la, lo]) => S.question(n, la, lo).catch(() => null)));
    return Promise.all([ask('zones'), ask('land'), ask('floods')]).then(([zs, ls, fs]) => {
      const out = [];
      const uniq = xs => [...new Set(xs.filter(Boolean))];
      const zones = uniq(zs.flatMap(z => (z && z.zones) || [])).filter(v => /fire ant|electric ant/i.test(v));
      for (const z of zones) out.push(row('amber', 'land', z, 'soil, mulch, gravel and hay may leave the site only under the biosecurity rules', 'State of Queensland (biosecurity)', null));
      for (const h of uniq(ls.flatMap(l => (l && l.heritage) || []))) {
        out.push(row('amber', 'land', 'Cultural heritage', `${h} — talk to them before ground is disturbed`, 'State of Queensland (cultural heritage)', null));
      }
      for (const p of uniq(ls.flatMap(l => (l && l.parks) || []))) {
        out.push(row('red', 'land', 'Protected area', `${p} — works need a permit`, 'State of Queensland / DCCEEW', null));
      }
      const past = uniq(fs.flatMap(f => (f && f.past) || []));
      if (past.length) out.push(row('info', 'ground', 'Past floods reached here', past.join('; '), 'State of Queensland (flood lines)', null));
      if (zs.every(x => !x) && ls.every(x => !x)) return { rows: out, why: 'the State’s zone and heritage services did not answer' };
      return { rows: out };
    });
  }

  const CHECKS = [
    { id: 'power', words: 'Transmission lines and pipelines', run: checkGa },
    { id: 'net', words: 'Energex and Ergon lines and cables', run: checkNetwork },
    { id: 'pipes', words: 'Water, sewer and stormwater pipes', run: checkPipes },
    { id: 'land', words: 'Property, roads and easements', run: checkLand },
    { id: 'place', words: 'Zones, heritage and parks', run: checkPlace },
    { id: 'ground', words: 'Soil and wind', run: (pts) => checkGround(pts) },
  ];

  // ── Running a check ──────────────────────────────────────────────────────

  function run(pts) {
    dig = pts.map(([a, b]) => [Number(a), Number(b)]);
    const me = ++seq, r = P.r;
    res = { seq: me, r, rows: [], answered: {}, at: new Date() };
    draw();
    render();
    if (!src()) { res.failed = true; render(); return Promise.resolve(res); }
    return Promise.all(CHECKS.map(c => Promise.resolve().then(() => c.run(dig, r))
      .then(a => a || {}, () => ({ why: 'no answer' }))
      .then(a => {
        if (me !== seq) return;
        res.answered[c.id] = a;
        res.rows.push(...(a.rows || []));
        draw();
        render();
      }))).then(() => {
      if (me !== seq) return res;
      res.done = true;
      render();
      if (typeof announce === 'function') {
        const n = count();
        announce(`Before you dig: ${n.red} to stop and look at, ${n.amber} to check.`);
      }
      return res;
    });
  }

  const ORDER = { red: 0, amber: 1, info: 2 };
  function shown() {
    if (!res) return [];
    return res.rows.filter(x => P.show === 'both' || (P.show === 'over' ? x.kind !== 'under' : x.kind !== 'over'))
      .sort((a, b) => ORDER[a.band] - ORDER[b.band] || (a.m == null) - (b.m == null) || (a.m || 0) - (b.m || 0));
  }
  function count() {
    const n = { red: 0, amber: 0, info: 0 };
    for (const x of shown()) n[x.band]++;
    return n;
  }

  // ── On the map ───────────────────────────────────────────────────────────

  const COL = { red: '#d32f2f', amber: '#ef8f00', info: '#5c6bc0' };

  function clearLayer() { if (layer) { layer.remove(); layer = null; } }

  function draw() {
    clearLayer();
    if (!map || (!dig && !draft.length)) return;
    layer = L.layerGroup().addTo(map);
    const o = { pane: PANE, interactive: false };
    if (draft.length) {
      L.polyline(draft, { ...o, color: '#111', weight: 4, opacity: 0.85, dashArray: '6 5' }).addTo(layer);
      for (const p of draft) L.circleMarker(p, { ...o, radius: 4, color: '#111', fillColor: '#ffd600', fillOpacity: 1, weight: 2 }).addTo(layer);
    }
    if (!dig) return;
    const r = res ? res.r : P.r;
    for (const x of res ? shown() : []) {
      if (!x.shape || x.band === 'info') continue;
      for (const part of x.shape) {
        if (part.pts.length === 1) L.circleMarker(part.pts[0], { ...o, radius: 6, color: COL[x.band], weight: 3, fill: false }).addTo(layer);
        else L.polyline(part.area ? [...part.pts, part.pts[0]] : part.pts, { ...o, color: COL[x.band], weight: 4, opacity: 0.9 }).addTo(layer);
      }
    }
    if (dig.length === 1) {
      L.circle(dig[0], { ...o, radius: 2 * r, color: COL.amber, weight: 1.5, dashArray: '3 4', fillOpacity: 0.04 }).addTo(layer);
      L.circle(dig[0], { ...o, radius: r, color: COL.red, weight: 2, dashArray: '6 4', fillOpacity: 0.06 }).addTo(layer);
      L.circleMarker(dig[0], { ...o, radius: 5, color: '#111', fillColor: '#ffd600', fillOpacity: 1, weight: 2 }).addTo(layer);
    } else {
      // The ring either side of the line: a wide pale band under it.
      const px = metresToPx(r);
      if (px) L.polyline(dig, { ...o, color: COL.red, weight: Math.min(400, 2 * px), opacity: 0.12, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
      L.polyline(dig, { ...o, color: '#111', weight: 4, opacity: 0.9 }).addTo(layer);
      for (const p of dig) L.circleMarker(p, { ...o, radius: 4, color: '#111', fillColor: '#ffd600', fillOpacity: 1, weight: 2 }).addTo(layer);
    }
  }
  function metresToPx(m) {
    if (!map || !dig) return 0;
    const c = map.latLngToContainerPoint(dig[0]);
    const lat = dig[0][0], dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
    const e = map.latLngToContainerPoint([lat, dig[0][1] + dLon]);
    return Math.abs(e.x - c.x);
  }

  function onClick(e) {
    if (!mode) return;
    const p = [e.latlng.lat, e.latlng.lng];
    if (mode === 'spot') { setMode(null); run([p]); openPanel(); return; }
    if (draft.length < MAX_LINE_PTS) draft.push(p);
    draw();
    render();
  }
  function onZoom() { if (dig && dig.length > 1) draw(); }

  function setMode(m) {
    mode = m;
    if (map) {
      map.getContainer().classList.toggle('dig-arming', !!m);
      if (map.doubleClickZoom) { if (m === 'line') map.doubleClickZoom.disable(); else if (dblZoom !== false) map.doubleClickZoom.enable(); }
    }
    render();
  }

  // ── The panel ────────────────────────────────────────────────────────────

  function nearStations() {
    const list = (typeof state !== 'undefined' && state.data && state.data.stations) || [];
    if (!map || !list.length) return [];
    const c = map.getCenter();
    return list.filter(s => s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon))
      .map(s => ({ s, d: c.distanceTo([s.lat, s.lon]) })).sort((a, b) => a.d - b.d).slice(0, 15).map(x => x.s);
  }

  function rowHtml(x) {
    const chip = `<span class="dig-band dig-band--${x.band}" title="${escAttr(WORDS[x.band])}">${x.band === 'red' ? 'Stop' : x.band === 'amber' ? 'Check' : 'Note'}</span>`;
    const dist = x.m == null ? '' : `<span class="dig-m">${x.m === 0 ? 'here' : esc(mText(x.m))}</span>`;
    return `<li class="dig-row dig-row--${x.band}">${chip}<span class="dig-what"><strong>${esc(x.what)}</strong>${dist}`
      + `${x.detail ? `<br><span class="small">${esc(x.detail)}</span>` : ''}${x.by ? `<br><span class="small txt-muted">${esc(x.by)}</span>` : ''}</span></li>`;
  }

  function resultHtml() {
    if (!res) {
      return `<p class="small txt-muted">Press <strong>Check a spot</strong> and tap the map, pick a station, or draw the line of a trench.</p>`;
    }
    if (res.failed) return '<p class="small txt-warn">The map layers are not loaded yet; try again in a moment.</p>';
    const list = shown();
    const n = count();
    const waiting = CHECKS.filter(c => !res.answered[c.id]);
    const failed = CHECKS.filter(c => res.answered[c.id] && res.answered[c.id].why);
    const clear = CHECKS.filter(c => { const a = res.answered[c.id]; return a && !a.why && !a.skip && !(a.rows || []).length && a.none; });
    const where = dig.length === 1 ? `${dig[0][0].toFixed(5)}, ${dig[0][1].toFixed(5)}`
      : `a line of ${dig.length} points, ${mText(MapFeeds.Geo.length(dig))} long`;
    return `<p class="dig-sum" aria-live="polite"><strong>${n.red}</strong> ${term('red', 'stop and look')} · <strong>${n.amber}</strong> ${term('amber', 'check')} · <strong>${n.info}</strong> ${term('info', 'for the record')}`
      + ` <span class="small txt-muted">— ${esc(where)}, ring ${res.r} m</span></p>`
      + (waiting.length ? `<p class="small mn-pop-note">Asking: ${esc(waiting.map(c => c.words.toLowerCase()).join(', '))}…</p>` : '')
      + (list.length ? `<ul class="dig-list">${list.map(rowHtml).join('')}</ul>` : (waiting.length ? '' : '<p class="small">Nothing found in the open data.</p>'))
      + (clear.length ? `<p class="small">${term('clear', 'Nothing found')}: ${esc(clear.map(c => res.answered[c.id].none).join('; '))}.</p>` : '')
      + (failed.length ? `<p class="small txt-warn">Could not be read: ${esc(failed.map(c => res.answered[c.id].why).join('; '))}. <button type="button" class="link-btn" onclick="MapDig._again()">Try again</button></p>` : '');
  }

  function wordsHtml() {
    const keys = ['red', 'amber', 'info', 'clear', 'ring', 'overhead', 'underground', 'exclusion', 'easement', 'road', 'boundary', 'tenure', 'ass', 'soil', 'wind', 'byda'];
    const name = { red: 'Stop', amber: 'Check', info: 'Note', clear: 'Nothing found', ring: 'Check within', overhead: 'Overhead',
      underground: 'Underground', exclusion: 'Crane exclusion zone', easement: 'Easement', road: 'Road reserve', boundary: 'Lot boundary',
      tenure: 'Tenure', ass: 'Acid sulfate soil', soil: 'Soil', wind: 'Wind region', byda: 'Before You Dig' };
    return `<details class="bestrep-words"><summary>What the words on this panel mean</summary><dl>${keys.map(k =>
      `<dt>${esc(name[k])}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl></details>`;
  }

  function panelHtml() {
    const stations = nearStations();
    const seg = (v, label, k) => `<button type="button" class="mv-seg-b" aria-pressed="${P.show === v}" onclick="MapDig._show('${v}')">${k ? term(k, label) : esc(label)}</button>`;
    const drawing = mode === 'line';
    return `<div class="sites-panel dig-panel" data-tour="dig-panel">
      <p class="small">What is in the way of digging or a crane near a station — power lines and cables, pipes, property
        lines, road reserves, easements, soils and zones — from the open-data maps. ${term('byda', 'A guide, not a locate')}.</p>
      <div class="dig-acts" data-tour="dig-acts">
        <button type="button" class="btn btn-sm" aria-pressed="${mode === 'spot'}" onclick="MapDig._spot()">📍 Check a spot</button>
        <button type="button" class="btn btn-sm" aria-pressed="${drawing}" onclick="MapDig._line()">✏️ ${drawing ? 'Drawing — tap each bend' : 'Draw a dig line'}</button>
        ${drawing ? `<button type="button" class="btn btn-sm" onclick="MapDig._finish()" ${draft.length < 2 ? 'disabled' : ''}>Check this line</button>
          <button type="button" class="btn btn-sm" onclick="MapDig._undo()" ${draft.length ? '' : 'disabled'}>Undo</button>` : ''}
      </div>
      ${mode === 'spot' ? '<p class="small mn-pop-note">Tap the map where the work will be.</p>' : ''}
      ${drawing ? `<p class="small mn-pop-note">Tap from the station to the creek (or wherever the trench runs); ${draft.length} point${draft.length === 1 ? '' : 's'} so far.</p>` : ''}
      <label class="dig-field">At a station
        <select onchange="MapDig._station(this.value)"><option value="">nearest the middle of the map…</option>
          ${stations.map(s => `<option value="${escAttr(String(s.id))}">${esc(s.name || s.id)}</option>`).join('')}</select></label>
      <label class="dig-field">${term('ring', 'Check within')} <input type="range" min="${R_MIN}" max="${R_MAX}" step="${R_STEP}" value="${P.r}"
        oninput="this.nextElementSibling.textContent=this.value+' m'" onchange="MapDig._ring(this.value)"><output>${P.r} m</output></label>
      <div class="mv-seg dig-seg" role="group" aria-label="Which services">
        ${seg('both', 'Both')}${seg('over', 'Overhead (cranes)', 'overhead')}${seg('under', 'Underground (digging)', 'underground')}
      </div>
      <div class="dig-result" data-tour="dig-result">${resultHtml()}</div>
      ${res && res.done ? `<div class="dig-acts">
        <button type="button" class="btn btn-sm" onclick="MapDig._print()">🖨️ Print check sheet</button>
        <button type="button" class="btn btn-sm" onclick="MapDig._save()">💾 Save check sheet</button>
        <button type="button" class="btn btn-sm" onclick="MapDig.clear()">Clear</button></div>` : ''}
      <div class="dig-not">
        <p class="small"><strong>Not shown here</strong> — ask before you dig:</p>
        <ul class="small">${NOT_SHOWN.map(([a, b]) => `<li><strong>${esc(a)}</strong>: ${esc(b)}</li>`).join('')}</ul>
        <p class="small"><a href="${BYDA}" target="_blank" rel="noopener">Lodge a Before You Dig Australia request ↗</a>${dig ? ` — the spot: <code>${esc(dig[0][0].toFixed(5))}, ${esc(dig[0][1].toFixed(5))}</code>` : ''}
          · <a href="${CLR}" target="_blank" rel="noopener">Contaminated land registers ↗</a></p>
      </div>
      ${wordsHtml()}
    </div>`;
  }

  function render() { if (body) body.innerHTML = panelHtml(); }

  function openPanel() {
    const wrap = document.querySelector('.mn-mapctl[data-panel="dig"]');
    if (!wrap) return false;
    if (wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-dig');
    } else if (!wrap.classList.contains('is-open') && !(state.mapPanelsPinned && state.mapPanelsPinned.has('dig'))) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    return true;
  }

  // ── The check sheet ──────────────────────────────────────────────────────

  function sheetHtml() {
    const list = shown();
    const n = count();
    const when = res.at.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
    const where = dig.length === 1 ? `${dig[0][0].toFixed(5)}, ${dig[0][1].toFixed(5)}`
      : `${dig.map(p => `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`).join(' → ')} (${mText(MapFeeds.Geo.length(dig))})`;
    const band = { red: 'Stop and look', amber: 'Check', info: 'For the record' };
    const show = { both: 'overhead and underground', over: 'overhead only', under: 'underground only' }[P.show];
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Flood-Net — Before you dig check</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#eee}.red{background:#fde3e3}.amber{background:#fff1d6}
.small{font-size:12px;color:#444}.warn{border:2px solid #d32f2f;padding:8px 10px;margin:12px 0}</style></head><body>
<h1>Before you dig — site check</h1>
<p class="small">Flood-Net · ${esc(when)} · ${esc(where)} · ring ${res.r} m · ${esc(show)}</p>
<p><strong>${n.red}</strong> stop and look · <strong>${n.amber}</strong> check · <strong>${n.info}</strong> for the record</p>
<div class="warn"><strong>A guide only — not a locate.</strong> ${esc(src() ? src().NOT_FOR_DIGGING : '')} Open data is incomplete and may be out of date or out of place by metres.</div>
<table><thead><tr><th>Band</th><th>What</th><th>Distance</th><th>Detail</th><th>Source</th></tr></thead><tbody>
${list.map(x => `<tr class="${x.band}"><td>${band[x.band]}</td><td>${esc(x.what)}</td><td>${x.m == null ? '' : x.m === 0 ? 'here' : esc(mText(x.m))}</td><td>${esc(x.detail)}</td><td>${esc(x.by)}</td></tr>`).join('') || '<tr><td colspan="5">Nothing found in the open data.</td></tr>'}
</tbody></table>
<h2 style="font-size:15px">Not shown — ask before you dig</h2><ul>${NOT_SHOWN.map(([a, b]) => `<li><strong>${esc(a)}</strong>: ${esc(b)}</li>`).join('')}</ul>
<p>Before You Dig Australia: ${BYDA}</p>
<h2 style="font-size:15px">Checked on site</h2>
<table><tbody><tr><td style="width:40%">Before You Dig request number</td><td></td></tr><tr><td>Services located on site by</td><td></td></tr>
<tr><td>Landholder spoken to</td><td></td></tr><tr><td>Signed / date</td><td></td></tr></tbody></table>
<h2 style="font-size:15px">What the words mean</h2><dl class="small">${['red', 'amber', 'info', 'exclusion', 'easement', 'road', 'ass', 'soil', 'wind'].map(k => `<dt><strong>${esc({ red: 'Stop and look', amber: 'Check', info: 'For the record', exclusion: 'Crane exclusion zone', easement: 'Easement', road: 'Road reserve', ass: 'Acid sulfate soil', soil: 'Soil', wind: 'Wind region' }[k])}</strong></dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl>
</body></html>`;
  }

  // ── The face it shows the rest of the app ────────────────────────────────

  return {
    WORDS,
    attach(m) {
      map = m;
      load();
      if (!m.getPane(PANE)) { const p = m.createPane(PANE); p.style.zIndex = PANE_Z; p.style.pointerEvents = 'none'; }
      dblZoom = m.doubleClickZoom && m.doubleClickZoom.enabled ? m.doubleClickZoom.enabled() : null;
      m.on('click', onClick);
      m.on('zoomend', onZoom);
      if (typeof MapChrome !== 'undefined' && MapChrome.panel) {
        MapChrome.panel(m, {
          id: 'dig', icon: '🚧', dockIcon: typeof Glyphs !== 'undefined' ? Glyphs.rail('dig') : '🚧', title: 'Before you dig',
          btnLabel: 'Before you dig — power lines, cables, pipes, property lines, easements and soils near a spot or along a trench',
          group: 'tools', order: 24,
          html: () => panelHtml(),
          onMount(el) { body = el; },
          live: () => MapDig.live(),
          clear: () => MapDig.clear(),
        });
      }
      draw();
    },
    detach() {
      if (map) { map.off('click', onClick); map.off('zoomend', onZoom); map.getContainer().classList.remove('dig-arming'); }
      clearLayer();
      mode = null; draft = [];
      body = null; map = null;
    },
    // The Before you dig view's knob: on opens the panel ready for a spot.
    // It arms the map rather than opening the panel, so Views stays open
    // where it was pressed: the first tap checks that spot and opens the panel.
    setEnabled(on) {
      if (typeof state !== 'undefined') state.mapDig = !!on;
      if (on) {
        if (!dig) setMode('spot');
        if (typeof mapNote === 'function') mapNote('Before you dig: tap the map where the work will be, or open 🚧 Before you dig to draw a trench’s line.', 6000);
      } else MapDig.clear();
    },
    live() { return !!dig || !!mode; },
    clear() {
      seq++; dig = null; res = null; draft = []; setMode(null);
      clearLayer();
      render();
    },
    checkAt(lat, lon) { setMode(null); draft = []; return run([[lat, lon]]).then(() => MapDig.result()); },
    checkLine(pts) { setMode(null); draft = []; return run(pts).then(() => MapDig.result()); },
    // How many shapes are on the map (the check: the map draws on canvas).
    drawnCount: () => (layer ? layer.getLayers().length : 0),
    result() { return res ? { ...res, shown: shown(), count: count() } : null; },
    sheetHtml: () => (res ? sheetHtml() : ''),

    _spot() { draft = []; setMode(mode === 'spot' ? null : 'spot'); },
    _line() { if (mode === 'line') { draft = []; setMode(null); draw(); } else { draft = []; setMode('line'); } },
    _undo() { draft.pop(); draw(); render(); },
    _finish() { if (draft.length < 2) return; const pts = draft; draft = []; setMode(null); run(pts); },
    _station(id) {
      const list = (state.data && state.data.stations) || [];
      const s = list.find(x => String(x.id) === String(id));
      if (!s) return;
      setMode(null);
      if (map) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 17));
      openPanel();
      run([[s.lat, s.lon]]);
    },
    _ring(v) {
      P.r = Math.max(R_MIN, Math.min(R_MAX, Number(v) || 30)); save();
      if (dig) run(dig); else render();
    },
    _show(v) { P.show = v; save(); draw(); render(); },
    _again() { if (dig) run(dig); },
    _print() {
      const w = window.open('', '_blank');
      if (!w) { if (typeof mapNote === 'function') mapNote('The check sheet could not open: allow pop-ups, or use Save check sheet.'); return; }
      w.document.write(sheetHtml());
      w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch (_) { /* closed */ } }, 300);
    },
    _save() {
      const d = new Date().toISOString().slice(0, 10);
      if (typeof dlText === 'function') dlText(`dig-check-${d}.html`, sheetHtml(), 'text/html');
    },
  };
})();
if (typeof window !== 'undefined') window.MapDig = MapDig;
