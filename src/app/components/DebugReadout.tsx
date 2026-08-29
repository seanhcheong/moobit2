/**
 * Live debug readout: everything the brief asks to be visible while exercising.
 *
 * Detected exercise, phase, the continuous 0-100 depth, rep count, and end-to-end latency as
 * percentiles rather than only a rolling average — a good average with occasional spikes still
 * feels laggy, and only the tail shows that.
 *
 * The layout assumes it is being read from about six feet away, mid-rep, by someone who is out of
 * breath: the four numbers that matter are large, and the diagnostic detail is small and below.
 */

import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PoseSnapshot } from '../frame/usePosePipeline';
import { rollingPercentiles, type LatencyTracker } from '../../core/latency';
import { LATENCY_TARGET_MS } from '../../core/config';

const PHASE_COLORS: Record<string, string> = {
  standing: '#94a3b8',
  up: '#94a3b8',
  descending: '#fbbf24',
  bottom: '#f472b6',
  ascending: '#34d399',
};

export interface DebugReadoutProps {
  snapshot: PoseSnapshot;
  tracker: LatencyTracker;
  /** How many recent samples the live percentiles cover. */
  rollingWindow?: number;
  expanded: boolean;
}

const n = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export const DebugReadout = memo(function DebugReadout({
  snapshot,
  tracker,
  rollingWindow = 150,
  expanded,
}: DebugReadoutProps) {
  const { event, debug, latency } = snapshot;
  const samples = tracker.definition === 'STATE_AGE' ? tracker.stateAge : tracker.pipeline;
  const live = rollingPercentiles(samples, rollingWindow);
  const overTarget = Number.isFinite(live.p95) && live.p95 > LATENCY_TARGET_MS;
  const phaseColor = PHASE_COLORS[debug.phaseLabel] ?? '#94a3b8';

  return (
    <View style={styles.wrap}>
      <View style={styles.headline}>
        <View style={styles.cell}>
          <Text style={styles.label}>EXERCISE</Text>
          <Text style={[styles.big, event.exercise === 'unknown' && styles.dim]}>
            {event.exercise}
            {event.frontLeg ? ` ${event.frontLeg === 'left' ? 'L' : 'R'}` : ''}
          </Text>
          <Text style={styles.sub}>conf {event.confidence.toFixed(2)}</Text>
        </View>

        <View style={styles.cell}>
          <Text style={styles.label}>PHASE</Text>
          <Text style={[styles.big, { color: phaseColor }]}>{debug.phaseLabel}</Text>
          <Text style={styles.sub}>{event.phase}</Text>
        </View>

        <View style={styles.cell}>
          <Text style={styles.label}>DEPTH</Text>
          <Text style={styles.big}>{n(event.depth)}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, event.depth))}%` }]} />
          </View>
        </View>

        <View style={styles.cell}>
          <Text style={styles.label}>REPS</Text>
          <Text style={styles.big}>{event.repCount}</Text>
          <Text style={styles.sub}>
            {debug.partialReps > 0 ? `${debug.partialReps} partial` : 'no partials'}
          </Text>
        </View>
      </View>

      <View style={[styles.latencyRow, overTarget && styles.latencyWarn]}>
        <Text style={styles.latencyLabel}>{tracker.definition}</Text>
        <Text style={styles.latencyText}>
          now {n(latency.reportedMs)}  p50 {n(live.p50)}  p95 {n(live.p95)}  p99 {n(live.p99)} ms
        </Text>
        {overTarget && <Text style={styles.latencyFlag}>&gt; {LATENCY_TARGET_MS}ms target</Text>}
      </View>

      {expanded && (
        <View style={styles.detail}>
          <Text style={styles.detailText}>
            breakdown: inference {n(latency.inferenceMs, 1)} · staleness {n(latency.resultAgeMs, 1)} ·
            {' '}hop {n(latency.hopMs, 1)} · classify {n(latency.classifyMs, 2)} · decimate{' '}
            {n(latency.decimateMs, 1)} ms
          </Text>
          <Text style={styles.detailText}>
            {snapshot.processedFps.toFixed(1)} fps processed · {snapshot.framesDropped} native drops ·
            {' '}{snapshot.nativeDelegate} delegate · mode {snapshot.mode}
          </Text>
          <Text style={styles.detailText}>
            confidences:{' '}
            {debug.exerciseIds
              .map((id, i) => `${id} ${(debug.confidences[i] ?? 0).toFixed(2)}`)
              .join('  ')}
          </Text>
          <Text style={styles.detailText}>
            primary {Number.isFinite(debug.primarySignal) ? debug.primarySignal.toFixed(3) : '–'} ·
            {' '}corroboration {debug.corroboration.toFixed(2)} · flickers {debug.flickers} ·
            {' '}abandoned {debug.abandonedReps} · losses {debug.trackingLosses} ·
            {' '}unknown {debug.unknownFrames}
          </Text>
          <Text style={styles.detailReason}>{debug.reason}</Text>
          {debug.frontLegVotes.length > 0 && (
            <Text style={styles.detailSignals}>{debug.frontLegVotes}</Text>
          )}
          {snapshot.warning && <Text style={styles.warning}>{snapshot.warning}</Text>}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { backgroundColor: 'rgba(0,0,0,0.82)', paddingTop: 8, paddingHorizontal: 10, paddingBottom: 6 },
  headline: { flexDirection: 'row', justifyContent: 'space-between' },
  cell: { flex: 1, alignItems: 'flex-start' },
  label: { color: '#64748b', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  big: { color: '#f8fafc', fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dim: { color: '#64748b' },
  sub: { color: '#94a3b8', fontSize: 10, fontVariant: ['tabular-nums'] },
  barTrack: {
    width: '92%',
    height: 5,
    borderRadius: 3,
    backgroundColor: '#1e293b',
    marginTop: 3,
    overflow: 'hidden',
  },
  barFill: { height: 5, backgroundColor: '#38bdf8' },
  latencyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingTop: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#334155',
  },
  latencyWarn: { borderTopColor: '#f87171' },
  latencyLabel: { color: '#475569', fontSize: 9, fontWeight: '700', marginRight: 8 },
  latencyText: { color: '#cbd5e1', fontSize: 11, fontVariant: ['tabular-nums'] },
  latencyFlag: { color: '#f87171', fontSize: 10, fontWeight: '700', marginLeft: 8 },
  detail: { marginTop: 5, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1e293b' },
  detailText: { color: '#94a3b8', fontSize: 9.5, lineHeight: 14, fontVariant: ['tabular-nums'] },
  detailReason: { color: '#7dd3fc', fontSize: 9.5, lineHeight: 14, marginTop: 2 },
  detailSignals: { color: '#a78bfa', fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  warning: { color: '#fbbf24', fontSize: 10, marginTop: 3 },
});
