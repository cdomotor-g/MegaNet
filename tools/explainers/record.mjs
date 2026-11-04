// tools/explainers/record.mjs — an MP4 of a 🎬 video, with its voices (#268).
//
// For a meeting room laptop that cannot reach the site, or a slide deck. Not a
// screen recording, which stutters: the page itself, in its meeting layout,
// drawn a frame at a time on the player's own clock (makeShowPlayer's
// render/frame, health-bulletin.js) — each scene's motion at that moment, its
// words revealed as the voice file says them — each frame a screenshot piped
// to ffmpeg with the video's own MP3. No ElevenLabs credits: the voices are the
// ones already made. Out come
//
//   data/explainers/video/<id>.mp4    H.264 + AAC, 1920×1080, under 25 MiB
//                                     (Cloudflare's limit for one file)
//   data/explainers/video/<id>.vtt    the words, with when each is said
//   data/explainers/video/<id>.json   what it was made from: the voice's hash
//
// and the index (data/explainers/index.json) offers ⤓ Download MP4 only while
// that hash is the voice's now — a video voiced again shows no stale download.
// Only a video marked final and voiced is recorded.
//
//   node tools/explainers/record.mjs welcome         record one (or several)
//   node tools/explainers/record.mjs --pending       every voiced video whose MP4 is missing or out of date
//   node tools/explainers/record.mjs --pending --list    just say which (ids=…, for a workflow's output)
//   --fps N   frames a second (30)      --size WxH   (1920x1080)
//
// The workflow `explainer-video.yml` runs it after each Bulletin voices run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { voicePathFor, validateVoice, listFiles, writeIndex } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const VIDEO_FORMAT = 'floodnet-explainer-video/1';
export const OUT = path.join(REPO, 'data', 'explainers', 'video');
const MAX_BYTES = 24.5 * 1024 * 1024;
const HOLD = 1.5;                 // seconds the last frame is held after the voices end

export const videoPathFor = id => ({ mp4: `data/explainers/video/${id}.mp4`, vtt: `data/explainers/video/${id}.vtt`, json: `data/explainers/video/${id}.json` });

// Which scene a moment of the video is in, and how far into it, by the voice
// file's own times: a scene runs from its start to the next one's.
export function sceneAt(v, T) {
  const sc = v.scenes;
  let i = sc.length - 1;
  while (i > 0 && T < sc[i].start) i--;
  return { i, ms: Math.max(0, (T - sc[i].start) * 1000) };
}

