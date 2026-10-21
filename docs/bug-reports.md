# Bug reports straight from the app

The 🐞 **Report a Bug** dialog can file a report itself: the person types what
happened, presses **Send report**, and it is done. No GitHub account, no second
page. The Worker's `/api/report` (`worker/report.js`) does the filing, as a
GitHub issue on this repository, an email to the team, or both, depending on
which secrets the Worker has.

Until one of them is set, the dialog works as it always has: **Open GitHub
issue ↗** opens GitHub's pre-filled *New issue* page, and **Copy report** is for
anyone without an account. It goes back to that whenever a send fails (GitHub
or Resend refusing, the day's ceiling reached, no connection) and keeps what the
person typed.

## Switching it on: GitHub issues (about 5 minutes)

1. **Make a token.** Open <https://github.com/settings/personal-access-tokens/new>
   (GitHub → your picture → **Settings** → **Developer settings** → **Personal
   access tokens** → **Fine-grained tokens** → **Generate new token**).
   - **Token name:** `Flood-Net bug reports`
   - **Expiration:** the longest it offers. Put a reminder in your calendar a
     week before, to make a new one and replace the secret.
   - **Resource owner:** `cdomotor-g`
   - **Repository access:** **Only select repositories** → `cdomotor-g/MegaNet`
   - **Permissions** → **Repository permissions** → **Issues** → **Read and
     write**. Leave everything else as it is (GitHub adds *Metadata: Read-only*
     itself).
   - **Generate token**, and copy it (it starts `github_pat_`). GitHub shows it
     only once.
2. **Give it to the Worker.** Cloudflare dashboard → **Workers & Pages** → the
   `meganet` Worker → **Settings** → **Variables and Secrets** → **Add** →
   **Type:** **Secret**, **Variable name:** `GITHUB_ISSUES_TOKEN`, **Value:**
   the token → **Deploy**. Or, from a checkout signed in to Cloudflare:
   `npx wrangler secret put GITHUB_ISSUES_TOKEN` and paste it.
3. **Check it.** Open <https://floodwarning.net> → 🐞 in the header. The blue
   button now says **Send report**. Pick *Question*, type `Test from the in-app
   reporter`, press **Send report**: the dialog thanks you with a link to a new
   issue. Open it, check it reads right, and close it.

The token can do one thing, on one repository: read and write its issues.
Anybody holding it could open, edit or close issues here, and nothing else,
which is why it lives only in the Worker's secrets.

**Issues filed this way show as opened by you**, since it is your token, and
GitHub does not notify you about your own actions. They still land in the issue
list, labelled `bug`, `enhancement` or `question`, each ending *"Sent straight
from the app"*. To get an email about each one as well, add the email route
below.

## Also, or instead: email (about 5 minutes, after #237 Part 2)

This needs Resend sending from `floodwarning.net`, which is #237's Part 2. Once
that domain says **Verified**:

1. <https://resend.com/api-keys> → **Create API key** → **Name:**
   `Flood-Net bug reports`, **Permission:** **Sending access**, **Domain:**
   `floodwarning.net` → **Add**. Copy the key (it starts `re_`).
2. In the same Cloudflare page as above, add two secrets and **Deploy**:
   - `RESEND_API_KEY`: the key;
   - `REPORT_EMAIL_TO`: the address reports should go to. For more than one,
     separate them with commas. It is a secret rather than written in the code
     so that no address sits in a public repository.
3. Send a test report as above. It arrives from `noreply@floodwarning.net`, with
   the issue's link at the top if the GitHub route is on too.

With only these two set and no GitHub token, reports go by email alone, and
nothing is posted publicly.

## What stops misuse

The route takes reports from anybody, since the dialog is for people with no
account of any kind. So the limits are on volume and reach, not on who:

- **Only Flood-Net's own pages** (`floodwarning.net`, and the github.io copy)
  can send one. Another website cannot have its visitors' browsers do it.
- **3 a minute from one address** (`REPORT_RATE_LIMIT` in `wrangler.toml`).
- **25 a day in all** (`DAY_MAX` in `worker/report.js`), counted per UTC day in
  the photo bucket under `_meganet/reports/`. After that, the dialog offers
  GitHub's own page for the rest of the day, where a person can still file a
  report under their own account.
- **Sizes:** a title of 256 characters, a report of 60,000 (longer ones are cut,
  and say so).
- **No reaching anyone else on GitHub:** an `@mention`, or a reference into
  another repository (`owner/repo#12`), is broken so that it notifies nobody.

**The repository is public, so the issue is too.** The dialog says so beside
the box and asks people to leave out passwords, gate or padlock codes, and
anyone's phone number or email. The diagnostics it adds are shown under
*Preview exactly what will be shared*, and any part of the page address that
could be a sign-in token is replaced with `(removed)`. If a report does carry
something private, edit or delete the issue on GitHub as usual.

## Switching it off

Delete the secrets (the same Cloudflare page → the delete icon beside each →
**Deploy**). The dialog goes back to GitHub's pre-filled page at once. To
revoke the token itself: <https://github.com/settings/personal-access-tokens> →
`Flood-Net bug reports` → **Delete**.
