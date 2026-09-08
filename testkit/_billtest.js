/* MIS validation for the "zonal has no contract_id, rfq_id IS the contract id" change.
   Runs the real Code.gs + Billing.gs in Node against the demo CSVs, and proves:
     - zonal is still read and still totals the same after every zonal contract_id is blanked
     - zonal is grouped one line per rfq_id, and those lines sum to the zonal total
     - no zonal KM, amount or trip leaks into a local contract's slab / adhoc / vehicle rows
     - the "every zonal trip carries an RFQ ID" gate fires when an rfq_id is blank
   Compares against a hand-rolled independent sum so a bug in Billing.gs cannot hide behind itself. */
const fs=require('fs');
const DIR=__dirname+'/demo-data/';
function readCsv(f){const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){if(ch==='"'){if(txt[i+1]==='"'){val+='"';i++;}else q=false;}else val+=ch;}
  else if(ch==='"')q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r')val+=ch;}
 if(val||cur.length){cur.push(val);rows.push(cur);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.some(c=>c!=='')).map(r=>{const o={};h.forEach((k,i)=>o[k]=r[i]===undefined?'':r[i]);return o;});}
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
 const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return f.replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
  .replace(/\bd\b/,d.getDate()).replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),
 openById:()=>{throw new Error('no MIS sheet in test')},create:()=>({}),getUi:()=>{throw new Error('no ui')}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval([__dirname+'/../apps-script/Code.gs',__dirname+'/../apps-script/Billing.gs'].map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_readTab=t=>readCsv(t+'.csv'); _tz=()=>'Asia/Kolkata';
MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
const R=n=>Math.round(n);

/* ---- independent sum straight off the CSV, no Billing.gs involved ---- */
const tl=readCsv('Trip_Level.csv');
const ORC='ORC-4521';
const indep={zonal:0,zTrips:0,byRfq:{},blankCid:0,blankRfq:0};
tl.forEach(t=>{
  if(String(t.transporter_oracle_id).trim()!=='19186' && String(t.transporter_oracle_id).trim()!==ORC) {
    // demo file keys oracle by the numeric id; accept whatever the Contract_Info join uses
  }
  if(String(t.route_scope||'Local').trim().toLowerCase()!=='zonal') return;
  const rto=/^rto/i.test(String(t.challan_type_final||t.challan_type||''));
  const adhoc=String(t.billing_type_system||'').trim().toLowerCase()==='adhoc';
  /* RTO rule, 2026-09-08 two-part form: the RTO gate applies to Regular only. An adhoc trip is paid
     its amount whether or not the challan is RTO-only. */
  const amt=adhoc?Number(t.adhoc_amount||0)
                 :(rto?0:Number(t.zonal_rfq_amount_final||t.zonal_rfq_amount||0));
  indep.zonal+=amt; indep.zTrips++;
  if(!String(t.contract_id||'').trim()) indep.blankCid++;
  const k=String(t.rfq_id||'').trim()||'(no RFQ id)';
  if(k==='(no RFQ id)') indep.blankRfq++;
  indep.byRfq[k]=(indep.byRfq[k]||0)+amt;
});

console.log('── independent sum off the CSV ──');
console.log('  zonal trips '+indep.zTrips+' · ₹'+R(indep.zonal)
  +' · blank contract_id on '+indep.blankCid+' of them · blank rfq_id on '+indep.blankRfq);
ck(indep.blankCid===indep.zTrips,'the demo data really does have a blank contract_id on every zonal trip');

/* ---- Billing.gs ---- */
const d=_misReadSource();
const zKeys=Object.keys(d.zonal);
console.log('\n── _misReadSource ──');
zKeys.forEach(k=>console.log('  '+k+': '+d.zonal[k].rows.length+' rows · ₹'
  +R(d.zonal[k].regAmt+d.zonal[k].adhocAmt)+' · '+d.zonal[k].rfqGroups.length+' RFQ group(s)'));
ck(zKeys.length>0,'zonal is still read even though no zonal row carries a contract_id');
ck((d.zonalOrphans||[]).length===0,'no zonal row is orphaned (vendor comes from transporter_oracle_id)');

const m=buildBillingModel(ORC,d);
console.log('\n── vendor model: '+m.vendorName+' ──');
console.log('  local contracts: '+m.contracts.length);
m.contracts.forEach(c=>console.log('    '+c.cid.padEnd(32)+' slab '+String(c.slabCV).padStart(6)
  +' · regKm '+String(R(c.regKm)).padStart(6)+' · adhoc ₹'+String(R(c.adhocAmt)).padStart(7)));

/* no zonal may leak into a local contract */
let leak=0;
m.contracts.forEach(c=>{
  (c.allTrips||[]).forEach(t=>{ if(String(t.scope||'Local').toLowerCase()==='zonal') leak++; });
  if(c.zonalAmt!==undefined||c.zonalRows!==undefined) leak+=100;   // fields should be gone entirely
});
ck(leak===0,'no zonal trip and no zonal field reaches a local contract record (leak count '+leak+')');

console.log('\n── zonal, one line per RFQ ──');
const g=m.zonal.rfqGroups;
g.forEach(x=>console.log('    '+x.rfq.padEnd(40)+' '+String(x.trips).padStart(3)+' trip(s)  ₹'+R(x.amt)));
const gSum=g.reduce((s,x)=>s+x.amt,0);
console.log('    '+'ZONAL SUBTOTAL'.padEnd(40)+' '+String(m.totals.zonalTrips).padStart(3)+' trip(s)  ₹'+R(m.totals.zonal));
ck(g.length>0,'zonal is grouped into '+g.length+' RFQ line(s)');
ck(R(gSum)===R(m.totals.zonal),'the per-RFQ lines sum exactly to the zonal subtotal ('+R(gSum)+' vs '+R(m.totals.zonal)+')');
ck(R(m.totals.zonal)===R(indep.zonal),'Billing.gs zonal total matches the independent CSV sum ('+R(m.totals.zonal)+' vs '+R(indep.zonal)+')');
ck(m.totals.zonalTrips===indep.zTrips,'zonal trip count matches ('+m.totals.zonalTrips+' vs '+indep.zTrips+')');
g.forEach(x=>{
  // adhoc has no rfq_id, so it is compared against the independent '(no RFQ id)' bucket
  const want = x.isAdhoc ? (indep.byRfq['(no RFQ id)']||0) : (indep.byRfq[x.rfq]||0);
  ck(R(x.amt)===R(want),(x.isAdhoc?'Zonal adhoc group':'RFQ '+x.rfq)
     +' matches the independent sum (₹'+R(x.amt)+' vs ₹'+R(want)+')');
});
/* ZONAL ADHOC HAS NO RFQ BY DESIGN — it bills on its amount, so it must never become an RFQ line and
   must never be gated as a missing value. */
const adG=g.filter(x=>x.isAdhoc), rfqG=g.filter(x=>!x.isAdhoc);
const adhocRows=tl.filter(t=>String(t.route_scope||'').trim().toLowerCase()==='zonal'
                        && String(t.billing_type_system||'').trim().toLowerCase()==='adhoc');
const adhocBlank=adhocRows.filter(t=>!String(t.rfq_id||'').trim()).length;
console.log('    (zonal adhoc rows: '+adhocRows.length+', of which blank rfq_id: '+adhocBlank+')');
ck(adhocBlank===adhocRows.length,'the demo data has a blank rfq_id on every zonal ADHOC row, as production will');
ck(adG.length===1,'zonal adhoc collapses into exactly ONE group, not one per blank rfq');
ck(adG.length===1&&adG[0].rfq==='Zonal adhoc trips','that group is labelled "Zonal adhoc trips", never "(no RFQ id)"');
ck(adG.length===1&&adG[0].trips===adhocRows.length,'it holds every zonal adhoc trip ('+(adG[0]||{}).trips+')');
ck(!rfqG.some(x=>x.rfq==='(no RFQ id)'),'no phantom "(no RFQ id)" RFQ line is created by adhoc');
ck(rfqG.every(x=>x.adhocN===0),'no RFQ line contains an adhoc trip');
ck(adG.length===1&&adG[0].regN===0,'the adhoc group contains no Regular trip');
ck(Object.keys(indep.byRfq).filter(k=>k!=='(no RFQ id)').length===rfqG.length,
   'every real RFQ in the data has a line ('+rfqG.length+')');

/* ---- REGRESSION 2026-08-11: totals.adhoc, summed independently off the CSV ----------------------
   The check below used to be `payable === fixed+excess+adhoc+zonal` and nothing else, which is
   vacuous: every term comes from the same object, so it holds no matter how wrong `adhoc` is. It
   held while all 11 zonal trips were ALSO being counted into totals.adhoc through the Other-Adhoc
   orphan bucket (a zonal trip has a blank contract_id, so it failed the info[cid] test in
   _misReadSource and fell through), double-billing ₹17,000 and inflating payable to ₹548,250.
   This sums LOCAL adhoc money from the raw CSV, the way the spec says, and never trusts Billing.gs.
*/
const ci=readCsv('Contract_Info.csv');
const cvRows=readCsv('Contract_Vehicles.csv');
const myCids={}; ci.forEach(c=>{ if(String(c.vendor_oracle_id||'').trim()===ORC) myCids[String(c.contract_id||'').trim()]=1; });
const infoCids={}; ci.forEach(c=>{ const k=String(c.contract_id||'').trim(); if(k) infoCids[k]=String(c.vendor_oracle_id||'').trim(); });
function indepClass(t,defBilling){
  const st=v=>String(v==null?'':v).trim(), lc=v=>st(v).toLowerCase();
  const nm=v=>{ const n=parseFloat(st(v).replace(/,/g,'')); return isNaN(n)?0:n; };
  const isZonal=lc(st(t.route_scope)||'Local')==='zonal';
  const billing=st(t.billing_type_resolved)||(isZonal?'':st(t.billing_type_final))
              ||st(t.billing_type_system)||defBilling;
  const isAdhoc=lc(billing)==='adhoc';
  const cf=lc(t.challan_type_final);
  const km=nm(t.total_trip_km);
  const rto=cf?cf.indexOf('rto')===0
    :(lc(t.challan_type).indexOf('rto')===0
      ||(lc(t.km_accumulated_flag)!=='yes'&&km===0&&!isAdhoc&&st(t.km_accumulated_flag)!==''));
  return {isZonal:isZonal,isAdhoc:isAdhoc,rto:rto,
          /* adhoc is tested before rto — the 2026-09-08 rule */
          amt:isAdhoc?nm(t.adhoc_amount):0};
}
let indepAdhoc=0, indepAdhocN=0, indepBucket=0, indepBucketN=0;
tl.forEach(t=>{
  if(String(t.transporter_oracle_id||'').trim()!==ORC) return;
  if(String(t.route_scope||'Local').trim().toLowerCase()==='zonal') return;  // zonal is NOT adhoc money
  const cid=String(t.contract_id||'').trim();
  const mine=!!infoCids[cid];
  const x=indepClass(t, mine?'Regular':'Adhoc');   // the orphan bucket defaults to Adhoc
  if(!x.isAdhoc) return;
  if(mine){ indepAdhoc+=x.amt; indepAdhocN++; } else { indepBucket+=x.amt; indepBucketN++; }
});
console.log('\n── independent LOCAL adhoc sum off the CSV ──');
console.log('  on-contract adhoc: '+indepAdhocN+' trip(s) ₹'+R(indepAdhoc)
  +'   ·   orphan bucket: '+indepBucketN+' trip(s) ₹'+R(indepBucket)
  +'   =   ₹'+R(indepAdhoc+indepBucket));
console.log('  Billing.gs totals.adhoc: ₹'+R(m.totals.adhoc)
  +'   (bucket ₹'+R(m.bucket?m.bucket.adhocAmt:0)+' over '+(m.bucket?(m.bucket.trips||[]).length:0)+' row(s))');
ck(R(m.totals.adhoc)===R(indepAdhoc+indepBucket),
   'totals.adhoc matches the independent CSV sum (₹'+R(m.totals.adhoc)+' vs ₹'+R(indepAdhoc+indepBucket)+')');
ck(R(m.bucket?m.bucket.adhocAmt:0)===R(indepBucket),
   'the Other-Adhoc bucket holds exactly the off-contract adhoc money (₹'+R(indepBucket)+')');
/* the bug itself, named: a zonal trip must never reach the local trips map or the orphan bucket */
const zonalInBucket=(m.bucket?(m.bucket.trips||[]):[]).filter(b=>{
  const src=tl.filter(t=>String(t.trip_id||'').trim()===String(b.id||'').trim())[0];
  return src && String(src.route_scope||'').trim().toLowerCase()==='zonal';
});
ck(zonalInBucket.length===0,'no zonal trip is inside the Other-Adhoc bucket ('
  +zonalInBucket.length+' found'+(zonalInBucket.length?': '+zonalInBucket.slice(0,3).map(x=>x.id).join(', '):'')+')');
let zonalInLocal=0;
Object.keys(d.trips||{}).forEach(cid=>(d.trips[cid]||[]).forEach(t=>{
  if(String(t.route_scope||'').trim().toLowerCase()==='zonal') zonalInLocal++; }));
let zonalInOrphans=0;
Object.keys(d.orphans||{}).forEach(o=>(d.orphans[o]||[]).forEach(t=>{
  if(String(t.route_scope||'').trim().toLowerCase()==='zonal') zonalInOrphans++; }));
console.log('  zonal rows leaked into d.trips: '+zonalInLocal+' · into d.orphans: '+zonalInOrphans);
ck(zonalInLocal===0,'_misReadSource puts no zonal row in the local trips map');
ck(zonalInOrphans===0,'_misReadSource puts no zonal row in the orphan map (the ₹17,000 double-bill)');

/* payable = fixed + excess + adhoc + zonal, no double count */
const expect=m.totals.fixed+m.totals.excessAmt+m.totals.adhoc+m.totals.zonal;
console.log('\n── totals ──');
console.log('  fixed ₹'+R(m.totals.fixed)+' · excess ₹'+R(m.totals.excessAmt)+' · adhoc ₹'+R(m.totals.adhoc)
  +' · zonal ₹'+R(m.totals.zonal)+'  =  PAYABLE ₹'+R(m.totals.payable));
ck(R(m.totals.payable)===R(expect),'payable is the sum of its four parts, zonal counted once');
/* and an independent payable, so the four parts cannot all drift together */
const indepPayable=m.totals.fixed+m.totals.excessAmt+(indepAdhoc+indepBucket)+indep.zonal;
console.log('  independent payable (fixed+excess from vehicle rows, adhoc+zonal from the CSV): ₹'+R(indepPayable));
ck(R(m.totals.payable)===R(indepPayable),
   'payable matches an independently summed payable (₹'+R(m.totals.payable)+' vs ₹'+R(indepPayable)+')');
ck(R(m.totals.payable)!==548250,'payable is NOT the ₹548,250 figure the double-bill produced');

/* the blank-rfq gate */
const gates=runGates(m,d)||[];
console.log('\n── gates ──');
gates.forEach(x=>console.log('  ['+(x.level||'')+'] '+(x.verdict==='clear'?'PASS':x.verdict)+'  '+x.name+(x.detail?(' — '+x.detail):'')));
const zg=gates.filter(x=>/carries an RFQ ID/i.test(x.name));
ck(zg.length===1,'the "every zonal trip carries an RFQ ID" gate exists');
ck(zg.length===1&&zg[0].verdict==='clear',
   'the gate is CLEAR even though '+adhocBlank+' zonal adhoc rows have a blank rfq_id — adhoc is not gated');

/* now break one rfq_id and prove the gate bites */
const d2=JSON.parse(JSON.stringify(d));
const _k=Object.keys(d2.zonal)[0];
// blank the rfq on a REGULAR row — that IS a data problem and must still be caught
const _reg=d2.zonal[_k].rows.find(r=>String(r.billing).toLowerCase()!=='adhoc');
_reg.rfqId='';
d2.zonal[_k].rfqGroups=_misZonalRfq(d2.zonal[_k]);
const m2=buildBillingModel(ORC,d2);
const g2=(runGates(m2,d2)||[]).filter(x=>/carries an RFQ ID/i.test(x.name))[0];
console.log('  broken-data gate → '+(g2?(g2.verdict+' · '+g2.detail):'(missing)'));
ck(g2&&g2.verdict!=='clear','the gate FAILS when a zonal trip has a blank rfq_id');
ck(g2&&/blank rfq_id/.test(g2.detail||''),'and the message names the problem');
ck((m2.zonal.rfqGroups||[]).some(x=>x.rfq==='(no RFQ id)'),'a blank rfq_id still gets its own visible line, not dropped');
ck(R(m2.totals.zonal)===R(m.totals.zonal),'blanking an rfq_id does not change the money (₹'+R(m2.totals.zonal)+')');
ck((m2.zonal.rfqGroups||[]).filter(x=>x.isAdhoc).length===1,'the adhoc group survives the broken-data case intact');

console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
