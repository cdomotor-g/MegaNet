// MegaNet — pass-ranges.js
//
//   renderPassRangesHtml   the Pass Ranges tab: which repeater carries which
//   and the matching       ALERT ids, and what is carried by nothing at all.
//   helpers behind it
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, netName and announce, and
// across to app.js for the whole of the shared search machinery —
// prepareSearch, parseSearchTerms, stationMatchesSearch, findStationMatches,
// markHits, markAlertId, stationAlertIds, passRangeCoversId and
// repeaterPassingCount. That is the longest reach back into app.js of the
// fourteen, and it is deliberate: this tab's filter box is meant to behave
// exactly like the Stations one, so the two share the rules rather than
// reimplementing them.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.
//
// ── U2 (#137): layout, mobile and accessibility ──────────────────────────────
// This tab was one inline `max-width:1100px;margin:auto;padding:1rem` wrapper,
// six more inline styles inside it, two literal #c7401a's, and two tables with
// no caption, no scope and no way in from a keyboard. What it is now is #109's
// system applied, plus the two additions #137 made *to* that system rather than
// to this tab (both are written up in docs/design-system.md, patterns 7 and 8):
//
//   A scrolling .table-wrap is a labelled region. `overflow:auto` on a div is
//   keyboard-scrollable in Firefox and in nothing else, so a table taller than
//   its wrapper — which both of these are — was unreachable without a mouse.
//   role="region" + tabindex="0" + aria-labelledby the panel's own heading, so
//   it is one stop with a name rather than one stop called "region".
//
//   A clickable row carries a real button. Both tables were `<tr onclick>`,
//   which is invisible to Tab and to a screen reader alike. The first cell now
//   holds a <button class="row-open"> with the row's own name in it; the row
//   keeps its onclick for the mouse, and the button stops the event so the two
//   never both fire.
//
// The rest is the system as it already stood: .page, tokens, .col-optional on
// the one column in each table that carries context rather than an answer
// (Network, both times — a repeater's network is not what anyone opens this tab
// to find out), captions, scope="col", and --bad in place of the two #c7401a
// literals. The filter box also got an sr-only role="status": the two badges
// say "12 of 34" to anyone who can see them, and said nothing at all otherwise.

// ── PASS RANGES tab ────────────────────────────────────────────────────────────

// Does a station answer to the page's filter box? The box takes a station
// number, an ALERT id or part of a station name and does not ask which — an
// operator holding one of the three shouldn't have to say which one it is.
// Shares the Stations search box's matching rules, pasted lists included, so
// the same text typed into either box picks the same stations.
function passRangeMatch(s, q) {
  return stationMatchesSearch(s, prepareSearch(q));
}

// A repeater row survives the filter if the repeater itself matches, if one of
// the stations it serves matches, or if the query is an ALERT id its pass
// ranges cover — the last one answers "which repeater carries this address?".
function passRangeRepeaterMatch(r, matched, q) {
  if (!q) return true;
  if (passRangeMatch(r, q)) return true;
  if (matched.some(s => passRangeMatch(s, q))) return true;
  // Every address in the box is tried, not just the first — a pasted list is
  // the case where "which repeater carries these?" is actually being asked.
  return parseSearchTerms(q)
    .filter(t => /^\d+$/.test(t))
    .some(t => passRangeCoversId(r.repeater, Number(t)));
}

// Static shell — the filter box lives out here and is never re-rendered on a
// keystroke, so it keeps focus while only #pr-tables refreshes below it. The
// status line lives out here for the same reason: a live region replaced
// wholesale is a live region the screen reader has stopped watching.
function renderPassRangesHtml() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const fields    = all.filter(s => s.roles.includes('field'));
  const noAid     = fields.filter(s => !stationAlertIds(s).length).length;
  const orphans   = passRangeOrphans();

  return `
    <div class="page">
      <div class="panel">
        <div class="panel-header"><h2>Pass Ranges</h2></div>
        <div class="stats stats-row">
          <div>Repeaters with pass ranges: <strong>${repeaters.length}</strong></div>
          <div>Field stations with AlertID: <strong>${fields.length - noAid}</strong></div>
          <div>No AlertID (telemetry): <strong>${noAid}</strong></div>
          <div class="${orphans.length ? 'stat-bad' : ''}">
            Orphaned (no matching repeater): <strong>${orphans.length}</strong>
          </div>
        </div>
        <label class="pr-filter">
          Filter by station number, AlertID or station name
          <input type="search" id="pr-filter" value="${esc(state.prFilter)}"
                 placeholder="e.g. 540123, 6128 or Amiens…"
                 oninput="onPassRangeFilter(this.value)">
        </label>
        <p class="small">
          Click any row — or press Enter on the station's name — to open it on the
          Stations tab.
        </p>
        <p id="pr-found" class="sr-only" role="status" aria-live="polite">${esc(passRangeFoundText())}</p>
      </div>

      <div id="pr-tables" class="stack">${passRangeTablesHtml()}</div>
    </div>`;
}

