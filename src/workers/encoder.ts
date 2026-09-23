/// <reference lib="webworker" />
import { encode, parseDigits, type EncodeObjective, type EncodeProgress } from '../core/codec';
import { parsePiIndex } from '../core/piIndex';

self.onmessage = (event: MessageEvent<{image: ImageData; digits: string; index: ArrayBuffer; savePercent: number; quality: number; splitPersistence: number; minPatchSize: number; objective: EncodeObjective; compressionPriority: number}>) => {
  try {
    const digits = parseDigits(event.data.digits);
    const index = parsePiIndex(event.data.index);
    let lastProgressAt = 0, lastPreviewAt = 0;
    const onProgress = (progress: EncodeProgress) => {
      const now = performance.now(), hasPreview = Boolean(progress.preview?.length);
      if (!hasPreview && progress.phase !== 'final' && now - lastProgressAt < 90) return;
      const transfer = (progress.preview ?? []).map((patch) => patch.pixels.buffer);
      self.postMessage({type: 'progress', progress}, transfer);
      lastProgressAt = now;
      if (hasPreview) lastPreviewAt = now;
    };
    const result = encode(
      event.data.image,
      digits,
      index,
      event.data.savePercent,
      event.data.quality,
      event.data.splitPersistence,
      event.data.minPatchSize,
      event.data.objective,
      event.data.compressionPriority,
      {
        onProgress,
        shouldPreview: () => performance.now() - lastPreviewAt >= 140,
      },
    );
    self.postMessage({type: 'result', result}, [result.bytes.buffer, result.image.data.buffer]);
  } catch (error) {
    self.postMessage({type: 'error', error: error instanceof Error ? error.message : String(error)});
  }
};
