-- 0118_task_tags.sql — Tags on tasks: short words of people's own (RTS, QA,
-- Assessment…) put on a task to say what kind of job it is, each with a
-- meaning said on hover, offered to everybody once anybody has made one.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0118_task_tags.sql
--
-- Why this file exists
-- ────────────────────
-- The owner asked (November 2026) to sort tasks by kind with words of their
-- own, starting with RTS (Return to service), QA (Quality assurance) and
-- Assessment (FWIN site assessment), with the tags already in use suggested
-- and new ones easy to add — and for administrators a place to rename, merge,
-- recolour and retire them.
--
--   1. task_tag      One tag: a name (1–30 characters on one line, no comma,
--                    unique case aside), a meaning (what it means here, said
--                    on hover), a colour from a short list the app draws in
--                    its own tokens, and retired_at — a retired tag stays on
--                    the tasks that have it but is no longer offered. Who
--                    made it is kept as text, history (0100's rule for
--                    attribution written as text).
--   2. task_tagging  Which tasks have which tags.
--
-- Who
-- ───
--   * Every approved account (is_member()) reads the tag list through
--     tags_read(): a tag's name and meaning are not private, its tasks are.
--     Who made a tag and how many tasks have it go to administrators alone.
--   * Whoever may move a task on — its team — or manage it (0095's task_may())
--     changes its tags through task_update({tags}); task_create() takes tags
--     too. A name nobody has used yet makes a new tag there and then, with the
--     meaning it was given if any: that is how a new tag is "easy to add".
--     tag_save() with no id also makes one, for anybody tasks are for.
--   * Administrators rename, re-word, recolour and retire a tag (tag_save()
--     with its id), merge one into another (tag_merge(): every task that had
--     the first has the second, and its thread says so) and remove one no task
--     has (tag_remove()).
--   * Every tag change on a task goes in its thread (task_note kind 'tags':
--     from_value and to_value the tags before and after, by name).
--   * Like tasks, tags are never public: no anon grant, nothing in the station
--     document or the agent API's relations.
--
-- Seeded: RTS, QA and Assessment, with the owner's meanings.
--
-- Depends on 0095 (task, task_note, task_may, task_get and the rest, whose
-- task_json(), task_create() and task_update() this file redefines with tags
-- and otherwise unchanged), 0062 (is_member), 0036 (is_admin).
-- tools/check_task_tags.sql proves it.

-- ── 1. Tags ──────────────────────────────────────────────────────────────────

create table if not exists meganet.task_tag (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  meaning     text        not null default '',
  colour      text        not null default 'grey',
  retired_at  timestamptz,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint task_tag_name_shape check (pg_catalog.length(name) between 1 and 30
                                        and name = pg_catalog.btrim(name) and name !~ '[[:cntrl:],]'),
  constraint task_tag_meaning_size check (pg_catalog.length(meaning) <= 300 and meaning !~ '[[:cntrl:]]'),
  constraint task_tag_colour_known check (colour in ('blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'))
);

comment on table meganet.task_tag is
  'A tag people put on tasks (0118): a name (unique, case aside), what it means here, a colour from the app''s short list, and retired_at — a retired tag stays on its tasks but is not offered. Read through tags_read() by approved accounts; made through task_create(), task_update() and tag_save(), changed, merged and removed by administrators.';

create unique index if not exists task_tag_name_key on meganet.task_tag (pg_catalog.lower(name));

drop trigger if exists task_tag_touch_updated_at on meganet.task_tag;
create trigger task_tag_touch_updated_at
  before update on meganet.task_tag
  for each row execute function meganet.touch_updated_at();

create table if not exists meganet.task_tagging (
  task_id   uuid        not null references meganet.task (id) on delete cascade,
  tag_id    uuid        not null references meganet.task_tag (id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (task_id, tag_id)
);

comment on table meganet.task_tagging is
  'Which tasks have which tags (0118). RLS on, no policy, no grant: read inside task_json(), written by task_create(), task_update() and tag_merge().';

create index if not exists task_tagging_tag on meganet.task_tagging (tag_id);

alter table meganet.task_tag enable row level security;
alter table meganet.task_tagging enable row level security;
-- No policy on either: read through tags_read() and task_json() alone.

-- A tag change goes in the thread.
alter table meganet.task_note drop constraint if exists task_note_kind_known;
alter table meganet.task_note add constraint task_note_kind_known
  check (kind in ('created', 'note', 'status', 'team', 'edit', 'tags'));

-- ── 2. The helpers ───────────────────────────────────────────────────────────

-- May the caller tag tasks at all — make a tag? Anybody tasks are for: an
-- approved account who hands out tasks, is on a team, or made a task.
create or replace function meganet.may_tag()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select meganet.is_member()
     and (meganet.hands_out_tasks()
          or pg_catalog.cardinality(meganet.my_teams(false)) > 0
          or exists (select 1 from meganet.task k where k.created_by = auth.uid()));
$$;

comment on function meganet.may_tag() is
  'May the caller make a tag (0118)? An approved account that hands out tasks, is on a team or made a task. Internal: tag_save() asks it.';

-- A task's tags by name, A–Z, joined — what the thread keeps.
create or replace function meganet.task_tag_names(p_task uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.string_agg(g.name, ', ' order by pg_catalog.lower(g.name)), '')
    from meganet.task_tagging x
    join meganet.task_tag g on g.id = x.tag_id
   where x.task_id = p_task;
$$;

comment on function meganet.task_tag_names(uuid) is
  'A task''s tags by name, A–Z, joined with ", " (0118). Internal: what a tags entry in the thread keeps.';

-- A tag name as it is kept: spaces closed up and trimmed.
create or replace function meganet.tag_name_clean(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
$$;

-- The tags a list names, as ids: each a name, or {name, meaning, colour}.
-- A name already a tag's (case aside, retired or not) is that tag; one that
-- is nobody's yet is made, with the meaning and colour given. At most 12; the
-- same tag twice is once. p_label goes in front of a refusal ('task 3: ').
create or replace function meganet.tag_resolve(p_tags jsonb, p_label text default '')
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  e        jsonb;
  v_key    text;
  v_name   text;
  v_mean   text;
  v_col    text;
  v_id     uuid;
  v_out    uuid[] := '{}';
  v_n      integer;
  v_cols   constant text[] := array['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'];
  p        text := coalesce(p_label, '');
begin
  if p_tags is null or pg_catalog.jsonb_typeof(p_tags) = 'null' then
    return v_out;
  end if;
  if pg_catalog.jsonb_typeof(p_tags) <> 'array' then
    raise exception '%tags are a list of names', p using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_tags) > 12 then
    raise exception '%at most 12 tags on a task', p using errcode = '22023';
  end if;
  for e in select x from pg_catalog.jsonb_array_elements(p_tags) x loop
    v_mean := null; v_col := null;
    if pg_catalog.jsonb_typeof(e) = 'string' then
      v_name := meganet.tag_name_clean(e #>> '{}');
    elsif pg_catalog.jsonb_typeof(e) = 'object' then
      for v_key in select pg_catalog.jsonb_object_keys(e) loop
        if v_key not in ('name', 'meaning', 'colour') then
          raise exception '%a tag has a name, a meaning and a colour — not %', p, v_key using errcode = '22023';
        end if;
      end loop;
      v_name := meganet.tag_name_clean(e ->> 'name');
      v_mean := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(e ->> 'meaning', ''), '\s+', ' ', 'g'));
      v_col  := nullif(e ->> 'colour', '');
    else
      raise exception '%a tag is a name', p using errcode = '22023';
    end if;
    if pg_catalog.length(v_name) not between 1 and 30 or v_name ~ '[[:cntrl:],]' then
      raise exception '%a tag is 1–30 characters on one line, without a comma: %', p, coalesce(nullif(v_name, ''), '(nothing)')
        using errcode = '22023';
    end if;
    select g.id into v_id from meganet.task_tag g where pg_catalog.lower(g.name) = pg_catalog.lower(v_name);
    if v_id is null then
      if pg_catalog.length(coalesce(v_mean, '')) > 300 then
        raise exception '%a tag''s meaning is at most 300 characters', p using errcode = '22023';
      end if;
      if v_col is not null and not (v_col = any (v_cols)) then
        raise exception '%a tag''s colour is one of %', p, pg_catalog.array_to_string(v_cols, ', ') using errcode = '22023';
      end if;
      select count(*) into v_n from meganet.task_tag;
      if v_n >= 300 then
        raise exception '%there are 300 tags already — use one of them, or ask an administrator to merge some', p
          using errcode = '54000';
      end if;
      insert into meganet.task_tag (name, meaning, colour, created_by)
      values (v_name, coalesce(v_mean, ''), coalesce(v_col, v_cols[1 + (v_n % pg_catalog.array_length(v_cols, 1))]),
              coalesce(meganet.person_name(auth.uid()), meganet.actor()))
      returning id into v_id;
    end if;
    if not (v_id = any (v_out)) then
      v_out := v_out || v_id;
    end if;
  end loop;
  return v_out;
end;
$$;

comment on function meganet.tag_resolve(jsonb, text) is
  'The tags a list names, as ids (0118): each a name, or {name, meaning, colour}; an existing tag by its name (case aside, retired too), a new one made with the meaning and colour given. At most 12. Internal: task_create() and task_update() call it, having asked who is calling.';

-- ── 3. Tasks, with their tags ────────────────────────────────────────────────
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
    'tags', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', g.id, 'name', g.name, 'colour', g.colour)
                                                  order by pg_catalog.lower(g.name))
                        from meganet.task_tagging x join meganet.task_tag g on g.id = x.tag_id
                       where x.task_id = p_task.id), '[]'::jsonb),
    'my_team', coalesce(p_mine, false), 'by_me', coalesce(p_by, false),
    'notes', (select count(*) from meganet.task_note n where n.task_id = p_task.id and n.kind = 'note'),
    'last_at', coalesce((select max(n.created_at) from meganet.task_note n where n.task_id = p_task.id), p_task.created_at));
