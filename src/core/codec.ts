export const HEADER_BYTES = 24;
export const RECORD_BYTES = 12;
const MAGIC = [0x50, 0x49, 0x50, 0x57];
export type EncodedStats = { budgetBytes:number; actualBytes:number; ratio:number; tileSize:number; patches:number; piPatches:number; mse:number; psnr:number };
export type EncodeResult = { bytes:Uint8Array; image:ImageData; stats:EncodedStats };
type Record = { offset:number; bias:[number,number,number]; gain:[number,number,number]; transform:number; repeat:number; phase:number; solid:boolean; gradient?:boolean };
type Candidate = { offset:number; transform:number; repeat:number; phase:number; score:number };

export function parseDigits(text:string):Uint8Array { return Uint8Array.from(text.replace(/\D/g,''), Number); }
function transformCell(x:number,y:number,t:number):[number,number] {
  let a=x,b=y;if(t&4)a=3-a;const r=t&3;
  if(r===1)return[3-b,a];if(r===2)return[3-a,3-b];if(r===3)return[b,3-a];return[a,b];
}
function qAt(d:Uint8Array,off:number,x:number,y:number,t:number,rep:number,phase:number,w:number,h:number) {
  const density=1<<rep,shiftX=phase&1,shiftY=(phase>>1)&1;
  let gx=(Math.floor((x*density%w)*4/w)+shiftX)&3,gy=(Math.floor((y*density%h)*4/h)+shiftY)&3;
  [gx,gy]=transformCell(gx,gy,t);return d[(off+gy*4+gx)%d.length]*2-9;
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
  return{offset:slopeY,bias,gain:gx,transform:0,repeat:0,phase:0,solid:false,gradient:true};
}
function pixel(r:Record,d:Uint8Array,x:number,y:number,tw:number,th:number,ch:number){
  if(r.gradient){const u=tw>1?(2*x-tw+1)/(tw-1):0,v=th>1?(2*y-th+1)/(th-1):0;return clamp(r.bias[ch]+r.gain[ch]*u+rSlopeY(r,ch)*v);}
  return clamp(r.bias[ch]+r.gain[ch]*(r.solid?0:qAt(d,r.offset,x,y,r.transform,r.repeat,r.phase,tw,th)));
}
function rSlopeY(r:Record,ch:number){return ((r.offset>>(ch*8))&255)<<24>>24;}
function fit(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,c:Candidate):Record {
  const n=tw*th;let sq=0,sq2=0;const sy=[0,0,0],sqy=[0,0,0];
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,tw,th);sq+=q;sq2+=q*q;const p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++){sy[ch]+=data[p+ch];sqy[ch]+=q*data[p+ch];}}
  const gain:[number,number,number]=[0,0,0],bias:[number,number,number]=[0,0,0],den=n*sq2-sq*sq;
  for(let ch=0;ch<3;ch++){const g=den?Math.round((n*sqy[ch]-sq*sy[ch])/den):0;gain[ch]=Math.max(-127,Math.min(127,g));bias[ch]=clamp((sy[ch]-gain[ch]*sq)/n);}
  return{offset:c.offset,bias,gain,transform:c.transform,repeat:c.repeat,phase:c.phase,solid:false};
}
function reconstructionError(r:Record,data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array){
  let total=0;for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const p=((y0+y)*width+x0+x)*4,edge=x===0||y===0||x===tw-1||y===th-1?1.35:1;for(let ch=0;ch<3;ch++){const delta=data[p+ch]-pixel(r,d,x,y,tw,th,ch);total+=delta*delta*edge;}}return total;
}
function solid(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number):Record {
  const bias:[number,number,number]=[0,0,0],n=tw*th;for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++)bias[ch]+=data[p+ch];}for(let ch=0;ch<3;ch++)bias[ch]=clamp(bias[ch]/n);return{offset:0,bias,gain:[0,0,0],transform:0,repeat:0,phase:0,solid:true};
}
function colorDescriptor(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number){
  const sums=new Float64Array(48),counts=new Uint16Array(16);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const cell=Math.min(3,Math.floor(y*4/th))*4+Math.min(3,Math.floor(x*4/tw)),p=((y0+y)*width+x0+x)*4;for(let ch=0;ch<3;ch++)sums[ch*16+cell]+=data[p+ch];counts[cell]++;}for(let ch=0;ch<3;ch++)for(let i=0;i<16;i++)sums[ch*16+i]/=Math.max(1,counts[i]);return sums;
}
function descriptorScore(target:Float64Array,d:Uint8Array,c:Omit<Candidate,'score'>,tw:number,th:number){
  let sx=0,sxx=0,score=0;const q=new Float64Array(16);for(let i=0;i<16;i++){const x=Math.min(tw-1,Math.floor((i%4+.5)*tw/4)),y=Math.min(th-1,Math.floor((Math.floor(i/4)+.5)*th/4));q[i]=qAt(d,c.offset,x,y,c.transform,c.repeat,c.phase,tw,th);sx+=q[i];sxx+=q[i]*q[i];}const den=16*sxx-sx*sx;for(let ch=0;ch<3;ch++){let sy=0,sxy=0;for(let i=0;i<16;i++){sy+=target[ch*16+i];sxy+=q[i]*target[ch*16+i];}const g=den?(16*sxy-sx*sy)/den:0,b=(sy-g*sx)/16;for(let i=0;i<16;i++){const delta=target[ch*16+i]-(b+g*q[i]);score+=delta*delta;}}return score;
}
function shortlist(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,quality:number){
  const target=colorDescriptor(data,width,x0,y0,tw,th),offsets=quality===0?24:quality===1?64:160,keep=quality===0?128:quality===1?256:512,list:Candidate[]=[];
  for(let i=0;i<offsets;i++){const offset=Math.floor(i*Math.max(1,d.length-16)/offsets);for(let repeat=0;repeat<3;repeat++)for(let transform=0;transform<8;transform++)for(let phase=0;phase<4;phase++){const base={offset,repeat,transform,phase},score=descriptorScore(target,d,base,tw,th);if(list.length<keep||score<list[list.length-1].score){list.push({...base,score});list.sort((a,b)=>a.score-b.score);if(list.length>keep)list.pop();}}}return list;
}
function best(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,quality:number){
  let out=solid(data,width,x0,y0,tw,th),bestError=reconstructionError(out,data,width,x0,y0,tw,th,d),slope=gradient(data,width,x0,y0,tw,th),slopeError=reconstructionError(slope,data,width,x0,y0,tw,th,d);
  if(slopeError<bestError){out=slope;bestError=slopeError;}
  if(bestError<tw*th*3) return out;
  for(const candidate of shortlist(data,width,x0,y0,tw,th,d,quality)){const record=fit(data,width,x0,y0,tw,th,d,candidate),error=reconstructionError(record,data,width,x0,y0,tw,th,d);if(error<bestError){bestError=error;out=record;}}return out;
}
type Region = { x:number; y:number; w:number; h:number; record:Record; error:number; children?:Region[]; tried?:boolean };
function partition(x:number,y:number,w:number,h:number){const a=Math.floor(w/2),b=Math.floor(h/2);return[[x,y,a,b],[x+a,y,w-a,b],[x,y+b,a,h-b],[x+a,y+b,w-a,h-b]] as const;}
export function encode(source:ImageData,digits:Uint8Array,savePercent:number,quality=1):EncodeResult {
  if(!digits.length||source.width>65535||source.height>65535)throw new Error('画像または円周率辞書が無効です');
  const raw=source.width*source.height*3,budget=Math.max(HEADER_BYTES+13,Math.floor(raw*savePercent/100));
  let tile=Math.max(16,Math.min(64,Math.ceil(Math.max(source.width,source.height)/8))),cols=Math.ceil(source.width/tile),rows=Math.ceil(source.height/tile);
  while(HEADER_BYTES+cols*rows*13>budget){tile++;cols=Math.ceil(source.width/tile);rows=Math.ceil(source.height/tile);}
  const make=(x:number,y:number,w:number,h:number):Region=>{const record=best(source.data,source.width,x,y,w,h,digits,quality);return{x,y,w,h,record,error:reconstructionError(record,source.data,source.width,x,y,w,h,digits)};};
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
    if(reduction<selected.error*0.12||reduction<selected.w*selected.h*3*4)continue;
    selected.children=children;leaves.splice(leaves.indexOf(selected),1,...children);size+=40;
  }
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);MAGIC.forEach((m,i)=>view.setUint8(i,m));view.setUint8(4,3);view.setUint16(5,source.width,true);view.setUint16(7,source.height,true);view.setUint16(9,tile,true);view.setUint16(11,cols,true);view.setUint16(13,rows,true);view.setUint32(15,digits.length,true);view.setUint32(19,leaves.length,true);
  let cursor=HEADER_BYTES;
  const write=(node:Region)=>{
    if(node.children){view.setUint8(cursor++,1);node.children.forEach(write);return;}
    view.setUint8(cursor++,0);const r=node.record,p=cursor;cursor+=RECORD_BYTES;
    view.setUint32(p,r.offset,true);for(let ch=0;ch<3;ch++)view.setUint8(p+4+ch,r.bias[ch]);for(let ch=0;ch<3;ch++)view.setInt8(p+7+ch,r.gain[ch]);view.setUint8(p+10,r.transform|(r.repeat<<3)|(r.phase<<5));view.setUint8(p+11,r.gradient?2:r.solid?1:0);
  };
  roots.forEach(write);
  if(cursor!==bytes.length)throw new Error('サイズ計算が一致しません');
  const image=decode(bytes,digits),mse=mseOf(source,image),psnr=mse?10*Math.log10(255*255/mse):Infinity;
  return{bytes,image,stats:{budgetBytes:budget,actualBytes:bytes.length,ratio:bytes.length/raw*100,tileSize:tile,patches:leaves.length,piPatches:leaves.filter(r=>!r.record.solid&&!r.record.gradient).length,mse,psnr}};
}
export function decode(bytes:Uint8Array,digits:Uint8Array):ImageData {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),version=bytes.length>=5?view.getUint8(4):0;if(bytes.length<HEADER_BYTES||MAGIC.some((m,i)=>view.getUint8(i)!==m)||(version!==1&&version!==2&&version!==3))throw new Error('対応していない .pipw です');
  const w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true),need=view.getUint32(15,true),count=view.getUint32(19,true);if(!w||!h||!tile||w*h>16_777_216||digits.length<need||cols!==Math.ceil(w/tile)||rows!==Math.ceil(h/tile)||count<cols*rows||count>w*h||version!==3&&HEADER_BYTES+count*RECORD_BYTES!==bytes.length)throw new Error('破損または辞書が一致しません');
  if(version===3){
    const out=new ImageData(w,h);let cursor=HEADER_BYTES,seen=0;
    const read=(x0:number,y0:number,tw:number,th:number,depth:number):void=>{
      if(cursor>=bytes.length||depth>16)throw new Error('分割情報が破損しています');
      const tag=view.getUint8(cursor++);
      if(tag===1){if(tw<8||th<8)throw new Error('分割情報が破損しています');for(const [x,y,a,b] of partition(x0,y0,tw,th))read(x,y,a,b,depth+1);return;}
      if(tag!==0||cursor+RECORD_BYTES>bytes.length||++seen>count)throw new Error('パッチが破損しています');
      const p=cursor;cursor+=RECORD_BYTES;
      const offset=view.getUint32(p,true),bias:[number,number,number]=[view.getUint8(p+4),view.getUint8(p+5),view.getUint8(p+6)],gain:[number,number,number]=[view.getInt8(p+7),view.getInt8(p+8),view.getInt8(p+9)],flags=view.getUint8(p+10),mode=view.getUint8(p+11);
      if(mode>2||mode===0&&offset+16>need)throw new Error('桁位置が範囲外です');
      const r:Record={offset,bias,gain,transform:flags&7,repeat:(flags>>3)&3,phase:(flags>>5)&3,solid:mode===1,gradient:mode===2};
      for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
        const z=((y0+y)*w+x0+x)*4;for(let ch=0;ch<3;ch++)out.data[z+ch]=pixel(r,digits,x,y,tw,th,ch);out.data[z+3]=255;
      }
    };
    for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;read(x,y,Math.min(tile,w-x),Math.min(tile,h-y),0);}
    if(cursor!==bytes.length||seen!==count)throw new Error('パッチ数が一致しません');return out;
  }
  const out=new ImageData(w,h);for(let i=0;i<count;i++){const p=HEADER_BYTES+i*RECORD_BYTES,offset=view.getUint32(p,true),bias=[view.getUint8(p+4),view.getUint8(p+5),view.getUint8(p+6)],gain=[view.getInt8(p+7),view.getInt8(p+8),view.getInt8(p+9)],flags=view.getUint8(p+10),solid=!!view.getUint8(p+11),transform=flags&7,repeat=(flags>>3)&3,phase=version===2?(flags>>5)&3:0,gx=i%cols,gy=Math.floor(i/cols),x0=gx*tile,y0=gy*tile,tw=Math.min(tile,w-x0),th=Math.min(tile,h-y0);if(offset+16>need)throw new Error('桁位置が範囲外です');for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=solid?0:qAt(digits,offset,x,y,transform,repeat,phase,tw,th),z=((y0+y)*w+x0+x)*4;for(let ch=0;ch<3;ch++)out.data[z+ch]=clamp(bias[ch]+gain[ch]*q);out.data[z+3]=255;}}return out;
}
export function mseOf(a:ImageData,b:ImageData){let e=0;for(let i=0;i<a.data.length;i+=4)for(let ch=0;ch<3;ch++){const d=a.data[i+ch]-b.data[i+ch];e+=d*d;}return e/(a.width*a.height*3);}
export function patchRects(bytes:Uint8Array):Array<[number,number,number,number]> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=view.getUint16(5,true),h=view.getUint16(7,true),tile=view.getUint16(9,true),cols=view.getUint16(11,true),rows=view.getUint16(13,true);
  if(bytes[4]!==3)return Array.from({length:cols*rows},(_,i)=>{const x=i%cols*tile,y=Math.floor(i/cols)*tile;return[x,y,Math.min(tile,w-x),Math.min(tile,h-y)] as [number,number,number,number];});
  const rects:Array<[number,number,number,number]>=[];let cursor=HEADER_BYTES;
  const walk=(x:number,y:number,a:number,b:number):void=>{
    const tag=bytes[cursor++];if(tag===1){for(const [u,v,m,n] of partition(x,y,a,b))walk(u,v,m,n);return;}
    rects.push([x,y,a,b]);cursor+=RECORD_BYTES;
  };
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile;walk(x,y,Math.min(tile,w-x),Math.min(tile,h-y));}
  return rects;
}
