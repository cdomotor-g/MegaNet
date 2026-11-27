#!/usr/bin/env python3
"""Send a folder of field photos to Flood-Net through the photo upload API.

An example client (docs/agent-api.md, "Sending field photos"): Python 3.8 or
later, standard library only.

    FLOODNET_UPLOAD_KEY=fnp_... python3 send.py <folder> [--station ID] [--caption TEXT]
    FLOODNET_UPLOAD_KEY=fnp_... python3 send.py <folder> --status

Every JPEG, PNG, WebP and HEIC in the folder (not below it) is sent once. What
was sent is remembered in <folder>/.floodnet-sent.json -- each photo's SHA-256
and its receipt -- so running it again sends only new photos, and --status asks
what became of each one. Sending a photo twice is harmless anyway: the API
answers with the receipt it already has.

The key is read from the environment and never printed.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("FLOODNET_UPLOAD_URL", "https://floodwarning.net/api/upload/v1").rstrip("/")
KEY = os.environ.get("FLOODNET_UPLOAD_KEY", "")
TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
         ".heic": "image/heic", ".heif": "image/heif"}


def call(method, url, body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Authorization": f"Bearer {KEY}", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read() or b"{}"), res.headers
    except urllib.error.HTTPError as err:
        try:
            data = json.loads(err.read() or b"{}")
        except ValueError:
            data = {}
        return err.code, data, err.headers


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder")
    ap.add_argument("--station")
    ap.add_argument("--caption")
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if not KEY:
        sys.exit("set FLOODNET_UPLOAD_KEY to your photo upload key (fnp_...)")

    ledger_path = os.path.join(a.folder, ".floodnet-sent.json")
    try:
        with open(ledger_path) as f:
            ledger = json.load(f)
    except (OSError, ValueError):
        ledger = {}

    if a.status:
        for name, x in ledger.items():
            status, r, _ = call("GET", f"{BASE}/photos/{x['receipt']}")
            extra = f" -- {r['reason']}" if r.get("reason") else ""
            print(f"{name}: {r.get('state', status)}{extra}")
        return 0

    q = {k: v for k, v in (("station", a.station), ("caption", a.caption)) if v}
    url = f"{BASE}/photos" + (f"?{urllib.parse.urlencode(q)}" if q else "")
    failed = 0
    for name in sorted(os.listdir(a.folder)):
        ctype = TYPES.get(os.path.splitext(name)[1].lower())
        if not ctype:
            continue
        with open(os.path.join(a.folder, name), "rb") as f:
            data = f.read()
        sha = hashlib.sha256(data).hexdigest()
        if ledger.get(name, {}).get("sha256") == sha:
            continue
        for attempt in range(1, 5):
            try:
                status, r, headers = call("PUT", url, data, {
                    "Content-Type": ctype, "X-Content-SHA256": sha,
                    "X-FloodNet-File-Name": urllib.parse.quote(name)})
            except urllib.error.URLError as err:
                # Safe to resend: the same photo gets the same receipt.
                if attempt < 4:
                    time.sleep(2 * attempt)
                    continue
                print(f"{name}: could not reach Flood-Net -- {err.reason}")
                failed += 1
                break
            if status in (409, 429) and attempt < 4:
                time.sleep(int(headers.get("Retry-After") or 60))
                continue
            if status in (200, 202):
                ledger[name] = {"sha256": sha, "receipt": r["receipt"]}
                with open(ledger_path, "w") as f:
                    json.dump(ledger, f, indent=2)
                print(f"{name}: {r['state']}{' (sent before)' if r.get('repeat') else ''} -- receipt {r['receipt']}")
            else:
                print(f"{name}: refused ({status}) -- {r.get('error', 'no reason given')}")
                failed += 1
            break
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
