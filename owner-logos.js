// MegaNet — owner-logos.js
//
//   OwnerLogos   each station owner's logo, beside its name in the Owner row of
//                the station card on the Stations map, and in the station
//                editor's Owner field.
//
// After core.js (esc, escAttr); app.js's stnCardOwnerHtml() calls partyHtml()
// once per party of the owner that stationOwner() worked out, and the station
// editor calls logoHtml() beside an owner typed into its box. Nothing runs at
// load: the name-to-logo lookup is built the first time it is asked for
// (`npm run toplevel`).
//
// ── Where the logos come from ───────────────────────────────────────────────
// Each owner's own website, as the small mark the site gives a browser tab or
// a phone's home screen — mostly through Google's copy of it, because most
// council sites turn a script away — and, where that copy was too small or not
// the mark, the logo on the site's own page or its Wikipedia article. Every
// one is in assets/owners/<file>.webp, trimmed and 64 px tall (192 px wide at
// most), so a card fetches one small image per owner and nothing from anybody
// else's site.
//
// ── Whose logo a name gets ──────────────────────────────────────────────────
// Owners are looked up by the names stationOwner() hands out: the Bureau's
// Service Level Specification's "Station owner", else the station's own
// `owner` (0030), split into its parties and tidied (app.js). A state
// department carries its government's mark — DLGWV, DETSI, Transport and Main
// Roads and Maritime Safety Queensland the Queensland Government's, NSW
// DCCEEW and the NSW Office of Water the NSW Government's — because that is
// the logo those departments put on their own work. Three of the SLS's names
// are read rather than taken as written: "Cool Shire Council" (OAKEY CREEK
// CAUSEWAY, on the Endeavour) is Cook Shire, "Central Highlands Council"
// (Emerald, Yatton) is the Queensland regional council and not Tasmania's,
// and "Cooma Monaro Shire Council" is Snowy Monaro Regional Council since the
// 2016 merger. A name not in LOGOS gets no logo — never a guess at one:
// "Northern RWMP", "Bureau Western Downs Regional Council" (two owners run
// together), the five owners no clear logo could be found for yet (North
// Burnett, Gunnedah, Inverell, the Northern Gulf Resource Management Group
// and North Byron Parklands), and the pieces of a name the SLS writes with
// commas, which stationOwnerParse splits as if they were parties: "VIC
// Department of Energy, Environment and Climate Action" carries Victoria's
// mark on its first piece only, and South Australia's Department of
// Environment, Water and Natural Resources on "South Australia".
//
// ── Adding one ──────────────────────────────────────────────────────────────
// Put the mark in assets/owners/<file>.webp (64 px tall, transparent or white
// round it) and add <file>: { name, parties } below — `name` is whose logo it
// is, `parties` every owner name that should carry it, spelt as the card
// shows it. `npm run sls` holds every party in the SLS to having a logo or
// being one of the names above, every file here to existing and every file
// in assets/owners/ to being here, and the card to showing them.