$$;

comment on function meganet.task_json(meganet.task, boolean, boolean) is
  'A task as the doors answer it, without its details or thread (0095), with its tags [{id, name, colour}] A–Z (0118). Internal: granted to nobody.';

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
  v_tags    uuid[];
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
      if v_key not in ('station_id', 'title', 'details', 'team_id', 'due_on', 'source', 'source_date', 'source_ref', 'tags') then
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
      -- Its tags (0118): a name nobody has used yet is a new tag.
      v_tags := meganet.tag_resolve(x -> 'tags', pg_catalog.format('task %s: ', i));
      if pg_catalog.cardinality(v_tags) > 0 then
        insert into meganet.task_tagging (task_id, tag_id)
        select v_id, u from pg_catalog.unnest(v_tags) u on conflict do nothing;
        insert into meganet.task_note (task_id, author_id, kind, from_value, to_value)
        values (v_id, v_me, 'tags', '', meganet.task_tag_names(v_id));
      end if;
      v_created := v_created || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', v_id, 'ref', v_ref, 'title', v_title));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('created', v_created, 'existing', v_exist);
end;
$$;

comment on function meganet.task_create(jsonb) is
  'Make up to 50 tasks, all or nothing (0095): each {station_id, title, details, team_id, due_on, source, source_date, source_ref, tags} — tags a list of names or {name, meaning, colour}, a new name a new tag (0118); an unknown key, a station not in the register, a team that is not one or a bad date refuses the lot in words (22023). One whose source_ref a task already has is not made again and comes back under existing. The people who hand out tasks make them for any team or none; a team''s owner for that team only (42501). Answers {created: [{id, ref, title}], existing: [{ref, created_at, visible, id}]}.';

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
  v_tags    uuid[];
  v_had     uuid[];
