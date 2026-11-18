// Builds build/icon.png, build/icon-512.png and build/icon.ico from canvas-rendered
// logo data captured in build/icon-sources.json ({size:{png,rgba}}).
// ICO uses BMP/DIB entries for sizes < 256 (Windows shell cannot read small PNG-in-ICO
// entries, which made Explorer/taskbar/tray fall back to a generic icon) and PNG for 256.
const fs = require('fs');
const path = require('path');
const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'icon-sources.json'), 'utf8'));
const dec = (s) => Buffer.from(s.split(',')[1], 'base64');
const out = __dirname;
fs.writeFileSync(path.join(out, 'icon.png'), dec(map['256'].png));
fs.writeFileSync(path.join(out, 'icon-512.png'), dec(map['512'].png));

function dib(size, rgba) {
  const w = size, h = size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(w * h * 4, 20);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4, dst = (y * w + x) * 4;
      px[dst] = rgba[src + 2]; px[dst + 1] = rgba[src + 1]; px[dst + 2] = rgba[src]; px[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.floor((w + 31) / 32) * 4;
  const mask = Buffer.alloc(maskRow * h, 0);
  return Buffer.concat([header, px, mask]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map((s) => ({ s, buf: s >= 256 ? dec(map[String(s)].png) : dib(s, Buffer.from(map[String(s)].rgba, 'base64')) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(imgs.length, 4);
let offset = 6 + 16 * imgs.length;
const dir = [], bodies = [];
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
console.log('icons written (BMP<256, PNG=256):', fs.readdirSync(out).filter((f) => f.startsWith('icon')).join(', '));