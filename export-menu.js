// MegaNet — export-menu.js
//
//   ExportMenu   ⤓ Export in the banner: what the open tab can save of what is
//                on screen — its filters applied — through the writers the tab
//                already had (#227).
//
// After export.js and every module whose writer it names, before init.js;
// nothing runs at load. index.html holds the order and the reasons.
//
// A table here, not a registry the tabs fill in. Nothing in this app runs at
// load but init.js, so a tab that registered itself from its own init() would
// be missing from the menu until it had been opened once — and the menu is
// most useful on the tab somebody has just opened. So what each tab offers is
// written down in one place, beside the tabs that offer nothing and why, and
// `npm run exports` holds every tab in TABS to being in exactly one of the two.
//
// Each offer names its writer by the path the tab's own button calls —
// 'ArroData.exportCsv', 'exportMapSelection' — so the banner's Export and the
// tab's buttons are the same code and cannot drift: the same columns, the same
// filters, the same file. The check resolves every one of those names. The few
// new writers are the Stations tab's list as a file (export.js,
// exportStationsView), which no tab wrote before because no button asked.
//
// `ready()`, where an offer has one, says why it cannot run yet ("Nothing is
// selected"), and the offer is listed with the reason rather than left out —
// the menu also says what the tab *could* give. Most writers check their own
// state and quietly do nothing when there is nothing to write; for those, the
// menu watches whether a file was named (core.js's floodnetName counts every
// one) and says the offer's `empty` line if none was.
//
// Every file is named floodnet-… — floodnetName() sees to it at every place a
// file is written.
//
// Exposes: open, run, offers, coverage, EXEMPT.
// Requires: core.js (state, TAB_LIST, esc, floodnetName), modal.js, toast.js,
//           and at call time the modules each offer names.

