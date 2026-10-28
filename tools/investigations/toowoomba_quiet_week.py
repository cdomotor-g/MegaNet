#!/usr/bin/env python3
"""Investigation 02 — Toowoomba's quiet week (October 2026). Builds the report
page from the four exports.

    python3 tools/investigations/toowoomba_quiet_week.py

Reads   data/investigations/2026-10-toowoomba-quiet-week/*.csv
Writes  investigations/2026-10-toowoomba-quiet-week.html

The exports come from tools/investigations/toowoomba_quiet_week.sql, which
says what each holds; none names a receiver. Standard library only, so it
runs anywhere the repo is checked out. Every number the page quotes is
computed here from the exports.

The test
────────
Toowoomba AL's repeater (151.525 MHz) last transmitted at 04:35 on 25 October.
Flood-Net's receiver heard its channel throughout, so the channel's corrupted
copies per 1,000 bursts decoded can be compared before and after. 151.500 MHz,
the receiver's only other channel all fortnight and one Toowoomba doesn't use,
is the comparison: a fall there too would be something at our end. The rate
is taken over windows: early October; 15–21 October, when it rose; the storm
of 22–24 October; the 17 hours between our receiver's software update (11:16
on 24 October) and Toowoomba's silence; and the days since.
"""

import csv
import html
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'data', 'investigations', '2026-10-toowoomba-quiet-week')
OUT = os.path.join(ROOT, 'investigations', '2026-10-toowoomba-quiet-week.html')

TW, CMP = '151.525', '151.500'                       # Toowoomba's channel; the comparison
START = datetime(2026, 10, 7)
ONSET = datetime(2026, 10, 15)                       # the rate on 151.525 rises
STORM = datetime(2026, 10, 22)
UPDATE = datetime(2026, 10, 24, 11, 16)              # our receiver's software update
QUIET = datetime(2026, 10, 25, 4, 35)                # Toowoomba's last transmission
END = datetime(2026, 10, 29)
CARRIERS_FROM = datetime(2026, 10, 21, 22, 0)        # carrier offsets recorded from here
WINDOWS = [  # key, label (\n breaks it in Figure 4), start, end
    ('early', 'Early Oct\n7–14', START, ONSET),
    ('rise', 'Risen\n15–21 Oct', ONSET, STORM),
    ('storm', 'Storm\n22–24 Oct', STORM, UPDATE),
    ('update', 'Our update,\nToowoomba on', UPDATE, QUIET),
    ('quiet', 'Toowoomba\nquiet', QUIET, END),
]
# The three repeaters heard on 151.525, by carrier offset (20 Hz bins, lower
# edges). Every carrier reads about 40 Hz higher after 24 October, ours or
# the weather's, so each has its own bins before and after.
TOOWOOMBA_BINS = range(520, 601, 20)
MT_GLORIOUS_BINS = {'before': range(260, 381, 20), 'after': range(280, 441, 20)}
THIRD_BINS = {'before': range(0, 121, 20), 'after': range(40, 161, 20)}
SLOTS = (2, 5, 8, 11, 14, 17, 20, 23)                # its gauge's three-hourly reports, at :02

# The words a reader may not know, each explained on hover where it is used and
# listed at the foot of the page, where a finger or a keyboard can read it.
TERMS = {
    'corrupted copy': 'A second copy of a real report, heard within five seconds of it, with one or two of its '
                      'address or value bits changed.',
    'per 1,000 decoded': 'Corrupted copies for every 1,000 bursts our receiver decoded on that channel, all '
                         'addresses together.',
    'carrier offset': 'How far a transmitter\'s carrier sits from the channel\'s centre, as our receiver measures '
                      'it. Every crystal is off by its own amount, so the offset tells apart transmitters that '
                      'share a channel.',
    'pass range': 'The block of addresses a repeater is set to relay. Toowoomba passes 4000–4099, 6526–6527 and '
                  'its own gauge, 6598.',
    'clear': 'A corrupted copy as strong as the clean one, within 6 dB: the transmitter sent wrong bits, rather '
             'than our receiver mishearing a weak one.',
    'three-hourly report': 'Toowoomba\'s gauge sends its count at two minutes past 2, 5, 8, 11, 14, 17, 20 and 23 '
                           'o\'clock, rain or not.',
}


# ── Reading the exports ──────────────────────────────────────────────────────

def rows(name):
    with open(os.path.join(DATA, name), newline='') as f:
        return list(csv.DictReader(f))


def load():
    blocks = [dict(a=datetime.fromisoformat(r['start']), z=datetime.fromisoformat(r['end']), ch=r['channel_mhz'],
                   g=r['group'], dec=int(r['decoded']), bad=int(r['corrupted']), clear=int(r['clear']))
              for r in rows('blocks.csv')]
    carriers = [dict(ch=r['channel_mhz'], per=r['period'], hz=int(r['carrier_hz']), dec=int(r['decoded']),
                     tw=int(r['toowoomba_range']), tw_own=int(r['toowoomba_own']),
                     bad=int(r['corrupted']))
                for r in rows('carriers.csv')]
    own = [dict(t=datetime.fromisoformat(r['heard']), v=int(r['value']),
                hz=int(r['carrier_hz']) if r['carrier_hz'] else None) for r in rows('toowoomba_own.csv')]
    tx = {r['tx']: dict(bursts=int(r['bursts']), bad=int(r['corrupted']), fleet=float(r['fleet_rate']),
                        judged=r['judged_at']) for r in rows('transmitters.csv')}
    return blocks, carriers, own, tx


