'use strict';
const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 10000);
const TEAM_KEY = process.env.TEAM_KEY;
if (!TEAM_KEY) { console.error('Missing TEAM_KEY environment variable'); process.exit(1); }
const panels = new Map();
const MAX = 2000;
function reply(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(payload));}
function allowed(req){const a=Buffer.from(String(req.headers['x-team-key']||''));const b=Buffer.from(TEAM_KEY);return a.length===b.length && crypto.timingSafeEqual(a,b);}
function readJSON(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>200000){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(s))}catch(e){reject(e)}});req.on('error',reject);});}
function idOf(p){return [p.x,p.y,p.z].map(v=>Math.round(v*2)/2).join(':');}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/health'){return reply(res,200,{ok:true,panels:panels.size});}
 if(!allowed(req))return reply(res,401,{error:'unauthorized'});
 if(url.pathname==='/panels'&&req.method==='GET')return reply(res,200,{panels:[...panels.values()],count:panels.size,now:Date.now()});
 if(url.pathname==='/panels'&&req.method==='POST'){
  try{const body=await readJSON(req);const p=body.panel;
   if(!p||![p.x,p.y,p.z].every(v=>typeof v==='number'&&Number.isFinite(v))||Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z))>100000)return reply(res,400,{error:'invalid panel coordinates'});
   const id=idOf(p);if(!panels.has(id)&&panels.size>=MAX)return reply(res,413,{error:'panel limit reached'});
   const existing=panels.get(id)||{};
   const record={...existing,id,x:p.x,y:p.y,z:p.z,updatedAt:Date.now()};
   if(typeof p.finishAt==='number'&&Number.isFinite(p.finishAt))record.finishAt=p.finishAt;
   if(typeof p.repairs==='number'&&Number.isInteger(p.repairs)&&p.repairs>=0)record.repairs=p.repairs;
   panels.set(id,record);return reply(res,200,{ok:true,panel:record});
  }catch(e){return reply(res,400,{error:'invalid JSON'});}
 }
 if(url.pathname==='/panels'&&req.method==='DELETE'){panels.clear();return reply(res,200,{ok:true,count:0});}
 if(url.pathname==='/panels/remove'&&req.method==='POST'){
  try{const body=await readJSON(req);if(typeof body.id!=='string')return reply(res,400,{error:'missing id'});return reply(res,200,{ok:true,removed:panels.delete(body.id)});}catch(e){return reply(res,400,{error:'invalid JSON'});}
 }
 return reply(res,404,{error:'not found'});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Panel sync listening on ${PORT}`));
