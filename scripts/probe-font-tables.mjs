import fs from 'node:fs';

function table(buf, tag) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (buf.toString('ascii', off, off + 4) === tag) {
      const offset = buf.readUInt32BE(off + 8);
      const length = buf.readUInt32BE(off + 12);
      return { offset, length };
    }
  }
  return null;
}

for (const file of ['Poppins-ExtraBold.ttf', 'Poppins-Bold.ttf', 'Poppins-Regular.ttf']) {
  const buf = fs.readFileSync(`tools/fonts/${file}`);
  const head = table(buf, 'head');
  const hhea = table(buf, 'hhea');
  const os2 = table(buf, 'OS/2');
  const maxp = table(buf, 'maxp');
  const name = table(buf, 'name');
  console.log('---', file, 'size', buf.length);
  if (head) {
    console.log('unitsPerEm', buf.readUInt16BE(head.offset + 18));
    console.log('xMin', buf.readInt16BE(head.offset + 36), 'yMin', buf.readInt16BE(head.offset + 38), 'xMax', buf.readInt16BE(head.offset + 40), 'yMax', buf.readInt16BE(head.offset + 42));
  }
  if (hhea) console.log('hhea asc/desc/gap', buf.readInt16BE(hhea.offset + 4), buf.readInt16BE(hhea.offset + 6), buf.readInt16BE(hhea.offset + 8));
  if (os2) {
    console.log('os2 version', buf.readUInt16BE(os2.offset), 'weightClass', buf.readUInt16BE(os2.offset + 4), 'widthClass', buf.readUInt16BE(os2.offset + 6));
    console.log('typo asc/desc/gap', buf.readInt16BE(os2.offset + 68), buf.readInt16BE(os2.offset + 70), buf.readInt16BE(os2.offset + 72));
    console.log('win asc/desc', buf.readUInt16BE(os2.offset + 74), buf.readUInt16BE(os2.offset + 76));
  }
  console.log('numGlyphs', maxp ? buf.readUInt16BE(maxp.offset + 4) : '?', 'nameOffset', name?.offset);
}
