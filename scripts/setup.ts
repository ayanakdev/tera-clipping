import process from 'node:process';
import { ensureAll, getBinaries } from '../server/services/binaries';

const force = process.argv.includes('--force');

console.log(`\nTeraClip Studio — local tool setup${force ? ' (forced refresh)' : ''}\n`);
console.log('Downloading only what is missing. This can take a few minutes on a fresh install.\n');

const ready = await ensureAll(force);
const bins = getBinaries();
const labels: Array<[string, keyof typeof bins]> = [
  ['ffmpeg', 'ffmpeg'],
  ['ffprobe', 'ffprobe'],
  ['yt-dlp', 'ytdlp'],
  ['whisper.cpp', 'whisper'],
  ['speech model', 'whisperModel'],
  ['face tracker', 'yunet'],
  ['caption fonts', 'fonts'],
];

for (const [label, key] of labels) {
  const info = bins[key];
  const mark = info.status === 'ready' ? 'OK  ' : 'MISS';
  const version = info.version ? `  ${info.version}` : '';
  const location = info.path ? `  ${info.path}` : '';
  console.log(`${mark} ${label.padEnd(13)}${version}${location}`);
}

if (!ready) {
  console.error('\nSome tools are missing. Check the paths above, then retry with --force.\n');
  process.exit(1);
}

console.log('\nAll local tools are ready. Start the studio with: npm run dev\n');
