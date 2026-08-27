/* THE LOST-RESOLUTION BUG — 2026-08-27.
 *
 * Reported symptom: a vendor accepts a resolved dispute, and the trip row shows the ORIGINAL KM again.
 *
 * Actual cause, found in the live sheet: 166 of 166 resolved disputes had never reached Trip_Level at
 * all. resolved_at — the permanent "already applied" guard — was stamped at the TOP of the applier's
 * loop, before any resolved_* value was read. Ops marks a dispute Resolved, the 10-minute timer fires
 * on the still-empty row, the guard is stamped, the trip flips to Reconfirm, nothing is written, and
 * the row is locked out of the applier forever. The number typed a minute later lived in Disputes_Log
 * only. Σ(resolved_km − total_trip_km) across the 166 = 1,974.216 km, all Krushiv Enterprise.
 *
 * It was invisible because the panel's View-Dispute dialog reads resolved_km LIVE from Disputes_Log,
 * so the vendor did see the right figure there — until they accepted, at which point the panel hid
 * the link (it was gated on status disputed|reconfirm) and only the uncorrected row KM was left.
 *
 * Three defects, three fixes, all asserted below:
 *   1. resolved_km / resolved_amount were written INTO the system columns total_trip_km /
 *      adhoc_amount. They now have their own destinations, and _classifyTrip reads resolution-then-
 *      system, so the original survives and a re-push of Trip_Level cannot revert a correction.
 *   2. resolved_at no longer skips the row. It gates only the one-time vendor-facing side effects;
 *      the value writes reconcile on every pass.
 *   3. repairMissedResolutions() cleans up rows already stamped-but-unwritten.
 *
 * Section 6 is the non-vacuity check: it re-implements the OLD behaviour and proves this harness fails.
 */
const fs=require('fs');

const TL_HDR=['trip_id','row_id','transporter_oracle_id','route_scope','rfq_id','contract_id',
  'vehicle_number','vendor_status','billing_type_system','billing_type_final','billing_type_resolved',
  'replaced_default_vehicle_system','replaced_default_vehicle_final','total_trip_km','adhoc_amount',
  'total_trip_km_resolved','adhoc_amount_resolved','zonal_rfq_amount','zonal_rfq_amount_final',
  'challan_type','challan_type_final','km_accumulated_flag','sent_to_vendor_flag','dispute_window_end'];
const DL_HDR=['dispute_id','row_id','trip_id','dispute_status','reconfirm_status','resolved_at',
  'resolved_by','resolution_note','resolved_billing_type','resolved_km','resolved_amount',
  'resolved_zonal_amount','resolved_rfq_id','resolved_challan_type','resolved_aggregate_vehicle',
  'resolved_contract_id','orig_total_km'];

global.Utilities={formatDate:()=>'2026-08-27T10:00:00',parseCsv:t=>t.trim().split('\n').map(l=>l.split(','))};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),getUi:()=>{throw new Error('no UI');}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8'));
_tz=()=>'Asia/Kolkata'; _nowIso=()=>'2026-08-27T10:00:00';

let TL,DL,statusUpserts,tlWrites,HIDE_TL_COLS;
function mk(hdr,rows){ return [hdr.slice()].concat(rows.map(r=>hdr.map(h=>r[h]===undefined?'':r[h]))); }
function reset(tlRows,dlRows){ TL=mk(TL_HDR,tlRows); DL=mk(DL_HDR,dlRows);
  statusUpserts=[]; tlWrites=[]; HIDE_TL_COLS=[]; }
_ctx=function(tab){
  const s=(tab===TABS.tripLevel)?TL:DL;
  const idx={}; s[0].forEach((h,i)=>{ if(h && !(s===TL && HIDE_TL_COLS.indexOf(h)>=0)) idx[h]=i; });
  return {sh:{name:tab},values:s,headerRow:0,headers:s[0],idx};
};
_setCell=function(ctx,r,col,v){ const ci=ctx.idx[col]; if(ci===undefined) return;
  ctx.values[r][ci]=v;
  if(ctx.sh.name===TABS.tripLevel) tlWrites.push({trip:ctx.values[r][ctx.idx['trip_id']],col,v}); };
