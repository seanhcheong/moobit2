#!/usr/bin/env node
/**
 * Dev-only telemetry sink for the recognition test harness.
 *
 * Runs alongside Metro (`npm run dev` starts both). The phone POSTs each finished test
 * session here so ground-truth accuracy, latency percentiles and raw replay logs land
 * straight in ./sessions/ instead of having to be pulled off the device by hand.
 *
 * This is a DEVELOPMENT CONVENIENCE ONLY. It binds to the LAN so a physical phone can
 * reach it, has no authentication, and must never be deployed anywhere. The app side is
 * compiled out of release builds (see src/app/config/devFlags.ts).
 *
 *   POST /sessions              JSON session summary  -> sessions/<ts>__<ex>__<id>.json
 *   POST /sessions/:id/raw      JSONL chunk (appended) -> sessions/raw/<id>.jsonl
 *   GET  /health                connectivity probe used by the in-app settings screen
 *   GET  /sessions              list what has landed so far
 *
 * Env: PORT (default 8787), SESSIONS_DIR (default ./sessions)
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, '..', '..');
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || path.join(ROOT, 'sessions'));
const RAW_DIR = path.join(SESSIONS_DIR, 'raw');

fs.mkdirSync(RAW_DIR, { recursive: true });

const app = express();

// Replay logs are big (30fps x 33 landmarks). The app chunks them, but keep the ceiling high.
app.use('/sessions/:id/raw', express.text({ type: '*/*', limit: '64mb' }));
app.use(express.json({ limit: '16mb' }));

/** Filenames come from the device; never let one escape SESSIONS_DIR. */
function safeId(raw) {
  const id = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '');
  return id.length > 0 && id.length <= 120 && !id.startsWith('.') ? id : null;
}

function stamp(iso) {
  // 2026-08-29T19:42:03.123Z -> 2026-08-29T19-42-03 (filename-safe, still sorts correctly)
  return String(iso).replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function log(...args) {
  process.stdout.write(`[telemetry] ${args.join(' ')}\n`);
}

app.get('/health', (_req, res) => {
  let count = 0;
  try {
    count = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    /* directory may not exist yet */
  }
  res.json({
    ok: true,
    service: 'moobit-recognition-telemetry',
    sessionsDir: SESSIONS_DIR,
    sessionCount: count,
    host: os.hostname(),
  });
});

app.post('/sessions', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'expected a JSON object body' });
  }

  const id = safeId(body.sessionId) || `s${Date.now().toString(36)}`;
  const iso = typeof body.startedAtIso === 'string' ? body.startedAtIso : new Date().toISOString();
  const exercise = safeId(body.exercise) || 'unknown';
  const name = `${stamp(iso)}__${exercise}__${id}.json`;
  const dest = path.join(SESSIONS_DIR, name);

  try {
    fs.writeFileSync(dest, JSON.stringify(body, null, 2));
  } catch (err) {
    log('FAILED to write', dest, String(err));
    return res.status(500).json({ ok: false, error: String(err) });
  }

  const detected = body?.reps?.detected;
  const actual = body?.reps?.actual;
  const p95 = body?.latency?.endToEnd?.p95;
  log(
    `session ${id} (${exercise})  reps ${detected ?? '?'}/${actual ?? '?'}` +
      `  e2e p95 ${p95 != null ? `${p95}ms` : '?'}  -> ${name}`,
  );

  res.json({ ok: true, id, file: dest });
});

app.post('/sessions/:id/raw', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'bad session id' });

  const chunk = typeof req.body === 'string' ? req.body : '';
  if (!chunk) return res.status(400).json({ ok: false, error: 'empty chunk' });

  const dest = path.join(RAW_DIR, `${id}.jsonl`);
  const seq = req.query.seq != null ? Number(req.query.seq) : null;

  try {
    // seq 0 truncates so a re-run of the same session id does not concatenate onto the last.
    if (seq === 0) fs.writeFileSync(dest, chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    else fs.appendFileSync(dest, chunk.endsWith('\n') ? chunk : `${chunk}\n`);
  } catch (err) {
    log('FAILED to append raw', dest, String(err));
    return res.status(500).json({ ok: false, error: String(err) });
  }

  const bytes = fs.statSync(dest).size;
  if (req.query.final === '1') {
    log(`raw log ${id}.jsonl closed — ${(bytes / 1e6).toFixed(2)} MB`);
  }
  res.json({ ok: true, id, bytes });
});

app.get('/sessions', (_req, res) => {
  let files = [];
  try {
    files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        const st = fs.statSync(path.join(SESSIONS_DIR, f));
        return { file: f, bytes: st.size, mtime: st.mtime.toISOString() };
      });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
  res.json({ ok: true, count: files.length, sessions: files });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`${ni.address}  (${name})`);
    }
  }
  return out;
}

app.listen(PORT, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${PORT}`);
  log(`writing sessions to ${SESSIONS_DIR}`);
  const addrs = lanAddresses();
  if (addrs.length) {
    log('set the app\'s "Dev server host" to one of these LAN addresses:');
    for (const a of addrs) log(`    ${a}`);
  } else {
    log('no LAN interface found — use `npm run adb:reverse` and point the app at 127.0.0.1');
  }
  log(`or over USB (Android): adb reverse tcp:${PORT} tcp:${PORT}  then host = 127.0.0.1`);
});