def window(blocks, ch, a, b, groups=None):
    sel = [x for x in blocks if x['ch'] == ch and x['a'] >= a and x['z'] <= b and (groups is None or x['g'] in groups)]
    dec, bad, clear = (sum(x[k] for x in sel) for k in ('dec', 'bad', 'clear'))
    return dict(dec=dec, bad=bad, clear=clear, rate=1000 * bad / dec if dec else 0,
                days=(b - a).total_seconds() / 86400)


def ratio_ci(b1, d1, b0, d0):
    """Rate ratio (b1/d1)/(b0/d0) with a 95% range, counts taken as Poisson."""
    r = (b1 / d1) / (b0 / d0)
    se = math.sqrt(1 / b1 + 1 / b0)
    return r, r * math.exp(-1.96 * se), r * math.exp(1.96 * se)


def carrier(carriers, ch, per, bins):
    sel = [c for c in carriers if c['ch'] == ch and c['per'] == per and c['hz'] in bins]
    dec, bad = sum(c['dec'] for c in sel), sum(c['bad'] for c in sel)
    return dict(dec=dec, bad=bad, tw=sum(c['tw'] for c in sel), own=sum(c['tw_own'] for c in sel),
                share=100 * bad / dec if dec else 0)


def slots(own):
    """Each day's three-hourly reports from Toowoomba's gauge: heard or not."""
    heard = {(r['t'].date(), r['t'].hour) for r in own if r['t'].minute == 2 and r['t'].hour in SLOTS}
    days, d = [], START
    while d < END:
        days.append((d.date(), [(d.date(), h) in heard for h in SLOTS]))
        d += timedelta(days=1)
    return days


# ── Drawing ──────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s), quote=True)


def fmt(n):
    return f'{n:,}'


def term(text, key=None):
    return f'<span class="term" title="{esc(TERMS[key or text])}">{esc(text)}</span>'


def rate_chart(blocks):
    """Figure 1: corrupted copies per 1,000 decoded, each day (25 October cut at
    Toowoomba's silence, 24 October at our update), on Toowoomba's channel and the comparison."""
    W, h, L, R, T, B = 720, 190, 40, 10, 34, 22
    pw, ph = W - L - R, h - T - B
    span = (END - START).total_seconds()
    X = lambda t: L + pw * (t - START).total_seconds() / span
    top = 80
    Y = lambda v: T + ph * (1 - min(v, top) / top)
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Corrupted copies per 1,000 decoded, each '
           'day from 7 to 28 October, on Toowoomba\'s channel and on our receiver\'s other channel; Toowoomba\'s '
           'falls when it goes quiet on 25 October, the other does not">']
    out.append(f'<rect class="quiet" x="{X(QUIET):.1f}" y="{T}" width="{X(END) - X(QUIET):.1f}" height="{ph}"/>')
    for v in range(0, top + 1, 20):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 24}">per 1,000</text>')
    d = START
    while d < END:
        mid = X(d + timedelta(hours=12))
        out.append(f'<text class="tick" x="{mid:.1f}" y="{T + ph + 14}" text-anchor="middle">{d.day}</text>')
        if d > START:
            out.append(f'<line class="grid faint" x1="{X(d):.1f}" x2="{X(d):.1f}" y1="{T + ph}" y2="{T + ph + 4}"/>')
        d += timedelta(days=1)
    out.append(f'<text class="tick" x="{L - 5}" y="{T + ph + 14}" text-anchor="end">Oct</text>')
    for t, text, anchor, dy in ((ONSET, 'rises on 15 Oct', 'start', 0), (UPDATE, 'our update', 'end', 0),
                                (QUIET, 'Toowoomba quiet', 'start', 0)):
        x = X(t)
        out.append(f'<line class="mark" x1="{x:.1f}" x2="{x:.1f}" y1="{T - 6}" y2="{T + ph}"/>'
                   f'<text class="note" x="{x + (3 if anchor == "start" else -3):.1f}" y="{T - 9 + dy}" '
                   f'text-anchor="{anchor}">{esc(text)}</text>')
    by = defaultdict(lambda: [0, 0])
    for x in blocks:
        k = (x['ch'], x['a'], x['z'])
        by[k][0] += x['dec']
        by[k][1] += x['bad']
    for ch, cls, name in ((CMP, 'line cmp', 'Comparison channel, 151.500'), (TW, 'line tw', 'Toowoomba\'s channel, 151.525')):
        segs = sorted((a, z, v) for (c, a, z), v in by.items() if c == ch)
        d_path, dots = [], []
        for i, (a, z, (dec, bad)) in enumerate(segs):
            r = 1000 * bad / dec if dec else 0
            d_path.append(f'{"M" if i == 0 else "L"}{X(a):.1f} {Y(r):.1f}H{X(z):.1f}')
            mid = a + (z - a) / 2
            dots.append(f'<g><title>{esc(name)}, {a:%d %b %H:%M}–{z:%H:%M}: {bad} corrupted of {fmt(dec)} decoded, '
                        f'{r:.0f} per 1,000</title><rect class="hit" x="{X(a):.1f}" y="{T}" width="{X(z) - X(a):.1f}" '
                        f'height="{ph}"/></g>')
        out.append(f'<path class="{cls}" d="{"".join(d_path)}"/>')
        out.extend(dots)
    lx = L + 8
    for cls, text in (('tw', 'Toowoomba\'s channel, 151.525 MHz'), ('cmp', 'Comparison, 151.500 MHz')):
        out.append(f'<line class="line {cls}" x1="{lx}" x2="{lx + 16}" y1="{T + 9}" y2="{T + 9}"/>'
                   f'<text class="key" x="{lx + 21}" y="{T + 12.5}">{esc(text)}</text>')
        lx += 36 + len(text) * 5.5
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/></svg>')
    return '\n'.join(out)


