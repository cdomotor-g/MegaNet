// MegaNet — bug-report.js
//
//   BugReport   gathers context and sends it to the Worker's /api/report,
//               which files it for the reporter; where that is not set up or
//               fails, GitHub's own prefilled "New issue" page, with a
//               copy-the-report fallback for anyone without an account.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js and nowhere else: state, esc, TAB_LIST, APP_VERSION,
// GITHUB_REPO, dbProxyAvailable, and the _errorLog ring buffer the global error
// handlers fill.
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
// The report button gathers context and, where the Worker is set up to take it
// (worker/report.js, docs/bug-reports.md), sends it there: one press of Send,
// and it is filed as an issue on the project repo (GITHUB_REPO) or emailed to
// the team, with no GitHub account and no second page. The dialog asks the
// Worker on opening whether it is ready, and words itself to match.
//
// Where it is not — no token set yet, the day's ceiling reached, a page served
// from somewhere the Worker does not answer for — it opens GitHub's own
// prefilled "New issue" page as it always did: the user reviews it and clicks
// Submit. A send that fails says why and turns the dialog into that, with the
// report still in it. "Copy report" covers anyone without a GitHub account:
// paste it into an email to the maintainer instead. Auto-collected diagnostics
// (which screen, data state, browser, and any captured errors) turn a vague "it
// broke" into something reproducible.
const BugReport = (function () {

  // ghLabel values are GitHub's built-in default labels, so the prefilled
  // ?labels= applies cleanly on a fresh repo.
  const TYPES = [
    { id: 'bug',         label: 'Something is broken', prefix: 'Bug',      ghLabel: 'bug' },
    { id: 'enhancement', label: 'Idea / improvement',  prefix: 'Idea',     ghLabel: 'enhancement' },
    { id: 'question',    label: 'Question',            prefix: 'Question', ghLabel: 'question' },
  ];

  // Where a report is sent: this origin when the Worker is in front of it, as
  // for the database; the one that has it otherwise, which answers the
  // github.io copy and refuses anywhere else — and a refusal reads as "not
  // ready", which is GitHub's page.
  const REPORT_URL = `${dbProxyAvailable() ? '' : 'https://floodwarning.net'}/api/report`;
  const SEND_TIMEOUT_MS = 20000;

  // How Send goes this session: 'direct' (the Worker files it) or 'github'
  // (GitHub's prefilled page). Null until the Worker has been asked; `to` is
  // where it said a report goes.
  let route = null, to = [], sending = false;
  // Bumped by each probe and each send: only the latest one's answer is acted
  // on, so a probe answering late cannot undo what a send decided, and a send
  // answering into a dialog closed and opened again since leaves it be.
  let asked = 0;

  // The address, less anything in it that could be a credential: auth.js takes
  // a sign-in link's token out of the address once it has read it, and this
  // does not rely on that having happened.
  function pageForReport() {
    try {
      const u = new URL(location.href);
      for (const k of [...u.searchParams.keys()]) {
        if (/token|code|key|secret|pass/i.test(k)) u.searchParams.set(k, '(removed)');
      }
      if (/token|code|key|secret|pass/i.test(u.hash)) u.hash = '(removed)';
      return u.href;
    } catch (_) { return '(unknown)'; }
  }

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
      'Page':             pageForReport(),
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

  // The line under the title, for the way Send will go.
  function introHtml() {
    if (route === 'direct') {
      const pub = to.includes('github')
        ? ` It is posted on the project's public GitHub page, so leave out passwords, gate or padlock codes,
            and anyone's phone number or email address.`
        : '';
      return `Tell us what happened and press <em>Send report</em> — it goes straight to the Flood-Net team.
              No GitHub account needed.${pub}`;
    }
    return `Tell us what happened. When you submit, Flood-Net opens a pre-filled issue on the
            project's GitHub — just review it and click <em>Submit new issue</em>. No GitHub account?
            Use <em>Copy report</em> and email it to the maintainer instead.`;
  }

  // Bring the line, the button and Copy report into step with `route`. In
  // place, so nothing typed in the boxes is touched.
  function applyRoute() {
    const intro = document.getElementById('br-intro');
    const go = document.getElementById('br-go');
    const copyBtn = document.getElementById('br-copy');
    if (intro) intro.innerHTML = introHtml();
    if (go && !sending) go.textContent = route === 'direct' ? 'Send report' : 'Open GitHub issue ↗';
    // Sending direct, a copy is not the next step for anybody; on GitHub's
    // route it is the way round for anyone without an account.
    if (copyBtn) copyBtn.hidden = route === 'direct';
  }

  // Ask the Worker whether Send can go through it. Any answer but a ready one
  // — including none, from an origin it does not answer — is GitHub's page.
  function probe() {
    const mine = ++asked;
    fetch(REPORT_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(out => out, () => null)
      .then(out => {
        if (mine !== asked) return;
        route = out && out.ready ? 'direct' : 'github';
        to = (out && Array.isArray(out.to)) ? out.to : [];
        applyRoute();
      });
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
        <p class="sub" id="br-intro">${introHtml()}</p>

        <div class="modal-form">
          <label>What kind of report is this?
            <select id="br-type">${typeOpts}</select>
          </label>
          <label>What went wrong, or what would you like? <span class="req">*</span>
            <textarea id="br-desc" aria-describedby="br-msg" placeholder="e.g. Clicking a repeater on the Stations tab does nothing…"></textarea>
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

        <p id="br-msg" class="br-msg" tabindex="-1" hidden></p>

        <div class="modal-foot">
          <button onclick="BugReport.close()">Cancel</button>
          <button id="br-copy" onclick="BugReport.copy(this)">Copy report</button>
          <button id="br-go" class="primary" onclick="BugReport.submit()">Open GitHub issue ↗</button>
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
    // Until the Worker has answered, a guess from where the page is: this
    // origin has the Worker in front of it; anywhere else may not.
    if (!route) { route = dbProxyAvailable() ? 'direct' : 'github'; to = ['github']; }
    sending = false;
    root.innerHTML = template();
    applyRoute();
    root.style.display = 'flex';
    document.addEventListener('keydown', onKey);
    const ta = document.getElementById('br-desc');
    if (ta) ta.focus();
    probe();
  }

  // preventDefault marks the key claimed: the fullscreen map's own Escape
  // listener stands down for a claimed key, so closing this dialog cannot
  // also drop the map out of full screen behind it (the Modal contract).
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  function close() {
    const root = document.getElementById('bugreport-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
    sending = false;
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
    body += `\n\n<sub>Reported from Flood-Net ${APP_VERSION} via the in-app bug reporter.</sub>`;

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

  // A line in the dialog's own markup, for what alert() used to say (#223).
  // Not Toast: this file depends on nothing newer than itself (see the top).
  // The field it is about is described by it, so moving focus there reads it.
  function say(text, bad) {
    const el = document.getElementById('br-msg');
    if (!el) return null;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('is-bad', !!bad);
    return el;
  }

  function submit() {
    if (sending) return;
    const { url, report } = issueUrl(false);
    const ta = document.getElementById('br-desc');
    if (!report.desc) {
      say('Describe what went wrong, or what you would like, first — it is the one thing the report needs.', true);
      if (ta) { ta.setAttribute('aria-invalid', 'true'); ta.focus(); }
      return;
    }
    if (ta) ta.removeAttribute('aria-invalid');
    if (route === 'direct') { send(report); return; }
    // GitHub caps the length of a prefilled issue URL. If we're over a safe
    // budget, copy the report and open a blank issue so nothing typed is lost.
    // The copy is started first, while the page still has the focus a new tab
    // is about to take; and the dialog stays, because what it now says is the
    // next step — closing it would take the instructions away with it.
    if (url.length > 7500) {
      const copied = copyText(`${report.title}\n\n${report.body}`);
      window.open(issueUrl(true).url, '_blank', 'noopener');
      copied.then(ok => {
        const el = say(ok
          ? 'Your report is long, so it was copied to the clipboard instead of filled in on GitHub. '
            + 'A blank issue has opened in a new tab: paste it into the description (Ctrl/Cmd+V).'
          : 'Your report is too long to fill in on GitHub, and it could not be copied by itself. '
            + 'Press Copy report, then paste it into the blank issue that opened in a new tab.', !ok);
        if (el) el.focus();
      });
      return;
    }
    window.open(url, '_blank', 'noopener');
    close();
  }

  // Send it through the Worker. On success the dialog becomes a thank-you with
  // the issue's link; on failure it says why and becomes GitHub's route, with
  // everything typed still in it — except a busy minute, which is only a wait.
  function send(report) {
    const go = document.getElementById('br-go');
    const mine = ++asked;
    sending = true;
    say('');
    if (go) { go.disabled = true; go.textContent = 'Sending…'; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS) : null;
    const type = (document.getElementById('br-type') || {}).value || 'bug';
    fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type, title: report.title, body: report.body }),
      signal: ctl ? ctl.signal : undefined,
    }).then(
      res => res.json().catch(() => null).then(out => ({ status: res.status, out: out || {} })),
      () => ({ status: 0, out: {} }),
    ).then(({ status, out }) => {
      if (timer) clearTimeout(timer);
      if (mine !== asked || !document.getElementById('br-go')) return;   // closed meanwhile
      sending = false;
      if (status === 201) { sent(out); return; }
      const busy = status === 429 && !out.ceiling;
      if (!busy) route = 'github';
      applyRoute();
      const btn = document.getElementById('br-go');
      if (btn) btn.disabled = false;
      const why = status === 0 ? 'Flood-Net could not be reached (are you offline?)'
        : busy ? 'A few reports have just been sent from this connection'
        : out.ceiling ? 'Flood-Net has taken as many reports as it can for today'
        : out.unconfigured ? 'Flood-Net is not set up to take reports directly yet'
        : `Flood-Net could not file it (${out.error || `HTTP ${status}`})`;
      const el = say(busy
        ? `${why}. Wait a minute and press Send report again — what you typed is still here.`
        : `${why}. What you typed is still here: press Open GitHub issue to file it there, filled in for you, `
          + 'or Copy report to email it.', true);
      if (el) el.focus();
    });
  }

  // The dialog's thanks, in place of the form, with where the report went.
  function sent(out) {
    const card = document.querySelector('#bugreport-modal .modal-card');
    if (!card) return;
    for (const sel of ['#br-intro', '.modal-form']) {
      const el = card.querySelector(sel);
      if (el) el.hidden = true;
    }
    const foot = card.querySelector('.modal-foot');
    if (foot) foot.innerHTML = '<button class="primary" onclick="BugReport.close()">Done</button>';
    const el = say('Thank you — your report has reached the Flood-Net team.');
    if (!el) return;
    if (/^https:\/\/github\.com\//.test(out.url || '')) {
      el.append(' It is ');
      const a = document.createElement('a');
      a.href = out.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `issue #${out.number} on GitHub ↗`;
      el.append(a, ', if you would like to follow it.');
    }
    el.focus();
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
