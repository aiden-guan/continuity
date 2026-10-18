// Render chosen frames of a composition to PNGs and tile them into one contact sheet, for reviewing the cut.
//   node scripts/stills.mts Launch 0,60,120 [out/stills]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const [id = 'Launch', framesArg = '0', outDir = 'out/stills'] = process.argv.slice(2);
const frames = framesArg.split(',').map((s) => Number(s.trim()));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browserExecutable = existsSync(chrome) ? chrome : null;

mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts'), enableCaching: true });
const composition = await selectComposition({ serveUrl, id, browserExecutable, inputProps: {} });

const files: string[] = [];
for (const frame of frames) {
  const output = path.join(outDir, `${id}-${String(frame).padStart(5, '0')}.png`);
  await renderStill({ composition, serveUrl, output, frame, browserExecutable, imageFormat: 'png', overwrite: true });
  files.push(output);
  process.stdout.write(`${frame} `);
}
process.stdout.write('\n');

if (files.length > 1) {
  const cols = Math.min(3, files.length);
  const rows = Math.ceil(files.length / cols);
  const sheet = path.join(outDir, `${id}-sheet.png`);
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=960:-1[s${i}]`).join(';');
  const layout = files.map((_, i) => `${(i % cols) * 960}_${Math.floor(i / cols) * 540}`).join('|');
  const stack = `${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${scaled};${stack}`, '-frames:v', '1', sheet]);
  console.log(sheet, `${cols}x${rows}`);
} else {
  console.log(files[0]);
}
