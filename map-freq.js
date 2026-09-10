// MegaNet — map-freq.js
//
//   MapFreq   colours every drawn link by the frequency the hop runs on,
//             instead of by the fade margin or by nothing at all.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and cssVar, and is reached from app.js
// (refreshMapLayers and the Map display block) and from the legend. All of it
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── Why this is the default and the fade margin is not ───────────────────────
//
// The two link colourings answer different kinds of question and cost different
// amounts. A fade margin is computed — terrain, land cover and a Longley–Rice
// run per hop — and until the network is swept and saved most links have no
// figure at all, so the map opens mostly uncoloured. A frequency is *recorded*:
// it is on the repeater, it is right there in stations.json, and every drawn
// link either has one or provably does not. So the frequency colouring is
// instant, complete and free, which is what a default has to be.
//
// It is also the question asked most often about a picture of this network.
// "Which repeaters are on 152.4?" is answered by looking; so is "does this
// field station's carrier run on the same channel as the one next to it", which
// is the co-channel question the RF Environment tab exists for, one glance
// earlier.
//
// ── One colouring at a time ──────────────────────────────────────────────────
//
// Frequency and fade margin both want the same channel — the colour of the
// core line — so they are radio buttons, not two checkboxes (state.mapLinkColour
// in core.js). Two colourings fighting over one line would mean a green line
// that might be 15 dB of headroom or might be 151.95 MHz, and no way to tell
// which from the map.
//
// Line-of-sight is not in that group and does not need to be: it paints over
// whichever colouring is running, in its own crimson, and says one thing —
// "the ground cuts this path". A colour that means "obstructed" outranks a
// colour that means "on this channel", so MapLos classifies after this does.
//
// ── Where the frequency comes from ───────────────────────────────────────────
//
// From the repeater on one end, which is the only place this file records one:
// `station.repeater.rx_mhz`. A field station has no frequency of its own — it
// transmits on whatever its carrier listens on — so a pass-range link takes the
// repeater's, and that is not an approximation, it is the definition. A
// backbone path between two repeaters takes the first end's and names both in
// the tooltip when they differ, which is a pair worth noticing rather than a
// pair to average away. A repeater–base path takes the repeater's: a base opens
// no channel of its own.
//
// A link with no frequency anywhere on it keeps the plain link colour. There
// are none in this network today — all 88 repeaters have an rx_mhz — but a
// station list that arrives without one must not silently be given a colour
// that means a channel nobody recorded.
const MapFreq = (function () {
  // Eight hues, assigned in ascending frequency order — so the same channel
  // gets the same colour on every load of the same file, and a channel that
  // appears later in the list does not shuffle the ones above it. This network
  // uses four (151.5, 151.525, 151.95, 152.4); the other four are there so a
  // file with more channels colours all of them rather than wrapping onto a
  // colour already in use before it has to.
  //
  // Chosen against what else can be on the map at the same time: none of them
  // is the crimson MapLos paints an obstructed path, the red MapBlast paints a
  // dying one, the blue of a highlighted river or the teal of a survey mark.
  // They are deliberately saturated — these lines are read over satellite
  // imagery and topo shading, under the same white casing every link carries.
  const TOKENS = ['--map-freq-1', '--map-freq-2', '--map-freq-3', '--map-freq-4',
                  '--map-freq-5', '--map-freq-6', '--map-freq-7', '--map-freq-8'];
  const FALLBACK = ['#2979ff', '#ff9100', '#d500f9', '#00e5ff',
                    '#ffea00', '#76ff03', '#b388ff', '#ff4081'];

  // frequency → resolved colour, plus the repeater count behind each, for the
  // legend. Rebuilt on demand and dropped by reset(); resolved rather than
  // token names because a colour is asked for once per drawn link and
  // getComputedStyle three thousand times a refresh is not free.
  let scale = null;

  function build() {
    const counts = new Map();
    for (const s of (state.data ? state.data.stations : [])) {
      const r = s && s.repeater;
      if (!r || !(r.rx_mhz > 0)) continue;
      const f = Number(r.rx_mhz);
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    const list = [...counts.keys()].sort((a, b) => a - b);
    scale = new Map(list.map((f, i) => [f, {
      colour: cssVar(TOKENS[i % TOKENS.length], FALLBACK[i % FALLBACK.length]),
      count:  counts.get(f),
    }]));
    return scale;
  }

  function table() { return scale || build(); }

  // The channel one end of a link is on, or null. `rx_mhz` rather than tx: it
  // is what the repeater listens on, which is the frequency everything drawn
  // into it transmits on, and it is the figure the fade-margin sweep and the
  // ACMA interference scan both already use for the same reason.
  function endMhz(s) {
    const r = s && s.repeater;
    return r && r.rx_mhz > 0 ? Number(r.rx_mhz) : null;
  }

  function pairMhz(a, b) {
    const fa = endMhz(a);
    return fa != null ? fa : endMhz(b);
  }

  function fmt(f) {
    // Three of this network's four channels need three decimals and one needs
    // one, and a column of 151.500 / 151.525 reads better than 151.5 / 151.525
    // — but only where the extra digits are real, so trailing zeros go.
    return `${Number(f).toFixed(3).replace(/\.?0+$/, '')} MHz`;
  }

  return {
    // Which colouring the operator has chosen. Both this and MapFade.active()
    // read the same one setting, so they can never both be true.
    active() { return state.mapLinkColour === 'freq'; },

    // Drop the resolved palette. Called from refreshMapLayers, beside
    // MapLos.newGeneration() and MapFade.newGeneration(), so a theme switch —
    // which refreshes the map — is picked up without every classify() paying
    // for a getComputedStyle of its own.
    reset() { scale = null; },

    // One core line, as refreshMapLayers draws it — the same shape as
    // MapFade.classify, and called immediately before MapLos so an obstructed
    // path still gets the last word.
    classify(line, a, b) {
      if (!this.active()) return;
      const f = pairMhz(a, b);
      if (f == null) return;
      const hit = table().get(f);
      if (!hit) return;
      line.mnFreqMhz = f;
      // mnBaseColor is what MapBlast's restore puts back when a blast disarms,
      // so it moves with the colour — MapLos's lesson, and the same reason.
      line.mnBaseColor = hit.colour;
      if (!line.mnBlastRed) line.setStyle({ color: hit.colour });
      if (typeof line.bindTooltip === 'function') {
        const other = endMhz(a) != null && endMhz(b) != null && endMhz(a) !== endMhz(b)
          ? ` (far end ${fmt(endMhz(b))})` : '';
        line.bindTooltip(`${fmt(f)}${other}`, { sticky: true });
      }
    },

    // What the legend lists: every channel in the loaded file, in the order the
    // colours were assigned, with how many repeaters are on each.
    rows() {
      return [...table().entries()]
        .map(([mhz, v]) => ({ mhz, label: fmt(mhz), colour: v.colour, count: v.count }));
    },

    // What the Map display block says under the radio buttons. Drawn only while
    // this colouring is the one running — the block does not offer a note for a
    // colouring nobody picked, and a line inviting somebody to pick one, under
    // the button that picks it, is a line saying nothing.
    noteHtml() {
      const n = table().size;
      if (!n) return 'No repeater in this file records a frequency, so every link draws plain.';
      return `Every link takes the channel of the repeater on its end — ${n} in this file, listed
              in the 🔑 legend. A hop with no recorded frequency keeps the plain link colour.`;
    },
  };
})();
if (typeof window !== 'undefined') window.MapFreq = MapFreq;
