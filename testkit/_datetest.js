/* DATES — the quiet failure mode.
   Nothing in this system shouts when a date is wrong. `_toDate` returns null, the period gate opens
   instead of closing, the projection divides by a 235-day window instead of a 31-day one, and every
   number downstream is plausible and wrong. The live sanity check of 2026-08-07 found exactly this:
   `contract_end_date` held the TEXT "31-08-2026", which _toDate cannot read, and `contract_start_date`
   held 8 January instead of 1 August.

   This file pins the behaviour so the next bad cell is caught by a test instead of by a vendor.
*/
const fs=require('fs');
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return String(f).replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
   .replace('yy',String(d.getFullYear()).slice(2)).replace('d',d.getDate())
   .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'})};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata'};global.Logger={log:()=>{}};
global.HtmlService={};global.CacheService={};global.PropertiesService={};global.UrlFetchApp={};
global.MailApp={};global.DriveApp={};
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Billing.gs','utf8'));
_tz=()=>'Asia/Kolkata';

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };

/* ==================================================================================================
 * 1. _toDate — exactly which cell formats are readable
 * ================================================================================================= */
console.log('── 1. _toDate: what the sheet can hold, and what the code can read ──');
const CASES=[
  ['2026-08-01',                 true,  'ISO date — what a real date cell serialises to'],
  ['2026-08-01 00:00',           true,  'ISO date + time'],
  ['2026-08-01T09:30:00',        true,  'full ISO'],
  ['2026-08-31',                 true,  'the correct end date'],
  ['31-08-2026',                 false, 'dd-mm-yyyy TEXT — THE LIVE BUG. Unreadable.'],
  ['01-08-2026',                 true,  'dd-mm-yyyy TEXT with dd<=12 — parses, as 8 JANUARY. The root cause.'],
  ['31/08/2026',                 false, 'dd/mm/yyyy TEXT — unreadable'],
  ['08/31/2026',                 true,  'mm/dd/yyyy TEXT — readable, but only because JS assumes US order'],
  ['',                           false, 'blank'],
  [null,                         false, 'null'],
  [undefined,                    false, 'undefined'],
  ['   ',                        false, 'whitespace'],
  ['not a date',                 false, 'garbage'],
  [new Date('2026-08-01'),       true,  'a real Date object from a date-formatted cell'],
  [new Date('nonsense'),         false, 'an invalid Date object'],
];
CASES.forEach(function(c){
  const d=_toDate(c[0]);
  console.log('  '+JSON.stringify(String(c[0])).padEnd(24)
    +(d?d.toISOString().slice(0,10):'*** null ***').padEnd(16)+c[2]);
  ck(!!d===c[1],'_toDate('+JSON.stringify(String(c[0]))+') '+(c[1]?'parses':'returns null')+' — '+c[2]);
});
/* the trap named explicitly, because it cost a live sheet */
ck(_toDate('31-08-2026')===null,
   'THE LIVE BUG: a dd-mm-yyyy text end date is UNREADABLE, so the contract has no end date at all');
ck(_toDate('2026-08-31')!==null && _toDate('2026-08-31').getMonth()===7,
   'the fix — a real date cell — reads as August');
/* and the day/month swap that produced "8 Jan" instead of "1 Aug": both parse, so nothing complains */
ck(_toDate('2026-01-08')!==null && _toDate('2026-08-01')!==null,
   'the OTHER live bug is worse: 2026-01-08 and 2026-08-01 BOTH parse, so a swap is silent');
/* ROOT CAUSE, found by this test: the two live findings are ONE bug wearing two faces. If ops types
   the Indian format as text, JS reads dd-mm-yyyy as mm-dd-yyyy whenever the day is <= 12 — so
   "01-08-2026" (1 August) silently becomes 8 JANUARY, which is exactly the start date in the live
   sheet. When the day is > 12 there is no valid month to map it to, so it returns null instead — which
   is exactly the end date, "31-08-2026". Same typing mistake, two different silent failures. */
ck(_toDate('01-08-2026')!==null && _toDate('01-08-2026').getMonth()===0
   && _toDate('01-08-2026').getDate()===8,
   'ROOT CAUSE: the text "01-08-2026" (1 Aug in India) parses as 8 JANUARY — this is where the live '
   +'contract_start_date of 2026-01-08 came from');
ck(_toDate('31-08-2026')===null,
   'and the SAME typing mistake on the 31st returns null instead, because there is no 31st month — '
   +'which is where the unreadable contract_end_date came from');
ck(_toDate('13-08-2026')===null && _toDate('12-08-2026')!==null,
   'the boundary is the 12th: dd<=12 parses WRONGLY, dd>12 fails LOUDLY. Never store dates as text.');
