// MegaNet — site-land.js
//
//   SiteLand   The land a station stands on: which lot, its tenure — freehold,
//              a reserve, State land, a national park, a road, a watercourse —
//              and in plain words who holds that kind of land and who to ask,
//              with the council whose area it is in, the street address, the
//              rural property's name and what the land is used for. Asked of
//              the Queensland Government's own map services at a point, for a
//              section on the station card and the same rows on the "What is
//              here" card (map-here.js).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr and announce, and to app.js for
// docUrl — all only from inside its own functions, so this file's position
// among the modules is free (`npm run toplevel`). Two files reach into it:
// app.js, whose stnCardHtml() places the section and whose repaintStnCard()
// calls ask(), and map-here.js, which does the same for a picked point.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Asked for in these words: "we need to know details of the land like whether
// it is council owned or that sort of thing." Getting onto a site — to build,
// to maintain, to put a mast up — starts with whose ground it is, and the app
// had the boundaries (map-lots.js, twin-cadastre.js) but said nothing about
// the land inside them outside the Digital Twin.
//
// ── What the State publishes, and what it does not ──────────────────────────
// **Queensland does not publish who owns a lot.** The owner's name is on the
// title, and a title is a paid search with Titles Queensland. What *is* free is
// the tenure — the kind of holding — and for most of the network that answers
// the question that was actually asked:
//
//   * a **Reserve** is State land set aside for a community purpose and run by
//     a trustee, and on this network that is very often the council (the
//     cadastre names many of them: "Dauth Park", "Both Valleys Reserve");
//   * a **road** or **watercourse** parcel is State land with a road manager or
//     the Water Act over it — a gauge in a channel or on a bridge is on one;
//   * **State Land**, a **National Park**, a **State Forest**, **Main Road**,
//     **Railway** land name the agency without a search;
//   * **Freehold** is the one that cannot be answered for free. Councils own
//     freehold too — a depot, a park, a pump station — so the land use row is
//     put beside it as a hint (public services, recreation, utilities), and
//     the card says plainly that only the title says.
//
// So the card never says "council owned". It says what the tenure is, who
// holds that kind of land, which council's area it is in, and what to search.
//
// ── The sources ─────────────────────────────────────────────────────────────
// One host, spatial-gis.information.qld.gov.au — keyless, CORS reflecting the
// Origin, the one site-exposure.js and the cadastre layers already ask.
//
//   PlanningCadastre/LandParcelPropertyFramework/4    the DCDB's parcels: lot,
//                                                     plan, tenure, name, area,
//                                                     locality, local authority,
//                                                     plotting accuracy
//                                               /0    property addresses, by
//                                                     the lot's lot/plan
//                                               /50   named rural properties
//   PlanningCadastre/LandUse/0                        Queensland land use
//                                                     (QLUMP, ALUM classes)
//
// The parcel comes first: a point outside the State's land comes back as a
// pseudo-parcel the DCDB keeps for its own extent ("New South Wales" as a
// Transport Route, "Coral Sea" as a Watercourse, both in a local authority
// called "Queensland Extent") and nothing else is asked for it. Inside, the
// other three are asked together — the address only for a lot with a lot/plan.
// Four requests a station, each a handful of attributes.
//
// Layer ids are fixed, for site-exposure.js's reason, and every query names its
// fields so a renumbered layer is an error rather than a wrong answer.
//
// ── What a row can say ──────────────────────────────────────────────────────
// site-exposure.js's rule: an answer, "asking…", or "could not be read" with
// the source named and why. A request that failed is never shown as "none".
//
// ── What it costs ───────────────────────────────────────────────────────────
// Answers are kept for the session per position — five decimal places, about
// a metre, because a lot boundary is a line and a station a metre from its
// road reserve is in a different parcel to one on it. At most IN_FLIGHT at
// once, TIMEOUT_MS each; a card that moves on drops the old position's queue;
// a failed source is not asked again for FAIL_TTL unless Try again is pressed.
const SiteLand = (function () {
  const HOST = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services';
  const LPPF = 'PlanningCadastre/LandParcelPropertyFramework/MapServer';

  const TIMEOUT_MS = 20000;
  const IN_FLIGHT  = 3;
  const FAIL_TTL   = 60000;
  const CACHE_MAX  = 64;
  const KEY_DP     = 5;
  const ADDR_MAX   = 6;

  // site-exposure.js's box: outside it nothing is asked.
  const QLD_BOX = { w: 137.9, e: 153.7, s: -29.3, n: -9.0 };
  // The local authority the DCDB gives its pseudo-parcels outside the State.
  const EXTENT = /^queensland extent$/i;

  const SOURCES = {
    parcel: {
      name: 'the Queensland cadastre',
      title: 'Cadastral data — Queensland series (DCDB), via the Land Parcel Property Framework',
      by: 'State of Queensland (Department of Resources)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/cadastral-data-queensland-series',
    },
    addr: {
      name: 'the property address register',
      title: 'Property Address locations — Queensland',
      by: 'State of Queensland (Department of Resources)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/property-address-locations',
    },
    prop: {
      name: 'the rural properties map',
      title: 'Rural properties — Queensland',
      by: 'State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/rural-properties-queensland',
    },
    use: {
      name: 'the land use map',
      title: 'Land Use Mapping — Current (Queensland Land Use Mapping Program)',
      by: 'State of Queensland (Department of Environment and Science)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/land-use-mapping-current-web-service-json',
    },
  };

  // Where to go next, for the summary's last line.
  const NEXT = {
    titles:   { title: 'Title searches — Titles Queensland', page: 'https://www.titlesqld.com.au/title-searches/' },
    reserves: { title: 'Reserves on State land — Queensland Government', page: 'https://www.qld.gov.au/environment/land/state/use/reserves' },
    permits:  { title: 'Permits to occupy State land — Queensland Government', page: 'https://www.qld.gov.au/environment/land/state/use/permits' },
  };

  const PARCEL_FIELDS = 'lot,plan,lotplan,tenure,lot_area,feat_name,alias_name,acc_code,cover_typ,parcel_typ,locality,shire_name';
  const LAYERS = {
    parcel: { path: `${LPPF}/4`, fields: PARCEL_FIELDS },
    use:    { path: 'PlanningCadastre/LandUse/MapServer/0', fields: 'year,alum_code,primary_,secondary,tertiary' },
    prop:   { path: `${LPPF}/50`, fields: 'name,feature_type' },
    addr:   { path: `${LPPF}/0`, fields: 'address', byLot: true },
  };

  // ── Tenure, in words ──────────────────────────────────────────────────────
  // `held` is the row — short, because the card is 340 px; `who` the sentence
  // under the rows, which can say what the row cannot. `{council}` is filled
  // with the council whose area the lot is in. `next` names the NEXT links.
  // Every value the DCDB's tenure column holds for a Base parcel is here; one
  // it adds later reads as the tenure's own name and "the title says who".
  const TENURE = {
    'Freehold': {
      held: 'Private title — owner not published',
      who: 'Freehold: owned outright by whoever is on the title — a person, a company, a council or a State '
         + 'agency. Queensland does not publish the owner; a title search with Titles Queensland names them.',
      next: ['titles'],
    },
    'Reserve': {
      held: 'The State, through a trustee — often the council',
      who: 'A reserve: State land set aside for a community purpose under the Land Act 1994 and managed by a '
         + 'trustee — most often the local council ({council}), sometimes a State agency or a community body. '
         + 'The trustee and the purpose are on the reserve’s title record.',
      next: ['reserves', 'titles'],
    },
    'State Land': {
      held: 'The State — unallocated State land',
      who: 'Unallocated State land: not leased, reserved or a road, and administered by the Department of '
         + 'Resources. A structure on it is normally authorised by a permit to occupy.',
      next: ['permits'],
    },
    'Lands Lease': {
      held: 'A lessee, on State land',
      who: 'State land leased under the Land Act 1994 — often a pastoral or term lease. The lessee occupies it and '
         + 'the State owns it: works need the lessee’s agreement, and may need the Department of Resources’ too.',
      next: ['titles'],
    },
    'National Park': {
      held: 'The State — Queensland Parks and Wildlife Service',
      who: 'A protected area under the Nature Conservation Act 1992, managed by the Queensland Parks and Wildlife '
         + 'Service. Works and structures in it need a QPWS permit.',
    },
    'State Forest': {
      held: 'The State — State forest',
      who: 'State forest under the Forestry Act 1959, managed by the Queensland Parks and Wildlife Service; a '
         + 'plantation in it may be licensed to a plantation company. A structure needs a permit.',
    },
    'Forest Reserve': {
      held: 'The State — forest reserve',
      who: 'A forest reserve, State land managed by the Queensland Parks and Wildlife Service. A structure needs a permit.',
    },
    'Timber Reserve': {
      held: 'The State — timber reserve',
      who: 'A timber reserve under the Forestry Act 1959, State land managed for its timber. A structure needs a permit.',
    },
    'Main Road': {
      held: 'The State — Transport and Main Roads',
      who: 'Land held for a State-controlled road by the Department of Transport and Main Roads. Works on it need '
         + 'a road corridor permit from TMR.',
    },
    'Railway': {
      held: 'A railway manager',
      who: 'Land held for a railway — Queensland Rail, or the manager it is leased to. Works on it need the rail '
         + 'manager’s approval.',
    },
    'Water Resource': {
      held: 'A water authority — the title says which',
      who: 'Land held for water infrastructure — a dam, a weir, a channel — by a water authority such as '
         + 'Sunwater or Seqwater, or by the council. The title says which.',
      next: ['titles'],
    },
    'Port and Harbours Boards': {
      held: 'A port authority',
      who: 'Port land, held by the port authority.',
      next: ['titles'],
    },
    'Boat Harbours': {
      held: 'The State — boat harbour',
      who: 'Boat harbour land, administered by the State (Transport and Main Roads, Maritime Safety Queensland).',
    },
    'Commonwealth Acquisition': {
      held: 'The Commonwealth',
      who: 'Land acquired by the Commonwealth — defence, an airport, a lighthouse. The agency holding it is the one to ask.',
    },
    'Housing Land': {
      held: 'The State — housing',
      who: 'Land the State holds for public housing.',
    },
    'Industrial Estates': {
      held: 'The State — industrial estate',
      who: 'Land in a State industrial estate.',
      next: ['titles'],
    },
    'Mines Tenure': {
      held: 'A mining tenure holder',
      who: 'Land held under a mining tenure. The tenure holder occupies it.',
      next: ['titles'],
    },
  };

  // The parcels with no tenure, by what kind of parcel they are.
  const KIND = {
    road: {
      tenure: 'Road reserve',
      held: 'Road reserve — council or TMR',
      who: 'A road reserve: State land under the control of its road manager — the council ({council}) for a local '
         + 'road, Transport and Main Roads for a State-controlled one. Works in it need the road manager’s approval.',
    },
    junction: {
      tenure: 'Road reserve or unlinked parcel',
      held: 'Road reserve — council or TMR',
      who: 'An unlinked parcel — in the DCDB most often the square where two roads meet, so a road reserve under '
         + 'the council ({council}) or Transport and Main Roads.',
    },
    water: {
      tenure: 'Watercourse',
      held: 'The State — bed and banks',
      who: 'The bed and banks of a watercourse, which the State owns under the Water Act 2000. Works in it — a '
         + 'gauge post, a footing, fill — may need a riverine protection permit; the land beside it is the '
         + 'adjoining lot’s.',
    },
  };

  // Land uses that often mean a public owner (ALUM classes, as QLUMP maps them):
  // public services, recreation and culture, defence, research, utilities,
  // transport, waste, reservoirs, supply channels, stormwater, stock routes and
  // surface water supply. A hint, said as one, beside freehold only.
  const PUBLIC_USE = /^(1\.2\.2|1\.3\.[12]|5\.5\.[2-5]|5\.[679]\.|6\.2\.1|6\.4\.[13])/;

  // ── Reading an answer ────────────────────────────────────────────────────
  const UNREADABLE = 'answered with something this could not read';

  function features(j) {
    if (!j || !Array.isArray(j.features)) throw new Error(UNREADABLE);
    return j.features.map(f => (f && f.attributes) || {});
  }

  const str = v => (v == null ? '' : String(v).trim());

  function parcelOf(a) {
    const typ = str(a.parcel_typ);
    const kind = /^road/i.test(typ) ? 'road'
      : /^unlinked/i.test(typ) ? 'junction'
      : /^watercourse/i.test(typ) ? 'water'
      : /^transport route/i.test(typ) ? 'route'
      : 'lot';
    return {
      kind, lot: str(a.lot), plan: str(a.plan), lotplan: str(a.lotplan), tenure: str(a.tenure),
      area: Number(a.lot_area) || 0, name: str(a.feat_name) || str(a.alias_name),
      acc: str(a.acc_code), cover: str(a.cover_typ), locality: str(a.locality), shire: str(a.shire_name),
    };
  }

  const DIGEST = {
    // Base parcels and the easements over them. Strata and volumetric lots
    // subdivide buildings and airspace, not the ground, and are left out — the
    // twin's reason (twin-cadastre.js). The service repeats a parcel now and
    // then, so each is kept once.
    parcel(j) {
      const seen = new Set();
      const list = [];
      for (const a of features(j)) {
        const p = parcelOf(a);
        if (p.cover !== 'Base' && p.cover !== 'Easement') continue;
        const k = `${p.cover}|${p.lotplan}|${p.kind}|${p.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        list.push(p);
      }
      const base = list.filter(p => p.cover === 'Base');
      // A lot before a road before a watercourse, when the point is on a line.
      const rank = { lot: 0, road: 1, junction: 2, water: 3, route: 4 };
      base.sort((x, y) => rank[x.kind] - rank[y.kind]);
      return { main: base[0] || null, others: base.slice(1), ease: list.filter(p => p.cover === 'Easement') };
    },
    use(j) {
      const f = features(j)[0];
      return {
        f: f ? { year: f.year || null, code: str(f.alum_code), primary: str(f.primary_),
                 secondary: str(f.secondary), tertiary: str(f.tertiary) } : null,
      };
    },
    prop(j) {
      const f = features(j).find(a => str(a.name));
      return { f: f ? { name: str(f.name), type: str(f.feature_type) } : null };
    },
    addr(j) {
      const list = [...new Set(features(j).map(a => str(a.address)).filter(Boolean))];
      return { list };
    },
  };

  // ── Asking ───────────────────────────────────────────────────────────────

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return null;
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;
  }

  const pointOf = k => k.split(',').map(Number);

  function inBox(k) {
    const [lat, lon] = pointOf(k);
    return lon >= QLD_BOX.w && lon <= QLD_BOX.e && lat >= QLD_BOX.s && lat <= QLD_BOX.n;
  }

  // A lot/plan goes into a where clause, so it is held to what one looks like
  // — letters and digits — and a parcel with anything else is not asked for.
  const LOTPLAN_RE = /^[A-Z0-9]{2,24}$/i;

  function queryUrl(spec, lat, lon, lotplan) {
    const p = new URLSearchParams();
    if (spec.byLot) {
      p.set('where', `lotplan='${lotplan}'`);
      p.set('orderByFields', 'address');
      p.set('resultRecordCount', String(ADDR_MAX + 1));
    } else {
      p.set('geometry', `${lon},${lat}`);
      p.set('geometryType', 'esriGeometryPoint');
      p.set('inSR', '4326');
      p.set('spatialRel', 'esriSpatialRelIntersects');
    }
    p.set('outFields', spec.fields);
    p.set('returnGeometry', 'false');
    p.set('f', 'json');
    return `${HOST}/${spec.path}/query?${p}`;
  }

  async function askJson(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`answered HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) {
        throw new Error(`answered with an error${json.error.message ? ` (${json.error.message})` : ''}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  function reason(e) {
    if (e && e.name === 'AbortError') return `no answer in ${TIMEOUT_MS / 1000} s`;
    if (e instanceof TypeError) return 'unreachable — offline, or the network blocks the host';
    const m = String((e && e.message) || '');
    return m ? m.slice(0, 160) : 'no usable answer';
  }

  // The queue, site-exposure.js's: a job for a position nobody is showing any
  // more is dropped before it is sent, and that is not a failure.
  const SUPERSEDED = new Error('superseded');
  const queue = [];
  let inFlight = 0;
  let wanted = null;

  function schedule(k, run) {
    return new Promise((resolve, reject) => {
      queue.push({ k, run, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (inFlight < IN_FLIGHT && queue.length) {
      const job = queue.shift();
      if (job.k !== wanted) { job.reject(SUPERSEDED); continue; }
      inFlight++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject)
        .finally(() => { inFlight--; pump(); });
    }
  }

  const answers = new Map();   // position → { layers, busy, running }
  const asked = new Map();     // element id → the place last asked about there

  function entry(k) {
    let a = answers.get(k);
    if (a) {
      answers.delete(k);
      answers.set(k, a);
      return a;
    }
    a = { layers: {}, busy: {}, running: null };
    answers.set(k, a);
    if (answers.size > CACHE_MAX) {
      for (const [old, v] of answers) {
        if (old !== k && !v.running) { answers.delete(old); break; }
      }
    }
    return a;
  }

  const val     = r => (r && r.ok ? r.v : undefined);
  const failed  = r => !!(r && r.ok === false);
  const settled = r => !!r && (r.ok || Date.now() - r.at < FAIL_TTL);

  function layer(k, name, lotplan) {
    const a = entry(k);
    if (a.busy[name]) return a.busy[name];
    const spec = LAYERS[name];
    const [lat, lon] = pointOf(k);
    const url = queryUrl(spec, lat, lon, lotplan);
    const p = schedule(k, () => askJson(url))
      .then(json => ({ ok: true, v: DIGEST[name](json) }))
      .catch(e => (e === SUPERSEDED ? { superseded: true } : { ok: false, at: Date.now(), why: reason(e) }))
      .then(r => {
        delete a.busy[name];
        if (!r.superseded) a.layers[name] = r;
        return r;
      });
    a.busy[name] = p;
    return p;
  }

  // Is the point on Queensland's land at all? 'away' outside the box (nothing
  // asked), 'out' for the DCDB's pseudo-parcels and for no parcel at all,
  // 'in' for a real one.
  function coverage(k, L) {
    if (!inBox(k)) return 'away';
    if (failed(L.parcel)) return 'failed';
    const v = val(L.parcel);
    if (!v) return 'pending';
    if (!v.main || EXTENT.test(v.main.shire) || v.main.kind === 'route') return 'out';
    return 'in';
  }

  function lotplanOf(L) {
    const v = val(L.parcel);
    const m = v && v.main;
    return m && m.kind === 'lot' && LOTPLAN_RE.test(m.lotplan) ? m.lotplan : null;
  }

  function needed(k, L) {
    if (!inBox(k)) return [];
    if (coverage(k, L) !== 'in') return ['parcel'];
    const out = ['parcel', 'use', 'prop'];
    if (lotplanOf(L)) out.push('addr');
    return out;
  }

  const unsettled = (k, a) => needed(k, a.layers).filter(n => !settled(a.layers[n]));

  function run(k) {
    const a = entry(k);
    if (a.running) return a.running;
    const step = async () => {
      for (;;) {
        if (k !== wanted) return;
        const todo = unsettled(k, a);
        if (!todo.length) return;
        const lp = lotplanOf(a.layers);
        const got = await Promise.all(todo.map(n => layer(k, n, lp)));
        if (got.some(r => r.superseded)) return;
        notify(k);
      }
    };
    a.running = step().catch(() => {}).then(() => {
      a.running = null;
      notify(k);
      if (k === wanted && unsettled(k, a).length) run(k);
    });
    return a.running;
  }

  function notify(k) {
    for (const [elId, s] of asked) {
      const el = document.getElementById(elId);
      if (!el) { asked.delete(elId); continue; }
      if (el.dataset.mnLand !== k) continue;
      paint(el, s);
    }
  }

  function paint(el, s) {
    const had = el.contains(document.activeElement);
    el.innerHTML = html(s);
    if (had) {
      const g = el.querySelector('.stn-card-land') || el;
      g.focus({ preventScroll: true });
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const TITLE = {
    head: 'The land at this point as Queensland’s cadastre records it — the lot, its tenure, the council area — '
        + 'with the street address, the rural property’s name and the mapped land use. The cadastre gives the kind '
        + 'of holding, not the owner: an owner’s name is on the title, which is a paid search.',
    lot: 'The lot and the survey plan it was created on — what a title search, a council and a surveyor all ask for. '
       + 'SmartMap is the State’s free one-page map of the lot and its neighbours.',
    tenure: 'The kind of holding the cadastre records for the parcel: freehold, a reserve, a lease or a class of '
          + 'State land.',
    held: 'Who holds this kind of land, from its tenure. For freehold the owner is named only on the title.',
    council: 'The local government area the lot is in, as the cadastre records it. The council whose area it is — '
           + 'not necessarily the owner.',
    addr: 'The street address the State’s address register gives this lot.',
    prop: 'The rural property this point is in, as the State’s rural properties map names it.',
    use: 'Queensland’s land use mapping (QLUMP), in the Australian Land Use and Management classes, as at the year '
       + 'it was mapped for this area.',
    area: 'The lot’s area as the cadastre records it.',
    ease: 'An easement over the land at this point — a right of way, a powerline, a pipe — registered on its own plan.',
    acc: 'How well the cadastre’s boundary is plotted here, by its own accuracy code. A station near a boundary '
       + 'plotted this coarsely may be on the other side of it.',
  };

  const note   = t => `<span class="mn-pop-note">${t}</span>`;
  const asking = () => note('asking…');
  const unread = src => `<span class="txt-warn">could not be read</span> ${note(`— ${esc(SOURCES[src].name)}`)}`;

  function row(label, value, title) {
    if (!value) return '';
    const t = title ? ` title="${esc(title)}"` : '';
    return `<div class="acma-row"><span${t}>${esc(label)}</span><span>${value}</span></div>`;
  }

  function link(text, href, label) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener"
        aria-label="${esc(`${label || text} — in a new tab`)}">${esc(text)}<span aria-hidden="true"> ↗</span></a>`;
  }

  function areaWords(m2) {
    if (!(m2 > 0)) return '';
    if (m2 < 10000) return `${Math.round(m2).toLocaleString()} m²`;
    const ha = m2 / 10000;
    return `${ha < 100 ? ha.toFixed(ha < 10 ? 2 : 1) : Math.round(ha).toLocaleString()} ha`;
  }

  // The DCDB's accuracy code ends in its figure: "B&D PLOT CONTROLLED - 0.25M".
  function accuracyM(code) {
    const m = /([\d.]+)\s*M\s*$/i.exec(String(code || ''));
    const v = m ? Number(m[1]) : NaN;
    return isFinite(v) && v > 0 ? v : null;
  }

  const councilOf = p => (p && p.shire && !EXTENT.test(p.shire) ? `${p.shire} Council` : '');

  function tenureOf(p) {
    if (!p) return null;
    if (KIND[p.kind]) return KIND[p.kind];
    return TENURE[p.tenure] || { held: 'Not stated — the title says who', who: '' };
  }

  function smartMapUrl(p) {
    return `https://apps.information.qld.gov.au/data/v2/Cadastre/SmartMap?lot=${encodeURIComponent(p.lot)}&plan=${encodeURIComponent(p.plan)}`;
  }

  function parcelWords(p) {
    if (p.kind === 'lot') return p.lot && p.plan ? `Lot ${p.lot} on ${p.plan}` : (p.lotplan || 'a lot');
    if (p.kind === 'road') return p.name ? `${p.name} (road reserve)` : 'a road reserve';
    if (p.kind === 'water') return p.name ? `${p.name} (watercourse)` : 'a watercourse';
    return 'an unlinked parcel';
  }

  function parcelRows(L) {
    const v = val(L.parcel);
    const p = v.main;
    const t = tenureOf(p);
    const out = [];
    if (p.kind === 'lot') {
      const acc = accuracyM(p.acc);
      out.push(row('Lot on plan', `${esc(parcelWords(p))}${p.lot && p.plan
        ? ` ${link('SmartMap', smartMapUrl(p), `SmartMap — the State’s free map of ${parcelWords(p)}`)}` : ''}${acc != null && acc >= 5
        ? ` ${note(`plotted to ±${esc(String(acc))} m`)}` : ''}`, acc != null && acc >= 5 ? `${TITLE.lot} ${TITLE.acc}` : TITLE.lot));
      out.push(row('Tenure', `${esc(p.tenure || 'not recorded')}${p.name ? ` ${note(`— ${esc(p.name)}`)}` : ''}`, TITLE.tenure));
    } else {
      out.push(row('Tenure', `${esc(t.tenure || p.tenure || 'not recorded')}${p.name ? ` ${note(`— ${esc(p.name)}`)}` : ''}`, TITLE.tenure));
    }
    out.push(row('Held by', esc(t.held), TITLE.held));
    out.push(row('Council', esc(councilOf(p) || 'not recorded'), TITLE.council));
    if (p.kind === 'lot') {
      out.push(row('Address', addrValue(L), TITLE.addr));
      out.push(row('Lot area', esc(areaWords(p.area)), TITLE.area));
    }
    if (v.ease.length) {
      out.push(row('Easement', v.ease.map(e => esc(e.lot && e.plan ? `Easement ${e.lot} on ${e.plan}` : (e.lotplan || 'an easement')))
        .join('<br>'), TITLE.ease));
    }
    if (v.others.length) {
      out.push(row('On the line with', v.others.map(o => esc(parcelWords(o))).join('<br>'),
        'The position is on, or within a metre of, the boundary between these parcels.'));
    }
    return out.join('');
  }

  function addrValue(L) {
    if (failed(L.addr)) return unread('addr');
    const v = val(L.addr);
    if (!v) return asking();
    if (!v.list.length) return note('none registered for this lot');
    const more = v.list.length - 1;
    return `${esc(v.list[0])}${more > 0 ? ` ${note(`and ${more > ADDR_MAX - 1 ? `${ADDR_MAX - 1}+` : more} more`)}` : ''}`;
  }

  function propRow(L) {
    if (failed(L.prop)) return row('Property', unread('prop'), TITLE.prop);
    const v = val(L.prop);
    if (!v) return row('Property', asking(), TITLE.prop);
    return v.f ? row('Property', esc(v.f.name), TITLE.prop) : '';
  }

  function useWords(f) {
    const bits = [f.secondary, f.tertiary].filter(Boolean);
    const words = bits.length === 2 && bits[0] === bits[1] ? bits[0] : bits.join(' › ');
    return words || f.primary || '';
  }

  function useRow(L) {
    if (failed(L.use)) return row('Land use', unread('use'), TITLE.use);
    const v = val(L.use);
    if (!v) return row('Land use', asking(), TITLE.use);
    if (!v.f) return row('Land use', note('not mapped here'), TITLE.use);
    const f = v.f;
    return row('Land use', `<span title="${esc(f.primary)}">${esc(useWords(f))}</span>${f.year ? ` ${note(esc(`mapped ${f.year}`))}` : ''}`, TITLE.use);
  }

  // Who to ask, in a sentence or two, and where to go next.
  function summary(L) {
    const v = val(L.parcel);
    const p = v.main;
    const t = tenureOf(p);
    const council = councilOf(p) || 'the local council';
    const lines = [];
    if (t.who) lines.push(esc(t.who.replace('{council}', council)));
    if (p.kind === 'lot' && p.tenure === 'Freehold') {
      const u = val(L.use) && val(L.use).f;
      if (u && PUBLIC_USE.test(u.code)) {
        lines.push(esc(`Mapped as ${useWords(u).toLowerCase()}, which is often public land — the council’s or a `
          + 'State agency’s. A hint, not a finding: only the title says.'));
      }
    }
    if (v.ease.length) {
      lines.push(esc('An easement crosses this point: whoever holds it — a power, water or gas utility, or a neighbour '
        + 'with a right of way — has rights here too, recorded on the easement’s plan.'));
    }
    const next = (t.next || []).map(n => link(NEXT[n].title, NEXT[n].page));
    return `<ul class="stn-card-exp-list stn-card-exp-sum">${lines.map(l => `<li>${l}</li>`).join('')}${next.length
      ? `<li>${next.join(' · ')}</li>` : ''}</ul>`;
  }

  function sourcesHtml(k, L) {
    const used = needed(k, L);
    const docs = typeof docUrl === 'function' ? docUrl('docs/site-land.md') : 'docs/site-land.md';
    return `<details class="stn-card-rhs-earlier stn-card-exp-src">
        <summary class="small">Sources and limits</summary>
        <ul class="stn-card-exp-list">${used.map(src => {
          const d = SOURCES[src];
          return `<li>${link(d.title, d.page)} ${esc(`— © ${d.by}, ${d.licence}.`)}</li>`;
        }).join('')}</ul>
        <p class="stn-card-aep-line">Read at one point, rounded to about a metre. The cadastre’s boundaries are plotted
          to anything from 10 cm in a surveyed town to tens of metres in the far west, so a station near a line may be
          on the other side of it. The tenure is the kind of holding, not the owner; “held by” is what that kind of
          holding usually means, and the title is the authority.</p>
        <p class="stn-card-aep-line">${link('What each row means, and its limits', docs,
          'What each row means, and its limits — the documentation')}</p>
      </details>`;
  }

  function failuresHtml(k, L) {
    const bad = needed(k, L).filter(n => failed(L[n]));
    if (!bad.length) return '';
    const list = bad.map(n => `${SOURCES[n].name} (${L[n].why})`);
    return `<p class="small txt-warn stn-card-exp-foot">Could not be read: ${esc(list.join('; '))}. Nothing here is
        claimed from ${bad.length === 1 ? 'it' : 'them'}.</p>
      <button type="button" class="pill stn-card-exp-retry" onclick="SiteLand.retry(this)"
              aria-label="Try again — ask the Queensland Government’s land services that did not answer"
              ><span aria-hidden="true">↻</span> Try again</button>`;
  }

  // The section for a station or a point, from whatever is known now. Never
  // asks anything; ask() does, and the fills call this again.
  function html(s) {
    const k = key(s);
    if (!k) return '';
    const a = answers.get(k);
    const L = (a && a.layers) || {};
    const cov = coverage(k, L);
    const busy = cov !== 'away' && needed(k, L).some(n => !L[n]);
    const headId = `mn-land-head-${s.id}`;
    const parts = [];
    if (cov === 'away') {
      parts.push(`<p class="small txt-muted stn-card-exp-foot">Not in Queensland. This section reads Queensland’s
          cadastre, which stops at the state border — so nothing is known here about the land.</p>`);
    } else if (cov === 'pending') {
      parts.push('<p class="small txt-muted stn-card-exp-foot">Asking the Queensland cadastre…</p>');
    } else if (cov === 'failed') {
      parts.push(failuresHtml(k, L));
    } else if (cov === 'out') {
      const m = val(L.parcel).main;
      const where = m && m.name ? ` — ${m.name}` : '';
      parts.push(`<p class="small txt-muted stn-card-exp-foot">${esc(`Not on Queensland’s land${where}. The cadastre has `
          + 'no lot here: across the border, or at sea — so nothing is known here about the land.')}</p>`);
    } else {
      parts.push(parcelRows(L), propRow(L), useRow(L), summary(L));
      if (!busy) parts.push(failuresHtml(k, L));
      parts.push(sourcesHtml(k, L));
    }
    return `<div class="stn-card-land" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1"${busy ? ' aria-busy="true"' : ''}>
        <span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
              title="${esc(TITLE.head)}">Land — tenure and council</span>
        <span class="stn-card-rhs-snap mn-pop-note">Queensland cadastre — not a title search</span>
        ${parts.join('')}
      </div>`;
  }

  // Fill an element once the answers are in. `data-mn-land` carries the
  // position it was rendered for and is checked before every write.
  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    asked.set(elId, s);
    wanted = k;
    if (!inBox(k)) return;
    const a = entry(k);
    if (!unsettled(k, a).length) return;
    run(k);
  }

  function retry(btn) {
    const el = btn && btn.closest ? btn.closest('[data-mn-land]') : null;
    const s = el ? asked.get(el.id) : null;
    const k = key(s);
    if (!k || el.dataset.mnLand !== k) return;
    const a = entry(k);
    for (const n of Object.keys(a.layers)) if (failed(a.layers[n])) delete a.layers[n];
    wanted = k;
    paint(el, s);
    run(k).then(() => {
      const left = needed(k, a.layers).filter(n => failed(a.layers[n])).length;
      if (typeof announce === 'function') {
        announce(left ? `Land: ${left} source${left === 1 ? '' : 's'} still could not be read.` : 'Land: answered.');
      }
    });
  }

  return {
    key,
    html,
    ask,
    retry,
    clear() {
      for (const job of queue.splice(0)) job.reject(SUPERSEDED);
      answers.clear();
      asked.clear();
      wanted = null;
    },
  };
})();
if (typeof window !== 'undefined') window.SiteLand = SiteLand;
