// MegaNet — licence-docs.js
//
//   LicenceDocs   the radio-licensing documents Flood-Net keeps a copy of, the
//                 passages the app quotes from them, and the reader that opens
//                 a document at the passage — for the Knowledge base's
//                 🪪 Radio Licensing tab (kb-licensing.js) and the guide in
//                 the Stations map's 📜 ACMA licences tool (map-acma.js).
//
// ── What is kept, and why a copy ─────────────────────────────────────────────
// docs/acma/ holds five PDFs as they stood on SNAPSHOT: ACMA's two assignment
// instructions (RALI FX16 and FX19), the Fixed Licence determination as it was
// first made and as it is in force now, and its explanatory statement. A rule
// read on a web page that has since changed cannot be checked, so the copy is
// what a quotation here is held to — and every place it is shown says it is a
// copy, with the address of the version in force beside it. docs/acma/README.md
// says where each came from and under what terms it is reproduced.
//
// docs/acma/text/<id>.json is the same document's words, page by page
// (tools/acma_docs.py), which is what the reader shows: a PDF opened at a page
// works on a desktop browser and on little else, and cannot mark a sentence.
// `law` is the exception — short extracts of the Act and four instruments,
// copied by hand, with no PDF kept.
//
// ── A quotation ──────────────────────────────────────────────────────────────
// CITES is the one list: id → [document, page, where it is, the words]. The
// words are the document's, exactly; `npm run licensing` fails any that is not
// on its page. Both tabs draw their quotations from here (quote(), cite()), so
// a sentence is never typed twice and never paraphrased inside quote marks.
//
// After core.js (esc, escAttr) and modal.js (Modal, read when a link is
// pressed), before kb-licensing.js and init.js. Nothing runs at load.
//
// Exposes: SNAPSHOT, DOCS, CITES, cite, quote, said, where, open, openDoc,
//          turn, libraryHtml, kindChip, text.

