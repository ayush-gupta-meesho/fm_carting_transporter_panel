/* What do the cross-vendor-plate trips actually COST?
   KM is bucketed by the trip's contract_id, so the plate never moves money by itself. It only matters
   through excess KM: excessKm = max(0, regKm - slabCV) per contract. So the question is whether the
   contract that received the KM is already over its pegged slab. This prints the excess-KM bill as it
   stands today against the counterfactual where each cross-plate trip is re-billed to the contract the
   plate is a default of. The difference is the exposure. */
const fs=require('fs'), DIR=(process.env.LIVE_DIR||'live')+'/';
function readCsv(f){const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){ if(ch==='"'){ if(txt[i+1]==='"'){val+='"';i++;} else q=false; } else val+=ch; }
  else if(ch==='"') q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r') val+=ch;}
 if(val!==''||cur.length){cur.push(val);rows.push(cur);}
 const hdr=rows.shift().map(h=>h.trim());
 return rows.filter(r=>r.some(c=>String(c).trim()!=='')).map(r=>{const o={};hdr.forEach((h,i)=>o[h]=(r[i]||'').trim());return o;});}
const S=v=>String(v==null?'':v).trim(), N=v=>{const n=parseFloat(String(v).replace(/[^0-9.\-]/g,''));return isNaN(n)?0:n;};
const K=v=>S(v).toUpperCase().replace(/[\s-]/g,'');
const ci=readCsv('Contract_Info.csv'), cv=readCsv('Contract_Vehicles.csv'), tl=readCsv('Trip_Level.csv');
const info={}; ci.forEach(c=>{const cid=S(c.contract_id);
  if(cid && S(c.vendor_oracle_id).toLowerCase()!=='orc-4521') info[cid]=c;});
const home={}, slab={};
cv.forEach(v=>{const cid=S(v.contract_id); if(!info[cid]) return; const no=K(v.vehicle_number); if(!no) return;
  (home[no]=home[no]||[]).push(cid); slab[cid]=(slab[cid]||0)+N(v.pegged_km_slab);});
function km(t){const r=S(t.total_trip_km_resolved); return r!==''?N(r):N(t.total_trip_km);}
const reg={}, moved=[];
tl.forEach(t=>{
  if(S(t.route_scope||'Local').toLowerCase()==='zonal') return;
  const cid=S(t.contract_id), c=info[cid]; if(!c) return;
  if(S(t.billing_type_system).toLowerCase()==='adhoc') return;
  const ch=S(t.challan_type_final||t.challan_type).toLowerCase(); if(ch.indexOf('rto')===0) return;
  const k=km(t); reg[cid]=(reg[cid]||0)+k;
  const no=K(t.vehicle_number), h=home[no]; if(!h) return;
  if([...new Set(h.map(x=>S(info[x].vendor_oracle_id)))].indexOf(S(c.vendor_oracle_id))===-1)
    moved.push({cid, to:h[0], km:k, no:no});
});
function bill(regMap){let tot=0; const per={};
  Object.keys(info).forEach(cid=>{const ex=Math.max(0,(regMap[cid]||0)-(slab[cid]||0))*N(info[cid].ex_km_rate);
    per[cid]=ex; tot+=ex;}); return {tot, per};}
const base=bill(reg);
const alt=JSON.parse(JSON.stringify(reg));
moved.forEach(m=>{alt[m.cid]=(alt[m.cid]||0)-m.km; alt[m.to]=(alt[m.to]||0)+m.km;});
const after=bill(alt);
console.log('cross-plate trips: '+moved.length+'   km: '+Math.round(moved.reduce((a,b)=>a+b.km,0)).toLocaleString('en-IN'));
console.log('\nEXCESS-KM CHARGE, all contracts');
console.log('  as billed today (KM on the contract that engaged the vendor) : Rs '+Math.round(base.tot).toLocaleString('en-IN'));
console.log('  if KM followed the PLATE instead                            : Rs '+Math.round(after.tot).toLocaleString('en-IN'));
console.log('  difference                                                  : Rs '+Math.round(after.tot-base.tot).toLocaleString('en-IN'));
console.log('\nPer contract touched by these trips  (regKm / slab / excess Rs)');
[...new Set(moved.map(m=>m.cid).concat(moved.map(m=>m.to)))].sort().forEach(cid=>{
  const c=info[cid];
  console.log('  '+cid.padEnd(26)+S(c.vendor_name).slice(0,22).padEnd(24)
    +'reg '+String(Math.round(reg[cid]||0)).padStart(6)+' / slab '+String(slab[cid]||0).padStart(6)
    +'  excess Rs '+String(Math.round(base.per[cid])).padStart(7)
    +'   -> if plate-based: Rs '+String(Math.round(after.per[cid])).padStart(7)
    +'  (headroom '+Math.round((slab[cid]||0)-(reg[cid]||0))+' km)');
});
