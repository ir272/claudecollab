import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';
import { COLORS, MONO, sec, blinkOpacity } from './theme.js';
import { Typewriter } from './Typewriter.jsx';

// ~1.6s. "claudecollab" typewrites in; rishi's chip pops the instant "claude"
// finishes, ian's the instant "collab" does; tail cursor blinks from the end of
// the word; tagline typewrites below. Timings mirror mockup round 12 exactly.
export const INTRO_SECONDS = 1.6;

const WORD_SIZE = 108;
const CHAR_STEP = 0.028;
const WORD_START = 0.08;
const COLLAB_START = WORD_START + 6 * CHAR_STEP; // 0.248
const TAG_START = 0.55;

// Mockup popin: rise from .35em + scale .5 -> overshoot 1.1 at 70% -> settle 1.
const pop = (frame, fps, start, dur) => {
  const t = interpolate(frame, [sec(start, fps), sec(start + dur, fps)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const scale = t < 0.7 ? 0.5 + (t / 0.7) * 0.6 : 1.1 - ((t - 0.7) / 0.3) * 0.1;
  return { opacity: t === 0 ? 0 : Math.min(1, t * 2), rise: (1 - t) * 0.35 * WORD_SIZE, scale };
};

const Chip = ({ label, bg, color, start }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, start, 0.25);
  return (
    <span
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: `translate(-50%, ${-0.15 * 28 + p.rise}px) scale(${p.scale})`,
        opacity: p.opacity,
        background: bg,
        color,
        fontSize: 28,
        fontWeight: 400,
        letterSpacing: 0,
        padding: '6px 24px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        fontFamily: MONO,
      }}
    >
      {label}
    </span>
  );
};

export const Intro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: COLORS.bg,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 40,
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          position: 'relative',
          fontSize: WORD_SIZE,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: COLORS.ink,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <Typewriter text="claude" start={WORD_START} step={CHAR_STEP} />
          <Chip label="rishi" bg={COLORS.rishi} color="#fff" start={0.26} />
        </span>
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <Typewriter text="collab" start={COLLAB_START} step={CHAR_STEP} color={COLORS.accent} />
          <Chip label="ian" bg={COLORS.accent} color={COLORS.chipInkOnOrange} start={0.44} />
        </span>
        <span
          style={{
            display: 'inline-block',
            width: 0.5 * WORD_SIZE,
            height: 0.95 * WORD_SIZE,
            background: COLORS.accent,
            borderRadius: 6,
            verticalAlign: `${-0.08 * WORD_SIZE}px`,
            marginLeft: 0.1 * WORD_SIZE,
            opacity: blinkOpacity(frame, fps, 0.46, 0.5),
          }}
        />
      </div>
      <div style={{ fontSize: 36, color: COLORS.dim, letterSpacing: '0.04em', minHeight: 54 }}>
        <Typewriter text="your Claude session — multiplayer" start={TAG_START} step={0.014} fade={0.05} />
      </div>
    </AbsoluteFill>
  );
};
