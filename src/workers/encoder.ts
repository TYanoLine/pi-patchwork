/// <reference lib="webworker" />
import { encode, parseDigits } from '../core/codec';
self.onmessage = (event: MessageEvent<{image: ImageData; digits: string; savePercent: number; quality: number}>) => {
  try {
    const result = encode(event.data.image, parseDigits(event.data.digits), event.data.savePercent, event.data.quality);
    self.postMessage({ok: true, result}, [result.bytes.buffer, result.image.data.buffer]);
  } catch (error) {
    self.postMessage({ok: false, error: error instanceof Error ? error.message : String(error)});
  }
};