begin
  if v_me is null or not meganet.is_member() then
    raise exception 'sign in with an approved account to work on a task' using errcode = '42501';
  end if;
  if p_change is null or pg_catalog.jsonb_typeof(p_change) <> 'object' then
    raise exception 'say what to change' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_change) loop
    if v_key not in ('note', 'status', 'team_id', 'title', 'details', 'due_on', 'station_id', 'tags') then
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

  -- Its tags (0118): the whole list as it is to be; a name nobody has used
  -- yet is a new tag. Its team or whoever manages it.
  if p_change ? 'tags' then
    v_tags := meganet.tag_resolve(p_change -> 'tags', '');
    select coalesce(pg_catalog.array_agg(x.tag_id), '{}') into v_had from meganet.task_tagging x where x.task_id = k.id;
    if not (v_tags @> v_had and v_had @> v_tags) then
      if not (v_work or v_manage) then
        raise exception 'only the team it is handed to, or whoever manages it, tags a task' using errcode = '42501';
      end if;
      v_from := meganet.task_tag_names(k.id);
      delete from meganet.task_tagging x where x.task_id = k.id and not (x.tag_id = any (v_tags));
      insert into meganet.task_tagging (task_id, tag_id)
      select k.id, u from pg_catalog.unnest(v_tags) u on conflict do nothing;
      insert into meganet.task_note (task_id, author_id, kind, body, from_value, to_value)
      values (k.id, v_me, 'tags', case when v_used then '' else v_note end, v_from, meganet.task_tag_names(k.id));
      v_used := true;
      update meganet.task t set updated_at = pg_catalog.now() where t.id = k.id;
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
  'Change a task the caller may see (0095): any of note, status, team_id, title, details, due_on, station_id, and tags (0118: the whole list as it is to be, names or {name, meaning, colour}, a new name a new tag; its team or whoever manages it). Its team writes notes and moves the status among open, in_progress, waiting and done; whoever manages it — the people who hand out tasks, whoever made it, its team''s owners — also cancels it or brings it back, hands it to another team they may hand out to (none: the people who hand out tasks only) and edits its words, station and date. Every change goes in the thread, a note with the first. Answers task_get().';

