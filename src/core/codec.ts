import { PI_SOURCE_SIZES, indexedOffsets, transformedFeatureHash, type PiIndex } from './piIndex';

export const HEADER_BYTES = 24;
export const RECORD_BYTES = 12;
const MAGIC = [0x50, 0x49, 0x50, 0x57];
const FORMAT_VERSION = 4;
const DICTIONARY_ID = 1;
export type EncodedStats = { budgetBytes:number; actualBytes:number; ratio:number; tileSize:number; patches:number; piPatches:number; mse:number; psnr:number };
export type EncodeResult = { bytes:Uint8Array; image:ImageData; stats:EncodedStats };
type Record = { offset:number; bias:[number,number,number]; gain:[number,number,number]; transform:number; repeat:number; phase:number; sourceSize:number; solid:boolean; gradient?:boolean };
type Candidate = { offset:number; transform:number; repeat:number; phase:number; sourceSize:number; score:number };

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
function gradient(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number):Record {
  const n=tw*th,bias:[number,number,number]=[0,0,0],gx:[number,number,number]=[0,0,0],gy:[number,number,number]=[0,0,0];
  let xx=0,yy=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const u=tw>1?(2*x-tw+1)/(tw-1):0,v=th>1?(2*y-th+1)/(th-1):0,p=((y0+y)*width+x0+x)*4;
    xx+=u*u;yy+=v*v;
    for(let ch=0;ch<3;ch++){bias[ch]+=data[p+ch];gx[ch]+=u*data[p+ch];gy[ch]+=v*data[p+ch];}
  }
  for(let ch=0;ch<3;ch++){
    bias[ch]=clamp(bias[ch]/n);
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
function fit(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,c:Candidate):Record {
  const n=tw*th;let sq=0,sq2=0;const sy=[0,0,0],sqy=[0,0,0];
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,c.sourceSize,tw,th);sq+=q;sq2+=q*q;const p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++){sy[ch]+=data[p+ch];sqy[ch]+=q*data[p+ch];}}
  const gain:[number,number,number]=[0,0,0],bias:[number,number,number]=[0,0,0],den=n*sq2-sq*sq;
  for(let ch=0;ch<3;ch++){const g=den?Math.round((n*sqy[ch]-sq*sy[ch])/den):0;gain[ch]=Math.max(-127,Math.min(127,g));bias[ch]=clamp((sy[ch]-gain[ch]*sq)/n);}
  return{offset:c.offset,bias,gain,transform:c.transform,repeat:c.repeat,phase:c.phase,sourceSize:c.sourceSize,solid:false};
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
  const bias:[number,number,number]=[0,0,0],n=tw*th;for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++)bias[ch]+=data[p+ch];}for(let ch=0;ch<3;ch++)bias[ch]=clamp(bias[ch]/n);return{offset:0,bias,gain:[0,0,0],transform:0,repeat:0,phase:0,sourceSize:4,solid:true};
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
function descriptorScore(target:Float64Array,d:Uint8Array,c:Omit<Candidate,'score'>,tw:number,th:number){
  let sx=0,sxx=0,score=0;const q=new Float64Array(16);for(let i=0;i<16;i++){const x=Math.min(tw-1,Math.floor((i%4+.5)*tw/4)),y=Math.min(th-1,Math.floor((Math.floor(i/4)+.5)*th/4));q[i]=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,c.sourceSize,tw,th);sx+=q[i];sxx+=q[i]*q[i];}const den=16*sxx-sx*sx;for(let ch=0;ch<3;ch++){let sy=0,sxy=0;for(let i=0;i<16;i++){sy+=target[ch*16+i];sxy+=q[i]*target[ch*16+i];}const g=den?(16*sxy-sx*sy)/den:0,b=(sy-g*sx)/16;for(let i=0;i<16;i++){const delta=target[ch*16+i]-(b+g*q[i]);score+=delta*delta;}}return score;
}
function shortlist(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,index:PiIndex,quality:number){
  const target=colorDescriptor(data,width,x0,y0,tw,th),feature=principalDescriptor(target),scored:Candidate[]=[];
  const transforms=quality===0?[0,2]:quality===1?[0,1,2,3]:[0,1,2,3,4,5,6,7],hashes=new Set<number>(),mask=(1<<index.bucketBits)-1;
  for(const transform of transforms){const hash=transformedFeatureHash(feature,transform);hashes.add(hash);hashes.add(hash^mask);}
  const slotLimit=quality===0?2:quality===1?4:8,keep=quality===0?96:quality===1?192:384,fallback=quality===0?4:quality===1?8:16,repeatCount=quality===0?2:3,phaseCount=quality===0?2:4;
  const sourceCodes=(quality===0?[0,1,2]:[0,1,2,3]).filter(code=>PI_SOURCE_SIZES[code]<=Math.max(tw,th)&&PI_SOURCE_SIZES[code]**2<=d.length);
  for(const sourceCode of sourceCodes){
    const sourceSize=PI_SOURCE_SIZES[sourceCode],maxOffset=d.length-sourceSize*sourceSize,offsets=new Set<number>();
    for(const hash of hashes)for(const offset of indexedOffsets(index,sourceCode,hash,slotLimit))if(offset<=maxOffset)offsets.add(offset);
    for(let i=0;i<fallback;i++)offsets.add(Math.floor(i*Math.max(1,maxOffset)/fallback));
    for(const offset of offsets)for(let repeat=0;repeat<repeatCount;repeat++)for(let transform=0;transform<8;transform++)for(let phase=0;phase<phaseCount;phase++){
      const base={offset,repeat,transform,phase,sourceSize},score=descriptorScore(target,d,base,tw,th);
      scored.push({...base,score});
    }
  }
  scored.sort((a,b)=>a.score-b.score);
  return scored.slice(0,keep);
}
function best(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,index:PiIndex,quality:number){
  let out=solid(data,width,x0,y0,tw,th),bestError=reconstructionError(out,data,width,x0,y0,tw,th,d),slope=gradient(data,width,x0,y0,tw,th),slopeError=reconstructionError(slope,data,width,x0,y0,tw,th,d);
  if(slopeError<bestError){out=slope;bestError=slopeError;}
  if(bestError<tw*th*3) return out;
  for(const candidate of shortlist(data,width,x0,y0,tw,th,d,index,quality)){const record=fit(data,width,x0,y0,tw,th,d,candidate),error=reconstructionError(record,data,width,x0,y0,tw,th,d);if(error<bestError){bestError=error;out=record;}}return out;
}
type Region = { x:number; y:number; w:number; h:number; record:Record; error:number; children?:Region[]; tried?:boolean };
function partition(x:number,y:number,w:number,h:number){const a=Math.floor(w/2),b=Math.floor(h/2);return[[x,y,a,b],[x+a,y,w-a,b],[x,y+b,a,h-b],[x+a,y+b,w-a,h-b]] as const;}
export function encode(source:ImageData,digits:Uint8Array,index:PiIndex,savePercent:number,quality=1):EncodeResult {
  if(!digits.length||digits.length>0xffffffff||index.digitCount!==digits.length||source.width>65535||source.height>65535)throw new Error('画像・円周率辞書・特徴インデックスが一致しません');
  const raw=source.width*source.height*3,budget=Math.max(HEADER_BYTES+13,Math.floor(raw*savePercent/100));
  let tile=Math.max(16,Math.min(64,Math.ceil(Math.max(source.width,source.height)/8))),cols=Math.ceil(source.width/tile),rows=Math.ceil(source.height/tile);
  while(HEADER_BYTES+cols*rows*13>budget){tile++;cols=Math.ceil(source.width/tile);rows=Math.ceil(source.height/tile);}
  const make=(x:number,y:number,w:number,h:number):Region=>{const record=best(source.data,source.width,x,y,w,h,digits,index,quality);return{x,y,w,h,record,error:reconstructionError(record,source.data,source.width,x,y,w,h,digits)};};
  const roots:Region[]=[],leaves:Region[]=[];
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    const x=gx*tile,y=gy*tile,node=make(x,y,Math.min(tile,source.width-x),Math.min(tile,source.height-y));roots.push(node);leaves.push(node);
  }
  let size=HEADER_BYTES+leaves.length*13;
  while(size+40<=budget){
    let selected:Region|undefined,priority=0;
    for(const node of leaves)if(!node.tried&&node.w>=8&&node.h>=8&&node.error>priority){selected=node;priority=node.error;}
    if(!selected)break;
    selected.tried=true;
    const children=partition(selected.x,selected.y,selected.w,selected.h).map(([x,y,w,h])=>make(x,y,w,h));
    const reduction=selected.error-children.reduce((sum,node)=>sum+node.error,0);
    // Spending 40 more bytes on tiny texture changes makes every region look equally tiled.
    // Keep larger patches unless the split has a perceptible payoff per pixel.
    if(reduction<selected.error*0.06||reduction<selected.w*selected.h*3*2)continue;
    selected.children=children;leaves.splice(leaves.indexOf(selected),1,...children);size+=40;
  }
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);MAGIC.forEach((m,i)=>view.setUint8(i,m));view.setUint8(4,FORMAT_VERSION);view.setUint16(5,source.width,true);view.setUint16(7,source.height,true);view.setUint16(9,tile,true);view.setUint16(11,cols,true);view.setUint16(13,rows,true);view.setUint32(15,digits.length,true);view.setUint32(19,leaves.length,true);view.setUint8(23,DICTIONARY_ID);
  let cursor=HEADER_BYTES;
  const write=(node:Region)=>{
    if(node.children){view.setUint8(cursor++,1);node.children.forEach(write);return;}
    view.setUint8(cursor++,0);const r=node.record,p=cursor;cursor+=RECORD_BYTES;
    view.setUint32(p,r.offset,true);for(let ch=0;ch<3;ch++)view.setUint8(p+4+ch,r.bias[ch]);for(let ch=0;ch<3;ch++)view.setInt8(p+7+ch,r.gain[ch]);view.setUint8(p+10,r.transform|(r.repeat<<3)|(r.phase<<5));const sourceCode=Math.max(0,Math.min(3,Math.round(Math.log2(r.sourceSize))-1));view.setUint8(p+11,(r.gradient?2:r.solid?1:0)|(sourceCode<<2));
  };
  roots.forEach(write);
  if(cursor!==bytes.length)throw new Error('サイズ計算が一致しません');
  const image=decode(bytes,digits),mse=mseOf(source,image),psnr=mse?10*Math.log10(255*255/mse):Infinity;
  return{bytes,image,stats:{budgetBytes:budget,actualBytes:bytes.length,ratio:bytes.length/raw*100,tileSize:tile,patches:leaves.length,piPatches:leaves.filter(r=>!r.record.solid&&!r.record.gradient).length,mse,psnr}};
}
export function decode(bytes:Uint8Array,digits:Uint8Array):ImageData {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<HEADER_BYTES||MAGIC.some((m,i)=>view.getUint8(i)!==m)||view.getUint8(4)!==FORMAT_VERSION||view.getUint8(23)!==DICTIONARY_ID)throw new Error('対応していない .pipw です');
  const w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true),need=view.getUint32(15,true),count=view.getUint32(19,true);
  if(!w||!h||!tile||w*h>16_777_216||digits.length!==need||cols!==Math.ceil(w/tile)||rows!==Math.ceil(h/tile)||count<cols*rows||count>w*h)throw new Error('破損または辞書が一致しません');
  const out=new ImageData(w,h);let cursor=HEADER_BYTES,seen=0;
  const read=(x0:number,y0:number,tw:number,th:number,depth:number):void=>{
    if(cursor>=bytes.length||depth>16)throw new Error('分割情報が破損しています');
    const tag=view.getUint8(cursor++);
    if(tag===1){if(tw<8||th<8)throw new Error('分割情報が破損しています');for(const [x,y,a,b] of partition(x0,y0,tw,th))read(x,y,a,b,depth+1);return;}
    if(tag!==0||cursor+RECORD_BYTES>bytes.length||++seen>count)throw new Error('パッチが破損しています');
    const p=cursor;cursor+=RECORD_BYTES;
    const offset=view.getUint32(p,true),bias:[number,number,number]=[view.getUint8(p+4),view.getUint8(p+5),view.getUint8(p+6)],gain:[number,number,number]=[view.getInt8(p+7),view.getInt8(p+8),view.getInt8(p+9)],flags=view.getUint8(p+10),modeByte=view.getUint8(p+11),mode=modeByte&3,sourceSize=1<<(((modeByte>>2)&3)+1);
    if((flags&0x80)!==0||(modeByte&0xf0)!==0||mode>2||mode===0&&offset+sourceSize*sourceSize>need)throw new Error('パッチが破損しています');
    const r:Record={offset,bias,gain,transform:flags&7,repeat:(flags>>3)&3,phase:(flags>>5)&3,sourceSize,solid:mode===1,gradient:mode===2};
    for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
      const z=((y0+y)*w+x0+x)*4;for(let ch=0;ch<3;ch++)out.data[z+ch]=pixel(r,digits,x,y,tw,th,ch);out.data[z+3]=255;
    }
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;read(x,y,Math.min(tile,w-x),Math.min(tile,h-y),0);}
  if(cursor!==bytes.length||seen!==count)throw new Error('パッチ数が一致しません');
  return out;
}
export function mseOf(a:ImageData,b:ImageData){let e=0;for(let i=0;i<a.data.length;i+=4)for(let ch=0;ch<3;ch++){const d=a.data[i+ch]-b.data[i+ch];e+=d*d;}return e/(a.width*a.height*3);}
export function patchRects(bytes:Uint8Array):Array<[number,number,number,number]> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true);
  if(bytes.length<HEADER_BYTES||bytes[4]!==FORMAT_VERSION||bytes[23]!==DICTIONARY_ID)throw new Error('対応していない .pipw です');
  const rects:Array<[number,number,number,number]>=[];let cursor=HEADER_BYTES;
  const walk=(x:number,y:number,a:number,b:number):void=>{
    const tag=bytes[cursor++];if(tag===1){for(const [u,v,m,n] of partition(x,y,a,b))walk(u,v,m,n);return;}
    rects.push([x,y,a,b]);cursor+=RECORD_BYTES;
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;walk(x,y,Math.min(tile,w-x),Math.min(tile,h-y));}
  return rects;
}
