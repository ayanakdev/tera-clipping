import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { probeMedia } from '../server/services/media';
import { planReframe } from '../server/services/reframe';
import { ASPECT_SIZES } from '../shared/presets';

const ffmpeg = ffmpegPath as unknown as string;
const test = 'data/tmp/reframe-test.mp4';
fs.mkdirSync('data/tmp/reframe-out', { recursive: true });

if (!fs.existsSync(test)) {
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-t',
      '8',
      '-i',
      'assets/hooking caption/marlon.webp',
      '-f',
      'lavfi',
      '-t',
      '8',
      '-i',
      'color=c=#15121c:s=1920x1080:r=30',
      '-filter_complex',
      "[0:v]scale=-2:1080[img];[1:v][img]overlay=x='(t/8)*840':y=0:shortest=1,format=yuv420p[v]",
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      test,
    ],
    { stdio: 'inherit' },
  );
}

const probe = await probeMedia(test);
const width = probe.displayWidth;
const height = probe.displayHeight;
const aspect = '9:16' as const;
const out = ASPECT_SIZES[aspect];
console.log('source', { width, height });

const plan = await planReframe({
  sourcePath: test,
  start: 0,
  duration: 8,
  sourceWidth: width,
  sourceHeight: height,
  aspect,
  mode: 'smart',
  outputWidth: out.width,
  outputHeight: out.height,
  onProgress: (ratio) => {
    if (Math.round(ratio * 100) % 25 === 0) process.stdout.write(`\ranalysis ${Math.round(ratio * 100)}%`);
  },
});
process.stdout.write('\n');
console.log('mode', plan.mode, 'faces', plan.faceSamples.length);
console.log(
  'samples',
  plan.faceSamples.map((s) => ({ t: s.t, x: +s.x.toFixed(3), w: +s.w.toFixed(3), faces: s.faces })),
);
console.log('filter', plan.filter.slice(0, 500));

const filtered = `setpts=PTS-STARTPTS,${plan.filter}`;
execFileSync(
  ffmpeg,
  ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0', '-t', '8', '-i', test, '-vf', filtered, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', `${'data/tmp/reframe-out'}/out.mp4`],
  { stdio: 'inherit' },
);

for (const t of [1, 3, 5, 7]) {
  execFileSync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', 'data/tmp/reframe-out/out.mp4', '-frames:v', '1', `data/tmp/reframe-out/frame-${t}.png`],
    { stdio: 'inherit' },
  );
}
console.log('wrote frames');
