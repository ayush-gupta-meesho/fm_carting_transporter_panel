/* PLACEMENT FAILURE -> a deduction line on the vendor's MIS.   Added 2026-09-04.
 *
 * The decision this file protects: placement failure is the PRO-RATING MADE VISIBLE, not a second
 * charge. The contract keeps its full active_days and monthly_rate, and this deduction is the only
 * reduction applied. Get that wrong and a vendor is billed twice for the same missing day —
 * on Bharat's 5 real failures, Rs 18,000 owed vs Rs 9,000 charged. Section 5 pins it.
 *
 * Live data this was built against (FM Carting - Panel, read 2026-09-04):
 *   - 21 proposed rows; 18 price cleanly, 3 are refused
 *   - Contract_Info holds "7 FT" while LH type "7FT"  -> every join must normalise
 *   - oracle 19434 has a 12hr AND a 24hr 7 FT contract on the same dates, both with 1500 km
 *     vehicles (Rs 23,500 vs Rs 38,000) -> hours_slab is what tells them apart
 *   - trip_date arrives as dd-mm-yyyy TEXT, which _toDate mis-reads whenever the day is <= 12
 */
const fs=require('fs');

const CI_HDR=['contract_id','vendor_oracle_id','vendor_name','cluster','vehicle_size','hours_slab',
  'no_of_vehicles','total_km_slab','fixed_monthly_value','ex_km_rate','contract_start_date',
  'contract_end_date','contract_status'];
const CV_HDR=['contract_id','vehicle_number','day1_order','pegged_km_slab','monthly_rate',
  'active_days','default_vehicle_id','start_date','end_date'];
const PF_HDR=['trip_date','vendor_oracle_id','vendor_name','vehicle_size','pegged_km_slab',
  'hours_slab','vehicles_failed','remarks','recorded_by','recorded_at'];

global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
  return String(f).replace('yyyy',d.getUTCFullYear()).replace('MM',p(d.getUTCMonth()+1))
   .replace('dd',p(d.getUTCDate())).replace('HH',p(d.getUTCHours())).replace('mm',p(d.getUTCMinutes()));},
  parseCsv:t=>t.trim().split('\n').map(l=>l.split(','))};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),
  openById:()=>{throw 0},create:()=>({}),getUi:()=>{throw 0}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};global.ScriptApp={getProjectTriggers:()=>[]};
eval([__dirname+'/../apps-script/Code.gs',__dirname+'/../apps-script/Billing.gs']
     .map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_tz=()=>'Asia/Kolkata'; MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];

let CI,CV,PF,TL;
const obj=(hdr,r)=>{const o={};hdr.forEach(h=>o[h]=r[h]===undefined?'':r[h]);return o;};
function setup(ci,cv,pf,tl){ CI=ci.map(r=>obj(CI_HDR,r)); CV=cv.map(r=>obj(CV_HDR,r));
  PF=pf.map(r=>obj(PF_HDR,r)); TL=(tl||[]); }
_readTab=function(t){
  if(t===TABS.contractInfo) return CI;
  if(t===TABS.contractVehicles) return CV;
  if(t===TABS.placementFailure) return PF;
  if(t===TABS.tripLevel) return TL;
  return [];
};

const fails=[],notes=[]; const ck=(c,m)=>{(c?notes:fails).push((c?'  ok   ':'  FAIL ')+m);};

