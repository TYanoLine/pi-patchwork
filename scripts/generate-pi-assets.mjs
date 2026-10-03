import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const DIGIT_COUNT = 1_000_000;
const GUARD = 20;
const SOURCE_SIZES = [2, 4, 8, 16];
const PAIRS = [
  [0, 15], [3, 12], [5, 10], [6, 9],
  [1, 14], [2, 13], [4, 11], [7, 8],
  [0, 5], [3, 10], [12, 6], [15, 9],
];
const BUCKET_BITS = 12;
const BUCKETS = 1 << BUCKET_BITS;
const SLOTS = 8;
const EMPTY = 0xffffffff;
const EXPECTED_SHA256 = "7806ee47461b49ef1f578e14461b2c83c09c6d7a9a914275da1d71e9cbbf7069";
const C3_OVER_24 = 10939058860032000n;

function isqrt(n) {
  if (n < 0n) throw new Error("negative sqrt");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  while (true) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

function binarySplit(a, b) {
  if (b - a === 1) {
    if (a === 0) return [1n, 1n, 13591409n];
    const k = BigInt(a);
    const p = (6n * k - 5n) * (2n * k - 1n) * (6n * k - 1n);
    const q = k * k * k * C3_OVER_24;
    let t = p * (13591409n + 545140134n * k);
    if (a & 1) t = -t;
    return [p, q, t];
  }
  const m = (a + b) >> 1;
  const [p1, q1, t1] = binarySplit(a, m);
  const [p2, q2, t2] = binarySplit(m, b);
  return [p1 * p2, q1 * q2, t1 * q2 + p1 * t2];
}

function generatePiDigits(count) {
  const digits = count + GUARD;
  const scale = 10n ** BigInt(digits);
  const terms = Math.ceil(digits / 14.181647462725477);
  const [, q, t] = binarySplit(0, terms);
  const sqrtC = isqrt(10005n * scale * scale);
  const pi = (q * 426880n * sqrtC) / t;
  const text = pi.toString().slice(1, count + 1);
  if (text.length !== count || !text.startsWith("14159265358979323846264338327950288419716939937510")) {
    throw new Error("pi generation self-check failed");
  }
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash !== EXPECTED_SHA256) throw new Error(`pi SHA-256 mismatch: ${hash}`);
  return text;
}

function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function buildPairOffsets(size) {
  return PAIRS.map(([a, b]) => {
    const ax = a & 3, ay = a >> 2, bx = b & 3, by = b >> 2;
    const sax = Math.min(size - 1, Math.floor((ax + 0.5) * size / 4));
    const say = Math.min(size - 1, Math.floor((ay + 0.5) * size / 4));
    const sbx = Math.min(size - 1, Math.floor((bx + 0.5) * size / 4));
    const sby = Math.min(size - 1, Math.floor((by + 0.5) * size / 4));
    return [say * size + sax, sby * size + sbx];
  });
}

function featureHash(digits, offset, pairOffsets) {
  let hash = 0;
  for (let bit = 0; bit < pairOffsets.length; bit++) {
    const [a, b] = pairOffsets[bit];
    if (digits[offset + a] >= digits[offset + b]) hash |= 1 << bit;
  }
  return hash;
}

function buildIndex(digits) {
  const entries = new Uint32Array(SOURCE_SIZES.length * BUCKETS * SLOTS);
  entries.fill(EMPTY);
  const counts = new Uint32Array(SOURCE_SIZES.length * BUCKETS);
  for (let sourceCode = 0; sourceCode < SOURCE_SIZES.length; sourceCode++) {
    const size = SOURCE_SIZES[sourceCode];
    const pairOffsets = buildPairOffsets(size);
    const last = digits.length - size * size;
    for (let offset = 0; offset <= last; offset++) {
      const hash = featureHash(digits, offset, pairOffsets);
      const countIndex = sourceCode * BUCKETS + hash;
      const seen = counts[countIndex]++;
      const base = countIndex * SLOTS;
      if (seen < SLOTS) {
        entries[base + seen] = offset;
      } else {
        const sample = mix32(offset ^ Math.imul(sourceCode + 1, 0x9e3779b1)) % (seen + 1);
        if (sample < SLOTS) entries[base + sample] = offset;
      }
    }
  }

  const header = Buffer.alloc(16);
  header.write("PIDX", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(BUCKET_BITS, 5);
  header.writeUInt8(SLOTS, 6);
  header.writeUInt8(SOURCE_SIZES.length, 7);
  header.writeUInt32LE(digits.length, 8);
  header.writeUInt32LE(entries.length, 12);

  const body = Buffer.alloc(entries.length * 4);
  for (let i = 0; i < entries.length; i++) body.writeUInt32LE(entries[i], i * 4);
  return Buffer.concat([header, body]);
}

async function main() {
  const started = performance.now();
  const text = generatePiDigits(DIGIT_COUNT);
  const digits = Uint8Array.from(text, (ch) => ch.charCodeAt(0) - 48);
  const index = buildIndex(digits);
  await mkdir("public", { recursive: true });
  await writeFile("public/pi-1m.txt", text);
  await writeFile("public/pi-index-1m.bin", index);
  console.log(`Generated ${DIGIT_COUNT.toLocaleString()} π digits + ${(index.byteLength / 1024).toFixed(1)} KiB feature index in ${((performance.now() - started) / 1000).toFixed(2)}s`);
}

await main();
