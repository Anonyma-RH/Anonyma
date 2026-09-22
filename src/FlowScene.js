import * as THREE from 'three';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import wasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url';
DotLottie.setWasmUrl(wasmUrl);

const clamp=(v)=>Math.max(0,Math.min(1,v));
const labels=[['Model catalog','Your capabilities','One workspace'],['Shared credits','Usage receipts','Credit lifecycle'],['Conversations','Code workspace','Image studio','Generation checks'],['Saved conversations','Your library','Activity history']];
const colors=['#ffb21c','#adc6ff','#dbe5ff','#ffcc69'];
function panel(stage,index){
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=stage===1&&index===0?720:510;
 const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
 ctx.fillStyle='#082674';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#6181c2';ctx.lineWidth=2;
 ctx.font='500 34px Retorika, sans-serif';ctx.fillStyle='#f5f7ff';ctx.fillText(labels[stage][index],40,64);
 ctx.fillStyle='#aac0ee';ctx.font='23px Retorika, sans-serif';ctx.fillText('ANONYMA / PRODUCT PREVIEW',40,h-28);
 const accent=colors[stage];
 if(stage===0){
  const rows=index===0?['OpenAI','Anthropic','Google','DeepSeek']:['Chat & reasoning','Code generation','Images','Video'];
  rows.forEach((label,i)=>{const y=104+i*79;ctx.strokeRect(36,y,w-72,65);ctx.fillStyle=accent;ctx.fillRect(54,y+20,24,24);ctx.fillStyle='#fff';ctx.font='28px Retorika, sans-serif';ctx.fillText(label,98,y+43);ctx.fillStyle='#b5c7ee';ctx.font='20px Retorika, sans-serif';ctx.fillText(index===0?'Catalog':'Workflow',w-150,y+41)});
 }else if(stage===1&&index===0){
  ctx.fillStyle='#fff';ctx.font='92px Retorika, sans-serif';ctx.fillText('1,000',42,204);ctx.font='26px Retorika, sans-serif';ctx.fillStyle='#b5c7ee';ctx.fillText('Sample credits',45,251);
  [0,1,2,3,4,5,6].forEach(i=>{ctx.fillStyle=i===6?accent:'#3454a1';ctx.fillRect(45+i*89,530-[100,135,112,180,160,220,260][i],56,[100,135,112,180,160,220,260][i]);});
 }else if(stage===1){
  ['Estimated','Reserved','Settled','Available'].forEach((t,i)=>{let y=111+i*77;ctx.strokeRect(36,y,648,58);ctx.fillStyle='#fff';ctx.font='28px Retorika, sans-serif';ctx.fillText(t,55,y+39);ctx.fillStyle=accent;ctx.fillRect(480,y+24,157-i*25,9)});
 }else if(stage===2&&index===1){
  const rows=['const workspace = new Anonyma();','const response = await workspace.chat({','  model: selectedModel,','  messages: conversation','});'];ctx.font='22px monospace';rows.forEach((t,i)=>{ctx.fillStyle=i===0?accent:'#e2eaff';ctx.fillText(t,38,130+i*58)});
 }else if(stage===2&&index===2){
  ctx.strokeRect(38,100,644,332);ctx.fillStyle='#325bb5';ctx.beginPath();ctx.moveTo(39,431);ctx.lineTo(214,172);ctx.lineTo(354,354);ctx.lineTo(467,204);ctx.lineTo(681,431);ctx.fill();ctx.fillStyle=accent;ctx.beginPath();ctx.arc(545,174,31,0,Math.PI*2);ctx.fill();
 }else{
  const rows=stage===2?['Your prompt','Thinking through your idea','A response, ready to refine']:index===0?['Plan a product launch','Explore a new direction','Compare model responses']:['Visual explorations','Saved for your next idea','Private workspace'];
  rows.forEach((t,i)=>{const y=107+i*96;ctx.fillStyle=i===0?'#264b9d':'#183780';ctx.fillRect(36,y,648-i*24,72);ctx.fillStyle=i===0?accent:'#fff';ctx.font='27px Retorika, sans-serif';ctx.fillText(t,57,y+44)});
 }
 return canvas;
}

