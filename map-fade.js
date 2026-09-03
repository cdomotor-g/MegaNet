// MegaNet — map-fade.js
//
//   MapFade   colours every drawn link by its fade margin — green, yellow or
//             red — instead of by the one bit MapLos answers. The margin is
//             the link budget card's own figure, computed for the whole
//             network on demand, saved to the datastore, and read straight
//             back out of it on the next page load.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, cssVar and acmaHaversineKm; across to
// terrain.js for Terrain.profile, to land-cover.js for LandCover.sample, to
// path-profile.js for pathAnalyse, rmSystemOf, wattsToDbm and the
// PATH_DEFAULT_* constants, and to datastore.js for dbSelect, dbRpc and
// dbCanWrite. All of it from inside MapFade's own functions, so this file's
// position among the modules is free.
//
// ── One figure, or none ──────────────────────────────────────────────────────
//
// This layer answers the question the link budget card answers, so it has to
// answer it the same way: 256 samples, the same land cover stood on the same
// terrain, the same Longley–Rice run. It did not, at first — 64 samples and
// bare ground, MapLos's economics applied to a question they do not suit — and
// the result was two fade margins for one link, 17.3 dB on the map and 2.2 dB
// on the card. Under-sampling a 46 km hop over a range accounted for 2.9 dB of
// that; the missing land cover accounted for the other 12.3, most of it P.2108
// terminal clutter at two antennas sitting under the canopy at 4 m.
//
// So: no cover, no figure. A margin over bare earth is not a cheaper version of
// this number, it is a different and always kinder one, and a link that reads
// green because nobody told it about the trees is worse than a link with no
// colour at all.
//
// ── Why this is not just MapLos with more colours ────────────────────────────
//
// MapLos asks "does the ground cut the line", which is geometry and costs one
// terrain profile. A fade margin asks "how much signal is left over", which is
// the whole Longley–Rice run plus both ends' radios — and it is the number an
// operator actually plans on. It is also the expensive one: the same terrain
// profile, but no useful answer at all for a pair whose radios are not on file.
//
// So the work is asked for, done once, and then **kept somewhere other than
// this browser**. That is the difference that matters. MapLos remembers its
// verdicts in localStorage, which means the second person to open the map pays
// for the sweep all over again. This one has a Save button: press it and the
// margins go to meganet.link_fade_margin, and from then on every page load
// paints the network from the datastore with no terrain fetched at all.
//
// ── What a saved row is, and when it stops being true ────────────────────────
//
// Every row carries the signature of the physics it was computed from — both
// ends' coordinates, surveyed elevations, antenna heights, transmit power,
// antenna gain, line loss and receive threshold, the frequency, the sample
// count, the propagation settings and a model version. A saved row is painted
// only when that signature still matches what the station list says today.
// Move a pin, retune a repeater, edit a system, change the reliability the
// card is set to, and the row silently stops matching: it is not painted, it
// is counted as stale, and the note says how many are waiting to be computed
// again. A colour that is quietly out of date is worse than no colour, because
// nothing on screen says which one you are looking at.
//
// ── The bands ────────────────────────────────────────────────────────────────
//
// Green at 15 dB and yellow at 6 dB by default, which is a planner's split
// rather than the link budget card's (10 / 3). The card is answering "is this
// link viable"; this map is answering "which of these would I rebuild first",
// and it wants more headroom before it says the word green. Both figures are
// editable and both are saved with the rows, so a row read back a year later
// carries the rule it was judged under — meganet.inspection_rain_gauge's
// adjustment_threshold_pct, and for its reason.
//
// Changing a threshold re-colours immediately and costs nothing: the margins
// are already computed, and a band is a comparison. Only the margins are
// expensive, and only they are swept.
const MapFade = (function () {
  const STORE       = 'mn-fade-v2';
  const SAMPLES     = 256;  // PathProfile's own figure, and that is the point:
                            // this layer and the link budget card have to be
                            // answering the same question with the same
                            // arithmetic, or the map and the card produce two
                            // different fade margins for one link and only one
                            // of them can be right. It was 64 — MapLos's
                            // figure, which is right for "is the path cut" and
                            // wrong for "how many decibels" — and on a 46 km
                            // hop over a range that under-sampling alone was
                            // worth 2.9 dB of terrain attenuation the map never
                            // charged for.
  const CONCURRENCY = 4;    // profiles in flight; Terrain dedups tiles beneath
  const CAP         = 5000; // margins kept in localStorage, MapLos's cap
  const CHUNK       = 400;  // rows per save request — a whole network is a
                            // ~3,100-row payload, and one of those is a request
                            // some proxy will refuse for its size alone
  const PAGE        = 1000; // rows per *read*. PostgREST's own ceiling, and it
                            // is applied silently: `limit=20000` came back with
                            // exactly a thousand rows and no error and no
                            // header saying so, which painted the first third
                            // of the network and left the rest looking as
                            // though nobody had ever computed it. Paging is
                            // the only way to read a table bigger than this.
  const PAGES_MAX   = 40;   // 40,000 rows — an order of magnitude past what
                            // this network can produce, so the loop always has
                            // a floor even if the cap moves
  // Bumped when anything about how the margin is derived changes. It is part of
  // the signature, so a bump invalidates every saved row rather than leaving
  // old figures to be read as new ones. /2 is 256 samples and land cover, which
  // together moved one real link from 17.3 dB to 2.1 — from the top of green to
  // the bottom of red, and the card had been saying 2.2 all along.
  const MODEL       = 'itm-p2p/2';

  let mem = null;           // Map sig → { m, ab, ba, v, t }  (this session + localStorage)
  let saved = null;         // Map pairKey → row, as read from the datastore
  let savedState = 'idle';  // idle | loading | ready | failed | absent
  let savedError = '';
  let gen = 0;
  let queue = [], running = 0, persistTimer = null;
  let note = { pending: 0, done: 0, failed: 0, stale: 0, fromDb: 0, noRadio: 0 };
  let saving = null;        // { done, total } while a save is in flight
  let saveMsg = null;       // { kind: 'ok'|'error', text } — the last save's outcome
  let pendingRows = null;   // memoised unsaved(); null means "work it out again"
  let btnTimer = null;

  const G = () => state.mapFadeGoodDb;
  const O = () => state.mapFadeOkDb;

  // ── identity ──

  // Undirected, because one line is drawn per pair and one row is stored per
  // pair. map-backbone.js's pairKey, borrowed rather than re-invented.
  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

  // The radios at one end, as filed. Same rules as MapLos's endParams for the
  // geometry, plus the four figures a budget needs — and the same refusal to
  // invent any of them: a term nobody supplied blanks the margin rather than
  // being read as nought (link-budget.js's rule, inherited).
  function endSys(s) {
    const sys = rmSystemOf(s);
    return {
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      agl:  sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
      txW:  sys && sys.tx_power_w != null ? sys.tx_power_w : null,
      gain: sys && sys.antenna_gain_dbi != null ? sys.antenna_gain_dbi : null,
      loss: sys && sys.line_loss_db != null ? sys.line_loss_db : null,
      thr:  sys && sys.rx_threshold_dbm != null ? sys.rx_threshold_dbm : null,
    };
  }

  function freqFor(a, b) {
    for (const s of [a, b]) {
      const r = s.repeater;
      if (r && r.rx_mhz > 0) return r.rx_mhz;
    }
    return PATH_DEFAULT_MHZ;
  }

  // Everything the margin depends on, in a fixed order, and nothing else. The
  // thresholds are deliberately absent: re-banding an existing figure is free,
  // so a changed threshold must not throw away a sweep.
  function sigFor(a, b) {
    const pa = endSys(a), pb = endSys(b);
    const p = pathPropOf({});
    const end = (s, e) => [
      s.lat.toFixed(5), s.lon.toFixed(5), e.elev == null ? '' : e.elev, e.agl,
      e.txW == null ? '' : e.txW, e.gain == null ? '' : e.gain,
      e.loss == null ? '' : e.loss, e.thr == null ? '' : e.thr,
    ].join(',');
    // Ends in pair order, so a→b and b→a produce one signature for one line.
    const ends = a.id < b.id ? [end(a, pa), end(b, pb)] : [end(b, pb), end(a, pa)];
    return [
      MODEL, ends[0], ends[1], freqFor(a, b), SAMPLES, 'cover',
      p.climate, p.N0, p.epsilon, p.sigma, p.pol, p.mdvar, p.time, p.location, p.situation,
    ].join('|');
  }

  // ── the margin ──

  // Both directions, and the worse of the two. A link is a conversation: the
  // path loss is reciprocal but the radios at either end are not, and a hop
  // that gets there and cannot answer is not a working link. Nothing else in
  // the app takes this view — the budget card is pointed A→B because an
  // operator aimed it — but the map is drawing one line for the pair, and one
  // line can only honestly carry the worse number.
  function marginFrom(an, from, to) {
    const f = endSys(from), t = endSys(to);
    const txDbm = wattsToDbm(f.txW);
    if (txDbm == null || f.gain == null || f.loss == null) return null;
    if (t.gain == null || t.loss == null || t.thr == null) return null;
    if (an.pathLoss_db == null) return null;
    return (txDbm + f.gain - f.loss) - an.pathLoss_db + t.gain - t.loss - t.thr;
  }

  function marginPair(an, a, b) {
    const ab = marginFrom(an, a, b), ba = marginFrom(an, b, a);
    if (ab == null || ba == null) return null;
    return { m: Math.min(ab, ba), ab, ba };
  }

  // ── the bands ──

  function bandOf(db) { return db >= G() ? 'good' : db >= O() ? 'ok' : 'bad'; }

  const BAND_TOKEN = { good: '--map-fade-good', ok: '--map-fade-ok', bad: '--map-fade-bad' };
  const BAND_FALLBACK = { good: '#00e676', ok: '#ffab00', bad: '#e53935' };

  function bandColour(band) {
    return cssVar(BAND_TOKEN[band], BAND_FALLBACK[band]);
  }

  // Paint one line. mnBaseColor is what MapBlast's restore puts back when a
  // blast disarms, so it moves with the colour — MapLos's lesson, and the same
  // reason: two layers may want this line red at once and neither may erase
  // the other's reason for it.
  //
  // The good band also gets a heavier core. The point of the exercise is a
  // network you can read at a glance over a satellite base map, and the one
  // colour that has to survive that is green: half the ground under these
  // links is green already. A saturated hue and the white casing under it do
  // most of the work; the extra weight is what finishes it.
  function paint(line, band, margin) {
    line.mnFadeBand = band;
    line.mnFadeMargin = margin;
    const c = bandColour(band);
    line.mnBaseColor = c;
    const style = { color: c };
    if (band === 'good') {
      style.weight = line.mnLinkRole === 'backbone' ? MAP_BACKBONE_CORE_W + 1 : MAP_LINK_CORE_W + 1;
    }
    if (!line.mnBlastRed) line.setStyle(style);
    // The figure itself, on hover. A colour says which of three buckets; the
    // number is what anybody who cares about the colour asks next.
    if (typeof line.bindTooltip === 'function' && margin != null) {
      line.bindTooltip(`Fade margin ${margin > 0 ? '+' : ''}${margin.toFixed(1)} dB`, { sticky: true });
    }
  }

  // ── the local cache ──

  function hydrate() {
    if (mem) return;
    mem = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.m === 'number') mem.set(k, v);
      }
    } catch (_) {}
  }

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

  // ── the datastore ──

  // Read once per page, whether or not the switch is on: the whole point of
  // saving is that the colours are there before anybody asks for them. A
  // failure is remembered rather than retried on every repaint — the sleeping
  // free-tier project would otherwise turn one dead read into one per render
  // (station-inspections.js's sticky-failure rule).
  function loadSaved() {
    // Every state but 'idle' means the question has been asked, and asking it
    // twice is not merely wasteful — it does not terminate. The answer calls
    // settled(), settled() redraws the map, the redraw classifies every line,
    // and classify() asks again. 'absent' was missing from this list, so a
    // network with nothing saved yet — which is every network the first time
    // anybody turns the switch on — spun here instead of sweeping: each pass
    // cleared the queue it had just filled, and not one terrain profile was
    // ever fetched. Only save() may put it back to 'idle', which is how the
    // re-read after a save is allowed through.
    if (savedState !== 'idle') return;
    savedState = 'loading';
    readAllSaved()
      .then(rows => {
        saved = new Map();
        for (const r of rows) saved.set(pairKey(r.station_a_id, r.station_b_id), r);
        savedState = rows.length ? 'ready' : 'absent';
        pendingRows = null;
        // The thresholds come back with the rows, and adopting them is what
        // makes "we agreed on 15 and 6" a property of the network rather than
        // of whoever's browser is open. An operator who has set their own keeps
        // theirs — a stored preference is a decision, and this must not
        // overrule it. The newest row wins where a network has been saved twice
        // under two different rules and only half of it re-saved.
        if (rows.length && !state.mapFadeBandsSet) {
          const newest = rows.reduce((a, b) => (a.computed_at > b.computed_at ? a : b));
          const g = Number(newest.good_db), o = Number(newest.ok_db);
          if (isFinite(g) && isFinite(o) && g > o) { state.mapFadeGoodDb = g; state.mapFadeOkDb = o; }
        }
        settled();
      })
      .catch(err => {
        savedState = 'failed';
        savedError = (err && err.message) || String(err);
        settled();
      });
  }

  // Every saved row, a page at a time. Ordered by the primary key rather than
  // by computed_at, because offset paging over a column whose values are all
  // within a second of each other is not paging at all — rows repeat and rows
  // go missing, and the ones that go missing are indistinguishable from links
  // nobody has computed.
  async function readAllSaved() {
    const cols = 'station_a_id,station_b_id,margin_db,margin_ab_db,margin_ba_db,'
               + 'verdict,signature,good_db,ok_db,computed_at';
    const out = [];
    for (let page = 0; page < PAGES_MAX; page++) {
      const rows = await dbSelect(`link_fade_margin?select=${cols}`
        + `&order=station_a_id.asc,station_b_id.asc&limit=${PAGE}&offset=${page * PAGE}`);
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  // The datastore has answered, one way or the other. The map was drawn before
  // it did, so it is drawn again — which is what paints the saved rows, and
  // what releases the sweep for everything they did not cover (see kick()).
  function settled() {
    if (state.mapFade && state.map) refreshMapLayers({ skipFit: true });
    else setNote();
  }

  // Everything computed this session that the datastore does not already have
  // under the same signature. This is what Save sends, and its length is what
  // the button counts.
  function unsaved() {
    if (pendingRows) return pendingRows;
    return (pendingRows = buildUnsaved());
  }

  function buildUnsaved() {
    const out = [];
    if (!state.data) return out;
    hydrate();
    const seen = new Set();
    for (const link of allLinks()) {
      const { a, b, kind } = link;
      const key = pairKey(a.id, b.id);
      if (seen.has(key)) continue;
      const sig = sigFor(a, b);
      const hit = mem.get(sig);
      if (!hit) continue;
      const row = saved && saved.get(key);
      if (row && row.signature === sig
          && Number(row.good_db) === G() && Number(row.ok_db) === O()) continue;
      seen.add(key);
      const [x, y] = a.id < b.id ? [a, b] : [b, a];
      out.push({
        station_a_id: x.id, station_b_id: y.id, kind,
        margin_db: round1(hit.m),
        margin_ab_db: round1(a.id < b.id ? hit.ab : hit.ba),
        margin_ba_db: round1(a.id < b.id ? hit.ba : hit.ab),
        distance_km: round1(acmaHaversineKm(a.lat, a.lon, b.lat, b.lon)),
        freq_mhz: freqFor(a, b),
        verdict: hit.v || null,
        signature: sig,
        model: MODEL,
      });
    }
    return out;
  }

  function round1(n) { return n == null || !isFinite(n) ? null : Math.round(n * 10) / 10; }

  // Every link the map would draw right now, whatever is on screen. Save is
  // about the network, not about the current filter — an operator who narrowed
  // the list to one catchment and then saved would otherwise wipe nothing and
  // store a tenth of it, which reads identically on their screen and not at
  // all on anyone else's.
  function allLinks() {
    const out = [];
    if (!state.data) return out;
    try {
      for (const l of passRangeLinks(state.data.stations)) {
        if (l.s.lat == null || l.r.lat == null) continue;
        out.push({ a: l.s, b: l.r, kind: 'field' });
      }
    } catch (_) {}
    try {
      for (const p of backboneLinks(MAX_LINK_KM_CAP)) {
        if (p.a.lat == null || p.b.lat == null) continue;
        out.push({ a: p.a, b: p.b, kind: 'backbone' });
      }
    } catch (_) {}
    return out;
  }

  // ── the sweep ──

  function setNote() {
    const el = document.getElementById('map-fade-note');
    if (el) el.innerHTML = noteHtml();
    refreshSaveBtnSoon();
  }

  // The button's label is a count over every link the network has, and the
  // sweep settles a job every few hundred milliseconds — so it is worked out
  // when the dust settles rather than on every one of them. Without the
  // debounce a 3,000-link sweep re-derives 3,000 signatures 3,000 times, and
  // the browser spends longer counting than computing.
  function refreshSaveBtnSoon() {
    clearTimeout(btnTimer);
    btnTimer = setTimeout(refreshSaveBtn, 600);
  }

  function refreshSaveBtn() {
    const btn = document.getElementById('map-fade-save');
    if (!btn) return;
    const n = saving ? 0 : unsaved().length;
    btn.disabled = !!saving || !n || !dbCanWrite();
    btn.title = dbCanWrite() ? '' : 'Sign in to save — the datastore takes writes from an editor only.';
    btn.textContent = saving
      ? `Saving ${saving.done} of ${saving.total}…`
      : n ? `Save ${n} to the datastore` : 'Save to the datastore';
  }

  // One link: terrain, then the cover standing on it, then the model over both.
  // This is PathProfile.sync()'s sequence and PathProfile.coverFor()'s rules,
  // deliberately — the whole point of the layer is that the colour on the map
  // and the figure on the card are the same figure.
  //
  // Cover is not optional here. It was, and the map was the poorer for it: on a
  // 46 km hop with both antennas at 4 m under the canopy, P.2108's terminal
  // clutter alone came to 10.6 dB, and without it the map called a 2 dB link a
  // 17 dB one and painted it green. A margin computed over bare ground is not a
  // cheaper version of this figure, it is a different and consistently
  // optimistic one — so cover that cannot be fetched is a link that cannot be
  // computed, and says so, rather than one quietly answered from bare earth.
  async function computeOne(a, b) {
    const prof = await Terrain.profile([[a.lat, a.lon], [b.lat, b.lon]], SAMPLES);
    if (!prof || !prof.ok) return null;
    // A margin over bridged gaps is a guess dressed as a figure, and unlike an
    // obstruction it is not true in one direction either — so a partial profile
    // is refused outright (terrain.js's loud-failure rule, at its strictest).
    if (prof.partial) return null;
    const res = await LandCover.sample(prof.lat, prof.lon);
    if (!res || !res.ok) return null;
    const pa = endSys(a), pb = endSys(b);
    const an = pathAnalyse(prof, {
      elevA: pa.elev, elevB: pb.elev, aglA: pa.agl, aglB: pb.agl,
      freqMhz: freqFor(a, b),
      cover: res.cls, canopy: res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return null;
    const m = marginPair(an, a, b);
    return m ? { m: m.m, ab: m.ab, ba: m.ba, v: an.verdict, t: Date.now() } : null;
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      running++;
      computeOne(job.a, job.b).then(hit => {
        if (hit) { mem.set(job.sig, hit); persistSoon(); pendingRows = null; }
        if (job.gen === gen) {
          if (hit) { paint(job.line, bandOf(hit.m), hit.m); note.done++; }
          else note.failed++;
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
    const caveat = 'Longley–Rice over ~30 m terrain with the land cover standing on it, at the '
      + 'reliability the link budget card is set to, both ends&rsquo; filed radios, the worse of the '
      + 'two directions. The same arithmetic the card runs, over the same 256 samples, so a colour '
      + 'here and a figure there cannot disagree. Indicative, like the card &mdash; and every bit as '
      + 'much a model, not a measurement.';
    if (!state.mapFade) {
      return `Colour every link by its fade margin instead of one flat orange: green at
              ${G()} dB or better, yellow at ${O()}, red below. Turning it on computes what the
              datastore has not already been told; Save puts the answers there, and after that a
              page load paints the network without fetching a single terrain tile. ${caveat}`;
    }
    const bits = [];
    if (note.fromDb) bits.push(`<span class="txt-ok">${note.fromDb} from the datastore</span>`);
    if (note.done)   bits.push(`${note.done} computed here`);
    if (note.pending) bits.push(`${note.pending} still computing…`);
    if (note.stale)   bits.push(`<span class="txt-warn">${note.stale} saved ${note.stale === 1 ? 'figure has' : 'figures have'} gone stale — the radios or the positions moved since</span>`);
    if (note.noRadio) bits.push(`${note.noRadio} with no radio system on file — no margin to give`);
    if (note.failed)  bits.push(`<span class="txt-warn">${note.failed} could not be computed — terrain or land cover unreachable, or the model refused the path</span>`);
    // The one way left for the map and the card to disagree, said out loud
    // where it happens. These figures always have the cover in them; the card
    // follows the operator's switch, so with cover off it is answering about
    // bare ground and will read higher — by 12 dB on a path with two antennas
    // under the canopy. The map does not follow the switch on purpose: it
    // states the network as filed, and cover-off is a what-if (MapLos's rule).
    if (!state.path.cover) {
      bits.push('<span class="txt-warn">ground cover is switched off on the profile card, so its figures'
              + ' are bare-ground ones and will read higher than these</span>');
    }
    if (savedState === 'failed') bits.push(`<span class="txt-warn">the datastore did not answer (${esc(savedError)}) — nothing saved is being shown</span>`);
    if (savedState === 'absent') bits.push('nothing saved yet');
    if (!bits.length) bits.push('no links drawn to colour');
    if (saveMsg) bits.push(`<span class="${saveMsg.kind === 'ok' ? 'txt-ok' : 'txt-bad'}">${esc(saveMsg.text)}</span>`);
    return `${bits.join(' · ')}<br>${caveat}`;
  }

  return {
    newGeneration() {
      gen++;
      queue = [];
      pendingRows = null;
      note = { pending: 0, done: 0, failed: 0, stale: 0, fromDb: 0, noRadio: 0 };
    },

    // One core line, as refreshMapLayers draws it. The order is the point:
    // a saved row that still matches wins, then this session's cache, then the
    // queue. Everything but the queue paints synchronously, so a network whose
    // margins are in the datastore is coloured in the same frame it is drawn.
    classify(line, a, b, kind) {
      if (!state.mapFade) return;
      if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return;
      hydrate();
      loadSaved();
      const sig = sigFor(a, b);

      const row = saved && saved.get(pairKey(a.id, b.id));
      if (row) {
        if (row.signature === sig) {
          const m = Number(row.margin_db);
          if (isFinite(m)) {
            // Keep it in the session cache too, so Save can tell what is
            // already stored and the note can stop counting it as work.
            // The two directions come back with it, so re-saving a row after a
            // threshold change carries them forward instead of nulling them.
            // Stored in this line's own order, which pairKey may have flipped.
            if (!mem.has(sig)) {
              const flip = a.id > b.id;
              const num = v => (v == null || v === '' ? null : Number(v));
              mem.set(sig, {
                m,
                ab: num(flip ? row.margin_ba_db : row.margin_ab_db),
                ba: num(flip ? row.margin_ab_db : row.margin_ba_db),
                v: row.verdict || null, t: Date.now(),
              });
            }
            paint(line, bandOf(m), m);
            note.fromDb++;
            return;
          }
        } else {
          note.stale++;
        }
      }

      const hit = mem.get(sig);
      if (hit) {
        hit.t = Date.now();
        paint(line, bandOf(hit.m), hit.m);
        note.done++;
        return;
      }

      // A pair with no radios on file will never produce a figure however long
      // it is left, so it is named now rather than queued and failed later.
      const pa = endSys(a), pb = endSys(b);
      const bare = e => e.txW == null && e.gain == null && e.thr == null;
      if (bare(pa) || bare(pb)) { note.noRadio++; return; }

      note.pending++;
      queue.push({ line, a, b, kind, sig, gen });
    },

    kick() {
      if (!state.mapFade) { setNote(); return; }
      loadSaved();
      // Sweep the map a neighbourhood at a time, not in the order the links
      // happened to be drawn. Every profile pulls terrain tiles and land-cover
      // tiles, both held in small LRUs (128 and 48), and the drawing order is
      // by repeater across the whole state — so consecutive links shared almost
      // nothing and the caches evicted everything before it could be used
      // twice. Sorted into ~25 km cells the same tiles serve dozens of links in
      // a row: on this network it took the cover service from thirteen requests
      // a link to about one, and the sweep from an hour to a couple of minutes.
      // Nothing about the answers changes — only the order they are asked in.
      const cell = j => {
        const lat = (j.a.lat + j.b.lat) / 2, lon = (j.a.lon + j.b.lon) / 2;
        return Math.round(lat * 4) * 100000 + Math.round(lon * 4);
      };
      queue.sort((x, y) => cell(x) - cell(y));
      // Nothing is computed until the datastore has been asked. Without this a
      // network whose margins are all saved would still start a terrain sweep
      // for every link in the half-second before its own answers arrive, and
      // throw that work away when they did — which is the whole cost the Save
      // button exists to avoid, paid once per page load anyway.
      if (savedState === 'idle' || savedState === 'loading') { setNote(); return; }
      pump();
    },

    noteHtml,

    active() { return state.mapFade; },

    bands() { return { good: G(), ok: O() }; },

    // Off by default and remembered, which is the opposite of MapLos's rule and
    // for the reason that rule gives: this one stops costing terrain requests
    // the moment the network is saved, so an operator who turned it on is not
    // signing up for a fetch every visit.
    setEnabled(on) {
      state.mapFade = !!on;
      try { localStorage.setItem('mn-map-fade', on ? 'on' : 'off'); } catch (_) {}
      if (on) loadSaved();
      refreshMapLayers({ skipFit: true });
      // The thresholds and the Save button only exist while the switch is on,
      // so the panel that holds the switch has to be redrawn by the switch —
      // "Show signal links" and "Kill spaghetti" in the same flyout do exactly
      // this, and for exactly this reason. Done here rather than in the
      // onchange attribute so a programmatic caller gets the controls too.
      rerenderMapDisplayControls();
      rerenderMapLegend();
      setNote();
    },

    // A threshold is a comparison, not a computation: nothing is re-swept and
    // nothing is re-fetched, the same margins are simply banded again. Which is
    // why these are two boxes rather than a wizard.
    setBand(which, v) {
      const n = Number(v);
      if (!isFinite(n)) return;
      if (which === 'good') state.mapFadeGoodDb = n;
      else                  state.mapFadeOkDb = n;
      // Kept apart rather than clamped: an operator part-way through typing
      // "15" has typed "1", and a box that fought them over it would be
      // unusable. The bands simply read oddly until the second figure lands.
      state.mapFadeBandsSet = true;
      pendingRows = null;                 // the bands are stored on every row
      try {
        localStorage.setItem('mn-map-fade-good', String(state.mapFadeGoodDb));
        localStorage.setItem('mn-map-fade-ok', String(state.mapFadeOkDb));
      } catch (_) {}
      if (state.mapFade) refreshMapLayers({ skipFit: true });
      rerenderMapLegend();
      setNote();
    },

    // Everything computed this session, into meganet.link_fade_margin, in
    // chunks — a whole network is a few thousand rows and one request that size
    // is one request too big. Sequential rather than parallel: a half-applied
    // save is confusing enough without four of them interleaving, and this is
    // not the slow part of anything.
    async save() {
      if (saving) return;
      const rows = unsaved();
      if (!rows.length) return;
      if (!dbCanWrite()) {
        saveMsg = { kind: 'error', text: 'Sign in to save — the datastore takes writes from an editor only.' };
        setNote();
        return;
      }
      pendingRows = null;
      saving = { done: 0, total: rows.length };
      saveMsg = null;
      setNote();
      try {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          await dbRpc('save_link_fade', {
            p_rows: chunk, p_good_db: G(), p_ok_db: O(),
          });
          saving.done = Math.min(rows.length, i + chunk.length);
          setNote();
        }
        // Re-read rather than patch what is on screen: the count below is what
        // the database did, not what this tab asked for (message-log.js's rule).
        saving = null;
        savedState = 'idle'; saved = null;
        loadSaved();
        saveMsg = { kind: 'ok', text: `${rows.length} saved — this network now paints from the datastore.` };
      } catch (err) {
        saving = null;
        saveMsg = {
          kind: 'error',
          text: err && err.denied
            ? 'The datastore refused the write — an editor session is needed.'
            : `Save failed: ${(err && err.message) || String(err)}`,
        };
      }
      setNote();
    },
  };
})();
if (typeof window !== 'undefined') window.MapFade = MapFade;
