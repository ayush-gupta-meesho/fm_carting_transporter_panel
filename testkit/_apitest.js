/* THE MISSING LINK.
   A dispute claim has to survive THREE hops, each of which names its fields independently:
     1. index.html  submitDispute()   -> builds the POST body
     2. api/action.js                 -> copies the body into the queued Upstash action
     3. Actions.gs  applyDispute()    -> writes the action into Disputes_Log
   Hop 2 is an explicit whitelist. A field missing there is dropped SILENTLY: the dispute still lands and
   the trip still flips to Disputed, so it looks like it worked — the claim just arrives blank. That is
   exactly how claim_zonal_amount / claim_rfq_id went missing.

   This file does two things:
     A. a static contract check — the claim_* field sets in all three files must be identical
     B. a live check — actually invoke api/action.js with a stubbed Upstash and assert the queued action
        carries every claim field with the right value
*/
const fs=require('fs'), path=require('path'), Module=require('module');
const HTML   = fs.readFileSync(__dirname+'/../vercel-app/index.html','utf8');
const APIJS  = fs.readFileSync(__dirname+'/../vercel-app/api/action.js','utf8');
const ACTIONS= fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8');

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
const setOf=a=>[...new Set(a)].sort();

/* ── A. static contract ───────────────────────────────────────────────────── */
// what the panel can send: `claim.claim_x = ...` assignments in submitDispute()
const sub = HTML.slice(HTML.indexOf('async function submitDispute'), HTML.indexOf('/* ══════════════ ADMIN VIEW'));
const fromPanel = setOf([...sub.matchAll(/claim\.(claim_[a-z_]+)\s*=/g)].map(m=>m[1]));
// what the API copies into the queued action
// take the whole file and keep only keys that are actually COPIED FROM body (that is what a whitelist is)
const fromApi = setOf([...APIJS.matchAll(/(claim_[a-z_]+)\s*:[^,\n]*body\.\1/g)].map(m=>m[1]));
// what applyDispute writes
const ad = ACTIONS.slice(ACTIONS.indexOf('function applyDispute'), ACTIONS.indexOf('_upsertStatusView({', ACTIONS.indexOf('function applyDispute')));
// keys can share a line, so do not anchor to line start
const fromGs = setOf([...ad.matchAll(/(claim_[a-z_]+)\s*:/g)].map(m=>m[1]));

console.log('── claim_* fields at each hop ──');
console.log('  1 index.html  submitDispute : '+fromPanel.join(', '));
console.log('  2 api/action.js  whitelist  : '+fromApi.join(', '));
console.log('  3 Actions.gs applyDispute   : '+fromGs.join(', '));

const droppedByApi = fromPanel.filter(f=>!fromApi.includes(f));
const droppedByGs  = fromApi.filter(f=>!fromGs.includes(f));
const orphanInApi  = fromApi.filter(f=>!fromPanel.includes(f));
droppedByApi.forEach(f=>console.log('    !! '+f+' is SENT by the panel but not copied by api/action.js — it will arrive blank'));
droppedByGs.forEach(f=>console.log('    !! '+f+' is queued but never written by applyDispute()'));
ck(droppedByApi.length===0,'every claim_* the panel sends is copied by api/action.js'
   +(droppedByApi.length?(' — DROPPED: '+droppedByApi.join(', ')):''));
ck(droppedByGs.length===0,'every queued claim_* is written by applyDispute()'
   +(droppedByGs.length?(' — DROPPED: '+droppedByGs.join(', ')):''));
ck(orphanInApi.length===0,'api/action.js copies nothing the panel cannot send'
   +(orphanInApi.length?(' — orphans: '+orphanInApi.join(', ')):''));
ck(fromApi.includes('claim_zonal_amount'),'claim_zonal_amount is in the API whitelist (the field that went missing)');
ck(fromApi.includes('claim_rfq_id'),'claim_rfq_id is in the API whitelist');

