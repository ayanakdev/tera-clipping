import { loadImage, createCanvas } from '@napi-rs/canvas';

const img = await loadImage('data/tmp/fontvariants.png');
const c = createCanvas(img.width, img.height);
const x = c.getContext('2d');
x.drawImage(img, 0, 0);
const d = x.getImageData(0, 0, img.width, img.height).data;
function measure(label, y0, y1) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let xx = 0; xx < img.width; xx++) {
      const idx = (y * img.width + xx) * 4;
      if (d[idx] > 170) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(label, JSON.stringify({ w: maxX - minX + 1, h: maxY - minY + 1, minY, maxY }));
}
const names = ['Poppins b0', 'Poppins b-1', 'Poppins EB b0', 'Poppins EB b-1', 'Poppins-ExtraBold b0', 'Poppins-ExtraBold b-1', 'Anton b0', 'Bebas b0'];
names.forEach((name, i) => measure(name, 65 + i * 90, 125 + i * 90));
