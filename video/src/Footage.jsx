import React from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, MONO } from './theme.js';
import { Typewriter } from './Typewriter.jsx';

// The raw recording: 1768x1080 @ 30fps, 18.966s (569 frames).
// Hard cut in the source at ~9.9s where the session jumps ~5 minutes ahead —
// SEGMENT_A ends there, the SeamCard bridges it, SEGMENT_B plays the rest.
export const FOOTAGE_FPS = 30;
export const CUT_FRAME = 297; // ~9.9s
export const TOTAL_FRAMES = 569;
export const SEAM_SECONDS = 0.8;

// objectFit cover on a 1920x1080 canvas upscales the 1768-wide source ~8.6%,
// trimming ~46px top/bottom — which usefully pushes the browser chrome
// (URL bar with the host token, "New Chrome available") mostly off-frame.
// Browser-chrome mask: a flat black band pinned to the top of the frame,
// shown only while the recording has the URL bar (host token!) on screen.
// Times are SOURCE seconds; heights are comp px (1080-tall canvas), measured
// from the actual frames. Constraint: at ~3.8s the "Rishi wants to join"
// banner starts at y~118 and while zoomed (~5.0s) at y~181 — the band must
// cover the URL bar but never the knock.
//   2.75–2.90  fade in (browser window appears at ~2.9)
//   2.90–4.20  height 105 (URL bar in windowed/fullscreen views: y 49–94)
//   4.20–4.55  grow to 176 as the recording zooms in (URL bar grows to y~171)
//   4.55–5.35  height 176
//   5.35–5.55  fade out (recording zooms into the terminal, chrome gone)
//   17.55–17.70 fade in again (final zoom-out brings the URL bar back)
//   until end   height 105
function maskAt(srcT) {
  if (srcT < 2.75) return { h: 0, o: 0 };
  if (srcT < 5.55) {
    const o = interpolate(srcT, [2.75, 2.9, 5.35, 5.55], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const h = interpolate(srcT, [3.8, 4.05], [105, 184], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return { h, o };
  }
  const o = interpolate(srcT, [17.55, 17.7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return { h: 105, o };
}

const ChromeMask = ({ trimBefore }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { h, o } = maskAt((trimBefore + frame) / fps);
  if (o === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: h,
        background: '#000',
        opacity: o,
      }}
    />
  );
};

export const FootageSegment = ({ trimBefore, trimAfter }) => (
  <AbsoluteFill style={{ background: COLORS.bg }}>
    <OffthreadVideo
      src={staticFile('demo.mp4')}
      trimBefore={trimBefore}
      trimAfter={trimAfter}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      muted
    />
    <ChromeMask trimBefore={trimBefore} />
  </AbsoluteFill>
);

export const SeamCard = () => (
  <AbsoluteFill
    style={{
      background: COLORS.bg,
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: MONO,
      fontSize: 44,
      color: COLORS.dim,
      letterSpacing: '0.04em',
    }}
  >
    <div>
      <Typewriter text="5 minutes later…" start={0.06} step={0.02} fade={0.05} />
    </div>
  </AbsoluteFill>
);
