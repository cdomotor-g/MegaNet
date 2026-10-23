# Datastore decision

**Decided:** 11 August 2026 · **Ticket:** [#71](https://github.com/cdomotor-g/MegaNet/issues/71), under epic [#70](https://github.com/cdomotor-g/MegaNet/issues/70) · **Status:** in force · **Plan:** Pro since October 2026 ([what changed](#pro-plan-from-october-2026))

Flood-Net's datastore is **Postgres, hosted on Supabase**, in a **dedicated
project** (`MegaNet`, ref `jjprlritvhdqpvphfrnu`) in **`ap-southeast-2` (Sydney)**,
on the **Pro plan** (it was on the free tier until October 2026),
with all schema kept as plain SQL in [`db/migrations/`](../db/migrations/) and
applied with `psql`.

This note exists so the next person does not re-litigate the choice from scratch —
the same job the README's terrain and ACMA notes do. If you are about to change
one of these, the reasoning is here; argue with it rather than around it.

## What was checked

### Pro plan, from October 2026

The org moved to Supabase's Pro plan in October 2026; the database was 703 MB by
then, past the free tier's 500 MB. What that changes for Flood-Net:

| | On Pro |
| --- | --- |
| Database size | No 500 MB read-only ceiling. **8 GB of disk is included per project**; at 90% full the disk grows by half and the extra is billed (about US$0.125 per GB a month), unless the spend cap is on, which holds it at 8 GB and goes read-only there instead. The Admin tab's meter reads against the 8 GB. |
| Inactivity | **Pro projects do not pause.** The pause below no longer applies. |
| Egress | **250 GB/month** uncached and 250 GB cached across the org, billed past that. |
| File storage | **100 GB** across the org, billed past that. The field photos stay in R2 anyway ([`field-photos.md`](field-photos.md)). |
| Active projects | No cap, but every project runs its own instance and bills compute. The plan's US$10 compute credit covers one Micro instance; each further active project adds about US$10 a month. |

Sources: Supabase's [database size](https://supabase.com/docs/guides/platform/database-size),
[disk size](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size),
[egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress) and
[compute](https://supabase.com/docs/guides/platform/manage-your-usage/compute) docs.

The rest of this section is the free-tier reading the decision was made on, kept
as it was.

### Free-tier limits, confirmed 11 Aug 2026

The numbers in #70 were from mid-2026 and worth re-reading. As of this date, on
the Free plan:

| | Limit |
| --- | --- |
| Active projects | **2**, counted across every org where you are Owner or Admin. Paused projects do not count. |
| Database size | **500 MB per project.** Past it the database goes read-only — this is the one that bites. |
| Disk | 1 GB per project (separate from the 500 MB database-size quota). |
| Egress | **5 GB/month** across the org, plus a further ~5 GB of cached bandwidth. |
| Inactivity | Paused after **7 days** without enough database activity. A warning email comes about a week earlier; a paused project is restorable for **90 days**. |
| Storage / Realtime / Edge | 1 GB · 2M messages, 200 peak connections · 500k invocations. None of it used here. |

Sources: Supabase's [billing](https://supabase.com/docs/guides/platform/billing-on-supabase),
[database size](https://supabase.com/docs/guides/platform/database-size) and
[project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) docs.

### Does it fit?

Comfortably. `stations.json` is 3.5 MB of JSON covering 3,174 stations, 8,815
sensor rows and 15 radio networks. Normalised into tables with indexes, call it
low tens of MB — under a tenth of the 500 MB ceiling, with the whole ACMA and
terrain story still living outside the database. Egress is a non-issue while the
only traffic is a version string per page load.

**The pause is the real constraint, not the size.** A tool used in bursts — nothing
for three weeks, then hard for two days — is precisely the shape that gets paused,
and a paused project fails the app's read rather than slowing it. Two mitigations,
neither built yet: the Data source panel makes a pause visible and named instead
of mysterious, and #B2 onwards should keep `stations.json` working as a fallback
so a paused database degrades to "yesterday's data" rather than "no data".
*(October 2026: on Pro the project does not pause. Both mitigations were built
and stay, because an outage, a maintenance window or a field laptop with no
signal fails the read the same way.)*

### Room in the org

`cdomotor-g's Org` (Free) holds `MegaNet` and `SoRT` active, with `F-TIDE` paused
and so not counting. That is **2 of 2 active projects used**. Not a problem for
this ticket, but worth knowing before anyone reaches for a third: it would mean
pausing one, or paying.

The Singapore project was deleted outright rather than left paused, so it occupies
neither a slot nor a restore window.

*(October 2026: Pro has no two-project limit. Each active project bills its own
compute instead; see [Pro plan](#pro-plan-from-october-2026).)*

## The decisions

**A dedicated project, not a second schema in a shared one.** #70 recommended a
`meganet` schema inside the existing free project. A dedicated project was created
instead, and that is the better call now that the org has room for it: the 500 MB
quota and the pause timer are both *per project*, so sharing one would couple
Flood-Net's headroom and its uptime to an unrelated app's usage. It also keeps the
anon key scoped to data Flood-Net owns — a key shared across apps is a key that
leaks two apps' data at once.

**Still a `meganet` schema inside it**, rather than dumping tables in `public`.
`public` is where Supabase's own machinery and every copy-pasted snippet land by
default. Keeping our tables out of it means "what belongs to Flood-Net" is
answerable by listing one schema, and nothing arrives there by accident. It costs
one line of config (see `db/README.md`) and an `Accept-Profile` header per request.

**Region: `ap-southeast-2` (Sydney).** The nearest region to Queensland, which is
what #71 asked for and what every read from a browser here pays for. Brisbane→Sydney
is roughly 15–25 ms round trip against roughly 110–130 ms to Singapore.

The first project was created in `ap-southeast-1` (Singapore) and moved before any
station data existed. That timing was the whole point: region is fixed at creation,
so changing it means destroying and recreating the project, and the window in which
that costs ten minutes rather than a data migration closes the moment #B2 lands.
Recorded here because the *next* region question — a read replica, a second
environment — will face the same one-way door.

Because the org sits at its 2-project cap the move was a destroy-then-create rather
than a create-then-migrate, which is the more anxious order to do it in. Worth
knowing if it ever has to happen again: pause the old project first, so it stops
counting against the cap while remaining restorable for 90 days.

**Schema as plain SQL, applied with `psql`.** No ORM, no migration framework, no
`npm`. This repo has no build step and gains nothing by growing one for five
tables. Numbered, forward-only, idempotent files that a human can read and apply.

**The anon key is committed, and RLS is what protects the data.** The key
identifies the project and authorises nothing. Every table is created with RLS
enabled and an explicit policy *in the same migration*, and grants are named per
table — no `alter default privileges`, so a new table is never exposed by
inheritance. The rule and its rationale are in `db/README.md`; it is the one thing
in this whole setup that fails catastrophically and silently if ignored.

Used the modern `sb_publishable_…` key rather than the legacy anon JWT: same
guarantees, but independently rotatable, so a rotation does not invalidate
everything else at once.

## What this ticket did not decide

- **Writes.** Nothing is granted `insert`/`update`/`delete` to `anon`. How the app
  authenticates a writer is #B3's problem and deliberately untouched here.
- **The station tables.** `app_meta` is the only table. The shape of stations,
  sensors and networks in Postgres is #B2.
- **Fallback behaviour.** The app still loads `stations.json` exactly as before;
  the datastore is additive and nothing depends on it yet.

## Known, and left alone

Supabase's security advisor flags `public.rls_auto_enable()` — a `SECURITY
DEFINER` function reachable by `anon` at `/rest/v1/rpc/rls_auto_enable`. It is a
Supabase platform object, not ours: an event trigger that auto-enables RLS on new
tables in `public`. Called directly over the API it iterates an empty DDL command
list and does nothing, so it is not a way in. Left alone rather than hardened,
because it is the platform's to manage and revoking it may break their tooling or
be silently restored.

Two things follow from it that *do* matter to us, and both are already handled:
its enforced list is `public` only, so it will never enable RLS on a `meganet`
table — which is why that rule is a hard one in `db/README.md` — and it is why the
advisor will keep reporting a warning against this project that is not ours to
fix.

Present on the Singapore project this one replaced and, checked after the move, on
this one too — it ships with new Supabase projects rather than being something
either was configured into. The two warnings the advisor reports against this
project are both this function, and both are expected.
