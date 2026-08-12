-- 0004_station_writes.sql — Save means saved. The write path for the station
-- editor, and the soft delete that makes a mis-click survivable.
--
-- Until now the editor's Save button rearranged an array in a browser tab. This
-- file is the other half: two functions the app calls, a soft delete, an
-- optimistic-concurrency check, and the authorisation that decides who may call
-- any of it.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0004_station_writes.sql
--
-- Four decisions run through everything below, and they are worth stating before
-- the SQL rather than discovering in it.
--
-- **The RPCs are the only write path.** meganet.save_station() and
-- meganet.delete_station() are `security definer`, and no write privilege is
-- granted to `anon` or `authenticated` on any table. That is deliberate. A
-- station is not one row — it is a row, its sensors, its repeater and that
-- repeater's pass ranges — and a repeater whose ranges half-saved is worse than
-- one that did not save at all. Routing every write through a function makes the
-- whole edit one transaction, and makes the soft delete and the concurrency
-- check impossible to go around: a `DELETE /station?id=eq.x` cannot hard-delete
-- what it was never granted permission to touch.
--
-- **Authorisation is checked in the function, and again by RLS.** A definer
-- function runs as its owner and so runs past RLS; the `if not
-- meganet.is_editor()` at the top of each one is therefore the check that
-- actually decides. The policies added at the foot of this file are the second
-- lock — they cost nothing today and are what stands between a future
-- `grant update … to authenticated` and an open database.
--
-- **Delete is soft.** Three thousand stations curated over years, one mis-click.
-- `deleted_at` is stamped, the document stops carrying the station, and the row —
-- with its sensors, repeater and ranges — is still there:
--
--   update meganet.station set deleted_at = null where id = 'the_station';
--
-- **A concurrent edit is refused, never merged.** Every write carries the
-- `updated_at` the editor loaded with, and is rejected if the row has moved
-- since. The error carries SQLSTATE `PT409`, which PostgREST turns into HTTP 409
-- — so the app can tell "somebody else got there first" from "the network is
-- down" without parsing an error message.

-- ── The two new columns ──────────────────────────────────────────────────────

-- Soft delete. Null means live, which is why it is the default and why the
-- document filters on it rather than on a flag somebody has to remember to set.
alter table meganet.station add column if not exists deleted_at timestamptz;

comment on column meganet.station.deleted_at is
  'Soft delete. Null = live. Set by meganet.delete_station(); cleared by hand to restore.';

-- The editor has offered a TBRG bucket size since long before there was a
-- database, and had nowhere to put it: the field wrote to memory and was lost on
-- the next reload. A write path that silently drops a field the form collects is
-- worse than one that never offered it, so the column lands with the writes.
--
-- No station carries a value today, so the document is unchanged for every one
-- of them — the key is emitted only when the column is non-null, exactly like
-- `lga` and `basin` (see the view below). tools/check_stations_doc.py still
-- matches the committed file.
alter table meganet.station add column if not exists tbrg_bucket_size numeric;

comment on column meganet.station.tbrg_bucket_size is
  'Tipping-bucket rain gauge size, mm per tip. Null = not recorded, which is not the same as zero — the app falls back to an assumed 0.2 and says so. Document key: TBRGbucketSize.';

-- How a soft delete meets meganet.load_stations_doc(), which is a *sync*: every
-- row in the document upserted, every row not in it deleted.
--
-- A deleted station is not in the document, so a snapshot taken after the delete
-- does not carry it, and loading that snapshot removes the row for real. That is
-- the intended end state and it needs no code.
--
-- Loading an *older* document — the copy committed in this repo, say — puts the
-- row back, still flagged deleted and so still absent from the document. That is
-- odd-looking rather than wrong, and it is undone the same way every other
-- restore is:
--
--   update meganet.station set deleted_at = null where id = 'the_station';
--
-- The tempting alternative was a trigger that cleared deleted_at whenever the
-- loader touched a row. It was written, and then deleted: the only way for a
-- trigger to recognise the loader is by the `updated_by` value it writes, that
-- value stays on the row afterwards, and so *any* later update to a
-- loader-written row — a hand-run `update … set lat = …` — would silently
-- resurrect a deleted station. A quiet un-delete is a worse failure than the
-- tidy-up it was buying.

