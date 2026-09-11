// The two navigators under and beside the Arrow chart, and the wheel over it.
//
// This exists because of a defect that was invisible to every check the repo
// had, and plainly visible to anybody using the tab: the edge handles of the
// overview strip and the vertical navigator **could not be grabbed**. The
// cursor flickered between the double arrow and a plain pointer, and a press
// that looked dead-on threw the window sideways instead of resizing it.
//
// Nothing was wrong with the hit-test, and nothing was wrong with the drawing.
// They simply disagreed about where the pointer was:
//
//   Both SVGs left `preserveAspectRatio` at its `xMidYMid meet` default, which
//   fits the viewBox *uniformly* inside the box and centres the leftovers. The
//   overview's viewBox is as wide as the chart and 56 tall, drawn into a box as
//   wide as the chart and 54 tall (a 1 px border, box-sizing: border-box), so
//   the whole strip was drawn ~3.5% narrow and centred — every handle up to
//   17 px from where it was painted. The vertical navigator, 46 viewBox px of
//   width in 44 of content box, was a dozen px out down its length.
//
//   Meanwhile the hit-tests mapped client coordinates with
//   `(clientX - rect.left) * (ad.w / rect.width)`, which assumes the viewBox
//   fills the *border* box corner to corner. It does not, and never did.
//
// So this checks the one thing that proves the two agree — a press at the
// centre of the handle *as drawn* is read as a resize of that edge — plus the
// thickness and the cursor that made it findable in the first place, and the
// wheel gestures that share the same coordinate mapping.
//
// It also covers the two differences the hover balloon and the pinned callout
// quote either side of a reading: both go through one neighbourDelta(), against
// the values the chart is actually drawing, so a rainfall rollover or a removed
// neighbour cannot make the figure beside a point disagree with the points.
//
//   node --run adnav      (or: npm run adnav)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // The demo CSV, through the same door the "Load demo data" button uses.
  await page.evaluate(async () => {
    switchTab('arrodata');
    await new Promise(r => setTimeout(r, 60));
    await window.ArroData.loadDemo();
  });
  await page.waitForFunction(() => window.ArroData.ad.series.length > 0,
                             null, { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(200);

  // A window well inside the track, so both edge handles are reachable and
  // neither is sitting on a clamp.
  const span = await page.evaluate(() => {
    const A = window.ArroData;
    const s = A.ad.series[0];
    const t0 = s.t[0], t1 = s.t[s.n - 1];
    A.ad.view = { t0: t0 + (t1 - t0) * 0.35, t1: t0 + (t1 - t0) * 0.65 };
    A.repaint();
    return { t0: A.ad.view.t0, t1: A.ad.view.t1, rec0: t0, rec1: t1 };
  });
  await page.waitForTimeout(120);

  // ── 1. The handles are things a hand can land on ──────────────────────────
  const grips = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                                 w: r.width, h: r.height }; };
    const ovEdges  = [...document.querySelectorAll('#ad-ov .ad-ov-edge')].map(box);
    const vovEdges = [...document.querySelectorAll('#ad-vov .ad-vov-edge')].map(box);
    return { ovEdges, vovEdges };
  });

  ok('the overview strip draws a hit zone for each edge', grips.ovEdges.length === 2,
     `found ${grips.ovEdges.length}`);
  ok('the vertical navigator draws a hit zone for each edge', grips.vovEdges.length === 2,
     `found ${grips.vovEdges.length}`);
  // 12 viewBox px is what it used to be, and what the complaint was about.
  for (const [i, g] of grips.ovEdges.entries()) {
    ok(`overview edge ${i} is at least 16 px wide on screen`, g.w >= 16,
       `${g.w.toFixed(1)} px`);
  }
  for (const [i, g] of grips.vovEdges.entries()) {
    ok(`vertical edge ${i} is at least 16 px tall on screen`, g.h >= 16,
       `${g.h.toFixed(1)} px`);
  }

  // ── 2. …and the pointer says so, over the handle as drawn ─────────────────
  const cursors = await page.evaluate(({ ovEdges, vovEdges }) => {
    const at = p => {
      const el = document.elementFromPoint(p.x, p.y);
      return { cls: el ? (el.getAttribute('class') || el.tagName) : null,
               cursor: el ? getComputedStyle(el).cursor : null };
    };
    const mid = sel => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return at({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    return {
      ovEdge:  ovEdges.map(at),
      vovEdge: vovEdges.map(at),
      ovMid:   mid('#ad-ov .ad-ov-mid'),
      vovMid:  mid('#ad-vov .ad-vov-mid'),
    };
  }, grips);

  for (const [i, c] of cursors.ovEdge.entries()) {
    ok(`the pointer over overview edge ${i} is the double arrow`, c.cursor === 'ew-resize',
       `cursor=${c.cursor} on ${c.cls}`);
  }
  for (const [i, c] of cursors.vovEdge.entries()) {
    ok(`the pointer over vertical edge ${i} is the double arrow`, c.cursor === 'ns-resize',
       `cursor=${c.cursor} on ${c.cls}`);
  }
  ok('the pointer over the overview window says grab', cursors.ovMid.cursor === 'grab',
     `cursor=${cursors.ovMid.cursor} on ${cursors.ovMid.cls}`);
  ok('the pointer over the vertical window says grab', cursors.vovMid.cursor === 'grab',
     `cursor=${cursors.vovMid.cursor} on ${cursors.vovMid.cls}`);

  // ── 2b. The strip is drawn over the chart's own scale ─────────────────────
  // The overview's window box only means anything if the same instant is at the
  // same screen x on both, which is why the strip quotes the chart's PADL and
  // padRNow() rather than its own margins. Left to preserveAspectRatio's
  // default the browser undoes that for it: `meet` fits the viewBox uniformly
  // and centres what is left, so a strip whose viewBox is as wide as the chart
  // and 56 tall, drawn into a box 54 tall, comes out ~3.5% narrow and pushed
  // ~17 px inward at each end. Nothing throws and the strip looks fine on its
  // own — it is only wrong against the chart above it.
  const align = await page.evaluate(() => {
    // One viewBox point, through each SVG's own matrix, onto the screen.
    const screenX = (id, vx) => {
      const el = document.getElementById(id);
      const m = el.getScreenCTM();
      return new DOMPoint(vx, 0).matrixTransform(m).x;
    };
    const A = window.ArroData;
    const w = A.ad.w;
    return {
      // PADL and the plot's right edge, as the chart and the strip each place them.
      leftChart: screenX('ad-svg', 64), leftOv: screenX('ad-ov', 64),
      rightChart: screenX('ad-svg', w - 18), rightOv: screenX('ad-ov', w - 18),
    };
  });
  ok('the overview strip puts the chart\'s left margin where the chart does',
     Math.abs(align.leftChart - align.leftOv) < 2,
     `chart ${align.leftChart.toFixed(1)} px, strip ${align.leftOv.toFixed(1)} px`);
  ok('…and its right margin too',
     Math.abs(align.rightChart - align.rightOv) < 2,
     `chart ${align.rightChart.toFixed(1)} px, strip ${align.rightOv.toFixed(1)} px`);

  // ── 3. The regression itself: a press on the handle is read as that edge ──
  // The handle's screen position comes from the *drawing*; the verdict comes
  // from the hit-test. Before preserveAspectRatio="none" and svgPt() the two
  // were up to 17 px apart, this press read as "outside the window", and the
  // window jumped instead of resizing.
  // Both ends of the zone as drawn, not just its middle: a middle-only check
  // passes with the mapping out by half a grip, and half a grip is more than
  // the error that made these handles ungrabbable in the first place.
  const right = grips.ovEdges[1];
  for (const [where, x] of [['near end', right.x - right.w / 2 + 1.5],
                            ['far end',  right.x + right.w / 2 - 1.5],
                            ['middle',   right.x]]) {
    await page.mouse.move(x, right.y);
    await page.mouse.down();
    const k = await page.evaluate(() => {
      const d = window.ArroData.ad.ovDrag;
      return d && d.kind;
    });
    await page.mouse.up();
    ok(`the ${where} of the right handle, as drawn, is read as that edge`, k === 'hi',
       `navHit said "${k}" ${(x - right.x).toFixed(1)} px from centre`);
  }

  await page.mouse.move(right.x, right.y);
  await page.mouse.down();
  const pressed = await page.evaluate(() => {
    const d = window.ArroData.ad.ovDrag;
    return { kind: d && d.kind, t0: window.ArroData.ad.view.t0 };
  });
  ok('a press on the right handle resizes that edge, not the window',
     pressed.kind === 'hi', `navHit said "${pressed.kind}"`);
  ok('…and does not move the far edge on the way',
     Math.abs(pressed.t0 - span.t0) < 1,
     `t0 moved by ${Math.round(pressed.t0 - span.t0)} ms`);

  // Drag it left: the window narrows from the right, and only from the right.
  await page.mouse.move(right.x - 80, right.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const resized = await page.evaluate(() => ({ ...window.ArroData.ad.view }));
  ok('dragging the right handle narrows the window',
     resized.t1 < span.t1 - 1 && Math.abs(resized.t0 - span.t0) < 1,
     `t0 ${Math.round(resized.t0 - span.t0)} ms, t1 ${Math.round(resized.t1 - span.t1)} ms`);

  // The same on the other axis, where the error was a clean dozen pixels.
  // Re-measured rather than reused: the resize above changed the horizontal
  // window, and with the vertical axis on its default fit-to-view that moves
  // the box this is aiming at.
  // Settle the toolbar first. The *first* press on this navigator is what moves
  // the vertical axis to Fixed, and Fixed adds two number inputs to the toolbar
  // — which makes the toolbar taller and pushes the whole plot down the page by
  // about a hundred pixels. That is the pane doing what it says it does, and the
  // gesture survives it (the capture is re-taken and every mapping re-read), but
  // a screen coordinate measured before it is stale after it.
  const settle = await page.evaluate(() => {
    const r = document.querySelector('#ad-vov .ad-vov-edge').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(settle.x, settle.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);

  const vtop = await page.evaluate(() => {
    const r = document.querySelector('#ad-vov .ad-vov-edge').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
  });
  for (const [where, y] of [['near end', vtop.y - vtop.h / 2 + 1.5],
                            ['far end',  vtop.y + vtop.h / 2 - 1.5],
                            ['middle',   vtop.y]]) {
    await page.mouse.move(vtop.x, y);
    await page.mouse.down();
    const k = await page.evaluate(() => {
      const d = window.ArroData.ad.vovDrag;
      return d && d.kind;
    });
    await page.mouse.up();
    ok(`the ${where} of the vertical top handle, as drawn, is read as that edge`,
       k === 'lo', `navHit said "${k}" ${(y - vtop.y).toFixed(1)} px from centre`);
  }

  // ── 4. The wheel ──────────────────────────────────────────────────────────
  const stage = await page.evaluate(() => {
    const r = document.getElementById('ad-svg').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const view = () => page.evaluate(() => ({ ...window.ArroData.ad.view }));

  await page.mouse.move(stage.x, stage.y);
  const zoom0 = await view();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(120);
  const zoom1 = await view();
  ok('a plain wheel still zooms', (zoom1.t1 - zoom1.t0) > (zoom0.t1 - zoom0.t0) + 1,
     `span ${Math.round(zoom0.t1 - zoom0.t0)} → ${Math.round(zoom1.t1 - zoom1.t0)} ms`);
  // One notch, one modest step — not the 18% lurch an uncapped delta gave.
  const grew = (zoom1.t1 - zoom1.t0) / (zoom0.t1 - zoom0.t0);
  ok('…by one modest step rather than a lurch', grew > 1.01 && grew < 1.12,
     `one notch changed the span by ${((grew - 1) * 100).toFixed(1)}%`);

  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(120);
  const pan1 = await view();
  ok('Shift+wheel pans instead of zooming',
     Math.abs((pan1.t1 - pan1.t0) - (zoom1.t1 - zoom1.t0)) < 2 && pan1.t0 > zoom1.t0 + 1,
     `span ${Math.round(zoom1.t1 - zoom1.t0)} → ${Math.round(pan1.t1 - pan1.t0)} ms, `
     + `t0 moved ${Math.round(pan1.t0 - zoom1.t0)} ms`);

  await page.mouse.wheel(-200, 0);
  await page.waitForTimeout(120);
  const pan2 = await view();
  ok('a sideways wheel pans the other way',
     Math.abs((pan2.t1 - pan2.t0) - (pan1.t1 - pan1.t0)) < 2 && pan2.t0 < pan1.t0 - 1,
     `t0 moved ${Math.round(pan2.t0 - pan1.t0)} ms`);

  // The wheel is one gesture whatever "Drag does" is set to — it never consulted
  // that setting, and this is what keeps it that way.
  const perMode = {};
  for (const mode of ['pan', 'box', 'y', 'select']) {
    perMode[mode] = await page.evaluate(async (m) => {
      const A = window.ArroData;
      A.setDrag(m);
      await new Promise(r => setTimeout(r, 60));
      const before = { ...A.ad.view };
      return { before, mode: A.ad.dragMode };
    }, mode);
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(120);
    const after = await view();
    perMode[mode].ratio = (after.t1 - after.t0)
                        / (perMode[mode].before.t1 - perMode[mode].before.t0);
  }
  const ratios = Object.values(perMode).map(m => m.ratio);
  ok('one wheel notch is the same step in all four "Drag does" modes',
     Math.max(...ratios) - Math.min(...ratios) < 0.001,
     Object.entries(perMode).map(([k, m]) => `${k}=${m.ratio.toFixed(4)}`).join(' '));

  // ── 5. The balloon says it too, at a glance ───────────────────────────────
  // The hover balloon is where the question is actually asked — the pointer is
  // already on the point. It quotes the same two differences as the callout,
  // from the same neighbourDelta(), but as figures alone.
  const balloon = await page.evaluate(async () => {
    const A = window.ArroData, s = A.ad.series[0];
    const f = A.runFilter(s, A.ad.cfg);
    // A reading whose neighbours both differ from it, so the figures are not
    // all zeros, and one whose previous neighbour the filters removed.
    const CUT = new Set([3, 4, 5, 6, 7]);
    let step = -1, cut = -1;
    for (let i = 1; i < s.n - 1; i++) {
      if (step < 0 && Math.abs(f.adj[i] - f.adj[i - 1]) > 0.1
                   && Math.abs(f.adj[i + 1] - f.adj[i]) > 0.1) step = i;
      if (cut < 0 && CUT.has(f.status[i - 1])
                  && Math.abs(f.adj[i] - f.adj[i - 1]) > 0.1) cut = i;
      if (step >= 0 && cut >= 0) break;
    }
    const hover = (i) => {
      // Straight through hoverAt()'s own path: set the window around the
      // reading, then ask the module where the pointer would land on it.
      const t = s.t[i];
      A.ad.view = { t0: t - 900000, t1: t + 900000 };
      A.repaint();
      const px = 64 + (t - A.ad.view.t0) / (A.ad.view.t1 - A.ad.view.t0) * (A.ad.w - 64 - 18);
      const r = document.getElementById('ad-svg').getBoundingClientRect();
      return { x: r.left + (px / A.ad.w) * r.width, y: r.top + r.height / 2 };
    };
    return { step, cut, at: { step: hover(step), cut: hover(cut) },
             want: { prev: f.adj[step] - f.adj[step - 1], next: f.adj[step + 1] - f.adj[step] } };
  });

  const tipAt = async (pt) => {
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const el = document.getElementById('ad-tip');
      if (!el || el.hidden) return null;
      const d = el.querySelector('.ad-tip-d');
      return { text: el.innerText.replace(/\s+/g, ' ').trim(),
               delta: d ? d.textContent.replace(/\s+/g, ' ').trim() : null,
               warned: !!(d && d.querySelector('b.txt-warn')) };
    });
  };

  // Re-measure: repaint() above moved the window, and the coordinates were
  // computed against the window each hover() call had just set.
  await page.evaluate((i) => {
    const A = window.ArroData, s = A.ad.series[0], t = s.t[i];
    A.ad.view = { t0: t - 900000, t1: t + 900000 };
    A.repaint();
  }, balloon.step);
  await page.waitForTimeout(200);
  const tipStep = await tipAt(balloon.at.step);
  ok('the hover balloon appears', !!tipStep, 'no balloon');
  ok('it carries a Δ prev and a Δ next', !!(tipStep && /Δ prev/.test(tipStep.delta || '')
                                            && /Δ next/.test(tipStep.delta || '')),
     tipStep && tipStep.text);
  // Against the arithmetic, not just against a number being present: which
  // reading the pointer actually landed on is hoverAt()'s call, so the expected
  // figures are read back from the reading it chose.
  const want = await page.evaluate(() => {
    const A = window.ArroData, s = A.ad.series[0];
    const h = A.ad.hover && A.ad.hover.rows[0];
    if (!h) return null;
    const f = A.runFilter(s, A.ad.cfg);
    const fmt = dv => `${dv > 0 ? '+' : ''}${
      Math.abs(dv) >= 1000 ? dv.toFixed(0) : Math.abs(dv) >= 10 ? dv.toFixed(1)
      : Math.abs(dv) >= 1 ? dv.toFixed(2)
      : dv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
    return { prev: fmt(f.adj[h.i] - f.adj[h.i - 1]), next: fmt(f.adj[h.i + 1] - f.adj[h.i]) };
  });
  ok('the figures are the differences either side of the reading it landed on',
     !!(want && tipStep.delta === `Δ prev ${want.prev} · Δ next ${want.next}`),
     `${tipStep && tipStep.delta}  ≠  Δ prev ${want && want.prev} · Δ next ${want && want.next}`);
  ok('…and they are not all zeros, so the check means something',
     !!(want && (want.prev !== '0' || want.next !== '0')),
     JSON.stringify(want));

  await page.evaluate((i) => {
    const A = window.ArroData, s = A.ad.series[0], t = s.t[i];
    A.ad.view = { t0: t - 900000, t1: t + 900000 };
    A.repaint();
  }, balloon.cut);
  await page.waitForTimeout(200);
  const tipCut = await tipAt(balloon.at.cut);
  ok('a difference against a reading the filters removed is flagged',
     !!(tipCut && tipCut.warned), tipCut && tipCut.delta);

  // Increment already plots the difference from the reading before, so a second
  // one beside it would be the same fact twice — and against the untransformed
  // value, a different number.
  await page.evaluate(() => window.ArroData.setTransform('increment'));
  await page.waitForTimeout(250);
  const tipInc = await tipAt(balloon.at.cut);
  ok('the balloon drops the deltas when the chart is already drawing them',
     !!tipInc && tipInc.delta === null, tipInc && tipInc.text);
  await page.evaluate(() => window.ArroData.setTransform('value'));
  await page.waitForTimeout(250);

  // ── 6. The callout says what the reading did, either side ─────────────────
  const pin = await page.evaluate(async () => {
    const A = window.ArroData;
    const s = A.ad.series[0];
    A.ad.pin = { key: s.key, i: 40 };
    switchTab('arro');
    await new Promise(r => setTimeout(r, 40));
    switchTab('arrodata');
    await new Promise(r => setTimeout(r, 160));
    const el = document.querySelector('.ad-pin');
    const cells = [...document.querySelectorAll('.ad-pin-grid .ad-delta')]
      .map(d => d.textContent.replace(/\s+/g, ' ').trim());
    return { has: !!el, cells, first: s.v[40] - s.v[39], next: s.v[41] - s.v[40] };
  });
  ok('the pinned callout renders', pin.has);
  ok('it carries a Δ previous and a Δ next', pin.cells.length === 2,
     JSON.stringify(pin.cells));
  ok('Δ previous names the reading before', /Δ previous/.test(pin.cells[0] || ''),
     pin.cells[0]);
  ok('Δ next names the reading after', /Δ next/.test(pin.cells[1] || ''),
     pin.cells[1]);
  // Each cell says how far apart the two readings are — and "same timestamp"
  // is one of the answers, not a missing one: the demo record carries repeat
  // timestamps, which is the case a rate across the gap must not divide by.
  ok('both say how far apart the two readings are',
     pin.cells.every(c => /(over \d[\d.,]* (s|min|h|d)\b|same timestamp)/.test(c)),
     JSON.stringify(pin.cells));
  ok('a real gap is quoted as a rate per hour, and a zero gap is not',
     pin.cells.every(c => /same timestamp/.test(c) ? !/\/h/.test(c) : /\/h/.test(c)),
     JSON.stringify(pin.cells));

  // The first and last readings have no neighbour on one side, and must say so
  // rather than quoting a number made of whatever was past the end.
  const ends = await page.evaluate(async () => {
    const A = window.ArroData;
    const s = A.ad.series[0];
    const read = async (i) => {
      A.ad.pin = { key: s.key, i };
      switchTab('arro');
      await new Promise(r => setTimeout(r, 30));
      switchTab('arrodata');
      await new Promise(r => setTimeout(r, 140));
      return [...document.querySelectorAll('.ad-pin-grid .ad-delta')]
        .map(d => d.textContent.replace(/\s+/g, ' ').trim());
    };
    return { first: await read(0), last: await read(s.n - 1) };
  });
  ok('the first reading has no previous', /first reading/.test(ends.first[0] || ''),
     JSON.stringify(ends.first));
  ok('the last reading has no next', /last reading/.test(ends.last[1] || ''),
     JSON.stringify(ends.last));

  ok('nothing threw', errors.length === 0, errors.join(' | '));

  await context.close();
} finally {
  await browser.close();
  await server.close();
}

console.log(failures
  ? `\nFAIL — ${failures} check(s) failed.`
  : '\nPASS — the navigator handles answer the pointer where they are drawn, the\n'
    + '       wheel pans sideways and steps evenly, and both the balloon and the\n'
    + '       callout say what the reading did either side of itself.');
process.exit(failures ? 1 : 0);
