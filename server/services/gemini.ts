import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, PATHS } from '../config';
import { log } from '../lib/logger';
import { store } from '../lib/store';

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiJsonResult<T> {
  data: T;
  cached: boolean;
  tokensIn: number;
  tokensOut: number;
}

function cachePath(key: string): string {
  return path.join(PATHS.geminiCache, `${key}.json`);
}

export function geminiAvailable(): boolean {
  return Boolean(CONFIG.geminiKey);
}

export function geminiBudgetLeft(): number {
  const settings = store.getSettings();
  const usage = store.getUsage();
  const configured = settings.geminiDailyLimit;
  const limit =
    configured === 0 ? 0 : Math.min(configured || CONFIG.geminiDailyLimit, CONFIG.geminiDailyLimit);
  return Math.max(0, limit - usage.requests);
}

/**
 * One JSON-mode Gemini call, with an on-disk cache keyed by the exact prompt.
 * We deliberately keep this tiny: Gemini is reserved for editorial judgement,
 * while transcription, face tracking and scoring all run locally.
 */
export async function geminiJson<T>(options: {
  prompt: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  label: string;
}): Promise<GeminiJsonResult<T>> {
  const model = options.model || store.getSettings().geminiModel || CONFIG.geminiModel;
  const digest = crypto.createHash('sha256').update(`${model}\n${options.prompt}`).digest('hex').slice(0, 40);
  const file = cachePath(digest);
  if (fs.existsSync(file)) {
    try {
      const cached = JSON.parse(await fsp.readFile(file, 'utf8')) as { data: T };
      void store.recordUsage({ cachedHits: 1 });
      return { data: cached.data, cached: true, tokensIn: 0, tokensOut: 0 };
    } catch {
      await fsp.rm(file, { force: true }).catch(() => undefined);
    }
  }

  if (!CONFIG.geminiKey) throw new GeminiError('Gemini is not configured.');
  if (geminiBudgetLeft() <= 0) throw new GeminiError('Daily Gemini limit reached.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(CONFIG.geminiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: options.temperature ?? 0.55,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(75_000),
    });
  } catch (error) {
    await store.recordUsage({ failures: 1 });
    throw new GeminiError(`Gemini could not be reached: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    await store.recordUsage({ failures: 1 });
    throw new GeminiError(`Gemini returned ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  if (payload.promptFeedback?.blockReason) {
    await store.recordUsage({ failures: 1 });
    throw new GeminiError(`Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
  }
  const text = (payload.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
  if (!text) {
    await store.recordUsage({ failures: 1 });
    throw new GeminiError('Gemini returned an empty response.');
  }

  let data: T;
  try {
    data = parseJsonLoose<T>(text);
  } catch {
    await store.recordUsage({ failures: 1 });
    throw new GeminiError('Gemini returned malformed JSON.');
  }

  const tokensIn = Number(payload.usageMetadata?.promptTokenCount || 0);
  const tokensOut = Number(payload.usageMetadata?.candidatesTokenCount || 0);
  await store.recordUsage({ requests: 1, tokensIn, tokensOut });
  await fsp.mkdir(PATHS.geminiCache, { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ model, createdAt: new Date().toISOString(), data }, null, 2), 'utf8');
  log.info(`gemini ${options.label}: ${tokensIn}→${tokensOut} tokens`);
  return { data, cached: false, tokensIn, tokensOut };
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    if (start < 0) throw new Error('no JSON found');
    const opening = cleaned[start];
    const closing = opening === '[' ? ']' : '}';
    const end = cleaned.lastIndexOf(closing);
    if (end <= start) throw new Error('unclosed JSON');
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
}
