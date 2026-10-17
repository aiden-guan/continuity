// Captures the real Continuity demo for the video — no mock-ups. It boots the stage server (engine plus
// genuine agent processes), drives the site in Chrome by pressing → once per beat, and grabs every
// repaint from the Chrome DevTools screencast. Writes to public/recording/:
//   hero.mp4       landing-page hero (headline and the thread animation)
//   live.mp4       presenter view, every beat through to the closing card
//   timeline.json  start/finish of each beat, in seconds from the first frame of live.mp4
//
//   npm run record              # Claude extractor + Claude agents if ../.env has ANTHROPIC_API_KEY
//   npm run record -- --offline # rule extractor + policy agents: quick and deterministic
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false },
    headless: { type: 'boolean', default: false },
    port: { type: 'string', default: '4010' },
  },
});

const videoDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(videoDir, '..');
const outDir = join(videoDir, 'public', 'recording');
const siteUrl = `http://localhost:${opts.port}`;
const WIDTH = 1920;
const HEIGHT = 1080;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clock = () => Date.now() / 1000;
const say = (msg: string) => console.log(`[record] ${msg}`);

// ================================================================ stage server

const stageArgs = [
  '--env-file-if-exists=.env',
  'scripts/stage.ts',
  '--port', opts.port,
  '--engine-port', String(Number(opts.port) + 101),
  '--db', 'data/stage-record.db',
];
if (opts.offline) stageArgs.push('--offline');

const stage = spawn(process.execPath, stageArgs, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
stage.stdout!.on('data', (chunk) => {
  const indented = String(chunk)
    .split('\n')
    .filter(Boolean)
    .map((line) => `  ${line}\n`)
    .join('');
  process.stdout.write(indented);
});
stage.stderr!.on('data', (chunk) => process.stderr.write(String(chunk)));

function stopStage() {
  if (stage.exitCode === null) stage.kill();
}
process.on('exit', stopStage);
process.on('SIGINT', () => process.exit(130));

type StageStatus = {
  cursor: number;
  busy: boolean;
  error: string | null;
  beats: { title: string; caption: string }[];
};

async function stageStatus(): Promise<StageStatus> {
  const res = await fetch(`${siteUrl}/stage/status`);
  return (await res.json()) as StageStatus;
}

for (let attempt = 0; ; attempt++) {
  try {
    await stageStatus();
    break;
  } catch {
    if (attempt > 200) throw new Error('stage did not start');
    await wait(150);
  }
}

// ================================================================ screencast recorder

type Shot = { ts: number; file: string };

/** Turns variable-rate screencast frames into an ffmpeg concat list: each frame lasts until the next arrives. */
function concatList(shots: Shot[], endTs: number): string {
  const entries = shots.map((shot, i) => {
    const nextTs = shots[i + 1]?.ts ?? endTs;
    return `file '${shot.file}'\nduration ${Math.max(0.001, nextTs - shot.ts).toFixed(4)}`;
  });
  // concat demuxer quirk: the final file must be listed again for its duration to count
  return entries.join('\n') + `\nfile '${shots.at(-1)!.file}'\n`;
}

async function record(page: Page, name: string, script: (elapsed: () => number) => Promise<void>): Promise<number> {
  const framesDir = join(outDir, `.frames-${name}`);
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const session: CDPSession = await page.context().newCDPSession(page);
  const shots: Shot[] = [];
  session.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = join(framesDir, `${String(shots.length).padStart(6, '0')}.jpg`);
    shots.push({ ts: metadata.timestamp ?? clock(), file });
    writeFileSync(file, Buffer.from(data, 'base64'));
    await session.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  });

  while (shots.length === 0) await wait(20);
  const firstTs = shots[0].ts;
  await script(() => clock() - firstTs);
  const lastTs = clock();
  await session.send('Page.stopScreencast');
  await wait(200);

  const listFile = join(framesDir, 'list.txt');
  writeFileSync(listFile, concatList(shots, lastTs));
  const mp4 = join(outDir, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=30,scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
    '-movflags', '+faststart',
    mp4,
  ]);
  rmSync(framesDir, { recursive: true, force: true });

  const seconds = lastTs - firstTs;
  say(`${name}.mp4 — ${seconds.toFixed(1)}s from ${shots.length} frames`);
  return seconds;
}

// ================================================================ browser

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: opts.headless,
  args: [`--window-size=${WIDTH},${HEIGHT + 120}`, '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
});
const page = await context.newPage();

// ---- take 1: landing hero
await page.goto(`${siteUrl}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await wait(600);
const heroSeconds = await record(page, 'hero', () => wait(11000));

// ---- take 2: the live story in the presenter view
await page.goto(`${siteUrl}/live`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await wait(1500);

const initial = await stageStatus();
const beatCount = initial.beats.length;
const beats: { index: number; title: string; caption: string; start: number; end: number }[] = [];
let finale = 0;

async function waitForBeat(i: number) {
  for (;;) {
    await wait(250);
    const s = await stageStatus();
    if (s.error) throw new Error(`beat ${i + 1} failed: ${s.error}`);
    if (s.cursor > i && !s.busy) return;
  }
}

const liveSeconds = await record(page, 'live', async (elapsed) => {
  await wait(2500);
  for (let i = 0; i < beatCount; i++) {
    const { title, caption } = initial.beats[i];
    const start = elapsed();
    await page.keyboard.press('ArrowRight');
    say(`beat ${i + 1}: ${title}`);
    await waitForBeat(i);
    const end = elapsed();
    beats.push({ index: i, title, caption, start, end });

    if (i === beatCount - 1) {
      // the closing card shows up 2.6 s after the final beat and stays roughly 5 s
      finale = end + 2.6;
      await wait(9500);
    } else {
      // reading time; a little longer after the beats where an agent writes
      await wait(i === 5 || i === 7 ? 5000 : 3500);
    }
  }
});

const timeline = {
  recorded_at: new Date().toISOString(),
  mode: opts.offline ? 'offline' : 'claude',
  hero: { file: 'recording/hero.mp4', duration: heroSeconds },
  live: { file: 'recording/live.mp4', duration: liveSeconds, beats, finale },
};
writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
say(`timeline.json — ${beats.length} beats, finale at ${finale.toFixed(1)}s`);

await browser.close();
stopStage();
process.exit(0);
