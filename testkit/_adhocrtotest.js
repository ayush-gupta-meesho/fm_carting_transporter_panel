/* THE ADHOC-RTO CONSTRUCT  (decided 2026-09-08, replaces the blanket "an RTO trip pays nothing")
 *
 *   REGULAR (either scope, replacement included) + RTO  ->  pays 0, and no KM reaches the slab
 *   ADHOC   (either scope)                       + RTO  ->  IS PAID, at the adhoc amount it carries
 *
 * How this came up: Pune Logistics' adhoc total read Rs 2,39,260 on the panel and Rs 2,50,987 in the
 * MIS. The gap was four RTO-only adhoc trips — the panel summed `payable` (0 under the old rule) and
 * the MIS summed `amt`. Rather than pull the MIS down to the panel, the rule itself changed: an
 * RTO-only adhoc run is still a vehicle hired for a job, so it earns its trip amount. The fix is one
 * line in _classifyTrip, which means the panel and the MIS move together by construction.
 *
 * The PARITY assertions below are the point of this file. Panel adhoc sum must equal MIS adhoc total
 * over the same rows — that equality is the property that actually broke, and no single surface can
 * satisfy it alone.
 */
const fs=require('fs');
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
 const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return String(f).replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
  .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata',getSheets:()=>[]}),
 openById:()=>{throw new Error('no MIS sheet in test')},create:()=>({}),getUi:()=>{throw new Error('no ui')}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};global.ScriptApp={getProjectTriggers:()=>[]};
eval([__dirname+'/../apps-script/Code.gs',__dirname+'/../apps-script/Billing.gs']
     .map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_tz=()=>'Asia/Kolkata'; MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };
const R=n=>Math.round(n*100)/100;

/* ---------------- a fixture shaped like the real Pune Logistics case ---------------- */
const ORC='19280', CID='MUM8-19280-20260817-31';
const CI=[{contract_id:CID,vendor_oracle_id:ORC,vendor_name:'Pune Logistics',cluster:'MUM',
  vehicle_size:'8 FT',hours_slab:'12hr',no_of_vehicles:'1',total_km_slab:'1000',
  fixed_monthly_value:'23750',ex_km_rate:'20',contract_start_date:'2026-08-17',
  contract_end_date:'2026-08-31',contract_status:'Active'}];
const CV=[{contract_id:CID,vehicle_number:'MH01AA0001',day1_order:'1',pegged_km_slab:'1000',
  monthly_rate:'23750',active_days:'15',default_vehicle_id:'V1',
  start_date:'2026-08-17',end_date:'2026-08-31'}];
function trip(o){ return Object.assign({
  row_id:'', trip_id:'', transporter_oracle_id:ORC, contract_id:CID, vehicle_number:'MH01AA0001',
  vehicle_size:'8 FT', route_scope:'Local', trip_date:'2026-08-20', challan_type:'Forward Only',
  total_trip_km:'0', billing_type_system:'Adhoc', adhoc_amount:'0', vendor_status:'Confirmed',
  sent_to_vendor_flag:'Yes'
}, o); }
/* two adhoc trips ON the contract (one plain, one RTO-only), the same pair in the orphan bucket,
   and one REGULAR RTO trip to hold the arm that did not change. */
const TL=[
  trip({trip_id:'T-OK-C',  adhoc_amount:'5000'}),
  trip({trip_id:'T-RTO-C', adhoc_amount:'3162.945', challan_type:'RTO only'}),
  trip({trip_id:'T-OK-B',  adhoc_amount:'4000', contract_id:'ADHOC-'+ORC}),
  trip({trip_id:'T-RTO-B', adhoc_amount:'2400',  contract_id:'ADHOC-'+ORC, challan_type:'RTO only'}),
  trip({trip_id:'T-REG-RTO', billing_type_system:'Regular', challan_type:'RTO only',
        total_trip_km:'180', km_accumulated_flag:'No', adhoc_amount:''})
];
const AC=[{email:'v@x',vendor_oracle_id:ORC,vendor_name:'Pune Logistics',role:'vendor',cluster_scope:'',active:'TRUE'}];
_readTab=function(t){
  if(t==='Contract_Info') return CI.map(x=>Object.assign({},x));
  if(t==='Contract_Vehicles') return CV.map(x=>Object.assign({},x));
  if(t==='Trip_Level') return TL.map(x=>Object.assign({},x));
  if(t==='Access_Control') return AC.map(x=>Object.assign({},x));
  return [];
};

