import fs from 'node:fs';
import fsp from 'node:fs/promises';

export interface AudioAnalysis {
  /** RMS energy per 0.5s, normalised 0..1 */
  points: Array<{ t: number; value: number }>;
  /** local peaks where the 2s average is materially above the rolling baseline */
  peaks: Array<{ t: number; score: number }>;
  mean: number;
  max: number;
}

interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

async function readWavFormat(file: string): Promise<WavFormat> {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const buf = head.subarray(0, bytesRead);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a WAV file');
    let offset = 12;
    let sampleRate = 16000;
    let channels = 1;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(offset + 10);
        sampleRate = buf.readUInt32LE(offset + 12);
        bitsPerSample = buf.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset < 0) throw new Error('WAV data chunk not found');
    return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
  } finally {
    await handle.close();
  }
}

export async function analyzeWav(file: string, windowSec = 0.5): Promise<AudioAnalysis> {
  const fmt = await readWavFormat(file);
  if (fmt.bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth ${fmt.bitsPerSample}`);
  const fileSize = (await fsp.stat(file)).size;
  const dataSize = Math.min(fmt.dataSize || fileSize - fmt.dataOffset, fileSize - fmt.dataOffset);
  const bytesPerSample = 2;
  const samplesPerWindow = Math.max(1, Math.round(fmt.sampleRate * windowSec));
  const bytesPerWindow = samplesPerWindow * fmt.channels * bytesPerSample;
  const points: Array<{ t: number; value: number }> = [];
  let windowIndex = 0;
  let buffer: Buffer = Buffer.alloc(0);

  const stream = fs.createReadStream(file, { start: fmt.dataOffset, end: fmt.dataOffset + dataSize - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
    while (buffer.length >= bytesPerWindow) {
      const slice = buffer.subarray(0, bytesPerWindow);
      buffer = buffer.subarray(bytesPerWindow);
      let sum = 0;
      let count = 0;
      for (let i = 0; i + 1 < slice.length; i += fmt.channels * 2) {
        const sample = slice.readInt16LE(i) / 32768;
        sum += sample * sample;
        count += 1;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      const db = 20 * Math.log10(rms + 1e-7);
      const value = Math.max(0, Math.min(1, (db + 55) / 55));
      points.push({ t: windowIndex * windowSec, value });
      windowIndex += 1;
    }
  }
  if (buffer.length > bytesPerSample) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i + 1 < buffer.length; i += fmt.channels * 2) {
      const sample = buffer.readInt16LE(i) / 32768;
      sum += sample * sample;
      count += 1;
    }
    const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, count)) + 1e-7);
    points.push({ t: windowIndex * windowSec, value: Math.max(0, Math.min(1, (db + 55) / 55)) });
  }

  const values = points.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const max = values.reduce((a, b) => Math.max(a, b), 0);

  // A shifting baseline makes silence-relative spikes visible in quiet stream audio.
  const peaks: Array<{ t: number; score: number }> = [];
  const radius = 12; // 6 seconds around each point
  for (let i = 0; i < points.length; i++) {
    let local = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(points.length - 1, i + radius); j++) {
      local += points[j]!.value;
      count += 1;
    }
    local /= Math.max(1, count);
    const score = Math.max(0, (points[i]!.value - local) * 3.5);
    if (score > 0.18 && points[i]!.value > 0.35) peaks.push({ t: points[i]!.t, score: Math.min(1, score) });
  }

  // merge adjacent peaks and keep the strongest one per 4s bucket
  const buckets = new Map<number, { t: number; score: number }>();
  for (const peak of peaks) {
    const key = Math.floor(peak.t / 4);
    const prev = buckets.get(key);
    if (!prev || peak.score > prev.score) buckets.set(key, peak);
  }

  return { points, peaks: [...buckets.values()].sort((a, b) => b.score - a.score).slice(0, 80), mean, max };
}
