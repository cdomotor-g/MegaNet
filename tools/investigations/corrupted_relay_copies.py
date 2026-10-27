#!/usr/bin/env python3
"""Investigation 01 — corrupted relay copies at Billaboo AL and Blackdown
Tableland AL (October 2026). Builds the report page from the two ARRO exports.

    python3 tools/investigations/corrupted_relay_copies.py

Reads   data/investigations/2026-10-corrupted-relay-copies/*.csv and stations.json
Writes  investigations/2026-10-corrupted-relay-copies.html

Standard library only, so it runs anywhere the repo is checked out. Every
number the page quotes about the two stations is computed here from the
exports; the network-wide bit-flip figures are a dated snapshot of
meganet.flip_event (NETWORK below), because that table keeps growing and the
report describes it as it stood on the day.

How a reading is judged
───────────────────────
An accumulator only climbs, so the true count is the longest run of readings
that never goes down, taken in the order they were received (after undoing
Blackdown's one real wrap past 2047). A reading off that run, and outside the
counts either side of it, is a bad copy; one 16 or more counts (3.2 mm) from
the true count is a corrupted copy, and copies of one value received within
3 s of each other are one corrupted transmission. Rows coded MM or MT
(re-entered by hand) and rows received more than ten minutes after their
reading time (re-deliveries of those) are left out.
"""

import bisect
import csv
import html
import json
import math
import os
from collections import Counter
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'data', 'investigations', '2026-10-corrupted-relay-copies')
OUT = os.path.join(ROOT, 'investigations', '2026-10-corrupted-relay-copies.html')
BILLABOO = os.path.join(DATA, 'aem_Billaboo_AL_535082_Rainfall_535082_0_R_5927.csv')
BLACKDOWN = os.path.join(DATA, 'aem_Blackdown_Tableland_AL_35186_Rainfall_35186_0_R_5910.csv')
BLACKDOWN_WRAP = datetime(2026, 10, 23, 8, 56, 10)   # 2047 → 0, every count present
MM_PER_TIP = 0.2
BIG = 16                                             # counts: 3.2 mm

# meganet.flip_event, read 27 October 2026: 4,312 corrupted copies heard by
# Flood-Net's receivers, 7–27 October, 117 transmitters. Per bit, in on-air
# order: how many copies had it 0 and 1, and how many flipped it each way.
NETWORK_EVENTS = 4312
NETWORK_TX = 117
NETWORK = [  # (bit, word, n0, n1, up, down)
    ('A0', 1, 2436, 1876, 208, 287), ('A1', 1, 2226, 2086, 233, 233), ('A2', 1, 2110, 2202, 288, 190),
    ('A3', 1, 1953, 2359, 197, 156), ('A4', 1, 2144, 2168, 232, 149), ('A5', 1, 1748, 2564, 162, 93),
    ('A6', 2, 1432, 2880, 58, 159), ('A7', 2, 1720, 2592, 56, 109), ('A8', 2, 2702, 1610, 88, 100),
    ('A9', 2, 2250, 2062, 75, 85), ('A10', 2, 2251, 2061, 109, 85), ('A11', 2, 1644, 2668, 78, 129),
    ('A12', 3, 2579, 1733, 56, 97), ('D0', 3, 2224, 2088, 15, 22), ('D1', 3, 2271, 2041, 24, 14),
    ('D2', 3, 2192, 2120, 20, 18), ('D3', 3, 2484, 1828, 22, 15), ('D4', 3, 2704, 1608, 24, 24),
    ('D5', 4, 2746, 1566, 74, 42), ('D6', 4, 3077, 1235, 131, 53), ('D7', 4, 2703, 1609, 110, 90),
    ('D8', 4, 3489, 823, 145, 35), ('D9', 4, 3528, 784, 147, 33), ('D10', 4, 3555, 757, 229, 19),
]
# The same snapshot, joined to each burst's measured carrier: how far the
# corrupted copy's carrier sat from the clean copy's, by where the flip was.
CARRIER_GAP_HZ = {1: 46, 2: 14, 3: 6, 4: 9}


# ── Reading the exports ──────────────────────────────────────────────────────

def load(path):
    rows = []
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            rows.append(dict(t=datetime.fromisoformat(r['Reading']), rx=datetime.fromisoformat(r['Receive']),
                             q=r['Data Quality'], raw=int(r['Raw Value'])))
    return rows


def w4_slip(v, k):
    """Value v with its last byte (D5–D10, check bits 1 1, stop 1) read k bits late."""
    bits = [(v >> (5 + i)) & 1 for i in range(6)] + [1] * 8
    return (v & 0x1f) | sum(b << (5 + i) for i, b in enumerate(bits[k:k + 6]))


def classify(raw, lo, hi):
    """What happened to a corrupted copy, against any true count from lo to hi."""
    order = ['one bit forced to 1', 'two bits forced to 1', 'last byte read one bit late',
             'last byte read 2–3 bits late', 'three or more bits forced to 1']
    best = None
    for c in range(lo, hi + 1):
        up, down = raw & ~c, c & ~raw
        lab = None
        if raw == c:
            continue
        if down == 0 and bin(up).count('1') == 1:
            lab = order[0]
        elif down == 0 and bin(up).count('1') == 2:
            lab = order[1]
        elif w4_slip(c, 1) == raw:
            lab = order[2]
        elif w4_slip(c, 2) == raw or w4_slip(c, 3) == raw:
            lab = order[3]
        elif down == 0:
            lab = order[4]
        if lab and (best is None or order.index(lab) < order.index(best)):
            best = lab
    return best or 'something else'