-- ── 4. Tags, read ────────────────────────────────────────────────────────────

-- Every tag, the ones in use first A–Z, the retired at the foot: name,
-- meaning, colour, retired — to an approved account. Who made each and how
-- many tasks have it (and how many of those are still going), to
-- administrators.
create or replace function meganet.tags_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  if not meganet.is_member() then
    raise exception 'tags are for approved accounts'
      using errcode = '42501',
            hint    = 'sign in with an account an administrator has approved';
  end if;
  v_admin := meganet.is_admin();
  return pg_catalog.jsonb_build_object(
    'me', pg_catalog.jsonb_build_object('admin', v_admin, 'may_tag', meganet.may_tag()),
    'colours', pg_catalog.to_jsonb(array['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey']),
    'tags', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', g.id, 'name', g.name, 'meaning', g.meaning, 'colour', g.colour,
               'retired', g.retired_at is not null)
             || case when v_admin then pg_catalog.jsonb_build_object(
                  'retired_at', g.retired_at, 'created_by', g.created_by, 'created_at', g.created_at,
                  'tasks', (select count(*) from meganet.task_tagging x where x.tag_id = g.id),
                  'live', (select count(*) from meganet.task_tagging x join meganet.task k on k.id = x.task_id
                            where x.tag_id = g.id and k.status in ('open', 'in_progress', 'waiting')))
                else '{}'::jsonb end
             order by g.retired_at is not null, pg_catalog.lower(g.name))
        from meganet.task_tag g), '[]'::jsonb));
end;
$$;

comment on function meganet.tags_read() is
  'Every tag (0118), to an approved account (42501 otherwise): {me: {admin, may_tag}, colours, tags: [{id, name, meaning, colour, retired}]} — retired ones last — and to administrators each tag''s retired_at, created_by, created_at, tasks (how many have it) and live (how many of those are not finished).';

-- ── 5. Tags, changed ─────────────────────────────────────────────────────────

-- Make a tag (no id) — anybody tasks are for — or change one: its name, its
-- meaning, its colour, and with p_retired whether it is still offered (null
-- leaves that as it is) — administrators. Answers tags_read().
create or replace function meganet.tag_save(p_id uuid, p_name text, p_meaning text default '',
                                            p_colour text default null, p_retired boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := meganet.tag_name_clean(p_name);
  v_mean text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_meaning, ''), '\s+', ' ', 'g'));
  v_cols constant text[] := array['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'];
  v_n    integer;
