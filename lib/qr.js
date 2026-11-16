// Minimal QR encoder (byte mode, error correction level M, versions 1-10).
//
// The iLink API returns only a URL, not an image, so the settings page needs a
// locally rendered code. Bundling an encoder keeps the plugin dependency-free;
// this covers the ~90 byte WeChat login URL comfortably (version 4-5).
//
// Layout follows ISO/IEC 18004. Only the pieces a login URL needs are
// implemented: byte mode, level M, automatic version selection.

const EC_LEVEL_M = { ordinal: 0, formatBits: 0 };

// Level M block structure per version: [ecCodewordsPerBlock, [ [count, dataCodewords], ... ] ]
const BLOCKS_M = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Galois field tables for Reed-Solomon.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

function utf8Bytes(text) {
  return [...new TextEncoder().encode(text)];
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    const [, groups] = BLOCKS_M[version];
    const dataCodewords = groups.reduce((sum, [count, codewords]) => sum + count * codewords, 0);
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords * 8) return version;
  }
  throw new Error('QR payload too large for versions 1-10');
}

function buildDataCodewords(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const [, groups] = BLOCKS_M[version];
  const capacityBits = groups.reduce((sum, [count, codewords]) => sum + count * codewords, 0) * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  const pad = [0xec, 0x11];
  let index = 0;
  while (codewords.length < capacityBits / 8) codewords.push(pad[index++ % 2]);
  return codewords;
}

function interleave(dataCodewords, version) {
  const [ecPerBlock, groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLength] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.slice(offset, offset + dataLength);
      offset += dataLength;
      blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

const FORMAT_BITS_M = 0b00;

function formatCodewords(mask) {
  const data = (FORMAT_BITS_M << 3) | mask;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function placeFormat(matrix, size, mask) {
  const bits = formatCodewords(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, value) => { matrix[y][x] = value; };

  // Around the top-left finder.
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i <= 14; i += 1) set(14 - i, 8, bit(i));

  // Mirror copy.
  for (let i = 0; i <= 7; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i <= 14; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function placeFunctionPatterns(matrix, size, version) {
  const set = (x, y, value) => { if (x >= 0 && y >= 0 && x < size && y < size) matrix[y][x] = value; };

  // Finder patterns with separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // Alignment patterns.
  const centers = ALIGNMENT[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format areas and the dark module.
  for (let i = 0; i <= 8; i += 1) { set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i += 1) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);

  // Version information (version >= 7).
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const value = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, value);
      set(b, a, value);
    }
  }
}

function isFunctionModule(size, version, x, y) {
  if (x === 6 || y === 6) return true;
  if ((x <= 8 && y <= 8) || (x >= size - 8 && y <= 8) || (x <= 8 && y >= size - 8)) return true;
  const centers = ALIGNMENT[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  }
  if (version >= 7 && ((x >= size - 11 && x <= size - 9 && y <= 5) || (y >= size - 11 && y <= size - 9 && x <= 5))) return true;
  return false;
}

function applyData(matrix, size, version, codewords) {
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (isFunctionModule(size, version, x, y)) continue;
        let value = false;
        if (bitIndex < codewords.length * 8) {
          value = ((codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        }
        matrix[y][x] = value;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function penalty(matrix, size) {
  let score = 0;
  // Runs of five or more.
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (matrix[y][x] === matrix[y][x - 1]) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else run = 1;
    }
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (matrix[y][x] === matrix[y - 1][x]) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else run = 1;
    }
  }
  // 2x2 blocks.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = matrix[y][x];
      if (value === matrix[y][x + 1] && value === matrix[y + 1][x] && value === matrix[y + 1][x + 1]) score += 3;
    }
  }
  return score;
}

/**
 * Encode text as a QR module matrix.
 * @param text payload, encoded as UTF-8 byte mode.
 * @returns { size, modules } where modules[y][x] is true for a dark module.
 */
export function encodeQr(text) {
  const bytes = utf8Bytes(String(text));
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = interleave(buildDataCodewords(bytes, version), version);

  let best;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
    placeFunctionPatterns(matrix, size, version);
    applyData(matrix, size, version, codewords);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isFunctionModule(size, version, x, y)) continue;
        if (maskBit(mask, x, y)) matrix[y][x] = !matrix[y][x];
      }
    }
    placeFormat(matrix, size, mask);
    const score = penalty(matrix, size);
    if (best === undefined || score < best.score) best = { score, matrix };
  }
  return { size, modules: best.matrix };
}

/** Render a matrix as a standalone SVG document with a white quiet zone. */
export function qrSvg(text, { margin = 4, scale = 6 } = {}) {
  const { size, modules } = encodeQr(text);
  const total = (size + margin * 2) * scale;
  const cells = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) cells.push('M' + (x + margin) * scale + ',' + (y + margin) * scale + 'h' + scale + 'v' + scale + 'h-' + scale + 'z');
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + total + '" height="' + total
    + '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">'
    + '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>'
    + '<path fill="#000000" d="' + cells.join('') + '"/></svg>';
}