ck(_toDate('2026-01-08').getMonth()===0 && _toDate('2026-08-01').getMonth()===7,
   'which is why the sanity check has to compare against Contract_Vehicles, not just parse');

/* ==================================================================================================
 * 2. _fmtRange — what the vendor actually sees when a date is bad
 * ================================================================================================= */
console.log('\n── 2. _fmtRange: the vendor-facing Duration ──');
const R1=_fmtRange('2026-08-01','2026-08-31');
const R2=_fmtRange('2026-01-08 00:00','31-08-2026');       // the live state
const R3=_fmtRange('','');
console.log('  correct data  : "'+R1+'"');
console.log('  the live state: "'+R2+'"');
console.log('  both blank    : "'+R3+'"');
ck(R1==='1 Aug – 31 Aug 2026','correct dates render as "1 Aug – 31 Aug 2026"');
ck(/31-08-2026/.test(R2),'an unparseable end date is printed RAW — the vendor sees the broken cell');
ck(/2026-01-08/.test(R2),'and so is the start, so the vendor sees "2026-01-08 – 31-08-2026"');
ck(R3==='','two blanks render as nothing rather than "Invalid Date"');
ck(_fmtRange('2026-08-01','')==='2026-08-01','one blank falls back to printing what there is');

/* ==================================================================================================
 * 3. _misInPeriod — the gate that opens when it should close
 * ================================================================================================= */
console.log('\n── 3. _misInPeriod ──');
const GOOD={contract_start_date:'2026-08-01',contract_end_date:'2026-08-31'};
const LIVE={contract_start_date:'2026-01-08',contract_end_date:'31-08-2026'};   // as found in the sheet
const T=d=>({trip_date:d});
console.log('  trip date     correct window   the live window');
[['2026-08-15',true,true],['2026-08-01',true,true],['2026-08-31',true,true],
 ['2026-07-31',false,true],['2026-09-01',false,true],['2026-02-14',false,true]].forEach(function(r){
  const g=_misInPeriod(T(r[0]),GOOD), l=_misInPeriod(T(r[0]),LIVE);
  console.log('  '+r[0].padEnd(14)+String(g).padEnd(17)+String(l)+(g!==l?'   <<< the gate is wrong':''));
  ck(g===r[1],'a trip on '+r[0]+' is '+(r[1]?'inside':'outside')+' the correct 1–31 Aug window');
  ck(l===r[2],'  and the live window wrongly reports it '+(r[2]?'inside':'outside'));
});
ck(_misInPeriod(T('2026-02-14'),GOOD)===false && _misInPeriod(T('2026-02-14'),LIVE)===true,
   'THE CONSEQUENCE: a February trip is correctly rejected by a good window and WRONGLY ACCEPTED by the live one');
/* the boundaries are inclusive, and the time of day must not matter */
ck(_misInPeriod({trip_date:'2026-08-31T23:59:00'},GOOD)===true,'the last day is inclusive to the last minute');
ck(_misInPeriod({trip_date:'2026-08-01T00:00:00'},GOOD)===true,'and so is the first');
ck(_misInPeriod({trip_date:'2026-09-01T00:00:01'},GOOD)===false,'one second past the window is outside');
/* the fail-open rule: an unreadable date must never silently DROP a trip */
ck(_misInPeriod(T(''),GOOD)===true,'a trip with no date is kept, not dropped (never lose money silently)');
ck(_misInPeriod(T('31-08-2026'),GOOD)===true,'a trip with an unreadable date is kept too');
ck(_misInPeriod(T('2026-08-15'),{contract_start_date:'',contract_end_date:''})===true,
   'a contract with no window keeps every trip');
ck(_misInPeriod(T('2026-08-15'),{contract_start_date:'2026-08-01',contract_end_date:'31-08-2026'})===true,
   'and so does one whose END date is unreadable — the window cannot close, which is the live state');
/* trip_end_time is the documented fallback when trip_date is blank */
ck(_misInPeriod({trip_date:'',trip_end_time:'2026-08-15T18:00:00'},GOOD)===true,
   'trip_end_time is used when trip_date is blank');
ck(_misInPeriod({trip_date:'',trip_end_time:'2026-02-15T18:00:00'},GOOD)===false,
   'and it is really gated, not just accepted');

/* ==================================================================================================
 * 4. _projFields — the projection, and what a 235-day window does to it
 * ================================================================================================= */
console.log('\n── 4. _projFields: the OVER / UNDER / ON-TRACK badge ──');
/* _projFields reads the real clock, so the assertions below are written against relationships that
   hold whatever today is, plus one frozen-clock case for the exact arithmetic. */
