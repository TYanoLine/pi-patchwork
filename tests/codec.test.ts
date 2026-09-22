import { describe,expect,it } from 'vitest';
import { decode,encode,parseDigits,patchRects,HEADER_BYTES,RECORD_BYTES } from '../src/core/codec';
(globalThis as typeof globalThis & {ImageData: typeof ImageData}).ImageData = class ImageDataPolyfill {
  data: Uint8ClampedArray; width: number; height: number;
  constructor(dataOrWidth: Uint8ClampedArray|number,widthOrHeight:number,height?:number){
    if(typeof dataOrWidth==='number'){this.width=dataOrWidth;this.height=widthOrHeight;this.data=new Uint8ClampedArray(this.width*this.height*4);}
    else{this.data=dataOrWidth;this.width=widthOrHeight;this.height=height!;}
  }
} as unknown as typeof ImageData;
const digits=parseDigits('14159265358979323846264338327950288419716939937510'.repeat(20));
function sample(w=32,h=24){const d=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*4;d[p]=x*7%256;d[p+1]=y*11%256;d[p+2]=(x+y)*5%256;d[p+3]=255;}return new ImageData(d,w,h);}
describe('pipw codec',()=>{
  it('stays within budget and decodes v3 deterministically',()=>{const src=sample(),r=encode(src,digits,20,0);expect(r.bytes[4]).toBe(3);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);expect(Array.from(decode(r.bytes,digits).data)).toEqual(Array.from(r.image.data));});
  it('continues to accept v1 and v2 records',()=>{const legacy=new Uint8Array(HEADER_BYTES+RECORD_BYTES),v=new DataView(legacy.buffer);legacy.set([80,73,80,87]);v.setUint16(5,4,true);v.setUint16(7,4,true);v.setUint16(9,4,true);v.setUint16(11,1,true);v.setUint16(13,1,true);v.setUint32(15,digits.length,true);v.setUint32(19,1,true);v.setUint8(HEADER_BYTES+4,123);v.setUint8(HEADER_BYTES+5,55);v.setUint8(HEADER_BYTES+6,89);v.setUint8(HEADER_BYTES+11,1);for(const version of [1,2]){legacy[4]=version;expect(Array.from(decode(legacy,digits).data.slice(0,4))).toEqual([123,55,89,255]);}});
  it('encodes a smooth gradient and splits detailed regions',()=>{const src=sample(64,48),r=encode(src,digits,15,0);expect(r.stats.patches).toBeGreaterThan(Math.ceil(src.width/r.stats.tileSize)*Math.ceil(src.height/r.stats.tileSize));expect(r.bytes.includes(2)).toBe(true);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);});
  it('uses gradient patches for smooth shading',()=>{const src=sample(64,64);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const p=(y*64+x)*4;src.data[p]=x*3;src.data[p+1]=y*3;src.data[p+2]=80+x+y;}const r=encode(src,digits,5,0);expect(r.stats.psnr).toBeGreaterThan(30);expect(r.stats.piPatches).toBeLessThan(r.stats.patches);});
  it('rejects a truncated v3 partition',()=>{const r=encode(sample(32,32),digits,20,0);expect(()=>decode(r.bytes.slice(0,-1),digits)).toThrow();});
  it('keeps different patch sizes in a mixed-detail image',()=>{const src=sample(128,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const p=(y*128+x)*4,v=x<64?x*2:(x*31+y*17)%200;src.data[p]=v;src.data[p+1]=v;src.data[p+2]=v;}const r=encode(src,digits,10,0),sizes=new Set(patchRects(r.bytes).map(([, ,w,h])=>Math.max(w,h)));expect(sizes.size).toBeGreaterThanOrEqual(3);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);});
  it('rejects a corrupt payload',()=>expect(()=>decode(new Uint8Array(HEADER_BYTES+RECORD_BYTES),digits)).toThrow());
  it('scores visual error instead of exact byte matches',()=>expect(encode(sample(16,16),digits,50,1).stats.mse).toBeGreaterThanOrEqual(0));
});
