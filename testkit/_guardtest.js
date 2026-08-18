/* THE GUARDS — every refusal path in Actions.gs, driven for real.
   Until now the harnesses tested what happens when things go RIGHT. These are the paths that fire when
   they go wrong, and they are the ones protecting the money:

     transferReadyTrips()  — the ground window, the ZONAL_NOT_EDITABLE clear, the hand-typed
                             billing_type_resolved clear, and the incomplete-reclassification bounce
     applyConfirm()        — ownership, locking, and the Reconfirm -> Reconfirmed transition
     applyDispute()        — ownership, locking, the closed dispute window, and re-dispute

   Every case is run through the REAL function against an in-memory sheet, and asserted on the cells
   that actually changed. Nothing here is a print.
*/
const fs=require('fs');

const TL_HDR=['trip_id','row_id','transporter_oracle_id','route_scope','rfq_id','contract_id','vehicle_number',
  'vehicle_size','trip_cluster','source_node','dest_fmh_nodes','trip_end_time','ground_review_deadline',
  'ground_confirmed','sent_to_vendor_flag','sent_to_vendor_timestamp','dispute_window_end','vendor_status',
  'billing_type_system','billing_type_final','billing_type_resolved','replaced_default_vehicle_system',
  'replaced_default_vehicle_final','total_trip_km','adhoc_amount','zonal_rfq_amount','zonal_rfq_amount_final',
  'challan_type','challan_type_final','km_accumulated_flag'];
const GCL_HDR=['log_id','row_id','trip_id','contract_id','transporter_oracle_id','route_scope','trip_end_time',
  'ground_review_deadline','sent_to_vendor_timestamp','ground_action_state','billing_before','billing_after',
  'replaced_vehicle_before','replaced_vehicle_after','data_sent','partial_edit_flag'];
const DSP_HDR=['dispute_id','row_id','trip_id','contract_id','transporter_oracle_id','vendor_name','raised_at',
  'categories','claim_billing_type','claim_aggregate_vehicle','claim_km','claim_amount','claim_zonal_amount',
  'claim_rfq_id','claim_challan_type','claim_contract_id','vendor_description','proof_url','callback_number',
  'orig_vehicle_number','orig_vehicle_size','orig_trip_cluster','orig_route','orig_route_scope','orig_rfq_id',
  'orig_completed_time','orig_billing_type','orig_replaced_default_vehicle','orig_total_km','orig_adhoc_amount',
  'orig_challan_type','orig_zonal_rfq_amount','dispute_status','reconfirm_status'];

/* the contracted vehicles the guards check against */
const CV=[
  {contract_id:'RJK7-X',vehicle_number:'GJ01AA0001'},
  {contract_id:'RJK7-X',vehicle_number:'GJ01AA0002'},
  {contract_id:'RJK10-Y',vehicle_number:'GJ02BB0001'},
];

let NOW=new Date('2026-08-10T12:00:00+05:30');
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
  return String(f).replace('yyyy',d.getFullYear()).replace('MM',p(d.getMonth()+1)).replace('dd',p(d.getDate()))
   .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes())).replace('ss',p(d.getSeconds()))
   .replace(/'/g,'');}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),getUi:()=>{throw new Error('no UI in the harness');}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8'));
_tz=()=>'Asia/Kolkata';
_nowIso=()=>'2026-08-10T12:00:00';

/* ---- the in-memory sheet ---- */
let TL, appended, statusUpserts;
function mk(hdr,rows){ return [hdr.slice()].concat(rows.map(r=>hdr.map(h=>r[h]===undefined?'':r[h]))); }
function reset(rows){
  TL=mk(TL_HDR,rows); appended=[]; statusUpserts=[];
}
_ctx=function(tab){
  const idx={}; TL[0].forEach((h,i)=>{ if(h) idx[h]=i; });
  return {sh:{name:tab},values:TL,headerRow:0,headers:TL[0],idx};
};
_setCell=function(ctx,r,col,v){ const ci=ctx.idx[col]; if(ci!==undefined) ctx.values[r][ci]=v; };
_appendByHeaders=function(tab,key,dict){ appended.push({tab:tab,d:dict}); };
_upsertStatusView=function(o){ statusUpserts.push(o); };
_readTab=function(t){ return (t==='Contract_Vehicles')?CV:[]; };

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
function cell(tid,col){
  const idx={}; TL[0].forEach((h,i)=>{ if(h) idx[h]=i; });
  for(let i=1;i<TL.length;i++) if(String(TL[i][idx['trip_id']])===tid) return TL[i][idx[col]];
  return undefined;
}
function gcl(tid){ return appended.filter(a=>a.tab===LOG_TABS.ground && a.d.trip_id===tid)[0]; }

