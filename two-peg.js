// MegaNet — two-peg.js
//
//   TwoPeg   🎯 the Two-Peg Test tab: a level's line of sight checked the way
//            a crew does it in the field — two pegs, the level midway, then
//            close to one of them — with the error worked out as the four
//            readings go in, held to its tolerance, and what the level should
//            have read on the far peg if it is out. Kept on the phone like a
//            survey, sent to Flood-Net when there is a signal, linked to the
//            surveys done with that level.
//
// After core.js, levelling.js, xlsx-write.js, level-store.js and
// level-camera.js, before init.js — index.html holds the order. Reaches back
// to core.js for state, esc, escAttr, announce and floodnetName; to app.js for
// switchTab; to level-survey.js for LevelSurvey.linkTest (a test done from a
// survey goes back to it); to modal.js and toast.js. Nothing runs at load.
//
// Why a tab of its own: the test is done before a trip and after any knock,
// often at the depot, and it belongs to the level rather than to any one
// survey — a survey links the latest one for its level.

const TwoPeg = (function () {
  const TAB = 'twopeg';
  let cur = null;           // the test open on this device
  let forSurvey = null;     // the survey it was started from, to go back to
  let saveTimer = 0, unsub = null, filed = null, filedError = '', kitForm = null;

  const $ = id => document.getElementById(id);
  const L = Levelling;
  const doc = () => (cur ? LevelStore.get('tests', cur) : null);
  const active = () => typeof state !== 'undefined' && state.activeTab === TAB;
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const f3 = v => L.fmt(v, 3);
  const attr = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function touch() {
    const t = doc();
    if (!t) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { LevelStore.put('tests', t).catch(() => {}); }, 350);
    paintLive();
  }
  function flush() {
    const t = doc();
    if (!t || !saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = 0;
    return LevelStore.put('tests', t).catch(() => {});
  }
  function set(path, value, number) {
    const t = doc();
    if (!t) return;
    const keys = path.split('.');
    let o = t;
    for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = number ? L.num(value) : value;
    if (path === 'tester') LevelStore.setPrefs({ operator: value });
    if (path === 'organisation') LevelStore.setPrefs({ organisation: value });
    touch();
  }

  // ── The screen ─────────────────────────────────────────────────────────────

  function render() {
    return `<div class="page lv-page" style="--page-max:1000px"><h2 class="sr-only">Two-Peg Test</h2><div id="tp-root" class="stack">${body()}</div></div>`;
  }
  function body() { const t = doc(); return t ? testHtml(t) : listHtml(); }
  function repaint() {
    if (!active()) return;
    const el = $('tp-root');
    if (el) el.innerHTML = body();
    for (const img of document.querySelectorAll('#tp-root img[data-ev]')) {
      LevelStore.urlOf(img.getAttribute('data-ev')).then(u => { if (u) img.src = u; });
    }
  }
  function paintLive() {
    if (!active()) return;
    const t = doc();
    if (!t) return;
    const r = L.twoPeg(t);
    const put = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
    put('tp-live', liveHtml(t, r));
    put('tp-chip', resultChip(r));
    put('tp-diagrams', diagramsHtml(t, r));
  }

  function resultChip(r) {
    if (!r.ready) return '<span class="lv-chip">not finished</span>';
    return `<span class="lv-chip lv-chip-${r.pass ? 'ok' : 'bad'}">${r.pass ? '✓ pass' : '✗ fail'} · error ${f3(r.error)} m</span>`;
  }
  function syncChip(t) {
    const s = t.sync || {};
    const words = { draft: 'Not sent', waiting: 'Waiting to send', failed: 'Waiting for a signal', 'sign-in': 'Waiting for sign-in',
                    'not-ready': 'Kept here — Flood-Net is not ready for it', sending: 'Sending…', sent: 'In Flood-Net', refused: 'Not taken' };
    const kind = s.state === 'sent' ? 'ok' : s.state === 'refused' ? 'bad' : s.state && s.state !== 'draft' ? 'warn' : '';
    return `<span class="lv-chip${kind ? ` lv-chip-${kind}` : ''}">${esc(words[s.state || 'draft'] || 'Not sent')}</span>`;
  }

  function listHtml() {
    const tests = LevelStore.list('tests').sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (signedIn() && filed == null && !filedError) loadFiled();
    return `
      <section class="panel lv-hero">
        <h3>🎯 Two-peg test</h3>
        <p>Check a level's line of sight before a trip and after any knock: two pegs about 50 m apart, the
          level midway, then close to one of them. The error is worked out as the readings go in, against
          its tolerance, and a level that is out is told what it should have read.</p>
        <div class="lv-big"><button type="button" class="primary" onclick="TwoPeg.start()">＋ New test</button></div>
        <p class="small"><button type="button" class="link-btn" onclick="SurveyGuide.show('pegtest')">📖 How the test is done</button></p>
      </section>
      <section class="panel"><h3>On this device</h3>
        ${tests.length ? `<ul class="lv-cards">${tests.map(t => {
          const r = L.twoPeg(t);
          return `<li><button type="button" class="lv-card" onclick="TwoPeg.open('${escAttr(t.id)}')">
            <span class="lv-card-title">${esc(L.kitLabel(t.instrument) || 'Level not chosen')}</span>
            <span class="lv-card-sub">${esc(L.dmy(t.date))}${t.tester ? ` · ${esc(t.tester)}` : ''}</span>
            <span class="lv-card-chips">${t.practice ? '<span class="lv-chip lv-chip-warn">practice</span>' : syncChip(t)} ${resultChip(r)}</span>
          </button></li>`; }).join('')}</ul>` : '<p class="txt-muted">No tests on this phone yet.</p>'}
      </section>
      ${signedIn() ? `<section class="panel"><h3>In Flood-Net</h3>
        ${filedError ? `<p class="txt-warn">${esc(filedError)}</p>` : filed == null ? '<p class="txt-muted">Asking Flood-Net…</p>' : filed.length
          ? `<div class="table-wrap medium" role="region" aria-label="Filed two-peg tests" tabindex="0"><table><caption class="sr-only">Two-peg tests filed in Flood-Net</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Level</th><th scope="col">Error (m)</th><th scope="col">Result</th><th scope="col">Filed by</th></tr></thead>
              <tbody>${filed.map(x => `<tr><td>${esc(L.dmy(x.tested_on))}</td><td>${esc(L.kitLabel((x.doc && x.doc.instrument) || {}))}</td>
                <td>${f3(Number(x.error_m))}</td><td class="txt-${x.passed ? 'ok' : 'bad'}">${x.passed ? 'pass' : 'fail'}</td><td>${esc(x.submitted_by)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="txt-muted">No test filed yet.</p>'}</section>`
        : '<section class="panel"><p>Sign in to send tests to Flood-Net and see the ones filed. <button type="button" onclick="Auth.open()">🔑 Sign in</button></p></section>'}`;
  }
  async function loadFiled() {
    try { filed = await LevelStore.serverTests({ limit: 40 }); filedError = ''; }
    catch (err) {
      filed = [];
      filedError = LevelStore._isMissing(err) ? 'Flood-Net\'s database does not keep two-peg tests yet — they wait on this device.'
        : `Flood-Net did not answer (${String((err && err.message) || err)}).`;
    }
    if (!doc()) repaint();
  }

  // ── A test ─────────────────────────────────────────────────────────────────

  async function start(o = {}) {
    const p = LevelStore.prefs();
    const t = L.blankTest({ tester: o.tester || p.operator || '', organisation: o.organisation || p.organisation || '', practice: !!o.practice });
    const level = o.instrument && (o.instrument.serial || o.instrument.model) ? o.instrument : (p.level && LevelStore.get('kit', p.level));
    if (level) t.instrument = { id: level.id || null, make: level.make || '', model: level.model || '', serial: level.serial || '', service_date: level.service_date || '' };
    await LevelStore.put('tests', t);
    cur = t.id;
    repaint();
    return t;
  }
  // From a survey's Crew & kit step: a new test of its level, and back to it after.
  function startFor(o = {}) {
    forSurvey = o.surveyId || null;
    start(o);
  }
  function open(id) { if (LevelStore.get('tests', id)) { cur = id; repaint(); } }
  async function home() { await flush(); cur = null; forSurvey = null; repaint(); }

  function testHtml(t) {
    const r = L.twoPeg(t);
    const reading = (f, label) => `
      <div class="lv-sight">
        <label class="lv-sight-label" for="tp-${f}">${label} (m)</label>
        <div class="lv-sight-row">
          <input id="tp-${f}" class="lv-num" inputmode="decimal" autocomplete="off" value="${attr(t[f] == null ? '' : t[f])}" oninput="TwoPeg.set('${f}', this.value, true)">
          <button type="button" class="lv-cam" onclick="TwoPeg.readInto('${f}')" aria-label="Read ${label.toLowerCase()} off the display">📷</button>
        </div>
        ${(t.photos || []).filter(p => p.field === f).slice(-1).map(p => `<div class="lv-thumbs"><span class="lv-thumb"><img data-ev="${attr(p.id)}" alt="The picture this reading was taken from"></span></div>`).join('')}
      </div>`;
    const levels = LevelStore.kit('level');
    const ins = t.instrument || {};
    return `
      <div class="lv-top">
        <button type="button" class="link-btn" onclick="TwoPeg.home()">◀ All tests</button>
        <h3 class="lv-title">${esc(L.kitLabel(ins) || 'Two-peg test')} <span class="txt-muted">— ${esc(L.dmy(t.date))}</span>
          ${t.practice ? '<span class="lv-chip lv-chip-warn">practice</span>' : ''}</h3>
        <p><span id="tp-chip">${resultChip(r)}</span> ${t.practice ? '' : syncChip(t)}</p>
        ${forSurvey ? `<p class="small">For the survey you came from. <button type="button" class="primary" onclick="TwoPeg.backToSurvey()"${r.ready ? '' : ' disabled'}>Use it in the survey ▶</button></p>` : ''}
      </div>
      <section class="panel lv-step">
        <details class="lv-how"><summary>How the test is done</summary><ol>
          <li>Two pegs or firm marks roughly 50 m apart on fairly flat ground; measure the gap.</li>
          <li>Set up dead centre between them; read A, then B.</li>
          <li>Move up close to A (5 m or so); read A, then B again.</li>
          <li>A − B should come out the same both times; the mismatch is the error.</li>
          <li>Over the limit: the level is out of action until adjusted or serviced — then test again.</li>
        </ol><p><button type="button" class="link-btn" onclick="SurveyGuide.show('pegtest')">📖 More in the Survey Guide</button></p></details>
        <h4>The level</h4>
        <ul class="lv-kit">${levels.map(k => `<li><button type="button" class="lv-kit-btn" onclick="TwoPeg.useKit('${escAttr(k.id)}')" aria-pressed="${ins.id === k.id ? 'true' : 'false'}">
          <strong>${esc(L.kitLabel(k))}</strong>${k.service_date ? `<span class="small txt-muted"> serviced ${esc(L.dmy(k.service_date))}</span>` : ''}</button></li>`).join('')}</ul>
        ${kitForm ? `<div class="lv-kit-form"><div class="form-grid">
            <label>Make <input id="tp-kf-make" value="${attr(kitForm.make)}"></label><label>Model <input id="tp-kf-model" value="${attr(kitForm.model)}"></label>
            <label>Serial number <input id="tp-kf-serial" value="${attr(kitForm.serial)}" autocapitalize="characters"></label><label>Service date <input id="tp-kf-service" type="date" value="${attr(kitForm.service_date)}"></label></div>
            <div class="button-row"><button type="button" onclick="TwoPeg.kitRead()">📷 Read the plate</button><button type="button" class="primary" onclick="TwoPeg.kitSave()">Save the level</button>
            <button type="button" onclick="TwoPeg.kitCancel()">Cancel</button></div></div>`
          : '<button type="button" onclick="TwoPeg.kitAdd()">＋ Add a level</button>'}
        <div class="form-grid">
          <label>Test date <input type="date" value="${attr(t.date)}" onchange="TwoPeg.set('date', this.value)"></label>
          <label>Tester <input value="${attr(t.tester)}" oninput="TwoPeg.set('tester', this.value)" autocomplete="name"></label>
          <label class="full">Organisation <input value="${attr(t.organisation)}" oninput="TwoPeg.set('organisation', this.value)" autocomplete="organization"></label>
          <label>Peg spacing (m) <input inputmode="decimal" value="${attr(t.spacing == null ? '' : t.spacing)}" oninput="TwoPeg.set('spacing', this.value, true)"></label>
          <label>Set-up 2, from peg A (m) <input inputmode="decimal" value="${attr(t.near == null ? '' : t.near)}" oninput="TwoPeg.set('near', this.value, true)"></label>
          <label class="full">Where, and the conditions <input value="${attr(t.location)}" oninput="TwoPeg.set('location', this.value)" placeholder="Firm, level ground at the depot; overcast, no shimmer"></label>
        </div>
        <h4>Set-up 1 — midway between the pegs</h4>
        <div class="lv-sights lv-pair">${reading('a1', 'Reading on A')}${reading('b1', 'Reading on B')}</div>
        <h4>Set-up 2 — close to peg A</h4>
        <div class="lv-sights lv-pair">${reading('a2', 'Reading on A')}${reading('b2', 'Reading on B')}</div>
        <div id="tp-live" class="lv-live" aria-live="polite">${liveHtml(t, r)}</div>
        <div id="tp-diagrams" class="tp-diagrams">${diagramsHtml(t, r)}</div>
        <label class="lv-block">If it failed — what was done <textarea rows="2" oninput="TwoPeg.set('action', this.value)" placeholder="Taken out of use, sent for adjustment, tested again…">${esc(t.action || '')}</textarea></label>
        <details class="lv-limits"><summary>Tolerance</summary>
          <label>Largest error allowed (m) <input inputmode="decimal" value="${attr(t.tol)}" oninput="TwoPeg.set('tol', this.value, true)"></label></details>
        <h4>Send and save</h4>
        ${t.practice ? '<p class="txt-warn">A practice test stays on this device.</p>' : signedIn()
          ? `<div class="button-row"><button type="button" class="primary" onclick="TwoPeg.send()">${(t.sync || {}).state === 'sent' ? '↻ Send again' : '📤 Send to Flood-Net'}</button></div>`
          : '<div class="button-row"><button type="button" class="primary" onclick="Auth.open()">🔑 Sign in to send</button></div>'}
        ${(t.sync || {}).note ? `<p class="small">${esc(t.sync.note)}</p>` : ''}
        <div class="button-row">
          <button type="button" onclick="TwoPeg.exportOpen('xlsx')">📊 Excel</button>
          <button type="button" onclick="TwoPeg.exportOpen('csv')">CSV</button>
          <button type="button" class="btn-danger" onclick="TwoPeg.remove()">Remove from this phone</button>
        </div>
      </section>`;
  }

  function liveHtml(t, r) {
    const span = L.num(t.spacing) != null && L.num(t.near) != null ? L.num(t.spacing) - 2 * L.num(t.near) : null;
    const lines = [];
    lines.push(`<p>Difference 1 (A − B, midway): <strong>${r.d1 == null ? '—' : L.signed(r.d1)}</strong> m · Difference 2 (near A): <strong>${r.d2 == null ? '—' : L.signed(r.d2)}</strong> m</p>`);
    if (r.ready) {
      lines.push(`<p class="tp-verdict txt-${r.pass ? 'ok' : 'bad'}"><strong>${r.pass ? 'PASS' : 'FAIL'}</strong> — error ${f3(r.error)} m against ${f3(r.tol)} m.</p>`);
      if (r.per30 != null) {
        lines.push(`<p class="small">The line of sight ${r.tilt > 0 ? 'rises' : r.tilt < 0 ? 'falls' : 'neither rises nor falls'} by about ${L.fmt(Math.abs(r.per30) * 1000, 1)} mm over 30 m.
          ${!r.pass && r.bShould != null ? `Adjusted, the level would read <strong>${f3(r.bShould)}</strong> on B from set-up 2.` : ''}</p>`);
      }
      if (!r.pass) lines.push('<p class="small txt-warn">Take it out of use until it is adjusted or serviced, then test it again — and say what was done below.</p>');
    } else {
      lines.push('<p class="txt-muted">The four readings give the error.</p>');
    }
    if (span != null && span <= 0) lines.push('<p class="small txt-warn">Set-up 2 has to be nearer A than B — check the spacing and the distance.</p>');
    return lines.join('');
  }

  // The two set-ups, drawn: the pegs, the level, the readings, and the line of
  // sight tilted (much exaggerated) by what the test found.
  function diagram(n, a, b, tilt) {
    const W = 340, H = 150, gy = 118, ax = 34, bx = 306, top = 26;
    const ix = n === 1 ? (ax + bx) / 2 : ax + 30;
    const hy = 66;
    const k = Math.max(-0.12, Math.min(0.12, (tilt || 0) * 4000));      // exaggerated
    const yAt = x => hy - k * Math.abs(x - ix);
    const label = (x, v, side) => `<text x="${x + (side < 0 ? -6 : 6)}" y="${hy - 8}" text-anchor="${side < 0 ? 'end' : 'start'}" class="tp-num">${v == null ? '' : esc(f3(v))}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="tp-d${n}-t" class="tp-svg">
      <title id="tp-d${n}-t">Set-up ${n}: the level ${n === 1 ? 'midway between the pegs' : 'close to peg A'}, reading ${a == null ? '—' : f3(a)} on A and ${b == null ? '—' : f3(b)} on B</title>
      <line x1="10" y1="${gy}" x2="${W - 10}" y2="${gy}" class="tp-ground"/>
      <rect x="${ax - 3}" y="${top}" width="6" height="${gy - top}" class="tp-staff"/><text x="${ax}" y="${gy + 16}" text-anchor="middle" class="tp-lab">A</text>
      <rect x="${bx - 3}" y="${top}" width="6" height="${gy - top}" class="tp-staff"/><text x="${bx}" y="${gy + 16}" text-anchor="middle" class="tp-lab">B</text>
      <line x1="${ax}" y1="${hy}" x2="${bx}" y2="${hy}" class="tp-level"/>
      <line x1="${ix}" y1="${hy}" x2="${ax}" y2="${yAt(ax)}" class="tp-sight"/>
      <line x1="${ix}" y1="${hy}" x2="${bx}" y2="${yAt(bx)}" class="tp-sight"/>
      <rect x="${ix - 9}" y="${hy - 6}" width="18" height="10" rx="2" class="tp-inst"/>
      <line x1="${ix}" y1="${hy + 4}" x2="${ix - 10}" y2="${gy}" class="tp-leg"/><line x1="${ix}" y1="${hy + 4}" x2="${ix + 10}" y2="${gy}" class="tp-leg"/>
      ${label(ax, a, 1)}${label(bx, b, -1)}
    </svg>`;
  }
  function diagramsHtml(t, r) {
    return `<figure>${diagram(1, L.num(t.a1), L.num(t.b1), 0)}<figcaption class="small">Set-up 1, midway: equal sights, so a tilted line of sight errs the same on both — the difference is the true one.</figcaption></figure>
      <figure>${diagram(2, L.num(t.a2), L.num(t.b2), r.tilt)}<figcaption class="small">Set-up 2, close to A: unequal sights, so any tilt shows. Solid: level; dashed: the line of sight (tilt exaggerated).</figcaption></figure>`;
  }

  // ── Doing things ───────────────────────────────────────────────────────────

  async function readInto(field) {
    const t = doc();
    if (!t) return;
    await flush();
    const words = { a1: 'Set-up 1, peg A', b1: 'Set-up 1, peg B', a2: 'Set-up 2, peg A', b2: 'Set-up 2, peg B' };
    const got = await LevelCamera.read({ purpose: 'reading', expect: 'height', title: words[field], owner: 'two-peg', owner_id: t.id, field,
                                         caption: { what: `Two-peg test · ${words[field]}`, station: L.kitLabel(t.instrument) } });
    const t2 = doc();
    if (!got || !t2) { repaint(); return; }
    if (got.typed) { repaint(); const el = $(`tp-${field}`); if (el) el.focus(); return; }
    if (got.value != null) t2[field] = got.value;
    if (got.evidence) { t2.photos = t2.photos || []; t2.photos.push({ id: got.evidence.id, kind: 'reading', field }); }
    touch();
    repaint();
  }
  function useKit(id) {
    const t = doc(), k = LevelStore.get('kit', id);
    if (!t || !k) return;
    t.instrument = { id: k.id, make: k.make || '', model: k.model || '', serial: k.serial || '', service_date: k.service_date || '' };
    LevelStore.setPrefs({ level: id });
    LevelStore.usedKit(id);
    touch();
    repaint();
  }
  function kitAdd() { kitForm = { make: '', model: '', serial: '', service_date: '' }; repaint(); }
  function kitCancel() { kitForm = null; repaint(); }
  function kitFormRead() {
    if (!kitForm) return;
    for (const k of ['make', 'model', 'serial']) { const el = $(`tp-kf-${k}`); if (el) kitForm[k] = el.value.trim(); }
    const s = $('tp-kf-service'); if (s) kitForm.service_date = s.value;
  }
  async function kitRead() {
    kitFormRead();
    const got = await LevelCamera.read({ purpose: 'label', title: 'The level\'s plate', owner: 'kit', caption: { what: 'level plate' } });
    if (got && got.label) for (const k of ['make', 'model', 'serial']) if (got.label[k]) kitForm[k] = got.label[k];
    repaint();
  }
  async function kitSave() {
    kitFormRead();
    if (!kitForm.make && !kitForm.model && !kitForm.serial) { announce('Give it a make, a model or a serial number.'); return; }
    const k = await LevelStore.saveKit(Object.assign({ kind: 'level' }, kitForm));
    kitForm = null;
    useKit(k.id);
  }
  async function send() {
    const t = doc();
    if (!t || t.practice) return;
    await flush();
    await LevelStore.queue('tests', t.id);
    announce(navigator.onLine === false ? 'Kept to send — it goes when there is a signal.' : 'Sending.');
    repaint();
  }
  async function remove() {
    const t = doc();
    if (!t) return;
    const sent = (t.sync || {}).state === 'sent';
    const ok = await confirmDialog({ title: 'Remove this test from this phone?',
      message: sent ? 'Flood-Net keeps it. Only this phone\'s copy goes.' : 'It has not been sent — removing it loses it.', confirm: 'Remove it', danger: !sent });
    if (!ok) return;
    await LevelStore.remove('tests', t.id);
    cur = null;
    repaint();
  }
  async function backToSurvey() {
    const t = doc();
    if (!t || !forSurvey) return;
    await flush();
    const id = forSurvey;
    forSurvey = null;
    cur = null;
    if (typeof LevelSurvey !== 'undefined') await LevelSurvey.linkTest(id, t.id);
    switchTab('levels');
  }
  function save(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = floodnetName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportOpen(kind) {
    const t = doc();
    if (!t) { announce('Open a test first.'); return; }
    await flush();
    const stem = L.fileStem({ station: { number: (t.instrument && (t.instrument.serial || t.instrument.model)) || 'level' }, date: t.date, practice: t.practice }, 'two-peg-test');
    if (kind === 'csv') save(`${stem}.csv`, L.testCsv(t), 'text/csv;charset=utf-8');
    else save(`${stem}.xlsx`, XlsxWrite.build([L.testSheet(t)], { title: `Two-peg test ${L.dmy(t.date)}` }), XlsxWrite.MIME);
    announce(`Saved ${stem}.${kind === 'csv' ? 'csv' : 'xlsx'}.`);
  }
  function openWhy() { return doc() ? '' : 'Open a test first — on this tab, from the list.'; }

  function init() {
    registerTabTeardown('TwoPeg', () => { flush(); });
    LevelStore.boot();
    if (!unsub) unsub = LevelStore.onChange(() => { if (!active()) return; if (doc()) paintLive(); else repaint(); });
    LevelStore.ready().then(() => { if (active() && !doc()) repaint(); });
  }
  function authChanged() { filed = null; filedError = ''; if (active()) repaint(); }

  return { render, init, authChanged, start, startFor, open, home, set, readInto, useKit, kitAdd, kitCancel, kitRead, kitSave,
           send, remove, backToSurvey, exportOpen, openWhy, diagram };
})();

if (typeof window !== 'undefined') window.TwoPeg = TwoPeg;
