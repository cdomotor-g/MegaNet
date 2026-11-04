#!/usr/bin/env python3
"""Investigation 03 — Hillcrest (Wine Glass) (November 2026). Builds the report
page from the eleven exports.

    python3 tools/investigations/hillcrest_wine_glass.py

Reads   data/investigations/2026-11-hillcrest-wine-glass/*.csv, stations.json
Writes  investigations/2026-11-hillcrest-wine-glass.html

The exports come from tools/investigations/hillcrest_wine_glass.sql, which
says what each holds; none names a receiver. Standard library only, so it
runs anywhere the repo is checked out. Every number the page quotes is
computed here from the exports.

The question
────────────
Station Health flagged Hillcrest AL (Wine Glass), the repeater on 151.500 MHz
at Logan, as critical: "80 corrupted copies in a week (70.8% of what it
sent)". The Backbone tab's first look had it off air from 14:15 on 26
October, and the weekly bulletin of 2 November had it back. Three tests:
whose carrier is the big one near +170 Hz (addresses only Hillcrest relays
against addresses only Constitution Hill does); whether that carrier ever
went quiet (three-hour blocks); and how much of its corruption is a burst
read two ways by our own decoder (the same instant as its clean twin), against
signal strength, on Hillcrest's carrier and the channel's others.
"""

import csv
import html
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'data', 'investigations', '2026-11-hillcrest-wine-glass')
OUT = os.path.join(ROOT, 'investigations', '2026-11-hillcrest-wine-glass.html')

BAND = (120, 240)                                    # Hillcrest's carrier, Hz (lower edge in)
START = datetime(2026, 10, 22)                       # carriers measured, whole days
END = datetime(2026, 11, 4)
SLOTS_FROM = datetime(2026, 10, 7)                   # its gauge's reports, from here
WEAK_FROM = datetime(2026, 10, 24, 21, 0)            # our receiver's floor up (levels.csv)
WEAK_TO = datetime(2026, 11, 2, 15, 0)               # its levels up
SLOT_HOURS = (0, 3, 6, 9, 12, 15, 18, 21)            # reports at :34, rain or not
HILLCREST_RANGES = '1900–2200, 4151–4199, 4800–4899, 5304–5399 and 6200–6274'

# The words a reader may not know, each explained on hover where it is used and
# listed at the foot of the page, where a finger or a keyboard can read it.
TERMS = {
    'carrier offset': 'How far a transmitter\'s carrier sits from the channel\'s centre, as our receiver measures '
                      'it. Each crystal is off by its own amount, so it tells transmitters on one channel apart.',
    'pass range': 'The block of addresses a repeater is set to relay. Hillcrest passes ' + HILLCREST_RANGES + '.',
    'corrupted copy': 'A second copy of a real report, heard within five seconds of it, with one or two of its '
                      'address or value bits changed.',
    'one burst read two ways': 'A corrupted copy our decoder took from the same transmission as the clean one, at '
                               'the same instant: one burst decoded twice, once wrongly.',
    'own burst': 'A corrupted copy that came in a transmission of its own, 0.3 to 5 seconds from its clean twin.',
    'signal-to-noise': 'How far a burst stood above the noise at our receiver, in decibels. Most bursts here arrive '
                       'at 8 to 13 dB.',
    'votes': 'In how many of our decoder\'s 45 guesses at a burst\'s carrier and timing a frame turned up. It '
             'reports a frame from 4.',
    'checked': 'The same reading reached us in another burst 0.3 to 5 seconds away, so a damaged copy shows.',
    'clear': 'As strong as the clean copy, within 6 dB. Station Health takes it as sent wrong, not misheard.',
    'three-hourly report': 'Hillcrest\'s gauge sends its count at 34 minutes past every third hour from midnight, '
                           'rain or not, and its battery a few seconds later.',
}


# ── Reading the exports ──────────────────────────────────────────────────────

def rows(name):
    with open(os.path.join(DATA, name), newline='') as f:
        return list(csv.DictReader(f))


def num(v):
    return float(v) if v not in ('', None) else None


def load():
    carriers = [dict(hz=int(r['carrier_hz']), dec=int(r['decoded']), hc_only=int(r['hillcrest_only']),
                     ch_only=int(r['constitution_only']), own=int(r['own']), same=int(r['corrupted_same_burst']),
                     sep=int(r['corrupted_separate'])) for r in rows('carriers.csv')]
    addresses = [dict(g=r['group'], a=int(r['addr']), on=int(r['on_hillcrest']), off=int(r['elsewhere']))
                 for r in rows('addresses.csv')]
    blocks = [dict(a=datetime.fromisoformat(r['start']), hc=int(r['hillcrest_carrier']), oth=int(r['other_carriers']),
                   none=int(r['no_carrier']), gauge=int(r['gauge_reports']), same=int(r['hillcrest_same_burst']),
                   sep=int(r['hillcrest_separate'])) for r in rows('blocks.csv')]
    levels = [dict(a=datetime.fromisoformat(r['start']), hs=num(r['hillcrest_snr_db']), os=num(r['other_snr_db']),
                   nf=num(r['noise_floor_dbfs']), lv=num(r['level_dbfs'])) for r in rows('levels.csv')]
    snr = [dict(s=int(r['snr_db']), c=r['carrier'], dec=int(r['decoded']), same=int(r['corrupted_same_burst']),
                sep=int(r['corrupted_separate'])) for r in rows('snr.csv')]
    checked = {r['group']: dict(dec=int(r['decoded']), twin=int(r['clean_with_twin']), sep=int(r['corrupted_separate']),
                                same=int(r['corrupted_same_burst'])) for r in rows('checked.csv')}
    separate = [dict(t=datetime.fromisoformat(r['heard']), ta=int(r['true_addr']), tv=int(r['true_value']),
                     ba=int(r['bad_addr']), bv=int(r['bad_value']), bits=int(r['bits']), gap=float(r['gap_s']),
                     snr=num(r['snr_db']), tsnr=num(r['twin_snr_db']), twin=r['twin_carrier'])
                for r in rows('separate.csv')]
    pairs = {r['carrier']: dict(n=int(r['pairs']), fewer=int(r['fewer_votes']), bv=float(r['bad_votes_median']),
                                gv=float(r['good_votes_median'])) for r in rows('pairs.csv')}
    own = [dict(t=datetime.fromisoformat(r['heard']), a=int(r['addr']), v=int(r['value']), hz=num(r['carrier_hz']),
                snr=num(r['snr_db']), copy=r['copy'] == '1') for r in rows('own.csv')]
    credited = [dict(tx=r['tx'], how=r['how'], n=int(r['bursts']), hz=int(r['carrier_hz'])) for r in rows('credited.csv')]
    tx = rows('transmitters.csv')[0]
    return carriers, addresses, blocks, levels, snr, checked, separate, pairs, own, credited, tx


