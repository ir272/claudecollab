// One place for the video's look + the typewriter helper.
// All timings are in SECONDS (matching the approved HTML mockups 1:1);
// components convert with sec(t, fps).

export const COLORS = {
  bg: '#000000',
  ink: '#e8e4dd',
  dim: '#9a958c',
  accent: '#ff9333',
  accent2: '#ffb066',
  rishi: '#2e7dd1',
  chipInkOnOrange: '#1a1205',
};

export const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

export const sec = (t, fps) => t * fps;

// Opacity for a typewritten character: starts at `start` s, fades in over `fade` s.
export function charOpacity(frame, fps, start, fade) {
  const f0 = sec(start, fps);
  const f1 = sec(start + fade, fps);
  if (frame <= f0) return 0;
  if (frame >= f1) return 1;
  return (frame - f0) / (f1 - f0);
}

// Blinking cursor: invisible before `start` s, then oscillates 1 <-> 0.1
// with the given period (matches the mockup's blinkc keyframes).
export function blinkOpacity(frame, fps, start, period) {
  const t = frame / fps;
  if (t < start) return 0;
  const phase = ((t - start) % period) / period; // 0..1
  const tri = 1 - Math.abs(phase - 0.5) * 2; // 0 at ends, 1 mid-cycle
  return 1 - 0.9 * tri;
}
