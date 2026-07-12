// A QR encoder, from scratch.
//
// The whole pairing story rests on scanning a code off your own screen: that is what lets
// the encryption key reach the phone without ever travelling the tunnel it protects. So the
// QR is not decoration, it is the security boundary — and pulling in an npm package for it
// would break the one promise this tool makes about itself (zero dependencies).
//
// Byte mode, ECC level M, versions 1-20. Enough for a pairing payload or a download URL.

// --- Galois field GF(256) -----------------------------------------------------
// Reed-Solomon lives here. Multiplication is done through log tables because doing it the
// long way, per byte, for every codeword, is needlessly slow.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;              // the QR standard's primitive polynomial
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `n` error-correction codewords. */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

/**
 * The ECC codewords for one block.
 *
 * `gen` comes back in ASCENDING powers (gen[k] is the coefficient of x^k, and gen[n] is the
 * implicit leading 1). The division below walks the remainder from its highest power down,
 * so it needs the generator the other way round — reading it ascending silently produces
 * ECC bytes that are pure noise.
 *
 * That is the bug that made every QR this file produced unscannable: the data codewords were
 * perfect and only the error-correction bytes were garbage, so a phone would see the code,
 * decode it, fail the checksum, and hand back nothing.
 */
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[n - 1] = 0;
    for (let i = 0; i < n; i++) res[i] ^= gmul(gen[n - 1 - i], factor);
  }
  return res;
}

// --- capacity tables (ECC level M) --------------------------------------------
// Per version: total codewords, ECC codewords per block, blocks in group 1, blocks in
// group 2. Straight out of the spec — there is no deriving these.
const VERSIONS = [
  null,
  { total: 26, ecc: 10, g1: 1, g2: 0 },      // 1
  { total: 44, ecc: 16, g1: 1, g2: 0 },      // 2
  { total: 70, ecc: 26, g1: 1, g2: 0 },      // 3
  { total: 100, ecc: 18, g1: 2, g2: 0 },     // 4
  { total: 134, ecc: 24, g1: 2, g2: 0 },     // 5
  { total: 172, ecc: 16, g1: 4, g2: 0 },     // 6
  { total: 196, ecc: 18, g1: 4, g2: 0 },     // 7
  { total: 242, ecc: 22, g1: 2, g2: 2 },     // 8
  { total: 292, ecc: 22, g1: 3, g2: 2 },     // 9
  { total: 346, ecc: 26, g1: 4, g2: 1 },     // 10
  { total: 404, ecc: 30, g1: 1, g2: 4 },     // 11
  { total: 466, ecc: 22, g1: 6, g2: 2 },     // 12
  { total: 532, ecc: 22, g1: 8, g2: 1 },     // 13
  { total: 581, ecc: 24, g1: 4, g2: 5 },     // 14
  { total: 655, ecc: 24, g1: 5, g2: 5 },     // 15
  { total: 733, ecc: 28, g1: 7, g2: 3 },     // 16
  { total: 815, ecc: 28, g1: 10, g2: 1 },    // 17
  { total: 901, ecc: 26, g1: 9, g2: 4 },     // 18
  { total: 991, ecc: 26, g1: 3, g2: 11 },    // 19
  { total: 1085, ecc: 26, g1: 3, g2: 13 },   // 20
];

const ALIGN = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90],
];

const blocksOf = (v) => VERSIONS[v].g1 + VERSIONS[v].g2;
const dataBytes = (v) => VERSIONS[v].total - VERSIONS[v].ecc * blocksOf(v);

/** The smallest version this text fits in. */
function pickVersion(len) {
  for (let v = 1; v < VERSIONS.length; v++) {
    const header = 4 + (v < 10 ? 8 : 16);                 // mode + length field, in bits
    if (dataBytes(v) * 8 >= header + len * 8) return v;
  }
  throw new Error(`too much data for a QR code (${len} bytes)`);
}