def analyse(rows, wrap=None):
    manual = [r for r in rows if r['q'] in ('MM', 'MT')]
    work = [r for r in rows if r['q'] not in ('MM', 'MT') and (r['rx'] - r['t']).total_seconds() <= 600]
    work.sort(key=lambda r: (r['rx'], r['t']))
    for r in work:
        r['u'] = r['raw'] + 2048 if (wrap and r['rx'] >= wrap and r['raw'] < 1024) else r['raw']

    # The longest run that never goes down: the true count.
    tails, tail_i, prev = [], [], [-1] * len(work)
    for i, r in enumerate(work):
        j = bisect.bisect_right(tails, r['u'])
        if j == len(tails):
            tails.append(r['u']); tail_i.append(i)
        else:
            tails[j] = r['u']; tail_i[j] = i
        prev[i] = tail_i[j - 1] if j > 0 else -1
    keep, k = set(), tail_i[-1]
    while k != -1:
        keep.add(k); k = prev[k]
    ok = [work[i] for i in sorted(keep)]
    ok_rx = [r['rx'] for r in ok]

    def around(rx):
        j = bisect.bisect_right(ok_rx, rx) - 1
        return ok[max(j, 0)]['u'], ok[min(j + 1, len(ok) - 1)]['u']

    bad_rows = []
    for i, r in enumerate(work):
        if i in keep:
            continue
        lo, hi = around(r['rx'])
        if lo - 1 <= r['u'] <= hi + 1:
            continue                                   # in order, just late
        truth = lo % 2048
        if abs(r['raw'] - truth) >= BIG:
            bad_rows.append(dict(r, truth=truth, lo=lo % 2048, hi=hi % 2048))

    tx = []                                            # one per corrupted transmission
    for r in bad_rows:
        if tx and tx[-1]['raw'] == r['raw'] and (r['rx'] - tx[-1]['rx']).total_seconds() <= 3:
            tx[-1]['copies'] += 1
            continue
        tx.append(dict(r, copies=1))
    for c in tx:
        best = None
        for o in ok:
            d = (c['rx'] - o['rx']).total_seconds()
            if 0 <= d <= 4 and abs(o['u'] % 2048 - c['truth']) <= 1:
                best = d if best is None else min(best, d)
        c['after'] = best
        lo, hi = (c['lo'], c['hi']) if c['lo'] <= c['hi'] else (c['lo'], c['lo'])
        c['kind'] = classify(c['raw'], max(0, lo - 1), min(2047, hi + 1))

    # Transmissions the gauge made (clean copies more than 3 s apart), by the
    # rain in the hour before, against the corrupted ones in the same bands.
    def band(rx):
        j0 = bisect.bisect_left(ok_rx, rx - timedelta(hours=1))
        tips = around(rx)[0] - ok[j0]['u']
        return 'heavy' if tips >= 10 else ('light' if tips >= 1 else 'dry')
    sent, last = Counter(), None
    for r in ok:
        if last is None or (r['rx'] - last).total_seconds() > 3:
            sent[band(r['rx'])] += 1
        last = r['rx']
    hit = Counter(band(c['rx']) for c in tx)

    return dict(rows=rows, work=work, ok=ok, bad_rows=bad_rows, tx=tx, manual=manual, sent=sent, hit=hit,
                codes=Counter(r['q'] for r in bad_rows))


# ── Drawing ──────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s), quote=True)


def fmt(n):
    return f'{n:,}'


def when(t):
    return t.strftime('%a %d %b %H:%M:%S').replace(' 0', ' ')


def x_mark(x, y, cls, title, r=4.2):
    d = f'M{x - r:.1f} {y - r:.1f}L{x + r:.1f} {y + r:.1f}M{x - r:.1f} {y + r:.1f}L{x + r:.1f} {y - r:.1f}'
    return (f'<g><title>{esc(title)}</title><path class="ring" d="{d}"/>'
            f'<path class="{cls}" d="{d}"/><circle class="hit" cx="{x:.1f}" cy="{y:.1f}" r="7"/></g>')


def tri_mark(x, y, cls, title, r=4.6):
    d = f'M{x:.1f} {y - r:.1f}L{x + r:.1f} {y + r * 0.8:.1f}L{x - r:.1f} {y + r * 0.8:.1f}Z'
    return (f'<g><title>{esc(title)}</title><path class="ring-fill" d="{d}"/>'
            f'<path class="{cls}" d="{d}"/><circle class="hit" cx="{x:.1f}" cy="{y:.1f}" r="7"/></g>')


def week_chart(a, label, start, end, marks, notes=(), legend=(), h=168):
    """A week of an accumulator in mm: the true count as a line (broken where
    it wraps), corrupted copies as marks. `marks` is [(transmission, kind)]."""
    W, L, R, T, B = 720, 46, 10, 24, 22
    pw, ph = W - L - R, h - T - B
    span = (end - start).total_seconds()
    X = lambda t: L + pw * (t - start).total_seconds() / span
    Y = lambda mm: T + ph * (1 - mm / 420)
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="{esc(label)}">']
    for mm in range(0, 421, 100):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(mm):.1f}" y2="{Y(mm):.1f}"/>'
                   f'<text class="tick" x="{L - 6}" y="{Y(mm) + 3.5:.1f}" text-anchor="end">{mm}</text>')
    out.append(f'<text class="tick" x="{L - 6}" y="{T - 12}" text-anchor="end">mm</text>')
    d = start.replace(hour=0, minute=0, second=0) + timedelta(days=1)
    while d < end:
        out.append(f'<line class="grid" x1="{X(d):.1f}" x2="{X(d):.1f}" y1="{T}" y2="{T + ph}"/>'
                   f'<text class="tick" x="{X(d) + 3:.1f}" y="{T + ph + 14}">{d.strftime("%a %d").replace(" 0", " ")}</text>')
        d += timedelta(days=1)
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{T + ph}" y2="{T + ph}"/>')
    pts, segs, prev = [], [], None
    for r in a['ok']:
        if prev is not None and r['u'] % 2048 < prev % 2048:
            segs.append(pts); pts = []
        pts.append(f'{X(r["rx"]):.1f},{Y(r["u"] % 2048 * MM_PER_TIP):.1f}')
        prev = r['u']
    segs.append(pts)
    for s in segs:
        out.append(f'<polyline class="line" points="{" ".join(s)}"/>')
    for c, kind in marks:
        x, y = X(c['rx']), Y(c['raw'] * MM_PER_TIP)
        title = (f'{when(c["rx"])} — {c["raw"] * MM_PER_TIP:.1f} mm ({fmt(c["raw"])} tips) against a true '
                 f'{c["truth"] * MM_PER_TIP:.1f} mm ({fmt(c["truth"])}); {c["kind"]}')
        out.append(x_mark(x, y, 'mark-x', title) if kind == 'x' else tri_mark(x, y, 'mark-tri', title))
    for (t, mm, text, anchor, dx, dy) in notes:
        x, y = X(t), Y(mm)
        out.append(f'<line class="leader" x1="{x:.1f}" y1="{y:.1f}" x2="{x + dx:.1f}" y2="{y + dy:.1f}"/>'
                   f'<text class="note" x="{x + dx + (3 if anchor == "start" else -3):.1f}" y="{y + dy + 3.5:.1f}" '
                   f'text-anchor="{anchor}">{esc(text)}</text>')
    lx = L + 8
    for kind, text in legend:
        if kind == 'line':
            out.append(f'<line class="line" x1="{lx}" x2="{lx + 16}" y1="9" y2="9"/>')
        elif kind == 'x':
            out.append(x_mark(lx + 8, 9, 'mark-x', text))
        else:
            out.append(tri_mark(lx + 8, 9, 'mark-tri', text))
        out.append(f'<text class="key" x="{lx + 22}" y="12.5">{esc(text)}</text>')
        lx += 30 + len(text) * 5.6
    out.append('</svg>')
    return '\n'.join(out)


