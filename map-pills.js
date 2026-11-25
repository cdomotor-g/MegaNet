// MegaNet — map-pills.js
//
//   MapPills   two small pills in the bottom-left corner of the Stations map,
//              so the two choices a person changes most while looking at the
//              ground are one tap from the map rather than inside the Layers
//              panel:
//
//              · View — which ready-made view is in force (map-views.js:
//                Overview, Site visit, Radio paths…), with a menu to switch;
//              · Imagery — where the aerial photos come from while the
//                Satellite base is on (map-controls.js: Auto, Esri only, NSW,
//                Queensland), with a menu to switch.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// initMap() attaches it and stopStationsMap() detaches it (app.js). Reaches
// MapViews and the map's own `mnBases.imagery` at runtime only, each behind a
// typeof, and nothing executes at load (`npm run toplevel`).
//
// Both menus read their lists from the module that owns the choice, so a view
// or a source added there turns up here without a line of its own.
const MapPills = (() => {
  let map = null, ctl = null, root = null;
  let openMenu = null;     // 'view' | 'imagery' | null

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const VIEW_SAY = 'The ready-made mix of map layers in force: what is drawn and how. Pick another to switch in one press; Layers has the full list and your own saved views.';
  const IMAGERY_SAY = 'Where the aerial photos on the Satellite map come from. Auto lays each State’s own photos over Esri where it has them.';

  function views() {
    if (typeof MapViews === 'undefined') return null;
    const out = [];
    for (const [g, name] of MapViews.GROUPS) {
      const list = MapViews.VIEWS.filter(v => v.group === g);
      if (list.length) out.push({ group: name, list: list.map(v => ({ id: v.id, label: v.label, say: v.say || '' })) });
    }
    const mine = (MapViews.saved() || []).map(v => ({ id: v.id, label: v.name, say: 'One of your own saved views.' }));
    if (mine.length) out.push({ group: 'Yours', list: mine });
    return out;
  }
  function viewLabel() {
    const groups = views();
    if (!groups) return null;
    const id = MapViews.active();
    for (const g of groups) for (const v of g.list) if (v.id === id) return v.label;
    return 'Custom';
  }
  function imagery() {
    const api = map && map.mnBases && map.mnBases.imagery;
    return api ? { id: api.get(), options: api.options(), set: api.set } : null;
  }
  // The Imagery over time slider (map-history.js), when it is there: which of its
  // sources is on, and the list to choose from.
  function history() {
    if (typeof MapHistory === 'undefined' || !MapHistory.sources) return null;
    return { on: MapHistory.source(), sources: () => MapHistory.sources() };
  }
  function satelliteOn() {
    try { const m = map.mnBases.mix(); return !!(m.Satellite && m.Satellite.on && m.Satellite.op > 0); } catch (_) { return false; }
  }

  function pill(kind, key, value, say) {
    const open = openMenu === kind;
    return `<button type="button" class="map-pill${open ? ' is-open' : ''}" data-pill="${kind}" aria-haspopup="menu"
              aria-expanded="${open}" title="${esc(say)}">
              <span class="map-pill-k">${key}</span><b>${esc(value)}</b><span aria-hidden="true">▾</span></button>`;
  }
  function menu(kind) {
    if (openMenu !== kind) return '';
    if (kind === 'view') {
      const groups = views() || [];
      const cur = MapViews.active();
      return `<div class="map-pill-menu" role="menu" aria-label="Map view">${groups.map(g => `
        <div class="map-pill-grp">${esc(g.group)}</div>${g.list.map(v => `
        <button type="button" role="menuitemradio" aria-checked="${v.id === cur}" class="map-pill-opt${v.id === cur ? ' is-on' : ''}"
                data-view="${esc(v.id)}" title="${esc(v.say)}">${esc(v.label)}</button>`).join('')}`).join('')}</div>`;
    }
    const im = imagery();
    if (!im) return '';
    const h = history();
    const over = h ? h.sources().map(o => `
        <button type="button" role="menuitemradio" aria-checked="${o.id === h.on}" class="map-pill-opt${o.id === h.on ? ' is-on' : ''}"
                data-history="${esc(o.id)}" title="${esc(`${o.words || ''} ${o.span}`.trim())}">${esc(o.name)} <span class="map-pill-sub">${esc(o.span)}</span></button>`).join('') : '';
    return `<div class="map-pill-menu" role="menu" aria-label="Imagery source">
        <div class="map-pill-grp">Now</div>${im.options.map(o => `
        <button type="button" role="menuitemradio" aria-checked="${!(h && h.on) && o.id === im.id}" class="map-pill-opt${!(h && h.on) && o.id === im.id ? ' is-on' : ''}"
                data-source="${esc(o.id)}" title="${esc(o.say)}">${esc(o.label)}</button>`).join('')}${over
      ? `<div class="map-pill-grp">Over time (slider)</div>${over}` : ''}</div>`;
  }

  function render() {
    if (!root) return;
    const vl = viewLabel();
    const im = imagery();
    const showImg = !!im && satelliteOn();
    if (!showImg && openMenu === 'imagery') openMenu = null;
    const h = history();
    const over = h && h.on ? h.sources().find(o => o.id === h.on) : null;
    const label = over ? { label: `Over time · ${over.name}` } : im && im.options.find(o => o.id === im.id);
    root.innerHTML =
      (vl == null ? '' : `<div class="map-pill-wrap">${menu('view')}${pill('view', 'View', vl, VIEW_SAY)}</div>`)
      + (showImg ? `<div class="map-pill-wrap">${menu('imagery')}${pill('imagery', 'Imagery', label ? label.label : 'Auto', IMAGERY_SAY)}</div>` : '');
    root.hidden = !root.innerHTML;
    // The slider's card stands at the foot of the map on the left (map-history.js);
    // the pills ride above it rather than under it.
    const bar = map && map.getContainer().querySelector('.mn-history-bar');
    root.style.marginBottom = bar ? `calc(${bar.offsetHeight}px + 2.6rem)` : '';
  }

  function onClick(e) {
    const t = e.target.closest && e.target.closest('button');
    if (!t || !root.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    if (t.dataset.pill) { openMenu = openMenu === t.dataset.pill ? null : t.dataset.pill; render(); return; }
    if (t.dataset.view && typeof MapViews !== 'undefined') { openMenu = null; MapViews.apply(t.dataset.view); render(); return; }
    if (t.dataset.history && typeof MapHistory !== 'undefined') { openMenu = null; MapHistory.setSource(t.dataset.history); render(); return; }
    if (t.dataset.source) {
      const im = imagery(); openMenu = null;
      if (typeof MapHistory !== 'undefined' && MapHistory.source()) MapHistory.setSource(null);   // back to now
      if (im) im.set(t.dataset.source);
      render();
    }
  }
  function onDoc(e) {
    if (openMenu && root && !root.contains(e.target)) { openMenu = null; render(); }
  }
  function onKey(e) {
    if (e.key === 'Escape' && openMenu) { const k = openMenu; openMenu = null; render(); const b = root && root.querySelector(`[data-pill="${k}"]`); if (b) b.focus(); }
  }

  return {
    attach(m) {
      detach();
      if (typeof L === 'undefined') return;
      map = m;
      ctl = L.control({ position: 'bottomleft' });
      ctl.onAdd = () => {
        root = L.DomUtil.create('div', 'map-pills');
        root.setAttribute('data-tour', 'map-pills');
        root.addEventListener('click', onClick);
        L.DomEvent.disableClickPropagation(root);
        L.DomEvent.disableScrollPropagation(root);
        return root;
      };
      ctl.addTo(map);
      map.on('mnbasemix mnimagerychange', render);
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mn-imagery-history', render);
      render();
    },
    detach,
    sync: render,
    _state: () => ({ open: openMenu, view: viewLabel(), imagery: imagery() ? imagery().id : null, shown: !!root && !root.hidden }),
  };
  function detach() {
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mn-imagery-history', render);
    if (map) { map.off('mnbasemix mnimagerychange', render); if (ctl) map.removeControl(ctl); }
    map = ctl = root = null;
    openMenu = null;
  }
})();
if (typeof window !== 'undefined') window.MapPills = MapPills;
