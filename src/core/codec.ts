import { PI_INDEX_EMPTY, PI_SOURCE_SIZES, indexedOffsetAt, indexedReferences, transformedFeatureHash, type PiIndex } from './piIndex';

export const HEADER_BYTES = 24;
export const RECORD_BYTES = 6;
export const SOLID_RECORD_BYTES = 3;
export const GRADIENT_RECORD_BYTES = 9;
const MAGIC = [0x50, 0x49, 0x50, 0x57];
const FORMAT_VERSION = 5;
const TAG_PI = 0;
const TAG_SPLIT = 1;
const TAG_SOLID = 2;
const TAG_GRADIENT = 3;
const DICTIONARY_ID = 1;
export type EncodeObjective = 'quality'|'dictionary';
export type EncodedStats = { budgetBytes:number; actualBytes:number; ratio:number; tileSize:number; patches:number; piPatches:number; piCoverage:number; pixelsPerByte:number; budgetUse:number; objective:EncodeObjective; mse:number; psnr:number };
export type EncodeResult = { bytes:Uint8Array; image:ImageData; stats:EncodedStats };
export type PatchInfo = {
  index:number; x:number; y:number; width:number; height:number;
  mode:'pi'|'solid'|'gradient'; payloadBytes:number; totalBytes:number;
  bias:[number,number,number]; gain:[number,number,number];
  offset?:number; digitStart?:number; digitCount?:number; sourceSize?:number;
  transform?:number; repeat?:number; phase?:number; bucket?:number; slot?:number;
  gradientY?:[number,number,number];
};
export type LivePatchInfo = Omit<PatchInfo,'index'>;
export type EncodePreviewPatch = { x:number; y:number; width:number; height:number; pixels:Uint8ClampedArray; info:LivePatchInfo };
export type EncodeProgress = {
  phase:'roots'|'refine'|'final';
  overall:number;
  done:number;
  total:number;
  attempts:number;
  patches:number;
  bytes:number;
  budget:number;
  elapsedMs:number;
  preview?:EncodePreviewPatch[];
};
export type EncodeHooks = {
  onProgress?:(event:EncodeProgress)=>void;
  shouldPreview?:()=>boolean;
};
type Record = { offset:number; bias:[number,number,number]; gain:[number,number,number]; transform:number; repeat:number; phase:number; sourceSize:number; solid:boolean; gradient?:boolean; sourceCode?:number; bucket?:number; slot?:number };
type Candidate = { offset:number; sourceCode:number; bucket:number; slot:number; transform:number; repeat:number; phase:number; sourceSize:number; score:number };