def column_chart(cats, label, w=250, h=150, ymax=None, caption_y='transmissions'):
    L, R, T, B = 30, 6, 18, 30
    pw, ph = w - L - R, h - T - B
    ymax = ymax or max(v for _, v in cats)
    step = 10 if ymax <= 60 else 50
    top = math.ceil(ymax / step) * step
    Y = lambda v: T + ph * (1 - v / top)
    out = [f'<svg class="fig" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(label)}">']
    for v in range(0, top + 1, step):
        out.append(f'<line class="grid" x1="{L}" x2="{w - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 8}">{esc(caption_y)}</text>')
    slot = pw / len(cats)
    bw = min(24, slot * 0.55)
    for i, (name, v) in enumerate(cats):
        cx = L + slot * (i + 0.5)
        y0, y1 = Y(0), Y(v)
        r = min(4, (y0 - y1) / 2)
        d = (f'M{cx - bw / 2:.1f} {y0:.1f}V{y1 + r:.1f}Q{cx - bw / 2:.1f} {y1:.1f} {cx - bw / 2 + r:.1f} {y1:.1f}'
             f'H{cx + bw / 2 - r:.1f}Q{cx + bw / 2:.1f} {y1:.1f} {cx + bw / 2:.1f} {y1 + r:.1f}V{y0:.1f}Z')
        out.append(f'<g><title>{esc(name)}: {v}</title><path class="bar" d="{d}"/></g>'
                   f'<text class="val" x="{cx:.1f}" y="{y1 - 4:.1f}" text-anchor="middle">{v}</text>')
        for k, part in enumerate(name.split('\n')):
            out.append(f'<text class="tick" x="{cx:.1f}" y="{y0 + 12 + k * 10:.1f}" text-anchor="middle">{esc(part)}</text>')
    out.append(f'<line class="axis" x1="{L}" x2="{w - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/></svg>')
    return '\n'.join(out)


def frame_diagram():
    """The four 10-bit words of an ALERT Binary frame, and the last one of
    1,346 read one bit late."""
    W, h, cw, gap, x0, y0 = 720, 150, 16, 12, 30, 28
    words = [
        ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'K1', 'K0'],
        ['A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'K1', 'K0'],
        ['A12', 'D0', 'D1', 'D2', 'D3', 'D4', 'K1', 'K1'],
        ['D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'K1', 'K1'],
    ]
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="The ALERT Binary frame: four '
           'ten-bit words, and the last word of 1,346 read one bit late, which decodes as 1,698">']
    wx = []
    for w, cells in enumerate(words):
        bx = x0 + w * (10 * cw + gap)
        wx.append(bx)
        out.append(f'<text class="key" x="{bx + 5 * cw:.1f}" y="12" text-anchor="middle">Byte {w + 1}</text>')
        seq = [('S', 'frame', '0')] + [(c, 'check' if c.startswith('K') else ('addr' if c[0] == 'A' else 'val'),
                                        c[1] if c.startswith('K') else '') for c in cells] + [('P', 'frame', '1')]
        for i, (name, cls, val) in enumerate(seq):
            x = bx + i * cw
            out.append(f'<rect class="cell {cls}" x="{x + 0.5}" y="{y0}" width="{cw - 1}" height="22" rx="2"/>')
            if val:
                out.append(f'<text class="bit" x="{x + cw / 2:.1f}" y="{y0 + 15}" text-anchor="middle">{val}</text>')
            else:
                out.append(f'<text class="cellname" x="{x + cw / 2:.1f}" y="{y0 + 14}" text-anchor="middle">'
                           f'{esc(name)}</text>')
        ends = 'ends 1 0: a slip or a run of 1s' if w < 2 else 'ends 1 1: a slip or a run of 1s'
        verdict = 'breaks it, frame dropped' if w < 2 else 'passes unnoticed'
        out.append(f'<text class="note" x="{bx + 5 * cw:.1f}" y="{y0 + 34}" text-anchor="middle">{ends}</text>'
                   f'<text class="note {"" if w < 2 else "strong"}" x="{bx + 5 * cw:.1f}" y="{y0 + 45}" '
                   f'text-anchor="middle">{verdict}</text>')
    # The example, under byte 4: 1,346 as sent, then read one bit late.
    sent = [0] + [(1346 >> (5 + i)) & 1 for i in range(6)] + [1, 1, 1]
    late = [0] + sent[2:] + [1]
    bx = wx[3]
    for row, (bits, text, y) in enumerate([(sent, '1,346 (269.2 mm) as sent', 90), (late, 'read one bit late: 1,698 (339.6 mm)', 122)]):
        out.append(f'<text class="key" x="{bx - 8}" y="{y + 15}" text-anchor="end">{esc(text)}</text>')
        for i, b in enumerate(bits):
            x = bx + i * cw
            changed = row == 1 and 1 <= i <= 6 and b != sent[i]
            out.append(f'<rect class="cell {"changed" if changed else ("frame" if i in (0, 9) else ("check" if i in (7, 8) else "val"))}" '
                       f'x="{x + 0.5}" y="{y}" width="{cw - 1}" height="22" rx="2"/>'
                       f'<text class="bit" x="{x + cw / 2:.1f}" y="{y + 15}" text-anchor="middle">{b}</text>')
        if row == 0:
            for i in range(2, 10):
                out.append(f'<line class="leader" x1="{bx + i * cw + cw / 2:.1f}" y1="{y + 23}" '
                           f'x2="{bx + (i - 1) * cw + cw / 2:.1f}" y2="{y + 31}"/>')
    # Legend for the cell fills, under bytes 1–3.
    lx, ly = x0, 98
    for cls, text in [('addr', 'address bit'), ('val', 'value bit'), ('check', 'fixed check bit'),
                      ('frame', 'start / stop'), ('changed', 'changed by the late read')]:
        out.append(f'<rect class="cell {cls}" x="{lx}" y="{ly}" width="12" height="12" rx="2"/>'
                   f'<text class="key" x="{lx + 17}" y="{ly + 10}">{text}</text>')
        lx += 26 + len(text) * 5.4
        if lx > 300:
            lx, ly = x0, ly + 20
    out.append('</svg>')
    return '\n'.join(out)


