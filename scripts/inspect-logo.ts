import { createCanvas, loadImage } from '@napi-rs/canvas';

const img = await loadImage('assets/logo+favicon/teraclip.png');
console.log('size', img.width, img.height);
const c = createCanvas(img.width, img.height);
const ctx = c.getContext('2d');
ctx.drawImage(img, 0, 0);
const d = ctx.getImageData(0, 0, img.width, img.height).data;
let minX = img.width;
let minY = img.height;
let maxX = 0;
let maxY = 0;
let transparent = 0;
let white = 0;
const total = img.width * img.height;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const a = d[i + 3]!;
    if (a < 10) {
      transparent++;
      continue;
    }
    if (d[i]! > 245 && d[i + 1]! > 245 && d[i + 2]! > 245) white++;
    if (a > 20) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log({ transparent, white, total, bbox: [minX, minY, maxX, maxY], corner: [d[0], d[1], d[2], d[3]] });
