// MegaNet — map-los.js
//
//   MapLos   colours a drawn link line red when terrain says the path is
//            obstructed — the Path profile tool's own verdict, asked of every
//            line on the map instead of the one line an operator drew.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and cssVar; across to terrain.js for
// Terrain.profile and to path-profile.js for pathAnalyse, rmSystemOf and the
// PATH_DEFAULT_* constants — the same physics, the same endpoint rules, so
// this layer and the profile card can never argue about what "obstructed"
// means. All of it called from inside MapLos' own functions only, so this
// file's position among the modules is free.
//
// ── The smart part: never compute the same path twice ────────────────────────
//
// A whole-network sweep is hundreds of links and each one wants terrain tiles,
// so the work is (1) asked for, never assumed — an off-by-default Map display
// switch, MapSurvey's reasoning for layers that cost requests; (2) queued at a
// small concurrency so Terrain's 128-tile LRU is shared, not thrashed; and
// (3) remembered. A verdict is cached under a signature built from the
// physics inputs alone — both ends' coordinates, surveyed elevations, antenna
// heights, the frequency, the sample count — so the cache never needs telling
// when the station list changes: a moved pin, an edited elevation or a
// retuned repeater simply computes a new signature and misses. Verdicts
// persist in localStorage ('mn-los-v1', pruned oldest-first at 2,000), so the
// sweep is paid for once per network, not once per session.
//
// A verdict from a profile with missing tiles is only trusted one way: an
// obstruction seen over gaps is real, but "clear" over gaps is a guess, and
// guesses are neither cached nor painted (terrain.js's loud-failure rule).
// The maths carries the profile tool's own caveats — k=4/3 earth, ~30 m
// terrain, no trees or clutter — and the note under the switch says so.
const MapLos = (function () {
  const STORE       = 'mn-los-v1';
  const SAMPLES     = 64;   // catches a significant obstruction at a quarter of
                            // the profile card's bill; the signature carries it,
                            // so a future change re-computes rather than lies
  const CONCURRENCY = 4;    // profiles in flight; Terrain dedups tiles beneath
  const CAP         = 5000; // persisted verdicts kept — above the ~3,100 links
                            // this network draws with filters off, because a
                            // cap below the working set turns the cache into a
                            // treadmill (~120 bytes an entry; ~600 KB at cap)

  let mem = null;           // Map sig → { v: verdict, r: worstRatio, t: stampMs }
  let gen = 0;              // refreshMapLayers generation; stale results still
                            // cache, they just stop touching dead lines
  let queue = [], running = 0, persistTimer = null;
  let note = { pending: 0, obstructed: 0, done: 0, failed: 0 };

  function hydrate() {
    if (mem) return;
    mem = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.v === 'string') mem.set(k, v);
      }
    } catch (_) {}
  }

  // Writes are debounced: a cold sweep lands results in bursts, and one
  // stringify of a few thousand entries per burst beats one per link. Only
  // the *persisted* copy is pruned — evicting from the live Map would throw
  // away verdicts for lines still on screen and turn the next filter change
  // into a re-sweep; cache hits refresh their stamp, so what survives the
  // prune is the working set, not whatever happened to land first.
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        let entries = [...mem.entries()];
        if (entries.length > CAP) {
          entries.sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
          entries = entries.slice(0, CAP);
        }
        localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(entries)));
      } catch (_) {}
    }, 2000);
  }

  // The endpoint rules are PathProfile's own (endpoint()/freqFor() there):
  // surveyed elevation_ahd over the tile sample, the station's rm_system
  // antenna height else the 4 m field default, either end's repeater RX else
  // the network's VHF band. The one divergence is deliberate: the profile
  // card lets an operator override AGL and frequency for what-ifs, and this
  // layer never follows those — the map states the network as filed, and the
  // card is where hypotheticals live.
  function endParams(s) {
    const sys = rmSystemOf(s);
    return {
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      agl:  sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
    };
  }

  function freqFor(a, b) {
    for (const s of [a, b]) {
      const r = s.repeater;
      if (r && r.rx_mhz > 0) return r.rx_mhz;
    }
    return PATH_DEFAULT_MHZ;
  }

  function sigFor(a, b) {
    const pa = endParams(a), pb = endParams(b);
    return [
      a.lat.toFixed(5), a.lon.toFixed(5), pa.elev == null ? '' : pa.elev, pa.agl,
      b.lat.toFixed(5), b.lon.toFixed(5), pb.elev == null ? '' : pb.elev, pb.agl,
      freqFor(a, b), SAMPLES,
    ].join('|');
  }

  function blockedColor() {
    return cssVar('--map-line-blocked', '#d81b60');
  }

  function setNote() {
    const el = document.getElementById('map-los-note');
    if (el) el.innerHTML = noteHtml();
  }

  // Paint one line with its verdict. mnBaseColor is what MapBlast's restore
  // puts back after a blast disarms — updating it here is what lets blast-red
  // and obstruction-red coexist on the same line without erasing each other.
  function paint(line, verdict) {
    line.mnLosVerdict = verdict;
    // A fade margin has already been painted here, so leave it alone. Both
    // layers may be on at once and both may want this line red; the one with a
    // figure behind it wins, because the margin is computed over the same
    // terrain and has already been charged for the obstruction. Without this
    // the two race — whichever profile landed last picked the colour — and a
    // link would read green or red depending on the order the tiles arrived in.
    if (line.mnFadeBand) return;
    if (verdict === 'obstructed') {
      const c = blockedColor();
      line.mnBaseColor = c;
      if (!line.mnBlastRed) line.setStyle({ color: c });
    }
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      const hit = mem.get(job.sig);
      if (hit) {
        hit.t = Date.now();
        if (job.gen === gen) { paint(job.line, hit.v); note.done++; if (hit.v === 'obstructed') note.obstructed++; }
        note.pending--;
        continue;
      }
      running++;
      const { a, b } = job;
      Terrain.profile([[a.lat, a.lon], [b.lat, b.lon]], SAMPLES).then(prof => {
        let v = null;
        if (prof && prof.ok) {
          const pa = endParams(a), pb = endParams(b);
          const an = pathAnalyse(prof, {
            elevA: pa.elev, elevB: pb.elev, aglA: pa.agl, aglB: pb.agl,
            freqMhz: freqFor(a, b),
          });
          if (an.ok) {
            // Gaps in the tiles only prove an obstruction, never clearance.
            if (!prof.partial || an.verdict === 'obstructed') v = an.verdict;
          }
        }
        if (v) {
          mem.set(job.sig, { v, r: null, t: Date.now() });
          persistSoon();
        }
        // The generation guard everywhere below: a rebuild has already reset
        // the counters and destroyed this job's line, so a stale result may
        // land in the cache (it did real work) but not on the ledger.
        if (job.gen === gen) {
          if (v) {
            paint(job.line, v);
            note.done++;
            if (v === 'obstructed') note.obstructed++;
          } else {
            note.failed++;
          }
        }
      }).catch(() => {
        if (job.gen === gen) note.failed++;
      }).finally(() => {
        running--;
        if (job.gen === gen) note.pending--;
        setNote();
        pump();
      });
    }
    setNote();
  }

  function noteHtml() {
    const caveat = 'The Path profile tool’s own verdict — k=4/3 earth, ~30 m terrain, '
      + 'filed antenna heights, no trees — asked of every drawn link and remembered, '
      + 'so a network is only ever computed once. Indicative, like the profile.';
    if (!state.mapLos) {
      return 'Colour a link red when terrain blocks its line of sight. ' + caveat;
    }
    const bits = [];
    if (note.obstructed) bits.push(`<span class="txt-bad">${note.obstructed} obstructed</span>`);
    else if (note.done) bits.push(`${note.done} checked, none obstructed`);
    if (note.pending) bits.push(`${note.pending} still checking…`);
    // The loud-failure rule reaches the note too: zero completed checks must
    // never read as an all-clear, so failures say so in as many words.
    if (note.failed) bits.push(`<span class="txt-warn">${note.failed} could not be checked — terrain tiles unreachable?</span>`);
    if (!bits.length) bits.push('no links drawn to check');
    return `${bits.join(' · ')}<br>${caveat}`;
  }

  return {
    // refreshMapLayers announces each rebuild before it draws: lines from the
    // last round are gone, so results still in flight must stop touching them.
    // The queue restarts empty; the cache, of course, survives.
    newGeneration() {
      gen++;
      queue = [];
      note = { pending: 0, obstructed: 0, done: 0, failed: 0 };
    },

    // Called for every core (non-casing) line as refreshMapLayers draws it.
    // A cached verdict paints synchronously; a miss queues, in the order the
    // links were drawn. No-op while the switch is off.
    classify(line, a, b) {
      if (!state.mapLos) return;
      if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return;
      hydrate();
      const sig = sigFor(a, b);
      const hit = mem.get(sig);
      if (hit) {
        hit.t = Date.now();
        paint(line, hit.v);
        note.done++;
        if (hit.v === 'obstructed') note.obstructed++;
        return;
      }
      note.pending++;
      queue.push({ line, a, b, sig, gen });
    },

    // refreshMapLayers calls this once, after both link loops: starting the
    // pumps after every line is queued keeps the four slots working the whole
    // list rather than racing the loop that fills it.
    kick() {
      if (state.mapLos) pump(); else setNote();
    },

    noteHtml,

    active() { return state.mapLos; },

    // Off by default, not persisted — MapSurvey's reasoning: this one costs
    // terrain-tile requests. The redraw is what queues the classifications;
    // skipFit so asking a question about the links doesn't move the map.
    setEnabled(on) {
      state.mapLos = on;
      refreshMapLayers({ skipFit: true });
      setNote();
    },
  };
})();
if (typeof window !== 'undefined') window.MapLos = MapLos;
