// MegaNet — investigations.js
//
//   Investigations   🕵️ the Investigations tab, in Network health beside
//                    Station Health and Backbone: the write-ups of strange
//                    data and what was behind it, newest first, each opening
//                    its two-page report.
//
// The list is not kept here. investigations/index.html is the list — a page of
// its own that a crawler, a printer or a link from outside can read — and this
// tab reads its <article>s, so an entry added there is on the tab with nothing
// to change in the app. Each article's first .meta paragraph, its h3 link and
// the paragraph after it are the card's three parts; a link that is not a page
// beside the list is left out rather than followed.
//
// After core.js (esc, escAttr). Nothing runs at load; switchTab calls render()
// then init().

const Investigations = (function () {
  const LIST = 'investigations/';
  const PAGE = /^[a-z0-9][a-z0-9-]*\.html$/;

  // 'idle' until the tab is first opened, then 'loading', 'ready' or 'error'.
  const S = { phase: 'idle', items: [], err: '' };

  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('main article')].map(a => {
      const link = a.querySelector('h3 a');
      const href = link ? (link.getAttribute('href') || '').trim() : '';
      const paras = [...a.querySelectorAll('p')];
      const meta = a.querySelector('p.meta');
      const pill = meta && meta.querySelector('.pill');
      const metaText = meta ? [...meta.childNodes].filter(n => n !== pill).map(n => n.textContent).join('') : '';
      return {
        title: link ? link.textContent.replace(/\s+/g, ' ').trim() : '',
        href: PAGE.test(href) ? LIST + href : '',
        meta: metaText.replace(/\s+/g, ' ').replace(/[\s·]+$/, '').trim(),
        status: pill ? pill.textContent.replace(/\s+/g, ' ').trim() : '',
        summary: (paras.find(p => p !== meta) || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      };
    }).filter(i => i.title && i.href);
  }

  async function load() {
    S.phase = 'loading';
    try {
      const res = await fetch(LIST + 'index.html', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`the list answered ${res.status}`);
      S.items = parse(await res.text());
      S.phase = 'ready';
    } catch (e) {
      S.err = (e && e.message) || String(e);
      S.phase = 'error';
    }
    paint();
  }

  function cardHtml(i) {
    return `
      <div class="panel inv-card">
        <p class="small txt-muted">${esc(i.meta)}${i.status ? ` · <strong>${esc(i.status)}</strong>` : ''}</p>
        <h3 class="inv-title"><a href="${escAttr(i.href)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3>
        <p>${esc(i.summary)}</p>
        <p><a class="btn" href="${escAttr(i.href)}" target="_blank" rel="noopener">📄 Read the report</a>
          <span class="small txt-muted">Two printed pages. Print it, or save it as a PDF, from the browser.</span></p>
      </div>`;
  }

  function bodyHtml() {
    if (S.phase === 'error') {
      return `<div class="panel"><p class="txt-bad" role="alert">The list of investigations could not be read: ${esc(S.err)}.</p>
        <p>It needs a connection. <button class="btn" onclick="Investigations.retry()">Try again</button>
          or <a href="${LIST}" target="_blank" rel="noopener">open it as a page</a>.</p></div>`;
    }
    if (S.phase !== 'ready') return '<div class="panel"><p class="small" role="status">Reading the list of investigations…</p></div>';
    if (!S.items.length) return '<div class="panel"><p>No investigations yet.</p></div>';
    return S.items.map(cardHtml).join('');
  }

  function render() {
    return `
    <div class="page inv-page" style="--page-max:900px">
      <div class="panel">
        <div class="panel-header"><h2>Investigations</h2></div>
        <p class="small txt-muted">Strange data we have looked into, and what was behind it, newest first. Each one is
          dated, says how sure it is, and keeps the exports and the script behind every figure in the repository.
          <a href="${LIST}" target="_blank" rel="noopener">The list as a page of its own</a>.</p>
      </div>
      <div id="inv-list">${bodyHtml()}</div>
    </div>`;
  }

  function paint() {
    const el = document.getElementById('inv-list');
    if (el) el.innerHTML = bodyHtml();
  }

  function init() {
    if (S.phase === 'idle' || S.phase === 'error') load();
  }

  function retry() {
    load();
    paint();
  }

  return { render, init, retry, parse };
})();