export function parseDigits(text:string):Uint8Array { return Uint8Array.from(text.replace(/\D/g,''), Number); }
function transformCell(x:number,y:number,t:number,size:number):[number,number] {
  let a=x,b=y;const max=size-1;if(t&4)a=max-a;const r=t&3;
  if(r===1)return[max-b,a];if(r===2)return[max-a,max-b];if(r===3)return[b,max-a];return[a,b];
}
function qAt(d:Uint8Array,off:number,x:number,y:number,t:number,rep:number,phase:number,sourceSize:number,w:number,h:number) {
  const density=1<<rep,shiftX=phase&1,shiftY=(phase>>1)&1;
  const ux=(x+.5)*density*sourceSize/w-.5+shiftX,uy=(y+.5)*density*sourceSize/h-.5+shiftY;
  const x0=Math.floor(ux),y0=Math.floor(uy),fx=ux-x0,fy=uy-y0;
  const sample=(gx:number,gy:number)=>{
    gx=((gx%sourceSize)+sourceSize)%sourceSize;gy=((gy%sourceSize)+sourceSize)%sourceSize;
    [gx,gy]=transformCell(gx,gy,t,sourceSize);
    return d[off+gy*sourceSize+gx]*2-9;
  };
  const a=sample(x0,y0),b=sample(x0+1,y0),c=sample(x0,y0+1),e=sample(x0+1,y0+1);
  return (a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+e*fx)*fy;
}
function clamp(v:number){return Math.max(0,Math.min(255,Math.round(v)));}
const GAIN_LEVELS=[0,4,8,12,18,26,38,56] as const;
function biasCode(v:number){return Math.max(0,Math.min(15,Math.round(v/17)));}
function biasFromCode(code:number){return Math.max(0,Math.min(15,code))*17;}
function gainCode(v:number){
  const sign=v<0?8:0,absolute=Math.abs(v);
  let best=0,distance=Infinity;
  for(let i=0;i<GAIN_LEVELS.length;i++){const delta=Math.abs(absolute-GAIN_LEVELS[i]);if(delta<distance){distance=delta;best=i;}}
  return sign|best;
}
function gainFromCode(code:number){const magnitude=GAIN_LEVELS[code&7];return code&8?-magnitude:magnitude;}
const PURE_PI_BIAS:[number,number,number]=[136,136,136],PURE_PI_GAIN:[number,number,number]=[12,12,12];
function purePiRecord(c:Candidate):Record {
  return{
    offset:c.offset,bias:[...PURE_PI_BIAS],gain:[...PURE_PI_GAIN],
    transform:c.transform,repeat:c.repeat,phase:c.phase,sourceSize:c.sourceSize,
    solid:false,sourceCode:c.sourceCode,bucket:c.bucket,slot:c.slot,
  };
}
function quantizePiRecord(r:Record):Record {
  return {...r,bias:r.bias.map(v=>biasFromCode(biasCode(v))) as [number,number,number],gain:r.gain.map(v=>gainFromCode(gainCode(v))) as [number,number,number]};
}
function fitWeight(x:number,y:number,w:number,h:number){
  const edge=x===0||y===0||x===w-1||y===h-1;
  const near=x===1||y===1||x===w-2||y===h-2;
  return edge?1.8:near?1.2:1;
}
function gradient(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number):Record {
  const bias:[number,number,number]=[0,0,0],gx:[number,number,number]=[0,0,0],gy:[number,number,number]=[0,0,0];
  let sw=0,xx=0,yy=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const weight=fitWeight(x,y,tw,th),u=tw>1?(2*x-tw+1)/(tw-1):0,v=th>1?(2*y-th+1)/(th-1):0,p=((y0+y)*width+x0+x)*4;
    sw+=weight;xx+=weight*u*u;yy+=weight*v*v;
    for(let ch=0;ch<3;ch++){bias[ch]+=weight*data[p+ch];gx[ch]+=weight*u*data[p+ch];gy[ch]+=weight*v*data[p+ch];}
  }
  for(let ch=0;ch<3;ch++){
    bias[ch]=clamp(bias[ch]/sw);
    gx[ch]=Math.max(-127,Math.min(127,Math.round(gx[ch]/(xx||1))));
    gy[ch]=Math.max(-127,Math.min(127,Math.round(gy[ch]/(yy||1))));
  }
  const slopeY=gy.reduce((value,slope,ch)=>value|((slope&255)<<(ch*8)),0);
  return{offset:slopeY,bias,gain:gx,transform:0,repeat:0,phase:0,sourceSize:4,solid:false,gradient:true};
}
function pixel(r:Record,d:Uint8Array,x:number,y:number,tw:number,th:number,ch:number){
  if(r.gradient){const u=tw>1?(2*x-tw+1)/(tw-1):0,v=th>1?(2*y-th+1)/(th-1):0;return clamp(r.bias[ch]+r.gain[ch]*u+rSlopeY(r,ch)*v);}
  return clamp(r.bias[ch]+r.gain[ch]*(r.solid?0:qAt(d,r.offset,x,y,r.transform,r.repeat,r.phase,r.sourceSize,tw,th)));
}
function rSlopeY(r:Record,ch:number){return ((r.offset>>(ch*8))&255)<<24>>24;}
function renderRegion(region:Region,digits:Uint8Array):EncodePreviewPatch {
  const pixels=new Uint8ClampedArray(region.w*region.h*4),record=region.record,
    mode:PatchInfo['mode']=record.gradient?'gradient':record.solid?'solid':'pi',
    payloadBytes=record.gradient?GRADIENT_RECORD_BYTES:record.solid?SOLID_RECORD_BYTES:RECORD_BYTES,
    info:LivePatchInfo={
      x:region.x,y:region.y,width:region.w,height:region.h,mode,payloadBytes,totalBytes:1+payloadBytes,
      bias:[...record.bias] as [number,number,number],
      gain:[...record.gain] as [number,number,number],
    };
  if(mode==='pi'){
    info.offset=record.offset;
    info.digitStart=record.offset+1;
    info.digitCount=record.sourceSize*record.sourceSize;
    info.sourceSize=record.sourceSize;
    info.transform=record.transform;
    info.repeat=record.repeat;
    info.phase=record.phase;
    info.bucket=record.bucket;
    info.slot=record.slot;
  } else if(mode==='gradient'){
    info.gradientY=[rSlopeY(record,0),rSlopeY(record,1),rSlopeY(record,2)];
  }
  for(let y=0;y<region.h;y++)for(let x=0;x<region.w;x++){
    const p=(y*region.w+x)*4;
    for(let ch=0;ch<3;ch++)pixels[p+ch]=pixel(record,digits,x,y,region.w,region.h,ch);
    pixels[p+3]=255;
  }
  return{x:region.x,y:region.y,width:region.w,height:region.h,pixels,info};
}
function fit(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,c:Candidate):Record {
  let sw=0,sq=0,sq2=0;const sy=[0,0,0],sqy=[0,0,0];
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const weight=fitWeight(x,y,tw,th),q=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,c.sourceSize,tw,th),p=((y0+y)*width+x0+x)*4;
    sw+=weight;sq+=weight*q;sq2+=weight*q*q;
    for(let ch=0;ch<3;ch++){sy[ch]+=weight*data[p+ch];sqy[ch]+=weight*q*data[p+ch];}
  }
  const gain:[number,number,number]=[0,0,0],bias:[number,number,number]=[0,0,0],den=sw*sq2-sq*sq;
  for(let ch=0;ch<3;ch++){const g=den?Math.round((sw*sqy[ch]-sq*sy[ch])/den):0;gain[ch]=Math.max(-127,Math.min(127,g));bias[ch]=clamp((sy[ch]-gain[ch]*sq)/sw);}
  return quantizePiRecord({offset:c.offset,bias,gain,transform:c.transform,repeat:c.repeat,phase:c.phase,sourceSize:c.sourceSize,solid:false,sourceCode:c.sourceCode,bucket:c.bucket,slot:c.slot});
}
function reconstructionError(r:Record,data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array){
  let total=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const px=x0+x,py=y0+y,p=(py*width+px)*4;
    let contrast=0;
    if(px+1<width){const q=p+4;for(let ch=0;ch<3;ch++)contrast+=Math.abs(data[p+ch]-data[q+ch]);}
    if(py+1<Math.floor(data.length/4/width)){const q=p+width*4;for(let ch=0;ch<3;ch++)contrast+=Math.abs(data[p+ch]-data[q+ch]);}
    const detail=1+Math.min(1.5,contrast/192),boundary=x===0||y===0||x===tw-1||y===th-1?1.18:1,weight=detail*boundary;
    for(let ch=0;ch<3;ch++){const delta=data[p+ch]-pixel(r,d,x,y,tw,th,ch);total+=delta*delta*weight;}
  }
  return total;
}
function solid(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number):Record {
  const bias:[number,number,number]=[0,0,0];let sw=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const weight=fitWeight(x,y,tw,th),p=((y0+y)*width+x0+x)*4;sw+=weight;for(let ch=0;ch<3;ch++)bias[ch]+=weight*data[p+ch];}
  for(let ch=0;ch<3;ch++)bias[ch]=clamp(bias[ch]/sw);
  return{offset:0,bias,gain:[0,0,0],transform:0,repeat:0,phase:0,sourceSize:4,solid:true};
}
function colorDescriptor(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number){
  const sums=new Float64Array(48),counts=new Uint16Array(16);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const cell=Math.min(3,Math.floor(y*4/th))*4+Math.min(3,Math.floor(x*4/tw)),p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++)sums[ch*16+cell]+=data[p+ch];counts[cell]++;}for(let ch=0;ch<3;ch++)for(let i=0;i<16;i++)sums[ch*16+i]/=Math.max(1,counts[i]);return sums;
}
function principalDescriptor(target:Float64Array){
  const mean=[0,0,0],cov=[[0,0,0],[0,0,0],[0,0,0]];
  for(let ch=0;ch<3;ch++)for(let i=0;i<16;i++)mean[ch]+=target[ch*16+i]/16;
  for(let i=0;i<16;i++){
    const v=[target[i]-mean[0],target[16+i]-mean[1],target[32+i]-mean[2]];
    for(let a=0;a<3;a++)for(let b=0;b<3;b++)cov[a][b]+=v[a]*v[b];
  }
  let axis=[1,1,1];
  for(let iter=0;iter<5;iter++){
    const next=[
      cov[0][0]*axis[0]+cov[0][1]*axis[1]+cov[0][2]*axis[2],
      cov[1][0]*axis[0]+cov[1][1]*axis[1]+cov[1][2]*axis[2],
      cov[2][0]*axis[0]+cov[2][1]*axis[1]+cov[2][2]*axis[2],
    ],norm=Math.hypot(...next)||1;
    axis=next.map(value=>value/norm);
  }
  const out=new Float64Array(16);
  for(let i=0;i<16;i++)out[i]=(target[i]-mean[0])*axis[0]+(target[16+i]-mean[1])*axis[1]+(target[32+i]-mean[2])*axis[2];
  return out;
}
function frequencySignature8(values:ArrayLike<number>){
  let mean=0;for(let i=0;i<64;i++)mean+=values[i];mean/=64;
  const block2=new Float64Array(16),block4=new Float64Array(4);
  for(let by=0;by<4;by++)for(let bx=0;bx<4;bx++){
    let sum=0;for(let y=0;y<2;y++)for(let x=0;x<2;x++)sum+=values[(by*2+y)*8+bx*2+x];
    block2[by*4+bx]=sum/4;
  }
  for(let by=0;by<2;by++)for(let bx=0;bx<2;bx++){
    let sum=0;for(let y=0;y<2;y++)for(let x=0;x<2;x++)sum+=block2[(by*2+y)*4+bx*2+x];
    block4[by*2+bx]=sum/4;
  }
  let low=0,mid=0,high=0,gx=0,gy=0,gd=0;
  for(let i=0;i<4;i++){const d=block4[i]-mean;low+=d*d*16;}
  for(let by=0;by<4;by++)for(let bx=0;bx<4;bx++){
    const parent=block4[Math.floor(by/2)*2+Math.floor(bx/2)],d=block2[by*4+bx]-parent;mid+=d*d*4;
    for(let y=0;y<2;y++)for(let x=0;x<2;x++){const q=values[(by*2+y)*8+bx*2+x]-block2[by*4+bx];high+=q*q;}
  }
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    const here=values[y*8+x];
    if(x+1<8){const d=here-values[y*8+x+1];gx+=d*d;}
    if(y+1<8){const d=here-values[(y+1)*8+x];gy+=d*d;}
    if(x+1<8&&y+1<8){const d=here-values[(y+1)*8+x+1];gd+=d*d;}
  }
  const bands=low+mid+high||1,dirs=gx+gy+gd||1;
  return Float64Array.from([low/bands,mid/bands,high/bands,gx/dirs,gy/dirs,gd/dirs]);
}
function frequencyDistance(a:ArrayLike<number>,b:ArrayLike<number>){
  let total=0;for(let i=0;i<6;i++){const d=a[i]-b[i];total+=d*d;}return total;
}
function sampledLumaGrid(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number){
  const out=new Float64Array(64);
  for(let i=0;i<64;i++){
    const x=Math.min(tw-1,Math.floor((i%8+.5)*tw/8)),y=Math.min(th-1,Math.floor((Math.floor(i/8)+.5)*th/8)),
      p=((y0+y)*width+x0+x)*4;
    out[i]=data[p]*.299+data[p+1]*.587+data[p+2]*.114;
  }
  return out;
}
function reconstructedLumaGrid(r:Record,d:Uint8Array,tw:number,th:number){
  const out=new Float64Array(64);
  for(let i=0;i<64;i++){
    const x=Math.min(tw-1,Math.floor((i%8+.5)*tw/8)),y=Math.min(th-1,Math.floor((Math.floor(i/8)+.5)*th/8));
    out[i]=pixel(r,d,x,y,tw,th,0)*.299+pixel(r,d,x,y,tw,th,1)*.587+pixel(r,d,x,y,tw,th,2)*.114;
  }
  return out;
}
function candidateFrequencyGrid(d:Uint8Array,c:Omit<Candidate,'score'>,tw:number,th:number){
  const out=new Float64Array(64);
  for(let i=0;i<64;i++){
    const x=Math.min(tw-1,Math.floor((i%8+.5)*tw/8)),y=Math.min(th-1,Math.floor((Math.floor(i/8)+.5)*th/8));
    out[i]=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,c.sourceSize,tw,th);
  }
  return out;
}
function descriptorScore(target:Float64Array,d:Uint8Array,c:Omit<Candidate,'score'>,tw:number,th:number){
  let sx=0,sxx=0,score=0;const q=new Float64Array(16);
  for(let i=0;i<16;i++){const x=Math.min(tw-1,Math.floor((i%4+.5)*tw/4)),y=Math.min(th-1,Math.floor((Math.floor(i/4)+.5)*th/4));q[i]=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,c.sourceSize,tw,th);sx+=q[i];sxx+=q[i]*q[i];}
  const den=16*sxx-sx*sx;
  for(let ch=0;ch<3;ch++){let sy=0,sxy=0;for(let i=0;i<16;i++){sy+=target[ch*16+i];sxy+=q[i]*target[ch*16+i];}const g=den?(16*sxy-sx*sy)/den:0,b=(sy-g*sx)/16;for(let i=0;i<16;i++){const delta=target[ch*16+i]-(b+g*q[i]);score+=delta*delta;}}
  return score;
}
function shortlist(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,index:PiIndex,quality:number,objective:EncodeObjective,piComposition:number){
  const target=colorDescriptor(data,width,x0,y0,tw,th),feature=principalDescriptor(target),scored:Candidate[]=[],
    piPreference=Math.max(0,Math.min(100,piComposition))/100,
    dictionary=objective==='dictionary';
  const transforms=quality===0?[0,2]:quality===1?[0,1,2,3]:[0,1,2,3,4,5,6,7],
    hashes=new Set<number>(),mask=(1<<index.bucketBits)-1;
  for(const transform of transforms){const hash=transformedFeatureHash(feature,transform);hashes.add(hash);hashes.add(hash^mask);}
  if(dictionary&&piPreference>=.6){
    const seeds=[...hashes];
    for(const hash of seeds)for(let bit=0;bit<index.bucketBits;bit++)hashes.add(hash^(1<<bit));
  }
  const baseSlotLimit=quality===0?2:quality===1?4:8,
    slotLimit=dictionary&&piPreference>=.75?Math.min(8,index.slots):baseSlotLimit,
    keep=dictionary?(piPreference>=.95?640:piPreference>=.7?448:256):(quality===0?96:quality===1?192:384),
    repeatCount=quality===0?2:3,
    phaseCount=quality===0?2:4,
    refTarget=dictionary?(piPreference>=.95?28:piPreference>=.7?20:12):Infinity;
  const sourceCodes=(dictionary
    ? piPreference>=.8?[0,1,2,3]:piPreference>=.4?[1,2,3]:[2,3]
    : quality===0?[0,1,2]:[0,1,2,3])
    .filter(code=>PI_SOURCE_SIZES[code]<=Math.max(tw,th)&&PI_SOURCE_SIZES[code]**2<=d.length);
  for(const sourceCode of sourceCodes){
    const sourceSize=PI_SOURCE_SIZES[sourceCode],maxOffset=d.length-sourceSize*sourceSize,
      refs=new Map<number,{bucket:number;slot:number}>();
    for(const bucket of hashes){
      for(const ref of indexedReferences(index,sourceCode,bucket,slotLimit)){
        if(ref.offset<=maxOffset&&!refs.has(ref.offset))refs.set(ref.offset,{bucket,slot:ref.slot});
        if(refs.size>=refTarget)break;
      }
      if(refs.size>=refTarget)break;
    }
    for(const [offset,ref] of refs)for(let repeat=0;repeat<repeatCount;repeat++)for(let transform=0;transform<8;transform++)for(let phase=0;phase<phaseCount;phase++){
      const base={offset,sourceCode,bucket:ref.bucket,slot:ref.slot,repeat,transform,phase,sourceSize},score=descriptorScore(target,d,base,tw,th);
      scored.push({...base,score});
    }
  }
  scored.sort((a,b)=>a.score-b.score);
  const pool=scored.slice(0,Math.min(scored.length,Math.max(keep*2,192))),
    targetFrequency=frequencySignature8(sampledLumaGrid(data,width,x0,y0,tw,th));
  for(const candidate of pool){
    const frequencyPenalty=frequencyDistance(targetFrequency,frequencySignature8(candidateFrequencyGrid(d,candidate,tw,th)));
    candidate.score*=1+frequencyPenalty*2.4;
  }
  pool.sort((a,b)=>a.score-b.score);
  return pool.slice(0,keep);
}
function best(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,index:PiIndex,quality:number,objective:EncodeObjective,compressionPriority:number,piComposition:number,purePi=false){
  if(purePi){
    let raw:Record|undefined,rawError=Infinity;
    for(const candidate of shortlist(data,width,x0,y0,tw,th,d,index,quality,'dictionary',100)){
      const record=purePiRecord(candidate),error=reconstructionError(record,data,width,x0,y0,tw,th,d);
      if(error<rawError){rawError=error;raw=record;}
    }
    if(!raw)throw new Error('純πモードで参照候補を見つけられませんでした');
    return raw;
  }
  let model=solid(data,width,x0,y0,tw,th),modelError=reconstructionError(model,data,width,x0,y0,tw,th,d),
    slope=gradient(data,width,x0,y0,tw,th),slopeError=reconstructionError(slope,data,width,x0,y0,tw,th,d);
  if(slopeError<modelError){model=slope;modelError=slopeError;}
  if(objective==='quality'&&modelError<tw*th*3)return model;
  let piRecord:Record|undefined,piError=Infinity;
  for(const candidate of shortlist(data,width,x0,y0,tw,th,d,index,quality,objective,piComposition)){
    const record=fit(data,width,x0,y0,tw,th,d,candidate),
      error=reconstructionError(record,data,width,x0,y0,tw,th,d);
    if(error<piError){piError=error;piRecord=record;}
  }
  if(!piRecord)return model;
  if(piError<modelError)return piRecord;
  if(objective==='dictionary'){
    const priority=Math.max(0,Math.min(100,compressionPriority))/100,
      piPreference=Math.max(0,Math.min(100,piComposition))/100;
    if(piPreference>=1)return piRecord;
    const tolerance=1.15+priority*.55+Math.pow(piPreference,1.7)*6.5;
    if(modelError>0&&piError<=modelError*tolerance)return piRecord;
  }
  return model;
}
type Region = { x:number; y:number; w:number; h:number; record:Record; error:number; meanError:number; peakBlockError:number; hotRatio:number; frequencyMismatch:number; children?:Region[]; tried?:boolean };
function localErrorProfile(r:Record,data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,digits:Uint8Array){
  const block=4;let total=0,peakBlockError=0;
  for(let by=0;by<th;by+=block)for(let bx=0;bx<tw;bx+=block){
    const bw=Math.min(block,tw-bx),bh=Math.min(block,th-by);let local=0;
    for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){
      const p=((y0+by+y)*width+x0+bx+x)*4;
      for(let ch=0;ch<3;ch++){const delta=data[p+ch]-pixel(r,digits,bx+x,by+y,tw,th,ch);local+=delta*delta;}
    }
    total+=local;peakBlockError=Math.max(peakBlockError,local/(bw*bh*3));
  }
  const meanError=total/Math.max(1,tw*th*3);
  return{meanError,peakBlockError,hotRatio:peakBlockError/Math.max(1,meanError)};
}
function isPiRecord(record:Record){return !record.solid&&!record.gradient;}
function piPixelsOf(regions:Region[]){return regions.reduce((sum,region)=>sum+(isPiRecord(region.record)?region.w*region.h:0),0);}
function leafBytes(record:Record){return 1+(record.gradient?GRADIENT_RECORD_BYTES:record.solid?SOLID_RECORD_BYTES:RECORD_BYTES);}
function subtreeBytes(node:Region):number{return node.children?1+node.children.reduce((sum,child)=>sum+subtreeBytes(child),0):leafBytes(node.record);}
function sourceCodeFor(record:Record){return record.sourceCode??Math.max(0,Math.min(3,Math.round(Math.log2(record.sourceSize))-1));}
function packPiRecord(record:Record){
  if(record.bucket===undefined||record.slot===undefined)throw new Error('π参照の索引情報がありません');
  const fields=[
    [sourceCodeFor(record),0],[record.bucket,2],[record.slot,14],[record.transform,17],[record.repeat,20],[record.phase,22],
    [biasCode(record.bias[0]),24],[biasCode(record.bias[1]),28],[biasCode(record.bias[2]),32],
    [gainCode(record.gain[0]),36],[gainCode(record.gain[1]),40],[gainCode(record.gain[2]),44],
  ] as const;
  let packed=0;for(const [value,shift] of fields)packed+=value*2**shift;return packed;
}
function writePacked48(view:DataView,offset:number,packed:number){for(let i=0;i<6;i++)view.setUint8(offset+i,Math.floor(packed/2**(i*8))%256);}
function readPacked48(view:DataView,offset:number){let packed=0;for(let i=0;i<6;i++)packed+=view.getUint8(offset+i)*2**(i*8);return packed;}
function bits(packed:number,shift:number,width:number){return Math.floor(packed/2**shift)%2**width;}
function partition(x:number,y:number,w:number,h:number){const a=Math.floor(w/2),b=Math.floor(h/2);return[[x,y,a,b],[x+a,y,w-a,b],[x,y+b,a,h-b],[x+a,y+b,w-a,h-b]] as const;}
function canSplit(node:Pick<Region,'x'|'y'|'w'|'h'>,minPatchSize:number){
  return partition(node.x,node.y,node.w,node.h).every(([, ,w,h])=>w>=minPatchSize&&h>=minPatchSize);
}
function pairSeamMismatch(a:Region,b:Region,data:Uint8ClampedArray,width:number,digits:Uint8Array){
  let total=0,count=0;
  if(a.x+a.w===b.x||b.x+b.w===a.x){
    const left=a.x<b.x?a:b,right=left===a?b:a,y0=Math.max(left.y,right.y),y1=Math.min(left.y+left.h,right.y+right.h);
    for(let py=y0;py<y1;py++){const ly=py-left.y,ry=py-right.y,lp=(py*width+left.x+left.w-1)*4,rp=(py*width+right.x)*4;for(let ch=0;ch<3;ch++){const reconstructed=pixel(left.record,digits,left.w-1,ly,left.w,left.h,ch)-pixel(right.record,digits,0,ry,right.w,right.h,ch),source=data[lp+ch]-data[rp+ch],delta=reconstructed-source;total+=delta*delta;count++;}}
  } else if(a.y+a.h===b.y||b.y+b.h===a.y){
    const top=a.y<b.y?a:b,bottom=top===a?b:a,x0=Math.max(top.x,bottom.x),x1=Math.min(top.x+top.w,bottom.x+bottom.w);
    for(let px=x0;px<x1;px++){const tx=px-top.x,bx=px-bottom.x,tp=((top.y+top.h-1)*width+px)*4,bp=(bottom.y*width+px)*4;for(let ch=0;ch<3;ch++){const reconstructed=pixel(top.record,digits,tx,top.h-1,top.w,top.h,ch)-pixel(bottom.record,digits,bx,0,bottom.w,bottom.h,ch),source=data[tp+ch]-data[bp+ch],delta=reconstructed-source;total+=delta*delta;count++;}}
  }
  return count?total*2.2:0;
}
function seamPenalty(leaves:Region[],data:Uint8ClampedArray,width:number,digits:Uint8Array){
  let total=0;for(let i=0;i<leaves.length;i++)for(let j=i+1;j<leaves.length;j++)total+=pairSeamMismatch(leaves[i],leaves[j],data,width,digits);return total;
}
export function encode(source:ImageData,digits:Uint8Array,index:PiIndex,savePercent:number,quality=1,splitPersistence=50,minPatchSize=4,objective:EncodeObjective='quality',compressionPriority=70,piComposition=90,hooks?:EncodeHooks,purePi=false):EncodeResult {
  if(!digits.length||digits.length>0xffffffff||index.digitCount!==digits.length||source.width>65535||source.height>65535)throw new Error('画像・円周率辞書・特徴インデックスが一致しません');
  const raw=source.width*source.height*3,budget=Math.max(HEADER_BYTES+1+GRADIENT_RECORD_BYTES,Math.floor(raw*savePercent/100));
  if(![4,8,16,32].includes(minPatchSize))throw new Error('最小パッチサイズが不正です');
  if(objective!=='quality'&&objective!=='dictionary')throw new Error('最適化目標が不正です');
  if(!Number.isFinite(piComposition)||piComposition<0||piComposition>100)throw new Error('π構成率が不正です');
  const persistence=Math.max(0,Math.min(100,splitPersistence))/100,
    compression=Math.max(0,Math.min(100,compressionPriority))/100,
    lookaheadChildren=splitPersistence<=0?0:Math.max(1,Math.min(4,Math.ceil(persistence*4))),
    minRelativeGain=objective==='dictionary'?.06+.12*compression:.045,
    minGainPerSample=objective==='dictionary'?1.1+1.5*compression:.75,
    minEfficiency=objective==='dictionary'?70+120*compression:0,
    areaPower=objective==='dictionary'?.58+.22*compression:.5,
    piPreference=purePi?1:objective==='dictionary'?Math.max(0,Math.min(100,piComposition))/100:0;
  const started=performance.now(),maxLeafBytes=purePi?1+RECORD_BYTES:1+GRADIENT_RECORD_BYTES;
  let tile=Math.max(16,Math.min(64,Math.ceil(Math.max(source.width,source.height)/8))),cols=Math.ceil(source.width/tile),rows=Math.ceil(source.height/tile);
  while(HEADER_BYTES+cols*rows*maxLeafBytes>budget){tile++;cols=Math.ceil(source.width/tile);rows=Math.ceil(source.height/tile);}
  const rootTotal=cols*rows;
  const emit=(event:Omit<EncodeProgress,'elapsedMs'>)=>hooks?.onProgress?.({...event,elapsedMs:performance.now()-started});
  const pendingPreview:Region[]=[];
  const previewFor=(regions:Region[],force=false)=>{
    if(!hooks?.onProgress)return undefined;
    pendingPreview.push(...regions);
    if(!force&&!hooks.shouldPreview?.())return undefined;
    if(!pendingPreview.length)return undefined;
    const preview=pendingPreview.map(region=>renderRegion(region,digits));
    pendingPreview.length=0;
    return preview;
  };
  const make=(x:number,y:number,w:number,h:number):Region=>{
    const record=best(source.data,source.width,x,y,w,h,digits,index,quality,objective,compressionPriority,piComposition,purePi),
      error=reconstructionError(record,source.data,source.width,x,y,w,h,digits),
      profile=localErrorProfile(record,source.data,source.width,x,y,w,h,digits),
      frequencyMismatch=frequencyDistance(
        frequencySignature8(sampledLumaGrid(source.data,source.width,x,y,w,h)),
        frequencySignature8(reconstructedLumaGrid(record,digits,w,h)),
      );
    return{x,y,w,h,record,error,meanError:profile.meanError,peakBlockError:profile.peakBlockError,hotRatio:profile.hotRatio,frequencyMismatch};
  };
  const roots:Region[]=[],leaves:Region[]=[];let rootDone=0,rootBytes=0;
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    const x=gx*tile,y=gy*tile,node=make(x,y,Math.min(tile,source.width-x),Math.min(tile,source.height-y));
    roots.push(node);leaves.push(node);rootDone++;rootBytes+=leafBytes(node.record);
    emit({phase:'roots',overall:.28*rootDone/rootTotal,done:rootDone,total:rootTotal,attempts:0,patches:leaves.length,bytes:HEADER_BYTES+rootBytes,budget,preview:previewFor([node])});
  }
  const initialSize=HEADER_BYTES+rootBytes;
  let size=initialSize,attempts=0;
  while(size<budget){
    let selected:Region|undefined,selectionPriority=0;
    for(const node of leaves)if(!node.tried&&canSplit(node,minPatchSize)){
      const area=node.w*node.h,errorDensity=node.error/(area*3),
        hotspotBoost=objective==='dictionary'&&piPreference>=.8&&isPiRecord(node.record)
          ?Math.min(4,Math.max(0,node.hotRatio-1.8)*.45+Math.max(0,node.peakBlockError-1200)/1800+Math.max(0,node.meanError-500)/1200+Math.max(0,node.frequencyMismatch-.12)*2.5)
          :0,
        score=errorDensity*Math.pow(area,areaPower)*(1+hotspotBoost);
      if(score>selectionPriority){selected=node;selectionPriority=score;}
    }
    if(!selected)break;
    selected.tried=true;attempts++;
    const children=partition(selected.x,selected.y,selected.w,selected.h).map(([x,y,w,h])=>make(x,y,w,h)),
      directCost=children.reduce((sum,node)=>sum+node.error,0)+seamPenalty(children,source.data,source.width,digits),
      directReduction=selected.error-directCost,
      samples=selected.w*selected.h*3,
      directRelative=selected.error?directReduction/selected.error:0,
      directGain=directReduction/samples,
      directExtra=1+children.reduce((sum,node)=>sum+leafBytes(node.record),0)-leafBytes(selected.record),
      parentPiPixels=isPiRecord(selected.record)?selected.w*selected.h:0,
      directPiPixels=piPixelsOf(children),
      directPiDelta=(directPiPixels-parentPiPixels)/(selected.w*selected.h),
      directEff=directReduction/Math.max(1,directExtra),
      directCoverageScore=directPiDelta*(240+1760*piPreference*piPreference),
      directScore=directEff+directCoverageScore,
      directLosesPi=directPiDelta<0&&piPreference>=.95,
      directCoverageDriven=directPiDelta>0&&piPreference>=.8,
      hotspot=piPreference>=.95&&isPiRecord(selected.record)&&selected.peakBlockError>1600&&selected.hotRatio>2.1,
      childPeak=Math.max(...children.map(node=>node.peakBlockError)),
      childMean=children.reduce((sum,node)=>sum+node.meanError*node.w*node.h,0)/(selected.w*selected.h),
      directPeakImprovement=(selected.peakBlockError-childPeak)/Math.max(1,selected.peakBlockError),
      directMeanImprovement=(selected.meanError-childMean)/Math.max(1,selected.meanError),
      childFrequency=children.reduce((sum,node)=>sum+node.frequencyMismatch*node.w*node.h,0)/(selected.w*selected.h),
      directFrequencyImprovement=(selected.frequencyMismatch-childFrequency)/Math.max(.01,selected.frequencyMismatch),
      broadFailure=piPreference>=.95&&isPiRecord(selected.record)&&(selected.meanError>625||selected.frequencyMismatch>.18),
      directHotspotRescue=hotspot&&directPeakImprovement>.28,
      directBroadRescue=broadFailure&&(directMeanImprovement>.2||directFrequencyImprovement>.25),
      directRescue=directHotspotRescue||directBroadRescue;
    let bestPlan:{children:Region[];leaves:Region[];extraBytes:number;reduction:number;efficiency:number;splitChild?:Region;grandchildren?:Region[]}|undefined;
    const directQualityOk=directReduction>0&&directRelative>=minRelativeGain&&directGain>=minGainPerSample&&directScore>=minEfficiency,
      directPiOk=directCoverageDriven&&(piPreference>=.999||directScore>=minEfficiency*.35),
      directPlanScore=directScore+(directHotspotRescue?220:0)+(directBroadRescue?180:0);
    if(directExtra>0&&size+directExtra<=budget&&(!directLosesPi||directRescue)&&(directQualityOk||directPiOk||directRescue)){
      bestPlan={children,leaves:children,extraBytes:directExtra,reduction:directReduction,efficiency:directPlanScore};
    }

    if(lookaheadChildren){
      const probe=children.filter(node=>canSplit(node,minPatchSize)).sort((a,b)=>b.error-a.error).slice(0,lookaheadChildren);
      for(const child of probe){
        const grandchildren=partition(child.x,child.y,child.w,child.h).map(([x,y,w,h])=>make(x,y,w,h)),
          planLeaves=children.flatMap(node=>node===child?grandchildren:[node]),
          planCost=planLeaves.reduce((sum,node)=>sum+node.error,0)+seamPenalty(planLeaves,source.data,source.width,digits),
          reduction=selected.error-planCost,
          relative=selected.error?reduction/selected.error:0,
          gain=reduction/samples,
          planTreeBytes=1+children.reduce((sum,node)=>sum+(node===child?1+grandchildren.reduce((inner,g)=>inner+leafBytes(g.record),0):leafBytes(node.record)),0),
          extraBytes=planTreeBytes-leafBytes(selected.record),
          rawEfficiency=reduction/Math.max(1,extraBytes),
          planPiPixels=piPixelsOf(planLeaves),
          piDelta=(planPiPixels-parentPiPixels)/(selected.w*selected.h),
          coverageScore=piDelta*(240+1760*piPreference*piPreference),
          efficiency=rawEfficiency+coverageScore,
          losesPi=piDelta<0&&piPreference>=.95,
          coverageDriven=piDelta>0&&piPreference>=.8,
          planPeak=Math.max(...planLeaves.map(node=>node.peakBlockError)),
          planMean=planLeaves.reduce((sum,node)=>sum+node.meanError*node.w*node.h,0)/(selected.w*selected.h),
          planPeakImprovement=(selected.peakBlockError-planPeak)/Math.max(1,selected.peakBlockError),
          planMeanImprovement=(selected.meanError-planMean)/Math.max(1,selected.meanError),
          planFrequency=planLeaves.reduce((sum,node)=>sum+node.frequencyMismatch*node.w*node.h,0)/(selected.w*selected.h),
          planFrequencyImprovement=(selected.frequencyMismatch-planFrequency)/Math.max(.01,selected.frequencyMismatch),
          hotspotRescue=hotspot&&planPeakImprovement>.22,
          broadRescue=broadFailure&&(planMeanImprovement>.16||planFrequencyImprovement>.2),
          rescue=hotspotRescue||broadRescue,
          qualityOk=reduction>0&&relative>=minRelativeGain&&gain>=minGainPerSample*.8&&efficiency>=minEfficiency*.85,
          piOk=coverageDriven&&(piPreference>=.999||efficiency>=minEfficiency*.3),
          planScore=efficiency+(hotspotRescue?180:0)+(broadRescue?150:0);
        if(extraBytes>0&&size+extraBytes<=budget&&(!losesPi||rescue)&&(qualityOk||piOk||rescue)&&(!bestPlan||planScore>bestPlan.efficiency)){
          bestPlan={children,leaves:planLeaves,extraBytes,reduction,efficiency:planScore,splitChild:child,grandchildren};
        }
      }
    }
    if(!bestPlan){
      const refineTotal=Math.max(1,budget-initialSize),used=Math.max(0,size-initialSize);
      emit({phase:'refine',overall:.28+.67*Math.min(1,used/refineTotal),done:used,total:refineTotal,attempts,patches:leaves.length,bytes:size,budget});
      continue;
    }
    selected.children=bestPlan.children;
    if(bestPlan.splitChild&&bestPlan.grandchildren)bestPlan.splitChild.children=bestPlan.grandchildren;
    leaves.splice(leaves.indexOf(selected),1,...bestPlan.leaves);
    size+=bestPlan.extraBytes;
    const refineTotal=Math.max(1,budget-initialSize),used=Math.max(0,size-initialSize);
    emit({phase:'refine',overall:.28+.67*Math.min(1,used/refineTotal),done:used,total:refineTotal,attempts,patches:leaves.length,bytes:size,budget,preview:previewFor(bestPlan.leaves)});
  }
  emit({phase:'final',overall:.97,done:size,total:budget,attempts,patches:leaves.length,bytes:size,budget,preview:previewFor([],true)});
  const serializedSize=HEADER_BYTES+roots.reduce((sum,node)=>sum+subtreeBytes(node),0);
  if(serializedSize!==size)throw new Error('サイズ計算が一致しません');
  const bytes=new Uint8Array(serializedSize),view=new DataView(bytes.buffer);
  MAGIC.forEach((m,i)=>view.setUint8(i,m));view.setUint8(4,FORMAT_VERSION);view.setUint16(5,source.width,true);view.setUint16(7,source.height,true);view.setUint16(9,tile,true);view.setUint16(11,cols,true);view.setUint16(13,rows,true);view.setUint32(15,digits.length,true);view.setUint32(19,leaves.length,true);view.setUint8(23,DICTIONARY_ID);
  let cursor=HEADER_BYTES;
  const write=(node:Region)=>{
    if(node.children){view.setUint8(cursor++,TAG_SPLIT);node.children.forEach(write);return;}
    const r=node.record;
    if(r.gradient){
      view.setUint8(cursor++,TAG_GRADIENT);
      const p=cursor;cursor+=GRADIENT_RECORD_BYTES;
      for(let ch=0;ch<3;ch++)view.setUint8(p+ch,r.bias[ch]);
      for(let ch=0;ch<3;ch++)view.setInt8(p+3+ch,r.gain[ch]);
      for(let ch=0;ch<3;ch++)view.setInt8(p+6+ch,rSlopeY(r,ch));
      return;
    }
    if(r.solid){
      view.setUint8(cursor++,TAG_SOLID);
      const p=cursor;cursor+=SOLID_RECORD_BYTES;
      for(let ch=0;ch<3;ch++)view.setUint8(p+ch,r.bias[ch]);
      return;
    }
    view.setUint8(cursor++,TAG_PI);
    writePacked48(view,cursor,packPiRecord(r));cursor+=RECORD_BYTES;
  };
  roots.forEach(write);
  if(cursor!==bytes.length)throw new Error('サイズ計算が一致しません');
  const image=decode(bytes,digits,index),mse=mseOf(source,image),psnr=mse?10*Math.log10(255*255/mse):Infinity,
    piLeaves=leaves.filter(r=>!r.record.solid&&!r.record.gradient),
    piPixels=piLeaves.reduce((sum,r)=>sum+r.w*r.h,0);
  emit({phase:'final',overall:1,done:bytes.length,total:budget,attempts,patches:leaves.length,bytes:bytes.length,budget});
  return{bytes,image,stats:{budgetBytes:budget,actualBytes:bytes.length,ratio:bytes.length/raw*100,tileSize:tile,patches:leaves.length,piPatches:piLeaves.length,piCoverage:piPixels/(source.width*source.height)*100,pixelsPerByte:source.width*source.height/bytes.length,budgetUse:bytes.length/budget*100,objective,mse,psnr}};
}
export function decode(bytes:Uint8Array,digits:Uint8Array,index:PiIndex):ImageData {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<HEADER_BYTES||MAGIC.some((m,i)=>view.getUint8(i)!==m)||view.getUint8(4)!==FORMAT_VERSION||view.getUint8(23)!==DICTIONARY_ID)throw new Error('対応していない .pipw です');
  const w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true),need=view.getUint32(15,true),count=view.getUint32(19,true);
  if(!w||!h||!tile||w*h>16_777_216||digits.length!==need||index.digitCount!==need||cols!==Math.ceil(w/tile)||rows!==Math.ceil(h/tile)||count<cols*rows||count>w*h)throw new Error('破損または辞書が一致しません');
  const out=new ImageData(w,h);let cursor=HEADER_BYTES,seen=0;
  const read=(x0:number,y0:number,tw:number,th:number,depth:number):void=>{
    if(cursor>=bytes.length||depth>16)throw new Error('分割情報が破損しています');
    const tag=view.getUint8(cursor++);
    if(tag===TAG_SPLIT){
      if(tw<8||th<8)throw new Error('分割情報が破損しています');
      for(const [x,y,a,b] of partition(x0,y0,tw,th))read(x,y,a,b,depth+1);
      return;
    }
    if(++seen>count)throw new Error('パッチが破損しています');
    let r:Record;
    if(tag===TAG_PI){
      if(cursor+RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const packed=readPacked48(view,cursor);cursor+=RECORD_BYTES;
      const sourceCode=bits(packed,0,2),bucket=bits(packed,2,12),slot=bits(packed,14,3),
        transform=bits(packed,17,3),repeat=bits(packed,20,2),phase=bits(packed,22,2),
        bias:[number,number,number]=[biasFromCode(bits(packed,24,4)),biasFromCode(bits(packed,28,4)),biasFromCode(bits(packed,32,4))],
        gain:[number,number,number]=[gainFromCode(bits(packed,36,4)),gainFromCode(bits(packed,40,4)),gainFromCode(bits(packed,44,4))],
        sourceSize=PI_SOURCE_SIZES[sourceCode],offset=indexedOffsetAt(index,sourceCode,bucket,slot);
      if(offset===PI_INDEX_EMPTY||offset+sourceSize*sourceSize>need)throw new Error('π参照が壊れています');
      r={offset,bias,gain,transform,repeat,phase,sourceSize,solid:false,sourceCode,bucket,slot};
    } else if(tag===TAG_SOLID){
      if(cursor+SOLID_RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const p=cursor;cursor+=SOLID_RECORD_BYTES;
      r={offset:0,bias:[view.getUint8(p),view.getUint8(p+1),view.getUint8(p+2)],gain:[0,0,0],transform:0,repeat:0,phase:0,sourceSize:4,solid:true};
    } else if(tag===TAG_GRADIENT){
      if(cursor+GRADIENT_RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const p=cursor;cursor+=GRADIENT_RECORD_BYTES;
      const gy=[view.getInt8(p+6),view.getInt8(p+7),view.getInt8(p+8)],
        slopeY=(gy[0]&255)|((gy[1]&255)<<8)|((gy[2]&255)<<16);
      r={offset:slopeY,bias:[view.getUint8(p),view.getUint8(p+1),view.getUint8(p+2)],gain:[view.getInt8(p+3),view.getInt8(p+4),view.getInt8(p+5)],transform:0,repeat:0,phase:0,sourceSize:4,solid:false,gradient:true};
    } else throw new Error('パッチが破損しています');
    for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
      const z=((y0+y)*w+x0+x)*4;
      for(let ch=0;ch<3;ch++)out.data[z+ch]=pixel(r,digits,x,y,tw,th,ch);
      out.data[z+3]=255;
    }
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;read(x,y,Math.min(tile,w-x),Math.min(tile,h-y),0);}
  if(cursor!==bytes.length||seen!==count)throw new Error('パッチ数が一致しません');
  return out;
}
export function mseOf(a:ImageData,b:ImageData){let e=0;for(let i=0;i<a.data.length;i+=4)for(let ch=0;ch<3;ch++){const d=a.data[i+ch]-b.data[i+ch];e+=d*d;}return e/(a.width*a.height*3);}
export function patchInfos(bytes:Uint8Array,index:PiIndex):PatchInfo[] {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),
    w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),
    cols=view.getUint16(11,true),rows=view.getUint16(13,true),need=view.getUint32(15,true),count=view.getUint32(19,true);
  if(bytes.length<HEADER_BYTES||bytes[4]!==FORMAT_VERSION||bytes[23]!==DICTIONARY_ID||index.digitCount!==need)throw new Error('対応していない .pipw です');
  const out:PatchInfo[]=[];let cursor=HEADER_BYTES,leafIndex=0;
  const walk=(x:number,y:number,a:number,b:number):void=>{
    if(cursor>=bytes.length)throw new Error('分割情報が破損しています');
    const tag=view.getUint8(cursor++);
    if(tag===TAG_SPLIT){for(const [u,v,m,n] of partition(x,y,a,b))walk(u,v,m,n);return;}
    leafIndex++;
    if(tag===TAG_PI){
      if(cursor+RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const packed=readPacked48(view,cursor);cursor+=RECORD_BYTES;
      const sourceCode=bits(packed,0,2),bucket=bits(packed,2,12),slot=bits(packed,14,3),
        transform=bits(packed,17,3),repeat=bits(packed,20,2),phase=bits(packed,22,2),
        bias:[number,number,number]=[biasFromCode(bits(packed,24,4)),biasFromCode(bits(packed,28,4)),biasFromCode(bits(packed,32,4))],
        gain:[number,number,number]=[gainFromCode(bits(packed,36,4)),gainFromCode(bits(packed,40,4)),gainFromCode(bits(packed,44,4))],
        sourceSize=PI_SOURCE_SIZES[sourceCode],offset=indexedOffsetAt(index,sourceCode,bucket,slot),digitCount=sourceSize*sourceSize;
      if(offset===PI_INDEX_EMPTY||offset+digitCount>need)throw new Error('π参照が壊れています');
      out.push({index:leafIndex,x,y,width:a,height:b,mode:'pi',payloadBytes:RECORD_BYTES,totalBytes:1+RECORD_BYTES,bias,gain,offset,digitStart:offset+1,digitCount,sourceSize,transform,repeat,phase,bucket,slot});
      return;
    }
    if(tag===TAG_SOLID){
      if(cursor+SOLID_RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const p=cursor;cursor+=SOLID_RECORD_BYTES;
      const bias:[number,number,number]=[view.getUint8(p),view.getUint8(p+1),view.getUint8(p+2)];
      out.push({index:leafIndex,x,y,width:a,height:b,mode:'solid',payloadBytes:SOLID_RECORD_BYTES,totalBytes:1+SOLID_RECORD_BYTES,bias,gain:[0,0,0]});
      return;
    }
    if(tag===TAG_GRADIENT){
      if(cursor+GRADIENT_RECORD_BYTES>bytes.length)throw new Error('パッチが破損しています');
      const p=cursor;cursor+=GRADIENT_RECORD_BYTES;
      const bias:[number,number,number]=[view.getUint8(p),view.getUint8(p+1),view.getUint8(p+2)],
        gain:[number,number,number]=[view.getInt8(p+3),view.getInt8(p+4),view.getInt8(p+5)],
        gradientY:[number,number,number]=[view.getInt8(p+6),view.getInt8(p+7),view.getInt8(p+8)];
      out.push({index:leafIndex,x,y,width:a,height:b,mode:'gradient',payloadBytes:GRADIENT_RECORD_BYTES,totalBytes:1+GRADIENT_RECORD_BYTES,bias,gain,gradientY});
      return;
    }
    throw new Error('パッチが破損しています');
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;walk(x,y,Math.min(tile,w-x),Math.min(tile,h-y));}
  if(cursor!==bytes.length||leafIndex!==count)throw new Error('パッチ数が一致しません');
  return out;
}

export function patchRects(bytes:Uint8Array):Array<[number,number,number,number]> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true);
  if(bytes.length<HEADER_BYTES||bytes[4]!==FORMAT_VERSION||bytes[23]!==DICTIONARY_ID)throw new Error('対応していない .pipw です');
  const rects:Array<[number,number,number,number]>=[];let cursor=HEADER_BYTES;
  const walk=(x:number,y:number,a:number,b:number):void=>{
    if(cursor>=bytes.length)throw new Error('分割情報が破損しています');
    const tag=bytes[cursor++];
    if(tag===TAG_SPLIT){for(const [u,v,m,n] of partition(x,y,a,b))walk(u,v,m,n);return;}
    rects.push([x,y,a,b]);
    if(tag===TAG_PI)cursor+=RECORD_BYTES;
    else if(tag===TAG_SOLID)cursor+=SOLID_RECORD_BYTES;
    else if(tag===TAG_GRADIENT)cursor+=GRADIENT_RECORD_BYTES;
    else throw new Error('パッチが破損しています');
    if(cursor>bytes.length)throw new Error('パッチが破損しています');
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;walk(x,y,Math.min(tile,w-x),Math.min(tile,h-y));}
  if(cursor!==bytes.length)throw new Error('パッチが破損しています');
  return rects;
}
