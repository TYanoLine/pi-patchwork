export const HEADER_BYTES = 24;
export const RECORD_BYTES = 12;
const MAGIC = [0x50, 0x49, 0x50, 0x57];

export type EncodedStats = { budgetBytes:number; actualBytes:number; ratio:number; tileSize:number; patches:number; piPatches:number; mse:number; psnr:number };
export type EncodeResult = { bytes:Uint8Array; image:ImageData; stats:EncodedStats };
type Record = { offset:number; bias:[number,number,number]; gain:[number,number,number]; transform:number; repeat:number; solid:boolean };

export function parseDigits(text:string): Uint8Array {
  return Uint8Array.from(text.replace(/\D/g,''), Number);
}
function tx(x:number,y:number,t:number):[number,number]{
  let a=x,b=y; if(t&4) a=3-a; const r=t&3;
  if(r===1) return [3-b,a]; if(r===2) return [3-a,3-b]; if(r===3) return [b,3-a]; return [a,b];
}
function qAt(d:Uint8Array,off:number,x:number,y:number,t:number,rep:number,w:number,h:number){
  const density=1<<rep; let gx=Math.floor((x*density%w)*4/w)&3, gy=Math.floor((y*density%h)*4/h)&3;
  [gx,gy]=tx(gx,gy,t); return d[(off+gy*4+gx)%d.length]*2-9;
}
function clamp(v:number){return Math.max(0,Math.min(255,Math.round(v)));}
function fit(data:Uint8ClampedArray,width:number,height:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,off:number,t:number,rep:number):Record{
  const n=tw*th; let sq=0,sq2=0; const sy=[0,0,0],sqy=[0,0,0];
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=qAt(d,off,x,y,t,rep,tw,th);sq+=q;sq2+=q*q;const p=((y0+y)*width+x0+x)*4;for(let c=0;c<3;c++){sy[c]+=data[p+c];sqy[c]+=q*data[p+c];}}
  const gains:[number,number,number]=[0,0,0], bias:[number,number,number]=[0,0,0], den=n*sq2-sq*sq;
  for(let c=0;c<3;c++){const g=den?Math.round((n*sqy[c]-sq*sy[c])/den):0;gains[c]=Math.max(-127,Math.min(127,g));bias[c]=clamp((sy[c]-gains[c]*sq)/n);}
  return {offset:off,bias,gain:gains,transform:t,repeat:rep,solid:false};
}
function error(rec:Record,data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array){let e=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=rec.solid?0:qAt(d,rec.offset,x,y,rec.transform,rec.repeat,tw,th),p=((y0+y)*width+x0+x)*4;for(let c=0;c<3;c++){const v=clamp(rec.bias[c]+rec.gain[c]*q),z=data[p+c]-v;e+=z*z;}}return e;}
function solid(data:Uint8ClampedArray,width:number,x0:number,y0:number,tw:number,th:number):Record{const b:[number,number,number]=[0,0,0],n=tw*th;for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const p=((y0+y)*width+x0+x)*4;for(let c=0;c<3;c++)b[c]+=data[p+c];}for(let c=0;c<3;c++)b[c]=clamp(b[c]/n);return{offset:0,bias:b,gain:[0,0,0],transform:0,repeat:0,solid:true};}
function best(data:Uint8ClampedArray,width:number,height:number,x0:number,y0:number,tw:number,th:number,d:Uint8Array,quality:number){let out=solid(data,width,x0,y0,tw,th),be=error(out,data,width,x0,y0,tw,th,d);const candidates=quality===0?24:quality===1?64:160;for(let i=0;i<candidates;i++){const off=Math.floor(i*Math.max(1,d.length-16)/candidates);for(let rep=0;rep<3;rep++)for(let t=0;t<8;t++){const r=fit(data,width,height,x0,y0,tw,th,d,off,t,rep),e=error(r,data,width,x0,y0,tw,th,d);if(e<be){be=e;out=r;}}}return out;}
export function encode(source:ImageData,digits:Uint8Array,savePercent:number,quality=1):EncodeResult{
 const raw=source.width*source.height*3,budget=Math.max(HEADER_BYTES+RECORD_BYTES,Math.floor(raw*savePercent/100));const maxRec=Math.max(1,Math.floor((budget-HEADER_BYTES)/RECORD_BYTES));
 const tile=Math.max(4,Math.ceil(Math.sqrt(source.width*source.height/maxRec)));const cols=Math.ceil(source.width/tile),rows=Math.ceil(source.height/tile),records:Record[]=[];
 for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=gx*tile,y=gy*tile,tw=Math.min(tile,source.width-x),th=Math.min(tile,source.height-y);records.push(best(source.data,source.width,source.height,x,y,tw,th,digits,quality));}
 const bytes=new Uint8Array(HEADER_BYTES+records.length*RECORD_BYTES),v=new DataView(bytes.buffer);MAGIC.forEach((m,i)=>v.setUint8(i,m));v.setUint8(4,1);v.setUint16(5,source.width,true);v.setUint16(7,source.height,true);v.setUint16(9,tile,true);v.setUint16(11,cols,true);v.setUint16(13,rows,true);v.setUint32(15,digits.length,true);v.setUint32(19,records.length,true);
 records.forEach((r,i)=>{const p=HEADER_BYTES+i*RECORD_BYTES;v.setUint32(p,r.offset,true);for(let c=0;c<3;c++)v.setUint8(p+4+c,r.bias[c]);for(let c=0;c<3;c++)v.setInt8(p+7+c,r.gain[c]);v.setUint8(p+10,r.transform|(r.repeat<<3));v.setUint8(p+11,r.solid?1:0);});
 const image=decode(bytes,digits),mse=mseOf(source,image),psnr=mse?10*Math.log10(255*255/mse):Infinity;return{bytes,image,stats:{budgetBytes:budget,actualBytes:bytes.length,ratio:bytes.length/raw*100,tileSize:tile,patches:records.length,piPatches:records.filter(r=>!r.solid).length,mse,psnr}};
}
export function decode(bytes:Uint8Array,digits:Uint8Array):ImageData{const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(bytes.length<HEADER_BYTES||MAGIC.some((m,i)=>v.getUint8(i)!==m)||v.getUint8(4)!==1)throw new Error('対応していない .pipw です');const w=v.getUint16(5,true),h=v.getUint16(7,true),tile=v.getUint16(9,true),cols=v.getUint16(11,true),rows=v.getUint16(13,true),need=v.getUint32(15,true),count=v.getUint32(19,true);if(!w||!h||w*h>16_777_216||digits.length<need||count!==cols*rows||HEADER_BYTES+count*RECORD_BYTES!==bytes.length)throw new Error('破損または辞書が一致しません');const out=new ImageData(w,h);for(let i=0;i<count;i++){const p=HEADER_BYTES+i*RECORD_BYTES,off=v.getUint32(p,true),b=[v.getUint8(p+4),v.getUint8(p+5),v.getUint8(p+6)],g=[v.getInt8(p+7),v.getInt8(p+8),v.getInt8(p+9)],flags=v.getUint8(p+10),solid=!!v.getUint8(p+11),t=flags&7,rep=(flags>>3)&3,gx=i%cols,gy=Math.floor(i/cols),x0=gx*tile,y0=gy*tile,tw=Math.min(tile,w-x0),th=Math.min(tile,h-y0);if(off+16>need)throw new Error('桁位置が範囲外です');for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const q=solid?0:qAt(digits,off,x,y,t,rep,tw,th),z=((y0+y)*w+x0+x)*4;for(let c=0;c<3;c++)out.data[z+c]=clamp(b[c]+g[c]*q);out.data[z+3]=255;}}return out;}
export function mseOf(a:ImageData,b:ImageData){let e=0;for(let i=0;i<a.data.length;i+=4)for(let c=0;c<3;c++){const d=a.data[i+c]-b.data[i+c];e+=d*d;}return e/(a.width*a.height*3);}
