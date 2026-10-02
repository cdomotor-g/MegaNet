// MegaNet — sdr-pi/dsp-worker.js
//
//   The decoder's thread on the Pi: alert-dsp.js's Pipeline, unchanged — the
//   one the browser's RTL-SDR card runs in its Web Worker — fed the stick's
//   samples by relay.js and posting back the same messages.
//
// A thread of its own because one decode takes the better part of a second on a
// Pi Zero 2 W, and the USB transfers must keep being collected while it runs:
// a stick whose transfers are not collected overflows its FIFO and drops
// samples. relay.js measures how far behind this thread is with `ping` and
// stops sending it samples, rather than queueing them, if it cannot keep up.

'use strict';

const { parentPort, workerData } = require('worker_threads');
const AlertDsp = require(workerData.dsp);

const pipe = new AlertDsp.Pipeline((msg, transfer) => parentPort.postMessage(msg, transfer || []));

parentPort.on('message', m => {
  try {
    if (m.type === 'iq') pipe.feed(new Uint8Array(m.buf));
    else if (m.type === 'config') pipe.configure(m.cfg);
    else if (m.type === 'reset') pipe.reset();
    else if (m.type === 'decodeNow') pipe.decodeNow(m.seconds);
    // Answered after everything sent before it: how far behind this thread is.
    else if (m.type === 'ping') parentPort.postMessage({ type: 'pong', id: m.id, sent: m.sent });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
});

parentPort.postMessage({ type: 'ready' });
