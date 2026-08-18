/* PANEL vs MIS PARITY — the promise the whole design rests on.
   The vendor sees numbers from _buildVendorPayload (Code.gs). Finance pays numbers from
   buildBillingModel (Billing.gs). They are supposed to be incapable of disagreeing, because both call the
   same _classifyTrip. Nothing has ever asserted that. This does, per contract and per RFQ, over the demo
   data, and it is the test that would catch a divergence introduced by a change to either file.
*/
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
  .replace('yy',String(d.getFullYear()).slice(2)).replace('d',d.getDate())
  .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),openById:()=>{throw 0},create:()=>({}),getUi:()=>{throw 0}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval([__dirname+'/../apps-script/Code.gs',__dirname+'/../apps-script/Billing.gs'].map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_readTab=function(t){ return readCsv(t+'.csv'); };
_tz=function(){ return 'Asia/Kolkata'; };
MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
const R=n=>Math.round(n||0);
const ORC='ORC-4521';

const panel = _buildVendorPayload(ORC,{allTrips:true});
const d     = _misReadSource();
const mis   = buildBillingModel(ORC,d);

/* ---------- 1. LOCAL: per-contract KM and adhoc must match exactly ---------- */
console.log('── local contracts: panel vs MIS ──');
console.log('  %-32s %-18s %-18s'.replace(/%-?\d*s/g,'%s'),'');
console.log('  '+'contract'.padEnd(32)+'panel regKm / adhoc'.padEnd(24)+'MIS regKm / adhoc');
mis.contracts.forEach(function(c){
  const p = panel.contracts.filter(function(x){ return x.id===c.cid; })[0];
  const pAdhoc = (panel.trips[c.cid]||[]).reduce(function(s,t){ return s+(t.billing==='Adhoc'?(t.amt||0):0); },0);
  console.log('  '+String(c.cid).padEnd(32)
    +(p?String(R(p.regKm))+' km / Rs '+R(pAdhoc):'*** MISSING FROM PANEL ***').padEnd(24)
    +String(R(c.regKm))+' km / Rs '+R(c.adhocAmt));
  ck(!!p,'the panel has a card for '+c.cid);
  if(p){
    ck(R(p.regKm)===R(c.regKm),'regKm matches on '+c.cid+' ('+R(p.regKm)+' vs '+R(c.regKm)+')');
    ck(R(pAdhoc)===R(c.adhocAmt),'adhoc total matches on '+c.cid+' (Rs '+R(pAdhoc)+' vs Rs '+R(c.adhocAmt)+')');
  }
});
/* and the panel must not invent a local contract the MIS does not bill */
panel.contracts.filter(function(c){ return !c.isZonalCard && !c.isAdhocBucket; }).forEach(function(c){
  ck(mis.contracts.some(function(m){ return m.cid===c.id; }),'the MIS bills every local card the panel shows: '+c.id);
});

/* ---------- 2. ZONAL: per-RFQ trips and money must match ---------- */
console.log('\n── zonal, per RFQ: panel cards vs MIS groups ──');
const pz={}, pzTrips={};
panel.contracts.filter(function(c){ return c.isZonalCard; }).forEach(function(c){
  pz[c.rfqId]=c.zonalTotal; pzTrips[c.rfqId]=c.zonalTrips;
});
const mz={}, mzTrips={};
(mis.zonal.rfqGroups||[]).forEach(function(g){ if(!g.isAdhoc){ mz[g.rfq]=g.amt; mzTrips[g.rfq]=g.trips; } });
const allRfq=[].concat(Object.keys(pz),Object.keys(mz)).filter(function(v,i,a){return a.indexOf(v)===i;}).sort();
allRfq.forEach(function(r){
  console.log('  '+r.padEnd(38)+'panel '+String(pzTrips[r]||0)+' trip / Rs '+R(pz[r]).toString().padEnd(8)
    +' MIS '+String(mzTrips[r]||0)+' trip / Rs '+R(mz[r]));
  ck(R(pz[r])===R(mz[r]),'RFQ '+r+' money matches (Rs '+R(pz[r])+' vs Rs '+R(mz[r])+')');
  ck((pzTrips[r]||0)===(mzTrips[r]||0),'RFQ '+r+' trip count matches');
});

/* ---------- 3. ZONAL ADHOC bucket vs the MIS adhoc group ---------- */
const pzab = panel.contracts.filter(function(c){ return c.isZonalAdhocBucket; })[0];
const mzab = (mis.zonal.rfqGroups||[]).filter(function(g){ return g.isAdhoc; })[0];
console.log('\n── zonal adhoc ──');
console.log('  panel bucket: '+(pzab?((panel.trips[pzab.id]||[]).length+' trips / Rs '+R(pzab.adhocTotal)):'none')
  +'   MIS group: '+(mzab?(mzab.trips+' trips / Rs '+R(mzab.amt)):'none'));
ck(!!pzab===!!mzab,'both sides agree on whether zonal adhoc exists at all');
if(pzab&&mzab){
  ck(R(pzab.adhocTotal)===R(mzab.amt),'zonal adhoc money matches (Rs '+R(pzab.adhocTotal)+' vs Rs '+R(mzab.amt)+')');
  ck((panel.trips[pzab.id]||[]).length===mzab.trips,'zonal adhoc trip count matches');
}

/* ---------- 4. every trip appears exactly once on each side ---------- */
console.log('\n── trip coverage ──');
const pIds={}, dupP=[];
Object.keys(panel.trips).forEach(function(cid){ (panel.trips[cid]||[]).forEach(function(t){
  if(pIds[t.id]) dupP.push(t.id); pIds[t.id]=1; }); });
const misIds={}, dupM=[];
mis.contracts.forEach(function(c){ (c.allTrips||[]).forEach(function(t){ if(misIds[t.id]) dupM.push(t.id); misIds[t.id]=1; }); });
(mis.zonal.rows||[]).forEach(function(z){ if(misIds[z.tripId]) dupM.push(z.tripId); misIds[z.tripId]=1; });
if(mis.bucket) (mis.bucket.trips||[]).forEach(function(t){ if(misIds[t.id]) dupM.push(t.id); misIds[t.id]=1; });
console.log('  panel: '+Object.keys(pIds).length+' distinct trips, '+dupP.length+' duplicated');
console.log('  MIS  : '+Object.keys(misIds).length+' distinct trips, '+dupM.length+' duplicated');
ck(dupP.length===0,'no trip appears twice in the panel payload');
ck(dupM.length===0,'no trip appears twice across the MIS Local/Zonal/Adhoc tabs'
  +(dupM.length?(' — '+dupM.slice(0,4).join(', ')):''));
/* the documented MIS promise: every trip the vendor can see is backed by a trip_id on some MIS tab, and
   the MIS never bills a trip the vendor was never shown. Both directions, or the vendor gets a number
   with no backup. */
var onlyPanel=Object.keys(pIds).filter(function(id){ return !misIds[id]; });
var onlyMis  =Object.keys(misIds).filter(function(id){ return !pIds[id]; });
onlyPanel.slice(0,6).forEach(function(id){ console.log('    on the panel, NOT on any MIS tab: '+id); });
onlyMis.slice(0,6).forEach(function(id){ console.log('    on the MIS, NOT on the panel: '+id); });
ck(onlyPanel.length===0,'every trip the vendor sees is listed on a MIS tab ('+onlyPanel.length+' missing)');
ck(onlyMis.length===0,'the MIS lists no trip the vendor was never shown ('+onlyMis.length+' extra)');
ck(Object.keys(pIds).length===Object.keys(misIds).length,
   'the two sides carry the same number of trips ('+Object.keys(pIds).length+' vs '+Object.keys(misIds).length+')');

/* ---------- 5. the totals ---------- */
const pZonal = panel.contracts.reduce(function(s,c){ return s+(c.isZonalCard?(c.zonalTotal||0):0); },0)
             + (pzab?(pzab.adhocTotal||0):0);
console.log('\n── grand totals ──');
console.log('  zonal   panel Rs '+R(pZonal)+'   MIS Rs '+R(mis.totals.zonal));
ck(R(pZonal)===R(mis.totals.zonal),'total zonal matches end to end (Rs '+R(pZonal)+')');
const pKm = panel.contracts.reduce(function(s,c){ return s+(c.isZonalCard||c.isAdhocBucket?0:(c.regKm||0)); },0);
console.log('  slab KM panel '+R(pKm)+'      MIS '+R(mis.totals.regKm));
ck(R(pKm)===R(mis.totals.regKm),'total slab-bearing KM matches ('+R(pKm)+')');

/* ---------- 6. the classifier really is shared, not copied ---------- */
const codeSrc=fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8');
const billSrc=fs.readFileSync(__dirname+'/../apps-script/Billing.gs','utf8');
ck((codeSrc.match(/function _classifyTrip/g)||[]).length===1,'_classifyTrip is defined exactly once');
ck((billSrc.match(/function _classifyTrip/g)||[]).length===0,'Billing.gs does not redefine it');
ck((billSrc.match(/_classifyTrip\(/g)||[]).length>0,'Billing.gs calls the shared one ('
   +(billSrc.match(/_classifyTrip\(/g)||[]).length+' call sites)');

console.log('\n── results ──');
notes.forEach(function(x){ console.log(x); });
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(function(f){ console.log(f); }); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
