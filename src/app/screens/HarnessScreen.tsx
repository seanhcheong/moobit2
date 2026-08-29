/**
 * The debug harness screen.
 *
 * Front camera, live pose detection, skeleton overlay, framing guide, live debug readout, and the
 * ground-truth session flow that turns each test into an accuracy number.
 *
 * Scope is recognition only: no character, no animation, no game state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';

import { usePosePipeline } from '../frame/usePosePipeline';
import { SkeletonOverlay } from '../components/SkeletonOverlay';
import { FramingGuideOverlay } from '../components/FramingGuideOverlay';
import { DebugReadout } from '../components/DebugReadout';
import { SessionControls, type SessionPhase } from '../components/SessionControls';
import { DEFAULT_TOGGLES, SettingsSheet, type HarnessToggles } from '../components/SettingsSheet';
import { createSessionRecorder, type SessionRecorder } from '../session/recorder';
import { checkDevServer, DEFAULT_DEV_SERVER, type DevServerSettings } from '../session/telemetry';
import { REPLAY_LOGGING_ENABLED, TELEMETRY_ENABLED } from '../config/devFlags';
import { DEFAULT_FRAMING } from '../../core/framing';
import { formatSessionSummary, type ExerciseSummary } from '../../core/session';
import { LUNGE_CONFIG, PUSHUP_CONFIG, SQUAT_CONFIG } from '../../core/exercises';
import { DEFAULT_ONE_EURO } from '../../core/oneEuro';
import type { ExerciseId } from '../../core/types';
import type { PipelineOutput } from '../../core/pipeline';

export function HarnessScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');

  const [toggles, setToggles] = useState<HarnessToggles>(DEFAULT_TOGGLES);
  const [appliedToggles, setAppliedToggles] = useState<HarnessToggles>(DEFAULT_TOGGLES);
  const [devServer, setDevServer] = useState<DevServerSettings>(DEFAULT_DEV_SERVER);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [healthText, setHealthText] = useState<string | null>(null);

  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [declaredExercise, setDeclaredExercise] = useState<ExerciseId | null>(null);
  const [plannedReps, setPlannedReps] = useState<number | null>(10);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [deliveryText, setDeliveryText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const recorderRef = useRef<SessionRecorder | null>(null);
  const recordingRef = useRef(false);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  /**
   * Prefer a modest resolution at the highest frame rate.
   *
   * Pose Landmarker downsamples to its own input size regardless, so a 4K stream buys nothing and
   * costs real bandwidth on every frame. Frame rate is what the recognition stream actually needs.
   */
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1280, height: 720 } },
    { fps: 60 },
  ]);

  const configuredFps = useMemo(() => {
    if (!format) return 30;
    return Math.min(60, Math.max(30, Math.floor(format.maxFps)));
  }, [format]);

  const onFrameForRecorder = useCallback(
    (out: PipelineOutput, native: unknown) => {
      const rec = recorderRef.current;
      if (!rec || !recordingRef.current) return;
      const n = native as {
        ok?: boolean;
        nowMs?: number;
        resultAtMs?: number;
        inferenceMs?: number;
        decimateMs?: number;
        framesDropped?: number;
        landmarks?: number[];
      };
      rec.onFrame(
        out.event,
        n.landmarks ?? null,
        {
          nowMs: n.nowMs ?? 0,
          resultAtMs: n.resultAtMs ?? 0,
          inferenceMs: n.inferenceMs ?? 0,
          decimateMs: n.decimateMs ?? 0,
          framesDropped: n.framesDropped ?? 0,
        },
        out.repCompleted,
        out.repCompleted ? out.event.depth : NaN,
      );
    },
    [],
  );

  const pipelineConfig = useMemo(
    () => ({
      camera: {
        mirrorX: appliedToggles.mirrorX,
        swapAnatomicalSides: appliedToggles.swapAnatomicalSides,
      },
      latencyDefinition: appliedToggles.latencyDefinition,
    }),
    [appliedToggles.mirrorX, appliedToggles.swapAnatomicalSides, appliedToggles.latencyDefinition],
  );

  const { frameProcessor, snapshot, pipeline, pluginAvailable, beginCalibration, resetCounters } =
    usePosePipeline({
      config: pipelineConfig,
      nativeFrame: {
        targetLongEdge: appliedToggles.targetLongEdge,
        rotationDegrees: appliedToggles.rotationDegrees,
      },
      uiHz: 15,
      onFrame: onFrameForRecorder,
    });

  // The pipeline is created once, so a mid-session settings change has to be pushed into it.
  useEffect(() => {
    pipeline.config.camera.mirrorX = appliedToggles.mirrorX;
    pipeline.config.camera.swapAnatomicalSides = appliedToggles.swapAnatomicalSides;
    pipeline.latencyTracker.definition = appliedToggles.latencyDefinition;
  }, [pipeline, appliedToggles]);

  // Track calibration reaching completion so the session flow can advance itself.
  useEffect(() => {
    if (phase === 'calibrating' && snapshot.mode === 'running') setPhase('idle');
  }, [phase, snapshot.mode]);

  const onToggle = useCallback(
    <K extends keyof HarnessToggles>(key: K, value: HarnessToggles[K]) => {
      setToggles((prev) => {
        const next = { ...prev, [key]: value };
        // Camera-geometry and inference-size changes need an explicit Apply; everything else is
        // presentational and takes effect immediately.
        const needsApply =
          key === 'targetLongEdge' || key === 'rotationDegrees';
        if (!needsApply) setAppliedToggles(next);
        return next;
      });
    },
    [],
  );

  const onTestConnection = useCallback(async () => {
    setHealthText('checking…');
    const res = await checkDevServer(devServer);
    setHealthText(`${res.ok ? 'OK' : 'FAILED'} — ${res.detail}`);
  }, [devServer]);

  const onStart = useCallback(() => {
    if (!pipeline.baseline) {
      Alert.alert('Not calibrated', 'Run "Recalibrate" and hold still for two seconds first.');
      return;
    }
    const now = new Date();
    const sessionId = `s${now.getTime().toString(36)}`;
    resetCounters();

    const recorder = createSessionRecorder({
      sessionId,
      startedAtIso: now.toISOString(),
      startedAtMs: Date.now(),
      device: {
        platform: Platform.OS,
        osVersion: String(Platform.Version),
        model: device?.name ?? 'unknown',
        delegate: snapshot.nativeDelegate,
        targetLongEdge: appliedToggles.targetLongEdge,
        cameraWidth: format?.videoWidth ?? 0,
        cameraHeight: format?.videoHeight ?? 0,
        cameraFps: configuredFps,
      },
      config: {
        oneEuro: DEFAULT_ONE_EURO,
        squat: SQUAT_CONFIG,
        pushup: PUSHUP_CONFIG,
        lunge: LUNGE_CONFIG,
        camera: pipeline.config.camera,
        latencyDefinition: appliedToggles.latencyDefinition,
      },
      header: {
        imageWidth: format?.videoWidth ?? 0,
        imageHeight: format?.videoHeight ?? 0,
        rotationDegrees: appliedToggles.rotationDegrees,
        mirrorX: appliedToggles.mirrorX,
      },
      recordRawLog: REPLAY_LOGGING_ENABLED && toggles.recordRawLog,
      devServer,
    });

    if (pipeline.baseline) recorder.noteBaseline(pipeline.baseline);
    recorderRef.current = recorder;
    recordingRef.current = true;
    setSummaryText(null);
    setDeliveryText(null);
    setPhase('recording');
  }, [
    pipeline,
    resetCounters,
    device,
    snapshot.nativeDelegate,
    appliedToggles,
    format,
    configuredFps,
    toggles.recordRawLog,
    devServer,
  ]);

  const onEnd = useCallback(() => {
    recordingRef.current = false;
    setPhase('awaiting-truth');
  }, []);

  const detectedReps = useMemo(() => {
    if (!declaredExercise) return snapshot.event.repCount;
    const idx = pipeline.registry.findIndex((m) => m.id === declaredExercise);
    if (idx < 0) return snapshot.event.repCount;
    return pipeline.registry[idx].diagnostics(pipeline.exerciseState(idx)).repCount;
  }, [declaredExercise, pipeline, snapshot.event.repCount]);

  const onSubmitActual = useCallback(
    async (actual: number) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        setPhase('idle');
        return;
      }
      setBusy(true);
      try {
        const perExercise: ExerciseSummary[] = pipeline.registry.map((mod, i) => {
          const d = mod.diagnostics(pipeline.exerciseState(i));
          return {
            id: mod.id,
            repCount: d.repCount,
            partialReps: d.partialReps,
            abandonedReps: d.abandonedReps,
            flickers: d.flickers,
            trackingLosses: d.trackingLosses,
          };
        });

        const { summary, delivery, rawUploaded } = await recorder.finish({
          latencyTracker: pipeline.latencyTracker,
          perExercise,
          groundTruth: { declaredExercise, plannedReps, actualReps: actual },
          baseline: pipeline.baseline,
          labelSwitches: pipeline.disambiguation.labelSwitches,
        });

        setSummaryText(formatSessionSummary(summary));
        const bits: string[] = [];
        bits.push(delivery.savedLocally ? `saved on device: ${delivery.localPath}` : 'device save FAILED');
        if (TELEMETRY_ENABLED) {
          bits.push(delivery.posted ? `posted to ${devServer.host}:${devServer.port}` : 'POST failed (kept on device)');
          if (recorder.recordingRaw) bits.push(rawUploaded ? 'raw log uploaded' : 'raw log kept on device only');
        }
        if (delivery.error) bits.push(delivery.error);
        setDeliveryText(bits.join('\n'));
        setPhase('done');
      } catch (err) {
        setDeliveryText(`failed to finish session: ${String(err)}`);
        setPhase('done');
      } finally {
        setBusy(false);
        recorderRef.current = null;
      }
    },
    [pipeline, declaredExercise, plannedReps, devServer],
  );

  const onNewSession = useCallback(() => {
    setSummaryText(null);
    setDeliveryText(null);
    resetCounters();
    setPhase('idle');
  }, [resetCounters]);

  const onCalibrate = useCallback(() => {
    beginCalibration();
    setPhase('calibrating');
  }, [beginCalibration]);

  const onMarker = useCallback(() => {
    recorderRef.current?.addMarker('marked', Date.now());
  }, []);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setPreviewSize({ width, height });
  }, []);

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>Camera permission needed</Text>
        <Text style={styles.centerBody}>
          The harness watches you exercise on-device. Nothing leaves the phone except the dev-only
          session summary you explicitly send to your own machine.
        </Text>
        <Pressable style={styles.centerButton} onPress={() => void requestPermission()}>
          <Text style={styles.centerButtonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#0ea5e9" />
        <Text style={styles.centerBody}>Looking for a front camera…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.preview} onLayout={onLayout}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          fps={configuredFps}
          isActive
          // The Android plugin reads frame.image, which requires the YUV pixel format.
          pixelFormat="yuv"
          enableFpsGraph
          frameProcessor={frameProcessor}
        />

        {appliedToggles.showSkeleton && (
          <SkeletonOverlay
            u={snapshot.u}
            v={snapshot.v}
            vis={snapshot.vis}
            rawU={snapshot.rawU}
            rawV={snapshot.rawV}
            aspect={snapshot.aspect}
            width={previewSize.width}
            height={previewSize.height}
            showRaw={appliedToggles.showRawSkeleton}
            showIndices={appliedToggles.showLandmarkIndices}
          />
        )}

        <FramingGuideOverlay
          status={snapshot.framing}
          config={DEFAULT_FRAMING}
          aspect={snapshot.aspect}
          width={previewSize.width}
          height={previewSize.height}
          visible={appliedToggles.showFramingGuide}
        />

        <Pressable style={styles.settingsButton} onPress={() => setSettingsOpen(true)}>
          <Text style={styles.settingsButtonText}>settings</Text>
        </Pressable>

        {!pluginAvailable && (
          <View style={styles.pluginError}>
            <Text style={styles.pluginErrorText}>
              Native plugin "detectPose" did not register. On Android check the
              FrameProcessorPluginRegistry call in MainApplication.kt; on iOS check that
              PoseFrameProcessorPlugin.m is in the target's Compile Sources.
            </Text>
          </View>
        )}
      </View>

      <DebugReadout
        snapshot={snapshot}
        tracker={pipeline.latencyTracker}
        expanded={appliedToggles.expandedReadout}
      />

      <SessionControls
        phase={phase}
        declaredExercise={declaredExercise}
        plannedReps={plannedReps}
        detectedReps={detectedReps}
        calibrationProgress={snapshot.calibration.progress}
        calibrationReject={snapshot.calibration.reject}
        framingOk={snapshot.framing.inFrame}
        busy={busy}
        summaryText={summaryText}
        deliveryText={deliveryText}
        onSelectExercise={setDeclaredExercise}
        onSelectPlanned={setPlannedReps}
        onCalibrate={onCalibrate}
        onStart={onStart}
        onEnd={onEnd}
        onSubmitActual={onSubmitActual}
        onNewSession={onNewSession}
        onMarker={onMarker}
      />

      <SettingsSheet
        visible={settingsOpen}
        toggles={toggles}
        devServer={devServer}
        healthText={healthText}
        onToggle={onToggle}
        onDevServerChange={setDevServer}
        onTestConnection={() => void onTestConnection()}
        onClose={() => setSettingsOpen(false)}
        onApplyCamera={() => {
          setAppliedToggles(toggles);
          setSettingsOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020617' },
  preview: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: '#020617',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 12,
  },
  centerTitle: { color: '#f8fafc', fontSize: 19, fontWeight: '700' },
  centerBody: { color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  centerButton: {
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  centerButtonText: { color: '#02121f', fontWeight: '800' },
  settingsButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  settingsButtonText: { color: '#cbd5e1', fontSize: 11, fontWeight: '700' },
  pluginError: {
    position: 'absolute',
    bottom: 16,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(127,29,29,0.92)',
    borderRadius: 10,
    padding: 10,
  },
  pluginErrorText: { color: '#fecaca', fontSize: 11, lineHeight: 16 },
});
