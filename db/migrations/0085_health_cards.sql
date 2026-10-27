-- 0085_health_cards.sql — Each station as the Station Health tab shows it when
-- it is opened — its findings, its learned check schedule day by day, its
-- battery's night lows — kept by the database for the agent API.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0085_health_cards.sql
--
-- Why this file exists
-- ────────────────────
-- A field team asked for the tab's per-station findings through the agent
-- API: GET /api/v1/stations/{id}/health?days=3|7|14 — the station's findings
-- (severity, what, what to do, since, evidence), its learned check schedule
-- with what arrived and what was missed each day, and its battery's night-low
-- trend — and GET /api/v1/health/findings for a page of stations at a time,
-- to plan a campaign from. Until now that was worked out only in a browser
-- with the tab open; 0059 kept the findings about a present condition (silent,
-- a battery low …) and nothing else.
--
-- The Worker cannot work it out per request: the analysis of a week takes
-- seconds of CPU and needs every station's readings to know whether a
-- station's receivers were listening. tools/health/report.mjs already runs it
-- every fifteen minutes (0059, .github/workflows/station-health.yml); now it
-- also writes down, for each of the tab's windows, one card per station heard
-- (tools/health/cards.mjs has the shape) and reports them here.
--
--   1. health_card             one row per (window, station): the card, and
--                              its worst severity and finding counts so a
--                              page of stations can be sorted and filtered
--                              without reading every card. A card is
--                              rewritten only when it changed.
--   2. health_card_run         when each window was last worked out, and what
--                              from — so a reader can tell a card that has not
--                              changed from a schedule that has stopped.
--   3. report_station_cards()  the door in, the secret key only. Takes a run's
--                              cards a batch at a time (a fortnight's is about
--                              2.5 MB in all): upserts the batch, and — when
--                              the run read everything — removes the cards of
--                              stations it no longer heard. Refuses a batch
--                              from a run older than the last accepted.
--
-- Who reads it: everybody. The cards are worked out from readings anybody may
-- read (0006, 0050), like the station findings 0059 made public; the agent API
-- reads them with the publishable key.
--
-- Depends on 0059 (the run that reports them) only in spirit: nothing here
-- references its tables, so it applies with or without 0060–0084.
-- tools/check_health_cards.sql proves it.

-- ── 1. The cards ─────────────────────────────────────────────────────────────

create table if not exists meganet.health_card (
  -- The window it was worked out over, in days: the tab's 3, 7 or 14.
  days        smallint     not null,
  station_id  text         not null,
  -- The station's status as the tab gives it: its worst own finding, else
  -- ok, or irregular when no check schedule could be learned.
  status      text,
  -- The worst severity among every finding about it (its own, as a
  -- repeater, as one of a group); null for none.
  worst       text,
  findings    integer      not null default 0,
  -- Of those, how many need attention: a warning or worse.
  attention   integer      not null default 0,
  card        jsonb        not null,
  -- The run that last changed it; meganet.health_card_run says when it was
  -- last looked at.
  changed_at  timestamptz  not null,
  primary key (days, station_id),

  constraint health_card_days     check (days in (3, 7, 14)),
  constraint health_card_station  check (pg_catalog.length(station_id) between 1 and 200),
  constraint health_card_status   check (status is null or status in ('critical', 'warn', 'info', 'ok', 'irregular')),
  constraint health_card_worst    check (worst is null or worst in ('critical', 'warn', 'info')),
  constraint health_card_counts   check (findings >= 0 and attention between 0 and findings),
  constraint health_card_body     check (pg_catalog.jsonb_typeof(card) = 'object' and pg_catalog.octet_length(card::text) <= 32768)
);

comment on table meganet.health_card is
  'Each station heard, as the Station Health tab shows it when opened (0085): its findings with evidence and action, its learned check schedule with what arrived and was missed each day, its battery''s night lows and trend — one row per window (3, 7, 14 days) and station, worked out by health-analysis.js every fifteen minutes (tools/health/report.mjs, tools/health/cards.mjs for the shape) and read by the agent API. Public, like the readings it comes from.';
comment on column meganet.health_card.card is
  'tools/health/cards.mjs'' card: { v, station_id, name, station_number, status, last_heard_at, heard_by, findings[], schedule, battery }.';

alter table meganet.health_card enable row level security;
drop policy if exists health_card_read on meganet.health_card;
create policy health_card_read on meganet.health_card
  for select to anon, authenticated
  using (true);

-- ── 2. When each window was last worked out ──────────────────────────────────

