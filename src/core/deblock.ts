export type PatchRect = [number, number, number, number];

function clamp(value:number,min:number,max:number){
  return Math.max(min,Math.min(max,value));
}

function luma(data:Uint8ClampedArray,index:number){
  return data[index]*.299+data[index+1]*.587+data[index+2]*.114;
}

function filterSamples(
  data:Uint8ClampedArray,
  p2:number,p1:number,p0:number,q0:number,q1:number,q2:number,
  strength:number,
){
  const yp2=luma(data,p2),yp1=luma(data,p1),yp0=luma(data,p0),
    yq0=luma(data,q0),yq1=luma(data,q1),yq2=luma(data,q2),
    jump=Math.abs(yp0-yq0),
    near=Math.max(Math.abs(yp1-yp0),Math.abs(yq1-yq0)),
    far=Math.max(Math.abs(yp2-yp1),Math.abs(yq2-yq1));

  // Only treat moderate, isolated jumps as likely block seams.
  // Very large jumps are much more likely to be real image edges.
  if(jump<6||jump>72||near>28||far>24)return;
  const artifact=jump-near*1.35-far*.35;
  if(artifact<5)return;
  const amount=clamp((artifact-5)/36,0,1)*strength,
    limit=8+8*amount;

  for(let ch=0;ch<3;ch++){
    const a=data[p0+ch],b=data[q0+ch],
      delta=clamp(((b-a)*4+(data[p1+ch]-data[q1+ch]))/8,-limit,limit)*amount;
    data[p0+ch]=Math.round(a+delta);
    data[q0+ch]=Math.round(b-delta);

    if(near<12&&jump<48){
      const outer=delta*.22;
      data[p1+ch]=Math.round(data[p1+ch]+outer);
      data[q1+ch]=Math.round(data[q1+ch]-outer);
    }
  }
}

function filterVertical(image:ImageData,x:number,y0:number,y1:number,strength:number){
  const {width,height,data}=image;
  if(x<3||x>width-3)return;
  const from=Math.max(0,y0),to=Math.min(height,y1);
  for(let y=from;y<to;y++){
    const row=y*width*4;
    filterSamples(
      data,
      row+(x-3)*4,row+(x-2)*4,row+(x-1)*4,
      row+x*4,row+(x+1)*4,row+(x+2)*4,
      strength,
    );
  }
}

function filterHorizontal(image:ImageData,y:number,x0:number,x1:number,strength:number){
  const {width,height,data}=image;
  if(y<3||y>height-3)return;
  const from=Math.max(0,x0),to=Math.min(width,x1);
  for(let x=from;x<to;x++){
    const column=x*4;
    filterSamples(
      data,
      (y-3)*width*4+column,(y-2)*width*4+column,(y-1)*width*4+column,
      y*width*4+column,(y+1)*width*4+column,(y+2)*width*4+column,
      strength,
    );
  }
}

export function deblockImage(source:ImageData,rects:PatchRect[],strength=.72){
  const image=new ImageData(new Uint8ClampedArray(source.data),source.width,source.height);
  // Right/bottom edges only: every internal seam is visited once, including T junctions.
  for(const [x,y,w,h] of rects){
    if(x+w<image.width)filterVertical(image,x+w,y,y+h,strength);
    if(y+h<image.height)filterHorizontal(image,y+h,x,x+w,strength);
  }
  return image;
}
