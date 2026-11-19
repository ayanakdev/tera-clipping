import type {
  AiMode,
  ClipCandidate,
  ClipSettings,
  HeatPoint,
  HookOption,
  PlatformId,
  ScoreParts,
  Transcript,
  TranscriptSegment,
  Word,
} from '../../shared/types';
import { log } from '../lib/logger';
import type { AudioAnalysis } from './audio';
import { geminiAvailable, geminiBudgetLeft, geminiJson, parseJsonLoose } from './gemini';
import { isSpeakableToken, stripSoundTags } from '../../shared/utils';

const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves`.split(
    /\s+/,
  ),
);

const HOOK_WORDS = [
  'never',
  'nobody',
  'everyone',
  'actually',
  'insane',
  'crazy',
  'secret',
  'worst',
  'best',
  'free',
  'broke',
  'prove',
  'proved',
  'exposed',
  'caught',
  'warning',
  'watch',
  'look',
  'listen',
  'imagine',
  'what if',
  "you won't",
  'you wont',
  'nobody',
  'finally',
  'literally',
  'unbelievable',
  'impossible',
  'shocked',
  'unexpected',
  'mistake',
  'truth',
  'hate',
  'love',
  'ruined',
  'destroyed',
  'clutch',
  'banned',
  'fired',
  'quit',
  'rich',
  'money',
  'million',
  'dollar',
  'why',
  'how',
];
const EMOTION_WORDS = [
  'insane',
  'crazy',
  'unbelievable',
  'shocked',
  'scared',
  'angry',
  'furious',
  'crying',
  'laughing',
  'dead',
  'dying',
  'hilarious',
  'wild',
  'nuts',
  'omg',
  'bro',
  'no way',
  'what',
  'holy',
  'damn',
  'fuck',
  'shit',
  'love',
  'hate',
  'obsessed',
  'amazing',
  'terrible',
  'worst',
  'best',
  'epic',
  'clutch',
  'chills',
];
const PAYOFF_WORDS = [
  'so',
  "that's why",
  'thats why',
  'turns out',
  'ended up',
  'in the end',
  'worked',
  'made it',
  'won',
  'lost',
  'never again',
  'now',
  'look',
  'watch',
  'boom',
  'insane',
  'crazy',
  'unbelievable',
  'and then',
  'because of that',
  'which means',
];
const PAYOFF_END = [
  'that',
  'it',
  'this',
  'everything',
  'nothing',
  'money',
  'insane',
  'crazy',
  'done',
  'over',
  'won',
  'lost',
  'worked',
  'happened',
];

const PRONOUN_START = new Set(['it', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'him', 'her', 'them']);
const FILLER_START = new Set(['so', 'okay', 'ok', 'and', 'but', 'like', 'uh', 'um', 'yeah', 'well', 'now', 'then', 'anyway']);
const LEADING_FILLER =
  /^(?:so|okay|ok|and|but|like|uh|um|yeah|well|now|then|anyway|honestly|literally|oh|ah|yo|hey|bro|right|alright|hmm)[,\s]+/i;
const SENTENCE_END = /[.!?…]["')\]]?$/;
const DANGLING_END =
  /\b(and|but|so|or|because|if|when|while|with|to|of|for|the|a|an|my|your|his|her|their|our|i|we|they|he|she|it|that|this|is|was|are|were|im|i'm|like|than|then|as|at|on|in|could|would|should|will|can|may|might|must|do|does|did|have|has|had|not|it's|that's|i'm|you're|we're|they're|he's|she's|there's|what's|let's|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't)$/i;
const QUESTION_START =
  /^(?:what|why|how|who|which|when|where|whose|is|are|was|were|do|does|did|can|could|would|should|have|has|will)\b/i;
const ANSWER_START = /^(?:[$€£]\s?\d|\d)/;
const SHORT_ANSWER =
  /^(?:yes|yeah|no|nah|maybe|exactly|right|correct|wrong|true|false|a|b|c|d)\b/i;

type PoolEntry = {
  start: number;
  end: number;
  unit: Unit;
  units: Unit[];
  firstIndex: number;
  lastIndex: number;
  text: string;
  wordCount: number;
};

/**
 * A sentence that opens with "it", "that", an answer like "$440", or a dangling
 * "and" only makes sense with the sentence before it. Questions and unfinished
 * sentences also give the next line its setup. Include that lead-in when it is
 * close enough, which is what stops clips from starting mid-thought.
 */
function openingNeedsContext(unit: Unit, prev?: Unit): boolean {
  const text = unit.text.trim();
  const words = textWords(text);
  const first = words[0] || '';
  if (PRONOUN_START.has(first)) return true;
  // "I mean…", "yeah…", "okay…" continue a thought that came before; without
  // that thought the clip starts in the middle of a sentence, not a story.
  if (FILLER_START.has(first)) return true;
  if (/^i mean\b/i.test(text)) return true;
  if (words.length <= 4) return true;
  if (ANSWER_START.test(text)) return true;
  if (!prev || unit.start - prev.end > 3.2) return false;
  if (endingNeedsContext(unit) && looksLikeQuestion(prev)) return true;
  if (endingNeedsContext(prev)) return true;
  if (looksLikeQuestion(prev) && (textWords(text).length <= 6 || SHORT_ANSWER.test(text))) return true;
  return false;
}

function looksLikeQuestion(unit: Unit): boolean {
  const text = unit.text.trim();
  return /\?["')\]]*$/.test(text) || (QUESTION_START.test(text) && textWords(text).length <= 18);
}

function endingNeedsContext(unit: Unit): boolean {
  const text = unit.text.trim();
  if (!text) return false;
  if (SENTENCE_END.test(text)) return false;
  // A line that stops on a comma or colon is half a sentence; the rest is next.
  if (/[,;:]$/.test(text)) return true;
  const tail = textWords(text).slice(-1)[0] || '';
  return DANGLING_END.test(tail);
}

/**
 * Walk backwards from a candidate until its opening stands on its own.
 * "It sold for $440" needs the line naming the item; "No." needs the question
 * before it. This is the setup a cold viewer is missing when a clip opens on a
 * random point, so the range is widened before it is ever scored.
 */
function expandStart(units: Unit[], firstIndex: number, lastIndex: number, maxDuration: number): number {
  let first = firstIndex;
  for (let step = 0; step < 4; step++) {
    const prev = units[first - 1];
    if (!prev) break;
    const current = units[first]!;
    if (!openingNeedsContext(current, prev)) break;
    if (current.start - prev.end > 4.5) break;
    if (units[lastIndex]!.end - prev.start > maxDuration) break;
    first -= 1;
  }
  return first;
}

/**
 * The questions an editor asks a clip before posting it, answered locally so a
 * cold viewer never lands mid-thought. These are also handed to Gemini, so the
 * cloud pass judges a clip the same way the local brain does.
 */
export interface StoryCheck {
  /** 0–100: the first line names the subject instead of leaning on a missing line. */
  setup: number;
  /** 0–100: a question raised inside the clip is answered inside the clip. */
  resolution: number;
  /** 0–100: the last line lands on a finished sentence. */
  ending: number;
  passes: boolean;
  note: string;
}

const RESOLUTION_PHRASES = [
  'because',
  'which means',
  'turns out',
  'ended up',
  'in the end',
  "that's why",
  'thats why',
  'the answer is',
  'there it is',
  'there you go',
  'so yeah',
  'so basically',
];

function isAnswerUnit(unit: Unit): boolean {
  const text = unit.text.trim();
  if (!text) return false;
  if (ANSWER_START.test(text) || SHORT_ANSWER.test(text)) return true;
  return countMatches(text, RESOLUTION_PHRASES) > 0;
}

/**
 * A question is usually answered in the sentence right after it. Ending on the
 * question — or one sentence before the answer — is the cut-off feeling viewers
 * complain about, so the end snaps forward to the unit that answers it.
 */
function closeOnAnswer(units: Unit[], firstIndex: number, lastIndex: number, maxDuration: number): number {
  // Check every question in the window, not just the last one, and accept only
  // a substantive answer — a one-word "Yeah" is not the payoff.
  const isSubstantiveAnswer = (text: string): boolean =>
    countMatches(text, RESOLUTION_PHRASES) > 0 ||
    (ANSWER_START.test(text) && textWords(text).length > 2);
  let unanswered = -1;
  for (let i = firstIndex; i <= lastIndex; i++) {
    if (!looksLikeQuestion(units[i]!)) continue;
    const answered = units.slice(i + 1, lastIndex + 1).some((unit) => isSubstantiveAnswer(unit.text.trim()));
    if (!answered) {
      unanswered = i;
      break;
    }
  }
  if (unanswered < 0) return lastIndex;

  let last = lastIndex;
  for (let step = 0; step < 6; step++) {
    const next = units[last + 1];
    if (!next) break;
    if (next.start - units[last]!.end > 3) break;
    if (next.end - units[firstIndex]!.start > maxDuration) break;
    last += 1;
    const text = units[last]!.text.trim();
    if (isSubstantiveAnswer(text) && SENTENCE_END.test(text)) break;
    if (SENTENCE_END.test(text) && textWords(text).length >= 5 && last > unanswered + 1) break;
  }
  return last;
}

function storyCheckFor(units: Unit[], firstIndex: number, lastIndex: number): StoryCheck {
  const slice = units.slice(firstIndex, lastIndex + 1);
  const closer = slice[slice.length - 1]!.text.trim();
  const opener = slice[0]?.text.trim() || '';
  const openerWords = textWords(opener);
  const firstWord = openerWords[0] || '';
  // At the video's own first line there is no earlier speech to recover, so a
  // pronoun is not a missing premise — the clip simply starts where the video does.
  const atStart = firstIndex === 0;
  let setup = 100;
  if (!atStart && PRONOUN_START.has(firstWord)) setup -= 70;
  if (!atStart && (FILLER_START.has(firstWord) || /^i mean\b/i.test(opener))) setup -= 55;
  if (ANSWER_START.test(opener)) setup -= 30;
  if (opener.length < 24) setup -= 22;
  if (meaningfulWords(opener).size >= 2) setup += 8;
  setup = Math.round(clamp01(setup / 100) * 100);

  const questionIndexes: number[] = [];
  slice.forEach((unit, index) => {
    if (looksLikeQuestion(unit)) questionIndexes.push(index);
  });

  let resolution = 45;
  if (questionIndexes.length) {
    const answered = questionIndexes.some((questionIndex) => {
      if (questionIndex >= slice.length - 1) return false;
      for (let i = questionIndex + 1; i < slice.length; i++) {
        const text = slice[i]!.text.trim();
        if (ANSWER_START.test(text) && textWords(text).length > 2) return true;
        if (countMatches(text, RESOLUTION_PHRASES) > 0) return true;
      }
      // Three later sentences do not prove the question was answered.
      return false;
    });
    resolution = answered ? 92 : 20;
  } else {
    const tail = slice
      .slice(-2)
      .map((unit) => unit.text.toLowerCase())
      .join(' ');
    if (countMatches(tail, PAYOFF_WORDS) > 0) resolution = 88;
    else if (SENTENCE_END.test(closer) && slice.length >= 3) resolution = 70;
    else if (slice.length >= 3) resolution = 50;
    else resolution = 35;
  }

  const closerWords = textWords(closer);
  const closerIsQuestion = looksLikeQuestion(slice[slice.length - 1]!);
  // Ending on the question means the clip stops before the answer.
  if (closerIsQuestion) resolution = Math.min(resolution, 15);

  // A clip must land on a finished sentence. Whisper often omits final
  // punctuation, so a plain default score used to let cut-off lines through.
  let ending = 35;
  if (SENTENCE_END.test(closer)) ending = 100;
  if (closerIsQuestion) ending = Math.min(ending, 62);
  const tailWord = closerWords[closerWords.length - 1] || '';
  if (!SENTENCE_END.test(closer) && DANGLING_END.test(tailWord)) ending = 18;
  if (/[,;:]$/.test(closer)) ending = Math.min(ending, 30);

  const passes = setup >= 55 && resolution >= 55 && ending >= 65;
  const note = passes
    ? 'Context check passed: setup, beat and payoff all land inside the clip.'
    : setup < 55
      ? 'Context check failed: opens mid-thought, a cold viewer would not know what is being discussed.'
      : resolution < 50
        ? 'Context check failed: raises a question it never answers.'
        : 'Context check failed: stops before the sentence finishes.';
  return { setup, resolution, ending, passes, note };
}

const CATEGORY_WORDS: Record<string, string[]> = {
  funny: ['laugh', 'laughing', 'funny', 'joke', 'hilarious', 'dead', 'lmao', 'lol', 'rofl', 'clown', 'troll'],
  clutch: ['clutch', 'ace', '1v', 'last second', 'choke', 'won the', 'won it', 'match point'],
  story: ['story', 'one time', 'so i', 'when i', 'happened', 'turns out', 'ended up', 'years ago', 'back in'],
  'hot take': ['unpopular', 'hot take', 'opinion', 'actually', 'wrong', 'hate', 'overrated', 'underrated', 'controversial'],
  wholesome: ['thank', 'love', 'appreciate', 'wholesome', 'heart', 'cute', 'community', 'kind'],
  reaction: ['react', 'reaction', 'look at', 'watching', 'chat', 'clip', 'caught', 'camera'],
  tutorial: ['how to', 'tip', 'step', 'tutorial', 'guide', 'setup', 'settings', 'learn', 'advice'],
};

const EMOJI = ['😳', '😭', '🔥', '🤯', '👀', '💀', '😅', '🚨'];
const PLATFORM_TAG: Record<PlatformId, string> = {
  youtube: '#youtube',
  twitch: '#twitch',
  kick: '#kick',
  x: '#x',
  rumble: '#rumble',
  tiktok: '#tiktok',
  instagram: '#reels',
  vimeo: '#vimeo',
  upload: '#creator',
  generic: '#clips',
};

interface Unit {
  index: number;
  start: number;
  end: number;
  text: string;
  words: TranscriptSegment['words'];
  low: string;
}

interface WorkingCandidate extends ClipCandidate {
  baseScore: number;
  textSet: Set<string>;
  excerpt: string;
  story: StoryCheck;
}

interface Series {
  points: Array<{ t: number; value: number }>;
  prefix: number[];
  p60: number;
  p95: number;
  peaks: Array<{ t: number; score: number }>;
}

function makeSeries(
  points: Array<{ t: number; value: number }> | undefined,
  peaks: Array<{ t: number; score: number }> | undefined,
): Series | null {
  if (!points?.length) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const prefix = [0];
  for (const point of sorted) prefix.push(prefix[prefix.length - 1]! + point.value);
  const values = sorted.map((point) => point.value).sort((a, b) => a - b);
  return {
    points: sorted,
    prefix,
    p60: values[Math.floor(values.length * 0.6)] ?? 0,
    p95: values[Math.floor(values.length * 0.95)] ?? 1,
    peaks: peaks || [],
  };
}

function lowerBound(points: Array<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function seriesScore(series: Series | null, start: number, end: number, fallback = 0.45): number {
  if (!series) return fallback;
  const from = lowerBound(series.points, start - 0.5);
  const to = lowerBound(series.points, end + 0.5);
  if (to <= from) return fallback;
  const mean = (series.prefix[to]! - series.prefix[from]!) / (to - from);
  let peak = 0;
  for (const item of series.peaks) {
    if (item.t >= start && item.t <= end && item.score > peak) peak = item.score;
  }
  return clamp01(normalizeAgainst(mean, series.p60, series.p95) * 0.62 + peak * 0.38);
}


export interface AnalyzeInput {
  transcript: Transcript;
  duration: number;
  settings: Pick<ClipSettings, 'clipCount' | 'minDuration' | 'maxDuration' | 'aiMode'>;
  platform: PlatformId;
  audio?: AudioAnalysis | null;
  chatHeat?: HeatPoint[];
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

export interface AnalyzeResult {
  candidates: ClipCandidate[];
  engine: string;
  geminiCalls: number;
  cachedCalls: number;
  failures: number;
  pool: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function textWords(text: string): string[] {
  return stripSoundTags(text)
    .toLowerCase()
    .replace(/[^a-z0-9'$% ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && isSpeakableToken(word));
}

function meaningfulWords(text: string): Set<string> {
  return new Set(textWords(text).filter((word) => word.length > 2 && !STOPWORDS.has(word)));
}

function countMatches(text: string, list: string[]): number {
  const haystack = ` ${text.toLowerCase()} `;
  let count = 0;
  for (const needle of list) {
    if (haystack.includes(` ${needle} `) || haystack.includes(`${needle} `) || haystack.includes(` ${needle}`)) count += 1;
  }
  return count;
}

/** Whisper segments often hold several sentences, so split them before cutting. */
function splitSegmentSentences(words: Word[]): Word[][] {
  const chunks: Word[][] = [];
  let current: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    current.push(word);
    const next = words[i + 1];
    const gap = next ? next.start - word.end : 0;
    if (SENTENCE_END.test(word.text) || (next && gap > 1.5 && current.length >= 4)) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  // A one-word fragment like "Yeah." belongs with the sentence beside it.
  const merged: Word[][] = [];
  for (const chunk of chunks) {
    if (chunk.length < 3 && merged.length) {
      merged[merged.length - 1] = [...merged[merged.length - 1]!, ...chunk];
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function sentenceUnits(transcript: Transcript): Unit[] {
  const units: Unit[] = [];
  const push = (words: Word[]) => {
    const text = words
      .map((word) => word.text)
      .join(' ')
      .replace(/\s+([,.!?;:…])/g, '$1')
      .trim();
    if (!text) return;
    units.push({
      index: units.length,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text,
      words,
      low: text.toLowerCase(),
    });
  };
  for (const segment of transcript.segments) {
    const words = (segment.words || [])
      .map((word) => ({ ...word, text: stripSoundTags(String(word.text || '')).trim() }))
      .filter((word) => word.text && isSpeakableToken(word.text));
    if (!words.length) continue;
    for (const chunk of splitSegmentSentences(words)) push(chunk);
  }

  if (units.length) return units;

  // Fallback for transcripts without sentence metadata.
  const words = transcript.words
    .map((word) => ({ ...word, text: stripSoundTags(String(word.text || '')).trim() }))
    .filter((word) => word.text && isSpeakableToken(word.text));
  const out: Unit[] = [];
  let bucket: typeof words = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push({
      index: out.length,
      start: bucket[0]!.start,
      end: bucket[bucket.length - 1]!.end,
      text: bucket.map((word) => word.text).join(' '),
      words: [...bucket],
      low: bucket.map((word) => word.text.toLowerCase()).join(' '),
    });
    bucket = [];
  };
  for (const word of words) {
    bucket.push(word);
    if (bucket.length >= 14 || /[.!?]$/.test(word.text)) flush();
  }
  flush();
  return out;
}

function normalizeAgainst(value: number, baseline: number, ceiling: number): number {
  if (ceiling <= baseline) return 0.45;
  return clamp01((value - baseline) / (ceiling - baseline));
}

function hookPart(text: string): number {
  const low = text.toLowerCase();
  let score = 0.22;
  if (/^(what|why|how|did|have|do|would|could|can|is|are|should)\b/.test(low)) score += 0.1;
  if (low.includes('?')) score += 0.11;
  if (/\d/.test(low) || /\b(million|thousand|hundred|dollar|grand)\b/.test(low)) score += 0.13;
  score += Math.min(0.32, countMatches(low, HOOK_WORDS) * 0.09);
  if (/\b(you|your|you're|yourself)\b/.test(low)) score += 0.08;
  if (/\b(never|nobody|everyone|no one|impossible|can't|cannot)\b/.test(low)) score += 0.08;
  if (text.length > 0 && text.length <= 95) score += 0.08;
  if (PRONOUN_START.has(textWords(low)[0] || '')) score -= 0.08;
  if (FILLER_START.has(textWords(low)[0] || '')) score -= 0.04;
  return clamp01(score);
}

function emotionPart(text: string, audio: number, chat: number): number {
  const hits = Math.min(0.55, countMatches(text, EMOTION_WORDS) * 0.09);
  const punctuation = (text.match(/[!?]/g) || []).length;
  return clamp01(0.18 + hits + Math.min(0.14, punctuation * 0.035) + audio * 0.1 + chat * 0.08);
}

function selfContainedPart(unit: Unit, units: Unit[], index: number, text: string, duration: number, wordCount: number): number {
  const first = textWords(unit.low)[0] || '';
  let score = 0.58;
  if (PRONOUN_START.has(first)) score -= 0.18;
  if (FILLER_START.has(first)) score -= 0.06;
  if (/[.!?]["')\]]?$/.test(text.trim())) score += 0.08;
  if (/\b(because|so|which means|that's why|turns out|therefore)\b/.test(text.toLowerCase())) score += 0.1;
  const density = wordCount / Math.max(1, duration);
  if (density >= 1.8 && density <= 5) score += 0.12;
  else if (density < 1.2) score -= 0.12;
  if (index > 0 && unit.start - units[index - 1]!.end > 0.9) score += 0.03;
  if (units[index + 1] && units[index + 1]!.start - unit.end > 1.2 && !/[.!?]$/.test(text)) score -= 0.05;
  return clamp01(score);
}

function payoffPart(text: string, audio: number): number {
  const low = text.toLowerCase();
  const lastWords = textWords(low).slice(-14).join(' ');
  let score = 0.3;
  score += Math.min(0.3, countMatches(lastWords, PAYOFF_WORDS) * 0.1);
  const endings = textWords(low).slice(-4);
  if (endings.some((word) => PAYOFF_END.includes(word))) score += 0.12;
  if (/[.!?]$/.test(text.trim())) score += 0.08;
  if (audio > 0.55) score += Math.min(0.05, (audio - 0.55) * 0.35);
  return clamp01(score);
}

function categoryFor(text: string): string {
  const low = text.toLowerCase();
  let best = 'moment';
  let bestScore = 0.5;
  for (const [category, words] of Object.entries(CATEGORY_WORDS)) {
    const hits = countMatches(low, words);
    if (hits > bestScore) {
      bestScore = hits;
      best = category;
    }
  }
  return best;
}

function scoreCandidate(
  candidate: {
    start: number;
    end: number;
    text: string;
    unit: Unit;
    units: Unit[];
    firstIndex: number;
    lastIndex: number;
    wordCount: number;
  },
  audio: Series | null,
  chatHeat: Series | null,
): { score: number; parts: ScoreParts; audioScore: number; chat: number; story: StoryCheck } {
  const duration = candidate.end - candidate.start;
  const audioScore = seriesScore(audio, candidate.start, candidate.end);
  const chat = seriesScore(chatHeat, candidate.start, candidate.end, 0.4);
  const hook = hookPart(candidate.unit.text);
  const emotion = emotionPart(candidate.text, audioScore, chat);
  const story = storyCheckFor(candidate.units, candidate.firstIndex, candidate.lastIndex);
  const storyScore = (story.setup * 0.35 + story.resolution * 0.35 + story.ending * 0.3) / 100;
  // A complete story matters more than a loud moment: it is the main thing a
  // cold viewer can judge in the first seconds.
  const selfContained =
    selfContainedPart(candidate.unit, candidate.units, candidate.firstIndex, candidate.text, duration, candidate.wordCount) * 0.4 +
    storyScore * 0.6;
  const payoff = payoffPart(candidate.text, audioScore);
  const durationFit = clamp01(1 - Math.abs(duration - 30) / 34);
  const parts: ScoreParts = {
    hook: Math.round(hook * 100),
    emotion: Math.round(emotion * 100),
    selfContained: Math.round(selfContained * 100),
    payoff: Math.round(payoff * 100),
    audio: Math.round(audioScore * 100),
    chat: Math.round(chat * 100),
    novelty: 100,
  };
  let score =
    hook * 22 +
    emotion * 16 +
    selfContained * 30 +
    payoff * 13 +
    audioScore * 3 +
    chat * 2 +
    durationFit * 4 +
    7; // novelty baseline, adjusted during selection
  if (!story.passes) score -= 18;
  // Reward the full arc: a named subject, an answered question and a finished
  // sentence. This is the reel shape a cold viewer can follow without context.
  if (story.passes && story.resolution >= 88 && story.ending >= 100) score += 5;
  return { score: Math.round(score * 10) / 10, parts, audioScore, chat, story };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
}

function titleCase(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Untitled moment';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function normalizePhrase(text: string): string {
  return stripSoundTags(text)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(LEADING_FILLER, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,;:.!?]+|[,;:.!?]+$/g, '');
}

/** Drop trailing function words so a phrase never ends on "the" or "with". */
function dropDanglingTail(phrase: string): string {
  let words = phrase.split(' ').filter(Boolean);
  while (words.length > 3 && DANGLING_END.test(words[words.length - 1]!)) words = words.slice(0, -1);
  return words.join(' ').trim();
}

/**
 * Every complete line in a moment that fits a title/hook budget. A line is only
 * accepted when it ends on a real word: a half sentence like "going for flight
 * box to be down on the" is worse than no title at all, so it is rejected here
 * and the caller falls back to a truthful template.
 */
function completeLines(text: string, maxWords = 9, maxChars = 62): string[] {
  const clean = normalizePhrase(text);
  if (!clean) return [];
  const out: string[] = [];
  const push = (value: string) => {
    const trimmed = dropDanglingTail(value.replace(/[,;:—–-]+$/, '').trim());
    const words = trimmed.split(' ').filter((word) => word && isSpeakableToken(word));
    if (words.length < 3 || words.length > maxWords || trimmed.length > maxChars) return;
    if (DANGLING_END.test(words[words.length - 1]!)) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };

  const sentences = clean
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences.slice(0, 8)) {
    const words = sentence.split(' ').filter(Boolean);
    if (words.length <= maxWords && sentence.length <= maxChars) {
      push(sentence);
      continue;
    }
    // Long sentence: keep the opening clauses that still read as one thought.
    const parts = sentence.split(/(?<=[,;:—–])\s+|\s+(?:but|and then|because|which means|so then)\s+/i);
    let accumulated = '';
    for (const part of parts) {
      const next = accumulated ? `${accumulated} ${part}` : part;
      const nextWords = next.split(' ').filter(Boolean);
      if (nextWords.length > maxWords) break;
      if (!DANGLING_END.test(nextWords[nextWords.length - 1]!)) push(next);
      accumulated = next;
    }
  }
  return out;
}

/** The best complete line in a text, or '' when every line is a fragment. */
function cleanPhrase(text: string, maxWords = 9, maxChars = 62): string {
  return completeLines(text, maxWords, maxChars)[0] || '';
}

/** Pick the most readable complete line in a moment, not just whatever came first. */
function bestPhrase(text: string, maxWords = 9): string {
  const lines = completeLines(text, maxWords, 72);
  if (!lines.length) return '';
  const ranked = lines
    .map((line) => {
      const words = textWords(line).length;
      return {
        line,
        score:
          hookPart(line) * 0.55 +
          Math.min(1, words / 12) * 0.25 +
          (words >= 5 ? 0.1 : 0) +
          (/\?$/.test(line) ? 0.1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]!.line;
}

function hookOptionsFor(firstSentences: string, category: string, seed: number): HookOption[] {
  const clean = stripSoundTags(firstSentences);
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  let firstSentence = sentences[0] || clean;
  // A three-word question like "What is it?" needs the next line to mean anything.
  if (sentences[1] && textWords(firstSentence).length < 5) firstSentence = `${firstSentence} ${sentences[1]}`;
  const phrase = bestPhrase(firstSentence, 9) || bestPhrase(clean, 9);
  const phraseWords = phrase.split(' ').filter(Boolean).length;
  const emoji = EMOJI[seed % EMOJI.length]!;
  const options: HookOption[] = [];
  const push = (text: string, style: HookOption['style']) => {
    const value = stripSoundTags(text).replace(/\s+/g, ' ').trim();
    if (value && options.length < 5 && !options.some((option) => option.text === value)) {
      options.push({ text: value, style });
    }
  };

  if (/\?/.test(firstSentence) && phrase.length >= 12 && phraseWords >= 3) {
    push(`${phrase} ${emoji}`, 'question');
  }
  const strongPhrase = phrase.length >= 14 && phraseWords >= 3 && hookPart(phrase) >= 0.4;
  if (strongPhrase) push(`${phrase} ${emoji}`, 'curiosity');
  if (category === 'funny') push(`I was not ready for this ${emoji}`, 'humor');
  if (category === 'clutch') push(`This is actually insane ${emoji}`, 'stakes');
  if (category === 'hot take') push(`Everyone was wrong about this ${emoji}`, 'contrarian');
  if (category === 'story') push(`This story took a turn ${emoji}`, 'curiosity');
  if (category === 'wholesome') push(`This restored my faith ${emoji}`, 'pov');

  if (!strongPhrase && phrase.length >= 14 && phraseWords >= 3) push(`${phrase} ${emoji}`, 'curiosity');
  // Last-resort hooks stay useful without pretending to quote the streamer.
  push(`You need to see this ${emoji}`, 'curiosity');
  push(`Wait for the ending ${emoji}`, 'stakes');
  push(`Nobody expected this ${emoji}`, 'contrarian');
  push(`Would you have caught this? ${emoji}`, 'question');
  push(`POV: you were in the call ${emoji}`, 'pov');
  return options.slice(0, 4);
}

function titleFor(phrase: string, category: string, fullText = ''): string {
  // Prefer a specific spoken line over a generic template. This is what keeps
  // titles like "The moment everything changed" out of the library. Only
  // complete lines are considered, so a title never stops mid-sentence.
  const options = [bestPhrase(phrase, 9), bestPhrase(fullText, 9)].filter(Boolean);
  const clean = options.sort((a, b) => hookPart(b) - hookPart(a))[0] || '';
  if (clean.length >= 16 && meaningfulWords(clean).size >= 1) return titleCase(clean);
  const fallback: Record<string, string> = {
    funny: 'The moment chat lost it',
    clutch: 'The clutch of the stream',
    story: 'The story that escalated',
    'hot take': 'The take nobody expected',
    wholesome: 'The wholesome moment',
    reaction: 'The reaction says it all',
    tutorial: 'The tip that changed everything',
    moment: 'A moment worth watching',
  };
  return fallback[category] || fallback.moment!;
}

function captionFor(title: string, category: string, platform: PlatformId): string {
  const cta: Record<string, string> = {
    funny: 'Wait for the reaction.',
    clutch: 'Watch how this ends.',
    story: 'The ending is worth it.',
    'hot take': 'Is this a fair take?',
    wholesome: 'This one hit different.',
    reaction: 'His face says everything.',
    tutorial: 'Save this for later.',
    moment: 'Watch the full moment.',
  };
  return `${title}. ${cta[category] || cta.moment} ${PLATFORM_TAG[platform] || '#clips'}`;
}

function hashtagsFor(text: string, category: string, platform: PlatformId): string[] {
  const tags = new Set<string>(['#shorts', '#clips', '#streamer', PLATFORM_TAG[platform] || '#clips']);
  tags.add('#funny');
  if (category === 'clutch') tags.add('#clutch');
  if (category === 'hot take') tags.add('#hottake');
  if (category === 'wholesome') tags.add('#wholesome');
  if (category === 'tutorial') tags.add('#tips');
  const freq = new Map<string, number>();
  for (const word of meaningfulWords(text)) {
    if (word.length < 5) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach(([word]) => tags.add(`#${word.replace(/[^a-z0-9]/g, '')}`));
  return [...tags].filter((tag) => tag.length > 2).slice(0, 7);
}

