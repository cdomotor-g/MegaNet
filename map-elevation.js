// MegaNet — map-elevation.js
//
//   MapElevation   a base map that IS the terrain: ground height, banded into
//                  colours, decoded in the browser from the same terrarium
//                  tiles the elevation profile is built on.
//
// After core.js and before map-controls.js's makeBaseLayers() is *called* —
// index.html holds the order and the reasons. Reaches back to core.js for
// `state` only, and to nothing else in the app: the tile source is written out
// here rather than borrowed from terrain.js because the two want different
// things from it (that one wants metres at a point and caches them decoded,
// this one wants pixels on screen and lets the browser's HTTP cache do the
// keeping), and a shared 128-tile LRU sized for a profile would be thrashed
// flat by a base map. Same URL, same datum, same attribution — said in both
// places rather than reached for.
//
// ── Why an overlay and not a base map (#186) ─────────────────────────────────
// It shipped as a base map, one radio beside OSM-Topo, Satellite and Dark, on
// the reasoning that "what does this country look like" is the question you
// have before you draw anything on it. That reasoning was sound and the answer
// was still wrong, for a reason a radio button cannot express: **the ground and
// the place names are not alternatives.** Picked as a base, the ramp took the
// localities, the roads and the watercourses with it, so the operator who
// wanted to see which of two hills a site sits on lost the names of both.
//
// So it is an overlay now, on the Stations map's Map display panel with an
// opacity slider — the control that makes the two readings one picture instead
// of a choice between them. It draws just above the base tiles and *below* the
// place-name layers that ride along with Satellite and Dark (pane 245, under
// mnBaseLabels' 250), so on those two bases the names stay crisp over the wash;
// on OSM-Topo the names are baked into the tiles and the slider is the whole of
// the answer.
//
// The cost, stated rather than discovered: the other six maps had this in their
// picker and no longer do. Map display is the Stations map's own panel, and a
// second copy of the switch in the shared base picker would be two controls for
// one layer.
//
// The layer is L.TileLayer with createTile overridden to return a <canvas>
// rather than an <img>. Everything else about a tile layer — the tile grid,
// the pyramid, retention on zoom, maxNativeZoom's overzoom arithmetic — is
// Leaflet's and is left alone. maxNativeZoom is terrain.js's MAX_ZOOM for
// terrain.js's reason: the source is ~30 m SRTM, and past z12 the tiles are
// resampling their own pixels. Leaflet stretches the z12 tile from there.
//
// ── The colours ──────────────────────────────────────────────────────────────
// From the Radio Mobile colour file in #184 (twelve heights, twelve colours).
// The colour list in that format runs the way a legend is *drawn* — top of the
// strip first, which is the highest band — while the heights run bottom-up, so
// the two lists are paired end to end rather than head to head. Read the other
// way round the ramp puts pure blue on the mountains and pale yellow on the
// coast, and the grey (8F8F8F) lands on the coastal flats instead of where a
// grey in a hypsometric ramp always is: the bare rock just under the top of
// the scale. Paired as below it reads the way every topographic sheet reads —
// water blue, lowlands cyan, ranges green, tops grey then pale.
//
// Bands, not a gradient: a colour file is a set of bands and Radio Mobile
// draws it as one, so a boundary here is a real height an operator can point
// at rather than a place where two colours happen to blend.
const MapElevation = (function () {
  const TILE_URL   = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_PX    = 256;
  const MAX_NATIVE = 12;    // terrain.js's MAX_ZOOM, for terrain.js's reason
  const ATTRIB     = 'Elevation: AWS Terrain Tiles (SRTM/GMTED, ~30 m), height above the EGM96 geoid';

  // Lower bound of each band, ascending, with the colour that band is painted.
  // Anything below the first band is painted the first band's colour — the sea
  // is blue and so is a metre of it.
  const RAMP = [
    { m:    0, hex: '#0000FF' },
    { m:    1, hex: '#6464FF' },
    { m:   50, hex: '#4080FF' },
    { m:  100, hex: '#2F97FF' },
    { m:  150, hex: '#00F4F4' },
    { m:  250, hex: '#88FFFF' },
    { m:  400, hex: '#4B9700' },
    { m:  500, hex: '#00CA00' },
    { m:  700, hex: '#00FF80' },
    { m:  800, hex: '#80FF00' },
    { m:  900, hex: '#8F8F8F' },
    { m: 1000, hex: '#FFFF80' },
  ];

  // The ramp as three flat arrays, built once: a per-pixel loop that reads
  // objects and parses hex strings is the difference between a tile that
  // paints in 4 ms and one that paints in 60.
  const CUT = RAMP.map(b => b.m);
  const R = RAMP.map(b => parseInt(b.hex.slice(1, 3), 16));
  const G = RAMP.map(b => parseInt(b.hex.slice(3, 5), 16));
  const B = RAMP.map(b => parseInt(b.hex.slice(5, 7), 16));

  // ── Relief ──────────────────────────────────────────────────────────────────
  // Twelve bands over a thousand metres is four colours for the whole of
  // coastal Queensland, and a base map that is one flat blue from Bundaberg to
  // Brisbane is not a base map. So the band colour is *shaded* by the ground's
  // own slope — the standard hillshade, light from the north-west at 45°,
  // multiplied over the hue. The hue is still the height and nothing else; the
  // shading only says which way the ground is leaning, which is what makes a
  // ridge line visible between two contours of the same colour.
  //
  // It can be switched off from the Base map panel for anyone comparing this
  // against Radio Mobile's own flat rendering of the same colour file.
  //
  // The gradient at a tile's edge is taken from the pixel one step inside it,
  // rather than from the neighbouring tile that has not been fetched: the
  // outermost row and column of every tile are therefore shaded like their
  // neighbour. That is a one-pixel error at the native zoom and it draws no
  // seam, because both sides of a shared edge make the same substitution.
  const AZIMUTH  = 315 * Math.PI / 180;
  const ZENITH   = 45 * Math.PI / 180;
  const Z_FACTOR = 2.2;     // vertical exaggeration; ~30 m ground detail is
                            // otherwise almost flat at map scale
  const SHADE_LO = 0.62, SHADE_HI = 1.22;

  let relief = (() => { try { return localStorage.getItem('mn-elev-relief') !== 'off'; }
                        catch (_) { return true; } })();

  const live = new Set();   // every layer instance on any map, for a repaint

  // Ground distance one tile pixel covers, which is what turns a height
  // difference into a slope. Web Mercator, at the tile's own centre latitude.
  function metresPerPixel(z, y) {
    const n   = Math.PI - 2 * Math.PI * (y + 0.5) / Math.pow(2, z);
    const lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return 156543.03392804097 * Math.cos(lat) / Math.pow(2, z);
  }

  // Which band a height falls in. Linear over twelve entries, walked from the
  // top down: the tail of the ramp is where the rare heights are, so most
  // pixels answer in the first two or three comparisons.
  function bandOf(m) {
    for (let i = CUT.length - 1; i > 0; i--) if (m >= CUT[i]) return i;
    return 0;
  }

  function paint(canvas, img, z, ty) {
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    const data = cx.getImageData(0, 0, TILE_PX, TILE_PX);
    const px = data.data;
    const N = TILE_PX * TILE_PX;

    // Terrarium: elevation_m = (R·256 + G + B/256) − 32768.
    const h = new Float32Array(N);
    for (let i = 0, j = 0; j < N; i += 4, j++) {
      h[j] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
    }

    const res = metresPerPixel(z, ty);
    const cosZ = Math.cos(ZENITH), sinZ = Math.sin(ZENITH);

    for (let y = 0, j = 0; y < TILE_PX; y++) {
      // Clamped one step inside the tile at both edges — see the note above.
      const yUp = y > 0 ? y - 1 : 0, yDn = y < TILE_PX - 1 ? y + 1 : TILE_PX - 1;
      const spanY = (yDn - yUp) * res;
      for (let x = 0; x < TILE_PX; x++, j++) {
        const v = h[j];
        const b = bandOf(v);
        let r = R[b], g = G[b], bl = B[b];

        if (relief) {
          const xL = x > 0 ? x - 1 : 0, xR = x < TILE_PX - 1 ? x + 1 : TILE_PX - 1;
          const spanX = (xR - xL) * res;
          const dzdx = spanX > 0 ? (h[y * TILE_PX + xR] - h[y * TILE_PX + xL]) / spanX : 0;
          // y grows southward, so north-up rise is the row above minus below.
          const dzdy = spanY > 0 ? (h[yUp * TILE_PX + x] - h[yDn * TILE_PX + x]) / spanY : 0;
          const slope  = Math.atan(Z_FACTOR * Math.sqrt(dzdx * dzdx + dzdy * dzdy));
          const aspect = Math.atan2(dzdy, -dzdx);
          const hs = cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(AZIMUTH - aspect);
          // hs runs 0..1 with 0.707 at flat ground, so it is re-centred rather
          // than used raw: flat country must come out the band's own colour.
          const f = Math.max(SHADE_LO, Math.min(SHADE_HI, 1 + (hs - cosZ) * 1.15));
          r  = Math.min(255, r * f);
          g  = Math.min(255, g * f);
          bl = Math.min(255, bl * f);
        }

        const o = j * 4;
        px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = 255;
      }
    }
    cx.putImageData(data, 0, 0);
  }

  // L.TileLayer, with the <img> swapped for a <canvas> we draw ourselves.
  // Everything Leaflet does around a tile — the grid, retention, the
  // maxNativeZoom overzoom that hands us native coordinates and a stretched
  // CSS size — is untouched, which is the whole reason for extending the tile
  // layer rather than inventing a layer.
  // Built on first use rather than at load. `L.TileLayer.extend()` is a call
  // into Leaflet, and running it in this file's IIFE body would make Leaflet a
  // real ordering constraint on a file that otherwise only declares — the one
  // property index.html's script list rests on. Nothing asks for a layer until
  // a map is being built, which is long after every script has parsed.
  let ElevationLayer = null;

  function layerClass() {
    if (ElevationLayer) return ElevationLayer;
    ElevationLayer = L.TileLayer.extend({
    initialize(opts) {
      L.TileLayer.prototype.initialize.call(this, TILE_URL, L.extend({
        attribution: ATTRIB,
        maxNativeZoom: MAX_NATIVE,
        maxZoom: 19,
        className: 'mn-base-elev',
      }, opts || {}));
    },

    onAdd(map) {
      live.add(this);
      return L.TileLayer.prototype.onAdd.call(this, map);
    },

    onRemove(map) {
      live.delete(this);
      return L.TileLayer.prototype.onRemove.call(this, map);
    },

    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = TILE_PX;
      // Whatever else goes wrong, a tile that never calls done() leaves
      // Leaflet holding a loading counter that never reaches zero.
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const z = this._getZoomForUrl();
      let settled = false;
      const finish = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(err || null, tile);
      };
      const timer = setTimeout(() => finish(new Error('terrain tile timed out')), 12000);
      img.onload = () => {
        // A tile that cannot be read back — CORS withdrawn, a tainted canvas —
        // is a blank tile and an error, never a plausible-looking wrong colour.
        try { paint(tile, img, z, coords.y); finish(null); }
        catch (e) { finish(e); }
      };
      img.onerror = () => finish(new Error('terrain tile unavailable'));
      img.src = this.getTileUrl(coords);
      return tile;
    },
    });
    return ElevationLayer;
  }

  // ── The overlay, on one map at a time ──────────────────────────────────────
  // The Stations map is the one with a Map display panel to switch it from, and
  // the layer is per-map like every other overlay in this app: attached when
  // the map is built, taken down with it.
  const PANE   = 'mnElevation';
  // Above the base tiles (200) and below the place-name layers that ride with
  // Satellite and Dark (mnBaseLabels, 250) — see the note at the top. Well
  // under the 320–350 band the other overlays share (map-survey.js documents
  // it), because this is ground rather than anything drawn on it.
  const PANE_Z = 245;

  let map = null, overlay = null;

  function sync() {
    if (!map) return;
    if (state.mapElev) {
      if (!overlay) {
        if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
        overlay = new (layerClass())({ pane: PANE, opacity: state.mapElevOpacity });
      }
      if (!map.hasLayer(overlay)) overlay.addTo(map);
      overlay.setOpacity(state.mapElevOpacity);
    } else if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  return {
    RAMP,
    attribution: ATTRIB,

    // The name it answers to. Kept as an export because the Map Generator reads
    // it to say which base maps it does *not* offer.
    NAME: 'Elevation',

    layer(opts) { return new (layerClass())(opts); },

    attach(m) { map = m; sync(); },

    detach() {
      if (overlay) overlay.remove();
      overlay = null;
      map = null;
    },

    active() { return !!state.mapElev; },

    // Off by default and remembered, on MapContours' terms rather than
    // MapSurvey's: it fetches a tile per screenful of terrain the moment it is
    // on, so a cold page load has to cost nothing.
    setEnabled(on) {
      state.mapElev = !!on;
      try { localStorage.setItem('mn-map-elev', on ? 'on' : 'off'); } catch (_) {}
      sync();
      rerenderMapDisplayControls();
      rerenderMapLegend();
    },

    // The whole point of it being an overlay: how much of the ground you want
    // against how much of the map under it. Applied in place — the tiles are
    // already drawn, and opacity is a style rather than a redraw.
    setOpacity(v) {
      const n = Math.max(0.1, Math.min(1, Number(v) || 0));
      state.mapElevOpacity = n;
      try { localStorage.setItem('mn-map-elev-opacity', String(n)); } catch (_) {}
      if (overlay) overlay.setOpacity(n);
    },

    opacity() { return state.mapElevOpacity; },

    noteHtml() {
      if (!state.mapElev) {
        return 'Ground height as colour, over whichever base map is picked — the slider decides '
             + 'which of the two you are mostly looking at.';
      }
      return `Painted at <strong>${Math.round(state.mapElevOpacity * 100)}%</strong> over the base
              map. Heights are above the EGM96 geoid, ~30 m sampling; the bands are the Radio
              Mobile colour file's own. On Satellite and Dark the place names draw over the top
              of it — on OSM-Topo they are in the tiles, so the slider is what brings them back.`;
    },

    // The hex a height is painted, for anything that wants to agree with this
    // ramp without drawing tiles — the peak markers, a legend, a key.
    colourAt(m) { return m == null || isNaN(m) ? RAMP[0].hex : RAMP[bandOf(m)].hex; },

    relief() { return relief; },

    // Every instance on every map redraws. `redraw()` is Leaflet's own and
    // re-runs createTile for the tiles it is holding.
    setRelief(on) {
      relief = !!on;
      try { localStorage.setItem('mn-elev-relief', relief ? 'on' : 'off'); }
      catch (_) { /* private browsing — the setting still holds this session */ }
      for (const l of live) l.redraw();
    },

    // The ramp as a legend strip, drawn highest band first the way a legend is
    // read — and the way the colour file itself is written.
    rampHtml() {
      return `<ul class="elev-ramp">${RAMP.map((b, i) => {
        const next = RAMP[i + 1];
        const label = next ? `${b.m}–${next.m} m` : `${b.m} m and above`;
        return `<li><i style="--dot:${b.hex}"></i><span>${label}</span></li>`;
      }).reverse().join('')}</ul>`;
    },
  };
})();
if (typeof window !== 'undefined') window.MapElevation = MapElevation;
