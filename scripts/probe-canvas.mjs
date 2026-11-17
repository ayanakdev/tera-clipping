import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';

GlobalFonts.registerFromPath('tools/fonts/Poppins-ExtraBold.ttf', 'Poppins EB');
const canvas = createCanvas(1000, 420);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, 1000, 420);
ctx.fillStyle = '#000';
ctx.font = '48px "Poppins EB"';
ctx.fillText('Marlon caught him edit farming 😭', 40, 100);
ctx.font = '64px "Segoe UI Emoji"';
ctx.fillText('😭 🔥 🚀 ✅', 40, 210);
ctx.font = '48px "Poppins EB"';
ctx.fillStyle = '#7c3aed';
ctx.fillText('Lip-sync captions, perfectly timed', 40, 320);
const png = await canvas.encode('png');
fs.writeFileSync('data/tmp/canvas-test.png', png);
console.log('written', png.length);
