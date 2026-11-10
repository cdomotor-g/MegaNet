#!/usr/bin/env python3
"""
acma_docs.py — the words of the licensing documents kept in docs/acma/, page
by page, as the small JSON files the app's document reader opens
(licence-docs.js) when somebody presses a rule's "read it" link in the
Knowledge base's 📜 Radio Licensing tab or the Stations map's ACMA licences
guide.

    docs/acma/<name>.pdf            the document itself, a copy as it stood
        └─ tools/acma_docs.py  →  docs/acma/text/<id>.json

Each JSON is { id, pages: ["page 1 …", "page 2 …", …] }: one string a page, in
reading order, the running header and footer taken off, a paragraph a line
pair apart. The reader shows the page a rule is on with the quoted words
marked, so `cd test && npm run licensing` can hold every quotation in the app
to the document it is quoted from: a quote that is not on its page, word for
word, fails.

Needs poppler's `pdftotext` on the path (poppler-utils). Standard library
otherwise. Run it after replacing a PDF:

    python3 tools/acma_docs.py            # rebuild every text file
    python3 tools/acma_docs.py --check    # exit 1 if a text file is stale

The list below is the one place a document's file and id are paired; its
title, date and source address are in licence-docs.js, beside the quotations.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / 'docs' / 'acma'

# id → the PDF, and the lines that are page furniture rather than text.
DOCS = {
    'fx16': ('rali-fx16-2025-03-25.pdf', [
        r'^OFFICIAL$',
        r'^Australian Communications and Media Authority\s+[0-9ivx]+$',
    ]),
    'fx19': ('rali-fx19-2026-07-02.pdf', [
        r'^RALI FX19\s+acma \| [0-9ivx]+$',
        r'^[0-9ivx]+ \| acma\s+RALI FX19$',
        r'^[0-9ivx]+ \| acma$', r'^acma \| [0-9ivx]+$', r'^RALI FX19$',
    ]),
    'lcd': ('fixed-licence-determination-2025-compilation-2-F2026C00349.pdf', [
        r'^Radiocommunications Licence Conditions \(Fixed Licence\) Determination 2025$',
        r'^Radiocommunications \(Exemption . Remotely Piloted Aircraft Disruption\) Determination 2022$',
        r'^Compilation No\. 2\s+Compilation date: 21 March 2026\s+[0-9]+$',
        r'^Compilation No\. 2$', r'^Compilation date: 21 March 2026$',
        r'^Authorised Version F2026C00349 registered 22/04/2026$',
        r'^[0-9]{1,2}$',
    ]),
    'lcd0': ('fixed-licence-determination-2025-as-made-F2025L00388.pdf', [
        r'^Radiocommunications Licence Conditions \(Fixed Licence\) Determination 2025$',
        r'^Authorised Version F2025L00388 registered 21/03/2025$',
        r'^[0-9]{1,2}$',
    ]),
    'es': ('fixed-licence-determination-2025-explanatory-statement.pdf', [
        r'^Explanatory Statement to the Radiocommunications Licence Conditions \(Fixed Licence\) Determination 2025$',
        r'^and the Radiocommunications \(Register of Radiocommunications Licences\) Amendment Determination 2025$',
        r'^\(No\. 1\)$',
        r'^Authorised Version Explanatory Statement registered 21/03/2025 to F2025L00388$',
        r'^[0-9]{1,2}$',
    ]),
}

# A line that starts a new item rather than carrying on the sentence above.
ITEM = re.compile(r'^(\([0-9a-zA-Z]{1,4}\)|[•>]\s|[•>]$|Note( [0-9])?:|Example( for [a-z ()]+)?:)')


def page_count(pdf):
    out = subprocess.run(['pdfinfo', str(pdf)], check=True, capture_output=True, text=True).stdout
    return int(re.search(r'^Pages:\s+(\d+)', out, re.M).group(1))


def page_text(pdf, n, junk):
    """One page in reading order. `-layout` keeps a bullet beside its words and
    a table's row on one line; the indent is then dropped, a paragraph's lines
    are joined, and a row of a table (three spaces or more inside it) or the
    start of a list item keeps a line of its own."""
    raw = subprocess.run(['pdftotext', '-layout', '-f', str(n), '-l', str(n), str(pdf), '-'],
                         check=True, capture_output=True, text=True).stdout
    paras, cur = [], []
    for line in raw.replace('\x0c', '\n').split('\n'):
        body = line.strip()
        flat = re.sub(r'\s+', ' ', body)
        if flat and any(re.match(j, flat) for j in junk):
            continue
        if not flat:
            if cur:
                paras.append(cur)
                cur = []
            continue
        # The gap after a bullet, a list letter or "Note 1:" is an indent, not a column.
        inner = re.sub(r'^(\S{1,8}( [0-9])?:?)\s+', r'\1 ', body)
        cur.append((flat, bool(re.search(r'\S {3,}\S', inner))))
    if cur:
        paras.append(cur)
    out = []
    for p in paras:
        text, was_row = p[0]
        for flat, row in p[1:]:
            sep = '\n' if row or was_row or ITEM.match(flat) else ' '
            if sep == ' ' and re.search(r'\w-$', text):
                sep = ''          # "case-by-" / "case": a hyphen at a line's end, not a space
            text += sep + flat
            was_row = row
        out.append(text)
    return '\n\n'.join(out)


def build(doc_id):
    name, junk = DOCS[doc_id]
    pdf = DIR / name
    pages = [page_text(pdf, n, junk) for n in range(1, page_count(pdf) + 1)]
    return {'id': doc_id, 'file': name, 'pages': pages}


def main():
    check = '--check' in sys.argv
    stale = 0
    (DIR / 'text').mkdir(exist_ok=True)
    for doc_id in DOCS:
        path = DIR / 'text' / f'{doc_id}.json'
        text = json.dumps(build(doc_id), ensure_ascii=False, indent=0, separators=(',', ':')) + '\n'
        if check:
            if not path.exists() or path.read_text(encoding='utf8') != text:
                print(f'stale: {path.relative_to(ROOT)}')
                stale += 1
            continue
        path.write_text(text, encoding='utf8')
        print(f'{path.relative_to(ROOT)}  {len(json.loads(text)["pages"])} pages  {len(text) // 1024} KB')
    sys.exit(1 if stale else 0)


if __name__ == '__main__':
    main()
