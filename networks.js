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

// ── NETWORKS tab ───────────────────────────────────────────────────────────────

function renderNetworksHtml() {
  const nets = state.data.radio_networks || [];
  const all  = state.data.stations;
  return `
    <div style="max-width:960px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header">
          <h2>Radio Networks</h2>
          <span class="badge">${nets.length}</span>
        </div>
        <div class="table-wrap tall" style="margin-top:.75rem">
          <table>
            <colgroup>
              <col style="width:20%"><col style="width:28%"><col style="width:12%">
              <col style="width:12%"><col style="width:28%">
            </colgroup>
            <thead><tr><th>ID</th><th>Name</th><th>Repeaters</th><th>Field stns</th><th>Description</th></tr></thead>
            <tbody>
              ${nets.map(n => {
                const rpts = all.filter(s => s.roles.includes('repeater') && s.radio_network_ids.includes(n.id));
                const flds = all.filter(s => s.roles.includes('field')    && s.radio_network_ids.includes(n.id));
                return `<tr>
                  <td class="small">${esc(n.id)}</td>
                  <td>${esc(n.name)}</td>
                  <td>${rpts.length}</td>
                  <td>${flds.length}</td>
                  <td class="small">${esc(n.description || '')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Catchments</h2>
          <span class="badge">${(state.data.catchments || []).length}</span>
        </div>
        ${!(state.data.catchments || []).length
          ? '<p class="small" style="color:var(--muted);margin:.75rem 0">No catchments defined yet.</p>'
          : `<div class="table-wrap medium" style="margin-top:.75rem">
               <table>
                 <thead><tr><th>ID</th><th>Name</th></tr></thead>
                 <tbody>
                   ${state.data.catchments.map(c =>
                     `<tr><td class="small">${esc(c.id)}</td><td>${esc(c.name)}</td></tr>`
                   ).join('')}
                 </tbody>
               </table>
             </div>`}
      </div>
    </div>`;
}

