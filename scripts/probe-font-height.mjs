import { loadImage, createCanvas } from '@napi-rs/canvas';

async function measure(file, bands) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, img.width, img.height).data;
  for (const [name, y0, y1] of bands) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = y0; y < y1; y++) {
      for (let xx = 0; xx < img.width; xx++) {
        const i = (y * img.width + xx) * 4;
        if (d[i] > 170) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    console.log(name, JSON.stringify({ w: maxX - minX + 1, h: maxY - minY + 1, minX, minY, maxX, maxY }));
  }
}

await measure('data/tmp/fonts-only/out.png', [
  ['A PoppinsExtraBold b0', 60, 160],
  ['B Poppins fallback', 160, 260],
  ['C PoppinsExtraBold b-1', 260, 360],
]);
await measure('data/tmp/font-ground.png', [
  ['canvas ground 400', 20, 100],
  ['canvas ground 700', 100, 180],
  ['canvas arial 400', 180, 260],
]);