begin
  if p_id is null then
    if not meganet.may_tag() then
      raise exception 'tags are made by the people tasks are for'
        using errcode = '42501',
              hint    = 'an administrator, somebody on a team, or somebody who made a task';
    end if;
  elsif not meganet.is_admin() then
    raise exception 'only an administrator changes a tag' using errcode = '42501';
  end if;
  if pg_catalog.length(v_name) not between 1 and 30 or v_name ~ '[[:cntrl:],]' then
    raise exception 'a tag is 1–30 characters on one line, without a comma' using errcode = '22023';
  end if;
  if pg_catalog.length(v_mean) > 300 then
    raise exception 'a tag''s meaning is at most 300 characters' using errcode = '22023';
  end if;
  if p_colour is not null and not (p_colour = any (v_cols)) then
    raise exception 'a tag''s colour is one of %', pg_catalog.array_to_string(v_cols, ', ') using errcode = '22023';
  end if;
  if exists (select 1 from meganet.task_tag g
              where pg_catalog.lower(g.name) = pg_catalog.lower(v_name) and g.id is distinct from p_id) then
    raise exception 'there is a tag called % already', v_name
      using errcode = '23505',
            hint    = 'use that one — or, to make two one, merge them';
  end if;
  if p_id is null then
    select count(*) into v_n from meganet.task_tag;
    if v_n >= 300 then
      raise exception 'there are 300 tags already — use one of them, or ask an administrator to merge some'
        using errcode = '54000';
    end if;
    insert into meganet.task_tag (name, meaning, colour, created_by)
    values (v_name, v_mean, coalesce(p_colour, v_cols[1 + (v_n % pg_catalog.array_length(v_cols, 1))]),
            coalesce(meganet.person_name(auth.uid()), meganet.actor()));
  else
    update meganet.task_tag g
       set name = v_name, meaning = v_mean, colour = coalesce(p_colour, g.colour),
           retired_at = case when p_retired is null then g.retired_at
                             when p_retired then coalesce(g.retired_at, pg_catalog.now()) end
     where g.id = p_id;
    if not found then
      raise exception 'no such tag' using errcode = 'P0002';
    end if;
  end if;
  return meganet.tags_read();
end;
$$;

comment on function meganet.tag_save(uuid, text, text, text, boolean) is
  'Make a tag (0118: no id — anybody may_tag() says yes to) or change one (its id — administrators, 42501 otherwise): its name, meaning, colour, and p_retired (true retires it — still on its tasks, no longer offered; false brings it back; null leaves it). A name another tag has is 23505; more than 300 tags is 54000. Answers tags_read().';