const ExportMenu = (function () {
  const signedIn = () => typeof exportMayDownload === 'function' && exportMayDownload();
  // The Export tab's own rule (#191): the network leaving as a file needs a
  // signed-in session. Said the way that tab says it.
  const GATE = 'Sign in first — taking the station list away as a file needs a signed-in session (the Export tab\'s rule).';
  const gated = () => signedIn() ? '' : GATE;

  // tab id → () => [offer]. An offer: { label, sub, call: [path, ...args],
  // ready?: () => '' | why not, empty?: what to do first }.
  const OFFERS = {
    stations: () => {
      const n = typeof filteredStations === 'function' ? filteredStations().length : 0;
      const all = state.data ? state.data.stations.length : 0;
      const which = n === all ? `all ${all.toLocaleString()} stations` : `the ${n.toLocaleString()} stations the filters leave, of ${all.toLocaleString()}`;
      const none = () => gated() || (n ? '' : 'No station is left by the filters.');
      return [
        { label: 'The station list — CSV', sub: `${which}: names, numbers, roles, networks, ALERT ids, position and height`,
          call: ['exportStationsView', 'csv'], ready: none },
        { label: 'The station list — GeoJSON', sub: `${which}, as points for a GIS`, call: ['exportStationsView', 'geojson'], ready: none },
        { label: 'The station list — KML', sub: `${which}, as pins for Google Earth`, call: ['exportStationsView', 'kml'], ready: none },
        { label: 'The selection — CSV', sub: 'the stations picked on the map, in the same columns', call: ['exportMapSelection'],
          ready: () => (typeof selectedStations === 'function' && selectedStations().length) ? ''
            : 'Nothing is selected — Shift-drag on the map, or pick stations from the list.' },
        { label: 'This station and its links — KML', sub: 'the station whose card is open, with its pass-range and backbone paths',
          call: ['downloadStationKml', state.stnCard && state.stnCard.id],
          ready: () => (state.stnCard && state.stnCard.id) ? '' : 'Open a station\'s card first.' },
        { label: 'The drawings — KML', sub: 'everything drawn with Draw & measure', call: ['downloadDrawingKml'],
          ready: () => (state.draw && state.draw.shapes && state.draw.shapes.length) ? '' : 'Nothing is drawn.' },
        { label: 'The repeater sites found — KML', sub: 'the site finder\'s answer, for Google Earth', call: ['downloadSitesKml'],
          empty: 'The site finder has no answer yet — add the sites to serve and press Find sites.' },
        { label: 'The polar coverage plot — CSV', sub: 'the plot on the map, ring by ring', call: ['MapPolar.save'],
          empty: 'There is no polar plot on the map — draw one from the ⊚ tool first.' },
        { label: 'The fallbacks for the blast-radius repeater — CSV', sub: 'the stations it serves and where each could fall back to',
          call: ['MapBlast.exportCsv'], empty: 'Blast radius is off — arm it on a repeater first.' },
      ];
    },
    export: () => [
      { label: 'Radio Mobile CSVs, for the networks ticked', sub: 'the files the Export tab generates', call: ['runExport'], ready: gated,
        empty: 'Tick at least one network on this tab first.' },
    ],
    mapgen: () => [
      { label: 'The map — SVG', sub: 'the generated sheet, every layer in one file', call: ['MapGen.downloadSvg'],
        empty: 'Generate a map first.' },
      { label: 'The map — PNG at 300 dpi', sub: 'the generated sheet as a picture', call: ['MapGen.downloadPng'],
        empty: 'Generate a map first.' },
      { label: 'The layers ticked — one SVG each', sub: 'for the laser cutter', call: ['MapGen.downloadLayers'],
        empty: 'Generate a map and tick the layers first.' },
    ],
    rf: () => [
      { label: 'The transmitters listed — CSV', sub: 'the candidates as filtered, with their scores', call: ['rfExportCsv'],
        empty: 'Nothing is listed yet — choose a repeater first.' },
    ],
    rfchanges: () => [
      { label: 'The changes listed — CSV', sub: 'the licences as filtered, with how near the onset each came', call: ['RfChanges.exportCsv'],
        empty: 'Nothing is listed yet.' },
    ],
    workbench: () => {
      const ran = () => (state.wb && state.wb.lastAnalysis) ? '' : 'Run the analysis first — pick the affected repeaters.';
      return [
        { label: 'The case — CSV', sub: 'the hypotheses, their scores and the evidence', call: ['Workbench.exportCsv'], ready: ran },
        { label: 'The site-visit checklist — Markdown', sub: 'what to check, in the order to check it', call: ['Workbench.exportChecklist'], ready: ran },
        { label: 'The ACMA complaint draft — Markdown', sub: 'the case, written for the regulator', call: ['Workbench.exportComplaint'], ready: ran },
      ];
    },
    reception: () => [
      { label: 'The receptions — CSV', sub: 'every reception on the map, as filtered', call: ['Reception.exportCsv'],
        empty: 'There are no receptions yet — load a survey, the demo drive, or readings.' },
      { label: 'The receptions — GeoJSON', sub: 'the same, as points for a GIS', call: ['Reception.exportGeoJson'],
        empty: 'There are no receptions yet — load a survey, the demo drive, or readings.' },
      { label: 'The open site survey — CSV', sub: 'the survey being looked at', call: ['Reception.exportSurveyCsv'],
        empty: 'Open a site survey first.' },
    ],
    network: () => [
      { label: 'The links in view — CSV', sub: 'the ghosting links the graph is drawing', call: ['NetworkView.exportVisible'],
        empty: 'There are no links in view.' },
    ],
    alert2: () => [
      { label: 'The readings decoded — CSV', sub: 'one row per sensor reading', call: ['Alert2.exportCsv'],
        empty: 'Nothing is decoded yet — paste a capture, drop a log, or load a sample, then Decode.' },
      { label: 'The readings decoded — JSON', sub: 'the same, as structured data', call: ['Alert2.exportJson'],
        empty: 'Nothing is decoded yet — paste a capture, drop a log, or load a sample, then Decode.' },
    ],
    hfem: () => [
      { label: 'The measurements decoded — CSV', sub: 'one row per measurement', call: ['HfemTab.exportCsv'],
        empty: 'Nothing is decoded yet — paste messages or load a sample.' },
    ],
    arrodata: () => arroOffers('ARRO export'),
    field: () => arroOffers('field data'),
    msglog: () => [
      { label: 'The messages listed — CSV', sub: 'as filtered, with their decoded values', call: ['MessageLog.exportCsv'],
        empty: 'There are no messages listed.' },
    ],
    health: () => [
      { label: 'The findings — CSV', sub: 'every finding, with its evidence and the station\'s owner', call: ['Health.exportCsv'],
        empty: 'There are no findings yet — the week is still being read, or nothing was found.' },
      { label: 'Check times — CSV', sub: 'each station\'s learned check time, how its logger keeps it, who it falls together with, and the move suggested',
        call: ['HealthAirtime.exportCsv'],
        empty: 'There are no check times yet — the week is still being read.' },
      { label: 'The briefing pack for another AI — text', sub: 'the AI briefing\'s instructions, the findings and the stations that need attention in full, to attach to a chat with Copilot, ChatGPT or any other',
        call: ['HealthAgent.downloadPack'],
        empty: 'There are no findings yet — the week is still being read.' },
    ],
    history: () => [
      { label: 'The records listed — CSV', sub: 'the inspection and maintenance records, as filtered', call: ['History.exportList'],
        empty: 'There are no records listed.' },
    ],
    admin: () => [
      { label: 'The station document — stations.json', sub: 'the whole register, as the datastore holds it now', call: ['snapshotStationsJson'],
        ready: gated },
    ],
    review: () => [
      { label: 'The path margin matrix — CSV', sub: 'every field station\'s margin to each hub, its best path, the measured margin and the flags',
        call: ['NetworkReview.exportCsv'],
        ready: () => (typeof NetworkReview !== 'undefined' && NetworkReview.matrix()) ? ''
          : 'No matrix yet — add a repeater or base and press Compute margins.' },
    ],
  };

  function arroOffers(what) {
    return [
      { label: 'The series shown, filtered — CSV', sub: `the ${what} as the 357 filter keeps it`, call: ['ArroData.exportCsv', 'kept'],
        empty: 'No series is shown — load a file or the demo first.' },
      { label: 'The series shown, every reading — CSV', sub: 'with the filter\'s verdict on each', call: ['ArroData.exportCsv', 'all'],
        empty: 'No series is shown — load a file or the demo first.' },
      { label: 'The chart — SVG', sub: 'as drawn, flood lines and all', call: ['ArroData.exportImg', 'svg'],
        empty: 'No series is shown — load a file or the demo first.' },
      { label: 'The chart — PNG', sub: 'as drawn, as a picture', call: ['ArroData.exportImg', 'png'],
        empty: 'No series is shown — load a file or the demo first.' },
    ];
  }

  // The tabs with nothing of their own to save, and why — each one a reason,
  // not a shrug: a tab that ought to have an export and does not is a gap to
  // file, not a line here.
  const EXEMPT = {
    sitemap:     'The guide to every other tab — it holds nothing of its own to save.',
    offline:     'This device\'s setup for working with no signal — nothing on it is a record to keep as a file.',
    propagation: 'A lesson in how radio travels — made-up demonstrations, not records; nothing on it is data to keep as a file.',
    maps:        'The printed sheets are the files: each one opens as its own PDF.',
    passranges:  'Worked out from the station list, which Stations saves; the ranges travel with each station\'s record in that file.',
    bitflipper:  'A calculator: the variants of one address, on screen to read or copy.',
    packets:     'It decodes what is pasted into it: the paste was the file, and the decode is on screen to copy.',
    serial:      'A card per device, each with its own Save log — which device\'s log is a choice the card makes, not the banner.',
    arro:        'A launcher: it opens ARRO\'s own pages, and holds no data of its own.',
    inspections: 'A sheet being filled in: once saved it is a record, and Inspection History exports those.',
    maintenance: 'A sheet being filled in: once saved it is a record, and Inspection History exports those.',
    photos:      'The photos are the files — each one opens full size from the viewer — and they live in Dropbox or Drive as well.',
    camera:      'Each photo is a file already — Save a copy keeps it on this device, stamp and EXIF and all — and once uploaded it is in Field Photos.',
    basestations: 'The fleet\'s live state, for administering it — nothing here is a record to keep as a file.',
  };

  function resolve(path) {
    try { return Function(`return (${path});`)(); } catch (_) { return undefined; }
  }

  function offers(tab = state.activeTab) {
    const fn = OFFERS[tab];
    let list = [];
    try { list = fn ? fn() : []; } catch (err) { console.error(err); list = []; }
    return list.map(o => ({ ...o, why: o.ready ? (o.ready() || '') : '' }));
  }

  // Every tab, sorted into the two lists — for the check, and for nobody else.
  function coverage() {
    return {
      offers: Object.keys(OFFERS),
      exempt: { ...EXEMPT },
      calls: Object.fromEntries(Object.keys(OFFERS).map(t => {
        let list = [];
        try { list = OFFERS[t](); } catch (_) { list = []; }
        return [t, list.map(o => ({ label: o.label, path: o.call[0], resolves: typeof resolve(o.call[0]) === 'function' }))];
      })),
    };
  }

  function tabLabel(tab) {
    const t = TAB_LIST.find(x => x.id === tab);
    return t ? t.label : tab;
  }

  function open() {
    const tab = state.activeTab;
    const list = offers(tab);
    const reason = EXEMPT[tab];
    const body = list.length
      ? `<p class="small txt-muted exm-lede">What this tab can save of what it shows, filters and all — the same files its own buttons write, named <code>floodnet-…</code>.</p>
         <ul class="exm-list">${list.map((o, i) => `
           <li><button type="button" class="exm-opt" data-exm="${i}"${o.why ? ' aria-disabled="true"' : ''}
                 aria-describedby="exm-sub-${i}">
               <span class="exm-label">${esc(o.label)}</span>
               <span class="exm-sub small" id="exm-sub-${i}">${esc(o.why || o.sub || '')}</span>
             </button></li>`).join('')}</ul>`
      : `<p class="exm-none">${esc(reason || 'This tab has nothing to save as a file.')}</p>`;
    Modal.open({ title: `Export — ${tabLabel(tab)}`, html: `<div class="exm" id="exm" data-tab="${esc(tab)}">${body}</div>` });
    const root = document.getElementById('exm');
    if (!root) return;
    root.querySelectorAll('.exm-opt').forEach(btn => btn.addEventListener('click', () => run(tab, +btn.dataset.exm)));
    const first = root.querySelector('.exm-opt:not([aria-disabled])') || root.querySelector('.exm-opt');
    if (first) first.focus();
  }

  // An offer that cannot run says why and stays put; one that can closes the
  // dialog first, so whatever the writer says — a toast, a status line — is
  // not said under a dialog that is about to go.
  function run(tab, i) {
    const o = offers(tab)[i];
    if (!o) return;
    if (o.why) { Toast.note(o.why); return; }
    const fn = resolve(o.call[0]);
    if (typeof fn !== 'function') { Toast.failed(`${o.label}: this build has no writer for it (${o.call[0]}).`); return; }
    Modal.close();
    const before = floodnetName.count || 0;
    let out;
    try { out = fn(...o.call.slice(1)); } catch (err) { Toast.failed(`${o.label} could not be saved: ${(err && err.message) || err}`); return; }
    // A writer with nothing to write returns quietly. Some write a moment later
    // (a PNG is drawn first), so the question is asked once that has had time.
    Promise.resolve(out).catch(() => {}).then(() => setTimeout(() => {
      if ((floodnetName.count || 0) === before && o.empty) Toast.note(o.empty);
    }, 1500));
  }

  return { open, run, offers, coverage, EXEMPT };
})();
if (typeof window !== 'undefined') window.ExportMenu = ExportMenu;
