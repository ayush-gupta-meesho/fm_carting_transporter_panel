/* EXHAUSTIVE classification matrix.
   _classifyTrip() is the single source of truth for what every trip pays — the panel and the MIS both
   call it, so a bug here is a bug in both, silently and identically. This walks the FULL cross product of
   every field that can influence the answer and compares against an INDEPENDENT oracle written from
   docs/ZONAL_LOCAL_SCHEMA.md (§2 amount matrix, §3 classifier, §4c precedence) rather than from the code.

   If the code and the spec ever disagree, this names the exact combination.
*/
const fs=require('fs');
global.Utilities={formatDate:function(){return '';}};
global.SpreadsheetApp={getActive:function(){return {getSpreadsheetTimeZone:function(){return 'Asia/Kolkata';}};}};
global.Session={getScriptTimeZone:function(){return 'Asia/Kolkata';}};global.Logger={log:function(){}};
global.HtmlService={};global.CacheService={};global.PropertiesService={};global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
_tz=function(){return 'Asia/Kolkata';};

/* ---------- the oracle: the spec, implemented from the doc ---------- */
function ORACLE(t, defSet){
  var lc=function(v){ return String(v==null?'':v).trim().toLowerCase(); };
  var st=function(v){ return String(v==null?'':v).trim(); };
  var nm=function(v){ var n=parseFloat(String(v==null?'':v).replace(/,/g,'')); return isNaN(n)?0:n; };

  var scope   = st(t.route_scope) || 'Local';               // blank reads as Local
  var isZonal = lc(scope)==='zonal';

  // precedence: resolution > ground(LOCAL only) > engine            [schema 4c]
  var billing = st(t.billing_type_resolved)
             || (isZonal ? '' : st(t.billing_type_final))
             || st(t.billing_type_system) || 'Regular';
  var isAdhoc = lc(billing)==='adhoc';

  var km = nm(t.total_trip_km);

  // RTO: challan_type_final wins if present; else the system challan; else the zero-km fallback  [§3]
  var cf = lc(t.challan_type_final);
  var rto;
  if(cf) rto = cf.indexOf('rto')===0;
  else   rto = lc(t.challan_type).indexOf('rto')===0
            || (lc(t.km_accumulated_flag)!=='yes' && km===0 && !isAdhoc && st(t.km_accumulated_flag)!=='');

  // the amount matrix, and the ONE RTO RULE applied FIRST                              [§2]
  var zonalAmt = nm(t.zonal_rfq_amount_final) || nm(t.zonal_rfq_amount);
  var payable  = rto ? 0 : (isAdhoc ? nm(t.adhoc_amount) : (isZonal ? zonalAmt : 0));

  // only Local + Regular + non-RTO KM ever reaches a slab                              [§2]
  var kmToSlab = !isZonal && !isAdhoc && !rto;

  return { scope: isZonal?'Zonal':'Local', isZonal: isZonal,
           billing: isAdhoc?'Adhoc':'Regular', isAdhoc: isAdhoc,
           rto: !!rto, payable: payable, kmToSlab: kmToSlab };
}

/* ---------- the cross product ---------- */
const AX = {
  route_scope:           ['', 'Local', 'Zonal', 'zonal', 'ZONAL'],
  billing_type_system:   ['Regular', 'Adhoc', ''],
  billing_type_final:    ['', 'Regular', 'Adhoc'],
  billing_type_resolved: ['', 'Regular', 'Adhoc'],
  challan_type:          ['Forward Only', 'RTO only', 'RTO', ''],
  challan_type_final:    ['', 'Forward Only', 'RTO cancelled', 'Not RTO'],
  total_trip_km:         [0, 180],
  km_accumulated_flag:   ['', 'No', 'Yes'],
};
const FIXED = { adhoc_amount: 4944, zonal_rfq_amount: 5300, zonal_rfq_amount_final: '',
                vehicle_number: 'GJ03AA1001', rfq_id: 'FM-Zonal-R1', vendor_status: 'Pending' };
const keys = Object.keys(AX);