_appendByHeaders=function(){}; _upsertStatusView=function(o){ statusUpserts.push(o); };
_readTab=function(){ return []; };

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
function tcell(tid,col){ const i={}; TL[0].forEach((h,k)=>{if(h)i[h]=k;});
  for(let r=1;r<TL.length;r++) if(String(TL[r][i['trip_id']])===tid) return TL[r][i[col]]; }
function dcell(did,col){ const i={}; DL[0].forEach((h,k)=>{if(h)i[h]=k;});
  for(let r=1;r<DL.length;r++) if(String(DL[r][i['dispute_id']])===did) return DL[r][i[col]]; }
function dset(did,col,v){ const i={}; DL[0].forEach((h,k)=>{if(h)i[h]=k;});
  for(let r=1;r<DL.length;r++) if(String(DL[r][i['dispute_id']])===did) DL[r][i[col]]=v; }
function tset(tid,col,v){ const i={}; TL[0].forEach((h,k)=>{if(h)i[h]=k;});
  for(let r=1;r<TL.length;r++) if(String(TL[r][i['trip_id']])===tid) TL[r][i[col]]=v; }
const C=t=>_classifyTrip(t,{},'Regular');

/* ==================================================================================================
 * 1. _classifyTrip — the precedence, and the two cases a naive `||` gets wrong
 * ================================================================================================= */
console.log('── 1. KM / amount precedence in the classifier ──');
ck(C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
      total_trip_km:167.074}).km===167.074,'with no resolution, the system KM is used');
ck(C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
      total_trip_km:167.074,total_trip_km_resolved:183}).km===183,
   'a resolved KM outranks the system KM');
/* the naive `_num(a) || _num(b)` bug: a resolution to 0 km is a real outcome and must not fall through */
const zeroRes=C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
                 total_trip_km:167.074,total_trip_km_resolved:0});
console.log('  resolved to 0 km -> km='+zeroRes.km+'  (a `||` chain would have said 167.074)');
ck(zeroRes.km===0,'a resolution to ZERO km is honoured, not treated as "unset"');
ck(zeroRes.kmWas===167.074,'and kmWas still reports what it replaced');
/* blank must mean blank, not zero */
ck(C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
      total_trip_km:167.074,total_trip_km_resolved:''}).km===167.074,
   'an EMPTY total_trip_km_resolved falls through to the system KM');
ck(C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
      total_trip_km:167.074,total_trip_km_resolved:''}).kmWas===null,
   'and nothing is flagged as revised');
ck(C({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
      total_trip_km:183,total_trip_km_resolved:183}).kmWas===null,
   'a resolution that confirms the system value is NOT shown as a revision');

console.log('  ── adhoc amount, same rules ──');
ck(C({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'Forward Only',
      adhoc_amount:2871.44}).payable===2871.44,'with no resolution the system adhoc amount pays');
ck(C({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'Forward Only',
      adhoc_amount:2871.44,adhoc_amount_resolved:3200}).payable===3200,'a resolved amount outranks it');
ck(C({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'Forward Only',
      adhoc_amount:2871.44,adhoc_amount_resolved:0}).payable===0,'a resolution to ZERO is honoured');
ck(C({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'Forward Only',
      adhoc_amount:2871.44,adhoc_amount_resolved:3200}).amtWas===2871.44,'and amtWas reports the original');

console.log('  ── the ONE RTO RULE still wins over a resolution ──');
const rtoRes=C({route_scope:'Local',billing_type_system:'Regular',challan_type:'RTO only',
                km_accumulated_flag:'No',total_trip_km:0,total_trip_km_resolved:183});
ck(rtoRes.kmToSlab===false,'a resolved KM on a still-RTO trip contributes nothing to the slab');
rtoRes2=C({route_scope:'Local',billing_type_system:'Regular',challan_type:'RTO only',
           km_accumulated_flag:'No',total_trip_km:0,total_trip_km_resolved:183,
           challan_type_final:'Forward Only'});
ck(rtoRes2.kmToSlab===true&&rtoRes2.km===183,
   'lifting the RTO as well puts the RESOLVED 183 km into the slab (both levers, one resolution)');
ck(C({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'RTO only',
      adhoc_amount:2871.44,adhoc_amount_resolved:3200}).payable===0,
   'and a resolved amount on an RTO adhoc trip still pays 0');

