# floodwarning.net — moving the domain to MegaNet

`floodwarning.net` used to point at the FloodLab / ALERT1v3 project. It is being
recycled: MegaNet takes the name, and FloodLab is retired from it.

This is a runbook, not a description of something already done. **Every step
below is a dashboard action that needs a human with the Cloudflare account.**
Nothing in this repository performs it, and nothing in this repository has to
change for it to work — see "Why no code changes", at the foot.

---

## Where the domain actually stands

Measured 2026-08-12, from a resolver with no special access:

| Name | Result | What it means |
|---|---|---|
| `floodwarning.net` | resolves NOERROR, **no A/AAAA record** | The zone exists and its nameservers answer. The apex has no address record. |
| `www.floodwarning.net` | **NXDOMAIN** | No such name at all. |

So **nothing is being served at floodwarning.net today.** Whatever record used to
send it to FloodLab is already gone.

That is worth knowing before starting, because it changes the risk: this is not a
cutover of live traffic from one app to another, with a window where users hit
the wrong thing. It is bringing a dormant name back up, pointed somewhere new.
There is no traffic to break.

It also means step 1 is not "remove the old record" — it is "find out what state
the zone is really in", because a zone with no apex record is equally consistent
with a deleted Pages project, a lapsed integration, or somebody having already
half-done this.

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
