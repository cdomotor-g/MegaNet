// A static file server over the repo root, on a loopback port the OS picks.
//
// The smoke test could load index.html over `file://` — the app supports that
// mode on purpose — but it deliberately does not. Over `file://` the bundled
// `stations.json` is unreachable (autoLoad() says so at app.js:1671), so
// `state.data` stays null and eleven of the sixteen tabs render the empty state
// instead of themselves. A smoke test that never draws a station table is not
// testing much. So: http on loopback, real data, real render paths.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

export async function startServer(root = REPO_ROOT) {
  const server = http.createServer(async (req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

    // Nothing outside the repo, whatever the URL claims.
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      // Streamed, and as raw bytes: app.js carries 4 literal NUL bytes (#129)
      // and must reach the browser unmodified.
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: (p = '/index.html') => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
