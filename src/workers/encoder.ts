/// <reference lib="webworker" />
import { encode, parseDigits } from '../core/codec';
import { parsePiIndex } from '../core/piIndex';

self.onmessage = (event: MessageEvent<{image: ImageData; digits: string; index: ArrayBuffer; savePercent: number; quality: number; splitPersistence: number}>) => {
  try {
    const digits = parseDigits(event.data.digits);
    const index = parsePiIndex(event.data.index);
    const result = encode(event.data.image, digits, index, event.data.savePercent, event.data.quality, event.data.splitPersistence);
    self.postMessage({ok: true, result}, [result.bytes.buffer, result.image.data.buffer]);
  } catch (error) {
    self.postMessage({ok: false, error: error instanceof Error ? error.message : String(error)});
  }
};