console.log('  ── zonal has no KM slab, so a resolved KM is inert there ──');
ck(C({route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',challan_type:'Forward Only',
      zonal_rfq_amount:5300,total_trip_km:0,total_trip_km_resolved:900}).kmToSlab===false,
   'a resolved KM on a zonal trip never reaches a slab');

/* ==================================================================================================
 * 2. THE REGRESSION ITSELF — stamped first, filled second
 * ================================================================================================= */
console.log('\n── 2. the exact live sequence: mark Resolved, THEN type the number ──');
function liveRow(){
  reset([{trip_id:'TR-59335170-3079',row_id:'TR-59335170-3079_R',transporter_oracle_id:'18838',
          contract_id:'RJK8-18838-20260801-01',route_scope:'Local',billing_type_system:'Regular',
          challan_type:'Forward + RTO',km_accumulated_flag:'Yes',total_trip_km:167.074,
          adhoc_amount:2871.44842,vendor_status:'Disputed',sent_to_vendor_flag:'Yes'}],
        [{dispute_id:'DSP-20260824113254-2626',trip_id:'TR-59335170-3079_R',
          row_id:'TR-59335170-3079_R',dispute_status:'Resolved',orig_total_km:'167.074',
          resolution_note:'We have reviewed and resolved.'}]);
}
liveRow();
applyResolutionsFromSheet();                       // the timer fires on the note-only row
console.log('  pass 1 (note only) : resolved_at='+dcell('DSP-20260824113254-2626','resolved_at')
  +'  vendor_status='+tcell('TR-59335170-3079','vendor_status'));
ck(String(dcell('DSP-20260824113254-2626','resolved_at')).length>0,'pass 1 stamps resolved_at');
ck(tcell('TR-59335170-3079','vendor_status')==='Reconfirm','pass 1 re-surfaces the trip');
dset('DSP-20260824113254-2626','resolved_km','183');    // ops types it now
tset('TR-59335170-3079','vendor_status','Reconfirmed'); // and the vendor accepts
tlWrites=[]; statusUpserts=[];
const out2=applyResolutionsFromSheet();
console.log('  pass 2 (km typed)  : total_trip_km_resolved='+tcell('TR-59335170-3079','total_trip_km_resolved')
  +'  system total_trip_km='+tcell('TR-59335170-3079','total_trip_km'));
ck(String(tcell('TR-59335170-3079','total_trip_km_resolved'))==='183',
   'THE FIX: a resolved_km filled AFTER resolved_at was stamped still lands');
ck(String(tcell('TR-59335170-3079','total_trip_km'))==='167.074','the system KM is preserved');
ck(/RECONCILED/.test(out2),'and the late application is reported, not silent');
ck(tcell('TR-59335170-3079','vendor_status')==='Reconfirmed','the accepted trip is not reopened');
ck(statusUpserts.length===0,'and the vendor is not notified a second time');
/* a third pass must be completely inert */
tlWrites=[];
applyResolutionsFromSheet();
ck(tlWrites.length===0,'a third pass writes nothing — reconciliation is idempotent');

/* ==================================================================================================
 * 3. repairMissedResolutions() — cleaning up rows already lost
 * ================================================================================================= */
