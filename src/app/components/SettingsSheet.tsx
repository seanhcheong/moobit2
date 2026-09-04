/**
 * Settings sheet: the dev-server address and the toggles that make the camera assumptions
 * verifiable on device rather than trusted.
 *
 * The dev-server host has to be editable in-app because the phone reaches the dev machine over
 * the LAN, and that address changes with every network and reboot. Both mirroring flags are
 * exposed for the same reason: they are the two most likely silent-wrong-answer bugs in this
 * pipeline, and flipping one while watching the colour-coded skeleton settles it in seconds.
 */

import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { connectionHint, type DevServerSettings } from '../session/telemetry';
import { TELEMETRY_ENABLED } from '../config/devFlags';
import type { LatencyDefinition } from '../../core/latency';

export interface HarnessToggles {
  showSkeleton: boolean;
  showRawSkeleton: boolean;
  showLandmarkIndices: boolean;
  showFramingGuide: boolean;
  expandedReadout: boolean;
  recordRawLog: boolean;
  mirrorX: boolean;
  swapAnatomicalSides: boolean;
  latencyDefinition: LatencyDefinition;
  targetLongEdge: number;
  rotationDegrees: number;
}

export const DEFAULT_TOGGLES: HarnessToggles = {
  showSkeleton: true,
  showRawSkeleton: false,
  showLandmarkIndices: false,
  showFramingGuide: true,
  expandedReadout: true,
  recordRawLog: true,
  mirrorX: true,
  swapAnatomicalSides: false,
  latencyDefinition: 'STATE_AGE',
  targetLongEdge: 320,
  rotationDegrees: 90,
};

export interface SettingsSheetProps {
  visible: boolean;
  toggles: HarnessToggles;
  devServer: DevServerSettings;
  healthText: string | null;
  onToggle: <K extends keyof HarnessToggles>(key: K, value: HarnessToggles[K]) => void;
  onDevServerChange: (s: DevServerSettings) => void;
  onTestConnection: () => void;
  onClose: () => void;
  /** Requires a camera restart to take effect, so it is applied explicitly. */
  onApplyCamera: () => void;
}