console.log('The adhoc-RTO construct: adhoc RTO pays, regular RTO does not, and both surfaces agree\n');

/* ---------------- 1. the classifier, both arms ---------------- */
const xAdRto  = _classifyTrip(trip({adhoc_amount:'3162.945', challan_type:'RTO only'}), {}, 'Adhoc');
const xZnRto  = _classifyTrip(trip({route_scope:'Zonal', adhoc_amount:'6100', challan_type:'RTO only'}), {}, 'Adhoc');
const xRegRto = _classifyTrip(trip({billing_type_system:'Regular', challan_type:'RTO only',
                                    total_trip_km:'180', km_accumulated_flag:'No'}), {}, 'Regular');
const xReplRto= _classifyTrip(trip({billing_type_system:'Regular', challan_type:'RTO only',
                                    total_trip_km:'180', km_accumulated_flag:'No',
                                    replacement_flag_system:'Yes'}), {}, 'Regular');
console.log('1) the classifier');
console.log('   local adhoc RTO    rto='+xAdRto.rto +'  payable='+xAdRto.payable);
console.log('   zonal adhoc RTO    rto='+xZnRto.rto +'  payable='+xZnRto.payable);
console.log('   regular RTO        rto='+xRegRto.rto+'  payable='+xRegRto.payable+'  km='+xRegRto.km+'  kmToSlab='+xRegRto.kmToSlab);
console.log('   replacement RTO    rto='+xReplRto.rto+' payable='+xReplRto.payable+'  isRepl='+xReplRto.isRepl);
ck(xAdRto.rto===true && R(xAdRto.payable)===3162.95,
   'a LOCAL adhoc RTO trip is paid its amount, and is still recorded as an RTO');
ck(xZnRto.rto===true && R(xZnRto.payable)===6100,
   'a ZONAL adhoc RTO trip is paid the same way — one rule, both scopes');
ck(R(xAdRto.amt)===R(xAdRto.payable),
   'on adhoc, amt and payable now agree — which is what removes the whole bug class');
ck(xRegRto.rto===true && R(xRegRto.payable)===0,
   'a REGULAR RTO trip still pays nothing — the arm that did NOT change');
ck(xRegRto.kmToSlab===false && R(xRegRto.km)===180,
   'and its real KM is still visible while contributing nothing to the slab');
ck(xReplRto.isRepl===true && R(xReplRto.payable)===0,
   'a REPLACEMENT RTO trip pays nothing too, because a replacement row is a Regular row');

/* ---------------- 2. the MIS totals now include adhoc RTO ---------------- */
const d=_misReadSource();
const m=buildBillingModel(ORC,d);
const c=m.contracts.filter(x=>x.cid===CID)[0];
console.log('\n2) the MIS');
console.log('   per-contract adhocAmt  = '+R(c.adhocAmt)+'   (5000 + 3162.95)');
console.log('   orphan bucket adhocAmt = '+R(m.bucket.adhocAmt)+'   (4000 + 2400)');
console.log('   totals.adhoc = '+R(m.totals.adhoc)+'    regKm = '+R(c.regKm));
ck(R(c.adhocAmt)===8162.95,'the per-contract adhoc total includes the RTO trip');
ck(!!m.bucket && R(m.bucket.adhocAmt)===6400,'so does the Other-adhoc bucket');
ck(R(m.totals.adhoc)===14562.95,'totals.adhoc = 14562.95');
ck(R(c.regKm)===0,'and the Regular RTO trip put no KM into the contract — 0 km, not 180');
const rtoListed=(c.rtoTrips||[]).filter(x=>x.id==='T-REG-RTO')[0];
ck(!!rtoListed && R(rtoListed.realKm)===180,
   'the Regular RTO trip is still listed with its real 180 km for the record');
