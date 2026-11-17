import fs from 'node:fs';

function table(buf, tag) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (buf.toString('ascii', off, off + 4) === tag) {
      return { offset: buf.readUInt32BE(off + 8), length: buf.readUInt32BE(off + 12) };
    }
  }
  return null;
}

for (const file of ['Poppins-ExtraBold.ttf', 'Anton-Regular.ttf', 'BebasNeue-Regular.ttf']) {
  const buf = fs.readFileSync(`tools/fonts/${file}`);
  const head = table(buf, 'head');
  const os2 = table(buf, 'OS/2');
  const upm = buf.readUInt16BE(head.offset + 18);
  const winAsc = buf.readUInt16BE(os2.offset + 74);
  const winDesc = buf.readUInt16BE(os2.offset + 76);
  console.log(file, { upm, winAsc, winDesc, factor: ((winAsc + winDesc) / upm).toFixed(4) });
}
