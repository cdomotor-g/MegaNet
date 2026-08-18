-- 0016_inspection_events.sql — Derived maintenance events, mined from the
-- archive's Remarks prose (#127).
--
-- The Remarks column is where the actual maintenance history lives — battery
-- and panel replacements, gas services, hazards, floods — written in field
-- shorthand no other column records. tools/ingest/remarks.py reads every
-- remark (all of them; the coverage is a checked count, not a sample) and
-- derives typed events. This file gives those events a home that keeps the
-- issue's discipline in the schema itself:
--
--   * An event is a READING of a remark, never a replacement for it. Every row
--     carries `quote` — the exact span it was read from — and `rule`, the rule
--     that read it, so a doubted event can be checked against its own prose in
--     one glance. The remark itself stays untouched on meganet.inspection.
--   * Derived means derived: `method` names the rules version, and nothing
--     here is writable through the Data API by anyone — not editors, not
--     anon. The loader (a re-runnable sync keyed on uuid5 ids, load.py's
--     discipline) is the only writer, and a typed correction belongs in the
--     rules, not in a hand-edited row that the next sync would erase.
--   * Confidence is two-valued on purpose: 'high' or 'medium'. The miner
--     ships nothing it would have to call 'low' — that is spelled
--     "unclassified" and stays out of this table entirely.
--   * The gas figures ('17000/500/40') travel in `detail` as an ordered list
--     with `figures_meaning: 'unconfirmed'` — the convention has not been
--     confirmed with the network's operator, so the numbers are captured, not
--     named. See #127.
--
-- Reading: the event types are public vocabulary; the events are editors-only,
-- because a quote is a slice of a remark and remarks carry site-access notes
-- (0009's reasoning, inherited rather than re-decided).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0016_inspection_events.sql

-- ── The vocabulary ───────────────────────────────────────────────────────────
-- Seeded from tools/ingest/remarks.py's EVENT_TYPES — one source of truth; the
-- loader's foreign key is what refuses a type the two files disagree on.

create table if not exists meganet.inspection_event_type (
  key   text primary key,
  ord   integer not null,
  label text not null,
  note  text not null
);

comment on table meganet.inspection_event_type is
  'Event types tools/ingest/remarks.py can derive from a remark (#127). Public: the vocabulary explains the reading; the readings themselves are editors-only.';

insert into meganet.inspection_event_type (key, ord, label, note) values
  ('equipment_replaced', 1, 'Equipment replaced',
   'A named piece of equipment was replaced, renewed or newly installed.'),
  ('equipment_fault', 2, 'Equipment fault',
   'A named piece of equipment found faulty, blocked, leaking, unserviceable or otherwise wrong.'),
  ('calibration', 3, 'Calibration',
   'A calibration, recalibration or adjustment was performed or recorded.'),
  ('gas_service', 4, 'Gas service',
   'Gas system serviced: purge, bottle change, or the recurring N/N/N figures (convention unconfirmed — the numbers are captured, not named).'),
  ('commissioning', 5, 'Commissioning',
   'Station installed, commissioned, or upgraded from one configuration to another.'),
  ('decommissioning', 6, 'Decommissioning',
   'Station decommissioned, closed or removed.'),
  ('whs_hazard', 7, 'WHS hazard',
   'A workplace health and safety hazard: bees, wasps, snakes, ladder or access safety, electrical.'),
  ('vegetation', 8, 'Vegetation',
   'Vegetation encroachment or clearing: trees, shade on the panel or gauge, undergrowth.'),
  ('wildlife_intrusion', 9, 'Wildlife intrusion',
   'Wildlife in the works: ants, frogs, birds, spiders, termites, cattle.'),
  ('access_issue', 10, 'Access issue',
   'Site could not be reached or entered: locked, no key, road, permission.'),
  ('site_damage', 11, 'Site damage',
   'Damage to the site: flood, storm, lightning, vandalism, fire, theft, corrosion of structure.'),
  ('config_change', 12, 'Configuration change',
   'Radio or logger configuration changed or recorded: pass ranges, ALERT ids, check-signal rate, delays.')
on conflict (key) do update set
  ord = excluded.ord, label = excluded.label, note = excluded.note;

-- ── The events ───────────────────────────────────────────────────────────────

create table if not exists meganet.inspection_event (
  id            uuid primary key,
  inspection_id uuid not null references meganet.inspection(id) on delete cascade,
  ord           integer not null,
  event_type    text not null references meganet.inspection_event_type(key),
  confidence    text not null check (confidence in ('high', 'medium')),
  rule          text not null,
  quote         text not null,
  detail        jsonb not null default '{}'::jsonb,
  method        text not null,
  created_at    timestamptz not null default now(),
  unique (inspection_id, ord)
);

comment on table meganet.inspection_event is
  'Derived maintenance events mined from inspection remarks by tools/ingest/remarks.py (#127). Each row is a reading of a remark, never a replacement for it: `quote` is the exact span it was read from, `rule` the rule that read it, `method` the rules version. Written only by the loader''s sync; nothing writable through the Data API.';
comment on column meganet.inspection_event.quote is
  'The span of the remark this event was read from — shown wherever the event is, so the prose stays the source of truth.';
comment on column meganet.inspection_event.detail is
  'Structured capture where the shorthand genuinely supports one: equipment key, gas figures (ordered, meaning unconfirmed).';

create index if not exists inspection_event_inspection_idx
  on meganet.inspection_event (inspection_id);
create index if not exists inspection_event_type_idx
  on meganet.inspection_event (event_type);

alter table meganet.inspection_event_type enable row level security;
alter table meganet.inspection_event      enable row level security;

drop policy if exists inspection_event_type_read_all on meganet.inspection_event_type;
create policy inspection_event_type_read_all on meganet.inspection_event_type
  for select using (true);

drop policy if exists inspection_event_read_editors on meganet.inspection_event;
create policy inspection_event_read_editors on meganet.inspection_event
  for select to authenticated using (meganet.is_editor());

-- ── Grants — Data API setup, skipped off Supabase ───────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.inspection_event_type to anon, authenticated;
  grant select on meganet.inspection_event to authenticated;

  -- No write verbs for anyone the API can mint. Stated as revokes as well as
  -- omissions, for 0010's reason: the property should survive a later grant
  -- that nobody has typed yet.
  revoke insert, update, delete on meganet.inspection_event_type from anon, authenticated;
  revoke insert, update, delete on meganet.inspection_event      from anon, authenticated;
end
$$;

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so.

do $$
begin
  if to_regclass('meganet.inspection_event') is null then
    raise exception '0016 did not take: meganet.inspection_event is missing';
  end if;
  if (select count(*) from meganet.inspection_event_type) < 12 then
    raise exception '0016 did not take: the event vocabulary is short';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 15 → 16 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '16')
on conflict (key) do update set value = excluded.value;