let n=0, bad=[], seenPayable={}, seenShape={};
(function walk(i, row){
  if(i===keys.length){
    const t = Object.assign({}, FIXED, row);
    const got = _classifyTrip(t, {GJ03AA1001:true}, 'Regular');
    const want = ORACLE(t);
    n++;
    ['scope','isZonal','billing','isAdhoc','rto','payable','kmToSlab'].forEach(function(f){
      if(String(got[f])!==String(want[f]) && bad.length<12)
        bad.push({field:f, got:got[f], want:want[f], row:JSON.stringify(row)});
    });
    seenPayable[want.payable]=(seenPayable[want.payable]||0)+1;
    seenShape[want.scope+'/'+want.billing+(want.rto?'/RTO':'')+(want.kmToSlab?'/slab':'')]=1;
    return;
  }
  AX[keys[i]].forEach(function(v){ row[keys[i]]=v; walk(i+1, row); });
})(0, {});

console.log('── exhaustive classification matrix ──');
console.log('  axes: '+keys.map(function(k){return k+'('+AX[k].length+')';}).join(' x '));
console.log('  combinations walked: '+n.toLocaleString('en-IN'));
console.log('  distinct outcome shapes reached: '+Object.keys(seenShape).length);
Object.keys(seenShape).sort().forEach(function(s){ console.log('     '+s); });
console.log('  payable values produced: '+JSON.stringify(seenPayable));

const fails=[], notes=[];
const ck=function(c,m){ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
ck(bad.length===0, 'all '+n.toLocaleString('en-IN')+' combinations agree with the spec oracle'
   +(bad.length?(' — '+bad.length+' mismatch(es) shown below'):''));
bad.forEach(function(b){ console.log('    MISMATCH '+b.field+': code='+b.got+' spec='+b.want+'  '+b.row); });

/* every shape the spec says must exist, actually got exercised */
['Local/Regular/slab','Local/Regular/RTO','Local/Adhoc','Local/Adhoc/RTO',
 'Zonal/Regular','Zonal/Regular/RTO','Zonal/Adhoc','Zonal/Adhoc/RTO'].forEach(function(s){
  ck(!!seenShape[s], 'the matrix reaches '+s);
});

/* the specific invariants the amount matrix promises */
function P(o){ return _classifyTrip(Object.assign({},FIXED,o),{GJ03AA1001:true},'Regular'); }
ck(P({route_scope:'Zonal',challan_type:'RTO only'}).payable===0, 'a zonal RTO pays 0 (rule 8)');
ck(P({route_scope:'Local',billing_type_system:'Adhoc',challan_type:'RTO only'}).payable===0,
   'a LOCAL ADHOC RTO pays 0 too (the ONE RTO RULE, decided 2026-08-07)');
ck(P({route_scope:'Zonal',billing_type_final:'Adhoc'}).billing==='Regular',
   "ground's billing_type_final is ignored on zonal (rule iii)");
ck(P({route_scope:'Local',billing_type_final:'Adhoc'}).billing==='Adhoc',
   'but it still works on local');
ck(P({route_scope:'Zonal',billing_type_resolved:'Adhoc'}).billing==='Adhoc',
   'a resolution CAN flip zonal');
ck(P({route_scope:'Local',billing_type_final:'Adhoc',billing_type_resolved:'Regular'}).billing==='Regular',
   'a resolution outranks ground on local');
ck(P({route_scope:'Zonal',total_trip_km:900}).kmToSlab===false, 'zonal KM never reaches a slab');
ck(P({billing_type_system:'Adhoc',total_trip_km:900}).kmToSlab===false, 'adhoc KM never reaches a slab');
ck(P({total_trip_km:900,challan_type:'Forward Only'}).kmToSlab===true, 'local regular non-RTO KM does');
ck(P({route_scope:'Zonal',zonal_rfq_amount:5300,zonal_rfq_amount_final:6200}).payable===6200,
   'zonal_rfq_amount_final overrides zonal_rfq_amount');
ck(P({challan_type:'Forward Only',total_trip_km:0,km_accumulated_flag:'No'}).rto===true,
   'the zero-km fallback still detects an unflagged RTO');
ck(P({challan_type:'Forward Only',total_trip_km:0,km_accumulated_flag:''}).rto===false,
   'but a blank km_accumulated_flag does NOT trigger it (no flag = no claim)');
ck(P({challan_type:'RTO only',challan_type_final:'Forward Only'}).rto===false,
   'challan_type_final lifts an RTO');
ck(P({challan_type:'Forward Only',challan_type_final:'RTO cancelled'}).rto===true,
   'a challan_type_final that STARTS with "rto" is still an RTO — the documented trap');

console.log('\n── results ──');
notes.forEach(function(x){ console.log(x); });
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(function(f){ console.log(f); }); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
