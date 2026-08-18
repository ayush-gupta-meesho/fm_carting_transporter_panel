/* THE PENDING-ACTION OVERLAY — the fix for "confirmed / disputed trips revert to Pending".
   /api/action queues the action to Upstash and does NOT touch the vendor snapshot; drainActions()
   applies it and syncToUpstash() rewrites the snapshot minutes later. In between, /api/data served the
   old "Pending" status, so any refresh discarded the panel's in-memory optimistic update.
   These 16 checks pin the overlay AND its guard rails: the Sheet always wins once it is ahead, no
   cross-vendor leakage, the queue is read never consumed, and a corrupt row cannot break the read. */
const path=require('path'), Module=require('module');
const core=require('./_pendingtest_lib/core');
const _orig=Module.prototype.require;
Module.prototype.require=function(r){ return r==='../lib/core' ? core : _orig.apply(this,arguments); }; const action=require('./../vercel-app/api/action.js'); const data=require('./../vercel-app/api/data.js');
const ORC='ORC-4521', OTHER='ORC-9999';
const mkres=()=>{const o={code:200,body:null};o.status=c=>{o.code=c;return o;};o.json=b=>{o.body=b;return o;};return o;};
function snapshot(status){ return JSON.stringify({trips:{'RJK7-X':[
  {id:'TR-1',status:status,win:'20 Aug',ref:'RJK7-X'},
  {id:'TR-2',status:'pending',win:'20 Aug',ref:'RJK7-X'}]}}); }
const fails=[],notes=[]; const ck=(c,m)=>{(c?notes:fails).push((c?'  ok   ':'  FAIL ')+m);};
const post=async(b)=>{const r=mkres(); await action({method:'POST',__body:b},r); return r.body;};
const get =async()=>{const r=mkres(); await data({},r); return r.body;};
const T=(d,id)=>d.data.trips['RJK7-X'].filter(t=>t.id===id)[0];

(async()=>{
core.STORE.kv['vendor:'+ORC]=snapshot('pending');
console.log('── 1. confirm, then "refresh" ──');
let d=await get(); console.log('  before confirm            : TR-1 =',T(d,'TR-1').status);
ck(T(d,'TR-1').status==='pending','a pending trip reads as pending before any action');
console.log('  POST /api/action confirm  :',JSON.stringify(await post({type:'confirm',trip_id:'TR-1'})));
d=await get();
console.log('  after refresh (GET /api/data): TR-1 =',T(d,'TR-1').status,'_pending =',T(d,'TR-1')._pending,'| pendingActions =',d.pendingActions);
ck(T(d,'TR-1').status==='confirmed','THE FIX: a confirmed trip stays Confirmed across a refresh');
ck(T(d,'TR-1')._pending===true,'and is flagged _pending so the row reads "applying on next sync…"');
ck(T(d,'TR-2').status==='pending','an untouched trip on the same contract is left alone');
ck(d.pendingActions===1,'the response reports how many rows the overlay moved');
console.log('  snapshot in Upstash is still:',JSON.parse(core.STORE.kv['vendor:'+ORC]).trips['RJK7-X'][0].status,'(untouched, by design)');

console.log('\n── 2. a second confirm is now rejected, not double-queued ──');
const dup=await post({type:'confirm',trip_id:'TR-1'});
console.log('  POST again                :',JSON.stringify(dup));
ck(dup.ok===false && /Already submitted/.test(dup.error||''),'a duplicate confirm is refused with a clear message');
ck((core.STORE.lists['actions']||[]).length===1,'the queue still holds exactly 1 action for TR-1');
const dd=await post({type:'dispute',trip_id:'TR-1',categories:['value'],proof_url:'http://x/p.jpg'});
ck(dd.ok===false,'and a dispute on an already-queued trip is refused too: '+(dd.error||''));

console.log('\n── 3. dispute survives a refresh ──');
console.log('  POST dispute TR-2         :',JSON.stringify(await post({type:'dispute',trip_id:'TR-2',categories:['value'],claim_km:180,proof_url:'http://x/p.jpg'})));
d=await get(); console.log('  after refresh             : TR-2 =',T(d,'TR-2').status,'_pending =',T(d,'TR-2')._pending);
ck(T(d,'TR-2').status==='disputed','a disputed trip stays Disputed across a refresh');
ck(!T(d,'TR-2').disp,'with no View-dispute link, because no Disputes_Log row exists yet');

console.log('\n── 4. the SHEET always wins once it is ahead ──');
core.STORE.kv['vendor:'+ORC]=snapshot('reconfirm');   // ops resolved the dispute -> trip is back to the vendor
d=await get(); console.log('  snapshot says reconfirm, queue still says confirmed -> panel shows:',T(d,'TR-1').status);
ck(T(d,'TR-1').status==='confirmed','a queued confirm still applies to a reconfirm trip (it is actionable)');
core.STORE.kv['vendor:'+ORC]=snapshot('confirmed');
d=await get(); ck(T(d,'TR-1').status==='confirmed','once the drain lands, the snapshot carries it and the overlay is a no-op');
core.STORE.kv['vendor:'+ORC]=snapshot('disputed');
d=await get(); console.log('  snapshot says disputed, queue says confirmed        -> panel shows:',T(d,'TR-1').status);
ck(T(d,'TR-1').status==='disputed','a STALE queue entry can never override a snapshot that has moved on');

console.log('\n── 5. no cross-vendor leakage ──');
core.STORE.kv['vendor:'+OTHER]=snapshot('pending');
core.setSession({oracle:OTHER,email:'o@x',name:'Other'});
d=await get(); console.log('  another vendor loads their panel: TR-1 =',T(d,'TR-1').status,'| pendingActions =',d.pendingActions);
ck(T(d,'TR-1').status==='pending' && d.pendingActions===0,"another vendor never sees ORC-4521's queued actions");
core.setSession({oracle:ORC,email:'v@x',name:'Test Vendor'});

console.log('\n── 6. the queue is read, never consumed ──');
ck((core.STORE.lists['actions']||[]).length===2,'after '+6+' GETs the queue still holds all 2 actions (LRANGE, not LPOP)');

console.log('\n── 7. a malformed queue row cannot break the read ──');
core.STORE.lists['actions'].push('{not json');
core.STORE.kv['vendor:'+ORC]=snapshot('pending');
d=await get(); ck(d.ok===true && T(d,'TR-1').status==='confirmed','a corrupt row is skipped, the rest still overlay');

console.log('\n── results ──'); notes.forEach(x=>console.log(x));
if(fails.length){console.log('\n'+fails.length+' FAILURE(S):');fails.forEach(f=>console.log(f));process.exit(1);}
console.log('\nALL '+notes.length+' CHECKS PASSED');
})();
