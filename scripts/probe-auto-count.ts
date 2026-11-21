import fs from 'node:fs';
import { analyzeTranscript } from '../server/services/analyze';
import { store } from '../server/lib/store';

async function main() {
  await store.init();
  const id = process.argv[2] || 'proj_S-5-EX6vPb';
  const dir = `data/projects/${id}`;
  const project = JSON.parse(fs.readFileSync(`${dir}/project.json`, 'utf8'));
  const transcript = JSON.parse(fs.readFileSync(`${dir}/transcript.json`, 'utf8'));
  const audioPath = `${dir}/audio-analysis.json`;
  const audio = fs.existsSync(audioPath) ? JSON.parse(fs.readFileSync(audioPath, 'utf8')) : null;
  const result = await analyzeTranscript({
    transcript,
    duration: project.duration,
    settings: { clipCount: 0, minDuration: 18, maxDuration: 45, aiMode: 'off' },
    platform: project.platform || 'twitch',
    audio,
  });
  console.log('auto candidates:', result.candidates.length, 'pool:', result.pool, 'engine:', result.engine);
  for (const c of result.candidates.slice(0, 12)) {
    console.log(`  ${c.start.toFixed(1)}-${c.end.toFixed(1)} score=${c.score} ` +
      `parts(h=${c.scoreParts.hook},e=${c.scoreParts.emotion},react=${c.scoreParts.reaction}) ${c.title}`);
  }
}
void main();