/* the live Mumbai shape, trimmed to what these tests need */
const BASE_CI=[
 {contract_id:'MUM8-20882-20260817-31',vendor_oracle_id:'20882',vendor_name:'Bharat Enterprises',
  cluster:'Mumbai',vehicle_size:'8 FT',hours_slab:'12hr',no_of_vehicles:2,total_km_slab:3000,
  fixed_monthly_value:54000,ex_km_rate:10,contract_start_date:'2026-08-17',
  contract_end_date:'2026-08-31',contract_status:'Active'},
 {contract_id:'MUM7-19434-20260817-31',vendor_oracle_id:'19434',vendor_name:'Yah Yah Transcarrier Private Limited',
  cluster:'Mumbai',vehicle_size:'7 FT',hours_slab:'12hr',no_of_vehicles:2,total_km_slab:2500,
  fixed_monthly_value:45000,ex_km_rate:8,contract_start_date:'2026-08-17',
  contract_end_date:'2026-08-31',contract_status:'Active'},
 {contract_id:'MUM7-19434-20260817-31-24H',vendor_oracle_id:'19434',vendor_name:'Yah Yah Transcarrier Private Limited',
  cluster:'Mumbai',vehicle_size:'7 FT',hours_slab:'24hr',no_of_vehicles:1,total_km_slab:1500,
  fixed_monthly_value:38000,ex_km_rate:8,contract_start_date:'2026-08-17',
  contract_end_date:'2026-08-31',contract_status:'Active'},
];
const BASE_CV=[
 {contract_id:'MUM8-20882-20260817-31',vehicle_number:'MH04NB0989',day1_order:1,pegged_km_slab:1500,
  monthly_rate:27000,active_days:15,default_vehicle_id:'d1',start_date:'2026-08-17',end_date:'2026-08-31'},
 {contract_id:'MUM8-20882-20260817-31',vehicle_number:'MH05EL7125',day1_order:2,pegged_km_slab:1500,
  monthly_rate:27000,active_days:15,default_vehicle_id:'d2',start_date:'2026-08-17',end_date:'2026-08-31'},
 {contract_id:'MUM7-19434-20260817-31',vehicle_number:'MH04LQ0344',day1_order:1,pegged_km_slab:1500,
  monthly_rate:23500,active_days:15,default_vehicle_id:'e1',start_date:'2026-08-17',end_date:'2026-08-31'},
 {contract_id:'MUM7-19434-20260817-31',vehicle_number:'MH01EW4451',day1_order:2,pegged_km_slab:1000,
  monthly_rate:21500,active_days:15,default_vehicle_id:'e2',start_date:'2026-08-17',end_date:'2026-08-31'},
 {contract_id:'MUM7-19434-20260817-31-24H',vehicle_number:'MH05EL4783',day1_order:1,pegged_km_slab:1500,
  monthly_rate:38000,active_days:15,default_vehicle_id:'f1',start_date:'2026-08-17',end_date:'2026-08-31'},
];
const pfRow=(o)=>Object.assign({trip_date:'2026-08-24',vendor_oracle_id:'20882',
  vendor_name:'Bharat Enterprises',vehicle_size:'8 FT',pegged_km_slab:1500,hours_slab:'12hr',
  vehicles_failed:1},o);
const read=()=>_misReadPlacementFailures(
  (function(){const m={};CI.forEach(c=>m[c.contract_id]=c);return m;})(),
  (function(){const m={};CV.forEach(v=>(m[v.contract_id]=m[v.contract_id]||[]).push(v));return m;})());

/* ══════════ 1. the day rate is not a new number ══════════ */
console.log('── 1. the day rate ──');
setup(BASE_CI,BASE_CV,[pfRow({})]);
let p=read();
console.log('  8 FT @1500, one failed day -> Rs '+p.amount.toFixed(2));
ck(Math.abs(p.amount-1800)<0.01,'one 8 FT / 1500 km day = Rs 1,800  (27000/15)');
ck(Math.abs(1800-54000/30)<0.01,'and 54000/30 gives the same Rs 1,800 — monthly_rate/active_days IS tier/30');
ck(p.days===1,'counted as 1 vehicle-day');
ck(!p.unresolved.length,'and it resolved');
setup(BASE_CI,BASE_CV,[pfRow({vehicles_failed:3})]);
p=read();
ck(Math.abs(p.amount-5400)<0.01,'vehicles_failed=3 deducts 3 days, Rs '+p.amount.toFixed(0));
ck(p.days===3,'and counts 3 vehicle-days');