def carrier_chart(carriers, days_before, days_after):
    """Figure 2: bursts a day on 151.525 by carrier offset, before and after."""
    W, L, R, T, ph, gap = 720, 40, 10, 16, 62, 30
    lo, hi = -100, 720
    h = T + 2 * ph + gap + 30
    X = lambda hz: L + (W - L - R) * (hz - lo) / (hi - lo)
    top = 450
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Bursts a day on 151.525 MHz by carrier '
           'offset: before 25 October a tall peak near +560 Hz, Toowoomba\'s, which carried its own gauge; after, '
           'nothing there">']
    for i, (per, days, label) in enumerate((('before', days_before, f'Before: 21 Oct 22:00 to 25 Oct 04:35'),
                                            ('after', days_after, f'After: 25 Oct 04:35 to 29 Oct 00:00'))):
        y0 = T + ph + i * (ph + gap)
        Y = lambda v: y0 - ph * min(v, top) / top
        for v in (0, 200, 400):
            out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                       f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
        out.append(f'<text class="key strong" x="{L + 6}" y="{y0 - ph + 4}">{esc(label)}</text>')
        bw = (W - L - R) * 20 / (hi - lo) - 1.5
        for c in carriers:
            if c['ch'] != TW or c['per'] != per or not lo <= c['hz'] < hi:
                continue
            v = c['dec'] / days
            cls = 'bar tw' if per == 'before' and c['hz'] in TOOWOOMBA_BINS else 'bar'
            title = (f'{c["hz"]} to {c["hz"] + 20} Hz: {fmt(c["dec"])} bursts ({v:.0f} a day), {c["tw"]} in '
                     f'Toowoomba\'s ranges, {c["tw_own"]} from its own gauge; {c["bad"]} corrupted copies')
            out.append(f'<g><title>{esc(title)}</title><rect class="{cls}" x="{X(c["hz"]) + 0.75:.1f}" '
                       f'y="{Y(v):.1f}" width="{bw:.1f}" height="{y0 - Y(v):.1f}"/></g>')
        out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{y0}" y2="{y0}"/>')
        if per == 'before':
            notes = [(560, 'Toowoomba: its own gauge came here', 'end', -6), (330, 'Mt Glorious', 'middle', 0),
                     (70, 'a third repeater', 'middle', 0)]
        else:
            notes = [(530, 'nothing at Toowoomba\'s offset', 'start', 0), (360, 'Mt Glorious', 'middle', 0),
                     (100, 'third repeater', 'middle', 0)]
        for hz, text, anchor, dx in notes:
            peak = max((c['dec'] / days for c in carriers if c['ch'] == TW and c['per'] == per and abs(c['hz'] - hz) <= 40),
                       default=0)
            out.append(f'<text class="note" x="{X(hz) + dx:.1f}" y="{Y(peak) - 4:.1f}" text-anchor="{anchor}">'
                       f'{esc(text)}</text>')
    for hz in range(0, hi, 100):
        out.append(f'<text class="tick" x="{X(hz):.1f}" y="{h - 12}" text-anchor="middle">{"+" if hz else ""}{hz}</text>')
    out.append(f'<text class="tick" x="{W - R}" y="{h - 1}" text-anchor="end">carrier offset, Hz</text>'
               f'<text class="tick" x="0" y="{T - 6}">a day</text></svg>')
    return '\n'.join(out)


def slot_strip(days):
    """Figure 3: Toowoomba's three-hourly reports, heard or missed, each day."""
    cw, ch, L, T = 9, 9, 26, 14
    W, h = L + cw * len(days) + 4, T + ch * len(SLOTS) + 30
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Toowoomba\'s three-hourly reports, '
           '7 to 28 October: every one heard until 15 October, gaps from 15 to 18 October, none after 25 October">']
    for j, hr in enumerate(SLOTS):
        if j % 2 == 0:
            out.append(f'<text class="tick" x="{L - 4}" y="{T + j * ch + 7.5}" text-anchor="end">{hr:02d}h</text>')
    for i, (day, got) in enumerate(days):
        x = L + i * cw
        for j, ok in enumerate(got):
            title = f'{day:%d %b} {SLOTS[j]:02d}:02 — {"heard" if ok else "missed"}'
            out.append(f'<g><title>{esc(title)}</title><rect class="cell {"ok" if ok else "miss"}" x="{x + 0.5}" '
                       f'y="{T + j * ch + 0.5}" width="{cw - 1}" height="{ch - 1}" rx="1.5"/></g>')
        if day.day % 7 == 0 or i == 0:
            out.append(f'<text class="tick" x="{x + cw / 2:.1f}" y="{T + ch * len(SLOTS) + 11}" '
                       f'text-anchor="middle">{day.day}</text>')
    xq = L + (QUIET.date() - START.date()).days * cw + cw * (QUIET.hour + QUIET.minute / 60) / 24
    out.append(f'<line class="mark" x1="{xq:.1f}" x2="{xq:.1f}" y1="{T - 4}" y2="{T + ch * len(SLOTS) + 2}"/>')
    lx = L
    for cls, text in (('ok', 'heard'), ('miss', 'missed')):
        out.append(f'<rect class="cell {cls}" x="{lx}" y="{h - 10}" width="8" height="8" rx="1.5"/>'
                   f'<text class="key" x="{lx + 12}" y="{h - 3}">{text}</text>')
        lx += 58
    out.append('</svg>')
    return '\n'.join(out)


