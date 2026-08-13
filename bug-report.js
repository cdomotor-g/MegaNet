// MegaNet — bug-report.js
//
//   BugReport   gathers context and opens GitHub's own prefilled "New issue"
//               page, with a copy-the-report fallback for anyone without an
//               account.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js and nowhere else: state, esc, TAB_LIST, APP_VERSION,
// GITHUB_REPO, and the _errorLog ring buffer the global error handlers fill.
// That is deliberate rather than incidental. This is the thing people reach for
// when the app is already misbehaving, so it does not get to depend on anything
// newer than itself — which is also why it keeps its own copy of the modal
// markup instead of calling Modal.
//
// index.html's header calls BugReport.open() straight from the 🐞 button, so
// this file has to be loaded for that button to do anything; the handler runs on
// click, long after every script has been evaluated.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── Bug / issue reporting ────────────────────────────────────────────────────
// MegaNet is a static GitHub Pages app: there's no server to POST an issue to
// and nowhere safe to keep an API token. So the report button gathers context
// and opens GitHub's own prefilled "New issue" page — the user reviews it and
// clicks Submit, and the issue lands on the project repo (GITHUB_REPO). A "Copy
// report" fallback covers anyone without a GitHub account: paste it into an
// email to the maintainer instead. Auto-collected diagnostics (which screen,
// data state, browser, and any captured errors) turn a vague "it broke" into
// something reproducible.
const BugReport = (function () {

  // ghLabel values are GitHub's built-in default labels, so the prefilled
  // ?labels= applies cleanly on a fresh repo.
  const TYPES = [
    { id: 'bug',         label: 'Something is broken', prefix: 'Bug',      ghLabel: 'bug' },
    { id: 'enhancement', label: 'Idea / improvement',  prefix: 'Idea',     ghLabel: 'enhancement' },
    { id: 'question',    label: 'Question',            prefix: 'Question', ghLabel: 'question' },
  ];

  // Snapshot of the user's current context. Ordered for readability in the issue.
  function collect() {
    const d   = state.data;
    const tab = TAB_LIST.find(t => t.id === state.activeTab);
    const sel = (d && state.selectedId) ? d.stations.find(s => s.id === state.selectedId) : null;
    return {
      'Screen':           tab ? `${tab.label} (${tab.id})` : state.activeTab,
      'Selected station': sel ? `${sel.name} — ${sel.station_number || sel.id}` : '(none)',
      'Data loaded':      d ? `yes — ${d.stations.length} stations, ${(d.radio_networks || []).length} networks`
                            : 'no',
      'App build':        APP_VERSION,
      'Theme':            state.theme,
      'Page':             location.href,
      'Browser':          navigator.userAgent,
      'Platform':         navigator.platform || '(unknown)',
      'Language':         navigator.language || '(unknown)',
      'Window size':      `${window.innerWidth}×${window.innerHeight} (screen ${screen.width}×${screen.height})`,
      'Online':           navigator.onLine ? 'yes' : 'no',
      'Time':             new Date().toString(),
    };
  }

  // Markdown block of the snapshot plus any captured runtime errors.
  function diagBlock() {
    let out = Object.entries(collect()).map(([k, v]) => `- **${k}:** ${v}`).join('\n');
    if (_errorLog.length) {
      out += '\n\n**Recent errors (newest last):**\n```\n'
        + _errorLog.map(e =>
            `[${e.at}] ${e.kind}: ${e.message}`
            + (e.where ? `\n    at ${e.where}` : '')
            + (e.stack ? `\n    ${e.stack.replace(/\n/g, '\n    ')}` : '')
          ).join('\n')
        + '\n```';
    } else {
      out += '\n\n_No JavaScript errors were captured this session._';
    }
    return out;
  }

  function template() {
    const typeOpts = TYPES.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="br-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="br-title">Report a bug or idea</h2>
          <button class="modal-x" title="Close (Esc)" onclick="BugReport.close()">×</button>
        </div>
        <p class="sub">Tell us what happened. When you submit, MegaNet opens a pre-filled issue on the
           project's GitHub — just review it and click <em>Submit new issue</em>. No GitHub account?
           Use <em>Copy report</em> and email it to the maintainer instead.</p>

        <div class="modal-form">
          <label>What kind of report is this?
            <select id="br-type">${typeOpts}</select>
          </label>
          <label>What went wrong, or what would you like? <span class="req">*</span>
            <textarea id="br-desc" placeholder="e.g. Clicking a repeater on the Stations tab does nothing…"></textarea>
          </label>
          <label>What did you expect to happen? <span class="small">(optional)</span>
            <textarea id="br-expected" placeholder="e.g. The station's details should open on the right."></textarea>
          </label>

          <label class="check-inline">
            <input type="checkbox" id="br-include" checked>
            <span>Include diagnostic details <span class="small">(recommended — helps pinpoint the problem)</span></span>
          </label>

          <details class="diag-preview">
            <summary>Preview exactly what will be shared</summary>
            <pre class="diag-pre">${esc(diagBlock())}</pre>
          </details>
        </div>

        <div class="modal-foot">
          <button onclick="BugReport.close()">Cancel</button>
          <button onclick="BugReport.copy(this)">Copy report</button>
          <button class="primary" onclick="BugReport.submit()">Open GitHub issue ↗</button>
        </div>
      </div>`;
  }

  function open() {
    let root = document.getElementById('bugreport-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'bugreport-modal';
      root.className = 'modal-overlay';
      root.onclick = close;   // click on the backdrop (outside the card) closes
      document.body.appendChild(root);
    }
    root.innerHTML = template();
    root.style.display = 'flex';
    document.addEventListener('keydown', onKey);
    const ta = document.getElementById('br-desc');
    if (ta) ta.focus();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    const root = document.getElementById('bugreport-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
  }

  function buildReport() {
    const type     = (document.getElementById('br-type')     || {}).value   || 'bug';
    const desc     = ((document.getElementById('br-desc')     || {}).value   || '').trim();
    const expected = ((document.getElementById('br-expected') || {}).value   || '').trim();
    const include  = (document.getElementById('br-include')   || {}).checked;
    const t        = TYPES.find(x => x.id === type) || TYPES[0];
    const tab      = TAB_LIST.find(x => x.id === state.activeTab);
    const screen   = tab ? tab.label : state.activeTab;

    const firstLine = desc.split('\n')[0].slice(0, 80);
    const title = `[${t.prefix}] ${firstLine || screen}`;

    let body = `**What happened / what's wanted**\n${desc || '_(none provided)_'}\n`;
    if (expected) body += `\n**Expected**\n${expected}\n`;
    body += `\n**Where:** ${screen} screen`;
    if (include) body += `\n\n---\n### Diagnostics\n${diagBlock()}`;
    body += `\n\n<sub>Reported from MegaNet ${APP_VERSION} via the in-app bug reporter.</sub>`;

    return { title, body, ghLabel: t.ghLabel, desc };
  }

  function issueUrl(labelOnly) {
    const r = buildReport();
    let url = `https://github.com/${GITHUB_REPO}/issues/new?labels=${encodeURIComponent(r.ghLabel)}`;
    if (!labelOnly) {
      url += `&title=${encodeURIComponent(r.title)}&body=${encodeURIComponent(r.body)}`;
    }
    return { url, report: r };
  }

  function submit() {
    const { url, report } = issueUrl(false);
    if (!report.desc) {
      alert('Please describe what went wrong or what you\'d like before submitting.');
      const ta = document.getElementById('br-desc'); if (ta) ta.focus();
      return;
    }
    // GitHub caps the length of a prefilled issue URL. If we're over a safe
    // budget, copy the report and open a blank issue so nothing typed is lost.
    if (url.length > 7500) {
      copyText(`${report.title}\n\n${report.body}`);
      alert('Your report is long, so it was copied to the clipboard instead of pre-filling GitHub. '
          + 'A blank new-issue page is opening — paste (Ctrl/Cmd+V) into the description.');
      window.open(issueUrl(true).url, '_blank', 'noopener');
    } else {
      window.open(url, '_blank', 'noopener');
    }
    close();
  }

  function copy(btn) {
    const r = buildReport();
    copyText(`${r.title}\n\n${r.body}`).then(ok => {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  return { open, close, submit, copy };
})();
if (typeof window !== 'undefined') window.BugReport = BugReport;