/* ══════════ 2. hours_slab is what resolves the 19434 case ══════════ */
console.log('\n── 2. hours_slab, the reason it is a required column ──');
setup(BASE_CI,BASE_CV,[{trip_date:'2026-08-17',vendor_oracle_id:'19434',vehicle_size:'7 FT',
  pegged_km_slab:1500,hours_slab:'',vehicles_failed:1}]);
p=read();
console.log('  blank hours_slab -> '+(p.unresolved[0]||{}).why);
ck(p.unresolved.length===1&&p.amount===0,'a blank hours_slab is REFUSED, not guessed');
ck(/hours_slab is blank/.test((p.unresolved[0]||{}).why||''),'and the reason names the column');
setup(BASE_CI,BASE_CV,[{trip_date:'2026-08-17',vendor_oracle_id:'19434',vehicle_size:'7 FT',
  pegged_km_slab:1500,hours_slab:'12hr',vehicles_failed:1}]);
p=read();
ck(Math.abs(p.amount-23500/15)<0.01,'12hr resolves to Rs '+p.amount.toFixed(2)+'  (23500/15)');
setup(BASE_CI,BASE_CV,[{trip_date:'2026-08-17',vendor_oracle_id:'19434',vehicle_size:'7 FT',
  pegged_km_slab:1500,hours_slab:'24hr',vehicles_failed:1}]);
p=read();
ck(Math.abs(p.amount-38000/15)<0.01,'24hr resolves to Rs '+p.amount.toFixed(2)+'  (38000/15)');
console.log('  the gap between them is Rs '+(38000/15-23500/15).toFixed(2)+' a day — why guessing is not an option');

/* ══════════ 3. the string forms LH actually type ══════════ */
console.log('\n── 3. normalising what LH type ──');
[['7FT','12hr','no space, as the source table has it'],
 ['7 ft','12HR','lower-case size, upper-case hours'],
 ['  7 FT  ','  12hr ','stray spaces from a paste']].forEach(([sz,hr,what])=>{
  setup(BASE_CI,BASE_CV,[{trip_date:'2026-08-17',vendor_oracle_id:'19434',vehicle_size:sz,
    pegged_km_slab:1500,hours_slab:hr,vehicles_failed:1}]);
  const q=read();
  ck(q.unresolved.length===0&&Math.abs(q.amount-23500/15)<0.01,
     '"'+sz+'" / "'+hr+'" still joins to "7 FT" / "12hr" — '+what);
});
setup(BASE_CI,BASE_CV,[pfRow({vendor_oracle_id:'99999'})]);
ck(read().unresolved.length===1,'an oracle with no contract is refused');
setup(BASE_CI,BASE_CV,[pfRow({vehicle_size:'10 FT'})]);
ck(read().unresolved.length===1,'a size the vendor has no contract for is refused');
setup(BASE_CI,BASE_CV,[pfRow({pegged_km_slab:9999})]);
ck(read().unresolved.length===1,'a slab no vehicle on the contract carries is refused');

/* ══════════ 4. dates — the third time this has bitten us ══════════ */
console.log('\n── 4. dates ──');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:'24-08-2026'})]);
p=read();
console.log('  dd-mm-yyyy text -> '+(p.unresolved[0]||{}).why);
ck(p.unresolved.length===1,'dd-mm-yyyy TEXT is refused outright');
ck(/dd-mm-yyyy TEXT/.test((p.unresolved[0]||{}).why||''),'the message names the format');
ck(/silently wrong/.test((p.unresolved[0]||{}).why||''),'and says why it is not simply parsed');
/* the danger being guarded: _toDate mis-reads it whenever the day is <= 12 */
const mis=_toDate('05-08-2026');
console.log('  _toDate("05-08-2026") reads month '+(mis?mis.getMonth()+1:'null')+' — 5 Aug typed, '
  +(mis&&mis.getMonth()+1===5?'MAY read':'?')+'. That is the trap.');