def network_chart():
    W, h, L, R, T, B = 720, 150, 40, 8, 30, 20
    pw, ph = W - L - R, h - T - B
    rates = [(b, w, 1000 * (up + dn) / NETWORK_EVENTS, up, dn, n0, n1) for b, w, n0, n1, up, dn in NETWORK]
    top = 120
    Y = lambda v: T + ph * (1 - v / top)
    gap = 10
    slot = (pw - 3 * gap) / len(rates)
    bw = min(20, slot * 0.7)
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Corrupted copies per thousand that '
           'changed each bit of the frame, in the order the bits go on the air">']
    for v in range(0, top + 1, 40):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 24}">per 1,000 copies</text>')
    names = {1: 'Byte 1 · address, low bits', 2: 'Byte 2 · address, high bits', 3: 'Byte 3 · A12 + value, low bits',
             4: 'Byte 4 · value, high bits'}
    x, starts = L, {}
    for i, (b, w, rate, up, dn, n0, n1) in enumerate(rates):
        if i and rates[i - 1][1] != w:
            x += gap
        starts.setdefault(w, x)
        cx = x + slot / 2
        y0, y1 = Y(0), Y(rate)
        r = min(4, (y0 - y1) / 2)
        d = (f'M{cx - bw / 2:.1f} {y0:.1f}V{y1 + r:.1f}Q{cx - bw / 2:.1f} {y1:.1f} {cx - bw / 2 + r:.1f} {y1:.1f}'
             f'H{cx + bw / 2 - r:.1f}Q{cx + bw / 2:.1f} {y1:.1f} {cx + bw / 2:.1f} {y1 + r:.1f}V{y0:.1f}Z')
        title = (f'{b}: {rate:.0f} per 1,000 copies; 0→1 {1000 * up / n0:.0f} per 1,000 zeros, '
                 f'1→0 {1000 * dn / n1:.0f} per 1,000 ones')
        out.append(f'<g><title>{esc(title)}</title><path class="bar" d="{d}"/></g>'
                   f'<text class="tick" x="{cx:.1f}" y="{y0 + 12}" text-anchor="middle">{b}</text>')
        x += slot
        if b == 'D10':
            out.append(f'<line class="leader" x1="{cx:.1f}" y1="{y1 - 3:.1f}" x2="{cx - 30:.1f}" y2="{Y(100):.1f}"/>'
                       f'<text class="note" x="{cx - 33:.1f}" y="{Y(100) - 2:.1f}" text-anchor="end">top bit: 0→1 '
                       f'{(up / n0) / (dn / n1):.1f}× as often as 1→0</text>')
    for w in (1, 2, 3, 4):
        end = starts[w + 1] - gap if w < 4 else W - R
        out.append(f'<line class="band" x1="{starts[w] + 2:.1f}" x2="{end - 2:.1f}" y1="{T - 8}" y2="{T - 8}"/>'
                   f'<text class="key" x="{(starts[w] + end) / 2:.1f}" y="{T - 13}" text-anchor="middle">{names[w]}</text>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/></svg>')
    return '\n'.join(out)


