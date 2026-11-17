import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as ort from 'onnxruntime-node';

const source = process.argv[2] ?? 'assets/hooking caption/marlon.webp';
const outPath = process.argv[3] ?? 'data/tmp/yunet-probe.png';

const SIZE = 640;
const img = await loadImage(source);
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, SIZE, SIZE);
const aspect = img.width / img.height;
const scaledW = aspect > 1 ? SIZE : Math.round(SIZE * aspect);
const scaledH = aspect > 1 ? Math.round(SIZE / aspect) : SIZE;
const padX = Math.round((SIZE - scaledW) / 2);
const padY = Math.round((SIZE - scaledH) / 2);
ctx.drawImage(img, padX, padY, scaledW, scaledH);
const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

// BGR float32 NCHW, 0..255 like cv::dnn::blobFromImage
const tensor = new Float32Array(3 * SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) {
  tensor[i] = data[i * 4 + 2]; // B
  tensor[SIZE * SIZE + i] = data[i * 4 + 1]; // G
  tensor[2 * SIZE * SIZE + i] = data[i * 4]; // R
}

const started = Date.now();
const session = await ort.InferenceSession.create('tools/models/face_detection_yunet_2023mar.onnx', {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
});
console.log('session ms', Date.now() - started);
const inputName = session.inputNames[0];
const feeds = { [inputName]: new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]) };
const results = await session.run(feeds);
console.log('outputs', Object.keys(results));
for (const key of Object.keys(results)) {
  const v = results[key];
  console.log(key, v.dims, v.type);
}

const strides = [8, 16, 32];
const cls = results['cls_8'] ? results : null;
if (!cls) throw new Error('unexpected output names');

function clamp(v) {
  return Math.min(1, Math.max(0, v));
}

function decode(stride) {
  const clsT = results[`cls_${stride}`].data;
  const objT = results[`obj_${stride}`].data;
  const bboxT = results[`bbox_${stride}`].data;
  const kpsT = results[`kps_${stride}`].data;
  const cols = SIZE / stride;
  const rows = SIZE / stride;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const score = Math.sqrt(clamp(clsT[i]) * clamp(objT[i]));
      if (score < 0.5) continue;
      const cx = (c + bboxT[i * 4]) * stride;
      const cy = (r + bboxT[i * 4 + 1]) * stride;
      const w = Math.exp(bboxT[i * 4 + 2]) * stride;
      const h = Math.exp(bboxT[i * 4 + 3]) * stride;
      const kps = [];
      for (let n = 0; n < 5; n++) {
        kps.push([(kpsT[i * 10 + n * 2] + c) * stride, (kpsT[i * 10 + n * 2 + 1] + r) * stride]);
      }
      out.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, kps });
    }
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

let faces = strides.flatMap(decode);
faces.sort((a, b) => b.score - a.score);
const kept = [];
for (const face of faces) {
  if (kept.some((k) => iou(k, face) > 0.3)) continue;
  kept.push(face);
  if (kept.length >= 50) break;
}
console.log('raw', faces.length, 'kept', kept.length);
for (const face of kept.slice(0, 10)) {
  console.log(JSON.stringify({ score: +face.score.toFixed(3), x: Math.round(face.x), y: Math.round(face.y), w: Math.round(face.w), h: Math.round(face.h) }));
}

const draw = createCanvas(SIZE, SIZE);
const dctx = draw.getContext('2d');
dctx.drawImage(canvas, 0, 0);
for (const face of kept) {
  dctx.strokeStyle = '#00ff88';
  dctx.lineWidth = 3;
  dctx.strokeRect(face.x, face.y, face.w, face.h);
  dctx.fillStyle = '#ffcc00';
  for (const [kx, ky] of face.kps) {
    dctx.beginPath();
    dctx.arc(kx, ky, 3, 0, Math.PI * 2);
    dctx.fill();
  }
  dctx.fillStyle = '#00ff88';
  dctx.font = '20px Arial';
  dctx.fillText(face.score.toFixed(2), face.x + 4, Math.max(20, face.y - 6));
}
fs.mkdirSync('data/tmp', { recursive: true });
fs.writeFileSync(outPath, await draw.encode('png'));
console.log('wrote', outPath);
process.exit(0);
