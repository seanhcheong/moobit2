/**
 * Session lifecycle and ground-truth capture.
 *
 * The brief's key requirement: declare what you are about to do, do it, then enter what you
 * actually completed. Without that second number a session yields only an impression; with it,
 * every session yields a real detected-vs-actual accuracy figure that can be tracked across
 * threshold changes and across devices.
 *
 * The actual-reps prompt is deliberately unskippable-by-accident: it is the whole point of the
 * session, and it has to be answered while the set is still fresh in mind.
 */

import React, { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ExerciseId } from '../../core/types';

export type SessionPhase = 'idle' | 'calibrating' | 'recording' | 'awaiting-truth' | 'done';

const EXERCISES: { id: ExerciseId; label: string }[] = [
  { id: 'squat', label: 'Squat' },
  { id: 'pushup', label: 'Push-up' },
  { id: 'lunge', label: 'Lunge' },
];

const PLANNED_OPTIONS = [5, 10, 15, 20];

export interface SessionControlsProps {
  phase: SessionPhase;
  declaredExercise: ExerciseId | null;
  plannedReps: number | null;
  detectedReps: number;
  calibrationProgress: number;
  calibrationReject: string | null;
  framingOk: boolean;
  busy: boolean;
  summaryText: string | null;
  deliveryText: string | null;

  onSelectExercise: (id: ExerciseId) => void;
  onSelectPlanned: (reps: number) => void;
  onCalibrate: () => void;
  onStart: () => void;
  onEnd: () => void;
  onSubmitActual: (actual: number) => void;
  onNewSession: () => void;
  onMarker: () => void;
}

export const SessionControls = memo(function SessionControls(props: SessionControlsProps) {
  const [actualText, setActualText] = useState('');

  if (props.phase === 'awaiting-truth') {
    const parsed = Number.parseInt(actualText, 10);
    const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 999;
    return (
      <View style={styles.wrap}>
        <Text style={styles.prompt}>
          How many {props.declaredExercise ?? 'reps'} did you ACTUALLY complete?
        </Text>
        <Text style={styles.promptSub}>
          The app detected {props.detectedReps}. Enter your own count — the difference is the
          accuracy number for this session.
        </Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={actualText}
            onChangeText={setActualText}
            keyboardType="number-pad"
            placeholder={String(props.detectedReps)}
            placeholderTextColor="#475569"
            autoFocus
            maxLength={3}
          />
          {/* Quick buttons around the detected count, since the answer is usually within one. */}
          {[-1, 0, 1].map((delta) => {
            const value = Math.max(0, props.detectedReps + delta);
            return (
              <Pressable
                key={delta}
                style={styles.quick}
                onPress={() => setActualText(String(value))}
              >
                <Text style={styles.quickText}>{value}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          style={[styles.primary, (!valid || props.busy) && styles.disabled]}
          disabled={!valid || props.busy}
          onPress={() => props.onSubmitActual(parsed)}
        >
          <Text style={styles.primaryText}>{props.busy ? 'Saving…' : 'Save session'}</Text>
        </Pressable>
      </View>
    );
  }

  if (props.phase === 'done') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.summaryTitle}>Session complete</Text>
        {props.summaryText && <Text style={styles.summary}>{props.summaryText}</Text>}
        {props.deliveryText && <Text style={styles.delivery}>{props.deliveryText}</Text>}
        <Pressable style={styles.primary} onPress={props.onNewSession}>
          <Text style={styles.primaryText}>New session</Text>
        </Pressable>
      </View>
    );
  }

  if (props.phase === 'recording') {
    return (
      <View style={styles.wrap}>
        <View style={styles.row}>
          <Pressable style={styles.secondary} onPress={props.onMarker}>
            <Text style={styles.secondaryText}>Mark this rep</Text>
          </Pressable>
          <Pressable style={[styles.primary, styles.flex]} onPress={props.onEnd}>
            <Text style={styles.primaryText}>End set ({props.detectedReps} detected)</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Recording {props.declaredExercise ?? '?'}
          {props.plannedReps ? ` · planned ${props.plannedReps}` : ''}
        </Text>
      </View>
    );
  }

  if (props.phase === 'calibrating') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.prompt}>Stand still…</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(props.calibrationProgress * 100)}%` }]} />
        </View>
        <Text style={styles.hint}>
          {props.calibrationReject
            ? `waiting: ${props.calibrationReject}`
            : `capturing your neutral standing pose (${Math.round(props.calibrationProgress * 100)}%)`}
        </Text>
      </View>
    );
  }

  // idle
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>EXERCISE</Text>
      <View style={styles.row}>
        {EXERCISES.map((e) => (
          <Pressable
            key={e.id}
            style={[styles.chip, props.declaredExercise === e.id && styles.chipOn, styles.flex]}
            onPress={() => props.onSelectExercise(e.id)}
          >
            <Text style={[styles.chipText, props.declaredExercise === e.id && styles.chipTextOn]}>
              {e.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>PLANNED REPS</Text>
      <View style={styles.row}>
        {PLANNED_OPTIONS.map((r) => (
          <Pressable
            key={r}
            style={[styles.chip, props.plannedReps === r && styles.chipOn, styles.flex]}
            onPress={() => props.onSelectPlanned(r)}
          >
            <Text style={[styles.chipText, props.plannedReps === r && styles.chipTextOn]}>{r}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <Pressable style={[styles.secondary, styles.flex]} onPress={props.onCalibrate}>
          <Text style={styles.secondaryText}>Recalibrate</Text>
        </Pressable>
        <Pressable
          style={[styles.primary, styles.flex, (!props.declaredExercise || !props.framingOk) && styles.disabled]}
          disabled={!props.declaredExercise || !props.framingOk}
          onPress={props.onStart}
        >
          <Text style={styles.primaryText}>Start set</Text>
        </Pressable>
      </View>
      {!props.framingOk && (
        <Text style={styles.hint}>Get in frame before starting — see the guide above.</Text>
      )}
      {props.framingOk && !props.declaredExercise && (
        <Text style={styles.hint}>Pick an exercise so the session has a ground truth to compare against.</Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { backgroundColor: '#0b1220', paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  flex: { flex: 1 },
  label: { color: '#475569', fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 9,
    backgroundColor: '#1e293b',
    alignItems: 'center',
  },
  chipOn: { backgroundColor: '#0ea5e9' },
  chipText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#02121f' },
  primary: {
    backgroundColor: '#22c55e',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryText: { color: '#052e12', fontSize: 14, fontWeight: '800' },
  secondary: {
    backgroundColor: '#1e293b',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  secondaryText: { color: '#cbd5e1', fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  prompt: { color: '#f8fafc', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  promptSub: { color: '#94a3b8', fontSize: 11, marginBottom: 8, lineHeight: 15 },
  hint: { color: '#64748b', fontSize: 11, marginTop: 2 },
  input: {
    width: 84,
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    borderRadius: 10,
    paddingVertical: 8,
  },
  quick: {
    backgroundColor: '#1e293b',
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  quickText: { color: '#cbd5e1', fontSize: 15, fontWeight: '700' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1e293b',
    overflow: 'hidden',
    marginVertical: 6,
  },
  progressFill: { height: 8, backgroundColor: '#0ea5e9' },
  summaryTitle: { color: '#f8fafc', fontSize: 15, fontWeight: '700', marginBottom: 4 },
  summary: {
    color: '#cbd5e1',
    fontSize: 10.5,
    lineHeight: 15,
    fontVariant: ['tabular-nums'],
    marginBottom: 6,
  },
  delivery: { color: '#7dd3fc', fontSize: 10.5, marginBottom: 8 },
});
