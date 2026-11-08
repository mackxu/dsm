#!/usr/bin/env node
// 生成应用图标：深色圆角底 + 亮绿色字母 D。
// 纯 Node 实现（PNG 编码 + 超采样抗锯齿），无第三方依赖。
// macOS 下额外通过 iconutil 生成 .icns。

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'resources');

const BACKGROUND_TOP = [32, 43, 36];
const BACKGROUND_BOTTOM = [16, 22, 18];
const GLYPH_COLOR = [185, 239, 112];

// 以下比例均基于图标边长 1.0
const MARGIN = 0.095;
const CORNER_RADIUS = 0.19;
const GLYPH_LEFT = 0.3;
const GLYPH_HEIGHT = 0.5;
const GLYPH_WIDTH = 0.4;
const GLYPH_STEM = 0.105;
const SUPERELLIPSE_POWER = 2.2;
const SUPERSAMPLE = 4;

const ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedSquare(x, y) {
  const half = 0.5 - MARGIN;
  const corner = half - CORNER_RADIUS;
  const qx = Math.abs(x - 0.5) - corner;
  const qy = Math.abs(y - 0.5) - corner;
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS;
}

function insideGlyph(x, y) {
  if (x < GLYPH_LEFT || x > GLYPH_LEFT + GLYPH_WIDTH) return false;
  const dy = Math.abs(y - 0.5);
  if (dy > GLYPH_HEIGHT / 2) return false;

  // 碗形以字干右边缘为圆心，保证平顶与圆弧切线连续。
  const bowlLeft = GLYPH_LEFT + GLYPH_STEM;
  if (x < bowlLeft) return true;

  const outerDx = (x - bowlLeft) / (GLYPH_WIDTH - GLYPH_STEM);
  const outerDy = dy / (GLYPH_HEIGHT / 2);
  if (outerDx ** SUPERELLIPSE_POWER + outerDy ** SUPERELLIPSE_POWER > 1) {
    return false;
  }

  const innerDx = (x - bowlLeft) / (GLYPH_WIDTH - GLYPH_STEM * 2);
  const innerDy = dy / (GLYPH_HEIGHT / 2 - GLYPH_STEM);
  return innerDx ** SUPERELLIPSE_POWER + innerDy ** SUPERELLIPSE_POWER > 1;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  const sub = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const gradient = BACKGROUND_TOP.map(
    (start, index) => BACKGROUND_BOTTOM[index] - start,
  );

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    const rowOffset = pixelY * size * 4;
    const t = (pixelY + 0.5) * step;
    const baseColor = BACKGROUND_TOP.map(
      (start, index) => start + gradient[index] * t,
    );
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let backgroundHits = 0;
      let glyphHits = 0;
      for (let sampleY = 0; sampleY < SUPERSAMPLE; sampleY += 1) {
        const y = (pixelY + (sampleY + 0.5) * sub) * step;
        for (let sampleX = 0; sampleX < SUPERSAMPLE; sampleX += 1) {
          const x = (pixelX + (sampleX + 0.5) * sub) * step;
          if (insideRoundedSquare(x, y)) backgroundHits += 1;
          if (insideGlyph(x, y)) glyphHits += 1;
        }
      }

      const offset = rowOffset + pixelX * 4;
      if (backgroundHits === 0) continue;
      const glyphAlpha = glyphHits / samples;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(
          baseColor[channel] * (1 - glyphAlpha) +
            GLYPH_COLOR[channel] * glyphAlpha,
        );
      }
      rgba[offset + 3] = Math.round((backgroundHits / samples) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(images.length * 16);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const entry = entries.subarray(index * 16, (index + 1) * 16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

async function buildIcns(cache) {
  if (process.platform !== 'darwin') {
    console.warn('跳过 .icns：仅支持在 macOS 上生成。');
    return false;
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsm-icon-'));
  const iconsetDir = path.join(tempDir, 'icon.iconset');
  await mkdir(iconsetDir);
  try {
    for (const [filename, size] of ICNS_ENTRIES) {
      await writeFile(path.join(iconsetDir, filename), cache.get(size));
    }
    execFileSync(
      'iconutil',
      ['-c', 'icns', iconsetDir, '-o', path.join(OUT_DIR, 'icon.icns')],
      { stdio: 'inherit' },
    );
    return true;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const cache = new Map();
  const getPng = (size) => {
    if (!cache.has(size)) cache.set(size, renderIcon(size));
    return cache.get(size);
  };
  for (const size of ICON_SIZES) {
    getPng(size);
  }

  await writeFile(path.join(OUT_DIR, 'icon.png'), getPng(1024));
  await writeFile(
    path.join(OUT_DIR, 'icon.ico'),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: getPng(size) }))),
  );
  const icnsBuilt = await buildIcns(cache);

  console.log(
    `已生成 resources/icon.png、resources/icon.ico${
      icnsBuilt ? '、resources/icon.icns' : ''
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
