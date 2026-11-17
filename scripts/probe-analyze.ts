import type { Transcript, TranscriptSegment, Word } from '../shared/types';
import { analyzeTranscript } from '../server/services/analyze';

const script = `Okay so here is the craziest part. Everyone told me this edit was impossible. I had four hours, one laptop and no plugins. Watch what happens when I actually try it. The first render crashed immediately. Chat started spamming that it was over. But then I changed one setting and everything worked. That is actually insane. I never thought it would work but it did. After that we tried the same trick on a two hour stream. It found the best moment in under thirty seconds. The clip got a million views overnight. Nobody expected that. And that is why I keep saying local tools are underrated. If you want the full breakdown, watch the next part.`;

const words: Word[] = [];
let cursor = 0.3;
for (const token of script.split(/\s+/)) {
  const text = token.trim();
  if (!text) continue;
  const duration = Math.max(0.16, Math.min(0.55, text.length * 0.055));
  words.push({ text, start: cursor, end: cursor + duration });
  cursor += duration + 0.06;
  if (/[.!?]$/.test(text)) cursor += 0.25;
}

const segments: TranscriptSegment[] = [];
let bucket: Word[] = [];
const flush = () => {
  if (!bucket.length) return;
  segments.push({
    start: bucket[0]!.start,
    end: bucket[bucket.length - 1]!.end,
    text: bucket.map((word) => word.text).join(' '),
    words: [...bucket],
  });
  bucket = [];
};
for (const word of words) {
  bucket.push(word);
  if (/[.!?]$/.test(word.text)) flush();
}
flush();

const transcript: Transcript = {
  language: 'en',
  duration: cursor,
  words,
  segments,
  model: 'probe',
  createdAt: new Date().toISOString(),
};

const result = await analyzeTranscript({
  transcript,
  duration: cursor,
  platform: 'twitch',
  settings: { clipCount: 3, minDuration: 8, maxDuration: 22, aiMode: (process.env.USE_GEMINI ? 'smart' : 'off') as 'smart' | 'off' },
  onProgress: (progress, message) => process.stdout.write(`\r${Math.round(progress)}% ${message}          `),
});
console.log('\nengine', result.engine, 'calls', result.geminiCalls, 'cached', result.cachedCalls, 'failures', result.failures, 'pool', result.pool);
for (const candidate of result.candidates) {
  console.log(JSON.stringify({ start: candidate.start, end: candidate.end, score: candidate.score, source: candidate.source, title: candidate.title, hook: candidate.hook, category: candidate.category, reason: candidate.reason }, null, 2));
}
