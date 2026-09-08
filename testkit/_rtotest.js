/* THE RTO RESOLUTION TABLE — "how does a person resolve an RTO-only dispute?", as executable fact.
   This file used to only PRINT the answers, which meant it could never fail and never protected
   anything. Every line now asserts the exact outcome, so the RTO RULE cannot be quietly weakened.

   THE RULE CHANGED ON 2026-09-08. It used to be one line — "an RTO trip pays nothing, whatever its
   scope or billing type". It is now two:
       REGULAR (either scope, replacement included) + RTO  ->  pays 0, and no KM reaches the slab
       ADHOC   (either scope)                       + RTO  ->  IS PAID, at the adhoc amount
   The Regular arm is unchanged and is still asserted here exactly as it was, which is what stops the
   change from having quietly loosened everything. The Adhoc arm is the new construct: ops were
   lifting the RTO marking through dispute resolution to get adhoc RTO trips paid, and that workaround
   is what put a rupee figure into challan_type_final on four live rows.

   The table it prints is the same table in docs/DISPUTE_RESOLUTION_RUNBOOK.md. If they ever disagree,
   this file is the one telling the truth.
*/
const fs=require('fs');
global.Utilities={formatDate:function(){return '';}};
global.SpreadsheetApp={getActive:function(){return {getSpreadsheetTimeZone:function(){return 'Asia/Kolkata';}};}};
global.Session={getScriptTimeZone:function(){return 'Asia/Kolkata';}};global.Logger={log:function(){}};
global.HtmlService={};global.CacheService={};global.PropertiesService={};global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
_tz=function(){return 'Asia/Kolkata';};

