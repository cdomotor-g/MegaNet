// Where things are, resolved once so no other file has to count `../`s.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TEST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(TEST_DIR);
export const BASELINE_DIR = path.join(TEST_DIR, 'baseline');

export const INDEX_HTML = path.join(REPO_ROOT, 'index.html');

export const repo = (...p) => path.join(REPO_ROOT, ...p);
export const baseline = (...p) => path.join(BASELINE_DIR, ...p);
