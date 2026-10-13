# Accounts — anybody may sign up; an administrator approves

Since migration `0062_open_accounts_and_views.sql` (October 2026), anybody can make a
Flood-Net account with an email address and a password. What an account is *worth*
is still decided by the database, in four steps:

| Who | How they get there | What it adds |
|---|---|---|
| **Anyone** | Nothing — reading needs no account | Every tab that reads, and picking a left-bar view (All, Simple, Field) |
| **An account** | Sign up, and confirm the address from the email | Its own left-bar views, kept in the database and on every device it signs in on |
| **A member** | Approved — automatically for an address on the allowlist (any `@bom.gov.au`), or by an administrator on the Admin tab | The field photos |
| **An editor** | On the allowlist (by address or domain) — *Approve as editor* puts an address there | Editing stations, inspections, surveys, photos — exactly as before |
| **An administrator** | An editor whose role is `admin` | Approving accounts, managing users |

The enforcement is in Postgres — `meganet.is_member()`, `meganet.is_editor()` and
`meganet.is_admin()` — and in the Worker's photo route (`worker/photos.js`), which asks
the database the same questions. The app only asks; see [`access.md`](access.md) for the
layers.

**An address counts only once it is confirmed.** `is_member()` and `is_editor()` read the
address from `auth.users`, and only once `email_confirmed_at` is set (0054). That is what
stops somebody typing a Bureau address they do not hold and being approved for it, and it
is why **"Confirm email" must stay on** in Supabase (it is on today).

---

## How passwords are kept

Flood-Net never sees, stores or handles a password beyond sending it to Supabase Auth
(GoTrue) over TLS. GoTrue keeps a **bcrypt** hash of it, with its own random salt, in
`auth.users.encrypted_password` — a column nothing in the `meganet` schema reads. Nobody,
the owner included, can read a password back out of the database. A forgotten password
is reset by email, never recovered.

What a password must be is GoTrue's setting, not the app's. The recommendation (step B
below) follows NIST SP 800-63B: **length, and not a known-breached password** — no "one
capital and a symbol" rules, which produce predictable passwords. The sign-in panel asks
for at least 10 characters before it sends one, and suggests three or four ordinary
words; a password manager is the best answer of all.

### Passkeys, two-factor, and why not yet

* **Passkeys** are the low-friction future (a fingerprint or face instead of a password,
  and phishing-proof). Supabase Auth supports them, but marks the support **experimental**
  — "the API may change without notice" — and it is off on this project. Adding them now
  would mean building on something that can move under us. Revisit when Supabase marks it
  stable: the panel's password fields already carry the `autocomplete` hints a password
  manager (and its passkeys) look for, and a passkey can be added to an existing account.
* **Two-factor (TOTP)** is supported by Supabase and stable. For a viewer or a member it
  is friction for little gain — what they can reach is photos and their own views. It is
  worth turning on for **administrators** (who can approve anybody) once there are more
  of them; it is a separate piece of work.
* **Google / Microsoft sign-in** are the lowest-friction of all, and the panel shows a
  button for each provider Supabase says is on. **Google is switched on in this project
  today** — check step F.

---

## The human steps (about 40 minutes, once)

None of these can be done from the app or from a migration: they are Supabase dashboard
settings and a mail provider's account. **Until step A is done, strangers cannot sign up**
— Supabase's built-in mail only delivers to members of the project's own team, so the
confirmation email never reaches anybody else.

### 0. Finish the database migration — check first, ~3 minutes

Most of `0062` went into the live database on 13 October 2026. What did not is the
Admin tab's *Approve* / *Decline* (`meganet.admin_user_decide()`, which bans a declined
account in `auth.users`), the account emails (`account_mail_one()`, `send_account_mail()`
and their five-minute pg_cron job, which read the Vault secret) and the schema number.
Statements that write to `auth.users` or read the Vault were left for a person to run
from the dashboard. Running the whole file finishes it, and every statement in it is
safe to run again.

