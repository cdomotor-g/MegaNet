// A small in-memory PostgREST, for test/agent-api.mjs.
//
// worker/api.js builds real PostgREST URLs — filters, logic trees, embedded
// resources, JSON paths, counted ranges — and the only way to hold those to the
// grammar without a database is to answer them the way PostgREST would. So this
// parses what the API sends and answers from tables built out of the real
// stations.json, and it is strict where PostgREST is strict: an unknown
// relation, a column the migrations never made, a relation `anon` may not read
// or a malformed logic tree is an error here too, not a quiet empty array. A
// query that only works against a forgiving fake is the failure it exists for.
//
// What it implements is what the API uses, and nothing it does not:
//   select=a,b,rel(c,d) (one-to-many embeds off meganet.station)   order=a.asc,b.desc.nullslast
//   eq neq gt gte lt lte like ilike in is cs cd ov, each with not.       limit offset
//   or=(…) and=(…) nested, quoted values, {arrays}, (lists), a->b / a->>b paths
//   Prefer: count=exact → Content-Range, and 416 past the end
//   a max-rows cap (1000, Supabase's default), so paging is exercised for real
//
// Every request is recorded — method, URL and headers — so the caller can
// assert the API's read-only property over everything it actually sent.

const MAX_ROWS = 1000;

// Relations the anon role cannot read at all. Asking for one is a 401 from the
// real API; here it is the same, so a stray read shows up as a failure.
const PRIVATE = new Set(['reading_raw', 'app_user', 'editor_allow', 'ingest_token', 'inspection',
  'inspection_power', 'inspection_radio', 'inspection_data', 'field_photo', 'maintenance_activity',
  'attachment', 'field_photo_sync', 'bridge_health_secret']);

// The embeds PostgREST can infer from a foreign key onto meganet.station.
const STATION_CHILDREN = new Set(['sensor', 'station_flood_class', 'station_aep_level', 'station_crossing',
  'station_gauge_survey', 'station_flood_effect', 'station_bureau_listing', 'station_frequency']);

export class PostgrestStub {
  constructor({ base, columns, tables }) {
    this.base = base.replace(/\/$/, '');
    this.columns = columns;        // relation → Set of column names
    this.tables = tables;          // relation → array of rows
    this.requests = [];
    this.fault = null;             // (relation, url) → Response | Error | null
    this.maxRows = MAX_ROWS;
    this.index = new Map();        // relation → Map(station_id → rows)
  }

  childrenOf(relation, stationId) {
    if (!this.index.has(relation)) {
      const m = new Map();
      for (const r of this.tables[relation] || []) {
        if (!m.has(r.station_id)) m.set(r.station_id, []);
        m.get(r.station_id).push(r);
      }
      this.index.set(relation, m);
    }
    return this.index.get(relation).get(stationId) || [];
  }

  reset() { this.requests = []; this.fault = null; }

  async fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    this.requests.push({ url, method, headers: Object.fromEntries(headers.entries()) });

    if (!url.startsWith(`${this.base}/`)) throw new Error(`the stub was asked for ${url}, which is not the database`);
    const u = new URL(url);
    const relation = decodeURIComponent(u.pathname.slice(new URL(this.base).pathname.length + 1));

    if (this.fault) {
      const f = this.fault(relation, url);
      if (f instanceof Error) throw f;
      if (f) return f;
    }
    if (method !== 'GET' && method !== 'HEAD') return err(405, 'PGRST000', `${method} is not something a reader sends`);
    if (headers.get('accept-profile') !== 'meganet') return err(406, 'PGRST106', 'The schema must be meganet');
    if (relation.startsWith('rpc/')) return err(404, 'PGRST202', `Could not find the function ${relation}`);
    if (PRIVATE.has(relation)) return err(401, '42501', `permission denied for table ${relation}`);
    if (!this.columns[relation]) return err(404, '42P01', `relation "meganet.${relation}" does not exist`);

    let query;
    try { query = parseQuery(relation, u.searchParams, this.columns); } catch (e) { return err(400, e.code || 'PGRST100', e.message); }

    let rows = (this.tables[relation] || []).filter(r => query.filters.every(f => f(r)));
    rows = sortRows(rows, query.order);
    const total = rows.length;
    const offset = query.offset || 0;
    const count = /count=exact/.test(headers.get('prefer') || '');
    if (count && total > 0 && offset >= total) {
      return new Response(JSON.stringify({ code: 'PGRST103', message: 'Requested range not satisfiable' }),
        { status: 416, headers: { 'Content-Type': 'application/json', 'Content-Range': `*/${total}` } });
    }
    const limit = Math.min(query.limit ?? Infinity, this.maxRows);
    const page = rows.slice(offset, offset + limit).map(r => project(r, query.select, this, relation));
    const range = page.length ? `${offset}-${offset + page.length - 1}/${count ? total : '*'}` : `*/${count ? total : '*'}`;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Range': range },
    });
  }
}