const OwnerLogos = (() => {
  const DIR = 'assets/owners/';

  // file → whose logo it is, and the owner names (case and spacing aside) it
  // stands beside.
  const LOGOS = {
    // Commonwealth, states and territories
    'bom':        { name: 'Bureau of Meteorology', parties: ['Bureau of Meteorology'] },
    'defence':    { name: 'Department of Defence', parties: ['Department of Defence'] },
    'nca':        { name: 'National Capital Authority', parties: ['National Capital Authority'] },
    'qld-gov':    { name: 'Queensland Government', parties: ['DLGWV', 'DNRM', 'DETSI', 'DETSI (Tide Stations)',
                    'Department of Environment and Science (Tide Stations)', 'Department of Transport and Main Roads',
                    'Maritime Safety Queensland', 'Queensland Station'] },
    'nsw-gov':    { name: 'NSW Government', parties: ['NSW DCCEEW', 'NSW Office of Water'] },
    'vic-gov':    { name: 'Victorian Government', parties: ['VIC Department of Energy'] },
    'sa-gov':     { name: 'Government of South Australia', parties: ['South Australia'] },
    'act-gov':    { name: 'ACT Government', parties: ['ACT Government'] },
    // Water, power and private owners
    'waternsw':   { name: 'WaterNSW', parties: ['WaterNSW'] },
    'seqwater':   { name: 'Seqwater', parties: ['Seqwater'] },
    'sunwater':   { name: 'Sunwater', parties: ['Sunwater'] },
    'icon-water': { name: 'Icon Water', parties: ['Icon Water'] },
    'gawb':       { name: 'Gladstone Area Water Board', parties: ['Gladstone Area Water Board'] },
    'powerlink':  { name: 'Powerlink Queensland', parties: ['Powerlink Queensland'] },
    'santos':     { name: 'Santos', parties: ['Santos'] },
    'stanbroke':  { name: 'Stanbroke Pastoral Company', parties: ['Stanbroke Pastoral Company'] },
    // Queensland councils
    'balonne':         { name: 'Balonne Shire Council', parties: ['Balonne Shire Council'] },
    'banana':          { name: 'Banana Shire Council', parties: ['Banana Shire Council'] },
    'barcaldine':      { name: 'Barcaldine Regional Council', parties: ['Barcaldine Regional Council'] },
    'barcoo':          { name: 'Barcoo Shire Council', parties: ['Barcoo Shire Council'] },
    'blackall-tambo':  { name: 'Blackall Tambo Regional Council', parties: ['Blackall Tambo Regional Council'] },
    'boulia':          { name: 'Boulia Shire Council', parties: ['Boulia Shire Council'] },
    'brisbane':        { name: 'Brisbane City Council', parties: ['Brisbane City Council'] },
    'bulloo':          { name: 'Bulloo Shire Council', parties: ['Bulloo Shire Council'] },
    'bundaberg':       { name: 'Bundaberg Regional Council', parties: ['Bundaberg Regional Council'] },
    'burdekin':        { name: 'Burdekin Shire Council', parties: ['Burdekin Shire Council'] },
    'burke':           { name: 'Burke Shire Council', parties: ['Burke Shire Council'] },
    'cairns':          { name: 'Cairns Regional Council', parties: ['Cairns Regional Council'] },
    'carpentaria':     { name: 'Carpentaria Shire Council', parties: ['Carpentaria Shire Council'] },
    'cassowary-coast': { name: 'Cassowary Coast Regional Council', parties: ['Cassowary Coast Regional Council'] },
    'central-highlands-qld': { name: 'Central Highlands Regional Council',
                         parties: ['Central Highlands Regional Council', 'Central Highlands Council'] },
    'charters-towers': { name: 'Charters Towers Regional Council', parties: ['Charters Towers Regional Council'] },
    'cherbourg':       { name: 'Cherbourg Aboriginal Shire Council', parties: ['Cherbourg Aboriginal Shire Council'] },
    'cloncurry':       { name: 'Cloncurry Shire Council', parties: ['Cloncurry Shire Council'] },
    'cook':            { name: 'Cook Shire Council', parties: ['Cook Shire Council', 'Cool Shire Council'] },
    'croydon':         { name: 'Croydon Shire Council', parties: ['Croydon Shire Council'] },
    'diamantina':      { name: 'Diamantina Shire Council', parties: ['Diamantina Shire Council'] },
    'douglas':         { name: 'Douglas Shire Council', parties: ['Douglas Shire Council'] },
    'etheridge':       { name: 'Etheridge Shire Council', parties: ['Etheridge Shire Council'] },
    'flinders':        { name: 'Flinders Shire Council', parties: ['Flinders Shire Council'] },
    'fraser-coast':    { name: 'Fraser Coast Regional Council', parties: ['Fraser Coast Regional Council'] },
    'gladstone':       { name: 'Gladstone Regional Council', parties: ['Gladstone Regional Council'] },
    'gold-coast':      { name: 'City of Gold Coast', parties: ['Gold Coast City Council', 'City of Gold Coast'] },
    'goondiwindi':     { name: 'Goondiwindi Regional Council', parties: ['Goondiwindi Regional Council'] },
    'hinchinbrook':    { name: 'Hinchinbrook Shire Council', parties: ['Hinchinbrook Shire Council'] },
    'ipswich':         { name: 'Ipswich City Council', parties: ['Ipswich City Council'] },
    'isaac':           { name: 'Isaac Regional Council', parties: ['Isaac Regional Council'] },
    'lockyer-valley':  { name: 'Lockyer Valley Regional Council', parties: ['Lockyer Valley Regional Council'] },
    'logan':           { name: 'Logan City Council', parties: ['Logan City Council'] },
    'longreach':       { name: 'Longreach Regional Council', parties: ['Longreach Regional Council'] },
    'mackay':          { name: 'Mackay Regional Council', parties: ['Mackay Regional Council'] },
    'maranoa':         { name: 'Maranoa Regional Council', parties: ['Maranoa Regional Council'] },
    'mareeba':         { name: 'Mareeba Shire Council', parties: ['Mareeba Shire Council'] },
    'mckinlay':        { name: 'McKinlay Shire Council', parties: ['McKinlay Shire Council'] },
    'moreton-bay':     { name: 'City of Moreton Bay', parties: ['City of Moreton Bay', 'Moreton Bay Regional Council'] },
    'murweh':          { name: 'Murweh Shire Council', parties: ['Murweh Shire Council'] },
    'noosa':           { name: 'Noosa Shire Council', parties: ['Noosa Shire Council'] },
    'paroo':           { name: 'Paroo Shire Council', parties: ['Paroo Shire Council'] },
    'quilpie':         { name: 'Quilpie Shire Council', parties: ['Quilpie Shire Council'] },
    'richmond':        { name: 'Richmond Shire Council', parties: ['Richmond Shire Council'] },
    'rockhampton':     { name: 'Rockhampton Regional Council', parties: ['Rockhampton Regional Council'] },
    'scenic-rim':      { name: 'Scenic Rim Regional Council', parties: ['Scenic Rim Regional Council'] },
    'southern-downs':  { name: 'Southern Downs Regional Council', parties: ['Southern Downs Regional Council'] },
    'sunshine-coast':  { name: 'Sunshine Coast Council', parties: ['Sunshine Coast Regional Council', 'Sunshine Coast Council'] },
    'toowoomba':       { name: 'Toowoomba Regional Council', parties: ['Toowoomba Regional Council'] },
    'townsville':      { name: 'Townsville City Council', parties: ['Townsville City Council'] },
    'western-downs':   { name: 'Western Downs Regional Council', parties: ['Western Downs Regional Council'] },
    'whitsunday':      { name: 'Whitsunday Regional Council', parties: ['Whitsunday Regional Council'] },
    'winton':          { name: 'Winton Shire Council', parties: ['Winton Shire Council'] },
    // New South Wales councils
    'ballina':           { name: 'Ballina Shire Council', parties: ['Ballina Shire Council'] },
    'bathurst':          { name: 'Bathurst Regional Council', parties: ['Bathurst Regional Council'] },
    'bellingen':         { name: 'Bellingen Shire Council', parties: ['Bellingen Shire Council'] },
    'byron':             { name: 'Byron Shire Council', parties: ['Byron Shire Council'] },
    'cabonne':           { name: 'Cabonne Council', parties: ['Cabonne Shire Council', 'Cabonne Council'] },
    'central-coast':     { name: 'Central Coast Council', parties: ['Central Coast Council'] },
    'cessnock':          { name: 'Cessnock City Council', parties: ['Cessnock City Council'] },
    'clarence-valley':   { name: 'Clarence Valley Council', parties: ['Clarence Valley Council'] },
    'coffs-harbour':     { name: 'Coffs Harbour City Council', parties: ['Coffs Harbour City Council'] },
    'coonamble':         { name: 'Coonamble Shire Council', parties: ['Coonamble Council', 'Coonamble Shire Council'] },
    'gilgandra':         { name: 'Gilgandra Shire Council', parties: ['Gilgandra Shire Council'] },
    'goulburn-mulwaree': { name: 'Goulburn Mulwaree Council', parties: ['Goulburn Mulwaree Council'] },
    'hay':               { name: 'Hay Shire Council', parties: ['Hay Shire Council'] },
    'kempsey':           { name: 'Kempsey Shire Council', parties: ['Kempsey Shire Council'] },
    'lismore':           { name: 'Lismore City Council', parties: ['Lismore City Council'] },
    'midcoast':          { name: 'MidCoast Council', parties: ['Mid-Coast Council', 'MidCoast Council'] },
    'nambucca':          { name: 'Nambucca Valley Council', parties: ['Nambucca Valley Council'] },
    'narromine':         { name: 'Narromine Shire Council', parties: ['Narromine Shire Council'] },
    'newcastle':         { name: 'City of Newcastle', parties: ['Newcastle City Council', 'City of Newcastle'] },
    'orange':            { name: 'Orange City Council', parties: ['Orange City Council'] },
    'parramatta':        { name: 'City of Parramatta', parties: ['City of Parramatta'] },
    'port-macquarie-hastings': { name: 'Port Macquarie-Hastings Council',
                           parties: ['Port Macquarie Hastings Council', 'Port Macquarie-Hastings Council'] },
    'qprc':              { name: 'Queanbeyan-Palerang Regional Council', parties: ['Queanbeyan-Palerang Regional Council'] },
    'shoalhaven':        { name: 'Shoalhaven City Council', parties: ['Shoalhaven City Council'] },
    'snowy-monaro':      { name: 'Snowy Monaro Regional Council',
                           parties: ['Snowy Monaro Regional Council', 'Cooma Monaro Shire Council'] },
    'sutherland':        { name: 'Sutherland Shire Council', parties: ['Sutherland Shire Council'] },
    'tamworth':          { name: 'Tamworth Regional Council', parties: ['Tamworth Regional Council'] },
    'tweed':             { name: 'Tweed Shire Council', parties: ['Tweed Shire Council'] },
    'upper-hunter':      { name: 'Upper Hunter Shire Council', parties: ['Upper Hunter Shire Council'] },
  };

  const key = p => String(p).replace(/\s+/g, ' ').trim().toLowerCase();
  let byParty = null;
  function lookup() {
    if (!byParty) {
      byParty = new Map();
      for (const [file, e] of Object.entries(LOGOS)) {
        for (const p of e.parties) byParty.set(key(p), { file, src: DIR + file + '.webp', name: e.name });
      }
    }
    return byParty;
  }

  // { file, src, name } for one owner party, or null when it has no logo here.
  function forParty(party) {
    return party == null ? null : lookup().get(key(party)) || null;
  }

  // One party's logo alone, or '' when it has none. It says nothing the name
  // beside it does not, so it has no alt text of its own; where it is a
  // parent's (a department carrying its government's crest) the tooltip says
  // whose.
  function logoHtml(party) {
    const l = forParty(party);
    if (!l) return '';
    const tip = key(l.name) === key(party) ? '' : ` title="${escAttr(`${l.name} logo`)}"`;
    return `<img class="owner-logo" src="${escAttr(l.src)}"
      alt=""${tip} decoding="async">`;
  }

  // One party as the card shows it: its logo, then its name, the logo held to
  // the name's first word so a narrow card never leaves it alone at the end
  // of a line.
  function partyHtml(party) {
    const logo = logoHtml(party);
    if (!logo) return esc(party);
    const [, first, rest] = String(party).match(/^(\S*)([\s\S]*)$/);
    return `<span class="owner-party"><span class="owner-lead">${logo}${esc(first)}</span>${esc(rest)}</span>`;
  }

  return { forParty, logoHtml, partyHtml, files: () => Object.keys(LOGOS) };
})();
