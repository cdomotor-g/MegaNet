// MegaNet — networks.js
//
//   renderNetworksHtml   the Networks tab: one card per radio network, with
//                        what is on it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// The smallest of the fourteen and the only one that reaches nowhere but
// core.js, for state and esc. app.js's renderMain() calls it — which is the
// registration that did not move with it (constraint 3 on #113).
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.
//
// ── #109's proving ground ────────────────────────────────────────────────────
// This tab is where the design system is shown to work end to end before six
// per-tab issues apply it nineteen more times. It was picked for being the
// smallest thing in the app that still has all the parts — a centred page, two
// panels, two tables, a count, and an empty state — so what changed here is
// legible as *the system* rather than as a redesign of this tab. #137 owns it
// afterwards and picks up whatever is left.
//
// Four things changed, and each is a rule U1–U6 inherit:
//
//   The inline style block became `.page`. Eight tabs open with the same
//   `max-width:Npx;margin:auto;padding:1rem;display:grid;gap:1rem` written out
//   by hand with four different maximums. One class, and --page-max where the
//   default is wrong. An inline style is a decision that no token can reach.
//
//   Both tables got a caption. `.sr-only`, because the panel heading directly
//   above already says the same words out loud — but a table with no
//   accessible name is what a screen reader lands in with no idea what it is
//   reading, and it was the most common single finding in the audit behind
//   #111.
//
//   The headers got `scope="col"`. Two words that tell a screen reader which
//   header belongs to which cell; without them a five-column table is read as
//   sixty unlabelled values.
//
//   The description column got `.col-optional`. It is the one column here that
//   carries context rather than an answer, so below --bp-sm it goes and the
//   other four get the width — which is the sanctioned way to drop a column,
//   and the only one. Everything else scrolls inside its wrapper instead.
//
// ── U2 (#137) picked it up, and found one thing left ─────────────────────────
// Both wrappers scroll — `.tall` is 42vh and this table is longer than that on
// any real file — and a div with `overflow:auto` is keyboard-scrollable in
// Firefox and in nothing else. So each is a labelled region now:
// role="region" + tabindex="0" + aria-labelledby, pointed at the two heading
// ids that were already sitting here unused. That is pattern 7 in
// docs/design-system.md, and it applies to every scrolling wrapper in the app
// rather than to this tab.

// ── NETWORKS tab ───────────────────────────────────────────────────────────────

function renderNetworksHtml() {
  const nets = state.data.radio_networks || [];
  const all  = state.data.stations;
  const cats = state.data.catchments || [];
  return `
    <div class="page" style="--page-max:960px">
      <section class="panel">
        <div class="panel-header">
          <h2 id="net-radio-h">Radio Networks</h2>
          <span class="badge">${nets.length}</span>
        </div>
        <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="net-radio-h">
          <table>
            <caption class="sr-only">
              Radio networks — ${nets.length} of them, with the repeaters and field
              stations on each.
            </caption>
            <colgroup>
              <col style="width:20%"><col style="width:28%"><col style="width:12%">
              <col style="width:12%"><col style="width:28%">
            </colgroup>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Name</th>
                <th scope="col">Repeaters</th>
                <th scope="col">Field stns</th>
                <th scope="col" class="col-optional">Description</th>
              </tr>
            </thead>
            <tbody>
              ${nets.map(n => {
                const rpts = all.filter(s => s.roles.includes('repeater') && s.radio_network_ids.includes(n.id));
                const flds = all.filter(s => s.roles.includes('field')    && s.radio_network_ids.includes(n.id));
                return `<tr>
                  <td class="small">${esc(n.id)}</td>
                  <td>${esc(n.name)}</td>
                  <td>${rpts.length}</td>
                  <td>${flds.length}</td>
                  <td class="small col-optional">${esc(n.description || '')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2 id="net-catch-h">Catchments</h2>
          <span class="badge">${cats.length}</span>
        </div>
        ${!cats.length
          ? '<p class="note">No catchments defined yet.</p>'
          : `<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="net-catch-h">
               <table>
                 <caption class="sr-only">Catchments — ${cats.length} of them, by id and name.</caption>
                 <thead>
                   <tr><th scope="col">ID</th><th scope="col">Name</th></tr>
                 </thead>
                 <tbody>
                   ${cats.map(c =>
                     `<tr><td class="small">${esc(c.id)}</td><td>${esc(c.name)}</td></tr>`
                   ).join('')}
                 </tbody>
               </table>
             </div>`}
      </section>
    </div>`;
}
