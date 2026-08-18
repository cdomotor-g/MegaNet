#!/usr/bin/env python3
"""Mine the archive's Remarks prose into derived maintenance events (#127).

Reads #124's extraction (`data/inspections/inspections.jsonl`) and classifies
every visit remark — all of them, not a sample — into zero or more typed
events, each carrying the exact quote it was read from, a confidence tier and
the structured detail the shorthand genuinely supports. The output is:

    data/inspections/events.jsonl      one line per derived event
    data/inspections/events_report.json  the counts, and the reconciliation

## The discipline (from the issue, restated as rules of this file)

* **The remark is the record; an event is a reading of it.** Every event
  carries `quote` — the span it was read from — and nothing here ever edits,
  normalises or "repairs" the prose.
* **High precision over recall.** A rule that would misfile shorthand is not
  written; a remark nothing matches is `unclassified`, loudly counted, never
  forced. The confidence tiers are honest: `high` means the pattern is
  unambiguous field convention, `medium` means keyword plus corroborating
  context, and nothing ships as `low` — a low-confidence guess is spelled
  "unclassified" here.
* **The gas triplet is captured, not interpreted.** `17000/500/40` recurs in
  ~1,000 remarks and is obviously a convention — and its three positions are
  NOT labelled in the output, because the convention has not been confirmed
  with the network's operator. The numbers travel as `raw` and as an ordered
  list; naming them pressure/regulator/days (or anything else) is one line in
  this file the day the convention is confirmed on #127.

## Why rules rather than anything cleverer

The same reason `survey.py` and `extract.py` are deterministic: this file is
re-run by CI (`--check`) and a derivation nobody can re-derive identically is
a fixture, not a pipeline. Every event this writes can be traced to the rule
that wrote it (`rule` field) and re-produced from the committed artefacts.

Standard library only.

    python3 tools/ingest/remarks.py            # rewrite both artefacts
    python3 tools/ingest/remarks.py --check    # re-derive and diff (CI)
    python3 tools/ingest/remarks.py --sample N # print N stratified samples
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, 'data', 'inspections')

# The same namespace and derivation as load.py: an event's id is stable across
# runs and machines, so loading is an upsert and a re-run changes nothing.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL,
                       'https://github.com/cdomotor-g/MegaNet/inspection')

RULES_VERSION = 'rules-v1'

# ── The vocabulary ───────────────────────────────────────────────────────────
# One entry per event type the rules can assign. `note` is what the type means,
# stated once here and seeded into the migration from this same table — the
# 0009 pattern: one source of truth, not a parallel list.

EVENT_TYPES = {
    'equipment_replaced':  'A named piece of equipment was replaced, renewed or newly installed.',
    'equipment_fault':     'A named piece of equipment found faulty, blocked, leaking, unserviceable or otherwise wrong.',
    'calibration':         'A calibration, recalibration or adjustment was performed or recorded.',
    'gas_service':         'Gas system serviced: purge, bottle change, or the recurring N/N/N figures (convention unconfirmed — the numbers are captured, not named).',
    'commissioning':       'Station installed, commissioned, or upgraded from one configuration to another.',
    'decommissioning':     'Station decommissioned, closed or removed.',
    'whs_hazard':          'A workplace health and safety hazard: bees, wasps, snakes, ladder or access safety, electrical.',
    'vegetation':          'Vegetation encroachment or clearing: trees, shade on the panel or gauge, undergrowth.',
    'wildlife_intrusion':  'Wildlife in the works: ants, frogs, birds, spiders, termites, cattle.',
    'access_issue':        'Site could not be reached or entered: locked, no key, road, permission.',
    'site_damage':         'Damage to the site: flood, storm, lightning, vandalism, fire, theft, corrosion of structure.',
    'config_change':       'Radio or logger configuration changed or recorded: pass ranges, ALERT ids, check-signal rate, delays.',
}

# ── The equipment lexicon ────────────────────────────────────────────────────
# Spellings seen in the corpus, folded to one key each. Longest-first matching,
# so "solar panel" wins over "panel" and "gas bottle" over "gas".

EQUIPMENT = [
    ('solar panel',      r'solar\s+panel|solar\s+pannel|\bpanel\b|\bpannel\b'),
    ('solar regulator',  r'solar\s+reg(?:ulator)?\b|\breg(?:ulator)?\b(?=[^a-z]*(?:replaced|new|installed|u/s|faulty))'),
    ('battery',          r'\bbatt(?:ery|eries|s)?\b'),
    ('tbrg',             r'\btbrg\b|\brain\s*gauge\b|\br/g\b|\bpluvi(?:o|ometer)?\b'),
    ('druck',            r'\bdruck\b|pressure\s+transmitter|\bpt\b(?=[^a-z]*(?:replaced|new|u/s))'),
    ('canister',         r'\bcanister\b|\bcannister\b'),
    ('antenna',          r'\bantenna[e]?\b|\baerial\b|\bant\b(?!s)(?!\s*(?:bait|nest|cap|hill))'),
    ('logger',           r'\blogger\b|data\s*logger'),
    ('encoder',          r'\bencoder\b'),
    ('gauge board',      r'gauge\s*board|\bg/b\b'),
    ('gas bottle',       r'gas\s+bottle|\bcylinder\b|\bbottle\b'),
    ('bubble unit',      r'bubble\s+unit|\bbubbler\b'),
    ('feed tube',        r'feed\s+tube|capillary|\btube\b|\bolives?\b'),
    ('sensor',           r'\bsensor\b|greenspan|\bwl\s*3100\b|shaft\s+encoder'),
    ('radio',            r'\bradio\b|\btx\b(?=[^a-z]*(?:replaced|new|u/s))|transmitter(?!\s+card)'),
    ('mast/tower',       r'\bmast\b|\btower\b|\bpole\b|\bguy(?:s|\s+wires?)?\b'),
    ('enclosure',        r'\benclosure\b|\bcabinet\b|\bbox\b(?=[^a-z]*(?:replaced|new|damaged))'),
    ('mains supply',     r'mains\s+(?:power|supply)|\b240v\b'),
    ('firmware/software', r'\bf/?w\b|\bfirmware\b|\bsoftware\b|\bmodem\b|\beprom\b'),
    ('orifice',          r'\borifice\b'),
    ('cable/wiring',     r'\bcable\b|\bcoax\b|\bwiring\b|\bconnector\b|\bplug\b'),
]

EQUIP_RE = [(key, re.compile(pat, re.I)) for key, pat in EQUIPMENT]

# ── The rules ────────────────────────────────────────────────────────────────
# Each rule: (event_type, confidence, rule name, compiled pattern). Rules fire
# per *clause* — remarks chain several jobs with ';', '-', '.', and one event
# per clause keeps a quote short enough to check at a glance.

def rx(p):
    return re.compile(p, re.I)

# The recurring gas figures: one to three groups of digits joined by '/',
# usually 3-5 digits then 2-4 then 1-3. Also "gas 9000" alone.
GAS_TRIPLET = rx(r'\b\d{3,5}\s*/\s*\d{2,4}(?:\s*/\s*\d{1,3})?\b')
GAS_WORD    = rx(r'\bgas\b|\bpurge\b|\bcylinder\b|\bbottle\b|feed\s+pressure|\bbpm\b')

REPLACED = rx(r'\breplaced?\b|\brepl\b|\brenewed?\b|\bnew\b|\bchanged?\b(?!\s+to\s+\d)|'
              r'\bupgraded?\b|\binstalled?\b|\bfitted\b|\binst\b|\bupdated\b')
# Work already done reads in the past tense, and outranks a prospective note
# in the same clause: "Battery replaced; TBRG needs cleaning" replaced a
# battery, whatever the TBRG needs.
PAST_DONE = rx(r'\breplaced\b|\brenewed\b|\binstalled\b|\bfitted\b|\bchanged\b|'
               r'\bupgraded\b|\bupdated\b|\brepl\b|\binst\b')
# The future tense of maintenance: recommended, scheduled, or somebody
# else's job. A replacement spoken of this way has not happened yet, and an
# equipment_replaced event for it would put a phantom part in the lifecycle.
PROSPECTIVE = rx(r'\bwill\b|\bto\s+be\b|next\s+(?:visit|year|trip)|\brequired?\b|'
                 r'\bconsider(?:ing)?\b|\bsuggest(?:ed)?\b|\bdue\s+(?!to\b)|\bneeds?\b|'
                 r'\bto\s+(?:install|replace|repair)\b|\bplanned\b|\brecommend')
FAULT    = rx(r'\bu/s\b|\bus\b(?=[\s.,;]|$)|unserviceabl|\bfault(?:y|ed)?\b|\bfailed?\b|'
              r'\bblocked\b|\bleak(?:s|ing|ed)?\b|\bstick(?:ing|s)\b|\bnot\s+(?:charging|working|'
              r'recording|counting|reading)\b|\bdamaged\b|\bcorro(?:ded|sion)\b|\bflat\b(?=[^a-z]*batt)|'
              r'double.?counting|\bmissed\s+tips?\b|\bdrift(?:ing|ed)?\b|\bintermittent\b|\bseized\b')
CALIB    = rx(r'\brecal(?:ibrat\w*)?\b|\bcalibrat\w+\b|\bcal\b(?=[\s.,;:]|$|\s+to)|\badjust(?:ed|ment)?\b|'
              r'\btip\s*test\b|\bre-?zero(?:ed)?\b|\bset\s+to\s+\d')
COMMISSION = rx(r'station\s+install|(?<!since\s)(?<!after\s)(?<!at\s)(?<!by\s)\binstallation\b(?!\s+by)|\bcommission(?:ed|ing)?\b|'
               r'upgraded\s+station|converted\s+(?:station\s+)?(?:from|to)\b|new\s+station\b')
DECOMMISSION = rx(r'station\s+(?:removed|closed|withdrawn|decommissioned)|'
                 r'site\s+decommissioned|\bstn\s+(?:removed|closed)|'
                 r'\bdecommissioned\b(?=\s*[.;,]|\s*$)|\bclosed\s+down\b')
DECOM_NOT   = rx(r'\brecommend|\bintention\b|\bwill\s+be\b|\bto\s+be\s+decommissioned|'
                 r'\bwhen\b|\bgear\b|\bequipment\b')
WHS      = rx(r'\bbees?\b|\bwasps?\b|\bsnakes?\b|\bwhse?\b|\boh&s\b|\bunsafe\b|\bnot\s+safe\b|'
              r'\bladder\b|\basbestos\b|\belectrical\s+hazard\b|\blive\s+wire|\bcaution\b|\bdanger(?:ous)?\b')
VEG_TREE     = rx(r'\btrees?\b')
VEG_CONTEXT  = rx(r'\btrim|\bclear|\bcut\b|\blop|\bsha(?:de|ding|ded)\b|\boverhang|\bencroach|'
                  r'\bgrow(?:th|ing|n)?\b|\bsapling|\bpoison|\bvines?\b|\bprun|\bspray')
VEGETATION = rx(r'\bsaplings?\b|\bundergrowth\b|\bvegetation\b|re-?growth\b|'
               r'\bsha(?:de|ding|ded)\b|\bgrass\b|\bweeds?\b|\bscrub\b|\bvines?\b')
WILDLIFE = rx(r'\bants\b|\bant\s+(?:bait|nest|cap|infest\w*)|\bfrogs?\b|\bbirds?\b|\bspiders?\b|\btermites?\b|\bcattle\b(?!\s*(?:fence|grid|yard))|\bwildlife\b|'
              r'\bpossums?\b|\brodents?\b|\bmice\b|\brats?\b|\bgeckos?\b|\bmud\s*wasp')
ACCESS   = rx(r'\bunable\s+to\s+access\b|\bno\s+access\b|\baccess\s+(?:denied|issue|problem)|'
              r'locked\s+(?:gate|out|compound|shed|room|site)|gate\s+locked|\bno\s+key\b|'
              r'\broad\s+closed\b|\bpermission\b|\bcould\s+not\s+(?:get\s+(?:in|to|through|past)|gain|enter)\b|\binaccessible\b')
DAMAGE   = rx(r'\bflood(?:ed|ing)?\b|\bvandal(?:s|ised|ism)?\b|storm\s+damage|'
              r'(?:damaged?|hit|struck|lost)\s+(?:in|by|during)\s+(?:a\s+)?storm|\blightning\b|\bfire\b|'
              r'\btheft\b|\bstolen\b|\bwashed\s+away\b|\bstruck\b')
CONFIG   = rx(r'pass\s+range|\balert\s*id\b|\blow\s*=\s*\d|\bhigh\s*=\s*\d|\b\d\s*hourly\b|'
              r'check\s+signals?\b|\bdelay\s+(?:changed|set)\b|\bfrequency\b|\bre-?range[d]?\b|'
              r'#\s*\d\s+\d{3,4}\s*[-–]\s*\d{3,4}')

# Clause splitter: the corpus chains jobs with ';', ' - ', '. ' and ','
# before a fresh verb. Split conservatively — a wrong split costs a clumsy
# quote, a missing one costs nothing (rules still fire on the longer clause).
CLAUSE_SPLIT = re.compile(r'\s*(?:;|\.\s+|\s+-\s+|–\s+)\s*')

# Observations that are readings rather than events — recognised so the
# unclassified bucket is genuinely "nothing understood this", not "nothing
# happened". These produce no event and mark the remark 'observation'.
OBSERVATION = rx(r'^\s*(?:next\s*g\s+signal|signal\s+strength|low\s+solar\s+results|'
                r'all\s+ok\b|no\s+(?:faults?|problems?|issues?)\b|nil\s+(?:faults?|defects?)\b|'
                r'\bok\b\.?\s*$|routine\s+(?:visit|inspection)|r\.?l\.?\s+of|raw\s+path\s+test|'
                r'\bfwd\s*=|\bref\s*=|readings?\s+(?:taken|ok))|fade\s+margins?\b|'
                r'(?:checked|tested)\s+ok\b')


def visit_id(ref):
    return str(uuid.uuid5(NAMESPACE, ref))


def event_id(ref, ord_no):
    """Stable per (visit, event ordinal) — the load.py uuid5 discipline."""
    return str(uuid.uuid5(NAMESPACE, '%s#event:%d' % (ref, ord_no)))


def equipment_in(clause):
    for key, pat in EQUIP_RE:
        if pat.search(clause):
            return key
    return None


def gas_detail(clause):
    """Every N/N or N/N/N group in the clause, digits kept in order and
    deliberately unlabelled — see the module docstring."""
    figures = [re.sub(r'\s+', '', m.group(0)) for m in GAS_TRIPLET.finditer(clause)]
    return {'figures': figures, 'figures_meaning': 'unconfirmed'} if figures else {}


def classify_clause(clause):
    """Zero or more (type, confidence, rule, detail) for one clause."""
    out = []
    c = clause.strip()
    if not c:
        return out

    # Order matters only where two rules would double-report one fact; each
    # append is independent otherwise — a clause can be a fault AND a WHS
    # hazard AND a vegetation note, and often is.
    if COMMISSION.search(c) and not rx(r'upgraded\s+solar|upgraded\s+(?:battery|tbrg|antenna)').search(c):
        out.append(('commissioning', 'high', 'commission-verb', {}))
    if DECOMMISSION.search(c) and not DECOM_NOT.search(c):
        out.append(('decommissioning', 'high', 'decommission-verb', {}))

    equip = equipment_in(c)
    prospective = bool(PROSPECTIVE.search(c)) and not PAST_DONE.search(c)
    if equip and REPLACED.search(c) and not FAULT.search(c):
        if not prospective:
            out.append(('equipment_replaced', 'high', 'equip+replace-verb', {'equipment': equip}))
    elif equip and REPLACED.search(c) and FAULT.search(c):
        # "blocked on arrival - cleaned & calibrated", "u/s - replaced":
        # both facts are real; report both rather than pick.
        out.append(('equipment_fault', 'high', 'equip+fault-verb', {'equipment': equip}))
        if not prospective:
            out.append(('equipment_replaced', 'medium', 'equip+replace-after-fault', {'equipment': equip}))
    elif equip and FAULT.search(c):
        out.append(('equipment_fault', 'high', 'equip+fault-verb', {'equipment': equip}))

    if CALIB.search(c) \
        and not rx(r"(?:didn'?t|did\s+not|not|no|unable\s+to)\s+(?:do\s+)?(?:get\s+)?(?:re)?cal").search(c) \
        and not rx(r'^\s*check\b').search(c):
        out.append(('calibration', 'high', 'calibration-verb',
                    {'equipment': equip} if equip else {}))

    if GAS_WORD.search(c) or GAS_TRIPLET.search(c):
        d = gas_detail(c)
        if d or GAS_WORD.search(c):
            conf = 'high' if d else 'medium'
            out.append(('gas_service', conf, 'gas-figures' if d else 'gas-word', d))

    if WHS.search(c):
        out.append(('whs_hazard', 'medium', 'whs-keyword', {}))
    if VEGETATION.search(c) or (VEG_TREE.search(c) and VEG_CONTEXT.search(c)):
        out.append(('vegetation', 'medium', 'vegetation-keyword', {}))
    if WILDLIFE.search(c):
        out.append(('wildlife_intrusion', 'medium', 'wildlife-keyword', {}))
    if ACCESS.search(c):
        out.append(('access_issue', 'high', 'access-phrase', {}))
    if DAMAGE.search(c):
        out.append(('site_damage', 'medium', 'damage-keyword', {}))
    if CONFIG.search(c):
        out.append(('config_change', 'medium', 'config-pattern', {}))

    return out


def mine(remark):
    """(events, status) for one remark. status: 'classified' when at least one
    event fired, 'observation' for a recognised reading, else 'unclassified'."""
    events = []
    for clause in CLAUSE_SPLIT.split(remark):
        for etype, conf, rule, detail in classify_clause(clause):
            # Dedup within a remark: the same type + equipment + rule firing on
            # two clauses is usually the splitter's doing, not two events —
            # except gas figures, where two triplets are two bottles.
            key = (etype, rule, detail.get('equipment'), tuple(detail.get('figures', ())))
            if any(e[0] == key for e in events):
                continue
            events.append((key, etype, conf, rule, detail, clause.strip()))
    if events:
        return [e[1:] for e in events], 'classified'
    if OBSERVATION.search(remark):
        return [], 'observation'
    return [], 'unclassified'


def run():
    visits = []
    with open(os.path.join(DATA, 'inspections.jsonl'), encoding='utf-8') as f:
        for line in f:
            r = json.loads(line)
            t = (r.get('remarks') or '').strip()
            if t:
                visits.append((r['ref'], t))

    events_out = []
    counts = {'remarks': len(visits), 'classified': 0, 'observation': 0,
              'unclassified': 0, 'events': 0,
              'by_type': {k: 0 for k in EVENT_TYPES},
              'by_confidence': {'high': 0, 'medium': 0}}
    unclassified_samples = []

    for ref, remark in visits:
        events, status = mine(remark)
        counts[status] += 1
        if status == 'unclassified' and len(unclassified_samples) < 40:
            unclassified_samples.append(remark[:160])
        for ord_no, (etype, conf, rule, detail, quote) in enumerate(events, 1):
            counts['events'] += 1
            counts['by_type'][etype] += 1
            counts['by_confidence'][conf] += 1
            events_out.append({
                'id': event_id(ref, ord_no),
                'inspection_id': visit_id(ref),
                'ref': ref,
                'ord': ord_no,
                'event_type': etype,
                'confidence': conf,
                'rule': rule,
                'quote': quote,
                'detail': detail,
                'method': RULES_VERSION,
            })

    counts['coverage'] = counts['classified'] + counts['observation'] + counts['unclassified']
    report = {
        'rules_version': RULES_VERSION,
        'counts': counts,
        'unclassified_sample': unclassified_samples,
        'note': ('Every remark is counted exactly once as classified, observation or '
                 'unclassified — coverage equals remarks or this file is wrong. The issue\'s '
                 'own figure of 7,932 was the pre-#123 workbook-wide count of cells over 40 '
                 'characters; the extraction\'s remark set is what actually exists to mine.'),
    }
    return events_out, report


def write_artifacts(events, report):
    with open(os.path.join(DATA, 'events.jsonl'), 'w', encoding='utf-8') as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False, sort_keys=True) + '\n')
    with open(os.path.join(DATA, 'events_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write('\n')


def check():
    """CI: the committed artefacts are what these rules derive. A drifted rule
    or a hand-edited artefact fails here rather than being quietly wrong."""
    events, report = run()
    fresh = [json.dumps(e, ensure_ascii=False, sort_keys=True) for e in events]
    try:
        with open(os.path.join(DATA, 'events.jsonl'), encoding='utf-8') as f:
            existing = [line.rstrip('\n') for line in f if line.strip()]
    except FileNotFoundError:
        print('events.jsonl is missing — run tools/ingest/remarks.py', file=sys.stderr)
        return 1
    if fresh != existing:
        print('events.jsonl does not match what the rules derive '
              '(%d fresh vs %d committed) — re-run tools/ingest/remarks.py'
              % (len(fresh), len(existing)), file=sys.stderr)
        return 1
    with open(os.path.join(DATA, 'events_report.json'), encoding='utf-8') as f:
        committed = json.load(f)
    if committed.get('counts') != report['counts']:
        print('events_report.json counts drifted — re-run tools/ingest/remarks.py',
              file=sys.stderr)
        return 1
    c = report['counts']
    if c['coverage'] != c['remarks']:
        print('coverage %d != remarks %d — a remark was silently skipped'
              % (c['coverage'], c['remarks']), file=sys.stderr)
        return 1
    print('remarks: %d remarks → %d events; %d classified, %d observations, '
          '%d unclassified; artefacts match.' %
          (c['remarks'], c['events'], c['classified'], c['observation'], c['unclassified']))
    return 0


def q(s):
    """One SQL text literal."""
    return "'" + str(s).replace("'", "''") + "'"


def emit_sql(out):
    """The events as one re-runnable sync, printed as SQL. Requires 0016.

    A full refresh on purpose: the table is *entirely* derived, so its correct
    contents are exactly what the rules derive and nothing else — a delete of
    everything followed by inserts is the honest sync, and a re-run converges
    on the same rows (uuid5 ids) whatever happened before. Run it in one
    transaction (psql --single-transaction); over a per-request surface, run
    the pieces in order and verify the final count — a partial apply is
    repaired by running it again, and the trailing check says whether that is
    needed.
    """
    events, report = run()
    out.write("-- Generated by tools/ingest/remarks.py --sql — do not edit.\n")
    out.write("-- Derived maintenance events (#127): a full-refresh sync of\n")
    out.write("-- meganet.inspection_event. Requires 0016_inspection_events.sql.\n\n")
    out.write("do $$ begin\n"
              "  if to_regclass('meganet.inspection_event') is null then\n"
              "    raise exception 'apply db/migrations/0016_inspection_events.sql first';\n"
              "  end if;\nend $$;\n\n")
    out.write("delete from meganet.inspection_event;\n\n")
    cols = ('id, inspection_id, ord, event_type, confidence, rule, quote, '
            'detail, method')
    batch = []
    n = 0
    for e in events:
        detail = json.dumps(e['detail'], ensure_ascii=False, sort_keys=True,
                            separators=(',', ':'))
        batch.append('(%s, %s, %d, %s, %s, %s, %s, %s::jsonb, %s)' % (
            q(e['id']), q(e['inspection_id']), e['ord'], q(e['event_type']),
            q(e['confidence']), q(e['rule']), q(e['quote']), q(detail),
            q(e['method'])))
        if len(batch) == 500:
            out.write('insert into meganet.inspection_event (%s) values\n%s\n'
                      'on conflict (id) do nothing;\n\n' % (cols, ',\n'.join(batch)))
            n += len(batch)
            batch = []
    if batch:
        out.write('insert into meganet.inspection_event (%s) values\n%s\n'
                  'on conflict (id) do nothing;\n\n' % (cols, ',\n'.join(batch)))
        n += len(batch)
    out.write("do $$ begin\n"
              "  if (select count(*) from meganet.inspection_event) <> %d then\n"
              "    raise exception 'events sync incomplete: %% of %d rows -- run the stream again',\n"
              "      (select count(*) from meganet.inspection_event);\n"
              "  end if;\nend $$;\n" % (n, n))
    print('%d events emitted as SQL' % n, file=sys.stderr)


def sample(n):
    """Stratified reading list for hand-validation: n per event type plus n
    unclassified, with the quote and the whole remark side by side."""
    events, _ = run()
    remarks = {}
    with open(os.path.join(DATA, 'inspections.jsonl'), encoding='utf-8') as f:
        for line in f:
            r = json.loads(line)
            if (r.get('remarks') or '').strip():
                remarks[r['ref']] = r['remarks'].strip()
    rng = random.Random(127)
    by_type = {}
    for e in events:
        by_type.setdefault(e['event_type'], []).append(e)
    for etype in sorted(by_type):
        picks = rng.sample(by_type[etype], min(n, len(by_type[etype])))
        print('\n== %s (%d of %d)' % (etype, len(picks), len(by_type[etype])))
        for e in picks:
            print('  [%s/%s] %r' % (e['confidence'], e['rule'], e['quote'][:90]))
            print('      remark: %r' % remarks[e['ref']][:150])
    classified_refs = {e['ref'] for e in events}
    unclassified = [t for ref, t in remarks.items()
                    if ref not in classified_refs and not OBSERVATION.search(t)]
    print('\n== unclassified (%d of %d)' % (min(n, len(unclassified)), len(unclassified)))
    for t in rng.sample(unclassified, min(n, len(unclassified))):
        print('  - %r' % t[:150])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='CI: re-derive and diff')
    ap.add_argument('--sample', type=int, metavar='N',
                    help='print N stratified examples per type for hand-validation')
    ap.add_argument('--sql', action='store_true',
                    help='emit the events as a re-runnable SQL sync on stdout')
    args = ap.parse_args()
    if args.check:
        return check()
    if args.sample:
        return sample(args.sample)
    if args.sql:
        return emit_sql(sys.stdout)
    events, report = run()
    write_artifacts(events, report)
    c = report['counts']
    print('%d remarks → %d events (%d classified, %d observation, %d unclassified)'
          % (c['remarks'], c['events'], c['classified'], c['observation'], c['unclassified']))
    for k, v in sorted(c['by_type'].items(), key=lambda kv: -kv[1]):
        print('  %-20s %5d' % (k, v))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