1. Supabase dashboard → project **MegaNet** → **SQL Editor** → **New query** → paste
   `select value from meganet.app_meta where key = 'schema_version';` → **Run**.
   **62** means this is done — skip to A.
2. If it says **61**: open
   <https://github.com/cdomotor-g/MegaNet/blob/main/db/migrations/0062_open_accounts_and_views.sql>
   → the **Copy raw file** button (two overlapping squares, top right of the file).
3. SQL Editor → **New query** → paste → **Run**. If Supabase warns that the query
   contains destructive operations (it drops and re-creates two policies and a trigger
   by name), choose **Run this query**.
4. Run the query from 1 again: it now says **62**, and the Admin tab's *Database schema*
   row reads v62 with no warning beside it.

### A. Email that reaches people (required) — Resend, ~15 minutes

Resend is the provider Supabase lists first and works on the free plan for this volume
(3,000 emails a month). Any SMTP provider works the same way (Postmark, AWS SES, Brevo).

1. Go to <https://resend.com> → **Sign up** (use the owner's address) → confirm it.
2. **Domains → Add domain** → enter `floodwarning.net` → region **Tokyo (ap-northeast-1)**
   or the closest offered → **Add**.
3. Resend shows three or four DNS records (an MX and TXT records for SPF, and a DKIM
   record). If it offers **Sign in to Cloudflare** / *Auto configure*, use it. Otherwise:
   Cloudflare dashboard → **floodwarning.net** → **DNS → Records → Add record**, and add
   each record exactly as Resend shows it (**Proxy status: DNS only** for each).
4. Back in Resend, press **Verify DNS records**. Wait until the domain says **Verified**
   (minutes, occasionally an hour).
5. **API Keys → Create API key** → name `Flood-Net Supabase` → permission **Sending
   access** → domain `floodwarning.net` → **Add**. Copy the key (`re_…`) — it is shown once.
6. Supabase dashboard → project **MegaNet** → **Authentication → Emails → SMTP Settings**
   (on some dashboards: **Project Settings → Authentication → SMTP Settings**) → switch
   **Enable custom SMTP** on, and fill in:
   * **Sender email**: `noreply@floodwarning.net`
   * **Sender name**: `Flood-Net`
   * **Host**: `smtp.resend.com`
   * **Port**: `465`
   * **Username**: `resend`
   * **Password**: the `re_…` key from step 5
   * **Minimum interval between emails**: leave the default
   → **Save**.
7. Same area → **Rate limits** → **Rate limit for sending emails**: set to `100` per hour
   (custom SMTP starts at 30).
8. Test: open <https://floodwarning.net> in a private window → **Sign in → Create a free
   account** with a personal address → the confirmation email should arrive within a
   minute (check junk mail the first time).

### B. Password rules — ~3 minutes

Supabase dashboard → **Authentication → Sign In / Providers → Email** (the Email provider's
settings):

1. **Confirm email**: **on** (it is — leave it).
2. **Secure email change**: **on** (both the old and new address must confirm a change).
3. **Minimum password length**: `10`.
4. **Password requirements**: **No required characters** (length and the breach check do
   the work).
5. **Prevent use of leaked passwords**: **on** (Pro plan — the project is on it).
6. **Secure password change** and **Require current password when updating**: leave **off**
   — the panel's *Set a new password* sends the new password only.
7. **Save**.

### C. The emails' wording — ~5 minutes

Supabase dashboard → **Authentication → Emails → Templates**. The panel accepts a typed
six-digit code as well as the link, which matters on a phone and when the email opens in a
different browser — but the code is only in the email if the template carries `{{ .Token }}`.

* **Confirm signup** — Subject `Confirm your Flood-Net account`, body:
  ```html
  <p>Welcome to Flood-Net.</p>
  <p>Your confirmation code is <strong>{{ .Token }}</strong> — or
     <a href="{{ .ConfirmationURL }}">confirm your address here</a>.</p>
  <p>A Bureau address is approved as soon as it is confirmed. Any other is approved by an
     administrator, and you will get an email when it is.</p>
  ```
