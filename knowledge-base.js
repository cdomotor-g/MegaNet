// MegaNet — knowledge-base.js
//
//   KnowledgeBase   the Knowledge base group's shared parts: where each lesson
//                   came from, and the credit panel every adapted lesson shows.
//
// Five of the group's tabs are Flood-Net re-tellings of Mallee HydroTech's
// open training tools (github.com/MalleeHydroTech), used with the owner's
// permission and under the terms they publish: the code is MIT, the artwork and
// training material CC BY 4.0. CC BY asks for three things — credit Mallee
// HydroTech, link the source and the licence, and say what was changed — and
// MIT asks that its notice travel with the code. credit() is the first three,
// on the tab itself where a reader sees it; the notices are kept word for word
// in docs/third-party/mallee-hydrotech/. Nothing here implies the owner
// endorses Flood-Net: their grant gives no trademark rights, and the panel
// says so.
//
// After core.js (esc, escAttr) — docUrl is app.js's, called only once a tab
// renders — before the kb-*.js lessons that call credit() and before
// init.js. Nothing runs at load.

const KnowledgeBase = (function () {
  const ORG = 'Mallee HydroTech';
  const ORG_URL = 'https://malleehydrotech.com.au/';
  const MIT_URL = 'https://opensource.org/license/mit';
  const CCBY_URL = 'https://creativecommons.org/licenses/by/4.0/';
  const NOTICES = 'docs/third-party/mallee-hydrotech/README.md';

  // key → the original. `title` is the original's own name, as its owner
  // writes it; `changes` is the "indicate changes" CC BY asks for.
  const SOURCES = {
    staff: {
      title: 'Survey Staff Simulator',
      repo: 'https://github.com/MalleeHydroTech/survey-staff-simulator',
      changes: 'Rewritten for Flood-Net: the practice drills redrawn as Flood-Net SVG, the text condensed, the practice models\' arithmetic ported, and the original\'s React app, sign-in and certificate left out.',
    },
    logbook: {
      title: 'Survey Logbook',
      repo: 'https://github.com/MalleeHydroTech/survey-logbook',
      changes: 'Rewritten for Flood-Net: the lessons and booking practice re-set in Flood-Net\'s layout, the arithmetic checked by Flood-Net\'s own levelling code, and the original\'s illustrations left out.',
    },
    lifecycle: {
      title: 'Site Operations Lifecycle',
      repo: 'https://github.com/MalleeHydroTech/site-operations-lifecycle',
      changes: 'Rewritten for Flood-Net: the stages and scenarios re-set as Flood-Net panels, the text condensed, and the original\'s photographs and React app left out.',
    },
    level: {
      title: 'Hydrographer: A Day on the Level',
      repo: 'https://github.com/MalleeHydroTech/hydrographer-day-on-the-level',
      changes: 'Rewritten for Flood-Net: the game\'s day of levelling told as a step-by-step walkthrough with Flood-Net drawings, in place of the original\'s 3D scene, models and audio.',
    },
    river: {
      title: 'Hydrographer: A Day on the River',
      repo: 'https://github.com/MalleeHydroTech/hydrographer-day-on-the-river',
      changes: 'Rewritten for Flood-Net: the game\'s routine site visit told as a step-by-step walkthrough with Flood-Net drawings, in place of the original\'s 3D scene, models, audio and score service.',
    },
  };

  // The panel at the foot of an adapted lesson. Authored values only — nothing
  // here comes from a user or a file.
  function credit(key) {
    const s = SOURCES[key];
    if (!s) return '';
    return `<section class="panel kb-credit" aria-labelledby="kb-credit-${key}">
      <h3 id="kb-credit-${key}">Source and credit</h3>
      <p>Adapted from <a href="${s.repo}" target="_blank" rel="noopener"><cite>${esc(s.title)}</cite></a> by
        <a href="${ORG_URL}" target="_blank" rel="noopener">${ORG}</a>, used with permission.
        The original's code is © 2026 ${ORG} under the <a href="${MIT_URL}" target="_blank" rel="noopener">MIT licence</a>;
        its training material is licensed <a href="${CCBY_URL}" target="_blank" rel="noopener">CC BY 4.0</a>.</p>
      <p class="small"><strong>Changes:</strong> ${esc(s.changes)}
        Any mistake in this version is Flood-Net's, not ${ORG}'s, and ${ORG} does not endorse Flood-Net.
        The licence notices are kept in full in <a href="${escAttr(docUrl(NOTICES))}" target="_blank" rel="noopener">the third-party notices</a>.</p>
      <p class="small">Credit: “${ORG}, ${esc(s.title)}, CC BY 4.0; modified for Flood-Net.”</p>
    </section>`;
  }

  return { SOURCES, credit };
})();

if (typeof window !== 'undefined') window.KnowledgeBase = KnowledgeBase;