function Row({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

export const SettingsSheet = memo(function SettingsSheet(props: SettingsSheetProps) {
  if (!props.visible) return null;
  const { toggles: t } = props;

  return (
    <View style={styles.overlay}>
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
        <View style={styles.header}>
          <Text style={styles.title}>Harness settings</Text>
          <Pressable onPress={props.onClose} style={styles.close}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>OVERLAY</Text>
        <Row
          label="Skeleton overlay"
          hint="Off while measuring latency: it renders on the JS thread."
          value={t.showSkeleton}
          onChange={(v) => props.onToggle('showSkeleton', v)}
        />
        <Row
          label="Also draw unsmoothed skeleton"
          hint="Faint ghost. The way to judge the One Euro settings by eye."
          value={t.showRawSkeleton}
          onChange={(v) => props.onToggle('showRawSkeleton', v)}
        />
        <Row
          label="Landmark indices"
          value={t.showLandmarkIndices}
          onChange={(v) => props.onToggle('showLandmarkIndices', v)}
        />
        <Row
          label="Framing guide"
          value={t.showFramingGuide}
          onChange={(v) => props.onToggle('showFramingGuide', v)}
        />
        <Row
          label="Expanded readout"
          value={t.expandedReadout}
          onChange={(v) => props.onToggle('expandedReadout', v)}
        />

        <Text style={styles.section}>CAMERA GEOMETRY</Text>
        <Row
          label="Mirror X"
          hint="Lines the skeleton up with the mirrored selfie preview. Angles are unaffected."
          value={t.mirrorX}
          onChange={(v) => props.onToggle('mirrorX', v)}
        />
        <Row
          label="Swap left/right labels"
          hint="Should NOT be needed. Raise one hand and check the highlighted limb matches."
          value={t.swapAnatomicalSides}
          onChange={(v) => props.onToggle('swapAnatomicalSides', v)}
        />

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Frame rotation</Text>
            <Text style={styles.rowHint}>
              Clockwise degrees to make the image upright. Wrong here gives plausible but wrong
              joint angles, so check the skeleton lands on the body.
            </Text>
          </View>
          <View style={styles.segments}>
            {[0, 90, 180, 270].map((deg) => (
              <Pressable
                key={deg}
                style={[styles.segment, t.rotationDegrees === deg && styles.segmentOn]}
                onPress={() => props.onToggle('rotationDegrees', deg)}
              >
                <Text style={[styles.segmentText, t.rotationDegrees === deg && styles.segmentTextOn]}>
                  {deg}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Inference size</Text>
            <Text style={styles.rowHint}>
              Longest edge fed to the detector. Android only; iOS resizes on the GPU.
            </Text>
          </View>
          <View style={styles.segments}>
            {[192, 256, 320, 384].map((px) => (
              <Pressable
                key={px}
                style={[styles.segment, t.targetLongEdge === px && styles.segmentOn]}
                onPress={() => props.onToggle('targetLongEdge', px)}
              >
                <Text style={[styles.segmentText, t.targetLongEdge === px && styles.segmentTextOn]}>
                  {px}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Text style={styles.section}>LATENCY DEFINITION</Text>
        <View style={styles.segmentsWide}>
          {(['STATE_AGE', 'PIPELINE'] as LatencyDefinition[]).map((d) => (
            <Pressable
              key={d}
              style={[styles.segmentWide, t.latencyDefinition === d && styles.segmentOn]}
              onPress={() => props.onToggle('latencyDefinition', d)}
            >
              <Text style={[styles.segmentText, t.latencyDefinition === d && styles.segmentTextOn]}>
                {d}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.explain}>
          STATE_AGE measures from the capture of the frame the emitted state describes, so it
          includes the async result staleness — the lag you would actually feel. PIPELINE measures
          only detector throughput and reads lower.
        </Text>

        <Text style={styles.section}>DEV TELEMETRY {TELEMETRY_ENABLED ? '' : '(not in this build)'}</Text>
        <Row
          label="Record raw landmark log"
          hint="~1 MB per 30 s. Enables offline replay tuning."
          value={t.recordRawLog}
          onChange={(v) => props.onToggle('recordRawLog', v)}
        />
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Dev server</Text>
            <Text style={styles.rowHint}>{connectionHint()}</Text>
          </View>
        </View>
        <View style={styles.hostRow}>
          <TextInput
            style={[styles.input, styles.hostInput]}
            value={props.devServer.host}
            onChangeText={(host) => props.onDevServerChange({ ...props.devServer, host })}
            placeholder="192.168.1.42"
            placeholderTextColor="#475569"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
          />
          <TextInput
            style={[styles.input, styles.portInput]}
            value={String(props.devServer.port)}
            onChangeText={(text) =>
              props.onDevServerChange({ ...props.devServer, port: Number.parseInt(text, 10) || 0 })
            }
            keyboardType="number-pad"
            maxLength={5}
          />
          <Pressable style={styles.test} onPress={props.onTestConnection}>
            <Text style={styles.testText}>Test</Text>
          </Pressable>
        </View>
        {props.healthText && <Text style={styles.health}>{props.healthText}</Text>}

        <Pressable style={styles.apply} onPress={props.onApplyCamera}>
          <Text style={styles.applyText}>Apply camera settings (restarts the stream)</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,6,23,0.94)' },
  sheet: { flex: 1 },
  sheetContent: { padding: 14, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: '#f8fafc', fontSize: 18, fontWeight: '800' },
  close: { backgroundColor: '#0ea5e9', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  closeText: { color: '#02121f', fontWeight: '800' },
  section: {
    color: '#475569',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 14,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e293b',
  },
  rowText: { flex: 1, paddingRight: 10 },
  rowLabel: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  rowHint: { color: '#64748b', fontSize: 10, lineHeight: 14, marginTop: 1 },
  segments: { flexDirection: 'row', gap: 4 },
  segment: {
    backgroundColor: '#1e293b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minWidth: 38,
    alignItems: 'center',
  },
  segmentsWide: { flexDirection: 'row', gap: 6 },
  segmentWide: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  segmentOn: { backgroundColor: '#0ea5e9' },
  segmentText: { color: '#94a3b8', fontSize: 11, fontWeight: '700' },
  segmentTextOn: { color: '#02121f' },
  explain: { color: '#64748b', fontSize: 10, lineHeight: 14, marginTop: 6 },
  hostRow: { flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center' },
  input: {
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
  },
  hostInput: { flex: 1 },
  portInput: { width: 78, textAlign: 'center' },
  test: { backgroundColor: '#334155', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  testText: { color: '#e2e8f0', fontWeight: '700' },
  health: { color: '#7dd3fc', fontSize: 10.5, marginTop: 6, lineHeight: 15 },
  apply: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 18,
  },
  applyText: { color: '#cbd5e1', fontWeight: '700', fontSize: 13 },
});
