import type { AspectRatio, FaceSample, ReframeMode } from '../../shared/types';
import { ASPECT_SIZES } from '../../shared/presets';
import { PATHS } from '../config';
import { decodeRgbFrames, type RgbFrame } from './media';

/** YuNet expects a 640x640 BGR blob in 0..255, exactly like cv::dnn::blobFromImage. */
const MODEL_SIZE = 640;
const SCORE_THRESHOLD = 0.6;
const NMS_IOU = 0.3;
const SAMPLE_FPS = 2;

interface Detection {
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

type OrtModule = typeof import('onnxruntime-node');
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

let ortModule: OrtModule | null = null;
let sessionPromise: Promise<OrtSession | null> | null = null;
let inputBuffer: Float32Array | null = null;

async function getSession(): Promise<OrtSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        ortModule ??= await import('onnxruntime-node');
        const session = await ortModule.InferenceSession.create(PATHS.yunet, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });
        return session;
      } catch (error) {
        console.warn('[reframe] YuNet unavailable, falling back to centre crop:', (error as Error).message);
        return null;
      }
    })();
  }
  return sessionPromise;
}

/** Warm the model in the background so the first clip does not pay the load cost. */
export function warmFaceModel(): void {
  void getSession();
}

function decodeStride(outputs: Record<string, import('onnxruntime-node').Tensor>, stride: number): Detection[] {
  const cls = outputs[`cls_${stride}`]?.data as Float32Array | undefined;
  const obj = outputs[`obj_${stride}`]?.data as Float32Array | undefined;
  const bbox = outputs[`bbox_${stride}`]?.data as Float32Array | undefined;
  if (!cls || !obj || !bbox) return [];
  const cols = MODEL_SIZE / stride;
  const rows = MODEL_SIZE / stride;
  const found: Detection[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
      if (score < SCORE_THRESHOLD) continue;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride;
      const h = Math.exp(bbox[i * 4 + 3]!) * stride;
      found.push({
        score,
        x: (c + bbox[i * 4]!) * stride - w / 2,
        y: (r + bbox[i * 4 + 1]!) * stride - h / 2,
        w,
        h,
      });
    }
  }
  return found;
}

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Detect faces in a letterboxed 640 RGB frame and map them back to source pixels. */
export async function detectFaces(frame: RgbFrame): Promise<Array<Detection & { cx: number; cy: number }>> {
  const session = await getSession();
  if (!session) return [];

  inputBuffer ??= new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const buf = inputBuffer;
  const pixelCount = MODEL_SIZE * MODEL_SIZE;
  const rgb = frame.rgb;
  for (let i = 0; i < pixelCount; i++) {
    buf[i] = rgb[i * 3 + 2]!; // B
    buf[pixelCount + i] = rgb[i * 3 + 1]!; // G
    buf[pixelCount * 2 + i] = rgb[i * 3]!; // R
  }

  const ort = ortModule!;
  const tensor = new ort.Tensor('float32', buf, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const inputName = session.inputNames[0]!;
  const outputs = (await session.run({ [inputName]: tensor })) as Record<string, import('onnxruntime-node').Tensor>;

  let faces = [8, 16, 32].flatMap((stride) => decodeStride(outputs, stride));
  faces.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const face of faces) {
    if (kept.some((other) => iou(other, face) > NMS_IOU)) continue;
    kept.push(face);
    if (kept.length >= 20) break;
  }

  const scaledW = frame.scale;
  const scaledH = MODEL_SIZE - frame.padY * 2;
  const toSourceX = frame.sourceWidth / scaledW;
  const toSourceY = frame.sourceHeight / scaledH;
  return kept.map((face) => {
    const x = (face.x - frame.padX) * toSourceX;
    const y = (face.y - frame.padY) * toSourceY;
    const w = face.w * toSourceX;
    const h = face.h * toSourceY;
    return { ...face, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  });
}

interface FrameTarget {
  t: number;
  cx: number | null;
  cy: number | null;
  /** normalized face-box width, 0..1 */
  fw: number | null;
  /** normalized face-box height, 0..1 */
  fh: number | null;
  faces: number;
}

export interface ReframeOptions {
  sourcePath: string;
  start: number;
  duration: number;
  sourceWidth: number;
  sourceHeight: number;
  aspect: AspectRatio;
  mode: ReframeMode;
  outputWidth: number;
  outputHeight: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export interface ReframePlan {
  mode: ReframeMode;
  /** Filter chain (without setpts) that produces the output frame size. */
  filter: string;
  faceSamples: FaceSample[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.floor(clean.length / 2)]!;
}

/** Ramer-Douglas-Peucker on (t, value) pairs, tolerance in source pixels. */
function simplify(points: Array<{ t: number; v: number }>, tolerance: number): Array<{ t: number; v: number }> {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const a = points[from]!;
    const b = points[to]!;
    let maxDist = -1;
    let index = -1;
    for (let i = from + 1; i < to; i++) {
      const p = points[i]!;
      const span = b.t - a.t;
      const ratio = span <= 0 ? 0 : (p.t - a.t) / span;
      const projected = a.v + (b.v - a.v) * ratio;
      const dist = Math.abs(p.v - projected);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function axisExpression(points: Array<{ t: number; v: number }>, clampMin: number, clampMax: number): string {
  if (!points.length) return String(Math.round((clampMin + clampMax) / 2));
  const parts: string[] = [];
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const span = b.t - a.t;
    if (span <= 0.001) continue;
    const value = `${fmt(a.v)}+${fmt(b.v - a.v)}*(t-${a.t.toFixed(3)})/${span.toFixed(3)}`;
    parts.push(`if(lt(t,${b.t.toFixed(3)}),${value}`);
  }
  let expr = fmt(points[points.length - 1]!.v);
  for (let i = parts.length - 1; i >= 0; i--) expr = `${parts[i]},${expr})`;
  return `min(max(${expr},${fmt(clampMin)}),${fmt(clampMax)})`;
}

interface CropGeometry {
  cropW: number;
  cropH: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
}

function geometryForRatio(sourceWidth: number, sourceHeight: number, targetAspect: number): CropGeometry {
  const sourceAspect = sourceWidth / sourceHeight;
  let cropW: number;
  let cropH: number;
  if (sourceAspect > targetAspect) {
    cropH = sourceHeight;
    cropW = Math.round(sourceHeight * targetAspect);
  } else {
    cropW = sourceWidth;
    cropH = Math.round(sourceWidth / targetAspect);
  }
  cropW = Math.max(2, Math.min(sourceWidth, cropW));
  cropH = Math.max(2, Math.min(sourceHeight, cropH));
  return {
    cropW,
    cropH,
    maxX: Math.max(0, sourceWidth - cropW),
    maxY: Math.max(0, sourceHeight - cropH),
    centerX: (sourceWidth - cropW) / 2,
    centerY: (sourceHeight - cropH) / 2,
  };
}

function geometryFor(sourceWidth: number, sourceHeight: number, aspect: AspectRatio): CropGeometry {
  const target = ASPECT_SIZES[aspect];
  return geometryForRatio(sourceWidth, sourceHeight, target.width / target.height);
}

function pickPrimary(
  faces: Array<{ cx: number; cy: number; w: number; h: number }>,
  anchor: { cx: number; area: number } | null,
  sourceWidth: number,
): { cx: number; cy: number; w: number; h: number } | null {
  if (!faces.length) return null;
  let best: { cx: number; cy: number; w: number; h: number } | null = null;
  let bestScore = -1;
  for (const face of faces) {
    const area = face.w * face.h;
    let score = area;
    if (anchor) {
      const distance = Math.abs(face.cx - anchor.cx);
      const stickRadius = Math.max(anchor.area ** 0.5 * 2.2, sourceWidth * 0.12);
      const stick = distance < stickRadius ? 1.45 : 1;
      const sizeRatio = area / Math.max(1, anchor.area);
      score *= stick * (sizeRatio > 2.2 ? 1.25 : 1);
    }
    const centrality = 1 - Math.abs(face.cx - sourceWidth / 2) / (sourceWidth / 2);
    score *= 1 + 0.12 * Math.max(0, centrality);
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }
  return best;
}

interface FaceAnalysis {
  faceSamples: FaceSample[];
  times: number[];
  xs: number[];
  ys: number[];
}

async function detectTargets(opts: ReframeOptions): Promise<FrameTarget[]> {
  const targets: FrameTarget[] = [];
  const estimatedFrames = Math.max(1, Math.ceil(opts.duration * SAMPLE_FPS));
  let anchor: { cx: number; area: number } | null = null;

  try {
    await decodeRgbFrames(opts.sourcePath, {
      start: opts.start,
      duration: opts.duration,
      fps: SAMPLE_FPS,
      sourceWidth: opts.sourceWidth,
      sourceHeight: opts.sourceHeight,
      signal: opts.signal,
      onFrame: async (frame) => {
        const detections = await detectFaces(frame);
        const primary = pickPrimary(detections, anchor, opts.sourceWidth);
        if (primary) anchor = { cx: primary.cx, area: primary.w * primary.h };
        targets.push({
          t: frame.t - opts.start,
          cx: primary?.cx ?? null,
          cy: primary?.cy ?? null,
          fw: primary ? primary.w / opts.sourceWidth : null,
          fh: primary ? primary.h / opts.sourceHeight : null,
          faces: detections.length,
        });
        opts.onProgress?.(Math.min(1, targets.length / estimatedFrames));
      },
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    console.warn('[reframe] face sampling failed, using centre crop:', (error as Error).message);
  }
  return targets;
}

function smoothTargets(
  targets: FrameTarget[],
  geometry: CropGeometry,
  opts: ReframeOptions,
  yBias = 0.06,
): FaceAnalysis {
  if (!targets.length) {
    const faceSamples: FaceSample[] = [
      {
        t: 0,
        x: (geometry.centerX + geometry.cropW / 2) / opts.sourceWidth,
        w: geometry.cropW / opts.sourceWidth,
        y: (geometry.centerY + geometry.cropH / 2) / opts.sourceHeight,
        h: geometry.cropH / opts.sourceHeight,
        faces: 0,
      },
    ];
    return {
      faceSamples,
      times: [0, opts.duration],
      xs: [geometry.centerX, geometry.centerX],
      ys: [geometry.centerY, geometry.centerY],
    };
  }

  // Median-of-3 before smoothing removes single-frame landmark spikes.
  const rawX: Array<number | null> = targets.map((target) => target.cx);
  const rawY: Array<number | null> = targets.map((target) => target.cy);
  const filteredX = rawX.map((_, i) => median([rawX[i - 1] ?? null, rawX[i] ?? null, rawX[i + 1] ?? null]));
  const filteredY = rawY.map((_, i) => median([rawY[i - 1] ?? null, rawY[i] ?? null, rawY[i + 1] ?? null]));

  const dt = 1 / SAMPLE_FPS;
  const maxStep = opts.sourceWidth * 0.9 * dt;
  let smoothX = (filteredX.find((value) => value !== null) ?? opts.sourceWidth / 2)!;
  let smoothY = (filteredY.find((value) => value !== null) ?? opts.sourceHeight / 2)!;
  let velocityX = 0;
  let velocityY = 0;
  let lastFaceAt = 0;

  const xs: number[] = [];
  const ys: number[] = [];
  const times: number[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!.t;
    times.push(t);
    const targetX = filteredX[i];
    const targetY = filteredY[i];
    if (targetX !== null) {
      lastFaceAt = t;
      if (Math.abs(targetX - smoothX) > opts.sourceWidth * 0.3) {
        // Hard scene cut / new speaker: settle immediately instead of gliding over.
        smoothX = targetX;
        velocityX = 0;
      } else {
        // Alpha-beta filter: unlike plain EMA it has no steady-state lag, so a
        // creator walking across the frame stays centred instead of trailing.
        const predicted = smoothX + velocityX * dt;
        const residual = targetX - predicted;
        if (Math.abs(residual) > geometry.cropW * 0.01) {
          const alpha = Math.abs(residual) > geometry.cropW * 0.5 ? 0.65 : 0.38;
          const beta = 0.12;
          const next = predicted + residual * alpha;
          const step = clamp(next - smoothX, -maxStep, maxStep);
          smoothX += step;
          velocityX = clamp(velocityX + (beta * residual) / dt, -opts.sourceWidth, opts.sourceWidth);
        }
      }
      if (targetY !== null) {
        const desiredY = targetY + geometry.cropH * yBias;
        if (Math.abs(desiredY - smoothY) > opts.sourceHeight * 0.3) {
          smoothY = desiredY;
          velocityY = 0;
        } else {
          const predicted = smoothY + velocityY * dt;
          const residual = desiredY - predicted;
          if (Math.abs(residual) > geometry.cropH * 0.012) {
            const alpha = Math.abs(residual) > geometry.cropH * 0.45 ? 0.6 : 0.32;
            const next = predicted + residual * alpha;
            const step = clamp(next - smoothY, -maxStep, maxStep);
            smoothY += step;
            velocityY = clamp(velocityY + (0.08 * residual) / dt, -opts.sourceHeight, opts.sourceHeight);
          }
        }
      }
    } else if (t - lastFaceAt > 1.5) {
      // No face for a while: drift calmly back to the middle of the frame.
      velocityX *= 0.8;
      velocityY *= 0.8;
      smoothX += clamp((opts.sourceWidth / 2 - smoothX) * 0.03, -maxStep * 0.25, maxStep * 0.25);
      smoothY += clamp((opts.sourceHeight / 2 - smoothY) * 0.03, -maxStep * 0.25, maxStep * 0.25);
    }
    xs.push(clamp(smoothX - geometry.cropW / 2, 0, geometry.maxX));
    ys.push(clamp(smoothY - geometry.cropH / 2, 0, geometry.maxY));
  }

  const finalX = xs[xs.length - 1] ?? geometry.centerX;
  const finalY = ys[ys.length - 1] ?? geometry.centerY;
  times.push(opts.duration);
  xs.push(finalX);
  ys.push(finalY);

  const faceSamples: FaceSample[] = times.slice(0, -1).map((t, i) => ({
    t: Math.round(t * 100) / 100,
    x: (xs[i]! + geometry.cropW / 2) / opts.sourceWidth,
    w: geometry.cropW / opts.sourceWidth,
    y: (ys[i]! + geometry.cropH / 2) / opts.sourceHeight,
    h: geometry.cropH / opts.sourceHeight,
    fw: targets[i]?.fw ?? undefined,
    fh: targets[i]?.fh ?? undefined,
    faces: targets[i]?.faces ?? 0,
  }));

  return { faceSamples, times, xs, ys };
}

async function analyzeFaces(opts: ReframeOptions, geometry: CropGeometry): Promise<FaceAnalysis> {
  const targets = await detectTargets(opts);
  return smoothTargets(targets, geometry, opts);
}

function cropFilter(
  geometry: CropGeometry,
  times: number[],
  xs: number[],
  ys: number[],
  outputWidth: number,
  outputHeight: number,
): string {
  const xPoints = times.map((t, i) => ({ t, v: xs[i]! }));
  const yPoints = times.map((t, i) => ({ t, v: ys[i]! }));
  const xTolerance = Math.max(1, geometry.cropW * 0.008);
  const yTolerance = Math.max(1, geometry.cropH * 0.008);
  const xExpr = axisExpression(simplify(xPoints, xTolerance), 0, geometry.maxX);
  const yExpr = axisExpression(simplify(yPoints, yTolerance), 0, geometry.maxY);
  // Commas inside ffmpeg expressions must be protected from filtergraph parsing.
  const crop = `crop=${geometry.cropW}:${geometry.cropH}:'${xExpr}':'${yExpr}'`;
  return `${crop},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`;
}

function centreFilter(geometry: CropGeometry, outputWidth: number, outputHeight: number): string {
  return `crop=${geometry.cropW}:${geometry.cropH}:${Math.round(geometry.centerX)}:${Math.round(geometry.centerY)},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`;
}

const SPLIT_TOP_RATIO = 0.62;

/**
 * Gameplay + facecam vertical layout. The game keeps the top 62% of the
 * frame (centre-cropped to fill it) while the tracked webcam panel fills the
 * bottom 38%. This is the standard stacked Shorts/TikTok stream layout.
 */
function splitFilter(
  gameGeometry: CropGeometry,
  camGeometry: CropGeometry,
  camTimes: number[],
  camXs: number[],
  camYs: number[],
  outputWidth: number,
  outputHeight: number,
): string {
  const topHeight = Math.round(outputHeight * SPLIT_TOP_RATIO);
  const bottomHeight = outputHeight - topHeight;
  const xExpr = axisExpression(
    simplify(camTimes.map((t, i) => ({ t, v: camXs[i]! })), Math.max(1, camGeometry.cropW * 0.006)),
    0,
    camGeometry.maxX,
  );
  const yExpr = axisExpression(
    simplify(camTimes.map((t, i) => ({ t, v: camYs[i]! })), Math.max(1, camGeometry.cropH * 0.006)),
    0,
    camGeometry.maxY,
  );
  const camCrop = `crop=${camGeometry.cropW}:${camGeometry.cropH}:'${xExpr}':'${yExpr}'`;
  return [
    'split=2[game][cam]',
    `[game]crop=${gameGeometry.cropW}:${gameGeometry.cropH}:${Math.round(gameGeometry.centerX)}:${Math.round(gameGeometry.centerY)},scale=${outputWidth}:${topHeight}:flags=lanczos,setsar=1[top]`,
    `[cam]${camCrop},scale=${outputWidth}:${bottomHeight}:flags=lanczos,setsar=1,drawbox=x=0:y=0:w=iw:h=3:color=black@0.55:t=fill[bottom]`,
    '[top][bottom]vstack=inputs=2,setsar=1',
  ].join(';');
}

function camGeometryForFaceWidths(
  sourceWidth: number,
  sourceHeight: number,
  faceWidths: number[],
  targetAspect: number,
): CropGeometry {
  const clean = faceWidths.filter((width) => Number.isFinite(width) && width > 4).sort((a, b) => a - b);
  const faceWidth = clean.length ? clean[Math.floor(clean.length / 2)]! : sourceWidth * 0.26;
  let cropW = clamp(faceWidth * 3.2, sourceWidth * 0.18, sourceWidth * 0.68);
  let cropH = cropW / targetAspect;
  const maxH = sourceHeight * 0.82;
  if (cropH > maxH) {
    cropH = maxH;
    cropW = cropH * targetAspect;
  }
  cropW = Math.max(2, Math.min(sourceWidth, Math.round(cropW)));
  cropH = Math.max(2, Math.min(sourceHeight, Math.round(cropH)));
  return {
    cropW,
    cropH,
    maxX: Math.max(0, sourceWidth - cropW),
    maxY: Math.max(0, sourceHeight - cropH),
    centerX: (sourceWidth - cropW) / 2,
    centerY: (sourceHeight - cropH) / 2,
  };
}

function camGeometryForTargets(
  sourceWidth: number,
  sourceHeight: number,
  targets: FrameTarget[],
  targetAspect: number,
): CropGeometry {
  return camGeometryForFaceWidths(
    sourceWidth,
    sourceHeight,
    targets.map((target) => (target.fw ? target.fw * sourceWidth : 0)),
    targetAspect,
  );
}

function blurFilter(outputWidth: number, outputHeight: number): string {
  return [
    `split=2[bg][fg]`,
    `[bg]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight},gblur=sigma=28,eq=brightness=-0.14[blurred]`,
    `[fg]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease[sharp]`,
    `[blurred][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1`,
  ].join(';');
}

export async function planReframe(opts: ReframeOptions): Promise<ReframePlan> {
  const geometry = geometryFor(opts.sourceWidth, opts.sourceHeight, opts.aspect);

  if (opts.mode === 'blur') {
    return { mode: 'blur', filter: blurFilter(opts.outputWidth, opts.outputHeight), faceSamples: [] };
  }

  if (opts.mode === 'split') {
    if (opts.sourceWidth <= 16 || opts.sourceHeight <= 16) {
      return { mode: 'center', filter: centreFilter(geometry, opts.outputWidth, opts.outputHeight), faceSamples: [] };
    }
    const topHeight = Math.round(opts.outputHeight * SPLIT_TOP_RATIO);
    const bottomHeight = opts.outputHeight - topHeight;
    const gameGeometry = geometryForRatio(opts.sourceWidth, opts.sourceHeight, opts.outputWidth / topHeight);
    const targets = await detectTargets(opts);
    const camGeometry = camGeometryForTargets(
      opts.sourceWidth,
      opts.sourceHeight,
      targets,
      opts.outputWidth / bottomHeight,
    );
    const tracked = smoothTargets(targets, camGeometry, opts, 0.14);
    return {
      mode: 'split',
      filter: splitFilter(gameGeometry, camGeometry, tracked.times, tracked.xs, tracked.ys, opts.outputWidth, opts.outputHeight),
      faceSamples: tracked.faceSamples,
    };
  }

  if (opts.mode === 'center') {
    const filter =
      geometry.cropW >= opts.sourceWidth && geometry.cropH >= opts.sourceHeight
        ? `scale=${opts.outputWidth}:${opts.outputHeight}:flags=lanczos,setsar=1`
        : `crop=${geometry.cropW}:${geometry.cropH}:${Math.round(geometry.centerX)}:${Math.round(geometry.centerY)},scale=${opts.outputWidth}:${opts.outputHeight}:flags=lanczos,setsar=1`;
    return { mode: 'center', filter, faceSamples: [] };
  }

  if (opts.sourceWidth <= 16 || opts.sourceHeight <= 16) {
    return { mode: 'center', filter: centreFilter(geometry, opts.outputWidth, opts.outputHeight), faceSamples: [] };
  }

  const analysis = await analyzeFaces(opts, geometry);
  return {
    mode: 'smart',
    filter: cropFilter(geometry, analysis.times, analysis.xs, analysis.ys, opts.outputWidth, opts.outputHeight),
    faceSamples: analysis.faceSamples,
  };
}

export function cropExpressionForSamples(
  faceSamples: FaceSample[] | undefined,
  sourceWidth: number,
  sourceHeight: number,
  aspect: AspectRatio,
  outputWidth: number,
  outputHeight: number,
  duration: number,
): string {
  if (!faceSamples?.length) {
    const geometry = geometryFor(sourceWidth, sourceHeight, aspect);
    return centreFilter(geometry, outputWidth, outputHeight);
  }
  const geometry = geometryFor(sourceWidth, sourceHeight, aspect);
  const times: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sample of faceSamples) {
    times.push(clamp(sample.t, 0, duration));
    xs.push(clamp(sample.x * sourceWidth - geometry.cropW / 2, 0, geometry.maxX));
    ys.push(clamp((sample.y ?? 0.5) * sourceHeight - geometry.cropH / 2, 0, geometry.maxY));
  }
  if (times[times.length - 1]! < duration - 0.01) {
    times.push(duration);
    xs.push(xs[xs.length - 1] ?? geometry.centerX);
    ys.push(ys[ys.length - 1] ?? geometry.centerY);
  }
  return cropFilter(geometry, times, xs, ys, outputWidth, outputHeight);
}

/**
 * Rebuild the split layout from stored face samples (edit re-renders). The
 * webcam crop size is derived from the stored face-box widths so a re-render
 * does not need to detect faces again.
 */
export function splitExpressionForSamples(
  faceSamples: FaceSample[] | undefined,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  duration: number,
): string {
  const topHeight = Math.round(outputHeight * SPLIT_TOP_RATIO);
  const bottomHeight = outputHeight - topHeight;
  const gameGeometry = geometryForRatio(sourceWidth, sourceHeight, outputWidth / topHeight);
  const camGeometry = camGeometryForFaceWidths(
    sourceWidth,
    sourceHeight,
    (faceSamples || []).map((sample) => (sample.fw ? sample.fw * sourceWidth : 0)),
    outputWidth / bottomHeight,
  );
  const times: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sample of faceSamples || []) {
    times.push(clamp(sample.t, 0, duration));
    xs.push(clamp(sample.x * sourceWidth - camGeometry.cropW / 2, 0, camGeometry.maxX));
    ys.push(clamp((sample.y ?? 0.5) * sourceHeight - camGeometry.cropH / 2, 0, camGeometry.maxY));
  }
  if (!times.length) {
    times.push(0, duration);
    xs.push(camGeometry.centerX, camGeometry.centerX);
    ys.push(camGeometry.centerY, camGeometry.centerY);
  } else if (times[times.length - 1]! < duration - 0.01) {
    times.push(duration);
    xs.push(xs[xs.length - 1] ?? camGeometry.centerX);
    ys.push(ys[ys.length - 1] ?? camGeometry.centerY);
  }
  return splitFilter(gameGeometry, camGeometry, times, xs, ys, outputWidth, outputHeight);
}