def window_chart(rates):
    """Figure 4: each window's rate, Toowoomba's channel beside the comparison."""
    W, h, L, R, T, B = 380, 184, 30, 4, 30, 34
    pw, ph = W - L - R, h - T - B
    top = 60
    Y = lambda v: T + ph * (1 - v / top)
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Corrupted copies per 1,000 decoded in '
           'each window, Toowoomba\'s channel beside the comparison channel">']
    for v in range(0, top + 1, 20):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 18}">per 1,000</text>')
    slot = pw / len(WINDOWS)
    bw = min(20, slot * 0.32)
    for i, (key, label, a, b) in enumerate(WINDOWS):
        cx = L + slot * (i + 0.5)
        if key == 'quiet':
            out.append(f'<rect class="quiet" x="{cx - slot / 2 + 2:.1f}" y="{T}" width="{slot - 4:.1f}" height="{ph}"/>')
        for k, (ch, cls) in enumerate(((TW, 'tw'), (CMP, 'cmp'))):
            r = rates[key][ch]
            x0 = cx + (k - 1) * (bw + 2) + 1
            y0, y1 = Y(0), Y(r['rate'])
            rr = min(3, (y0 - y1) / 2)
            d = (f'M{x0:.1f} {y0:.1f}V{y1 + rr:.1f}Q{x0:.1f} {y1:.1f} {x0 + rr:.1f} {y1:.1f}H{x0 + bw - rr:.1f}'
                 f'Q{x0 + bw:.1f} {y1:.1f} {x0 + bw:.1f} {y1 + rr:.1f}V{y0:.1f}Z')
            title = (f'{label.replace(chr(10), " ")}, {ch} MHz: {fmt(r["bad"])} corrupted of {fmt(r["dec"])} decoded '
                     f'({r["rate"]:.0f} per 1,000; {r["dec"] / r["days"]:,.0f} decoded a day)')
            out.append(f'<g><title>{esc(title)}</title><path class="bar {cls}" d="{d}"/></g>'
                       f'<text class="val" x="{x0 + bw / 2:.1f}" y="{y1 - 3:.1f}" text-anchor="middle">{r["rate"]:.0f}</text>')
        for k, part in enumerate(label.split('\n')):
            out.append(f'<text class="tick" x="{cx:.1f}" y="{Y(0) + 12 + k * 10:.1f}" text-anchor="middle">{esc(part)}</text>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/>')
    lx = L + 40
    for cls, text in (('tw', '151.525 (Toowoomba)'), ('cmp', '151.500 (comparison)')):
        out.append(f'<rect class="bar {cls}" x="{lx}" y="{T - 27}" width="9" height="9" rx="2"/>'
                   f'<text class="key" x="{lx + 13}" y="{T - 19}">{esc(text)}</text>')
        lx += 30 + len(text) * 5.8
    out.append('</svg>')
    return '\n'.join(out)


# ── The page ─────────────────────────────────────────────────────────────────

