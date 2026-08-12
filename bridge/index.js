#!/usr/bin/env node
// index.js — Start the bridge, and stop it properly when something asks it to.
//
// Everything else is in src/. This file exists to turn a process into a bridge:
// read the environment, wire the signals, and make sure a container being
// rescheduled does not drop the second's worth of readings it was holding.

const { loadConfig } = require('./src/config');
const { createBridge } = require('./src/bridge');

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // Before the logger exists, and deliberately human-readable rather than
    // JSON: this is the message somebody reads while the deploy is failing.
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  const bridge = createBridge(config);
  bridge.start();

  let shuttingDown = false;
  const shutdown = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    bridge.log.info('signal', { signal });

    // A hard deadline, because the alternative to exiting late is exiting never:
    // an unreachable database would otherwise hold the process open through
    // every retry while the platform waits to send SIGKILL. Anything still
    // unacked at that point is still the broker's, which is the whole point of
    // not acking early.
    const deadline = setTimeout(() => {
      bridge.log.error('shutdown_timeout', {});
      process.exit(1);
    }, 10_000);
    deadline.unref();

    try {
      await bridge.stop();
      process.exit(0);
    } catch (err) {
      bridge.log.error('shutdown_failed', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    bridge.log.error('unhandled_rejection', { err: err instanceof Error ? err : new Error(String(err)) });
  });
  process.on('uncaughtException', (err) => {
    bridge.log.error('uncaught_exception', { err });
    // Not survivable: the process is in an unknown state, and an unknown state
    // holding unacked messages is exactly what the broker's redelivery is for.
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { main };