const _D=global.Date;
function freeze(iso){ const F=function(...a){ return a.length?new _D(...a):new _D(iso); };
  F.prototype=_D.prototype; F.now=()=>new _D(iso).getTime(); F.parse=_D.parse; F.UTC=_D.UTC; global.Date=F; }
function unfreeze(){ global.Date=_D; }

/* the window is _toDate('2026-08-01') .. _toDate('2026-08-31'), i.e. 30 day-gaps, so the exact
   midpoint is 16 Aug 00:00 UTC — not 16 Aug noon IST, which is 15.27 days in and projects 2,947. */
freeze('2026-08-16T00:00:00Z');        // exactly half way through the 30-day gap
let good=_projFields(1500,3000,'2026-08-01','2026-08-31');
let live=_projFields(1500,3000,'2026-01-08','31-08-2026');
let none=_projFields(1500,3000,'','');
unfreeze();
console.log('  half way through August, 1500 of 3000 km run:');
console.log('    correct window : projected '+good.projected+' km  '+good.projPct+'%  '+good.sizing
  +'   expected-by-now '+good.expected);
console.log('    live window    : projected '+live.projected+' km  '+live.projPct+'%  '+live.sizing
  +'   expected-by-now '+live.expected);
console.log('    no window      : projected '+none.projected+' km  '+none.sizing+'  (30-day fallback)');
ck(good.projected===3000,'a contract half way through, half its slab run, projects to exactly its slab');
ck(good.projPct===100,'so it is 100% of slab');
ck(good.sizing==='good','and the badge is ON-TRACK');
ck(good.expected===1500,'expected-by-now is half the slab');
ck(live.projected!==3000,'the LIVE window projects something else entirely ('+live.projected+' km)');
ck(live.sizing!=='good','and shows the wrong badge ('+live.sizing.toUpperCase()+')');
ck(live.projected<good.projected,
   'specifically it UNDER-projects, because a 235-day window makes 15 days look like the very start');
/* the fallback when there is no window at all */
ck(none.projected>0,'a contract with no dates still projects on a 30-day fallback rather than dividing by zero');
/* the badge thresholds, stated */
freeze('2026-08-31T23:00:00+05:30');    // the window is over: projected == actual
ck(_projFields(3000,3000,'2026-08-01','2026-08-31').sizing==='good','at slab exactly -> ON-TRACK');
ck(_projFields(3070,3000,'2026-08-01','2026-08-31').sizing==='over','2.3% over slab -> OVER');
ck(_projFields(3020,3000,'2026-08-01','2026-08-31').sizing==='good','0.7% over is still ON-TRACK (2% tolerance)');
ck(_projFields(2600,3000,'2026-08-01','2026-08-31').sizing==='under','13% under slab -> UNDER');
ck(_projFields(2750,3000,'2026-08-01','2026-08-31').sizing==='good','8% under is still ON-TRACK (10% tolerance)');
ck(_projFields(500,0,'2026-08-01','2026-08-31').projPct===0,'a zero slab gives 0% rather than dividing by zero');
ck(_projFields(0,3000,'2026-08-01','2026-08-31').projected===0,'zero KM projects to zero, not to NaN');
unfreeze();
/* a trip window that has not started yet must not project to infinity */
freeze('2026-07-01T12:00:00+05:30');
const future=_projFields(0,3000,'2026-08-01','2026-08-31');
unfreeze();
console.log('  before the contract starts: projected '+future.projected+' km');
ck(isFinite(future.projected),'a contract that has not started yet projects a finite number, not Infinity');

/* ==================================================================================================
 * 5. the sanity check itself, as a test — the live cells, and what they should be
 * ================================================================================================= */
console.log('\n── 5. the live findings, pinned ──');
const LIVE_CELLS={contract_start_date:'2026-01-08 00:00',contract_end_date:'31-08-2026'};
const CV_CELLS  ={start_date:'2026-08-01 00:00',         end_date:'2026-08-31 00:00'};
ck(_toDate(CV_CELLS.end_date)!==null,'Contract_Vehicles.end_date parses — which is why it is the source of truth');
ck(_toDate(LIVE_CELLS.contract_end_date)===null,'Contract_Info.contract_end_date does not');
const a=_toDate(LIVE_CELLS.contract_start_date), b=_toDate(CV_CELLS.start_date);
ck(a && b && a.getMonth()!==b.getMonth(),
   'and the two start dates disagree on the MONTH (Jan vs Aug) — the day/month swap');
ck(Math.round((_toDate(CV_CELLS.end_date)-_toDate(CV_CELLS.start_date))/86400000)===30,
   'the correct window is 30 day-gaps = 31 active days, matching active_days on all 72 vehicle rows');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
