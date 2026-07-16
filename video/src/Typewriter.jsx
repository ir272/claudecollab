import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { charOpacity } from './theme.js';

// Renders `text` one character at a time: first char at `start` s, one every
// `step` s, each fading in over `fade` s. Characters always occupy their space
// (opacity-only) so the layout never shifts while typing.
export const Typewriter = ({ text, start, step, fade = 0.06, color, colorFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <>
      {[...text].map((ch, i) => (
        <span
          key={i}
          style={{
            opacity: charOpacity(frame, fps, start + i * step, fade),
            color: colorFrom === undefined || i >= colorFrom ? color : undefined,
            whiteSpace: 'pre',
          }}
        >
          {ch}
        </span>
      ))}
    </>
  );
};
