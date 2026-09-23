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
    local=(left1+right1)*.5+(left2+right2)*.18;

  if(jump<4||jump>116)return;
  const excess=jump-local*.78;
  if(excess<2.5)return;

  const confidence=clamp((excess-2.5)/30,0,1),
    edgeProtection=clamp((116-jump)/74,.2,1),
    amount=strength*(.32+.68*confidence)*edgeProtection,
    limit=7+20*confidence,
    weights=[.18,.46,.82];

  for(let ch=0;ch<3;ch++){
    const a=data[p0+ch],b=data[q0+ch],
      inward=(data[p1+ch]-data[q1+ch])*.12,
      correction=clamp((b-a)*.48+inward,-limit,limit)*amount;

    const ps=[p2,p1,p0],qs=[q2,q1,q0];
    for(let i=0;i<3;i++){
      const delta=correction*weights[i];
      data[ps[i]+ch]=Math.round(data[ps[i]+ch]+delta);
      data[qs[i]+ch]=Math.round(data[qs[i]+ch]-delta);
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

export function deblockImage(source:ImageData,rects:PatchRect[],strength=1){
  const image=new ImageData(new Uint8ClampedArray(source.data),source.width,source.height);
  // Feather a few pixels across known codec seams. Two moderate passes remove
  // low-frequency block steps without turning the whole image into a blur.
  for(let pass=0;pass<2;pass++){
    const passStrength=strength*(pass===0?.88:.48);
    for(const [x,y,w,h] of rects){
      if(x+w<image.width)filterVertical(image,x+w,y,y+h,passStrength);
      if(y+h<image.height)filterHorizontal(image,y+h,x,x+w,passStrength);
    }
  }
  return image;
}
