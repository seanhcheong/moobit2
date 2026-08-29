/**
 * Skeleton overlay for visual debugging.
 *
 * Rendered with react-native-svg rather than Skia. Current Skia needs Reanimated 4 plus
 * react-native-worklets, which would put a second worklet runtime alongside the worklets-core one
 * VisionCamera's frame processors use — the single largest install risk in this stack, and not a
 * risk a debug overlay justifies. The cost is that this re-renders on the JS thread, which is why
 * it is driven at ~15 fps from a snapshot and has an off switch.
 *
 * Left limbs are drawn in one colour and right limbs in another. That is not decoration: it is how
 * the mirroring and anatomical-side flags get verified. Raise one hand and check the highlighted
 * limb is the one you actually raised.
 */

import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import { LM, SKELETON_BONES } from '../../core/landmarks';

export const OVERLAY_COLORS = {
  left: '#4ade80',
  right: '#60a5fa',
  center: '#facc15',
  raw: 'rgba(255,255,255,0.28)',
  lowConfidence: '#ef4444',
};

export interface SkeletonOverlayProps {
  /** Smoothed positions in isotropic space: u in units of image height, v in 0..1. */
  u: number[];
  v: number[];
  vis: number[];
  /** Unsmoothed positions, drawn faintly when `showRaw`. */
  rawU?: number[];
  rawV?: number[];
  /** imageWidth / imageHeight of the frame the coordinates came from. */
  aspect: number;
  width: number;
  height: number;
  /** Below this visibility a joint is drawn in the warning colour. */
  minVisibility?: number;
  showRaw?: boolean;
  showIndices?: boolean;
}

/**
 * Map isotropic space to screen pixels.
 *
 * The preview fills the view with `resizeMode="cover"`, so the frame is scaled by whichever axis
 * needs the larger factor and the overflow is cropped evenly. Reproducing that here is what keeps
 * the skeleton on the body instead of a systematically offset copy of it.
 */
function makeProjector(aspect: number, width: number, height: number) {
  const frameAspect = aspect > 0 ? aspect : 0.5625;
  const scale = Math.max(width / frameAspect, height);
  const drawnWidth = frameAspect * scale;
  const offsetX = (width - drawnWidth) / 2;
  const offsetY = (height - scale) / 2;
  return {
    x: (uu: number) => offsetX + uu * scale,
    y: (vv: number) => offsetY + vv * scale,
  };
}

export const SkeletonOverlay = memo(function SkeletonOverlay({
  u,
  v,
  vis,
  rawU,
  rawV,
  aspect,
  width,
  height,
  minVisibility = 0.4,
  showRaw = false,
  showIndices = false,
}: SkeletonOverlayProps) {
  if (width <= 0 || height <= 0) return null;
  const p = makeProjector(aspect, width, height);

  const bones: React.ReactNode[] = [];

  if (showRaw && rawU && rawV) {
    for (let i = 0; i < SKELETON_BONES.length; i++) {
      const b = SKELETON_BONES[i];
      bones.push(
        <Line
          key={`raw-${i}`}
          x1={p.x(rawU[b.a])}
          y1={p.y(rawV[b.a])}
          x2={p.x(rawU[b.b])}
          y2={p.y(rawV[b.b])}
          stroke={OVERLAY_COLORS.raw}
          strokeWidth={5}
          strokeLinecap="round"
        />,
      );
    }
  }

  for (let i = 0; i < SKELETON_BONES.length; i++) {
    const b = SKELETON_BONES[i];
    const weak = vis[b.a] < minVisibility || vis[b.b] < minVisibility;
    bones.push(
      <Line
        key={`bone-${i}`}
        x1={p.x(u[b.a])}
        y1={p.y(v[b.a])}
        x2={p.x(u[b.b])}
        y2={p.y(v[b.b])}
        stroke={weak ? OVERLAY_COLORS.lowConfidence : OVERLAY_COLORS[b.side]}
        strokeWidth={weak ? 2 : 3.5}
        strokeOpacity={weak ? 0.55 : 1}
        strokeLinecap="round"
      />,
    );
  }

  // Only the joints the classifiers read. Drawing all 33 clutters the view with eyes and fingers
  // that no threshold depends on.
  const joints = [
    LM.NOSE,
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_ELBOW,
    LM.RIGHT_ELBOW,
    LM.LEFT_WRIST,
    LM.RIGHT_WRIST,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_KNEE,
    LM.RIGHT_KNEE,
    LM.LEFT_ANKLE,
    LM.RIGHT_ANKLE,
  ];

  const dots: React.ReactNode[] = [];
  for (const j of joints) {
    const weak = vis[j] < minVisibility;
    const isLeft = j % 2 === 1 && j >= LM.LEFT_SHOULDER;
    const color = weak
      ? OVERLAY_COLORS.lowConfidence
      : j === LM.NOSE
        ? OVERLAY_COLORS.center
        : isLeft
          ? OVERLAY_COLORS.left
          : OVERLAY_COLORS.right;
    const cx = p.x(u[j]);
    const cy = p.y(v[j]);
    dots.push(
      <Circle key={`j-${j}`} cx={cx} cy={cy} r={weak ? 3 : 5} fill={color} fillOpacity={weak ? 0.5 : 1} />,
    );
    if (showIndices) {
      dots.push(
        <SvgText key={`t-${j}`} x={cx + 8} y={cy - 6} fontSize={9} fill="#fff" opacity={0.7}>
          {String(j)}
        </SvgText>,
      );
    }
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        {bones}
        {dots}
      </Svg>
    </View>
  );
});
