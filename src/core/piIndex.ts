export const PI_SOURCE_SIZES = [2, 4, 8, 16] as const;
export const PI_INDEX_BUCKET_BITS = 12;
export const PI_INDEX_BUCKETS = 1 << PI_INDEX_BUCKET_BITS;
export const PI_INDEX_EMPTY = 0xffffffff;

const MAGIC = [0x50, 0x49, 0x44, 0x58];
const FEATURE_PAIRS = [
  [0, 15], [3, 12], [5, 10], [6, 9],
  [1, 14], [2, 13], [4, 11], [7, 8],
  [0, 5], [3, 10], [12, 6], [15, 9],
] as const;

export type PiIndex = {
  bucketBits: number;
  slots: number;
  digitCount: number;
  entries: Uint32Array;
};

export function parsePiIndex(input: ArrayBuffer | Uint8Array): PiIndex {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 16) throw new Error("π特徴インデックスが壊れています");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (MAGIC.some((value, i) => view.getUint8(i) !== value) || view.getUint8(4) !== 1) {
    throw new Error("π特徴インデックスの形式が違います");
  }
  const bucketBits = view.getUint8(5);
  const slots = view.getUint8(6);
  const sourceCount = view.getUint8(7);
  const digitCount = view.getUint32(8, true);
  const entryCount = view.getUint32(12, true);
  if (
    bucketBits !== PI_INDEX_BUCKET_BITS ||
    !slots ||
    sourceCount !== PI_SOURCE_SIZES.length ||
    entryCount !== sourceCount * (1 << bucketBits) * slots ||
    bytes.byteLength !== 16 + entryCount * 4
  ) {
    throw new Error("π特徴インデックスのサイズが一致しません");
  }
  const entries = new Uint32Array(entryCount);
  for (let i = 0; i < entryCount; i++) entries[i] = view.getUint32(16 + i * 4, true);
  return { bucketBits, slots, digitCount, entries };
}

export function featureHash(values: ArrayLike<number>) {
  let hash = 0;
  for (let bit = 0; bit < FEATURE_PAIRS.length; bit++) {
    const [a, b] = FEATURE_PAIRS[bit];
    if (values[a] >= values[b]) hash |= 1 << bit;
  }
  return hash;
}

function transformCell(x: number, y: number, transform: number): [number, number] {
  let a = x, b = y;
  if (transform & 4) a = 3 - a;
  const r = transform & 3;
  if (r === 1) return [3 - b, a];
  if (r === 2) return [3 - a, 3 - b];
  if (r === 3) return [b, 3 - a];
  return [a, b];
}

export function transformedFeatureHash(values: ArrayLike<number>, transform: number) {
  const transformed = new Float64Array(16);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const [sx, sy] = transformCell(x, y, transform);
    transformed[y * 4 + x] = values[sy * 4 + sx];
  }
  return featureHash(transformed);
}

export type PiIndexReference = { offset: number; slot: number };

export function indexedReferences(index: PiIndex, sourceCode: number, hash: number, slotLimit: number) {
  const buckets = 1 << index.bucketBits;
  const base = (sourceCode * buckets + hash) * index.slots;
  const out: PiIndexReference[] = [];
  for (let slot = 0; slot < Math.min(slotLimit, index.slots, 8); slot++) {
    const offset = index.entries[base + slot];
    if (offset !== PI_INDEX_EMPTY) out.push({ offset, slot });
  }
  return out;
}

export function indexedOffsets(index: PiIndex, sourceCode: number, hash: number, slotLimit: number) {
  return indexedReferences(index, sourceCode, hash, slotLimit).map(({ offset }) => offset);
}

export function indexedOffsetAt(index: PiIndex, sourceCode: number, hash: number, slot: number) {
  const buckets = 1 << index.bucketBits;
  if (sourceCode < 0 || sourceCode >= PI_SOURCE_SIZES.length || hash < 0 || hash >= buckets || slot < 0 || slot >= index.slots) {
    return PI_INDEX_EMPTY;
  }
  return index.entries[(sourceCode * buckets + hash) * index.slots + slot];
}