// Geometry, camera, z range and stage windows follow the inspected reference scene.
export function createFlowScene(canvas,center,progress){
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});renderer.setClearAlpha(0);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1,.1,2000);const groups=[],resources=[],players=[];let closed=false;
 const points3=[[[-1.25,1,0],[1,.5,-.5],[-.75,-.75,.5]],[[0,1,0],[-1.25,-1,-.5],[1,-.75,.5]]];
 const points4=[[-.75,1,.5],[1.25,.75,-.25],[-1.25,-.75,-.5],[.75,-1,1]];
 for(let stage=0;stage<4;stage++){
  const group=new THREE.Group();scene.add(group);groups.push(group);const count=stage===2?4:3;const points=count===4?points4:points3[stage%2];
  for(let i=0;i<count;i++){
   const animated=i===count-1;const ratio=animated?[2,1,720/510,2][stage]:(stage===1&&i===0?1:240/170);
   const w=ratio>=1?1.5:1.5*ratio,h=ratio>=1?1.5/ratio:1.5;
   const [x,y,z]=points[i],distance=Math.hypot(x,y),ux=x/distance,uy=y/distance;
   const adjusted=(distance+Math.abs(ux)*w/2+Math.abs(uy)*h/2-.75)*Math.hypot(w/2,h/2)/Math.hypot(.75,.75);
   const object=new THREE.Group();object.position.set(ux*adjusted,uy*adjusted,z);group.add(object);
   const geometry=new THREE.BoxGeometry(w,h,1.5),material=new THREE.MeshBasicMaterial({color:'#0135df',transparent:true,polygonOffset:true,polygonOffsetFactor:2,polygonOffsetUnits:2});
   object.add(new THREE.Mesh(geometry,material));const edges=new THREE.EdgesGeometry(geometry),line=new THREE.LineBasicMaterial({color:'#7697e2',transparent:true});object.add(new THREE.LineSegments(edges,line));
   let source=panel(stage,i),player=null;
   if(animated){
    source=document.createElement('canvas');source.width=720;source.height=Math.round(720/ratio);
    player=new DotLottie({canvas:source,src:`/media/flow/${stage}-motion.json`,autoplay:false,loop:false,renderConfig:{autoResize:false,devicePixelRatio:1,freezeOnOffscreen:false}});
    players.push({player,stage,started:false,ready:false});const record=players[players.length-1];player.addEventListener('load',()=>{record.ready=true;});
   }
   const texture=new THREE.CanvasTexture(source);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=renderer.capabilities.getMaxAnisotropy();
   if(player)player.addEventListener('render',()=>{texture.needsUpdate=true});
   const faceGeometry=new THREE.PlaneGeometry(w,h),faceMaterial=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false});const face=new THREE.Mesh(faceGeometry,faceMaterial);face.position.z=.751;object.add(face);
   resources.push(geometry,material,edges,line,faceGeometry,faceMaterial,texture);
  }
 }
 function resize(){const {width,height}=canvas.parentElement.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();const r=center.getBoundingClientRect(),c=canvas.getBoundingClientRect();camera.setViewOffset(width,height,0,c.top+height/2-r.top-r.height/2,width,height);}
 const observer=new ResizeObserver(resize);observer.observe(canvas.parentElement);resize();
 return {render(){if(closed)return;const p=progress.value;
  groups.forEach((g,i)=>{const start=i*.2,end=(i+2)*.2;g.visible=p>=start&&p<end&&p<1;if(!g.visible)return;let f,opacity;if(p<(i+1)*.2){f=(p-start)/.2;g.scale.setScalar(f);g.position.z=-8;opacity=clamp((f-.2)/.2);}else{f=clamp((p-(i+1)*.2)/.2);g.scale.setScalar(1-f);g.position.z=-8+16*f;opacity=1;}g.traverse(o=>{if(o.material)o.material.opacity=opacity});});
  players.forEach(r=>{const start=r.stage*.2+.04,active=p>=start&&p<(r.stage+2)*.2&&p<1;if(r.ready&&active&&!r.started){r.player.setFrame(0);r.player.play();r.started=true;}else if(!active&&r.started){r.player.pause();r.started=false;}});renderer.render(scene,camera);
 },dispose(){closed=true;observer.disconnect();players.forEach(r=>r.player.destroy());resources.forEach(r=>r.dispose());renderer.dispose();},pause(){players.forEach(r=>{r.player.pause();r.started=false;});}};
}