/* ── B. live: actually run api/action.js ──────────────────────────────────── */
const queued=[];
const stubCore={
  rget: async ()=>JSON.stringify({trips:{
    'ZONAL::FM-Zonal-REB-RFQ-0005':[{id:'TR-ZT-0001',status:'pending',scope:'Zonal',billing:'Regular',zamt:5300,rfq:'FM-Zonal-REB-RFQ-0005'}],
    'RJK7-X':[{id:'TR-L-1',status:'pending',scope:'Local',billing:'Regular',km:120}]
  }}),
  rpush: async (k,v)=>{ queued.push(JSON.parse(v)); },
  sessionFromReq: ()=>({oracle:'ORC-4521',email:'v@x',name:'Rajkot Movers Pvt Ltd'}),
  readBody: async req=>req._body
};
// load api/action.js with ../lib/core replaced by the stub
const origResolve=Module._resolveFilename, origLoad=Module._load;
Module._load=function(req,parent,isMain){
  if(req==='../lib/core') return stubCore;
  return origLoad.apply(this,arguments);
};
const handler=require(__dirname+'/../vercel-app/api/action.js');
Module._load=origLoad;

function res(){ const o={code:200,body:null}; o.status=c=>{o.code=c;return o;}; o.json=b=>{o.body=b;return o;}; return o; }
async function post(body){ const r=res(); await handler({method:'POST',_body:body},r); return r.body; }

(async()=>{
console.log('\n── live POST /api/action ──');

// the exact case Ayush hit: zonal Regular, claim 5500 against 5300
queued.length=0;
let out=await post({type:'dispute',trip_id:'TR-ZT-0001',
  categories:['Wrong zonal amount','Wrong RFQ'],
  claim_zonal_amount:'5500', claim_rfq_id:'FM-Zonal-REB-RFQ-0009',
  vendor_description:'rate is wrong', callback_number:'+91 9812345678', proof_url:'https://x/p.png'});
const q=queued[0]||{};
console.log('  zonal Regular  -> '+JSON.stringify(out));
console.log('    queued claim fields: '+JSON.stringify(Object.fromEntries(
  Object.entries(q).filter(([k])=>k.startsWith('claim_')))));
ck(out&&out.ok===true,'a zonal dispute is accepted by the API');
ck(q.claim_zonal_amount==='5500','claim_zonal_amount 5500 reaches the queue (was silently dropped)');
ck(q.claim_rfq_id==='FM-Zonal-REB-RFQ-0009','claim_rfq_id reaches the queue');
ck(q.claim_km===''||q.claim_km===undefined,'claim_km stays empty on a zonal claim');
ck(!q.claim_aggregate_vehicle,'claim_aggregate_vehicle stays empty on a zonal claim');
ck(Array.isArray(q.categories)&&q.categories.includes('Wrong zonal amount'),'the zonal log categories reach the queue');
ck(q.contract_id==='ZONAL::FM-Zonal-REB-RFQ-0005','the queued action carries the card id, and applyDispute derives the billing ref from the sheet');

// zonal adhoc -> claim_amount, not claim_zonal_amount
queued.length=0;
await post({type:'dispute',trip_id:'TR-ZT-0001',categories:['Wrong zonal amount'],
  claim_amount:'6100', callback_number:'+91 9812345678', proof_url:'https://x/p.png'});
ck((queued[0]||{}).claim_amount==='6100','a zonal ADHOC claim reaches the queue as claim_amount');

// local unchanged
queued.length=0;
await post({type:'dispute',trip_id:'TR-L-1',categories:['value','rfq'],
  claim_km:'145', claim_contract_id:'CID-9', callback_number:'+91 9812345678', proof_url:'https://x/p.png'});
const ql=queued[0]||{};
console.log('  local Regular  -> queued: '+JSON.stringify(Object.fromEntries(
  Object.entries(ql).filter(([k])=>k.startsWith('claim_')))));
ck(ql.claim_km==='145','a local KM claim still reaches the queue');
ck(ql.claim_contract_id==='CID-9','a local contract-id claim still reaches the queue');
ck(!ql.claim_zonal_amount,'a local claim never carries a zonal amount');

// the gates still bite
ck((await post({type:'dispute',trip_id:'TR-ZT-0001',categories:[],proof_url:'x'})).ok===false,'a dispute with no category is rejected');
ck((await post({type:'dispute',trip_id:'TR-ZT-0001',categories:['x']})).ok===false,'a dispute with no proof is rejected');
ck((await post({type:'dispute',trip_id:'NOPE',categories:['x'],proof_url:'x'})).ok===false,"a trip that is not this vendor's is rejected");

console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
})();
