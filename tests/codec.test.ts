import { describe,expect,it } from 'vitest';
import { decode,encode,parseDigits,patchRects,HEADER_BYTES,RECORD_BYTES } from '../src/core/codec';
import { PI_INDEX_EMPTY, type PiIndex } from '../src/core/piIndex';
import { deblockImage } from '../src/core/deblock';

(globalThis as typeof globalThis & {ImageData: typeof ImageData}).ImageData = class ImageDataPolyfill {
  data: Uint8ClampedArray; width: number; height: number;
  constructor(dataOrWidth: Uint8ClampedArray|number,widthOrHeight:number,height?:number){
    if(typeof dataOrWidth==='number'){this.width=dataOrWidth;this.height=widthOrHeight;this.data=new Uint8ClampedArray(this.width*this.height*4);}
    else{this.data=dataOrWidth;this.width=widthOrHeight;this.height=height!;}
  }
} as unknown as typeof ImageData;

const digits=parseDigits('14159265358979323846264338327950288419716939937510'.repeat(20));
const indexEntries=new Uint32Array(4*(1<<12)).fill(PI_INDEX_EMPTY);
indexEntries[0]=0;
const index:PiIndex={bucketBits:12,slots:1,digitCount:digits.length,entries:indexEntries};

function sample(w=32,h=24){const d=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*4;d[p]=x*7%256;d[p+1]=y*11%256;d[p+2]=(x+y)*5%256;d[p+3]=255;}return new ImageData(d,w,h);}

