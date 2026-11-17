import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import { store } from '../server/lib/store';
import { bus } from '../server/lib/events';
import { editClip } from '../server/services/pipeline';

await store.init();
const projectId = process.argv[2];
if (!projectId) throw new Error('pass a project id');
const project = await store.getProject(projectId);
if (!project) throw new Error('project not found');
const clip = project.clips[0]!;
console.log('before', { id: clip.id, start: clip.start, end: clip.end, hook: clip.hook, preset: clip.captionPreset, files: clip.files, words: clip.words.length });

bus.on('clip.updated', (event) => {
  if (event.projectId === projectId) process.stdout.write(`\rclip ${event.clip.status} ${event.clip.progress}% ${event.clip.stage}      `);
});
bus.on('toast', (event) => console.log('\nTOAST', event.title, event.message || ''));

const started = Date.now();
await editClip(projectId, clip.id, {
  hook: 'This changed everything 🤯',
  captionPreset: 'purple-pop',
  hookStyle: 'purple',
});
console.log('\nedit returned, waiting for render…');
for (;;) {
  const fresh = await store.getProject(projectId);
  const target = fresh?.clips.find((item) => item.id === clip.id);
  if (target && target.status !== 'rendering') {
    console.log('\nafter', {
      status: target.status,
      hook: target.hook,
      preset: target.captionPreset,
      hookStyle: target.hookStyle,
      files: target.files,
      error: target.error,
    });
    const finalPath = path.resolve('data', target.files.final || '');
    console.log('final exists', fs.existsSync(finalPath), finalPath);
    break;
  }
  if (Date.now() - started > 180_000) throw new Error('timeout');
  await new Promise((resolve) => setTimeout(resolve, 600));
}

// Boundary change forces new words + new face analysis.
const fresh = await store.getProject(projectId);
const again = fresh!.clips[0]!;
console.log('\nshrinking clip from', again.start, again.end);
await editClip(projectId, again.id, { start: again.start + 0.6, end: again.end - 0.5 });
const start2 = Date.now();
for (;;) {
  const latest = await store.getProject(projectId);
  const target = latest?.clips.find((item) => item.id === again.id);
  if (target && target.status !== 'rendering') {
    console.log('\nboundary after', { status: target.status, start: target.start, end: target.end, words: target.words.length, files: target.files, error: target.error });
    break;
  }
  if (Date.now() - start2 > 180_000) throw new Error('timeout 2');
  await new Promise((resolve) => setTimeout(resolve, 600));
}
console.log('done');
process.exit(0);