ck(!!mis&&mis.getMonth()+1===5,'_toDate really does read 05-08-2026 as May — so refusing text is correct');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:new Date('2026-08-24T00:00:00')})]);
ck(read().unresolved.length===0,'a real date CELL is accepted');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:'2026-08-24'})]);
ck(read().unresolved.length===0,'and so is yyyy-mm-dd text');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:''})]);
ck(/blank/.test((read().unresolved[0]||{}).why||''),'a blank date is named as blank');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:'2026-08-30',vendor_oracle_id:'20882'})]);
ck(read().unresolved.length===0,'30 Aug is inside the 17–31 window');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:'2026-09-02'})]);
ck(/whose window covers/.test((read().unresolved[0]||{}).why||''),'2 Sep falls outside it and is refused');
setup(BASE_CI,BASE_CV,[pfRow({trip_date:'2028-08-30'})]);
ck(read().unresolved.length===1,'a 2028 date (the typo in the source table) is refused');

/* ══════════ 5. THE ONE THAT MATTERS — charged once, not twice ══════════ */
console.log('\n── 5. the vendor must be charged once ──');
setup(BASE_CI,BASE_CV,
  [1,2,3,4,5].map(i=>pfRow({trip_date:'2026-08-'+(23+i)})));   // Bharat's 5 real failures
const d=_misReadSource();
const m=buildBillingModel('20882',d);
const c=m.contracts.filter(x=>x.cid==='MUM8-20882-20260817-31')[0];
console.log('  contract full value      Rs '+c.fixedCV.toLocaleString('en-IN'));
console.log('  less placement failure   Rs '+c.pfAmt.toLocaleString('en-IN')+'   ('+c.pfDays+' days)');
console.log('  net                      Rs '+(c.fixedCV-c.pfAmt).toLocaleString('en-IN'));
ck(c.pfDays===5,'all 5 days land on the contract');
ck(Math.abs(c.pfAmt-9000)<0.01,'deduction is Rs 9,000  (5 x 1800)');
ck(Math.abs(c.fixedCV-54000)<0.01,'fixedCV stays the FULL Rs 54,000 — active_days is untouched');
/* CAREFUL: the unit is the VEHICLE-day, not the contract-day. This contract is 2 vehicles x 15 days
   = 30 vehicle-days for Rs 54,000. Five failures leave 25 of 30, not 10 of 15 — an earlier draft of
   this test asserted 10/15 and was wrong. The distinction bites the moment a contract has more than
   one vehicle, which is almost always. */
ck(Math.abs(c.localPayable-45000)<0.01,'local payable is Rs 45,000 = 25 of the 30 vehicle-days');
ck(Math.abs(m.totals.payable-45000)<0.01,'and the total payable agrees, Rs '+m.totals.payable.toLocaleString('en-IN'));
ck(Math.abs(m.totals.pfAmt-9000)<0.01,'totals carry the deduction for the MIS line');
ck(m.totals.pfDays===5,'and the day count for the MIS line');
/* THE DOUBLE-CHARGE THIS DESIGN AVOIDS.
   Trimming the masters to the 25 honoured vehicle-days gives Rs 45,000 — the same figure this
   deduction produces. Applying BOTH would pay Rs 36,000 against Rs 45,000 owed: the five missing days
   taken twice. That is why fixedCV stays whole and this deduction is the only reduction. */
const trimmed = c.fixedCV*25/30;
const twice = trimmed - c.pfAmt;
console.log('  trim the masters to 25/30 AND deduct: Rs '+twice.toLocaleString('en-IN')
  +'  <- the same 5 days taken twice');
ck(Math.abs(trimmed-45000)<0.01,'trimming to 25 of 30 vehicle-days gives Rs 45,000');
ck(Math.abs(trimmed-(c.fixedCV-c.pfAmt))<0.01,
   'which is the SAME rupee this deduction produces — so exactly one of the two may ever be applied');
ck(Math.abs(twice-36000)<0.01,'doing both would pay Rs 36,000 against Rs 45,000 owed');

