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
    left1=Math.abs(yp1-yp0),right1=Math.abs(yq1-yq0),
    left2=Math.abs(yp2-yp1),right2=Math.abs(yq2-yq1),
    local=(left1+right1)*.55+(left2+right2)*.2;

  // Known patch boundaries let us be more permissive than a generic blur.
  // Preserve very strong edges, but smooth a seam when the boundary jump
  // is noticeably larger than the local texture activity on either side.
  if(jump<4||jump>112)return;
  const excess=jump-local*.82;
  if(excess<3)return;

  const edgeProtection=clamp((112-jump)/72,.18,1),
    confidence=clamp((excess-3)/34,0,1),
    amount=strength*(.28+.72*confidence)*edgeProtection,
    limit=6+18*confidence;

  for(let ch=0;ch<3;ch++){
    const a=data[p0+ch],b=data[q0+ch],
      inward=(data[p1+ch]-data[q1+ch])*.18,
      delta=clamp((b-a)*.42+inward,-limit,limit)*amount;
    data[p0+ch]=Math.round(a+delta);
    data[q0+ch]=Math.round(b-delta);

    const quiet=Math.max(left1,right1)<34&&Math.max(left2,right2)<30;
    if(quiet){
      const outer=delta*.28;
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

export function deblockImage(source:ImageData,rects:PatchRect[],strength=.9){
  const image=new ImageData(new Uint8ClampedArray(source.data),source.width,source.height);
  // Two weak passes are less conspicuous than one aggressive pass and also
  // catch T-junctions after their neighboring seam has been softened.
  for(let pass=0;pass<2;pass++){
    const passStrength=strength*(pass===0?.72:.42);
    for(const [x,y,w,h] of rects){
      if(x+w<image.width)filterVertical(image,x+w,y,y+h,passStrength);
      if(y+h<image.height)filterHorizontal(image,y+h,x,x+w,passStrength);
    }
  }
  return image;
}
