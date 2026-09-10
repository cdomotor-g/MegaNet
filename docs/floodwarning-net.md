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
than a plan. One thing the plan did not anticipate has since turned up: the name
is blocked on the Bureau network. That has its own section —
[The name is blocked on the Bureau network](#the-name-is-blocked-on-the-bureau-network).

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

## The name is blocked on the Bureau network

Reported September 2026: `floodwarning.net` does not load from a Bureau machine.
`floodwarning.tech` — an unrelated third party in the same field, Adam Murphy's
ALERT2 / TDMA tooling — loads fine from the same machine.

That comparison is the useful part, because it rules out the three intuitive
explanations on its own. Both sites are about flood warning. Both have a login on
them. Both are hosted offshore on a commodity provider. Whatever the filter is
reacting to, it is none of those.

Measured 2026-09-10, from outside both networks:

| | `floodwarning.net` | `floodwarning.tech` |
|---|---|---|
| `GET /`, signed out | **302 → `floodwarningnet.cloudflareaccess.com`** | **200, 5,912 bytes of real content** |
| `GET /robots.txt` | 302, to the same login | 200 — `Allow: /`, plus a sitemap |
| Readable without signing in | **nothing, at any path** | everything but `/dashboard`, `/login`, `/api/`, … |
| Registered | 2026-02-26 | 2024-08-11 |
| Before that | **expired, then auctioned on DropCatch.com** (listing seen 2025-10-16) | never dropped |
| Serving what it serves now since | ~2026-08-28 | 2024 |
| Hosting | Cloudflare, proxied | Hetzner behind Caddy; Cloudflare for DNS only |

### Why

Ranked by how much of the difference each one explains.

**1. Nothing here is readable, so nothing can classify it.** A web filter
categorises a name by fetching it. Every path on this domain — `/`,
`/robots.txt`, even `/favicon.ico` — answers 302 to a login on a *different*
hostname. A crawler never receives one byte of MegaNet, so the name cannot leave
**Uncategorised**, and a government SOE commonly default-denies that category.
Handed the same crawler, `floodwarning.tech` returns a page reading "Open Source
Flood Warning & Hydrography Projects" and a `robots.txt` pointing at a sitemap,
and lands somewhere harmless like Technology or Business. It is not that the
other site argued its way past the filter. It answered the question and this one
does not.

**2. From the outside, the gate has the exact shape of a phishing kit.** Line the
facts up as a scanner sees them: a six-month-old domain, bought at expiry
auction, named after a Bureau statutory function, which redirects instantly to a
hostname the visitor never asked for, where a form asks for a `@bom.gov.au`
address and mails back a six-digit code. Every one of those is a
credential-harvesting indicator and together they are the textbook description of
one. A brand-impersonation rule would fire on the *name* alone and never so much
as look at `.tech`, which claims nothing.

**If Bureau security blocked this without knowing what it was, they were right
to.** That is worth leading with when raising it, rather than treating the block
as a fault.

**3. `*.cloudflareaccess.com` may be blocked in its own right.** It is
Cloudflare's Zero Trust product, and several enterprise filters file it under
Proxy Avoidance / Anonymisers / VPN — it tunnels into private resources, and it
competes with whatever the agency already runs. If that category is denied, the
redirect target is refused whether or not `floodwarning.net` itself is.

**4. The domain dropped and was re-caught.** Expiry, auction, re-registration is
the most common pattern in malicious domain re-use, so filters treat it harshly:
the registration date resets, which restarts any newly-registered-domain penalty,
and a previous owner's categorisation can survive the change of hands. What the
previous owner served is worth finding out and has not been established here —
archive.org was rate-limiting the lookup when this was written.

**Not the TLD, and not the host.** Both are the obvious guess and both run
backwards. `.tech` is a new gTLD with a *worse* average reputation than `.net`,
and some filters deny new gTLDs wholesale; Hetzner has a considerably worse abuse
reputation than Cloudflare. If either were the mechanism, the other site would be
the blocked one.

### Telling which, from a Bureau machine

- **Read the block page.** It names the product and almost always the category.
  One screenshot settles the whole question and makes everything below
  unnecessary.
- **Try the three names separately** — `floodwarning.net`,
  `floodwarningnet.cloudflareaccess.com`, and the `workers.dev` preview from
  step 2 if it has not been retired yet. The preview serves the same app with no
  gate in front of it: if it loads and the real name does not, the gate is the
  cause and the content is not.
- **`nslookup floodwarning.net`.** An internal address or an NXDOMAIN means DNS
  filtering — a category feed or a newly-registered-domain list. Getting
  `104.21.59.35` / `172.67.211.242` back and *then* failing to load means the
  HTTP proxy.

### What to do about it

1. **Submit recategorisation requests.** Free, and the actual fix. Every vendor
   takes them — Zscaler Sitereview, FortiGuard, Symantec/Broadcom Sitereview,
   Palo Alto Test A Site, Netskope, Cisco Talos, Microsoft SmartScreen. Submit
   `floodwarning.net` **and** `floodwarningnet.cloudflareaccess.com`; the second
   is the one people forget, and on cause 3 it is the one that matters.
2. **Give the crawler something to read.** Exempt one page from the Access policy
   — a public `/about` saying in plain HTML what MegaNet is, who runs it, and
   that access is restricted to Bureau staff — and leave `/robots.txt` outside
   the policy too. This is most of why `.tech` is categorised and this domain is
   not, and it defuses cause 2 as well, because a login stops being the first
   thing any visitor sees. It costs nothing under option (a): the page says only
   what this public repository already says.
3. **Ask Bureau IT to allowlist it**, with the case stated plainly: a
   Bureau-staff tool, gated to `@bom.gov.au`, whose data is public by decision
   ([`access.md`](access.md#the-decision-the-data-stays-public-option-a)).
4. **Longer term, a `bom.gov.au` subdomain** deletes this entire class of
   problem — no external name to categorise, no impersonation question to answer,
   no allowlist entry to maintain across filter changes. That is a conversation
   with the Bureau rather than a configuration change, which is why it is last
   and not first.

Only (2) is a change anyone can make from here, and even that one is a dashboard
action against the Access policy rather than a commit.

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
