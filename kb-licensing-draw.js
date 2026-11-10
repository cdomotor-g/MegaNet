// MegaNet — kb-licensing-draw.js
//
//   LicensingDraw   the drawings of the Knowledge base's 🪪 Radio Licensing tab
//                   (kb-licensing.js): SVG written as text, coloured by class
//                   from the sheet's tokens so both themes get them, and moved
//                   by CSS so the one reduced-motion policy stills them.
//
//     scene()        who needs a licence: a gauge, a repeater and a base that
//                    only listens, with the message travelling between them
//     system()       a point-to-multipoint system, role by role
//     explorer()     the 30 km question seen from above: a base, its service
//                    area, the next base on the channel, and a station to move
//     shapes()       one power, three shapes: isotropic, dipole, Yagi
//     pattern()      an antenna's radiation pattern, from above or from the side
//     antenna()      what the antenna itself looks like
//     ladder()       transmitter power → at the antenna → EIRP, against the limits
//     timeline()     a gauge's bursts across a minute, against the timing rules
//     bars()         how many of a holder's bases run at each EIRP
//
// Every drawing is `role="img"` with a name that carries its numbers; what it
// offers to do is on real controls beside it, never on the picture
// (docs/design-system.md, "Charts, canvas and maps").
//
// The antenna figures are ACMA's own where it gives them (RALI FX16 s 3.1 and
// the Fixed Licence determination's Table 1) and textbook values otherwise;
// the patterns are drawn from those figures by one formula (lobeDb) — a
// sketch of the shape, not a maker's measured plot, and the tab says so.
//
// After core.js (esc, escAttr). Nothing runs at load.
//
// Exposes: ANTENNAS, lobeDb, scene, system, explorer, placeExplorer, shapes,
//          pattern, antenna, ladder, timeline, bars.