def station_names():
    """Address → station name, from the register."""
    with open(os.path.join(ROOT, 'stations.json')) as f:
        doc = json.load(f)
    items = doc if isinstance(doc, list) else doc.get('stations', doc)
    if isinstance(items, dict):
        items = list(items.values())
    names = {}
    for s in items:
        for x in s.get('sensors') or []:
            names.setdefault(x.get('alert_id'), s.get('name'))
    return names


def in_band(hz):
    return hz is not None and BAND[0] <= hz < BAND[1]


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    return (xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2) if n else None


def slots(own):
    """Each day's three-hourly reports from Hillcrest's gauge or battery: heard or not."""
    heard = {(r['t'].date(), r['t'].hour) for r in own if r['t'].minute in (34, 35) and r['t'].hour in SLOT_HOURS}
    days, d = [], SLOTS_FROM
    while d < END:
        days.append((d.date(), [(d.date(), h) in heard for h in SLOT_HOURS]))
        d += timedelta(days=1)
    return days


def slot_share(days, a, b):
    got = [ok for day, g in days for h, ok in zip(SLOT_HOURS, g)
           if a <= datetime.combine(day, datetime.min.time()) + timedelta(hours=h, minutes=34) < b]
    return sum(got), len(got)


# ── Drawing ──────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s), quote=True)


def fmt(n):
    return f'{n:,}'


def term(text, key=None):
    return f'<span class="term" title="{esc(TERMS[key or text])}">{esc(text)}</span>'


def carrier_chart(carriers):
    """Figure 1: bursts on 151.500 by carrier offset, and the addresses only one repeater relays."""
    W, L, R, T, ph1, gap, ph2 = 720, 44, 10, 20, 84, 30, 54
    lo, hi = -400, 460
    h = T + ph1 + gap + ph2 + 30
    X = lambda hz: L + (W - L - R) * (hz - lo) / (hi - lo)
    bw = (W - L - R) * 20 / (hi - lo) - 1.2
    sel = [c for c in carriers if lo <= c['hz'] < hi]
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Bursts on 151.500 MHz by carrier '
           'offset: one tall peak from +120 to +240 Hz, Hillcrest\'s. Below, the addresses only Hillcrest relays '
           'come on that peak; those only Constitution Hill relays are scattered thinly everywhere">']
    top = 8000
    Y = lambda v: T + ph1 * (1 - min(v, top) / top)
    for v in range(0, top + 1, 2000):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{fmt(v)}</text>')
    out.append(f'<text class="key strong" x="{L + 6}" y="{T + 4}">Every burst with a carrier measured</text>')
    for c in sel:
        cls = 'bar tw' if in_band(c['hz']) else 'bar'
        title = (f'{c["hz"]:+d} to {c["hz"] + 20:+d} Hz: {fmt(c["dec"])} bursts, {c["own"]} from Hillcrest\'s own '
                 f'sensors; {c["same"]} corrupted copies read from the same burst, {c["sep"]} in their own')
        out.append(f'<g><title>{esc(title)}</title><rect class="{cls}" x="{X(c["hz"]) + 0.6:.1f}" y="{Y(c["dec"]):.1f}" '
                   f'width="{bw:.1f}" height="{Y(0) - Y(c["dec"]):.1f}"/></g>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/>')
    peak = max(sel, key=lambda c: c['dec'])
    out.append(f'<text class="note" x="{X(peak["hz"]) + 16:.1f}" y="{Y(peak["dec"]) + 10:.1f}">Hillcrest\'s carrier, '
               f'+120 to +240 Hz</text>')
    y0 = T + ph1 + gap + ph2
    top2 = 420
    Y2 = lambda v: y0 - ph2 * min(v, top2) / top2
    for v in (0, 400):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y2(v):.1f}" y2="{Y2(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y2(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="key strong" x="{L + 6}" y="{y0 - ph2 - 6}">Addresses only one repeater relays on '
               f'this channel</text>')
    hw = bw / 2
    for c in sel:
        for k, (v, cls, who) in enumerate(((c['hc_only'], 'bar tw', 'only Hillcrest relays'),
                                           (c['ch_only'], 'bar cmp', 'only Constitution Hill relays'))):
            if not v:
                continue
            title = f'{c["hz"]:+d} to {c["hz"] + 20:+d} Hz: {v} bursts from addresses {who}'
            out.append(f'<g><title>{esc(title)}</title><rect class="{cls}" x="{X(c["hz"]) + 0.6 + k * hw:.1f}" '
                       f'y="{Y2(v):.1f}" width="{hw:.1f}" height="{y0 - Y2(v):.1f}"/></g>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{y0}" y2="{y0}"/>')
    alford = max((c for c in sel if c['hz'] >= 320), key=lambda c: c['hc_only'])
    out.append(f'<text class="note" x="{X(alford["hz"]) - 4:.1f}" y="{Y2(alford["hc_only"]) + 8:.1f}" '
               f'text-anchor="end">Mt Alford AL, heard direct</text>')
    out.append(f'<text class="note" x="{X(-200):.1f}" y="{Y2(60):.1f}" text-anchor="middle">Constitution Hill\'s: '
               f'thin, everywhere</text>')
    for hz in range(-400, hi + 1, 100):
        out.append(f'<text class="tick" x="{X(hz):.1f}" y="{h - 12}" text-anchor="middle">'
                   f'{"+" if hz > 0 else ""}{hz}</text>')
    lx = W - R - 300
    for cls, text in (('tw', 'only Hillcrest relays'), ('cmp', 'only Constitution Hill relays')):
        out.append(f'<rect class="bar {cls}" x="{lx}" y="{y0 - ph2 - 15}" width="9" height="9" rx="2"/>'
                   f'<text class="key" x="{lx + 13}" y="{y0 - ph2 - 7}">{esc(text)}</text>')
        lx += 130
    out.append(f'<text class="tick" x="{W - R}" y="{h - 1}" text-anchor="end">carrier offset, Hz</text>'
               f'<text class="tick" x="0" y="{T - 8}">bursts</text></svg>')
    return '\n'.join(out)


def timeline_chart(blocks, levels):
    """Figure 2: bursts each three hours on Hillcrest's carrier and the others, and how strongly we heard them."""
    W, L, R, T, ph1, gap, ph2 = 720, 44, 10, 22, 74, 18, 48
    h = T + ph1 + gap + ph2 + 26
    span = (END - START).total_seconds()
    X = lambda t: L + (W - L - R) * (t - START).total_seconds() / span
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Bursts every three hours from 22 '
           'October to 3 November on Hillcrest\'s carrier, never none, and on the channel\'s other carriers; '
           'below, the signal-to-noise of both falls together from the evening of 24 October and recovers on the '
           'afternoon of 2 November">']
    for y0, ph in ((T, ph1), (T + ph1 + gap, ph2)):
        out.append(f'<rect class="quiet" x="{X(WEAK_FROM):.1f}" y="{y0}" width="{X(WEAK_TO) - X(WEAK_FROM):.1f}" '
                   f'height="{ph}"/>')
    top = math.log10(2000)
    Y = lambda v: T + ph1 * (1 - math.log10(max(v, 1)) / top)
    for v in (1, 10, 100, 1000):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{fmt(v)}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 10}">bursts in 3 h</text>')
    bw = X(START + timedelta(hours=3)) - X(START) - 0.8
    for b in blocks:
        title = (f'{b["a"]:%d %b %H:%M}–{b["a"] + timedelta(hours=3):%H:%M}: {fmt(b["hc"])} on Hillcrest\'s carrier, '
                 f'{fmt(b["oth"])} on other carriers, {fmt(b["none"])} with none measured; its gauge {b["gauge"]}')
        out.append(f'<g><title>{esc(title)}</title><rect class="bar tw" x="{X(b["a"]) + 0.4:.1f}" y="{Y(b["hc"]):.1f}" '
                   f'width="{bw:.1f}" height="{Y(1) - Y(b["hc"]):.1f}"/></g>')
    d_path = ''.join(f'{"M" if i == 0 else "L"}{X(b["a"]):.1f} {Y(b["oth"]):.1f}H{X(b["a"] + timedelta(hours=3)):.1f}'
                     for i, b in enumerate(blocks))
    out.append(f'<path class="line cmp" d="{d_path}"/>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(1):.1f}" y2="{Y(1):.1f}"/>')
    out.append(f'<text class="note" x="{X(WEAK_FROM) + 4:.1f}" y="{T + 9}">our receiver hears the channel weaker</text>')
    y0 = T + ph1 + gap
    lo, hi = 8, 13
    Y2 = lambda v: y0 + ph2 * (1 - (min(max(v, lo), hi) - lo) / (hi - lo))
    for v in range(lo, hi + 1):
        if v % 2 == 0:
            out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y2(v):.1f}" y2="{Y2(v):.1f}"/>'
                       f'<text class="tick" x="{L - 5}" y="{Y2(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{y0 - 6}">signal-to-noise, dB (median)</text>')
    for k, cls in (('os', 'line cmp'), ('hs', 'line tw')):
        pts = [(X(l['a'] + timedelta(hours=1.5)), Y2(l[k])) for l in levels if l[k] is not None]
        out.append(f'<path class="{cls}" d="{"".join(f"{chr(77) if i == 0 else chr(76)}{x:.1f} {y:.1f}" for i, (x, y) in enumerate(pts))}"/>')
    d = START
    while d < END:
        out.append(f'<text class="tick" x="{X(d + timedelta(hours=12)):.1f}" y="{h - 10}" text-anchor="middle">{d.day}</text>')
        if d > START:
            out.append(f'<line class="grid faint" x1="{X(d):.1f}" x2="{X(d):.1f}" y1="{y0 + ph2}" y2="{y0 + ph2 + 4}"/>')
        d += timedelta(days=1)
    out.append(f'<text class="tick" x="{L - 5}" y="{h - 10}" text-anchor="end">Oct</text>')
    out.append(f'<text class="tick" x="{X(datetime(2026, 11, 1)):.1f}" y="{h}" text-anchor="start">Nov</text>')
    lx = W - R - 290
    for cls, text in (('tw', 'Hillcrest\'s carrier'), ('cmp', 'the channel\'s other carriers')):
        out.append(f'<line class="line {cls}" x1="{lx}" x2="{lx + 16}" y1="{T - 12}" y2="{T - 12}"/>'
                   f'<text class="key" x="{lx + 21}" y="{T - 8.5}">{esc(text)}</text>')
        lx += 120
    out.append('</svg>')
    return '\n'.join(out)