// Field stations carrying an AlertID that no repeater's pass ranges cover.
function passRangeOrphans() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  return all.filter(s => {
    if (!s.roles.includes('field')) return false;
    const ids = stationAlertIds(s);
    if (!ids.length) return false;
    return !repeaters.some(r => ids.some(id => passRangeCoversId(r.repeater, id)));
  });
}

// What the two badges say, for whoever cannot see them. Empty with no filter
// running, because "34 of 34 repeaters" is not the result of anything the user
// did — rule 1 of announce()'s policy, applied to a status region.
function passRangeFoundText() {
  const q = state.prFilter;
  if (!q) return '';
  const all        = state.data.stations;
  const repeaters  = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const shownRpts  = repeaters
    .map(r => ({ r, matched: findStationMatches(r) }))
    .filter(({ r, matched }) => passRangeRepeaterMatch(r, matched, q)).length;
  const allOrphans = passRangeOrphans();
  const shownOrph  = allOrphans.filter(s => passRangeMatch(s, q)).length;
  const parts = [`${shownRpts} of ${repeaters.length} repeaters`];
  if (allOrphans.length) parts.push(`${shownOrph} of ${allOrphans.length} orphaned stations`);
  return parts.join(', ');
}

// The repeater's ranges, with any range carrying a searched address marked.
// That mark answers "which range picked this station up?" — the question the
// tab is usually open for.
//
// The rule is passRangeRepeaterMatch's own, not a second one: passRangeCoversId
// still decides whether the repeater carries the address, and the bounds test
// only says which of its ranges is the one to point at. The two compose exactly
// because exclusions belong to the repeater rather than to a range — so an
// address inside this range that survives passRangeCoversId cannot have been
// excluded, and one that was excluded fails it everywhere. Range bounds are
// numbers, so there is nothing here to escape.
function passRangesHtml(repeater, searchIds) {
  return (repeater.pass_ranges || []).map(p => {
    const label = `${p.low}–${p.high}`;
    return searchIds.some(id => id >= p.low && id <= p.high && passRangeCoversId(repeater, id))
      ? `<mark class="hit">${label}</mark>` : label;
  }).join(', ');
}

// The first cell of a clickable row (pattern 7). The row keeps its own onclick
// so the whole thing is still a target for a mouse; this is the half a keyboard
// can reach, and it stops the event so a mouse click on the name does not run
// goToStation twice. The visible text is the accessible name — the title is the
// description, which is where "and here is what will happen" belongs.
function passRangeRowOpen(station, labelHtml) {
  return `<button type="button" class="row-open" onclick="event.stopPropagation();goToStation('${escAttr(station.id)}')"
                  title="Open ${escAttr(station.name)} on the Stations tab">${labelHtml}</button>`;
}

