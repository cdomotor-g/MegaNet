// health.js — Whether this process is alive, and whether it is doing anything.
//
// The failure to design against is not a bridge that crashes. A crash is loud:
// the supervisor restarts it, the log says so, somebody notices. The failure is
// a bridge that has been quietly connected to nothing for a week while the app
// shows a network where nothing has happened — because "no readings since
// Tuesday" and "the relay died on Tuesday" look identical from the front end and
// need completely different people out of bed.
//
// So the counters below are reported two ways: pushed to meganet.bridge_health
// on a timer (which is what the app can see, and what makes a *stopped* bridge
// visible — a row that stops being updated), and served on a local HTTP endpoint
// (which is what a platform health check polls, and what restarts it).
//
// Counters are absolute totals since start-up, never increments. A heartbeat
// that fails to send then costs nothing at all, where a lost increment would
// under-count silently and forever.

const http = require('node:http');

function createHealth({ bridgeId, version, log, now = () => new Date() }) {
  const startedAt = now();
  const state = {
    connected: false,
    connectedSince: null,
    lastMessageAt: null,
    lastInsertAt: null,
    messagesTotal: 0,
    readingsAccepted: 0,
    readingsDup: 0,
    readingsRejected: 0,
    errorsTotal: 0,
    pending: 0,
    lastError: null,
  };

  const api = {
    get state() {
      return state;
    },

    connectionUp() {
      state.connected = true;
      state.connectedSince = now();
    },
    connectionDown() {
      state.connected = false;
    },
    messageReceived() {
      state.messagesTotal += 1;
      state.lastMessageAt = now();
    },
    inserted({ accepted = 0, duplicates = 0, rejected = 0 } = {}) {
      state.readingsAccepted += accepted;
      state.readingsDup += duplicates;
      state.readingsRejected += rejected;
      state.lastInsertAt = now();
    },
    rejected(n = 1) {
      state.readingsRejected += n;
    },
    errored(reason) {
      state.errorsTotal += 1;
      // Truncated, and a reason rather than a stack: this string is pushed to a
      // world-readable table (0008, decision 4), so it says what went wrong and
      // never where or with what credentials.
      state.lastError = typeof reason === 'string' ? reason.slice(0, 200) : String(reason).slice(0, 200);
    },
    setPending(n) {
      state.pending = n;
    },

    /** What gets pushed to meganet.bridge_health, and served on /healthz. */
    snapshot() {
      return {
        bridge_id: bridgeId,
        started_at: startedAt.toISOString(),
        connected: state.connected,
        connected_since: state.connectedSince ? state.connectedSince.toISOString() : null,
        last_message_at: state.lastMessageAt ? state.lastMessageAt.toISOString() : null,
        last_insert_at: state.lastInsertAt ? state.lastInsertAt.toISOString() : null,
        messages_total: state.messagesTotal,
        readings_accepted: state.readingsAccepted,
        readings_dup: state.readingsDup,
        readings_rejected: state.readingsRejected,
        errors_total: state.errorsTotal,
        pending: state.pending,
        detail: {
          version,
          ...(state.lastError ? { last_error: state.lastError } : {}),
        },
      };
    },

    /**
     * Is the process healthy *right now*, for a platform health check.
     *
     * Connected to the broker, and not sitting on a backlog it cannot deliver.
     * Deliberately not "has received a message recently": a quiet night on a
     * small network is not a fault, and a health check that restarts the process
     * every time the field goes quiet is a health check that causes outages.
     */
    healthy() {
      return state.connected && state.pending < 5000;
    },
  };

  /** Start the local health endpoint. Returns a close function. */
  api.serve = (port) => {
    if (!port) return () => {};
    const server = http.createServer((req, res) => {
      const ok = api.healthy();
      const body = JSON.stringify({ ok, ...api.snapshot() });
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
    });
    server.listen(port, () => log.info('health_listening', { port }));
    server.on('error', (err) => log.error('health_listen_failed', { err, port }));
    return () => new Promise((resolve) => server.close(resolve));
  };

  return api;
}

module.exports = { createHealth };
