// The drawing goes to Google Earth (#183), and the file says what the map said.
//
// Draw & measure makes real geometry — a circle is 25.0 km because somebody
// typed 25.0 — and until this it could not leave the page as anything but a
// screenshot. `drawingKml()` in `export.js` writes the whole drawing out:
// every shape in the colour it was drawn in, plus the stations each one
// encloses or runs between.
//
// Every other check in `test/` is blind to all of it. Nothing throws when a
// KML is wrong; `node --check` sees a template literal; `smoke` presses the
// button and gets a file it never opens. **A KML that is wrong opens
// perfectly** — Google Earth is forgiving about namespaces, ignores a
// `<styleUrl>` naming a style that is not there, and will happily draw a
// polygon somewhere in the Indian Ocean if the coordinates arrive as lat,lon
// instead of lon,lat. So the assertions below are about the file's *contents*,
// parsed, and about the ground the numbers in it describe:
//
//   * **The axis order.** KML is `lon,lat,alt` and every other API in this app
//     is `lat, lon`. Getting it backwards is one character, silent, and puts an
//     Australian drawing 30° south-west of Sri Lanka. Checked by putting the
//     ring's due-north vertex where due north actually is.
//   * **A circle is round on the sphere, not on the screen.** KML has no
//     circle, so `ringFor()` steps 72 bearings with `destPoint`. The tempting
//     version adds degrees of longitude instead, which is right at the equator,
//     out by 6% at Brisbane and worse the further south you go. Every vertex is
//     measured back to the centre here, so that version fails.
//   * **The stations, against an oracle that is not the app's.** The circle's
//     membership is recomputed in this file by haversine over `state.data`, and
//     the count in the file has to be that count and every name it lists one of
//     those names.
//   * **Every `<styleUrl>` resolves.** A colour whose `<Style>` was never
//     emitted draws in Google Earth's default white and looks like a choice.
//   * **The two ways a shape learns its stations, and both ends of the second.**
//     A snapped shape carries ids — a line added with them, and a pin snapped by
//     a real map click through the map's own handler, which nothing else here
//     drives. A shape typed in as numbers carries none and falls back to "a
//     station within 250 m of this point": a pin 120 m from a site finds it, a
//     pin more than a kilometre from anything finds nothing.
//   * **XML-hostile text.** A note saying `Smith & Sons <hr>` is a well-formed
//     way to break the file, and it is one `prompt()` away from being typed.
//
// Run:  npm run drawkml
//       npm run drawkml -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// The oracle. Deliberately not the app's acmaHaversineKm — a membership list
// checked against the function that built it is checking nothing.
const R_EARTH = 6371.0088;
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

