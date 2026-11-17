import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import pngToIco from 'png-to-ico';

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'assets', 'logo+favicon', 'teraclip.png');
const PUBLIC = path.join(ROOT, 'web', 'public');
const BRAND = path.join(PUBLIC, 'brand');
const FAVICONS = path.join(PUBLIC, 'favicons');
const FONTS_SOURCE = path.join(ROOT, 'tools', 'fonts');
const FONTS_OUT = path.join(PUBLIC, 'fonts');

const img = await loadImage(SOURCE);
const full = createCanvas(img.width, img.height);
full.getContext('2d').drawImage(img, 0, 0);
const pixels = full.getContext('2d').getImageData(0, 0, img.width, img.height).data;

let minX = img.width;
let minY = img.height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const alpha = pixels[(y * img.width + x) * 4 + 3]!;
    if (alpha > 12) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.045);
minX = Math.max(0, minX - pad);
minY = Math.max(0, minY - pad);
maxX = Math.min(img.width - 1, maxX + pad);
maxY = Math.min(img.height - 1, maxY + pad);
const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
const side = Math.max(box.width, box.height);
const square = {
  x: box.x - Math.round((side - box.width) / 2),
  y: box.y - Math.round((side - box.height) / 2),
  width: side,
  height: side,
};

await fsp.mkdir(BRAND, { recursive: true });
await fsp.mkdir(FAVICONS, { recursive: true });
await fsp.mkdir(FONTS_OUT, { recursive: true });

function render(size: number, source = square): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, source.x, source.y, source.width, source.height, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}

await fsp.writeFile(path.join(BRAND, 'mark.png'), render(1024));
await fsp.writeFile(path.join(BRAND, 'mark-256.png'), render(256));
await fsp.writeFile(path.join(FAVICONS, 'favicon-32.png'), render(32));
await fsp.writeFile(path.join(FAVICONS, 'favicon-48.png'), render(48));
await fsp.writeFile(path.join(FAVICONS, 'favicon-192.png'), render(192));
await fsp.writeFile(path.join(FAVICONS, 'favicon-512.png'), render(512));
await fsp.writeFile(path.join(FAVICONS, 'apple-touch-icon.png'), render(180));

const ico = await pngToIco([render(16), render(32), render(48), render(64)]);
await fsp.writeFile(path.join(PUBLIC, 'favicon.ico'), ico);

const fontFiles = ['Poppins-ExtraBold.ttf', 'Poppins-Bold.ttf', 'Anton-Regular.ttf', 'BebasNeue-Regular.ttf'];
for (const file of fontFiles) {
  const from = path.join(FONTS_SOURCE, file);
  if (fs.existsSync(from)) await fsp.copyFile(from, path.join(FONTS_OUT, file));
}

console.log('brand generated', { box, square, icoBytes: ico.length });
