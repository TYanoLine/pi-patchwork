import { useEffect, useRef, useState } from "react";
import { Download, ImagePlus, LoaderCircle, Pi, Sparkles } from "lucide-react";
import { decode, mseOf, parseDigits, patchRects, type EncodeProgress, type EncodeResult } from "./core/codec";
import { deblockImage, type PatchRect } from "./core/deblock";

type Quality = 0 | 1 | 2;
type MinPatchSize = 4 | 8 | 16 | 32;
type Comparison = {
  label: string;
  image: ImageData;
  blob: Blob;
  bytes: number;
  quality: number;
  psnr: number;
  delta: number;
  encoder: string;
};
const qualityLabels = ["Fast", "Balanced", "Thorough"];
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function blankPreview(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 12;
    data[i + 1] = 14;
    data[i + 2] = 12;
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}
function mergePreview(raw: ImageData, progress: EncodeProgress) {
  const patches = progress.preview ?? [];
  if (!patches.length) return;
  for (const patch of patches) {
    for (let y = 0; y < patch.height; y++) {
      const src = y * patch.width * 4,
        dst = ((patch.y + y) * raw.width + patch.x) * 4;
      raw.data.set(patch.pixels.subarray(src, src + patch.width * 4), dst);
    }
  }
}
function updatePreviewRects(current: PatchRect[], progress: EncodeProgress) {
  const patches = progress.preview ?? [];
  if (!patches.length) return current;
  const contains = (a: PatchRect, b: PatchRect) =>
    b[0] >= a[0] &&
    b[1] >= a[1] &&
    b[0] + b[2] <= a[0] + a[2] &&
    b[1] + b[3] <= a[1] + a[3];
  let next = [...current];
  for (const patch of patches) {
    const rect: PatchRect = [patch.x, patch.y, patch.width, patch.height];
    next = next.filter((existing) => !contains(existing, rect) && !contains(rect, existing));
    next.push(rect);
  }
  return next;
}
function draw(
  canvas: HTMLCanvasElement | null,
  image: ImageData,
  grid = false,
  tile = 0,
  bytes?: Uint8Array,
) {
  if (!canvas) return;
  canvas.width = image.width;
  canvas.height = image.height;
  const c = canvas.getContext("2d")!;
  c.putImageData(image, 0, 0);
  if (grid && tile) {
    if (bytes) {
      for (const [x, y, w, h] of patchRects(bytes)) {
        const scale = Math.max(w, h) / tile;
        c.strokeStyle = `rgba(255,255,255,${scale >= 0.75 ? 0.46 : scale >= 0.4 ? 0.25 : 0.12})`;
        c.lineWidth = 1;
        c.strokeRect(x + 0.5, y + 0.5, w, h);
      }
    }
  }
}