create table if not exists meganet.health_card_run (
  days     smallint     primary key,
  at       timestamptz  not null,
  -- What the run said about itself: the window, the readings it read, how
  -- many stations it heard, whether it read everything, the commit it ran.
  detail   jsonb        not null default '{}'::jsonb,
  constraint health_card_run_days   check (days in (3, 7, 14)),
  constraint health_card_run_detail check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.octet_length(detail::text) <= 4096)
);

comment on table meganet.health_card_run is
  'When each Station Health window''s cards were last worked out, and from what (0085). Public, so a reader can tell a card that has not changed from a schedule that has stopped.';

alter table meganet.health_card_run enable row level security;
drop policy if exists health_card_run_read on meganet.health_card_run;
create policy health_card_run_read on meganet.health_card_run
  for select to anon, authenticated
  using (true);

-- ── 3. The door in ───────────────────────────────────────────────────────────
-- POST /rest/v1/rpc/report_station_cards with the secret key, body
--   {"p_report": {"at": "<the analysis' now>", "days": 7, "complete": true,
--                 "detail": {"t0", "t1", "readings", "stations", "commit", …},
--                 "heard": ["<every station id the run heard>", …],
--                 "cards": [{"station_id", "status", "worst", "findings",
--                            "attention", "card"}, …]}}
-- → {"at", "days", "upserted", "unchanged", "removed"}, or {"stale": true}
--   for a batch from a run older than the last one accepted.
--
-- A run sends its cards in batches, each carrying the run's `at` and the whole
-- `heard` list: a batch from the run already accepted is taken (the same at),
-- an older one refused. `removed` drops the cards of stations not in `heard`
-- — only when the run read everything (`complete`), so a capped read never
-- forgets a station it merely did not reach.

