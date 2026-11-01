-- 0095_teams_and_tasks.sql — Teams, and the tasks handed to them: who is on
-- a team, who may hand a job to one, and the job itself — at a station, with
-- a status, a due date and a running thread of notes.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0095_teams_and_tasks.sql
--
-- …and then an administrator names each team's owners on the Admin tab
-- (Teams), or from the SQL editor, a direct connection, with the address
-- each owner signs in with:
--
--   select meganet.team_member_save(
--     (select id from meganet.team where name = 'SoRT Forum'), 'someone@example.org', true);
--
-- Until somebody is on a team, the Tasks tab is listed to administrators
-- alone.
--
-- Why this file exists
-- ────────────────────
-- The work that comes out of a station's health, an inspection or the SoRT
-- forum (the meeting that agrees what each site needs, and whose scope
-- builder writes the list) had nowhere to go but an email. The owner asked
-- (November 2026) for teams, and for tasks handed to them — and for the SoRT
-- scope builder to hand its list straight over. 0065's foot said the owner
-- "expects groups later"; these are they. 0076 (the ALERT2 plan's list) is
-- the shape copied: a table nobody reads but through functions that ask who
-- is calling, writes only through security definer functions.
--
--   1. team         An administrator makes one: a name, optionally the
--                   maintenance hub it looks after (meganet.hub, one team a
--                   hub, so a hub names one team), and whether it hands out
--                   tasks (hands_out). Its name, hub and that flag are seen
--                   by every approved account (is_member()), so a task can
--                   say which team has it; nothing else about it is.
--   2. team_member  Who is on a team, and who of them owns it. An
--                   administrator names the owners; an owner adds and takes
--                   off members, by the address of their Flood-Net account —
--                   an approved one. A team's roster is seen by
--                   administrators, its owners and its members, and by
--                   nobody else: RLS on, no policy, no grant; teams_read()
--                   answers it after asking who is calling. Nobody browses
--                   the accounts but administrators, as before (0042).
--   3. task         A job: a station (optional only for a general task), a
--                   title, details, the team it is handed to (none yet is
--                   "unassigned"), a status — open, in progress, waiting,
--                   done, or cancelled — an optional due date, who made it
--                   and when, where it came from (Flood-Net, or SoRT with
--                   the forum's date) and a source_ref, unique, so the same
--                   job handed over twice is created once.
--   4. task_note    The running thread: a note, a status changed, the task
--                   handed to another team, its words edited, its creation —
--                   who and when, kept for good.
--
-- Who
-- ───
--   * Hands out tasks (hands_out_tasks()): an administrator, or a member of
--     any team flagged hands_out — the SoRT Forum, seeded below. They may
--     make a task for any team, or for none yet, and they see every task.
--   * A team's owners may make tasks for their own team only (and move one
--     between teams they own).
--   * A task is seen by the people who hand out tasks, the members of the
--     team it is handed to, and whoever made it — not by every approved
--     account: some are councils, contractors or other outside users.
--   * The team it is handed to changes its status (all but cancelled) and
--     adds notes; whoever made it, the people who hand out tasks and the
--     team's owners also hand it to another team, edit its words, and
--     cancel it or bring it back.
--   * Every door asks is_member() first: a declined or banned account loses
--     its teams and its tasks at once, as it loses the photos (0062).
--   * Tasks are never public: no anon grant, nothing in the station document
--     or the agent API's relations (worker/api.js READABLE_RELATIONS), and
--     the public station record says nothing of them.
--
-- Not yet: telling anybody. A task handed to a team waits for them on the
-- Tasks tab and on the station's card; an email when one arrives waits for
-- #237 (mail through Resend), and a push for #216 (staff alerts).
--
-- Starter teams (names only, no people): a team for every maintenance hub,
-- named like it and linked to it, and Property Services, Radio licensing,
-- SoRT Forum (hands out tasks), OTE and ID.
--
-- whoami() says it all: `tasks` (the Tasks tab is for them), `hands_out`,
-- `team_owner` and `teams` (how many they are on); the app lists the tab by
-- the first.
--
-- Depends on 0001 (touch_updated_at), 0002 (station), 0005 (app_user, the
-- auth.users triggers), 0027 (hub), 0036 (is_admin), 0062 (is_member,
-- account_standing), 0076 (whoami's last shape). tools/check_teams_and_tasks.sql
-- proves it.

-- ── 1. Teams ─────────────────────────────────────────────────────────────────

create table if not exists meganet.team (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  -- The hub a team looks after: SoRT's hand-off names a hub, and this is how
  -- it finds the team. Dropped with the hub (a stations.json load prunes a
  -- hub the document lacks), which leaves the team, unlinked.
  hub_id      text        references meganet.hub (id) on delete set null,
  hands_out   boolean     not null default false,
  created_by  uuid        references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint team_name_shape check (pg_catalog.length(name) between 1 and 80
                                    and name = pg_catalog.btrim(name) and name !~ '[[:cntrl:]]')
);

comment on table meganet.team is
  'A team (0095): a name, the maintenance hub it looks after if any (one team a hub), and whether its members hand out tasks to any team (hands_out). Made and changed by an administrator through team_save(); its name, hub and flag are seen by approved accounts, its roster (team_member) only through teams_read().';

create unique index if not exists team_name_key on meganet.team (pg_catalog.lower(name));
create unique index if not exists team_hub_key on meganet.team (hub_id) where hub_id is not null;

drop trigger if exists team_touch_updated_at on meganet.team;
create trigger team_touch_updated_at
  before update on meganet.team
  for each row execute function meganet.touch_updated_at();

create table if not exists meganet.team_member (
  team_id   uuid        not null references meganet.team (id) on delete cascade,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  is_owner  boolean     not null default false,
  added_by  uuid        references auth.users (id) on delete set null,
  added_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);

comment on table meganet.team_member is
  'Who is on a team, and who of them owns it (0095). An administrator names owners; an owner adds and takes off members, by the address of an approved account. RLS on, no policy, no grant: read through teams_read() and whoami(), written through team_member_save() and team_member_remove().';

create index if not exists team_member_user on meganet.team_member (user_id);

-- ── 2. Tasks ─────────────────────────────────────────────────────────────────

create table if not exists meganet.task (
  id           uuid        primary key default gen_random_uuid(),
  -- A station a task is about; none only for a general task. A station a
  -- load removes leaves its tasks, stationless — the thread says where.
  station_id   text        references meganet.station (id) on delete set null,
  title        text        not null,
  details      text        not null default '',
  -- The team it is handed to; none yet is "unassigned". A team with tasks
  -- is not removed (team_remove() says so first).
  team_id      uuid        references meganet.team (id) on delete restrict,
  status       text        not null default 'open',
  due_on       date,
  source       text        not null default 'floodnet',
  -- For a task from SoRT: the forum it was agreed at.
  source_date  date,
  -- What it was made from, for de-duplication: 'sort:<session>:<ref>' for
  -- one handed over by SoRT's scope builder. Unique where there is one.
  source_ref   text,
  created_by   uuid        references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  closed_at    timestamptz,
  constraint task_status_known check (status in ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  constraint task_source_known check (source in ('floodnet', 'sort')),
  constraint task_title_shape check (pg_catalog.length(title) between 1 and 200
                                     and title = pg_catalog.btrim(title) and title !~ '[[:cntrl:]]'),
  constraint task_details_size check (pg_catalog.length(details) <= 8000),
  constraint task_source_ref_shape check (source_ref is null
                                          or (pg_catalog.length(source_ref) between 1 and 300 and source_ref !~ '[[:cntrl:]]')),
  constraint task_sort_ref check (source <> 'sort' or coalesce(source_ref like 'sort:%', false)),
  constraint task_closed_when check ((closed_at is not null) = (status in ('done', 'cancelled')))
);

comment on table meganet.task is
  'A task (0095): a job at a station (or a general one), handed to a team (or none yet), with a status — open, in_progress, waiting, done, cancelled — an optional due date, who made it and when, where it came from (floodnet, or sort with the forum''s date) and a unique source_ref. Seen by the people who hand out tasks, the team it is handed to and whoever made it; never by anon. Written only through task_create() and task_update().';

create unique index if not exists task_source_ref_key on meganet.task (source_ref) where source_ref is not null;
create index if not exists task_station on meganet.task (station_id) where station_id is not null;
create index if not exists task_team on meganet.task (team_id);
create index if not exists task_created_by on meganet.task (created_by);

drop trigger if exists task_touch_updated_at on meganet.task;
create trigger task_touch_updated_at
  before update on meganet.task
  for each row execute function meganet.touch_updated_at();

create table if not exists meganet.task_note (
  id          bigint      generated always as identity primary key,
  task_id     uuid        not null references meganet.task (id) on delete cascade,
  author_id   uuid        references auth.users (id) on delete set null,
  -- created: the task was made (to_value its team's name, if it had one);
  -- note: somebody wrote something; status: from_value → to_value;
  -- team: handed from one team's name to another's ('' for none);
  -- edit: its words, station or due date changed (to_value says which).
  kind        text        not null default 'note',
  body        text        not null default '',
  from_value  text,
  to_value    text,
  created_at  timestamptz not null default now(),
  constraint task_note_kind_known check (kind in ('created', 'note', 'status', 'team', 'edit')),
  constraint task_note_body_size check (pg_catalog.length(body) <= 4000),
  constraint task_note_says_something check (kind <> 'note' or pg_catalog.length(pg_catalog.btrim(body)) > 0)
);

comment on table meganet.task_note is
  'A task''s running thread (0095): created, a note, a status changed (from_value → to_value), handed to another team (the teams'' names then), or its words edited — who and when. Seen by whoever sees the task; written only by task_create() and task_update(), and never changed.';

create index if not exists task_note_task on meganet.task_note (task_id, created_at, id);

-- ── 3. The questions ─────────────────────────────────────────────────────────
-- The role from the `role` GUC for is_admin()'s reason (0036): inside a
-- definer function current_user is the owner, and would wave everybody
-- through. anon never; the service key and a direct connection always; an
-- authenticated caller by its teams, and only while an approved account.

create or replace function meganet.hands_out_tasks()
returns boolean
language plpgsql
stable
security definer
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
  if v_role in ('anon', 'authenticator') then
    return false;
  end if;
  if v_role = 'service_role' then
    return true;
  end if;
  if v_role = 'authenticated' then
    if auth.uid() is null or not meganet.is_member() then
      return false;
    end if;
    return meganet.is_admin()
        or exists (select 1 from meganet.team_member m
                     join meganet.team t on t.id = m.team_id
                    where m.user_id = auth.uid() and t.hands_out);
  end if;
  -- A direct connection: psql, the SQL editor, a migration.
  return true;
end;
$$;

comment on function meganet.hands_out_tasks() is
  'May the caller hand a task to any team, and see every task (0095)? An administrator, or a member of a team flagged hands_out, while an approved account; the service key and a direct connection always; anon never.';

-- The teams the caller is on — or, with p_owned, owns — while an approved
-- account; none for anybody else, the service key and a direct connection
-- included (they see everything through hands_out_tasks()).
create or replace function meganet.my_teams(p_owned boolean default false)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not meganet.is_member() then
    return '{}'::uuid[];
  end if;
  return coalesce((select pg_catalog.array_agg(m.team_id order by m.team_id)
                     from meganet.team_member m
                    where m.user_id = auth.uid() and (m.is_owner or not coalesce(p_owned, false))), '{}'::uuid[]);
end;
$$;

comment on function meganet.my_teams(boolean) is
  'The teams the caller is on, or with p_owned true owns, while an approved account (0095); empty for anybody else. What the task policy and the doors ask.';

-- A display name, or the address where none was given — what a roster, a
-- task's creator and a note's author are shown as.
create or replace function meganet.person_name(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email, au.email)
    from (select p_id as id) x
    left join meganet.app_user u on u.id = x.id
    left join auth.users au on au.id = x.id
   where p_id is not null;
$$;

comment on function meganet.person_name(uuid) is
  'An account as people see it (0095): its display name, or its address where it gave none. Internal: the doors call it for a roster, a task''s creator and a note''s author.';

-- ── 4. Who sees what ─────────────────────────────────────────────────────────

alter table meganet.team enable row level security;
drop policy if exists team_read_members on meganet.team;
-- In a sub-select so that it is asked once a query rather than once a row.
create policy team_read_members on meganet.team
  for select to authenticated
  using ((select meganet.is_member()));

alter table meganet.team_member enable row level security;
-- No policy: the roster is read through teams_read() alone.

alter table meganet.task enable row level security;
drop policy if exists task_read_allowed on meganet.task;
create policy task_read_allowed on meganet.task
  for select to authenticated
  using ((select meganet.hands_out_tasks())
         or ((select meganet.is_member())
             and (created_by = (select auth.uid()) or team_id = any ((select meganet.my_teams(false))::uuid[]))));

alter table meganet.task_note enable row level security;
drop policy if exists task_note_read_allowed on meganet.task_note;
-- Whoever may see the task: the select below is held to task's own policy.
create policy task_note_read_allowed on meganet.task_note
  for select to authenticated
  using (exists (select 1 from meganet.task t where t.id = task_note.task_id));

-- ── 5. Teams, read ───────────────────────────────────────────────────────────

-- One team's roster, owners first: names to everybody on it, addresses to its
-- owners and administrators (they add and take off by address). Not a door of
-- its own: teams_read() and the team writers answer it, having asked.
create or replace function meganet.team_roster(p_team uuid, p_addresses boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',       m.user_id,
           'who',      meganet.person_name(m.user_id),
           'email',    case when p_addresses then coalesce(u.email, au.email) end,
           'owner',    m.is_owner,
           'you',      m.user_id = auth.uid(),
           'added_at', m.added_at,
           'added_by', meganet.person_name(m.added_by))
         order by m.is_owner desc, pg_catalog.lower(meganet.person_name(m.user_id))), '[]'::jsonb)
    from meganet.team_member m
    left join meganet.app_user u on u.id = m.user_id
    left join auth.users au on au.id = m.user_id
   where m.team_id = p_team;
$$;

comment on function meganet.team_roster(uuid, boolean) is
  'A team''s roster (0095), owners first, addresses only with p_addresses. Granted to nobody: teams_read() and the team writers answer it after asking who is calling.';

-- Every team's name, hub and flag, to an approved account; a team's roster
-- to administrators, its owners and its members; and the caller's own place
-- in all of it. Administrators also get the hubs, for the Teams panel.
create or replace function meganet.teams_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_all   boolean;
  v_on    uuid[];
  v_owns  uuid[];
begin
  if not meganet.is_member() then
    raise exception 'teams are for approved accounts'
      using errcode = '42501',
            hint    = 'sign in with an account an administrator has approved';
  end if;
  v_admin := meganet.is_admin();
  v_all   := meganet.hands_out_tasks();
  v_on    := meganet.my_teams(false);
  v_owns  := meganet.my_teams(true);
  return pg_catalog.jsonb_build_object(
    'me', pg_catalog.jsonb_build_object('admin', v_admin, 'hands_out', v_all, 'on', pg_catalog.to_jsonb(v_on),
                                        'owns', pg_catalog.to_jsonb(v_owns)),
    'teams', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', t.id, 'name', t.name, 'hub_id', t.hub_id, 'hub', h.name, 'hands_out', t.hands_out,
               'role', case when t.id = any (v_owns) then 'owner' when t.id = any (v_on) then 'member' end,
               'roster', case when v_admin or t.id = any (v_on)
                              then meganet.team_roster(t.id, v_admin or t.id = any (v_owns)) end,
               'tasks', case when v_admin then (select count(*) from meganet.task k where k.team_id = t.id) end)
             order by pg_catalog.lower(t.name))
        from meganet.team t
        left join meganet.hub h on h.id = t.hub_id), '[]'::jsonb),
    'hubs', case when v_admin then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id, 'name', h.name) order by h.ord, h.id)
        from meganet.hub h), '[]'::jsonb) end);
