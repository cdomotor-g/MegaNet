# floodwarning.net — moving the domain to MegaNet

`floodwarning.net` used to point at the FloodLab / ALERT1v3 project. It is being
recycled: MegaNet takes the name, and FloodLab is retired from it.

This was written as a runbook. **Every step below is a dashboard action that
needs a human with the Cloudflare account.** Nothing in this repository performs
it, and nothing in this repository has to change for it to work — see "Why no
code changes", at the foot.

**Status, 2026-09-10: steps 1 to 4 have been done.** The apex resolves to
Cloudflare and every request to it is challenged by Access, so what follows is
now the record of what was done and the thing to read when undoing it, rather
than a plan. One thing the plan did not anticipate has since turned up: Access
puts the login on a hostname the Bureau's web filter denies, so the site does not
load from a Bureau machine. That has its own section —
[The Access login host is blocked on the Bureau network](#the-access-login-host-is-blocked-on-the-bureau-network).

---

## Where the domain actually stands

Measured 2026-09-10, from a resolver with no special access:

| Name | Result | What it means |
|---|---|---|
| `floodwarning.net` | `104.21.59.35`, `172.67.211.242` | Cloudflare anycast, proxied. Serving. |
| `www.floodwarning.net` | the same pair | Attached as a second custom domain. |
| `GET /` on either | **302 → `floodwarningnet.cloudflareaccess.com`** | Access is in front and is challenging. |

Measured 2026-08-12, before the cutover, and kept because it is the state a
rollback returns to:

| Name | Result | What it means |
|---|---|---|
| `floodwarning.net` | resolves NOERROR, **no A/AAAA record** | The zone exists and its nameservers answer. The apex has no address record. |
| `www.floodwarning.net` | **NXDOMAIN** | No such name at all. |

Nothing was being served at that point. That is why the cutover below carried no
risk of interrupting live traffic — there was none to interrupt — and it is why
the first step was not "remove the old record" but "find out what state the zone
is really in".

---

## The target

```
                    ┌──────────────────────┐
  browser  ────────▶│  Cloudflare Access   │   @bom.gov.au or bust
                    │  (Zero Trust policy) │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Cloudflare Pages    │   builds from cdomotor-g/MegaNet
                    │  floodwarning.net    │   on every push to main
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Supabase            │   reads open, writes need a session
                    └──────────────────────┘
```

**Cloudflare Pages rather than GitHub Pages behind a proxy**, and the reason is
the one spelled out in [`access.md`](access.md#what-it-protects-and-what-it-does-not):
Access only protects the hostnames it sits in front of. Proxying
`floodwarning.net` to a GitHub Pages origin leaves `cdomotor-g.github.io/MegaNet`
serving the same app with no gate at all. Serving from Cloudflare means there is
one door to lock.

Under option (a) the unprotected second door is not a data breach — the data is
public by decision. It is still worth closing, because a gate that is bypassable
by typing a different URL teaches people that the gate is decorative.

---

## Cutover

### 1. Confirm what the zone is doing

Cloudflare dashboard → the `floodwarning.net` zone → **DNS → Records**.

Expect to find no `A`/`AAAA`/`CNAME` at the apex. Note anything else that *is*
there — **`MX` and `TXT` records are mail and domain verification, and deleting
them breaks email that has nothing to do with this app.** Leave them alone.

If the zone is not in this Cloudflare account at all, stop: the registrar's
nameservers need to point at Cloudflare first, and that is a 24-hour change.

### 2. Create the Pages project

Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.

- Repository: `cdomotor-g/MegaNet`
- Project name: `meganet` — must exactly match the `name` in `wrangler.toml`
  at the repo root, or the build fails.
- Production branch: `main`
- Framework preset: **None**
- Build command: *(leave empty)*
- Deploy command: `npx wrangler deploy` — the prefilled default. The current
  dashboard flow marks this field required; it cannot be left empty the way
  the build command is.
- Build output directory (only if the flow asks for one): `/`

MegaNet is static files with no build step. An empty build command is correct,
not a placeholder. The required deploy command is answered by two files at the
repo root: `wrangler.toml` tells Wrangler this project is assets-only — no
Worker script, the whole repository root served as static files — and
`.assetsignore` keeps `.git/` and other non-site files out of the upload.
Neither changes what is served: the full tree, exactly as GitHub Pages serves
it today.

Deploy. It comes up on `meganet.<account>.workers.dev` (or `<project>.pages.dev`
if the flow created a classic Pages project) — check the app loads there and the
station list arrives from Supabase **before** attaching the real name.

### 3. Attach the domain

Pages project → **Custom domains** → **Set up a custom domain** →
`floodwarning.net`. Cloudflare writes the apex record itself; accept it.

Add `www.floodwarning.net` as a second custom domain if you want the `www` form
to work — it does not exist today, so this is a choice, not a restoration.

### 4. Put Access in front

Follow [`access.md` → Layer 1](access.md#layer-1--cloudflare-access), with the
application domain set to `floodwarning.net` (and `www.` if added).

Test in a private window: you should be challenged, and a `@bom.gov.au` address
should get through by one-time PIN.

### 5. Tell Supabase about the new origin

The sign-in email's link comes back to whatever origin sent it, and Supabase
refuses redirect targets it has not been told about.

Dashboard → **Authentication → URL Configuration → Redirect URLs**, add:

```
https://floodwarning.net
https://floodwarning.net/*
https://www.floodwarning.net
https://www.floodwarning.net/*
```

— the `www.` pair only if step 3 added that domain. On the same page, set
**Site URL** to `https://floodwarning.net`: it is the fallback for any sign-in
request without a redirect of its own, and it ships as `http://localhost:3000`
(see [`access.md` → the localhost trap](access.md#site-url-and-the-localhost-trap)).

Miss this and sign-in fails in a way that looks like a broken email — but only
the emailed *link* is affected. Typing the six-digit code from the same email
verifies in place, with no redirect involved, so the code path working while
the link path lands somewhere wrong is the signature of this list being stale.

### 5a. Set the Worker's three secrets

The app asks for one login, not two: `worker/index.js` exchanges the Cloudflare
Access identity for the Supabase session. It needs three values, all set as
**Secrets** on the Worker (Settings → Variables and Secrets) — the table and the
reasoning are in [`access.md` → Between the layers](access.md#between-the-layers--the-gate-signs-you-in-173).

Skip this and nothing breaks: the Worker answers 503 and the old email-and-code
panel keeps working.

### 6. Retire the second door

Once `floodwarning.net` serves the app and the gate works, GitHub Pages is a
duplicate of the site with no gate on it.

GitHub → repo **Settings → Pages → Source → None**.

The Workers deploy opened a second ungated duplicate of its own:
`meganet.<account>.workers.dev`, the preview URL from step 2. Access on the
`floodwarning.net` zone does not cover it. Once the real name works, switch it
off: Worker → **Settings** → **Domains & Routes** → `workers.dev` → **Disable**.

Optional but kind: before switching it off, replace what it serves with a one-
page redirect so an old bookmark lands somewhere useful rather than on a 404.
That means a `gh-pages` branch holding a single `index.html` with a
`<meta http-equiv="refresh" content="0; url=https://floodwarning.net">` — worth
it only if the github.io URL has actually been shared around.

**Do not add a `CNAME` file to this repository.** It is the GitHub Pages way of
claiming a custom domain, and with Cloudflare Pages serving the same name it
produces two services both asserting they own `floodwarning.net`. There is no
`CNAME` file here today; that is deliberate, and this paragraph is why.

---

## The Access login host is blocked on the Bureau network

`floodwarning.net` does not load from a Bureau machine. The block page, captured
11 September 2026, says exactly why, and it is worth reading field by field
because it contradicts most of what is easy to assume:

| Field | Value |
|---|---|
| URL | **`floodwarningnet.cloudflareaccess.com`** |
| Category | **`none`** |
| Exception | `policy_denied` |
| ProxySG Appliance | `S2-BOM-SWG-fsg12` — a Symantec/Broadcom ProxySG secure web gateway |
| Stated reason | "the website has not been categorised by the department security filter" |

**Read the URL field twice: `floodwarning.net` is not what was blocked.** The
browser reached the apex, was served the 302, followed it, and was stopped at the
next hop. The site passes the filter. The Access login host does not.

And `none` is not a bad category, it is the absence of one. WebPulse — the
categorisation feed a ProxySG consults — has never classified that name, and the
Bureau default-denies whatever it cannot classify. There is no threat verdict
here: `policy_denied` on an empty category is a default-deny, not a detection.

### Why that host will never be categorised

`floodwarningnet.cloudflareaccess.com` is this Zero Trust account's **team
domain**. Cloudflare lets you choose the team-name portion and nothing else — its
own setup documentation gives the value as `<your-team-name>.cloudflareaccess.com`.
So the name is unique to one tenant, is linked to from nowhere, and serves nothing
but a login form.

Nothing is ever going to categorise that. It is not a backlog that will clear;
there is no content to classify and no reason for a crawler to call. It will read
`none` indefinitely, which means **it needs an allowlist entry, not a
recategorisation** — the distinction to make explicitly when raising the ticket,
because it is not the usual "your filter has us in the wrong bucket" complaint.

The same fact kills the tempting engineering answer. The hop onto Cloudflare's
domain is not a redirect that can be moved onto `floodwarning.net`; while Access
is the gate, the login genuinely happens somewhere else, and that somewhere else
is a name the Bureau has never heard of.

### And why `floodwarning.tech` loads

The comparison that prompted this — Adam Murphy's ALERT2 / TDMA tooling at
`floodwarning.tech`, which loads on the same machine — turns out to have a very
short explanation, and it is not about reputation, age, TLD or hosting. **It has
no Access gate.** `GET /` returns 200 with the page, its own login lives on its
own domain, and no request ever leaves for a third-party authentication host. One
hop, one name, and that name is categorised.

Three hypotheses worth recording as dead, since each looked plausible before the
block page turned up:

- **Not the domain's history.** `floodwarning.net` was registered 2026-02-26,
  after expiring and being auctioned on DropCatch (listing seen 2025-10-16),
  against `floodwarning.tech`'s 2024-08-11 and never dropped. Irrelevant — the
  apex passes.
- **Not the phishing shape.** A gate on an unfamiliar domain asking for a
  `@bom.gov.au` address and mailing back a six-digit code genuinely does resemble
  credential harvesting, but the appliance returned no such finding.
- **Not the TLD, and not the host.** Both run backwards anyway: `.tech` is a new
  gTLD with a worse average reputation than `.net`, and Hetzner's is worse than
  Cloudflare's.

The one idea that survived is the mechanism — uncategorised means denied. It just
applies to the login host rather than to the site.

### What to do

The Bureau's own remedy is the Cherwell request the block page names, and it is
worth knowing even though it is not the route taken:
**Technology > I want something > Security Services > Cyber Security Operations >
Request Website Approval**, asking for `floodwarningnet.cloudflareaccess.com`,
with the ticket saying it is a per-tenant authentication host that will never
carry a category (IT Service Desk 03 9669 8188, x8188). That is the right
sentence to write if it is ever needed for a *second* hostname.

It was not taken here, because it stalls on somebody else's queue and because
the same problem would return with the next uncategorised name. What was done
instead removes the class of problem:

1. **The database is reached through this origin.** `worker/index.js` forwards
   `/api/db/*` to the Supabase project, and `core.js` points `DB_URL` at that
   path on the origins the Worker serves. The rest follows from one constant:
   `AUTH_URL` and `STORAGE_URL` are derived from `DB_URL`, so the sign-in and
   the attachment bucket moved with it. The browser now names one host —
   `floodwarning.net`, which already passes the filter — for the page, the data
   and the sign-in alike. What it does *not* do is change any authority: the
   publishable key is still public, RLS still decides every read, and
   `meganet.is_editor()` still decides every write from the caller's own token.
   `test/db-proxy.mjs` asserts the two properties that make it a route rather
   than a hole — the path allow-list and what is stripped from the headers.
2. **Access comes off.** The proxy solves the data hop, not the gate: while an
   Access policy is on the hostname, every request still starts with a redirect
   to the denied login host. Deleting the Access application is what actually
   makes the site load, and the app is built for it —
   [`access.md`](access.md#between-the-layers--the-gate-signs-you-in-173):
   `/api/session` answers 401 wherever there is no Access identity and the
   email-and-code panel takes over, which now runs through the proxy too.
   That trades the perimeter for reachability. Under option (a) it is a smaller
   loss than it sounds — the data was never the secret, and Layer 2 is untouched
   either way.
3. **Nothing else changes.** `github.io`, `file://` and a checkout served from a
   spare port are not on the Worker list, so they keep dialling Supabase
   directly, exactly as before. That is the safe direction for the default to
   fail: an origin nobody anticipated behaves as it always has rather than
   404ing against a route that is not there.

4. **There is something to read at the door.** The block page's stated reason
   was that the site "has not been categorised", and the app could not have been
   categorised: it draws itself from JavaScript, so anything that does not run
   scripts — a categorisation crawler, a proxy deciding what a name is — saw an
   empty document. Now `index.html` carries a `<meta name="description">`,
   `about.html` is a self-contained page in plain HTML saying what MegaNet is
   and what it is not, and `robots.txt` invites the crawl and names a
   `sitemap.xml`. Deliberately no stylesheet, font, script or CDN on that page:
   a page that has to fetch something first is a page that can arrive blank, and
   arriving blank is the fault it exists to fix.

   The "what it is not" half is not boilerplate. This domain is named after a
   Bureau statutory function, and a reader — or a brand-protection rule — is
   entitled to wonder. The page says plainly that MegaNet issues no warnings,
   is not an official Bureau product, and points at the Bureau for the real
   thing. That is both true and the single most useful sentence on it.

Two things this does not reach, worth knowing before the next report of "it
does not work from the office":

- **The map's other hosts.** Tiles, Overpass, Nominatim and Google Fonts are
  still third-party names and any of them may be uncategorised too. The app
  loads, signs in and reads its data without them; the map degrades. Each is
  proxyable the same way if it turns out to matter.
- **A `bom.gov.au` subdomain** would still be the real answer — no external name
  to categorise at all, and no list to keep current. A conversation with the
  Bureau rather than a configuration change, which is why it is not this.

Keep the block page screenshot. Its URL and Category fields are the entire
diagnosis, and a future recurrence is worth comparing against it — a different
URL in that field is a different problem.

---

## Retiring FloodLab / ALERT1v3

The domain is only one of the things holding that project up. In order:

1. **Take a copy first.** Whatever it was, it is about to become unreachable.
   Export or clone the repository and any database behind it, and put the copy
   somewhere that is not the machine doing the deleting.
2. **Delete the old Pages/Workers project** in Cloudflare, once the new one is
   confirmed serving. Deleting it *before* step 2 above is what causes an outage
   window; deleting it after causes nothing, because it is already receiving no
   traffic.
3. **Archive the repository** rather than deleting it — GitHub's *Settings →
   Archive this repository* makes it read-only and unambiguous, and keeps the
   history. Put a line at the top of its README saying the domain moved to
   MegaNet and when.
4. **Cancel anything it was paying for** — a database, an uptime check, a
   certificate bought outside Cloudflare.
5. **Leave DNS records you do not understand alone.** Especially `MX` and `TXT`.

Nothing in this section is reversible in a hurry, which is the argument for doing
it in this order and not in one sitting.

---

## Why no code changes

Checked, not assumed: every asset reference in `index.html` and the app's
scripts is
relative, so the app does not care whether it is served from a path
(`/MegaNet/`) or an apex (`/`). The only absolute URLs are to
`raw.githubusercontent.com` and to the Supabase project, neither of which depends
on where the app is served from.

Two consequences worth stating:

- Moving the domain needs no deploy of this repository, so it can be done and
  undone without touching code.
- `GITHUB_RAW_URL` and the "Load from GitHub" button keep working from
  `floodwarning.net`, because they name the repository directly rather than
  guessing from `location`.

## Rollback

Because there is no live traffic to lose, rollback is cheap at every step.

| If this breaks | Undo |
|---|---|
| Pages project serves the wrong thing | Remove the custom domain. The name goes back to serving nothing, which is what it does today. |
| Access locks everybody out | Delete the Access application. The site becomes open — acceptable, per option (a) — while the policy is fixed. |
| Sign-in stops working | Check redirect URLs (step 5). The app still reads; only saving is affected. |
| GitHub Pages was switched off too early | Settings → Pages → Source → `main` branch. It comes back within a minute. |