def main():
    blocks, carriers, own, tx = load()
    rates = {k: {ch: window(blocks, ch, a, b) for ch in (TW, CMP)} for k, _, a, b in WINDOWS}
    before = {ch: window(blocks, ch, ONSET, QUIET) for ch in (TW, CMP)}      # 15 Oct to the silence
    quiet = rates['quiet']
    tw_grp = {k: window(blocks, TW, a, b, {'toowoomba'}) for k, _, a, b in WINDOWS}
    tw_oth = {k: window(blocks, TW, a, b, {'other'}) for k, _, a, b in WINDOWS}
    clear_tw = window(blocks, TW, ONSET, QUIET)

    r, lo, hi = ratio_ci(quiet[TW]['bad'], quiet[TW]['dec'], before[TW]['bad'], before[TW]['dec'])
    days_before = (QUIET - CARRIERS_FROM).total_seconds() / 86400
    days_after = (END - QUIET).total_seconds() / 86400
    tc = carrier(carriers, TW, 'before', TOOWOOMBA_BINS)
    tc_after = carrier(carriers, TW, 'after', range(500, 641, 20))
    mg_b, mg_a = carrier(carriers, TW, 'before', MT_GLORIOUS_BINS['before']), carrier(carriers, TW, 'after', MT_GLORIOUS_BINS['after'])
    th_b, th_a = carrier(carriers, TW, 'before', THIRD_BINS['before']), carrier(carriers, TW, 'after', THIRD_BINS['after'])
    tw_before_all = sum(c['bad'] for c in carriers if c['ch'] == TW and c['per'] == 'before')
    own_total = sum(c['tw_own'] for c in carriers if c['ch'] == TW and c['per'] == 'before')

    days = slots(own)
    missed = {d: 8 - sum(g) for d, g in days}
    pre_onset_missed = sum(v for d, v in missed.items() if d < ONSET.date())
    onset_missed = missed[ONSET.date()]
    rise_missed = sum(v for d, v in missed.items() if ONSET.date() <= d <= datetime(2026, 10, 18).date())
    own_tw = [x for x in own if x['hz'] is not None and 500 <= x['hz'] <= 640]
    last = own_tw[-1]
    reset = next(x for x in own_tw if x['v'] == 0)
    before_reset = max((x for x in own_tw if x['t'] < reset['t']), key=lambda x: x['t'])
    after_quiet = [x for x in own if x['t'] > QUIET]
    last_any = carrier(carriers, TW, 'after', TOOWOOMBA_BINS)

    twx = tx['st:toowoomba_al']

    print(f'151.525: early {rates["early"][TW]["rate"]:.1f}, risen {rates["rise"][TW]["rate"]:.1f}, storm '
          f'{rates["storm"][TW]["rate"]:.1f}, update {rates["update"][TW]["rate"]:.1f}, quiet {quiet[TW]["rate"]:.1f}; '
          f'ratio {r:.2f} ({lo:.2f}–{hi:.2f})')
    print(f'151.500: ' + ', '.join(f'{k} {rates[k][CMP]["rate"]:.1f}' for k, *_ in WINDOWS))
    print(f'Toowoomba carrier before: {tc}; after {tc_after}; Mt Glorious {mg_b["share"]:.1f}% → {mg_a["share"]:.1f}%; '
          f'third {th_b["share"]:.1f}% → {th_a["share"]:.1f}%')
    print(f'missed three-hourly reports: before 15 Oct {pre_onset_missed}, 15 Oct {onset_missed}, 15–18 Oct {rise_missed}')

    fig1 = rate_chart(blocks)
    fig2 = carrier_chart(carriers, days_before, days_after)
    fig3 = slot_strip(days)
    fig4 = window_chart(rates)
    key = ''.join(f'<dt>{esc(k[0].upper() + k[1:])}</dt><dd>{esc(v)}</dd>' for k, v in TERMS.items())

    def per_day(w):
        return f'{w["dec"] / w["days"]:,.0f}'

    page = TEMPLATE
    for k, v in dict(
        FIG1=fig1, FIG2=fig2, FIG3=fig3, FIG4=fig4, KEY=key,
        T_COPY=term('corrupted copy'), T_COPIES=term('corrupted copies', 'corrupted copy'),
        T_PERK=term('per 1,000 decoded'), T_CARRIER=term('carrier offset'), T_PASS=term('pass ranges', 'pass range'),
        T_CLEAR=term('clear'), T_SLOT=term('three-hourly reports', 'three-hourly report'),
        EARLY=f'{rates["early"][TW]["rate"]:.0f}', RISE=f'{rates["rise"][TW]["rate"]:.0f}',
        STORMR=f'{rates["storm"][TW]["rate"]:.0f}', UPD=f'{rates["update"][TW]["rate"]:.0f}',
        QUIETR=f'{quiet[TW]["rate"]:.0f}', BEFORE=f'{before[TW]["rate"]:.0f}',
        B_BAD=fmt(before[TW]['bad']), B_DEC=fmt(before[TW]['dec']), Q_BAD=fmt(quiet[TW]['bad']),
        Q_DEC=fmt(quiet[TW]['dec']), RATIO=f'{r:.2f}', RLO=f'{lo:.2f}', RHI=f'{hi:.2f}',
        UPD_BAD=rates['update'][TW]['bad'], UPD_DEC=fmt(rates['update'][TW]['dec']),
        PD_EARLY=per_day(rates['early'][TW]), PD_RISE=per_day(rates['rise'][TW]), PD_QUIET=per_day(quiet[TW]),
        TWG_RISE=f'{tw_grp["rise"]["rate"]:.0f}', TWG_EARLY=f'{tw_grp["early"]["rate"]:.0f}',
        TWG_QUIET=f'{tw_grp["quiet"]["rate"]:.0f}', OTH_RISE=f'{tw_oth["rise"]["rate"]:.0f}',
        OTH_EARLY=f'{tw_oth["early"]["rate"]:.0f}', OTH_QUIET=f'{tw_oth["quiet"]["rate"]:.0f}',
        CLEAR_PCT=f'{100 * clear_tw["clear"] / clear_tw["bad"]:.0f}',
        CMP_UPD=f'{rates["update"][CMP]["rate"]:.0f}', CMP_QUIET=f'{quiet[CMP]["rate"]:.0f}',
        TW_TX_BAD=twx['bad'], TW_TX_BURSTS=twx['bursts'], TW_TX_PCT=f'{100 * twx["bad"] / twx["bursts"]:.0f}',
        FLEET=f'{100 * twx["fleet"]:.2f}', JUDGED=twx['judged'][11:],
        TC_DEC=fmt(tc['dec']), TC_TW=f'{100 * tc["tw"] / tc["dec"]:.0f}', TC_OWN=tc['own'], OWN_TOTAL=own_total,
        TC_BAD=tc['bad'], TC_SHARE=f'{tc["share"]:.1f}', TC_OF=f'{100 * tc["bad"] / tw_before_all:.0f}',
        TC_AFTER={0: 'no burst', 1: 'one burst'}.get(last_any['tw'], f"{last_any['tw']} bursts"),
        MG_B=f'{mg_b["share"]:.1f}', MG_A=f'{mg_a["share"]:.1f}', TH_B=f'{th_b["share"]:.1f}', TH_A=f'{th_a["share"]:.1f}',
        DAYS_B=f'{days_before:.1f}', DAYS_A=f'{days_after:.1f}',
        PRE_MISSED=pre_onset_missed, ONSET_MISSED=onset_missed, RISE_MISSED=rise_missed,
        RESET_AT=f'{reset["t"]:%H:%M}', RESET_FROM=fmt(before_reset['v']), LAST_AT=f'{QUIET:%H:%M}',
        LAST_OWN_AT=f'{last["t"]:%H:%M}', PRE_SLOTS=8 * (ONSET - START).days,
        LAST_V=last['v'], LAST_MIN=round((QUIET - reset['t']).total_seconds() / 60),
        STRAY_AT=f'{after_quiet[0]["t"]:%d %B, %H:%M}'.lstrip('0'), STRAY_V=after_quiet[0]['v'],
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
  <title>Toowoomba's quiet week — Flood-Net investigation 02</title>
  <meta name="description" content="A before-and-after test of Toowoomba AL's repeater: when it went off air on 25 October 2026, corrupted copies of readings on its channel fell to a third, back to the early-October level.">
  <link rel="canonical" href="https://floodwarning.net/investigations/2026-10-toowoomba-quiet-week">
  <link rel="icon" type="image/svg+xml" href="../assets/icon-small.svg">
  <!-- Generated by tools/investigations/toowoomba_quiet_week.py from the four
       exports in data/investigations/2026-10-toowoomba-quiet-week/ (queries in
       tools/investigations/toowoomba_quiet_week.sql): edit the script and run
       it again rather than this file. Self-contained like about.html: no
       script, no font, no stylesheet to fetch; two A4 pages printed. No ?v=
       stamp: sw.js keeps none of this, and the icon is the only thing it
       loads. -->
  <style>
    :root {
      color-scheme: light;
      --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --bg: #ffffff; --panel: #f6f7f8;
      --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab;
      --s1: #2a78d6; --s2: #eb6834; --quiet: rgba(27,175,122,.10); --miss: #e9e8e2;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
        --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
        --s1: #3987e5; --s2: #d95926; --quiet: rgba(25,158,112,.16); --miss: #2c2c2a;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
      --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
      --s1: #3987e5; --s2: #d95926; --quiet: rgba(25,158,112,.16); --miss: #2c2c2a;
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
    .term { text-decoration: underline dotted var(--muted); text-underline-offset: 2px; cursor: help; }
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
    .row { display: grid; grid-template-columns: 236px 1fr; gap: 1rem; align-items: start; }
    .row.wide { grid-template-columns: 1fr 380px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
    @media (max-width: 620px) { .row, .row.wide, .two { grid-template-columns: 1fr; } }
    ol { margin: .25rem 0; padding-left: 1.2rem; }
    li { margin: .15rem 0; }
    dl.key { margin: .2rem 0 0; display: grid; grid-template-columns: max-content 1fr; gap: .1rem .6rem; }
    dl.key dt { font-weight: 600; color: var(--ink); }
    dl.key dd { margin: 0; }
    .small { font-size: 11.5px; color: var(--ink-2); }
    footer { margin-top: .8rem; padding-top: .5rem; border-top: 1px solid var(--line); }
    svg.fig { width: 100%; height: auto; display: block; overflow: visible;
              font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .grid { stroke: var(--line); stroke-width: 1; }
    .grid.faint { stroke: var(--axis); }
    .axis { stroke: var(--axis); stroke-width: 1; }
    .tick { fill: var(--muted); font-size: 9.5px; font-variant-numeric: tabular-nums; }
    .key { fill: var(--ink-2); font-size: 10.5px; }
    .key.strong { fill: var(--ink); font-weight: 600; }
    .note { fill: var(--ink-2); font-size: 10px; }
    .val { fill: var(--ink); font-size: 9.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .mark { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
    .quiet { fill: var(--quiet); }
    .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .line.tw { stroke: var(--s2); } .line.cmp { stroke: var(--muted); stroke-width: 1.5; }
    .hit { fill: transparent; }
    .bar { fill: var(--s1); } .bar.tw { fill: var(--s2); } .bar.cmp { fill: var(--muted); }
    .cell.ok { fill: var(--s1); } .cell.miss { fill: var(--miss); }
    .sheet + .sheet { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    @page { size: A4; margin: 9mm 10mm; }
    @media print {
      :root { color-scheme: light; --ink: #0b0b0b; --ink-2: #52514e; --bg: #ffffff; --panel: #f6f7f8;
              --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab; --s1: #2a78d6; --s2: #eb6834;
              --quiet: rgba(27,175,122,.10); --miss: #e9e8e2; }
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
      .term { text-decoration: none; }
      footer { margin-top: .4rem; padding-top: .3rem; }
      main { max-width: none; }
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }
      .sheet + .sheet { margin-top: 0; padding-top: 0; border-top: 0; }
      figure, .tldr, dl.key { break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
      .crumb { display: none; }
      .row { grid-template-columns: 200px 1fr; }
      .row.wide { grid-template-columns: 1fr 320px; }
    }
  </style>
</head>
<body>
<main>
<section class="sheet">
  <p class="crumb"><a href="./">Investigations</a> · <a href="../">Flood-Net</a></p>
  <h1>Toowoomba's quiet week: what changed when its repeater went off air</h1>
  <p class="meta">Investigation 02 · 29 October 2026 · Toowoomba AL (540162, rain 6598), repeater on 151.525 MHz,
    Brisbane hub · <span class="pill">Open: Toowoomba implicated, site fault not yet found</span></p>

  <div class="tldr">
    <ul>
      <li><strong>Toowoomba's transmitter last spoke at {{LAST_AT}} on 25 October.</strong> Its rain counter had reset
        to 0 at {{RESET_AT}}, which looks like a power cut or a restart. Its carrier hasn't been heard since.</li>
      <li><strong>On its channel, {{T_COPIES}} fell to a third at that moment</strong>: from {{BEFORE}} to
        {{QUIETR}} {{T_PERK}}, with the same traffic, back where it was in early October. Our receiver's update the
        day before didn't do it: the rate stayed at {{UPD}} until Toowoomba stopped.</li>
      <li><strong>Toowoomba was sending some of the damage itself.</strong> {{TC_SHARE}}% of the bursts on its
        carrier were corrupted copies, about twice the share on the other two repeaters on its channel. Mt Glorious,
        which relays the same addresses, went from {{MG_B}}% to {{MG_A}}% once Toowoomba stopped.</li>
      <li><strong>It looks to have been failing since 15 October.</strong> That day the corruption on its channel
        tripled, and its own {{T_SLOT}} began going missing.</li>
    </ul>
  </div>

  <h2>The test: the channel cleared when Toowoomba stopped</h2>
  <figure>
    <div class="scroll">{{FIG1}}</div>
    <figcaption>Figure 1. Corrupted copies per 1,000 decoded, each day. Orange: Toowoomba's channel. Grey: 151.500
      MHz, our receiver's only other channel all fortnight, which Toowoomba doesn't use. Green: Toowoomba's silence.
      Hover a day for its counts.</figcaption>
  </figure>
  <p>On Toowoomba's channel the rate ran at {{EARLY}} per 1,000 in early October and rose to {{RISE}} from 15 October,
    with no change in traffic (about {{PD_EARLY}} and {{PD_RISE}} bursts a day). When Toowoomba went quiet it dropped to {{QUIETR}}, still on about {{PD_QUIET}} bursts a day:
    {{Q_BAD}} corrupted copies in {{Q_DEC}}, against {{B_BAD}} in {{B_DEC}} from 15 October up to the silence. That's
    {{RATIO}} times the earlier rate (95% range {{RLO}}–{{RHI}}), too large a drop for chance. The comparison channel
    didn't drop at {{LAST_AT}}, so the fall wasn't something at our end. {{CLEAR_PCT}}% of the corrupted copies on
    Toowoomba's channel were {{T_CLEAR}}: as strong as the clean copy, so wrong when they were sent, not
    misheard.</p>

  <h2>What went quiet at {{LAST_AT}} on 25 October</h2>
  <figure>
    <div class="scroll">{{FIG2}}</div>
    <figcaption>Figure 2. Bursts a day on 151.525 MHz by {{T_CARRIER}}, in 20 Hz steps, since offsets were first
      recorded ({{DAYS_B}} days before, {{DAYS_A}} after). Orange is Toowoomba's carrier. Every carrier reads about
      40 Hz higher after 24 October, so look at the shape, not the exact offset.</figcaption>
  </figure>
  <div class="row">
    <figure>
      {{FIG3}}
      <figcaption>Figure 3. Toowoomba's {{T_SLOT}}, 7–28 October. The dashed line is {{LAST_AT}} on 25
        October.</figcaption>
    </figure>
    <div>
      <p>The tall peak near +560 Hz is Toowoomba. {{TC_TW}}% of its {{TC_DEC}} bursts were addresses in Toowoomba's
        {{T_PASS}}, and all {{TC_OWN}} reports from its own gauge came on it. After {{LAST_AT}} on 25 October,
        {{TC_AFTER}} from its ranges arrived anywhere near that offset. The Mt Glorious peak carries addresses only Mt
        Glorious relays, and it's still there.</p>
      <p>Before 15 October almost every one of its three-hourly reports arrived ({{PRE_MISSED}} of {{PRE_SLOTS}}
        missed). On the 15th, the day the corruption rose, {{ONSET_MISSED}} of 8 went missing, and {{RISE_MISSED}} by the
        18th. On 25 October its count read {{RESET_FROM}}, then 0 at {{RESET_AT}}, then 1 to {{LAST_V}} by
        {{LAST_OWN_AT}} as it rained. Its carrier was last heard at {{LAST_AT}}, {{LAST_MIN}} minutes after the
        reset. The one copy of its address since ({{STRAY_AT}}) came on Mt Glorious's carrier with a count of
        {{STRAY_V}}: another gauge, not Toowoomba.</p>
    </div>
  </div>
</section>

<section class="sheet">
  <div class="row wide">
    <div>
      <h2>Before and after, side by side</h2>
      <p>Each window is a stretch of the fortnight. The orange bars stay high through the storm and through our
        receiver's update, 17 hours before the silence ({{UPD_BAD}} corrupted in {{UPD_DEC}}, {{UPD}} per 1,000). They
        drop only when Toowoomba stops. The grey bars, on the comparison channel, don't drop then: {{CMP_UPD}} per
        1,000 just before, {{CMP_QUIET}} after.</p>
      <p>Toowoomba's own addresses, which now reach us only through the repeaters that share its ranges, went from
        {{TWG_RISE}} to {{TWG_QUIET}} per 1,000 ({{TWG_EARLY}} in early October). Addresses outside its ranges went from
        {{OTH_RISE}} to {{OTH_QUIET}} ({{OTH_EARLY}} early), so it was spoiling traffic it doesn't list as well.</p>
    </div>
    <figure>
      {{FIG4}}
      <figcaption>Figure 4. Corrupted copies per 1,000 decoded in each window. The shaded pair is Toowoomba's
        silence. Hover a bar for its counts.</figcaption>
    </figure>
  </div>

  <h2>Where the damage came from</h2>
  <p>From 21 October, when carriers were first recorded, to the silence, {{TC_BAD}} corrupted copies came on
    Toowoomba's carrier: {{TC_OF}}% of all those on the channel, and {{TC_SHARE}}% of what that carrier brought. The
    other two repeaters on the channel ran at {{MG_B}}% (Mt Glorious) and {{TH_B}}% (the third). Once Toowoomba
    stopped, Mt Glorious's share fell to {{MG_A}}%. It relays Toowoomba's addresses onward, so some of its damage was
    Toowoomba's, passed on. The third repeater stayed about where it was ({{TH_A}}%).</p>
  <p>Flood-Net's transmitter table, as judged at {{JUDGED}} on 29 October, puts {{TW_TX_BAD}} corrupted copies on
    Toowoomba against {{TW_TX_BURSTS}} bursts ({{TW_TX_PCT}}%), against a typical {{FLEET}}%. That overstates it. The
    table divides by the bursts it pinned to Toowoomba itself, not everything on its carrier, and it gave most of
    Toowoomba's carrier to Mt Glorious, which relays the same addresses. Measured on the whole carrier, Toowoomba's
    share is the {{TC_SHARE}}% above.</p>

  <div class="two">
    <div>
      <h2>What we know</h2>
      <p><b>Established.</b> Toowoomba's transmitter stopped at {{LAST_AT}} on 25 October. On its channel, corrupted
        copies fell from {{BEFORE}} to {{QUIETR}} per 1,000 at that moment, on the same traffic. Neither our
        receiver's update nor anything else at our end caused it: the comparison channel didn't drop.</p>
      <p><b>Likely.</b> Toowoomba was failing for ten days before it died, and sending corrupted copies the whole
        time. Some went out again through Mt Glorious. A counter reset, then silence {{LAST_MIN}} minutes later in
        rain, points at power: battery, charger or supply.</p>
      <p><b>Open.</b> What failed on 15 October. Why traffic outside Toowoomba's ranges was damaged too: it may relay
        more than its {{T_PASS}} say, or its transmissions may have been colliding with other repeaters' bursts.</p>
    </div>
    <div>
      <h2>Next</h2>
      <ol>
        <li>Visit Toowoomba AL: power first (battery, charger, solar, supply), then the radio. Ask whether anything was
          done at the site around 15 October.</li>
        <li>When it's back on air, watch Figure 1's orange line. If it stays near {{QUIETR}} per 1,000, the fault went
          with the repair; if it climbs back towards {{BEFORE}}, it didn't.</li>
        <li>Fix the transmitter table so it uses the whole carrier as the denominator, and so a repeater can't be
          credited with another's carrier. The Bit-Flip Sources tab and the bulletins read from it.</li>
      </ol>
    </div>
  </div>

  <footer class="small">
    <p>Method: Flood-Net's receiver, legacy ALERT bursts on 151.525 MHz (Toowoomba's channel) and 151.500 MHz (the
      comparison), 7–28 October (Brisbane time). A corrupted copy is one Flood-Net's checks found: a burst one or two
      bits from a real one, on the same receiver within five seconds. Rates are corrupted copies over bursts decoded.
      An address is Toowoomba's if it is in Toowoomba AL's pass ranges in the station register. The receiver's other
      channels changed during the fortnight, so they are left out. Data, queries and script:
      <code>data/investigations/2026-10-toowoomba-quiet-week/</code>,
      <code>tools/investigations/toowoomba_quiet_week.sql</code>,
      <code>tools/investigations/toowoomba_quiet_week.py</code>.</p>
    <p><b>Words used here.</b></p>
    <dl class="key">{{KEY}}</dl>
  </footer>
</section>
</main>
</body>
</html>
'''

if __name__ == '__main__':
    main()