def relay_map(stations):
    names = ['Billaboo AL', 'Mt Mayde AL', 'Emerald Radar AL', 'Roddas Lookout AL', 'Blackdown Tableland AL']
    st = {s['name']: s for s in stations if s.get('name') in names}
    lat0 = sum(st[n]['lat'] for n in names) / len(names)
    kx = 111.32 * math.cos(math.radians(lat0))
    km = {n: ((st[n]['lon'] - 147.25) * kx, (st[n]['lat'] - -23.45) * -110.57) for n in names}
    W, h, pad = 340, 172, 20
    maxx = max(p[0] for p in km.values()); maxy = max(p[1] for p in km.values())
    s = min((W - 2 * pad) / maxx, (h - 2 * pad - 14) / maxy)
    P = {n: (pad + km[n][0] * s, pad + km[n][1] * s) for n in names}
    rain = {n: (st[n].get('alert_ids') or {}).get('rainfall') for n in names}

    def passes(rep, sid):
        return any(p['low'] <= sid <= p['high'] for p in ((st[rep].get('repeater') or {}).get('pass_ranges') or []))
    edges = []
    for src in ('Billaboo AL', 'Blackdown Tableland AL', 'Mt Mayde AL', 'Roddas Lookout AL'):
        for rep in ('Mt Mayde AL', 'Emerald Radar AL', 'Roddas Lookout AL'):
            if rep != src and rain[src] and passes(rep, rain[src]):
                edges.append((src, rep))
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="The two stations and the repeaters '
           'whose pass ranges carry them; Emerald Radar is the only one both share">']
    for a, b in edges:
        (x1, y1), (x2, y2) = P[a], P[b]
        out.append(f'<line class="link{" shared" if b == "Emerald Radar AL" else ""}" x1="{x1:.1f}" y1="{y1:.1f}" '
                   f'x2="{x2:.1f}" y2="{y2:.1f}"><title>{esc(b)} passes {esc(a)} ({rain[a]})</title></line>')
    label_at = {'Billaboo AL': (-4, -10, 'start'), 'Mt Mayde AL': (2, 17, 'start'),
                'Emerald Radar AL': (0, -14, 'middle'), 'Roddas Lookout AL': (9, 4, 'start'),
                'Blackdown Tableland AL': (0, -21, 'middle')}
    for n in names:
        x, y = P[n]
        dx, dy, anchor = label_at[n]
        if n in ('Billaboo AL', 'Blackdown Tableland AL'):
            out.append(f'<circle class="stn" cx="{x:.1f}" cy="{y:.1f}" r="5"><title>{esc(n)} — rain {rain[n]}</title></circle>')
        else:
            cls = 'rep shared' if n == 'Emerald Radar AL' else 'rep'
            out.append(f'<rect class="{cls}" x="{x - 5:.1f}" y="{y - 5:.1f}" width="10" height="10" rx="2">'
                       f'<title>{esc(n)} — repeater</title></rect>')
        text = 'Emerald Radar: on both paths' if n == 'Emerald Radar AL' else n.replace(' AL', '')
        lines = text.split(' ', 1) if n == 'Blackdown Tableland AL' else [text]
        spans = ''.join(f'<tspan x="{x + dx:.1f}" dy="{0 if i == 0 else 10.5}">{esc(t)}</tspan>' for i, t in enumerate(lines))
        out.append(f'<text class="key{" strong" if n == "Emerald Radar AL" else ""}" x="{x + dx:.1f}" y="{y + dy:.1f}" '
                   f'text-anchor="{anchor}">{spans}</text>')
    sb = 50 * s
    out.append(f'<line class="axis" x1="{pad}" x2="{pad + sb:.1f}" y1="{h - 10}" y2="{h - 10}"/>'
               f'<text class="tick" x="{pad + sb + 5:.1f}" y="{h - 7}">50 km</text>')
    out.append('</svg>')
    return '\n'.join(out)


# ── The page ─────────────────────────────────────────────────────────────────

def main():
    stations = json.load(open(os.path.join(ROOT, 'stations.json')))
    stations = next(v for v in stations.values() if isinstance(v, list) and v and 'alert_ids' in v[0])
    bil = analyse(load(BILLABOO))
    bld = analyse(load(BLACKDOWN), wrap=BLACKDOWN_WRAP)

    btx = bil['tx']
    n_b = len(btx)
    b_after = Counter(c['after'] for c in btx)
    b_clean_before = sum(v for k, v in b_after.items() if k is not None)
    b_up = sum(1 for c in btx if c['raw'] > c['truth'])
    b_kind = Counter(c['kind'] for c in btx)
    rate = {k: (bil['hit'][k], bil['sent'][k]) for k in ('heavy', 'light', 'dry')}
    pct = lambda k: round(100 * rate[k][0] / rate[k][1])

    dtx = bld['tx']
    n_d = len(dtx)
    d_clean_before = sum(1 for c in dtx if c['after'] is not None)
    pre = [c for c in dtx if c['rx'] < BLACKDOWN_WRAP]
    post = [c for c in dtx if c['rx'] >= BLACKDOWN_WRAP]
    top_pre = sum(1 for c in pre if (c['raw'] ^ c['truth']) & 1024)
    top_post = sum(1 for c in post if (c['raw'] ^ c['truth']) & 1024)
    flagged = all(r['q'] in ('DD', 'PD', 'ND', 'AN') for r in bil['bad_rows'] + bld['bad_rows'])
    d10 = next(r for r in NETWORK if r[0] == 'D10')
    d10_ratio = (d10[4] / d10[2]) / (d10[5] / d10[3])
    rows_total = len(bil['rows']) + len(bld['rows'])

    for name, a in (('Billaboo', bil), ('Blackdown', bld)):
        print(f'{name}: {len(a["rows"])} rows, {len(a["tx"])} corrupted transmissions '
              f'({len(a["bad_rows"])} rows), codes {dict(a["codes"])}')
    print(f'Billaboo: after a clean copy {dict(b_after)}, above {b_up}/{n_b}, kinds {dict(b_kind)}, rates {rate}')
    print(f'Blackdown: clean before {d_clean_before}/{n_d}; top bit {top_pre}/{len(pre)} before the wrap, '
          f'{top_post}/{len(post)} after; all flagged DD/PD/ND/AN: {flagged}')

    start, end = datetime(2026, 10, 20, 16), datetime(2026, 10, 27, 15)
    ex = next(c for c in btx if c['raw'] == 1698)
    fig1 = week_chart(bil, 'Billaboo AL rainfall, 20 to 27 October: the true count as a line and every corrupted '
                      'copy as a cross', start, end, [(c, 'x') for c in btx],
                      notes=[(ex['rx'], ex['raw'] * MM_PER_TIP, '1,698 a second after a clean 1,346', 'end', -22, 62)],
                      legend=[('line', 'true count'), ('x', 'corrupted copy')])
    fig2 = column_chart([('same\nsecond', b_after[0.0]), ('+1 s', b_after[1.0]), ('+2 s', b_after[2.0]),
                         ('no clean\ncopy', b_after[None])],
                        'Seconds between the clean copy and the corrupted one, Billaboo')
    fig3 = frame_diagram()
    wrap_row = next(r for r in bld['ok'] if r['rx'] >= BLACKDOWN_WRAP)
    top_ex = next(c for c in post if c['raw'] == 1618)
    fig4 = week_chart(bld, 'Blackdown Tableland AL rainfall, 20 to 27 October: the true count wrapping past '
                      '409.4 mm, and its corrupted copies', start, end,
                      [(c, 'x' if (c['raw'] ^ c['truth']) & 1024 else 'tri') for c in dtx],
                      notes=[(wrap_row['rx'], 40, 'real wrap: 2,047 → 0, every count present', 'end', -10, 0),
                             (top_ex['rx'], top_ex['raw'] * MM_PER_TIP, 'true 594, read as 1,618', 'end', -16, 34)],
                      legend=[('line', 'true count'), ('x', 'top bit forced to 1 (+204.8 mm)'),
                              ('tri', 'other corrupted copy')], h=156)
    fig5 = network_chart()
    fig6 = relay_map(stations)

    page = TEMPLATE
    for k, v in dict(
        FIG1=fig1, FIG2=fig2, FIG3=fig3, FIG4=fig4, FIG5=fig5, FIG6=fig6,
        ROWS=fmt(rows_total), NB=n_b, NB_CLEAN=b_clean_before, NB_PLUS1=b_after[1.0], NB_UP=b_up,
        K1=b_kind['one bit forced to 1'], K2=b_kind['two bits forced to 1'],
        KSLIP=b_kind['last byte read one bit late'] + b_kind['last byte read 2–3 bits late'],
        KSLIP1=b_kind['last byte read one bit late'],
        PCT_HEAVY=pct('heavy'), PCT_LIGHT=pct('light'), PCT_DRY=pct('dry'),
        HIT_HEAVY=rate['heavy'][0], SENT_HEAVY=rate['heavy'][1], HIT_DRY=rate['dry'][0], SENT_DRY=rate['dry'][1],
        ND=n_d, ND_CLEAN=d_clean_before, PRE=len(pre), POST=len(post), TOP_PRE=top_pre, TOP_POST=top_post,
        NEV=fmt(NETWORK_EVENTS), NTX=NETWORK_TX, D10=f'{d10_ratio:.1f}',
        GAP1=CARRIER_GAP_HZ[1], GAP_LO=min(CARRIER_GAP_HZ[w] for w in (2, 3, 4)),
        GAP_HI=max(CARRIER_GAP_HZ[w] for w in (2, 3, 4)),
        MANUAL=len([r for r in bil['manual'] if r['q'] == 'MM']),
        FLAGGED='every one of them' if flagged else 'most of them',
    ).items():
        page = page.replace('{{' + k + '}}', str(v))
    assert '{{' not in page, page[page.index('{{'):page.index('{{') + 40]
    with open(OUT, 'w') as f:
        f.write(page)
    print('wrote', os.path.relpath(OUT, ROOT))