create or replace function meganet.report_station_cards(p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at        timestamptz;
  v_last      timestamptz;
  v_days      smallint;
  v_complete  boolean;
  v_detail    jsonb;
  v_heard     text[];
  c           jsonb;
  v_i         integer := 0;
  v_up        integer := 0;
  v_same      integer := 0;
  v_removed   integer := 0;
  v_n         integer;
begin
  if p_report is null or pg_catalog.jsonb_typeof(p_report) <> 'object' then
    raise exception 'report_station_cards takes an object' using errcode = '22023';
  end if;
  begin
    v_at := (p_report ->> 'at')::timestamptz;
  exception when others then
    raise exception 'at is not a time: %', pg_catalog.left(p_report ->> 'at', 40) using errcode = '22023';
  end;
  if v_at is null or v_at > pg_catalog.now() + interval '5 minutes' or v_at < pg_catalog.now() - interval '1 day' then
    raise exception 'at must be within the last day, not %', coalesce(v_at::text, 'missing') using errcode = '22023';
  end if;
  if coalesce(p_report ->> 'days', '') not in ('3', '7', '14') then
    raise exception 'days is 3, 7 or 14, not %', coalesce(pg_catalog.left(p_report ->> 'days', 20), 'missing') using errcode = '22023';
  end if;
  v_days := (p_report ->> 'days')::smallint;
  if pg_catalog.jsonb_typeof(p_report -> 'cards') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_report -> 'cards') > 500 then
    raise exception 'cards is a list of at most 500 — send a run''s cards in batches' using errcode = '22023';
  end if;
  v_complete := coalesce((p_report -> 'complete') = 'true'::jsonb, false);
  if v_complete and (pg_catalog.jsonb_typeof(p_report -> 'heard') is distinct from 'array'
                     or pg_catalog.jsonb_array_length(p_report -> 'heard') > 20000
                     or exists (select 1 from pg_catalog.jsonb_array_elements(p_report -> 'heard') h
                                 where pg_catalog.jsonb_typeof(h) <> 'string')) then
    raise exception 'a complete report names every station it heard: heard is a list of at most 20,000 ids' using errcode = '22023';
  end if;
  v_detail := coalesce(nullif(p_report -> 'detail', 'null'::jsonb), '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_detail) <> 'object' or pg_catalog.octet_length(v_detail::text) > 4096 then
    raise exception 'detail is an object of at most 4 KB' using errcode = '22023';
  end if;

  -- One batch at a time, and never one from an older run over a newer.
  perform pg_catalog.pg_advisory_xact_lock(8500085);
  select r.at into v_last from meganet.health_card_run r where r.days = v_days;
  if v_last is not null and v_at < v_last then
    return pg_catalog.jsonb_build_object('stale', true, 'at', v_at, 'days', v_days, 'last', v_last);
  end if;

  for c in select * from pg_catalog.jsonb_array_elements(p_report -> 'cards') loop
    v_i := v_i + 1;
    if pg_catalog.jsonb_typeof(c) <> 'object'
       or pg_catalog.length(coalesce(c ->> 'station_id', '')) not between 1 and 200
       or (c ? 'status' and c -> 'status' <> 'null'::jsonb and coalesce(c ->> 'status', '') not in ('critical', 'warn', 'info', 'ok', 'irregular'))
       or (c ? 'worst' and c -> 'worst' <> 'null'::jsonb and coalesce(c ->> 'worst', '') not in ('critical', 'warn', 'info'))
       or pg_catalog.jsonb_typeof(c -> 'findings') is distinct from 'number'
       or pg_catalog.jsonb_typeof(c -> 'attention') is distinct from 'number'
       or pg_catalog.jsonb_typeof(c -> 'card') is distinct from 'object'
       or pg_catalog.octet_length((c -> 'card')::text) > 32768 then
      raise exception 'card % is not one: it needs a station_id, a status and worst severity or null, finding counts, and a card object of at most 32 KB', v_i
        using errcode = '22023';
    end if;
    insert into meganet.health_card as hc (days, station_id, status, worst, findings, attention, card, changed_at)
    values (v_days, c ->> 'station_id', nullif(c ->> 'status', ''), nullif(c ->> 'worst', ''),
            (c ->> 'findings')::numeric::integer, (c ->> 'attention')::numeric::integer, c -> 'card', v_at)
    on conflict (days, station_id) do update set
      status = excluded.status, worst = excluded.worst, findings = excluded.findings,
      attention = excluded.attention, card = excluded.card, changed_at = excluded.changed_at
    where hc.card is distinct from excluded.card
       or hc.status is distinct from excluded.status
       or hc.worst is distinct from excluded.worst;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_up := v_up + 1; else v_same := v_same + 1; end if;
  end loop;

  if v_complete then
    select pg_catalog.array_agg(h) into v_heard
      from pg_catalog.jsonb_array_elements_text(p_report -> 'heard') h;
    delete from meganet.health_card hc
     where hc.days = v_days and hc.station_id <> all (coalesce(v_heard, '{}'::text[]));
    get diagnostics v_removed = row_count;
  end if;

  -- A later batch of the same run adds to what the first said about it.
  insert into meganet.health_card_run as r (days, at, detail)
  values (v_days, v_at, v_detail || pg_catalog.jsonb_build_object('complete', v_complete))
  on conflict (days) do update set at = excluded.at,
    detail = case when r.at = excluded.at then r.detail || excluded.detail else excluded.detail end;

  return pg_catalog.jsonb_build_object('at', v_at, 'days', v_days, 'complete', v_complete,
           'upserted', v_up, 'unchanged', v_same, 'removed', v_removed);
end;
$$;

comment on function meganet.report_station_cards(jsonb) is
  'What health-analysis.js worked out about each station heard over one of Station Health''s windows, reported a batch at a time by .github/workflows/station-health.yml (0085): upserts the cards that changed, removes those of stations a complete run no longer heard, refuses a batch from a run older than the last accepted. The secret key only.';

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.report_station_cards(jsonb) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.health_card     to anon, authenticated, service_role;
  grant select on meganet.health_card_run to anon, authenticated, service_role;
  grant execute on function meganet.report_station_cards(jsonb) to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.health_card') is null or pg_catalog.to_regclass('meganet.health_card_run') is null then
    raise exception '0085 did not take: a table is missing';
  end if;
  if not (select pg_catalog.bool_and(c.relrowsecurity) from pg_catalog.pg_class c
           where c.oid in ('meganet.health_card'::pg_catalog.regclass, 'meganet.health_card_run'::pg_catalog.regclass)) then
    raise exception '0085 did not take: RLS is off on one of its tables';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.health_card', 'select')
       or not pg_catalog.has_table_privilege('anon', 'meganet.health_card_run', 'select') then
      raise exception '0085 did not take: anon cannot read the cards';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.health_card', 'insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.health_card', 'insert,update,delete')
       or pg_catalog.has_table_privilege('anon', 'meganet.health_card_run', 'insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.health_card_run', 'insert,update,delete') then
      raise exception '0085 did not take: a browser role can write the cards';
    end if;
    if pg_catalog.has_function_privilege('anon', 'meganet.report_station_cards(jsonb)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.report_station_cards(jsonb)', 'execute') then
      raise exception '0085 did not take: a browser role can report cards';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '85')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
