// The Continuity launch film. Scenes play back to back on a 120 BPM grid; the HUD and paper finish sit on top.
import { Audio } from '@remotion/media';
import React from 'react';
import { AbsoluteFill, interpolate, Series, staticFile, useCurrentFrame } from 'remotion';
import { Hud } from './Hud';
import { Finish } from './kit';
import { S01MidDeal } from './scenes/S01MidDeal';
import { S02Sigkill } from './scenes/S02Sigkill';
import { S03DealDoesntWait } from './scenes/S03DealDoesntWait';
import { S04Inbox } from './scenes/S04Inbox';
import { S05Title } from './scenes/S05Title';
import { S06Listen } from './scenes/S06Listen';
import { S07Resolve } from './scenes/S07Resolve';
import { S08Brief } from './scenes/S08Brief';
import { S09Act } from './scenes/S09Act';
import { S10Close } from './scenes/S10Close';
import { S11Results } from './scenes/S11Results';
import { S12Finale } from './scenes/S12Finale';
import { C } from './theme';
import { SCENES } from './timing';

export const SCENE_COMPONENTS: Record<string, React.FC> = {
  'S01-MidDeal': S01MidDeal,
  'S02-Sigkill': S02Sigkill,
  'S03-DealDoesntWait': S03DealDoesntWait,
  'S04-Inbox': S04Inbox,
  'S05-Title': S05Title,
  'S06-Listen': S06Listen,
  'S07-Resolve': S07Resolve,
  'S08-Brief': S08Brief,
  'S09-Act': S09Act,
  'S10-Close': S10Close,
  'S11-Results': S11Results,
  'S12-Finale': S12Finale,
};

// Scenes that hold still get a slow push so nothing on screen is ever frozen. (The others carry their own camera,
// or hand a card to the next scene and must end exactly where it begins.)
const DRIFT: Record<string, number> = { 'S03-DealDoesntWait': 0.03, 'S10-Close': 0.035, 'S11-Results': 0.03 };

const Drift: React.FC<{ amount: number; dur: number; children: React.ReactNode }> = ({ amount, dur, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ scale: interpolate(f, [0, dur], [1, 1 + amount]) }}>{children}</AbsoluteFill>;
};

export const Launch: React.FC<{ withAudio?: boolean }> = ({ withAudio = false }) => {
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Series>
        {SCENES.map((s) => {
          const Comp = SCENE_COMPONENTS[s.id];
          return (
            <Series.Sequence key={s.id} name={s.id} durationInFrames={s.dur}>
              {DRIFT[s.id] ? (
                <Drift amount={DRIFT[s.id]} dur={s.dur}>
                  <Comp />
                </Drift>
              ) : (
                <Comp />
              )}
            </Series.Sequence>
          );
        })}
      </Series>
      <Hud />
      <Finish />
      {withAudio ? <Audio src={staticFile('launch/score.wav')} /> : null}
    </AbsoluteFill>
  );
};