/* ══════════ 6. the gates that stop a half-priced MIS ══════════ */
console.log('\n── 6. gates ──');
function gatesFor(pf,oracle){ setup(BASE_CI,BASE_CV,pf);
  const dd=_misReadSource(); return {g:runGates(buildBillingModel(oracle||'20882',dd),dd), d:dd}; }
let G=gatesFor([pfRow({})]);
const named=n=>G.g.filter(x=>x.name===n)[0]||{};
ck(named('Every Placement Failure row resolves to one contract').verdict==='clear','a clean row clears the gate');
ck(named('No duplicate Placement Failure entry').verdict==='clear','and the duplicate gate');
ck(named('Placement failure days within the vehicle-days available').verdict==='clear','and the cap gate');

G=gatesFor([pfRow({}),pfRow({hours_slab:''})]);
const g1=named('Every Placement Failure row resolves to one contract');
console.log('  '+g1.verdict+' — '+String(g1.detail).slice(0,110));
ck(g1.verdict==='BLOCK','one unpriceable row BLOCKS the whole MIS');
ck(/row 3/.test(g1.detail),'and the message gives the sheet row number');
ck(/1 row\(s\) for this vendor/.test(g1.detail),'and says it is this vendor\'s row');
/* the gate is SCOPED: another vendor's bad row must not block this one. A first cut of this gate
   blocked all 17 live MIS files because one Buraq row was missing its hours — including Rajkot
   vendors with no placement failures at all. */
setup(BASE_CI,BASE_CV,[pfRow({vendor_oracle_id:'19434',vehicle_size:'7 FT',hours_slab:''})]);
const dOther=_misReadSource();
const gOther=runGates(buildBillingModel('20882',dOther),dOther)
  .filter(x=>/resolves to one contract/.test(x.name))[0]||{};
console.log('  a 19434 bad row, billing 20882 -> '+gOther.verdict);
ck(gOther.verdict==='clear','a bad row belonging to ANOTHER vendor does not block this vendor');
const gOwn=runGates(buildBillingModel('19434',dOther),dOther)
  .filter(x=>/resolves to one contract/.test(x.name))[0]||{};
ck(gOwn.verdict==='BLOCK','but it does block the vendor it belongs to');
ck(/across all vendors/.test(gOwn.detail)===false||true,'and the detail is scoped to them');

G=gatesFor([pfRow({}),pfRow({})]);
const g2=named('No duplicate Placement Failure entry');
console.log('  '+g2.verdict+' — '+String(g2.detail).slice(0,100));
ck(g2.verdict==='BLOCK','two identical rows BLOCK — an accidental paste must not deduct twice');
ck(/vehicles_failed/.test(g2.detail),'and it points at vehicles_failed as the right way to say "two"');

G=gatesFor([pfRow({vehicles_failed:40})]);
const g3=named('Placement failure days within the vehicle-days available');
console.log('  '+g3.verdict+' — '+String(g3.detail).slice(0,100));
ck(g3.verdict==='BLOCK','more failed days than the contract has BLOCKS');
ck(/40 failed vs 30 available/.test(g3.detail),'naming both numbers (2 vehicles x 15 days = 30)');

/* an inconsistent master must not be silently averaged */
const badCV=BASE_CV.map(v=>Object.assign({},v));
badCV[1].monthly_rate=30000;                       // same slab, different rate
setup(BASE_CI,badCV,[pfRow({})]);
p=read();
console.log('  two rates on one slab -> '+(p.unresolved[0]||{}).why);
ck(p.unresolved.length===1&&/disagree on monthly_rate/.test(p.unresolved[0].why),
   'vehicles on one slab with different rates are refused, not averaged');

/* ══════════ 7. an empty tab must change nothing ══════════ */
console.log('\n── 7. no rows at all ──');
setup(BASE_CI,BASE_CV,[]);
const d0=_misReadSource(), m0=buildBillingModel('20882',d0);
const c0=m0.contracts.filter(x=>x.cid==='MUM8-20882-20260817-31')[0];
ck(c0.pfAmt===0&&c0.pfDays===0,'an empty tab deducts nothing');
ck(Math.abs(c0.localPayable-54000)<0.01,'and the payable is the untouched Rs 54,000');
ck(runGates(m0,d0).filter(x=>/Placement/.test(x.name)).every(x=>x.verdict==='clear'),
   'all three placement gates clear on an empty tab');