const LicenceDocs = (function () {
  const SNAPSHOT = '2026-11-10';
  const DIR = 'docs/acma/';

  // kind: 'law' binds; 'policy' is how ACMA hands out and plans licences;
  // 'explain' is ACMA saying what the law means; 'old' has been replaced.
  const KIND = {
    law: ['The law', 'Legislation: an Act of Parliament, or an instrument ACMA made under it. Breaking it is an offence or a contravention with a penalty.'],
    policy: ['ACMA policy', 'A Radiocommunications Assignment and Licensing Instruction (RALI): ACMA’s written policy for the people who assign frequencies and issue licences. It decides what licence you are given and what ACMA plans around it; it is not itself legislation.'],
    explain: ['ACMA’s explanation', 'The explanatory statement ACMA published with the determination: its own account of what each section means. Not law itself, but the best evidence of what the law was meant to do.'],
    old: ['Replaced', 'An earlier version of the law, kept because it is the copy that was supplied. The version in force is listed beside it.'],
  };

  const DOCS = {
    fx16: {
      short: 'RALI FX16', kind: 'policy', pages: 40,
      title: 'RALI FX16 — Frequency assignment requirements for the point-to-multipoint service in the VHF high, 400 MHz and 800 MHz bands',
      dated: 'in effect from 25 March 2025',
      file: 'rali-fx16-2025-03-25.pdf',
      url: 'https://www.acma.gov.au/sites/default/files/2025-11/rali_fx16.pdf',
      home: ['ACMA’s list of RALIs', 'https://www.acma.gov.au/ralis-frequency-coordination'],
      why: 'The one that matters most here. It is how ACMA plans a licence like the Bureau’s: the 30 km service area, the power of a base and of a gauge, and how far apart two bases on one channel must be.',
    },
    lcd: {
      short: 'Fixed Licence determination', kind: 'law', pages: 31,
      title: 'Radiocommunications Licence Conditions (Fixed Licence) Determination 2025 — as in force (Compilation No. 2)',
      dated: 'in force from 21 March 2026',
      file: 'fixed-licence-determination-2025-compilation-2-F2026C00349.pdf',
      url: 'https://www.legislation.gov.au/F2025L00388/latest/text',
      home: ['Federal Register of Legislation', 'https://www.legislation.gov.au/F2025L00388/latest/versions'],
      why: 'The conditions every fixed licence carries by law: who a station may talk to, on which frequency, how long and how often a gauge may transmit, and at what power.',
    },
    es: {
      short: 'Explanatory statement', kind: 'explain', pages: 13,
      title: 'Explanatory Statement — Radiocommunications Licence Conditions (Fixed Licence) Determination 2025',
      dated: 'registered 21 March 2025',
      file: 'fixed-licence-determination-2025-explanatory-statement.pdf',
      url: 'https://www.legislation.gov.au/F2025L00388/asmade/text/explanatory-statement',
      home: ['Federal Register of Legislation', 'https://www.legislation.gov.au/F2025L00388/asmade/downloads'],
      why: 'ACMA’s own words on what the determination means — including that a licence’s unlisted transmitters “can be located anywhere”.',
    },
    fx19: {
      short: 'RALI FX19', kind: 'policy', pages: 49,
      title: 'RALI FX19 — Frequency coordination and licensing procedures for point to multipoint and short range wireless broadband apparatus licensed services in the 1900–1920 MHz band',
      dated: 'in effect from 2 July 2026',
      file: 'rali-fx19-2026-07-02.pdf',
      url: 'https://www.acma.gov.au/sites/default/files/2026-07/rali_fx19_02_07_26.pdf',
      home: ['ACMA’s list of RALIs', 'https://www.acma.gov.au/ralis-frequency-coordination'],
      why: 'About wireless broadband at 1900–1920 MHz, not flood telemetry — no Flood-Net station is in that band. Kept because it says plainly how ACMA treats a point-to-multipoint station working beyond its planned range.',
    },
    lcd0: {
      short: 'Fixed Licence determination, as first made', kind: 'old', pages: 18,
      title: 'Radiocommunications Licence Conditions (Fixed Licence) Determination 2025 — as made (F2025L00388)',
      dated: 'in force 22 March to 22 September 2025',
      file: 'fixed-licence-determination-2025-as-made-F2025L00388.pdf',
      url: 'https://www.legislation.gov.au/F2025L00388/asmade/text',
      home: ['Federal Register of Legislation', 'https://www.legislation.gov.au/F2025L00388/latest/versions'],
      why: 'The determination as it was first made. Amended twice since — a new licence type for 3.4–4.0 GHz was added — but every section that applies to a VHF gauge reads the same in both.',
    },
    law: {
      short: 'The Act and related law', kind: 'law', pages: 12, extract: true,
      title: 'Extracts — Radiocommunications Act 1992 and five related instruments',
      dated: 'copied 10 November 2026',
      url: 'https://www.legislation.gov.au/C2004A04465/latest/text',
      home: ['Federal Register of Legislation', 'https://www.legislation.gov.au/'],
      why: 'The sections quoted here, word for word: the offence of transmitting without a licence, what a licence authorises, the definitions, how a RALI enters a licence, and the label a transmitter at a shared site must carry.',
    },
  };

  // id → [document, page, where it is, the words — the document's own].
  const CITES = {
    // ── RALI FX16 ─────────────────────────────────────────────────────────────
    'fx16-policy': ['fx16', 5, 'section 1.1', 'The information in this document reflects the ACMA’s statement of current policy in relation to frequency assignment requirements for PMP services in the VHF High, 400 MHz and 800 MHz bands. In making decisions, accredited frequency assigners and the ACMA’s officers should take all relevant factors into account and decide each case on its merits.'],
    'fx16-system': ['fx16', 6, 'section 2', 'A two frequency PMP system consists of a single central master station communicating with a number of outlying remote fixed stations.'],
    'fx16-eirp-master': ['fx16', 8, 'section 3.1', 'the maximum station EIRP (considering transmitter power, cable loss, antenna gain) for master stations shall be 40 W;'],
    'fx16-eirp-remote': ['fx16', 8, 'section 3.1', 'the maximum station EIRP (considering transmitter power, cable loss, antenna gain) for remote and supplementary stations shall be 20 W.'],
    'fx16-master-antenna': ['fx16', 8, 'section 3.1', 'For a master station the antenna shall be a vertically polarised antenna with a maximum gain of 8.2 dBi.'],
    'fx16-yagi': ['fx16', 8, 'section 3.1', 'in the VHF High Band: directional antenna with a mid-band gain of 6 dBi, minimum front-to-back ratio of 12 dB and a maximum beam width (in E-plane) of 75° (e.g. a 3 element Yagi);'],
    'fx16-omni': ['fx16', 8, 'section 3.1', 'In all bands radiated power 180 degrees from the direction of the remote station to the base shall not exceed 5 Watts, i.e. if an omnidirectional antenna is used on a remote, the EIRP shall not exceed 5 Watts.'],
    'fx16-remote-power': ['fx16', 8, 'section 3.1', 'Remote stations transmitting on frequencies in the bands 451.5–452.5 MHz or 805.5–806 MHz are limited to a maximum transmitter output power at the input of the antenna of 5 W and in all other bands to a maximum transmitter power of 1 W'],
    'fx16-heights': ['fx16', 8, 'section 3.1', 'Typical master station effective antenna height of 200 m above surrounding terrain.'],
    'fx16-interference': ['fx16', 9, 'section 3.1', 'In the event that interference from remote stations or RCSs occurs, the Fixed licence LCD 2025 contains a condition that those transmitters must not be operated if they cause harmful interference.'],
    'fx16-coordination': ['fx16', 9, 'section 3.1', 'Frequency coordination is performed for the master station only (interference protection for remote stations, supplementary stations and RCSs is intrinsic to the service model).'],
    'fx16-30km': ['fx16', 9, 'section 3.1', 'A service area radius of 30 km. All stations must be contained within the service area.'],
    'fx16-reuse': ['fx16', 9, 'section 3.1', 'A co-channel minimum re-use distance of 100 km between master stations.'],
    'fx16-fill-in': ['fx16', 9, 'section 3.1', 'Supplementary stations have no re-use distance requirements, they are included to improve the service reliability within, but not outside, the service area.'],
    'fx16-low-eirp': ['fx16', 10, 'section 3.2', 'the maximum station EIRP (considering transmitter power, cable loss, antenna gain) for master stations shall be 8.3 W;'],
    'fx16-2km': ['fx16', 10, 'section 3.2', 'A service area radius of 2 km. All stations must be contained within the service area.'],
    'fx16-low-reuse': ['fx16', 10, 'section 3.2', 'A co-channel minimum re-use distance of 10 km between master stations.'],
    'fx16-expected': ['fx16', 11, 'section 4', 'To successfully manage interference, all PMP stations (master, remote, RCS) are expected to comply with the technical constraints in this RALI.'],
    'fx16-another-master': ['fx16', 12, 'section 4.3', 'Note that a transmitter that extends coverage beyond a 30 km radius of the master station is not a supplementary transmitter; it is another master station and must be separately licensed and coordinated in the same manner as any other master station.'],
    'fx16-fill-in-table': ['fx16', 13, 'section 4.3, Table 2', 'Table 2: Height constraints'],
    'fx16-land-mobile': ['fx16', 17, 'section 5.4', 'The service area radius of a PMP system assigned in frequencies allocated for the land mobile service is 30 km for a high power system and 2 km for low power system.'],
    'fx16-exceptions': ['fx16', 20, 'section 6', 'Exceptions to the requirements of this RALI for prospective assignments require case-by-case consideration by the Manager, Spectrum Planning Section.'],
    // ── The Fixed Licence determination, as in force ──────────────────────────
    'lcd-system-licence': ['lcd', 3, 'section 5(1)', 'fixed licence (point to multipoint system) means a fixed licence that authorises the operation of:'],
    'lcd-remote': ['lcd', 4, 'section 5(1)', 'remote station means a fixed station that is used, or intended to be used, to communicate with:'],
    'lcd-fill-in': ['lcd', 4, 'section 5(1)', 'supplementary base station means a fixed point to multipoint station that is used, or intended to be used, with a base station to communicate with a remote station.'],
    'lcd-base': ['lcd', 6, 'section 5(2)', 'In this instrument, if a point to multipoint station is operated at a fixed location mentioned in a fixed licence, the station is a base station.'],
    'lcd-not-listed': ['lcd', 6, 'section 5(2), note', 'A base station is at a fixed location specified in the licence. The locations of other stations are not specified in the licence.'],
    'lcd-duty': ['lcd', 6, 'section 5(3)', 'the duty cycle is the ratio of:'],
    'lcd-antenna': ['lcd', 10, 'section 11(2), Table 1', 'the mid band gain of the antenna is at least the value specified in column 4 of the table item.'],
    'lcd-own-conditions': ['lcd', 12, 'section 12(2)', 'then, to the extent of any inconsistency, the condition mentioned in paragraph (a) prevails.'],
    'lcd-talk-to': ['lcd', 12, 'section 13', 'A person must not operate a fixed station (the first station) otherwise than to communicate with another station (the other station), where:'],
    'lcd-receiver': ['lcd', 12, 'section 13, note', 'A fixed licence (point to multipoint station) does not authorise the operation of, but may refer to, a radiocommunications receiver.'],
    'lcd-fill-gaps': ['lcd', 12, 'section 14(3)', 'A person must not operate a supplementary base station otherwise than to overcome deficiencies, within the coverage area of a base station, in reception of transmissions from that base station.'],
    'lcd-no-extend': ['lcd', 12, 'section 14(4)', 'A person must not operate a supplementary base station to extend the coverage area of a base station.'],
    'lcd-no-harm': ['lcd', 13, 'section 15(1)', 'A person must not operate a remote station if its operation causes harmful interference.'],
    'lcd-frequency': ['lcd', 13, 'section 15(2)', 'A person must not operate a remote station under the relevant licence for a base station otherwise than on a receive frequency or transmit frequency specified in the relevant licence.'],
    'lcd-timing': ['lcd', 13, 'section 15(3)', '(d) the duty cycle of the station is more than 1 in 30; or (e) the duration of the transmission from the station is more than 2 seconds; or (f) the minimum repetition interval of the station is less than 10 seconds.'],
    'lcd-interval': ['lcd', 13, 'section 15(3), note 2', 'The repetition interval is the time between the start of a transmission and the start of the next transmission of a station.'],
    'lcd-power': ['lcd', 13, 'section 15(4)', 'with an output power greater than the power specified in column 2 of that table item, measured at the antenna input.'],
    'lcd-vhf': ['lcd', 17, 'section 23(2)', 'A person must not operate a remote station on VHF to transmit to a base station unless the remote station uses a receive frequency specified in the relevant licence for the base station.'],
    // ── ACMA's explanatory statement ──────────────────────────────────────────
    'es-remade': ['es', 1, 'page 1', 'without making any significant changes to the regulatory arrangements created by the Fixed Licence LCD 2015'],
    'es-not-authorised': ['es', 2, 'page 2', 'Operation of a radiocommunications device is not authorised by an apparatus licence (including a fixed licence) if it is not in accordance with the conditions of the licence (subsection 97(4) of the Act).'],
    'es-anywhere': ['es', 7, 'notes on section 8', 'This means that the transmitters can be located anywhere, although for most practical purposes, they need to be located in relatively close physical proximity to a radiocommunications transmitter whose location is specified in the fixed licence.'],
    'es-pmp': ['es', 8, 'notes on section 12', 'It also authorises the operation of other stations that communicate with the base station, which are not necessarily fixed stations.'],
    'es-fill-in': ['es', 8, 'notes on section 14', 'It is designed to overcome transmission deficiencies in the area notionally covered by the transmissions of a base station (e.g., because of terrain that blocks transmissions from the base station).'],
    'es-register': ['es', 13, 'Attachment B, item 3', 'Details about supplementary base stations, remote stations and remote control stations, which are authorised by the licence but not specified in the licence, are not required to be included in the Register.'],
    // ── RALI FX19 ─────────────────────────────────────────────────────────────
    'fx19-scope': ['fx19', 9, 'section 1.1', 'point to multipoint fixed broadband wireless access (BWA)'],
    'fx19-one-licence': ['fx19', 15, 'section 1.6.1', 'All transmitters in a BWA service (comprising one base station and any number of remote stations communicating with that base station) are to be licensed under one Fixed licence authorising a point to multipoint station.'],
    'fx19-dispute': ['fx19', 11, 'section 1.3', 'If interference occurs after a licence is issued and the issue cannot be resolved between the affected parties, licensees can expect the ACMA to have regard to this RALI and relevant legislative instruments in dealing with the dispute.'],
    'fx19-fortuitous': ['fx19', 47, 'Appendix E, Table E1, footnote 7', 'While practical systems may in some cases achieve greater ranges, such operation is regarded as fortuitous and will not be afforded protection. Similarly, such operation will be subject to a “no interference” condition in respect of interference to other licensed services.'],
    // ── The Act and related law (extracts) ────────────────────────────────────
    'act-46': ['law', 1, 'section 46(1)', 'a person must not operate a radiocommunications device otherwise than as authorised by:'],
    'act-46-penalty': ['law', 1, 'section 46(1), penalty', '(ii) otherwise—1,500 penalty units; or'],
    'act-97': ['law', 2, 'section 97(4)', 'Operation of a radiocommunications device is not authorised by the relevant apparatus licence if it is not in accordance with the conditions of the licence.'],
    'act-107': ['law', 3, 'section 107(1)(g)', '(g) such other conditions as are specified in the licence.'],
    'act-110a': ['law', 4, 'section 110A(2)', 'The ACMA may, by legislative instrument, determine that each apparatus licence included in a specified class of apparatus licences is taken to include one or more specified conditions.'],
    'act-113': ['law', 5, 'section 113(1)', 'the person must not contravene a condition of the licence.'],
    'act-114': ['law', 6, 'section 114(1)', 'a licensee of an apparatus licence may, by written instrument, authorise other persons to operate radiocommunications devices under the licence.'],
    'int-eirp': ['law', 7, 'Interpretation determination, “EIRP”', 'EIRP, in relation to a radiocommunications device, means the equivalent isotropically radiated power of the device.'],
    'int-pmp': ['law', 7, 'Interpretation determination, “point to multipoint station”', '(f) principally for communication with more than one other fixed station; and'],
    'int-ptp': ['law', 7, 'Interpretation determination, “point to point station”', '(b) principally for communication with one other fixed station; and'],
    'int-receive': ['law', 7, 'Interpretation determination, “fixed receive licence”', 'fixed receive licence means a receiver licence issued for one or more fixed receive stations:'],
    'int-harmful': ['law', 7, 'Interpretation determination, “harmful interference”', '(b) obstructs, repeatedly interrupts or seriously degrades a radiocommunication service that is operating in accordance with:'],
    'types-receivers': ['law', 8, 'section 6', 'For the purposes of paragraph 7(1)(b) of the Act, a radiocommunications receiver is specified if it is, or forms part of:'],
    'fac-procedural': ['law', 9, 'section 5', '(b) sets out policies or procedures for an accredited person to follow or have regard to; and'],
    'fac-consistent': ['law', 9, 'section 8(1)(e)(i)', '(i) any procedural document, specified in the frequency assignment certificate, that applies to the frequency or frequencies, or the frequency channel, on which the device would operate;'],
    'penalty-unit': ['law', 10, 'section 5', 'For the purposes of subsection 4AA(1A) of the Act, the amount of a penalty unit is $364.'],
    'int-communal': ['law', 7, 'Interpretation determination, “communal site”', 'communal site means a place used by radiocommunications transmitters operating within 200 metres of each other, for which 2 or more fixed transmitters operate, on an assigned basis, on frequencies within one of the following frequency bands:'],
    'int-communal-3': ['law', 7, 'Interpretation determination, section 6(4)', 'the relevant place is not a communal site until the first time, on or after 31 March 2025, that the place is a communal site within the meaning given by the Radiocommunications (Interpretation) Determination 2015'],
    'act-300': ['law', 11, 'section 300(1)', 'The ACMA may, by determination in writing, require any person who operates a radiocommunications transmitter under a licence to apply to that transmitter a label setting out the information specified in the determination.'],
    'act-300-must': ['law', 11, 'section 300(4)', 'A person required by a determination to apply a label to a radiocommunications transmitter must comply with the determination.'],
    'label-high': ['law', 12, 'Labelling determination, section 5', 'high power transmitter means a fixed transmitter that is authorised to operate with an EIRP greater than 2 watts.'],
    'label-number': ['law', 12, 'Labelling determination, section 5', 'frequency assignment number, in relation to a radiocommunications transmitter, means the number included in the Register as a unique identifier of the use, by the transmitter, of a particular frequency or particular part of the spectrum.'],
    'label-which': ['law', 12, 'Labelling determination, section 7', 'A radiocommunications transmitter is a relevant transmitter if:'],
    'label-what': ['law', 12, 'Labelling determination, section 8(2)', '(a) the frequency assignment number for the relevant transmitter; and (b) the statement ‘Do Not Remove.’'],
    'label-form': ['law', 12, 'Labelling determination, section 8(3)', 'the text of the label must be in a contrasting colour to the background of the label.'],
  };

  const TEXT = {};              // document id → its text file, once read
  const waiting = {};
  let cur = null;               // what the reader shows: { doc, page, quote, where }
  let opened = 0;               // how many times the reader has been opened: which dialog is the live one

  const dateText = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
  };

  function text(doc) {
    if (TEXT[doc]) return Promise.resolve(TEXT[doc]);
    if (!waiting[doc]) {
      waiting[doc] = fetch(`${DIR}text/${doc}.json`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(j => { TEXT[doc] = j; delete waiting[doc]; return j; })
        .catch(e => { delete waiting[doc]; throw e; });
    }
    return waiting[doc];
  }

  function kindChip(kind) {
    const k = KIND[kind] || KIND.law;
    return `<span class="term-chip ld-kind ld-kind-${kind}" title="${escAttr(k[1])}">${esc(k[0])}</span>`;
  }

  const said = id => (CITES[id] ? CITES[id][3] : '');
  // "RALI FX16, section 3.1"
  function where(id) {
    const c = CITES[id];
    return c ? `${DOCS[c[0]].short}, ${c[2]}` : '';
  }

  // A link that opens the document at the passage. `label` is what it reads;
  // left out, it reads where the passage is.
  function cite(id, label) {
    const c = CITES[id];
    if (!c) return esc(label || '');
    const w = where(id);
    return `<button type="button" class="ld-cite" data-cite="${escAttr(id)}" onclick="LicenceDocs.open('${escAttr(id)}')"
        title="${escAttr(`Read it in the document: ${w}`)}" aria-label="${escAttr(`${label || w} — read it in the document`)}"
        ><span aria-hidden="true">📖</span> ${esc(label || w)}</button>`;
  }

  // The words themselves, set apart, with who said them and the way in.
  function quote(id, lead) {
    const c = CITES[id];
    if (!c) return '';
    return `<blockquote class="ld-quote ld-quote-${DOCS[c[0]].kind}" data-cite="${escAttr(id)}">
        <p>${lead ? `${lead} ` : ''}“${esc(c[3])}”</p>
        <footer>${kindChip(DOCS[c[0]].kind)} ${cite(id)}</footer>
      </blockquote>`;
  }

  // ── The reader ──────────────────────────────────────────────────────────────

  const flex = q => q.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  function find(page, q) {
    if (!q) return null;
    const m = new RegExp(flex(q)).exec(page);
    return m ? [m.index, m.index + m[0].length] : null;
  }
  const paras = t => esc(t).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
  function pageHtml(page, q) {
    const r = find(page, q);
    if (!r) return `<p>${paras(page) || '<em>This page has no words on it — a figure or a blank. Open the saved copy to see it.</em>'}</p>`;
    return `<p>${paras(page.slice(0, r[0]))}<mark id="ld-mark" tabindex="-1">${esc(page.slice(r[0], r[1])).replace(/\n+/g, '<br>')}</mark>${paras(page.slice(r[1]))}</p>`;
  }

  function linksHtml(doc, page, t) {
    const d = DOCS[doc];
    const now = d.extract && t && t.urls ? t.urls[page - 1] : d.url;
    const out = (label, href) => `<a class="btn-link" href="${escAttr(href)}" target="_blank" rel="noopener"
        aria-label="${escAttr(`${label} — in a new tab`)}">${esc(label)}<span aria-hidden="true"> ↗</span></a>`;
    return `${d.file ? out(`The saved copy (PDF), at page ${page}`, `${DIR}${d.file}#page=${page}`) : ''}
      ${out(d.kind === 'policy' ? 'The version on ACMA’s website now' : 'The version in force now', now)}`;
  }

  function bodyHtml(t) {
    const d = DOCS[cur.doc], n = cur.page, of = d.pages;
    const page = t ? (t.pages[n - 1] || '') : '';
    const label = d.extract && t && t.labels ? t.labels[n - 1] : `Page ${n} of ${of}`;
    const from = d.extract && t && t.from ? t.from[n - 1] : d.dated;
    const old = d.kind === 'old'
      ? `<p class="ld-warn"><strong>This version has been replaced.</strong> It is the determination as first made. The one in force is
          <button type="button" class="link-btn" onclick="LicenceDocs.openDoc('lcd', 1)">Compilation No. 2</button>; the sections on point-to-multipoint
          stations below 1 GHz read the same in both.</p>` : '';
    return `<div class="ld-reader" data-doc="${escAttr(cur.doc)}" data-page="${n}">
        <p class="ld-head">${kindChip(d.kind)} <strong>${esc(d.title)}</strong></p>
        <p class="ld-sub">${esc(label)} · ${esc(from)}${cur.where ? ` · the marked words are in ${esc(cur.where)}` : ''}</p>
        ${old}
        <div class="ld-page" id="ld-page" role="region" tabindex="0" aria-label="${escAttr(`${d.short}, ${label}`)}">
          ${t ? pageHtml(page, cur.quote) : '<p class="ld-wait">Opening the document…</p>'}
        </div>
        <div class="ld-turn">
          <button type="button" onclick="LicenceDocs.turn(-1)" ${n <= 1 ? 'disabled' : ''}><span aria-hidden="true">◀</span> ${d.extract ? 'Previous extract' : 'Previous page'}</button>
          <span class="ld-pageno">${d.extract ? `Extract ${n} of ${of}` : `Page ${n} of ${of}`}</span>
          <button type="button" onclick="LicenceDocs.turn(1)" ${n >= of ? 'disabled' : ''}>${d.extract ? 'Next extract' : 'Next page'} <span aria-hidden="true">▶</span></button>
        </div>
        <p class="ld-links">${linksHtml(cur.doc, n, t)}</p>
        <p class="ld-note">${d.extract
          ? `Copied word for word from the Federal Register of Legislation on ${esc(dateText(SNAPSHOT))}. Laws are amended: open the version in force before relying on it.`
          : `A copy Flood-Net saved on ${esc(dateText(SNAPSHOT))}, shown as plain words — a table or a figure reads better in the saved PDF. Documents are replaced and amended: open the current version before relying on it.`}</p>
      </div>`;
  }

  function paint(focusMark) {
    const el = document.getElementById('ld-body');
    if (!el || !cur) return;
    el.innerHTML = bodyHtml(TEXT[cur.doc] || null);
    const mark = document.getElementById('ld-mark');
    const page = document.getElementById('ld-page');
    if (mark && page) page.scrollTop = Math.max(0, mark.offsetTop - page.offsetTop - page.clientHeight / 3);
    else if (page) page.scrollTop = 0;
    if (focusMark && page) page.focus({ preventScroll: true });
  }

  function show(doc, page, q, w) {
    const d = DOCS[doc];
    if (!d) return;
    cur = { doc, page: Math.min(Math.max(1, page | 0), d.pages), quote: q || '', where: w || '' };
    // Opening a second document from inside the reader closes the first one's
    // dialog after this one's state is set: only the dialog that is still the
    // open one may clear it.
    const mine = ++opened;
    Modal.open({ title: `${d.short} — ${d.dated}`, wide: true, html: `<div id="ld-body">${bodyHtml(TEXT[doc] || null)}</div>`,
      onClose: () => { if (opened === mine) cur = null; } });
    paint(false);
    if (!TEXT[doc]) {
      text(doc).then(() => { if (cur && cur.doc === doc) paint(false); }, e => {
        const el = document.getElementById('ld-page');
        if (el && cur && cur.doc === doc) {
          el.innerHTML = `<p class="ld-warn">The document’s words could not be read here (${esc((e && e.message) || 'no connection')}). The links below open it instead.</p>`;
        }
      });
    }
  }

  function open(id) {
    const c = CITES[id];
    if (c) show(c[0], c[1], c[3], c[2]);
  }
  function openDoc(doc, page) { show(doc, page || 1, '', ''); }
  function turn(by) {
    if (!cur) return;
    const d = DOCS[cur.doc];
    const n = Math.min(Math.max(1, cur.page + by), d.pages);
    if (n === cur.page) return;
    cur = { doc: cur.doc, page: n, quote: '', where: '' };
    paint(true);
  }

  // ── The shelf: every document, what it is and three ways to open it ─────────

  function libraryHtml() {
    const order = ['fx16', 'lcd', 'es', 'law', 'fx19', 'lcd0'];
    return `<ul class="ld-shelf">${order.map(k => {
      const d = DOCS[k];
      return `<li class="ld-book ld-book-${d.kind}" data-doc="${k}">
          <p class="ld-book-h">${kindChip(d.kind)} <strong>${esc(d.short)}</strong> <span class="ld-book-when">${esc(d.dated)}</span></p>
          <p class="ld-book-t">${esc(d.title)}</p>
          <p class="ld-book-why">${esc(d.why)}</p>
          <p class="ld-book-go">
            <button type="button" class="pill" onclick="LicenceDocs.openDoc('${k}', 1)">Read it here</button>
            ${d.file ? `<a class="pill" href="${escAttr(DIR + d.file)}" target="_blank" rel="noopener" aria-label="${escAttr(`${d.short} — the saved copy, a PDF, in a new tab`)}">Saved copy (PDF)<span aria-hidden="true"> ↗</span></a>` : ''}
            <a class="pill" href="${escAttr(d.url)}" target="_blank" rel="noopener" aria-label="${escAttr(`${d.short} — the current version, in a new tab`)}">Current version<span aria-hidden="true"> ↗</span></a>
            <a class="pill" href="${escAttr(d.home[1])}" target="_blank" rel="noopener" aria-label="${escAttr(`${d.home[0]} — in a new tab`)}">${esc(d.home[0])}<span aria-hidden="true"> ↗</span></a>
          </p>
        </li>`;
    }).join('')}</ul>
    <p class="ld-note">Copies saved on ${esc(dateText(SNAPSHOT))}. They are a record of what the rules said that day, not a promise of what they say now —
      ACMA replaces a RALI without notice and a determination can be amended. Reproduced under the terms each was published on
      (Creative Commons Attribution 4.0); the sources and terms are in
      <a href="${escAttr(typeof docUrl === 'function' ? docUrl('docs/acma/README.md') : 'docs/acma/README.md')}" target="_blank" rel="noopener">the folder’s notes</a>.</p>`;
  }

  return { SNAPSHOT, DOCS, CITES, KIND, cite, quote, said, where, open, openDoc, turn, libraryHtml, kindChip, text, find, dateText };
})();

if (typeof window !== 'undefined') window.LicenceDocs = LicenceDocs;
