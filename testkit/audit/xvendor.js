/* Are two vendors presenting the same plate, and does it cost us anything?
   Aggregator model: vendors hire from the open market, so a plate CAN legitimately appear under two
   vendors. This script separates the three things that could actually move money.
     A. is a plate a CONTRACTED (default) vehicle of two vendors, with overlapping periods?
        -> that would be two fixed charges for one vehicle. This is the expensive failure mode.
     B. is any KM billed to a vendor whose contracted vehicles do not include that plate?
        -> KM is bucketed by the trip's contract_id, never by plate, so this is a records question.
     C. is one plate claimed by two vendors on the SAME DATE?
        -> physically impossible for two 12-hour contracts; at least one side is mis-keyed. */
const fs=require('fs'), DIR=(process.env.LIVE_DIR||'live')+'/';
function readCsv(f){ if(!fs.existsSync(DIR+f)) return [];
 const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){ if(ch==='"'){ if(txt[i+1]==='"'){val+='"';i++;} else q=false; } else val+=ch; }
  else if(ch==='"') q=true;
  else if(ch===','){ cur.push(val); val=''; }
  else if(ch==='\n'){ cur.push(val); rows.push(cur); cur=[]; val=''; }
  else if(ch!=='\r') val+=ch; }
 if(val!==''||cur.length){cur.push(val);rows.push(cur);}
 const hdr=rows.shift().map(h=>h.trim());
 return rows.filter(r=>r.some(c=>String(c).trim()!=='')).map(r=>{const o={};hdr.forEach((h,i)=>o[h]=(r[i]||'').trim());return o;});
}
const S=v=>String(v==null?'':v).trim();
const N=v=>{const n=parseFloat(String(v).replace(/[^0-9.\-]/g,''));return isNaN(n)?0:n;};
const ci=readCsv('Contract_Info.csv'), cv=readCsv('Contract_Vehicles.csv'), tl=readCsv('Trip_Level.csv');
const EXCL={'orc-4521':1};                                  // demo vendor, same list as MIS_EXCLUDE_ORACLES
const info={}; ci.forEach(c=>{const cid=S(c.contract_id); if(!cid) return;
  if(EXCL[S(c.vendor_oracle_id).toLowerCase()]) return; info[cid]=c;});

const home={};                                              // plate -> [{cid,vendor,...}] it is a DEFAULT of
cv.forEach(v=>{const cid=S(v.contract_id), c=info[cid]; if(!c) return;
  const no=S(v.vehicle_number).toUpperCase().replace(/\s|-/g,''); if(!no) return;
  (home[no]=home[no]||[]).push({cid, vendor:S(c.vendor_name), oracle:S(c.vendor_oracle_id),
    start:S(v.start_date)||S(c.contract_start_date), end:S(v.end_date)||S(c.contract_end_date),
    rate:N(v.monthly_rate), days:N(v.active_days), slab:N(v.pegged_km_slab)});
});
function iso(s){ s=S(s); let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return m[1]+m[2]+m[3];
  m=s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/); if(m) return m[3]+String(m[2]).padStart(2,'0')+String(m[1]).padStart(2,'0');
  const d=new Date(s); if(!isNaN(d)) return String(d.getFullYear())+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  return ''; }

