#!/usr/bin/env python3
"""Apply a `load.py --chunks` emission's data plane over PostgREST.

The control plane (setup.sql, sync.sql, cleanup.sql) goes over whatever SQL
surface is available — the Supabase MCP connection, or psql. This script is
only the middle: it posts every chunk file named by manifest.json to the
secret-gated `meganet.load159_stage()` RPC that setup.sql created, one HTTPS
request per chunk, and verifies the row count the function reports against
the manifest's.

    python3 tools/ingest/load.py --chunks /tmp/history-chunks
    # ... run setup.sql over the SQL surface ...
    python3 tools/ingest/apply_chunks.py --dir /tmp/history-chunks
    # ... run sync.sql, then cleanup.sql ...

Progress lands in DIR/applied.json after every chunk, so a rerun resumes
rather than double-staging. A chunk staged twice anyway would overshoot the
sync function's count assertion and the sync would refuse — that assertion
is the backstop; this file's ledger is the convenience.

The URL and anon key default to the app's own, read out of core.js — the
same public values every browser uses; the write authority comes from the
per-emission secret in the manifest, not from the key. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def app_defaults():
    """DB_URL and DB_ANON_KEY as core.js states them."""
    with open(os.path.join(REPO, 'core.js'), encoding='utf-8') as f:
        src = f.read()
    url = re.search(r"const DB_URL\s*=\s*'([^']+)'", src)
    key = re.search(r"const DB_ANON_KEY\s*=\s*'([^']+)'", src)
    if not url or not key:
        raise SystemExit('could not read DB_URL / DB_ANON_KEY out of core.js '
                         '— pass --url and --key')
    return url.group(1), key.group(1)


def post(url, key, profile, payload, cafile, timeout):
    req = urllib.request.Request(url, method='POST',
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'apikey': key,
                 'Authorization': 'Bearer ' + key,
                 'Content-Profile': profile})
    ctx = ssl.create_default_context(cafile=cafile) if cafile else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
        body = res.read().decode('utf-8')
    return json.loads(body) if body else None


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split('\n')[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', required=True,
                    help='the directory load.py --chunks wrote')
    ap.add_argument('--url', help='PostgREST base, default from core.js')
    ap.add_argument('--key', help='anon key, default from core.js')
    ap.add_argument('--cafile', default=os.environ.get('SSL_CERT_FILE'),
                    help='CA bundle for TLS, default $SSL_CERT_FILE')
    ap.add_argument('--timeout', type=int, default=120,
                    help='per-request timeout in seconds')
    args = ap.parse_args()

    url, key = args.url, args.key
    if not url or not key:
        default_url, default_key = app_defaults()
        url = url or default_url
        key = key or default_key

    with open(os.path.join(args.dir, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    rpc = '%s/rpc/%s' % (url.rstrip('/'), manifest['rpc'])

    ledger_path = os.path.join(args.dir, 'applied.json')
    applied = set()
    if os.path.exists(ledger_path):
        with open(ledger_path, encoding='utf-8') as f:
            applied = set(json.load(f))

    todo = [e for e in manifest['files'] if e['file'] not in applied]
    print('%d chunk(s), %d already staged, %d to go'
          % (len(manifest['files']), len(applied), len(todo)))

    for entry in todo:
        with open(os.path.join(args.dir, entry['file']), encoding='utf-8') as f:
            chunk = json.load(f)
        payload = {'p_secret': manifest['secret'],
                   'p_table': chunk['table'],
                   'p_rows': chunk['rows']}
        for attempt in range(5):
            try:
                n = post(rpc, key, manifest['profile'], payload,
                         args.cafile, args.timeout)
                break
            except (urllib.error.URLError, OSError) as err:
                detail = ''
                if isinstance(err, urllib.error.HTTPError):
                    detail = ' — ' + err.read().decode('utf-8', 'replace')[:400]
                if attempt == 4:
                    raise SystemExit('%s: gave up after 5 attempts: %s%s'
                                     % (entry['file'], err, detail))
                wait = 2 ** (attempt + 1)
                print('  %s: %s%s — retrying in %ds'
                      % (entry['file'], err, detail, wait), file=sys.stderr)
                time.sleep(wait)
        if n != entry['rows']:
            raise SystemExit(
                '%s: the stage function reports %r rows, the manifest says %d '
                '— stop and look before staging anything else'
                % (entry['file'], n, entry['rows']))
        applied.add(entry['file'])
        with open(ledger_path, 'w', encoding='utf-8') as f:
            json.dump(sorted(applied), f, indent=2)
        print('  %-28s %6d rows staged' % (entry['file'], n))

    staged = {}
    for entry in manifest['files']:
        staged[entry['table']] = staged.get(entry['table'], 0) + entry['rows']
    print('\nall chunks staged; per-table totals this emission expects:')
    for table, n in manifest['expected'].items():
        marker = 'ok' if staged.get(table, 0) == n else '??'
        print('  %-14s %7d  %s' % (table, n, marker))
    print('\nnext: run sync.sql over the SQL surface, then cleanup.sql.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
