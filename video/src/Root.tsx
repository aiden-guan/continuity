import { Composition, Folder, staticFile, type CalculateMetadataFunction } from 'remotion';
import { Launch, SCENE_COMPONENTS } from './launch/Launch';
import { FPS as LAUNCH_FPS, SCENES, TOTAL } from './launch/timing';
import { Demo, type DemoProps } from './Demo';
import { FPS, plan, type Timeline, type Voice } from './plan';

async function loadPublicJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(staticFile(path), { signal });
  if (!res.ok) throw new Error(`missing public/${path} — run npm run record and npm run narrate first`);
  return (await res.json()) as T;
}

// The cut is derived from the recording timeline and the voiceover manifest, so length follows the inputs.
const calculateMetadata: CalculateMetadataFunction<DemoProps> = async ({ abortSignal }) => {
  const [timeline, voice] = await Promise.all([
    loadPublicJson<Timeline>('recording/timeline.json', abortSignal),
    loadPublicJson<Voice>('voice/manifest.json', abortSignal),
  ]);
  const { segments, durationInFrames } = plan(timeline, voice);
  return { durationInFrames, props: { segments }, defaultOutName: 'continuity-demo' };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
    <Composition
      id="Launch"
      component={Launch}
      width={1920}
      height={1080}
      fps={LAUNCH_FPS}
      durationInFrames={TOTAL}
      defaultProps={{ withAudio: false }}
    />
    <Folder name="Launch-Scenes">
      {SCENES.filter((s) => SCENE_COMPONENTS[s.id]).map((s) => (
        <Composition key={s.id} id={s.id} component={SCENE_COMPONENTS[s.id]} width={1920} height={1080} fps={LAUNCH_FPS} durationInFrames={s.dur} />
      ))}
    </Folder>
    <Composition
      id="Demo"
      component={Demo}
      width={1920}
      height={1080}
      fps={FPS}
      durationInFrames={FPS * 60}
      defaultProps={{ segments: [] }}
      calculateMetadata={calculateMetadata}
    />
    </>
  );
};