const adRow=(c.adhocTrips||[]).filter(x=>x.id==='T-RTO-C')[0];
ck(!!adRow && R(adRow.amt)===3162.95 && adRow.rto===true,
   'the adhoc RTO trip appears on the adhoc list at its full amount, flagged rto');

/* ---------------- 3. PARITY: the panel and the MIS over the same rows ---------------- */
const pay=_buildVendorPayload(ORC);
let panelAdhoc=0, panelN=0, panelRtoShown=0;
Object.keys(pay.trips||{}).forEach(cid=>{
  (pay.trips[cid]||[]).forEach(t=>{
    if(String(t.billing||'').toLowerCase()!=='adhoc') return;
    panelN++; if(t.rto) panelRtoShown++;
    panelAdhoc+=_num(t.amt);        // the card's amount IS what the vendor is told he is paid
  });
});
const pBucket=(pay.contracts||[]).filter(x=>x.isAdhocBucket)[0];
console.log('\n3) parity');
console.log('   panel adhoc sum = '+R(panelAdhoc)+' over '+panelN+' trip(s), '+panelRtoShown+' of them RTO');
console.log('   MIS   adhoc sum = '+R(m.totals.adhoc));
ck(panelN===4,'the panel shows all four adhoc trips');
ck(panelRtoShown===2,'and marks the two RTO ones rto:true — paid, but still labelled');
ck(!!pBucket && R(pBucket.adhocTotal)===6400,'the panel bucket card totals 6400, matching the MIS bucket');
ck(R(panelAdhoc)===R(m.totals.adhoc),
   'THE PARITY ASSERTION: panel adhoc total === MIS adhoc total ('+R(panelAdhoc)+' vs '+R(m.totals.adhoc)+')');
ck(R(panelAdhoc)===14562.95,'and both are 14562.95');

/* ---------------- 4. non-vacuity: the old rule would have split them ---------------- */
let oldPanel=0;
TL.forEach(t=>{
  const x=_classifyTrip(t,{},'Adhoc');
  if(!x.isAdhoc) return;
  oldPanel += x.rto ? 0 : x.amt;        // exactly what the old payable did
});
console.log('\n4) what the old rule produced');
console.log('   old panel sum = '+R(oldPanel)+'   vs MIS '+R(m.totals.adhoc)+'   gap '+R(m.totals.adhoc-oldPanel));
ck(R(oldPanel)===9000,'under the old rule the panel would have shown 9000');
ck(R(m.totals.adhoc-oldPanel)===R(3162.945+2400),
   'a gap of exactly the two RTO amounts — the shape of the live Rs 11,726.71 on Pune Logistics');

/* ---------------- 5. the surfaces stopped saying "not payable" about adhoc ---------------- */
const html=fs.readFileSync(__dirname+'/../vercel-app/index.html','utf8');
const flat=html.replace(/\s+/g,' ');
ck(/t\.rto && t\.billing==='Adhoc'/.test(flat),
   "index.html gives an adhoc RTO row its own branch instead of the 'RTO · 0 km / Not payable' cell");
ck(!/if \( disputeTrip\.rto \) claim\.claim_challan_type/.test(flat),
   'and it no longer auto-claims "Forward Only" on every RTO dispute — an adhoc one is already paid');
ck(/disputeTrip\.rto && disputeTrip\.billing!=='Adhoc'/.test(flat),
   'the challan claim is now scoped to non-adhoc RTO trips');
const code=fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8');
ck(/var payable\s*=\s*isAdhoc \? adhocAmt : \(rto \? 0 :/.test(code),
   'Code.gs tests isAdhoc BEFORE rto — the one line the whole construct rests on');
ck(!/payable\s*=\s*rto \? 0 :/.test(code),'and the old blanket form is gone');
const bill=fs.readFileSync(__dirname+'/../apps-script/Billing.gs','utf8');
ck(/RTO-only[\s\S]{0,120}paid its trip amount|paid its trip amount even when the challan/.test(bill),
   'the MIS Adhoc tab tells the vendor an RTO adhoc trip is paid, so the row does not read as an error');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
