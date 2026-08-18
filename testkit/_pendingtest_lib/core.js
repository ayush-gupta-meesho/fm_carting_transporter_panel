'use strict';
const STORE={kv:{},lists:{}};
async function redis(cmd){
  const [op,key,...rest]=cmd;
  if(op==='LRANGE') return (STORE.lists[key]||[]).slice();
  if(op==='RPUSH'){ (STORE.lists[key]=STORE.lists[key]||[]).push(rest[0]); return STORE.lists[key].length; }
  if(op==='GET') return STORE.kv[key]||null;
  throw new Error('unsupported '+op);
}
const rget=(k)=>redis(['GET',k]);
const rpush=(k,v)=>redis(['RPUSH',k,v]);
const ACTION_QUEUE = 'actions';   // MUST match ACTION_QUEUE in Actions.gs and the rpush() in action.js

async function pendingVendorActions(oracle) {
  let rows;
  try { rows = await redis(['LRANGE', ACTION_QUEUE, '0', '-1']); }
  catch (e) { return {}; }                       // queue unreadable -> caller serves the snapshot as-is
  if (!Array.isArray(rows) || !rows.length) return {};

  const out = {};                                // trip_id -> 'confirmed' | 'disputed'
  rows.forEach((raw) => {
    let a;
    try { a = JSON.parse(raw); } catch (e) { return; }        // a malformed row must not break the read
    if (!a || String(a.oracle) !== String(oracle)) return;    // never surface another vendor's action
    if (a.type === 'confirm') {
      (Array.isArray(a.trip_ids) ? a.trip_ids : []).forEach((id) => { out[String(id)] = 'confirmed'; });
      if (a.trip_id) out[String(a.trip_id)] = 'confirmed';
    } else if (a.type === 'dispute' && a.trip_id) {
      out[String(a.trip_id)] = 'disputed';       // a dispute after a confirm is the later intent
    }
  });
  return out;
}

let SESSION={oracle:'ORC-4521',email:'v@x',name:'Test Vendor'};
module.exports={STORE,redis,rget,rpush,pendingVendorActions,
  sessionFromReq:()=>SESSION, setSession:(s)=>{SESSION=s;},
  readBody:async(req)=>req.__body};
