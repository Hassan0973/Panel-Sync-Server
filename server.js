'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 10000);
const TEAM_KEY = process.env.TEAM_KEY;
if (!TEAM_KEY) { console.error('Missing TEAM_KEY environment variable'); process.exit(1); }
const panels = new Map();
const MAX = 2000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'panels-data.json');
function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify([...panels.values()]));
    fs.renameSync(temp, DATA_FILE);
  } catch (e) { console.error('PERSIST FAILED:', e.message); }
}
try {
  if (fs.existsSync(DATA_FILE)) {
    const items = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(items)) for (const p of items) {
      if (p && typeof p.id === 'string' && panels.size < MAX) panels.set(p.id,p);
    }
  }
} catch (e) { console.error('RESTORE FAILED:', e.message); }

function reply(res, status, payload) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
  res.end(JSON.stringify(payload));
}
function keyValid(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate), b = Buffer.from(TEAM_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function allowed(req) { return keyValid(req.headers['x-team-key']); }
function readJSON(req) {
  return new Promise((resolve,reject) => {
    let s = ''; let finished = false;
    req.on('data', chunk => {
      if (finished) return;
      s += chunk;
      if (s.length > 200000) { finished = true; reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (finished) return;
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on('error', e => { if (!finished) reject(e); });
  });
}
function idOf(p) { return [p.x,p.y,p.z].map(v => Math.round(v*2)/2).join(':'); }
function savePanel(p, res) {
  if (!p || ![p.x,p.y,p.z].every(v => typeof v === 'number' && Number.isFinite(v)) ||
      Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z)) > 100000)
    return reply(res,400,{error:'invalid panel coordinates'});
  const id = idOf(p);
  if (!panels.has(id) && panels.size >= MAX) return reply(res,413,{error:'panel limit reached'});
  const existing = panels.get(id) || {};
  const record = {...existing, id, x:p.x, y:p.y, z:p.z, updatedAt:Date.now()};
  if (typeof p.finishAt === 'number' && Number.isFinite(p.finishAt)) record.finishAt = p.finishAt;
  if (typeof p.repairs === 'number' && Number.isInteger(p.repairs) && p.repairs >= 0) record.repairs = p.repairs;
  // Preserve existing Execute ID when older clients omit it.
  if (Object.prototype.hasOwnProperty.call(p, 'executeId')) {
    if (!Number.isSafeInteger(p.executeId) || p.executeId < 0) return reply(res,400,{error:'invalid executeId'});
    record.executeId = p.executeId;
  }
  panels.set(id,record);
  persist();
  return reply(res,200,{ok:true,panel:record});
}
const server = http.createServer(async(req,res) => {
  const url = new URL(req.url,'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health')
    return reply(res,200,{ok:true,panels:panels.size});

  // Susano can POST a JSON string but its custom-header support is unconfirmed.
  // Keep the original header-authenticated routes unchanged for other clients.
  if (url.pathname === '/sync' && req.method === 'POST') {
    let body;
    try { body = await readJSON(req); } catch (e) { return reply(res,400,{error:'invalid JSON'}); }
    if (!body || !keyValid(body.key)) return reply(res,401,{error:'unauthorized'});
    if (body.action === 'ping') return reply(res,200,{ok:true,mode:'body-key',now:Date.now()});
    if (body.action === 'pull') return reply(res,200,{ok:true,panels:[...panels.values()],count:panels.size,now:Date.now()});
    if (body.action === 'push') return savePanel(body.panel,res);
    if (body.action === 'remove') {
      if (typeof body.id !== 'string') return reply(res,400,{error:'missing id'});
      const removed = panels.delete(body.id); if (removed) persist();
      return reply(res,200,{ok:true,removed});
    }
    return reply(res,400,{error:'unknown action'});
  }
  if (!allowed(req)) return reply(res,401,{error:'unauthorized'});
  if (url.pathname === '/panels' && req.method === 'GET')
    return reply(res,200,{panels:[...panels.values()],count:panels.size,now:Date.now()});
  if (url.pathname === '/panels' && req.method === 'POST') {
    let body;
    try { body = await readJSON(req); } catch (e) { return reply(res,400,{error:'invalid JSON'}); }
    return savePanel(body && body.panel,res);
  }
  if (url.pathname === '/panels' && req.method === 'DELETE') {
    panels.clear(); persist(); return reply(res,200,{ok:true,count:0});
  }
  if (url.pathname === '/panels/remove' && req.method === 'POST') {
    let body;
    try { body = await readJSON(req); } catch (e) { return reply(res,400,{error:'invalid JSON'}); }
    if (typeof body.id !== 'string') return reply(res,400,{error:'missing id'});
    const removed = panels.delete(body.id); if (removed) persist();
    return reply(res,200,{ok:true,removed});
  }
  return reply(res,404,{error:'not found'});
});
server.listen(PORT,'0.0.0.0',() => console.log(`Panel sync listening on ${PORT}`));