* **Reset password** — Subject `Reset your Flood-Net password`, body:
  ```html
  <p>Your code is <strong>{{ .Token }}</strong> — or
     <a href="{{ .ConfirmationURL }}">choose a new password here</a>.</p>
  <p>If you did not ask for this, ignore it: nothing changes.</p>
  ```
* **Magic link** — keep the one [`access.md`](access.md#the-email-template) describes (it
  already carries `{{ .Token }}`).

### D. Where links come back to — check only

**Authentication → URL Configuration**: **Site URL** `https://floodwarning.net`, and
**Redirect URLs** including `https://floodwarning.net/*` (see
[`access.md`](access.md#site-url-and-the-localhost-trap)). A sign-up link or reset link
that lands on `localhost:3000` means this is wrong.

### E. Tell the administrators — ~3 minutes (optional, recommended)

The Admin tab always shows the accounts waiting (a red count on **Admin** in the left bar,
and a note on arrival). To be **emailed** as well — and for each approved person to be
emailed that they are in — give the database the same Resend key:

1. Supabase dashboard → **Project Settings → Vault** (or **Integrations → Vault**) →
   **Secrets → Add new secret**.
2. **Name**: `resend_api_key` · **Secret**: the `re_…` key from A5 → **Save**.

That is all: `meganet.send_account_mail()` runs every five minutes (pg_cron job
`meganet-account-mail`) and starts sending once the secret exists. It sends from
`Flood-Net <noreply@floodwarning.net>`; to change that, or the link in the emails, run in
the SQL editor:

```sql
insert into meganet.app_meta (key, value) values ('mail_from', 'Flood-Net <accounts@floodwarning.net>')
on conflict (key) do update set value = excluded.value;
```

### F. Google sign-in — check, ~2 minutes

**Authentication → Sign In / Providers → Google** is **on** in this project, so the panel
offers *Continue with Google*. Make sure it actually works: open the site in a private
window → **Sign in → Continue with Google**. If it errors, either finish its setup (a
Google Cloud OAuth client whose authorised redirect URI is
`https://jjprlritvhdqpvphfrnu.supabase.co/auth/v1/callback`) or switch it **off** — the
button disappears by itself.

---

## Day to day

* **Approving.** Admin tab → **Waiting for approval**: *Approve* (sees the photos), *Approve
  as editor* (also edits — the address goes on the allowlist), or *Decline* (locked out:
  the account is banned in `auth.users` and its current session stops counting at once).
  *Undo decline* is in the users table.
* **Too many strangers?** Admin tab → **Who may create an account** → *Only addresses on
  the allowlist*. Sign-up is then 0005's rule again; nothing else changes.
* **Removing somebody.** The users table's **Delete**, as before (`access.md`).
* **Unconfirmed sign-ups** are folded away under the waiting list. They count for nothing —
  a typo or a robot — and need no action.

## If something is wrong

| Symptom | Cause, and fix |
|---|---|
| *Approve* says "The database cannot decide about accounts yet", or the Admin tab says the app expects v62 | Step 0. |
| Sign-up says sent, no email arrives | Step A not done (Supabase's own mail only reaches the project's team), or the email is in junk. Resend → **Logs** shows whether it was sent. |
| "Too many emails have gone out for now" | Step A7's rate limit. |
| The panel says *New accounts are open only to listed addresses* | Sign-up is closed (Admin tab switch, or `app_meta` `signup = 'allowlist'`). |
| Approved, but no photos | The person needs to sign out and in again only if their tab was open for over an hour; otherwise check the Worker is deployed (its photo route asks `rpc/is_member`). |
| Administrators are not emailed | Step E: the Vault secret's name must be exactly `resend_api_key`. `select meganet.send_account_mail();` in the SQL editor returns how many it told. |
