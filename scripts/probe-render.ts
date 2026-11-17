import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ClipRecord, Word } from '../shared/types';
import { probeMedia } from '../server/services/media';
import { renderClip } from '../server/services/render';
import { toData } from '../server/config';

const source = 'data/tmp/reframe-test.mp4';
const probe = await probeMedia(source);
const projectDir = path.resolve('data/tmp/render-probe');
await fsp.rm(projectDir, { recursive: true, force: true });
await fsp.mkdir(path.join(projectDir, 'clips'), { recursive: true });

const words: Word[] = `everyone said this edit was impossible but watch what happens next it is actually insane and i never thought it would work but it did`.split(' ').map((text, i) => ({
  text,
  start: 0.2 + i * 0.34,
  end: 0.2 + i * 0.34 + 0.3,
}));

const clip = {
  id: 'clip_probe',
  projectId: 'proj_probe',
  index: 0,
  start: 0,
  end: 8,
  duration: 8,
  title: 'Probe clip',
  hook: 'He said this was impossible 😳',
  hooks: [],
  caption: '',
  hashtags: [],
  transcript: '',
  words,
  score: 80,
  scoreParts: {},
  reason: 'probe',
  category: 'test',
  source: 'local',
  status: 'planned',
  progress: 0,
  stage: 'planned',
  captionPreset: 'tera-box',
  hookStyle: 'white',
  framing: 'smart',
  files: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as ClipRecord;

const result = await renderClip({
  clip,
  sourcePath: path.resolve(source),
  projectDir,
  words,
  aspect: '9:16',
  quality: 'fast',
  audioEnhance: false,
  watermark: true,
  brandHandle: '@teraclip',
  sourceWidth: probe.displayWidth,
  sourceHeight: probe.displayHeight,
  onProgress: (progress, stage) => {
    if (progress % 10 === 0) process.stdout.write(`\r${progress}% ${stage}   `);
  },
});
console.log('\nresult', { ...result, files: result.files });
console.log('media paths', Object.fromEntries(Object.entries(result.files).map(([k, v]) => [k, toData(path.resolve('data', v!))])));

for (const t of [1, 4, 7]) {
  const { execFileSync } = await import('node:child_process');
  const ffmpeg = (await import('ffmpeg-static')).default as unknown as string;
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', path.resolve('data', result.files.final!), '-frames:v', '1', `data/tmp/render-probe/frame-${t}.png`], { stdio: 'inherit' });
}
console.log('frames written');
