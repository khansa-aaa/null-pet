#!/usr/bin/env node
// Draws null's built-in sprite sheet (assets/sprite.png) plus the tray and app icons.
// Original pixel art, generated from code so it can be changed and rebuilt: `npm run sprite:build`.
//
// The sheet uses the Codex pet layout, so any sheet in that layout can replace it:
//   8 columns x 11 rows of 192x208 frames
//   rows 0-8: idle, run right, run left, wave, jump, sad, think, work, celebrate
//   rows 9-10: 16 "look" frames, clockwise from straight up in 22.5° steps
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 24; // one frame, in art pixels
const H = 26;
const COLS = 8;
const ROWS = 11;

const C = {
  body: [24, 24, 28, 255],
  edge: [255, 65, 54, 255],
  eye: [245, 245, 245, 255],
  dim: [120, 120, 132, 255],
  spark: [255, 200, 60, 255],
  tear: [90, 170, 255, 255]
};

// ---------- a tiny RGBA canvas and PNG writer ----------
function canvas(w, h) {
  const data = Buffer.alloc(w * h * 4);
  return {
    w,
    h,
    data,
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      data.set(c, (y * w + x) * 4);
    }
  };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function png(cv) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((cv.w * 4 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) cv.data.copy(raw, y * (cv.w * 4 + 1) + 1, y * cv.w * 4, (y + 1) * cv.w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- the creature ----------
// A small dark blob with a red outline and a floating ∅ over its head.
// pose: { dx, dy, eye: [ex, ey], blink, sad, armL, armR ('down' | 'out' | 'up'), feet (0 | 1), halo: [hx, hy], haloDim, extra(px) }
function creature(px, pose = {}) {
  const { dx = 0, dy = 0, eye = [0, 0], blink = false, sad = false, armL = 'down', armR = 'down', feet = 0, halo = [0, 0], haloDim = false, extra } = pose;
  const shape = new Set();
  const add = (x, y) => shape.add(`${x + dx},${y + dy}`);
  for (let x = 8; x <= 15; x++) add(x, 9);
  for (let x = 7; x <= 16; x++) add(x, 10);
  for (let y = 11; y <= 21; y++) for (let x = 6; x <= 17; x++) add(x, y);
  const bumps = feet
    ? [[7, 9], [12, 13], [16, 17]]
    : [[6, 8], [11, 12], [15, 17]];
  for (const [a, b] of bumps) for (let x = a; x <= b; x++) add(x, 22);

  for (const key of shape) {
    const [x, y] = key.split(',').map(Number);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!shape.has(`${x + ox},${y + oy}`)) px(x + ox, y + oy, C.edge);
  }
  for (const key of shape) {
    const [x, y] = key.split(',').map(Number);
    px(x, y, C.body);
  }

  // arms
  const arm = (side, state) => {
    const x0 = side < 0 ? 5 : 18;
    const pts = { down: [[0, 16], [side, 17]], out: [[0, 15], [side, 15], [2 * side, 14]], up: [[0, 14], [side, 13], [side, 12]] }[state];
    for (const [ox, y] of pts) px(x0 + ox + dx, y + dy, C.edge);
  };
  arm(-1, armL);
  arm(1, armR);

  // eyes
  const [ex, ey] = eye;
  for (const x0 of [9, 14]) {
    if (blink) {
      px(x0 + ex + dx, 15 + ey + dy, C.eye);
      px(x0 + 1 + ex + dx, 15 + ey + dy, C.eye);
    } else {
      for (let y = 14; y <= 16; y++) for (let x = x0; x <= x0 + 1; x++) px(x + ex + dx, y + ey + dy, C.eye);
      if (sad) {
        // inner top corner cut: a worried look
        px((x0 === 9 ? x0 : x0 + 1) + ex + dx, 14 + ey + dy, C.body);
      }
    }
  }

  // the ∅ above its head
  const [hx, hy] = halo;
  const hc = haloDim ? C.dim : C.edge;
  const ring = [];
  for (let x = 10; x <= 13; x++) ring.push([x, 2], [x, 5]);
  ring.push([9, 3], [9, 4], [14, 3], [14, 4]);
  for (let i = 0; i < 6; i++) ring.push([14 - i, 1 + i]);
  for (const [x, y] of ring) px(x + hx + dx, y + hy + Math.max(dy, -1), hc);

  if (extra) extra(px);
}

const ROW_POSES = [
  // 0 idle (6): a slow bob and a blink
  [{}, {}, { dy: 1, halo: [0, 1] }, { dy: 1, blink: true }, { halo: [0, -1] }, {}],
  // 1 run right (8)
  Array.from({ length: 8 }, (_, i) => ({ dx: 1, dy: i % 2 ? -1 : 0, feet: i % 2, eye: [2, 0], armL: i % 2 ? 'out' : 'down', armR: i % 2 ? 'down' : 'out', halo: [-1, 0] })),
  // 2 run left (8)
  Array.from({ length: 8 }, (_, i) => ({ dx: -1, dy: i % 2 ? -1 : 0, feet: i % 2, eye: [-2, 0], armL: i % 2 ? 'down' : 'out', armR: i % 2 ? 'out' : 'down', halo: [1, 0] })),
  // 3 wave (4)
  [{ armR: 'out' }, { armR: 'up' }, { armR: 'out' }, { armR: 'up', blink: true }],
  // 4 jump (5)
  [{ feet: 1 }, { dy: -2, armL: 'out', armR: 'out' }, { dy: -3, armL: 'up', armR: 'up' }, { dy: -2, armL: 'out', armR: 'out' }, { feet: 1 }],
  // 5 sad (8): a tear runs down
  Array.from({ length: 8 }, (_, i) => ({
    dy: 1,
    sad: true,
    eye: [0, 1],
    halo: [0, 2],
    haloDim: true,
    extra: (px) => i % 4 !== 3 && px(9, 19 + (i % 4), C.tear)
  })),
  // 6 think (6): dots drift up
  Array.from({ length: 6 }, (_, i) => ({
    eye: [1, -1],
    halo: [0, i % 2 ? -1 : 0],
    extra: (px) => {
      const dots = [[19, 8], [21, 5], [22, 2]];
      for (let k = 0; k < Math.min(3, Math.floor(i / 2) + 1); k++) {
        px(dots[k][0], dots[k][1], C.dim);
        if (k === 2) px(dots[k][0] - 1, dots[k][1], C.dim);
      }
    }
  })),
  // 7 work (6): lines of "code" scroll across its belly
  Array.from({ length: 6 }, (_, i) => ({
    eye: [0, -1],
    armL: i % 2 ? 'out' : 'down',
    armR: i % 2 ? 'down' : 'out',
    extra: (px) => {
      const lens = [[5, 3], [3, 6], [6, 2], [2, 5], [4, 4], [6, 3]][i];
      for (let x = 0; x < lens[0]; x++) px(8 + x, 18, C.edge);
      for (let x = 0; x < lens[1]; x++) px(8 + x, 20, C.dim);
    }
  })),
  // 8 celebrate (6)
  Array.from({ length: 6 }, (_, i) => ({
    dy: i % 2 ? -2 : 0,
    armL: 'up',
    armR: 'up',
    blink: i === 3,
    feet: i % 2,
    extra: (px) => {
      const sparks = i % 2 ? [[2, 6], [21, 9], [4, 20]] : [[3, 10], [20, 4], [21, 19]];
      for (const [x, y] of sparks) {
        px(x, y, C.spark);
        px(x - 1, y, C.spark);
        px(x + 1, y, C.spark);
        px(x, y - 1, C.spark);
        px(x, y + 1, C.spark);
      }
    }
  }))
];

// rows 9-10: looking around, clockwise from straight up
const LOOKS = Array.from({ length: 16 }, (_, i) => {
  const a = (i * 22.5 * Math.PI) / 180;
  return { eye: [Math.round(Math.sin(a) * 2), Math.round(-Math.cos(a) * 1.4)], halo: [Math.round(Math.sin(a)), 0] };
});

function render(scale) {
  const cv = canvas(COLS * W * scale, ROWS * H * scale);
  const at = (col, row) => (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) cv.set((col * W + x) * scale + sx, (row * H + y) * scale + sy, c);
  };
  ROW_POSES.forEach((poses, row) => poses.forEach((pose, col) => creature(at(col, row), pose)));
  LOOKS.forEach((pose, i) => creature(at(i % 8, 9 + Math.floor(i / 8)), pose));
  return cv;
}

function icon(size, scale) {
  const cv = canvas(size, size);
  const ox = Math.round((size - W * scale) / 2);
  const oy = Math.round((size - H * scale) / 2);
  creature((x, y, c) => {
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) cv.set(ox + x * scale + sx, oy + y * scale + sy, c);
  });
  return cv;
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'sprite.png'), png(render(8))); // 1536 x 2288
fs.writeFileSync(path.join(out, 'tray.png'), png(icon(64, 2)));
fs.writeFileSync(path.join(out, 'icon.png'), png(icon(256, 9)));
console.log('Wrote assets/sprite.png, assets/tray.png and assets/icon.png');