TEMPLATE = r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Corrupted relay copies — Flood-Net investigation 01</title>
  <meta name="description" content="Why corrupted copies of rainfall readings climb above the true line at Billaboo AL and Blackdown Tableland AL: relayed ALERT frames damaged at the end, where the check bits cannot see it.">
  <link rel="canonical" href="https://floodwarning.net/investigations/2026-10-corrupted-relay-copies">
  <link rel="icon" type="image/svg+xml" href="../assets/icon-small.svg">
  <!-- Generated by tools/investigations/corrupted_relay_copies.py from the two
       exports in data/investigations/2026-10-corrupted-relay-copies/: edit the
       script and run it again rather than this file. Self-contained like
       about.html: no script, no font, no stylesheet to fetch; two A4 pages
       printed. No ?v= stamp: sw.js keeps none of this, and the icon is the
       only thing it loads. -->
  <style>
    :root {
      color-scheme: light;
      --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --bg: #ffffff; --panel: #f6f7f8;
      --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab;
      --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;
      --addr: rgba(42,120,214,.16); --val: rgba(235,104,52,.16); --check: #f1d48a; --frame: #e4e3dd;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
        --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
        --s1: #3987e5; --s2: #d95926; --s3: #199e70;
        --addr: rgba(57,135,229,.24); --val: rgba(217,89,38,.24); --check: #6b5a22; --frame: #2c2c2a;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
      --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
      --s1: #3987e5; --s2: #d95926; --s3: #199e70;
      --addr: rgba(57,135,229,.24); --val: rgba(217,89,38,.24); --check: #6b5a22; --frame: #2c2c2a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1.5rem 16px 3rem; background: var(--bg); color: var(--ink);
           font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    main { max-width: 760px; margin: 0 auto; }
    a { color: var(--brand); }
    .crumb { font-size: 12.5px; color: var(--ink-2); margin: 0 0 .4rem; }
    h1 { font-size: 22px; line-height: 1.25; margin: 0 0 .35rem; }
    h2 { font-size: 15px; margin: 1.1rem 0 .3rem; color: var(--brand); }
    p { margin: .35rem 0; }
    .meta { color: var(--ink-2); font-size: 12.5px; margin: 0 0 .7rem; }
    .pill { display: inline-block; padding: 0 .5rem; border-radius: 999px; border: 1px solid var(--axis);
            font-size: 11.5px; color: var(--ink-2); }
    .tldr { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--brand);
            border-radius: 4px; padding: .55rem .9rem; margin: .5rem 0 .6rem; }
    .tldr ul { margin: .2rem 0; padding-left: 1.1rem; }
    .tldr li { margin: .2rem 0; }
    figure { margin: .4rem 0 .5rem; }
    figcaption { font-size: 12px; color: var(--ink-2); margin-top: .15rem; }
    /* On a phone the wide charts keep a legible size and scroll sideways on
       their own; the page itself never does. */
    .scroll { overflow-x: auto; }
    @media (max-width: 620px) { .scroll svg.fig { min-width: 560px; } }
    .row { display: grid; grid-template-columns: 250px 1fr; gap: 1rem; align-items: start; }
    .row.map { grid-template-columns: 1fr 340px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
    @media (max-width: 620px) { .row, .row.map, .two { grid-template-columns: 1fr; } }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: .3rem 0; }
    th, td { text-align: left; vertical-align: top; padding: .25rem .4rem; border-top: 1px solid var(--line); }
    th { color: var(--ink-2); font-weight: 600; white-space: nowrap; }
    ol { margin: .25rem 0; padding-left: 1.2rem; }
    li { margin: .15rem 0; }
    .small { font-size: 11.5px; color: var(--ink-2); }
    footer { margin-top: .8rem; padding-top: .5rem; border-top: 1px solid var(--line); }
    svg.fig { width: 100%; height: auto; display: block; overflow: visible;
              font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .grid { stroke: var(--line); stroke-width: 1; }
    .axis { stroke: var(--axis); stroke-width: 1; }
    .tick { fill: var(--muted); font-size: 9.5px; font-variant-numeric: tabular-nums; }
    .key { fill: var(--ink-2); font-size: 10.5px; }
    .key.strong, .note.strong { fill: var(--ink); font-weight: 600; }
    .note { fill: var(--ink-2); font-size: 10px; }
    .val { fill: var(--ink); font-size: 10px; font-weight: 600; }
    .leader { stroke: var(--muted); stroke-width: 1; }
    .line { fill: none; stroke: var(--s1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .ring { fill: none; stroke: var(--bg); stroke-width: 5; stroke-linecap: round; }
    .ring-fill { fill: var(--bg); stroke: var(--bg); stroke-width: 4; stroke-linejoin: round; }
    .mark-x { fill: none; stroke: var(--s2); stroke-width: 2; stroke-linecap: round; }
    .mark-tri { fill: var(--s3); }
    .hit { fill: transparent; }
    .bar { fill: var(--s1); }
    .band { stroke: var(--axis); stroke-width: 1; }
    .cell { stroke: none; }
    .cell.addr { fill: var(--addr); } .cell.val { fill: var(--val); } .cell.check { fill: var(--check); }
    .cell.frame { fill: var(--frame); } .cell.changed { fill: var(--s2); }
    .bit { fill: var(--ink); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .cellname { fill: var(--ink-2); font-size: 7.5px; }
    .link { stroke: var(--axis); stroke-width: 1.5; }
    .link.shared { stroke: var(--s2); stroke-width: 2; }
    .stn { fill: var(--s1); stroke: var(--bg); stroke-width: 2; }
    .rep { fill: var(--ink-2); stroke: var(--bg); stroke-width: 2; }
    .rep.shared { fill: var(--s2); }
    .sheet + .sheet { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    @page { size: A4; margin: 9mm 10mm; }
    @media print {
      :root { color-scheme: light; --ink: #0b0b0b; --ink-2: #52514e; --bg: #ffffff; --panel: #f6f7f8;
              --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab; --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;
              --addr: rgba(42,120,214,.16); --val: rgba(235,104,52,.16); --check: #f1d48a; --frame: #e4e3dd; }
      body { padding: 0; font-size: 8.9pt; line-height: 1.36; }
      h1 { font-size: 15pt; }
      h2 { font-size: 10.5pt; margin: .55rem 0 .15rem; }
      p { margin: .2rem 0; }
      figure { margin: .25rem 0 .3rem; }
      figcaption { font-size: 8pt; }
      .tldr { padding: .35rem .7rem; margin: .35rem 0 .3rem; }
      .tldr li { margin: .1rem 0; }
      .meta { margin-bottom: .3rem; }
      .small { font-size: 7.6pt; }
      footer { margin-top: .4rem; padding-top: .3rem; }
      main { max-width: none; }
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }
      .sheet + .sheet { margin-top: 0; padding-top: 0; border-top: 0; }
      figure, table, .tldr { break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
      .crumb { display: none; }
      .row { grid-template-columns: 210px 1fr; }
      .row.map { grid-template-columns: 1fr 290px; }
    }
  </style>
</head>
<body>
<main>
<section class="sheet">
  <p class="crumb"><a href="./">Investigations</a> · <a href="../">Flood-Net</a></p>
  <h1>Climbing red crosses: corrupted relay copies at Billaboo and Blackdown Tableland</h1>
  <p class="meta">Investigation 01 · 27 October 2026 · Billaboo AL (535082, rain 5927) and Blackdown Tableland AL
    (35186, rain 5910), Emerald network · <span class="pill">Open: cause narrowed, not confirmed</span></p>

  <div class="tldr">
    <ul>
      <li><strong>The crosses above the line aren't rain.</strong> Each is a second copy of a real report, damaged as
        it was relayed. It arrives about a second after a clean copy, with the right count but some upper bits
        changed.</li>
      <li><strong>Old ALERT frames have no checksum.</strong> Their few fixed check bits catch damage at the start of a
        frame but not at the end, where the value's top bits travel. So the damage gets through, and almost always
        reads high.</li>
      <li><strong>Blackdown Tableland's odd reset is a real wrap plus the same fault.</strong> Once the counter
        restarted from 0, its top bit could be forced to 1, which put copies 204.8 mm above the line.</li>
      <li><strong>Emerald Radar AL is the first place to look:</strong> it's the only repeater both stations go
        through. Not proven, because Flood-Net's receivers don't hear this network.</li>
    </ul>
  </div>

  <h2>A clean copy, then a corrupted one a second later</h2>
  <figure>
    <div class="scroll">{{FIG1}}</div>
    <figcaption>Figure 1. Billaboo AL, 20–27 October. The line is the true count; each cross is one corrupted
      transmission, usually received as two or more rows. {{NB_UP}} of the {{NB}} sit above the line. Hover a cross
      for its values.</figcaption>
  </figure>
  <div class="row">
    <figure>
      {{FIG2}}
      <figcaption>Figure 2. When each corrupted copy arrived, after a clean copy of the same count.</figcaption>
    </figure>
    <div>
      <p>{{NB_CLEAN}} of the {{NB}} corrupted transmissions arrived within two seconds of a clean copy of the same
        count, {{NB_PLUS1}} of them exactly one second after: about one store-and-forward relay hop. Both receive paths
        in the export got the same wrong value at the same moment, so the damage happened before they split.</p>
      <p>Rain multiplies it but doesn't cause it. About the same share of transmissions came back corrupted in heavy
        rain ({{PCT_HEAVY}}%, {{HIT_HEAVY}} of {{SENT_HEAVY}}), light rain ({{PCT_LIGHT}}%) and the dry three-hourly
        reports ({{PCT_DRY}}%, {{HIT_DRY}} of {{SENT_DRY}}). The crosses bunch in storms because the gauge transmits
        on every tip.</p>
    </div>
  </div>

  <h2>Why the damage gets through, and nearly always upward</h2>
  <figure>
    <div class="scroll">{{FIG3}}</div>
    <figcaption>Figure 3. An ALERT Binary frame is four bytes, each sent lowest bit first between a start bit (0) and
      a stop bit (1). Bytes 1–2 end in check bits <b>1 0</b>; bytes 3–4 end in <b>1 1</b>, followed by a stop bit
      and an idle line that are also 1. Read late, byte 4 shifts every value bit along by one and takes in a 1, and
      nothing checks it.</figcaption>
  </figure>
  <p>Of Billaboo's {{NB}}, {{K1}} had one bit forced from 0 to 1 and {{K2}} had two. {{KSLIP}} were the last byte
    read late, {{KSLIP1}} of them by exactly one bit (1,346 became 1,698 three times in twelve minutes on 24 October).
    Damage early in a frame breaks a <b>1 0</b> check, and the frame is dropped; a changed address files the reading
    under another sensor. So what reaches this sensor was damaged at the end, and it reads high.</p>
</section>

<section class="sheet">
  <h2>Blackdown Tableland: a real wrap, then +1,024 copies</h2>
  <figure>
    <div class="scroll">{{FIG4}}</div>
    <figcaption>Figure 4. Blackdown Tableland AL, 20–27 October. The wrap on 23 October is real: every count up to
      2,047, then 0, 1, 2 …, arrived in order on both paths, graded A.</figcaption>
  </figure>
  <p>{{ND_CLEAN}} of its {{ND}} corrupted transmissions arrived within two seconds of a clean copy, as at Billaboo.
    Before the wrap the count was over 1,024, so its top bit was already 1 and couldn't be forced: {{TOP_PRE}} of
    {{PRE}} corrupted copies changed it. After the wrap the top bit was 0, and {{TOP_POST}} of {{POST}} were exactly
    that bit forced to 1, which put copies like 594 → 1,618 back near the old level.</p>

  <h2>Across the network: errors bunch at the ends of the frame</h2>
  <figure>
    <div class="scroll">{{FIG5}}</div>
    <figcaption>Figure 5. {{NEV}} corrupted copies heard by Flood-Net's own receivers in south-east Queensland,
      7–27 October, from {{NTX}} transmitters: how often each bit changed, in the order the bits go on the air. Small
      changes to low value bits are under-counted, because a reading a few counts out can pass for a real one.</figcaption>
  </figure>
  <p>The first and last bytes are hit hardest, which points to timing as a transmission starts and ends rather than
    to one faulty data line. D5–D9 flip up and down equally, so nothing is stuck high. Only the top bit goes 0→1
    {{D10}}× as often as 1→0, as a late read predicts: it hands that bit the check bit after it, which is always 1.
    Start-of-frame errors fit a frequency synthesiser (PLL) that hasn't settled. That could be a transmitter keying
    up too fast: those copies came in on carriers {{GAP1}} Hz from the clean copy's, against {{GAP_LO}}–{{GAP_HI}} Hz
    elsewhere. Or it could be our own decoder's bit-timing loop still locking during a short preamble.</p>

  <div class="row map">
    <div>
      <h2>Where it enters</h2>
      <p>Billaboo is relayed by Mt Mayde (15 km away) and Emerald Radar (94 km); Blackdown Tableland by Roddas Lookout
        and Emerald Radar, all on 151.5 MHz. At both stations the corrupted copy is one hop behind the clean one, and
        Emerald Radar is the only repeater on both paths. Both exports also share one receive path's slow, drifting
        clock, so they reach the Bureau through the same base station.</p>
      <p>That narrows it without convicting anyone: Flood-Net's receivers don't hear this network, so carrier
        fingerprints can't name the sender.</p>
    </div>
    <figure>
      {{FIG6}}
      <figcaption>Figure 6. Stations (circles) joined to the repeaters (squares) whose pass ranges include their
        address.</figcaption>
    </figure>
  </div>

  <div class="two">
    <div>
      <h2>What we know</h2>
      <p><b>Established.</b> These are corrupted relay copies a hop behind a clean one, damaged at the frame's end
        and almost always high. Blackdown Tableland's wrap is real. Codes DD, PD, ND and AN mark {{FLAGGED}}
        ({{ROWS}} rows checked), so excluding them in <b>Plots</b> (the Tyalgum preset) removes the crosses.</p>
      <p><b>Likely.</b> A timing fault at the end of a relayed frame: read a bit late, or the transmitter dropping
        before its last byte is done.</p>
      <p><b>Open.</b> Which site; and how much start-of-frame error is a transmitter's PLL, how much our
        decoder.</p>
    </div>
    <div>
      <h2>Next</h2>
      <ol>
        <li>Ask the network maintainer to check Emerald Radar first (receiver, antenna, feeder, key-up and tail
          timing), then Mt Mayde and Roddas Lookout.</li>
        <li>Export the same week for Florence Vale AL (relayed by Emerald Radar alone) and Kulumur Range AL (Mt Mayde,
          then Emerald Radar). Late copies at both point to Emerald Radar; at Kulumur only, to the second hop.</li>
        <li>Re-decode a batch of our own bursts with a faster bit-timing loop. If first-byte flips drop, part of
          Figure 5 is ours.</li>
      </ol>
    </div>
  </div>

  <footer class="small">
    Method: the true count is the longest never-decreasing run of readings in the order received; a copy 16 or more
    counts (3.2 mm) off it is corrupted; one value repeated within 3 s is one transmission; {{MANUAL}} crosses
    already flagged by hand (code MM, ARRO's orange triangles) are left out. Data and script:
    <code>data/investigations/2026-10-corrupted-relay-copies/</code>,
    <code>tools/investigations/corrupted_relay_copies.py</code>.
  </footer>
</section>
</main>
</body>
</html>
'''

if __name__ == '__main__':
    main()