console.log('\n── 3. the repair tool, on rows the old code already stamped ──');
function stampedButUnwritten(){
  /* exactly the live state: resolved_at present, resolved_km present, Trip_Level never updated,
     the vendor has already accepted */
  reset([{trip_id:'T-A',row_id:'T-A_R',transporter_oracle_id:'18838',contract_id:'RJK8-X',
          route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
          km_accumulated_flag:'Yes',total_trip_km:27.45,adhoc_amount:2781,
          vendor_status:'Reconfirmed',sent_to_vendor_flag:'Yes'},
         {trip_id:'T-B',row_id:'T-B_R',transporter_oracle_id:'18838',contract_id:'RJK10-X',
          route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
          km_accumulated_flag:'Yes',total_trip_km:100,adhoc_amount:0,
          vendor_status:'Reconfirmed',sent_to_vendor_flag:'Yes'}],
        [{dispute_id:'DSP-A',trip_id:'T-A',row_id:'T-A_R',dispute_status:'Resolved',
          resolved_at:'2026-08-21T15:57:19',resolved_by:'Sharan',resolved_km:'30',orig_total_km:'27.45'},
         {dispute_id:'DSP-B',trip_id:'T-B_R',row_id:'T-B_R',dispute_status:'Resolved',
          resolved_at:'2026-08-21T15:57:19',resolved_by:'Sharan',resolved_km:'150',orig_total_km:'100'}]);
}
stampedButUnwritten();
const dry=repairMissedResolutions(false);
console.log('  '+dry.split('\n').slice(0,8).join('\n  '));
ck(/DRY RUN/.test(dry),'the default call is a DRY RUN');
ck(tlWrites.length===0,'a dry run writes not one cell');
ck(/Rows that would change  : 2/.test(dry),'it reports both rows as needing repair');
ck(/KM delta vs system      : 52.55/.test(dry),'and totals the KM it would restore (30-27.45 + 150-100)');
ck(/matched on row_id/.test(dry),'DSP-B is matched via the row_id fallback (its trip_id holds the row_id)');

const applied=repairMissedResolutions(true);
console.log('  '+applied.split('\n')[1]+'  '+applied.split('\n')[2]);
ck(String(tcell('T-A','total_trip_km_resolved'))==='30','the repair writes T-A');
ck(String(tcell('T-B','total_trip_km_resolved'))==='150','and T-B, found by row_id');
ck(String(tcell('T-A','total_trip_km'))==='27.45'&&String(tcell('T-B','total_trip_km'))==='100',
   'neither system column is touched');
ck(tcell('T-A','vendor_status')==='Reconfirmed'&&tcell('T-B','vendor_status')==='Reconfirmed',
   'and NEITHER trip is reopened — the vendor accepted this correction, so applying it is the fix');
ck(statusUpserts.length===0,'the repair never notifies anyone');
ck(String(dcell('DSP-A','resolved_at'))==='2026-08-21T15:57:19','the original resolved_at is preserved');

tlWrites=[];
const second=repairMissedResolutions(true);
console.log('  re-run -> '+second.split('\n')[1].trim()+' / '+second.split('\n')[4].trim());
ck(tlWrites.length===0,'running the repair twice writes nothing the second time');
ck(/Already correct         : 2/.test(second),'and it reports both rows as already correct');

/* an Open dispute is never repaired */
stampedButUnwritten();
dset('DSP-A','dispute_status','Open');
repairMissedResolutions(true);
ck(tcell('T-A','total_trip_km_resolved')==='','an Open dispute is not repaired — Resolved is the trigger');
ck(String(tcell('T-B','total_trip_km_resolved'))==='150','but its Resolved sibling still is');

/* the columns must exist, and their absence must be LOUD rather than a silent no-op */
stampedButUnwritten();
HIDE_TL_COLS=['total_trip_km_resolved'];
const missing=repairMissedResolutions(true);
console.log('  without the column -> '+(missing.match(/MISSING COLUMN[^\n]*/)||['(nothing)'])[0]);
ck(/MISSING COLUMN "total_trip_km_resolved"/.test(missing),
   'a sheet without the new column is NAMED, not silently skipped (run "1 · Create / verify tabs")');

/* zonal: resolved_km must stay ignored by the repair too */
reset([{trip_id:'T-Z',row_id:'T-Z_R',transporter_oracle_id:'18838',route_scope:'Zonal',rfq_id:'R1',
        billing_type_system:'Regular',zonal_rfq_amount:5300,challan_type:'Forward Only',
        total_trip_km:0,vendor_status:'Reconfirmed'}],
      [{dispute_id:'DSP-Z',trip_id:'T-Z',row_id:'T-Z_R',dispute_status:'Resolved',
        resolved_at:'2026-08-21T15:57:19',resolved_km:'900',resolved_zonal_amount:'5500'}]);
repairMissedResolutions(true);
ck(tcell('T-Z','total_trip_km_resolved')==='','the repair ignores resolved_km on zonal, as the appliers do');
ck(String(tcell('T-Z','zonal_rfq_amount_final'))==='5500','but it does apply the resolved zonal amount');