// Dynamic half — recomputed into #pr-tables on every keystroke in the filter box.
function passRangeTablesHtml() {
  const all       = state.data.stations;
  const q         = state.prFilter;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  // The same prepared terms the filter itself ran on, so every mark below sits
  // where the match was actually made — as on the Stations tab. The numeric
  // terms are the addresses the range column is asked about, so they are
  // converted once here rather than once per range per repeater.
  const { terms, nums } = prepareSearch(q);
  const searchIds = nums.map(Number);

  const rptData = repeaters
    .map(r => ({ r, matched: findStationMatches(r) }))
    .filter(({ r, matched }) => passRangeRepeaterMatch(r, matched, q));

  const allOrphans = passRangeOrphans();
  const orphans    = allOrphans.filter(s => passRangeMatch(s, q));

  const of = (shown, total) => shown === total ? `${total}` : `${shown} of ${total}`;
  const noMatch = msg => `<p class="small table-empty">${msg}</p>`;

  // A repeater usually survives the filter because one of the ~100 stations it
  // carries matched — and that station is as likely to be 84th in the list as
  // 4th, so a cell showing the first ten would mark nothing and the row would
  // look like it matched for no reason. The matches go to the front; the order
  // is otherwise untouched, and the "+N more" count behind it is unchanged.
  const firstTen = matched => {
    if (!q) return matched;
    const hit = [], rest = [];
    for (const s of matched) (passRangeMatch(s, q) ? hit : rest).push(s);
    return hit.concat(rest);
  };

  return `
      <div class="panel">
        <div class="panel-header"><h2 id="pr-rpt-h">By Repeater</h2>
          <span class="badge">${of(rptData.length, repeaters.length)}</span>
        </div>
        <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="pr-rpt-h">
          ${!rptData.length ? noMatch('No repeater matches this filter.') : `
          <table>
            <caption class="sr-only">
              Repeaters with pass ranges — ${of(rptData.length, repeaters.length)} of them, with
              the addresses each carries and the field stations it matches.
            </caption>
            <colgroup>
              <col style="width:18%"><col style="width:14%"><col style="width:10%"><col style="width:8%">
              <col style="width:16%"><col style="width:34%">
            </colgroup>
            <thead><tr>
              <th scope="col">Repeater</th>
              <th scope="col" class="col-optional">Network</th>
              <th scope="col">Addresses</th>
              <th scope="col">Matched</th>
              <th scope="col">Pass ranges</th>
              <th scope="col">Stations (first 10)</th>
            </tr></thead>
            <tbody>
              ${rptData.map(({ r, matched }) => `
                <tr class="row-link" onclick="goToStation('${escAttr(r.id)}')">
                  <td>${passRangeRowOpen(r, markHits(r.name, terms))}</td>
                  <td class="small col-optional">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  <td><span class="badge" title="ALERT addresses carried, post-exclusion">${repeaterPassingCount(r) ?? 0}</span></td>
                  <td><span class="badge" title="Field stations matched">${matched.length}</span></td>
                  <td class="small">${passRangesHtml(r.repeater, searchIds)}</td>
                  <td class="small">${firstTen(matched).slice(0, 10).map(s => markHits(s.name, terms)).join(', ')}${matched.length > 10 ? ` +${matched.length - 10} more` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      ${allOrphans.length ? `
        <div class="panel">
          <div class="panel-header">
            <h2 id="pr-orph-h" class="h-bad">Orphaned Stations</h2>
            <span class="badge">${of(orphans.length, allOrphans.length)}</span>
          </div>
          <p class="small">
            These stations have an AlertID but no repeater's pass ranges cover it.
          </p>
          <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="pr-orph-h">
            ${!orphans.length ? noMatch('No orphaned station matches this filter.') : `
            <table>
              <caption class="sr-only">
                Orphaned stations — ${of(orphans.length, allOrphans.length)} of them, with the
                AlertIDs no repeater's pass ranges cover.
              </caption>
              <thead><tr>
                <th scope="col">Name</th>
                <th scope="col">Stn #</th>
                <th scope="col">AlertID(s)</th>
                <th scope="col" class="col-optional">Network</th>
              </tr></thead>
              <tbody>
                ${orphans.map(s => `
                  <tr class="row-link" onclick="goToStation('${escAttr(s.id)}')">
                    <td>${passRangeRowOpen(s, markHits(s.name, terms))}</td>
                    <td class="small">${markHits(s.station_number || '', terms)}</td>
                    <td class="small">${stationAlertIds(s).map(id => markAlertId(id, nums)).join(', ')}</td>
                    <td class="small col-optional">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
          </div>
        </div>` : ''}`;
}

function onPassRangeFilter(value) {
  state.prFilter = value;
  const el = document.getElementById('pr-tables');
  if (el) el.innerHTML = passRangeTablesHtml();
  // Not announce(): this is a count attached to a list, read where the list is,
  // which is the same call the nav's find box makes. The shared region is for
  // things that happen away from where the user is looking.
  const found = document.getElementById('pr-found');
  if (found) found.textContent = passRangeFoundText();
}
