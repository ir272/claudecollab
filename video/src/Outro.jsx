import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, MONO, blinkOpacity } from './theme.js';
import { Typewriter } from './Typewriter.jsx';

// ~3s. Bare wordmark typewrites in, then "$ npx @claudecollab/cli", cursor
// blinks out the rest. Timings mirror mockup round 12 exactly.
export const OUTRO_SECONDS = 3;

export const Outro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: COLORS.bg,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 48,
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          fontSize: 108,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: COLORS.ink,
          whiteSpace: 'nowrap',
        }}
      >
        <Typewriter text="claudecollab" start={0.15} step={0.024} fade={0.07} color={COLORS.accent} colorFrom={6} />
      </div>
      <div style={{ fontSize: 38, color: COLORS.accent2, whiteSpace: 'nowrap' }}>
        <span style={{ color: COLORS.dim }}>
          <Typewriter text="$ " start={0.63} step={0.02} />
        </span>
        <Typewriter text="npx @claudecollab/cli" start={0.68} step={0.02} />
        <span
          style={{
            display: 'inline-block',
            width: 19,
            height: 36,
            background: COLORS.accent,
            verticalAlign: -3,
            marginLeft: 5,
            opacity: blinkOpacity(frame, fps, 1.12, 0.55),
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