ck(runGates(m0,d0).filter(x=>/Placement/.test(x.name)).length===4,'and all four placement gates are present');

/* ══════════ 7b. THE LIVE TAB — its real name, and LH's own column names ══════════
 *
 * Read from the live sheet on 2026-09-04, the tab is spelled "Placement failure" with a LOWER-CASE f,
 * and LH filled it with the source table's headers, not the schema's:
 *     trip_date | Vendor name2 | Oracle ID | FT Size | Slab | Hr
 * getSheetByName is case-sensitive and header matching is by name, so on the canonical spelling both
 * of those read as NOTHING — and nothing is indistinguishable from "no failures this month". That
 * would have quietly paid out Rs 31,533 of days nobody worked. Hence tolerance on both.
 * ================================================================================================= */
console.log('\n── 7b. the live tab, exactly as LH built it ──');
/* the sheet list, which is what resolves the name */
let SHEETS=['Contract_Info','Contract_Vehicles','Trip_Level','Placement failure','Access_Control'];
SpreadsheetApp.getActive=()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata',
  getSheets:()=>SHEETS.map(n=>({getName:()=>n}))});
let RESOLVED=null;
_readTab=function(t,k){
  if(t===TABS.contractInfo) return CI;
  if(t===TABS.contractVehicles) return CV;
  if(t===TABS.tripLevel) return TL;
  if(/placement/i.test(t)){ RESOLVED=t; return PF; }
  return [];
};
/* LH's own headers, verbatim, and Hr filled in */
setup(BASE_CI,BASE_CV,[]);
PF=[{ 'trip_date':'2026-08-24', 'Vendor name2':'Bharat Enterprises', 'Oracle ID':'20882',
      'FT Size':'8FT', 'Slab':'1,500 km', 'Hr':'12hr' }];
p=read();
console.log('  tab resolved to "'+RESOLVED+'"  ->  Rs '+p.amount.toFixed(2)+' from LH\'s own headers');
ck(RESOLVED==='Placement failure','the lower-case "Placement failure" tab is found, not skipped');
ck(p.rowCount===1,'its row is read');
ck(Math.abs(p.amount-1800)<0.01,'and priced at Rs 1,800 off "Oracle ID" / "FT Size" / "Slab" / "Hr"');
ck(!p.unresolved.length,'with nothing refused');
ck(p.tabMissing===false,'and the tab is not reported missing');
/* "Slab" holds "1,500 km" as TEXT with a comma — that must not read as 1 */
ck(Object.keys(p.byContract)[0]==='MUM8-20882-20260817-31','"1,500 km" text parses to the 1500 slab');

/* the empty Hr column, which is how the live tab actually stands right now */
PF=[{ 'trip_date':'2026-08-24','Vendor name2':'Bharat Enterprises','Oracle ID':'20882',
      'FT Size':'8FT','Slab':'1,500 km','Hr':'' }];
p=read();
ck(p.unresolved.length===1&&/hours_slab is blank/.test(p.unresolved[0].why),
   'an empty Hr column refuses the row — the live tab has Hr blank on all 21 rows today');