-- ── Who may edit ─────────────────────────────────────────────────────────────
-- The sign-in itself is #B8's job: verified @bom.gov.au, with an allowlist for
-- everyone else. This is the half that lives in the database — given a request,
-- may it write? Both halves have to exist before an edit reaches a table, and
-- this one is the one that cannot be bypassed by a browser.
--
-- Until #B8 ships there are no sessions, so `authenticated` never happens and
-- every write from the app is refused with "not authorised". That is the correct
-- behaviour for a write path that has landed ahead of its gate: it is wired,
-- it is proven refused, and it turns on when the sign-in does.

create table if not exists meganet.editor_allow (
  -- Either a whole address ('someone@example.org') or a domain with its at-sign
  -- ('@bom.gov.au'), matched case-insensitively. One column rather than two
  -- tables: the question is always "does this email match anything on the list",
  -- and the leading @ says which kind of entry it is without a `kind` column
  -- that could disagree with the value next to it.
  entry     text        primary key,
  note      text        not null default '',
  added_at  timestamptz not null default now(),
  added_by  text
);

comment on table meganet.editor_allow is
  'Who may write. Entries are an email or a domain with its at-sign. Read only through meganet.email_allowed(); no role holding the anon key can select it.';

alter table meganet.editor_allow enable row level security;

-- No policy for any verb, on purpose, and no grant below either. This table
-- holds a list of named people; nothing that reaches it over the Data API has
-- any business reading it. meganet.email_allowed() is `security definer` and is
-- the only way in.
drop policy if exists editor_allow_no_one on meganet.editor_allow;

insert into meganet.editor_allow (entry, note, added_by)
values ('@bom.gov.au', 'Bureau staff, per #B8', '0004_station_writes')
on conflict (entry) do nothing;

create or replace function meganet.email_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from meganet.editor_allow a
     where pg_catalog.lower(a.entry) = pg_catalog.lower(p_email)
        or (pg_catalog.left(a.entry, 1) = '@'
            and pg_catalog.lower(p_email) like '%' || pg_catalog.lower(a.entry))
  );
$$;

comment on function meganet.email_allowed(text) is
  'Is this address on the editors list, by name or by domain? Definer, so the list itself stays unreadable.';

