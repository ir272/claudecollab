import React from 'react';
import { Composition } from 'remotion';
import { Intro, INTRO_SECONDS } from './Intro.jsx';
import { Outro, OUTRO_SECONDS } from './Outro.jsx';
import { SeamCard, SEAM_SECONDS } from './Footage.jsx';
import { Master, MASTER_FRAMES } from './Master.jsx';

const FPS = 30;
const size = { width: 1920, height: 1080 };

export const Root = () => (
  <>
    <Composition id="Master" component={Master} durationInFrames={MASTER_FRAMES} fps={FPS} {...size} />
    <Composition id="Intro" component={Intro} durationInFrames={Math.round(INTRO_SECONDS * FPS)} fps={FPS} {...size} />
    <Composition id="Outro" component={Outro} durationInFrames={Math.round(OUTRO_SECONDS * FPS)} fps={FPS} {...size} />
    <Composition id="SeamCard" component={SeamCard} durationInFrames={Math.round(SEAM_SECONDS * FPS)} fps={FPS} {...size} />
  </>
);
