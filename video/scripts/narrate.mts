// Voices each line of src/script.json into public/voice/<id>.wav and records the durations in
// public/voice/manifest.json. Provider is picked in this order: ElevenLabs (ELEVENLABS_API_KEY, optional
// ELEVENLABS_VOICE_ID), then OpenAI (OPENAI_API_KEY), then macOS `say` (SAY_VOICE chooses the voice).
// Keys come from ../.env when it exists, otherwise from the environment.
//
//   npm run narrate
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Script = { intro: string; idea: string; beats: string[]; finale: string; outro: string };
type Provider = 'elevenlabs' | 'openai' | 'say';
type ManifestLine = { id: string; text: string; file: string; duration: number };

const videoDir = fileURLToPath(new URL('..', import.meta.url));
const voiceDir = join(videoDir, 'public', 'voice');

const dotenv = join(videoDir, '..', '.env');
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const script = JSON.parse(readFileSync(join(videoDir, 'src', 'script.json'), 'utf8')) as Script;
const queue: { id: string; text: string }[] = [
  { id: 'intro', text: script.intro },
  { id: 'idea', text: script.idea },
  ...script.beats.map((text, i) => ({ id: `beat-${i}`, text })),
  { id: 'finale', text: script.finale },
  { id: 'outro', text: script.outro },
];

const env = process.env;
const provider: Provider = env.ELEVENLABS_API_KEY ? 'elevenlabs' : env.OPENAI_API_KEY ? 'openai' : 'say';
console.log(`[narrate] ${queue.length} lines via ${provider}`);

rmSync(voiceDir, { recursive: true, force: true });
mkdirSync(voiceDir, { recursive: true });

async function fetchAudio(url: string, label: string, init: RequestInit): Promise<Buffer> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Writes the provider's raw audio for `text` to `dest` (any format ffmpeg can read). */
async function synthesize(text: string, dest: string): Promise<void> {
  if (provider === 'elevenlabs') {
    const voiceId = env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    const audio = await fetchAudio(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, 'ElevenLabs', {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.25 },
      }),
    });
    writeFileSync(dest, audio);
    return;
  }

  if (provider === 'openai') {
    const audio = await fetchAudio('https://api.openai.com/v1/audio/speech', 'OpenAI', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: env.OPENAI_VOICE || 'onyx',
        input: text,
        instructions: 'Calm, confident keynote narrator. Unhurried. Short pauses at full stops.',
        response_format: 'wav',
      }),
    });
    writeFileSync(dest, audio);
    return;
  }

  // macOS fallback: `say` insists on an audio extension, so render to .aiff and move it into place
  const aiff = `${dest}.aiff`;
  execFileSync('say', ['-v', env.SAY_VOICE || 'Samantha', '-r', '168', '-o', aiff, text]);
  rmSync(dest, { force: true });
  execFileSync('mv', [aiff, dest]);
}

function probeSeconds(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.toString().trim());
}

async function voiceLine(id: string, text: string): Promise<ManifestLine> {
  const raw = join(voiceDir, `${id}.src`);
  const wav = join(voiceDir, `${id}.wav`);
  await synthesize(text, raw);

  // one format for every provider: 48 kHz stereo, lightly loudness-normalised
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '2', wav]);
  rmSync(raw, { force: true });

  const duration = probeSeconds(wav);
  console.log(`[narrate] ${id.padEnd(8)} ${duration.toFixed(2)}s  ${text}`);
  return { id, text, file: `voice/${id}.wav`, duration };
}

const lines: ManifestLine[] = [];
for (const { id, text } of queue) lines.push(await voiceLine(id, text));

writeFileSync(join(voiceDir, 'manifest.json'), JSON.stringify({ provider, lines }, null, 2));
console.log('[narrate] wrote public/voice/manifest.json');
