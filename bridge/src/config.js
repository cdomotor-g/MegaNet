// config.js — Every knob, read from the environment once, validated once.
//
// There is no config file. A config file on the host is a second place the
// broker password can live and a first thing somebody forgets to copy when the
// service moves; the environment is what every platform this might run on —
// systemd, Docker, Fly, a laptop — already has a way to set. `bridge/.env.example`
// documents them all and is the only file to copy.
//
// Missing or malformed settings are reported *all at once* and before anything
// connects. Failing on the first one means three restarts to find three typos,
// each of which is a minute of somebody's evening.

const fs = require('node:fs');
const os = require('node:os');

const DEFAULTS = {
  batchMs: 1000,
  batchMax: 1000,
  retryMaxMs: 60_000,
  heartbeatMs: 60_000,
  seenIntervalMs: 60_000,
  healthPort: 0,
  keepaliveSec: 60,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60_000,
  requestTimeoutMs: 15_000,
  logLevel: 'info',
};

function loadConfig(env = process.env) {
  const problems = [];

  const require_ = (key, hint) => {
    const value = (env[key] || '').trim();
    if (!value) problems.push(`${key} is not set — ${hint}`);
    return value;
  };

  const num = (key, fallback) => {
    if (env[key] == null || env[key] === '') return fallback;
    const n = Number(env[key]);
    if (!Number.isFinite(n) || n < 0) {
      problems.push(`${key} must be a non-negative number, got ${JSON.stringify(env[key])}`);
      return fallback;
    }
    return n;
  };

  const bool = (key, fallback = false) => {
    const raw = (env[key] || '').trim().toLowerCase();
    if (raw === '') return fallback;
    return raw === '1' || raw === 'true' || raw === 'yes';
  };

  const mqttUrl = require_('MQTT_URL', 'the broker to connect to, e.g. mqtts://host:8883');
  const allowInsecure = bool('MQTT_ALLOW_INSECURE');
  if (mqttUrl && !/^\w+:\/\//.test(mqttUrl)) {
    problems.push(`MQTT_URL is not a URL — expected something like mqtts://broker.example:8883`);
  } else if (mqttUrl && !/^(mqtts|wss):\/\//.test(mqttUrl) && !allowInsecure) {
    problems.push(
      `MQTT_URL is ${scheme(mqttUrl)}, which sends the broker credentials in clear text. ` +
        'Use mqtts:// or wss://, or set MQTT_ALLOW_INSECURE=1 if this is a local test broker.',
    );
  }

  const apiUrl = require_('MEGANET_API_URL', "the project's REST base, e.g. https://<ref>.supabase.co/rest/v1");
  const apiKey = require_('MEGANET_API_KEY', 'the publishable key — identifies the project, authorises nothing');
  const ingestToken = require_(
    'MEGANET_INGEST_TOKEN',
    'a token from meganet.create_ingest_token(); see docs/ingest-mqtt.md',
  );

  let ca;
  if (env.MQTT_CA_FILE) {
    try {
      ca = fs.readFileSync(env.MQTT_CA_FILE);
    } catch (err) {
      problems.push(`MQTT_CA_FILE ${env.MQTT_CA_FILE} could not be read: ${err.message}`);
    }
  }

  // The client id is the session's name, and the session is what holds unacked
  // messages while the bridge is away. It must therefore be *stable across
  // restarts* — a random one per boot means a new, empty session every time and
  // the old one's queued messages orphaned on the broker. Hence the hostname
  // rather than a uuid, and hence it being settable when the hostname is not
  // stable either (a container that gets a new one on every deploy).
  const clientId = (env.MQTT_CLIENT_ID || `meganet-bridge-${os.hostname()}`).trim();
  const bridgeId = (env.BRIDGE_ID || clientId).trim();

  const logLevel = (env.LOG_LEVEL || DEFAULTS.logLevel).trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug, info, warn or error — got ${JSON.stringify(logLevel)}`);
  }

  if (problems.length) {
    const err = new Error(
      `the bridge is not configured:\n  - ${problems.join('\n  - ')}\n` +
        'See bridge/.env.example and bridge/README.md.',
    );
    err.name = 'ConfigError';
    err.problems = problems;
    throw err;
  }

  return {
    mqtt: {
      url: mqttUrl,
      username: env.MQTT_USERNAME || undefined,
      password: env.MQTT_PASSWORD || undefined,
      clientId,
      ca,
      // Verifying the broker's certificate is the point of mqtts://. The escape
      // hatch exists for a self-signed Mosquitto on a bench, and is named so
      // that finding it in a production environment is finding a decision.
      rejectUnauthorized: !bool('MQTT_INSECURE_TLS'),
      keepaliveSec: num('MQTT_KEEPALIVE_SEC', DEFAULTS.keepaliveSec),
      reconnectBaseMs: num('MQTT_RECONNECT_BASE_MS', DEFAULTS.reconnectBaseMs),
      reconnectMaxMs: num('MQTT_RECONNECT_MAX_MS', DEFAULTS.reconnectMaxMs),
    },
    api: {
      url: apiUrl,
      key: apiKey,
      token: ingestToken,
      timeoutMs: num('MEGANET_TIMEOUT_MS', DEFAULTS.requestTimeoutMs),
    },
    bridge: {
      id: bridgeId,
      batchMs: num('BRIDGE_BATCH_MS', DEFAULTS.batchMs),
      batchMax: num('BRIDGE_BATCH_MAX', DEFAULTS.batchMax),
      // The ceiling on the wait between attempts at storing a batch, not a
      // limit on the attempts: there is no attempt count at which giving up on
      // a reading is the right answer. See batcher.js.
      retryMaxMs: Math.max(1000, num('BRIDGE_RETRY_MAX_MS', DEFAULTS.retryMaxMs)),
      heartbeatMs: num('BRIDGE_HEARTBEAT_MS', DEFAULTS.heartbeatMs),
      seenIntervalMs: num('BRIDGE_SEEN_INTERVAL_MS', DEFAULTS.seenIntervalMs),
      healthPort: num('BRIDGE_HEALTH_PORT', DEFAULTS.healthPort),
      logLevel,
    },
  };
}

function scheme(url) {
  const i = url.indexOf('://');
  return i === -1 ? 'not a URL' : `${url.slice(0, i)}://`;
}

module.exports = { loadConfig, DEFAULTS };
