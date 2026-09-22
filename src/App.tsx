import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, LoaderCircle, Pi, Sparkles } from 'lucide-react';
import { decode, parseDigits, type EncodeResult } from './core/codec';

type Quality = 0 | 1 | 2;
const qualityLabels = ['Fast', 'Balanced', 'Thorough'];
function formatBytes(bytes:number){if(bytes<1024)return `${bytes.toLocaleString()} B`;if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;return `${(bytes/1024/1024).toFixed(2)} MB`;}
function draw(canvas: HTMLCanvasElement | null, image: ImageData, grid=false, tile=0) {
  if (!canvas) return; canvas.width=image.width; canvas.height=image.height;
  const c=canvas.getContext('2d')!; c.putImageData(image,0,0);
  if (grid && tile) { c.strokeStyle='rgba(255,255,255,.3)'; c.lineWidth=1;
    for(let x=tile;x<image.width;x+=tile){c.beginPath();c.moveTo(x+.5,0);c.lineTo(x+.5,image.height);c.stroke();}
    for(let y=tile;y<image.height;y+=tile){c.beginPath();c.moveTo(0,y+.5);c.lineTo(image.width,y+.5);c.stroke();}
  }
}
async function fileToImageData(file:File){
  const bitmap=await createImageBitmap(file), scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
  const w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; const c=canvas.getContext('2d')!;
  c.fillStyle='#111';c.fillRect(0,0,w,h);c.drawImage(bitmap,0,0,w,h);bitmap.close();return c.getImageData(0,0,w,h);
}
export default function App(){
  const [digits,setDigits]=useState(''),[source,setSource]=useState<ImageData>(),[result,setResult]=useState<EncodeResult>();
  const [originalBytes,setOriginalBytes]=useState<number>();
  const [saving,setSaving]=useState(10),[quality,setQuality]=useState<Quality>(1),[busy,setBusy]=useState(false),[grid,setGrid]=useState(true),[error,setError]=useState('');
  const original=useRef<HTMLCanvasElement>(null),output=useRef<HTMLCanvasElement>(null),worker=useRef<Worker|undefined>(undefined);
  useEffect(()=>{fetch('/pi-10k.txt').then(r=>r.text()).then(setDigits).catch(()=>setError('円周率辞書を読み込めませんでした'));return()=>worker.current?.terminate();},[]);
  useEffect(()=>{if(source)draw(original.current,source)},[source]);
  useEffect(()=>{if(result)draw(output.current,result.image,grid,result.stats.tileSize)},[result,grid]);
  async function pick(file?:File){if(!file)return;setError('');try{setSource(await fileToImageData(file));setOriginalBytes(file.size);setResult(undefined);}catch{setError('画像を読み込めませんでした');}}
  function run(){if(!source||!digits)return;setBusy(true);setError('');worker.current?.terminate();const w=new Worker(new URL('./workers/encoder.ts',import.meta.url),{type:'module'});worker.current=w;
    const image=new ImageData(new Uint8ClampedArray(source.data),source.width,source.height);
    w.onmessage=e=>{setBusy(false);e.data.ok?setResult(e.data.result):setError(e.data.error);w.terminate();};w.onerror=()=>{setBusy(false);setError('処理中にエラーが発生しました');};w.postMessage({image,digits,savePercent:saving,quality},[image.data.buffer]);
  }
  function save(){if(!result)return;const url=URL.createObjectURL(new Blob([result.bytes as BlobPart]));const a=document.createElement('a');a.href=url;a.download='image.pipw';a.click();URL.revokeObjectURL(url);}
  async function openPipw(file?:File){if(!file||!digits)return;try{const bytes=new Uint8Array(await file.arrayBuffer()),image=decode(bytes,parseDigits(digits)),v=new DataView(bytes.buffer);setSource(undefined);setOriginalBytes(undefined);setResult({bytes,image,stats:{budgetBytes:bytes.length,actualBytes:bytes.length,ratio:0,tileSize:v.getUint16(9,true),patches:v.getUint32(19,true),piPatches:0,mse:0,psnr:0}});}catch(e){setError(e instanceof Error?e.message:'読み込めませんでした');}}
  return <main>
    <header><div className="mark"><Pi/></div><div><b>PI PATCHWORK</b><span>visual codec experiment</span></div><a href="#how">How it works</a></header>
    <section className="hero"><p className="eyebrow"><Sparkles/> THE DIGITS BECOME TEXTURE</p><h1>円周率で、<em>画像を編み直す。</em></h1><p>円周率の桁を共有パターンとして参照し、色補正・回転・反転・繰り返しで画像を再構成する不可逆コーデックです。</p></section>
    <section className="workbench"><aside>
      <label className="drop"><ImagePlus/><strong>画像を選択</strong><small>PNG / JPEG / WebP · 最大辺512px</small><input type="file" accept="image/*" onChange={e=>pick(e.target.files?.[0])}/></label>
      <div className="control"><div><span>保存率</span><b>{saving}%</b></div><input type="range" min="2" max="50" value={saving} onChange={e=>setSaving(+e.target.value)}/><small>非圧縮RGBに対する目標サイズ</small></div>
      <div className="control"><span>探索モード</span><div className="segments">{qualityLabels.map((q,i)=><button className={quality===i?'active':''} onClick={()=>setQuality(i as Quality)} key={q}>{q}</button>)}</div></div>
      <button className="primary" disabled={!source||!digits||busy} onClick={run}>{busy?<LoaderCircle className="spin"/>:<Sparkles/>}{busy?'探索中…':'再構成する'}</button>
      <label className="open">.pipw を開く<input type="file" accept=".pipw" onChange={e=>openPipw(e.target.files?.[0])}/></label>{error&&<p className="error">{error}</p>}
    </aside><div className="preview"><div className="previewHead"><span>PREVIEW</span>{result&&<label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)}/> パッチ境界</label>}</div>
      <div className="canvases"><figure className={!source?'empty':''}>{source?<canvas ref={original}/>:<div><ImagePlus/><span>画像を追加してください</span></div>}<figcaption>ORIGINAL</figcaption></figure><figure className={!result?'empty':''}>{result?<canvas ref={output}/>:<div><Pi/><span>再構成結果</span></div>}<figcaption>PI PATCHWORK</figcaption></figure></div>
      {result&&<><div className="stats"><div><small>元ファイル</small><strong>{originalBytes?formatBytes(originalBytes):'—'}</strong></div><div><small>.pipw</small><strong>{formatBytes(result.stats.actualBytes)}</strong></div><div><small>元ファイル比</small><strong>{originalBytes?(result.stats.actualBytes/originalBytes*100).toFixed(2)+'%':'—'}</strong></div><div><small>RGB保存率</small><strong>{result.stats.ratio?result.stats.ratio.toFixed(2)+'%':'—'}</strong></div><div><small>PSNR</small><strong>{result.stats.psnr?result.stats.psnr.toFixed(2)+' dB':'—'}</strong></div><div><small>パッチ / π</small><strong>{result.stats.patches} / {result.stats.piPatches||0}</strong></div></div><button className="download" onClick={save}><Download/> .pipw を保存</button></>}
    </div></section>
    <section className="how" id="how"><span>HOW IT WORKS</span><h2>画像ではなく、<em>作り方</em>を保存する。</h2><ol><li><b>01</b><strong>分割</strong><p>サイズ予算に合うパッチへ分けます。</p></li><li><b>02</b><strong>特徴探索</strong><p>4×4の色特徴から候補を絞ります。</p></li><li><b>03</b><strong>補正</strong><p>色・回転・反転・反復・位相を調整します。</p></li><li><b>04</b><strong>再構成</strong><p>境界も評価して参照値から描き直します。</p></li></ol></section>
    <footer>πの正規性や圧縮効率は保証されません。画像はブラウザ内だけで処理されます。</footer>
  </main>;
}