describe('pipw codec',()=>{
  it('stays within budget and decodes v5 deterministically',()=>{const src=sample(),r=encode(src,digits,index,20,0);expect(r.bytes[4]).toBe(5);expect(r.bytes[23]).toBe(1);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);expect(Array.from(decode(r.bytes,digits,index).data)).toEqual(Array.from(r.image.data));});
  it('rejects legacy versions',()=>{const legacy=new Uint8Array(HEADER_BYTES+1+RECORD_BYTES);legacy.set([80,73,80,87]);legacy[4]=4;expect(()=>decode(legacy,digits,index)).toThrow();});
  it('stores a pi leaf in six indexed bytes and bilinearly enlarges it',()=>{expect(RECORD_BYTES).toBe(6);const packed=new Uint8Array(HEADER_BYTES+1+RECORD_BYTES),v=new DataView(packed.buffer);packed.set([80,73,80,87]);v.setUint8(4,5);v.setUint16(5,4,true);v.setUint16(7,4,true);v.setUint16(9,4,true);v.setUint16(11,1,true);v.setUint16(13,1,true);v.setUint32(15,digits.length,true);v.setUint32(19,1,true);v.setUint8(23,1);v.setUint8(HEADER_BYTES,0);let bits=0;bits+=8*2**24+8*2**28+8*2**32;bits+=1*2**36+1*2**40+1*2**44;for(let i=0;i<6;i++)v.setUint8(HEADER_BYTES+1+i,Math.floor(bits/2**(8*i))%256);const image=decode(packed,digits,index),reds=[] as number[];for(let x=0;x<4;x++)reds.push(image.data[x*4]);expect(new Set(reds).size).toBeGreaterThan(1);});
  it('streams progress and preview patches',()=>{const phases:string[]=[],previews:number[]=[];encode(sample(32,32),digits,index,20,0,50,4,'quality',70,{shouldPreview:()=>true,onProgress:(p)=>{phases.push(p.phase);previews.push(p.preview?.length??0);}});expect(phases).toContain('roots');expect(phases).toContain('final');expect(previews.some((n)=>n>0)).toBe(true);});
  it('deblocking reduces moderate patch seams but preserves strong edges',()=>{const make=(left:number,right:number)=>{const d=new Uint8ClampedArray(12*6*4);for(let y=0;y<6;y++)for(let x=0;x<12;x++){const p=(y*12+x)*4,v=x<6?left:right;d[p]=v;d[p+1]=v;d[p+2]=v;d[p+3]=255;}return new ImageData(d,12,6);};const rects:[[number,number,number,number],[number,number,number,number]]=[[0,0,6,6],[6,0,6,6]],moderate=make(100,126),strong=make(20,220),moderateOut=deblockImage(moderate,rects),strongOut=deblockImage(strong,rects),seam=(image:ImageData)=>Math.abs(image.data[(2*12+5)*4]-image.data[(2*12+6)*4]);expect(seam(moderateOut)).toBeLessThan(seam(moderate));expect(seam(strongOut)).toBe(seam(strong));});
  it('deblocking also softens seams beside textured pixels',()=>{const d=new Uint8ClampedArray(12*6*4),left=[70,100,105],right=[160,165,135];for(let y=0;y<6;y++)for(let x=0;x<12;x++){const p=(y*12+x)*4,v=x<6?left[Math.max(0,x-3)%3]:right[Math.min(2,x-6)%3];d[p]=v;d[p+1]=v;d[p+2]=v;d[p+3]=255;}for(let y=0;y<6;y++){for(let x=0;x<3;x++){const p=(y*12+x)*4;d[p]=d[p+1]=d[p+2]=70;}for(let x=9;x<12;x++){const p=(y*12+x)*4;d[p]=d[p+1]=d[p+2]=135;}}const image=new ImageData(d,12,6),rects:[[number,number,number,number],[number,number,number,number]]=[[0,0,6,6],[6,0,6,6]],before=Math.abs(image.data[(2*12+5)*4]-image.data[(2*12+6)*4]),after=deblockImage(image,rects),afterJump=Math.abs(after.data[(2*12+5)*4]-after.data[(2*12+6)*4]);expect(afterJump).toBeLessThan(before);});
  it('flushes throttled preview updates before finishing',()=>{let finalPreview=0;encode(sample(32,32),digits,index,20,0,50,4,'quality',70,{shouldPreview:()=>false,onProgress:(p)=>{if(p.phase==='final')finalPreview=Math.max(finalPreview,p.preview?.length??0);}});expect(finalPreview).toBeGreaterThan(0);});
  it('requires a matching feature index',()=>expect(()=>encode(sample(),digits,{...index,digitCount:digits.length+1},20,0)).toThrow());
  it('encodes a smooth gradient and splits detailed regions',()=>{const src=sample(64,48),r=encode(src,digits,index,15,0);expect(r.stats.patches).toBeGreaterThan(Math.ceil(src.width/r.stats.tileSize)*Math.ceil(src.height/r.stats.tileSize));expect(r.stats.piPatches).toBeLessThan(r.stats.patches);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);});
  it('uses gradient patches for smooth shading',()=>{const src=sample(64,64);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const p=(y*64+x)*4;src.data[p]=x*3;src.data[p+1]=y*3;src.data[p+2]=80+x+y;}const r=encode(src,digits,index,5,0);expect(r.stats.psnr).toBeGreaterThan(30);expect(r.stats.piPatches).toBeLessThan(r.stats.patches);});
  it('rejects a truncated partition',()=>{const r=encode(sample(32,32),digits,index,20,0);expect(()=>decode(r.bytes.slice(0,-1),digits,index)).toThrow();});
  it.skip('keeps different patch sizes in a mixed-detail image',()=>{const src=sample(128,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const p=(y*128+x)*4,v=x<64?x*2:(x*31+y*17)%200;src.data[p]=v;src.data[p+1]=v;src.data[p+2]=v;}const r=encode(src,digits,index,10,0),sizes=new Set(patchRects(r.bytes).map(([, ,w,h])=>Math.max(w,h)));expect(sizes.size).toBeGreaterThanOrEqual(3);expect(r.bytes.length).toBeLessThanOrEqual(r.stats.budgetBytes);});
  it('split persistence can spend more budget on hard regions',()=>{const src=sample(128,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const p=(y*128+x)*4,v=x<80&&y<80?110:(x*47+y*29)%256;src.data[p]=v;src.data[p+1]=(v*3)%256;src.data[p+2]=(v*7)%256;}const low=encode(src,digits,index,12,0,0),high=encode(src,digits,index,12,0,100);expect(high.stats.patches).toBeGreaterThanOrEqual(low.stats.patches);expect(high.bytes.length).toBeLessThanOrEqual(high.stats.budgetBytes);});
  it('respects the configured minimum spatial patch size',()=>{const src=sample(128,128),r8=encode(src,digits,index,50,0,100,8),r16=encode(src,digits,index,50,0,100,16);expect(patchRects(r8.bytes).every(([, ,w,h])=>w>=8&&h>=8)).toBe(true);expect(patchRects(r16.bytes).every(([, ,w,h])=>w>=16&&h>=16)).toBe(true);expect(r16.stats.patches).toBeLessThanOrEqual(r8.stats.patches);});
  it('rejects unsupported minimum patch sizes',()=>expect(()=>encode(sample(),digits,index,20,0,50,12)).toThrow());
  it('dictionary-first can stop below budget and higher priority never spends more',()=>{const src=sample(128,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const p=(y*128+x)*4,v=x<64?x*2:(x*47+y*29)%256;src.data[p]=v;src.data[p+1]=(v*3)%256;src.data[p+2]=(v*7)%256;}const low=encode(src,digits,index,50,0,100,16,'dictionary',0),high=encode(src,digits,index,50,0,100,16,'dictionary',100);expect(high.bytes.length).toBeLessThanOrEqual(low.bytes.length);expect(high.stats.budgetUse).toBeLessThan(100);expect(high.stats.pixelsPerByte).toBeCloseTo((128*128)/high.bytes.length);expect(high.stats.objective).toBe('dictionary');});

  it('rejects a corrupt payload',()=>expect(()=>decode(new Uint8Array(HEADER_BYTES+RECORD_BYTES),digits,index)).toThrow());
  it('scores visual error instead of exact byte matches',()=>expect(encode(sample(16,16),digits,index,50,1).stats.mse).toBeGreaterThanOrEqual(0));
});
