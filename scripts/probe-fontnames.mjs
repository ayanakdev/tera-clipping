import fs from 'node:fs';

function readNames(file) {
  const buf = fs.readFileSync(file);
  const numTables = buf.readUInt16BE(4);
  let nameOffset = 0;
  let nameLength = 0;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = buf.toString('ascii', off, off + 4);
    if (tag === 'name') {
      nameOffset = buf.readUInt32BE(off + 8);
      nameLength = buf.readUInt32BE(off + 12);
    }
  }
  if (!nameOffset) return {};
  const count = buf.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + buf.readUInt16BE(nameOffset + 4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    const platformID = buf.readUInt16BE(rec);
    const encodingID = buf.readUInt16BE(rec + 2);
    const languageID = buf.readUInt16BE(rec + 4);
    const nameID = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);
    if (platformID !== 3) continue;
    const start = stringOffset + offset;
    const raw = buf.subarray(start, start + length);
    let text = '';
    for (let j = 0; j + 1 < raw.length; j += 2) text += String.fromCharCode(raw.readUInt16BE(j));
    const key = `${nameID}/${languageID}/${encodingID}`;
    out[key] = text;
  }
  return out;
}

for (const file of ['Poppins-ExtraBold.ttf', 'Anton-Regular.ttf', 'BebasNeue-Regular.ttf']) {
  console.log('---', file);
  const names = readNames(`tools/fonts/${file}`);
  const wanted = ['1', '2', '4', '6', '16', '17'];
  for (const [key, value] of Object.entries(names)) {
    const id = key.split('/')[0];
    if (wanted.includes(id) && key.endsWith('/1033/1')) console.log(key, JSON.stringify(value));
  }
}