function drawOutput(
  canvas: HTMLCanvasElement | null,
  raw: ImageData,
  deblock: boolean,
  rects: PatchRect[],
  grid = false,
  tile = 0,
  bytes?: Uint8Array,
) {
  draw(canvas, deblock ? deblockImage(raw, rects) : raw, grid, tile, bytes);
}
async function blobToImageData(file: Blob) {
  const bitmap = await createImageBitmap(file),
    scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)),
    h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#111";
  c.fillRect(0, 0, w, h);
  c.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return c.getImageData(0, 0, w, h);
}
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((blob) => resolve(blob?.type === type ? blob : null), type, quality),
  );
}
async function compareCodec(
  source: ImageData,
  targetBytes: number,
  type: "image/jpeg" | "image/webp",
): Promise<Comparison | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d")!.putImageData(source, 0, 0);
  let encoder = (quality: number) => canvasBlob(canvas, type, quality),
    encoderName = "ブラウザ";
  if (type === "image/webp" && !(await encoder(0.5))) {
    const { encode } = await import("@jsquash/webp");
    encoderName = "libwebp / WASM";
    encoder = async (quality) =>
      new Blob(
        [
          await encode(source, {
            quality: quality * 100,
            method: 4,
          }),
        ],
        { type },
      );
  }
  let low = 0.001,
    high = 0.99,
    best: { blob: Blob; quality: number } | undefined;
  for (let i = 0; i < 10; i++) {
    const quality = (low + high) / 2,
      blob = await encoder(quality);
    if (!blob) return undefined;
    if (!best || Math.abs(blob.size - targetBytes) < Math.abs(best.blob.size - targetBytes))
      best = { blob, quality };
    if (blob.size > targetBytes) high = quality;
    else low = quality;
  }
  if (!best) return undefined;
  const bitmap = await createImageBitmap(best.blob),
    decoded = document.createElement("canvas");
  decoded.width = source.width;
  decoded.height = source.height;
  const context = decoded.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, source.width, source.height),
    mse = mseOf(source, image);
  return {
    label: type === "image/jpeg" ? "JPEG" : "WebP",
    image,
    bytes: best.blob.size,
    quality: best.quality,
    psnr: mse ? 10 * Math.log10((255 * 255) / mse) : Infinity,
    delta: ((best.blob.size - targetBytes) / targetBytes) * 100,
    blob: best.blob,
    encoder: encoderName,
  };
}
function saveComparison(comparison: Comparison) {
  const url = URL.createObjectURL(comparison.blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `same-size.${comparison.label.toLowerCase()}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ComparisonCard({ comparison }: { comparison: Comparison }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => draw(canvas.current, comparison.image), [comparison]);
  return (
    <figure>
      <canvas ref={canvas} />
      <figcaption>{comparison.label}</figcaption>
      <div className="codecMeta">
        <strong>
          {formatBytes(comparison.bytes)} ({comparison.bytes.toLocaleString()} bytes)
        </strong>
        <span>Q {Math.round(comparison.quality * 100)}</span>
        <span>{comparison.psnr.toFixed(2)} dB</span>
        <span className={Math.abs(comparison.delta) > 10 ? "warn" : ""}>
          目標差 {comparison.delta > 0 ? "+" : ""}
          {comparison.delta.toFixed(1)}%
        </span>
        <span>
          {comparison.image.width}×{comparison.image.height}
        </span>
        <span>{comparison.encoder}</span>
        <button type="button" onClick={() => saveComparison(comparison)}>
          <Download /> {comparison.label}を保存
        </button>
      </div>
    </figure>
  );
}
export default function App() {
  const [digits, setDigits] = useState(""),
    [index, setIndex] = useState<ArrayBuffer>(),
    [source, setSource] = useState<ImageData>(),
    [result, setResult] = useState<EncodeResult>();
  const [originalBytes, setOriginalBytes] = useState<number>();
  const [comparisons, setComparisons] = useState<Comparison[]>([]),
    [comparing, setComparing] = useState(false),
    [comparisonNote, setComparisonNote] = useState("");
  const [saving, setSaving] = useState(10),
    [quality, setQuality] = useState<Quality>(1),
    [splitPersistence, setSplitPersistence] = useState(55),
    [minPatchSize, setMinPatchSize] = useState<MinPatchSize>(4),
    [encodeProgress, setEncodeProgress] = useState<EncodeProgress>(),
    [busy, setBusy] = useState(false),
    [deblock, setDeblock] = useState(true),
    [grid, setGrid] = useState(true),
    [error, setError] = useState("");
  const original = useRef<HTMLCanvasElement>(null),
    output = useRef<HTMLCanvasElement>(null),
    worker = useRef<Worker | undefined>(undefined),
    rawPreview = useRef<ImageData | undefined>(undefined),
    previewRects = useRef<PatchRect[]>([]),
    deblockRef = useRef(true),
    sourceChosen = useRef(false);
  const patchSizes = result ? patchRects(result.bytes).map(([, , w, h]) => Math.max(w, h)) : [];
  const distribution = patchSizes.length
    ? Array.from(new Set(patchSizes)).sort((a, b) => b - a).map((size) => `${size}px: ${patchSizes.filter((value) => value === size).length}枚`).join(" · ")
    : "";
  useEffect(() => {
    Promise.all([
      fetch("/pi-1m.txt").then((r) => {
        if (!r.ok) throw new Error();
        return r.text();
      }),
      fetch("/pi-index-1m.bin").then((r) => {
        if (!r.ok) throw new Error();
        return r.arrayBuffer();
      }),
    ])
      .then(([text, featureIndex]) => {
        setDigits(text);
        setIndex(featureIndex);
      })
      .catch(() => setError("100万桁の円周率辞書または特徴インデックスを読み込めませんでした"));

    fetch("/cicada-default.webp")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then(async (blob) => {
        if (sourceChosen.current) return;
        setSource(await blobToImageData(blob));
        setOriginalBytes(undefined);
      })
      .catch(() => {
        // The bundled sample is optional; manual upload still works.
      });

    return () => worker.current?.terminate();
  }, []);
  useEffect(() => {
    if (source) draw(original.current, source);
  }, [source]);
  useEffect(() => {
    deblockRef.current = deblock;
    if (result) {
      drawOutput(
        output.current,
        result.image,
        deblock,
        patchRects(result.bytes),
        grid,
        result.stats.tileSize,
        result.bytes,
      );
    } else if (busy && rawPreview.current) {
      drawOutput(output.current, rawPreview.current, deblock, previewRects.current);
    }
  }, [result, grid, deblock, busy]);
  async function pick(file?: File) {
    if (!file) return;
    sourceChosen.current = true;
    setError("");
    try {
      setSource(await blobToImageData(file));
      setOriginalBytes(file.size);
      setResult(undefined);
      rawPreview.current = undefined;
      previewRects.current = [];
      setComparisons([]);
      setComparisonNote("");
    } catch {
      setError("画像を読み込めませんでした");
    }
  }
  function run() {
    if (!source || !digits || !index) return;
    rawPreview.current = blankPreview(source.width, source.height);
    previewRects.current = [];
    setBusy(true);
    setEncodeProgress(undefined);
    setResult(undefined);
    setComparisons([]);
    setComparisonNote("");
    setError("");
    worker.current?.terminate();
    const w = new Worker(new URL("./workers/encoder.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const image = new ImageData(
      new Uint8ClampedArray(source.data),
      source.width,
      source.height,
    );
    w.onmessage = async (e) => {
      if (e.data.type === "progress") {
        const progress = e.data.progress as EncodeProgress;
        setEncodeProgress(progress);
        if (progress.preview?.length && rawPreview.current) {
          mergePreview(rawPreview.current, progress);
          previewRects.current = updatePreviewRects(previewRects.current, progress);
          drawOutput(
            output.current,
            rawPreview.current,
            deblockRef.current,
            previewRects.current,
          );
        }
        return;
      }
      if (e.data.type === "error") {
        setBusy(false);
        w.terminate();
        setError(e.data.error);
        return;
      }
      if (e.data.type !== "result") return;
      setBusy(false);
      setEncodeProgress(undefined);
      w.terminate();
      const encoded = e.data.result as EncodeResult;
      setResult(encoded);
      setComparing(true);
      setComparisonNote("");
      const attempts = await Promise.allSettled([
          compareCodec(source, encoded.stats.actualBytes, "image/jpeg"),
          compareCodec(source, encoded.stats.actualBytes, "image/webp"),
        ]),
        alternatives = attempts.flatMap((attempt) =>
          attempt.status === "fulfilled" && attempt.value ? [attempt.value] : [],
        );
      setComparisons(alternatives);
      if (alternatives.length < 2)
        setComparisonNote(
          "一部の比較形式を生成できませんでした。この端末ではWASMも利用できない可能性があります。",
        );
      setComparing(false);
    };
    w.onerror = () => {
      setBusy(false);
      setError("処理中にエラーが発生しました");
    };
    const featureIndex = index.slice(0);
    w.postMessage({ image, digits, index: featureIndex, savePercent: saving, quality, splitPersistence, minPatchSize }, [
      image.data.buffer,
      featureIndex,
    ]);
  }
  function save() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.bytes as BlobPart]));
    const a = document.createElement("a");
    a.href = url;
    a.download = "image.pipw";
    a.click();
    URL.revokeObjectURL(url);
  }
  async function openPipw(file?: File) {
    if (!file || !digits) return;
    sourceChosen.current = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()),
        image = decode(bytes, parseDigits(digits)),
        v = new DataView(bytes.buffer);
      setSource(undefined);
      rawPreview.current = undefined;
      previewRects.current = [];
      setOriginalBytes(undefined);
      setComparisons([]);
      setComparisonNote("");
      setResult({
        bytes,
        image,
        stats: {
          budgetBytes: bytes.length,
          actualBytes: bytes.length,
          ratio: 0,
          tileSize: v.getUint16(9, true),
          patches: v.getUint32(19, true),
          piPatches: 0,
          mse: 0,
          psnr: 0,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }
  return (
    <main>
      <header>
        <div className="mark">
          <Pi />
        </div>
        <div>
          <b>PI PATCHWORK</b>
          <span>visual codec experiment</span>
        </div>
        <a href="#how">How it works</a>
      </header>
      <section className="hero">
        <p className="eyebrow">
          <Sparkles /> THE DIGITS BECOME TEXTURE
        </p>
        <h1>
          円周率で、<em>画像を編み直す。</em>
        </h1>
        <p>
          円周率100万桁を共有辞書として参照し、特徴インデックスで似た断片を引き、2×2〜16×16の内部格子を拡大しながら画像を再構成する不可逆コーデックです。
        </p>
      </section>
      <section className="workbench">
        <aside>
          <label className="drop">
            <ImagePlus />
            <strong>画像を選択</strong>
            <small>PNG / JPEG / WebP · 最大辺512px</small>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </label>
          <div className="control">
            <div>
              <span>保存率</span>
              <b>{saving}%</b>
            </div>
            <input
              type="range"
              min="2"
              max="50"
              value={saving}
              onChange={(e) => setSaving(+e.target.value)}
            />
            <small>非圧縮RGBに対する目標サイズ · π辞書 1,000,000桁</small>
          </div>
          <div className="control">
            <span>探索モード</span>
            <div className="segments">
              {qualityLabels.map((q, i) => (
                <button
                  className={quality === i ? "active" : ""}
                  onClick={() => setQuality(i as Quality)}
                  key={q}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
          <div className="control">
            <div>
              <span>分割粘り</span>
              <b>{splitPersistence}</b>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={splitPersistence}
              onChange={(e) => setSplitPersistence(+e.target.value)}
            />
            <small>
              {splitPersistence === 0
                ? "1段だけ評価。追加の先読みをしません。"
                : `弱い分割では難しい子を最大${Math.max(1, Math.min(4, Math.ceil(splitPersistence / 25)))}枚、さらに1段だけ仮探索。改善しなければ親へ戻します。`}
            </small>
          </div>
          <div className="control">
            <span>最小パッチサイズ</span>
            <div className="segments patchSizes">
              {([4, 8, 16, 32] as MinPatchSize[]).map((size) => (
                <button
                  type="button"
                  className={minPatchSize === size ? "active" : ""}
                  onClick={() => setMinPatchSize(size)}
                  key={size}
                >
                  {size}px
                </button>
              ))}
            </div>
            <small>
              空間パッチの下限。小さいほど細部を追えますが、探索時間と境界数が増えます。
            </small>
          </div>
          <button
            className="primary"
            disabled={!source || !digits || !index || busy}
            onClick={run}
          >
            {busy ? <LoaderCircle className="spin" /> : <Sparkles />}
            {busy ? "探索中…" : "再構成する"}
          </button>
          {busy && (
            <div className="encodeProgress">
              <div className="encodeProgressHead">
                <span>
                  {encodeProgress?.phase === "roots"
                    ? "初期パッチを探索中"
                    : encodeProgress?.phase === "final"
                      ? "最終画像を組み立て中"
                      : "分割候補を精査中"}
                </span>
                <b>{Math.round((encodeProgress?.overall ?? 0) * 100)}%</b>
              </div>
              <div className="progressTrack">
                <i style={{ width: `${Math.round((encodeProgress?.overall ?? 0) * 100)}%` }} />
              </div>
              <small>
                {encodeProgress?.phase === "roots"
                  ? `${encodeProgress.done} / ${encodeProgress.total} 初期パッチ`
                  : `${encodeProgress?.attempts ?? 0}候補 · ${encodeProgress?.patches ?? 0} patches`}
                {encodeProgress ? ` · ${formatBytes(encodeProgress.bytes)} / ${formatBytes(encodeProgress.budget)} · ${(encodeProgress.elapsedMs / 1000).toFixed(1)}s` : ""}
              </small>
            </div>
          )}
          <label className="open">
            .pipw を開く
            <input
              type="file"
              accept=".pipw"
              onChange={(e) => openPipw(e.target.files?.[0])}
            />
          </label>
          {error && <p className="error">{error}</p>}
        </aside>
        <div className="preview">
          <div className="previewHead">
            <span>PREVIEW</span>
            <div className="previewToggles">
              <label title="表示専用の適応型デブロック。エンコードデータ自体は変更しません。">
                <input
                  type="checkbox"
                  checked={deblock}
                  onChange={(e) => setDeblock(e.target.checked)}
                />{" "}
                境界補正
              </label>
              {result && (
                <label>
                  <input
                    type="checkbox"
                    checked={grid}
                    onChange={(e) => setGrid(e.target.checked)}
                  />{" "}
                  パッチ境界
                </label>
              )}
            </div>
          </div>
          <div className="canvases">
            <figure className={!source ? "empty" : ""}>
              {source ? (
                <canvas ref={original} />
              ) : (
                <div>
                  <ImagePlus />
                  <span>画像を追加してください</span>
                </div>
              )}
              <figcaption>ORIGINAL</figcaption>
            </figure>
            <figure className={!result && !busy ? "empty" : ""}>
              {result || busy ? (
                <canvas ref={output} />
              ) : (
                <div>
                  <Pi />
                  <span>再構成結果</span>
                </div>
              )}
              <figcaption>PI PATCHWORK</figcaption>
            </figure>
          </div>
          {result && (
            <>
              <div className="stats">
                <div>
                  <small>元ファイル</small>
                  <strong>
                    {originalBytes ? formatBytes(originalBytes) : "—"}
                  </strong>
                </div>
                <div>
                  <small>.pipw</small>
                  <strong>{formatBytes(result.stats.actualBytes)}</strong>
                </div>
                <div>
                  <small>元ファイル比</small>
                  <strong>
                    {originalBytes
                      ? (
                          (result.stats.actualBytes / originalBytes) *
                          100
                        ).toFixed(2) + "%"
                      : "—"}
                  </strong>
                </div>
                <div>
                  <small>RGB保存率</small>
                  <strong>
                    {result.stats.ratio
                      ? result.stats.ratio.toFixed(2) + "%"
                      : "—"}
                  </strong>
                </div>
                <div>
                  <small>PSNR</small>
                  <strong>
                    {result.stats.psnr
                      ? result.stats.psnr.toFixed(2) + " dB"
                      : "—"}
                  </strong>
                </div>
                <div>
                  <small>パッチ / π</small>
                  <strong>
                    {result.stats.patches} / {result.stats.piPatches || 0}
                  </strong>
                </div>
              </div>
              <p className="patchDistribution">パッチ辺長の内訳（最大辺）: {distribution}</p>
              {source && (
                <section className="codecCompare">
                  <div className="compareTitle">
                    <div>
                      <small>SAME-SIZE COMPARISON</small>
                      <h3>.pipw と同容量のJPEG / WebP</h3>
                    </div>
                    <span>目標 {formatBytes(result.stats.actualBytes)}</span>
                  </div>
                  {comparing ? (
                    <p className="compareLoading">
                      <LoaderCircle className="spin" /> 同容量になる品質を探索中…
                    </p>
                  ) : (
                    <div className="comparisonGrid">
                      {comparisons.map((comparison) => (
                        <ComparisonCard key={comparison.label} comparison={comparison} />
                      ))}
                    </div>
                  )}
                  <p className="compareNote">
                    同じ512px以下の入力から最も近い容量を探索。JPEGはブラウザ、非対応端末のWebPはlibwebp/WASMで実際のファイルを生成しています。形式上の最小容量により一致しない場合があります。
                  </p>
                  {comparisonNote && <p className="compareWarning">{comparisonNote}</p>}
                </section>
              )}
              <button className="download" onClick={save}>
                <Download /> .pipw を保存
              </button>
            </>
          )}
        </div>
      </section>
      <section className="how" id="how">
        <span>HOW IT WORKS</span>
        <h2>
          画像ではなく、<em>作り方</em>を保存する。
        </h2>
        <ol>
          <li>
            <b>01</b>
            <strong>分割</strong>
          <p>細部は小さく、なめらかな場所は大きなパッチに分けます。</p>
          </li>
          <li>
            <b>02</b>
            <strong>特徴探索</strong>
            <p>色特徴をハッシュ化し、100万桁の索引から近いπ断片だけを候補にします。</p>
          </li>
          <li>
            <b>03</b>
            <strong>補正</strong>
          <p>単色・グラデーション・π模様から選び、色や向きを調整します。</p>
          </li>
          <li>
            <b>04</b>
            <strong>再構成</strong>
            <p>境界も評価して参照値から描き直します。</p>
          </li>
        </ol>
      </section>
      <footer>
        πの正規性や圧縮効率は保証されません。画像はブラウザ内だけで処理されます。
      </footer>
    </main>
  );
}