const LicensingDraw = (function () {
  const f1 = x => (Math.round(x * 10) / 10).toString();
  const num = (x, d = 1) => Number(x).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

  // id → what the page needs to draw and reckon with it. bw: half-power
  // beamwidth seen from above (360 = all round); vbw: from the side; fb:
  // front-to-back ratio in dB (0 = none).
  const ANTENNAS = {
    iso: { name: 'Isotropic (imaginary)', gain: 0, bw: 360, vbw: 360, fb: 0, dir: false, els: 0,
      what: 'A point that radiates equally in every direction. It cannot be built — it is the yardstick.', use: 'The reference for dBi and EIRP.' },
    whip: { name: 'Quarter-wave whip', gain: 2, bw: 360, vbw: 80, fb: 0, dir: false, els: 0,
      what: 'One upright rod about half a metre long at 151.5 MHz, over a metal base or four radial rods.', use: 'Small gauges and vehicles.' },
    dipole: { name: 'Half-wave dipole', gain: 2.15, bw: 360, vbw: 78, fb: 0, dir: false, els: 0,
      what: 'A straight rod about a metre long, fed in the middle. The simplest real antenna and the second yardstick (0 dBd).', use: 'The reference for dBd and ERP; folded versions sit on many masts.' },
    col5: { name: 'Collinear, 5 dBi', gain: 5.15, bw: 360, vbw: 36, fb: 0, dir: false, els: 0,
      what: 'Two or three dipoles stacked in one upright tube, a couple of metres tall.', use: 'Gauges that must reach more than one repeater; small bases.' },
    col8: { name: 'Collinear, 8.2 dBi', gain: 8.2, bw: 360, vbw: 16, fb: 0, dir: false, els: 0,
      what: 'A tall stack of dipoles, five or six metres of tube. 8.2 dBi is the most RALI FX16 plans a base station on.', use: 'A repeater or base that listens all round.' },
    yagi3: { name: 'Yagi, 3 elements', gain: 6, bw: 75, vbw: 75, fb: 12, dir: true, els: 3,
      what: 'Three rods on a short boom. ACMA’s least for a directional antenna at VHF: 6 dBi, a 75° beam, 12 dB front to back.', use: 'A gauge pointed at its one repeater.' },
    yagi6: { name: 'Yagi, 6 elements', gain: 12, bw: 44, vbw: 44, fb: 20, dir: true, els: 6,
      what: 'Six rods on a boom about three metres long. What the law asks of a point-to-point link in 148–174 MHz that names no antenna: 12 dBi, a 44° beam, 20 dB front to back.', use: 'Each end of a point-to-point link.' },
    yagi9: { name: 'Yagi, 9 elements (400 MHz)', gain: 13, bw: 36, vbw: 36, fb: 17, dir: true, els: 9,
      what: 'Nine rods, but a shorter boom because the rods are a third the size at 450 MHz: 13 dBi, a 36° beam, 17 dB front to back.', use: 'Links and remote stations in the 400 MHz band.' },
  };

  // The pattern's level, in dB below its peak, `deg` away from where it points.
  // A cos² beam whose half-power width is `bw`, never weaker than the floor.
  function lobeDb(deg, bw, floorDb) {
    if (bw >= 360) return 0;
    deg = ((deg + 540) % 360) - 180;            // -180 … 180, either way round
    const half = (bw / 2) * Math.PI / 180;
    const n = Math.log(0.5) / (2 * Math.log(Math.cos(half / 2)));
    const c = Math.cos((deg * Math.PI / 180) / 2);
    const db = c <= 0 ? -99 : 10 * Math.log10(Math.pow(c, 2 * n));
    return Math.max(db, -Math.abs(floorDb || 30));
  }
  // A side view of an antenna that is omnidirectional: strongest at the
  // horizon, nothing straight up or down. `deg` is from the horizon.
  function ringDb(deg, vbw) {
    if (vbw >= 360) return 0;
    const half = (vbw / 2) * Math.PI / 180;
    const n = Math.log(0.5) / (2 * Math.log(Math.cos(half)));
    const c = Math.abs(Math.cos(deg * Math.PI / 180));
    return c <= 1e-6 ? -30 : Math.max(-30, 10 * Math.log10(Math.pow(c, 2 * n)));
  }

  // ── Waves and marks ─────────────────────────────────────────────────────────

  // Three arcs opening towards `dir` (1 right, -1 left), each a beat behind.
  function waves(x, y, dir, cls) {
    return [14, 24, 34].map((r, i) => `<path class="rlc-wave rlc-wave-${i + 1}${cls ? ` ${cls}` : ''}"
        d="M${x + dir * r * 0.72} ${y - r * 0.7} A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x + dir * r * 0.72} ${y + r * 0.7}"/>`).join('');
  }
  const tag = (x, y, w, text, cls) => `<g class="rlc-tag ${cls || ''}"><rect x="${x - w / 2}" y="${y}" width="${w}" height="24" rx="12"/>
      <text x="${x}" y="${y + 16.5}" text-anchor="middle">${esc(text)}</text></g>`;

  // ── Who needs a licence ─────────────────────────────────────────────────────

  function scene() {
    return `<svg class="rlc-svg rlc-scene" viewBox="0 0 760 300" role="img"
        aria-label="A rain gauge transmits to a repeater on a hill, which transmits on to a base that only listens. The gauge and the repeater need a licence; the listening base does not.">
      <path class="rlc-sky" d="M0 0h760v300H0z"/>
      <path class="rlc-hill" d="M0 214 C90 196 150 204 220 196 C290 176 330 118 380 112 C430 118 470 176 540 196 C610 206 680 198 760 208 V300 H0z"/>
      <path class="rlc-water" d="M36 214 q16 -7 32 0 t32 0 t32 0 t32 0 v10 H36z"/>

      <g class="rlc-thing">
        <path class="rlc-line" d="M118 206 V140 M106 206 h24"/>
        <path class="rlc-box" d="M104 150 h28 v24 h-28z"/>
        <path class="rlc-line rlc-thin" d="M108 150 l10 -12 l10 12"/>
        <path class="rlc-line" d="M132 156 h12 V112"/>
        ${waves(150, 116, 1)}
        <text class="rlc-lbl" x="118" y="240" text-anchor="middle">Rain gauge</text>
      </g>
      ${tag(118, 250, 132, 'Transmits · licence', 'rlc-tag-yes')}

      <g class="rlc-thing">
        <path class="rlc-line" d="M368 112 L380 38 L392 112 M372 90 h16 M375 70 h10 M377 54 h6 M372 90 l13 -20 M388 90 l-13 -20"/>
        <path class="rlc-line" d="M380 38 V20"/>
        <path class="rlc-box" d="M396 96 h22 v16 h-22z"/>
        ${waves(394, 30, 1)}
        ${waves(366, 30, -1, 'rlc-wave-in')}
        <text class="rlc-lbl" x="380" y="240" text-anchor="middle">Repeater</text>
      </g>
      ${tag(380, 250, 190, 'Hears and transmits · licence', 'rlc-tag-yes')}

      <g class="rlc-thing">
        <path class="rlc-box" d="M606 150 h74 v52 h-74z"/>
        <path class="rlc-line rlc-thin" d="M618 164 h14 v14 h-14z M646 164 h14 v14 h-14z M636 202 v-16 h12 v16"/>
        <path class="rlc-line" d="M690 202 V96 M682 108 h16 M684 122 h12"/>
        ${waves(676, 100, -1, 'rlc-wave-in')}
        <text class="rlc-lbl" x="648" y="240" text-anchor="middle">Base</text>
      </g>
      ${tag(648, 250, 160, 'Only listens · none', 'rlc-tag-no')}

      <path class="rlc-hop" d="M152 112 L372 26"/>
      <path class="rlc-hop" d="M398 26 L682 96"/>
      <circle class="rlc-pkt rlc-pkt-1" r="6" cx="152" cy="112"/>
      <circle class="rlc-pkt rlc-pkt-2" r="6" cx="398" cy="26"/>
    </svg>`;
  }

  // ── A point-to-multipoint system ────────────────────────────────────────────
  // Each role is a group the page lights by class; the numbers match the key.

  const badge = (x, y, n) => `<g class="rlc-badge"><circle cx="${x}" cy="${y}" r="11"/><text x="${x}" y="${y + 4.5}" text-anchor="middle">${n}</text></g>`;
  function gaugeMark(x, y) {
    return `<path class="rlc-line" d="M${x} ${y} v-22 M${x - 6} ${y} h12"/><path class="rlc-box" d="M${x - 6} ${y - 20} h12 v10 h-12z"/>`;
  }
  function system(on) {
    const lit = k => (on === k ? ' is-on' : on ? ' is-off' : '');
    const remotes = [[120, 250], [205, 300], [330, 318], [470, 300], [150, 170]];
    return `<svg class="rlc-svg rlc-system" viewBox="0 0 660 360" role="img"
        aria-label="A point-to-multipoint system: one base station on a hill named on the licence, five remote stations round it that are not named, a fill-in transmitter behind a ridge, and a remote control station.">
      <ellipse class="rlc-area-fill" cx="320" cy="222" rx="286" ry="124"/>
      <ellipse class="rlc-area-edge" cx="320" cy="222" rx="286" ry="124"/>
      <path class="rlc-hill" d="M232 178 C276 156 296 96 320 92 C344 96 364 156 408 178z"/>
      <path class="rlc-ridge" d="M498 210 C520 176 540 168 560 176 C580 186 596 204 610 226z"/>

      <g class="rlc-role${lit('remote')}" data-role="remote">
        ${remotes.map(([x, y]) => `<path class="rlc-link" d="M${x} ${y - 22} L320 62"/>${gaugeMark(x, y)}`).join('')}
        ${badge(120, 268, 2)}
      </g>
      <g class="rlc-role${lit('base')}" data-role="base">
        <path class="rlc-line" d="M310 92 L320 44 L330 92 M313 78 h14 M316 62 h8"/>
        <path class="rlc-line" d="M320 44 V28"/>
        <circle class="rlc-pin" cx="320" cy="92" r="5"/>
        ${badge(350, 46, 1)}
      </g>
      <g class="rlc-role${lit('fillin')}" data-role="fillin">
        <path class="rlc-link rlc-link-fill" d="M560 150 L324 60"/>
        <path class="rlc-line" d="M560 176 V150 M554 156 h12"/>
        <path class="rlc-link rlc-link-fill" d="M560 150 L590 262"/>
        ${gaugeMark(590, 284)}
        ${badge(584, 148, 3)}
      </g>
      <g class="rlc-role${lit('rcs')}" data-role="rcs">
        <path class="rlc-box" d="M34 196 h44 v30 h-44z"/>
        <path class="rlc-line" d="M78 210 h10 V178"/>
        <path class="rlc-link" d="M88 178 L316 64"/>
        ${badge(56, 182, 4)}
      </g>
      <text class="rlc-lbl rlc-lbl-area" x="320" y="338" text-anchor="middle">the service area ACMA plans the licence on</text>
    </svg>`;
  }

  // ── The 30 km question, from above ──────────────────────────────────────────
  // Drawn once; placeExplorer() moves the parts. Positions are in kilometres
  // from base A along a line 12° north of east, at `scale` px a km.

  const EX = { ax: 150, ay: 150, bearing: -12 * Math.PI / 180 };
  function explorer() {
    return `<svg class="rlc-svg rlc-explorer" id="rlc-ex-svg" viewBox="0 0 720 300" role="img" aria-labelledby="rlc-ex-name">
      <title id="rlc-ex-name">A base station, its service area, and a station at a distance you choose</title>
      <path class="rlc-reuse" id="rlc-ex-reuse" d="M${EX.ax} 268 H450 M${EX.ax} 260 v16 M450 260 v16"/>
      <circle class="rlc-area-fill rlc-area-b" id="rlc-ex-area-b" cx="450" cy="${EX.ay}" r="90"/>
      <circle class="rlc-area-edge rlc-area-b" id="rlc-ex-edge-b" cx="450" cy="${EX.ay}" r="90"/>
      <circle class="rlc-area-fill" id="rlc-ex-area-a" cx="${EX.ax}" cy="${EX.ay}" r="90"/>
      <circle class="rlc-area-edge" id="rlc-ex-edge-a" cx="${EX.ax}" cy="${EX.ay}" r="90"/>
      <path class="rlc-ruler" id="rlc-ex-ruler" d="M${EX.ax} ${EX.ay} L240 190"/>
      <g id="rlc-ex-b"><circle class="rlc-pin rlc-pin-b" cx="450" cy="${EX.ay}" r="6"/>
        <text class="rlc-lbl" x="450" y="${EX.ay + 24}" text-anchor="middle">next base on</text>
        <text class="rlc-lbl" x="450" y="${EX.ay + 40}" text-anchor="middle">the channel</text></g>
      <circle class="rlc-pin" cx="${EX.ax}" cy="${EX.ay}" r="7"/>
      <text class="rlc-lbl rlc-lbl-b" x="${EX.ax}" y="${EX.ay + 26}" text-anchor="middle">licensed base</text>
      <text class="rlc-lbl rlc-lbl-area" id="rlc-ex-ring-t" x="${EX.ax}" y="52" text-anchor="middle">service area · 30 km</text>
      <text class="rlc-lbl rlc-lbl-reuse" id="rlc-ex-reuse-t" x="300" y="290" text-anchor="middle">re-use distance · 100 km — the least between two bases on one channel</text>
      <g id="rlc-ex-st" transform="translate(240 190)">
        <circle class="rlc-st-pulse" r="16"/>
        <circle class="rlc-st" id="rlc-ex-dot" r="8"/>
        <text class="rlc-lbl rlc-lbl-b" id="rlc-ex-km" x="0" y="-18" text-anchor="middle">30 km</text>
      </g>
    </svg>`;
  }
  // v: { km, radius, reuse, state: 'in' | 'out' | 'other' }
  function placeExplorer(v) {
    const g = id => document.getElementById(id);
    if (!g('rlc-ex-svg')) return;
    const scale = 300 / v.reuse, r = v.radius * scale;
    const bx = EX.ax + v.reuse * scale;
    const x = EX.ax + v.km * scale * Math.cos(EX.bearing), y = EX.ay + v.km * scale * Math.sin(EX.bearing);
    for (const id of ['rlc-ex-area-a', 'rlc-ex-edge-a']) g(id).setAttribute('r', f1(r));
    for (const id of ['rlc-ex-area-b', 'rlc-ex-edge-b']) { g(id).setAttribute('r', f1(r)); g(id).setAttribute('cx', f1(bx)); }
    g('rlc-ex-b').setAttribute('transform', `translate(${f1(bx - 450)} 0)`);
    g('rlc-ex-reuse').setAttribute('d', `M${EX.ax} 268 H${f1(bx)} M${EX.ax} 260 v16 M${f1(bx)} 260 v16`);
    g('rlc-ex-reuse-t').setAttribute('x', f1((EX.ax + bx) / 2));
    g('rlc-ex-ruler').setAttribute('d', `M${EX.ax} ${EX.ay} L${f1(x)} ${f1(y)}`);
    g('rlc-ex-st').setAttribute('transform', `translate(${f1(x)} ${f1(y)})`);
    g('rlc-ex-st').setAttribute('class', `rlc-st-${v.state}`);
    g('rlc-ex-ruler').setAttribute('class', `rlc-ruler rlc-ruler-${v.state}`);
    g('rlc-ex-km').textContent = `${num(v.km)} km`;
    g('rlc-ex-ring-t').setAttribute('y', f1(EX.ay - r - 8));
    g('rlc-ex-ring-t').textContent = `service area · ${num(v.radius)} km`;
    g('rlc-ex-reuse-t').textContent = `re-use distance · ${num(v.reuse)} km — the least between two bases on one channel`;
    g('rlc-ex-name').textContent = v.name;
  }

  // ── One power, three shapes ─────────────────────────────────────────────────

  function polar(fn, cx, cy, R, step) {
    const pts = [];
    for (let a = 0; a <= 360; a += step || 3) {
      const db = fn(a > 180 ? a - 360 : a);
      const r = Math.max(2, R * Math.pow(10, db / 20));   // how far it carries: reach goes as the square root of power
      pts.push(`${f1(cx + r * Math.sin(a * Math.PI / 180))} ${f1(cy - r * Math.cos(a * Math.PI / 180))}`);
    }
    return `M${pts.join(' L')}Z`;
  }
  // A shape drawn about (0,0) so the pulse grows from the antenna itself.
  function shapePath(kind) {
    if (kind === 'iso') return 'M0 -46 A46 46 0 1 1 0 46 A46 46 0 1 1 0 -46Z';
    if (kind === 'dipole') return 'M0 0 C16 -34 66 -30 74 0 C66 30 16 34 0 0 C-16 34 -66 30 -74 0 C-66 -30 -16 -34 0 0Z';
    return 'M0 0 C24 -30 104 -34 118 0 C104 34 24 30 0 0 C-6 9 -18 8 -20 0 C-18 -8 -6 -9 0 0Z';
  }
  function shapes() {
    const one = (kind, title, sub, gainText, mark) => `<figure class="rlc-shape" data-shape="${kind}">
        <svg class="rlc-svg" viewBox="-130 -84 260 168" role="img" aria-label="${escAttr(`${title}: ${sub}`)}">
          <path class="rlc-shape-edge" d="${shapePath(kind)}"/>
          <path class="rlc-shape-pulse rlc-shape-p1" d="${shapePath(kind)}"/>
          <path class="rlc-shape-pulse rlc-shape-p2" d="${shapePath(kind)}"/>
          ${mark}
        </svg>
        <figcaption><strong>${esc(title)}</strong> <span class="rlc-shape-gain">${esc(gainText)}</span><br>${esc(sub)}</figcaption>
      </figure>`;
    return `<div class="rlc-shapes">
      ${one('iso', 'Isotropic', 'The same in every direction — a ball. Imaginary: the yardstick.', '0 dBi', '<circle class="rlc-pin" r="4"/>')}
      ${one('dipole', 'Dipole, from the side', 'A doughnut: strong towards the horizon, nothing straight up or down.', '2.15 dBi', '<path class="rlc-line" d="M0 -30 V30"/>')}
      ${one('yagi', 'Yagi, from above', 'A torch beam: most of it one way, a little leaking out the back.', '6 to 16 dBi', '<path class="rlc-line" d="M-14 0 H34 M-12 -13 V13 M2 -11 V11 M16 -9.5 V9.5 M30 -8 V8"/>')}
    </div>`;
  }

  // ── A radiation pattern ─────────────────────────────────────────────────────

  function pattern(id, view) {
    const a = ANTENNAS[id] || ANTENNAS.iso;
    const side = view === 'side';
    const C = 150, R = 110;
    // From above, 0° is the way it points (drawn up). From the side, the
    // horizon runs left to right and the antenna points right.
    const fn = side
      ? (a.dir ? d => lobeDb(d - 90, a.vbw, a.fb) : d => ringDb(90 - Math.abs(d), a.vbw))
      : (a.dir ? d => lobeDb(d, a.bw, a.fb) : () => 0);
    const rings = [[1, 'full reach'], [0.5, 'half'], [0.25, 'quarter']].map(([k, label]) => `<circle class="rlc-grid" cx="${C}" cy="${C}" r="${f1(R * k)}"/>
        <text class="rlc-grid-t rlc-grid-ring" x="${C}" y="${f1(C + R * k - 3)}" text-anchor="middle">${label}</text>`).join('');
    const spokes = [0, 45, 90, 135].map(d => {
      const s = Math.sin(d * Math.PI / 180) * R, c = Math.cos(d * Math.PI / 180) * R;
      return `<path class="rlc-grid" d="M${f1(C - s)} ${f1(C + c)} L${f1(C + s)} ${f1(C - c)}"/>`;
    }).join('');
    let wedge = '';
    const bw = side ? a.vbw : a.bw;
    if (bw < 360 && (a.dir || side)) {
      const centre = side ? 90 : 0;
      const p = d => `${f1(C + R * Math.sin((centre + d) * Math.PI / 180))} ${f1(C - R * Math.cos((centre + d) * Math.PI / 180))}`;
      wedge = `<path class="rlc-wedge" d="M${C} ${C} L${p(-bw / 2)} A${R} ${R} 0 0 1 ${p(bw / 2)}Z"/>`;
      if (!a.dir && side) {
        const q = d => `${f1(C + R * Math.sin((270 + d) * Math.PI / 180))} ${f1(C - R * Math.cos((270 + d) * Math.PI / 180))}`;
        wedge += `<path class="rlc-wedge" d="M${C} ${C} L${q(-bw / 2)} A${R} ${R} 0 0 1 ${q(bw / 2)}Z"/>`;
      }
    }
    const name = side
      ? `${a.name} from the side: ${a.vbw >= 360 ? 'equal in every direction' : `strongest towards the horizon, half power ${num(a.vbw)}° apart`}.`
      : `${a.name} from above: ${a.bw >= 360 ? 'equal all the way round' : `a beam ${num(a.bw)}° wide at half power, ${num(a.fb)} dB weaker behind`}.`;
    return `<svg class="rlc-svg rlc-pattern" viewBox="0 0 300 312" role="img" aria-label="${escAttr(name)}">
      ${rings}${spokes}${wedge}
      <path class="rlc-pattern-fill" d="${polar(fn, C, C, R)}"/>
      <circle class="rlc-pin" cx="${C}" cy="${C}" r="3.5"/>
      <text class="rlc-grid-t rlc-grid-way" x="${side ? C + R + 28 : C}" y="${side ? 24 : 22}" text-anchor="${side ? 'end' : 'middle'}">${side ? (a.dir ? 'the way it points →' : 'the horizon →') : '↑ the way it points'}</text>
      <text class="rlc-lbl" x="${C}" y="302" text-anchor="middle">${side ? 'seen from the side' : 'seen from above'}</text>
    </svg>`;
  }

  // What the thing itself looks like on its pole.
  function antenna(id) {
    const a = ANTENNAS[id] || ANTENNAS.iso;
    let d = '';
    if (id === 'iso') {
      d = `<circle class="rlc-pin" cx="80" cy="70" r="5"/>${[0, 45, 90, 135, 180, 225, 270, 315].map(t => {
        const s = Math.sin(t * Math.PI / 180), c = Math.cos(t * Math.PI / 180);
        return `<path class="rlc-line rlc-thin" d="M${f1(80 + 12 * s)} ${f1(70 - 12 * c)} L${f1(80 + 34 * s)} ${f1(70 - 34 * c)}"/>`;
      }).join('')}`;
    } else if (id === 'whip') {
      d = '<path class="rlc-line" d="M80 132 V84 M80 84 V30"/><path class="rlc-line rlc-thin" d="M80 84 L52 102 M80 84 L108 102 M80 84 L64 108 M80 84 L96 108"/>';
    } else if (id === 'dipole') {
      d = '<path class="rlc-line" d="M60 132 V78 H80"/><path class="rlc-line rlc-heavy" d="M80 26 V74 M80 82 V130"/><circle class="rlc-pin" cx="80" cy="78" r="3"/>';
    } else if (id === 'col5' || id === 'col8') {
      const top = id === 'col8' ? 8 : 34;
      const marks = [];
      for (let y = top + 16; y < 104; y += 16) marks.push(`M76 ${y} h8`);
      d = `<path class="rlc-line" d="M80 132 V104"/><path class="rlc-box" d="M76 ${top} h8 v${104 - top} h-8z"/><path class="rlc-line rlc-thin" d="${marks.join(' ')}"/>`;
    } else {
      const n = a.els, x0 = 22, x1 = 138, gap = (x1 - x0) / (n - 1);
      const rods = [];
      for (let i = 0; i < n; i++) {
        const h = i === 0 ? 34 : i === 1 ? 31 : Math.max(18, 28 - (i - 2) * 2);
        rods.push(`M${f1(x0 + i * gap)} ${f1(60 - h)} V${f1(60 + h)}`);
      }
      d = `<path class="rlc-line" d="M70 132 V60"/><path class="rlc-line" d="M${x0 - 4} 60 H${x1 + 4}"/><path class="rlc-line rlc-heavy" d="${rods.join(' ')}"/>
        <path class="rlc-line rlc-thin" d="M${x1 + 8} 60 h12 m-5 -4 l5 4 l-5 4"/>`;
    }
    return `<svg class="rlc-svg rlc-ant" viewBox="0 0 160 140" role="img" aria-label="${escAttr(`${a.name}: ${a.what}`)}">${d}</svg>`;
  }

  // ── Power: the ladder from the radio to the air ─────────────────────────────

  // v: { tx, atAnt, eirp (watts), limits: [[watts, label, cls]], fails: { tx, atAnt, eirp } }
  function ladder(v) {
    const X0 = 150, X1 = 690, LO = -2, HI = 2.3;       // 0.01 W … 200 W
    const x = w => X0 + (Math.log10(Math.min(Math.max(w, 0.01), 200)) - LO) / (HI - LO) * (X1 - X0);
    const ticks = [0.01, 0.1, 1, 10, 100].map(w => `<path class="rlc-grid" d="M${f1(x(w))} 44 V178"/>
        <text class="rlc-grid-t" x="${f1(x(w))}" y="194" text-anchor="middle">${w >= 1 ? `${w} W` : `${w * 1000} mW`}</text>`).join('');
    const rows = [['Out of the radio', v.tx, v.fails.tx], ['Into the antenna', v.atAnt, v.fails.atAnt], ['EIRP — out of it', v.eirp, v.fails.eirp]];
    const bars = rows.map(([label, w, bad], i) => {
      const y = 56 + i * 42;
      return `<text class="rlc-lbl" x="${X0 - 8}" y="${y + 17}" text-anchor="end">${esc(label)}</text>
        <rect class="rlc-bar ${bad ? 'rlc-bar-bad' : 'rlc-bar-ok'}" x="${X0}" y="${y}" width="${f1(Math.max(2, x(w) - X0))}" height="26" rx="3"/>
        <text class="rlc-lbl rlc-lbl-b" x="${f1(Math.min(x(w) + 6, X1 - 56))}" y="${y + 17}">${esc(wattText(w))}</text>`;
    }).join('');
    const lims = (v.limits || []).map(([w, label, cls], i) => `<path class="rlc-limit ${cls || ''}" d="M${f1(x(w))} ${18 + (i % 2) * 14} V178"/>
        <text class="rlc-limit-t" x="${f1(x(w))}" y="${14 + (i % 2) * 14}" text-anchor="middle">${esc(label)}</text>`).join('');
    return `<svg class="rlc-svg rlc-ladder" viewBox="0 0 720 200" role="img"
        aria-label="${escAttr(`Power on its way out: ${wattText(v.tx)} from the radio, ${wattText(v.atAnt)} into the antenna, ${wattText(v.eirp)} EIRP.`)}">
      ${ticks}${bars}${lims}
    </svg>`;
  }
  function wattText(w) {
    if (!Number.isFinite(w)) return '—';
    if (w < 1) return `${num(w * 1000, w < 0.01 ? 1 : 0)} mW`;
    return `${num(w, w < 10 ? 2 : 1)} W`;
  }

  // ── Timing: a minute of a gauge's bursts ────────────────────────────────────

  // v: { dur, gap (seconds), badDur, badGap, badDuty }
  function timeline(v) {
    const X0 = 20, X1 = 700, span = 60, px = (X1 - X0) / span;
    const gap = Math.max(0.5, v.gap), dur = Math.max(0.02, v.dur);
    const bursts = [];
    for (let t = 0; t < span && bursts.length < 130; t += gap) {
      bursts.push(`<rect class="rlc-burst ${v.badDur || v.badGap || v.badDuty ? 'rlc-burst-bad' : ''}" x="${f1(X0 + t * px)}" y="34" width="${f1(Math.max(4, Math.min(dur, span - t) * px))}" height="40" rx="1.5"/>`);
    }
    const ticks = [0, 10, 20, 30, 40, 50, 60].map(t => `<path class="rlc-grid" d="M${f1(X0 + t * px)} 76 v8"/>
        <text class="rlc-grid-t" x="${f1(X0 + t * px)}" y="98" text-anchor="middle">${t} s</text>`).join('');
    return `<svg class="rlc-svg rlc-timeline" viewBox="0 0 720 112" role="img"
        aria-label="${escAttr(`One minute on the air: a burst of ${num(v.dur, 2)} seconds every ${num(v.gap)} seconds — on the air ${num(100 * Math.min(1, v.dur / v.gap), 2)} per cent of the time.`)}">
      <rect class="rlc-clear" x="${X0}" y="34" width="${f1(10 * px)}" height="40"/>
      <text class="rlc-grid-t" x="${X0}" y="24">10 s — the least between starts</text>
      <path class="rlc-line rlc-thin" d="M${X0} 76 H${X1}"/>
      ${ticks}${bursts.join('')}
      <path class="rlc-sweep" d="M${X0} 30 V80"/>
    </svg>`;
  }

  // ── A holder's bases by EIRP ────────────────────────────────────────────────

  // rows: [[label, count, cls]]
  function bars(rows, name) {
    const max = Math.max(1, ...rows.map(r => r[1]));
    const H = 26, W = 720, X0 = 150, X1 = 650;
    return `<svg class="rlc-svg rlc-bars" viewBox="0 0 ${W} ${rows.length * H + 12}" role="img" aria-label="${escAttr(name)}">
      ${rows.map(([label, n, cls], i) => `<text class="rlc-lbl" x="${X0 - 8}" y="${i * H + 23}" text-anchor="end">${esc(label)}</text>
        <rect class="rlc-bar ${cls || 'rlc-bar-ok'}" x="${X0}" y="${i * H + 8}" width="${f1(Math.max(1, n / max * (X1 - X0)))}" height="18" rx="3"/>
        <text class="rlc-lbl rlc-lbl-b" x="${f1(X0 + n / max * (X1 - X0) + 6)}" y="${i * H + 22}">${n}</text>`).join('')}
    </svg>`;
  }

  return { ANTENNAS, lobeDb, ringDb, scene, system, explorer, placeExplorer, shapes, pattern, antenna, ladder, timeline, bars, wattText, num };
})();

if (typeof window !== 'undefined') window.LicensingDraw = LicensingDraw;