def slot_strip(days):
    """Figure 3: Hillcrest's three-hourly reports, heard or missed, each day."""
    cw, ch, L, T = 8, 9, 26, 14
    W, h = L + cw * len(days) + 4, T + ch * len(SLOT_HOURS) + 30
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Hillcrest\'s three-hourly reports, '
           '7 October to 3 November: nearly every one heard until 24 October, fewer than half from then until 2 '
           'November, most again after">']
    for j, hr in enumerate(SLOT_HOURS):
        if j % 2 == 0:
            out.append(f'<text class="tick" x="{L - 4}" y="{T + j * ch + 7.5}" text-anchor="end">{hr:02d}h</text>')
    for i, (day, got) in enumerate(days):
        x = L + i * cw
        for j, ok in enumerate(got):
            title = f'{day:%d %b} {SLOT_HOURS[j]:02d}:34 — {"heard" if ok else "missed"}'
            out.append(f'<g><title>{esc(title)}</title><rect class="cell {"ok" if ok else "miss"}" x="{x + 0.5}" '
                       f'y="{T + j * ch + 0.5}" width="{cw - 1}" height="{ch - 1}" rx="1.5"/></g>')
        if day.day in (7, 14, 21, 28) or day.day == 1:
            out.append(f'<text class="tick" x="{x + cw / 2:.1f}" y="{T + ch * len(SLOT_HOURS) + 11}" '
                       f'text-anchor="middle">{day.day}</text>')
    for t in (WEAK_FROM, WEAK_TO):
        xq = L + (t.date() - SLOTS_FROM.date()).days * cw + cw * (t.hour + t.minute / 60) / 24
        out.append(f'<line class="mark" x1="{xq:.1f}" x2="{xq:.1f}" y1="{T - 4}" y2="{T + ch * len(SLOT_HOURS) + 2}"/>')
    lx = L
    for cls, text in (('ok', 'heard'), ('miss', 'missed')):
        out.append(f'<rect class="cell {cls}" x="{lx}" y="{h - 10}" width="8" height="8" rx="1.5"/>'
                   f'<text class="key" x="{lx + 12}" y="{h - 3}">{text}</text>')
        lx += 58
    out.append('</svg>')
    return '\n'.join(out)