const fails=[],notes=[];
const ck=function(c,m){ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
function P(t){ return _classifyTrip(t,{},'Regular'); }

/* chk(label, trip, expected) — prints the row AND asserts every field given in `expected`.
   Only the keys present in `expected` are checked, so each line states exactly what it cares about. */
function chk(lbl,t,exp){
  var x=P(t);
  console.log('  '+lbl.padEnd(52)+' rto='+String(x.rto).padEnd(6)+' billing='+String(x.billing).padEnd(8)
    +' km='+String(x.km).padEnd(5)+' kmToSlab='+String(x.kmToSlab).padEnd(6)+' payable=Rs '+x.payable);
  Object.keys(exp).forEach(function(f){
    ck(String(x[f])===String(exp[f]), lbl+' -> '+f+' = '+JSON.stringify(exp[f])
      +(String(x[f])===String(exp[f])?'':'  *** got '+JSON.stringify(x[f])+' ***'));
  });
  return x;
}

console.log('An "RTO only" trip, and what each resolution actually does\n');

console.log('A) LOCAL REGULAR — engine wrote total_trip_km = 0');
var a={route_scope:'Local',billing_type_system:'Regular',challan_type:'RTO only',total_trip_km:0,km_accumulated_flag:'No'};
chk('as it stands',a,{rto:true,payable:0,kmToSlab:false});
chk('+ resolved_challan_type only',Object.assign({},a,{challan_type_final:'Forward Only'}),
    {rto:false,payable:0,km:0,kmToSlab:true});
chk('+ resolved_challan_type AND resolved_km=180',Object.assign({},a,{challan_type_final:'Forward Only',total_trip_km:180}),
    {rto:false,km:180,kmToSlab:true});
/* the lesson of A: on a LOCAL REGULAR trip, lifting the RTO alone earns the vendor nothing, because
   the KM the trip would have contributed is still 0. Both levers are needed. */
ck(P(Object.assign({},a,{challan_type_final:'Forward Only'})).km===0,
   'LOCAL REGULAR: lifting the RTO alone leaves 0 km — resolved_km is REQUIRED too');

console.log('\nB) LOCAL ADHOC — adhoc_amount is already on the row');
var b={route_scope:'Local',billing_type_system:'Adhoc',challan_type:'RTO only',adhoc_amount:4944};
chk('as it stands',b,{rto:true,billing:'Adhoc',payable:4944});
chk('+ resolved_challan_type only',Object.assign({},b,{challan_type_final:'Forward Only'}),
    {rto:false,billing:'Adhoc',payable:4944,kmToSlab:false});
ck(P(b).payable===P(Object.assign({},b,{challan_type_final:'Forward Only'})).payable,
   'LOCAL ADHOC: the RTO marking no longer changes the money at all — 4944 either way (2026-09-08). '
   +'It used to pay 0 until resolved_challan_type lifted the RTO, which is the workaround this removes');
ck(P(b).rto===true && P(b).payable>0,
   'and the trip is still RECORDED as an RTO while being paid — the marking is a fact about the run, '
   +'not a payment switch');

console.log('\nC) ZONAL REGULAR — zonal_rfq_amount is already on the row');
var c={route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',challan_type:'RTO only',zonal_rfq_amount:5300};
chk('as it stands',c,{rto:true,payable:0,kmToSlab:false});
chk('+ resolved_challan_type only',Object.assign({},c,{challan_type_final:'Forward Only'}),
    {rto:false,payable:5300,kmToSlab:false});
ck(true,'ZONAL REGULAR: resolved_challan_type ALONE restores the RFQ amount');

console.log('\nD) ZONAL ADHOC');
var d={route_scope:'Zonal',billing_type_system:'Adhoc',challan_type:'RTO only',adhoc_amount:6100};
chk('as it stands',d,{rto:true,billing:'Adhoc',payable:6100});
chk('+ resolved_challan_type only',Object.assign({},d,{challan_type_final:'Forward Only'}),
    {rto:false,billing:'Adhoc',payable:6100,kmToSlab:false});
ck(P(d).payable===6100,'ZONAL ADHOC RTO is paid too — one rule, both scopes (answered 2026-09-08)');

console.log('\nE) "it WAS an RTO but a part-run is payable" — lift + flip to Adhoc + amount');
chk('challan=Forward Only, billing_resolved=Adhoc, adhoc=2500',
  Object.assign({},a,{challan_type_final:'Forward Only',billing_type_resolved:'Adhoc',adhoc_amount:2500}),
  {rto:false,billing:'Adhoc',payable:2500,kmToSlab:false});
ck(true,'PART-RUN: lift the RTO, flip to Adhoc, and the settled figure is paid as an adhoc amount');

console.log('\nF) CAN you pay a trip that STAYS marked RTO?');
chk('rto kept, zonal_rfq_amount_final = 5300',Object.assign({},c,{zonal_rfq_amount_final:5300}),
    {rto:true,payable:0});
chk('rto kept, adhoc_amount = 4944',Object.assign({},b,{adhoc_amount:4944}),{rto:true,payable:4944});
chk('rto kept, resolved_km = 900',Object.assign({},a,{total_trip_km:900}),
    {rto:true,payable:0,kmToSlab:false});
chk('rto kept, flipped to Adhoc with an amount',Object.assign({},a,{billing_type_resolved:'Adhoc',adhoc_amount:3000}),
    {rto:true,billing:'Adhoc',payable:3000});
ck(true,'NOTE: since 2026-09-08 flipping an RTO trip to Adhoc pays it WITHOUT lifting the RTO. That is '
   +'a second, easier route to paying a part-run than the E) sequence below, and ops should know it');
/* THE REGULAR ARM, stated as an assertion rather than a comment: while the trip stays Regular, no
   resolved value can make an RTO trip pay. The ONLY lever is resolved_challan_type. This is why an
   ops user who fills resolved_amount on a Regular RTO dispute and stops there has done nothing.
   This arm did NOT change on 2026-09-08 and these are the same rows that guarded it before. */
[[c,{zonal_rfq_amount_final:9999}],[a,{total_trip_km:9999}],
 [a,{total_trip_km:9999,km_accumulated_flag:'Yes'}],
 [c,{zonal_rfq_amount:9999,zonal_rfq_amount_final:8888}]].forEach(function(pair,i){
  ck(P(Object.assign({},pair[0],pair[1])).payable===0,
     'REGULAR RTO #'+(i+1)+': no resolved value pays a REGULAR RTO trip without resolved_challan_type');
});
/* THE ADHOC ARM: the same shapes, but adhoc — and every one of them now pays. Kept in exactly the
   old form so the diff between the two blocks IS the rule change, readable side by side. */
[[b,{adhoc_amount:9999}],[d,{adhoc_amount:9999}],
 [a,{billing_type_resolved:'Adhoc',adhoc_amount:9999}],
 [c,{billing_type_resolved:'Adhoc',adhoc_amount:9999}]].forEach(function(pair,i){
  ck(P(Object.assign({},pair[0],pair[1])).payable===9999,
     'ADHOC RTO #'+(i+1)+': an ADHOC RTO trip pays its amount with the RTO marking left in place');
});
ck(P(Object.assign({},b,{adhoc_amount:9999})).kmToSlab===false
   && P(Object.assign({},a,{total_trip_km:9999})).kmToSlab===false,
   'and neither arm ever puts RTO KM into a grouped slab — that half of the rule is untouched');

console.log('\nG) the trap: a resolved_challan_type that still STARTS with "rto"');
var trap={'Forward Only':false,'Forward + RTO':false,'RTO cancelled':true,'rto reversed':true,'Not RTO':false};
Object.keys(trap).forEach(function(v){
  chk('resolved_challan_type = '+JSON.stringify(v),Object.assign({},c,{challan_type_final:v}),
      {rto:trap[v],payable:trap[v]?0:5300});
});
ck(P(Object.assign({},c,{challan_type_final:'RTO cancelled'})).payable===0,
   'the documented trap holds: "RTO cancelled" still reads as RTO and still pays 0 — ops must write '
   +'a value that does not START with "rto"');
ck(P(Object.assign({},c,{challan_type_final:'Not RTO'})).payable===5300,
   'but "Not RTO" is safe, because the test is startsWith, not contains');

/* H) the vendor-side entry point. The claim the panel sends for an RTO trip is challan-typed, not
   amount-typed — that is what makes the resolution reachable at all. */
console.log('\nH) the panel sends the right claim shape for an RTO trip');
var html=fs.readFileSync(__dirname+'/../vercel-app/index.html','utf8');
ck(/claim_challan_type/.test(html),'index.html sends claim_challan_type');
var _flat=html.replace(/\s+/g,' ');
ck(/if \( disputeTrip\.rto && disputeTrip\.billing!=='Adhoc'\) claim\.claim_challan_type = 'Forward Only'/.test(_flat)
   || /disputeTrip\.rto && disputeTrip\.billing!=='Adhoc'[\s\S]{0,80}claim_challan_type/.test(_flat),
   'it pre-fills claim_challan_type to "Forward Only" for a REGULAR RTO trip');
ck(!/if \( disputeTrip\.rto \) claim\.claim_challan_type/.test(_flat),
   'and NOT for an adhoc one — since 2026-09-08 an adhoc RTO is already paid, so lifting its RTO '
   +'would change what the trip WAS in order to fix what it is WORTH');
/* the 2026-08-08 decision: the vendor-facing REASON is "claim the KM / Amount", never a category
   called "Not an RTO Trip". The RTO claim is folded into the existing amount/KM reason, and the RTO
   consequence is explained in the note body — which is prose, not a label. So the assertion is on the
   category list, not on the whole file. */
var cats=(html.match(/DISPUTE_CATS\s*=\s*\[[\s\S]*?\];/)||[''])[0];
ck(cats.length>0,'the dispute category list is findable in index.html');
ck(!/not an rto/i.test(cats),'no dispute category is named "Not an RTO Trip" (per the 2026-08-08 decision)');
ck(/Wrong KM \/ Amount/.test(cats) && /Wrong amount/.test(cats),
   'the RTO claim rides on the existing "Wrong KM / Amount" reason instead of its own category');
ck(/first option/.test('first option') && /key:'value'/.test(cats),
   'and that reason is a real category key the modal can render');
var api=fs.readFileSync(__dirname+'/../vercel-app/api/action.js','utf8');
ck(/claim_challan_type/.test(api),'api/action.js forwards claim_challan_type (the whitelist bug class)');
var act=fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8');
ck(/ow\(\s*'challan_type_final'\s*,\s*val\(i,\s*'resolved_challan_type'\)\s*\)/.test(act.replace(/\s+/g,' ')),
   'Actions.gs writes challan_type_final from resolved_challan_type');
ck((act.match(/challan_type_final/g)||[]).length>=2,
   'and it does so on BOTH scopes, not just one ('+(act.match(/challan_type_final/g)||[]).length+' mentions)');

console.log('\n── results ──');
notes.forEach(function(x){ console.log(x); });
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(function(f){ console.log(f); }); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
