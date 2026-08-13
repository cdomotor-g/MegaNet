// MegaNet — pass-ranges.js
//
//   renderPassRangesHtml   the Pass Ranges tab: which repeater carries which
//   and the matching       ALERT ids, and what is carried by nothing at all.
//   helpers behind it
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr and netName, and across to
// app.js for the whole of the shared search machinery — prepareSearch,
// parseSearchTerms, stationMatchesSearch, findStationMatches, markHits,
// markAlertId, stationAlertIds, passRangeCoversId and repeaterPassingCount.
// That is the longest reach back into app.js of the fourteen, and it is
// deliberate: this tab's filter box is meant to behave exactly like the Stations
// one, so the two share the rules rather than reimplementing them.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

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
// keystroke, so it keeps focus while only #pr-tables refreshes below it.
function renderPassRangesHtml() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const fields    = all.filter(s => s.roles.includes('field'));
  const noAid     = fields.filter(s => !stationAlertIds(s).length).length;
  const orphans   = passRangeOrphans();

  return `
    <div style="max-width:1100px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Pass Ranges</h2></div>
        <div class="stats" style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:.75rem">
          <div>Repeaters with pass ranges: <strong>${repeaters.length}</strong></div>
          <div>Field stations with AlertID: <strong>${fields.length - noAid}</strong></div>
          <div>No AlertID (telemetry): <strong>${noAid}</strong></div>
          <div style="${orphans.length ? 'color:#c7401a' : ''}">
            Orphaned (no matching repeater): <strong>${orphans.length}</strong>
          </div>
        </div>
        <label style="display:block;font-size:.88rem;color:var(--muted);margin-top:.9rem;max-width:420px">
          Filter by station number, AlertID or station name
          <input type="search" id="pr-filter" value="${esc(state.prFilter)}"
                 placeholder="e.g. 540123, 6128 or Amiens…"
                 style="width:100%;margin-top:.3rem;display:block"
                 oninput="onPassRangeFilter(this.value)">
        </label>
        <p class="small" style="color:var(--muted);margin:.5rem 0 0">
          Click any row to open that station on the Stations tab.
        </p>
      </div>

      <div id="pr-tables" style="display:grid;gap:1rem">${passRangeTablesHtml()}</div>
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
  const noMatch = msg => `<p class="small" style="color:var(--muted);padding:.75rem">${msg}</p>`;

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
        <div class="panel-header"><h2>By Repeater</h2>
          <span class="badge">${of(rptData.length, repeaters.length)}</span>
        </div>
        <div class="table-wrap tall">
          ${!rptData.length ? noMatch('No repeater matches this filter.') : `
          <table>
            <colgroup>
              <col style="width:18%"><col style="width:14%"><col style="width:10%"><col style="width:8%">
              <col style="width:16%"><col style="width:34%">
            </colgroup>
            <thead><tr><th>Repeater</th><th>Network</th><th>Addresses</th><th>Matched</th><th>Pass ranges</th><th>Stations (first 10)</th></tr></thead>
            <tbody>
              ${rptData.map(({ r, matched }) => `
                <tr onclick="goToStation('${escAttr(r.id)}')" style="cursor:pointer"
                    title="Open ${escAttr(r.name)} on the Stations tab">
                  <td>${markHits(r.name, terms)}</td>
                  <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
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
            <h2 style="color:#c7401a">Orphaned Stations</h2>
            <span class="badge">${of(orphans.length, allOrphans.length)}</span>
          </div>
          <p class="small" style="color:var(--muted);margin:.5rem 0">
            These stations have an AlertID but no repeater's pass ranges cover it.
          </p>
          <div class="table-wrap medium">
            ${!orphans.length ? noMatch('No orphaned station matches this filter.') : `
            <table>
              <thead><tr><th>Name</th><th>Stn #</th><th>AlertID(s)</th><th>Network</th></tr></thead>
              <tbody>
                ${orphans.map(s => `
                  <tr onclick="goToStation('${escAttr(s.id)}')" style="cursor:pointer"
                      title="Open ${escAttr(s.name)} on the Stations tab">
                    <td>${markHits(s.name, terms)}</td>
                    <td class="small">${markHits(s.station_number || '', terms)}</td>
                    <td class="small">${stationAlertIds(s).map(id => markAlertId(id, nums)).join(', ')}</td>
                    <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
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
}

