import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type { AspectRatio, HookStyleId } from '../../shared/types';
import { ASPECT_SIZES } from '../../shared/presets';
import { PATHS } from '../config';

const EMOJI_FONT =
  process.platform === 'win32'
    ? '"Segoe UI Emoji"'
    : process.platform === 'darwin'
      ? '"Apple Color Emoji"'
      : '"Noto Color Emoji"';

const WORD_FONT = '800 {size}px "Poppins", Inter, sans-serif';
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Token {
  text: string;
  graphemes: Array<{ text: string; emoji: boolean }>;
  width: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function isEmoji(grapheme: string): boolean {
  return /\p{Extended_Pictographic}/u.test(grapheme) || /[\u{1F1E6}-\u{1F1FF}]/u.test(grapheme);
}

function tokenizeWord(text: string, size: number): Token {
  const ctx = createCanvas(10, 10).getContext('2d');
  const graphemes = [...graphemeSegmenter.segment(text)].map((part) => ({
    text: part.segment,
    emoji: isEmoji(part.segment),
  }));
  let width = 0;
  for (const grapheme of graphemes) {
    ctx.font = grapheme.emoji ? `${size}px ${EMOJI_FONT}` : WORD_FONT.replace('{size}', String(size));
    width += ctx.measureText(grapheme.text).width;
  }
  return { text, graphemes, width };
}

function measureLine(tokens: Token[], size: number): number {
  if (!tokens.length) return 0;
  const ctx = createCanvas(10, 10).getContext('2d');
  ctx.font = WORD_FONT.replace('{size}', String(size));
  const space = ctx.measureText(' ').width;
  return tokens.reduce((sum, token) => sum + token.width, 0) + space * (tokens.length - 1);
}

function wrapTokens(text: string, size: number, maxWidth: number): Token[][] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: Token[][] = [];
  let line: Token[] = [];
  const ctx = createCanvas(10, 10).getContext('2d');
  ctx.font = WORD_FONT.replace('{size}', String(size));
  const space = ctx.measureText(' ').width;
  let lineWidth = 0;
  for (const word of words) {
    const token = tokenizeWord(word, size);
    const nextWidth = line.length ? lineWidth + space + token.width : token.width;
    if (line.length && nextWidth > maxWidth) {
      lines.push(line);
      line = [token];
      lineWidth = token.width;
    } else {
      line.push(token);
      lineWidth = nextWidth;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function drawTokenLine(
  ctx: SKRSContext2D,
  tokens: Token[],
  centerX: number,
  centerY: number,
  size: number,
  color: string,
): void {
  ctx.font = WORD_FONT.replace('{size}', String(size));
  ctx.fillStyle = color;
  const space = ctx.measureText(' ').width;
  const total = measureLine(tokens, size);
  let x = centerX - total / 2;
  ctx.textBaseline = 'middle';
  for (const token of tokens) {
    for (const grapheme of token.graphemes) {
      ctx.font = grapheme.emoji ? `${size}px ${EMOJI_FONT}` : WORD_FONT.replace('{size}', String(size));
      ctx.fillStyle = color;
      ctx.fillText(grapheme.text, x, centerY);
      x += ctx.measureText(grapheme.text).width;
    }
    x += space;
  }
}

export interface HookRenderOptions {
  text: string;
  style: HookStyleId;
  aspect: AspectRatio;
  out: string;
  watermark?: boolean;
  brandHandle?: string;
  /** Place the card centre at this y (used to straddle a panel seam). */
  centerAt?: number;
  /** Override the card's vertical position. */
  top?: number;
}

export async function renderHookPng(options: HookRenderOptions): Promise<boolean> {
  if (options.style === 'none') return false;
  const clean = options.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!clean) return false;

  const poppins = path.join(PATHS.fonts, 'Poppins-ExtraBold.ttf');
  if (fs.existsSync(poppins)) {
    try {
      GlobalFonts.registerFromPath(poppins);
    } catch {
      /* already registered */
    }
  }

  const { width: frameW, height: frameH } = ASPECT_SIZES[options.aspect];
  const scale = Math.min(frameW, frameH) / 1080;
  const maxCardWidth = Math.min(frameW * 0.86, 940 * scale + 220);
  const padX = Math.round(34 * Math.max(0.85, scale));
  const padY = Math.round(24 * Math.max(0.85, scale));
  const maxTextWidth = maxCardWidth - padX * 2;
  let size = Math.round(52 * Math.max(0.82, Math.min(1.2, scale)));
  let lines: Token[][] = [];
  let lineHeight = 0;

  for (const candidate of [size, size - 4, size - 8, 42, 38]) {
    lines = wrapTokens(clean, candidate, maxTextWidth);
    if (lines.length <= 3) {
      size = candidate;
      break;
    }
  }
  if (lines.length > 3) {
    lines = lines.slice(0, 3);
    const last = lines[2]!;
    if (last.length) last[last.length - 1] = tokenizeWord(`${last[last.length - 1]!.text}…`, size);
  }
  lineHeight = Math.round(size * 1.2);
  const cardHeight = lines.length * lineHeight + padY * 2;
  const maxLineWidth = Math.max(...lines.map((line) => measureLine(line, size)), 200);
  const cardWidth = Math.min(maxCardWidth, maxLineWidth + padX * 2);
  const cardX = (frameW - cardWidth) / 2;
  const top = options.centerAt != null
    ? Math.round(options.centerAt - cardHeight / 2)
    : options.top ?? (options.aspect === '9:16' ? Math.round(frameH * 0.075) : options.aspect === '1:1' ? 74 : 54);

  const canvas = createCanvas(frameW, frameH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, frameW, frameH);

  const style = options.style;
  const textColor = style === 'white' ? '#0A0A0C' : '#FFFFFF';
  const radius = Math.round(26 * Math.max(0.85, scale));

  ctx.save();
    ctx.shadowColor = 'rgba(10, 6, 20, 0.22)';
    ctx.shadowBlur = Math.round(34 * Math.max(0.8, scale));
    ctx.shadowOffsetY = Math.round(12 * Math.max(0.8, scale));
    ctx.beginPath();
    const r = radius;
    const x = cardX;
    const y = top;
    const w = cardWidth;
    const h = cardHeight;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    if (style === 'purple') {
      const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
      gradient.addColorStop(0, '#6D28D9');
      gradient.addColorStop(1, '#9333EA');
      ctx.fillStyle = gradient;
    } else if (style === 'black') {
      ctx.fillStyle = '#111116';
    } else {
      ctx.fillStyle = '#FFFFFF';
    }
    ctx.fill();
    ctx.restore();

    // hairline inner highlight, adds a crafted feel without visual noise
    ctx.save();
    ctx.globalAlpha = style === 'white' ? 0.07 : 0.16;
    ctx.strokeStyle = style === 'white' ? '#000000' : '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const inset = 1.5;
    ctx.roundRect(cardX + inset, top + inset, cardWidth - inset * 2, cardHeight - inset * 2, radius - 1);
    ctx.stroke();
    ctx.restore();

    const baseY = top + padY + lineHeight / 2;
    lines.forEach((line, index) => {
      drawTokenLine(ctx, line, frameW / 2, baseY + index * lineHeight, size, textColor);
    });

  if (options.watermark) {
    const label = options.brandHandle ? options.brandHandle.replace(/^@?/, '@') : 'teraclip';
    const fontSize = Math.round(26 * Math.max(0.8, scale));
    ctx.font = `700 ${fontSize}px "Poppins", Inter, sans-serif`;
    const width = ctx.measureText(label).width;
    const x = frameW - width - 54;
    const y = frameH - Math.round(frameH * 0.055);
    ctx.save();
    ctx.fillStyle = 'rgba(17, 12, 28, 0.45)';
    ctx.beginPath();
    ctx.roundRect(x - 30, y - fontSize - 10, width + 58, fontSize + 24, 14);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 2);
    ctx.fillStyle = '#A855F7';
    ctx.beginPath();
    ctx.arc(x - 14, y + 1, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  await fsp.mkdir(path.dirname(options.out), { recursive: true });
  await fsp.writeFile(options.out, await canvas.encode('png'));
  return true;
}

export async function renderHookPreview(options: Omit<HookRenderOptions, 'out'> & { out: string }): Promise<void> {
  await renderHookPng(options);
}
