// 生成 assets/icon.ico（16/32/48/256），桌面快捷方式用。纯手写光栅化，无依赖。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets');

const INK_TOP = [30, 46, 61];
const INK_BOT = [13, 24, 34];
const SHEET = [247, 244, 238];
const LINE = [72, 102, 130];
const AMBER = [233, 150, 62];

const sdRoundRect = (px, py, x0, y0, x1, y1, r) => {
  const hw = (x1 - x0) / 2 - r;
  const hh = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - (x0 + x1) / 2) - hw;
  const dy = Math.abs(py - (y0 + y1) / 2) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
};

const sdSegment = (px, py, ax, ay, bx, by, halfW) => {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - halfW;
};

// 归一化坐标 0..1 下逐点取色；返回 [r,g,b,a]
const shade = (x, y) => {
  if (sdRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22) > 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, y));
  let c = INK_TOP.map((v, i) => v + (INK_BOT[i] - v) * t);
  if (sdRoundRect(x, y, 0.15, 0.14, 0.68, 0.86, 0.05) <= 0) c = SHEET;
  const lines = [
    [0.22, 0.61, 0.285],
    [0.22, 0.61, 0.465],
    [0.22, 0.5, 0.645],
  ];
  for (const [x0, x1, yc] of lines) {
    if (sdRoundRect(x, y, x0, yc, x1, yc + 0.07, 0.035) <= 0) c = LINE;
  }
  const chevron =
    Math.min(
      sdSegment(x, y, 0.78, 0.3, 0.9, 0.5, 0.055),
      sdSegment(x, y, 0.9, 0.5, 0.78, 0.7, 0.055),
    ) <= 0;
  if (chevron) c = AMBER;
  return [...c, 255];
};

const render = (size) => {
  const SS = 4; // 4x4 超采样抗锯齿
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          const w = ca / 255;
          r += cr * w;
          g += cg * w;
          b += cb * w;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const aw = a / 255;
      buf[i] = aw ? Math.round(r / aw) : 0;
      buf[i + 1] = aw ? Math.round(g / aw) : 0;
      buf[i + 2] = aw ? Math.round(b / aw) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const encodePNG = (size, rgba) => {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const encodeICO = (entries) => {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size; // 0 表示 256
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.png)]);
};

const sizes = [16, 32, 48, 256];
const entries = sizes.map((size) => ({ size, png: encodePNG(size, render(size)) }));
const ico = encodeICO(entries);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
fs.writeFileSync(path.join(OUT, 'icon-256.png'), entries.at(-1).png);

// 自检：头部结构 + 每个条目的偏移都在文件内 + 抽样像素符合预期
const assert = (ok, msg) => {
  if (!ok) throw new Error(`icon.ico 自检失败: ${msg}`);
};
assert(ico.readUInt16LE(2) === 1, 'not an icon');
assert(ico.readUInt16LE(4) === sizes.length, 'entry count');
entries.forEach((e, i) => {
  const at = 6 + 16 * i;
  assert(ico.readUInt32LE(at + 8) === e.png.length, `size[${i}]`);
  assert(ico.readUInt32LE(at + 12) + e.png.length <= ico.length, `offset[${i}]`);
});
const big = render(256);
const at = (x, y) => [...big.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
assert(at(3, 3)[3] === 0, 'corner should be transparent');
assert(at(130, 107)[0] > 200, 'sheet centre should be light');
assert(at(230, 128)[0] > 150 && at(230, 128)[2] < 120, 'chevron should be amber');

console.log(`assets/icon.ico ${(ico.length / 1024).toFixed(1)}KB (${sizes.join('/')}) + assets/icon-256.png`);