console.log('=== A. PLATES THAT ARE A CONTRACTED VEHICLE OF MORE THAN ONE VENDOR ===\n');
let shared=0, overlapRows=[];
Object.keys(home).sort().forEach(no=>{
  const rows=home[no], vend=[...new Set(rows.map(r=>r.oracle))];
  if(vend.length<2) return;
  shared++;
  console.log(no+':');
  rows.forEach(r=>console.log('   '+r.cid.padEnd(26)+r.vendor.padEnd(26)+iso(r.start)+' -> '+iso(r.end)+'   Rs '+r.rate.toLocaleString('en-IN')+'  slab '+r.slab));
  for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++){
    if(rows[i].oracle===rows[j].oracle) continue;
    const a=rows[i], b=rows[j];
    const as=iso(a.start), ae=iso(a.end), bs=iso(b.start), be=iso(b.end);
    if(as&&ae&&bs&&be && as<=be && bs<=ae){
      const os=as>bs?as:bs, oe=ae<be?ae:be;
      const d=(new Date(oe.slice(0,4),+oe.slice(4,6)-1,+oe.slice(6))-new Date(os.slice(0,4),+os.slice(4,6)-1,+os.slice(6)))/86400000+1;
      overlapRows.push({no, a, b, os, oe, days:d,
        cost:(a.days? a.rate/a.days*d:0)+(b.days? b.rate/b.days*d:0)});
      console.log('   *** PERIODS OVERLAP '+os+'..'+oe+'  ('+d+' days) between '+a.vendor+' and '+b.vendor);
    }
  }
  console.log('');
});
if(!shared) console.log('(none - no plate is a contracted vehicle of two vendors, so no fixed charge is ever paid twice)\n');

console.log('=== B. IS ANY KM BILLED TO A VENDOR THE PLATE DOES NOT BELONG TO? ===\n');
let mism=0, mismKm=0, byV={};
tl.forEach(t=>{
  if(S(t.route_scope||'Local').toLowerCase()==='zonal') return;
  const cid=S(t.contract_id), c=info[cid]; if(!c) return;
  if(S(t.billing_type_system).toLowerCase()==='adhoc') return;
  const ch=S(t.challan_type_final||t.challan_type).toLowerCase();
  if(ch.indexOf('rto')===0) return;
  const no=S(t.vehicle_number).toUpperCase().replace(/\s|-/g,'');
  const r=S(t.total_trip_km_resolved), km=r!==''?N(r):N(t.total_trip_km);
  const h=home[no]; if(!h) return;
  if([...new Set(h.map(x=>x.oracle))].indexOf(S(c.vendor_oracle_id))===-1){
    mism++; mismKm+=km;
    const k=S(c.vendor_name)+' <- plate of '+[...new Set(h.map(x=>x.vendor))].join('/');
    byV[k]=(byV[k]||0)+km;
  }
});
console.log('trips whose plate is not a contracted vehicle of the billed vendor: '+mism+'  ('+Math.round(mismKm).toLocaleString('en-IN')+' km)');
Object.keys(byV).sort((a,b)=>byV[b]-byV[a]).forEach(k=>console.log('   '+Math.round(byV[k]).toLocaleString('en-IN').padStart(8)+' km   '+k));
console.log('\n(run xmoney.js for what this costs - it is Rs 0 unless the contract is already over slab)');

console.log('\n=== C. SAME PLATE, SAME DAY, TWO DIFFERENT VENDORS BILLING IT ===\n');
const day={};
tl.forEach(t=>{
  if(S(t.route_scope||'Local').toLowerCase()==='zonal') return;
  const cid=S(t.contract_id), c=info[cid]; if(!c) return;
  const no=S(t.vehicle_number).toUpperCase().replace(/\s|-/g,''); if(!no) return;
  const d=iso(t.trip_date); if(!d) return;
  const k=no+'|'+d, v=S(c.vendor_name)+' ['+S(c.vendor_oracle_id)+']';
  day[k]=day[k]||{}; (day[k][v]=day[k][v]||[]).push(cid);
});
let clash=0;
Object.keys(day).sort().forEach(k=>{
  const vs=Object.keys(day[k]);
  if(vs.length<2) return;
  clash++;
  console.log(k.replace('|','  on  ')+'   billed same day by: '+vs.join('  AND  '));
});
if(!clash) console.log('(none - no plate is claimed on the same date by two vendors)');
console.log('\nplates shared across vendors: '+shared+' | overlapping-period pairs: '+overlapRows.length);
overlapRows.forEach(o=>console.log('   '+o.no+'  '+o.os+'..'+o.oe+'  '+o.days+' d   fixed charge sitting in BOTH MIS over that window: Rs '+Math.round(o.cost).toLocaleString('en-IN')));