def snr_chart(snr):
    """Figure 4: corrupted copies per 1,000 decoded, by signal-to-noise."""
    W, h, L, R, T, B = 380, 196, 30, 8, 34, 30
    pw, ph = W - L - R, h - T - B
    ss = sorted({r['s'] for r in snr})
    X = lambda s: L + pw * (s - ss[0]) / (ss[-1] - ss[0])
    top = 60
    Y = lambda v: T + ph * (1 - min(v, top) / top)
    out = [f'<svg class="fig" viewBox="0 0 {W} {h}" role="img" aria-label="Corrupted copies per 1,000 decoded by '
           'signal-to-noise: copies read from the same burst fall as the signal strengthens, and are fewer on '
           'Hillcrest\'s carrier than on the others; copies in their own burst stay low and flat">']
    for v in range(0, top + 1, 20):
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 5}" y="{Y(v) + 3.5:.1f}" text-anchor="end">{v}</text>')
    out.append(f'<text class="tick" x="0" y="{T - 22}">per 1,000</text>')
    by = {(r['s'], r['c']): r for r in snr}
    series = (('other', 'same', 'line cmp', 'Others, read two ways'),
              ('hillcrest', 'same', 'line tw', 'Hillcrest, read two ways'),
              ('hillcrest', 'sep', 'line tw dash', 'Hillcrest, own burst'))
    for c, k, cls, name in series:
        pts = [(s, 1000 * by[(s, c)][k] / by[(s, c)]['dec']) for s in ss if (s, c) in by and by[(s, c)]['dec']]
        out.append(f'<path class="{cls}" d="{"".join(f"{chr(77) if i == 0 else chr(76)}{X(s):.1f} {Y(v):.1f}" for i, (s, v) in enumerate(pts))}"/>')
        for s, v in pts:
            r = by[(s, c)]
            title = f'{name}, {s} dB: {r[k]} of {fmt(r["dec"])} decoded, {v:.1f} per 1,000'
            out.append(f'<g><title>{esc(title)}</title><circle class="dot {cls.split()[1]}" cx="{X(s):.1f}" '
                       f'cy="{Y(v):.1f}" r="2.6"/></g>')
    for s in ss:
        lab = f'≤{s}' if s == ss[0] else (f'{s}+' if s == ss[-1] else str(s))
        out.append(f'<text class="tick" x="{X(s):.1f}" y="{T + ph + 13}" text-anchor="middle">{lab}</text>')
    out.append(f'<text class="tick" x="{W - R}" y="{h - 2}" text-anchor="end">signal-to-noise, dB</text>')
    out.append(f'<line class="axis" x1="{L}" x2="{W - R}" y1="{Y(0):.1f}" y2="{Y(0):.1f}"/>')
    ly = T - 26
    for i, (c, k, cls, name) in enumerate(series):
        lx = L + 40 + (i % 2) * 150
        yy = ly + (i // 2) * 12
        out.append(f'<line class="{cls}" x1="{lx}" x2="{lx + 14}" y1="{yy}" y2="{yy}"/>'
                   f'<text class="key" x="{lx + 18}" y="{yy + 3.5}">{esc(name)}</text>')
    out.append('</svg>')
    return '\n'.join(out)


# ── The page ─────────────────────────────────────────────────────────────────

def pct(a, b, d=1):
    return f'{100 * a / b:.{d}f}'


def main():
    carriers, addresses, blocks, levels, snr, checked, separate, pairs, own, credited, tx = load()
    names = station_names()

    # Whose carrier: addresses only Hillcrest relays, and only Constitution Hill does.
    hc, oth, none = checked['hillcrest'], checked['other'], checked['no_carrier']
    with_carrier = hc['dec'] + oth['dec']
    everything = with_carrier + none['dec']
    hco = [a for a in addresses if a['g'] == 'hillcrest_only']
    cho = [a for a in addresses if a['g'] == 'constitution_only']
    hco_on = [a for a in hco if a['on'] > a['off']]
    hco_off = [a for a in hco if a['on'] <= a['off']]
    cho_on_n, cho_all_n = sum(a['on'] for a in cho), sum(a['on'] + a['off'] for a in cho)
    hco_on_n, hco_all_n = sum(a['on'] for a in hco), sum(a['on'] + a['off'] for a in hco)
    own_band = sum(c['own'] for c in carriers if in_band(c['hz']))
    own_all = sum(c['own'] for c in carriers)
    alford = sorted({names.get(a['a'], '?') for a in hco_off if a['on'] + a['off'] >= 50})
    hco_rare = sum(1 for a in hco_off if a['on'] + a['off'] < 10)

    # How the carrier table credited it.
    cred_others = [c for c in credited if c['tx'] != 'st:hillcrest_wine_glass']
    cred_n, cred_bursts = len(cred_others), sum(c['n'] for c in cred_others)
    cred_named = sum(1 for c in cred_others if c['tx'].startswith('st:'))
    cred_rep = sum(1 for c in credited if c['how'] != 'own')
    hill_cred = next(c['n'] for c in credited if c['tx'] == 'st:hillcrest_wine_glass')

    # Never off air.
    bmin = min(blocks, key=lambda b: b['hc'])
    days = slots(own)
    sa = slot_share(days, SLOTS_FROM, WEAK_FROM)
    sb = slot_share(days, WEAK_FROM, WEAK_TO)
    sc = slot_share(days, WEAK_TO, END)
    reports = sorted({r['t'] for r in own})
    g1 = max((b - a, a, b) for a, b in zip(reports, reports[1:]))
    in_gap = sum(b['hc'] for b in blocks if b['a'] >= g1[1] and b['a'] + timedelta(hours=3) <= g1[2])

    def lv(a, b, k):
        return median([l[k] for l in levels if a <= l['a'] < b and l[k] is not None])
    hs_a, hs_b, hs_c = lv(START, WEAK_FROM, 'hs'), lv(WEAK_FROM, WEAK_TO, 'hs'), lv(WEAK_TO, END, 'hs')
    os_a, os_b, os_c = lv(START, WEAK_FROM, 'os'), lv(WEAK_FROM, WEAK_TO, 'os'), lv(WEAK_TO, END, 'os')
    pre = datetime(2026, 10, 24)                       # the day before the change, one gain setting
    nf_a, nf_b, nf_c = lv(pre, WEAK_FROM, 'nf'), lv(WEAK_FROM, WEAK_TO, 'nf'), lv(WEAK_TO, END, 'nf')
    lv_a, lv_b, lv_c = lv(pre, WEAK_FROM, 'lv'), lv(WEAK_FROM, WEAK_TO, 'lv'), lv(WEAK_TO, END, 'lv')


    # Battery: its three-hourly reports, by day and by night.
    batt = [r for r in own if r['a'] == 6201 and not r['copy'] and r['t'].minute in (34, 35) and 120 <= r['v'] <= 145]
    b_day = median([r['v'] for r in batt if r['t'].hour in (9, 12, 15)]) / 10
    b_night = median([r['v'] for r in batt if r['t'].hour in (21, 0, 3)]) / 10

    # The corruption on its carrier.
    hc_bad = hc['sep'] + hc['same']
    by = {(r['s'], r['c']): r for r in snr}
    lower = [s for s in sorted({r['s'] for r in snr})
             if by[(s, 'hillcrest')]['same'] / by[(s, 'hillcrest')]['dec'] < by[(s, 'other')]['same'] / by[(s, 'other')]['dec']]
    k9h = 1000 * by[(9, 'hillcrest')]['same'] / by[(9, 'hillcrest')]['dec']
    k9o = 1000 * by[(9, 'other')]['same'] / by[(9, 'other')]['dec']
    k12h = 1000 * by[(12, 'hillcrest')]['same'] / by[(12, 'hillcrest')]['dec']
    k12o = 1000 * by[(12, 'other')]['same'] / by[(12, 'other')]['dec']
    sep_k = [1000 * by[(s, 'hillcrest')]['sep'] / by[(s, 'hillcrest')]['dec'] for s in range(8, 14)]
    ph, po = pairs['hillcrest'], pairs['other']

    def checked_rate(g):
        x = checked[g]
        return x['sep'], x['twin'] + x['sep'], 100 * x['sep'] / (x['twin'] + x['sep'])
    c_hc, c_oth, c_525 = checked_rate('hillcrest'), checked_rate('other'), checked_rate('151.525')

    # What is Hillcrest's: the copies corrupted in a burst of their own.
    assert len(separate) == hc['sep'], (len(separate), hc['sep'])
    by_addr = defaultdict(int)
    for s in separate:
        by_addr[s['ta']] += 1
    top_addr, top_n = max(by_addr.items(), key=lambda kv: kv[1])
    twin = defaultdict(int)
    for s in separate:
        twin[s['twin']] += 1
    dsnr = median([s['snr'] - s['tsnr'] for s in separate if s['snr'] is not None and s['tsnr'] is not None])
    vflip = [s for s in separate if s['ta'] == s['ba'] and s['tv'] != s['bv']]
    raised = sum(1 for s in vflip if s['bv'] > s['tv'])
    high = sum(1 for s in vflip if all(1 << b >= 64 for b in range(11) if ((s['tv'] ^ s['bv']) >> b) & 1))
    addr_flips = sum(1 for s in separate if s['ta'] != s['ba'])

    tx_bursts, tx_bad, tx_clear = int(tx['bursts']), int(tx['corrupted']), int(tx['clear'])
    fleet = 100 * float(tx['fleet_rate'])
    judged = datetime.fromisoformat(tx['judged_at'])

    print(f'carrier: {hc["dec"]} of {with_carrier} with a carrier ({pct(hc["dec"], with_carrier, 0)}%), '
          f'{pct(hc["dec"], everything, 0)}% of all; hillcrest-only {len(hco_on)}/{len(hco)} addresses on it; '
          f'constitution-only {cho_on_n}/{cho_all_n} bursts on it')
    print(f'credited: {cred_n} transmitters ({cred_named} named), {cred_bursts} bursts, as heard direct; '
          f'Hillcrest {hill_cred}; via a repeater {cred_rep}')
    print(f'blocks: min {bmin["hc"]} at {bmin["a"]}; slots {sa} {sb} {sc}; longest gap {g1[0]} from {g1[1]}, '
          f'{in_gap} relayed meanwhile')
    print(f'snr medians: hillcrest {hs_a}/{hs_b}/{hs_c}, other {os_a}/{os_b}/{os_c}; floor {nf_a}/{nf_b}/{nf_c}, '
          f'level {lv_a}/{lv_b}/{lv_c}')
    print(f'corrupted on its carrier {hc_bad} ({pct(hc_bad, hc["dec"])}%), same burst {hc["same"]}; '
          f'checked {c_hc}, other {c_oth}, 151.525 {c_525}; same-burst lower at {lower}')
    print(f'separate: {len(separate)}, top {top_addr} ({names.get(top_addr)}) {top_n}, twins {dict(twin)}, dsnr {dsnr}, '
          f'value flips {len(vflip)} raised {raised} high {high}; battery day {b_day} night {b_night}')

    fig1 = carrier_chart(carriers)
    fig2 = timeline_chart(blocks, levels)
    fig3 = slot_strip(days)
    fig4 = snr_chart(snr)
    key = ''.join(f'<dt>{esc(k[0].upper() + k[1:])}</dt><dd>{esc(v)}</dd>' for k, v in TERMS.items())

    def when(t):
        return f'{t:%H:%M} on {t.day} {t:%B}'

    page = TEMPLATE
    for k, v in dict(
        FIG1=fig1, FIG2=fig2, FIG3=fig3, FIG4=fig4, KEY=key,
        T_CARRIER=term('carrier offset'), T_PASS=term('pass ranges', 'pass range'),
        T_COPIES=term('corrupted copies', 'corrupted copy'), T_TWO=term('one burst read two ways'),
        T_OWN=term('in a burst of their own', 'own burst'), T_SNR=term('signal-to-noise'), T_VOTES=term('votes'),
        T_CHECKED=term('relays we could check', 'checked'), T_CLEAR=term('clear'),
        T_SLOT=term('three-hourly reports', 'three-hourly report'),
        HC_DEC=fmt(hc['dec']), WITH=fmt(with_carrier), SHARE=pct(hc['dec'], with_carrier, 0),
        SHARE_ALL=pct(hc['dec'], everything, 0), DAYS=(END - START).days,
        HCO_ON=len(hco_on), HCO_N=len(hco), ALFORD=' and '.join(alford),
        HCO_RARE={1: 'one address', 2: 'two addresses'}.get(hco_rare, f'{hco_rare} addresses'),
        CHO_N=len(cho), CHO_ON=cho_on_n, CHO_ALL=cho_all_n, CHO_PCT=pct(cho_on_n, cho_all_n, 0),
        OWN_BAND=own_band, OWN_ALL=own_all,
        CRED_N=cred_n, CRED_NAMED=cred_named, CRED_BURSTS=fmt(cred_bursts), HILL_CRED=hill_cred,
        BLOCKS=len(blocks), BMIN=bmin['hc'], BMIN_AT=f'{bmin["a"]:%H:%M} on {bmin["a"].day} {bmin["a"]:%B}',
        SA=pct(*sa, 0), SB=pct(*sb, 0), SC=pct(*sc, 0), SA_N=f'{sa[0]} of {sa[1]}', SB_N=f'{sb[0]} of {sb[1]}',
        SC_N=f'{sc[0]} of {sc[1]}',
        GAP_H=round(g1[0].total_seconds() / 3600), GAP_FROM=when(g1[1]), IN_GAP=in_gap,
        HS_A=f'{hs_a:.1f}', HS_B=f'{hs_b:.1f}', HS_C=f'{hs_c:.1f}', OS_A=f'{os_a:.1f}', OS_B=f'{os_b:.1f}',
        OS_C=f'{os_c:.1f}', HS_DROP=f'{hs_a - hs_b:.1f}', OS_DROP=f'{os_a - os_b:.1f}',
        NF_UP=f'{nf_b - nf_a:.1f}', LV_UP=f'{lv_b - lv_a:.1f}', NF_UP2=f'{nf_c - nf_b:.1f}', LV_UP2=f'{lv_c - lv_b:.1f}',
        B_DAY=f'{b_day:.1f}', B_NIGHT=f'{b_night:.1f}',
        TX_BAD=tx_bad, TX_BURSTS=tx_bursts, TX_PCT=pct(tx_bad, tx_bursts), TX_CLEAR=tx_clear, FLEET=f'{fleet:.2f}',
        JUDGED=f'{judged:%H:%M} on {judged.day} {judged:%B}',
        HC_BAD=fmt(hc_bad), HC_BAD_PCT=pct(hc_bad, hc['dec']), SAME=hc['same'], SAME_PCT=pct(hc['same'], hc_bad, 0),
        LOWER_LO=lower[0], LOWER_HI=lower[-1],
        K9H=f'{k9h:.0f}', K9O=f'{k9o:.0f}', K12H=f'{k12h:.0f}', K12O=f'{k12o:.0f}',
        SEPK_LO=f'{min(sep_k):.0f}', SEPK_HI=f'{max(sep_k):.0f}',
        P_N=ph['n'], P_FEWER=ph['fewer'], P_FEWER_PCT=pct(ph['fewer'], ph['n'], 0), P_BV=f'{ph["bv"]:.0f}',
        P_GV=f'{ph["gv"]:.0f}', PO_FEWER_PCT=pct(po['fewer'], po['n'], 0),
        SEP=c_hc[0], SEP_OF=fmt(c_hc[1]), SEP_PCT=f'{c_hc[2]:.1f}', OTH_SEP=c_oth[0], OTH_OF=fmt(c_oth[1]),
        OTH_PCT=f'{c_oth[2]:.1f}', S525=c_525[0], S525_OF=fmt(c_525[1]), S525_PCT=f'{c_525[2]:.1f}',
        SEP_ALL_PCT=pct(hc['sep'], hc['dec']), RATIO=f'{c_hc[2] / c_oth[2]:.0f}',
        SEP_ADDRS=len(by_addr), TOP_N=top_n, TOP_NAME=esc(names.get(top_addr, f'address {top_addr}')),
        TW_HC=twin['hillcrest'], TW_OTH=twin['other'], TW_NONE=twin['none'], DSNR=f'{abs(dsnr):.1f}',
        DSNR_WORD='weaker' if dsnr < 0 else 'stronger', VFLIP=len(vflip), RAISED=raised, HIGH=high,
        ADDR_FLIPS=addr_flips,
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
  <title>Hillcrest (Wine Glass) — Flood-Net investigation 03</title>
  <meta name="description" content="Hillcrest AL (Wine Glass), flagged as corrupting 70.8% of what it sent and as off air, is the busiest relay Flood-Net hears on 151.500 MHz, never went off air, and corrupts about 1.6% of what can be checked.">
  <link rel="canonical" href="https://floodwarning.net/investigations/2026-11-hillcrest-wine-glass">
  <link rel="icon" type="image/svg+xml" href="../assets/icon-small.svg">
  <!-- Generated by tools/investigations/hillcrest_wine_glass.py from the
       eleven exports in data/investigations/2026-11-hillcrest-wine-glass/
       (queries in tools/investigations/hillcrest_wine_glass.sql): edit the
       script and run it again rather than this file. Self-contained like
       about.html: no script, no font, no stylesheet to fetch; two A4 pages
       printed. No ?v= stamp: sw.js keeps none of this, and the icon is the
       only thing it loads. -->
  <style>
    :root {
      color-scheme: light;
      --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --bg: #ffffff; --panel: #f6f7f8;
      --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab;
      --s1: #2a78d6; --s2: #eb6834; --quiet: rgba(137,135,129,.12); --miss: #e9e8e2;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
        --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
        --s1: #3987e5; --s2: #d95926; --quiet: rgba(195,194,183,.10); --miss: #2c2c2a;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --bg: #121212; --panel: #1a1a19;
      --line: #2c2c2a; --axis: #383835; --brand: #6fb4ff;
      --s1: #3987e5; --s2: #d95926; --quiet: rgba(195,194,183,.10); --miss: #2c2c2a;
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
    .row { display: grid; grid-template-columns: 252px 1fr; gap: 1rem; align-items: start; }
    .row.wide { grid-template-columns: 1fr 380px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
    @media (max-width: 620px) { .row, .row.wide, .two { grid-template-columns: 1fr; } }
    ol { margin: .25rem 0; padding-left: 1.2rem; }
    li { margin: .15rem 0; }
    table.tally { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: .3rem 0 .2rem;
                  font-variant-numeric: tabular-nums; }
    table.tally caption { text-align: left; font-size: 12px; color: var(--ink-2); caption-side: bottom; padding-top: .2rem; }
    table.tally th, table.tally td { padding: .18rem .4rem; border-bottom: 1px solid var(--line); text-align: right; }
    table.tally th:first-child, table.tally td:first-child { text-align: left; }
    table.tally thead th { color: var(--ink-2); font-weight: 600; border-bottom: 1px solid var(--axis); }
    table.tally tr.hl td { font-weight: 600; }
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
    .mark { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
    .quiet { fill: var(--quiet); }
    .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .line.tw { stroke: var(--s2); } .line.cmp { stroke: var(--muted); stroke-width: 1.5; }
    .line.dash { stroke-dasharray: 4 3; }
    .dot.tw { fill: var(--s2); } .dot.cmp { fill: var(--muted); }
    .bar { fill: var(--s1); } .bar.tw { fill: var(--s2); } .bar.cmp { fill: var(--muted); }
    .cell.ok { fill: var(--s1); } .cell.miss { fill: var(--miss); }
    .sheet + .sheet { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    @page { size: A4; margin: 9mm 10mm; }
    @media print {
      :root { color-scheme: light; --ink: #0b0b0b; --ink-2: #52514e; --bg: #ffffff; --panel: #f6f7f8;
              --line: #e1e0d9; --axis: #c3c2b7; --brand: #0b5cab; --s1: #2a78d6; --s2: #eb6834;
              --quiet: rgba(137,135,129,.12); --miss: #e9e8e2; }
      body { padding: 0; font-size: 8.5pt; line-height: 1.32; }
      h1 { font-size: 15pt; }
      h2 { font-size: 10.5pt; margin: .5rem 0 .15rem; }
      p { margin: .2rem 0; }
      figure { margin: .25rem 0 .3rem; }
      figcaption { font-size: 8pt; }
      .tldr { padding: .35rem .7rem; margin: .35rem 0 .3rem; }
      .tldr li { margin: .1rem 0; }
      .meta { margin-bottom: .3rem; }
      .small { font-size: 7.6pt; }
      table.tally { font-size: 8pt; }
      .term { text-decoration: none; }
      footer { margin-top: .4rem; padding-top: .3rem; }
      main { max-width: none; }
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }
      .sheet + .sheet { margin-top: 0; padding-top: 0; border-top: 0; }
      figure, .tldr, dl.key, table.tally { break-inside: avoid; }
      dl.key { grid-template-columns: max-content 1fr max-content 1fr; gap: .05rem .5rem; }
      a { color: inherit; text-decoration: none; }
      .crumb { display: none; }
      .row { grid-template-columns: 215px 1fr; }
      .row.wide { grid-template-columns: 1fr 270px; }
    }
  </style>
</head>
<body>
<main>
<section class="sheet">
  <p class="crumb"><a href="./">Investigations</a> · <a href="../">Flood-Net</a></p>
  <h1>Hillcrest (Wine Glass): our busiest relay, and why it looked like our worst</h1>
  <p class="meta">Investigation 03 · 4 November 2026 · Hillcrest AL (Wine Glass) (540235, rain 6200, battery 6201),
    repeater on 151.500 MHz, Brisbane hub · <span class="pill">Open: critical flag not borne out, a small fault
    remains</span></p>

  <div class="tldr">
    <ul>
      <li><strong>Hillcrest brings us most of 151.500.</strong> {{SHARE}}% of the bursts we measured a carrier for
        over {{DAYS}} days came on its carrier, near +170 Hz. The addresses only it relays come there; the ones only
        Constitution Hill relays don't.</li>
      <li><strong>It never went off air.</strong> Every three-hour block had bursts on its carrier. From 24 October
        to 2 November our receiver heard the whole channel about {{OS_DROP}} dB nearer the noise. Hillcrest reaches
        us weaker than most, so it lost the most: its gauge's {{T_SLOT}} went from {{SA}}% heard to {{SB}}%, then
        back to {{SC}}%.</li>
      <li><strong>"{{TX_PCT}}% corrupted" is a counting error.</strong> It divides {{TX_BAD}} {{T_COPIES}} by only
        the {{TX_BURSTS}} bursts credited to Hillcrest itself. On its whole carrier the share is {{HC_BAD_PCT}}%,
        and {{SAME_PCT}}% of those were {{T_TWO}} by our own decoder.</li>
      <li><strong>What's left is small but real.</strong> {{SEP_PCT}}% of the {{T_CHECKED}} came through damaged,
        against {{OTH_PCT}}% on the channel's other carriers. That damage was done before the burst reached us.</li>
    </ul>
  </div>

  <h2>Whose carrier it is</h2>
  <figure>
    <div class="scroll">{{FIG1}}</div>
    <figcaption>Figure 1. Bursts on 151.500 MHz by {{T_CARRIER}}, 22 October to 3 November, in 20 Hz steps (a small
      group near +2.5 kHz is left out). Below: only the addresses one repeater relays on this channel. Hover a bar
      for its counts.</figcaption>
  </figure>
  <p>{{SHARE}}% of the bursts with a carrier measured, and {{SHARE_ALL}}% of all we decoded on the channel, came on
    one carrier between +120 and +240 Hz. Hillcrest's {{T_PASS}} overlap Constitution Hill's almost entirely, but
    two groups of addresses tell them apart. {{HCO_ON}} of the {{HCO_N}} addresses only Hillcrest relays here came
    mostly on this carrier. The exceptions are {{ALFORD}}, heard direct near +380 Hz, and {{HCO_RARE}} heard fewer
    than ten times. Of {{CHO_ALL}} bursts from addresses only Constitution Hill relays, {{CHO_ON}} ({{CHO_PCT}}%)
    fell there, about what any 120 Hz of their spread holds. {{OWN_BAND}} of {{OWN_ALL}} reports from Hillcrest's
    own gauge and battery came on it too. Flood-Net's carrier table missed this. It credits {{CRED_BURSTS}} of these
    bursts to {{CRED_N}} transmitters as if each were heard direct, and Hillcrest with only its own
    {{HILL_CRED}}.</p>

  <h2>Never off air: our receiver heard the channel weaker</h2>
  <figure>
    <div class="scroll">{{FIG2}}</div>
    <figcaption>Figure 2. Top: bursts every three hours on Hillcrest's carrier (bars) and the channel's other
      carriers (line), log scale. Bottom: the median {{T_SNR}} of each. Shaded: the weaker spell.</figcaption>
  </figure>
  <div class="row">
    <figure>
      {{FIG3}}
      <figcaption>Figure 3. Hillcrest's {{T_SLOT}}, 7 October to 3 November. Dashed: 21:00 on 24 October and
        15:00 on 2 November.</figcaption>
    </figure>
    <div>
      <p>The quietest three hours on its carrier still had {{BMIN}} bursts. The "off air" Station Health saw was its
        gauge's longest silence, {{GAP_H}} hours from {{GAP_FROM}}, while the carrier relayed {{IN_GAP}}
        bursts.</p>
      <p>From the evening of 24 October the median signal-to-noise fell from {{HS_A}} to {{HS_B}} dB on Hillcrest's
        carrier, and from {{OS_A}} to {{OS_B}} dB on the others. They fell together, so the cause is something they
        share. At our receiver the noise floor rose {{NF_UP}} dB, and burst levels only {{LV_UP}} dB. On the
        afternoon of 2 November levels rose {{LV_UP2}} dB and the floor {{NF_UP2}} dB. The channel came part of the
        way back ({{HS_C}} and {{OS_C}} dB), and the gauge came back with it: the bulletin's "back on air". We heard
        {{SA_N}} of its reports before, {{SB_N}} during and {{SC_N}} after.</p>
    </div>
  </div>
</section>

<section class="sheet">
  <div class="row wide">
    <div>
      <h2>Most of the corruption is our decoder</h2>
      <p>Our receiver stamps every frame it decodes from a burst with the moment that burst ended. {{SAME}} of the
        corrupted copies on Hillcrest's carrier share that moment, to the millisecond, with their clean twin. They
        were never sent: each is one burst read two ways. In {{P_FEWER_PCT}}% of these pairs the wrong frame had
        fewer {{T_VOTES}} than the right one (median {{P_BV}} against {{P_GV}}). Our decoder drops a lookalike only
        when the real frame has three times its votes. The other carriers' pairs look the same
        ({{PO_FEWER_PCT}}%).</p>
      <p>The weaker the signal, the more often it happens (Figure 4). At every strength from {{LOWER_LO}} to
        {{LOWER_HI}} dB it happens less on Hillcrest's carrier than on the others: {{K9H}} per 1,000 against
        {{K9O}} at 9 dB. Station Health called {{TX_CLEAR}} of its {{TX_BAD}} copies {{T_CLEAR}}. But a copy from
        the same burst is always exactly as strong as its twin, so that test can't tell.</p>
    </div>
    <figure>
      {{FIG4}}
      <figcaption>Figure 4. Corrupted copies per 1,000 decoded on 151.500, by signal-to-noise. Hover a point for its
        counts.</figcaption>
    </figure>
  </div>

  <h2>What is Hillcrest's</h2>
  <p>{{SEP}} copies on its carrier were corrupted {{T_OWN}}, 0.3 to 5 seconds from a clean twin. The twin came on
    Hillcrest's carrier {{TW_HC}} times, on another {{TW_OTH}} times and with no carrier measured {{TW_NONE}} times.
    These hold at {{SEPK_LO}} to {{SEPK_HI}} per 1,000 from 8 to 13 dB; they don't rise as the signal weakens. The
    median copy was only {{DSNR}} dB {{DSNR_WORD}} than its twin. So the damage was done before the burst reached
    us. The copies are spread over {{SEP_ADDRS}} addresses, at most {{TOP_N}} from one station ({{TOP_NAME}}).
    {{RAISED}} of the {{VFLIP}} that changed only the value read high, and {{HIGH}} changed only its top bits. That
    is investigation 01's pattern: damage at the end of a frame, where no check bit sees it.</p>
  <table class="tally">
    <thead><tr><th>Counted</th><th>Corrupted</th><th>Out of</th><th>Share</th></tr></thead>
    <tbody>
      <tr><td>Station Health's figure, 7 days to {{JUDGED}}</td><td>{{TX_BAD}}</td><td>{{TX_BURSTS}} credited to it</td><td>{{TX_PCT}}%</td></tr>
      <tr><td>Everything on its carrier, 22 Oct to 3 Nov</td><td>{{HC_BAD}}</td><td>{{HC_DEC}}</td><td>{{HC_BAD_PCT}}%</td></tr>
      <tr><td>The same, without bursts read two ways</td><td>{{SEP}}</td><td>{{HC_DEC}}</td><td>{{SEP_ALL_PCT}}%</td></tr>
      <tr class="hl"><td>Relays on its carrier we could check</td><td>{{SEP}}</td><td>{{SEP_OF}}</td><td>{{SEP_PCT}}%</td></tr>
      <tr><td>The same, the channel's other carriers</td><td>{{OTH_SEP}}</td><td>{{OTH_OF}}</td><td>{{OTH_PCT}}%</td></tr>
      <tr><td>The same, 151.525 MHz (Toowoomba's channel, <a href="2026-10-toowoomba-quiet-week.html">02</a>)</td><td>{{S525}}</td><td>{{S525_OF}}</td><td>{{S525_PCT}}%</td></tr>
    </tbody>
    <caption>How the flag shrinks. Station Health compares {{TX_PCT}}% with {{FLEET}}% for a typical transmitter,
      counted its way.</caption>
  </table>

  <div class="two">
    <div>
      <h2>What we know</h2>
      <p><b>Established.</b> The carrier near +170 Hz is Hillcrest's. It was on air throughout and carries most of
        what we hear on 151.500. The {{TX_PCT}}% comes from counting only {{TX_BURSTS}} bursts. {{SAME_PCT}}% of the
        corrupted copies on its carrier were never sent.</p>
      <p><b>Likely.</b> The quiet spell of 25 October to 2 November was at our end: Hillcrest's signal and the
        others' fell and recovered together, in step with our receiver's own readings. Hillcrest damages
        {{SEP_PCT}}% of the relays we could check, about {{RATIO}} times the rate on the channel's other
        carriers.</p>
      <p><b>Open.</b> What changed at our receiver on 24 October: a setting, or noise near it. Whether the
        {{SEP_PCT}}% enters at Hillcrest's receiver or its transmitter. Why its battery reads {{B_NIGHT}} V at night
        and {{B_DAY}} V by day, with no solar charge showing.</p>
    </div>
    <div>
      <h2>Next</h2>
      <ol>
        <li>Fix Station Health's transmitter figures: count the whole carrier, and leave out bursts read two ways (or
          have the decoder drop a lookalike with fewer votes). The Bit-Flip Sources and Backbone tabs and the
          bulletins all read them.</li>
        <li>Teach the carrier table that +120 to +240 Hz on 151.500 is Hillcrest's. It now credits {{CRED_N}}
          transmitters there as heard direct.</li>
        <li>Find what raised our receiver's noise floor on 24 October, and keep the setting of 2 November.</li>
        <li>No urgent visit is needed. At the next one, check Hillcrest's power supply and its receive side.</li>
      </ol>
    </div>
  </div>

  <footer class="small">
    <p>Method: Flood-Net's receiver, legacy ALERT bursts on 151.500 MHz, 22 October to 3 November (Brisbane time),
      while carrier offsets were measured; Hillcrest's gauge from 7 October. A corrupted copy is one Flood-Net's
      checks found: a burst one or two bits from a real one, on the same receiver within five seconds. Hillcrest's
      carrier is +120 to +240 Hz. An address is Hillcrest's alone if it is in its pass ranges and in no other
      151.500 repeater's in the station register. Data, queries and script:
      <code>data/investigations/2026-11-hillcrest-wine-glass/</code>,
      <code>tools/investigations/hillcrest_wine_glass.sql</code>,
      <code>tools/investigations/hillcrest_wine_glass.py</code>.</p>
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