function reasonFor(parts: ScoreParts): string {
  const labels: Array<[keyof ScoreParts, string]> = [
    ['hook', 'a strong opening line'],
    ['emotion', 'high emotional energy'],
    ['selfContained', 'a self-contained story'],
    ['payoff', 'a clean payoff'],
  ];
  const winners = labels
    .filter(([key]) => (parts[key] ?? 0) >= 62)
    .sort((a, b) => (parts[b[0]] ?? 0) - (parts[a[0]] ?? 0))
    .slice(0, 3)
    .map(([, label]) => label);
  if (!winners.length) return 'Picked for pace, clarity and a clean sentence boundary.';
  return `Picked for ${winners.join(', ')}.`;
}

function buildPool(units: Unit[], duration: number, minDuration: number, maxDuration: number): PoolEntry[] {
  const pool: PoolEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    for (let j = i; j < units.length; j++) {
      const first = units[i]!;
      const last = units[j]!;
      const rawDuration = last.end - first.start;
      if (rawDuration > maxDuration + 3) break;
      if (rawDuration < minDuration - 3) continue;

      // The end may dangle on "and" or "because"; pull in the next sentence.
      // The start is handled after selection, where we can add the premise
      // without changing which moments were chosen.
      let lastIndex = j;
      for (let step = 0; step < 4; step++) {
        const closing = units[lastIndex]!;
        const next = units[lastIndex + 1];
        const shortClose = textWords(closing.text).length < 4 || /[,;:]$/.test(closing.text.trim());
        if (!next || (!shortClose && !endingNeedsContext(closing))) break;
        if (next.start - closing.end > 2.5) break;
        if (next.end - units[i]!.start > maxDuration) break;
        lastIndex += 1;
      }

      // The premise belongs in the clip, not in a tooltip. Without this the
      // range starts on "it" or on the answer to a question the viewer never heard.
      const firstIndex = expandStart(units, i, lastIndex, maxDuration);
      // A finished sentence is not enough: if the range asks something it has not
      // answered, run on to the answer instead of cutting the clip off there.
      lastIndex = closeOnAnswer(units, firstIndex, lastIndex, maxDuration);
      const start = Math.max(0, units[firstIndex]!.start - 0.12);
      const end = Math.min(duration, units[lastIndex]!.end + 0.28);
      const finalDuration = end - start;
      if (finalDuration < Math.min(minDuration, 8) || finalDuration > maxDuration + 1) continue;
      const slice = units.slice(firstIndex, lastIndex + 1);
      const text = slice.map((unit) => unit.text).join(' ');
      const wordCount = slice.reduce((sum, unit) => sum + unit.words.length, 0);
      if (wordCount < 8) continue;
      const key = `${Math.round(start * 10)}:${Math.round(end * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ start, end, unit: slice[0]!, units, firstIndex, lastIndex, text, wordCount });
    }
  }

  // Long single sentences may exceed the max duration; trim them at word boundaries.
  if (!pool.length && units.length) {
    const words = units.flatMap((unit) => unit.words);
    if (words.length >= 8) {
      const start = Math.max(0, words[0]!.start - 0.1);
      const end = Math.min(duration, start + Math.min(maxDuration, Math.max(minDuration, words[words.length - 1]!.end - start)));
      const text = words.map((word) => word.text).join(' ');
      pool.push({
        start,
        end,
        unit: units[0]!,
        units,
        firstIndex: 0,
        lastIndex: units.length - 1,
        text,
        wordCount: words.length,
      });
    }
  }
  return pool;
}

export async function analyzeTranscript(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { transcript, duration, settings } = input;
  const units = sentenceUnits(transcript);
  if (!units.length) throw new Error('No speech was found in this video, so there is nothing to clip.');
  input.onProgress?.(2, 'Reading the transcript');

  const minDuration = Math.max(5, Math.min(settings.minDuration, settings.maxDuration));
  const maxDuration = Math.max(minDuration + 3, settings.maxDuration);
  const pool = buildPool(units, duration, minDuration, maxDuration);
  if (!pool.length) throw new Error('No complete spoken moments fit the selected duration range. Try a wider range.');

  input.onProgress?.(10, 'Scoring moments');
  const audioSeries = makeSeries(input.audio?.points, input.audio?.peaks);
  const chatSeries = makeSeries(
    input.chatHeat?.map((point) => ({ t: point.t, value: point.chat ?? point.heat ?? 0 })),
    undefined,
  );
  const working: WorkingCandidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (i % 200 === 0 && input.signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
    const entry = pool[i]!;
    const { score, parts, story } = scoreCandidate(entry, audioSeries, chatSeries);
    const phrase = cleanPhrase(entry.unit.text);
    const category = categoryFor(entry.text);
    const title = titleFor(phrase, category, entry.text);
    const hooks = hookOptionsFor(entry.text.slice(0, 280), category, i);
    const hook = hooks[0]?.text || title;
    working.push({
      id: `cand_${String(i + 1).padStart(3, '0')}`,
      start: Math.round(entry.start * 100) / 100,
      end: Math.round(entry.end * 100) / 100,
      score,
      baseScore: score,
      category,
      title,
      hook,
      hooks,
      caption: captionFor(title, category, input.platform),
      hashtags: hashtagsFor(entry.text, category, input.platform),
      reason: `${reasonFor(parts)} ${story.note}`,
      scoreParts: parts,
      source: 'local',
      textSet: meaningfulWords(entry.text),
      excerpt: entry.text.slice(0, 1400),
      story,
    });
  }

  input.onProgress?.(30, 'Choosing the best moments');
  const count = Math.max(1, Math.min(10, settings.clipCount));
  const selected: WorkingCandidate[] = [];
  const consider = [...working];
  const bestAvailable = consider.reduce((max, candidate) => Math.max(max, candidate.baseScore), 0);
  // A clip that only scores by default weights should not pad the library.
  const minimumScore = Math.max(50, bestAvailable * 0.62);
  // First pass only accepts clips that answer the story questions. Weak clips
  // are used only to fill a shortfall, never to pad a library.
  let allowWeak = false;
  while (selected.length < count) {
    let best: { candidate: WorkingCandidate; adjusted: number } | null = null;
    for (const candidate of consider) {
      if (selected.some((other) => other.id === candidate.id)) continue;
      if (!allowWeak && !candidate.story.passes) continue;
      // Keep clips from covering the same beat. 0.3 means they can share a
      // lead-in sentence, but not the actual moment.
      if (selected.some((other) => overlapRatio(candidate, other) > 0.3)) continue;
      if (selected.some((other) => Math.abs(candidate.start - other.start) < 1.5)) continue;
      const maxSimilarity = selected.reduce((max, other) => Math.max(max, jaccard(candidate.textSet, other.textSet)), 0);
      const proximityPenalty = selected.filter((other) => Math.abs(candidate.start - other.start) < 20).length * 1.8;
      const adjusted = candidate.baseScore - maxSimilarity * 18 - proximityPenalty;
      if (!best || adjusted > best.adjusted) best = { candidate, adjusted };
    }
    if (!best) {
      if (!allowWeak && selected.length === 0) {
        // A source with no complete story still gets one clip rather than an
        // empty project, but we never pad a good set with broken clips.
        allowWeak = true;
        continue;
      }
      break;
    }
    if (selected.length > 0 && best.adjusted < Math.max(48, minimumScore)) break;
    best.candidate.score = Math.round(best.adjusted * 10) / 10;
    best.candidate.scoreParts.novelty = Math.round((1 - selected.reduce((max, other) => Math.max(max, jaccard(best!.candidate.textSet, other.textSet)), 0)) * 100);
    selected.push(best.candidate);
  }

  if (!selected.length) {
    // Extremely short source: keep the whole thing rather than returning nothing.
    const fallback = [...working].sort((a, b) => b.baseScore - a.baseScore)[0]!;
    fallback.start = 0;
    fallback.end = Math.min(duration, Math.max(minDuration, fallback.end));
    selected.push(fallback);
  }

  let engine = 'Local brain';
  let geminiCalls = 0;
  let cachedCalls = 0;
  let failures = 0;
  const poolForGemini = [
    ...selected,
    ...working
      .filter((candidate) => !selected.some((item) => item.id === candidate.id))
      // Quiet but complete stories must reach Gemini, not just the loudest.
      .sort((a, b) =>
        Number(b.story.passes) - Number(a.story.passes) ||
        b.baseScore - a.baseScore,
      ),
  ].slice(
    0,
    settings.aiMode === 'full' ? 26 : 14,
  );

  const shouldUseGemini =
    settings.aiMode !== 'off' && geminiAvailable() && geminiBudgetLeft() > 0 && !input.signal?.aborted;

  if (shouldUseGemini) {
    input.onProgress?.(42, 'Asking Gemini for the final edit');
    try {
      const result = await geminiJson<{ clips?: GeminiClip[] }>({
        label: 'moment selection',
        temperature: 0.6,
        maxOutputTokens: 4096,
        signal: input.signal,
        prompt: buildPrompt(poolForGemini, {
          count,
          minDuration,
          maxDuration,
          platform: input.platform,
          mode: settings.aiMode as AiMode,
          duration,
        }),
      });
      geminiCalls = result.cached ? 0 : 1;
      cachedCalls = result.cached ? 1 : 0;
      const clips = Array.isArray(result.data?.clips) ? result.data.clips : [];
      const byId = new Map(poolForGemini.map((candidate) => [candidate.id, candidate]));
      const chosen: WorkingCandidate[] = [];
      const seen = new Set<string>();
      for (const clip of clips) {
        if (!clip?.id || seen.has(clip.id)) continue;
        const base = byId.get(clip.id);
        if (!base) continue;
        if (chosen.some((item) => overlapRatio(item, base) > 0.3 || Math.abs(item.start - base.start) < 2)) continue;
        seen.add(clip.id);
        const title = sanitizeGeminiText(clip.title, 80) || base.title;
        const hook = sanitizeGeminiText(clip.hook, 120) || base.hook;
        const hooks = Array.isArray(clip.hooks)
          ? clip.hooks
              .map((item) => ({ text: sanitizeGeminiText(item?.text, 120), style: normalizeHookStyle(item?.style) }))
              .filter((item) => item.text.length >= 8)
              .slice(0, 4)
          : [];
        const uniqueHooks: HookOption[] = [];
        for (const item of [...hooks, ...base.hooks]) {
          if (!item.text || uniqueHooks.some((existing) => existing.text === item.text)) continue;
          uniqueHooks.push(item);
          if (uniqueHooks.length >= 4) break;
        }
        if (hook && !uniqueHooks.some((item) => item.text === hook)) uniqueHooks.unshift({ text: hook, style: 'curiosity' });
        chosen.push({
          ...base,
          title,
          hook,
          hooks: uniqueHooks.slice(0, 4),
          caption: sanitizeGeminiText(clip.caption, 240) || base.caption,
          hashtags: Array.isArray(clip.hashtags) && clip.hashtags.length
            ? clip.hashtags
                .map((tag) => sanitizeGeminiText(tag, 32))
                .filter((tag) => /^#[a-z0-9_]{2,30}$/i.test(tag))
                .slice(0, 8)
            : base.hashtags,
          category: sanitizeGeminiText(clip.category, 24) || base.category,
          reason: sanitizeGeminiText(clip.reason, 160) || base.reason,
          source: 'gemini',
        });
      }
      if (chosen.length) {
        // Fill any shortfall with the strongest local picks, keeping the timeline covered.
        for (const candidate of [...selected, ...working].sort((a, b) => b.baseScore - a.baseScore)) {
          if (chosen.length >= count) break;
          if (candidate.baseScore < minimumScore) break;
          if (!candidate.story.passes) continue;
          if (chosen.some((item) => item.id === candidate.id || Math.abs(item.start - candidate.start) < 1.2)) continue;
          if (chosen.some((item) => overlapRatio(item, candidate) > 0.3)) continue;
          chosen.push({ ...candidate, source: 'local' });
        }
        selected.length = 0;
        selected.push(...chosen.slice(0, count));
        engine = result.cached ? 'Gemini (cached) + local brain' : 'Gemini + local brain';
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      failures = 1;
      log.warn('Gemini selection failed, keeping local picks', (error as Error).message);
    }
  }

  selected.sort((a, b) => a.start - b.start);
  input.onProgress?.(55, 'Finalising hooks and boundaries');

  return {
    candidates: selected.map(({ baseScore: _baseScore, textSet: _textSet, excerpt: _excerpt, story: _story, ...candidate }) => ({
      ...candidate,
      score: Math.round(Math.max(0, Math.min(100, candidate.score)) * 10) / 10,
    })),
    engine,
    geminiCalls,
    cachedCalls,
    failures,
    pool: working.length,
  };
}

type GeminiClip = {
  id?: string;
  title?: string;
  hook?: string;
  hooks?: Array<{ text?: string; style?: string }>;
  caption?: string;
  hashtags?: string[];
  category?: string;
  reason?: string;
};

function normalizeHookStyle(style?: string): HookOption['style'] {
  const allowed: HookOption['style'][] = ['curiosity', 'stakes', 'contrarian', 'question', 'pov', 'humor', 'number'];
  return allowed.includes(style as HookOption['style']) ? (style as HookOption['style']) : 'curiosity';
}

/** Gemini sometimes echoes ASR stage directions; never let those reach the UI. */
function sanitizeGeminiText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return stripSoundTags(value.replace(/\s+/g, ' ').trim()).slice(0, max).trim();
}

function buildPrompt(
  candidates: WorkingCandidate[],
  context: { count: number; minDuration: number; maxDuration: number; platform: PlatformId; mode: AiMode; duration: number },
): string {
  const lines = candidates.map((candidate) => {
    const firstSentence = candidate.excerpt.split(/(?<=[.!?…])\s+/)[0] || candidate.excerpt;
    const opening = stripSoundTags(firstSentence).replace(/\s+/g, ' ').trim().slice(0, 110);
    const check = candidate.story
      ? ` | local story check: setup ${candidate.story.setup}/100, answer ${candidate.story.resolution}/100, ending ${candidate.story.ending}/100${
          candidate.story.passes ? '' : ' (FAILED)'
        }`
      : '';
    return `- id: ${candidate.id} | ${Math.round(candidate.start)}s–${Math.round(candidate.end)}s (${Math.round(candidate.end - candidate.start)}s) | local category: ${candidate.category}${check} | opens with: ${JSON.stringify(opening)}`;
  });

  const detail = candidates
    .map((candidate) => {
      const excerpt = candidateTranscript(candidate);
      return `### ${candidate.id}\n${excerpt}`;
    })
    .join('\n\n');

  return `You are the senior editor of TeraClip, a clipping studio for streamers. You are choosing the ${context.count} clips most likely to go viral as vertical shorts.

Video duration: ${Math.round(context.duration)} seconds. Target platform: ${context.platform}. Allowed clip length: ${context.minDuration}–${context.maxDuration}s.

LOCAL SHORTLIST
${lines.join('\n')}

TRANSCRIPT EXCERPTS (verbatim, may contain ASR errors)
${detail}

THE STORY CONTRACT — run this checklist on every id before you shortlist it
1. WHO OR WHAT: does the first line name the person, item, game, price or situation? If it only says "it", "that", "this", "he" or answers a question the viewer never heard, the clip FAILS.
2. THE QUESTION: what does the clip set up — a question, a bet, a problem, a claim? If it raises nothing, it is not a story yet.
3. THE ANSWER: is that question or problem resolved clearly inside the clip, before the last line? If not, the clip FAILS.
4. THE ENDING: would the last line feel finished if the video stopped there? A clip that stops mid-sentence or on a new question FAILS.
5. THE MISSING LINE: does any line depend on something said outside the clip? If so, the clip FAILS.
Only keep ids that pass all five. A slightly slower clip that answers its own question is always stronger than a punchier one that dangles. The "local story check" scores above are a second opinion, not the final word — override them when the transcript proves them wrong.

RULES
- Choose only ids from the shortlist. Never invent ids or timestamps.
- Every clip MUST stand on its own for a cold viewer: setup, beat and payoff all inside the range.
- Never start a clip on "it", "that", "this", "so", "and", "but", "like" or any dangling reference unless the selected range already includes the line it refers to. The local range has been snapped to sentences, so trust it over a mid-thought timestamp.
- Never end a clip on a dangling word such as "and", "because" or "the". Prefer the end of a complete sentence.
- Rank by scroll-stopping power for a cold viewer, not by importance to the stream.
- Do not select two clips covering the same beat or the same joke. If two ids overlap heavily, pick only the stronger one.
- Write hooks like a streamer editor: max 8 words, one natural iPhone-style emoji (😭 😳 🔥 💀 👀), no quotation marks, no trailing "and"/"but"/"so", and nothing that the clip does not deliver. A hook must be a complete phrase, never a truncated transcript fragment.
- Titles: max 7 words, title case, no emoji, no generic filler like "The moment everything changed". Quote or paraphrase the actual spoken line when possible.
- Captions: one sentence plus a short CTA. 3–6 hashtags.
- NEVER include ASR stage directions or sound labels anywhere: no "(gunfire)", "[Music]", "*laughs*", "♪", "applause" or similar. Only speakable words.
- Return between 1 and ${context.count} clips (fewer is allowed only if the rest are genuinely weak; never pad with a clip that does not make sense from start to finish).

Return JSON only:
{"clips":[{"id":"cand_001","title":"...","hook":"...","hooks":[{"text":"...","style":"curiosity"},{"text":"...","style":"stakes"},{"text":"...","style":"question"}],"caption":"...","hashtags":["#shorts"],"category":"funny","reason":"why this clip works"}]}`;
}

function candidateTranscript(candidate: WorkingCandidate): string {
  return candidate.excerpt;
}

export { parseJsonLoose };
