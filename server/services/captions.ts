import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { AspectRatio, CaptionPresetId, SubtitleCue, Word } from '../../shared/types';
import { CAPTION_BY_ID, ASPECT_SIZES } from '../../shared/presets';
import { isSpeakableToken, stripSoundTags } from '../../shared/utils';
import { PATHS } from '../config';

const FONT_FILES: Record<string, string> = {
  poppins: 'Poppins-ExtraBold.ttf',
  anton: 'Anton-Regular.ttf',
  bebas: 'BebasNeue-Regular.ttf',
};

const ASS_FONT_NAMES: Record<string, string> = {
  poppins: 'Poppins ExtraBold',
  anton: 'Anton',
  bebas: 'Bebas Neue',
};

const FONT_SIZE: Record<CaptionPresetId, number> = {
  'tera-box': 62,
  hormozi: 86,
  'purple-pop': 72,
  beast: 112,
  clean: 54,
  neon: 60,
};

/**
 * libass asks FreeType for FT_SIZE_REQUEST_TYPE_REAL_DIM, i.e. it treats the
 * ASS font size as the font's ascent+descent cell height rather than the em
 * size. Poppins has unusually tall win metrics, so without this correction
 * every caption is drawn ~44% smaller than the card measured for it.
 */
const FALLBACK_SIZE_FACTOR: Record<'poppins' | 'anton' | 'bebas', number> = {
  poppins: 1.762,
  anton: 1.7334,
  bebas: 1.3,
};
const sizeFactorCache = new Map<string, number>();

function readSizeFactor(file: string, fallback: number): number {
  const cached = sizeFactorCache.get(file);
  if (cached) return cached;
  try {
    const buf = fs.readFileSync(file);
    const numTables = buf.readUInt16BE(4);
    let head = 0;
    let os2 = 0;
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      const tag = buf.toString('ascii', off, off + 4);
      if (tag === 'head') head = buf.readUInt32BE(off + 8);
      else if (tag === 'OS/2') os2 = buf.readUInt32BE(off + 8);
    }
    if (!head || !os2) return fallback;
    const unitsPerEm = buf.readUInt16BE(head + 18);
    const winAscent = buf.readUInt16BE(os2 + 74);
    const winDescent = buf.readUInt16BE(os2 + 76);
    if (!unitsPerEm || winAscent + winDescent <= 0) return fallback;
    const factor = (winAscent + winDescent) / unitsPerEm;
    sizeFactorCache.set(file, factor);
    return factor;
  } catch {
    return fallback;
  }
}

function assSizeFactor(font: 'poppins' | 'anton' | 'bebas'): number {
  return readSizeFactor(path.join(PATHS.fonts, FONT_FILES[font]!), FALLBACK_SIZE_FACTOR[font]);
}


let fontsLoaded = false;

export function loadCaptionFonts(): void {
  if (fontsLoaded) return;
  for (const file of Object.values(FONT_FILES)) {
    const full = path.join(PATHS.fonts, file);
    if (fs.existsSync(full)) {
      try {
        GlobalFonts.registerFromPath(full);
      } catch {
        /* font may already be registered */
      }
    }
  }
  fontsLoaded = true;
}

export function captionFontCss(font: 'poppins' | 'anton' | 'bebas', size: number): string {
  if (font === 'anton') return `${size}px "Anton", Impact, sans-serif`;
  if (font === 'bebas') return `${size}px "Bebas Neue", Impact, sans-serif`;
  return `800 ${size}px "Poppins", Inter, sans-serif`;
}

const measureCanvas = createCanvas(32, 32);
const measureCtx = measureCanvas.getContext('2d');

function measureText(text: string, font: 'poppins' | 'anton' | 'bebas', size: number): number {
  measureCtx.font = captionFontCss(font, size);
  return measureCtx.measureText(text).width;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '').replace(/{/g, '(').replace(/}/g, ')').replace(/\r?\n/g, ' ');
}

function assColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${b}${g}${r}&`.toUpperCase();
}

function assAlpha(hexAlpha: string): string {
  return `&H${hexAlpha}&`.toUpperCase();
}

function roundRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2);
  const x1 = x + width;
  const y1 = y + height;
  return [
    `m ${(x + r).toFixed(1)} ${y.toFixed(1)}`,
    `l ${(x1 - r).toFixed(1)} ${y.toFixed(1)}`,
    `b ${(x1 - r / 2).toFixed(1)} ${y.toFixed(1)} ${x1.toFixed(1)} ${(y + r / 2).toFixed(1)} ${x1.toFixed(1)} ${(y + r).toFixed(1)}`,
    `l ${x1.toFixed(1)} ${(y1 - r).toFixed(1)}`,
    `b ${x1.toFixed(1)} ${(y1 - r / 2).toFixed(1)} ${(x1 - r / 2).toFixed(1)} ${y1.toFixed(1)} ${(x1 - r).toFixed(1)} ${y1.toFixed(1)}`,
    `l ${(x + r).toFixed(1)} ${y1.toFixed(1)}`,
    `b ${(x + r / 2).toFixed(1)} ${y1.toFixed(1)} ${x.toFixed(1)} ${(y1 - r / 2).toFixed(1)} ${x.toFixed(1)} ${(y1 - r).toFixed(1)}`,
    `l ${x.toFixed(1)} ${(y + r).toFixed(1)}`,
    `b ${x.toFixed(1)} ${(y + r / 2).toFixed(1)} ${(x + r / 2).toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}`,
  ].join(' ');
}

function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

interface Cue {
  start: number;
  end: number;
  words: Word[];
  lines: Word[][];
  lineWidths: number[];
  fontSize: number;
  lineHeight: number;
  boxWidth: number;
  boxHeight: number;
  centerX: number;
  centerY: number;
}

export interface CaptionOptions {
  preset: CaptionPresetId;
  aspect: AspectRatio;
  duration: number;
  /** Caption size multiplier (1 = preset default). */
  scale?: number;
  overlayTitle?: string;
  /** Edited subtitle lines. When present these replace word-derived cues. */
  subtitles?: SubtitleCue[];
  /** Override the vertical centre of the caption stack (safe-area aware). */
  centerY?: number;
}

function scaleValue(raw: number | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(0.6, Math.min(1.6, value));
}

function makeCues(words: Word[], options: CaptionOptions): Cue[] {
  const { width: frameW, height: frameH } = ASPECT_SIZES[options.aspect];
  const preset = CAPTION_BY_ID[options.preset];
  const font = preset.font;
  const minDim = Math.min(frameW, frameH);
  const fontSize = Math.round(((FONT_SIZE[options.preset] * minDim) / 1080) * scaleValue(options.scale));
  const maxTextWidth = Math.min(frameW - 130, preset.box ? 840 : 1000);
  const maxLines = preset.id === 'beast' ? 1 : 2;
  const maxWords = preset.wordsPerCue;
  const maxCueSeconds = preset.id === 'beast' ? 1.4 : preset.id === 'clean' ? 3.8 : 3.4;
  const lineHeight = fontSize * 1.16;
  const position =
    options.centerY ??
    (options.aspect === '9:16' ? frameH * 0.745 : options.aspect === '1:1' ? frameH * 0.8 : frameH * 0.82);
  const centerX = frameW / 2;
  const padX = Math.round(fontSize * 0.62);
  const padY = Math.round(fontSize * 0.38);

  const display = (word: Word): string => (preset.uppercase ? word.text.toUpperCase() : word.text);

  const measureLine = (lineWords: Word[]): number =>
    measureText(lineWords.map((w) => escapeAss(display(w))).join(' '), font, fontSize);

  const wrap = (cueWords: Word[]): { lines: Word[][]; widths: number[] } => {
    const lines: Word[][] = [];
    let line: Word[] = [];
    let lineWidth = 0;
    for (const word of cueWords) {
      const text = escapeAss(display(word));
      const space = line.length ? measureText(' ', font, fontSize) : 0;
      const wordWidth = measureText(text, font, fontSize);
      if (line.length && lineWidth + space + wordWidth > maxTextWidth) {
        lines.push(line);
        line = [word];
        lineWidth = wordWidth;
      } else {
        line.push(word);
        lineWidth += space + wordWidth;
      }
    }
    if (line.length) lines.push(line);

    // Avoid an awkward one-word orphan on the second line.
    if (lines.length === 2 && lines[1]!.length === 1 && lines[0]!.length >= 3 && cueWords.length >= 4) {
      const mid = Math.ceil(cueWords.length / 2);
      const first = cueWords.slice(0, mid);
      const second = cueWords.slice(mid);
      if (first.length && second.length && measureLine(first) <= maxTextWidth && measureLine(second) <= maxTextWidth) {
        return { lines: [first, second], widths: [measureLine(first), measureLine(second)] };
      }
    }

    return {
      lines,
      widths: lines.map(measureLine),
    };
  };

  const cues: Cue[] = [];
  const buildCue = (cueWords: Word[], nextStart?: number): void => {
    if (!cueWords.length) return;
    const layout = wrap(cueWords);
    const first = cueWords[0]!;
    const last = cueWords[cueWords.length - 1]!;
    const start = Math.max(0, first.start - 0.02);
    const tail = preset.id === 'beast' ? 0.18 : 0.14;
    let end = Math.min(options.duration, last.end + tail);
    if (nextStart !== undefined) end = Math.min(end, nextStart - 0.02);
    if (end <= start) end = start + 0.2;
    const maxWidth = layout.widths.length ? Math.max(...layout.widths) : 0;
    const boxWidth = Math.min(frameW - 40, Math.max(280, maxWidth + padX * 2));
    const boxHeight = layout.lines.length * lineHeight + padY * 2;
    cues.push({
      start,
      end,
      words: cueWords,
      lines: layout.lines,
      lineWidths: layout.widths,
      fontSize,
      lineHeight,
      boxWidth,
      boxHeight,
      centerX,
      centerY: position,
    });
  };

  let index = 0;
  while (index < words.length) {
    const cueWords: Word[] = [];
    const cueStart = words[index]!.start;
    while (index < words.length) {
      const candidate = words[index]!;
      if (cueWords.length && candidate.start - words[index - 1]!.end > 1.0) break;
      const trial = [...cueWords, candidate];
      const trialLayout = wrap(trial);
      const trialDuration = candidate.end - cueStart;
      if (
        cueWords.length &&
        (trialLayout.lines.length > maxLines || trialDuration > maxCueSeconds || trial.length > maxWords)
      ) {
        break;
      }
      cueWords.push(candidate);
      index += 1;
      const justEnded = /[.!?]["')\]]?$/.test(candidate.text);
      if (justEnded && cueWords.length >= 3) break;
      if (cueWords.length >= maxWords) break;
    }
    const nextStart = words[index]?.start;
    buildCue(cueWords, nextStart);
  }
  return cues;
}

function makeSubtitleCues(subtitles: SubtitleCue[], options: CaptionOptions): Cue[] {
  const { width: frameW, height: frameH } = ASPECT_SIZES[options.aspect];
  const preset = CAPTION_BY_ID[options.preset];
  const font = preset.font;
  const minDim = Math.min(frameW, frameH);
  const fontSize = Math.round(((FONT_SIZE[options.preset] * minDim) / 1080) * scaleValue(options.scale));
  const maxTextWidth = Math.min(frameW - 130, preset.box ? 840 : 1000);
  const lineHeight = fontSize * 1.16;
  const position =
    options.centerY ??
    (options.aspect === '9:16' ? frameH * 0.745 : options.aspect === '1:1' ? frameH * 0.8 : frameH * 0.82);
  const centerX = frameW / 2;
  const padX = Math.round(fontSize * 0.62);
  const padY = Math.round(fontSize * 0.38);
  const display = (word: Word): string => (preset.uppercase ? word.text.toUpperCase() : word.text);

  const cues: Cue[] = [];
  for (const subtitle of subtitles) {
    const text = stripSoundTags(String(subtitle.text || '')).replace(/\s+/g, ' ').trim();
    const tokens = text.split(' ').filter((token) => token && isSpeakableToken(token));
    if (!tokens.length) continue;
    const start = Math.max(0, Math.min(options.duration - 0.2, Number(subtitle.start) || 0));
    let end = Math.max(start + 0.4, Math.min(options.duration, Number(subtitle.end) || start + 2));
    if (end <= start + 0.2) end = Math.min(options.duration, start + Math.max(0.8, tokens.length * 0.3));
    const weights = tokens.map((token) => Math.max(2, token.replace(/[^\p{L}\p{N}]/gu, '').length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const span = Math.max(0.4, end - start);
    let cursor = start;
    const cueWords: Word[] = tokens.map((token, index) => {
      const from = cursor;
      const to = index === tokens.length - 1 ? end : cursor + (span * weights[index]!) / total;
      cursor = to;
      return { text: token, start: from, end: Math.max(from + 0.05, to) };
    });

    const lines: Word[][] = [];
    let line: Word[] = [];
    let lineWidth = 0;
    for (const word of cueWords) {
      const raw = escapeAss(display(word));
      const space = line.length ? measureText(' ', font, fontSize) : 0;
      const wordWidth = measureText(raw, font, fontSize);
      if (line.length && lineWidth + space + wordWidth > maxTextWidth) {
        lines.push(line);
        line = [word];
        lineWidth = wordWidth;
      } else {
        line.push(word);
        lineWidth += space + wordWidth;
      }
    }
    if (line.length) lines.push(line);
    if (!lines.length) continue;
    const widths = lines.map((lineWords) => measureText(lineWords.map((word) => escapeAss(display(word))).join(' '), font, fontSize));
    const maxWidth = widths.length ? Math.max(...widths) : 0;
    const boxWidth = Math.min(frameW - 40, Math.max(280, maxWidth + padX * 2));
    const boxHeight = lines.length * lineHeight + padY * 2;
    cues.push({
      start,
      end,
      words: cueWords,
      lines,
      lineWidths: widths,
      fontSize,
      lineHeight,
      boxWidth,
      boxHeight,
      centerX,
      centerY: position,
    });
  }
  return cues;
}

function buildAss(cues: Cue[], options: CaptionOptions): string {
  const { width: frameW, height: frameH } = ASPECT_SIZES[options.aspect];
  const preset = CAPTION_BY_ID[options.preset];
  const fontName = ASS_FONT_NAMES[preset.font];
  const fontSize =
    cues[0]?.fontSize ??
    Math.round(((FONT_SIZE[options.preset] * Math.min(frameW, frameH)) / 1080) * scaleValue(options.scale));
  const assFontSize = Math.max(1, Math.round(fontSize * assSizeFactor(preset.font)));
  const bold = preset.font === 'bebas' ? -1 : 0;
  const base = assColor(preset.textColor);
  const active = assColor(preset.activeColor);
  const stroke = assColor(preset.strokeColor);
  const outline =
    preset.id === 'hormozi'
      ? Math.round(fontSize * 0.075)
      : preset.id === 'beast'
        ? Math.round(fontSize * 0.04)
        : preset.id === 'purple-pop'
          ? 3
          : 0;
  const shadow = preset.id === 'tera-box' || preset.id === 'neon' ? 0 : preset.id === 'clean' ? 3 : 2;
  const backAlpha = preset.id === 'clean' ? '80' : '40';
  const style = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${fontName},${assFontSize},${base},${active},${stroke},&H${backAlpha}000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},5,0,0,0,1
Style: Box,${fontName},${assFontSize},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;

  const events: string[] = [];
  for (const cue of cues) {
    if (cue.end <= cue.start) continue;
    const ox = cue.centerX - cue.boxWidth / 2;
    const oy = cue.centerY - cue.boxHeight / 2;
    const radius = Math.round(cue.fontSize * 0.34);
    const fade = preset.id === 'beast' ? 25 : 45;

    if (preset.box) {
      if (preset.id === 'tera-box') {
        // soft drop shadow, then the white card
        events.push(
          `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&H000000&\\1a&H50&}${roundRectPath(ox, oy + 9, cue.boxWidth, cue.boxHeight, radius)}`,
        );
        events.push(
          `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&}${roundRectPath(ox, oy, cue.boxWidth, cue.boxHeight, radius)}`,
        );
      } else if (preset.id === 'neon') {
        events.push(
          `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&H${assColor('#7C3AED').replace('&H', '').replace('&', '')}&\\1a&H15&}${roundRectPath(ox - 3, oy - 3, cue.boxWidth + 6, cue.boxHeight + 6, radius + 3)}`,
        );
        events.push(
          `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&H160B22&\\1a&H10&}${roundRectPath(ox, oy, cue.boxWidth, cue.boxHeight, radius)}`,
        );
      }
    }

    const cueMs = Math.max(1, Math.round((cue.end - cue.start) * 1000));
    let wordCursor = 0;
    cue.lines.forEach((lineWords, lineIndex) => {
      const y = cue.centerY - ((cue.lines.length - 1) * cue.lineHeight) / 2 + lineIndex * cue.lineHeight;
      let text = '';
      lineWords.forEach((word, lineCursor) => {
        const t0 = Math.max(0, Math.min(cueMs - 30, Math.round((word.start - cue.start) * 1000)));
        const next = cue.words[wordCursor + 1];
        const rawNext = next ? Math.round((next.start - cue.start) * 1000) : cueMs;
        const t1 = Math.max(t0 + 30, Math.min(cueMs, rawNext));
        const raw = escapeAss(preset.uppercase ? word.text.toUpperCase() : word.text);
        const pop = preset.id === 'beast' ? 116 : preset.id === 'clean' ? 102 : 106;
        const enter = preset.id === 'beast' ? '\\fscx112\\fscy112' : '';
        text += `{${enter}\\t(${t0},${t0 + 55},\\c${active}\\fscx${pop}\\fscy${pop})\\t(${t1},${t1 + 55},\\c${base}\\fscx100\\fscy100)}${raw}`;
        if (lineCursor < lineWords.length - 1) text += ' ';
        wordCursor += 1;
      });
      events.push(
        `Dialogue: 1,${assTime(cue.start)},${assTime(cue.end)},Cap,,0,0,0,,{\\fn${fontName}\\an5\\pos(${cue.centerX.toFixed(1)},${y.toFixed(1)})\\fad(${fade},${preset.id === 'beast' ? 40 : 55})}${text}`,
      );
    });
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${frameW}
PlayResY: ${frameH}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

export async function writeCaptionFiles(
  words: Word[],
  outAss: string,
  outSrt: string | undefined,
  options: CaptionOptions,
): Promise<{ cues: number; cleanWords: Word[] }> {
  loadCaptionFonts();
  // Belt and braces: even a hand-edited clip or an old cached transcript must
  // never burn `(gunfire)` or a music note into the video.
  const cleanWords = words
    .map((word) => {
      const text = stripSoundTags(String(word.text || '')).trim();
      return text && isSpeakableToken(text) ? { ...word, text } : null;
    })
    .filter((word): word is Word => Boolean(word));
  const editedCues = Array.isArray(options.subtitles) ? options.subtitles : [];
  const cues = editedCues.length ? makeSubtitleCues(editedCues, options) : makeCues(cleanWords, options);
  await fsp.mkdir(path.dirname(outAss), { recursive: true });
  if (!cues.length) {
    await fsp.writeFile(outAss, `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`, 'utf8');
    return { cues: 0, cleanWords: [] };
  }
  const ass = buildAss(cues, options);
  await fsp.writeFile(outAss, ass, 'utf8');

  if (outSrt) {
    const preset = CAPTION_BY_ID[options.preset];
    const srt = cues
      .map((cue, i) => {
        const text = cue.lines.map((line) => line.map((w) => (preset.uppercase ? w.text.toUpperCase() : w.text)).join(' ')).join('\n');
        return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${text}\n`;
      })
      .join('\n');
    await fsp.writeFile(outSrt, srt, 'utf8');
  }
  return { cues: cues.length, cleanWords };
}

function srtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
