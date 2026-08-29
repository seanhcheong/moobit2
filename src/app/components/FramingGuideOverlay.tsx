/**
 * On-screen framing guide and in-frame indicator.
 *
 * The camera is fixed on the floor, so the user has to position themselves relative to it rather
 * than the other way round. This draws the target silhouette and says, in one short instruction,
 * what is wrong when they are not in it.
 *
 * The rectangle is derived from the same {@link FramingConfig} the in-frame test uses, not drawn by
 * hand. A guide the user can stand inside while still being told they are out of frame would be
 * worse than no guide at all.
 */

import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Ellipse, Line, Rect } from 'react-native-svg';
import { framingGuide, type FramingConfig, type FramingStatus } from '../../core/framing';

export interface FramingGuideOverlayProps {
  status: FramingStatus;
  config: FramingConfig;
  aspect: number;
  width: number;
  height: number;
  visible: boolean;
}

export const FramingGuideOverlay = memo(function FramingGuideOverlay({
  status,
  config,
  aspect,
  width,
  height,
  visible,
}: FramingGuideOverlayProps) {
  if (!visible || width <= 0 || height <= 0) return null;

  const guide = framingGuide(config, aspect > 0 ? aspect : 0.5625);
  const gx = guide.x * width;
  const gy = guide.y * height;
  const gw = guide.width * width;
  const gh = guide.height * height;

  const good = status.inFrame;
  const stroke = good ? '#4ade80' : '#f97316';

  // A head circle and a body outline, so the silhouette reads as a person to stand inside rather
  // than an abstract box.
  const headR = gw * 0.22;
  const headCx = gx + gw / 2;
  const headCy = gy + headR * 1.1;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        <Rect
          x={gx}
          y={gy}
          width={gw}
          height={gh}
          rx={gw * 0.16}
          stroke={stroke}
          strokeWidth={2.5}
          strokeDasharray="10 8"
          fill="none"
        />
        <Ellipse
          cx={headCx}
          cy={headCy}
          rx={headR}
          ry={headR * 1.15}
          stroke={stroke}
          strokeWidth={2}
          strokeDasharray="6 6"
          fill="none"
        />
        {/* Floor line: where the feet should land. */}
        <Line
          x1={gx - gw * 0.15}
          y1={gy + gh}
          x2={gx + gw * 1.15}
          y2={gy + gh}
          stroke={stroke}
          strokeWidth={2}
          strokeDasharray="4 6"
        />
      </Svg>

      <View style={[styles.badge, { borderColor: stroke }]}>
        <View style={[styles.dot, { backgroundColor: stroke }]} />
        <Text style={styles.badgeText}>
          {good ? 'In frame' : status.hint || 'Adjust position'}
        </Text>
      </View>

      {!good && status.issues.length > 1 && (
        <View style={styles.issues}>
          <Text style={styles.issuesText}>{status.issues.join(' · ')}</Text>
        </View>
      )}

      <View style={styles.metrics}>
        <Text style={styles.metricsText}>
          body height {(status.bodyHeightFrac * 100).toFixed(0)}% of frame
          {'  '}
          (target {(config.minBodyHeightFrac * 100).toFixed(0)}–
          {(config.maxBodyHeightFrac * 100).toFixed(0)}%)
        </Text>
        <Text style={styles.metricsText}>
          off-centre {status.centerOffset >= 0 ? '+' : ''}
          {status.centerOffset.toFixed(3)} (max ±{config.maxCenterOffset.toFixed(2)})
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1.5,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  dot: { width: 9, height: 9, borderRadius: 5, marginRight: 8 },
  badgeText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  issues: {
    position: 'absolute',
    top: 52,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  issuesText: { color: '#fdba74', fontSize: 11 },
  metrics: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  metricsText: { color: '#d1d5db', fontSize: 10, fontVariant: ['tabular-nums'] },
});