end;
$$;

comment on function meganet.teams_read() is
  'The teams (0095), to an approved account: {me: {admin, hands_out, on, owns}, teams: [{id, name, hub_id, hub, hands_out, role, roster, tasks}], hubs}. roster (owners first: id, who, email to owners and administrators, owner, you, added_at, added_by) only for a team the caller is on, or to an administrator; tasks (how many have ever been handed to it) and hubs to administrators.';

-- ── 6. Teams, changed ────────────────────────────────────────────────────────

-- Make a team (no id) or change one: its name, its hub (null for none) and
-- whether it hands out tasks. Administrators. Answers teams_read().
create or replace function meganet.team_save(p_id uuid, p_name text, p_hub_id text default null,
                                             p_hands_out boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_hub   text := nullif(pg_catalog.btrim(coalesce(p_hub_id, '')), '');
  v_other text;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator makes or changes a team'
      using errcode = '42501',
            hint    = 'an administrator is an editor whose account has the admin role (Admin tab)';
  end if;
  if pg_catalog.length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'a team''s name is 1–80 characters' using errcode = '22023';
  end if;
  select t.name into v_other from meganet.team t
   where pg_catalog.lower(t.name) = pg_catalog.lower(v_name) and t.id is distinct from p_id;
  if found then
    raise exception 'a team is already called %', v_other using errcode = '23505';
  end if;
  if v_hub is not null then
    if not exists (select 1 from meganet.hub h where h.id = v_hub) then
      raise exception 'no hub %', v_hub using errcode = '22023';
    end if;
    select t.name into v_other from meganet.team t where t.hub_id = v_hub and t.id is distinct from p_id;
    if found then
      raise exception 'that hub is already %''s — a hub is looked after by one team', v_other
        using errcode = '23505',
              hint    = 'take the hub off that team first';
    end if;
  end if;

  if p_id is null then
    insert into meganet.team (name, hub_id, hands_out, created_by)
    values (v_name, v_hub, coalesce(p_hands_out, false), auth.uid());
  else
    update meganet.team t
       set name = v_name, hub_id = v_hub, hands_out = coalesce(p_hands_out, false)
     where t.id = p_id;
    if not found then
      raise exception 'no such team' using errcode = 'P0002';
    end if;
  end if;
  return meganet.teams_read();
end;
$$;

comment on function meganet.team_save(uuid, text, text, boolean) is
  'Make a team (p_id null) or change one: its name (unique, case aside), its hub (null for none; one team a hub) and whether its members hand out tasks (0095). Administrators. Answers teams_read().';

-- Remove a team nothing has been handed to. Administrators. Answers
-- teams_read().
create or replace function meganet.team_remove(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator removes a team'
      using errcode = '42501',
            hint    = 'an administrator is an editor whose account has the admin role (Admin tab)';
  end if;
  select count(*) into n from meganet.task k where k.team_id = p_id;
  if n > 0 then
    raise exception '% task% handed to it, so it stays — rename it, or hand them to another team first',
      n, case when n = 1 then ' has been' else 's have been' end
      using errcode = '23503';
  end if;
  delete from meganet.team t where t.id = p_id;
  return meganet.teams_read();
end;
$$;

comment on function meganet.team_remove(uuid) is
  'Remove a team no task has ever been handed to, with its roster (0095); one with tasks is refused (23503). Administrators. Answers teams_read().';

-- Put an approved account on a team by the address it signs in with, or —
-- already on it — make it an owner or not (null leaves that). An
-- administrator does either; an owner adds members to their own team.
create or replace function meganet.team_member_save(p_team_id uuid, p_email text, p_owner boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin boolean := meganet.is_admin();
  v_owner boolean;
  v_id    uuid;
  v_was   boolean;
  v_stand text;
  v_mail  text := pg_catalog.btrim(coalesce(p_email, ''));
begin
  if not meganet.is_member() then
    raise exception 'sign in with an approved account to change a team'
      using errcode = '42501';
  end if;
  if not exists (select 1 from meganet.team t where t.id = p_team_id) then
    raise exception 'no such team' using errcode = 'P0002';
  end if;
  v_owner := p_team_id = any (meganet.my_teams(true));
  if not v_admin and not v_owner then
    raise exception 'only the team''s owners, or an administrator, change who is on it'
      using errcode = '42501';
  end if;
  if not v_admin and coalesce(p_owner, false) then
    raise exception 'only an administrator names a team''s owners' using errcode = '42501';
  end if;
  if v_mail = '' then
    raise exception 'whose address?' using errcode = '22023';
  end if;
  select u.id into v_id
    from auth.users u
   where pg_catalog.lower(u.email) = pg_catalog.lower(v_mail)
   order by u.created_at
   limit 1;
  if v_id is null then
    raise exception 'nobody has a Flood-Net account as % — they sign up once, then you add them', v_mail
      using errcode = 'P0002';
  end if;
  v_stand := meganet.account_standing(v_id);
  if v_stand is null or v_stand not in ('approved', 'automatic') then
    raise exception '%''s account is not approved (%), so the team''s tasks would not open for them — an administrator approves it on the Admin tab first',
      v_mail, coalesce(v_stand, 'no account') using errcode = '22023';
  end if;

  select m.is_owner into v_was from meganet.team_member m where m.team_id = p_team_id and m.user_id = v_id;
  if found then
    if p_owner is not null and p_owner <> v_was then
      if not v_admin then
        raise exception 'only an administrator names a team''s owners' using errcode = '42501';
      end if;
      update meganet.team_member m set is_owner = p_owner where m.team_id = p_team_id and m.user_id = v_id;
    end if;
  else
    insert into meganet.team_member (team_id, user_id, is_owner, added_by)
    values (p_team_id, v_id, coalesce(p_owner, false), auth.uid());
  end if;
  return meganet.teams_read();
end;
$$;

comment on function meganet.team_member_save(uuid, text, boolean) is
  'Put an approved account on a team by its address, or make it an owner or not (null leaves that) (0095). An administrator does either; a team''s owner adds members to it, and names no owner. P0002 for an address with no account, 22023 for one not approved. Answers teams_read().';

-- Take somebody off a team. An administrator takes anybody off; an owner
-- takes off the team's members, not its owners. Harmless for somebody not
-- on it. Answers teams_read().
create or replace function meganet.team_member_remove(p_team_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin boolean := meganet.is_admin();
  v_was   boolean;
begin
  if not meganet.is_member() then
    raise exception 'sign in with an approved account to change a team'
      using errcode = '42501';
  end if;
  if not v_admin and not (p_team_id = any (meganet.my_teams(true))) then
    raise exception 'only the team''s owners, or an administrator, change who is on it'
      using errcode = '42501';
  end if;
  select m.is_owner into v_was from meganet.team_member m where m.team_id = p_team_id and m.user_id = p_user_id;
  if not found then
    return meganet.teams_read();
  end if;
  if v_was and not v_admin then
    raise exception 'only an administrator takes an owner off a team' using errcode = '42501';
  end if;
  delete from meganet.team_member m where m.team_id = p_team_id and m.user_id = p_user_id;
  return meganet.teams_read();
end;
$$;

comment on function meganet.team_member_remove(uuid, uuid) is
  'Take somebody off a team (0095): an administrator anybody, an owner the team''s members (not its owners). Harmless for somebody not on it. Answers teams_read().';

-- ── 7. Tasks, read ───────────────────────────────────────────────────────────

-- One task as the doors answer it, without its thread. `p_mine` and `p_by`
-- say whether it is on one of the caller's teams and whether they made it.
create or replace function meganet.task_json(p_task meganet.task, p_mine boolean, p_by boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_task.id, 'station_id', p_task.station_id, 'title', p_task.title,
    'team_id', p_task.team_id, 'team', (select t.name from meganet.team t where t.id = p_task.team_id),
    'status', p_task.status, 'due_on', p_task.due_on,
    'source', p_task.source, 'source_date', p_task.source_date, 'source_ref', p_task.source_ref,
    'created_at', p_task.created_at, 'created_by', meganet.person_name(p_task.created_by),
    'updated_at', p_task.updated_at, 'closed_at', p_task.closed_at,
    'my_team', coalesce(p_mine, false), 'by_me', coalesce(p_by, false),
    'notes', (select count(*) from meganet.task_note n where n.task_id = p_task.id and n.kind = 'note'),
    'last_at', coalesce((select max(n.created_at) from meganet.task_note n where n.task_id = p_task.id), p_task.created_at));
$$;

comment on function meganet.task_json(meganet.task, boolean, boolean) is
  'A task as the doors answer it, without its details or thread (0095). Internal: granted to nobody.';

-- Every task the caller may see — or one station's, or only the ones still
-- open — newest first. Without details: task_get() has those.
create or replace function meganet.task_list(p_station_id text default null, p_open_only boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_all   boolean;
  v_teams uuid[];
begin
  if not meganet.is_member() then
    raise exception 'tasks are for approved accounts'
      using errcode = '42501',
            hint    = 'sign in with an account an administrator has approved';
  end if;
  v_all   := meganet.hands_out_tasks();
  v_teams := meganet.my_teams(false);
  return coalesce((
    select pg_catalog.jsonb_agg(meganet.task_json(k, coalesce(k.team_id = any (v_teams), false),
                                                  coalesce(k.created_by = v_me, false))
                                order by k.created_at desc, k.id)
      from meganet.task k
     where k.id in (select j.id from meganet.task j
                     where (v_all or j.created_by = v_me or j.team_id = any (v_teams))
                       and (p_station_id is null or j.station_id = p_station_id)
                       and (not coalesce(p_open_only, false) or j.status in ('open', 'in_progress', 'waiting'))
                     order by j.created_at desc, j.id
                     limit 5000)), '[]'::jsonb);
end;
$$;

comment on function meganet.task_list(text, boolean) is
  'The tasks the caller may see (0095) — the people who hand out tasks every one, anybody else the ones handed to a team they are on and the ones they made — optionally one station''s and only those not done or cancelled; newest first, at most 5,000; each as task_json() (no details or thread). Approved accounts.';

-- What the caller may do to one task: work on it (its team), manage it
-- (hands out tasks, made it, or owns its team) — or neither, when it is not
-- theirs to see (null).
create or replace function meganet.task_may(p_task meganet.task)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_all   boolean := meganet.hands_out_tasks();
  v_teams uuid[] := meganet.my_teams(false);
  v_owns  uuid[] := meganet.my_teams(true);
begin
  if not meganet.is_member()
     or not (v_all or coalesce(p_task.created_by = v_me, false) or coalesce(p_task.team_id = any (v_teams), false)) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'work',   coalesce(p_task.team_id = any (v_teams), false),
    'manage', v_all or coalesce(p_task.created_by = v_me, false) or coalesce(p_task.team_id = any (v_owns), false),
    'any_team', v_all,
    'owns', pg_catalog.to_jsonb(v_owns));
end;
$$;

comment on function meganet.task_may(meganet.task) is
  'What the caller may do to a task (0095): {work, manage, any_team, owns}, or null when it is not theirs to see. Internal: task_get() and task_update() ask it.';

-- One task with its details, its thread and what the caller may do to it.
create or replace function meganet.task_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k     meganet.task;
  v_may jsonb;
begin
  if not meganet.is_member() then
    raise exception 'tasks are for approved accounts'
      using errcode = '42501',
            hint    = 'sign in with an account an administrator has approved';
  end if;
  select * into k from meganet.task t where t.id = p_id;
  if found then
    v_may := meganet.task_may(k);
  end if;
  if v_may is null then
    raise exception 'no such task, or not one you may see' using errcode = 'P0002';
  end if;
  return meganet.task_json(k, (v_may ->> 'work')::boolean, k.created_by = auth.uid())
    || pg_catalog.jsonb_build_object(
      'details', k.details,
      'may', v_may,
      'thread', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'id', n.id, 'kind', n.kind, 'body', n.body, 'from', n.from_value, 'to', n.to_value,
                 'who', meganet.person_name(n.author_id), 'you', n.author_id = auth.uid(), 'at', n.created_at)
               order by n.created_at, n.id)
          from meganet.task_note n where n.task_id = k.id), '[]'::jsonb));
