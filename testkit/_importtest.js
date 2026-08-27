/* THE CSV IMPORT PATH — _applyResolvedRows(), the second of the two resolution doors.
   applyResolutionsFromSheet() (tested by _flowtest) is the in-sheet door. This is the CSV door, and it
   was never tested at all — yet it writes the SAME Trip_Level columns, so a divergence between the two
   would mean the same resolution pays differently depending on how ops submitted it.

   Every assertion below is really two: the CSV path behaves correctly, AND it behaves IDENTICALLY to
   the in-sheet path. The last section proves that equivalence directly by running both.
*/
const fs=require('fs');

const TL_HDR=['trip_id','row_id','transporter_oracle_id','route_scope','rfq_id','contract_id','vehicle_number',
  'vendor_status','billing_type_system','billing_type_final','billing_type_resolved',
  'replaced_default_vehicle_system','replaced_default_vehicle_final','total_trip_km','adhoc_amount',
  // added 2026-08-27: a resolution now writes HERE, never over the system columns above
  'total_trip_km_resolved','adhoc_amount_resolved',
  'zonal_rfq_amount','zonal_rfq_amount_final','challan_type','challan_type_final','km_accumulated_flag',
  'sent_to_vendor_flag','dispute_window_end'];
const DL_HDR=['dispute_id','row_id','trip_id','dispute_status','reconfirm_status','resolved_at','resolved_by',
  'resolution_note','resolved_billing_type','resolved_km','resolved_amount','resolved_zonal_amount',
  'resolved_rfq_id','resolved_challan_type','resolved_aggregate_vehicle','resolved_contract_id'];

global.Utilities={formatDate:()=>'2026-08-11T10:00:00',parseCsv:t=>t.trim().split('\n').map(l=>l.split(','))};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),getUi:()=>{throw new Error('no UI');}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8'));
_tz=()=>'Asia/Kolkata'; _nowIso=()=>'2026-08-11T10:00:00';

let TL,DL,statusUpserts,tlWrites;
function mk(hdr,rows){ return [hdr.slice()].concat(rows.map(r=>hdr.map(h=>r[h]===undefined?'':r[h]))); }
function reset(tlRows,dlRows){ TL=mk(TL_HDR,tlRows); DL=mk(DL_HDR,dlRows); statusUpserts=[]; tlWrites=[]; }
_ctx=function(tab){
  const s=(tab===TABS.tripLevel)?TL:DL;
  const idx={}; s[0].forEach((h,i)=>{ if(h) idx[h]=i; });
  return {sh:{name:tab},values:s,headerRow:0,headers:s[0],idx};
};
_setCell=function(ctx,r,col,v){ const ci=ctx.idx[col]; if(ci===undefined) return;
  ctx.values[r][ci]=v;
  if(ctx.sh.name===TABS.tripLevel) tlWrites.push({trip:ctx.values[r][ctx.idx['trip_id']],col,v}); };
_appendByHeaders=function(){};
_upsertStatusView=function(o){ statusUpserts.push(o); };
_readTab=function(){ return []; };

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
function tcell(tid,col){ const idx={}; TL[0].forEach((h,i)=>{if(h)idx[h]=i;});
  for(let i=1;i<TL.length;i++) if(String(TL[i][idx['trip_id']])===tid) return TL[i][idx[col]]; }
function dcell(did,col){ const idx={}; DL[0].forEach((h,i)=>{if(h)idx[h]=i;});
  for(let i=1;i<DL.length;i++) if(String(DL[i][idx['dispute_id']])===did) return DL[i][idx[col]]; }
function csv(hdr,rows){ return [hdr].concat(rows); }
const P=(tid)=>{ const idx={}; TL[0].forEach((h,i)=>{if(h)idx[h]=i;});
  for(let i=1;i<TL.length;i++) if(String(TL[i][idx['trip_id']])===tid){
    const o={}; Object.keys(idx).forEach(k=>o[k]=TL[i][idx[k]]); return _classifyTrip(o,{},'Regular'); } };

/* ==================================================================================================
 * 1. the header contract — a malformed CSV must refuse, not half-apply
 * ================================================================================================= */