// The words as captions: a cue of up to a dozen words, broken at a sentence
// where one ends, each shown from its first word to the next cue.
export function vttFor(x, v) {
  const t = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s - h * 3600 - m * 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`; };
  const cues = [];
  x.scenes.forEach((s, i) => {
    const words = String(s.say || '').split(/\s+/).filter(Boolean), times = v.scenes[i].words;
    let start = 0;
    for (let k = 0; k < words.length; k++) {
      const end = k === words.length - 1 || k - start >= 11 || (k - start >= 5 && /[.!?;:]$/.test(words[k]));
      if (!end) continue;
      cues.push({ from: times[start], to: k + 1 < words.length ? times[k + 1] : v.scenes[i].end, text: words.slice(start, k + 1).join(' ') });
      start = k + 1;
    }
  });
  return 'WEBVTT\n\n' + cues.map((c, n) => `${n + 1}\n${t(c.from)} --> ${t(Math.max(c.to, c.from + 0.4))}\n${c.text}\n`).join('\n');
}

// Videos marked final, voiced, and with no MP4 of that voice.
export function pendingVideos({ repo = REPO, force = [] } = {}) {
  const todo = [];
  for (const file of listFiles(repo)) {
    const x = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
    if (x.voice !== 'final') continue;
    const vp = path.join(repo, voicePathFor(file).json);
    if (!fs.existsSync(vp)) continue;
    const v = JSON.parse(fs.readFileSync(vp, 'utf8'));
    if (validateVoice(v, x).errors.length || !fs.existsSync(path.join(repo, v.audio))) continue;
    const p = videoPathFor(x.id), mp = path.join(repo, p.json);
    const meta = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
    if (force.includes('all') || force.includes(x.id) || !meta || meta.voice_hash !== v.hash || !fs.existsSync(path.join(repo, p.mp4))) todo.push(x.id);
  }
  return todo;
}

function ffmpegArgs({ fps, audio, out, bitrate }) {
  return ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
    '-maxrate', bitrate, '-bufsize', `${parseInt(bitrate, 10) * 2}k`, '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
}

// One video, from a page that serves the app at `base`. `setup(page)` may
// route files (the tests do); `audio` is the MP3 (or any sound ffmpeg reads)
// to put under it, the video's own by default.
export async function record({ id, base, launch, width = 1920, height = 1080, fps = 30, outDir = OUT, repo = REPO, setup = null, audio = null, log = console.log, bitrate = '1300k' }) {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: 'Australia/Brisbane', locale: 'en-AU', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    if (setup) await setup(page);
    await page.goto(new URL(`index.html?watch=${encodeURIComponent(id)}`, base).href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof state !== 'undefined' && state.data && Array.isArray(state.data.stations), null, { timeout: 120_000 });
    await page.waitForFunction(w => typeof Explainers !== 'undefined' && Explainers._state().file === `data/explainers/${w}.json` && !!document.querySelector('#xp-stage svg') && !!Explainers._shots(), id, { timeout: 60_000 });
    const [x, v] = await page.evaluate(() => { const b = Explainers._api.current(); return [b, Explainers._api.voiceOf(b)]; });
    if (!v) throw new Error(`${id} is not voiced here — only a voiced video is recorded`);
    // Every screenshot the video shows, in the browser's cache before frame one.
    await page.evaluate(async () => {
      const b = Explainers._api.current(), shots = Explainers._shots() || {};
      const urls = [...new Set((b.scenes || []).filter(s => s.type === 'shot').map(s => shots[s.shot]).filter(Boolean).map(m => `${m.image}?t=${encodeURIComponent(m.taken || '')}`))];
      await Promise.all(urls.map(u => { const im = new Image(); im.src = u; return im.decode().catch(() => {}); }));
    });
    if (!await page.evaluate(() => Explainers._render(true))) throw new Error('the video\'s player is not on the page');
    await page.waitForTimeout(600);                    // the stage measured at its meeting size, drawn wide
    const total = Math.ceil((v.duration + HOLD) * fps);
    fs.mkdirSync(outDir, { recursive: true });
    const p = videoPathFor(id), out = path.join(outDir, `${id}.mp4`);
    const sound = audio || path.join(repo, v.audio);
    const ff = spawn('ffmpeg', ffmpegArgs({ fps, audio: sound, out, bitrate }), { stdio: ['pipe', 'inherit', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d; });
    const done = new Promise((ok, no) => ff.on('close', code => (code === 0 ? ok() : no(new Error(`ffmpeg: ${ffErr.slice(0, 400)}`)))));
    const frames = [];
    let lastScene = -1;
    for (let f = 0; f < total; f++) {
      const T = Math.min(f / fps, v.duration + HOLD);
      const { i, ms } = sceneAt(v, T);
      await page.evaluate(([i, ms]) => Explainers._api.frame(i, ms), [i, ms]);
      if (i !== lastScene) { await page.waitForTimeout(120); lastScene = i; }   // a new scene's drawing laid out
      const jpg = await page.screenshot({ type: 'jpeg', quality: 90 });
      if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
      frames.push(i);
      if (f % (fps * 15) === 0) log(`    ${id}: ${(T).toFixed(0)} s of ${v.duration.toFixed(0)}`);
    }
    ff.stdin.end();
    await done;
    const bytes = fs.statSync(out).size;
    if (bytes > MAX_BYTES) throw new Error(`${id}.mp4 is ${(bytes / 1048576).toFixed(1)} MB, over the 25 MiB a static file may be — record it at a lower --bitrate`);
    fs.writeFileSync(path.join(outDir, `${id}.vtt`), vttFor(x, v));
    const meta = { format: VIDEO_FORMAT, explainer: id, mp4: p.mp4, vtt: p.vtt, bytes, duration: +(total / fps).toFixed(2), width, height, fps,
      voice_hash: v.hash, sha256: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 32), recorded_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(meta, null, 1) + '\n');
    log(`  ${p.mp4}: ${meta.duration} s, ${width}×${height} at ${fps} fps, ${(bytes / 1048576).toFixed(1)} MB${errors.length ? ` — page errors: ${errors.slice(0, 2).join(' | ')}` : ''}`);
    return { meta, frames, errors };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ── command line ────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const force = (arg('--force') || '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = argv.includes('--pending') ? pendingVideos({ force }) : argv.filter((a, i) => !a.startsWith('--') && !['--fps', '--size', '--force', '--bitrate'].includes(argv[i - 1]));
  if (argv.includes('--list')) { console.log(`ids=${ids.join(' ')}`); process.exit(0); }
  if (!ids.length) { console.log(argv.includes('--pending') ? 'Every voiced video has its MP4.' : 'node tools/explainers/record.mjs (ID … | --pending) [--fps N] [--size WxH]'); process.exit(0); }
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg is needed, on the PATH.'); process.exit(2); }
  const [w, h] = (arg('--size') || '1920x1080').split('x').map(Number);
  const { launchBrowser } = await import('../../test/lib/browser.mjs');
  const { startServer } = await import('../../test/lib/server.mjs');
  // The tests' own network: the page from this checkout, nothing off-site —
  // so the counts and the map are the committed station list's, and the same
  // on any machine (test/lib/network.mjs says why).
  const { applyNetworkPolicy } = await import('../../test/lib/network.mjs');
  const server = await startServer();
  let failed = 0;
  try {
    for (const id of ids) {
      try { await record({ id, base: server.origin + '/', launch: launchBrowser, setup: page => applyNetworkPolicy(page, server.origin), width: w, height: h, fps: +(arg('--fps') || 30), bitrate: arg('--bitrate') || '1300k' }); }
      catch (err) { failed++; console.error(`  ${id}: not recorded — ${err.message}`); }
    }
  } finally { await server.close(); }
  const { changed } = writeIndex(REPO);
  if (changed) console.log('  data/explainers/index.json: the MP4s offered.');
  process.exit(failed ? 1 : 0);
}
