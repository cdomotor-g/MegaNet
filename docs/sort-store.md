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
`sha256_hex('sort-forum-v1:' + normPass(passphrase))` is the hash it holds
(below), compared in constant time. `normPass` keeps only the letters and
digits, in capitals, so a sentence works however it is typed — *"Herons audit the
staff gauge at noon"* and *"herons-audit the staff gauge at NOON."* are the same
passphrase. (A header carries only plain characters, so
SoRT sends it already reduced the same way.)

| Request | Answer |
| --- | --- |
| `GET /check` | `200 {"ok":true}` |
| `PUT /passphrase` with `{"sha256":"<64 hex>"}` | change the passphrase (the current one in the header): `200 {"ok":true}`; `400 {"error":"sha256"}` if the body isn't that; `409 {"error":"set in Cloudflare"}` while `SORT_PASS_SHA256` is set; any other method `405` — the hash is never read back |
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

**From SoRT:** *Sessions* → *Shared with the forum* → **Change the forum
passphrase**, by anyone who has the current one. SoRT works out the new one's
hash in the browser and sends only that (`PUT /passphrase`); the Worker keeps it
in R2 at `_meganet/sort/passphrase.json` (`{"sha256", "changed_at"}`) — private,
unlike this repository, so even a memorable sentence can't be tried offline
against a published hash. Every isolate picks it up within 30 seconds; each forum
computer asks for the new passphrase the next time it is refused.

Which hash is held, first that applies:

1. **`SORT_PASS_SHA256`** on the Worker (a *secret*), when it is set — the
   owner's override. While it is set, `PUT /passphrase` answers `409`. A value
   that is not 64 hex characters refuses everybody (`503 {"error":"passphrase
   not set up"}`) rather than letting an old passphrase back in.
2. **The forum's own**, in R2 — the usual case since 4 Nov 2026 (a flood
   sentence, chosen by the owner). If R2 can't be read the answer is `503
   {"error":"storage"}`, never a fall back to (3).
3. **`PASS_SHA256` in `worker/sort.js`** — the starting passphrase's (random,
   about 100 bits), used only while R2 holds none: the way back in if the R2
   object is ever deleted.

By hand, with the current passphrase (`read -rs` so neither is echoed or kept):

```sh
read -rs CUR; read -rs NEW
H=$(printf '%s' "sort-forum-v1:$(printf '%s' "$NEW" | tr a-z A-Z | tr -cd 'A-Z0-9')" | sha256sum | cut -c1-64)
curl -s -X PUT https://floodwarning.net/api/sort/v1/passphrase \
  -H "X-SoRT-Passphrase: $(printf '%s' "$CUR" | tr a-z A-Z | tr -cd 'A-Z0-9')" \
  -H 'Content-Type: application/json' --data "{\"sha256\":\"$H\"}"
unset CUR NEW H
```

The owner's override instead: Cloudflare dashboard → **Workers & Pages** → the
`meganet` Worker → **Settings** → **Variables and Secrets** → **Add** → **Type:
Secret**, **Variable name:** `SORT_PASS_SHA256`, **Value:** the hash → **Deploy**
(a *secret*: the next deploy deletes plain-text variables set in the dashboard).
Delete it to go back to the forum's own.

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
