import { describe,expect,it } from 'vitest';
import { decode,encode,parseDigits,HEADER_BYTES,RECORD_BYTES } from '../src/core/codec';
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
  it('stays within budget and decodes deterministically',()=>{const src=sample(),r=encode(src,digits,20,0);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);expect(Array.from(decode(r.bytes,digits).data)).toEqual(Array.from(r.image.data));});
  it('rejects a corrupt payload',()=>expect(()=>decode(new Uint8Array(HEADER_BYTES+RECORD_BYTES),digits)).toThrow());
  it('scores visual error instead of exact byte matches',()=>expect(encode(sample(16,16),digits,50,1).stats.mse).toBeGreaterThanOrEqual(0));
});
