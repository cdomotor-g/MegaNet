// MegaNet — level-survey.js
//
//   LevelSurvey   📏 the Level Survey tab: a station's levels surveyed on a
//                 phone — the site, the crew and their kit, the datum and its
//                 benchmark, the rise-and-fall run booked a sight at a time
//                 and reduced as it is entered, the water check, and the final
//                 field check — kept on the phone, sent to Flood-Net when
//                 there is a signal, exported as a workbook, a CSV or a whole
//                 package. An administrator reviews a filed survey here and
//                 applies what it found to its station.
//
// After core.js, datastore.js, auth.js, export.js (zipStore), levelling.js,
// xlsx-write.js, level-store.js and level-camera.js, before init.js —
// index.html holds the order. Reaches back to core.js for state, esc,
// escAttr, announce, floodnetName and registerTabTeardown; to app.js for
// switchTab; to modal.js and toast.js for confirmDialog, promptDialog and
// Toast; to two-peg.js and survey-guide.js for TwoPeg and SurveyGuide. All of
// it from inside functions; nothing runs at load.
//
// ── Built for a phone in a paddock ───────────────────────────────────────────
// One step on screen at a time, big targets, the number pad for numbers, and
// nothing that needs a signal to work. Every change is kept on the phone the
// moment it is made (LevelStore); the run is reduced as each sight goes in, so
// a booking error shows on the row it happened on rather than at the end; and
// every reading box has a 📷 that reads the level's display and keeps the
// picture as evidence (LevelCamera). The screen is kept awake while a survey
// is open.
//
// ── Whose is what ────────────────────────────────────────────────────────────
// Anybody can survey, reduce and export, signed in or not. Sending a survey to
// Flood-Net files it under its station (0060: an editor's). Applying what it
// found — gauge zero, benchmarks, the sensor reference, the offset — is an
// administrator's, here, from the filed survey; the database enforces it.

