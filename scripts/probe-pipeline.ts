import fsp from 'node:fs/promises';
import path from 'node:path';
import { store } from '../server/lib/store';
import { createProject } from '../server/services/pipeline';
import { bus } from '../server/lib/events';

await store.init();
const uploadDir = path.resolve('data/uploads');
await fsp.mkdir(uploadDir, { recursive: true });
const upload = path.join(uploadDir, `probe-${Date.now()}.mp4`);
await fsp.copyFile('data/tmp/probe/out.mp4', upload);

const project = await createProject({
  title: 'Pipeline probe',
  platform: 'youtube',
  sourceKind: 'upload',
  filePath: upload,
  settings: {
    clipCount: 2,
    minDuration: 5,
    maxDuration: 10,
    aspect: '9:16',
    captionPreset: 'tera-box',
    hookStyle: 'white',
    pacing: 'balanced',
    reframe: 'center',
    quality: 'fast',
    aiMode: 'off',
    asrModel: 'base.en',
    language: 'en',
    audioEnhance: true,
    watermark: true,
  },
});
console.log('created', project.id);

bus.on('project.progress', (event) => {
  if (event.projectId === project.id) process.stdout.write(`\r${event.progress}% ${event.stage}: ${event.message}          `);
});
bus.on('project.log', (event) => {
  if (event.projectId === project.id) console.log(`\n[${event.level}] ${event.message}`);
});
bus.on('toast', (event) => console.log('\nTOAST', event.title, event.message || ''));

const started = Date.now();
for (;;) {
  const fresh = await store.getProject(project.id);
  if (!fresh) throw new Error('project disappeared');
  if (['ready', 'failed', 'cancelled'].includes(fresh.status)) {
    console.log('\nSTATUS', fresh.status, fresh.message);
    console.log('clips', fresh.clips.map((clip) => ({ id: clip.id, start: clip.start, end: clip.end, status: clip.status, hook: clip.hook, title: clip.title, files: clip.files, words: clip.words.length, error: clip.error })));
    console.log('stats', fresh.stats);
    break;
  }
  if (Date.now() - started > 8 * 60_000) throw new Error('timeout');
  await new Promise((resolve) => setTimeout(resolve, 800));
}
process.exit(0);
