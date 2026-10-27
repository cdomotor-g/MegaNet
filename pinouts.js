// MegaNet — pinouts.js
//
//   Pinouts   🪛 the Pinouts tab, in the Knowledge base: a library of the
//             connectors a site visit meets — RS-232 on a DE-9 or a DB-25,
//             the ALERT stations and their radios, the loggers and modems, the
//             sensors and the solar charger — each drawn as its face with the
//             pins numbered where they really sit, and its table beside it.
//             Pick a pin on either and the other follows. The face turns over
//             (front or the wire side) and changes sex (the unit's own, or the
//             plug that mates with it), because "which pin is 1?" is the whole
//             question at a gate. Then the cables made of them, drawn wire by
//             wire with a tick box each for buzzing one out; a 4–20 mA
//             calculator that scales a current and checks the loop has the
//             voltage to drive it; the RF connectors told apart; and how to
//             read a pinout without getting it backwards.
//
// After core.js (esc, escAttr, announce, dlText) and pinout-data.js, which
// holds every pinout and says where each came from; app.js's switchTab is read
// at call time. Nothing runs at load.
//
// Nothing here is a record: the tab keeps the connector and cable last looked
// at on this device (KEY), and the cable's tick boxes only while it is open.

const Pinouts = (function () {
  const TAB = 'pinouts';
  const KEY = 'mn-pinouts';
  const D = () => PinoutData;
  const U = 30;                       // one pin pitch, in drawing units

  const S = {
    id: 'rs232-de9-dte', mate: false, back: false, pin: null,
    q: '', cat: 'all',
    cable: 'null-3', wire: null, ticks: {},
    loop: { lo: '0', hi: '10', unit: 'm', ma: '12', val: '', v: '', ohms: '100', wire: '40', supply: '12', vmin: '9', fault: '24', mode: 'passive', preset: 'cr300' },
    pending: null,
  };

  // ── Plumbing ───────────────────────────────────────────────────────────────

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && D().byId(o.id)) S.id = o.id;
      if (o && D().cableById(o.cable)) S.cable = o.cable;
    } catch (_) { /* private mode, or nothing kept */ }
  }
  function keep() {
    try { localStorage.setItem(KEY, JSON.stringify({ id: S.id, cable: S.cable })); } catch (_) { /* private mode */ }
  }
  const $ = id => document.getElementById(id);
  const conn = () => D().byId(S.id) || D().CONNECTORS[0];
  const flips = c => c.face.type === 'dsub' || c.face.type === 'circular';
  const other = g => (g === 'M' ? 'F' : g === 'F' ? 'M' : '');
  const shown = c => (S.mate && flips(c) ? other(c.gender) : c.gender);
  const sexWord = g => (g === 'M' ? 'male (pins)' : g === 'F' ? 'female (sockets)' : '');
  const dirWord = { out: 'Out of the unit', in: 'Into the unit', both: 'Both ways', '': '—' };
  const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
  const fmt = (v, dp) => (Number.isFinite(v) ? (Math.abs(v) < 1e-9 ? 0 : v).toFixed(dp) : '—');

  const lab = p => p.t || p.n;
  const word = c => (c.face.type === 'strip' ? 'Terminal' : 'Pin');

  function pinSay(c, p) {
    if (!p) return `Pick a ${word(c).toLowerCase()} on the drawing or in the table.`;
    const kind = D().KINDS[p.kind] || '';
    const where = p.dir ? ` · ${dirWord[p.dir].toLowerCase()}` : '';
    return `${word(c)} ${lab(p)} — ${p.sig}${where}. ${p.what}${p.wire ? ` Wire: ${p.wire}.` : ''}${kind && p.kind !== 'nc' ? ` (${kind}.)` : ''}`;
  }

  // ── Drawing a face ─────────────────────────────────────────────────────────

  // A polygon with its corners rounded by r.
  function rounded(pts, r) {
    const n = pts.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      const a = [p1[0] + v1[0] / l1 * r, p1[1] + v1[1] / l1 * r];
      const b = [p1[0] + v2[0] / l2 * r, p1[1] + v2[1] / l2 * r];
      d += `${i ? 'L' : 'M'}${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
    }
    return d + 'Z';
  }

  // One pin, socket or terminal. `live` makes it a control.
  function pinMark(c, p, x, y, sex, live, shape) {
    const sel = live && S.pin === p.n;
    const kind = `po-k-${p.kind}`;
    const label = `${word(c)} ${lab(p)}: ${p.sig}${p.dir ? `, ${dirWord[p.dir].toLowerCase()}` : ''}`;
    const attrs = live
      ? ` data-pin="${escAttr(p.n)}" role="button" tabindex="${sel || (!S.pin && p === c.pins[0]) ? 0 : -1}" aria-pressed="${sel}" aria-label="${escAttr(label)}"
          onclick="Pinouts.pin('${escAttr(p.n)}')" onkeydown="Pinouts.key(event, '${escAttr(p.n)}')"`
      : ' aria-hidden="true"';
    const txt = lab(p).length > 3 ? lab(p).slice(0, 4) : lab(p);
    let body;
    if (shape === 'terminal') {
      const w = shape === 'terminal' ? x.w : 0;
      body = `<rect class="po-term" x="${(x.x - w / 2).toFixed(1)}" y="${(y - 26).toFixed(1)}" width="${w.toFixed(1)}" height="52" rx="4"/>
        <circle class="po-screw" cx="${x.x.toFixed(1)}" cy="${(y - 10).toFixed(1)}" r="8"/><path class="po-slot" d="M${(x.x - 4.5).toFixed(1)} ${(y - 10).toFixed(1)}h9M${x.x.toFixed(1)} ${(y - 14.5).toFixed(1)}v9"/>
        <text class="po-tlabel" x="${x.x.toFixed(1)}" y="${(y + 16).toFixed(1)}" text-anchor="middle">${esc(lab(p))}</text>`;
      return `<g class="po-pin po-pin--term ${kind}${sel ? ' is-sel' : ''}"${attrs}><title>${esc(label)}</title>${body}</g>`;
    }
    if (shape === 'pad') {
      body = `<rect class="po-pad" x="${(x - 11).toFixed(1)}" y="${(y - 11).toFixed(1)}" width="22" height="22" rx="3"/>
        <text class="po-plabel" x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle">${esc(txt)}</text>`;
    } else if (sex === 'F') {
      body = `<circle class="po-sock" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"/>
        <text class="po-slabel" x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle">${esc(txt)}</text>`;
    } else {
      body = `<circle class="po-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"/>
        <text class="po-plabel" x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle">${esc(txt)}</text>`;
    }
    const halo = `<circle class="po-halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="15"/>`;
    return `<g class="po-pin ${kind}${sel ? ' is-sel' : ''}"${attrs}><title>${esc(label)}</title>${halo}${body}</g>`;
  }

  // The face of a connector, as an SVG. opts: { gender, back, live, mini, id }.
  function faceSvg(c, opts = {}) {
    const gender = opts.gender != null ? opts.gender : shown(c);
    const back = !!opts.back;
    const L = D().layout(c, gender, back);
    const live = !!opts.live;
    const pins = Object.fromEntries(c.pins.map(p => [p.n, p]));
    const parts = [];
    let w, h;
    if (L.type === 'dsub') {
      const n1 = D().DSUB[c.face.shell][0];
      const top = ((n1 - 1) / 2 + 0.95) * U, hh = 1.3 * U, bot = top - 2 * hh * Math.tan(10 * Math.PI / 180);
      const fw = top + 2.1 * U, fh = 2.05 * U;
      parts.push(`<rect class="po-flange" x="${-fw}" y="${-fh}" width="${2 * fw}" height="${2 * fh}" rx="8"/>`);
      [-1, 1].forEach(s => parts.push(`<circle class="po-hole" cx="${s * (top + 1.2 * U)}" cy="0" r="${0.42 * U}"/>`));
      parts.push(`<path class="po-shell${gender === 'F' ? ' po-shell--f' : ''}" d="${rounded([[-top, -hh], [top, -hh], [bot, hh], [-bot, hh]], 0.5 * U)}"/>`);
      L.pts.forEach(pt => parts.push(pinMark(c, pins[pt.n], pt.x * U, pt.y * U, gender, live)));
      w = 2 * fw + 8; h = 2 * fh + 8;
    } else if (L.type === 'circular') {
      const R = 3.3 * U;
      parts.push(`<circle class="po-flange" cx="0" cy="0" r="${R + 0.9 * U}"/>`);
      parts.push(`<circle class="po-shell${gender === 'F' ? ' po-shell--f' : ''}" cx="0" cy="0" r="${R}"/>`);
      parts.push(`<rect class="po-key" x="${-0.32 * U}" y="${-R - 0.55 * U}" width="${0.64 * U}" height="${0.9 * U}" rx="3"/>`);
      L.pts.forEach(pt => parts.push(pinMark(c, pins[pt.n], pt.x * R, pt.y * R, gender, live)));
      w = h = 2 * (R + 0.9 * U) + 8;
    } else if (L.type === 'header') {
      const n = L.pts.length, x0 = -(n - 1) / 2 * U;
      parts.push(`<rect class="po-flange" x="${x0 - 0.9 * U}" y="${-0.95 * U}" width="${(n - 1) * U + 1.8 * U}" height="${1.9 * U}" rx="4"/>`);
      parts.push(`<rect class="po-key" x="${-0.6 * U}" y="${-1.25 * U}" width="${1.2 * U}" height="${0.42 * U}" rx="2"/>`);
      L.pts.forEach((pt, i) => parts.push(pinMark(c, pins[pt.n], x0 + i * U, 0, gender, live, 'pad')));
      w = (n - 1) * U + 1.8 * U + 8; h = 2.6 * U;
    } else {
      // A terminal strip: one row up to a dozen, else wrapped at eight — or at
      // the unit's own blocks.
      const per = c.face.per || (L.pts.length <= 12 ? L.pts.length : 8), tw = Math.max(44, Math.min(96, 14 + 7.4 * Math.max(...c.pins.map(p => lab(p).length))));
      const rows = Math.ceil(L.pts.length / per), cols = Math.min(per, L.pts.length);
      const x0 = -(cols - 1) / 2 * (tw + 4);
      L.pts.forEach((pt, i) => {
        const r = Math.floor(i / per), k = i % per;
        parts.push(pinMark(c, pins[pt.n], { x: x0 + k * (tw + 4), w: tw }, -((rows - 1) * 33) + r * 66, gender, live, 'terminal'));
      });
      w = cols * (tw + 4) + 12; h = rows * 66 + 4;
    }
    const vb = `${(-w / 2).toFixed(1)} ${(-h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
    if (opts.mini) return `<svg class="po-mini" viewBox="${vb}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
    const side = flips(c) ? `${back ? 'from the back, where the wires go in' : 'from the front, the face that mates'}` : 'as printed on the unit';
    const title = `${c.short}: the ${sexWord(gender) || 'terminals'} ${side}`;
    return `<svg class="po-face" id="${opts.id || 'po-face'}" viewBox="${vb}" role="group" aria-label="${escAttr(title)}">
      <title>${esc(title)}</title>${parts.join('')}</svg>`;
  }

  // What to look for on the face as drawn: where pin 1 is on a D-sub, which
  // way the letters run round a circular insert.
  function faceNote(c, g, back) {
    const m = D().mirrored(g, back);
    if (c.face.type === 'dsub') return `${m ? 'Pin 1 is top right' : 'Pin 1 is top left'} this way round — the numbers are moulded beside the pins, tiny.`;
    if (c.face.type === 'circular') return `The key at the top; the letters run ${m ? 'anticlockwise' : 'clockwise'} this way round. They are moulded beside each contact.`;
    return '';
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    load();
    const toc = [['po-lib', 'The library'], ['po-view', 'The connector'], ['po-cables', 'Cables and adapters'],
      ['po-loop', '4–20 mA loops'], ['po-rf', 'RF connectors'], ['po-read', 'Reading a pinout']];
    return `<div class="page po-page" id="po-page"><h2 class="sr-only">Pinouts</h2><div class="stack">
      <section class="panel po-hero" aria-labelledby="po-title">
        <h3 id="po-title" class="po-title">🪛 Pinouts</h3>
        <p class="po-lede">Every connector a site visit meets, drawn pin by pin: RS-232 on a DE-9 or a DB-25, the ALERT stations and
          their radios, the loggers and modems, the sensors and the solar charger. Pick a pin on the drawing or in the table and the
          other follows; turn the face over, or show the plug that mates with it.</p>
        <p class="po-caution" role="note"><strong>Check before you wire.</strong> Each pinout says where it came from and how sure it is.
          A unit's own label, or its manual, beats anything here — and power goes on last, after a meter has checked the pins.</p>
        <nav aria-label="On this page"><ul class="po-toc">${toc.map(([id, t]) =>
          `<li><button type="button" class="link-btn" onclick="Pinouts.go('${id}')">${esc(t)}</button></li>`).join('')}</ul></nav>
      </section>
      <section class="panel" id="po-lib" aria-labelledby="po-lib-h">
        <h3 id="po-lib-h">The library</h3>
        <div class="po-find">
          <label for="po-q">Find a connector, a unit or a signal</label>
          <input id="po-q" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. DB9, HS40, PTT, SDI-12"
            value="${escAttr(S.q)}" oninput="Pinouts.find(this.value)">
        </div>
        <div class="po-cats" role="group" aria-label="Show which connectors">${catsHtml()}</div>
        <div id="po-list">${listHtml()}</div>
      </section>
      <section class="panel" id="po-view" aria-labelledby="po-view-h">${viewHtml()}</section>
      <section class="panel" id="po-cables" aria-labelledby="po-cables-h">${cablesHtml()}</section>
      <section class="panel" id="po-loop" aria-labelledby="po-loop-h">${loopHtml()}</section>
      <section class="panel" id="po-rf" aria-labelledby="po-rf-h">${rfHtml()}</section>
      <section class="panel" id="po-read" aria-labelledby="po-read-h">${readHtml()}</section>
    </div></div>`;
  }

  // ── The library list ───────────────────────────────────────────────────────

  function matches(c) {
    if (S.cat !== 'all' && c.cat !== S.cat) return false;
    const terms = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = [c.name, c.short, c.unit, c.find, ...c.pins.map(p => `${p.n} ${p.sig}`)].join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  }

  function catsHtml() {
    return [['all', 'All']].concat(D().CATS).map(([k, t]) =>
      `<button type="button" class="po-chip" aria-pressed="${S.cat === k}" onclick="Pinouts.cat('${k}')">${esc(t)}</button>`).join('');
  }

  function listHtml() {
    const hits = D().CONNECTORS.filter(matches);
    if (!hits.length) return `<p class="po-none">No connector matches “${esc(S.q)}”. Try the unit's maker, a signal name (TXD, PTT) or a
      connector (DE-9, MIL).</p>`;
    return D().CATS.map(([k, t]) => {
      const list = hits.filter(c => c.cat === k);
      if (!list.length) return '';
      return `<h4 class="po-cat-h">${esc(t)}</h4><ul class="po-cards">${list.map(c => `<li>
        <button type="button" class="po-card" aria-pressed="${c.id === S.id}" onclick="Pinouts.pick('${c.id}')">
          ${faceSvg(c, { gender: c.gender, mini: true })}
          <span class="po-card-name">${esc(c.short)}</span>
          <span class="po-card-unit">${esc(c.unit)}</span>
          <span class="po-sure po-sure--${c.sure}">${esc(D().SURE[c.sure].short)}</span>
        </button></li>`).join('')}</ul>`;
    }).join('');
  }

  // ── The connector ──────────────────────────────────────────────────────────

  function viewHtml() {
    const c = conn(), sure = D().SURE[c.sure];
    const g = shown(c);
    const kinds = [...new Set(c.pins.map(p => p.kind))];
    const toggles = flips(c) ? `<div class="po-toggles">
        <fieldset class="po-seg"><legend>Show</legend>
          <label><input type="radio" name="po-mate" value="unit" ${S.mate ? '' : 'checked'} onchange="Pinouts.mate(false)"> On the unit: ${esc(sexWord(c.gender))}</label>
          <label><input type="radio" name="po-mate" value="plug" ${S.mate ? 'checked' : ''} onchange="Pinouts.mate(true)"> What plugs in: ${esc(sexWord(other(c.gender)))}</label>
        </fieldset>
        <fieldset class="po-seg"><legend>Seen from</legend>
          <label><input type="radio" name="po-back" value="front" ${S.back ? '' : 'checked'} onchange="Pinouts.side(false)"> The front (mating face)</label>
          <label><input type="radio" name="po-back" value="back" ${S.back ? 'checked' : ''} onchange="Pinouts.side(true)"> The back (wire side)</label>
        </fieldset></div>` : '';
    const one = faceNote(c, g, S.back);
    const sp = c.pins.find(p => p.n === S.pin) || null;
    return `<h3 id="po-view-h">${esc(c.name)}</h3>
      <p class="po-unit">${esc(c.unit)}${c.face.insert ? `${/[.)]$/.test(c.unit) ? '' : '.'} <span class="po-insert">Insert: ${esc(c.face.insert)}.</span>` : ''}</p>
      <p class="po-sure-line"><span class="po-sure po-sure--${c.sure}">${esc(sure.label)}</span> <span class="small">${esc(sure.blurb)}</span></p>
      ${c.warn ? `<p class="po-caution" role="note">${c.warn}</p>` : ''}
      <div class="po-view-grid">
        <figure class="po-fig">
          ${toggles}
          <div id="po-face-wrap">${faceSvg(c, { gender: g, back: S.back, live: true })}</div>
          <figcaption class="small">${esc(one)}${one ? ' ' : ''}Arrow keys move between pins.</figcaption>
          <p class="po-say" id="po-say" aria-live="polite">${esc(pinSay(c, sp))}</p>
        </figure>
        <ul class="po-legend" aria-label="Colours">${kinds.map(k => `<li><span class="po-swatch po-k-${k}" aria-hidden="true"></span>${esc(D().KINDS[k])}</li>`).join('')}</ul>
      </div>
      ${tableHtml(c)}
      ${c.notes && c.notes.length ? `<h4>Good to know</h4><ul class="po-notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <h4>Where this comes from</h4>
      ${c.sources && c.sources.length ? `<ul class="po-src">${c.sources.map(s => `<li><a href="${escAttr(s.href)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul>`
        : '<p class="small">No document — this is how the kind of device works. Confirm against the unit\'s own label.</p>'}
      <div class="button-row"><button type="button" onclick="Pinouts.exportCsv('one')">⤓ This connector — CSV</button>
        <button type="button" onclick="Pinouts.exportCsv('all')">⤓ Every connector — CSV</button></div>`;
  }

  function tableHtml(c) {
    const long = c.pins.length > 15;
    const rows = c.pins.filter(p => !(long && p.kind === 'nc'));
    const unused = long ? c.pins.filter(p => p.kind === 'nc').map(p => p.n) : [];
    const hasWire = c.pins.some(p => p.wire);
    return `<div class="table-wrap" role="region" aria-label="${escAttr(`The pins of ${c.short}`)}" tabindex="0"><table class="po-table">
      <caption class="sr-only">${esc(c.name)}: each pin, its signal, which way it goes and what it does</caption>
      <thead><tr><th scope="col">${word(c)}</th><th scope="col">Signal</th><th scope="col">Direction</th><th scope="col">What it does</th>${hasWire ? '<th scope="col">Wire</th>' : ''}</tr></thead>
      <tbody>${rows.map(p => `<tr class="po-row${S.pin === p.n ? ' is-sel' : ''}" data-row="${escAttr(p.n)}">
        <th scope="row"><button type="button" class="po-pin-btn po-k-${p.kind}" aria-pressed="${S.pin === p.n}" onclick="Pinouts.pin('${escAttr(p.n)}')"
          aria-label="${escAttr(`${word(c)} ${lab(p)}`)}">${esc(lab(p))}</button></th>
        <td><strong>${esc(p.sig)}</strong></td><td>${esc(dirWord[p.dir])}</td><td>${esc(p.what)}</td>${hasWire ? `<td>${esc(p.wire)}</td>` : ''}</tr>`).join('')}
      ${unused.length ? `<tr><th scope="row">${esc(runs(unused))}</th><td>—</td><td>—</td><td>Not used by this interface.</td>${hasWire ? '<td></td>' : ''}</tr>` : ''}</tbody>
    </table></div>`;
  }

  // "9, 10, 11, 12, 21" → "9–12, 21"
  function runs(ns) {
    const v = ns.map(Number);
    const out = [];
    for (let i = 0; i < v.length; i++) {
      let j = i;
      while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
      out.push(j > i ? `${v[i]}–${v[j]}` : `${v[i]}`);
      i = j;
    }
    return out.join(', ');
  }

  // ── Cables ─────────────────────────────────────────────────────────────────

  function cablesHtml() {
    return `<h3 id="po-cables-h">Cables and adapters</h3>
      <p>Each cable drawn wire by wire, with the signal at either end. Tick each wire as your meter beeps it out — a cable that
        passes every row is wired right; one wire short of the list is the fault.</p>
      <div class="po-cable-pick" role="group" aria-label="Pick a cable">${D().CABLES.map(k =>
        `<button type="button" class="po-chip" aria-pressed="${k.id === S.cable}" onclick="Pinouts.cable('${k.id}')">${esc(k.name)}</button>`).join('')}</div>
      <div id="po-cable">${cableHtml()}</div>`;
  }

  // The pins one end of a cable shows: every pin of a short connector, so an
  // unused one is seen to be unused; only the wired ones of a long one, or of
  // an end that spans two connectors.
  function endRows(end, refs) {
    const list = D().endConns(end);
    const used = new Set(refs.map(r => (D().endPin(end, r) || {}).key).filter(Boolean));
    if (list.length === 1 && list[0].pins.length <= 12) {
      return list[0].pins.map(p => ({ key: p.n, p, used: used.has(p.n) }));
    }
    const seen = new Set();
    return refs.map(r => D().endPin(end, r)).filter(x => x && !seen.has(x.key) && seen.add(x.key)).map(x => ({ key: x.key, p: x.p, used: true }));
  }
  const endWord = e => (e.gender ? sexWord(e.gender) : 'terminals');

  // The wiring drawn: end A's pins down the left, end B's down the right.
  function cableSvg(k) {
    const loops = k.loops || {};
    const ra = endRows(k.a, [...k.wires.map(w => w[0]), ...(loops.a || []).flat()]);
    const rb = k.b ? endRows(k.b, [...k.wires.map(w => w[1]), ...(loops.b || []).flat()]) : [];
    const rowH = 30, bw = 150, gap = k.b ? 200 : 120, top = 42;
    const n = Math.max(ra.length, rb.length);
    const W = bw * (k.b ? 2 : 1) + gap + 40, H = top + n * rowH + 16;
    const xa = 20, xb = xa + bw + gap;
    const ya = new Map(ra.map((r, i) => [r.key, top + i * rowH + rowH / 2]));
    const yb = new Map(rb.map((r, i) => [r.key, top + i * rowH + rowH / 2]));
    const box = (r, x, y, side) => `<g class="po-cpin po-k-${r.p.kind}${r.used ? '' : ' is-idle'}">
        <rect x="${x}" y="${y - 12}" width="${bw}" height="24" rx="4"/>
        <text class="po-cpin-n" x="${side === 'a' ? x + bw - 8 : x + 8}" y="${y + 4.5}" text-anchor="${side === 'a' ? 'end' : 'start'}">${esc(lab(r.p))}</text>
        <text class="po-cpin-s" x="${side === 'a' ? x + 8 : x + bw - 8}" y="${y + 4.5}" text-anchor="${side === 'a' ? 'start' : 'end'}">${esc(r.p.sig.length > 15 ? r.p.sig.slice(0, 14) + '…' : r.p.sig)}</text></g>`;
    const parts = [];
    parts.push(`<text class="po-cend" x="${xa}" y="18">${esc(`A · ${endWord(k.a)}`)}</text><text class="po-cend-sub" x="${xa}" y="32">${esc(k.a.label)}</text>`);
    if (k.b) parts.push(`<text class="po-cend" x="${xb}" y="18">${esc(`B · ${endWord(k.b)}`)}</text><text class="po-cend-sub" x="${xb}" y="32">${esc(k.b.label)}</text>`);
    k.wires.forEach((w, i) => {
      const a = D().endPin(k.a, w[0]), b = D().endPin(k.b, w[1]);
      if (!a || !b) return;
      const y1 = ya.get(a.key), y2 = yb.get(b.key);
      const x1 = xa + bw, x2 = xb, mx = (x1 + x2) / 2;
      parts.push(`<path class="po-wire po-k-${a.p.kind}${S.wire === String(i) ? ' is-hl' : ''}${S.ticks[`${k.id}:${i}`] ? ' is-ok' : ''}" data-wire="${i}"
        d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`);
    });
    const loopArcs = (end, list, ys, x, dir, side) => (list || []).forEach(([p, q], j) => {
      const a = D().endPin(end, p), b = D().endPin(end, q);
      if (!a || !b) return;
      const y1 = ys.get(a.key), y2 = ys.get(b.key), reach = 26 + 14 * j, i = `${side}${j}`;
      parts.push(`<path class="po-wire po-wire--loop${S.wire === i ? ' is-hl' : ''}${S.ticks[`${k.id}:${i}`] ? ' is-ok' : ''}" data-wire="${i}"
        d="M${x} ${y1}C${x + dir * reach} ${y1} ${x + dir * reach} ${y2} ${x} ${y2}"/>`);
    });
    loopArcs(k.a, loops.a, ya, k.b ? xa : xa + bw, k.b ? -1 : 1, 'a');
    if (k.b) loopArcs(k.b, loops.b, yb, xb + bw, 1, 'b');
    ra.forEach(r => parts.push(box(r, xa, ya.get(r.key), 'a')));
    rb.forEach(r => parts.push(box(r, xb, yb.get(r.key), 'b')));
    const title = `${k.name}: how each wire runs`;
    return `<svg class="po-cable-svg" viewBox="-60 0 ${W + 120} ${H}" role="img" aria-label="${escAttr(title)}"><title>${esc(title)}</title>${parts.join('')}</svg>`;
  }

  function cableRows(k) {
    const say = (end, ref, side) => {
      const x = D().endPin(end, ref);
      return x ? `${side} ${lab(x.p)} · ${x.p.sig}` : `${side} ${ref}`;
    };
    const loops = k.loops || {};
    const rows = k.wires.map((w, i) => ({ i: String(i), from: say(k.a, w[0], 'A'), to: say(k.b, w[1], 'B'), note: w[2] || '', wire: w[3] || '' }));
    const loopRows = (end, list, side) => (list || []).map(([p, q], j) => ({ i: `${side}${j}`, from: say(end, p, side.toUpperCase()),
      to: say(end, q, side.toUpperCase()), note: 'Joined at this end only', wire: '' }));
    return rows.concat(loopRows(k.a, loops.a, 'a'), loopRows(k.b, loops.b, 'b'));
  }

  const buzzSay = (done, all) => `${done} of ${all} checked${done === all && all ? ' — every wire is where it should be. Now check that no pin beeps to one it should not.' : '.'}`;

  function cableHtml() {
    const k = D().cableById(S.cable) || D().CABLES[0];
    const rows = cableRows(k);
    const done = rows.filter(r => S.ticks[`${k.id}:${r.i}`]).length;
    const colours = rows.some(r => r.wire);
    return `<h4>${esc(k.name)}</h4>
      <p class="po-sure-line"><span class="po-sure po-sure--${k.sure}">${esc(D().SURE[k.sure].label)}</span> <span class="small">${esc(D().SURE[k.sure].blurb)}</span></p>
      <div class="po-cable-wrap" role="region" aria-label="${escAttr(`${k.name}, drawn`)}" tabindex="0">${cableSvg(k)}</div>
      <div class="table-wrap" role="region" aria-label="${escAttr(`Buzz-out list for ${k.name}`)}" tabindex="0"><table class="po-table po-buzz">
        <caption class="sr-only">Each wire of ${esc(k.name)}, to tick as it is checked for continuity</caption>
        <thead><tr><th scope="col">Beeps</th><th scope="col">From</th><th scope="col">To</th>${colours ? '<th scope="col">Colour</th>' : ''}<th scope="col">Note</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="po-row${S.wire === r.i ? ' is-sel' : ''}" data-wire="${r.i}" onmouseenter="Pinouts.hl('${r.i}')" onmouseleave="Pinouts.hl(null)">
          <th scope="row"><input type="checkbox" id="po-tick-${r.i}" ${S.ticks[`${k.id}:${r.i}`] ? 'checked' : ''}
            onchange="Pinouts.tick('${r.i}', this.checked)" onfocus="Pinouts.hl('${r.i}')" onblur="Pinouts.hl(null)"
            aria-label="${escAttr(`${r.from} to ${r.to}: beeps`)}"></th>
          <td>${esc(r.from)}</td><td>${esc(r.to)}</td>${colours ? `<td>${esc(r.wire)}</td>` : ''}<td>${esc(r.note)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="po-buzz-count" id="po-buzz-count" aria-live="polite">${esc(buzzSay(done, rows.length))}</p>
      <div class="button-row"><button type="button" onclick="Pinouts.clearTicks()">Clear the ticks</button></div>
      ${k.notes && k.notes.length ? `<ul class="po-notes">${k.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${k.sources && k.sources.length ? `<p class="small">Sources: ${k.sources.map(s => `<a href="${escAttr(s.href)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('; ')}</p>` : ''}`;
  }

  // ── 4–20 mA ────────────────────────────────────────────────────────────────

  // Set-ups to start from: the HS40's WL3100 (a two-wire loop that needs 9 V
  // and signals a fault at 24 mA) into the loggers on the network.
  const PRESETS = [
    { id: 'cr300', label: 'HS40 into a CR300', set: { supply: '12', ohms: '100', wire: '40', vmin: '9', fault: '24' },
      note: 'The CR300 measures across its own 100 Ω, with 140 Ω in all to ground (so 40 Ω more here); the WL3100 needs 9 V and goes to 24 mA on a fault.' },
    { id: 'al200x', label: 'HS40 into an AL200X', set: { supply: '11.8', ohms: '100', wire: '10', vmin: '9', fault: '24' },
      note: 'The AL200X measures across 100 Ω inside; SW12A drops about 0.2 V, and Campbell asks for at least 11 V on the loop.' },
    { id: 'r250', label: 'HS40 across 250 Ω on 12 V', set: { supply: '12', ohms: '250', wire: '5', vmin: '9', fault: '24' },
      note: 'A 250 Ω resistor makes a tidy 1–5 V, but takes 5 V at 20 mA — more than a 12 V loop can spare.' },
    { id: 'r250-24', label: 'HS40 across 250 Ω on 24 V', set: { supply: '24', ohms: '250', wire: '5', vmin: '9', fault: '24' },
      note: 'The same resistor on a 24 V loop: room to spare, even at the 24 mA fault — but 24 mA reads 6 V, past a 0–5 V input.' },
  ];

  function loopHtml() {
    const L = S.loop;
    const f = (k, label, unit, attrs = '') => `<label class="po-field"><span>${esc(label)}</span>
      <span class="po-field-in"><input id="po-l-${k}" inputmode="decimal" value="${escAttr(L[k])}" oninput="Pinouts.loopSet('${k}', this.value)" ${attrs}>${unit ? `<span class="po-unit-tag">${esc(unit)}</span>` : ''}</span></label>`;
    return `<h3 id="po-loop-h">4–20 mA loops</h3>
      <p>A current loop carries a reading as a current: 4 mA at the bottom of the scale, 20 mA at the top. The logger reads it as the
        voltage across a measuring resistor. Set the scale, then type any one of the current, the reading or the volts and the other two follow.</p>
      <div class="po-cats" role="group" aria-label="Start from a set-up">${PRESETS.map(x =>
        `<button type="button" class="po-chip" id="po-pre-${x.id}" aria-pressed="${L.preset === x.id}" onclick="Pinouts.preset('${x.id}')">${esc(x.label)}</button>`).join('')}</div>
      ${(PRESETS.find(x => x.id === L.preset) || {}).note ? `<p class="small">${esc(PRESETS.find(x => x.id === L.preset).note)}</p>` : ''}
      <div class="po-loop-grid">
        <fieldset class="po-box"><legend>The scale</legend>
          ${f('lo', 'Reading at 4 mA', '')}${f('hi', 'Reading at 20 mA', '')}
          <label class="po-field"><span>Units</span><span class="po-field-in"><input id="po-l-unit" value="${escAttr(L.unit)}" oninput="Pinouts.loopSet('unit', this.value)" maxlength="8"></span></label>
        </fieldset>
        <fieldset class="po-box"><legend>Convert</legend>
          ${f('ma', 'Current', 'mA')}${f('val', 'Reading', L.unit)}${f('v', 'Volts across the resistor', 'V')}
        </fieldset>
        <fieldset class="po-box"><legend>The loop</legend>
          ${f('supply', 'Loop supply', 'V')}${f('ohms', 'Measuring resistor', 'Ω')}${f('wire', 'Cable, barrier and anything else in the loop', 'Ω')}${f('vmin', 'The transmitter needs at least', 'V')}${f('fault', 'It signals a fault at', 'mA')}
        </fieldset>
      </div>
      <div id="po-loop-out" class="po-loop-out" aria-live="polite">${loopOut()}</div>
      <figure class="po-fig">
        <fieldset class="po-seg"><legend>Wiring</legend>
          <label><input type="radio" name="po-lmode" ${L.mode === 'passive' ? 'checked' : ''} onchange="Pinouts.loopMode('passive')"> Two-wire, powered by the loop</label>
          <label><input type="radio" name="po-lmode" ${L.mode === 'active' ? 'checked' : ''} onchange="Pinouts.loopMode('active')"> Active output, powered by the instrument</label>
        </fieldset>
        <div id="po-loop-fig">${loopSvg()}</div>
      </figure>`;
  }

  // Fill the convert boxes from whichever was typed.
  function loopFill(from) {
    const L = S.loop, lo = num(L.lo), hi = num(L.hi), R = num(L.ohms);
    let ma = NaN;
    if (from === 'val') ma = D().val2ma(num(L.val), lo, hi);
    else if (from === 'v') ma = R > 0 ? num(L.v) / R * 1000 : NaN;
    else ma = num(L.ma);
    if (from !== 'ma') L.ma = Number.isFinite(ma) ? fmt(ma, 3) : '';
    if (from !== 'val') L.val = Number.isFinite(ma) && Number.isFinite(lo) && Number.isFinite(hi) ? fmt(D().ma2val(ma, lo, hi), 3) : '';
    if (from !== 'v') L.v = Number.isFinite(ma) && R > 0 ? fmt(D().volts(ma, R), 3) : '';
    return ma;
  }

  function loopOut() {
    const L = S.loop;
    const ma = num(L.ma), R = num(L.ohms), Rw = num(L.wire) || 0, sup = num(L.supply), vmin = num(L.vmin);
    const fa = num(L.fault) > 20 ? num(L.fault) : 21;
    const b = D().band(ma);
    const lines = [];
    if (b) lines.push(`<p class="po-band po-band--${b.k}"><strong>${fmt(ma, 2)} mA:</strong> ${esc(b.text)}</p>`);
    const lo = num(L.lo), hi = num(L.hi);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi !== lo && R > 0) {
      lines.push(`<p class="small">The scale: ${fmt((hi - lo) / 16, 4)} ${esc(L.unit)} per mA. Across ${fmt(R, 0)} Ω, 4 mA is ${fmt(D().volts(4, R), 3)} V, 20 mA ${fmt(D().volts(20, R), 3)} V and ${fmt(fa, 0)} mA ${fmt(D().volts(fa, R), 3)} V.</p>`);
    }
    if (S.loop.mode === 'passive' && Number.isFinite(sup) && R >= 0 && Number.isFinite(vmin)) {
      const g = D().budget(sup, R + Rw, vmin, fa);
      lines.push(g.ok
        ? `<p class="po-band po-band--${g.fault ? 'ok' : 'warn'}"><strong>The loop has the voltage${g.fault ? '' : ' — until a fault'}.</strong> At 20 mA the transmitter is left ${fmt(g.at20, 2)} V
            of the ${fmt(sup, 1)} V, ${fmt(g.spare, 2)} V more than it needs${g.fault ? `, and ${fmt(g.atFault, 2)} V at its ${fmt(fa, 0)} mA fault`
              : ` — but at its ${fmt(fa, 0)} mA fault only ${fmt(g.atFault, 2)} V, so a fault may read as a lower current. Keep the loop under ${fmt(g.maxFault, 0)} Ω to see it`}.
            The most this supply can drive at 20 mA is ${fmt(g.maxOhms, 0)} Ω in all.</p>`
        : `<p class="po-band po-band--bad"><strong>Not enough voltage.</strong> At 20 mA the ${fmt(R + Rw, 0)} Ω in the loop takes ${fmt(0.02 * (R + Rw), 2)} V, leaving the
            transmitter ${fmt(g.at20, 2)} V of the ${fmt(vmin, 1)} V it needs: readings will flatten off below full scale. Use no more than ${fmt(Math.max(0, g.maxOhms), 0)} Ω in all,
            a smaller resistor (100 Ω gives 0.4–2 V), or a higher loop supply.</p>`);
    } else if (S.loop.mode === 'active') {
      lines.push('<p class="small">An active output drives the loop from the instrument\'s own supply: check its datasheet for the most loop resistance it can drive (often 500 Ω or more), and do not power the loop from the logger as well.</p>');
    }
    return lines.join('');
  }

  // The two ways a loop is wired.
  function loopSvg() {
    const active = S.loop.mode === 'active';
    const t = (x, y, s, cls = 'po-lt', a = 'middle') => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${a}">${esc(s)}</text>`;
    const parts = [];
    // The transmitter, the logger's input and its resistor, and the supply.
    parts.push(`<rect class="po-lbox" x="20" y="40" width="150" height="120" rx="8"/>`, t(95, 30, active ? 'Instrument (active output)' : 'Transmitter (two-wire)'));
    parts.push(`<rect class="po-lbox" x="390" y="40" width="190" height="120" rx="8"/>`, t(485, 30, 'Logger input'));
    parts.push(`<rect class="po-res" x="470" y="70" width="26" height="70" rx="3"/>`, t(530, 110, `${S.loop.ohms || '?'} Ω`, 'po-lt', 'start'));
    if (!active) {
      parts.push(`<rect class="po-lbox" x="230" y="190" width="120" height="56" rx="8"/>`, t(290, 214, 'Loop supply'), t(290, 234, `${S.loop.supply || '?'} V`, 'po-lt-sub'));
      // + of the supply up to the transmitter's +; − of the transmitter to the
      // input; the resistor down to 0 V, back to the supply's −.
      parts.push(`<path class="po-lw po-lw--pwr" d="M260 190V180H60V160"/>`, t(70, 150, '+', 'po-lt', 'start'));
      parts.push(`<path class="po-lw po-lw--sig" d="M130 160V172H300V100H483V70"/>`, t(140, 150, '−', 'po-lt', 'start'));
      parts.push(`<path class="po-lw po-lw--gnd" d="M483 140V218H350"/>`, t(420, 210, '0 V', 'po-lt-sub'));
      parts.push(t(220, 92, '4–20 mA →', 'po-lt-sub'));
    } else {
      parts.push(`<path class="po-lw po-lw--sig" d="M130 100H483V70"/>`, t(140, 90, 'I+', 'po-lt', 'start'));
      parts.push(`<path class="po-lw po-lw--gnd" d="M483 140V190H60V160"/>`, t(70, 150, 'I− / 0 V', 'po-lt', 'start'));
      parts.push(t(300, 90, '4–20 mA →', 'po-lt-sub'), t(270, 205, 'common', 'po-lt-sub'));
    }
    parts.push(t(485, 60, 'reads V = I × R', 'po-lt-sub'));
    const title = active
      ? 'An active output: the instrument drives the current out of I+, through the logger\'s measuring resistor, and back on I− or 0 V.'
      : 'A two-wire loop: the supply\'s + feeds the transmitter\'s +, the current leaves its − for the logger\'s input, through the measuring resistor to 0 V and back to the supply.';
    return `<svg class="po-loop-svg" viewBox="0 0 600 260" role="img" aria-label="${escAttr(title)}"><title>${esc(title)}</title>${parts.join('')}</svg>`;
  }

  // ── RF connectors ──────────────────────────────────────────────────────────

  const RF = [
    ['N', 'Threaded (5/8″-24)', '50 Ω, to 11 GHz', 'Centre pin inside a coupling nut', 'Centre socket, thread on the outside',
      'Antenna feeders and jumpers, the SWR meters, repeater and base station antennas. Weatherproof when tight and taped.'],
    ['BNC', 'Bayonet — push and turn a quarter', '50 Ω (75 Ω for video)', 'Centre pin, a turning collar with slots', 'Centre socket, two studs on the barrel',
      'Bench radios, test gear, older data radios. Quick, but not for outdoors.'],
    ['TNC', 'Threaded BNC (7/16″-28)', '50 Ω', 'Centre pin inside a coupling nut', 'Centre socket, thread on the outside',
      'GPS and Iridium antennas and their cables, mobile radio antennas. Holds where a BNC would vibrate loose.'],
    ['SMA', 'Threaded (1/4″-36), small', '50 Ω', 'Centre pin inside a nut', 'Centre socket, thread on the outside',
      'Modem and module antenna ports, SDR dongles, short pigtails. Finger-tight plus an eighth of a turn.'],
    ['RP-SMA', 'As SMA, sexes of the pin swapped', '50 Ω', 'A nut, but a centre socket', 'Thread outside, but a centre pin',
      'Wi-Fi and some cellular routers. Looks like SMA and screws onto it, but the centres never meet: no signal.'],
    ['UHF (PL-259 / SO-239)', 'Threaded (5/8″-24 — the same thread as N)', 'Not a constant impedance', 'PL-259: pin inside a threaded sleeve', 'SO-239: a socket, thread outside',
      'Older HF and VHF radios and CB gear. A PL-259 will start onto an N socket because the thread is the same — but they do not mate, and forcing it ruins the N\'s centre.'],
  ];

  function rfFace(male, kind) {
    const pin = male ? '<circle class="po-rf-pin" cx="0" cy="0" r="4"/>' : '<circle class="po-rf-sock" cx="0" cy="0" r="5"/>';
    const bay = kind === 'BNC' ? (male ? '<path class="po-rf-slot" d="M-17 -6v12M17 -6v12"/>' : '<circle class="po-rf-stud" cx="-21" cy="0" r="3"/><circle class="po-rf-stud" cx="21" cy="0" r="3"/>') : '';
    const thread = kind === 'BNC' ? '' : `<circle class="po-rf-thread${male ? ' is-in' : ''}" cx="0" cy="0" r="${male ? 15 : 19}"/>`;
    return `<svg class="po-rf-face" viewBox="-26 -26 52 52" aria-hidden="true" focusable="false">
      <circle class="po-rf-body" cx="0" cy="0" r="${male ? 22 : 18}"/>${thread}<circle class="po-rf-diel" cx="0" cy="0" r="10"/>${pin}${bay}</svg>`;
  }

  function rfHtml() {
    return `<h3 id="po-rf-h">RF connectors</h3>
      <p>For coaxial connectors the sex is the centre: male has the pin, female the socket — whatever the outside looks like. RP-SMA is the
        exception that catches people out.</p>
      <div class="table-wrap" role="region" aria-label="RF connectors told apart" tabindex="0"><table class="po-table po-rf">
        <caption class="sr-only">RF connectors: how each couples, its impedance, how to tell male from female, and where it turns up</caption>
        <thead><tr><th scope="col">Connector</th><th scope="col">Male</th><th scope="col">Female</th><th scope="col">Couples</th><th scope="col">Where you meet it</th></tr></thead>
        <tbody>${RF.map(([n, how, z, m, f, where]) => `<tr><th scope="row">${esc(n)}<br><span class="small">${esc(z)}</span></th>
          <td><span class="po-rf-cell">${rfFace(n !== 'RP-SMA', n)}<span>${esc(m)}</span></span></td>
          <td><span class="po-rf-cell">${rfFace(n === 'RP-SMA', n)}<span>${esc(f)}</span></span></td>
          <td>${esc(how)}</td><td>${esc(where)}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ── Reading a pinout ───────────────────────────────────────────────────────

  function readHtml() {
    const de9 = D().byId('rs232-de9-dte');
    const fig = (g, back, cap) => `<figure class="po-read-fig">${faceSvg(de9, { gender: g, back, id: `po-read-${g}${back ? 'b' : 'f'}` })}<figcaption class="small">${esc(cap)}</figcaption></figure>`;
    return `<h3 id="po-read-h">Reading a pinout</h3>
      <div class="po-read-figs">
        ${fig('M', false, 'Male, from the front: pin 1 top left')}
        ${fig('F', false, 'Female, from the front: pin 1 top right')}
        ${fig('M', true, 'Male, from the back (solder cups): pin 1 top right')}
      </div>
      <ul class="po-notes">
        <li><strong>Male has pins, female has sockets</strong> — a D-sub's part number says so: DE-9<strong>P</strong> (pins), DE-9<strong>S</strong> (sockets). The shell goes the other way: a male D-sub's metal shroud fits around the female's.</li>
        <li><strong>A drawing is from the front unless it says otherwise.</strong> A socket's face, and either connector from the back, is a mirror image — the cause of most miswired cables. Use the tab's <em>Seen from</em> switch to see the side in your hand.</li>
        <li><strong>RS-232's names are the computer's.</strong> TXD is what a computer (DTE) sends; on a modem (DCE) the same pin is an input. Two DTEs need a null modem, a DTE and a DCE a straight cable.</li>
        <li><strong>Find the talking pin with a meter.</strong> Unit on and idle, black probe on ground (pin 5): the pin it transmits on sits at −5 to −12 V. Pin 3 negative: a DTE. Pin 2 negative: a DCE.</li>
        <li><strong>RS-232 is ±3 to ±15 V; logic pins are 0–5 or 0–3.3 V.</strong> An RS-232 port wired straight to a logic-level pin (VE.Direct, a GPS or radio module's UART) can kill it. A level shifter or the maker's interface cable goes between.</li>
        <li><strong>A gender changer is not a null modem.</strong> It swaps the sex and keeps every pin the same; a null modem crosses the data. Label which one you carry.</li>
        <li><strong>Power last.</strong> Check the supply pins' polarity with a meter before you plug in, and unplug power before you change a connector.</li>
      </ul>`;
  }

  // ── Doing things ───────────────────────────────────────────────────────────

  function rerender(part) {
    if (part === 'list') { const el = $('po-list'); if (el) el.innerHTML = listHtml(); return; }
    if (part === 'view') { const el = $('po-view'); if (el) el.innerHTML = viewHtml(); return; }
    if (part === 'cable') { const el = $('po-cable'); if (el) el.innerHTML = cableHtml(); return; }
  }

  function pick(id, quiet) {
    if (!D().byId(id)) return;
    if (S.id !== id) { S.id = id; S.pin = null; S.mate = false; S.back = false; }
    keep();
    document.querySelectorAll('.po-card').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('onclick') === `Pinouts.pick('${id}')`)));
    rerender('view');
    if (!quiet) {
      const v = $('po-view');
      if (v && v.scrollIntoView) v.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (typeof announce === 'function') announce(`${conn().name} shown`);
    }
  }

  // Select a pin: the drawing and the table follow, and focus stays put.
  function pin(n) {
    const c = conn();
    const p = c.pins.find(x => x.n === String(n));
    S.pin = p && S.pin !== p.n ? p.n : (p ? p.n : null);
    paintPin();
  }
  function paintPin() {
    const c = conn();
    document.querySelectorAll('#po-face .po-pin').forEach(g => {
      const on = g.dataset.pin === S.pin;
      g.classList.toggle('is-sel', on);
      g.setAttribute('aria-pressed', String(on));
      g.setAttribute('tabindex', on || (!S.pin && g.dataset.pin === c.pins[0].n) ? '0' : '-1');
    });
    document.querySelectorAll('#po-view .po-row').forEach(r => {
      const on = r.dataset.row === S.pin;
      r.classList.toggle('is-sel', on);
      const b = r.querySelector('.po-pin-btn');
      if (b) b.setAttribute('aria-pressed', String(on));
    });
    const say = $('po-say');
    if (say) say.textContent = pinSay(c, c.pins.find(p => p.n === S.pin) || null);
  }

  // Arrow keys walk the pins in number order; Enter or Space picks.
  function key(e, n) {
    const c = conn();
    const order = c.pins.map(p => p.n);
    const i = order.indexOf(String(n));
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(order.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = order.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(n); return; }
    if (j == null) return;
    e.preventDefault();
    S.pin = order[j];
    paintPin();
    const g = document.querySelector(`#po-face .po-pin[data-pin="${CSS.escape(order[j])}"]`);
    if (g) g.focus();
  }

  function mate(on) {
    S.mate = !!on;
    redrawFace();
  }
  function side(back) {
    S.back = !!back;
    redrawFace();
  }
  function redrawFace() {
    const c = conn();
    const w = $('po-face-wrap');
    if (w) w.innerHTML = faceSvg(c, { gender: shown(c), back: S.back, live: true });
    const cap = document.querySelector('#po-view .po-fig figcaption');
    if (cap && flips(c)) cap.textContent = `${faceNote(c, shown(c), S.back)} Arrow keys move between pins.`;
    if (typeof announce === 'function') announce(`Showing the ${sexWord(shown(c))}, ${S.back ? 'from the back' : 'from the front'}`);
  }

  function find(q) {
    S.q = String(q || '').slice(0, 80);
    rerender('list');
  }
  function cat(k) {
    S.cat = k === 'all' || D().CATS.some(([c]) => c === k) ? k : 'all';
    document.querySelectorAll('.po-cats .po-chip').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('onclick') === `Pinouts.cat('${S.cat}')`)));
    rerender('list');
  }

  function cable(id) {
    if (!D().cableById(id)) return;
    S.cable = id; S.wire = null;
    keep();
    document.querySelectorAll('.po-cable-pick .po-chip').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('onclick') === `Pinouts.cable('${id}')`)));
    rerender('cable');
  }
  // Light a wire on the drawing while its row is pointed at or focused.
  function hl(i) {
    S.wire = i == null ? null : String(i);
    document.querySelectorAll('#po-cable .po-wire').forEach(p => p.classList.toggle('is-hl', p.dataset.wire === S.wire));
    document.querySelectorAll('#po-cable .po-row').forEach(r => r.classList.toggle('is-sel', r.dataset.wire === S.wire));
  }
  function tick(i, on) {
    const k = S.cable;
    if (on) S.ticks[`${k}:${i}`] = true; else delete S.ticks[`${k}:${i}`];
    const p = document.querySelector(`#po-cable .po-wire[data-wire="${CSS.escape(String(i))}"]`);
    if (p) p.classList.toggle('is-ok', !!on);
    const rows = cableRows(D().cableById(k));
    const done = rows.filter(r => S.ticks[`${k}:${r.i}`]).length;
    const el = $('po-buzz-count');
    if (el) el.textContent = buzzSay(done, rows.length);
  }
  function clearTicks() {
    Object.keys(S.ticks).filter(t => t.startsWith(`${S.cable}:`)).forEach(t => delete S.ticks[t]);
    rerender('cable');
  }

  // A box in the calculator typed: the others follow, the typed one keeps focus.
  function loopSet(k, v) {
    if (!(k in S.loop)) return;
    S.loop[k] = String(v).slice(0, 12);
    if (['supply', 'ohms', 'wire', 'vmin', 'fault'].includes(k) && S.loop.preset) {
      S.loop.preset = '';
      document.querySelectorAll('#po-loop .po-cats .po-chip').forEach(b => b.setAttribute('aria-pressed', 'false'));
    }
    const from = k === 'val' || k === 'v' ? k : 'ma';
    loopFill(from);
    ['ma', 'val', 'v'].filter(x => x !== k).forEach(x => { const el = $(`po-l-${x}`); if (el) el.value = S.loop[x]; });
    if (k === 'unit') { const tag = document.querySelector('#po-l-val + .po-unit-tag'); if (tag) tag.textContent = S.loop.unit; }
    const out = $('po-loop-out');
    if (out) out.innerHTML = loopOut();
    if (k === 'ohms' || k === 'supply') { const f = $('po-loop-fig'); if (f) f.innerHTML = loopSvg(); }
  }
  function preset(id) {
    const x = PRESETS.find(p => p.id === id);
    if (!x) return;
    Object.assign(S.loop, x.set, { preset: id, mode: 'passive' });
    loopFill('ma');
    const el = $('po-loop');
    if (el) el.innerHTML = loopHtml();
    const b = $(`po-pre-${id}`);
    if (b) b.focus();
  }
  function loopMode(m) {
    S.loop.mode = m === 'active' ? 'active' : 'passive';
    const f = $('po-loop-fig'); if (f) f.innerHTML = loopSvg();
    const out = $('po-loop-out'); if (out) out.innerHTML = loopOut();
  }

  function go(id) {
    const el = $(id);
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const h = el.querySelector('h3');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function exportCsv(which) {
    if (which === 'one') {
      const c = conn();
      dlText(`pinout-${c.id}.csv`, D().csv([c.id]));
      if (typeof announce === 'function') announce(`Saved the ${c.short} pinout as a CSV`);
    } else {
      dlText('pinouts.csv', D().csv());
      if (typeof announce === 'function') announce('Saved every pinout as a CSV');
    }
  }

  // Open the tab on a connector (or a cable) from elsewhere.
  function show(id, cableId) {
    S.pending = { id, cableId };
    if (typeof state !== 'undefined' && state.activeTab === TAB) { init(); return; }
    if (typeof switchTab === 'function') switchTab(TAB);
  }

  function init() {
    S.loop.val = ''; S.loop.v = '';
    loopFill('ma');
    ['val', 'v'].forEach(x => { const el = $(`po-l-${x}`); if (el) el.value = S.loop[x]; });
    const p = S.pending;
    S.pending = null;
    if (!p) return;
    if (p.cableId && D().cableById(p.cableId)) { cable(p.cableId); go('po-cables'); }
    if (p.id && D().byId(p.id)) pick(p.id);
  }

  const state_ = () => ({ id: S.id, pin: S.pin, mate: S.mate, back: S.back, q: S.q, cat: S.cat, cable: S.cable, ticks: { ...S.ticks }, loop: { ...S.loop } });

  return { render, init, show, pick, pin, key, mate, side, find, cat, cable, hl, tick, clearTicks, loopSet, loopMode, preset, go, exportCsv, faceSvg, state: state_ };
})();

if (typeof window !== 'undefined') window.Pinouts = Pinouts;