// --- bit stream ----------------------------------------------------------------
class Bits {
  constructor() { this.bits = []; }
  push(value, n) { for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
  get length() { return this.bits.length; }
}

/** Text → the final codeword sequence, ECC and interleaving included. */
function encodeData(text, version) {
  const bytes = new TextEncoder().encode(text);
  const capacity = dataBytes(version);

  const bs = new Bits();
  bs.push(0b0100, 4);                                     // byte mode
  bs.push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bs.push(b, 8);

  bs.push(0, Math.min(4, capacity * 8 - bs.length));      // terminator
  while (bs.length % 8) bs.bits.push(0);

  const data = new Uint8Array(capacity);
  for (let i = 0; i < bs.length / 8; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bs.bits[i * 8 + j];
    data[i] = byte;
  }
  // Pad with the two alternating bytes the spec insists on.
  for (let i = Math.ceil(bs.length / 8), k = 0; i < capacity; i++, k++) {
    data[i] = k % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, ECC each, then interleave — that is what makes a scratch across the
  // code survive: damage gets spread across blocks instead of destroying one.
  const { ecc: eccLen, g1, g2 } = VERSIONS[version];
  const n = g1 + g2;
  const short = Math.floor(capacity / n);

  const blocks = [];
  const eccs = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = short + (i >= g1 ? 1 : 0);
    const block = data.slice(at, at + size);
    at += size;
    blocks.push(block);
    eccs.push(rsEncode(block, eccLen));
  }

  const out = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < eccLen; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

// --- the matrix ------------------------------------------------------------------
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 1], [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1], [1, 0, 1, 1, 1, 0, 1], [1, 0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1, 1],
];

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserve = (r, cc, v) => { if (r >= 0 && r < size && cc >= 0 && cc < size) m[r][cc] = v; };

  // Finders + their separators.
  for (const [dr, dc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let cc = -1; cc <= 7; cc++) {
        const on = r >= 0 && r < 7 && cc >= 0 && cc < 7 ? FINDER[r][cc] : 0;
        reserve(dr + r, dc + cc, on);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Alignment patterns — never on top of a finder.
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const cc of centres) {
      if ((r <= 8 && cc <= 8) || (r <= 8 && cc >= size - 9) || (r >= size - 9 && cc <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][cc + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  m[size - 8][8] = 1;                                     // the always-dark module

  // Reserve the format areas so data does not land there.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }

  const reserved = m.map((row) => row.map((v) => v !== null));

  // Version info (7+ only), bottom-left and top-right.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      m[a][b] = bit;
      m[b][a] = bit;
      reserved[a][b] = true;
      reserved[b][a] = true;
    }
  }

  // Zig-zag the data in, skipping everything reserved, masking as we go.
  let bit = 0;
  const bitAt = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  const total = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                           // the vertical timing column
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const cc = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - v : v;
        if (reserved[r][cc]) continue;

        let value = bit < total ? bitAt(bit) : 0;
        bit++;
        if (maskAt(mask, r, cc)) value ^= 1;
        m[r][cc] = value;
      }
    }
  }

  writeFormat(m, mask, size);
  return m;
}

function maskAt(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/**
 * Format info: ECC level + mask, BCH-protected, written twice.
 *
 * The two copies run at right angles to each other, and it is very easy to write them
 * transposed — the reference implementations index modules as (x, y), which reads exactly
 * like (row, col) and is not. Get it wrong and the code still LOOKS like a QR, still gets
 * found by the camera, and still fails to decode: the phone reads the wrong mask and
 * unmasks the data into noise.
 */
function writeFormat(m, mask, size) {
  const data = (0b00 << 3) | mask;                        // 00 = level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;

  // First copy: down the left of the top-right finder, then left along row 8.
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);                                       // skips row 6 — the timing line
  m[8][8] = bit(7);
  m[8][7] = bit(8);                                       // skips col 6 — the other one
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);

  // Second copy: right along row 8, then down the left column.
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);

  m[size - 8][8] = 1;                                     // the module that is always dark
}

/** How bad a mask looks to a scanner. Lower is better; the spec defines the penalties. */
function penalty(m) {
  const size = m.length;
  let score = 0;

  const run = (get) => {
    for (let a = 0; a < size; a++) {
      let last = -1;
      let len = 0;
      for (let b = 0; b < size; b++) {
        const v = get(a, b);
        if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score++; }
        else { last = v; len = 1; }
      }
    }
  };
  run((a, b) => m[a][b]);
  run((a, b) => m[b][a]);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Text → a matrix of 0/1. Picks the version and the mask for you.
 *
 * `mask` can be forced, which is what lets a test compare this matrix module-for-module
 * against a reference implementation: the mask is chosen by a penalty heuristic, and two
 * correct encoders may legitimately land on different masks for the same input. Pinning it
 * is the only way to tell "a different mask" apart from "wrong".
 */
export function encode(text, { mask = null } = {}) {
  const version = pickVersion(new TextEncoder().encode(text).length);
  const codewords = encodeData(text, version);

  if (mask !== null) return buildMatrix(version, codewords, mask);

  let best = null;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const grid = buildMatrix(version, codewords, m);
    const s = penalty(grid);
    if (s < bestScore) { bestScore = s; best = grid; }
  }
  return best;
}

/**
 * Render for a terminal, two rows per character with half-blocks.
 *
 * The quiet zone is not optional — a QR with no margin is a QR most scanners refuse, and
 * "it just doesn't scan" is a miserable thing to debug. Dark modules are drawn as the
 * FOREGROUND on a light background, because that is what a camera expects; inverting it
 * (as a dark terminal theme tempts you to) makes phones ignore it entirely.
 */
export function render(text, { quiet = 2 } = {}) {
  const m = encode(text);
  const size = m.length;
  const at = (r, cc) => (r >= 0 && r < size && cc >= 0 && cc < size ? m[r][cc] : 0);

  const lines = [];
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = '';
    for (let cc = -quiet; cc < size + quiet; cc++) {
      const top = at(r, cc);
      const bottom = at(r + 1, cc);
      // Dark module → no ink (the block chars ARE the light background).
      if (top && bottom) line += ' ';
      else if (top) line += '▄';
      else if (bottom) line += '▀';
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
