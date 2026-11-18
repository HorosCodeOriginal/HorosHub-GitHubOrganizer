// Builds build/icon.png, build/icon-512.png and build/icon.ico (PNG-in-ICO) from
// canvas-rendered logo dataURLs captured in build/icon-sources.json.
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(path.join(__dirname, 'icon-sources.json'), 'utf8');
const start = raw.indexOf('{');
const map = JSON.parse(raw.slice(start));
const dec = (s) => Buffer.from(s.split(',')[1], 'base64');
const out = __dirname;
fs.writeFileSync(path.join(out, 'icon.png'), dec(map['256']));
fs.writeFileSync(path.join(out, 'icon-512.png'), dec(map['512']));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map((s) => ({ s, buf: dec(map[String(s)]) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(imgs.length, 4);
let offset = 6 + 16 * imgs.length;
const dir = [];
const bodies = [];
for (const { s, buf } of imgs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
  dir.push(e); bodies.push(buf); offset += buf.length;
}
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...dir, ...bodies]));
console.log('icons written:', fs.readdirSync(out).filter((f) => f.startsWith('icon')).join(', '));