const RADIUS_KM = 20;
const BOX_KM = 12;
const NOTE_TEXT = 'Smith & Sons <hr> "flood watch"';
const GREEN = '#00c853';                       // → aabbggrr ff53c800

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    // downloadDrawingKml() ends in an anchor click, and without this Chromium
    // cancels it — which is a pass for every assertion that does not look.
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.stack || e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  const panelBtn = () => page.evaluate(() => {
    const b = document.querySelector('#map-draw-panel .draw-export');
    return b && { text: b.textContent.trim(), disabled: b.disabled, title: b.title,
                  handler: b.getAttribute('onclick') };
  });

  // ── 1. The button, before anything is drawn ───────────────────────────────
  const empty = await panelBtn();
  check('the draw panel carries a KML button', !!empty, 'no .draw-export in #map-draw-panel');
  check('with nothing drawn it is disabled', !!empty && empty.disabled === true);
  check('it says what it does', !!empty && /kml/i.test(empty.title) && /google earth/i.test(empty.title),
    empty && empty.title);
  check('its handler is downloadDrawingKml', !!empty && /downloadDrawingKml\(\)/.test(empty.handler),
    empty && empty.handler);

  // An empty drawing is a refusal with a reason, not a 300-byte file.
  const refusal = await page.evaluate(async () => {
    let made = 0;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { made++; return orig.call(URL, b); };
    try { downloadDrawingKml(); } finally { URL.createObjectURL = orig; }
    await new Promise(r => requestAnimationFrame(r));
    return { made, said: document.getElementById('app-status').textContent };
  });
  check('nothing drawn downloads nothing', refusal.made === 0, `${refusal.made} blob(s)`);
  check('and says why', /nothing is drawn/i.test(refusal.said), refusal.said);

  // ── 2. Draw the five shapes ───────────────────────────────────────────────
  // Four through the "place by numbers" form — the path that records no snap
  // at all — and the line through MapDraw.addLine(), which is the entry point
  // the link budget already uses and the one that carries station ids.
  const seeded = await page.evaluate(async ([radiusKm, boxKm, note, green]) => {
    const located = state.data.stations.filter(s => s.lat != null && s.lon != null);
    const km = (a, b) => acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);

    // A station with plenty of company, so "inside the circle" is a set worth
    // asserting about rather than a single pin.
    let hub = null, best = -1;
    for (const s of located.slice(0, 400)) {
      const n = located.filter(o => o !== s && km(s, o) <= radiusKm).length;
      if (n > best) { best = n; hub = s; }
    }
    // The far end of the line and the site the loose pin is about. It has to
    // be a station standing on its own — this file has co-located pairs (an
    // ALERT and its telemetry twin at the same coordinates), and a pin dropped
    // 120 m from one of those would have two right answers.
    const near = located.filter(o => o !== hub && km(hub, o) <= radiusKm)
      .sort((a, b) => km(hub, a) - km(hub, b));
    const peer = near.find(p => !located.some(o => o !== p && km(p, o) < 0.4)) || near[0];

    // 120 m east of it: inside shapeStationIds()'s 250 m tolerance and not on
    // top of it, which is the difference between checking the tolerance and
    // checking that 0 <= 0.
    const loose = destPoint(peer.lat, peer.lon, 90, 0.12);

    // And somewhere with nothing near it at all, for the other half of the
    // rule. Walked out from the hub until every station is more than a
    // kilometre away — four times the tolerance, so no rounding decides it.
    let lonely = null;
    for (let d = 2; d <= 120 && !lonely; d += 2) {
      for (let b = 0; b < 360; b += 30) {
        const pt = destPoint(hub.lat, hub.lon, b, d);
        if (located.every(o => acmaHaversineKm(pt[0], pt[1], o.lat, o.lon) > 1)) { lonely = pt; break; }
      }
    }

    MapDraw.setColour(green);
    state.draw.shapes = [];
    state.draw.seq = 0;
    state.draw.selectedId = null;

    // Typed in: the form is rendered by the panel for whichever tool is armed.
    const typed = (tool, fields) => {
      MapDraw.setTool(tool);
      MapDraw.rerenderPanel();
      for (const [id, v] of Object.entries(fields)) document.getElementById(id).value = v;
      MapDraw.addFromForm();
      MapDraw.setTool('');
    };
    typed('circle', { 'dr-lat': hub.lat, 'dr-lon': hub.lon, 'dr-radius': radiusKm });
    typed('rect',   { 'dr-lat': hub.lat, 'dr-lon': hub.lon, 'dr-width': boxKm, 'dr-height': boxKm });
    typed('pin',    { 'dr-lat': loose[0], 'dr-lon': loose[1] });
    typed('text',   { 'dr-lat': hub.lat, 'dr-lon': hub.lon, 'dr-text': note });
    // Snapped: ids recorded at both ends, as a map click would.
    MapDraw.addLine([[hub.lat, hub.lon], [peer.lat, peer.lon]], [hub.id, peer.id]);

    return {
      hub:  { id: hub.id,  name: hub.name,  lat: hub.lat,  lon: hub.lon },
      peer: { id: peer.id, name: peer.name, lat: peer.lat, lon: peer.lon },
      looseKm: acmaHaversineKm(loose[0], loose[1], peer.lat, peer.lon),
      lonely,
      kinds: state.draw.shapes.map(s => s.kind),
    };
  }, [RADIUS_KM, BOX_KM, NOTE_TEXT, GREEN]);

  check('five shapes are on the map', seeded.kinds.length === 5, seeded.kinds.join(','));
  check('one of each kind that can be drawn',
    ['circle', 'rect', 'pin', 'text', 'line'].every(k => seeded.kinds.includes(k)),
    seeded.kinds.join(','));

  const armed = await panelBtn();
  check('with something drawn the button is live', !!armed && armed.disabled === false);

  // ── 3. The file, parsed ───────────────────────────────────────────────────
  const kml = await page.evaluate(() => drawingKml());
  const dom = await page.evaluate((xml) => {
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    const bad = d.querySelector('parsererror');
    if (bad) return { error: bad.textContent.slice(0, 200) };
    const q = (el, sel) => [...el.querySelectorAll(sel)];
    const text = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent : null; };
    const folders = q(d, 'Document > Folder').map(f => ({
      name: text(f, 'name'),
      marks: q(f, 'Placemark').map(p => ({
        name:  text(p, 'name'),
        style: text(p, 'styleUrl'),
        desc:  text(p, 'description') || '',
        ring:  text(p, 'Polygon LinearRing coordinates'),
        line:  text(p, 'LineString coordinates'),
        point: text(p, 'Point coordinates'),
        clamped: q(p, 'altitudeMode').map(n => n.textContent),
        tessellate: q(p, 'tessellate').map(n => n.textContent),
      })),
    }));
    return {
      root: d.documentElement.tagName,
      ns: d.documentElement.namespaceURI,
      docs: q(d, 'kml > Document').length,
      docName: text(d, 'Document > name'),
      styleIds: q(d, 'Document > Style').map(s => s.getAttribute('id')),
      lineColours: q(d, 'Document > Style LineStyle > color').map(n => n.textContent),
      noteIconScale: (() => {
        const s = q(d, 'Document > Style').find(x => /^mnNote-/.test(x.getAttribute('id') || ''));
        return s ? text(s, 'IconStyle scale') : null;
      })(),
      styleRefs: q(d, 'styleUrl').map(n => n.textContent),
      folders,
    };
  }, kml);

  check('the file is well-formed XML', !dom.error, dom.error);
  check('it is a KML document in the OGC namespace',
    dom.root === 'kml' && dom.ns === 'http://www.opengis.net/kml/2.2' && dom.docs === 1,
    `${dom.root} / ${dom.ns} / ${dom.docs} Document(s)`);
  check('the document is named for what is in it',
    /5 shapes/.test(dom.docName || '') && /\d+ stations/.test(dom.docName || ''), dom.docName);

  const refs = new Set(dom.styleRefs.map(r => r.replace(/^#/, '')));
  const ids = new Set(dom.styleIds);
  check('every styleUrl resolves to a Style in the file',
    [...refs].every(r => ids.has(r)),
    `refs ${[...refs].join(',')} vs ids ${[...ids].join(',')}`);
  check('the drawing colour reached the file as aabbggrr',
    dom.lineColours.includes('ff53c800'), dom.lineColours.join(','));

  const drawings = dom.folders.find(f => /^Drawings/.test(f.name || ''));
  const held = dom.folders.find(f => /^Stations/.test(f.name || ''));
  check('the file is two folders: the drawings and the stations',
    !!drawings && !!held && dom.folders.length === 2,
    dom.folders.map(f => f.name).join(' | '));
  check('every shape is a placemark', !!drawings && drawings.marks.length === 5,
    drawings && String(drawings.marks.length));

  // ── 4. Geometry, measured on the ground ───────────────────────────────────
  const parse = (s) => (s || '').trim().split(/\s+/).filter(Boolean)
    .map(t => t.split(',').map(Number));

  const circle = drawings.marks.find(m => m.ring && /r 20/.test(m.name || ''));
  const box    = drawings.marks.find(m => m.ring && m !== circle);
  const line   = drawings.marks.find(m => m.line);
  const points = drawings.marks.filter(m => m.point);

  const ring = parse(circle && circle.ring);
  check('a circle is a closed ring of 72 sides', ring.length === 73
    && ring[0][0] === ring[72][0] && ring[0][1] === ring[72][1],
    `${ring.length} points`);

  // The axis-order assertion. Vertex 0 is bearing 000° — due north of the
  // centre — so its longitude must be the centre's and its latitude must be
  // larger. Written lat,lon by mistake, both halves fail at once.
  const north = ring[0] || [0, 0];
  check('coordinates are lon,lat: the due-north vertex is due north',
    Math.abs(north[0] - seeded.hub.lon) < 1e-9 && north[1] > seeded.hub.lat,
    `centre ${seeded.hub.lon},${seeded.hub.lat} → vertex ${north.join(',')}`);

  const radii = ring.map(([lon, lat]) => haversineKm(seeded.hub.lat, seeded.hub.lon, lat, lon));
  const worst = radii.reduce((a, r) => Math.max(a, Math.abs(r - RADIUS_KM)), 0);
  check('every vertex is the radius from the centre, on the sphere',
    worst < RADIUS_KM * 0.005, `worst error ${worst.toFixed(4)} km of ${RADIUS_KM}`);

  const boxRing = parse(box && box.ring);
  check('a rectangle is a closed ring of four corners', boxRing.length === 5
    && boxRing[0][0] === boxRing[4][0] && boxRing[0][1] === boxRing[4][1],
    `${boxRing.length} points`);
  const boxH = boxRing.length === 5
    ? haversineKm(boxRing[0][1], boxRing[0][0], boxRing[1][1], boxRing[1][0]) : 0;
  const boxV = boxRing.length === 5
    ? haversineKm(boxRing[1][1], boxRing[1][0], boxRing[2][1], boxRing[2][0]) : 0;
  check('and it is the size that was typed',
    Math.abs(boxH - BOX_KM) < BOX_KM * 0.02 && Math.abs(boxV - BOX_KM) < BOX_KM * 0.02,
    `${boxH.toFixed(2)} × ${boxV.toFixed(2)} km, asked for ${BOX_KM}`);

  const linePts = parse(line && line.line);
  check('a line is its own two ends, in order', linePts.length === 2
    && Math.abs(linePts[0][1] - seeded.hub.lat) < 1e-9
    && Math.abs(linePts[1][1] - seeded.peer.lat) < 1e-9,
    JSON.stringify(linePts));
  check('and it is named for the sites it joins',
    !!line && line.name.includes(seeded.hub.name) && line.name.includes(seeded.peer.name),
    line && line.name);

  check('a pin and a note are points', points.length === 2, String(points.length));
  const areas = [circle, box, line].filter(Boolean);
  check('everything with length or area is clamped to the ground',
    areas.every(m => m.clamped.every(v => v === 'clampToGround') && m.tessellate.includes('1')),
    JSON.stringify(areas.map(m => [m.clamped, m.tessellate])));

  // ── 5. The note ───────────────────────────────────────────────────────────
  const note = points.find(m => m.name === NOTE_TEXT);
  check('a note carrying & and < survives as itself', !!note,
    points.map(m => JSON.stringify(m.name)).join(' | '));
  check('and is drawn as a label with no pin under it',
    !!note && /^#mnNote-/.test(note.style) && dom.noteIconScale === '0',
    `${note && note.style} / icon scale ${dom.noteIconScale}`);

  // ── 6. The stations ───────────────────────────────────────────────────────
  const stations = await page.evaluate(() =>
    state.data.stations.filter(s => s.lat != null && s.lon != null)
      .map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })));
  const visible = new Set(await page.evaluate(() => state.mapMarkers.map(m => m.mnStationId)));

  // The oracle: recomputed here, with this file's own haversine.
  const inside = stations
    .filter(s => visible.has(s.id) && haversineKm(seeded.hub.lat, seeded.hub.lon, s.lat, s.lon) <= RADIUS_KM)
    .map(s => s.name).sort();

  // The balloon says how many are inside and names as many as a balloon can
  // hold; the pins in the Stations folder are the list. So the count is
  // checked against the oracle and the names against the count.
  const inRow  = (circle && circle.desc.match(/Stations inside \((\d+)\):<\/b>\s*([^<]*)/)) || [];
  const listed = String(inRow[2] || '').split(', ').map(x => x.trim()).filter(Boolean);
  const more   = ((listed[listed.length - 1] || '').match(/^and (\d+) more$/) || [, 0])[1];
  const named  = more ? listed.slice(0, -1) : listed;

  check('a circle counts exactly the stations inside it',
    Number(inRow[1]) === inside.length, `${inRow[1]} in file vs ${inside.length} computed`);
  check('and there are enough of them for that to mean something',
    inside.length >= 3, `${inside.length} station(s) within ${RADIUS_KM} km`);
  check('every station it names is one of them',
    named.length > 0 && named.every(n => inside.includes(n)),
    named.filter(n => !inside.includes(n)).join(', ') || `${named.length} named`);
  check('and the ones it could not fit are counted rather than dropped',
    named.length + Number(more) === inside.length,
    `${named.length} named + ${more} more vs ${inside.length}`);

  const heldNames = held.marks.map(m => m.name);
  check('every station a shape holds gets a pin', inside.every(n => heldNames.includes(n)),
    inside.filter(n => !heldNames.includes(n)).join(', '));
  check('and only one, however many shapes it is in',
    new Set(heldNames).size === heldNames.length,
    `${heldNames.length} pins, ${new Set(heldNames).size} distinct`);

  const hubPin = held.marks.find(m => m.name === seeded.hub.name);
  check('a station in several shapes says so on its own pin',
    !!hubPin && /r 20/.test(hubPin.desc) && /12(\.0)? km ×/.test(hubPin.desc),
    hubPin && hubPin.desc.replace(/<[^>]*>/g, ' ').slice(0, 160));

  // The typed pin recorded no snap at all and does not sit *on* its station —
  // it is 120 m away — so the only thing that can have found it is the 250 m
  // fallback in shapeStationIds(). A pin placed exactly on the coordinates
  // would pass with the tolerance set to zero, which is a fixture that cannot
  // see the rule it is about.
  const pinMark = points.find(m => m !== note);
  const namesIn = (d) => ((d.match(/Stations:<\/b>\s*([^<]*)/)) || [, ''])[1]
    .split(', ').map(x => x.trim()).filter(Boolean);
  check('the loose pin is near its station without being on it',
    seeded.looseKm > 0.05 && seeded.looseKm < 0.25, `${(seeded.looseKm * 1000).toFixed(0)} m`);
  check('a pin typed in as numbers still finds the station beside it',
    !!pinMark && namesIn(pinMark.desc).join(', ') === seeded.peer.name,
    pinMark && pinMark.desc.replace(/<[^>]*>/g, ' ').slice(0, 160));

  // And the other half of the rule, which is the half a tolerance gets wrong:
  // a pin nowhere near anything enrols nothing. Built and thrown away on its
  // own so the five-shape fixture above is undisturbed.
  check('the fixture found somewhere with no station within a kilometre',
    Array.isArray(seeded.lonely), String(seeded.lonely));
  const alone = seeded.lonely ? await page.evaluate((pt) => {
    MapDraw.setTool('pin');
    MapDraw.rerenderPanel();
    document.getElementById('dr-lat').value = pt[0];
    document.getElementById('dr-lon').value = pt[1];
    MapDraw.addFromForm();
    MapDraw.setTool('');
    const shape = MapDraw.exportShapes().pop();
    state.draw.shapes.pop();
    MapDraw.render();
    MapDraw.rerenderPanel();
    return shape.stationIds;
  }, seeded.lonely) : null;
  check('a pin nowhere near a station enrols none', !!alone && alone.length === 0,
    alone ? alone.join(',') : 'no such point found — the assertion did not run');

  // A pin dropped *on* a station by clicking, through the map's own click
  // handler and the snap that goes with it — the path the loose pin above
  // deliberately does not take. Zoomed in first so 15 screen pixels is about
  // 36 m on the ground and the snap can only land on the station meant.
  // Isolated and thrown away, so the five-shape fixture is undisturbed.
  const snapped = await page.evaluate((p) => {
    state.map.setView([p.lat, p.lon], 15);
    MapDraw.setTool('pin');
    state.map.fire('click', { latlng: L.latLng(p.lat, p.lon) });
    MapDraw.setTool('');
    const sh = state.draw.shapes[state.draw.shapes.length - 1];
    const out = { kind: sh.kind, snappedTo: (sh.snappedTo || []).slice(),
                  name: MapDraw.exportShapes().pop() };
    state.draw.shapes.pop();
    MapDraw.render();
    MapDraw.rerenderPanel();
    return out;
  }, seeded.peer);
  check('clicking a station with the pin tool snaps to it',
    snapped.kind === 'pin' && snapped.snappedTo[0] === seeded.peer.id,
    JSON.stringify(snapped.snappedTo));

  const snappedName = await page.evaluate((sh) => drawKmlName(sh), snapped.name);
  check('a snapped pin is named for its station, once',
    snappedName === seeded.peer.name, snappedName);

  // ── 7. A station deleted while its shape was on the map ───────────────────
  const ghost = await page.evaluate(() => {
    const before = state.draw.shapes.length;
    MapDraw.addLine([[-20, 145], [-21, 146]], ['no-such-station', 'nor-this-one']);
    const xml = drawingKml();
    state.draw.shapes.pop();
    return { before, blanks: (xml.match(/<name><\/name>/g) || []).length,
             marks: (xml.match(/<Placemark>/g) || []).length };
  });
  check('a station id that no longer resolves is dropped, not written blank',
    ghost.blanks === 0, `${ghost.blanks} nameless placemark(s)`);

  // ── 8. The button, pressed for real ───────────────────────────────────────
  // The button is clicked through the element rather than with a pointer: this
  // panel lives in a MapChrome flyout that is only laid out while the mouse is
  // on it, and whether *that* stays open is mapctl.mjs's assertion, not this
  // file's. The click is still the real one — same element, same handler.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.evaluate(() => document.querySelector('#map-draw-panel .draw-export').click()),
  ]);
  const stamp = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  check('the button downloads a dated KML',
    download.suggestedFilename() === `meganet-drawing-${stamp}.kml`,
    download.suggestedFilename());

  const stream = await download.createReadStream();
  let body = '';
  for await (const chunk of stream) body += chunk;
  // Byte-for-byte apart from the one thing that legitimately differs between
  // two calls: the Document description carries the export time, and the two
  // were generated seconds apart. Everything the rest of this file asserted
  // about has to be identical in what the button actually handed over.
  const undated = (t) => t.replace(/Exported from MegaNet[\s\S]*?\]\]><\/description>/, '');
  check('what it downloads is the document that was asserted about',
    undated(body) === undated(kml),
    `${body.length} bytes vs ${kml.length}`);

  await page.waitForTimeout(120);
  const said = await page.evaluate(() => document.getElementById('app-status').textContent);
  check('and it says what left', /5 shapes and \d+ stations/.test(said), said);

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the drawing leaves as a KML, in the right place on the right planet.');
