// MegaNet — decoder-sniff.js
//
// 📦 The Decoder's "not sure which kind?" box (November 2026). The Decoder is
// three decoders as views of one tab — ALERT packets (packets.js), ERT-A2
// serial output (alert2.js) and HFEM lines (hfem-tab.js) — and somebody
// holding a message does not always know which of the three wrote it. This
// box, under the Decoder's view strip (app.js, viewStripHtml), reads what was
// pasted, works out which kind it is, and opens that view with it decoded.
//
// The tests are the formats' own marks, cheapest first, and none guesses:
//   ALERT    32 or 40 0s and 1s (a payload, or four framed 10-bit words), or
//            eight hex digits — what Packets' own box takes;
//   HFEM     a line of NAME=value fields between bars, :HS=1|I1=…|NN: —
//            the Bureau's Hydro Field Event Message;
//   ERT-A2   the ALERT2A tag an ERT-A2 puts on its ASCII lines, the same
//            word in hex in a binary dump, or anything Alert2.parse finds a
//            frame in.
// Anything else is said to be none of them, with what each looks like.
//
// After core.js (state, esc, escAttr, announce) and the three decoders;
// reached from app.js at render. Nothing runs at load.

const DecoderSniff = (function () {
  const FAMILY = ['packets', 'alert2', 'hfem'];
  const NAMES = { packets: 'an ALERT packet', alert2: 'ERT-A2 serial output', hfem: 'HFEM lines' };
  let said = '';     // what the last paste was read as, shown under the box until the tab is left

  function kindOf(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const flat = t.replace(/[\s,_.\-]+/g, '');
    if (/^[01]{32}$|^[01]{40}$/.test(flat)) return { kind: 'packets', value: flat };
    if (/^(0x)?[0-9a-f]{8}$/i.test(flat)) return { kind: 'packets', value: /^0x/i.test(flat) ? flat : '0x' + flat };
    if (/(^|\n)\s*:?[A-Z][A-Z0-9_]*=[^|\n]*\|[A-Z][A-Z0-9_-]*=/.test(t)) return { kind: 'hfem', value: t };
    if (/ALERT2A/.test(t) || /4\s*1\W*4\s*C\W*4\s*5\W*5\s*2\W*5\s*4\W*3\s*2/i.test(t)) return { kind: 'alert2', value: t };
    try {
      if (typeof Alert2 !== 'undefined' && Alert2.parse) {
        const p = Alert2.parse(t);
        if (p && p.stats && p.stats.frames > (p.stats.errors || 0)) return { kind: 'alert2', value: t };
      }
    } catch (_) { /* not a capture, then */ }
    return null;
  }

  function stripHtml(id) {
    if (!FAMILY.includes(id)) return '';
    return `
      <div class="dec-sniff" role="group" aria-labelledby="dec-sniff-h">
        <label id="dec-sniff-h" for="dec-sniff-in" class="dec-sniff-h">Not sure which kind? Paste it here</label>
        <textarea id="dec-sniff-in" class="dec-sniff-in" rows="2" spellcheck="false"
                  placeholder="ALERT bits or 8 hex digits, ERT-A2 serial output, or HFEM lines — Flood-Net works out which"
                  onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();DecoderSniff.go();}"></textarea>
        <button type="button" class="primary" onclick="DecoderSniff.go()">Work it out</button>
        <p class="small txt-muted dec-sniff-said" id="dec-sniff-said" role="status">${esc(said)}</p>
      </div>`;
  }

  function go() {
    const box = document.getElementById('dec-sniff-in');
    const text = box ? box.value : '';
    const k = kindOf(text);
    if (!k) {
      said = String(text).trim()
        ? 'That is none of the three: an ALERT packet is 32 or 40 0s and 1s, or 8 hex digits; ERT-A2 serial output carries ALERT2A; an HFEM line looks like :HS=1|I1=123456|…:'
        : 'Paste a message first.';
      const el = document.getElementById('dec-sniff-said');
      if (el) el.textContent = said;
      announce(said);
      return;
    }
    said = `Read as ${NAMES[k.kind]}, and opened in that view.`;
    if (k.kind === 'packets') {
      state.pkt.decInput = k.value;
      switchTab('packets');
      if (typeof Packets !== 'undefined') Packets.decode();
    } else if (k.kind === 'alert2') {
      state.a2.text = k.value;
      state.a2.mode = 'auto';
      switchTab('alert2');
      if (typeof Alert2 !== 'undefined') Alert2.decode();
    } else {
      state.hfem.text = k.value;
      switchTab('hfem');
      if (typeof HfemTab !== 'undefined') HfemTab.decode();
    }
    announce(said);
  }

  // Leaving the Decoder forgets the last answer, so it is not said again
  // over a paste somebody makes next week.
  function forget() { said = ''; }

  return { kindOf, stripHtml, go, forget };
})();
