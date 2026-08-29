/**
 * Session recorder: accumulates statistics, buffers the raw replay log, and delivers both.
 *
 * Runs on the JS thread. Recording is deliberately kept off the recognition path — the pipeline
 * produces an event, and the recorder consumes a copy of it afterwards, so file I/O and uploads
 * can never inflate the measured latency.
 *
 * ## Chunked flushing
 * The raw log is flushed every `rawChunkFrames` frames rather than accumulated and written once.
 * A ten-minute session at 30 fps is ~18,000 records and roughly 10 MB of text; holding that in
 * memory is both a spike and a guarantee that a crash costs the whole session.
 */

// Named exports only — this package has no default export.
import * as RNFS from '@dr.pogodin/react-native-fs';
import { DEV_SERVER_DEFAULTS, REPLAY_LOGGING_ENABLED } from '../config/devFlags';
import {
  encodeFrameRecord,
  encodeRecord,
  REPLAY_FORMAT_VERSION,
  type ReplayHeader,
} from '../../core/replayFormat';
import {
  accumulateSessionStats,
  buildSessionSummary,
  createSessionStats,
  type DeviceInfo,
  type ExerciseSummary,
  type GroundTruth,
  type SessionStats,
  type SessionSummary,
} from '../../core/session';
import type { Baseline } from '../../core/calibration';
import type { RecognitionEvent } from '../../core/types';
import type { LatencyTracker } from '../../core/latency';
import {
  deliverSessionSummary,
  postRawLogChunk,
  sessionsDir,
  type DeliveryResult,
  type DevServerSettings,
} from './telemetry';

export interface RecorderOptions {
  sessionId: string;
  startedAtIso: string;
  startedAtMs: number;
  device: DeviceInfo;
  config: Record<string, unknown>;
  header: Omit<ReplayHeader, 'kind' | 'version' | 'sessionId' | 'startedAtIso' | 'device' | 'config'>;
  /** Record the raw landmark log. Ignored entirely in a release build. */
  recordRawLog: boolean;
  devServer: DevServerSettings;
}

export interface SessionRecorder {
  readonly sessionId: string;
  readonly stats: SessionStats;
  /** True when a raw log is being written for this session. */
  readonly recordingRaw: boolean;
  /** Path of the on-device raw log, once one exists. */
  rawLogPath: string | null;

  /** Feed one frame. `landmarks` may be omitted to record statistics without the raw log. */
  onFrame(
    event: RecognitionEvent,
    landmarks: readonly number[] | null,
    native: {
      nowMs: number;
      resultAtMs: number;
      inferenceMs: number;
      decimateMs: number;
      framesDropped: number;
    },
    repPeakDepth: number,
  ): void;

  noteBaseline(baseline: Baseline): void;
  addMarker(label: string, timestampMs: number): void;

  /** Flush and deliver. Returns the summary plus what happened to it. */
  finish(input: {
    latencyTracker: LatencyTracker;
    perExercise: ExerciseSummary[];
    groundTruth: GroundTruth;
    baseline: Baseline | null;
    labelSwitches: number;
    notes?: string;
  }): Promise<{ summary: SessionSummary; delivery: DeliveryResult; rawUploaded: boolean }>;

  /** Abandon without delivering. Leaves any partial raw log on disk. */
  cancel(): void;
}