function err(status, code, message) {
  return new Response(JSON.stringify({ code, message, details: null, hint: null }),
    { status, headers: { 'Content-Type': 'application/json' } });
}

function fail(message, code = 'PGRST100') {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseQuery(relation, params, columns) {
  const cols = columns[relation];
  const q = { select: null, order: [], filters: [], limit: undefined, offset: undefined };
  for (const [k, v] of params) {
    if (k === 'select') q.select = parseSelect(v, relation, columns);
    else if (k === 'order') q.order = parseOrder(v, cols, relation);
    else if (k === 'limit') q.limit = toInt(v, 'limit');
    else if (k === 'offset') q.offset = toInt(v, 'offset');
    else if (k === 'or' || k === 'and') q.filters.push(parseLogic(k, v, cols, relation));
    else q.filters.push(parseFilter(k, v, cols, relation));
  }
  return q;
}

function toInt(v, name) {
  if (!/^\d+$/.test(v)) throw fail(`${name} must be a non-negative integer`);
  return Number(v);
}

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '', quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '(' || ch === '{')) depth++;
    if (!quoted && (ch === ')' || ch === '}')) depth--;
    if (!quoted && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth !== 0 || quoted) throw fail(`unbalanced brackets or quotes in "${s}"`);
  out.push(cur);
  return out;
}

function parseSelect(v, relation, columns) {
  const cols = columns[relation];
  const items = [];
  for (const raw of splitTop(v)) {
    const item = raw.trim();
    if (!item) throw fail('empty item in select');
    const m = /^([a-z_][a-z0-9_]*)(!inner)?\((.*)\)$/i.exec(item);
    if (m) {
      const child = m[1];
      if (relation !== 'station' || !STATION_CHILDREN.has(child)) {
        throw fail(`Could not find a relationship between '${relation}' and '${child}' in the schema cache`, 'PGRST200');
      }
      items.push({ embed: child, select: parseSelect(m[3], child, columns) });
      continue;
    }
    if (item === '*') { items.push({ star: true }); continue; }
    if (!/^[a-z_][a-z0-9_]*$/i.test(item)) throw fail(`unsupported select item "${item}"`);
    if (!cols.has(item)) throw fail(`column ${relation}.${item} does not exist`, '42703');
    items.push({ col: item });
  }
  return items;
}

function parseOrder(v, cols, relation) {
  return splitTop(v).map(term => {
    const [col, dir = 'asc', nulls] = term.trim().split('.');
    if (!cols.has(col)) throw fail(`column ${relation}.${col} does not exist`, '42703');
    if (!['asc', 'desc'].includes(dir)) throw fail(`bad order direction "${dir}"`);
    if (nulls && !['nullsfirst', 'nullslast'].includes(nulls)) throw fail(`bad nulls option "${nulls}"`);
    return { col, desc: dir === 'desc', nullsFirst: nulls ? nulls === 'nullsfirst' : dir === 'desc' };
  });
}

// A field with an optional JSON path: col, col->key, col->>key.
function parseField(field, cols, relation) {
  const m = /^([a-z_][a-z0-9_]*)((?:->>?[a-z0-9_]+)*)$/i.exec(field);
  if (!m) throw fail(`"${field}" is not a field`);
  if (!cols.has(m[1])) throw fail(`column ${relation}.${m[1]} does not exist`, '42703');
  const steps = [...m[2].matchAll(/(->>?)([a-z0-9_]+)/gi)].map(s => ({ text: s[1] === '->>', key: s[2] }));
  return row => {
    let v = row[m[1]];
    for (const s of steps) {
      if (v == null || typeof v !== 'object') return null;
      v = v[s.key];
      if (v === undefined) return null;
      if (s.text && v !== null) v = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return v === undefined ? null : v;
  };
}

const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'cs', 'cd', 'ov']);

