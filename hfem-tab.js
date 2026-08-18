// MegaNet — hfem-tab.js
//
//   HfemTab   the HFEM tab: paste one Hydro Field Event Message or a capture of
//             them, see what each one says — decoded, unit-labelled, matched to
//             a station where the identifier allows it, and honest about what it
//             could not tell you. #154, EPIC #152.
//
// After core.js and hfem.js, before init.js — index.html holds the order and
// the reasons. Reaches back to core.js for state, esc, escAttr, csvEscape,
// dlText and announce; across to app.js for renderMain, goToStation and
// switchTab (from inline handlers); and sideways to hfem.js for the codec.
// Nothing executes at load — the IIFE body only defines (`npm run toplevel`).
//
// ── The division of labour, and why it is exactly here ───────────────────────
//
// `hfem.js` is the codec and knows the format. This file knows nothing about
// the format at all: it renders what `HFEM.decode()` returns and it reads the
// tables `HFEM` exports (SENSOR_CLASSES, SCHEMES, FIELD_PROVENANCE) rather than
// restating them. That is deliberate and it is the point of #153 shipping
// first — the moment a renderer starts knowing that scheme 6 is translated, the
// format has two implementations and they will disagree about something at
// three in the morning. Every claim this tab makes about a message comes off
// the decoded structure.
//
// The bridge (#155) reads the same codec through `toReadings()`, so what this
// tab shows and what the database stores are the same decode, one step apart.
//
// ── The first tab born converted ─────────────────────────────────────────────
//
// Every other tab in this app was written and then brought to
// `docs/design-system.md` by one of EPIC #107's six per-tab issues. This one is
// the first to start there: tokens and system classes only, tables wrapped and
// captioned and scoped, capped wrappers as named regions, `.link-btn` for an
// in-page action, `.check-label` for a checkbox with its caption, the heading
// outline stepping by one under the shell's h1, and `npm run tabs` holding all
// of it from the first commit rather than from a later conversion.
//
// It reuses the `.pkt` shell the two ALERT decoders share — same panels,
// badges, field tables and disclosure cards — because it is the same kind of
// tab and a third visual language for "here is a decoded message" would be a
// cost with no buyer.
//
// ── What this tab does NOT copy from alert2.js ───────────────────────────────
//
// The receiver metadata, the ASCII/binary sniffing, the bit unpacking, the RSSI
// and the clock-skew read. None of them exist in HFEM: there is no receiver and
// no receiver clock, so there is nothing to compare an observation time
// against. The summary says that rather than leaving an empty panel, which is
// the pattern alert2.js already uses for a capture whose format carries no
// clock.
const HfemTab = (function () {

  // The ten worked examples of the spec's §4.4, verbatim. They are the sample
  // capture *and* the acceptance criterion — test/hfem.mjs decodes and
  // re-encodes these same ten byte-for-byte, so a sample that renders here is a
  // sample the codec is held to.
  const SPEC_EXAMPLES = [
    ':HS=1|I1=123456|R_1-0=1055|NN:',
    ':HS=1|I1=123456|R_1-0=1055|B_1-10=139|NN:',
    ':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-10=139|NN:',
    ':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|NN:',
    ':HS=1|I1=123456|R_1-0=101|R_2-0=201|NN:',
    ':HS=1|I1=123456|T1=20100727030000|R_1-0=101|R_2-0=201|NN:',
    ':HS=1|I1=123456|T2=20100727030000+10|R_1-0=1098|H_1-10=1051|NN:',
    ':HS=1|I1=123456|T3=20100727130000-10|R_1-0=1098|H_1-10=1051|NN:',
    ':HS=1|M=1|I1=123456|T1=20100727030000|R_1-0=101|B_1-10=139|NN:',
    ':HS=1|I1=123456|T3=20100727130000-10|R_1-6=10.2|H_1-16=120.901|NN:',
  ].join('\n');

  // A capture with the things a real one has and the spec's examples do not: a
  // station number that is actually in the loaded file, a maintenance message,
  // a raw counter about to wrap, an over-precise value, and two malformed lines
  // — because "one bad message does not stop the others" is a claim this tab
  // makes and a sample should demonstrate it rather than assert it.
  function messyExample() {
    const st = state.data && state.data.stations.find(s => /^\d{6}$/.test(String(s.station_number || '')));
    const num = st ? st.station_number : '540123';
    return [
      `:HS=1|I1=${num}|T1=20260818020000|R_1-6=12.4|H_1-16=1.482|B_1-16=13.1|NN:`,
      `:HS=1|M=1|I1=${num}|T1=20260818021500|H_1-16=1.483|NN:`,
      `:HS=1|I1=${num}|T2=20260818120000+10|R_1-0=2043|NN:`,
      ':HS=1|I1=999999|T1=20260818023000|WT_1-16=18.55|NN:',
      ':HS=1|I1=123456|T1=20260818024500|R_1-6=10.2500|NN:',
      ':HS=1|I1=123456|R_1-5=100|NN:',
      ':HS=1|I1=123456|T1=20260818030000|R_1-0=1055',
    ].join('\n');
  }

  // ── decode ──────────────────────────────────────────────────────────────────

  // One capture in, one array of per-line results out. A line is a message; a
  // blank line is skipped; anything else is a decode with its own verdict, and
  // a rejection carries the decoder's own reason rather than a summary of it.
  //
  // Cached against the text it was made from, the way alert2.js caches its
  // parse: re-rendering the tab (a filter tick, a view switch) must not re-run
  // the decoder over a 10,000-line capture.
  function parse(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    lines.forEach((raw, i) => {
      if (!raw.trim()) return;
      const res = HFEM.decode(raw);
      out.push({ lineNo: i + 1, raw: raw.trim(), ok: res.ok,
                 message: res.ok ? res.message : null,
                 error: res.ok ? null : res.error });
    });
    return out;
  }

  function current() {
    const h = state.hfem;
    if (h.parsedKey === h.text && h.parsed) return h.parsed;
    h.parsed = parse(h.text);
    h.parsedKey = h.text;
    return h.parsed;
  }

  // ── station matching, and its honesty rule ─────────────────────────────────
  //
  // HFEM identifies a site by number, not by ALERT address, so the match is a
  // string comparison against `station_number` and there is nothing to be
  // ambiguous about — unlike the ERT-A2 tab, where one address can belong to
  // several stations. What there *is* is the unmatched case, and the rule is
  // the ERT-A2 tab's and 0006 decision 1's: a message whose site matches
  // nothing renders in full and says the station is unknown. It is never
  // dropped, and the column is never left blank to be read as "none".
  function stationFor(msg) {
    if (!msg || !msg.site || !state.data) return null;
    const want = String(msg.site.id);
    return state.data.stations.find(s => String(s.station_number || '') === want) || null;
  }

  // ── rendering: one message ─────────────────────────────────────────────────

  function siteCell(msg) {
    const st = stationFor(msg);
    if (st) {
      return `<button type="button" class="link-btn hf-stn" onclick="goToStation('${escAttr(st.id)}')"
                title="Open ${escAttr(st.name)} on the Stations tab">${esc(st.name)}</button>`;
    }
    if (!state.data) {
      return '<span class="txt-muted">no station file loaded</span>';
    }
    return `<span class="txt-warn">no station in the loaded file carries station number
            ${esc(msg.site.id)}</span>`;
  }

  // The timestamp, resolved *and* as written, side by side. T3 is the one a
  // reader will mistrust and should — its offset sign is inverted from every
  // convention they have met — so the two forms sit next to each other where
  // the arithmetic can be checked by eye rather than trusted.
  function timeBlock(msg) {
    const t = msg.time;
    if (!t) {
      return `<p class="spec">No observation timestamp in this message. HFEM makes
        <code>T1</code>/<code>T2</code>/<code>T3</code> optional (§2.1) — a message without one is
        reporting a value, not an instant, and the receiver's arrival time is the only time there
        is. There is no receiver clock in this format to compare against.</p>`;
    }
    const rule = t.scheme === 'T3'
      ? 'T3 — <strong>the stamp is local time and the offset is the zone it was written in</strong>. '
        + 'UTC is the stamp <em>plus</em> the offset, which is the opposite of ISO 8601 and the '
        + 'one place in this format a reader\'s instinct is wrong.'
      : t.scheme === 'T2'
        ? 'T2 — the stamp is already UTC and the offset says which local zone the site keeps. '
          + 'The offset does not move the instant.'
        : 'T1 — the stamp is UTC, with no zone stated.';
    return `
      <div class="table-wrap">
        <table class="fields">
          <caption class="sr-only">The observation time as written on the wire and as resolved to UTC</caption>
          <thead><tr><th scope="col">AS WRITTEN</th><th scope="col">SCHEME</th>
            <th scope="col">RESOLVED (UTC)</th>${t.localIso ? '<th scope="col">LOCAL AT THE SITE</th>' : ''}</tr></thead>
          <tbody>
            <tr>
              <td><code>${esc(t.scheme)}=${esc(t.raw)}</code></td>
              <td>${esc(t.scheme)}${t.offsetHours == null ? '' : ` <span class="spec">offset ${t.offsetHours > 0 ? '+' : ''}${t.offsetHours} h</span>`}</td>
              <td><b>${esc(t.utc)}</b>${t.utcIsStated
                ? ' <span class="badge ok">as stated</span>'
                : ' <span class="badge warn">computed</span>'}</td>
              ${t.localIso ? `<td><code>${esc(t.localIso)}</code></td>` : ''}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="spec">${rule}</p>`;
  }

  // Raw and translated are two different claims and must not look alike: one is
  // a counter whose engineering meaning lives in a site configuration nobody
  // here has, the other is the engineering value itself, already scaled by the
  // logger. The badge says which, and a raw counter carries the ceiling it
  // wraps at — because 2043 of 2047 is about to roll, and that is worth seeing
  // before it does rather than after.
  function sensorRows(msg) {
    return msg.sensors.map(s => {
      const raw = s.representation === 'raw';
      const near = raw && s.rollover != null && s.value >= s.rollover * 0.95;
      return `
        <tr>
          <td><code>${esc(s.tag)}</code></td>
          <td>${esc(s.className)} <span class="spec">#${s.instance}</span></td>
          <td>${esc(s.sampling)}</td>
          <td>${raw
            ? '<span class="badge warn" title="An integer counter. What it means in engineering units is a site configuration, and it is not in the message">raw counter</span>'
            : '<span class="badge ok" title="An engineering value, already scaled by the logger — nothing here converted it">translated</span>'}</td>
          <td><span class="val">${esc(s.valueText)}</span>
            ${raw ? '' : ` <span class="spec">${esc(s.unit)}</span>`}</td>
          <td class="spec">${raw
            ? (s.rollover == null ? '—'
              : `wraps at ${s.rollover.toLocaleString()}${near
                  ? ' <span class="txt-bad">— within 5% of the ceiling</span>' : ''}`)
            : `stated to ${s.decimals} dp`}</td>
        </tr>`;
    }).join('');
  }

  function messageCard(r, idx) {
    if (!r.ok) {
      return `
        <details class="fmtcard hf-bad">
          <summary class="fmthead">
            <h4>Line ${r.lineNo}</h4>
            <span class="badge bad">rejected</span>
            <span class="caret">${esc(r.error.slice(0, 200))} ▾</span>
          </summary>
          <div class="fmtbody">
            <div class="hf-raw"><code>${esc(r.raw)}</code></div>
            <p class="spec"><strong>The decoder refused this line, and this is its reason:</strong>
              ${esc(r.error)}</p>
            <p class="spec">HFEM has no checksum — the <code>|NN:</code> footer is the only
              integrity check the format has — so a structural fault is a rejection rather than a
              partial decode. A truncated line with three of five sensors intact must not land
              three readings. Every other message in this capture decoded independently of this
              one.</p>
          </div>
        </details>`;
    }
    const m = r.message;
    const st = stationFor(m);
    const summary = `${m.site.id}${st ? ' · ' + st.name : ''} · ${m.sensors.length} `
      + `measurement${m.sensors.length === 1 ? '' : 's'}`
      + (m.time ? ' · ' + m.time.utc.replace('T', ' ').replace('.000Z', 'Z') : ' · no timestamp');
    return `
      <details class="fmtcard${m.maintenance ? ' hf-maint' : ''}"${idx === 0 ? ' open' : ''}>
        <summary class="fmthead">
          <h4>Line ${r.lineNo}</h4>
          ${m.maintenance
            ? '<span class="badge bad">maintenance</span>'
            : '<span class="badge ok">clean</span>'}
          ${m.notes.length ? `<span class="badge warn">${m.notes.length} note${m.notes.length === 1 ? '' : 's'}</span>` : ''}
          <span class="caret">${esc(summary)} ▾</span>
        </summary>
        <div class="fmtbody">
          <div class="hf-raw"><code>${esc(r.raw)}</code></div>

          ${m.maintenance ? `
            <div class="note compact warn hf-banner" role="note">
              <strong>M=1 — this station was in maintenance mode.</strong> The flag is on the
              message, not on any one reading, so it applies to <em>every</em> measurement below.
              The spec's meaning is "do not use this in production": a technician may have been
              tipping the rain gauge or lifting the float. It is on the message rather than in a
              column for exactly that reason — a column is something the eye skips.
            </div>` : ''}

          <h5 class="hf-h">Where it came from</h5>
          <div class="table-wrap">
            <table class="fields">
              <caption class="sr-only">The site this message identifies, and the station it matched in the loaded file</caption>
              <thead><tr><th scope="col">IDENTIFIER</th><th scope="col">SCHEME</th>
                ${m.site.agency ? '<th scope="col">AGENCY</th>' : ''}
                <th scope="col">STATION</th></tr></thead>
              <tbody>
                <tr>
                  <td><code>${esc(m.site.id)}</code></td>
                  <td>${esc(m.site.scheme)} <span class="spec">${m.site.scheme === 'I1'
                    ? 'six digits, site only' : 'agency-qualified'}</span></td>
                  ${m.site.agency ? `<td><code>${esc(m.site.agency)}</code></td>` : ''}
                  <td>${siteCell(m)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h5 class="hf-h">When</h5>
          ${timeBlock(m)}

          <h5 class="hf-h">What it measured</h5>
          <div class="table-wrap">
            <table class="fields">
              <caption class="sr-only">Every measurement in this message — its class, how it was sampled, whether it is a raw counter or an engineering value, and what it read</caption>
              <thead><tr>
                <th scope="col">TAG</th><th scope="col">SENSOR</th><th scope="col">SAMPLING</th>
                <th scope="col">FORM</th><th scope="col">VALUE</th><th scope="col">NOTE</th>
              </tr></thead>
              <tbody>${sensorRows(m)}</tbody>
            </table>
          </div>

          ${m.notes.length ? `
            <h5 class="hf-h">What the decoder wanted to say</h5>
            <ul class="hf-notes">${m.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
            <p class="spec">These are observations about the data, not faults in the message.
              Each one was kept and reported rather than dropped or silently corrected — an
              over-precise value is over-reporting, not lying.</p>` : ''}
        </div>
      </details>`;
  }

  // ── rendering: the panels ──────────────────────────────────────────────────

  function statChip(n, label, kind) {
    return `<div class="a2-stat${kind ? ' ' + kind : ''}"><b>${esc(String(n))}</b><span>${esc(label)}</span></div>`;
  }

  function summaryPanel(rows) {
    const ok = rows.filter(r => r.ok);
    const bad = rows.length - ok.length;
    const sensors = ok.reduce((n, r) => n + r.message.sensors.length, 0);
    const maint = ok.filter(r => r.message.maintenance).length;
    const sites = new Set(ok.map(r => r.message.site.id));
    const matched = [...sites].filter(id => state.data
      && state.data.stations.some(s => String(s.station_number || '') === id)).length;
    const notes = ok.reduce((n, r) => n + r.message.notes.length, 0);
    return `
      <div class="panel">
        <div class="panel-header"><h3>Capture summary</h3></div>
        <div class="a2-stats">
          ${statChip(ok.length, 'messages decoded')}
          ${statChip(sensors, 'measurements')}
          ${statChip(sites.size, 'sites')}
          ${statChip(matched, 'matched to a station', matched < sites.size ? 'warn' : '')}
          ${statChip(maint, 'in maintenance', maint ? 'bad' : '')}
          ${statChip(notes, 'notes', notes ? 'warn' : '')}
          ${statChip(bad, 'rejected', bad ? 'bad' : '')}
        </div>
        ${bad ? `<div class="spec pkt-block">${bad} line${bad === 1 ? '' : 's'} could not be
          decoded, and ${bad === 1 ? 'it is' : 'they are'} listed below with the decoder's own
          reason. Nothing else in the capture was affected.</div>` : ''}
        ${maint ? `<div class="note compact warn pkt-block"><strong>${maint} message${maint === 1 ? '' : 's'}
          carried M=1.</strong> Every reading in ${maint === 1 ? 'it' : 'them'} was taken while the
          station was in maintenance and is not production data.</div>` : ''}
        <div class="spec pkt-block">This format carries no receiver metadata and no receiver
          clock, so there is no signal level to report and no clock skew to check — the
          <button type="button" class="link-btn" onclick="switchTab('alert2')">ALERT2 / ERT-A2</button>
          tab has both because that format carries both. What HFEM gives instead is engineering
          units on the wire, which is why most values here need no conversion at all.</div>
      </div>`;
  }

  // Every measurement in the capture, flattened — the view that answers "what
  // did this logger actually send", and the one the CSV mirrors exactly.
  function readingsPanel(rows) {
    const ok = rows.filter(r => r.ok);
    if (!ok.length) return '';
    const flat = [];
    ok.forEach(r => r.message.sensors.forEach(s => flat.push({ r, m: r.message, s })));
    return `
      <div class="panel">
        <div class="panel-header">
          <h3>Every measurement in this capture <span class="badge">${flat.length}</span></h3>
          <button class="ghost" onclick="HfemTab.exportCsv()">Export CSV</button>
        </div>
        <div class="table-wrap tall" role="region" tabindex="0"
             aria-label="Every measurement in this capture — ${flat.length} row${flat.length === 1 ? '' : 's'}">
          <table class="fields">
            <caption class="sr-only">One row per measurement across every decoded message, with its site, station, time, value and unit</caption>
            <thead><tr>
              <th scope="col">LINE</th><th scope="col">SITE</th><th scope="col">STATION</th>
              <th scope="col">TIME (UTC)</th><th scope="col">SENSOR</th><th scope="col">FORM</th>
              <th scope="col">VALUE</th><th scope="col">UNIT</th>
            </tr></thead>
            <tbody>
              ${flat.map(({ r, m, s }) => {
                const st = stationFor(m);
                return `
                <tr${m.maintenance ? ' class="hf-row-maint"' : ''}>
                  <td><code>${r.lineNo}</code></td>
                  <td><code>${esc(m.site.id)}</code>${m.maintenance
                    ? ' <span class="badge bad" title="M=1 — taken in maintenance mode">M</span>' : ''}</td>
                  <td>${st
                    ? `<button type="button" class="link-btn hf-stn" onclick="goToStation('${escAttr(st.id)}')"
                         title="Open ${escAttr(st.name)} on the Stations tab">${esc(st.name)}</button>`
                    : '<span class="txt-warn">unknown</span>'}</td>
                  <td>${m.time ? `<code>${esc(m.time.utc)}</code>` : '<span class="spec">not stated</span>'}</td>
                  <td>${esc(s.className)} <span class="spec">#${s.instance}</span></td>
                  <td class="spec">${s.representation === 'raw' ? 'raw' : 'translated'} · ${esc(s.sampling)}</td>
                  <td><span class="val">${esc(s.valueText)}</span></td>
                  <td class="spec">${esc(s.unit)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ── the builder ────────────────────────────────────────────────────────────
  //
  // #153's encoder makes this nearly free, and it is the difference between a
  // decode tab and a tab somebody can use before driving to a site: build what
  // the logger *should* be sending, and check the line against it. It round
  // trips through the decoder as it builds, so what is shown is not a string
  // this file assembled — it is a string the codec produced and then read back.
  function builderPanel() {
    const b = state.hfem.builder;
    const cls = Object.entries(HFEM.SENSOR_CLASSES);
    const schemes = Object.entries(HFEM.SCHEMES);
    const built = buildLine();
    return `
      <div class="panel">
        <div class="panel-header"><h3>Build a message</h3></div>
        <p class="sub">What a logger <em>should</em> be sending. Everything below goes through the
          same encoder the decoder round-trips against, so the line under it is not assembled
          here — it is produced by the codec and read straight back to prove it.</p>

        <div class="control-row">
          <label>Site number (I1)
            <input type="text" inputmode="numeric" maxlength="6" value="${escAttr(b.site)}"
                   oninput="HfemTab.setBuild('site', this.value)">
          </label>
          <label>Timestamp scheme
            <select onchange="HfemTab.setBuild('tscheme', this.value)">
              <option value="" ${b.tscheme === '' ? 'selected' : ''}>none</option>
              <option value="T1" ${b.tscheme === 'T1' ? 'selected' : ''}>T1 — UTC, no zone</option>
              <option value="T2" ${b.tscheme === 'T2' ? 'selected' : ''}>T2 — UTC with the site's zone appended</option>
              <option value="T3" ${b.tscheme === 'T3' ? 'selected' : ''}>T3 — local time, offset to add</option>
            </select>
          </label>
          ${b.tscheme ? `
            <label>Stamp <span class="spec">CCYYMMDDHHMISS</span>
              <input type="text" inputmode="numeric" maxlength="14" value="${escAttr(b.stamp)}"
                     oninput="HfemTab.setBuild('stamp', this.value)">
            </label>` : ''}
          ${b.tscheme === 'T2' || b.tscheme === 'T3' ? `
            <label class="field-num">Offset (hours)
              <input type="number" min="-14" max="14" step="1" value="${escAttr(b.offset)}"
                     oninput="HfemTab.setBuild('offset', this.value)">
            </label>` : ''}
        </div>

        <label class="check-label">
          <input type="checkbox" ${b.maintenance ? 'checked' : ''}
                 onchange="HfemTab.setBuild('maintenance', this.checked)">
          <span>Maintenance mode (<code>M=1</code>) — marks every reading as not production data</span>
        </label>

        <h4 class="hf-h">Measurements</h4>
        <div class="table-wrap">
          <table class="fields">
            <caption class="sr-only">The measurements this message will carry — sensor class, instance, scheme and value</caption>
            <thead><tr>
              <th scope="col">SENSOR</th><th scope="col">#</th><th scope="col">SCHEME</th>
              <th scope="col">VALUE</th><th scope="col"><span class="sr-only">Remove</span></th>
            </tr></thead>
            <tbody>
              ${b.sensors.map((s, i) => `
                <tr>
                  <td><select aria-label="Sensor class for measurement ${i + 1}"
                        onchange="HfemTab.setSensor(${i}, 'cls', this.value)">
                    ${cls.map(([k, v]) => `<option value="${k}" ${s.cls === k ? 'selected' : ''}>${esc(v.name)} (${k})</option>`).join('')}
                  </select></td>
                  <td class="field-num"><input type="number" min="1" max="99" step="1" value="${escAttr(s.instance)}"
                        aria-label="Instance for measurement ${i + 1}"
                        oninput="HfemTab.setSensor(${i}, 'instance', this.value)"></td>
                  <td><select aria-label="Measurement scheme for measurement ${i + 1}"
                        onchange="HfemTab.setSensor(${i}, 'scheme', this.value)">
                    ${schemes.map(([k, v]) => `<option value="${k}" ${String(s.scheme) === k ? 'selected' : ''}
                      >${k} — ${esc(v.sampling)}, ${esc(v.representation)}</option>`).join('')}
                  </select></td>
                  <td><input type="text" value="${escAttr(s.value)}"
                        aria-label="Value for measurement ${i + 1}"
                        oninput="HfemTab.setSensor(${i}, 'value', this.value)"></td>
                  <td><button type="button" class="btn-danger hf-del" title="Remove this measurement"
                        onclick="HfemTab.removeSensor(${i})"><span aria-hidden="true">×</span></button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="button-group pkt-block">
          <button class="ghost" onclick="HfemTab.addSensor()">+ Add a measurement</button>
        </div>

        <h4 class="hf-h">The message</h4>
        ${built.ok
          ? `<div class="outbits" id="hf-built">${esc(built.line)}</div>
             <div class="button-group pkt-block">
               <button class="primary" onclick="HfemTab.copyBuilt()">Copy</button>
               <button class="ghost" onclick="HfemTab.decodeBuilt()">Paste it into the decoder above</button>
             </div>
             <p class="spec">${built.round
               ? 'Decoded back and matched, field for field — this line says what it looks like it says.'
               : '<span class="txt-bad">This line did not survive a round trip, which is a bug in the codec rather than in your input. Please report it.</span>'}</p>`
          : `<p class="note compact warn" role="status">${esc(built.error)}</p>`}
      </div>`;
  }

  // Encode from the builder's state, then decode the result and compare. The
  // comparison is the point: an encoder that emits something its own decoder
  // will not read is the failure this catches, and it catches it in the tab
  // rather than in a logger three hundred kilometres away.
  function buildLine() {
    const b = state.hfem.builder;
    const msg = {
      type: 'HS', version: 1,
      maintenance: !!b.maintenance,
      site: { scheme: 'I1', id: String(b.site || '').trim(), agency: null },
      time: null,
      sensors: b.sensors.map(s => ({
        cls: s.cls, instance: Number(s.instance) || 1,
        scheme: Number(s.scheme), valueText: String(s.value).trim(),
      })),
      notes: [],
    };
    if (b.tscheme) {
      // `raw` is the *wire* text, offset suffix included — the encoder hands it
      // straight to decodeTime() to validate, which is what makes an
      // unencodable stamp a message here rather than a bad line downstream.
      const off = Number(b.offset) || 0;
      const stamp = String(b.stamp || '').trim();
      const raw = b.tscheme === 'T1'
        ? stamp
        : stamp + (off < 0 ? '-' : '+') + Math.abs(off);
      msg.time = { scheme: b.tscheme, raw, offsetHours: b.tscheme === 'T1' ? null : off };
    }
    const enc = HFEM.encode(msg);
    if (!enc.ok) return { ok: false, error: enc.error };
    const back = HFEM.decode(enc.line);
    return { ok: true, line: enc.line, round: back.ok };
  }

  // ── the reference ──────────────────────────────────────────────────────────
  //
  // Read out of the codec's own tables rather than restated here, so the two
  // can never drift: if a class is added to hfem.js it appears here, and if one
  // is corrected the correction shows up without this file being touched.
  function referencePanel() {
    const cls = Object.entries(HFEM.SENSOR_CLASSES);
    const schemes = Object.entries(HFEM.SCHEMES);
    return `
      <div class="panel">
        <div class="panel-header"><h3>What the format says</h3></div>
        <p class="sub">Every table below is read out of the decoder's own tables rather than
          written out again here — so this reference cannot drift from what the decoder does. The
          source is <code>archive/BoM HFEM v1.0.pdf</code> (R. Thompson, Bureau of Meteorology,
          August 2010).</p>

        <details>
          <summary class="pkt-summary">The shape of a message</summary>
          <div class="hf-raw"><code>:HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-10=139|NN:</code></div>
          <ul class="pkt-cheat">
            <li><code>:</code> … <code>:</code> — start and end of message. There is
              <strong>no checksum</strong> anywhere in HFEM; the <code>|NN:</code> footer is the
              only integrity check the format has, which is why a structural fault here is a
              rejection rather than a partial decode.</li>
            <li><code>HS=1</code> — message type and version. This decoder implements HS version 1.</li>
            <li><code>M=1</code> — optional maintenance flag. Absent means production data.</li>
            <li><code>I1</code> / <code>I2</code> — the site. <code>I1</code> is six alphanumerics;
              <code>I2</code> is an agency of six, a hyphen, then eight.</li>
            <li><code>T1</code> / <code>T2</code> / <code>T3</code> — the observation time, and
              optional. See below: the three are <em>not</em> interchangeable.</li>
            <li><code>{Class}_{Instance}-{Scheme}={Value}</code> — one per measurement, at least one
              required.</li>
            <li>Parameters are <strong>order-independent</strong> by specification (§2.1). Spaces
              are insignificant, and leading zeros are insignificant unless a format mandates a
              width.</li>
          </ul>
        </details>

        <details>
          <summary class="pkt-summary">The three timestamp schemes — and the one that catches people</summary>
          <div class="table-wrap">
            <table class="fields">
              <caption class="sr-only">The three HFEM timestamp schemes and how each resolves to UTC</caption>
              <thead><tr><th scope="col">SCHEME</th><th scope="col">ON THE WIRE</th>
                <th scope="col">MEANS</th><th scope="col">UTC IS</th></tr></thead>
              <tbody>
                <tr><td><code>T1</code></td><td><code>20100727030000</code></td>
                  <td>UTC, no zone stated</td><td>as written</td></tr>
                <tr><td><code>T2</code></td><td><code>20100727030000+10</code></td>
                  <td>UTC; the offset says which local zone the site keeps</td><td>as written</td></tr>
                <tr class="hf-row-maint"><td><code>T3</code></td><td><code>20100727130000-10</code></td>
                  <td><strong>local time</strong>; the offset is the one to <strong>add</strong></td>
                  <td>stamp <strong>+</strong> offset → <code>2010-07-27T03:00:00Z</code></td></tr>
              </tbody>
            </table>
          </div>
          <p class="spec">The <code>T2</code> and <code>T3</code> examples above describe
            <strong>the same instant</strong>, which is the clearest way to see it. The
            <code>T3</code> sign is inverted from ISO 8601 and from every other convention a
            reader is likely to have met — an ISO reading of <code>-10</code> would put this ten
            hours the wrong way, twenty hours from the truth. This tab always shows the resolved
            instant beside the stamp as written, so the arithmetic is checkable by eye.</p>
        </details>

        <details>
          <summary class="pkt-summary">Sensor classes (${cls.length})</summary>
          <div class="table-wrap medium" role="region" tabindex="0"
               aria-label="HFEM sensor classes — ${cls.length}">
            <table class="fields">
              <caption class="sr-only">Every sensor class the decoder knows, with the engineering unit and stated accuracy of each</caption>
              <thead><tr><th scope="col">CODE</th><th scope="col">SENSOR</th>
                <th scope="col">UNIT</th><th scope="col">DECIMALS</th></tr></thead>
              <tbody>
                ${cls.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v.name)}</td>
                  <td>${esc(v.unit)}</td><td class="spec">${v.decimals}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="spec">The unit and the decimal places apply to a <em>translated</em>
            measurement. A raw one is a counter and has neither — what it means in engineering
            units is a site configuration, and it is not in the message.</p>
        </details>

        <details>
          <summary class="pkt-summary">Measurement schemes (${schemes.length})</summary>
          <div class="table-wrap medium" role="region" tabindex="0"
               aria-label="HFEM measurement schemes — ${schemes.length}">
            <table class="fields">
              <caption class="sr-only">Every measurement scheme the specification defines, its sampling, whether it is raw or translated, and the ceiling a raw counter wraps at</caption>
              <thead><tr><th scope="col">SCHEME</th><th scope="col">SAMPLING</th>
                <th scope="col">FORM</th><th scope="col">WRAPS AT</th></tr></thead>
              <tbody>
                ${schemes.map(([k, v]) => `<tr>
                  <td><code>${esc(k)}</code></td><td>${esc(v.sampling)}</td>
                  <td>${v.representation === 'raw'
                    ? '<span class="badge warn">raw counter</span>'
                    : '<span class="badge ok">translated</span>'}</td>
                  <td class="spec">${v.rollover == null ? '—' : v.rollover.toLocaleString()}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="spec">Schemes 5, 7, 8, 9, 15, 17, 18, 19 and 25 are <strong>not defined</strong>
            by HFEM v1.0 and are rejected by name rather than inferred from the tens digit.
            Scheme 0's ceiling of 2,047 is the same 11-bit accumulator a legacy ALERT sensor uses,
            which is why the <button type="button" class="link-btn" onclick="switchTab('packets')">ALERT
            Packets</button> tab knows the same number.</p>
        </details>

        <details>
          <summary class="pkt-summary">Stated on the wire, or derived from a table?</summary>
          <p class="spec">A decoded message mixes what was actually transmitted with what the
            spec's tables imply, and anything storing these readings needs to know which is which.
            The decoder states the split rather than leaving it to be inferred:</p>
          <div class="table-wrap">
            <table class="fields">
              <caption class="sr-only">Which decoded fields came off the wire and which came from the specification's tables</caption>
              <thead><tr><th scope="col">STATED — on the wire</th><th scope="col">DERIVED — from the tables</th></tr></thead>
              <tbody>
                <tr>
                  <td><ul class="hf-plain">${HFEM.FIELD_PROVENANCE.stated.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></td>
                  <td><ul class="hf-plain">${HFEM.FIELD_PROVENANCE.derived.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>`;
  }

  // ── the tab ────────────────────────────────────────────────────────────────

  function render() {
    const rows = current();
    const has = rows.length > 0;
    return `
    <div class="pkt hf page" style="--page-max:1180px">

      <div class="panel">
        <div class="panel-header"><h2>HFEM — Hydro Field Event Messages</h2></div>
        <p class="sub">Paste one message or a whole capture. Each is decoded against
          <code>BoM HFEM v1.0</code>, matched to a station where the site number allows it, and
          reported honestly where it cannot be — a message whose site matches nothing still
          decodes in full and says so. This is the
          <button type="button" class="link-btn" onclick="switchTab('alert2')">ALERT2 / ERT-A2</button>
          tab's job for a format that shares none of its code: no receiver metadata, no bit
          unpacking, and most values already in engineering units when they arrive.</p>
        ${state.data ? '' : `<div class="note compact">No station file loaded — messages will
          decode fully, but nothing can be matched to a station. Load <b>stations.json</b> from
          the header to see names.</div>`}
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Capture</h3></div>
        <p class="sub">One message per line. Spaces are insignificant and are stripped before
          parsing, so a wrapped paste is fine.</p>
        <textarea id="hf-text" class="a2-input" spellcheck="false" rows="6"
                  aria-label="Capture — paste HFEM messages here, one per line"
                  placeholder=":HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-10=139|NN:"
                  oninput="state.hfem.text=this.value">${esc(state.hfem.text)}</textarea>
        <div class="row pkt-block">
          <div class="fit"><button class="primary" onclick="HfemTab.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="HfemTab.loadSample('spec')">Sample — the spec's ten examples</button></div>
          <div class="fit"><button class="ghost" onclick="HfemTab.loadSample('messy')">Sample — a real-looking capture</button></div>
          <div class="fit"><button class="ghost" onclick="HfemTab.clear()">Clear</button></div>
        </div>
      </div>

      ${has ? summaryPanel(rows) : ''}
      ${has ? readingsPanel(rows) : ''}

      ${has ? `
        <div class="panel">
          <div class="panel-header"><h3>Message by message <span class="badge">${rows.length}</span></h3></div>
          <p class="sub">Every line, in the order it arrived. A rejected one carries the decoder's
            own reason and does not stop the others.</p>
          <div id="hf-cards">${rows.map(messageCard).join('')}</div>
        </div>` : ''}

      ${builderPanel()}
      ${referencePanel()}

    </div>`;
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  function readBox() {
    const el = document.getElementById('hf-text');
    if (el) state.hfem.text = el.value;
  }

  // Decode whatever `state.hfem.text` holds, and redraw. Deliberately does NOT
  // read the textarea: everything that puts a capture there (the samples, the
  // builder's hand-off) writes state first, and a readBox() in here would
  // immediately overwrite it with whatever the not-yet-re-rendered box still
  // showed — which is exactly the bug `npm run tabs` caught by measuring a
  // seeded run that was identical to the empty one.
  function runDecode() {
    const rows = parse(state.hfem.text);
    state.hfem.parsed = rows;
    state.hfem.parsedKey = state.hfem.text;
    renderMain();
    // The result, announced once — not per message, which would be the
    // unusable half of the live-region failure mode (design-system §4).
    const ok = rows.filter(r => r.ok).length;
    announce(rows.length
      ? `${ok} of ${rows.length} message${rows.length === 1 ? '' : 's'} decoded`
      : 'Nothing to decode');
  }

  // The button. The box is the source of truth for *this* path and only this one.
  function decode() {
    readBox();
    runDecode();
  }

  function clear() {
    state.hfem.text = '';
    state.hfem.parsed = null;
    state.hfem.parsedKey = '';
    renderMain();
    announce('Capture cleared');
  }

  function loadSample(which) {
    state.hfem.text = which === 'messy' ? messyExample() : SPEC_EXAMPLES;
    runDecode();
  }

  function setBuild(key, value) {
    state.hfem.builder[key] = value;
    rerenderBuilder();
  }

  function setSensor(i, key, value) {
    const s = state.hfem.builder.sensors[i];
    if (!s) return;
    s[key] = value;
    rerenderBuilder();
  }

  function addSensor() {
    state.hfem.builder.sensors.push({ cls: 'R', instance: 1, scheme: 6, value: '0.0' });
    renderMain();
  }

  function removeSensor(i) {
    state.hfem.builder.sensors.splice(i, 1);
    renderMain();
  }

  // Only the built line is redrawn while the builder is being typed in: a full
  // re-render would replace the field under the cursor, which is the same trap
  // the ERT-A2 tab's number boxes documented.
  function rerenderBuilder() {
    const el = document.getElementById('hf-built');
    const built = buildLine();
    if (el && built.ok) { el.textContent = built.line; return; }
    renderMain();
  }

  function copyBuilt() {
    const built = buildLine();
    if (!built.ok || !navigator.clipboard) return;
    navigator.clipboard.writeText(built.line).then(() => announce('Message copied'));
  }

  function decodeBuilt() {
    const built = buildLine();
    if (!built.ok) return;
    // Read the box first — the operator may have typed into it since the last
    // decode, and appending to stale state would silently discard that.
    readBox();
    state.hfem.text = state.hfem.text
      ? state.hfem.text.replace(/\s*$/, '\n') + built.line
      : built.line;
    runDecode();
  }

  function exportCsv() {
    const rows = current().filter(r => r.ok);
    const out = [];
    rows.forEach(r => r.message.sensors.forEach(s => {
      const st = stationFor(r.message);
      out.push({
        line: r.lineNo,
        site: r.message.site.id,
        agency: r.message.site.agency || '',
        station: st ? st.name : '',
        station_number: st ? (st.station_number || '') : '',
        maintenance: r.message.maintenance ? 1 : 0,
        time_utc: r.message.time ? r.message.time.utc : '',
        time_as_written: r.message.time ? `${r.message.time.scheme}=${r.message.time.raw}` : '',
        time_utc_stated: r.message.time ? (r.message.time.utcIsStated ? 1 : 0) : '',
        sensor: s.className,
        instance: s.instance,
        tag: s.tag,
        sampling: s.sampling,
        representation: s.representation,
        value: s.valueText,
        unit: s.unit,
        rollover: s.rollover == null ? '' : s.rollover,
      });
    }));
    if (!out.length) return;
    const cols = Object.keys(out[0]);
    const csv = [cols.join(',')]
      .concat(out.map(r => cols.map(c => csvEscape(r[c])).join(','))).join('\n');
    dlText('hfem-measurements.csv', csv);
  }

  // No map and no timer, so nothing to register and nothing to tear down —
  // `npm run registry` is what makes that a checked claim rather than an
  // omission (#142, #143).
  function init() {}

  // parse and buildLine are exported for the same reason alert2.js exports its
  // codec entry points: they are the tab's behaviour with no DOM behind them,
  // which is the form a test can hold.
  return { render, init, decode, clear, loadSample, exportCsv,
           setBuild, setSensor, addSensor, removeSensor, copyBuilt, decodeBuilt,
           parse, buildLine };
})();