end;
$$;

comment on function meganet.task_get(uuid) is
  'One task the caller may see (0095): task_json() with its details, its thread (id, kind, body, from, to, who, you, at — oldest first) and what the caller may do to it (may: work, manage, any_team, owns). P0002 for a task that is not there or not theirs to see. Approved accounts.';

-- Which of these source_refs a task already has, when, and whether the caller
-- may open it — what the hand-off's review asks before it offers to create.
create or replace function meganet.task_refs(p_refs text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_all   boolean;
  v_teams uuid[];
begin
  if not meganet.is_member() then
    raise exception 'tasks are for approved accounts'
      using errcode = '42501',
            hint    = 'sign in with an account an administrator has approved';
  end if;
  if p_refs is null or pg_catalog.cardinality(p_refs) = 0 then
    return '[]'::jsonb;
  end if;
  if pg_catalog.cardinality(p_refs) > 100 then
    raise exception 'at most 100 references at a time' using errcode = '22023';
  end if;
  v_all   := meganet.hands_out_tasks();
  v_teams := meganet.my_teams(false);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'ref', k.source_ref, 'created_at', k.created_at,
             'visible', v_all or coalesce(k.created_by = v_me, false) or coalesce(k.team_id = any (v_teams), false),
             'id', case when v_all or coalesce(k.created_by = v_me, false) or coalesce(k.team_id = any (v_teams), false)
                        then k.id end)
           order by k.source_ref)
      from meganet.task k
     where k.source_ref = any (p_refs)), '[]'::jsonb);
