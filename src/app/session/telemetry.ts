/**
 * Dev-only telemetry client: POST a session to the local dev server, with an on-device fallback.
 *
 * Every entry point is guarded by {@link TELEMETRY_ENABLED}, which is `__DEV__`. Metro replaces
 * that with a literal, so in a release build these functions become no-ops and the minifier drops
 * the fetch calls entirely. There is no runtime switch, on purpose.
 *
 * The endpoint is always a plain-HTTP LAN address the tester types in. Nothing is ever sent to a
 * remote or cloud endpoint, and {@link isLocalHost} enforces that rather than trusting it.
 */

import { Platform } from 'react-native';
// Named exports only — this package has no default export.
import * as RNFS from '@dr.pogodin/react-native-fs';
import { DEV_SERVER_DEFAULTS, TELEMETRY_ENABLED } from '../config/devFlags';
import type { SessionSummary } from '../../core/session';
import { SESSION_CSV_HEADER, sessionSummaryToCsvRow } from '../../core/session';

export interface DevServerSettings {
  host: string;
  port: number;
}

export const DEFAULT_DEV_SERVER: DevServerSettings = {
  host: DEV_SERVER_DEFAULTS.host,
  port: DEV_SERVER_DEFAULTS.port,
};

/** Where on-device copies live. Always written, so a failed upload never loses data. */
export function sessionsDir(): string {
  return `${RNFS.DocumentDirectoryPath}/sessions`;
}

/**
 * Reject anything that is not a private-network or loopback address.
 *
 * A typo in the settings field should fail, not quietly ship a session's landmark data to whatever
 * host happens to answer. The check is on the shape of the address rather than on intent, so it
 * holds regardless of what gets typed.
 */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '10.0.2.2') return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function baseUrl(s: DevServerSettings): string {
  return `http://${s.host.trim()}:${s.port}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/** Connectivity probe, so the settings screen can confirm the address before a session. */
export async function checkDevServer(s: DevServerSettings): Promise<HealthResult> {
  if (!TELEMETRY_ENABLED) return { ok: false, detail: 'telemetry is not compiled into this build' };
  if (!isLocalHost(s.host)) {
    return { ok: false, detail: `${s.host} is not a local/private address; refusing to contact it` };
  }
  try {
    const res = await withTimeout(
      fetch(`${baseUrl(s)}/health`, { method: 'GET' }),
      DEV_SERVER_DEFAULTS.timeoutMs,
      'health',
    );
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { sessionsDir?: string; sessionCount?: number };
    return {
      ok: true,
      detail: `reachable — ${body.sessionCount ?? 0} sessions in ${body.sessionsDir ?? '?'}`,
    };
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) };
  }
}

export interface DeliveryResult {
  /** Whether the dev server accepted the summary. */
  posted: boolean;
  /** Whether an on-device copy was written. Always attempted. */
  savedLocally: boolean;
  localPath: string | null;
  error: string | null;
}

/**
 * Write the summary to device storage and, in a dev build, also POST it.
 *
 * The local write happens FIRST and unconditionally. A session that reached the dev server but was
 * never saved locally is fine; a session lost because the server was unreachable is not, and the
 * brief is explicit that a failed POST must not lose data.
 */
export async function deliverSessionSummary(
  summary: SessionSummary,
  settings: DevServerSettings,
): Promise<DeliveryResult> {
  const result: DeliveryResult = {
    posted: false,
    savedLocally: false,
    localPath: null,
    error: null,
  };

  const json = JSON.stringify(summary, null, 2);

  try {
    const dir = sessionsDir();
    await RNFS.mkdir(dir);
    const name = `${summary.startedAtIso.replace(/[:.]/g, '-')}__${summary.exercise}__${summary.sessionId}.json`;
    const path = `${dir}/${name}`;
    await RNFS.writeFile(path, json, 'utf8');
    result.savedLocally = true;
    result.localPath = path;

    // A rolling CSV alongside the JSON, so sessions can be eyeballed on-device without a laptop.
    const csvPath = `${dir}/sessions.csv`;
    const exists = await RNFS.exists(csvPath);
    const row = `${sessionSummaryToCsvRow(summary)}\n`;
    if (exists) await RNFS.appendFile(csvPath, row, 'utf8');
    else await RNFS.writeFile(csvPath, `${SESSION_CSV_HEADER}\n${row}`, 'utf8');
  } catch (err) {
    result.error = `local save failed: ${String(err instanceof Error ? err.message : err)}`;
  }

  if (!TELEMETRY_ENABLED) return result;
  if (!isLocalHost(settings.host)) {
    result.error = [result.error, `refused to POST to non-local host ${settings.host}`]
      .filter(Boolean)
      .join('; ');
    return result;
  }

  try {
    const res = await withTimeout(
      fetch(`${baseUrl(settings)}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json,
      }),
      DEV_SERVER_DEFAULTS.timeoutMs,
      'POST /sessions',
    );
    result.posted = res.ok;
    if (!res.ok) {
      result.error = [result.error, `POST returned HTTP ${res.status}`].filter(Boolean).join('; ');
    }
  } catch (err) {
    result.error = [result.error, `POST failed: ${String(err instanceof Error ? err.message : err)}`]
      .filter(Boolean)
      .join('; ');
  }

  return result;
}

/**
 * Upload one chunk of the raw replay log.
 *
 * Sent separately from the summary and in chunks, because a ten-minute session's landmark log is
 * on the order of 10 MB — too big to inline in the summary, and too big to hold in memory.
 *
 * @param seq 0 truncates the server-side file, so a re-run of the same session id does not
 *   concatenate onto the previous attempt.
 */
export async function postRawLogChunk(
  settings: DevServerSettings,
  sessionId: string,
  chunk: string,
  seq: number,
  final: boolean,
): Promise<boolean> {
  if (!TELEMETRY_ENABLED) return false;
  if (!isLocalHost(settings.host)) return false;
  try {
    const url = `${baseUrl(settings)}/sessions/${encodeURIComponent(sessionId)}/raw?seq=${seq}${
      final ? '&final=1' : ''
    }`;
    const res = await withTimeout(
      fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: chunk }),
      DEV_SERVER_DEFAULTS.timeoutMs,
      'POST raw chunk',
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Platform hint shown in the settings screen, since the two platforms differ here. */
export function connectionHint(): string {
  if (Platform.OS === 'android') {
    return (
      'Android: either put the phone on the same WiFi and use the dev machine\'s LAN IP ' +
      '(the dev server prints it on startup), or connect over USB and run ' +
      '`npm run adb:reverse`, then set the host to 127.0.0.1.'
    );
  }
  return (
    'iOS: there is no USB reverse-tunnel equivalent, so the phone must be on the same WiFi as ' +
    'the dev machine. Use the LAN IP the dev server prints on startup.'
  );
}
