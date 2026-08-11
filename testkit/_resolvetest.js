/* Does an UPHELD dispute now actually change what the trip pays?
   Runs the real _classifyTrip over the sheet state a resolution would produce, for the two loops that
   were dead ends: (1) zonal Regular -> Adhoc, (2) an RTO trip claiming its KM/amount back. */
const fs=require('fs');
global.Utilities={formatDate:()=>''};global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'})};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata'};global.Logger={log:()=>{}};
global.HtmlService={};global.CacheService={};global.PropertiesService={};global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
_tz=()=>'Asia/Kolkata';
const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
const P=(t,d)=>_classifyTrip(t,d||{},'Regular');

console.log('── 1. zonal Regular disputed as Adhoc ──');
let z={route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',challan_type:'Forward Only',
       zonal_rfq_amount:5300,adhoc_amount:'',total_trip_km:180};
console.log('  before                                        : '+P(z).billing+'  ₹'+P(z).payable);
ck(P(z).billing==='Regular'&&P(z).payable===5300,'a zonal Regular trip pays its RFQ amount');
/* GROUND writes billing_type_final. That must STILL be ignored on zonal — rule (iii). This is the
   TR-ZT-0006 case, and it is why the resolution needed its own column rather than sharing _final. */
z.billing_type_final='Adhoc'; z.adhoc_amount=6100;
console.log('  after GROUND writes billing_type_final=Adhoc   : '+P(z).billing+'  ₹'+P(z).payable);
ck(P(z).billing==='Regular'&&P(z).payable===5300,
   'a GROUND billing_type_final is still ignored on zonal — rule (iii) intact');
// ops upholds the dispute: the applier writes billing_type_RESOLVED, a column ground cannot reach
z.billing_type_resolved='Adhoc';
console.log('  after resolved_billing_type=Adhoc, amount=6100 : '+P(z).billing+'  ₹'+P(z).payable);
ck(P(z).billing==='Adhoc','an upheld resolution FLIPS a zonal trip to Adhoc (was ignored outright)');
ck(P(z).payable===6100,'and it pays the adhoc amount, ₹'+P(z).payable);
ck(P(z).kmToSlab===false,'a flipped zonal trip still never touches a KM slab');
// ground must still be locked out — the transfer guard clears _final before the trip is ever sent
console.log('  (ground is blocked in the classifier itself now — two authorities, two columns)');

console.log('\n── 2. an RTO trip claiming its KM / amount back ──');
let zr={route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',challan_type:'RTO only',
        zonal_rfq_amount:5300,total_trip_km:0};
console.log('  zonal RTO, before                             : ₹'+P(zr).payable);
ck(P(zr).payable===0,'a zonal RTO trip pays nothing');
zr.zonal_rfq_amount_final=5300;                      // the OLD, useless resolution
ck(P(zr).payable===0,'writing zonal_rfq_amount_final alone is still a no-op while the trip is RTO');
zr.challan_type_final='Forward Only';                // the NEW lever
console.log('  after resolved_challan_type=Forward Only       : ₹'+P(zr).payable);
ck(P(zr).payable===5300,'lifting the RTO makes the zonal trip payable again, ₹'+P(zr).payable);
ck(P(zr).rto===false,'and it is no longer classified RTO');

let lr={route_scope:'Local',billing_type_system:'Regular',challan_type:'RTO only',
        total_trip_km:0,km_accumulated_flag:'No'};
console.log('  local RTO, before                             : km='+P(lr).km+', into slab='+P(lr).kmToSlab);
ck(P(lr).kmToSlab===false,'a local RTO trip contributes no KM');
lr.total_trip_km=180;
ck(P(lr).kmToSlab===false,'writing total_trip_km alone is still a no-op while the trip is RTO');
lr.challan_type_final='Forward Only';
console.log('  after resolved_challan_type + resolved_km=180  : km='+P(lr).km+', into slab='+P(lr).kmToSlab);
ck(P(lr).kmToSlab===true&&P(lr).km===180,'lifting the RTO puts the 180 km into the slab');

let la={route_scope:'Local',billing_type_system:'Adhoc',challan_type:'RTO only',adhoc_amount:4944};
ck(P(la).payable===0,'a local ADHOC RTO trip pays nothing (the ONE RTO RULE)');
la.challan_type_final='Forward Only';
ck(P(la).payable===4944,'and lifting the RTO restores its adhoc amount, ₹'+P(la).payable);

console.log('\n── 1b. the SAME column works on a LOCAL trip ──');
let L={route_scope:'Local',billing_type_system:'Regular',challan_type:'Forward Only',total_trip_km:120};
ck(P(L).billing==='Regular','a local Regular trip starts Regular');
L.billing_type_final='Adhoc';                       // ground may reclassify LOCAL — that still works
console.log('  ground billing_type_final=Adhoc               : '+P(L).billing);
ck(P(L).billing==='Adhoc','ground CAN still reclassify a local trip via billing_type_final');
L.billing_type_resolved='Regular';                  // a resolution outranks ground
console.log('  + resolution billing_type_resolved=Regular    : '+P(L).billing);
ck(P(L).billing==='Regular','a resolution outranks ground on local — resolution > ground > system');
delete L.billing_type_final;
ck(P(L).billing==='Regular','and it works with no ground edit present at all');
// the precedence is identical on zonal, except ground never counts
let Z2={route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',zonal_rfq_amount:5300,
        challan_type:'Forward Only',billing_type_final:'Adhoc',adhoc_amount:9000};
ck(P(Z2).billing==='Regular','on zonal, ground is skipped in the SAME expression');
Z2.billing_type_resolved='Adhoc';
ck(P(Z2).billing==='Adhoc'&&P(Z2).payable===9000,'and the resolution lands identically, ₹'+P(Z2).payable);
console.log('  precedence, both scopes: resolution > ground(local only) > system');

console.log('\n── 3. the guard: a flip that would zero the trip ──');
console.log('  (enforced in Actions.gs, not the classifier — a zonal flip to Adhoc with a blank');
console.log('   adhoc_amount and no resolved_amount is REFUSED with a note rather than paying 0)');
let zz={route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',zonal_rfq_amount:5300,
        challan_type:'Forward Only',billing_type_resolved:'Adhoc',adhoc_amount:''};
console.log('  what the refused flip would have produced      : ₹'+P(zz).payable+'  <- why the guard exists');
ck(P(zz).payable===0,'an unguarded flip with a blank adhoc_amount would indeed pay 0');

console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