end;
$$;

comment on function meganet.task_refs(text[]) is
  'Which of up to 100 source_refs a task already has (0095): [{ref, created_at, visible, id}] — id only when the caller may open it. What the SoRT hand-off''s review asks so the same job is not created twice. Approved accounts.';

-- ── 8. Tasks, made ───────────────────────────────────────────────────────────

-- Make tasks, up to 50 at once, all or nothing: each {station_id?, title,
-- details?, team_id?, due_on?, source?, source_date?, source_ref?}. A task
-- whose source_ref is already a task's is not made again: it comes back
-- under `existing` instead. The people who hand out tasks may make one for
-- any team or for none; a team's owner for that team only.
create or replace function meganet.task_create(p_tasks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_all     boolean;
  v_owns    uuid[];
  v_teams   uuid[];
  x         jsonb;
  i         integer := 0;
  v_title   text;
  v_details text;
  v_station text;
  v_team    uuid;
  v_due     date;
  v_source  text;
  v_sdate   date;
  v_ref     text;
  v_id      uuid;
  v_key     text;
  v_created jsonb := '[]'::jsonb;
  v_exist   jsonb := '[]'::jsonb;
  v_at      timestamptz;
  v_by      uuid;
  v_tname   text;
begin
  if v_me is null or not meganet.is_member() then
    raise exception 'sign in with an approved account to hand out a task'
      using errcode = '42501';
  end if;
  v_all   := meganet.hands_out_tasks();
  v_owns  := meganet.my_teams(true);
  v_teams := meganet.my_teams(false);
  if not v_all and pg_catalog.cardinality(v_owns) = 0 then
    raise exception 'you may not hand out tasks'
      using errcode = '42501',
            hint    = 'ask a member of a team that hands out tasks (the SoRT Forum), a team''s owner or an administrator';
  end if;
  if p_tasks is null or pg_catalog.jsonb_typeof(p_tasks) <> 'array' or pg_catalog.jsonb_array_length(p_tasks) = 0 then
    raise exception 'say which tasks to make — a list of them' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_tasks) > 50 then
    raise exception 'at most 50 tasks at a time' using errcode = '22023';
  end if;

  for x in select e from pg_catalog.jsonb_array_elements(p_tasks) e loop
    i := i + 1;
    if pg_catalog.jsonb_typeof(x) <> 'object' then
      raise exception 'task %: not a task', i using errcode = '22023';
    end if;
    for v_key in select pg_catalog.jsonb_object_keys(x) loop
      if v_key not in ('station_id', 'title', 'details', 'team_id', 'due_on', 'source', 'source_date', 'source_ref') then
        raise exception 'task %: % is not something a task has', i, v_key using errcode = '22023';
      end if;
    end loop;

    v_title := pg_catalog.btrim(coalesce(x ->> 'title', ''));
    if pg_catalog.length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
      raise exception 'task %: a title is 1–200 characters on one line', i using errcode = '22023';
    end if;
    v_details := coalesce(x ->> 'details', '');
    if pg_catalog.length(v_details) > 8000 then
      raise exception 'task %: details are at most 8,000 characters', i using errcode = '22023';
    end if;

    v_station := nullif(pg_catalog.btrim(coalesce(x ->> 'station_id', '')), '');
    if v_station is not null and not exists (select 1 from meganet.station s
                                              where s.id = v_station and s.deleted_at is null) then
      raise exception 'task %: no station %', i, v_station using errcode = '22023';
    end if;

    v_team := null;
    if nullif(x ->> 'team_id', '') is not null then
      begin
        v_team := (x ->> 'team_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'task %: that is not a team', i using errcode = '22023';
      end;
      if not exists (select 1 from meganet.team t where t.id = v_team) then
        raise exception 'task %: no such team', i using errcode = '22023';
      end if;
    end if;
    if not v_all and (v_team is null or not (v_team = any (v_owns))) then
      raise exception 'task %: a team''s owner hands tasks to their own team only', i
        using errcode = '42501',
              hint    = 'pick your own team, or ask somebody who hands out tasks';
    end if;

    v_due := null;
    if nullif(x ->> 'due_on', '') is not null then
      if (x ->> 'due_on') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'task %: a due date is YYYY-MM-DD', i using errcode = '22023';
      end if;
      begin
        v_due := (x ->> 'due_on')::date;
      exception when others then
        raise exception 'task %: % is not a date', i, x ->> 'due_on' using errcode = '22023';
      end;
      if v_due not between date '2000-01-01' and date '2100-12-31' then
        raise exception 'task %: % is not a due date', i, v_due using errcode = '22023';
      end if;
    end if;

    v_source := coalesce(nullif(x ->> 'source', ''), 'floodnet');
    if v_source not in ('floodnet', 'sort') then
      raise exception 'task %: a task comes from floodnet or sort', i using errcode = '22023';
    end if;
    v_sdate := null;
    if nullif(x ->> 'source_date', '') is not null then
      if (x ->> 'source_date') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'task %: a forum date is YYYY-MM-DD', i using errcode = '22023';
      end if;
      begin
        v_sdate := (x ->> 'source_date')::date;
      exception when others then
        raise exception 'task %: % is not a date', i, x ->> 'source_date' using errcode = '22023';
      end;
    end if;
    v_ref := nullif(pg_catalog.btrim(coalesce(x ->> 'source_ref', '')), '');
    if v_ref is not null and (pg_catalog.length(v_ref) > 300 or v_ref ~ '[[:cntrl:]]') then
      raise exception 'task %: a source reference is at most 300 characters on one line', i using errcode = '22023';
    end if;
    if v_source = 'sort' and (v_ref is null or v_ref not like 'sort:%') then
      raise exception 'task %: a task from SoRT carries its reference, sort:<session>:<ref>', i using errcode = '22023';
    end if;

    v_id := null;
    insert into meganet.task (station_id, title, details, team_id, due_on, source, source_date, source_ref, created_by)
    values (v_station, v_title, v_details, v_team, v_due, v_source, v_sdate, v_ref, v_me)
    on conflict (source_ref) where source_ref is not null do nothing
    returning id into v_id;

    if v_id is null then
      -- Made already, by this hand-off or an earlier one.
      select k.id, k.created_at, k.created_by, k.team_id into v_id, v_at, v_by, v_team
        from meganet.task k where k.source_ref = v_ref;
      v_exist := v_exist || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ref', v_ref, 'created_at', v_at,
        'visible', v_all or coalesce(v_by = v_me, false) or coalesce(v_team = any (v_teams), false),
        'id', case when v_all or coalesce(v_by = v_me, false) or coalesce(v_team = any (v_teams), false) then v_id end));
    else
      select t.name into v_tname from meganet.team t where t.id = v_team;
      insert into meganet.task_note (task_id, author_id, kind, to_value)
      values (v_id, v_me, 'created', case when v_team is not null then v_tname end);
      v_created := v_created || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', v_id, 'ref', v_ref, 'title', v_title));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('created', v_created, 'existing', v_exist);
