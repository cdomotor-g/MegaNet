// log.js — Structured logs, because when readings go missing this process is
// the first suspect and its log is the only evidence.
//
// One JSON object per line on stdout. Not pretty-printed, not coloured, no
// framework: whatever collects logs where this ends up running — journald, Fly,
// Docker — collects lines, and a line that is already JSON can be queried
// without a parser somebody has to maintain a regex for.
//
// Every line carries `event`, a stable string. Messages are for humans and get
// reworded; `event` is what a search or an alert matches on, so the values are
// listed in bridge/README.md and changing one is a breaking change to whoever
// is watching.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Anything that looks like a credential never reaches stdout, whatever a caller
// passes. A broker URL with a password in it is the realistic accident here:
// mqtts://user:hunter2@broker.example — logged verbatim on a connection error,
// that is the password in a log aggregator forever.
const SECRET_KEYS = /^(.*_)?(token|password|secret|key|apikey|authorization)$/i;

function redactUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(\w+:\/\/[^/\s:@]+):[^/\s@]*@/g, '$1:***@');
}

function redact(value, depth = 0) {
  if (typeof value === 'string') return redactUrl(value);
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
  }
  return out;
}

function createLogger({ level = 'info', bridgeId = 'bridge', stream = process.stdout } = {}) {
  const floor = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, event, fields = {}) => {
    if (LEVELS[lvl] < floor) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      bridge: bridgeId,
      event,
      ...redact(fields),
    };
    // An error object serialises to `{}` through JSON.stringify, which is the
    // single most annoying way to lose the one field that mattered.
    if (fields.err instanceof Error) {
      line.err = fields.err.message;
      line.err_name = fields.err.name;
      if (fields.err.code) line.err_code = fields.err.code;
    }
    stream.write(`${JSON.stringify(line)}\n`);
  };

  return {
    level,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

module.exports = { createLogger, redact, LEVELS };