export function createSessionRecorder(opts: RecorderOptions): SessionRecorder {
  const stats = createSessionStats(opts.startedAtMs);
  const recordingRaw = REPLAY_LOGGING_ENABLED && opts.recordRawLog;

  let pending: string[] = [];
  let chunkSeq = 0;
  let rawLogPath: string | null = null;
  let rawInitPromise: Promise<void> | null = null;
  let rawUploadOk = true;
  let lastLabel: string | null = null;
  let cancelled = false;

  /** Serialises writes, so overlapping flushes cannot interleave inside the file. */
  let writeChain: Promise<void> = Promise.resolve();

  function header(): ReplayHeader {
    return {
      kind: 'header',
      version: REPLAY_FORMAT_VERSION,
      sessionId: opts.sessionId,
      startedAtIso: opts.startedAtIso,
      device: opts.device,
      config: opts.config,
      ...opts.header,
    };
  }

  function ensureRawFile(): Promise<void> {
    if (rawInitPromise) return rawInitPromise;
    rawInitPromise = (async () => {
      const dir = `${sessionsDir()}/raw`;
      await RNFS.mkdir(dir);
      rawLogPath = `${dir}/${opts.sessionId}.jsonl`;
      await RNFS.writeFile(rawLogPath, `${encodeRecord(header())}\n`, 'utf8');
    })().catch((err) => {
      // Losing the replay log must not take the session's statistics down with it.
      console.warn('[recorder] could not open raw log:', err);
      rawLogPath = null;
    });
    return rawInitPromise;
  }

  function flush(final: boolean): Promise<void> {
    if (!recordingRaw || pending.length === 0) return writeChain;
    const chunk = `${pending.join('\n')}\n`;
    pending = [];
    const seq = chunkSeq++;

    writeChain = writeChain
      .then(async () => {
        await ensureRawFile();
        if (rawLogPath) {
          await RNFS.appendFile(rawLogPath, chunk, 'utf8');
        }
        // The upload is best-effort: the on-device copy above is the durable one.
        const ok = await postRawLogChunk(opts.devServer, opts.sessionId, chunk, seq, final);
        if (!ok) rawUploadOk = false;
      })
      .catch((err) => {
        console.warn('[recorder] raw flush failed:', err);
        rawUploadOk = false;
      });

    return writeChain;
  }

  const recorder: SessionRecorder = {
    sessionId: opts.sessionId,
    stats,
    recordingRaw,
    get rawLogPath() {
      return rawLogPath;
    },

    onFrame(event, landmarks, native, repPeakDepth) {
      if (cancelled) return;

      if (lastLabel !== null && lastLabel !== event.exercise) stats.labelSwitches++;
      lastLabel = event.exercise;

      accumulateSessionStats(
        stats,
        event.exercise,
        event.confidence,
        event.depth,
        event.timestamp,
        false,
        repPeakDepth,
        event.frontLeg,
      );

      if (recordingRaw && landmarks) {
        pending.push(encodeFrameRecord(event.timestamp, landmarks, native, event));
        if (pending.length >= DEV_SERVER_DEFAULTS.rawChunkFrames) void flush(false);
      }
    },

    noteBaseline(baseline) {
      if (cancelled || !recordingRaw) return;
      pending.push(encodeRecord({ kind: 'baseline', baseline }));
    },

    addMarker(label, timestampMs) {
      if (cancelled || !recordingRaw) return;
      pending.push(encodeRecord({ kind: 'marker', t: Math.round(timestampMs), label }));
    },

    async finish(input) {
      if (cancelled) throw new Error('recorder was cancelled');

      // Fold rep-level data in that per-frame accumulation cannot see.
      stats.labelSwitches = Math.max(stats.labelSwitches, input.labelSwitches);

      await flush(true);
      await writeChain;

      const summary = buildSessionSummary({
        sessionId: opts.sessionId,
        startedAtIso: opts.startedAtIso,
        stats,
        latencyTracker: input.latencyTracker,
        perExercise: input.perExercise,
        groundTruth: input.groundTruth,
        device: opts.device,
        baseline: input.baseline,
        config: opts.config,
        rawLogFile: rawLogPath,
        notes: input.notes,
      });

      const delivery = await deliverSessionSummary(summary, opts.devServer);
      return { summary, delivery, rawUploaded: recordingRaw && rawUploadOk };
    },

    cancel() {
      cancelled = true;
      pending = [];
    },
  };

  return recorder;
}

/**
 * Record a completed rep.
 *
 * Separate from `onFrame` because a rep is a rep-level fact and the per-frame accumulator would
 * otherwise need to infer it from a count changing, which is exactly the kind of derived state
 * that goes wrong when a label switches on the same frame a rep completes.
 */
export function recordRepCompleted(
  stats: SessionStats,
  label: string,
  peakDepth: number,
  frontLeg: 'left' | 'right' | null,
): void {
  stats.repPeakDepths.push(peakDepth);
  if (label === 'lunge' && frontLeg) stats.frontLegs.push(frontLeg);
}