-- The gate.
--
-- "Which role is asking" is read from the `role` GUC rather than from
-- `current_user`, and that is not a stylistic choice. save_station() below is
-- `security definer`, and inside a definer function `current_user` is the
-- function's *owner* — so a check written against it would ask "is postgres
-- allowed to write", answer yes, and wave every caller through. `SET LOCAL ROLE
-- authenticated`, which is exactly what PostgREST does for each request, sets
-- the `role` GUC, and a GUC is not touched by entering a definer function. It
-- still says `authenticated` inside one, which is the question being asked.
--
-- `none` is what the GUC reads when nothing has done SET ROLE at all: a direct
-- connection, where the role that logged in is the answer.
create or replace function meganet.is_editor()
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  claims jsonb;
  v_role text;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(nullif(pg_catalog.current_setting('role', true), 'none'),
                     claims ->> 'role',
                     current_user::text);

  -- Anonymous, always, whatever else is true. `anon` is the role a request with
  -- no Authorization header lands in, and it is also where a request bearing a
  -- token PostgREST could not verify lands.
  if v_role in ('anon', 'authenticator') then
    return false;
  end if;

  -- The service key. It is a server-side secret, never in a browser, and is what
  -- a maintenance script or a workflow holds.
  if v_role = 'service_role' then
    return true;
  end if;

  if v_role = 'authenticated' then
    if claims is null then
      return false;
    end if;
    -- An unverified address is an address somebody typed, not one they proved
    -- they hold. Absent means the provider did not say, which #B8's magic-link
    -- flow does not do — present-and-false is the case being refused here.
    if (claims -> 'user_metadata' ->> 'email_verified') = 'false' then
      return false;
    end if;
    return meganet.email_allowed(claims ->> 'email');
  end if;

  -- Anything else is a direct database connection — psql, a migration, a
  -- scheduled job. It writes with whatever its own role was granted, and there
  -- is nothing here for it to get around.
  return true;
end;
$$;

comment on function meganet.is_editor() is
  'May the current request write? Anon never; service_role always; authenticated when its verified email is on meganet.editor_allow.';

-- Who the write is attributed to. Stamped server-side into updated_by, never
-- taken from the client — a field the browser fills in is a field the browser
-- can forge.
create or replace function meganet.actor()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    -- Same reason as is_editor(): under a definer function current_user is the
    -- owner, so the role GUC is the one that still names the caller.
    nullif(pg_catalog.current_setting('role', true), 'none'),
    current_user::text);
$$;

comment on function meganet.actor() is
  'The email on the request''s token, or the database role for a direct connection. Goes in updated_by.';

-- ── The document, one station at a time ──────────────────────────────────────
-- 0002 built the whole document in a single view. Two things have to change now:
-- deleted stations must drop out of it, and a *single* station's fragment has to
-- be gettable, because that is what save_station() returns — the app updates its
-- memory from what came back, not from what it sent.
--
-- Splitting the per-station half into its own view is what keeps those from
-- becoming two definitions of the same document that drift apart. The whole
-- document then aggregates this one, and the shape is written down once.

create or replace view meganet.station_json
with (security_invoker = true) as
with sensor_doc as (
  select station_id,
         jsonb_agg(jsonb_build_object(
           'alert_id',  alert_id,
           'type',      type,
           'sensor_id', sensor_id,
           'device_id', device_id
         ) order by ord) as doc
    from meganet.sensor
   group by station_id
),
range_doc as (
  select repeater_id,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'pass'), '[]'::jsonb) as passes,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'exclusion'), '[]'::jsonb) as exclusions
    from meganet.pass_range
   group by repeater_id
)
select s.id,
       s.ord,
       s.updated_at,
       jsonb_build_object(
         'id',                s.id,
         'name',              s.name,
         'station_number',    s.station_number,
         'lat',               s.lat,
         'lon',               s.lon,
         'elevation_ahd',     s.elevation_ahd,
         'roles',             to_jsonb(s.roles),
         'radio_network_ids', to_jsonb(s.radio_network_ids),
         'catchment_ids',     to_jsonb(s.catchment_ids),
         'alert_ids',         s.alert_ids,
         'satcom',            s.satcom,
         'rm_system_id',      s.rm_system_id,
         'enabled',           s.enabled,
         'notes',             s.notes
       )
       || case when s.legacy_unit_id is null then '{}'::jsonb
               else jsonb_build_object('legacy_unit_id', s.legacy_unit_id) end
       || case when s.site is null then '{}'::jsonb
               else jsonb_build_object('site', s.site) end
       || case when sd.doc is null then '{}'::jsonb
               else jsonb_build_object('sensors', sd.doc) end
       || case when s.lga is null then '{}'::jsonb
               else jsonb_build_object('lga', s.lga) end
       || case when s.basin is null then '{}'::jsonb
               else jsonb_build_object('basin', s.basin) end
       || case when s.location_types is null then '{}'::jsonb
               else jsonb_build_object('location_types', to_jsonb(s.location_types)) end
       || case when s.tbrg_bucket_size is null then '{}'::jsonb
               else jsonb_build_object('TBRGbucketSize', s.tbrg_bucket_size) end
       || case when r.station_id is null then '{}'::jsonb
               else jsonb_build_object('repeater', jsonb_build_object(
                      'acma_licence', r.acma_licence,
                      'rx_mhz',       r.rx_mhz,
                      'tx_mhz',       r.tx_mhz,
                      'pass_ranges',  coalesce(rd.passes,     '[]'::jsonb),
                      'exclusions',   coalesce(rd.exclusions, '[]'::jsonb),
                      'notes',        r.notes
                    )) end
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
 where s.deleted_at is null;

comment on view meganet.station_json is
  'One row per live station: its id, its position in the document, its updated_at, and its stations.json fragment.';

-- The whole document, now assembled from the view above rather than from a
-- second copy of the same expression. Everything outside `stations` is as 0002
-- left it.
create or replace view meganet.stations_json
with (security_invoker = true) as
select jsonb_build_object(
         'meta', (
           select jsonb_build_object(
                    'version',     m.version,
                    'description', m.description,
                    'updated',     m.updated,
                    'rm_paths',    m.rm_paths
                  )
             from meganet.doc_meta m
         ),
         'radio_networks', (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'id', n.id, 'name', n.name, 'description', n.description
                  ) order by n.ord), '[]'::jsonb)
             from meganet.radio_network n
         ),
         'catchments', (
           select coalesce(jsonb_agg(
                    jsonb_build_object(
                      'id',        c.id,
                      'name',      c.name,
                      'basin_no',  c.basin_no,
                      'area_sqkm', c.area_sqkm,
                      'region',    c.region
                    )
                    || case when c.border is null then '{}'::jsonb
                            else jsonb_build_object('border', c.border) end
                    order by c.ord), '[]'::jsonb)
             from meganet.catchment c
         ),
         'rm_systems', (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'id',               y.id,
                    'name',             y.name,
                    'tx_power_w',       y.tx_power_w,
                    'line_loss_db',     y.line_loss_db,
                    'supp_loss_db_m',   y.supp_loss_db_m,
                    'antenna_type',     y.antenna_type,
                    'antenna_gain_dbi', y.antenna_gain_dbi,
                    'antenna_height_m', y.antenna_height_m,
                    'rx_threshold_dbm', y.rx_threshold_dbm
                  ) order by y.ord), '[]'::jsonb)
             from meganet.rm_system y
         ),
         'stations', (
           select coalesce(jsonb_agg(doc order by ord), '[]'::jsonb)
             from meganet.station_json
         )
       ) as doc;

-- ── Saving ───────────────────────────────────────────────────────────────────
-- One station, whole: the row, its sensors, its repeater and that repeater's
-- ranges, in one transaction, or none of it.
--
-- Takes the same fragment the app already holds — a stations.json station object
-- — rather than a column list, so the editor sends what it has and the shape has
-- one definition on both sides. Returns the fragment as the database now holds
-- it, plus the new updated_at, because the app updates its memory from what came
-- back: the server owns updated_at, and the round trip is what proves the write
-- happened.
--
-- p_expected_updated_at is the stamp the editor loaded the station with. It is
-- required for an existing station and must be null for a new one, and a
-- mismatch is refused rather than merged.

create or replace function meganet.save_station(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       text := p_doc ->> 'id';
  v_actor    text := meganet.actor();
  v_is_new   boolean;
  v_prev     timestamptz;
  v_ord      integer;
  v_rep      jsonb := p_doc -> 'repeater';
  v_sensors  jsonb;
  v_ranges   jsonb;
  v_deleted  timestamptz;
  v_saved    jsonb;
  v_now      timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  if v_id is null or v_id = '' then
    raise exception 'the station has no id' using errcode = '22023';
  end if;
  if coalesce(p_doc ->> 'name', '') = '' then
    raise exception 'a station needs a name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc -> 'roles') is distinct from 'array' then
    raise exception 'roles must be an array' using errcode = '22023';
  end if;

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at into v_prev, v_deleted
    from meganet.station where id = v_id for update;
  v_is_new := not found;

  if v_is_new then
    if p_expected_updated_at is not null then
      raise exception 'station "%" is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409',
              hint    = 'your edits are still on screen; copy anything you need, then reload';
    end if;
  else
    if p_expected_updated_at is null then
      raise exception 'this editor did not load station "%" from the database, so it will not overwrite it', v_id
        using errcode = 'PT409',
              hint    = 'reload from the datastore and open the station again';
    end if;
    if v_prev is distinct from p_expected_updated_at then
      raise exception 'station "%" was changed in the database at %, after you opened it', v_id, v_prev
        using errcode = 'PT409',
              hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
    end if;
  end if;

  -- Position in the document. An existing station keeps its place; a new one
  -- goes on the end, which is where an appended station lands in the file too.
  if v_is_new then
    select coalesce(max(ord), -1) + 1 into v_ord from meganet.station;
  else
    select ord into v_ord from meganet.station where id = v_id;
  end if;

  insert into meganet.station (
    id, ord, name, station_number, lat, lon, elevation_ahd,
    roles, radio_network_ids, catchment_ids, alert_ids, satcom,
    rm_system_id, enabled, notes, legacy_unit_id, site, lga, basin,
    location_types, tbrg_bucket_size, deleted_at, updated_by)
  values (
    v_id, v_ord,
    p_doc ->> 'name',
    coalesce(p_doc ->> 'station_number', ''),
    (p_doc ->> 'lat')::numeric,
    (p_doc ->> 'lon')::numeric,
    (p_doc ->> 'elevation_ahd')::numeric,
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'roles') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'radio_network_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'catchment_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce(p_doc -> 'alert_ids', '{}'::jsonb),
    coalesce(p_doc -> 'satcom', '{}'::jsonb),
    coalesce((p_doc ->> 'rm_system_id')::integer, 1),
    coalesce((p_doc ->> 'enabled')::boolean, true),
    coalesce(p_doc ->> 'notes', ''),
    (p_doc ->> 'legacy_unit_id')::integer,
    p_doc -> 'site',
    p_doc ->> 'lga',
    p_doc ->> 'basin',
    (select array_agg(v order by o)
       from jsonb_array_elements_text(p_doc -> 'location_types') with ordinality t(v, o)),
    (p_doc ->> 'TBRGbucketSize')::numeric,
    -- Saving a station that had been deleted brings it back. The alternative is
    -- refusing the save of a station the editor is looking at, which would be a
    -- puzzle rather than a safeguard.
    null,
    v_actor)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon,
         elevation_ahd = excluded.elevation_ahd, roles = excluded.roles,
         radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         deleted_at = null, updated_by = excluded.updated_by;

  -- ── sensors ───────────────────────────────────────────────────────────────
  -- Normalised into a variable first, because the delete and the insert below
  -- both need the same list and a CTE cannot span two statements.
  --
  -- The natural key is (station_id, sensor_id, type), and a row the operator
  -- typed by hand has no sensor_id — those come from ARRO's export. One is
  -- minted from the station and the ALERT address, which is stable: the app
  -- writes back whatever comes out of here, so the row keeps its key from the
  -- next render onwards instead of being deleted and re-inserted on every save.
  --
  -- `distinct on` because two rows with the same address and type are the same
  -- sensor typed twice, and ON CONFLICT refuses to touch one row twice in a
  -- statement — a duplicate would otherwise fail the whole save with an error
  -- about the query rather than about the form.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sensor_id', sensor_id, 'type', type, 'ord', ord,
           'alert_id', alert_id, 'device_id', device_id) order by ord), '[]'::jsonb)
    into v_sensors
    from (
      select distinct on (sensor_id, type) sensor_id, type, ord, alert_id, device_id
        from (
          select coalesce(nullif(x.value ->> 'sensor_id', ''),
                          v_id || ':' || coalesce(x.value ->> 'alert_id', (x.ord - 1)::text)) as sensor_id,
                 coalesce(nullif(x.value ->> 'type', ''), 'Unknown')                          as type,
                 (x.ord - 1)::integer                                                         as ord,
                 (x.value ->> 'alert_id')::integer                                            as alert_id,
                 (x.value ->> 'device_id')::integer                                           as device_id
            from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb))
                 with ordinality x(value, ord)
        ) raw
       order by sensor_id, type, ord
    ) uniq;

  delete from meganet.sensor t
   where t.station_id = v_id
     and not exists (select 1 from jsonb_array_elements(v_sensors) e
                      where e.value ->> 'sensor_id' = t.sensor_id
                        and e.value ->> 'type'      = t.type);

  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id, updated_by)
  select v_id, e.value ->> 'sensor_id', e.value ->> 'type', (e.value ->> 'ord')::integer,
         (e.value ->> 'alert_id')::integer, (e.value ->> 'device_id')::integer, v_actor
    from jsonb_array_elements(v_sensors) e
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id, updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id);

  -- ── repeater and its ranges ───────────────────────────────────────────────
  -- The role is what decides, not the presence of the object: un-ticking
  -- "repeater" in the editor has to remove the repeater detail, or a station
  -- keeps passing addresses it is no longer a repeater for.
  if v_rep is null or jsonb_typeof(v_rep) is distinct from 'object'
     or not (coalesce(p_doc -> 'roles', '[]'::jsonb) ? 'repeater') then
    -- Cascades to pass_range.
    delete from meganet.repeater where station_id = v_id;
  else
    insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, notes, updated_by)
    values (v_id, coalesce(v_rep ->> 'acma_licence', ''),
            (v_rep ->> 'rx_mhz')::numeric, (v_rep ->> 'tx_mhz')::numeric,
            coalesce(v_rep ->> 'notes', ''), v_actor)
    on conflict (station_id) do update
       set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
           tx_mhz = excluded.tx_mhz, notes = excluded.notes,
           updated_by = excluded.updated_by;

    -- Ranges are replaced wholesale rather than diffed. There are ten of them on
    -- a busy repeater, they have no identity beyond their own numbers, and the
    -- editor hands over a textarea — "these are the ranges now" is what it means
    -- and what this does. Duplicated lines collapse: (kind, lo, hi) is the key.
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'lo', lo, 'hi', hi, 'ord', ord)
                              order by ord), '[]'::jsonb)
      into v_ranges
      from (
        select distinct on (kind, lo, hi) kind, lo, hi, ord
          from (
            select k.kind,
                   (p.value ->> 'low')::integer  as lo,
                   (p.value ->> 'high')::integer as hi,
                   (p.ord - 1)::integer          as ord
              from (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions')) as k(kind, field)
              cross join lateral jsonb_array_elements(coalesce(v_rep -> k.field, '[]'::jsonb))
                         with ordinality p(value, ord)
             where (p.value ->> 'low') is not null and (p.value ->> 'high') is not null
          ) raw
         order by kind, lo, hi, ord
      ) uniq;

    delete from meganet.pass_range where repeater_id = v_id;

    insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
    select v_id, e.value ->> 'kind', (e.value ->> 'lo')::integer,
           (e.value ->> 'hi')::integer, (e.value ->> 'ord')::integer, v_actor
      from jsonb_array_elements(v_ranges) e;
  end if;

  select updated_at into v_now from meganet.station where id = v_id;
  select doc into v_saved from meganet.station_json where id = v_id;

  return jsonb_build_object(
           'station',    v_saved,
           'updated_at', v_now,
           'created',    v_is_new,
           'updated_by', v_actor);

exception
  -- Two saves racing to create the same id: the loser's insert hits the primary
  -- key rather than the stamp check above, because there was no row to lock.
  -- Same situation, so it gets the same answer.
  when unique_violation then
    raise exception 'station "%" already exists — somebody created it while you were typing', v_id
      using errcode = 'PT409',
            hint    = 'your edits are still on screen; give the station another name or reload';
end;
$$;

comment on function meganet.save_station(jsonb, timestamptz) is
  'Insert or update one station and everything hanging off it, in one transaction. Refuses a stale write with SQLSTATE PT409 (HTTP 409). Returns the saved document fragment and its new updated_at.';

-- ── Deleting ─────────────────────────────────────────────────────────────────
-- Soft, and for the same reason the concurrency check exists: the expensive
-- mistakes here are quiet ones. The row keeps its sensors, its repeater and its
-- ranges; only the document stops mentioning it.

create or replace function meganet.delete_station(
         p_id text,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   text := meganet.actor();
  v_prev    timestamptz;
  v_deleted timestamptz;
  v_now     timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  select updated_at, deleted_at into v_prev, v_deleted
    from meganet.station where id = p_id for update;

  if not found then
    raise exception 'no station "%"', p_id using errcode = 'P0002';
  end if;

  if v_deleted is not null then
    -- Already gone, and by definition nothing was lost. Reported as success so
    -- a repeated click is not an error the operator has to interpret.
    return jsonb_build_object('id', p_id, 'deleted_at', v_deleted, 'already', true);
  end if;

  if p_expected_updated_at is null then
    raise exception 'this editor did not load station "%" from the database, so it will not delete it', p_id
      using errcode = 'PT409',
            hint    = 'reload from the datastore and open the station again';
  end if;
  if v_prev is distinct from p_expected_updated_at then
    raise exception 'station "%" was changed in the database at %, after you opened it', p_id, v_prev
      using errcode = 'PT409',
            hint    = 'reload to see the current version before deleting it';
  end if;

  update meganet.station
     set deleted_at = pg_catalog.now(), updated_by = v_actor
   where id = p_id
  returning deleted_at, updated_at into v_deleted, v_now;

  return jsonb_build_object(
           'id',         p_id,
           'deleted_at', v_deleted,
           'updated_at', v_now,
           'already',    false);
end;
$$;

comment on function meganet.delete_station(text, timestamptz) is
  'Soft-delete one station: stamps deleted_at, keeps every row. Restore with: update meganet.station set deleted_at = null where id = …';

-- ── Row level security for the write verbs ───────────────────────────────────
-- The functions above are `security definer` and run as this file's owner, so
-- they do not consult these policies — the `is_editor()` call at the top of each
-- one is what decides. These exist for the other direction: the day somebody
-- grants `authenticated` a write verb on one of these tables directly, the
-- database still asks who is writing. A policy that costs nothing today and is
-- the difference between a mistake and an incident is worth having written down.
--
-- The read policies from 0002 are untouched; these are additional and permissive,
-- so nothing that could be read before becomes unreadable.

do $$
declare
  t text;
  v text;
begin
  foreach t in array array['station', 'sensor', 'repeater', 'pass_range'] loop
    foreach v in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on meganet.%I', t || '_' || v || '_editors', t);
    end loop;

    execute format(
      'create policy %I on meganet.%I for insert to authenticated
         with check (meganet.is_editor())', t || '_insert_editors', t);
    execute format(
      'create policy %I on meganet.%I for update to authenticated
         using (meganet.is_editor()) with check (meganet.is_editor())',
      t || '_update_editors', t);
    execute format(
      'create policy %I on meganet.%I for delete to authenticated
         using (meganet.is_editor())', t || '_delete_editors', t);
  end loop;
end
$$;

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and these two
-- rewrite station records, so that default has to be revoked explicitly — see
-- db/README.md. `anon` is granted nothing: an unauthenticated caller gets a 404
-- from PostgREST for a function it may not execute, which is a better answer
-- than an authorisation error that confirms what exists.
--
-- No table is granted a write verb to `anon` or `authenticated` here, on
-- purpose. The RPCs are the write path; see the head of this file.

revoke all on function meganet.save_station(jsonb, timestamptz)   from public;
revoke all on function meganet.delete_station(text, timestamptz)  from public;
revoke all on function meganet.email_allowed(text)                from public;
revoke all on function meganet.is_editor()                        from public;
revoke all on function meganet.actor()                            from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.station_json to anon, authenticated, service_role;

  grant execute on function meganet.save_station(jsonb, timestamptz)  to authenticated, service_role;
  grant execute on function meganet.delete_station(text, timestamptz) to authenticated, service_role;
  -- is_editor() is called by the policies above, which are evaluated as the
  -- querying role; email_allowed() is called by is_editor().
  grant execute on function meganet.is_editor()          to anon, authenticated, service_role;
  grant execute on function meganet.email_allowed(text)  to authenticated, service_role;
  grant execute on function meganet.actor()              to authenticated, service_role;

  -- The editors list is maintained with the service key or from psql — never
  -- from a browser.
  grant select, insert, update, delete on meganet.editor_allow to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '4')
on conflict (key) do update set value = excluded.value;
