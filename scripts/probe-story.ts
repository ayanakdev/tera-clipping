/**
 * Offline replay of the story contract. Loads a finished project's transcript,
 * runs the local analyser (no Gemini, no ffmpeg) and prints what a cold viewer
 * would actually see at the start and the end of each clip.
 *
 *   npx tsx scripts/probe-story.ts proj_S-5-EX6vPb
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeTranscript } from '../server/services/analyze';
import type { Project, Transcript } from '../shared/types';

const id = process.argv[2] || 'proj_S-5-EX6vPb';
const dir = path.join('data', 'projects', id);
const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as Project;
const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')) as Transcript;

const result = await analyzeTranscript({
  transcript,
  duration: project.duration,
  platform: project.platform,
  settings: { ...project.settings, aiMode: 'off', clipCount: Math.max(3, project.clips.length) },
});

const spoken = (start: number, end: number) =>
  transcript.words
    .filter((word) => word.end > start && word.start < end)
    .map((word) => word.text)
    .join(' ');

/** The words that actually belong to the clip, so a display window cannot fake an ending. */
const inside = (start: number, end: number) =>
  transcript.words.filter((word) => word.start >= start - 0.05 && word.end <= end + 0.05);

const previous = project.clips.map((clip) => `  ${clip.start.toFixed(1)}s ${JSON.stringify(clip.title)}`);
console.log(`\n${project.title}`);
console.log(`previous plan:\n${previous.join('\n')}`);
console.log(`\n${result.pool} candidates · ${result.engine} · ${result.candidates.length} clips\n`);

for (const clip of result.candidates) {
  console.log(`${clip.start.toFixed(1)}s → ${clip.end.toFixed(1)}s (${(clip.end - clip.start).toFixed(1)}s) · score ${clip.score}`);
  console.log(`  title : ${clip.title}`);
  console.log(`  hook  : ${clip.hook}`);
  console.log(`  reason: ${clip.reason}`);
  const words = inside(clip.start, clip.end);
  console.log(`  opens : ${words.slice(0, 12).map((word) => word.text).join(' ')}`);
  console.log(`  ends  : ${words.slice(-10).map((word) => word.text).join(' ')}\n`);
}