const LevelSurvey = (function () {
  const TAB = 'levels';
  const STEPS = [
    { id: 'site',  label: 'Site',         icon: '📍' },
    { id: 'kit',   label: 'Crew & kit',   icon: '🧰' },
    { id: 'datum', label: 'Datum',        icon: '📐' },
    { id: 'run',   label: 'Level run',    icon: '📏' },
    { id: 'water', label: 'Water check',  icon: '🌊' },
    { id: 'check', label: 'Check & send', icon: '✅' },
  ];
  const SYNC_WORDS = {
    draft: ['Not sent', ''], waiting: ['Waiting to send', 'warn'], failed: ['Waiting for a signal', 'warn'],
    'sign-in': ['Waiting for sign-in', 'warn'], 'not-ready': ['Kept here — Flood-Net is not ready for it', 'warn'],
    sending: ['Sending…', ''], sent: ['In Flood-Net', 'ok'], refused: ['Not taken — see why', 'bad'],
  };
  const FIELD_WORDS = { bs: 'Backsight', is: 'Intermediate', fs: 'Foresight', bs_d: 'Backsight distance', is_d: 'Intermediate distance', fs_d: 'Foresight distance' };

  let view = 'list';          // list | survey | row | server
  let cur = null;             // the survey open on this device
  let step = 'site';
  let rowId = null;           // the row open in the row editor
  let server = null;          // a filed survey being read: { id, row, doc, evidence, urls, control, decisions, error }
  let lists = { mine: null, waiting: null, error: '' };
  let here = null, watchId = null, wake = null;
  let saveTimer = 0, unsub = null, kitForm = null, stationHits = null, ocrReady = null, asTable = false;

  const $ = id => document.getElementById(id);
  const L = Levelling;
  const doc = () => (cur ? LevelStore.get('surveys', cur) : null);
  const active = () => typeof state !== 'undefined' && state.activeTab === TAB;
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const isAdmin = () => signedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  const stationOf = id => stations().find(s => s.id === id) || null;
  const f3 = v => L.fmt(v, 3);
  const attr = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // ── Keeping ────────────────────────────────────────────────────────────────
  // A change goes into the document at once and onto the phone a moment later,
  // so typing a description is not a write a keystroke.
  function touch() {
    const d = doc();
    if (!d) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { LevelStore.put('surveys', d).catch(err => sayKept(err)); }, 350);
    paintLive();
  }
  function flush() {
    const d = doc();
    if (!d || !saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = 0;
    return LevelStore.put('surveys', d).catch(err => sayKept(err));
  }
  function sayKept(err) {
    if (typeof Toast !== 'undefined') Toast.failed(`This survey could not be kept on the device: ${String((err && err.message) || err)}. Export it now.`);
  }

  // A field of the open survey, by its path: set('bm.rl', '22.000').
  function set(path, value, opts = {}) {
    const d = doc();
    if (!d) return;
    const keys = path.split('.');
    let o = d;
    for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = opts.number ? L.num(value) : value;
    if (path === 'operator' || path === 'staff_holder' || path === 'organisation') LevelStore.setPrefs({ [path]: value });
    touch();
    if (opts.repaint) repaint();
  }
  function setNum(path, value) { set(path, value, { number: true }); }

  // ── The screen ─────────────────────────────────────────────────────────────

  function render() {
    return `<div class="page lv-page" style="--page-max:1080px"><h2 class="sr-only">Level Survey</h2><div id="lv-root" class="stack">${body()}</div></div>`;
  }
  function body() {
    if (view === 'server') return serverHtml();
    const d = doc();
    if (!d) return listHtml();
    if (view === 'row') return rowHtml(d);
    return surveyHtml(d);
  }
  function repaint() {
    if (!active()) return;
    const el = $('lv-root');
    if (!el) return;
    el.innerHTML = body();
    hydrate();
  }
  // The thumbnails, once there is somewhere to put them.
  function hydrate() {
    for (const img of document.querySelectorAll('#lv-root img[data-ev]')) {
      const id = img.getAttribute('data-ev');
      LevelStore.urlOf(id).then(u => { if (u) img.src = u; });
    }
    if (server && server.urls) {
      for (const img of document.querySelectorAll('#lv-root img[data-path]')) {
        const u = server.urls[img.getAttribute('data-path')];
        if (u) img.src = u;
      }
    }
  }

  // What moves while you type: the summary, the live boxes, the run's list.
  function paintLive() {
    if (!active()) return;
    const d = doc();
    if (!d) return;
    const red = L.reduce(d);
    const put = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
    put('lv-sum', summaryHtml(d, red));
    if (view === 'row') put('lv-live-row', rowLiveHtml(d, red));
    if (view === 'survey') {
      if (step === 'run') { put('lv-live-run', runLiveHtml(d, red)); put('lv-rows', rowsHtml(d, red)); put('lv-table', asTable ? tableHtml(d, red) : ''); }
      if (step === 'water') put('lv-live-water', waterLiveHtml(d, red));
      if (step === 'datum') put('lv-live-datum', datumLiveHtml(d, red));
      if (step === 'check') put('lv-live-check', checkLiveHtml(d, red));
    }
  }

  // ── The list ───────────────────────────────────────────────────────────────

  function listHtml() {
    const mine = LevelStore.list('surveys');
    const st = LevelStore.status();
    return `
      <section class="panel lv-hero">
        <h3>📏 Level surveys</h3>
        <p>Survey a station's levels on this phone: book the rise-and-fall run as you read it, and the
          levels, the checks and the misclose are worked out as you go. It is kept here with no signal and
          sent to Flood-Net when there is one. 📷 beside a reading reads it off the level's display and keeps
          the picture as evidence.</p>
        <div class="lv-big">
          <button type="button" class="primary" onclick="LevelSurvey.start()">＋ New survey</button>
          <button type="button" onclick="LevelSurvey.practise()">🎓 Practise on a worked example</button>
          <label class="lv-file-btn">📂 Open a survey file<input type="file" accept=".json,application/json" onchange="LevelSurvey.importFile(this.files)"></label>
        </div>
        <p class="small txt-muted">The two-peg test is on its own tab — <button type="button" class="link-btn" onclick="switchTab('twopeg')">🎯 Two-Peg Test</button> —
          and how a survey is done, step by step, is in the <button type="button" class="link-btn" onclick="switchTab('surveyguide')">📖 Survey Guide</button>.</p>
      </section>
      <section class="panel" id="lv-ready">${readyHtml(st)}</section>
      <section class="panel">
        <h3>On this device</h3>
        ${mine.length ? `<ul class="lv-cards">${mine.map(cardHtml).join('')}</ul>`
          : '<p class="txt-muted">No surveys on this phone yet.</p>'}
      </section>
      ${serverListHtml()}`;
  }

  function readyHtml(st) {
    const kit = LevelStore.kit().length;
    const waiting = st.waiting + st.signIn + st.notReady;
    const ocr = ocrReady === true ? '<span class="txt-ok">✓ ready with no signal</span>'
      : ocrReady === 'warming' ? '<span>getting it… (about 7 MB)</span>'
      : ocrReady === false ? '<span class="txt-warn">not on this device yet</span>'
      : '<span class="txt-muted">checking…</span>';
    return `
      <h3>Before you lose the signal</h3>
      <ul class="lv-ready">
        <li><span>The reading camera</span> ${ocr}
          ${ocrReady === true || ocrReady === 'warming' ? '' : '<button type="button" onclick="LevelSurvey.getReady()">Get it ready</button>'}</li>
        <li><span>Your levels and staffs</span> <span>${kit ? `${kit} on this device` : 'none yet — add them on a survey\'s Crew & kit step'}</span></li>
        <li><span>The app and the station list</span> <button type="button" class="link-btn" onclick="switchTab('offline')">📲 Offline & Install</button></li>
        <li><span>Waiting to send</span> <span>${waiting ? `${waiting} — ${st.signedIn ? (st.online ? 'sending when Flood-Net answers' : 'when there is a signal') : 'sign in to send'}` : 'nothing'}</span></li>
      </ul>
      ${st.note ? `<p class="small txt-warn">${esc(st.note)}</p>` : ''}
      ${st.memOnly ? '<p class="small txt-bad">This browser is keeping nothing between visits (a private window?) — export each survey before closing it.</p>' : ''}`;
  }

  function syncChip(s) {
    const [w, k] = SYNC_WORDS[(s && s.state) || 'draft'] || SYNC_WORDS.draft;
    const applied = s && s.server && s.server.status === 'applied';
    const returned = s && s.server && s.server.status === 'returned';
    return `<span class="lv-chip${k ? ` lv-chip-${k}` : ''}">${applied ? 'Applied at its station' : returned ? 'Returned — see why' : esc(w)}</span>`;
  }
  function closureChip(red) {
    if (!red.closed) return `<span class="lv-chip">${red.rows.length ? 'run open' : 'no readings'}</span>`;
    if (red.misclose == null) return '<span class="lv-chip lv-chip-bad">not closed on the benchmark</span>';
    return `<span class="lv-chip lv-chip-${red.within && red.checks.agree ? 'ok' : 'bad'}">${red.within ? '✓' : '✗'} misclose ${L.signed(red.misclose)} m</span>`;
  }
  function cardHtml(d) {
    const red = L.reduce(d);
    const st = d.station || {};
    return `<li><button type="button" class="lv-card" onclick="LevelSurvey.open('${escAttr(d.id)}')">
      <span class="lv-card-title">${esc([st.number, st.name].filter(Boolean).join(' · ') || 'Station not chosen')}</span>
      <span class="lv-card-sub">${esc(L.dmy(d.date))} · ${esc(L.DATUMS[d.datum] ? L.DATUMS[d.datum].label : d.datum)} · ${(d.rows || []).length} rows</span>
      <span class="lv-card-chips">${d.practice ? '<span class="lv-chip lv-chip-warn">practice</span>' : syncChip(d.sync)} ${closureChip(red)}</span>
    </button></li>`;
  }

  function serverListHtml() {
    if (!signedIn()) {
      return `<section class="panel"><h3>In Flood-Net</h3><p>Sign in to send surveys and to see the ones filed for each station.
        <button type="button" onclick="Auth.open()">🔑 Sign in</button></p></section>`;
    }
    const rows = l => (l || []).map(s => `<li><button type="button" class="lv-card" onclick="LevelSurvey.openServer('${escAttr(s.id)}')">
        <span class="lv-card-title">${esc([s.station_number, s.station_name].filter(Boolean).join(' · ') || s.station_id || 'Unfiled')}</span>
        <span class="lv-card-sub">${esc(L.dmy(s.survey_date))} · ${esc(s.submitted_by || '')} · ${s.rows_n} rows</span>
        <span class="lv-card-chips"><span class="lv-chip lv-chip-${s.status === 'applied' ? 'ok' : s.status === 'returned' ? 'warn' : ''}">${esc(s.status)}</span>
          <span class="lv-chip lv-chip-${s.outcome === 'pass' ? 'ok' : s.outcome === 'fail' ? 'bad' : ''}">${s.outcome === 'open' ? 'open' : `${s.outcome} ${L.signed(Number(s.misclose_m))} m`}</span></span>
      </button></li>`).join('');
    if (lists.mine == null && !lists.error) loadLists();
    return `
      ${isAdmin() ? `<section class="panel"><h3>Waiting for a decision</h3>
        ${lists.waiting == null ? '<p class="txt-muted">Asking Flood-Net…</p>' : lists.waiting.length ? `<ul class="lv-cards">${rows(lists.waiting)}</ul>`
          : '<p class="txt-muted">No filed survey is waiting for an administrator.</p>'}</section>` : ''}
      <section class="panel"><h3>In Flood-Net</h3>
        ${lists.error ? `<p class="txt-warn">${esc(lists.error)}</p>` : lists.mine == null ? '<p class="txt-muted">Asking Flood-Net…</p>'
          : lists.mine.length ? `<ul class="lv-cards">${rows(lists.mine)}</ul>` : '<p class="txt-muted">No survey filed yet.</p>'}
        <div class="button-row"><button type="button" onclick="LevelSurvey.refreshLists()">↻ Refresh</button></div>
      </section>`;
  }
  async function loadLists() {
    lists.error = '';
    try {
      const all = await LevelStore.serverSurveys({ limit: 60 });
      lists.mine = all;
      lists.waiting = all.filter(s => s.status === 'submitted');
    } catch (err) {
      lists.mine = [];
      lists.waiting = [];
      lists.error = LevelStore._isMissing(err) ? 'Flood-Net\'s database does not keep level surveys yet — they wait on this device.'
        : `Flood-Net did not answer (${String((err && err.message) || err)}).`;
    }
    if (view === 'list') repaint();
  }
  function refreshLists() { lists = { mine: null, waiting: null, error: '' }; repaint(); }

  async function getReady() {
    ocrReady = 'warming';
    repaint();
    try {
      await LevelCamera.warm();
      ocrReady = (await LevelCamera.readyOffline()) !== false;
      announce(ocrReady ? 'The reading camera is ready to use with no signal.' : 'The reading camera works now, but this browser may not keep it for no signal.');
    } catch (err) {
      ocrReady = false;
      if (typeof Toast !== 'undefined') Toast.failed(`The reading camera could not be fetched: ${String((err && err.message) || err)}`);
    }
    LevelStore.pullKit().catch(() => {});
    repaint();
  }

  // ── Starting and opening ───────────────────────────────────────────────────

  async function start() {
    const p = LevelStore.prefs();
    const d = L.blankSurvey({ operator: p.operator || '', staff_holder: p.staff_holder || '', organisation: p.organisation || '' });
    const level = p.level && LevelStore.get('kit', p.level);
    if (level) d.instrument = kitSnap(level);
    const staff = p.staff && LevelStore.get('kit', p.staff);
    if (staff) d.staff = kitSnap(staff);
    if (here) d.where = Object.assign({}, here);
    await LevelStore.put('surveys', d);
    cur = d.id; step = 'site'; view = 'survey';
    repaint();
    startGps();
    holdWake();
    announce('New survey. Start with the station.');
  }
  async function practise() {
    const { survey, test } = L.practice();
    await LevelStore.put('tests', test);
    await LevelStore.put('surveys', survey);
    cur = survey.id; step = 'run'; view = 'survey';
    repaint();
    holdWake();
    announce('A worked example is open, marked practice — it stays on this device.');
  }
  function open(id) {
    if (!LevelStore.get('surveys', id)) return;
    cur = id; view = 'survey'; rowId = null;
    const d = doc();
    step = (d.rows || []).length ? 'run' : 'site';
    repaint();
    holdWake();
    if (step === 'site') startGps();
  }
  async function home() {
    await flush();
    cur = null; view = 'list'; rowId = null; server = null;
    releaseWake();
    stopGps();
    repaint();
  }
  function go(id) {
    if (!STEPS.some(s => s.id === id)) return;
    flush();
    step = id; view = 'survey'; rowId = null;
    const d = doc();
    if (id === 'run' && d && !(d.rows || []).length) { d.rows = [openingRow(d)]; touch(); }
    if (id === 'site' || id === 'datum') startGps();
    repaint();
    const h = document.querySelector('#lv-step h3');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    const top = $('lv-root');
    if (top && top.scrollIntoView) top.scrollIntoView({ block: 'start' });
  }
  function openingRow(d) {
    return L.blankRow('bm', { name: (d.bm && d.bm.name) || L.bmName(d.station && d.station.number), desc: (d.bm && d.bm.description) || '' });
  }

  async function remove() {
    const d = doc();
    if (!d) return;
    const sent = d.sync && d.sync.state === 'sent';
    const ok = await confirmDialog({
      title: 'Remove this survey from this phone?',
      message: sent ? 'It is in Flood-Net, which keeps it. This takes only this phone\'s copy (and its pictures) away.'
                    : 'It has not been sent to Flood-Net. Removing it loses it — export it first if you may need it.',
      confirm: 'Remove it', danger: !sent,
    });
    if (!ok) return;
    await LevelStore.remove('surveys', d.id);
    cur = null; view = 'list';
    repaint();
    announce('Survey removed from this phone.');
  }

  // ── The open survey ────────────────────────────────────────────────────────

  function surveyHtml(d) {
    const red = L.reduce(d);
    const st = d.station || {};
    const i = STEPS.findIndex(s => s.id === step);
    return `
      <div class="lv-top">
        <button type="button" class="link-btn" onclick="LevelSurvey.home()">◀ All surveys</button>
        <h3 class="lv-title">${esc([st.number, st.name].filter(Boolean).join(' · ') || 'New survey')} <span class="txt-muted">— ${esc(L.dmy(d.date))}</span>
          ${d.practice ? '<span class="lv-chip lv-chip-warn">practice — not a record</span>' : ''}</h3>
        <div id="lv-sum" class="lv-sum" aria-live="polite">${summaryHtml(d, red)}</div>
      </div>
      <nav class="lv-steps" aria-label="Survey steps">
        ${STEPS.map((s, n) => `<button type="button" class="lv-step-btn" onclick="LevelSurvey.go('${s.id}')"${s.id === step ? ' aria-current="step"' : ''}>
          <span aria-hidden="true">${s.icon}</span> ${n + 1}. ${esc(s.label)}</button>`).join('')}
      </nav>
      <section class="panel lv-step" id="lv-step">${stepHtml(d, red)}</section>
      <div class="lv-nav">
        ${i > 0 ? `<button type="button" onclick="LevelSurvey.go('${STEPS[i - 1].id}')">◀ ${esc(STEPS[i - 1].label)}</button>` : '<span></span>'}
        ${i < STEPS.length - 1 ? `<button type="button" class="primary" onclick="LevelSurvey.go('${STEPS[i + 1].id}')">${esc(STEPS[i + 1].label)} ▶</button>` : ''}
      </div>`;
  }

  function summaryHtml(d, red) {
    const s = d.sync || {};
    const bits = [`${(d.rows || []).length} row${(d.rows || []).length === 1 ? '' : 's'}`];
    if (red.setups.length) bits.push(`${red.setups.length} set-up${red.setups.length === 1 ? '' : 's'}`);
    return `<span>${bits.join(' · ')}</span> ${closureChip(red)} ${d.practice ? '' : syncChip(s)}
      ${red.errors ? `<span class="lv-chip lv-chip-bad">${red.errors} to fix</span>` : ''}
      ${s.state === 'refused' && s.note ? `<span class="small txt-bad">${esc(s.note)}</span>` : ''}`;
  }

  function stepHtml(d, red) {
    switch (step) {
      case 'site': return siteHtml(d);
      case 'kit': return kitHtml(d);
      case 'datum': return datumHtml(d, red);
      case 'run': return runHtml(d, red);
      case 'water': return waterHtml(d, red);
      case 'check': return checkHtml(d, red);
      default: return '';
    }
  }

  // A short reminder of how, on the step it is about; the Survey Guide has the rest.
  function how(items, section) {
    return `<details class="lv-how"><summary>How this part is done</summary><ul>${items.map(t => `<li>${t}</li>`).join('')}</ul>
      <p><button type="button" class="link-btn" onclick="SurveyGuide.show('${section}')">📖 More in the Survey Guide</button></p></details>`;
  }

  // ── 1. Site ────────────────────────────────────────────────────────────────

  function siteHtml(d) {
    const st = d.station || {};
    const chosen = st.id || st.number || st.name;
    return `
      <h3>📍 Site</h3>
      ${how(['Bring the site\'s information: the station, why it is being surveyed, the benchmark list with levels and where they came from, gauge zero, and the datum to work in.',
             'Unsure of the datum, the main benchmark or gauge zero? Phone before you set up, and note what was missing.',
             'Have a walk first — find the benchmark, the boards, the sensor reference and the control before the tripod goes down.'], 'before')}
      <div class="lv-field">
        <span class="lv-label">Station</span>
        ${chosen ? `<div class="lv-chosen"><strong>${esc([st.number, st.name].filter(Boolean).join(' · '))}</strong>
            ${st.id ? '' : '<span class="small txt-warn"> — not in Flood-Net\'s list; filed by its number and name</span>'}
            <button type="button" onclick="LevelSurvey.clearStation()">Change</button></div>`
          : stationPickerHtml()}
      </div>
      <div class="form-grid">
        <label>Survey date <input type="date" value="${attr(d.date)}" onchange="LevelSurvey.set('date', this.value, {repaint:false})"></label>
        <label>Where you are <span class="lv-pos" id="lv-pos">${posHtml(here)}</span></label>
      </div>
      <fieldset class="lv-pills"><legend>Purpose</legend>
        ${Object.entries(L.PURPOSES).map(([k, v]) => `<label class="lv-pill"><input type="radio" name="lv-purpose" value="${k}"${d.purpose === k ? ' checked' : ''}
          onchange="LevelSurvey.set('purpose', this.value)"> ${esc(v)}</label>`).join('')}
      </fieldset>
      <label class="lv-block">Purpose and field notes
        <textarea rows="3" oninput="LevelSurvey.set('notes', this.value)" placeholder="The scope, anything missing from the site pack, anything unusual on the day">${esc(d.notes || '')}</textarea></label>`;
  }
  function posHtml(p) {
    if (!p) return '<span class="txt-muted">no fix yet</span>';
    return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} <span class="${p.acc > 20 ? 'txt-warn' : 'txt-muted'}">±${Math.round(p.acc)} m</span>`;
  }
  function stationPickerHtml() {
    const hits = stationHits || [];
    return `
      <div class="lv-picker">
        <input type="search" id="lv-stn-q" placeholder="Number or name" aria-label="Find the station by number or name"
               oninput="LevelSurvey.findStation(this.value)" autocomplete="off">
        <button type="button" onclick="LevelSurvey.nearMe()">📍 Near me</button>
      </div>
      <ul class="lv-hits" id="lv-hits">${hitsHtml(hits)}</ul>
      ${stations().length ? '' : '<p class="small txt-warn">The station list is not loaded on this device — type the number and name below.</p>'}
      <details class="lv-manual"${stations().length ? '' : ' open'}><summary>Not in the list?</summary>
        <div class="form-grid">
          <label>Station number <input oninput="LevelSurvey.set('station.number', this.value.trim())" autocomplete="off"></label>
          <label>Station name <input oninput="LevelSurvey.set('station.name', this.value)" autocomplete="off"></label>
        </div>
        <button type="button" onclick="LevelSurvey.go('site')">Use these</button>
      </details>`;
  }
  function hitsHtml(hits) {
    return (hits || []).map(h => `<li><button type="button" class="lv-hit" onclick="LevelSurvey.pickStation('${escAttr(h.s.id)}')">
      <strong>${esc(h.s.station_number || '')}</strong> ${esc(h.s.name)}${h.km != null ? ` <span class="txt-muted">${h.km < 1 ? `${Math.round(h.km * 1000)} m` : `${h.km.toFixed(1)} km`}</span>` : ''}
    </button></li>`).join('');
  }
  function findStation(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) { stationHits = null; }
    else {
      stationHits = stations().filter(x => !x.proposed && (String(x.station_number || '').toLowerCase().startsWith(s) || String(x.name || '').toLowerCase().includes(s)))
        .slice(0, 8).map(x => ({ s: x, km: here ? L.nearest([x], here.lat, here.lon, { km: 1e6 })[0].km : null }));
    }
    const el = $('lv-hits');
    if (el) el.innerHTML = hitsHtml(stationHits);
  }
  function nearMe() {
    startGps();
    if (!here) {
      announce('Finding where you are…');
      const el = $('lv-hits');
      if (el) el.innerHTML = '<li class="txt-muted">Waiting for a GPS fix…</li>';
      const t0 = Date.now();
      const wait = setInterval(() => {
        if (here || Date.now() - t0 > 20000) { clearInterval(wait); if (here) nearMe(); else if (el) el.innerHTML = '<li class="txt-warn">No fix — search by number or name.</li>'; }
      }, 500);
      return;
    }
    stationHits = L.nearest(stations(), here.lat, here.lon, { n: 6, km: 25 });
    const el = $('lv-hits');
    if (el) el.innerHTML = stationHits.length ? hitsHtml(stationHits) : '<li class="txt-muted">No station within 25 km — search by number or name.</li>';
    announce(stationHits.length ? `Nearest: ${stationHits[0].s.name}, ${Math.round(stationHits[0].km * 1000)} metres.` : 'No station within 25 kilometres.');
  }
  function pickStation(id) {
    const d = doc(), s = stationOf(id);
    if (!d || !s) return;
    const auto = !d.bm.name || /^BM\w*_1$/.test(d.bm.name);
    const was = d.bm.name;
    d.station = { id: s.id, number: String(s.station_number || ''), name: s.name || '' };
    if (auto) {
      d.bm.name = L.bmName(d.station.number, 1);
      for (const r of d.rows || []) if (r.kind === 'bm' && r.name === was) r.name = d.bm.name;
    }
    // What Flood-Net already says of its gauge zero, for the datum step.
    stationHits = null;
    touch();
    repaint();
    announce(`Station ${d.station.number} ${d.station.name}.`);
    if (signedIn()) loadControl(s.id);
  }
  function clearStation() {
    const d = doc();
    if (!d) return;
    d.station = { id: null, number: '', name: '' };
    touch();
    repaint();
    const q = $('lv-stn-q');
    if (q) q.focus();
  }

  // ── 2. Crew & kit ──────────────────────────────────────────────────────────

  function kitSnap(k) {
    return { id: k.id, make: k.make || '', model: k.model || '', serial: k.serial || '', service_date: k.service_date || '' };
  }
  function kitHtml(d) {
    return `
      <h3>🧰 Crew & kit</h3>
      ${how(['A two-person job: one reads and books, one holds the staff.',
             'Link the two-peg test done before this trip — and test again if the level has had a knock.',
             'Staff checks: all sections out and clicked in, bubble in the circle, foot clean.'], 'kit')}
      <div class="form-grid">
        <label>Level operator <input value="${attr(d.operator)}" oninput="LevelSurvey.set('operator', this.value)" autocomplete="name"></label>
        <label>Staff holder <input value="${attr(d.staff_holder)}" oninput="LevelSurvey.set('staff_holder', this.value)" autocomplete="off"></label>
        <label class="full">Organisation <input value="${attr(d.organisation)}" oninput="LevelSurvey.set('organisation', this.value)" autocomplete="organization"></label>
      </div>
      <h4>Level</h4>
      ${kitPickHtml(d, 'level')}
      <h4>Staff <span class="small txt-muted">(optional)</span></h4>
      ${kitPickHtml(d, 'staff')}
      <h4>Two-peg test</h4>
      ${pegHtml(d)}`;
  }
  function kitPickHtml(d, kind) {
    const chosen = kind === 'level' ? d.instrument : d.staff;
    const list = LevelStore.kit(kind);
    const form = kitForm && kitForm.kind === kind;
    return `
      <ul class="lv-kit">
        ${list.map(k => `<li><button type="button" class="lv-kit-btn" onclick="LevelSurvey.useKit('${kind}', '${escAttr(k.id)}')"${chosen && chosen.id === k.id ? ' aria-pressed="true"' : ' aria-pressed="false"'}>
          <strong>${esc(L.kitLabel(k))}</strong>${k.service_date ? `<span class="small txt-muted"> serviced ${esc(L.dmy(k.service_date))}</span>` : ''}</button></li>`).join('')}
      </ul>
      ${chosen && !chosen.id && (chosen.serial || chosen.model) ? `<p class="small">On this survey: ${esc(L.kitLabel(chosen))}</p>` : ''}
      ${form ? kitFormHtml(kind) : `<button type="button" onclick="LevelSurvey.kitAdd('${kind}')">＋ Add a ${kind}</button>`}`;
  }
  function kitFormHtml(kind) {
    const f = kitForm;
    return `<div class="lv-kit-form" id="lv-kit-form">
      <div class="form-grid">
        <label>Make <input id="lv-kf-make" value="${attr(f.make)}" autocomplete="off"></label>
        <label>Model <input id="lv-kf-model" value="${attr(f.model)}" autocomplete="off"></label>
        <label>Serial number <input id="lv-kf-serial" value="${attr(f.serial)}" autocomplete="off" autocapitalize="characters"></label>
        <label>Service date <input id="lv-kf-service" type="date" value="${attr(f.service_date)}"></label>
      </div>
      <div class="button-row">
        <button type="button" onclick="LevelSurvey.kitRead()">📷 Read the plate</button>
        <button type="button" class="primary" onclick="LevelSurvey.kitSave()">Save the ${kind}</button>
        <button type="button" onclick="LevelSurvey.kitCancel()">Cancel</button>
      </div></div>`;
  }
  function kitAdd(kind) { kitForm = { kind, make: '', model: '', serial: '', service_date: '' }; repaint(); const f = $('lv-kf-make'); if (f) f.focus(); }
  function kitCancel() { kitForm = null; repaint(); }
  function kitFormRead() {
    if (!kitForm) return;
    for (const k of ['make', 'model', 'serial']) { const el = $(`lv-kf-${k}`); if (el) kitForm[k] = el.value.trim(); }
    const s = $('lv-kf-service'); if (s) kitForm.service_date = s.value;
  }
  async function kitRead() {
    kitFormRead();
    const got = await LevelCamera.read({ purpose: 'label', title: `The ${kitForm.kind}'s plate`, owner: 'kit', owner_id: null,
                                         caption: { what: `${kitForm.kind} plate` } });
    if (got && got.label) {
      for (const k of ['make', 'model', 'serial']) if (got.label[k]) kitForm[k] = got.label[k];
    }
    repaint();
  }
  async function kitSave() {
    kitFormRead();
    const f = kitForm;
    if (!f.make && !f.model && !f.serial) { announce('Give it a make, a model or a serial number.'); return; }
    const k = await LevelStore.saveKit({ kind: f.kind, make: f.make, model: f.model, serial: f.serial, service_date: f.service_date });
    kitForm = null;
    useKit(f.kind, k.id);
  }
  function useKit(kind, id) {
    const d = doc(), k = LevelStore.get('kit', id);
    if (!d || !k) return;
    if (kind === 'level') d.instrument = kitSnap(k); else d.staff = kitSnap(k);
    LevelStore.setPrefs({ [kind]: id });
    LevelStore.usedKit(id);
    touch();
    repaint();
  }
  function pegHtml(d) {
    const pt = d.peg_test;
    const ins = d.instrument || {};
    const tests = LevelStore.list('tests').filter(t => t.instrument && ((ins.id && t.instrument.id === ins.id) || (ins.serial && t.instrument.serial === ins.serial)))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const line = t => { const r = L.twoPeg(t); return `${esc(L.dmy(t.date))} — ${r.ready ? `error ${f3(r.error)} m, <span class="txt-${r.pass ? 'ok' : 'bad'}">${r.pass ? 'pass' : 'fail'}</span>` : 'not finished'}`; };
    return `
      ${pt ? `<p>Linked: ${esc(L.dmy(pt.date))}, error ${f3(pt.error_m)} m — <span class="txt-${pt.passed === false ? 'bad' : 'ok'}">${pt.passed === false ? 'FAIL' : 'pass'}</span>
          <button type="button" onclick="LevelSurvey.unlinkPeg()">Unlink</button></p>` : '<p class="txt-muted">No two-peg test linked yet.</p>'}
      ${tests.length ? `<ul class="lv-tests">${tests.slice(0, 5).map(t => `<li>${line(t)}
          ${pt && pt.id === t.id ? '' : `<button type="button" onclick="LevelSurvey.linkPeg('${escAttr(t.id)}')">Link</button>`}</li>`).join('')}</ul>` : ''}
      <button type="button" onclick="LevelSurvey.pegNow()">🎯 Do a two-peg test now</button>`;
  }
  function linkPeg(id) {
    const d = doc(), t = LevelStore.get('tests', id);
    if (!d || !t) return;
    const r = L.twoPeg(t);
    d.peg_test = { id: t.id, date: t.date, error_m: r.error, passed: r.pass };
    touch();
    repaint();
  }
  function unlinkPeg() { const d = doc(); if (!d) return; d.peg_test = null; touch(); repaint(); }
  async function pegNow() {
    const d = doc();
    if (!d) return;
    await flush();
    if (typeof TwoPeg !== 'undefined') TwoPeg.startFor({ instrument: d.instrument, surveyId: d.id, tester: d.operator, organisation: d.organisation, practice: d.practice });
    switchTab('twopeg');
  }
  // The Two-Peg Test tab hands a finished test back to the survey it was done for.
  async function linkTest(surveyId, testId) {
    const d = LevelStore.get('surveys', surveyId), t = LevelStore.get('tests', testId);
    if (!d || !t) return;
    const r = L.twoPeg(t);
    d.peg_test = { id: t.id, date: t.date, error_m: r.error, passed: r.pass };
    await LevelStore.put('surveys', d);
    cur = d.id; view = 'survey'; step = 'kit';
  }

  // ── 3. Datum ───────────────────────────────────────────────────────────────

  let control = null;    // { station, points, offsets } — what Flood-Net holds for the station
  async function loadControl(stationId) {
    if (!stationId || !signedIn()) return;
    try {
      const c = await LevelStore.stationControl(stationId);
      control = Object.assign({ station: stationId }, c);
      if (view === 'survey' && step === 'datum') repaint();
    } catch (_) { control = { station: stationId, points: [], offsets: [] }; }
  }
  function openGauge(d) {
    const s = d.station && d.station.id && stationOf(d.station.id);
    const rows = ((s && s.gauge_survey) || []).filter(g => !g.valid_to && g.gauge_zero_m != null);
    return rows.length ? rows[rows.length - 1] : null;
  }
  function datumHtml(d, red) {
    const g = openGauge(d);
    const bm = d.bm || {};
    const known = control && d.station && control.station === d.station.id ? (control.points || []).filter(p => p.kind === 'bm') : [];
    if (d.station && d.station.id && signedIn() && !(control && control.station === d.station.id)) loadControl(d.station.id);
    const unit = d.datum === 'AHD' ? 'm AHD' : d.datum === 'ASSUMED' ? 'm, assumed' : 'm on the gauge';
    return `
      <h3>📐 Datum and control</h3>
      ${how(['Start on the main benchmark and finish on it. Give its level, the datum, and where the level came from.',
             'Stick to one datum; only mix assumed, gauge and AHD numbers if the link between them is recorded.',
             'No AHD you can rely on? Call the main benchmark 100.000 and mark the datum assumed. An AHD figure only ever comes from a real AHD connection.',
             'The main mark should be permanent — a pin in concrete or rock, above flood reach, away from traffic; not a picket, post or tree. Missing, or looks moved? Stop and ring.'], 'datum')}
      <fieldset class="lv-datums"><legend>Datum</legend>
        ${Object.entries(L.DATUMS).map(([k, v]) => `<label class="lv-datum"><input type="radio" name="lv-datum" value="${k}"${d.datum === k ? ' checked' : ''}
            onchange="LevelSurvey.setDatum(this.value)"> <strong>${esc(v.label)}</strong><span class="small">${esc(v.hint)}</span></label>`).join('')}
      </fieldset>
      <h4>Primary benchmark</h4>
      ${known.length ? `<p class="small">Flood-Net holds ${known.length === 1 ? 'this benchmark' : 'these benchmarks'} for the station:</p>
        <ul class="lv-known">${known.map(p => `<li><strong>${esc(p.name)}</strong>${p.is_primary ? ' (primary)' : ''} — RL ${f3(Number(p.rl))} ${esc(p.datum || '')}
          <button type="button" onclick="LevelSurvey.useKnownBm('${escAttr(p.id)}')">Use</button></li>`).join('')}</ul>` : ''}
      <div class="form-grid">
        <label>Name <input value="${attr(bm.name)}" oninput="LevelSurvey.set('bm.name', this.value)" autocomplete="off"></label>
        <label>RL (${unit}) <input inputmode="decimal" value="${attr(bm.rl == null ? '' : bm.rl)}" oninput="LevelSurvey.setNum('bm.rl', this.value)" autocomplete="off"></label>
        <label class="full">Where its RL came from <input value="${attr(bm.source)}" oninput="LevelSurvey.set('bm.source', this.value)" list="lv-sources" autocomplete="off"></label>
      </div>
      <datalist id="lv-sources"><option value="Site pack"><option value="Station records"><option value="Previous survey"><option value="Assumed 100.000"><option value="GNSS, post-processed (report attached)"></datalist>
      <label class="lv-block">Description <span class="small txt-muted">— what it is, exactly where, so another crew finds it</span>
        <textarea rows="3" oninput="LevelSurvey.set('bm.description', this.value)" placeholder="${attr(L.suggestDesc('bm', { name: bm.name }, d))}…">${esc(bm.description || '')}</textarea></label>
      <div class="button-row">
        <button type="button" onclick="LevelSurvey.bmHere()">📍 Its position is here</button>
        <span class="small">${bm.lat != null ? `${Number(bm.lat).toFixed(6)}, ${Number(bm.lon).toFixed(6)}${bm.acc != null ? ` ±${Math.round(bm.acc)} m` : ''}` : '<span class="txt-muted">no position yet</span>'}</span>
      </div>
      ${photosHtml(bm.photos, 'bm', 'Photos — one close up, one showing where it is')}
      <h4>Gauge zero</h4>
      ${gaugeZeroHtml(d, red, g)}
      <div id="lv-live-datum" class="lv-live">${datumLiveHtml(d, red)}</div>
      <details class="lv-limits"><summary>Limits this survey is held to</summary>
        <div class="form-grid">
          <label>Misclose (± m) <input inputmode="decimal" value="${attr(d.tol.misclose)}" oninput="LevelSurvey.setNum('tol.misclose', this.value)"></label>
          <label>Gauge board from its face value (± m) <input inputmode="decimal" value="${attr(d.tol.board)}" oninput="LevelSurvey.setNum('tol.board', this.value)"></label>
          <label>Longest sight (m) <input inputmode="decimal" value="${attr(d.tol.sight)}" oninput="LevelSurvey.setNum('tol.sight', this.value)"></label>
          <label>Back and fore sights apart by (m) <input inputmode="decimal" value="${attr(d.tol.balance)}" oninput="LevelSurvey.setNum('tol.balance', this.value)"></label>
        </div>
        <p class="small txt-muted">The site's own figures, where it has them, take precedence.</p>
      </details>`;
  }
  function gaugeZeroHtml(d, red, g) {
    const gz = d.gauge_zero || {};
    const boards = (d.rows || []).filter(r => r.kind === 'board');
    const fromBoard = `
      <label>Nominate a gauge board <select onchange="LevelSurvey.set('gauge_zero.from_row', this.value || null, {repaint:true})">
        <option value="">— none —</option>
        ${boards.map(r => `<option value="${attr(r.id)}"${gz.from_row === r.id ? ' selected' : ''}>${esc(r.name || 'Gauge board')}${r.face != null ? ` (face ${f3(L.num(r.face))})` : ''}</option>`).join('')}
      </select></label>
      ${boards.length ? '' : '<p class="small txt-muted">Survey the boards in the run first; they appear here.</p>'}`;
    if (d.datum === 'LGH') {
      return `<p class="small">Gauge zero is the datum: 0.000. Its AHD level, where known, gives the run an AHD column.</p>
        <div class="form-grid"><label>Gauge zero (m AHD) <input inputmode="decimal" value="${attr(gz.rl == null ? '' : gz.rl)}" oninput="LevelSurvey.setNum('gauge_zero.rl', this.value)"></label>
        <label>Where it came from <input value="${attr(gz.source)}" oninput="LevelSurvey.set('gauge_zero.source', this.value)" list="lv-sources"></label></div>
        ${g && g.datum === 'AHD' ? `<button type="button" onclick="LevelSurvey.useStationGz()">Use Flood-Net's: ${f3(Number(g.gauge_zero_m))} m AHD since ${esc(L.dmy(g.valid_from))}</button>` : ''}`;
    }
    const unit = d.datum === 'AHD' ? 'm AHD' : 'm, assumed';
    return `
      <div class="form-grid">
        <label>Gauge zero (${unit}) <input inputmode="decimal" value="${attr(gz.rl == null ? '' : gz.rl)}" ${gz.from_row ? 'disabled' : ''}
          oninput="LevelSurvey.setNum('gauge_zero.rl', this.value)"></label>
        <label>Where it came from <input value="${attr(gz.source)}" oninput="LevelSurvey.set('gauge_zero.source', this.value)" list="lv-sources"
          placeholder="${d.datum === 'ASSUMED' ? 'From the nominated board, or none yet' : 'Station records, site pack…'}"></label>
      </div>
      ${g && d.datum === 'AHD' && g.datum === 'AHD' ? `<button type="button" onclick="LevelSurvey.useStationGz()">Use Flood-Net's: ${f3(Number(g.gauge_zero_m))} m AHD since ${esc(L.dmy(g.valid_from))}</button>` : ''}
      <p class="small">${d.datum === 'ASSUMED' ? 'With no AHD, gauge zero comes from a board you trust: its surveyed top minus the number printed there. Nominate it below and the others are checked against it — book any that disagree and raise it, rather than splitting the difference.'
                                              : 'Or work it out from a board you trust: its surveyed top minus the number printed there.'}</p>
      ${fromBoard}`;
  }
  function datumLiveHtml(d, red) {
    const gz = red.gaugeZero;
    return `<p>${gz.rl != null || d.datum === 'LGH' ? `Gauge zero <strong>${d.datum === 'LGH' ? '0.000 (the datum)' : `${f3(gz.rl)} m`}</strong>${gz.how === 'board' ? ' — from the nominated board' : ''}`
      : '<span class="txt-muted">No gauge zero yet — the run has no levels on the gauge until there is one.</span>'}
      ${red.rows[0] && red.rows[0].lgh != null ? ` · the benchmark is <strong>${f3(red.rows[0].lgh)} m</strong> on the gauge` : ''}</p>`;
  }
  function setDatum(v) {
    const d = doc();
    if (!d || !L.DATUMS[v]) return;
    d.datum = v;
    if (v === 'ASSUMED' && L.num(d.bm.rl) == null) { d.bm.rl = 100; if (!d.bm.source) d.bm.source = 'Assumed 100.000'; }
    if (v !== 'ASSUMED' && d.gauge_zero && d.gauge_zero.from_row && v === 'LGH') d.gauge_zero.from_row = null;
    touch();
    repaint();
  }
  function useStationGz() {
    const d = doc(), g = d && openGauge(d);
    if (!g) return;
    d.gauge_zero = Object.assign({}, d.gauge_zero, { rl: Number(g.gauge_zero_m), source: `Flood-Net station records (since ${L.dmy(g.valid_from)})`, from_row: null });
    touch();
    repaint();
  }
  function useKnownBm(id) {
    const d = doc(), p = control && (control.points || []).find(x => x.id === id);
    if (!d || !p) return;
    d.bm = Object.assign({}, d.bm, { name: p.name, rl: Number(p.rl), source: `Flood-Net (adopted ${L.dmy(p.surveyed_on || '')})`,
      description: p.description || d.bm.description, lat: p.lat, lon: p.lon });
    if (p.datum === 'AHD') d.datum = 'AHD'; else if (p.datum === 'ASSUM') d.datum = 'ASSUMED'; else if (p.datum === 'LGH') d.datum = 'LGH';
    const first = (d.rows || [])[0];
    if (first && first.kind === 'bm') first.name = p.name;
    touch();
    repaint();
  }
  function bmHere() {
    const d = doc();
    if (!d) return;
    if (!here) { startGps(); announce('Waiting for a GPS fix — press again in a moment.'); return; }
    Object.assign(d.bm, { lat: here.lat, lon: here.lon, acc: Math.round(here.acc * 10) / 10 });
    touch();
    repaint();
  }

  // ── 4. The run ─────────────────────────────────────────────────────────────

  function runHtml(d, red) {
    return `
      <h3>📏 Level run</h3>
      ${how(['A row per staff position, in reading order — row 1 is the backsight on the main benchmark.',
             'Change point: the foresight to it, then — after moving the level — the backsight from it, both on the same row. Choose something solid that will not move; never a board.',
             `Balance backsight and foresight lengths in each set-up; keep sights to about ${esc(String(d.tol.sight))} m or less.`,
             'Put the staff foot on the exact spot: a board\'s top (a clamp helps), the top of the CTR fitting. Level the boards as found before anyone adjusts them.',
             'Finish with a foresight back on the benchmark you started on.'], 'run')}
      <div id="lv-live-run" class="lv-live" aria-live="polite">${runLiveHtml(d, red)}</div>
      <ol class="lv-rows" id="lv-rows">${rowsHtml(d, red)}</ol>
      <div class="lv-add">
        <button type="button" onclick="LevelSurvey.addRow('is')">＋ Intermediate</button>
        <button type="button" onclick="LevelSurvey.addRow('cp')">＋ Change point</button>
        <button type="button" class="primary" onclick="LevelSurvey.addRow('close')">＋ Close on the benchmark</button>
      </div>
      <label class="check-label"><input type="checkbox"${asTable ? ' checked' : ''} onchange="LevelSurvey.toggleTable(this.checked)"> Show the run as a level book</label>
      <div id="lv-table">${asTable ? tableHtml(d, red) : ''}</div>`;
  }
  function runLiveHtml(d, red) {
    const rows = d.rows || [];
    if (!rows.length) return '<p class="txt-muted">No readings yet.</p>';
    const last = [...red.rows].reverse().find(o => o.rl != null);
    const open = red.rows.filter(o => o.role === 'pending').length;
    const setup = red.setups[red.setups.length - 1];
    const lines = [];
    if (red.closed) {
      lines.push(`<p><strong>Closed.</strong> ${red.misclose == null ? '<span class="txt-bad">Not on the opening benchmark.</span>'
        : `Misclose <strong class="txt-${red.within ? 'ok' : 'bad'}">${L.signed(red.misclose)} m</strong> (${L.mm(red.misclose)}) against ±${f3(red.tolerance)} m.`}</p>`);
      lines.push(`<p class="small">ΣBS − ΣFS ${L.signed(red.checks.bsfs)} · ΣRise − ΣFall ${L.signed(red.checks.risefall)} · last − first ${L.signed(red.checks.lastfirst)}
        ${red.checks.agree ? '<span class="txt-ok">✓ all three agree</span>' : '<span class="txt-bad">✗ they disagree</span>'}</p>`);
    } else {
      lines.push(`<p>Set-up ${setup ? setup.n : 1}${last ? ` · last level ${f3(last.rl)}${last.lgh != null ? ` (${f3(last.lgh)} on the gauge)` : ''} on ${esc(last.name || L.KINDS[last.kind].label)}` : ''}${open ? ` · ${open} row${open === 1 ? '' : 's'} with no reading` : ''}</p>`);
    }
    const errs = red.problems.filter(p => p.level === 'error');
    if (errs.length) lines.push(`<ul class="lv-problems">${errs.slice(0, 4).map(p => `<li class="txt-bad">${esc(p.text)}</li>`).join('')}</ul>`);
    return lines.join('');
  }
  function sightText(r) {
    const b = [];
    if (r.fs != null) b.push(`FS ${f3(L.num(r.fs))}`);
    if (r.is != null) b.push(`IS ${f3(L.num(r.is))}`);
    if (r.bs != null) b.push(`BS ${f3(L.num(r.bs))}`);
    return b.join(' · ') || '<span class="txt-warn">no reading</span>';
  }
  function rowsHtml(d, red) {
    return (d.rows || []).map((r, i) => {
      const o = red.rows[i] || {};
      const k = L.KINDS[r.kind] || L.KINDS.other;
      const bad = (o.problems || []).some(p => p.level === 'error'), warn = (o.problems || []).some(p => p.level === 'warn');
      const move = o.rise != null ? `▲${f3(o.rise)}` : o.fall != null ? `▼${f3(o.fall)}` : '';
      const role = o.role === 'open' ? 'opening' : o.role === 'cp' ? 'change point' : o.role === 'close' ? 'closing' : '';
      return `<li class="lv-row${bad ? ' lv-bad' : warn ? ' lv-warn' : ''}">
        <button type="button" class="lv-row-btn" onclick="LevelSurvey.editRow('${escAttr(r.id)}')" aria-label="Row ${i + 1}, ${attr(k.label)} ${attr(r.name)} — open">
          <span class="lv-n">${i + 1}</span>
          <span class="lv-row-main"><span class="lv-row-name"><span aria-hidden="true">${k.icon}</span> ${esc(r.name || k.label)}${role ? ` <small class="txt-muted">${role}</small>` : ''}</span>
            <span class="lv-row-sights">${sightText(r)}</span></span>
          <span class="lv-row-rl">${move ? `<span class="lv-move">${move}</span>` : ''}${o.rl != null ? `<span>RL ${f3(o.rl)}</span>` : ''}${o.lgh != null ? `<span class="txt-muted">${f3(o.lgh)} gauge</span>` : ''}</span>
          ${bad ? '<span class="lv-flag" aria-label="has a problem">⚠</span>' : (r.photos || []).length ? '<span class="lv-flag" aria-label="has pictures">📷</span>' : ''}
        </button></li>`;
    }).join('');
  }
  // The run as a level book — the columns a printed sheet has — for a wide screen.
  function tableHtml(d, red) {
    const cell = v => (v == null ? '' : f3(v));
    return `<div class="table-wrap medium" role="region" aria-label="The level book" tabindex="0"><table class="lv-book">
      <caption class="sr-only">The run, booked rise and fall</caption>
      <thead><tr>${['No.', 'BS', 'IS', 'FS', 'Rise', 'Fall', 'RL Ass', 'RL LGH', 'RL AHD', 'Point', 'Description'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead>
      <tbody>${(d.rows || []).map((r, i) => { const o = red.rows[i] || {};
        return `<tr><td>${i + 1}</td><td>${cell(L.num(r.bs))}</td><td>${cell(L.num(r.is))}</td><td>${cell(L.num(r.fs))}</td><td>${cell(o.rise)}</td><td>${cell(o.fall)}</td>
          <td>${cell(o.ass)}</td><td>${cell(o.lgh)}</td><td>${cell(o.ahd)}</td><td>${esc(r.name || '')}</td><td class="lv-desc">${esc(r.desc || '')}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><th scope="row">Σ</th><td>${f3(red.sums.bs)}</td><td></td><td>${f3(red.sums.fs)}</td><td>${f3(red.sums.rise)}</td><td>${f3(red.sums.fall)}</td><td colspan="5"></td></tr></tfoot>
    </table></div>`;
  }
  function toggleTable(on) { asTable = !!on; paintLive(); }

  function addRow(mode) {
    const d = doc();
    if (!d) return;
    if (!(d.rows || []).length) d.rows = [openingRow(d)];
    const cps = d.rows.filter(r => r.bs != null && r.fs != null).length;
    const r = mode === 'cp' ? L.blankRow('cp', { name: `CP${cps + 1}`, mode: 'cp' })
      : mode === 'close' ? L.blankRow('bm', { name: d.bm.name || L.bmName(d.station.number), mode: 'close', desc: `${d.bm.name || 'Primary benchmark'} — closing sight on the opening benchmark.` })
      : L.blankRow('board', { mode: 'is' });
    d.rows.push(r);
    touch();
    editRow(r.id);
  }

  // ── A row ──────────────────────────────────────────────────────────────────

  function editRow(id) {
    flush();
    rowId = id; view = 'row';
    repaint();
    const first = document.querySelector('#lv-root input[data-first]');
    if (first) first.focus();
  }
  function doneRow() {
    flush();
    view = 'survey'; step = 'run'; rowId = null;
    repaint();
  }
  function curRow() { const d = doc(); return d && (d.rows || []).find(r => r.id === rowId); }
  function modeOf(r, i) {
    if (i === 0) return 'open';
    if (r.mode) return r.mode;
    if (r.bs != null && r.fs != null) return 'cp';
    if (r.fs != null) return 'close';
    return 'is';
  }

  function rowHtml(d) {
    const i = (d.rows || []).findIndex(r => r.id === rowId);
    const r = d.rows[i];
    if (!r) { view = 'survey'; return surveyHtml(d); }
    const red = L.reduce(d);
    const m = modeOf(r, i);
    const sight = (f, label, first) => `
      <div class="lv-sight">
        <label class="lv-sight-label" for="lv-r-${f}">${label} (m)</label>
        <div class="lv-sight-row">
          <input id="lv-r-${f}" class="lv-num" inputmode="decimal" autocomplete="off" value="${attr(r[f] == null ? '' : r[f])}"
                 oninput="LevelSurvey.setRow('${f}', this.value, true)"${first ? ' data-first' : ''}>
          <button type="button" class="lv-cam" onclick="LevelSurvey.readInto('${f}')" aria-label="Read the ${label.toLowerCase()} off the display">📷</button>
        </div>
        <div class="lv-sight-row lv-dist">
          <label for="lv-r-${f}_d">distance (m)</label>
          <input id="lv-r-${f}_d" class="lv-num lv-num-sm" inputmode="decimal" autocomplete="off" value="${attr(r[`${f}_d`] == null ? '' : r[`${f}_d`])}"
                 oninput="LevelSurvey.setRow('${f}_d', this.value, true)">
          <button type="button" class="lv-cam" onclick="LevelSurvey.readInto('${f}_d')" aria-label="Read the distance off the display">📷</button>
        </div>
        ${evThumbs(r, f)}
      </div>`;
    const k = r.kind;
    return `
      <div class="lv-top">
        <button type="button" class="link-btn" onclick="LevelSurvey.doneRow()">◀ Back to the run</button>
        <h3 class="lv-title">Row ${i + 1}${m === 'open' ? ' — opening on the benchmark' : ''}</h3>
        <div id="lv-sum" class="lv-sum">${summaryHtml(d, red)}</div>
      </div>
      <section class="panel lv-step">
        ${i === 0 ? '' : `<fieldset class="lv-pills lv-modes"><legend>This sight is</legend>
          ${[['is', 'An intermediate'], ['cp', 'A change point'], ['close', 'The closing sight']].map(([v, t]) =>
            `<label class="lv-pill"><input type="radio" name="lv-mode" value="${v}"${m === v ? ' checked' : ''} onchange="LevelSurvey.setMode(this.value)"> ${t}</label>`).join('')}
        </fieldset>`}
        <fieldset class="lv-pills lv-kinds"><legend>What the staff is on</legend>
          ${L.KIND_ORDER.map(kk => `<label class="lv-pill"><input type="radio" name="lv-kind" value="${kk}"${k === kk ? ' checked' : ''} onchange="LevelSurvey.setKind(this.value)">
            <span aria-hidden="true">${L.KINDS[kk].icon}</span> ${esc(L.KINDS[kk].label)}</label>`).join('')}
        </fieldset>
        <label class="lv-block">Point <input value="${attr(r.name)}" oninput="LevelSurvey.setRow('name', this.value)" autocomplete="off"
          placeholder="${attr(k === 'cp' ? 'CP1' : k === 'bm' ? L.bmName(d.station.number, 2) : k === 'board' ? '3–4 m board' : L.KINDS[k].short)}"></label>
        <div class="lv-sights">
          ${m === 'open' ? sight('bs', 'Backsight', true) : ''}
          ${m === 'is' ? sight('is', 'Intermediate sight', true) : ''}
          ${m === 'cp' ? sight('fs', 'Foresight to it', true) + sight('bs', 'Backsight from it, once moved', false) : ''}
          ${m === 'close' ? sight('fs', 'Foresight', true) : ''}
        </div>
        ${k === 'board' ? `<div class="form-grid">
            <label>Face value at the point read (m) <input inputmode="decimal" value="${attr(r.face == null ? '' : r.face)}" oninput="LevelSurvey.setRow('face', this.value, true)"></label>
            <label>Surveyed <select onchange="LevelSurvey.setRow('state', this.value)"><option value=""${!r.state ? ' selected' : ''}>—</option>
              <option value="found"${r.state === 'found' ? ' selected' : ''}>as found</option><option value="left"${r.state === 'left' ? ' selected' : ''}>as left, after adjusting</option></select></label>
          </div>` : ''}
        ${k === 'bm' && i > 0 && m !== 'close' ? `<label class="lv-block">Its scheduled RL, if it has one (m) <input inputmode="decimal" value="${attr(r.scheduled == null ? '' : r.scheduled)}" oninput="LevelSurvey.setRow('scheduled', this.value, true)"></label>` : ''}
        ${k === 'ctf' ? `<label class="check-label"><input type="checkbox"${r.approx ? ' checked' : ''} onchange="LevelSurvey.setRow('approx', this.checked)"> Approximate — judged, not surveyed at a defined control</label>` : ''}
        <div class="lv-time">
          <label>Time <input type="time" value="${attr(r.time)}" onchange="LevelSurvey.setRow('time', this.value)"></label>
          <button type="button" onclick="LevelSurvey.rowNow()">Now</button>
          ${k === 'water' ? '<span class="small txt-muted">A water surface needs its time — the water check is matched to it.</span>' : ''}
        </div>
        <label class="lv-block">Description <span class="small txt-muted">— ${esc(L.HINT[k] || L.HINT.other)}</span>
          <textarea rows="3" oninput="LevelSurvey.setRow('desc', this.value)" placeholder="${attr(L.suggestDesc(k, r, d))}…">${esc(r.desc || '')}</textarea></label>
        ${!r.desc ? `<button type="button" class="link-btn" onclick="LevelSurvey.startDesc()">Start it: “${esc(L.suggestDesc(k, r, d))}…”</button>` : ''}
        ${photosHtml(r.photos, 'row', k === 'bm' ? 'Photos — close up, and showing where it is' : 'Photo of the point')}
        ${k === 'bm' || k === 'ctr' ? `<div class="button-row"><button type="button" onclick="LevelSurvey.rowHere()">📍 Its position is here</button>
          <span class="small">${r.lat != null ? `${Number(r.lat).toFixed(6)}, ${Number(r.lon).toFixed(6)}${r.acc != null ? ` ±${Math.round(r.acc)} m` : ''}` : '<span class="txt-muted">no position yet</span>'}</span></div>` : ''}
        <div id="lv-live-row" class="lv-live" aria-live="polite">${rowLiveHtml(d, red)}</div>
        <div class="button-row lv-row-actions">
          <button type="button" class="primary" onclick="LevelSurvey.doneRow()">Done</button>
          ${i > 0 ? `<button type="button" onclick="LevelSurvey.moveRow(-1)" aria-label="Move this row up">↑</button>` : ''}
          ${i < d.rows.length - 1 ? `<button type="button" onclick="LevelSurvey.moveRow(1)" aria-label="Move this row down">↓</button>` : ''}
          ${i > 0 ? '<button type="button" class="btn-danger" onclick="LevelSurvey.deleteRow()">Delete the row</button>' : ''}
        </div>
      </section>`;
  }
  function rowLiveHtml(d, red) {
    const i = (d.rows || []).findIndex(r => r.id === rowId);
    const o = red.rows[i];
    if (!o) return '';
    const b = red.boards.find(x => x.id === rowId);
    const bits = [];
    if (o.rise != null) bits.push(`rise ${f3(o.rise)}`);
    if (o.fall != null) bits.push(`fall ${f3(o.fall)}`);
    if (o.rl != null) bits.push(`RL <strong>${f3(o.rl)}</strong>`);
    if (o.lgh != null) bits.push(`<strong>${f3(o.lgh)}</strong> on the gauge`);
    if (o.ahd != null && d.datum !== 'AHD') bits.push(`${f3(o.ahd)} AHD`);
    return `${bits.length ? `<p>${bits.join(' · ')}</p>` : '<p class="txt-muted">No level yet.</p>'}
      ${b && b.error != null ? `<p>Against its face value: <strong class="txt-${Math.abs(b.error) > d.tol.board ? 'warn' : 'ok'}">${L.signed(b.error)} m</strong>${b.adjust ? ' — adjust it, then survey it again as left' : ''}</p>` : ''}
      ${(o.problems || []).map(p => `<p class="txt-${p.level === 'error' ? 'bad' : 'warn'}">${esc(p.text)}</p>`).join('')}`;
  }
  function setRow(field, value, number) {
    const r = curRow();
    if (!r) return;
    r[field] = number ? L.num(value) : value;
    if (field === 'face' && r.kind === 'board' && (!r.name || /^\d+–\d+ m board$/.test(r.name))) {
      const f = L.num(value);
      if (f != null && f >= 1) r.name = `${L.fmt(f - 1, 0)}–${L.fmt(f, 0)} m board`;
    }
    touch();
  }
  function setMode(m) {
    const r = curRow();
    if (!r) return;
    const v = r.is != null ? r.is : r.fs;
    r.mode = m;
    if (m === 'is') { r.is = v; r.fs = null; r.bs = null; r.is_d = r.is_d != null ? r.is_d : r.fs_d; r.fs_d = null; r.bs_d = null; }
    else if (m === 'cp') { r.fs = v; r.is = null; r.fs_d = r.fs_d != null ? r.fs_d : r.is_d; r.is_d = null; if (r.kind === 'board' || r.kind === 'other') r.kind = 'cp'; }
    else { r.fs = v; r.is = null; r.bs = null; r.fs_d = r.fs_d != null ? r.fs_d : r.is_d; r.is_d = null; r.bs_d = null; }
    touch();
    repaint();
  }
  function setKind(k) {
    const r = curRow(), d = doc();
    if (!r || !L.KINDS[k]) return;
    r.kind = k;
    if (k === 'water' && !r.time) r.time = L.clock();
    if (k === 'bm' && !r.name) r.name = d.bm.name;
    if (k === 'cp' && !r.name) r.name = `CP${(d.rows || []).filter(x => x.kind === 'cp').length}`;
    if (k === 'ctr' && !r.name) r.name = 'CTR';
    if (k === 'ctf' && !r.name) r.name = 'CTF';
    touch();
    repaint();
  }
  function rowNow() { const r = curRow(); if (!r) return; r.time = L.clock(); touch(); repaint(); }
  function startDesc() { const r = curRow(), d = doc(); if (!r) return; r.desc = L.suggestDesc(r.kind, r, d); touch(); repaint();
    const t = document.querySelector('#lv-root textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  function rowHere() {
    const r = curRow();
    if (!r) return;
    if (!here) { startGps(); announce('Waiting for a GPS fix — press again in a moment.'); return; }
    Object.assign(r, { lat: here.lat, lon: here.lon, acc: Math.round(here.acc * 10) / 10 });
    touch();
    repaint();
  }
  function moveRow(dir) {
    const d = doc();
    const i = d.rows.findIndex(r => r.id === rowId), j = i + dir;
    if (i < 1 || j < 1 || j >= d.rows.length) return;
    [d.rows[i], d.rows[j]] = [d.rows[j], d.rows[i]];
    touch();
    repaint();
  }
  async function deleteRow() {
    const d = doc();
    const i = d.rows.findIndex(r => r.id === rowId);
    if (i < 1) return;
    const ok = await confirmDialog({ title: `Delete row ${i + 1}?`, message: 'Its readings and its pictures go with it.', confirm: 'Delete the row', danger: true });
    if (!ok) return;
    const [r] = d.rows.splice(i, 1);
    for (const p of r.photos || []) await LevelStore.dropEvidence(p.id);
    if (d.gauge_zero && d.gauge_zero.from_row === r.id) d.gauge_zero.from_row = null;
    if (d.water && d.water.row === r.id) d.water.row = null;
    touch();
    doneRow();
  }

  // 📷 beside a box: the reading camera, its answer into the box, its picture
  // filed under the row and the sight.
  async function readInto(field) {
    const d = doc(), r = curRow();
    if (!d || !r) return;
    await flush();
    const i = d.rows.indexOf(r);
    const dist = /_d$/.test(field);
    const got = await LevelCamera.read({
      purpose: 'reading', expect: dist ? 'distance' : 'height', title: `Row ${i + 1} · ${FIELD_WORDS[field] || field}`,
      owner: 'survey', owner_id: d.id, row_id: r.id, field,
      caption: { what: `Row ${i + 1} ${r.name || ''} · ${field.toUpperCase()}`, station: [d.station.number, d.station.name].filter(Boolean).join(' '), where: here },
    });
    const r2 = curRow();
    if (!got || !r2) { repaint(); return; }
    if (got.typed) { repaint(); const el = $(`lv-r-${field}`); if (el) el.focus(); return; }
    if (got.value != null) r2[field] = got.value;
    if (got.distance != null && !dist) r2[`${field}_d`] = got.distance;
    if (got.evidence) {
      r2.photos = r2.photos || [];
      r2.photos.push({ id: got.evidence.id, kind: 'reading', field });
    }
    touch();
    repaint();
    announce(`Row ${i + 1}: ${FIELD_WORDS[field] || field} ${got.value} metres.`);
  }
  function evThumbs(r, field) {
    const list = (r.photos || []).filter(p => p.kind === 'reading' && p.field === field);
    if (!list.length) return '';
    return `<div class="lv-thumbs">${list.slice(-3).map(p => {
      const e = LevelStore.evidence(p.id);
      const v = e && e.value_m != null ? e.value_m : null;
      const differs = v != null && L.num(r[field]) != null && Math.abs(v - L.num(r[field])) > 0.00005;
      return `<button type="button" class="lv-thumb" onclick="LevelSurvey.view('${escAttr(p.id)}')" aria-label="The picture this reading was taken from">
        <img data-ev="${attr(p.id)}" alt="">${differs ? '<span class="lv-thumb-note">changed since</span>' : ''}</button>`;
    }).join('')}</div>`;
  }

  // Photos of a point (or the benchmark): taken in the sheet, kept as evidence.
  function photosHtml(list, where, label) {
    const shots = (list || []).filter(p => p.kind !== 'reading');
    return `<div class="lv-photos"><span class="lv-label">${esc(label)}</span>
      <div class="lv-thumbs">${shots.map(p => `<button type="button" class="lv-thumb" onclick="LevelSurvey.view('${escAttr(p.id)}')" aria-label="Open the photo">
        <img data-ev="${attr(p.id)}" alt=""></button>`).join('')}
        <button type="button" class="lv-thumb lv-thumb-add" onclick="LevelSurvey.addPhoto('${where}')">📷<span>Add</span></button></div></div>`;
  }
  async function addPhoto(where) {
    const d = doc();
    if (!d) return;
    await flush();
    const r = where === 'row' ? curRow() : null;
    const name = r ? (r.name || L.KINDS[r.kind].label) : where === 'bm' ? (d.bm.name || 'Benchmark') : 'Site overview';
    const got = await LevelCamera.photo({
      title: `Photo — ${name}`, owner: 'survey', owner_id: d.id, row_id: r ? r.id : null, field: where === 'site' ? 'overview' : 'point',
      caption: { what: name, station: [d.station.number, d.station.name].filter(Boolean).join(' '), where: here },
    });
    if (!got || !got.evidence) { repaint(); return; }
    const ref = { id: got.evidence.id, kind: 'photo' };
    if (where === 'row' && r) { r.photos = r.photos || []; r.photos.push(ref); }
    else if (where === 'bm') { d.bm.photos = d.bm.photos || []; d.bm.photos.push(ref); }
    else { d.photos = d.photos || []; d.photos.push(ref); }
    touch();
    repaint();
  }
  // A picture, full size, with what it says about itself.
  async function viewPicture(id) {
    const e = LevelStore.evidence(id);
    const u = await LevelStore.urlOf(id);
    if (!u) return;
    Modal.open({
      title: e && e.kind === 'reading' ? 'The reading\'s picture' : 'Photo',
      wide: true,
      html: `<figure class="lv-figure"><img src="${attr(u)}" alt="${e && e.kind === 'reading' ? 'The level display the reading was taken from' : 'Photo'}">
        <figcaption class="small">${e && e.value_m != null ? `Taken as ${e.value_m} m. ` : ''}${e && e.ocr_text ? `The reader saw: “${esc(e.ocr_text.trim().replace(/\s+/g, ' ')).slice(0, 160)}”. ` : ''}
          ${e ? `${(e.bytes / 1024).toFixed(0)} kB, ${e.width}×${e.height}.` : ''}</figcaption></figure>
        <div class="modal-foot"><button type="button" class="btn-danger" onclick="LevelSurvey.dropPicture('${escAttr(id)}')">Delete the picture</button>
          <button type="button" class="primary" onclick="Modal.close()">Close</button></div>`,
    });
  }
  async function dropPicture(id) {
    const ok = await confirmDialog({ title: 'Delete this picture?', message: 'The reading stays; only its picture goes.', confirm: 'Delete it', danger: true });
    if (!ok) return;
    const d = doc();
    if (d) {
      for (const r of d.rows || []) r.photos = (r.photos || []).filter(p => p.id !== id);
      if (d.bm) d.bm.photos = (d.bm.photos || []).filter(p => p.id !== id);
      d.photos = (d.photos || []).filter(p => p.id !== id);
      touch();
    }
    await LevelStore.dropEvidence(id);
    Modal.close();
    repaint();
  }

  // ── 5. Water check ─────────────────────────────────────────────────────────

  function waterHtml(d, red) {
    const w = d.water || {};
    const waters = (d.rows || []).filter(r => r.kind === 'water');
    return `
      <h3>🌊 Water check</h3>
      ${how(['Only with water over the sensor reference.',
             'Three numbers, as close together in time as you can: the levelled water surface, the board, the logger.',
             'Note the differences — there is no pass mark, and the logger\'s offset stays as it is unless you have been told otherwise.',
             'Dry, or water under the sensor? Say so and leave the numbers out.'], 'water')}
      <fieldset class="lv-pills"><legend>The water</legend>
        ${[['wet', 'Above the sensor reference'], ['dry', 'The site is dry'], ['below', 'Below the sensor reference']].map(([v, t]) =>
          `<label class="lv-pill"><input type="radio" name="lv-water" value="${v}"${(w.state || 'wet') === v ? ' checked' : ''} onchange="LevelSurvey.set('water.state', this.value, {repaint:true})"> ${t}</label>`).join('')}
      </fieldset>
      ${(w.state || 'wet') === 'wet' ? `
        <div class="lv-field"><span class="lv-label">Surveyed water surface</span>
          ${waters.length ? `<select aria-label="The water-surface row" onchange="LevelSurvey.set('water.row', this.value)">${waters.map(r => `<option value="${attr(r.id)}"${(w.row || waters[waters.length - 1].id) === r.id ? ' selected' : ''}>Row ${d.rows.indexOf(r) + 1}${r.time ? ` at ${esc(r.time)}` : ''}</option>`).join('')}</select>`
            : `<p class="txt-warn">No water surface in the run yet. <button type="button" onclick="LevelSurvey.addWater()">＋ Add it to the run</button></p>`}
        </div>
        <div class="form-grid">
          <label>Gauge board reading (m) <input inputmode="decimal" value="${attr(w.board && w.board.value != null ? w.board.value : '')}" oninput="LevelSurvey.setNum('water.board.value', this.value)"></label>
          <div class="lv-time"><label>Board read at <input type="time" value="${attr(w.board && w.board.time)}" onchange="LevelSurvey.set('water.board.time', this.value)"></label>
            <button type="button" onclick="LevelSurvey.waterNow('board')">Now</button></div>
          <label>Logger reading (m) <input inputmode="decimal" value="${attr(w.logger && w.logger.value != null ? w.logger.value : '')}" oninput="LevelSurvey.setNum('water.logger.value', this.value)"></label>
          <div class="lv-time"><label>Logger read at <input type="time" value="${attr(w.logger && w.logger.time)}" onchange="LevelSurvey.set('water.logger.time', this.value)"></label>
            <button type="button" onclick="LevelSurvey.waterNow('logger')">Now</button></div>
          <label class="full">The logger's reading came from <input value="${attr(w.logger && w.logger.source)}" oninput="LevelSurvey.set('water.logger.source', this.value)" list="lv-logsrc" placeholder="The logger's display, the laptop, SCADA…"></label>
        </div>
        <datalist id="lv-logsrc"><option value="Logger display"><option value="Laptop on the logger"><option value="SCADA / telemetry"></datalist>` : ''}
      <label class="lv-block">Comments <textarea rows="2" oninput="LevelSurvey.set('water.note', this.value)" placeholder="${(w.state || 'wet') === 'wet' ? 'Anything that explains a difference' : 'Say why there is no water check'}">${esc(w.note || '')}</textarea></label>
      <div id="lv-live-water" class="lv-live" aria-live="polite">${waterLiveHtml(d, red)}</div>`;
  }
  function waterLiveHtml(d, red) {
    const wc = L.waterCheck(d, red);
    if (wc.state === 'dry' || wc.state === 'below') return wc.done ? '<p class="txt-ok">✓ Said why there is no water check.</p>' : `<p class="txt-warn">${esc(wc.notes.join(' '))}</p>`;
    const row = (t, v, time, diff) => `<tr><th scope="row">${t}</th><td>${v == null ? '—' : f3(v)}</td><td>${esc(time || '')}</td><td>${diff == null ? '' : esc(L.mm(diff))}</td></tr>`;
    return `<div class="table-wrap"><table class="lv-water-table"><caption class="sr-only">The water check</caption>
      <thead><tr><th scope="col">Reading</th><th scope="col">m (gauge)</th><th scope="col">Time</th><th scope="col">From the surveyed</th></tr></thead><tbody>
      ${row('Surveyed water surface', wc.surveyed, wc.surveyedTime, null)}
      ${row('Gauge board', wc.board, wc.boardTime, wc.boardLessSurveyed)}
      ${row('Logger', wc.logger, wc.loggerTime, wc.loggerLessSurveyed)}
      </tbody></table></div>
      ${wc.notes.length ? `<ul class="lv-problems">${wc.notes.map(n => `<li class="txt-warn">${esc(n)}</li>`).join('')}</ul>` : '<p class="txt-ok">✓ All three readings are in.</p>'}`;
  }
  function addWater() {
    const d = doc();
    if (!d) return;
    if (!(d.rows || []).length) d.rows = [openingRow(d)];
    const r = L.blankRow('water', { name: 'Water', mode: 'is', time: L.clock() });
    const close = d.rows.findIndex((x, i) => i > 0 && x.fs != null && x.bs == null);
    if (close > 0) d.rows.splice(close, 0, r); else d.rows.push(r);
    d.water = Object.assign({}, d.water, { row: r.id, state: 'wet' });
    touch();
    editRow(r.id);
  }
  function waterNow(which) { const d = doc(); if (!d) return; d.water[which] = Object.assign({}, d.water[which], { time: L.clock() }); touch(); repaint(); }

  // ── 6. Check & send ────────────────────────────────────────────────────────

  function checkHtml(d, red) {
    const s = d.sync || {};
    const cov = L.coverage(d, red);
    const absentable = ['board', 'ctr', 'ctf'];
    return `
      <h3>✅ Check and send</h3>
      ${how(['Three totals must match: ΣBS − ΣFS, ΣRise − ΣFall, and the last level minus the first.',
             'Over the limit? Look for a booking slip, then re-read set-up by set-up before you leave. Still will not close: file it as failed, explain, and ring.',
             'Every required point levelled or noted as absent; descriptions a stranger could follow.'], 'check')}
      <div id="lv-live-check">${checkLiveHtml(d, red)}</div>
      <h4>Points not surveyed</h4>
      <p class="small">Say why a point every survey covers is not in this one, so nobody wonders whether it was forgotten.</p>
      <div class="form-grid">
        ${absentable.map(k => cov.find(c => c.key === k) && !(d.rows || []).some(r => r.kind === k)
          ? `<label>${esc(L.KINDS[k].label)} — why not <input value="${attr((d.absent || {})[k])}" oninput="LevelSurvey.set('absent.${k}', this.value)" placeholder="${k === 'board' ? 'No gauge boards at this site' : 'Not present'}"></label>` : '').join('')}
      </div>
      ${photosHtml(d.photos, 'site', 'Site overview photo')}
      <label class="check-label"><input type="checkbox"${d.photos_elsewhere ? ' checked' : ''} onchange="LevelSurvey.set('photos_elsewhere', this.checked)"> The photos were taken another way (a camera, the Field Camera tab) and go with the survey</label>
      ${red.closed && red.misclose != null && !red.within ? `<label class="lv-block">What was done about the misclose <textarea rows="2" oninput="LevelSurvey.set('outcome_note', this.value)">${esc(d.outcome_note || '')}</textarea></label>` : ''}
      <h4>Send and save</h4>
      ${d.practice ? '<p class="txt-warn">A practice survey stays on this device — it is never sent. Export it to see what a real one gives.</p>'
        : `<p>${syncChip(s)} ${s.note ? `<span class="small">${esc(s.note)}</span>` : ''}</p>
           <div class="button-row lv-big">
             ${signedIn() ? `<button type="button" class="primary" onclick="LevelSurvey.send()">${s.state === 'sent' ? '↻ Send again' : '📤 Send to Flood-Net'}</button>`
               : '<button type="button" class="primary" onclick="Auth.open()">🔑 Sign in to send</button>'}
           </div>
           <p class="small txt-muted">It goes when there is a signal — with its pictures — and is kept here until then. Sent, it is filed under its station for an administrator to review.</p>`}
      <div class="button-row">
        <button type="button" onclick="LevelSurvey.exportOpen('xlsx')">📊 Excel workbook</button>
        <button type="button" onclick="LevelSurvey.exportOpen('csv')">CSV</button>
        <button type="button" onclick="LevelSurvey.exportOpen('zip')">📦 Package (.zip, with photos)</button>
        <button type="button" onclick="LevelSurvey.exportOpen('json')">Survey file (.json)</button>
      </div>
      <p class="small txt-muted">The workbook opens in Excel, Google Sheets (File → Import) and Numbers. The survey file opens this survey on another device.</p>
      <div class="button-row"><button type="button" class="btn-danger" onclick="LevelSurvey.remove()">Remove from this phone</button></div>`;
  }
  function checkLiveHtml(d, red) {
    const test = d.peg_test && LevelStore.get('tests', d.peg_test.id);
    const items = L.review(d, red, test);
    const done = items.filter(x => x.ok).length;
    const stepFor = { closes: 'run', cp: 'run', datum: 'datum', points: 'run', descriptions: 'run', closure: 'run', water: 'water', kit: 'kit', pegtest: 'kit', team: 'kit', photos: 'check' };
    return `<p><strong>${done} of ${items.length}</strong> done.</p>
      <ul class="lv-review">${items.map(x => `<li class="${x.ok ? 'lv-ok' : 'lv-todo'}"><span aria-hidden="true">${x.ok ? '✓' : '○'}</span>
        <span><strong>${esc(x.label)}</strong>${x.detail ? `<br><span class="small">${esc(x.detail)}</span>` : ''}</span>
        ${x.ok || !stepFor[x.key] || stepFor[x.key] === 'check' ? '' : `<button type="button" class="link-btn" onclick="LevelSurvey.go('${stepFor[x.key]}')">Go</button>`}</li>`).join('')}</ul>
      ${red.problems.filter(p => p.level !== 'info').length ? `<details class="lv-problem-list"${red.errors ? ' open' : ''}><summary>${red.errors} error${red.errors === 1 ? '' : 's'}, ${red.warnings} to look at</summary>
        <ul>${red.problems.filter(p => p.level !== 'info').map(p => `<li class="txt-${p.level === 'error' ? 'bad' : 'warn'}">${p.row ? `<button type="button" class="link-btn" onclick="LevelSurvey.editRow('${escAttr(p.row)}')">${esc(p.text)}</button>` : esc(p.text)}</li>`).join('')}</ul></details>` : ''}`;
  }

  async function send() {
    const d = doc();
    if (!d || d.practice) return;
    await flush();
    const red = L.reduce(d);
    if (red.errors) {
      const ok = await confirmDialog({ title: 'Send it with errors in the run?',
        message: `The run has ${red.errors} error${red.errors === 1 ? '' : 's'} (see Check and send). A survey can be filed as it stands — say what was done in the notes — but an administrator will see them.`,
        confirm: 'Send it anyway' });
      if (!ok) return;
    }
    await LevelStore.queue('surveys', d.id);
    announce(navigator.onLine === false ? 'Kept to send — it goes when there is a signal.' : 'Sending.');
    repaint();
  }

  // ── Exports ────────────────────────────────────────────────────────────────

  function saveFile(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = floodnetName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function photoRows(d, red, list) {
    return list.map(e => {
      const i = (d.rows || []).findIndex(r => r.id === e.row_id);
      const r = i >= 0 ? d.rows[i] : null;
      return { file: `photos/${fileOf(e, d)}`, row: i >= 0 ? i + 1 : null, point: r ? (r.name || L.KINDS[r.kind].label) : e.field === 'overview' ? 'Site' : (d.bm.name || ''),
               what: e.kind === 'reading' ? `${FIELD_WORDS[e.field] || e.field} reading` : e.kind === 'label' ? 'Label' : 'Photo',
               value: e.value_m, ocr: e.ocr_text ? e.ocr_text.trim().replace(/\s+/g, ' ').slice(0, 120) : '',
               taken: e.taken_at ? e.taken_at.replace('T', ' ').slice(0, 16) : '', lat: e.lat, lon: e.lon };
    });
  }
  function fileOf(e, d) {
    const i = (d.rows || []).findIndex(r => r.id === e.row_id);
    const ext = e.type === 'image/webp' ? 'webp' : e.type === 'image/png' ? 'png' : 'jpg';
    return `${i >= 0 ? `row${String(i + 1).padStart(2, '0')}-` : ''}${e.field || e.kind}-${e.id.slice(0, 8)}.${ext}`;
  }
  async function exportDoc(d, kind, evidence) {
    const red = L.reduce(d);
    const stem = L.fileStem(d);
    const test = d.peg_test && LevelStore.get('tests', d.peg_test.id);
    const pics = evidence || LevelStore.evidenceOf(d.id);
    const plain = JSON.parse(JSON.stringify(d));
    delete plain.sync;
    if (kind === 'csv') { saveFile(`${stem}.csv`, L.surveyCsv(d, red), 'text/csv;charset=utf-8'); return `${stem}.csv`; }
    if (kind === 'json') { saveFile(`${stem}.json`, JSON.stringify(plain, null, 1), 'application/json'); return `${stem}.json`; }
    const sheets = L.workbook(d, red, { test, photos: photoRows(d, red, pics) });
    const xlsx = XlsxWrite.build(sheets, { title: L.title(d) });
    if (kind === 'xlsx') { saveFile(`${stem}.xlsx`, xlsx, XlsxWrite.MIME); return `${stem}.xlsx`; }
    // The package: everything a reviewer needs, in one file.
    const entries = [
      { name: `${stem}.xlsx`, data: xlsx },
      { name: `${stem}.csv`, data: L.surveyCsv(d, red) },
      { name: `${stem}.json`, data: JSON.stringify(plain, null, 1) },
    ];
    if (test) entries.push({ name: `${stem}-two-peg-test.csv`, data: L.testCsv(test) });
    let missing = 0;
    for (const e of pics) {
      const b = e._bytes || await LevelStore.bytesOf(e.id);
      if (b) entries.push({ name: `photos/${fileOf(e, d)}`, data: b }); else missing++;
    }
    entries.push({ name: 'README.txt', data: [
      `${L.title(d)}${d.practice ? ' — PRACTICE, not a record' : ''}`, '',
      `${stem}.xlsx   the survey as a workbook: details, the run with its sums and closure, the gauge boards, the checks, the photos`,
      `${stem}.csv    one row a sight, every column`,
      `${stem}.json   the survey itself — opens in Flood-Net's Level Survey tab on another device`,
      test ? `${stem}-two-peg-test.csv   the two-peg test linked to it` : '',
      `photos/        ${pics.length - missing} picture${pics.length - missing === 1 ? '' : 's'}: each reading's crop of the level's display, and the photos of the points${missing ? ` (${missing} not on this device)` : ''}`,
      '', `Written by Flood-Net ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    ].filter(x => x !== '').join('\r\n') });
    saveFile(`${stem}.zip`, zipStore(entries), 'application/zip');
    return `${stem}.zip`;
  }
  async function exportOpen(kind) {
    const d = view === 'server' && server && server.doc ? server.doc : doc();
    if (!d) { announce('Open a survey first.'); return; }
    await flush();
    try {
      let ev = null;
      if (view === 'server' && server) ev = await serverPictures();
      const name = await exportDoc(d, kind || 'xlsx', ev);
      announce(`Saved ${name}.`);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.failed(`It could not be exported: ${String((err && err.message) || err)}`);
    }
  }
  function openWhy() {
    return (view === 'server' && server && server.doc) || doc() ? '' : 'Open a survey first — on this tab, from the list.';
  }

  async function importFile(files) {
    const f = files && files[0];
    if (!f) return;
    let d;
    try { d = JSON.parse(await f.text()); } catch (_) { Toast.failed('That file is not a survey file (.json).'); return; }
    if (!d || d.type !== 'level-survey' || !Array.isArray(d.rows) || !L.isUuid(d.id)) { Toast.failed('That file is not a level survey from Flood-Net.'); return; }
    if (LevelStore.get('surveys', d.id)) {
      const ok = await confirmDialog({ title: 'This survey is on this phone already', message: 'Replace this phone\'s copy with the one in the file?', confirm: 'Replace it' });
      if (!ok) return;
    }
    d.sync = { state: 'draft', note: 'Opened from a file.' };
    await LevelStore.put('surveys', d, { touch: false });
    open(d.id);
    announce('Survey opened from the file.');
  }

  // ── A filed survey, read from Flood-Net ────────────────────────────────────

  async function openServer(id) {
    await flush();
    server = { id, loading: true };
    view = 'server';
    cur = null;
    repaint();
    try {
      const row = await LevelStore.serverSurvey(id);
      if (!row) throw new Error('it is not there any more');
      server.row = row;
      server.doc = row.doc;
      server.doc.id = row.id;
      const [ev, dec] = await Promise.all([LevelStore.serverEvidence(id).catch(() => []), LevelStore.decisions(id).catch(() => [])]);
      server.evidence = ev;
      server.decisions = dec;
      if (isAdmin() && row.station_id) server.control = await LevelStore.stationControl(row.station_id).catch(() => ({ points: [], offsets: [] }));
      server.urls = ev.length ? await LevelStore.signedUrls(ev.map(e => e.storage_path)).catch(() => ({})) : {};
    } catch (err) {
      server.error = String((err && err.message) || err);
    }
    server.loading = false;
    repaint();
  }
  async function serverPictures() {
    const out = [];
    for (const e of (server && server.evidence) || []) {
      const u = server.urls && server.urls[e.storage_path];
      let b = null;
      if (u) { try { const r = await fetch(u); if (r.ok) b = new Uint8Array(await r.arrayBuffer()); } catch (_) { b = null; } }
      out.push({ id: e.id, row_id: e.row_id, field: e.field, kind: e.kind, type: e.content_type, value_m: e.value_m == null ? null : Number(e.value_m),
                 ocr_text: e.ocr_text, taken_at: e.taken_at, lat: e.lat, lon: e.lon, _bytes: b });
    }
    return out;
  }

  function serverHtml() {
    const s = server || {};
    const back = '<button type="button" class="link-btn" onclick="LevelSurvey.home()">◀ All surveys</button>';
    if (s.loading) return `${back}<p class="txt-muted">Reading the survey from Flood-Net…</p>`;
    if (s.error) return `${back}<p class="txt-bad">It could not be read: ${esc(s.error)}</p>`;
    const d = s.doc, row = s.row;
    const red = L.reduce(d);
    const st = d.station || {};
    const mine = typeof Auth !== 'undefined' && Auth.email && Auth.email() === row.submitted_by;
    return `
      <div class="lv-top">${back}
        <h3 class="lv-title">${esc([st.number, st.name].filter(Boolean).join(' · '))} <span class="txt-muted">— ${esc(L.dmy(d.date))}</span></h3>
        <p><span class="lv-chip lv-chip-${row.status === 'applied' ? 'ok' : row.status === 'returned' ? 'warn' : ''}">${esc(row.status)}</span>
          ${closureChip(red)} <span class="small">filed by ${esc(row.submitted_by)} on ${esc(L.dmy(String(row.submitted_at).slice(0, 10)))}</span></p>
        ${row.decision_note ? `<p class="small">${row.status === 'returned' ? '<strong>Returned:</strong>' : 'Note:'} ${esc(row.decision_note)}</p>` : ''}
      </div>
      <section class="panel">${sheetHtml(d, red, s)}</section>
      <section class="panel"><h3>Export</h3><div class="button-row">
        <button type="button" onclick="LevelSurvey.exportOpen('xlsx')">📊 Excel workbook</button>
        <button type="button" onclick="LevelSurvey.exportOpen('csv')">CSV</button>
        <button type="button" onclick="LevelSurvey.exportOpen('zip')">📦 Package, with photos</button></div>
        ${mine && row.status === 'returned' ? `<p>Returned to you for completion. <button type="button" class="primary" onclick="LevelSurvey.takeBack()">Open it on this phone to finish it</button></p>` : ''}
      </section>
      ${isAdmin() ? decideHtml(d, red, s) : ''}
      ${(s.decisions || []).length ? `<section class="panel"><h3>Decisions</h3><ul class="lv-decisions">${s.decisions.map(x => `<li><strong>${esc(x.decision)}</strong> by ${esc(x.decided_by)} on ${esc(L.dmy(String(x.decided_at).slice(0, 10)))}${x.note ? ` — ${esc(x.note)}` : ''}
        ${(x.changes || []).length ? `<ul>${x.changes.map(c => `<li>${esc(c.key || c.kind)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></section>` : ''}`;
  }
  // The survey as one sheet, read only.
  function sheetHtml(d, red, s) {
    const ins = d.instrument || {};
    const wc = L.waterCheck(d, red);
    const pics = (s && s.evidence) || [];
    return `
      <dl class="lv-dl">
        <dt>Datum</dt><dd>${esc(L.DATUMS[d.datum] ? L.DATUMS[d.datum].long : d.datum)}</dd>
        <dt>Benchmark</dt><dd>${esc(d.bm.name || '')} — RL ${f3(L.num(d.bm.rl))} (${esc(d.bm.source || 'source not said')})</dd>
        <dt>Gauge zero</dt><dd>${d.datum === 'LGH' ? '0.000 (the datum)' : red.gaugeZero.rl == null ? 'not given' : `${f3(red.gaugeZero.rl)} m${red.gaugeZero.how === 'board' ? ', from the nominated board' : ''}`}</dd>
        <dt>Crew</dt><dd>${esc([d.operator, d.staff_holder].filter(Boolean).join(' and '))}${d.organisation ? `, ${esc(d.organisation)}` : ''}</dd>
        <dt>Level</dt><dd>${esc(L.kitLabel(ins))}${ins.service_date ? `, serviced ${esc(L.dmy(ins.service_date))}` : ''}</dd>
        <dt>Two-peg test</dt><dd>${d.peg_test ? `${esc(L.dmy(d.peg_test.date))}, error ${f3(d.peg_test.error_m)} m` : 'none linked'}</dd>
        <dt>Water check</dt><dd>${wc.state === 'dry' || wc.state === 'below' ? esc((d.water || {}).note || wc.state)
          : `surveyed ${f3(wc.surveyed)}, board ${f3(wc.board)}, logger ${f3(wc.logger)}${wc.loggerLessSurveyed != null ? ` (logger ${L.mm(wc.loggerLessSurveyed)})` : ''}`}</dd>
      </dl>
      ${tableHtml(d, red)}
      <p>${red.closed ? `Misclose ${L.signed(red.misclose)} m against ±${f3(red.tolerance)} m — ${red.within ? '<span class="txt-ok">pass</span>' : '<span class="txt-bad">fail</span>'}` : 'The run is not closed.'}
        ${red.checks.agree ? '· the three checks agree' : ''}</p>
      ${pics.length ? `<h4>Pictures</h4><div class="lv-thumbs lv-thumbs-wide">${pics.map(e => {
        const i = (d.rows || []).findIndex(r => r.id === e.row_id);
        return `<figure class="lv-ev"><img data-path="${attr(e.storage_path)}" alt="${e.kind === 'reading' ? 'A reading\'s picture' : 'A photo'}" loading="lazy">
          <figcaption class="small">${i >= 0 ? `Row ${i + 1} ` : ''}${esc(FIELD_WORDS[e.field] || e.field || e.kind)}${e.value_m != null ? ` · ${Number(e.value_m)} m` : ''}</figcaption></figure>`; }).join('')}</div>` : ''}`;
  }

  // An administrator's panel: what the survey would change at its station,
  // each ticked or not, and the decision.
  function decideHtml(d, red, s) {
    const row = s.row;
    if (!row.station_id) return '<section class="panel"><h3>Apply to the station</h3><p class="txt-warn">This survey is not filed under a station in Flood-Net, so there is nothing to apply it to.</p></section>';
    const stn = stationOf(row.station_id);
    const current = { gauge_survey: (stn && stn.gauge_survey) || [], points: (s.control && s.control.points) || [], offset: s.control && s.control.offsets && s.control.offsets[0] };
    const changes = L.stationChanges(d, red, current);
    s.changes = changes;
    const groups = [...new Set(changes.map(c => c.group))];
    const closed = row.status === 'returned';
    return `<section class="panel lv-decide"><h3>Apply to the station <span class="small txt-muted">— administrators</span></h3>
      <p class="small">What this survey found, beside what ${esc(stn ? stn.name : row.station_id)} holds now. Tick what the station takes;
        nothing changes until you apply. Each change is logged with what it replaced.</p>
      ${!red.closed || !red.within ? '<p class="txt-warn">The run did not close within its tolerance — nothing is ticked for you.</p>' : ''}
      ${groups.map(g => `<fieldset class="lv-changes"><legend>${esc(g)}</legend>${changes.filter(c => c.group === g).map((c, n) => {
        const i = changes.indexOf(c);
        return `<label class="lv-change"><input type="checkbox" data-change="${i}"${c.on ? ' checked' : ''}${closed ? ' disabled' : ''}>
          <span><strong>${esc(c.label)}</strong><br><span class="small">now: ${esc(c.from)}${c.same ? ' — the same' : ''}${c.why ? ` · ${esc(c.why)}` : ''}</span></span></label>
          ${c.key === 'offset' ? `<div class="form-grid lv-offset">
            <label>Correction (m) <input id="lv-off-corr" inputmode="decimal" value="${attr(c.value.correction_m)}"></label>
            <label>The offset after it (m, if known) <input id="lv-off-after" inputmode="decimal"></label>
            <label>Sensor <input id="lv-off-sensor" placeholder="Which sensor, if more than one"></label></div>` : ''}`; }).join('')}</fieldset>`).join('')}
      ${changes.length ? '' : '<p class="txt-muted">Nothing in this survey adds to what the station holds.</p>'}
      <label class="lv-block">Note <textarea id="lv-decide-note" rows="2" placeholder="Checked against…"></textarea></label>
      <div class="button-row">
        ${changes.length && !closed ? '<button type="button" class="primary" onclick="LevelSurvey.applyTicked()">Apply what is ticked</button>' : ''}
        ${row.status === 'submitted' ? '<button type="button" onclick="LevelSurvey.giveBack()">Return it for completion</button>' : ''}
      </div></section>`;
  }
  async function applyTicked() {
    const s = server;
    if (!s || !s.changes) return;
    const picked = [...document.querySelectorAll('#lv-root input[data-change]')].filter(x => x.checked).map(x => s.changes[Number(x.getAttribute('data-change'))]);
    if (!picked.length) { announce('Tick at least one change.'); return; }
    const out = picked.map(c => {
      if (c.key === 'gauge_zero') return { key: c.key, kind: 'gauge_zero', value: c.value };
      if (c.key === 'offset') {
        return { key: c.key, kind: 'offset', value: Object.assign({}, c.value, {
          correction_m: L.num(($('lv-off-corr') || {}).value) != null ? L.num($('lv-off-corr').value) : c.value.correction_m,
          offset_m: L.num(($('lv-off-after') || {}).value), sensor: (($('lv-off-sensor') || {}).value || '').trim() }) };
      }
      return { key: c.key, kind: 'point', value: c.value };
    });
    const ok = await confirmDialog({
      title: `Apply ${out.length} change${out.length === 1 ? '' : 's'} to the station?`,
      html: `<ul>${picked.map(c => `<li>${esc(c.label)}</li>`).join('')}</ul><p>Each is logged with what it replaced. The survey is then a record and no longer changes.</p>`,
      confirm: 'Apply them',
    });
    if (!ok) return;
    try {
      await LevelStore.apply(s.id, out, (($('lv-decide-note') || {}).value || '').trim());
      if (typeof Toast !== 'undefined') Toast.done('Applied to the station.');
      if (s.row.station_id) await refreshStation(s.row.station_id);
      lists = { mine: null, waiting: null, error: '' };
      await openServer(s.id);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.failed(err && err.details === 'administrator' ? 'Only an administrator applies a survey.' : `Not applied: ${String((err && err.message) || err)}`);
    }
  }
  async function giveBack() {
    const s = server;
    if (!s) return;
    const note = await promptDialog({ title: 'Return it for completion', label: 'What it needs before it can be used', confirm: 'Return it' });
    if (!note) return;
    try {
      await LevelStore.giveBack(s.id, note);
      if (typeof Toast !== 'undefined') Toast.done('Returned to its crew.');
      lists = { mine: null, waiting: null, error: '' };
      await openServer(s.id);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.failed(`Not returned: ${String((err && err.message) || err)}`);
    }
  }
  async function takeBack() {
    const s = server;
    if (!s || !s.doc) return;
    const d = JSON.parse(JSON.stringify(s.doc));
    d.sync = { state: 'draft', note: 'Returned for completion — finish it and send it again.', server: { status: 'returned' } };
    await LevelStore.put('surveys', d, { touch: false });
    server = null;
    open(d.id);
  }
  // The station as the database has it now — a new gauge zero shows at once.
  async function refreshStation(id) {
    try {
      const rows = await dbSelect(`station_json?id=eq.${encodeURIComponent(id)}&select=doc`);
      const fresh = rows && rows[0] && rows[0].doc;
      const list = stations();
      const i = list.findIndex(x => x.id === id);
      if (fresh && i >= 0) list[i] = fresh;
    } catch (_) { /* the next load has it */ }
  }

  // ── Position and the screen ────────────────────────────────────────────────

  function startGps() {
    if (watchId != null || typeof navigator === 'undefined' || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(p => {
      here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      const d = doc();
      if (d && !d.where) { d.where = Object.assign({}, here); touch(); }
      const el = $('lv-pos');
      if (el) el.innerHTML = posHtml(here);
    }, () => { watchId = null; }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function stopGps() {
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  // Kept awake while a survey is open: a level book that locks between sights
  // is a level book somebody stops using.
  function holdWake() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || wake || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(w => {
      if (!cur || !active()) { w.release(); return; }
      wake = w;
      w.addEventListener('release', () => { if (wake === w) wake = null; });
    }, () => {});
  }
  function releaseWake() { if (wake) wake.release().catch(() => {}); wake = null; }

  function teardown() {
    flush();
    stopGps();
    releaseWake();
  }

  // ── The tab ────────────────────────────────────────────────────────────────

  function init() {
    registerTabTeardown('LevelSurvey', teardown);
    LevelStore.boot();
    if (!unsub) {
      unsub = LevelStore.onChange(() => {
        if (!active()) return;
        if (view === 'list') repaint(); else paintLive();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
        else if (active() && cur) holdWake();
      });
    }
    LevelStore.ready().then(() => { if (active() && view === 'list') repaint(); });
    if (ocrReady == null) LevelCamera.readyOffline().then(v => { ocrReady = v === true ? true : v === false ? false : null; if (active() && view === 'list') repaint(); });
    if (cur) holdWake();
    hydrate();
  }
  function authChanged() {
    lists = { mine: null, waiting: null, error: '' };
    if (active()) repaint();
  }

  return {
    render, init, authChanged, repaint,
    start, practise, open, home, go, remove, set, setNum, setDatum,
    findStation, nearMe, pickStation, clearStation,
    kitAdd, kitCancel, kitRead, kitSave, useKit, linkPeg, unlinkPeg, pegNow, linkTest,
    useStationGz, useKnownBm, bmHere,
    addRow, editRow, doneRow, setRow, setMode, setKind, rowNow, startDesc, rowHere, moveRow, deleteRow, readInto,
    addPhoto, view: viewPicture, dropPicture, toggleTable,
    addWater, waterNow, send, exportOpen, openWhy, importFile, getReady, refreshLists,
    openServer, applyTicked, giveBack, takeBack,
    exportDoc,
  };
})();

if (typeof window !== 'undefined') window.LevelSurvey = LevelSurvey;
