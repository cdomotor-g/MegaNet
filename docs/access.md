# Access — who gets in, and who may change things

MegaNet has two locks, and they are not the same lock. This is the page to read
before changing either, and the page to open when somebody cannot get in.

- **Cloudflare Access** is the perimeter. It decides who may load the site at
  all. It is configuration in a dashboard, not code in this repository.
- **Supabase Auth + `meganet.is_editor()`** is the data layer. It decides who
  may *change* a station. It is `db/migrations/0004_station_writes.sql` and
  `0005_auth.sql`, and it holds whether or not Cloudflare is in front.

The second one is the one that actually protects the data. The first one is
convenience and tidiness: it keeps the app off the open internet, and it is the
one an organisation's IT department will eventually replace with their own.

---

## The decision: the data stays public (option (a))

Issue [#72](https://github.com/cdomotor-g/MegaNet/issues/72) asked whether to
keep station data public and gate only the app and the write paths (a), or make
the data private by taking the repository private and moving `stations.json`
behind the API (b). **The answer was (a)**, recorded here because a decision that
only exists in a comment thread gets re-litigated every six months.

The reasoning, briefly: putting a login in front of the site does not make the
data private. `stations.json` is committed to a public repository, and so is
every line of the app that reads it. A sign-in screen in front of that is a sign
on a door in a field. Option (b) is a real option — it is just a much bigger one
than a sign-in panel, and it starts with the repository, not with Cloudflare.

**What follows from (a):**

- Reading is open. The station list, the maps, the ARRO tools and the ACMA data
  all work with nobody signed in, and that is intended, not an oversight.
- Signing in exists to *write*. Attribution (`updated_by`) and the ability to
  save at all are what a session buys.
- The allowlist's contents are not a secret worth engineering around. See
  "Deliberate leak", below.

---

## Layer 1 — Cloudflare Access

Free for up to 50 users. Access sits in front of a hostname and challenges every
request that has no valid session cookie.

### What it protects, and what it does not

Read this twice, because it is the part that surprises people.

Access protects **traffic that passes through Cloudflare for a hostname you have
put a policy on**. It does not protect an origin that is reachable by another
name. Concretely: while this app is served by GitHub Pages, `floodwarning.net`
can sit behind Access and `cdomotor-g.github.io/MegaNet` will still serve the
same app to anyone who types it. The lock is on one of the two doors.

Under option (a) that is tolerable — the data was never the secret — but it must
not be mistaken for a closed perimeter. The fix, if the second door ever matters,
is to stop serving from GitHub Pages and serve from Cloudflare instead, so there
is only one door. That is exactly what
[`docs/floodwarning-net.md`](floodwarning-net.md) sets up.

### Setting it up

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications**.

1. **Add an application** → **Self-hosted**.
2. Name it `MegaNet`. Session duration 24 hours is a reasonable default.
3. Application domain: the hostname the app is served from — `floodwarning.net`
   (and add a second entry for `www.floodwarning.net` if that is in use).
4. **Add a policy**:
   - Name: `Bureau staff`
   - Action: **Allow**
   - Include → **Emails ending in** → `@bom.gov.au`
5. Save.

Then **Settings → Authentication**, and enable at least one login method:

- **One-time PIN** needs no configuration and works for any address. This is the
  one to start with.
- **Google** or **Microsoft Entra ID** is better if the organisation already has
  it — people stop typing codes, and de-provisioning happens centrally when
  somebody leaves.

### Adding a second domain

Zero Trust → Access → Applications → `MegaNet` → Policies → the `Bureau staff`
policy → add another **Emails ending in** value, or add a second Allow policy.
Save. It takes effect on the next request. No deploy, no code change.

### Adding one person from outside

Same place, but use **Include → Emails** and list the address. Prefer this over
widening a domain rule for one contractor.

---

## Layer 2 — Supabase Auth and the editors list

This is the lock that matters. It is enforced inside Postgres, so it holds
against `curl`, against a browser with the developer tools open, and against
somebody who has bypassed Cloudflare entirely by using the github.io URL.

### How it fits together

- The sign-in panel (`Auth` in `auth.js`) asks Supabase Auth (GoTrue) to email a
  link and a six-digit code. No password is stored anywhere, because none exists.
- Verifying mints a JWT. The app keeps it in `sessionStorage` and sends it as a
  bearer token on every write.
- `meganet.is_editor()` — see `0004_station_writes.sql` — decides. It refuses
  `anon` unconditionally, and for an authenticated request it checks the token's
  verified email against **`meganet.editor_allow`**.
- `meganet.auth_user_gate()` — see `0005_auth.sql` — refuses to create an account
  at all for an address that is not on that list. An unlisted person does not get
  a session to be refused later; they never become a user.

### `editor_allow` is the allowlist

#72 sketched a table called `allowed_domains`. It does not exist, and that is
deliberate: `meganet.editor_allow` had already shipped in 0004 and does the same
job with one column that holds **either** a whole address **or** a domain with
its at-sign. Two allowlists would be two places to remove somebody from, and the
failure mode of that is somebody being removed from only one.

The table has no `select` grant and no RLS policy for any verb. Nothing holding
the publishable key can read it, list it, or write to it. It is reached only
through `meganet.email_allowed()`, which is `security definer`.

**Allow a second domain — no deploy:**

```sql
insert into meganet.editor_allow (entry, note, added_by)
values ('@other-agency.gov.au', 'Joint program, approved by …', 'your name');
```

**Allow one person:**

```sql
insert into meganet.editor_allow (entry, note, added_by)
values ('someone@contractor.com', 'ARRO migration, until June', 'your name');
```

**Remove somebody:**

```sql
delete from meganet.editor_allow where entry = 'someone@contractor.com';
```

Removing the entry stops future writes immediately, but **does not revoke a token
already issued** — that keeps working until it expires (an hour by default, and
its refresh token for longer). To end a session now, also delete the user:

```sql
delete from auth.users where lower(email) = lower('someone@contractor.com');
```

Run all of these in the Supabase **SQL Editor**, or from `psql` with
`$MEGANET_DB_URL`. They cannot be run from the app.

### Deliberate leak

`meganet.email_may_sign_in(email)` is callable anonymously so the sign-in panel
can say "that address is not on the list" without sending an email into the void.
It is an oracle: ask about one address and it answers yes or no.

It does not expose the list — entries cannot be enumerated, only guessed one at a
time — and the domain it mostly answers `true` for (`@bom.gov.au`) is written
down in this public repository. That is an accepted trade under option (a).

If it ever stops being acceptable, remove the `anon` grant at the foot of
`0005_auth.sql`. Nothing breaks: the signup trigger is what enforces this, and it
keeps working. The panel simply loses its early "no", and the refusal arrives
after the email round trip instead.

### The email template

Supabase's default **Magic Link** template contains only a link. The app also
accepts a typed six-digit code, which is friendlier on a phone and on a machine
where the email opens in a different browser — but the code is only in the email
if the template asks for it.

Dashboard → **Authentication** → **Email Templates** → **Magic Link**, and
include the token somewhere in the body:

```html
<p>Your MegaNet sign-in code is <strong>{{ .Token }}</strong>.</p>
<p>Or click here: <a href="{{ .ConfirmationURL }}">sign in</a></p>
```

Also set **Authentication → URL Configuration → Redirect URLs** to include the
app's origin, or the link in the email will refuse to come back:

```
https://floodwarning.net
https://floodwarning.net/*
https://cdomotor-g.github.io/MegaNet
https://cdomotor-g.github.io/MegaNet/*
```

### Site URL, and the localhost trap

On the same page, **Site URL** ships as `http://localhost:3000`. `auth.js` asks
for a `redirect_to` of its own origin, so Site URL is not what decides where the
link lands — but it is the fallback whenever a request arrives without one, and a
`redirect_to` that is *not* on the Redirect URLs list above falls back to it too.

Left at the default, the failure is a memorable one: the code verifies, a real
session is minted, and GoTrue sends it to a port on the operator's own phone that
nothing is listening on. The browser shows a blank page and no error. Nothing is
broken and nothing says so.

Set Site URL to the origin the app is actually served from — `https://floodwarning.net`
— and keep the Redirect URLs list above accurate.

---

## Proving it works

The acceptance criterion on #72 is that an unsigned write is refused **at the
server**, not by the app being polite. That is testable without a browser:

```bash
# Anonymous save attempt. Expect 404 — PostgREST answers "no such function" for
# a function the anon role has no EXECUTE on, which is a better answer than a
# 403 that confirms what exists.
curl -si -X POST 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/save_station' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'Content-Profile: meganet' \
  -H 'Content-Type: application/json' \
  -d '{"p_doc":{"id":"proof","name":"should not exist"},"p_expected_updated_at":null}' \
  | head -1
```

```bash
# Anonymous read of the editors list. Expect 404 as well — no grant, no policy.
curl -si 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/editor_allow?select=entry' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'Accept-Profile: meganet' | head -1
```

```bash
# The read path, which must keep working with no token at all — this is option
# (a) in one command. Expect 200.
curl -so /dev/null -w '%{http_code}\n' \
  -X POST 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/whoami' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'Content-Profile: meganet' -H 'Content-Type: application/json' -d '{}'
```

And in the app: sign out, open a station, and the Save button reads **"Sign in to
save"** rather than failing at the network.

---

## Recovery

### "I cannot get past the Cloudflare login screen"

The one that locks everybody out is a policy edited into uselessness. Cloudflare
Access policies are edited in the dashboard, and **dashboard access is not itself
behind Access** — sign in at `dash.cloudflare.com` with the account owner's
credentials and fix or delete the policy. Deleting the Access *application*
removes the gate entirely and the site returns to being open, which is a fine
emergency state for an app whose data is public anyway.

Keep a second account owner or a hardware key on the Cloudflare account. A
single-owner account with one MFA device on one phone is the actual risk here.

### "I am signed in but Save is refused"

The address is not on `meganet.editor_allow`. The Data source panel says so in
words, and the fix is one `insert`, above. Sign out and back in afterwards — the
check reads the token's email at request time, so a new session is not strictly
required, but it is the fastest way to be sure.

### "Nobody can sign in — the email never arrives"

In order of likelihood:

1. Supabase's built-in email service is rate-limited to a handful of messages an
   hour and is not for production. Dashboard → **Authentication → Emails → SMTP
   Settings**, and point it at a real SMTP relay.
2. The redirect URL is not on the allowed list (above), so the link is refused
   even though the email arrived.
3. The address is not on `editor_allow`, and the signup was refused by the
   database. The panel should have said so before sending; if it did not, check
   that `0005_auth.sql` has actually been applied.

### "The email arrives, but the link lands on a blank page"

Look at the address bar. If it says `localhost:3000`, or any origin that is not
the app's, the sign-in worked and the answer was delivered to the wrong door —
see "Site URL, and the localhost trap", above. The address is on the list, the
gate let it through, and the token was minted; nothing here needs a database
change.

Two fixes, and both are worth doing: set **Site URL** correctly, and put
`{{ .Token }}` in the Magic Link template so there is a six-digit code to type
when a link goes astray. A template with only a link has one way in and no
fallback.

### "The database is refusing every write, including mine"

Check the schema version. The **Data source** panel shows it, and a mismatch
means `db/migrations/` has files the database has not been given:

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
     -f db/migrations/0005_auth.sql
```

### The way in that always works

`service_role` — the secret key from the Supabase dashboard, never in a browser
— passes `meganet.is_editor()` unconditionally. So does a direct `psql`
connection as the database owner. If every session is broken and the site is
down, the data is still reachable and still editable by those two routes. Nothing
in this page can lock you out of your own database.
