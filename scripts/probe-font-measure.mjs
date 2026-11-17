import fs from 'node:fs';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';

GlobalFonts.registerFromPath('tools/fonts/Poppins-ExtraBold.ttf', 'PoppinsGround');

const text = 'THIS IS INSANE RIGHT NOW';
const canvas = createCanvas(1080, 500);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#111';
ctx.fillRect(0, 0, 1080, 500);
ctx.fillStyle = '#fff';
ctx.textBaseline = 'alphabetic';
ctx.font = '50px "PoppinsGround"';
const wGround = ctx.measureText(text).width;
ctx.fillText(text, 30, 80);
ctx.font = '700 50px "PoppinsGround"';
const wGround700 = ctx.measureText(text).width;
ctx.fillText(text, 30, 160);
ctx.font = '400 50px Arial';
const wArial = ctx.measureText(text).width;
ctx.fillText(text, 30, 240);
ctx.font = '700 50px Arial';
const wArial700 = ctx.measureText(text).width;
ctx.fillText(text, 30, 320);
fs.writeFileSync('data/tmp/font-ground.png', await canvas.encode('png'));

const img = await loadImage('data/tmp/fontvariants.png');
const c2 = createCanvas(img.width, img.height);
const x2 = c2.getContext('2d');
x2.drawImage(img, 0, 0);
const data = x2.getImageData(0, 0, img.width, img.height).data;
function extent(y0, y1) {
  let min = Infinity;
  let max = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (data[i] > 170 && data[i + 1] > 170 && data[i + 2] > 170) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  return { min, max, width: max - min + 1 };
}
console.log(JSON.stringify({ wGround, wGround700, wArial, wArial700 }, null, 2));
for (let i = 0; i < 8; i++) {
  const y0 = 40 + i * 90 + 25;
  const y1 = 40 + i * 90 + 75;
  console.log(i, JSON.stringify(extent(y0, y1)));
}
