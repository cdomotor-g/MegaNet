// The app's own questions — modal.js's confirmDialog and promptDialog (#223),
// which replaced the browser's confirm() and prompt() — answered the way a
// person answers them: wait for the dialog, read what it asks, press a button.
//
// Playwright dismisses a native dialog nobody handles, which is "no" to a
// confirm(); an in-app one stays up and covers the page until it is answered.
// So a check that used to get away with not handling a confirm now has to say
// what it would have pressed — which is the better test anyway.

/**
 * Waits for the question, reads it, and presses yes or no (or types first).
 * @param {import('playwright-core').Page} page
 * @param {boolean} yes   press the button that acts, else the one that does not
 * @param {{ timeout?: number, type?: string }} [opts]  `type` fills the prompt's box
 * @returns {Promise<{ title: string, text: string, yes: string, no: string, danger: boolean, message: string }>}
 */
export async function answer(page, yes, { timeout = 5000, type = null } = {}) {
  await page.waitForSelector('#app-ask .modal-card', { state: 'visible', timeout });
  const q = await page.evaluate(() => {
    const card = document.querySelector('#app-ask .modal-card');
    const txt = sel => ((card.querySelector(sel) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const go = card.querySelector('[data-ask="yes"]');
    return {
      title: txt('#app-ask-title'),
      text: txt('#app-ask-desc'),
      yes: txt('[data-ask="yes"]'),
      no: txt('[data-ask="no"]'),
      danger: !!(go && go.classList.contains('btn-danger')),
    };
  });
  if (type != null) await page.fill('#app-ask-input', type);
  await page.click(`#app-ask [data-ask="${yes ? 'yes' : 'no'}"]`);
  await page.waitForSelector('#app-ask .modal-card', { state: 'detached', timeout });
  return { ...q, message: `${q.title} ${q.text}`.trim() };
}

/** Whether a question is up. */
export const asking = page => page.evaluate(() => !!document.querySelector('#app-ask .modal-card'));