end;
$$;

comment on function meganet.task_create(jsonb) is
  'Make up to 50 tasks, all or nothing (0095): each {station_id, title, details, team_id, due_on, source, source_date, source_ref}; an unknown key, a station not in the register, a team that is not one or a bad date refuses the lot in words (22023). One whose source_ref a task already has is not made again and comes back under existing. The people who hand out tasks make them for any team or none; a team''s owner for that team only (42501). Answers {created: [{id, ref, title}], existing: [{ref, created_at, visible, id}]}.';

-- ── 9. Tasks, changed ────────────────────────────────────────────────────────

-- Change a task: p_change holds any of note, status, team_id, title,
-- details, due_on and station_id. Its team adds notes and moves its status
-- (but to or from cancelled); whoever manages it (hands out tasks, made it,
-- or owns its team) does all of that, hands it to another team they may
-- hand out to, edits its words and cancels it. Every change goes in the
-- thread. Answers task_get().
create or replace function meganet.task_update(p_id uuid, p_change jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  k         meganet.task;
  v_may     jsonb;
  v_work    boolean;
  v_manage  boolean;
  v_all     boolean;
  v_owns    uuid[];
  v_key     text;
  v_note    text;
  v_status  text;
  v_team    uuid;
  v_title   text;
  v_details text;
  v_due     date;
  v_station text;
  v_edits   text[] := '{}';
  v_used    boolean := false;
  v_from    text;
  v_to      text;
begin
  if v_me is null or not meganet.is_member() then
    raise exception 'sign in with an approved account to work on a task' using errcode = '42501';
  end if;
  if p_change is null or pg_catalog.jsonb_typeof(p_change) <> 'object' then
    raise exception 'say what to change' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_change) loop
    if v_key not in ('note', 'status', 'team_id', 'title', 'details', 'due_on', 'station_id') then
      raise exception '% is not something a task has', v_key using errcode = '22023';
    end if;
  end loop;

  select * into k from meganet.task t where t.id = p_id for update;
  if found then
    v_may := meganet.task_may(k);
  end if;
  if v_may is null then
    raise exception 'no such task, or not one you may see' using errcode = 'P0002';
  end if;
  v_work   := (v_may ->> 'work')::boolean;
  v_manage := (v_may ->> 'manage')::boolean;
  v_all    := (v_may ->> 'any_team')::boolean;
  v_owns   := meganet.my_teams(true);

  v_note := pg_catalog.btrim(coalesce(p_change ->> 'note', ''));
  if pg_catalog.length(v_note) > 4000 then
    raise exception 'a note is at most 4,000 characters' using errcode = '22023';
  end if;
  if v_note <> '' and not (v_work or v_manage) then
    raise exception 'only the team it is handed to, or whoever manages it, writes on a task' using errcode = '42501';
  end if;

  -- The status.
  if p_change ? 'status' and (p_change ->> 'status') is distinct from k.status then
    v_status := p_change ->> 'status';
    if v_status is null or v_status not in ('open', 'in_progress', 'waiting', 'done', 'cancelled') then
      raise exception 'a task is open, in_progress, waiting, done or cancelled' using errcode = '22023';
    end if;
    if (v_status = 'cancelled' or k.status = 'cancelled') and not v_manage then
      raise exception 'only whoever handed it out, or the people who hand out tasks, cancel a task or bring one back'
        using errcode = '42501';
    end if;
    if not (v_work or v_manage) then
      raise exception 'only the team it is handed to, or whoever manages it, moves a task on' using errcode = '42501';
    end if;
    insert into meganet.task_note (task_id, author_id, kind, body, from_value, to_value)
    values (k.id, v_me, 'status', v_note, k.status, v_status);
    v_used := true;
    update meganet.task t
       set status = v_status,
           closed_at = case when v_status in ('done', 'cancelled') then pg_catalog.now() end
     where t.id = k.id;
  end if;

  -- The team.
  if p_change ? 'team_id' then
    v_team := null;
    if nullif(p_change ->> 'team_id', '') is not null then
      begin
        v_team := (p_change ->> 'team_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'that is not a team' using errcode = '22023';
      end;
      if not exists (select 1 from meganet.team t where t.id = v_team) then
        raise exception 'no such team' using errcode = '22023';
      end if;
    end if;
    if v_team is distinct from k.team_id then
      if not v_manage then
        raise exception 'only whoever manages a task hands it to another team' using errcode = '42501';
      end if;
      if v_team is null and not v_all then
        raise exception 'only the people who hand out tasks leave one with no team' using errcode = '42501';
      end if;
      if v_team is not null and not v_all and not (v_team = any (v_owns)) then
        raise exception 'a team''s owner hands tasks to their own team only'
          using errcode = '42501',
                hint    = 'ask somebody who hands out tasks to give it to that team';
      end if;
      select coalesce((select t.name from meganet.team t where t.id = k.team_id), ''),
             coalesce((select t.name from meganet.team t where t.id = v_team), '')
        into v_from, v_to;
      insert into meganet.task_note (task_id, author_id, kind, body, from_value, to_value)
      values (k.id, v_me, 'team', case when v_used then '' else v_note end, v_from, v_to);
      v_used := true;
      update meganet.task t set team_id = v_team where t.id = k.id;
    end if;
  end if;

  -- Its words, its station and its date.
  if p_change ? 'title' then
    v_title := pg_catalog.btrim(coalesce(p_change ->> 'title', ''));
    if pg_catalog.length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
      raise exception 'a title is 1–200 characters on one line' using errcode = '22023';
    end if;
    if v_title <> k.title then v_edits := v_edits || 'title'::text; end if;
  end if;
  if p_change ? 'details' then
    v_details := coalesce(p_change ->> 'details', '');
    if pg_catalog.length(v_details) > 8000 then
      raise exception 'details are at most 8,000 characters' using errcode = '22023';
    end if;
    if v_details <> k.details then v_edits := v_edits || 'details'::text; end if;
  end if;
  if p_change ? 'due_on' then
    v_due := null;
    if nullif(p_change ->> 'due_on', '') is not null then
      if (p_change ->> 'due_on') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'a due date is YYYY-MM-DD' using errcode = '22023';
      end if;
      begin
        v_due := (p_change ->> 'due_on')::date;
      exception when others then
        raise exception '% is not a date', p_change ->> 'due_on' using errcode = '22023';
      end;
      if v_due not between date '2000-01-01' and date '2100-12-31' then
        raise exception '% is not a due date', v_due using errcode = '22023';
      end if;
    end if;
    if v_due is distinct from k.due_on then v_edits := v_edits || 'due date'::text; end if;
  end if;
  if p_change ? 'station_id' then
    v_station := nullif(pg_catalog.btrim(coalesce(p_change ->> 'station_id', '')), '');
    if v_station is not null and v_station is distinct from k.station_id
       and not exists (select 1 from meganet.station s where s.id = v_station and s.deleted_at is null) then
      raise exception 'no station %', v_station using errcode = '22023';
    end if;
    if v_station is distinct from k.station_id then v_edits := v_edits || 'station'::text; end if;
  end if;
  if pg_catalog.cardinality(v_edits) > 0 then
    if not v_manage then
      raise exception 'only whoever manages a task changes its words, its station or its date' using errcode = '42501';
    end if;
    update meganet.task t
       set title      = case when 'title' = any (v_edits) then v_title else t.title end,
           details    = case when 'details' = any (v_edits) then v_details else t.details end,
           due_on     = case when 'due date' = any (v_edits) then v_due else t.due_on end,
           station_id = case when 'station' = any (v_edits) then v_station else t.station_id end
     where t.id = k.id;
    insert into meganet.task_note (task_id, author_id, kind, body, to_value)
    values (k.id, v_me, 'edit', case when v_used then '' else v_note end, pg_catalog.array_to_string(v_edits, ', '));
    v_used := true;
  end if;

  -- A note on its own.
  if v_note <> '' and not v_used then
    insert into meganet.task_note (task_id, author_id, kind, body) values (k.id, v_me, 'note', v_note);
  end if;

  return meganet.task_get(k.id);
end;
$$;

comment on function meganet.task_update(uuid, jsonb) is
  'Change a task the caller may see (0095): any of note, status, team_id, title, details, due_on, station_id. Its team writes notes and moves the status among open, in_progress, waiting and done; whoever manages it — the people who hand out tasks, whoever made it, its team''s owners — also cancels it or brings it back, hands it to another team they may hand out to (none: the people who hand out tasks only) and edits its words, station and date. Every change goes in the thread, a note with the first. Answers task_get().';

-- ── 10. whoami ───────────────────────────────────────────────────────────────
-- 0076's, saying where the caller stands with teams and tasks.

create or replace function meganet.whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'signed_in',    auth.uid() is not null,
    'email',        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'role',         (select u.role from meganet.app_user u where u.id = auth.uid()),
    'display_name', (select u.display_name from meganet.app_user u where u.id = auth.uid()),
    'may_write',    meganet.is_editor(),
    'is_admin',     auth.uid() is not null and meganet.is_admin(),
    'is_member',    auth.uid() is not null and meganet.is_member(),
    'status',       case when auth.uid() is not null then meganet.account_standing(auth.uid()) end,
    'signup',       case when meganet.signup_open() then 'open' else 'allowlist' end,
    -- To an administrator only: the accounts a decision is waiting on — the
    -- Admin tab's badge, and the nudge an administrator gets on arrival.
    'approvals_waiting', case when auth.uid() is not null and meganet.is_admin() then (
        select count(*)
          from meganet.app_user a
          join auth.users u on u.id = a.id
         where a.status = 'pending'
           and u.email_confirmed_at is not null
           and not meganet.email_allowed(u.email)) end,
    -- The ALERT2 Transition Plan's list (0076): the tab is listed by these.
    'a2plan',           auth.uid() is not null and meganet.is_a2plan_member(),
    'a2plan_nominates', auth.uid() is not null and meganet.is_a2plan_nominator(),
    -- Teams and tasks (0095): the Tasks tab is listed by `tasks` — an
    -- administrator, somebody on a team, or somebody who made a task.
    'tasks',      auth.uid() is not null and meganet.is_member()
                  and (meganet.is_admin()
                       or pg_catalog.cardinality(meganet.my_teams(false)) > 0
                       or exists (select 1 from meganet.task k where k.created_by = auth.uid())),
    'hands_out',  auth.uid() is not null and meganet.hands_out_tasks(),
    'team_owner', auth.uid() is not null and pg_catalog.cardinality(meganet.my_teams(true)) > 0,
    'teams',      case when auth.uid() is not null then pg_catalog.cardinality(meganet.my_teams(false)) else 0 end,
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity, standing, membership, write permission and administration as the database sees them, whether sign-up is open, to an administrator the accounts waiting for a decision, whether the caller is on the ALERT2 Transition Plan''s list and may nominate, and where they stand with teams and tasks — tasks, hands_out, team_owner, teams (0005, 0042, 0062, 0076, 0095). Anonymous callers get signed_in false rather than an error.';

-- ── 11. The starter teams ────────────────────────────────────────────────────
-- Names only, no people: a team for every maintenance hub, named like it and
-- looking after it, and five more. An administrator names their owners. A
-- team already there by name, or a hub already looked after, is left as it is.

insert into meganet.team (name, hub_id)
select h.name, h.id
  from meganet.hub h
 where not exists (select 1 from meganet.team t where t.hub_id = h.id)
   and not exists (select 1 from meganet.team t where pg_catalog.lower(t.name) = pg_catalog.lower(h.name))
 order by h.ord, h.id;

insert into meganet.team (name, hands_out)
select v.name, v.hands_out
  from (values ('Property Services', false), ('Radio licensing', false), ('SoRT Forum', true),
               ('OTE', false), ('ID', false)) as v (name, hands_out)
 where not exists (select 1 from meganet.team t where pg_catalog.lower(t.name) = pg_catalog.lower(v.name));

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Every new function revoked from public in this file (db/README.md); the
-- doors granted to the two roles a request can be, the internals to nobody.

revoke all on function meganet.hands_out_tasks()                         from public;
revoke all on function meganet.my_teams(boolean)                         from public;
revoke all on function meganet.person_name(uuid)                         from public;
revoke all on function meganet.team_roster(uuid, boolean)                from public;
revoke all on function meganet.teams_read()                              from public;
revoke all on function meganet.team_save(uuid, text, text, boolean)      from public;
revoke all on function meganet.team_remove(uuid)                         from public;
revoke all on function meganet.team_member_save(uuid, text, boolean)     from public;
revoke all on function meganet.team_member_remove(uuid, uuid)            from public;
revoke all on function meganet.task_json(meganet.task, boolean, boolean) from public;
revoke all on function meganet.task_list(text, boolean)                  from public;
revoke all on function meganet.task_may(meganet.task)                    from public;
revoke all on function meganet.task_get(uuid)                            from public;
revoke all on function meganet.task_refs(text[])                         from public;
revoke all on function meganet.task_create(jsonb)                        from public;
revoke all on function meganet.task_update(uuid, jsonb)                  from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.team, meganet.team_member, meganet.task, meganet.task_note from anon;
  revoke all on meganet.team_member from authenticated;
  revoke insert, update, delete, truncate, references, trigger
    on meganet.team, meganet.task, meganet.task_note from authenticated;
  grant select on meganet.team, meganet.task, meganet.task_note to authenticated;
  grant select, insert, update, delete on meganet.team, meganet.team_member, meganet.task, meganet.task_note
    to service_role;
  grant usage, select on sequence meganet.task_note_id_seq to service_role;

  -- The task policy asks these as the caller, so authenticated may; each
  -- answers only about the caller.
  grant execute on function meganet.hands_out_tasks()                     to authenticated, service_role;
  grant execute on function meganet.my_teams(boolean)                     to authenticated, service_role;
  grant execute on function meganet.teams_read()                          to authenticated, service_role;
  grant execute on function meganet.team_save(uuid, text, text, boolean)  to authenticated, service_role;
  grant execute on function meganet.team_remove(uuid)                     to authenticated, service_role;
  grant execute on function meganet.team_member_save(uuid, text, boolean) to authenticated, service_role;
  grant execute on function meganet.team_member_remove(uuid, uuid)        to authenticated, service_role;
  grant execute on function meganet.task_list(text, boolean)              to authenticated, service_role;
  grant execute on function meganet.task_get(uuid)                        to authenticated, service_role;
  grant execute on function meganet.task_refs(text[])                     to authenticated, service_role;
  grant execute on function meganet.task_create(jsonb)                    to authenticated, service_role;
  grant execute on function meganet.task_update(uuid, jsonb)              to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  f text;
  r text;
begin
  foreach r in array array['meganet.team', 'meganet.team_member', 'meganet.task', 'meganet.task_note'] loop
    if pg_catalog.to_regclass(r) is null then
      raise exception '0095 did not take: % is missing', r;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = r::regclass) then
      raise exception '0095 did not take: RLS is off on %', r;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'meganet.team_member'::regclass) then
    raise exception '0095 did not take: meganet.team_member has a policy — its roster is read through teams_read() alone';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.whoami()'::regprocedure), 'hands_out_tasks') = 0 then
    raise exception '0095 did not take: whoami() says nothing of teams and tasks';
  end if;
  if not exists (select 1 from meganet.team t where t.name = 'SoRT Forum' and t.hands_out) then
    raise exception '0095 did not take: no SoRT Forum handing out tasks';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    foreach r in array array['meganet.team', 'meganet.team_member', 'meganet.task', 'meganet.task_note'] loop
      if pg_catalog.has_table_privilege('anon', r, 'select,insert,update,delete') then
        raise exception '0095 did not take: anon can read or write %', r;
      end if;
      if pg_catalog.has_table_privilege('authenticated', r, 'insert,update,delete') then
        raise exception '0095 did not take: a browser can write % directly', r;
      end if;
    end loop;
    if pg_catalog.has_table_privilege('authenticated', 'meganet.team_member', 'select') then
      raise exception '0095 did not take: a browser can read every team''s roster';
    end if;
  end if;
  foreach f in array array['meganet.teams_read()', 'meganet.team_save(uuid, text, text, boolean)',
                           'meganet.team_remove(uuid)', 'meganet.team_member_save(uuid, text, boolean)',
                           'meganet.team_member_remove(uuid, uuid)', 'meganet.task_list(text, boolean)',
                           'meganet.task_get(uuid)', 'meganet.task_refs(text[])', 'meganet.task_create(jsonb)',
                           'meganet.task_update(uuid, jsonb)', 'meganet.team_roster(uuid, boolean)',
                           'meganet.person_name(uuid)'] loop
    if pg_catalog.has_function_privilege('public', f, 'execute') then
      raise exception '0095 did not take: public may execute %', f;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and pg_catalog.has_function_privilege('anon', f, 'execute') then
      raise exception '0095 did not take: anon may execute %', f;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and (pg_catalog.has_function_privilege('authenticated', 'meganet.team_roster(uuid, boolean)', 'execute')
          or pg_catalog.has_function_privilege('authenticated', 'meganet.person_name(uuid)', 'execute')) then
    raise exception '0095 did not take: a browser may read a roster or a name without being asked who it is';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 95 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '95')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