function parseOpValue(opval, field, cols, relation, inLogic) {
  let s = opval;
  let negate = false;
  if (s.startsWith('not.')) { negate = true; s = s.slice(4); }
  const dot = s.indexOf('.');
  if (dot < 0) throw fail(`"${opval}" has no operator`);
  const op = s.slice(0, dot);
  let raw = s.slice(dot + 1);
  if (!OPS.has(op)) throw fail(`unknown operator "${op}"`);
  if (inLogic && raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw fail(`a quoted value must be followed by , or ) in "${opval}"`);
    raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  const get = parseField(field, cols, relation);
  const test = makeTest(op, raw);
  return row => { const r = test(get(row)); return negate ? !r : r; };
}

function parseFilter(key, value, cols, relation) {
  return parseOpValue(value, key, cols, relation, false);
}

// or=(a.eq.1,and(b.gt.2,c.is.null)), and=(or(…),or(…)); items split at the top
// level only, so a quoted comma or a comma inside {…} or (…) stays in its value.
function parseLogic(kind, value, cols, relation) {
  if (!value.startsWith('(') || !value.endsWith(')')) throw fail(`${kind} must be wrapped in parentheses`);
  const parts = splitTop(value.slice(1, -1));
  const tests = parts.map(p => {
    const item = p.trim();
    const nested = /^(not\.)?(and|or)\((.*)\)$/s.exec(item);
    if (nested) {
      const t = parseLogic(nested[2], `(${nested[3]})`, cols, relation);
      return nested[1] ? row => !t(row) : t;
    }
    const dot = item.indexOf('.');
    if (dot < 0) throw fail(`"${item}" is not a filter`);
    return parseOpValue(item.slice(dot + 1), item.slice(0, dot), cols, relation, true);
  });
  return kind === 'or' ? row => tests.some(t => t(row)) : row => tests.every(t => t(row));
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function unquote(s) {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t;
}

function parseList(raw) {
  if (!raw.startsWith('(') || !raw.endsWith(')')) throw fail(`an in-list must be wrapped in parentheses: ${raw}`);
  const inner = raw.slice(1, -1);
  return inner === '' ? [] : splitTop(inner).map(unquote);
}

function parseArray(raw) {
  if (!raw.startsWith('{') || !raw.endsWith('}')) throw fail(`an array must be wrapped in braces: ${raw}`);
  const inner = raw.slice(1, -1);
  return inner === '' ? [] : splitTop(inner).map(unquote);
}

function comparable(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    if (Number.isFinite(t)) return t;
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

function eqValue(fv, raw) {
  if (fv == null) return false;
  if (typeof fv === 'number') return Number(raw) === fv;
  if (typeof fv === 'boolean') return String(fv) === raw;
  if (typeof fv === 'object') return JSON.stringify(fv) === raw;
  return String(fv) === raw;
}

function likeRegex(pattern, flags) {
  const src = pattern.split('').map(ch => (ch === '*' || ch === '%') ? '.*'
    : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${src}$`, flags);
}

function makeTest(op, raw) {
  switch (op) {
    case 'eq': return fv => eqValue(fv, raw);
    case 'neq': return fv => fv != null && !eqValue(fv, raw);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const b = comparable(raw);
      return fv => {
        if (fv == null) return false;
        const a = comparable(fv);
        if (typeof a !== typeof b) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      };
    }
    case 'like': case 'ilike': {
      const re = likeRegex(raw, op === 'ilike' ? 'is' : 's');
      return fv => fv != null && re.test(String(fv));
    }
    case 'in': {
      const list = parseList(raw);
      return fv => fv != null && list.some(x => eqValue(fv, x));
    }
    case 'is': {
      if (!['null', 'true', 'false', 'unknown'].includes(raw)) throw fail(`is.${raw} is not a thing`);
      return fv => (raw === 'null' || raw === 'unknown' ? fv == null : fv === (raw === 'true'));
    }
    case 'cs': case 'cd': case 'ov': {
      const arr = parseArray(raw);
      return fv => {
        if (!Array.isArray(fv)) return false;
        const vals = fv.map(String);
        if (op === 'cs') return arr.every(x => vals.includes(x));
        if (op === 'cd') return vals.every(x => arr.includes(x));
        return arr.some(x => vals.includes(x));
      };
    }
    default: throw fail(`unknown operator ${op}`);
  }
}

function sortRows(rows, order) {
  if (!order.length) return rows;
  return rows.slice().sort((a, b) => {
    for (const o of order) {
      const x = a[o.col], y = b[o.col];
      if (x == null && y == null) continue;
      if (x == null) return o.nullsFirst ? -1 : 1;
      if (y == null) return o.nullsFirst ? 1 : -1;
      const cx = comparable(x), cy = comparable(y);
      if (cx < cy) return o.desc ? 1 : -1;
      if (cx > cy) return o.desc ? -1 : 1;
    }
    return 0;
  });
}

function project(row, select, stub, relation) {
  if (!select) return { ...row };
  const out = {};
  for (const item of select) {
    if (item.star) Object.assign(out, row);
    else if (item.col) out[item.col] = row[item.col] === undefined ? null : row[item.col];
    else if (item.embed) {
      out[item.embed] = stub.childrenOf(item.embed, row.id).map(c => project(c, item.select, stub, item.embed));
    }
  }
  return out;
}
