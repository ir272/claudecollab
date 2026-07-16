import React from 'react';
import { Series } from 'remotion';
import { Intro, INTRO_SECONDS } from './Intro.jsx';
import { Outro, OUTRO_SECONDS } from './Outro.jsx';
import { FootageSegment, SeamCard, CUT_FRAME, TOTAL_FRAMES, SEAM_SECONDS } from './Footage.jsx';

const FPS = 30;

export const MASTER_FRAMES =
  Math.round(INTRO_SECONDS * FPS) +
  CUT_FRAME +
  Math.round(SEAM_SECONDS * FPS) +
  (TOTAL_FRAMES - CUT_FRAME) +
  Math.round(OUTRO_SECONDS * FPS); // 48 + 297 + 24 + 272 + 90 = 731 (~24.4s)

export const Master = () => (
  <Series>
    <Series.Sequence durationInFrames={Math.round(INTRO_SECONDS * 30)}>
      <Intro />
    </Series.Sequence>
    <Series.Sequence durationInFrames={CUT_FRAME} premountFor={45}>
      <FootageSegment trimBefore={0} trimAfter={CUT_FRAME} />
    </Series.Sequence>
    <Series.Sequence durationInFrames={Math.round(SEAM_SECONDS * 30)}>
      <SeamCard />
    </Series.Sequence>
    <Series.Sequence durationInFrames={TOTAL_FRAMES - CUT_FRAME} premountFor={45}>
      <FootageSegment trimBefore={CUT_FRAME} trimAfter={TOTAL_FRAMES} />
    </Series.Sequence>
    <Series.Sequence durationInFrames={Math.round(OUTRO_SECONDS * 30)}>
      <Outro />
    </Series.Sequence>
  </Series>
);
