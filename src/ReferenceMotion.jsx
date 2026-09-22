import React,{useEffect,useRef} from 'react';
import {animate,stagger,splitText,createAnimatable,createTimeline,onScroll} from 'animejs';
import './reference-motion.css';
export function Reveal({children,className=''}){
 const ref=useRef();
 useEffect(()=>{
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const heading=ref.current.querySelector('h1,h2,h3');if(!heading)return;
  const split=splitText(heading,{words:true});
  const covers=split.words.map(word=>{word.style.position='relative';const cover=document.createElement('i');cover.className='reference-word-cover';word.append(cover);return cover;});
  let motion;const io=new IntersectionObserver(([entry])=>{if(!entry.isIntersecting)return;motion=animate(covers,{scaleY:0,delay:stagger(100),duration:1000,ease:'inOutExpo',onComplete:()=>covers.forEach(c=>c.remove())});io.disconnect();},{threshold:.5});io.observe(heading);
  return()=>{io.disconnect();motion?.revert();split.revert();};
 },[]);
 return <div ref={ref} className={'n-reveal shown '+className}>{children}</div>;
}
export function useHeroMotion(ref){
 useEffect(()=>{
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const node=ref.current,pills=node.querySelectorAll('.n-pill');
  const entrance=animate(pills,{scale:[0,1],duration:800,delay:500});
  const first=createTimeline({defaults:{ease:'linear'},autoplay:onScroll({target:node,enter:'top top',leave:'top-=50svh top',sync:.5})}).add(node.querySelector('.n-pills'),{y:'50svh',scale:0}).add(node.querySelector('.n-hero-media'),{y:'-5svh'},'<<');
  const second=createTimeline({defaults:{ease:'linear'},autoplay:onScroll({target:node,enter:'bottom bottom',leave:'center bottom',sync:.5})});
  if(matchMedia('(min-width:940px)').matches)second.add(node.querySelector('.n-hero-content'),{y:'-20%'}).add(node.querySelector('.n-hero-media'),{translate:'0 -50svh'},'<<');
  const fg=createAnimatable(pills,{x:1200,y:1200}),bg=createAnimatable(node.querySelector('.n-blurs'),{x:1200,y:1200});
  const move=e=>{if(!matchMedia('(min-width:940px) and (hover:hover)').matches)return;const x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;fg.x(-x*25);fg.y(-y*25);bg.x(-x*50);bg.y(-y*50);};
  const leave=()=>{fg.x(0);fg.y(0);bg.x(0);bg.y(0);};node.addEventListener('pointermove',move);node.addEventListener('pointerleave',leave);
  return()=>{first.revert();second.revert();entrance.revert();fg.revert();bg.revert();node.removeEventListener('pointermove',move);node.removeEventListener('pointerleave',leave);};
 },[]);
}
export function useClosingMotion(){
 const ref=useRef();useEffect(()=>{const node=ref.current;if(!node||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const io=new IntersectionObserver(([e])=>node.classList.toggle('closing-visible',e.isIntersecting),{threshold:.15});io.observe(node);return()=>io.disconnect();},[]);return ref;
}