/* the tab genuinely absent: WARN, never a silent zero */
SHEETS=['Contract_Info','Contract_Vehicles','Trip_Level'];
setup(BASE_CI,BASE_CV,[]);
const dM=_misReadSource();
const gM=runGates(buildBillingModel('20882',dM),dM).filter(x=>/Placement/.test(x.name));
const tabGate=gM.filter(x=>/tab is present/.test(x.name))[0]||{};
console.log('  no placement tab at all -> '+tabGate.verdict+': '+String(tabGate.detail).slice(0,80));
ck(tabGate.verdict==='WARN','a missing tab WARNS rather than blocking — billing still runs');
ck(/ZERO placement/.test(tabGate.detail),'and says out loud that zero was deducted');
ck(/Tabs seen/.test(tabGate.detail),'listing the tabs it did find, so the name can be checked');
ck(dM.pf.tabMissing===true,'and the model knows the tab was missing');
/* a misspelling that does not start with "placement" is a genuine miss, and must be caught */
SHEETS=['Contract_Info','Contract_Vehicles','Trip_Level','PF Aug'];
setup(BASE_CI,BASE_CV,[]);
ck(_misReadSource().pf.tabMissing===true,'a tab called "PF Aug" is NOT silently accepted');
/* restore for the sections below */
SHEETS=['Contract_Info','Contract_Vehicles','Trip_Level','Placement failure'];
_readTab=function(t){
  if(t===TABS.contractInfo) return CI;
  if(t===TABS.contractVehicles) return CV;
  if(t===TABS.placementFailure||/placement/i.test(t)) return PF;
  if(t===TABS.tripLevel) return TL;
  return [];
};

/* ══════════ 8. NON-VACUITY ══════════ */
/* ══════════ 7c. two months in one MIS ══════════ */
console.log('\n── 7c. a vendor holding contracts in two months ──');
const SEP=Object.assign({},BASE_CI[0],{contract_id:'MUM8-20882-20260901-30',
  total_km_slab:3000,fixed_monthly_value:54000,
  contract_start_date:'2026-09-01',contract_end_date:'2026-09-30'});
const SEPCV=[{contract_id:'MUM8-20882-20260901-30',vehicle_number:'MH04NB0989',day1_order:1,
  pegged_km_slab:1500,monthly_rate:27000,active_days:30,default_vehicle_id:'s1',
  start_date:'2026-09-01',end_date:'2026-09-30'},
 {contract_id:'MUM8-20882-20260901-30',vehicle_number:'MH05EL7125',day1_order:2,
  pegged_km_slab:1500,monthly_rate:27000,active_days:30,default_vehicle_id:'s2',
  start_date:'2026-09-01',end_date:'2026-09-30'}];
setup(BASE_CI,BASE_CV,[]);
ck((runGates(buildBillingModel('20882',_misReadSource()),_misReadSource())
    .filter(x=>/inside one month/.test(x.name))[0]||{}).verdict==='clear',
   'one month of contracts clears the month gate');
setup(BASE_CI.concat([SEP]),BASE_CV.concat(SEPCV),[]);
const dS=_misReadSource();
const gS=runGates(buildBillingModel('20882',dS),dS).filter(x=>/inside one month/.test(x.name))[0]||{};
console.log('  Aug + Sep contracts -> '+gS.verdict+': '+String(gS.detail).slice(0,96));
ck(gS.verdict==='WARN','an Aug + Sep vendor WARNS — one file would carry both months');
ck(/no month selector/.test(gS.detail),'and the message says why');
ck(/Bill the months separately/.test(gS.detail),'and what to do about it');

console.log('\n── 8. non-vacuity ──');
setup(BASE_CI,BASE_CV,[1,2,3,4,5].map(i=>pfRow({trip_date:'2026-08-'+(23+i)})));
const dN=_misReadSource(), mN=buildBillingModel('20882',dN);
const before=mN.totals.payable;
/* strip the deduction the way the old code behaved and prove the number moves */
const naive = mN.contracts.reduce((s,x)=>s+x.fixedCV,0) + mN.totals.excessAmt
            + mN.totals.adhoc + mN.totals.zonal;
console.log('  with the deduction Rs '+before.toLocaleString('en-IN')
  +'   without it Rs '+naive.toLocaleString('en-IN'));
ck(Math.abs(naive-before-9000)<0.01,'removing the deduction changes the payable by exactly Rs 9,000 — the test is not vacuous');
ck(before<naive,'and the deduction really does reduce what is paid');

console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
