# SoRT's forum sessions — the store behind the forum passphrase

The SoRT scope builder (<https://cdomotor-g.github.io/SoRT/>) is a static page
on GitHub Pages: it has nowhere of its own to keep a forum's work, and a forum
is run from several computers at once. So Flood-Net's Worker keeps those files
for it, at `https://floodwarning.net/api/sort/v1`, for whoever has the **forum
passphrase**. That is the whole of the sign-in: type the passphrase once on each
forum computer and SoRT does the rest. No GitHub token, no account — the owner's
rule: *"anyone with that passphrase could get into the sort scope builder and do
their thing"*.

It is **not** part of the agent API (`/api/v1`, `/api/mcp`): it lives in its
own module, `worker/sort.js`, shares nothing with `worker/api.js`, and is not in
the API's changelog. Its files are in Flood-Net's private R2 storage, never in
either repository.

## The contract

SoRT is built to this; change it only together with SoRT's side.

Every request except the CORS preflight carries the header
`X-SoRT-Passphrase: <passphrase>`. The Worker accepts it when
`sha256_hex('sort-forum-v1:' + passphrase)` is the hash it holds (below),
compared in constant time.

| Request | Answer |
| --- | --- |
| `GET /check` | `200 {"ok":true}` |
| `GET /files/<path>` | `200` the file's text, `Content-Type: application/json`, `ETag: "<etag>"`, `Cache-Control: no-store`; `404 {"error":"not found"}` if it was never saved |
| `PUT /files/<path>` with `If-None-Match: *` | create: `200 {"etag":"\"…\""}` and the same `ETag` header |
| `PUT /files/<path>` with `If-Match: "<etag>"` | replace the version with that etag (the one the last GET or PUT gave): `200 {"etag":"\"…\""}` and the same `ETag` header |

and, whatever the route:

| When | Answer |
| --- | --- |
| the passphrase is wrong or missing | `401 {"error":"passphrase"}` |
| `<path>` is not `index.json` or `stations/<slug>.json` (`^(index\.json\|stations/[a-z0-9][a-z0-9-]{0,79}\.json)$`) | `400 {"error":"path"}` |
| a PUT's body is not JSON (or not UTF-8, or empty) | `400 {"error":"not JSON"}` |
| a PUT's body is over 4 MB (4,194,304 bytes) | `413 {"error":"too large"}` |
| a create over a file that is there, a replace whose etag is not the file's now (somebody saved in between), or a PUT with neither header | `412 {"error":"changed"}` — SoRT reads the file again |
| past a brake (below) | `429 {"error":"slow down"}`, `Retry-After: 60` |
| a method other than GET or PUT (or not GET, on `/check`) | `405`, with `Allow` |
| another address under `/api/sort/v1` | `404 {"error":"not found"}` |

The body of a PUT is the whole file, stored exactly as sent. A save is never
blind: without `If-None-Match: *` or `If-Match` it is refused, so two forum
computers saving the same file at once cannot lose either's work — one is told
`200`, the other `412`. `If-Match: *`, a weak etag or a list of them are
refused the same way. The etag may be sent with or without its quotes.

**CORS.** For `https://cdomotor-g.github.io` and `https://floodwarning.net`
only: the preflight (`OPTIONS`, no passphrase) is `204` with
`Access-Control-Allow-Methods: GET, PUT, OPTIONS`,
`Access-Control-Allow-Headers: content-type, x-sort-passphrase, if-match,
if-none-match`, `Access-Control-Expose-Headers: ETag`, a day's `Max-Age` and
`Vary: Origin`; every answer to those pages — a refusal too — names the origin
and exposes `ETag`. Any other origin gets no CORS headers (its preflight is
`403`), so another site's page cannot read anything; a program that is not a
browser needs none and, with the passphrase, can use the store as SoRT does.

**Brakes** (Cloudflare's rate limiting bindings, `wrangler.toml`; per
Cloudflare location, keyed by a hash of the address):

- `SORT_RATE_LIMIT` — **120 requests a minute** from one address, every request
  but the preflight.
- `SORT_AUTH_FAIL` — **10 wrong passphrases a minute** from one address; the
  11th is `429` rather than `401`. Only wrong ones are counted, and the right
  passphrase is never refused by this brake, so one forum computer with an old
  passphrase behind an office's shared address cannot lock the others out.

All the forum computers in one office usually reach the internet through one
address, so the 120 a minute is theirs together.

## Where the files are

In the `meganet-photos` R2 bucket (the Worker's `PHOTOS` binding), under
`_meganet/` — the prefix no photo path reaches:

- `_meganet/sort/files/index.json`, `_meganet/sort/files/stations/<slug>.json`
  — the files themselves.
- `_meganet/sort/history/<path>/<YYYY-MM-DDTHH>Z.json` — after every save, a
  copy for that UTC hour, written over by later saves in the same hour. So each
  hour a file was saved in keeps that hour's last version: a bad save is put
  right from the hour before it (below). Nothing deletes them; they are small,
  and an R2 lifecycle rule on the `_meganet/sort/history/` prefix (the bucket's
  **Settings** → **Object lifecycle rules**) would, if they ever need to go.

What is in a file is SoRT's: a forum's scope, its stations and its notes. Like
the rest of Flood-Net it must hold **no landholder names or contact details and
no gate, padlock or key codes** — SoRT checks for them before it saves.

## Changing the passphrase

The hash the Worker holds is `PASS_SHA256` in `worker/sort.js`, unless the
Worker has **`SORT_PASS_SHA256`**, which then replaces it — so a new passphrase
needs no change to the code.

1. Choose the new passphrase (as random as the old one — about 100 bits, e.g.
   eight words from a diceware list). Give it to the forum by a way that is not
   email or chat in the open.
2. Work out its hash, on any computer:

   ```sh
   printf '%s' 'sort-forum-v1:the new passphrase' | sha256sum
   ```

   (`printf '%s'`, not `echo`, so no newline goes into the hash; on a Mac,
   `shasum -a 256`.) The 64 hex characters are the hash.
3. Give it to the Worker as a **secret**: Cloudflare dashboard → **Workers &
   Pages** → the `meganet` Worker → **Settings** → **Variables and Secrets** →
   **Add** → **Type: Secret**, **Variable name:** `SORT_PASS_SHA256`, **Value:**
   the hash → **Deploy**. Or, from a checkout signed in to Cloudflare:
   `npx wrangler secret put SORT_PASS_SHA256` and paste it. A *secret*, not a
   plain-text variable: the next deploy from the repository deletes plain-text
   variables set in the dashboard.
4. Check it: `curl -s https://floodwarning.net/api/sort/v1/check -H
   'X-SoRT-Passphrase: the new passphrase'` answers `{"ok":true}`, and the old
   one `{"error":"passphrase"}`. Each forum computer asks for the new
   passphrase the next time it is refused.

Or ask an agent to change `PASS_SHA256` in `worker/sort.js` to the new hash —
the hash only, never the passphrase. A `SORT_PASS_SHA256` that is set but is not
64 hex characters refuses everybody (`503 {"error":"passphrase not set up"}`)
rather than letting the old passphrase back in; delete the secret to go back to
the one in the code.

## Putting a file back

A save went wrong — a file emptied, a station's work overwritten. The copies are
by the hour, so go back to the hour before the bad save.

1. **Find the copy.** Cloudflare dashboard → **R2** → `meganet-photos` →
   **Objects** → `_meganet/` → `sort/` → `history/` → the file's path (e.g.
   `index.json/` or `stations/` → `<slug>.json/`). Each object is an hour, named
   in UTC (`2026-11-04T05Z.json` is 3–4 pm in Brisbane). Download the last one
   before the bad save. Or from a checkout signed in to Cloudflare:

   ```sh
   npx wrangler r2 object get 'meganet-photos/_meganet/sort/history/index.json/2026-11-04T05Z.json' --file restore.json --remote
   ```

2. **Put it back through the store**, so the save is conditional and leaves its
   own copy like any other:

   ```sh
   read -rs PASS            # type the forum passphrase; it is not echoed or kept
   F=https://floodwarning.net/api/sort/v1/files/index.json
   ETAG=$(curl -sS -o /dev/null -D - "$F" -H "X-SoRT-Passphrase: $PASS" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
   curl -sS -X PUT "$F" -H "X-SoRT-Passphrase: $PASS" -H "If-Match: $ETAG" \
     -H 'Content-Type: application/json' --data-binary @restore.json
   ```

   `{"etag":…}` means it is back. `{"error":"changed"}` means somebody saved in
   between: run the last two lines again.
3. **Tell the forum.** A computer with the file open is told `412` on its next
   save and reads the file again, so nothing it holds overwrites the restored
   one; reloading SoRT shows it at once.

Uploading the copy in the dashboard at `_meganet/sort/files/<path>` does the
same in one step, but unconditionally — only when nobody is saving.

## Checks

`cd test && npm run sortstore` (offline; R2 a stand-in): the passphrase right,
wrong and missing and the `SORT_PASS_SHA256` override; every route and status
above; the path refusals; the size cap; create, replace and conflict with
etags; the hour's copy; CORS for the two origins, another origin and the
preflight; both brakes; and that the passphrase is in no log line or answer.
`npm run agentdocs` holds the two brakes in `wrangler.toml` to `worker/sort.js`.
