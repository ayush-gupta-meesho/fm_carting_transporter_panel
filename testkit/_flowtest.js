/* "Does anyone ever have to type into Trip_Level to resolve a dispute?"
   Runs the REAL applyResolutionsFromSheet() against an in-memory sheet and records every Trip_Level cell
   it writes, so the answer is evidence rather than assertion. */
const fs=require('fs');
const TL_HDR=['trip_id','route_scope','rfq_id','billing_type_system','billing_type_final','billing_type_resolved',
  'total_trip_km','adhoc_amount','zonal_rfq_amount','zonal_rfq_amount_final','challan_type','challan_type_final',
  'replaced_default_vehicle_final','contract_id','vendor_status','row_id','transporter_oracle_id',
  'sent_to_vendor_timestamp','dispute_window_end'];
const DL_HDR=['dispute_id','trip_id','dispute_status','resolved_at','reconfirm_status','resolved_billing_type',
  'resolved_km','resolved_amount','resolved_zonal_amount','resolved_rfq_id','resolved_challan_type',
  'resolved_aggregate_vehicle','resolved_contract_id','resolution_note','resolved_by'];
const writes=[];                                     // every _setCell into Trip_Level
function mkSheet(name,hdr,rows){ return {name,values:[hdr.slice(),...rows.map(r=>r.slice())]}; }
function row(hdr,o){ return hdr.map(h=>o[h]===undefined?'':o[h]); }

global.Utilities={formatDate:()=>'2026-08-07T00:00:00'};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),getUi:()=>{throw 0;}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8'));
_tz=()=>'Asia/Kolkata'; _nowIso=()=>'2026-08-07T10:00:00';

let TL, DL;
_ctx=function(tab,key){
  const s = (tab===TABS.tripLevel)?TL:DL;
  const idx={}; s.values[0].forEach((h,i)=>{ if(h) idx[h]=i; });
  return {sh:{name:s.name},values:s.values,headerRow:0,headers:s.values[0],idx};
};
_setCell=function(ctx,r,col,v){
  const ci=ctx.idx[col]; if(ci===undefined) return;
  ctx.values[r][ci]=v;
  if(ctx.sh.name==='Trip_Level') writes.push({trip:ctx.values[r][ctx.idx['trip_id']],col,v});
};
_upsertStatusView=function(){};                       // a log tab, not in scope for this question

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };

/* ── the sheet state an OPS user creates: they touch Disputes_Log ONLY ── */
TL=mkSheet('Trip_Level',TL_HDR,[
  row(TL_HDR,{trip_id:'TR-ZT-0001',route_scope:'Zonal',rfq_id:'FM-Zonal-REB-RFQ-0005',billing_type_system:'Regular',
    zonal_rfq_amount:5300,adhoc_amount:6100,challan_type:'Forward Only',vendor_status:'Disputed'}),
  row(TL_HDR,{trip_id:'TR-ZT-0002',route_scope:'Zonal',rfq_id:'FM-Zonal-REB-RFQ-0005',billing_type_system:'Regular',
    zonal_rfq_amount:5300,adhoc_amount:5300,challan_type:'RTO only',vendor_status:'Disputed'}),
  row(TL_HDR,{trip_id:'TR-L-1',route_scope:'Local',billing_type_system:'Regular',total_trip_km:0,
    challan_type:'RTO only',contract_id:'RJK7-X',vendor_status:'Disputed'}),
]);
DL=mkSheet('Disputes_Log',DL_HDR,[
  // 1. zonal Regular -> Adhoc, upheld
  row(DL_HDR,{dispute_id:'DSP-1',trip_id:'TR-ZT-0001',dispute_status:'Resolved',
    resolved_billing_type:'Adhoc',resolved_amount:6100,resolution_note:'agreed adhoc',resolved_by:'ops@valmo'}),
  // 2. zonal RTO -> not an RTO, upheld
  row(DL_HDR,{dispute_id:'DSP-2',trip_id:'TR-ZT-0002',dispute_status:'Resolved',
    resolved_challan_type:'Forward Only',resolution_note:'challan was wrong',resolved_by:'ops@valmo'}),
  // 3. local RTO -> not an RTO + the KM, upheld
  row(DL_HDR,{dispute_id:'DSP-3',trip_id:'TR-L-1',dispute_status:'Resolved',
    resolved_challan_type:'Forward Only',resolved_km:180,resolution_note:'ran forward',resolved_by:'ops@valmo'}),
  // 4. still Open — must be untouched
  row(DL_HDR,{dispute_id:'DSP-4',trip_id:'TR-ZT-0001',dispute_status:'Open',resolved_billing_type:'Regular'}),
]);

console.log('── the ONLY sheet an ops user edits: Disputes_Log ──');
DL.values.slice(1).forEach(r=>{
  const o={}; DL_HDR.forEach((h,i)=>{ if(r[i]!=='') o[h]=r[i]; });
  console.log('  '+JSON.stringify(o));
});

const out=applyResolutionsFromSheet();
console.log('\n── what the SCRIPT then wrote into Trip_Level (no human typed any of this) ──');
writes.forEach(w=>console.log('  '+String(w.trip).padEnd(12)+' '+String(w.col).padEnd(24)+' = '+w.v));
console.log('\n  '+out);

const by=t=>writes.filter(w=>w.trip===t).reduce((o,w)=>(o[w.col]=w.v,o),{});
const a=by('TR-ZT-0001'), b=by('TR-ZT-0002'), c=by('TR-L-1');
ck(a.billing_type_resolved==='Adhoc','DSP-1 flipped the zonal trip via billing_type_resolved');
ck(String(a.adhoc_amount)==='6100','DSP-1 set the adhoc amount that will now bill');
ck(a.billing_type_final===undefined,"DSP-1 never touched billing_type_final — that column stays ground's");
ck(a.vendor_status==='Reconfirm','DSP-1 re-surfaced the trip to the vendor');
ck(b.challan_type_final==='Forward Only','DSP-2 lifted the RTO on the zonal trip');
ck(c.challan_type_final==='Forward Only'&&String(c.total_trip_km)==='180','DSP-3 lifted the RTO and set the local KM');
ck(!writes.some(w=>w.trip==='TR-ZT-0001'&&w.col==='total_trip_km'),'no KM was written to a zonal trip');
ck(writes.every(w=>['billing_type_resolved','adhoc_amount','challan_type_final','total_trip_km',
  'zonal_rfq_amount_final','rfq_id','contract_id','billing_type_final','replaced_default_vehicle_final',
  'vendor_status'].indexOf(w.col)>=0),'the script writes only the columns the resolution contract names');

/* the Open dispute must be untouched, and re-running must not double-apply */
const before=writes.length;
applyResolutionsFromSheet();
console.log('\n── re-run (idempotence) ──');
console.log('  extra Trip_Level writes on the second run: '+(writes.length-before));
ck(writes.length===before,'re-running applies nothing again — resolved_at is the guard');
ck(DL.values[4][DL_HDR.indexOf('resolved_at')]==='','the still-Open dispute was never applied');

console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