console.log('── 1. the CSV header contract ──');
reset([],[]);
console.log('  no rows      -> '+_applyResolvedRows([]));
console.log('  header only  -> '+_applyResolvedRows([['dispute_id']]));
console.log('  no dispute_id-> '+_applyResolvedRows([['trip_id','resolved_km'],['T-1','180']]));
ck(/no data rows/i.test(_applyResolvedRows([])),'an empty CSV is refused');
ck(/no data rows/i.test(_applyResolvedRows([['dispute_id']])),'a header-only CSV is refused');
ck(/must have a dispute_id/i.test(_applyResolvedRows([['trip_id','resolved_km'],['T-1','180']])),
   'a CSV without dispute_id is refused — the key is not guessed from trip_id');
ck(tlWrites.length===0,'and none of the three refusals wrote a single Trip_Level cell');
/* the header is matched case- and space-insensitively, because ops exports from Excel */
reset([{trip_id:'T-L1',row_id:'R1',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:0,challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-1',trip_id:'T-L1',dispute_status:'Open'}]);
let out=_applyResolvedRows(csv(['  Dispute_ID ','  Resolved_KM  '],[['DSP-1','180']]));
console.log('  messy header -> '+out+'   total_trip_km_resolved now '+tcell('T-L1','total_trip_km_resolved')
  +'  (system total_trip_km still '+tcell('T-L1','total_trip_km')+')');
ck(String(tcell('T-L1','total_trip_km_resolved'))==='180',
   'a header with stray spaces and mixed case still matches (Excel round-trips do this)');
/* 2026-08-27: the destination changed. resolved_km lands in total_trip_km_resolved and the SYSTEM
   column is left alone, so the original is auditable and a re-push of Trip_Level cannot revert the
   correction. Every assertion below that used to read total_trip_km now reads both. */
ck(String(tcell('T-L1','total_trip_km'))==='0','and the system total_trip_km is NOT overwritten');
ck(P('T-L1').km===180,'the classifier reads the resolved value, so the trip is 180 km');
ck(P('T-L1').kmWas===0,'and kmWas exposes the 0 it replaced, for the panel to show');

/* ==================================================================================================
 * 2. an unmatched dispute_id is reported, never invented
 * ================================================================================================= */
console.log('\n── 2. unmatched rows ──');
reset([{trip_id:'T-L1',row_id:'R1',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:100,vendor_status:'Disputed'}],
      [{dispute_id:'DSP-1',trip_id:'T-L1',dispute_status:'Open'}]);
out=_applyResolvedRows(csv(['dispute_id','resolved_km'],[['DSP-1','180'],['DSP-NOPE','999'],['','500']]));
console.log('  '+out.split('\n')[0]);
ck(/applied 1, unmatched 1/.test(out),'one applied, one unmatched, the blank id silently skipped — '+out.split('\n')[0]);
ck(/no dispute DSP-NOPE/.test(out),'and the unmatched id is NAMED in the return message');
ck(String(tcell('T-L1','total_trip_km_resolved'))==='180','the matched row applied');
ck(String(tcell('T-L1','total_trip_km'))==='100','and the system column still reads its original 100');

/* ==================================================================================================
 * 3. blank means "leave alone" — the §G16 promise
 * ================================================================================================= */
console.log('\n── 3. a blank resolved_* cell changes nothing ──');
reset([{trip_id:'T-L2',row_id:'R2',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Adhoc',adhoc_amount:4944,total_trip_km:120,
        challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-2',trip_id:'T-L2',dispute_status:'Open'}]);
_applyResolvedRows(csv(['dispute_id','resolved_km','resolved_amount','resolved_billing_type','resolution_note'],
  [['DSP-2','','','','upheld in part']]));
console.log('  km='+tcell('T-L2','total_trip_km')+' amt='+tcell('T-L2','adhoc_amount')
  +' billing_resolved='+JSON.stringify(tcell('T-L2','billing_type_resolved'))
  +' status='+tcell('T-L2','vendor_status'));
ck(String(tcell('T-L2','total_trip_km'))==='120','a blank resolved_km leaves total_trip_km alone');
ck(tcell('T-L2','total_trip_km_resolved')==='','and writes nothing into total_trip_km_resolved either');
ck(String(tcell('T-L2','adhoc_amount'))==='4944','a blank resolved_amount leaves adhoc_amount alone');
ck(tcell('T-L2','adhoc_amount_resolved')==='','and adhoc_amount_resolved stays blank');
ck(P('T-L2').kmWas===null&&P('T-L2').amtWas===null,'and nothing is flagged as revised to the vendor');
ck(tcell('T-L2','billing_type_resolved')==='','a blank resolved_billing_type writes nothing at all');
ck(dcell('DSP-2','resolution_note')==='upheld in part','but the note IS recorded');
/* the trip still has to re-surface, even when nothing about the money changed — the vendor is owed
   the answer, and Reconfirm is how they get the buttons back */
ck(tcell('T-L2','vendor_status')==='Reconfirm','the trip still moves to Reconfirm so the vendor can respond');
ck(dcell('DSP-2','dispute_status')==='Resolved','the dispute closes as Resolved');
ck(dcell('DSP-2','reconfirm_status')==='Pending Reconfirmation','and waits on the vendor');
ck(dcell('DSP-2','resolved_at')==='2026-08-11T10:00:00','resolved_at is stamped — the idempotency marker');

/* ==================================================================================================
 * 4. ZONAL through the CSV door — the same three ignores and the same refusal
 * ================================================================================================= */
console.log('\n── 4. zonal via CSV ──');
reset([{trip_id:'T-Z1',row_id:'RZ1',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R-OLD',
        billing_type_system:'Regular',zonal_rfq_amount:5300,adhoc_amount:'',total_trip_km:0,
        challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-Z1',trip_id:'T-Z1',dispute_status:'Open'}]);
out=_applyResolvedRows(csv(['dispute_id','resolved_km','resolved_aggregate_vehicle','resolved_zonal_amount',
  'resolved_rfq_id','resolved_contract_id'],[['DSP-Z1','900','GJ01AA0001','5500','R-NEW','RJK7-X']]));
console.log('  '+out.replace(/\n/g,'\n  '));
console.log('  km='+tcell('T-Z1','total_trip_km')+' repl='+JSON.stringify(tcell('T-Z1','replaced_default_vehicle_final'))
  +' zonal_final='+tcell('T-Z1','zonal_rfq_amount_final')+' rfq='+tcell('T-Z1','rfq_id')
  +' contract='+JSON.stringify(tcell('T-Z1','contract_id')));
ck(String(tcell('T-Z1','total_trip_km'))==='0','resolved_km is IGNORED on zonal (there is no KM slab)');
ck(tcell('T-Z1','replaced_default_vehicle_final')==='','resolved_aggregate_vehicle is IGNORED on zonal');
ck(/ignored resolved_km \/ resolved_aggregate_vehicle/.test(out),'and the return message says both were ignored');
ck(String(tcell('T-Z1','zonal_rfq_amount_final'))==='5500','resolved_zonal_amount IS applied');
ck(P('T-Z1').payable===5500,'so the trip now pays ₹5,500 instead of ₹5,300');
ck(tcell('T-Z1','rfq_id')==='R-NEW','resolved_rfq_id corrects the RFQ — the zonal billing reference');
ck(tcell('T-Z1','contract_id')==='','and resolved_contract_id is NOT written to a zonal row');
/* the refusal: a flip to Adhoc with nothing to pay */
reset([{trip_id:'T-Z2',row_id:'RZ2',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R1',
        billing_type_system:'Regular',zonal_rfq_amount:5300,adhoc_amount:'',
        challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-Z2',trip_id:'T-Z2',dispute_status:'Open'}]);
out=_applyResolvedRows(csv(['dispute_id','resolved_billing_type'],[['DSP-Z2','Adhoc']]));
console.log('  refusal -> '+out.split('\n').slice(1).join(' ').slice(0,120));
ck(/REFUSED flip to Adhoc/.test(out),'a flip to Adhoc with a blank adhoc_amount and no resolved_amount is REFUSED');
ck(tcell('T-Z2','billing_type_resolved')==='','and billing_type_resolved is left empty');
ck(P('T-Z2').payable===5300,'so the trip keeps paying its ₹5,300 instead of dropping to ₹0');
/* the same flip, done properly */
reset([{trip_id:'T-Z3',row_id:'RZ3',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R1',
        billing_type_system:'Regular',zonal_rfq_amount:5300,adhoc_amount:'',
        challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-Z3',trip_id:'T-Z3',dispute_status:'Open'}]);
out=_applyResolvedRows(csv(['dispute_id','resolved_billing_type','resolved_amount'],[['DSP-Z3','Adhoc','6100']]));
console.log('  proper flip -> billing_resolved='+tcell('T-Z3','billing_type_resolved')
  +' adhoc='+tcell('T-Z3','adhoc_amount')+' payable=₹'+P('T-Z3').payable);
ck(!/REFUSED/.test(out),'the same flip WITH resolved_amount is accepted');
ck(tcell('T-Z3','billing_type_resolved')==='Adhoc','billing_type_resolved is written (never billing_type_final)');
ck(tcell('T-Z3','billing_type_final')==='','ground\'s column is untouched — two authorities, two columns');
ck(String(tcell('T-Z3','adhoc_amount_resolved'))==='6100','the adhoc amount is populated');
ck(tcell('T-Z3','adhoc_amount')==='','into adhoc_amount_RESOLVED — the system column is left blank');
ck(P('T-Z3').billing==='Adhoc'&&P('T-Z3').payable===6100,'and the trip now bills ₹6,100 as Adhoc');

/* ==================================================================================================
 * 5. the RTO lever through the CSV door — on BOTH scopes
 * ================================================================================================= */
console.log('\n── 5. resolved_challan_type via CSV ──');
reset([
 {trip_id:'T-RL',row_id:'RL',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',billing_type_system:'Regular',
  total_trip_km:0,km_accumulated_flag:'No',challan_type:'RTO only',vendor_status:'Disputed'},
 {trip_id:'T-RZ',row_id:'RZ',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R1',
  billing_type_system:'Regular',zonal_rfq_amount:5300,challan_type:'RTO only',vendor_status:'Disputed'},
],[{dispute_id:'DSP-RL',trip_id:'T-RL',dispute_status:'Open'},
   {dispute_id:'DSP-RZ',trip_id:'T-RZ',dispute_status:'Open'}]);
ck(P('T-RL').rto===true&&P('T-RL').kmToSlab===false,'the local RTO trip starts unpayable');
ck(P('T-RZ').rto===true&&P('T-RZ').payable===0,'and so does the zonal one');
_applyResolvedRows(csv(['dispute_id','resolved_challan_type','resolved_km'],
  [['DSP-RL','Forward Only','180'],['DSP-RZ','Forward Only','']]));
console.log('  local: challan_final='+tcell('T-RL','challan_type_final')+' km='+tcell('T-RL','total_trip_km')
  +' -> slab='+P('T-RL').kmToSlab);
console.log('  zonal: challan_final='+tcell('T-RZ','challan_type_final')+' -> payable=₹'+P('T-RZ').payable);
ck(tcell('T-RL','challan_type_final')==='Forward Only','challan_type_final is written on a LOCAL trip');
ck(tcell('T-RZ','challan_type_final')==='Forward Only','and on a ZONAL trip — the challan is not scope-specific');
ck(P('T-RL').rto===false&&P('T-RL').km===180&&P('T-RL').kmToSlab===true,
   'the local trip is un-RTOd and its 180 km reaches the slab');
ck(P('T-RZ').rto===false&&P('T-RZ').payable===5300,'and the zonal trip becomes payable again');

/* ==================================================================================================
 * 6. THE EQUIVALENCE — the CSV door and the in-sheet door must land on the same cells
 * ================================================================================================= */
console.log('\n── 6. CSV door vs in-sheet door: identical outcomes ──');
const SCENARIOS=[
  {name:'local: KM + reclassify to Adhoc + amount',
   tl:{trip_id:'E1',row_id:'E1',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
       billing_type_system:'Regular',billing_type_final:'Regular',total_trip_km:100,adhoc_amount:'',
       challan_type:'Forward Only',vendor_status:'Disputed'},
   res:{resolved_billing_type:'Adhoc',resolved_amount:'3000',resolved_km:'150',
        resolved_aggregate_vehicle:'GJ01AA0002',resolved_contract_id:'RJK10-Y'}},
  {name:'local: lift an RTO and restore the KM',
   tl:{trip_id:'E2',row_id:'E2',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
       billing_type_system:'Regular',total_trip_km:0,km_accumulated_flag:'No',
       challan_type:'RTO only',vendor_status:'Disputed'},
   res:{resolved_challan_type:'Forward Only',resolved_km:'180'}},
  {name:'zonal: correct the amount and the RFQ',
   tl:{trip_id:'E3',row_id:'E3',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R-OLD',
       billing_type_system:'Regular',zonal_rfq_amount:5300,challan_type:'Forward Only',vendor_status:'Disputed'},
   res:{resolved_zonal_amount:'5500',resolved_rfq_id:'R-NEW',resolved_km:'900',
        resolved_aggregate_vehicle:'GJ01AA0001',resolved_contract_id:'RJK7-X'}},
  {name:'zonal: refused flip to Adhoc',
   tl:{trip_id:'E4',row_id:'E4',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R1',
       billing_type_system:'Regular',zonal_rfq_amount:5300,adhoc_amount:'',
       challan_type:'Forward Only',vendor_status:'Disputed'},
   res:{resolved_billing_type:'Adhoc'}},
  {name:'zonal: accepted flip to Adhoc',
   tl:{trip_id:'E5',row_id:'E5',transporter_oracle_id:'ORC-1',route_scope:'Zonal',rfq_id:'R1',
       billing_type_system:'Regular',zonal_rfq_amount:5300,adhoc_amount:'',
       challan_type:'Forward Only',vendor_status:'Disputed'},
   res:{resolved_billing_type:'Adhoc',resolved_amount:'6100'}},
  {name:'zonal adhoc: lift an RTO',
   tl:{trip_id:'E6',row_id:'E6',transporter_oracle_id:'ORC-1',route_scope:'Zonal',
       billing_type_system:'Adhoc',adhoc_amount:6100,challan_type:'RTO only',vendor_status:'Disputed'},
   res:{resolved_challan_type:'Forward Only'}},
];
const RES_KEYS=['resolved_billing_type','resolved_km','resolved_amount','resolved_zonal_amount',
  'resolved_rfq_id','resolved_challan_type','resolved_aggregate_vehicle','resolved_contract_id'];
function snapshotTL(){ const idx={}; TL[0].forEach((h,i)=>{if(h)idx[h]=i;});
  return TL.slice(1).map(r=>TL_HDR.map(h=>String(r[idx[h]]))).join('|'); }
SCENARIOS.forEach(function(sc){
  const did='D-'+sc.tl.trip_id;
  /* door A: the CSV */
  reset([JSON.parse(JSON.stringify(sc.tl))],[{dispute_id:did,trip_id:sc.tl.trip_id,dispute_status:'Open'}]);
  const hdr=['dispute_id'].concat(RES_KEYS);
  _applyResolvedRows(csv(hdr,[[did].concat(RES_KEYS.map(k=>sc.res[k]===undefined?'':sc.res[k]))]));
  const viaCsv=snapshotTL(), csvPay=P(sc.tl.trip_id);
  /* door B: the sheet — dispute_status=Resolved on the Disputes_Log row, resolved_* filled in place */
  const dlRow={dispute_id:did,trip_id:sc.tl.trip_id,dispute_status:'Resolved'};
  RES_KEYS.forEach(k=>{ if(sc.res[k]!==undefined) dlRow[k]=sc.res[k]; });
  reset([JSON.parse(JSON.stringify(sc.tl))],[dlRow]);
  applyResolutionsFromSheet();
  const viaSheet=snapshotTL(), shPay=P(sc.tl.trip_id);
  console.log('  '+sc.name.padEnd(42)+(viaCsv===viaSheet?'identical':'*** DIFFERENT ***')
    +'   payable ₹'+csvPay.payable+' / ₹'+shPay.payable);
  if(viaCsv!==viaSheet){ const a=viaCsv.split('|')[0].split(','),b=viaSheet.split('|')[0].split(',');
    TL_HDR.forEach((h,i)=>{ if(a[i]!==b[i]) console.log('      DIFF '+h+': csv='+JSON.stringify(a[i])+' sheet='+JSON.stringify(b[i])); }); }
  ck(viaCsv===viaSheet,'"'+sc.name+'" lands identically through both doors');
  ck(csvPay.payable===shPay.payable,'  and pays the same either way (₹'+csvPay.payable+')');
  ck(csvPay.billing===shPay.billing&&csvPay.rto===shPay.rto&&csvPay.kmToSlab===shPay.kmToSlab,
     '  with the same billing type, RTO state and slab treatment');
});

/* ==================================================================================================
 * 7. re-running the in-sheet applier — the contract CHANGED on 2026-08-27, read this
 *
 * It used to be: `if (val(i,'resolved_at')) continue;` — a stamped row was skipped forever, and the
 * OLD version of this section asserted that as a guarantee ("skipped forever, safe on a timer"). That
 * assertion was encoding the bug. Because resolved_at was stamped BEFORE any resolved_* value was
 * read, ops marking a dispute Resolved and typing the number a minute later lost the number for good:
 * 166 live rows, 1,974.216 km, invisible because the trip still flipped to Reconfirm and the vendor
 * still saw the figure in the View-Dispute dialog.
 *
 * The contract now: resolved_at gates the ONE-TIME side effects only (flip to Reconfirm, status-view
 * upsert — those notify the vendor). The value writes run every pass and are idempotent, compared
 * cell by cell. So the function is self-healing without ever reopening an accepted trip.
 * ================================================================================================= */
console.log('\n── 7. re-running the applier: self-healing, but never re-notifying ──');
reset([{trip_id:'I1',row_id:'I1',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:100,challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-I1',trip_id:'I1',dispute_status:'Resolved',resolved_km:'180'}]);
applyResolutionsFromSheet();
ck(String(tcell('I1','total_trip_km_resolved'))==='180','the first run applies the resolution');
ck(String(dcell('DSP-I1','resolved_at')).length>0,'and stamps resolved_at');
ck(tcell('I1','vendor_status')==='Reconfirm','and re-surfaces the trip to the vendor');
ck(statusUpserts.length===1,'with exactly one status-view upsert');

/* the vendor accepts. a timer fires again. nothing may move. */
TL[1][TL[0].indexOf('vendor_status')]='Reconfirmed';
tlWrites=[]; statusUpserts=[];
let out7=applyResolutionsFromSheet();
console.log('  re-run with nothing changed -> '+out7.split('\n')[0]+'   TL writes: '+tlWrites.length);
ck(tlWrites.length===0,'a re-run with nothing changed writes NOT ONE Trip_Level cell (true idempotency)');
ck(tcell('I1','vendor_status')==='Reconfirmed',
   'and an accepted trip is NOT reopened — resolved_at still gates the vendor-facing flip');
ck(statusUpserts.length===0,'no second status-view upsert, so the vendor is not notified twice');

/* THE REGRESSION THIS EXISTS FOR: ops fills the number AFTER the row was already stamped. */
reset([{trip_id:'I3',row_id:'I3',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:167.074,challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-I3',trip_id:'I3',dispute_status:'Resolved',resolution_note:'We have reviewed and resolved.'}]);
let outA=applyResolutionsFromSheet();                       // fires on the still-empty row
ck(tcell('I3','total_trip_km_resolved')==='','pass 1: note only, so nothing is written yet');
ck(String(dcell('DSP-I3','resolved_at')).length>0,'pass 1: resolved_at IS stamped (the vendor was told)');
ck(tcell('I3','vendor_status')==='Reconfirm','pass 1: and the trip re-surfaced');
DL[1][DL[0].indexOf('resolved_km')]='183';                  // ops types the number a minute later
TL[1][TL[0].indexOf('vendor_status')]='Reconfirmed';        // and the vendor has already accepted
tlWrites=[]; statusUpserts=[];
let outB=applyResolutionsFromSheet();
console.log('  late-filled resolved_km -> '+outB.replace(/\n/g,'\n    '));
ck(String(tcell('I3','total_trip_km_resolved'))==='183',
   'pass 2: the LATE-FILLED resolved_km lands anyway — this is the 166-row bug, fixed');
ck(String(tcell('I3','total_trip_km'))==='167.074','pass 2: and the system KM is still untouched');
ck(P('I3').km===183&&P('I3').kmWas===167.074,'pass 2: the classifier now bills 183 km and shows what it replaced');
ck(/RECONCILED/.test(outB),'pass 2: and it is REPORTED, not silent — '+(outB.match(/RECONCILED[^\n]{0,60}/)||[''])[0]);
ck(tcell('I3','vendor_status')==='Reconfirmed','pass 2: the accepted trip is still not reopened');
ck(statusUpserts.length===0,'pass 2: and the vendor is not re-notified');

/* an Open row is still never applied at all — Resolved remains the only trigger */
reset([{trip_id:'I2',row_id:'I2',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:100,vendor_status:'Disputed'}],
      [{dispute_id:'DSP-I2',trip_id:'I2',dispute_status:'Open',resolved_km:'180'}]);
applyResolutionsFromSheet();
ck(tcell('I2','total_trip_km_resolved')==='',
   'an Open dispute with resolved_km already filled is NOT applied — Resolved is the trigger');
ck(String(tcell('I2','total_trip_km'))==='100','the system column is untouched too');
ck(tcell('I2','vendor_status')==='Disputed','and the trip stays Disputed');

/* the row_id fallback — one LIVE dispute row carries the row_id in its trip_id column */
reset([{trip_id:'TR-59335170-3079',row_id:'TR-59335170-3079_R',transporter_oracle_id:'ORC-1',
        contract_id:'RJK8-X',billing_type_system:'Regular',total_trip_km:167.074,
        challan_type:'Forward Only',vendor_status:'Disputed'}],
      [{dispute_id:'DSP-RID',trip_id:'TR-59335170-3079_R',row_id:'TR-59335170-3079_R',
        dispute_status:'Resolved',resolved_km:'183'}]);
let outR=applyResolutionsFromSheet();
console.log('  trip_id holds the row_id -> resolved km '+tcell('TR-59335170-3079','total_trip_km_resolved'));
ck(String(tcell('TR-59335170-3079','total_trip_km_resolved'))==='183',
   'a dispute whose trip_id actually holds the row_id still finds its trip (live data does this)');
ck(!/NO TRIP ROW/.test(outR),'and it is not reported as unmatched');
/* but a genuinely unmatchable row IS reported, never silently dropped */
reset([{trip_id:'X1',row_id:'X1',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:100,vendor_status:'Disputed'}],
      [{dispute_id:'DSP-GONE',trip_id:'NOPE',row_id:'NOPE',dispute_status:'Resolved',resolved_km:'180'}]);
let outG=applyResolutionsFromSheet();
ck(/NO TRIP ROW for DSP-GONE/.test(outG),'a dispute matching no trip at all is NAMED in the return message');

/* an empty Resolved row — no values AND no note — is called out as a probable half-finished edit */
reset([{trip_id:'I4',row_id:'I4',transporter_oracle_id:'ORC-1',contract_id:'RJK7-X',
        billing_type_system:'Regular',total_trip_km:100,vendor_status:'Disputed'}],
      [{dispute_id:'DSP-I4',trip_id:'I4',dispute_status:'Resolved'}]);
let outE=applyResolutionsFromSheet();
ck(/EMPTY DSP-I4/.test(outE),'a Resolved row with no values and no note is flagged as probably half-finished');
ck(tcell('I4','vendor_status')==='Reconfirm','but still re-surfaces — a rejection is a real outcome');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
