import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { Word } from '../shared/types';
import { writeCaptionFiles } from '../server/services/captions';
import { renderHookPng } from '../server/services/hook';

const words: Word[] = [
  ['Okay', 0.11, 0.38],
  ['so', 0.38, 0.57],
  ['here', 0.57, 0.95],
  ['is', 0.95, 1.14],
  ['the', 1.14, 1.42],
  ['craziest', 1.42, 2.58],
  ['part.', 2.58, 3.05],
  ['I', 3.05, 3.11],
  ['never', 3.11, 3.39],
  ['thought', 3.39, 3.86],
  ['this', 3.86, 4.15],
  ['would', 4.15, 4.49],
  ['actually', 4.49, 5.0],
  ['work,', 5.0, 5.56],
  ['but', 5.56, 5.68],
  ['it', 5.68, 5.76],
  ['did.', 5.76, 6.0],
  ['Look', 6.88, 7.0],
  ['at', 7.0, 7.12],
  ['this.', 7.12, 7.52],
  ['That', 7.52, 8.15],
  ['is', 8.15, 8.39],
  ['insane.', 8.39, 9.99],
  ['Wait,', 9.99, 10.54],
  ['wait,', 10.54, 11.37],
  ['wait.', 11.37, 12.44],
  ['You', 12.44, 12.59],
  ['have', 12.59, 12.84],
  ['to', 12.84, 12.96],
  ['see', 12.96, 13.44],
  ['this.', 13.44, 14.0],
  ['Everybody', 14.4, 14.9],
  ['was', 14.9, 15.06],
  ['saying', 15.06, 15.3],
  ['it', 15.3, 15.4],
  ['was', 15.4, 15.6],
  ['impossible.', 15.6, 16.4],
  ['And', 16.4, 16.51],
  ['then...', 16.6, 17.34],
  ['boom.', 17.6, 18.13],
  ['We', 18.56, 19.08],
  ['did', 19.08, 19.35],
  ['it.', 19.35, 19.96],
].map(([text, start, end]) => ({ text: String(text), start: Number(start), end: Number(end) }));

fs.mkdirSync('data/tmp/probe', { recursive: true });
await writeCaptionFiles(words, 'data/tmp/probe/cap.ass', 'data/tmp/probe/cap.srt', {
  preset: 'tera-box',
  aspect: '9:16',
  duration: 20,
});
await renderHookPng({
  text: "Marlon's cameraman caught him edit farming 😭🔥",
  style: 'white',
  aspect: '9:16',
  out: 'data/tmp/probe/hook.png',
});
const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=20',
  '-i', path.join(process.env.TEMP || '.', 'teraclip-test.wav'),
  '-i', 'data/tmp/probe/hook.png',
  '-filter_complex',
  `[0:v]subtitles=filename=data/tmp/probe/cap.ass:fontsdir=tools/fonts[cap];[cap][2:v]overlay=0:0[v]`,
  '-map', '[v]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
  '-c:a', 'aac', '-shortest', 'data/tmp/probe/out.mp4',
];
const ffmpeg = ffmpegPath as string;
execFileSync(ffmpeg, args, { stdio: 'inherit' });
for (const t of [1.9, 8.7, 10.2, 15.9]) {
  execFileSync(ffmpeg, ['-y','-hide_banner','-loglevel','error','-ss',String(t),'-i','data/tmp/probe/out.mp4','-frames:v','1',`data/tmp/probe/frame-${t}.png`], { stdio: 'inherit' });
}
console.log('done');