-- Make two tags one: every task with p_from has p_into instead, its thread
-- saying so, and p_from goes. Administrators. Answers tags_read().
create or replace function meganet.tag_merge(p_from uuid, p_into uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from  meganet.task_tag;
  v_into  meganet.task_tag;
  v_task  uuid;
  v_was   text;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator merges tags' using errcode = '42501';
  end if;
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'name two different tags: the one that goes, and the one it becomes' using errcode = '22023';
  end if;
  select * into v_from from meganet.task_tag g where g.id = p_from for update;
  if not found then raise exception 'no such tag to merge' using errcode = 'P0002'; end if;
  select * into v_into from meganet.task_tag g where g.id = p_into for update;
  if not found then raise exception 'no such tag to merge it into' using errcode = 'P0002'; end if;

  for v_task in select x.task_id from meganet.task_tagging x where x.tag_id = p_from loop
    v_was := meganet.task_tag_names(v_task);
    insert into meganet.task_tagging (task_id, tag_id) values (v_task, p_into) on conflict do nothing;
    delete from meganet.task_tagging x where x.task_id = v_task and x.tag_id = p_from;
    insert into meganet.task_note (task_id, author_id, kind, body, from_value, to_value)
    values (v_task, auth.uid(), 'tags', pg_catalog.format('The tag %s was merged into %s.', v_from.name, v_into.name),
            v_was, meganet.task_tag_names(v_task));
  end loop;
  -- The one kept takes the other's meaning if it had none.
  if v_into.meaning = '' and v_from.meaning <> '' then
    update meganet.task_tag g set meaning = v_from.meaning where g.id = p_into;
  end if;
  delete from meganet.task_tag g where g.id = p_from;
  return meganet.tags_read();
end;
$$;

comment on function meganet.tag_merge(uuid, uuid) is
  'Make two tags one (0118): every task with p_from has p_into instead — a tags entry in its thread says so — p_into takes p_from''s meaning if it had none, and p_from is removed. Administrators (42501). Answers tags_read().';

-- Remove a tag no task has. Administrators. Answers tags_read().
create or replace function meganet.tag_remove(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator removes a tag' using errcode = '42501';
  end if;
  if not exists (select 1 from meganet.task_tag g where g.id = p_id) then
    raise exception 'no such tag' using errcode = 'P0002';
  end if;
  select count(*) into v_n from meganet.task_tagging x where x.tag_id = p_id;
  if v_n > 0 then
    raise exception 'that tag is on % task%', v_n, case when v_n = 1 then '' else 's' end
      using errcode = '23503',
            hint    = 'retire it, so it is no longer offered, or merge it into another';
  end if;
  delete from meganet.task_tag g where g.id = p_id;
  return meganet.tags_read();
end;
$$;

comment on function meganet.tag_remove(uuid) is
  'Remove a tag no task has (0118): administrators (42501); a tag on any task is 23503 — retire it or merge it instead. Answers tags_read().';

-- ── 6. The starter tags ──────────────────────────────────────────────────────

insert into meganet.task_tag (name, meaning, colour, created_by) values
  ('RTS',        'Return to service: getting a station that is out of action working and reporting again.', 'red',   'Flood-Net (0118)'),
  ('QA',         'Quality assurance: checking that a station''s readings, or the work done at it, are right.', 'blue',  'Flood-Net (0118)'),
  ('Assessment', 'FWIN site assessment: assessing a site for the Flood Warning Infrastructure Network program.', 'green', 'Flood-Net (0118)')
on conflict ((pg_catalog.lower(name))) do nothing;

-- ── 7. Grants ────────────────────────────────────────────────────────────────

revoke all on function meganet.may_tag()                                   from public;
revoke all on function meganet.task_tag_names(uuid)                        from public;
revoke all on function meganet.tag_name_clean(text)                        from public;
revoke all on function meganet.tag_resolve(jsonb, text)                    from public;
revoke all on function meganet.task_json(meganet.task, boolean, boolean)   from public;
revoke all on function meganet.task_create(jsonb)                          from public;
revoke all on function meganet.task_update(uuid, jsonb)                    from public;
revoke all on function meganet.tags_read()                                 from public;
revoke all on function meganet.tag_save(uuid, text, text, text, boolean)   from public;
revoke all on function meganet.tag_merge(uuid, uuid)                       from public;
revoke all on function meganet.tag_remove(uuid)                            from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.task_tag, meganet.task_tagging from anon, authenticated;
  grant select, insert, update, delete on meganet.task_tag, meganet.task_tagging to service_role;

  grant execute on function meganet.task_create(jsonb)                        to authenticated, service_role;
  grant execute on function meganet.task_update(uuid, jsonb)                  to authenticated, service_role;
  grant execute on function meganet.tags_read()                               to authenticated, service_role;
  grant execute on function meganet.tag_save(uuid, text, text, text, boolean) to authenticated, service_role;
  grant execute on function meganet.tag_merge(uuid, uuid)                     to authenticated, service_role;
  grant execute on function meganet.tag_remove(uuid)                          to authenticated, service_role;
end
$$;

-- ── 8. Did it take ───────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.pg_get_functiondef('meganet.task_update(uuid, jsonb)'::regprocedure) not like '%tag_resolve%' then
    raise exception '0118 did not take: task_update() does not take tags';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.task_create(jsonb)'::regprocedure) not like '%tag_resolve%' then
    raise exception '0118 did not take: task_create() does not take tags';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.task_json(meganet.task, boolean, boolean)'::regprocedure) not like '%task_tagging%' then
    raise exception '0118 did not take: task_json() does not say a task''s tags';
  end if;
  if (select count(*) from meganet.task_tag where pg_catalog.lower(name) in ('rts', 'qa', 'assessment')) <> 3 then
    raise exception '0118 did not take: the three starter tags are not there';
  end if;
end
$$;

insert into meganet.app_meta (key, value)
values ('schema_version', '118')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
