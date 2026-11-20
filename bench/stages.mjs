import { serialize, deserialize } from "../src/binary.js";
import { toBase77, fromBase77, toBase64url, fromBase64url } from "../src/text.js";
import { deflateSync, inflateSync } from "fflate";
let seed=42;const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
const c=["Rome","Milan","Paris","Berlin","Madrid","London","Lisbon","Vienna"];let t=0,p=100;
const table=Array.from({length:100000},(_,i)=>{t+=60000+((rnd()*5000)|0);p=Math.round((p+(rnd()-.5)*2)*100)/100;return{id:i+1,ts:t,city:c[(rnd()*8)|0],price:p,qty:(rnd()*50)|0,ok:rnd()>.3}});
const sensors=Array.from({length:10000},(_,i)=>({sensor:"s"+(i%20),lat:41.9+rnd()/100,lon:12.5+rnd()/100,temp:20+Math.sin(i/50)*5+rnd()}));
const med=(f)=>{const ts=[];let o;for(let i=0;i<15;i++){const a=performance.now();o=f();ts.push(performance.now()-a)}ts.sort((a,b)=>a-b);return [o,ts[7]]};
for (const [name,d] of [["table100k",table],["sensors10k",sensors]]) {
 const [raw,a]=med(()=>serialize(d)); const [z,b]=med(()=>deflateSync(raw,{level:6}));
 const [s77,c1]=med(()=>toBase77(z)); const [,c2]=med(()=>toBase64url(z));
 const [,e1]=med(()=>fromBase77(s77)); const [,e2]=med(()=>inflateSync(z)); const [,e3]=med(()=>deserialize(raw));
 console.log(name,`raw ${(raw.length/1024)|0}KB z ${(z.length/1024)|0}KB | ENC serialize ${a.toFixed(1)} deflate ${b.toFixed(1)} b77 ${c1.toFixed(1)} b64 ${c2.toFixed(2)} | DEC b77 ${e1.toFixed(1)} inflate ${e2.toFixed(1)} deserialize ${e3.toFixed(1)}`);
}