/* ==================================================================================================
 * 1. transferReadyTrips — the ground window
 * ================================================================================================= */
console.log('── 1. transferReadyTrips: the ground window ──');
/* the deadline is trip_end_time + GROUND_WINDOW_HOURS. A trip still inside it must NOT transfer, and
   the derived deadline must be PERSISTED so the next run is not recomputing from scratch. */
reset([
  {trip_id:'T-INSIDE', row_id:'R1', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular', trip_end_time:'2026-08-10T11:00:00'},
  {trip_id:'T-PAST',   row_id:'R2', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular', trip_end_time:'2026-08-01T09:00:00'},
  {trip_id:'T-NOEND',  row_id:'R3', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular'},
  {trip_id:'T-ALREADY',row_id:'R4', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular', trip_end_time:'2026-08-01T09:00:00',
   sent_to_vendor_flag:'Yes'},
  {trip_id:'',         row_id:'R5', transporter_oracle_id:'ORC-1'},          // blank id: skipped entirely
]);
const _origDate=global.Date;
function freeze(d){ const F=function(...a){ return a.length?new _origDate(...a):new _origDate(d); };
  F.prototype=_origDate.prototype; F.now=()=>new _origDate(d).getTime();
  F.parse=_origDate.parse; F.UTC=_origDate.UTC; global.Date=F; }
function unfreeze(){ global.Date=_origDate; }
freeze('2026-08-10T12:00:00+05:30');
let msg=transferReadyTrips();
unfreeze();
console.log('  '+msg);
console.log('  GROUND_WINDOW_HOURS='+GROUND_WINDOW_HOURS+'  DISPUTE_WINDOW_DAYS='+DISPUTE_WINDOW_DAYS);
console.log('  T-INSIDE flag='+JSON.stringify(cell('T-INSIDE','sent_to_vendor_flag'))
  +' deadline='+JSON.stringify(cell('T-INSIDE','ground_review_deadline')));
/* of the 5 rows, exactly ONE is eligible: T-PAST. T-INSIDE is inside its window, T-NOEND has no
   completion time, T-ALREADY is already flagged, and the blank trip_id row is skipped outright. */
ck(/Transferred 1 trip\(s\)/.test(msg),'exactly the 1 eligible trip of 5 transferred — '+msg);
ck(cell('T-INSIDE','sent_to_vendor_flag')==='','a trip still inside the ground window does NOT transfer');
ck(String(cell('T-INSIDE','ground_review_deadline')).length>0,
   'but its derived ground_review_deadline is PERSISTED for the next run');
ck(cell('T-PAST','sent_to_vendor_flag')==='Yes','a trip past its ground window DOES transfer');
ck(cell('T-NOEND','sent_to_vendor_flag')==='','a trip with no trip_end_time cannot transfer (no deadline)');
ck(cell('T-NOEND','ground_review_deadline')==='','and no deadline is invented for it');
ck(!gcl('T-ALREADY'),'an already-transferred trip is skipped, not logged twice');
/* the transfer must open the vendor's window and default the status, or the vendor sees no buttons */
ck(cell('T-PAST','vendor_status')==='Pending','the transfer defaults vendor_status to Pending');
ck(String(cell('T-PAST','dispute_window_end')).length>0,'and opens a dispute_window_end');
ck(String(cell('T-PAST','sent_to_vendor_timestamp')).length>0,'and stamps sent_to_vendor_timestamp');
/* the ordering promise: the ground log is written BEFORE the flag, so a log failure is retryable */
ck(!!gcl('T-PAST'),'a Ground_Confirmation_Log row is appended for the transferred trip');
ck(gcl('T-PAST').d.ground_action_state==='NO_GROUND_ACTION',
   'with state NO_GROUND_ACTION when ground did nothing (got '+gcl('T-PAST').d.ground_action_state+')');

console.log('\n── 2. transferReadyTrips: an existing deadline is respected, not recomputed ──');
reset([
  {trip_id:'T-DLSET', row_id:'R1', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular',
   trip_end_time:'2026-08-01T09:00:00',                     // long past
   ground_review_deadline:'2026-12-31T00:00:00'},           // but ground says: not yet
]);
freeze('2026-08-10T12:00:00+05:30'); transferReadyTrips(); unfreeze();
ck(cell('T-DLSET','sent_to_vendor_flag')==='',
   'an explicit ground_review_deadline in the future blocks the transfer even if trip_end_time is old');
ck(cell('T-DLSET','ground_review_deadline')==='2026-12-31T00:00:00',
   'and the engine-set deadline is left exactly as written');

/* ==================================================================================================
 * 3. ZONAL_NOT_EDITABLE — ground cannot reclassify a zonal trip
 * ================================================================================================= */
console.log('\n── 3. ZONAL_NOT_EDITABLE ──');
reset([
  {trip_id:'T-Z1', row_id:'RZ1', transporter_oracle_id:'ORC-1', route_scope:'Zonal',
   rfq_id:'FM-Zonal-REB-RFQ-0005', billing_type_system:'Regular', zonal_rfq_amount:5300,
   vehicle_number:'GJ99ZZ9999',                              // not a contract default, by design
   billing_type_final:'Adhoc',                               // <-- a ground edit that must be cleared
   replaced_default_vehicle_final:'GJ01AA0001',              // <-- and so must this
   trip_end_time:'2026-08-01T09:00:00'},
  {trip_id:'T-Z2', row_id:'RZ2', transporter_oracle_id:'ORC-1', route_scope:'Zonal',
   billing_type_system:'Adhoc', adhoc_amount:6100, vehicle_number:'GJ99ZZ9998',
   trip_end_time:'2026-08-01T09:00:00'},                     // clean zonal adhoc, no RFQ — normal
]);
freeze('2026-08-10T12:00:00+05:30'); transferReadyTrips(); unfreeze();
const z1=gcl('T-Z1'), z2=gcl('T-Z2');
console.log('  T-Z1 state='+z1.d.ground_action_state+'  partial='+z1.d.partial_edit_flag);
console.log('  T-Z1 data_sent: '+String(z1.d.data_sent).slice(0,110)+'…');
console.log('  T-Z2 state='+z2.d.ground_action_state+'  contract_id logged as '+JSON.stringify(z2.d.contract_id));
ck(cell('T-Z1','billing_type_final')==='','a ground billing_type_final is CLEARED on a zonal trip');
ck(cell('T-Z1','replaced_default_vehicle_final')==='','and so is replaced_default_vehicle_final');
ck(z1.d.ground_action_state==='ZONAL_NOT_EDITABLE','the log state is ZONAL_NOT_EDITABLE');
ck(/FM-Zonal-REB-RFQ-0005/.test(z1.d.data_sent),'and the message names the RFQ, since there is no contract_id');
ck(z1.d.partial_edit_flag==='Yes','the row is flagged as a partial edit so ops can find it');
ck(cell('T-Z1','sent_to_vendor_flag')==='Yes','the trip still TRANSFERS — the edit is dropped, not the trip');
/* the guard order matters: zonal must be exempt from the reclassification bounce, or every zonal
   trip would be stamped NEEDS_ATTRIBUTION_FIX because zonal vehicles are never contract defaults. */
ck(z1.d.ground_action_state!=='NEEDS_ATTRIBUTION_FIX',
   'zonal is EXEMPT from the reclassification guard (it would otherwise bounce every zonal trip)');
ck(z2.d.ground_action_state==='NO_GROUND_ACTION','a clean zonal trip is not flagged at all');
ck(z2.d.contract_id==='Zonal adhoc','a zonal ADHOC trip logs its reference as "Zonal adhoc", not as an error');
ck(z1.d.contract_id==='FM-Zonal-REB-RFQ-0005','a zonal REGULAR trip logs its RFQ id as the reference');
ck(z1.d.route_scope==='Zonal','route_scope travels with it so ops can tell the two apart');

/* ==================================================================================================
 * 4. a hand-typed billing_type_resolved is cleared, on BOTH scopes
 * ================================================================================================= */
console.log('\n── 4. the hand-typed billing_type_resolved clear ──');
reset([
  {trip_id:'T-HAND-L', row_id:'RH1', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ01AA0001', billing_type_system:'Regular', billing_type_resolved:'Adhoc',
   adhoc_amount:9999, trip_end_time:'2026-08-01T09:00:00'},
  {trip_id:'T-HAND-Z', row_id:'RH2', transporter_oracle_id:'ORC-1', route_scope:'Zonal',
   rfq_id:'R1', billing_type_system:'Regular', billing_type_resolved:'Adhoc', adhoc_amount:9999,
   zonal_rfq_amount:5300, vehicle_number:'GJ99ZZ0001', trip_end_time:'2026-08-01T09:00:00'},
]);
freeze('2026-08-10T12:00:00+05:30'); transferReadyTrips(); unfreeze();
console.log('  local: '+JSON.stringify(cell('T-HAND-L','billing_type_resolved'))
  +'   zonal: '+JSON.stringify(cell('T-HAND-Z','billing_type_resolved')));
ck(cell('T-HAND-L','billing_type_resolved')==='',
   'a hand-typed billing_type_resolved is cleared on a LOCAL trip that has never been sent');
ck(cell('T-HAND-Z','billing_type_resolved')==='','and on a ZONAL one');
ck(/CLEARED a hand-typed billing_type_resolved/.test(gcl('T-HAND-L').d.data_sent),
   'the local ground log says so');
ck(/CLEARED a hand-typed billing_type_resolved/.test(gcl('T-HAND-Z').d.data_sent),
   'and so does the zonal one');
ck(gcl('T-HAND-L').d.partial_edit_flag==='Yes','and the row is flagged');
/* WHY this matters: billing_type_resolved outranks everything. Left in place, someone could pay a
   trip ₹9,999 by typing in a cell, with no dispute and no resolution behind it. */
ck(_classifyTrip({billing_type_system:'Regular',billing_type_resolved:'',adhoc_amount:9999,
   challan_type:'Forward Only',total_trip_km:120},{},'Regular').payable===0,
   'with the cell cleared, the ₹9,999 is not payable — which is the point of the guard');

/* ==================================================================================================
 * 5. the incomplete-reclassification bounce (LOCAL only)
 * ================================================================================================= */
console.log('\n── 5. incomplete reclassification on a local trip ──');
reset([
  // ground says Regular on a NON-default vehicle with NO valid replaced-default mapping -> incomplete
  {trip_id:'T-BAD', row_id:'RB1', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ02BB0001',                       // a default of RJK10-Y, not of RJK7-X
   billing_type_system:'Adhoc', billing_type_final:'Regular',
   trip_end_time:'2026-08-01T09:00:00'},
  // same, but WITH a valid mapping -> the edit stands
  {trip_id:'T-OK', row_id:'RB2', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
   vehicle_number:'GJ77XX7777', billing_type_system:'Adhoc', billing_type_final:'Regular',
   replaced_default_vehicle_final:'GJ01AA0002',        // IS a default of RJK7-X
   trip_end_time:'2026-08-01T09:00:00'},
  // Regular on an ADHOC-bucket contract -> the fix is the contract_id, not the billing type
  {trip_id:'T-BUCKET', row_id:'RB3', transporter_oracle_id:'ORC-1', contract_id:'ADHOC-ORC-1',
   vehicle_number:'GJ02BB0001', billing_type_system:'Adhoc', billing_type_final:'Regular',
   trip_end_time:'2026-08-01T09:00:00'},
]);
freeze('2026-08-10T12:00:00+05:30'); transferReadyTrips(); unfreeze();
console.log('  T-BAD    '+gcl('T-BAD').d.ground_action_state+' — '+String(gcl('T-BAD').d.data_sent).slice(0,90));
console.log('  T-OK     '+gcl('T-OK').d.ground_action_state+'  billing_after='+gcl('T-OK').d.billing_after);
console.log('  T-BUCKET '+gcl('T-BUCKET').d.ground_action_state);
ck(cell('T-BAD','billing_type_final')==='','an incomplete Regular reclassification is discarded');
ck(gcl('T-BAD').d.ground_action_state==='NEEDS_ATTRIBUTION_FIX',
   'and flagged NEEDS_ATTRIBUTION_FIX, because the vehicle belongs to another contract');
ck(/GJ02BB0001 is a default of RJK10-Y/.test(gcl('T-BAD').d.data_sent),
   'the message names the contract the vehicle actually belongs to, so the fix is obvious');
ck(cell('T-OK','billing_type_final')==='Regular','a COMPLETE reclassification is kept');
ck(gcl('T-OK').d.ground_action_state==='NO_GROUND_ACTION','and not flagged');
ck(gcl('T-OK').d.billing_after==='Regular','the ground log records the after-state');
ck(gcl('T-BUCKET').d.ground_action_state==='NEEDS_ATTRIBUTION_FIX',
   'Regular on an ADHOC-bucket contract is an attribution problem, not a billing one');
ck(cell('T-BAD','sent_to_vendor_flag')==='Yes','a bounced edit still lets the trip transfer');

/* ==================================================================================================
 * 6. applyConfirm — ownership and locking
 * ================================================================================================= */
console.log('\n── 6. applyConfirm guards ──');
function seedForVendor(){
  reset([
    {trip_id:'C-PEND',   row_id:'S1', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
     vendor_status:'Pending', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-20T00:00:00'},
    {trip_id:'C-CONF',   row_id:'S2', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
     vendor_status:'Confirmed', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-20T00:00:00'},
    {trip_id:'C-DISP',   row_id:'S3', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
     vendor_status:'Disputed', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-20T00:00:00'},
    {trip_id:'C-RECONF', row_id:'S4', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
     vendor_status:'Reconfirm', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-01T00:00:00'},
    {trip_id:'C-OTHER',  row_id:'S5', transporter_oracle_id:'ORC-9', contract_id:'RJK9-Z',
     vendor_status:'Pending', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-20T00:00:00'},
    {trip_id:'C-ZONAL',  row_id:'S6', transporter_oracle_id:'ORC-1', route_scope:'Zonal',
     rfq_id:'FM-Zonal-RDB-RFQ-0003', vendor_status:'Pending', sent_to_vendor_flag:'Yes',
     dispute_window_end:'2026-08-20T00:00:00'},
  ]);
}
seedForVendor();
let n=applyConfirm({oracle:'ORC-1',trip_ids:['C-PEND','C-CONF','C-DISP','C-RECONF','C-OTHER','C-NOSUCH','C-ZONAL']});
console.log('  applyConfirm returned '+n+' (of 7 ids offered)');
['C-PEND','C-CONF','C-DISP','C-RECONF','C-OTHER','C-ZONAL'].forEach(t=>
  console.log('    '+t.padEnd(10)+cell(t,'vendor_status')));
ck(n===3,'applyConfirm confirmed exactly the 3 eligible trips (returned '+n+')');
ck(cell('C-PEND','vendor_status')==='Confirmed','a Pending trip confirms');
ck(cell('C-ZONAL','vendor_status')==='Confirmed','a Pending ZONAL trip confirms the same way');
ck(cell('C-CONF','vendor_status')==='Confirmed','an already-Confirmed trip is untouched (locked)');
ck(cell('C-DISP','vendor_status')==='Disputed','a Disputed trip cannot be confirmed away (locked)');
ck(cell('C-RECONF','vendor_status')==='Reconfirmed',
   'a Reconfirm trip becomes Reconfirmed, not Confirmed — the resolution is accepted');
ck(cell('C-OTHER','vendor_status')==='Pending','another vendor\'s trip is NOT touched (ownership)');
ck(statusUpserts.filter(o=>o.trip_id==='C-OTHER').length===0,'and it is not even logged');
ck(statusUpserts.filter(o=>o.trip_id==='C-RECONF')[0].reconfirm_status==='Reconfirmed',
   'the status view records reconfirm_status on the Reconfirmed trip');
ck(statusUpserts.filter(o=>o.trip_id==='C-ZONAL')[0].contract_id==='FM-Zonal-RDB-RFQ-0003',
   'the zonal confirmation logs its RFQ id as the billing reference');
ck(statusUpserts.filter(o=>o.trip_id==='C-ZONAL')[0].route_scope==='Zonal','with route_scope=Zonal alongside');
/* a confirm on a trip that was never transferred: the panel can never show it, but the API is public,
   so the ownership + status guards are what stand between it and a silent write. */
ck(applyConfirm({oracle:'ORC-1',trip_ids:['C-NOSUCH']})===0,'an unknown trip_id confirms nothing');
ck(applyConfirm({oracle:'',trip_ids:['C-PEND']})===0,'a blank oracle confirms nothing (ownership)');

/* ==================================================================================================
 * 7. applyDispute — ownership, locking, the closed window, re-dispute
 * ================================================================================================= */
console.log('\n── 7. applyDispute guards ──');
seedForVendor();
freeze('2026-08-10T12:00:00+05:30');
const dOK=applyDispute({oracle:'ORC-1',trip_id:'C-PEND',categories:['value'],claim_km:180,
  vendor_description:'ran 180',claim_challan_type:''});
const dOwn=applyDispute({oracle:'ORC-1',trip_id:'C-OTHER',categories:['value'],claim_km:99});
const dLock=applyDispute({oracle:'ORC-1',trip_id:'C-CONF',categories:['value'],claim_km:99});
const dDisp=applyDispute({oracle:'ORC-1',trip_id:'C-DISP',categories:['value'],claim_km:99});
const dNone=applyDispute({oracle:'ORC-1',trip_id:'C-NOSUCH',categories:['value'],claim_km:99});
const dRe=applyDispute({oracle:'ORC-1',trip_id:'C-RECONF',categories:['value'],claim_km:99});
unfreeze();
console.log('  pending='+dOK+' otherVendor='+dOwn+' confirmed='+dLock+' disputed='+dDisp
  +' unknown='+dNone+' reconfirm='+dRe);
ck(dOK===1,'a Pending trip inside its window CAN be disputed');
ck(cell('C-PEND','vendor_status')==='Disputed','and Trip_Level moves to Disputed');
ck(dOwn===0,'another vendor cannot dispute a trip (ownership)');
ck(cell('C-OTHER','vendor_status')==='Pending','and that trip is unchanged');
ck(dLock===0,'a Confirmed trip cannot be disputed (locked)');
ck(dDisp===0,'an already-Disputed trip cannot be disputed twice (locked)');
ck(dNone===0,'an unknown trip_id disputes nothing');
ck(dRe===1,'a Reconfirm trip CAN be re-disputed');
const reRow=appended.filter(a=>a.tab===LOG_TABS.disputes && a.d.trip_id==='C-RECONF')[0];
ck(reRow && reRow.d.reconfirm_status==='Re-disputed','and the row is marked Re-disputed');
ck(reRow && reRow.d.dispute_status==='Open','with dispute_status Open, so ops picks it up');
/* the window gate — and the exemption that makes re-dispute possible at all. C-RECONF's window
   closed on 1 Aug, and it still went through above, which is the whole point. */
console.log('  (C-RECONF\'s window closed 2026-08-01 and the re-dispute still went through — by design)');
reset([{trip_id:'C-LATE', row_id:'S7', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
        vendor_status:'Pending', sent_to_vendor_flag:'Yes', dispute_window_end:'2026-08-01T00:00:00'}]);
freeze('2026-08-10T12:00:00+05:30');
let threw='';
try{ applyDispute({oracle:'ORC-1',trip_id:'C-LATE',categories:['value'],claim_km:99}); }
catch(e){ threw=String(e.message||e); }
unfreeze();
console.log('  closed-window dispute -> '+(threw||'*** NO ERROR ***'));
ck(/dispute window closed/.test(threw),'disputing after the window THROWS, so the vendor sees an error');
ck(cell('C-LATE','vendor_status')==='Pending','and nothing is written');
ck(appended.filter(a=>a.tab===LOG_TABS.disputes).length===0,'and no dispute row is created');
/* a trip with NO window set must still be disputable — a blank window is "not yet closed", not "closed" */
reset([{trip_id:'C-NOWIN', row_id:'S8', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
        vendor_status:'Pending', sent_to_vendor_flag:'Yes'}]);
freeze('2026-08-10T12:00:00+05:30');
const dNoWin=applyDispute({oracle:'ORC-1',trip_id:'C-NOWIN',categories:['value'],claim_km:120});
unfreeze();
ck(dNoWin===1,'a blank dispute_window_end does NOT lock the vendor out (blank = open)');

/* ==================================================================================================
 * 8. the dispute row carries the full claim + snapshot — the shape ops resolves from
 * ================================================================================================= */
console.log('\n── 8. what the dispute row actually captures ──');
reset([{trip_id:'D-Z', row_id:'SZ', transporter_oracle_id:'ORC-1', route_scope:'Zonal',
        rfq_id:'FM-Zonal-REB-RFQ-0005', billing_type_system:'Regular', zonal_rfq_amount:5300,
        vehicle_number:'GJ99ZZ1', vehicle_size:'7ft', source_node:'RJK', dest_fmh_nodes:'MOR,JMN',
        challan_type:'RTO only', vendor_status:'Pending', sent_to_vendor_flag:'Yes',
        dispute_window_end:'2026-08-20T00:00:00'}]);
freeze('2026-08-10T12:00:00+05:30');
applyDispute({oracle:'ORC-1',trip_id:'D-Z',vendor_name:'Krushiv',categories:['value','rfq'],
  claim_zonal_amount:5500, claim_rfq_id:'FM-Zonal-REB-RFQ-0009', claim_challan_type:'Forward Only',
  vendor_description:'ran forward, amount short', proof_url:'http://x/p.jpg', callback_number:'9999'});
unfreeze();
const dr=appended.filter(a=>a.tab===LOG_TABS.disputes)[0].d;
console.log('  claim_zonal_amount='+dr.claim_zonal_amount+'  claim_rfq_id='+dr.claim_rfq_id
  +'  claim_challan_type='+dr.claim_challan_type);
console.log('  orig_zonal_rfq_amount='+dr.orig_zonal_rfq_amount+'  orig_challan_type='+dr.orig_challan_type
  +'  orig_route='+dr.orig_route);
ck(String(dr.claim_zonal_amount)==='5500','the claimed zonal amount reaches the log (the ₹5,500 bug)');
ck(dr.claim_rfq_id==='FM-Zonal-REB-RFQ-0009','so does the claimed RFQ id');
ck(dr.claim_challan_type==='Forward Only','so does claim_challan_type — the only lever that lifts an RTO');
ck(String(dr.orig_zonal_rfq_amount)==='5300','the ORIGINAL amount is snapshotted, so ops sees was-vs-claimed');
ck(dr.orig_challan_type==='RTO only','and the original challan, so ops knows it was an RTO');
ck(dr.orig_route_scope==='Zonal','the snapshot records the scope');
ck(dr.orig_rfq_id==='FM-Zonal-REB-RFQ-0005','and the original RFQ');
ck(dr.contract_id==='FM-Zonal-REB-RFQ-0005','and the row is keyed on the RFQ, since zonal has no contract_id');
ck(dr.orig_route==='RJK > MOR > JMN','the route is rebuilt for the card');
ck(dr.categories==='value|rfq','categories are pipe-joined');
ck(dr.dispute_status==='Open','and it lands Open');
/* an empty claim must stay empty, not become 0 — a 0 claim is a claim of zero, which is a real number */
reset([{trip_id:'D-E', row_id:'SE', transporter_oracle_id:'ORC-1', contract_id:'RJK7-X',
        vendor_status:'Pending', sent_to_vendor_flag:'Yes'}]);
freeze('2026-08-10T12:00:00+05:30');
applyDispute({oracle:'ORC-1',trip_id:'D-E',categories:['billing'],claim_billing_type:'Adhoc'});
unfreeze();
const de=appended.filter(a=>a.tab===LOG_TABS.disputes)[0].d;
ck(de.claim_km==='','an unfilled claim_km stays blank, it does not become 0');
ck(de.claim_amount==='','and so does claim_amount');
ck(de.claim_zonal_amount==='','and claim_zonal_amount');
ck(de.claim_billing_type==='Adhoc','while the claim that WAS made is recorded');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