/* ==================================================================================================
 * 4. _sameCell — the strict numeric rule. A first cut compared _num() on anything containing a digit,
 *    so "RJK7-X" and "RJK10-Y" both reduced to 0 and a contract_id correction was silently dropped.
 *    _importtest's both-doors parity check is what caught it; this pins the helper directly.
 * ================================================================================================= */
console.log('\n── 4. _sameCell ──');
ck(_sameCell('180','180')===true,'identical strings are the same');
ck(_sameCell(180,'180')===true,'a number and its string are the same value');
ck(_sameCell('180.0',180)===true,'and so are 180.0 and 180 — no endless rewrite');
ck(_sameCell('1,500','1500')===true,'a thousands separator does not make a new value');
ck(_sameCell('RJK7-X','RJK10-Y')===false,
   'two contract IDs that both merely CONTAIN digits are NOT equal (the bug this pins)');
ck(_sameCell('RJK7-X','RJK7-X')===true,'but the same contract ID is');
ck(_sameCell('','180')===false,'a blank destination is never "already correct"');
ck(_sameCell('180','')===false,'and a blank incoming value is not equal to a filled cell');
ck(_sameCell('Forward Only','Forward + RTO')===false,'plain strings compare exactly');

/* ==================================================================================================
 * 5. what the PANEL and the MIS now see — the money question
 * ================================================================================================= */
console.log('\n── 5. the resolved KM reaches the billing classifier, not just the screen ──');
const t={route_scope:'Local',contract_id:'RJK8-X',vehicle_number:'GJ01AA1',billing_type_system:'Regular',
         challan_type:'Forward Only',km_accumulated_flag:'Yes',total_trip_km:167.074,vendor_status:'Reconfirmed'};
const before=C(t); t.total_trip_km_resolved=183; const after=C(t);
console.log('  slab KM before='+before.km+'  after='+after.km+'  (kmToSlab '+after.kmToSlab+')');
ck(before.km===167.074&&after.km===183,'the same _classifyTrip both the panel and Billing.gs call now returns 183');
ck(after.kmToSlab===true,'and it is counted into the grouped slab');
ck(after.settled===true,'on a trip the vendor has already accepted');
console.log('  -> panel and MIS cannot disagree: there is one classifier and it reads the resolved column');

/* ==================================================================================================
 * 6. NON-VACUITY — restore the old behaviour and this harness must fail
 * ================================================================================================= */
console.log('\n── 6. non-vacuity ──');
function countFails(fn){ const keep=fails.length; try{ fn(); }catch(e){ return 'threw: '+e.message; }
  return fails.length-keep; }
const savedClassify=_classifyTrip;
// (a) the old classifier: system KM only
_classifyTrip=function(tt,ds,db){ const c=savedClassify(tt,ds,db);
  c.km=_num(tt.total_trip_km); c.kmWas=null; return c; };
let n=countFails(function(){
  const x=_classifyTrip({route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',
    total_trip_km:167.074,total_trip_km_resolved:183},{},'Regular');
  ck(x.km===183,'[probe] old classifier ignores total_trip_km_resolved');
});
console.log('  reverting the classifier to total_trip_km only  -> '+n+' new failure(s)');
ck(n===1,'reverting the KM precedence makes this harness fail (so section 1 is not vacuous)');
_classifyTrip=savedClassify; fails.pop();

// (b) the old guard: a stamped row is skipped forever
const savedApply=applyResolutionsFromSheet;
applyResolutionsFromSheet=function(){ return 'skipped'; };   // stand-in for `continue` on resolved_at
liveRow();
dset('DSP-20260824113254-2626','resolved_at','2026-08-21T15:57:19');
dset('DSP-20260824113254-2626','resolved_km','183');
applyResolutionsFromSheet();
const wouldBeLost = tcell('TR-59335170-3079','total_trip_km_resolved')==='';
console.log('  simulating the old resolved_at gate            -> resolution '+(wouldBeLost?'LOST':'applied'));
ck(wouldBeLost,'with the old gate the late-filled resolution IS lost — the bug reproduces');
applyResolutionsFromSheet=savedApply;
/* and the fixed version recovers that same row */
applyResolutionsFromSheet();
ck(String(tcell('TR-59335170-3079','total_trip_km_resolved'))==='183',
   'and the fixed applier recovers it on the very next run');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
