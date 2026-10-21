'use strict';
// v2: same /sync JSON API, durable Postgres option, version polling and optimistic per-panel revisions.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 10000);
const TEAM_KEY = process.env.TEAM_KEY;
const MAX = 2000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'panels-data.json');
if (!TEAM_KEY) { console.error('TEAM_KEY must be configured'); process.exit(1); }
const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const validNum = n => typeof n === 'number' && Number.isFinite(n);
function panelId(p) { return [p.x,p.y,p.z].map(n => Math.round(n*2)/2).join(':'); }
function validatePanel(p) {
  if (!p || ![p.x,p.y,p.z].every(v => validNum(v) && Math.abs(v)<=100000)) return 'invalid coordinates';
  if (has(p,'finishAt') && (!validNum(p.finishAt) || p.finishAt<0)) return 'invalid finishAt';
  if (has(p,'repairs') && (!Number.isSafeInteger(p.repairs) || p.repairs<0)) return 'invalid repairs';
  if (has(p,'executeId') && (!Number.isSafeInteger(p.executeId) || p.executeId<0)) return 'invalid executeId';
  if (has(p,'repairedSlot') && p.repairedSlot !== null && (typeof p.repairedSlot !== 'string' || !(p.repairedSlot==='' || /^\d{8}-\d{2}$/.test(p.repairedSlot)))) return 'invalid repairedSlot';
  if (has(p,'baseRevision') && (!Number.isSafeInteger(p.baseRevision) || p.baseRevision<0)) return 'invalid baseRevision';
  return null;
}
function mergePanel(existing, input) {
  const old = existing || {};
  const result = {...old, id: panelId(input), x: input.x, y:input.y, z:input.z, updatedAt:Date.now(), revision:(old.revision||0)+1};
  for (const field of ['finishAt','repairs','executeId','repairedSlot']) if(has(input,field)) result[field]=input[field];
  return result;
}
function keyValid(candidate) {
  if (typeof candidate !== 'string') return false;
  const a=Buffer.from(candidate), b=Buffer.from(TEAM_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function reply(res,code,payload) { res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(payload)); }
function readJSON(req) {
  return new Promise((resolve,reject)=>{
    let body='', length=0, finished=false;
    req.on('data',chunk=>{ if(finished)return; length+=chunk.length;
      if(length>5000000){finished=true;reject(new Error('request too large'));req.destroy();return;}
      body+=chunk.toString('utf8');
    });
    req.on('end',()=>{if(finished)return;try{resolve(JSON.parse(body))}catch(e){reject(e)}});
    req.on('error',e=>{if(!finished){finished=true;reject(e)}});
  });
}
class FileStorage {
  constructor() { this.panels=new Map(); this.version=0; this.mode='FILE / EPHEMERAL ON RENDER FREE'; }
  async init(){
    try { if(fs.existsSync(DATA_FILE)) {
      const value=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const arr=Array.isArray(value)?value:value.panels;
      this.version=Number.isSafeInteger(value.version)?value.version:0;
      if(Array.isArray(arr)) for(const p of arr) if(p && typeof p.id==='string' && this.panels.size<MAX) this.panels.set(p.id,p);
    }} catch(e){ throw Error('Cannot restore '+DATA_FILE+': '+e.message); }
    console.warn('NO DATABASE_URL: FILE STORAGE ONLY. Render free filesystem IS NOT durable after redeploy/restart.');
  }
  persist(next,version){
    fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
    const tmp=DATA_FILE+'.'+process.pid+'.tmp';
    try {fs.writeFileSync(tmp,JSON.stringify({version,panels:[...next.values()]}));fs.renameSync(tmp,DATA_FILE)}
    finally {try{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}catch(_) {}}
  }
  async poll(){return {version:this.version,count:this.panels.size};}
  async pull(){return {...await this.poll(),panels:[...this.panels.values()]};}
  async save(p){
    const id=panelId(p), old=this.panels.get(id);
    if(has(p,'baseRevision') && p.baseRevision !== (old?.revision||0)) return {conflict:true,panel:old||null,version:this.version};
    if(!old && this.panels.size>=MAX) return {error:'panel limit reached'};
    const record=mergePanel(old,p), next=new Map(this.panels); next.set(id,record);
    this.persist(next,this.version+1); this.panels=next; this.version++;
    return {panel:record,version:this.version};
  }
  async remove(id){const next=new Map(this.panels);const removed=next.delete(id);
    if(removed){this.persist(next,this.version+1);this.panels=next;this.version++;}
    return {removed,version:this.version};}
  async clear(){const next=new Map(); this.persist(next,this.version+1);this.panels=next;this.version++;return {version:this.version};}
  async restore(arr){
    const next=new Map(this.panels);let imported=0;
    for(const p of arr){if(validatePanel(p))throw Error('invalid imported panel');const id=panelId(p);
      if(!next.has(id)){if(next.size>=MAX)throw Error('panel limit reached');next.set(id,mergePanel(null,p));imported++;}
    }
    if(imported){this.persist(next,this.version+1);this.panels=next;this.version++;}
    return {imported,version:this.version};
  }
}
class PostgresStorage {
  constructor(){ const {Pool}=require('pg'); this.pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});this.mode='POSTGRES / DURABLE'; }
  async init(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS solar_sync_meta (id integer primary key CHECK (id=1), version bigint NOT NULL DEFAULT 0)`);
    await this.pool.query(`INSERT INTO solar_sync_meta(id,version) VALUES(1,0) ON CONFLICT(id) DO NOTHING`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS solar_sync_panels (id text primary key, data jsonb NOT NULL)`);
    console.log('PostgreSQL storage active');
  }
  async poll(){const [m,n]=await Promise.all([
    this.pool.query('SELECT version FROM solar_sync_meta WHERE id=1'),
    this.pool.query('SELECT COUNT(*)::int AS n FROM solar_sync_panels')]);
    return {version:Number(m.rows[0].version),count:n.rows[0].n};}
  async pull(){
    // Both values come from one PostgreSQL statement snapshot, so a concurrent
    // teammate save cannot yield a new version with an old panel array.
    const r=await this.pool.query(`SELECT
      (SELECT version FROM solar_sync_meta WHERE id=1) AS version,
      (SELECT COALESCE(jsonb_agg(data ORDER BY id), '[]'::jsonb)
         FROM solar_sync_panels) AS panels`);
    const panels=r.rows[0].panels;
    return {version:Number(r.rows[0].version),count:panels.length,panels};
  }
  async transaction(fn){
    const c=await this.pool.connect();try{
      await c.query('BEGIN');const v=await c.query('SELECT version FROM solar_sync_meta WHERE id=1 FOR UPDATE');
      const version=Number(v.rows[0].version);const result=await fn(c,version);
      if(result.bump)await c.query('UPDATE solar_sync_meta SET version=version+1 WHERE id=1');
      await c.query('COMMIT');return {...result,version:version+(result.bump?1:0)};
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }
  async save(p){return this.transaction(async(c,version)=>{
    const id=panelId(p);const got=await c.query('SELECT data FROM solar_sync_panels WHERE id=$1',[id]);
    const old=got.rows[0]?.data||null;
    if(has(p,'baseRevision') && p.baseRevision !== (old?.revision||0))return {conflict:true,panel:old,version,bump:false};
    if(!old){const n=await c.query('SELECT COUNT(*)::int AS n FROM solar_sync_panels');
      if(n.rows[0].n>=MAX)return {error:'panel limit reached',bump:false};}
    const panel=mergePanel(old,p);
    await c.query('INSERT INTO solar_sync_panels (id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[id,JSON.stringify(panel)]);
    return {panel,bump:true};
  });}
  async remove(id){return this.transaction(async(c)=>{
    const r=await c.query('DELETE FROM solar_sync_panels WHERE id=$1',[id]);
    return {removed:r.rowCount>0,bump:r.rowCount>0};
  });}
  async clear(){return this.transaction(async(c)=>{await c.query('DELETE FROM solar_sync_panels');return {bump:true};});}
  async restore(arr){return this.transaction(async(c)=>{
    let imported=0;const n=await c.query('SELECT COUNT(*)::int AS n FROM solar_sync_panels');let count=n.rows[0].n;
    for(const p of arr){if(validatePanel(p))throw Error('invalid imported panel');const id=panelId(p);
      if(count>=MAX && !await c.query('SELECT 1 FROM solar_sync_panels WHERE id=$1',[id]).then(r=>r.rowCount>0))throw Error('panel limit reached');
      const panel=mergePanel(null,p);
      const r=await c.query('INSERT INTO solar_sync_panels(id,data) VALUES($1,$2::jsonb) ON CONFLICT (id) DO NOTHING',[id,JSON.stringify(panel)]);
      if(r.rowCount){imported++;count++;}
    }
    return {imported,bump:imported>0};
  });}
}
let storage;
async function handle(req,res){
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && url.pathname==='/health'){
    const s=await storage.poll();return reply(res,200,{ok:true,...s,storage:storage.mode,durable:storage instanceof PostgresStorage});
  }
  let body={};
  if(req.method==='POST'){try{body=await readJSON(req)}catch(e){return reply(res,400,{ok:false,error:e.message})}}
  if(url.pathname==='/sync' && req.method==='POST'){
    if(!body || !keyValid(body.key))return reply(res,401,{ok:false,error:'unauthorized'});
    if(body.action==='ping')return reply(res,200,{ok:true,now:Date.now(),mode:'body-key',storage:storage.mode});
    if(body.action==='poll')return reply(res,200,{ok:true,...await storage.poll(),now:Date.now()});
    if(body.action==='pull')return reply(res,200,{ok:true,...await storage.pull(),now:Date.now()});
    if(body.action==='push')return save(body.panel,res);
    if(body.action==='remove')return remove(body.id,res);
    if(body.action==='restore')return restore(body.panels,res);
    return reply(res,400,{ok:false,error:'unknown action'});
  }
  if(!keyValid(req.headers['x-team-key']))return reply(res,401,{ok:false,error:'unauthorized'});
  if(url.pathname==='/panels' && req.method==='GET')return reply(res,200,{...await storage.pull(),now:Date.now()});
  if(url.pathname==='/panels' && req.method==='POST')return save(body?.panel,res);
  if(url.pathname==='/panels' && req.method==='DELETE') return reply(res,405,{ok:false,error:'bulk delete disabled for data safety'});
  if(url.pathname==='/panels/remove' && req.method==='POST')return remove(body?.id,res);
  return reply(res,404,{ok:false,error:'not found'});
}
async function save(p,res){
  const error=validatePanel(p);if(error)return reply(res,400,{ok:false,error});
  const result=await storage.save(p);
  if(result.conflict)return reply(res,409,{ok:false,error:'revision conflict',panel:result.panel,version:result.version});
  if(result.error)return reply(res,413,{ok:false,error:result.error});
  return reply(res,200,{ok:true,panel:result.panel,version:result.version});
}
async function remove(id,res){
  if(typeof id!=='string'||!/^[-\d.:]+$/.test(id)||id.length>100)return reply(res,400,{ok:false,error:'invalid id'});
  const result=await storage.remove(id);return reply(res,200,{ok:true,...result});
}
async function restore(items,res){
  if(!Array.isArray(items) || items.length>MAX)return reply(res,400,{ok:false,error:'invalid panels array'});
  const result=await storage.restore(items);return reply(res,200,{ok:true,...result});
}
async function main(){
  if(!process.env.DATABASE_URL && process.env.ALLOW_EPHEMERAL !== 'true') {
    throw Error('DATABASE_URL required for permanent storage (set ALLOW_EPHEMERAL=true ONLY for local testing)');
  }
  storage=process.env.DATABASE_URL?new PostgresStorage():new FileStorage();
  await storage.init();
  http.createServer((req,res)=>{handle(req,res).catch(e=>{
    console.error('SYNC REQUEST FAILED:',e.message);
    if(!res.headersSent)reply(res,500,{ok:false,error:'storage unavailable'});
    else res.destroy();
  })}).listen(PORT,'0.0.0.0',()=>console.log('Panel sync v2 listening on '+PORT));
}
main().catch(e=>{console.error('CANNOT START STORAGE:',e.message);process.exit(1)});
