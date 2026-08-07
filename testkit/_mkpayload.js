/* Build the REAL vendor payload by running Code.gs against the demo CSVs, then dump it to JSON so the
   browser harness serves exactly what /api/data would serve. No hand-written fixtures. */
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
 openById:()=>{throw new Error('no mis')},create:t=>({}),getUi:()=>{throw new Error('no ui')}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
_readTab=t=>readCsv(t+'.csv');
_tz=()=>'Asia/Kolkata';

/* real Disputes_Log rows, so View-Dispute is exercised against the real map builder */
const _origDmap=_buildDisputeMap;
const p=_buildVendorPayload('ORC-4521',{allTrips:true});

/* Force a few trips into non-pending states with attached disputes so the View-Dispute dialog and the
   reconfirm path are exercised. These mimic what _buildDisputeMap returns after a real sync. */
function pick(pred){ for(const cid of Object.keys(p.trips)) for(const t of p.trips[cid]) if(pred(t,cid)) return [cid,t]; return [null,null]; }

const [zc,zt]=pick(t=>t.scope==='Zonal'&&t.billing==='Regular'&&!t.rto);
if(zt){ zt.status='disputed'; zt.disp={id:'DSP-Z1',raised_at:'02 Jul',categories:['Wrong zonal amount','Wrong RFQ'],
  claim_zonal_amount:'6200',claim_rfq_id:'FM-Zonal-RJK-002',claim_billing_type:'',claim_aggregate_vehicle:'',
  claim_km:'',claim_amount:'',claim_contract_id:'',description:'RFQ rate applied is the old one',
  callback:'+91 9800000001',proof_url:'',status:'Open',orig_route_scope:'Zonal',orig_rfq_id:'FM-Zonal-RJK-001',
  orig_zonal_rfq_amount:'4700',orig_total_km:'',orig_adhoc_amount:'',orig_billing_type:'Regular'}; }

const [zc2,zt2]=pick(t=>t.scope==='Zonal'&&t.billing==='Regular'&&!t.rto&&t.disp==null);
if(zt2){ zt2.status='reconfirm'; zt2.disp={id:'DSP-Z2',raised_at:'03 Jul',categories:['Wrong zonal amount'],
  claim_zonal_amount:'7000',claim_rfq_id:'',claim_km:'',claim_amount:'',claim_contract_id:'',
  description:'amount low',callback:'+91 9800000002',proof_url:'',status:'Resolved',
  orig_route_scope:'Zonal',orig_rfq_id:'FM-Zonal-RJK-001',orig_zonal_rfq_amount:'4700',
  resolution_note:'Upheld — RFQ rate corrected',resolved_zonal_amount:'7000',resolved_rfq_id:'FM-Zonal-RJK-002',
  resolved_km:'',resolved_amount:'',resolved_billing_type:'',resolved_by:'ops@valmo',resolved_at:'05 Jul'}; }

const [lc,lt]=pick(t=>t.scope!=='Zonal'&&t.billing==='Regular'&&!t.rto);
if(lt){ lt.status='disputed'; lt.disp={id:'DSP-L1',raised_at:'02 Jul',categories:['value'],
  claim_km:'145',claim_amount:'',claim_zonal_amount:'',claim_rfq_id:'',claim_billing_type:'',
  claim_aggregate_vehicle:'',claim_contract_id:'',description:'GPS shows 145',callback:'+91 9800000003',
  proof_url:'',status:'Open',orig_route_scope:'Local',orig_total_km:'120',orig_adhoc_amount:''}; }

/* the demo set has no Local+Adhoc+RTO row and no zonal row with a missing rfq_id — both are shapes the
   modal must survive, so they are cloned in here for UI coverage (not for billing assertions) */
const [lac,lat]=pick(t=>t.scope!=='Zonal'&&t.billing==='Adhoc'&&!t.rto);
if(lat){ const c=Object.assign({},lat,{id:lat.id+'-RTOX',rto:true,amt:0,status:'pending',disp:null}); p.trips[lac].push(c); }
const [zrc,zrt]=pick(t=>t.scope==='Zonal'&&t.billing==='Regular'&&!t.rto);
if(zrt){ const c=Object.assign({},zrt,{id:zrt.id+'-NORFQ',rfq:'',status:'pending',disp:null}); p.trips[zrc].push(c); }
/* a zonal trip whose km/amt fields are absent entirely — the exact shape that printed "null km" */
if(zrt){ const c=Object.assign({},zrt,{id:zrt.id+'-BARE',status:'pending',disp:null}); delete c.km; delete c.amt; p.trips[zrc].push(c); }

fs.writeFileSync(__dirname+'/payload.json',JSON.stringify({ok:true,data:p},null,1));
const kinds={};
Object.keys(p.trips).forEach(cid=>p.trips[cid].forEach(t=>{
  const k=(t.scope||'Local')+'/'+t.billing+(t.rto?'/RTO':''); kinds[k]=(kinds[k]||0)+1;}));
console.log('cards',p.contracts.length,'| trip kinds:',JSON.stringify(kinds));
