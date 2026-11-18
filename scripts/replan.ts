/**
 * Re-plan stored projects one at a time with the current analyser, then wait
 * for the renders to finish. Cached transcripts and audio are reused, so this
 * costs render time only.
 *
 *   npx tsx scripts/replan.ts proj_a proj_b
 */
import { store } from '../server/lib/store';
import { projectBusy, replanProject } from '../server/services/pipeline';

const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !arg.startsWith('-'));
if (!ids.length) {
  console.error('Pass at least one project id.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await store.init();

for (const id of ids) {
  const before = await store.getProject(id);
  if (!before) {
    console.log(`\n### ${id} — not found, skipped`);
    continue;
  }
  console.log(`\n### ${id} — ${before.title} (${before.clips.length} old clips)`);
  console.log('old:', before.clips.map((clip) => `${clip.start.toFixed(1)}s ${JSON.stringify(clip.title)}`).join(' | '));

  await replanProject(id);
  const started = Date.now();
  let lastStage = '';
  for (;;) {
    const project = await store.getProject(id);
    if (!project) {
      console.log('project disappeared');
      break;
    }
    const stage = `${project.progress}% ${project.stage}: ${project.message}`;
    if (stage !== lastStage) {
      lastStage = stage;
      console.log('  ' + stage);
    }
    if (['ready', 'failed', 'cancelled'].includes(project.status) && !projectBusy(id)) {
      console.log(`  STATUS ${project.status} — ${project.message}`);
      for (const clip of project.clips) {
        console.log(
          `  ${clip.start.toFixed(1)}s → ${clip.end.toFixed(1)}s (${clip.duration.toFixed(1)}s) score ${clip.score} · ${clip.status}`,
        );
        console.log(`    title : ${JSON.stringify(clip.title)}`);
        console.log(`    hook  : ${JSON.stringify(clip.hook)}`);
        console.log(`    reason: ${clip.reason}`);
        console.log(`    file  : ${clip.files.final || '(none)'}`);
      }
      break;
    }
    if (Date.now() - started > 12 * 60_000) {
      console.log('  timed out waiting');
      break;
    }
    await sleep(2000);
  }
}
console.log('\nDONE');
process.exit(0);
