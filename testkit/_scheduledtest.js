/* THE SCHEDULED RUN — 14:30 / 18:30 / 22:30 / 03:30 IST, everything menu 4 does minus Adhoc and RTO.
 *
 * The one thing this file exists to stop: a filter that matches nothing and looks like it works.
 * The request named `challan_type = 'RTO Only'`. The live sheet stores **`RTO only`** with a lowercase
 * o on 145 rows (plus one bare `RTO`), so an exact-match test matches 0 of 3,911 rows — the filter
 * would run, report success, and hold back nothing. Section 1 pins the real strings.
 *
 * Second thing: menu 4 must stay UNFILTERED. It is the manual release valve for held trips, and if it
 * ever inherits the filter, a held trip can never be sent at all.
 */
const fs=require('fs');

const TL_HDR=['trip_id','row_id','transporter_oracle_id','route_scope','rfq_id','contract_id',
  'vehicle_number','vendor_status','billing_type_system','billing_type_final','billing_type_resolved',
  'replaced_default_vehicle_system','replaced_default_vehicle_final','total_trip_km','adhoc_amount',
  'total_trip_km_resolved','adhoc_amount_resolved','zonal_rfq_amount','zonal_rfq_amount_final',
  'challan_type','challan_type_final','km_accumulated_flag','ground_confirmed','trip_end_time',
  'ground_review_deadline','sent_to_vendor_flag','sent_to_vendor_timestamp','dispute_window_end'];

global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
  return String(f).replace('yyyy',d.getUTCFullYear()).replace('MM',p(d.getUTCMonth()+1))
   .replace('dd',p(d.getUTCDate())).replace('HH',p(d.getUTCHours())).replace('mm',p(d.getUTCMinutes()))
   .replace('ss',p(d.getUTCSeconds()));},parseCsv:t=>t.trim().split('\n').map(l=>l.split(','))};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),getUi:()=>{throw new Error('no UI');}};
global.Session={getScriptTimeZone:()=>SCRIPT_TZ,getActiveUser:()=>({getEmail:()=>'ops@valmo'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
let SCRIPT_TZ='Asia/Kolkata';
/* a fake trigger service that records what would be installed */
let TRIGGERS=[];
function fakeTrigger(fn){ const t={fn,type:'CLOCK',hour:null,min:null,days:null,mins:null,
  getHandlerFunction:()=>fn,getEventType:()=>'CLOCK'};
  const b={ timeBased:()=>b, everyDays:n=>{t.days=n;return b;}, everyMinutes:n=>{t.mins=n;return b;},
            atHour:h=>{t.hour=h;return b;}, nearMinute:m=>{t.min=m;return b;},
            create:()=>{TRIGGERS.push(t);return t;} };
  return b; }
global.ScriptApp={ getProjectTriggers:()=>TRIGGERS.slice(),
  deleteTrigger:t=>{TRIGGERS=TRIGGERS.filter(x=>x!==t);},
  newTrigger:fn=>fakeTrigger(fn) };

eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
eval(fs.readFileSync(__dirname+'/../apps-script/Actions.gs','utf8'));
_tz=()=>'Asia/Kolkata'; _nowIso=()=>'2026-08-27T14:30:00';

let TL,appended,tlWrites;
function mk(hdr,rows){ return [hdr.slice()].concat(rows.map(r=>hdr.map(h=>r[h]===undefined?'':r[h]))); }
function reset(rows){ TL=mk(TL_HDR,rows); appended=[]; tlWrites=[]; }
_ctx=function(tab){ const s=TL; const idx={}; s[0].forEach((h,i)=>{if(h)idx[h]=i;});
  return {sh:{name:tab},values:s,headerRow:0,headers:s[0],idx}; };
_setCell=function(ctx,r,col,v){ const ci=ctx.idx[col]; if(ci===undefined) return;
  ctx.values[r][ci]=v; tlWrites.push({trip:ctx.values[r][ctx.idx['trip_id']],col,v}); };
_appendByHeaders=function(tab,k,o){ appended.push({tab,o}); };
_upsertStatusView=function(){};
_readTab=function(t){ return t==='Contract_Vehicles'
  ? [{contract_id:'RJK8-X',vehicle_number:'GJ01AA0001',pegged_km_slab:2500}] : []; };
global.drainActions=()=>'Applied 0 vendor action(s).';
global.applyResolutionsFromSheet=()=>'In-sheet resolutions applied: 0';
global.syncToUpstash=()=>'Synced.';

const fails=[],notes=[]; const ck=(c,m)=>{(c?notes:fails).push((c?'  ok   ':'  FAIL ')+m);};
const PAST='2026-08-01T00:00:00';                       // well outside the ground window
const T=(o)=>Object.assign({row_id:o.trip_id+'_R',transporter_oracle_id:'18838',route_scope:'Local',
  contract_id:'RJK8-X',vehicle_number:'GJ01AA0001',billing_type_system:'Regular',
  challan_type:'Forward Only',km_accumulated_flag:'Yes',total_trip_km:120,
  trip_end_time:PAST,ground_review_deadline:PAST,sent_to_vendor_flag:''},o);
const sent=tid=>String(tcell(tid,'sent_to_vendor_flag'));
function tcell(tid,col){ const i={}; TL[0].forEach((h,k)=>{if(h)i[h]=k;});
  for(let r=1;r<TL.length;r++) if(String(TL[r][i['trip_id']])===tid) return TL[r][i[col]]; }

/* ==================================================================================================
 * 1. _holdFromVendor — the exact strings that exist in the live sheet
 * ================================================================================================= */
console.log('── 1. what the filter actually matches ──');
const H=o=>_holdFromVendor(T(o));
console.log('  challan_type frequency in the live sheet: Forward Only 1941 | Forward + RTO 1805 |');
console.log('                                            RTO only 145 | Regular 9 | (blank) 9 | Adhoc 1 | RTO 1');
ck(H({trip_id:'a',challan_type:'RTO only'})==='RTO',
   "'RTO only' (lowercase o — 145 live rows) IS held. An exact match on 'RTO Only' would miss all 145");
ck(H({trip_id:'b',challan_type:'RTO Only'})==='RTO',"'RTO Only' is held too — the test is case-insensitive");
ck(H({trip_id:'c',challan_type:'rto only'})==='RTO',"and so is 'rto only'");
ck(H({trip_id:'d',challan_type:'RTO'})==='RTO',"the single bare 'RTO' row is held");
ck(H({trip_id:'e',challan_type:'RTO cancelled'})==='RTO','anything STARTING with rto is held');
ck(H({trip_id:'f',challan_type:'Forward + RTO'})==='',
   "'Forward + RTO' (1,805 live rows) is NOT held — the classifier does not call these RTO and they carry payable KM");
ck(H({trip_id:'g',challan_type:'Forward Only'})==='','a plain forward trip is not held');
ck(H({trip_id:'h',challan_type:'Regular'})==='','and neither is challan_type=Regular');

console.log('  ── the adhoc half ──');
ck(H({trip_id:'i',billing_type_system:'Adhoc',adhoc_amount:3000})==='Adhoc','billing_type_system=Adhoc is held');
ck(H({trip_id:'j',billing_type_system:'adhoc',adhoc_amount:3000})==='Adhoc','case-insensitively');
ck(H({trip_id:'k',billing_type_system:'Regular',billing_type_final:'Adhoc',adhoc_amount:3000})==='Adhoc',
   'a GROUND reclassification to Adhoc is held too — a raw billing_type_system test would have missed it');
ck(H({trip_id:'l',route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Regular',
      billing_type_final:'Adhoc',zonal_rfq_amount:5300})==='',
   'but a ground Adhoc on ZONAL is ignored, exactly as the classifier ignores it (rule iii holds here too)');
ck(H({trip_id:'m',route_scope:'Zonal',rfq_id:'R1',billing_type_system:'Adhoc',adhoc_amount:5300})==='Adhoc',
   'a genuinely zonal-adhoc trip IS held (8 such rows live)');

console.log('  ── OR, not AND ──');
ck(H({trip_id:'n',billing_type_system:'Adhoc',challan_type:'RTO only',adhoc_amount:3000})==='Adhoc',
   'a trip that is BOTH is held (reported by the first reason hit)');
ck(H({trip_id:'o',billing_type_system:'Adhoc',challan_type:'Forward Only',adhoc_amount:3000})!=='',
   'Adhoc alone is enough — 318 live rows, not just the 13 in the intersection');
ck(H({trip_id:'p',billing_type_system:'Regular',challan_type:'RTO only'})!=='','RTO alone is enough — 146 live rows');

console.log('  ── the zero-km RTO fallback limb ──');
ck(H({trip_id:'q',challan_type:'',km_accumulated_flag:'No',total_trip_km:0})==='RTO',
   'a zero-km trip flagged km_accumulated_flag=No is held: the classifier already calls it RTO');
ck(H({trip_id:'r',challan_type:'',km_accumulated_flag:'',total_trip_km:0})==='',
   'but a BLANK flag is not enough — a blank challan_type row is not assumed to be RTO (9 live rows)');

/* ==================================================================================================
 * 2. transferReadyTrips — the filter actually holds trips back, and touches nothing
 * ================================================================================================= */
console.log('\n── 2. the transfer, filtered vs unfiltered ──');
function fixture(){ reset([
  T({trip_id:'OK-1'}),
  T({trip_id:'OK-2',challan_type:'Forward + RTO'}),
  T({trip_id:'AD-1',billing_type_system:'Adhoc',adhoc_amount:3000}),
  T({trip_id:'RT-1',challan_type:'RTO only',total_trip_km:0,km_accumulated_flag:'No'}),
  T({trip_id:'BOTH',billing_type_system:'Adhoc',challan_type:'RTO only',adhoc_amount:3000}),
  T({trip_id:'FUTURE',trip_end_time:'2099-01-01T00:00:00',ground_review_deadline:'2099-01-01T00:00:00'}),
]); }
fixture();
const rF=transferReadyTrips({skip:_holdFromVendor});
console.log('  filtered   -> '+rF);
ck(sent('OK-1')==='Yes'&&sent('OK-2')==='Yes','the two ordinary trips transfer (incl. Forward + RTO)');
ck(sent('AD-1')===''&&sent('RT-1')===''&&sent('BOTH')==='','Adhoc, RTO and both-at-once are held');
ck(sent('FUTURE')==='','a trip still inside its ground window is untouched, as before');
ck(/Transferred 2 trip\(s\)/.test(rF),'the count is right');
ck(/Held back 3 \(2 Adhoc, 1 RTO\)/.test(rF),'and the message says how many were held, and why: '+rF.split('Held back')[1]);
/* a held trip must be left byte-for-byte alone, or the "release later with menu 4" promise breaks */
const touched=tlWrites.filter(w=>['AD-1','RT-1','BOTH'].indexOf(w.trip)>=0);
console.log('  cells written on held trips: '+touched.length);
ck(touched.length===0,'NOT ONE cell is written on a held trip — no deadline, no window, no status');
ck(appended.every(a=>['AD-1','RT-1','BOTH'].indexOf(a.o.trip_id)<0),
   'and no Ground_Confirmation_Log row is appended for a held trip');

console.log('  ── menu 4 must stay the release valve ──');
fixture();
const rU=transferReadyTrips();                    // no opts at all — this is what menu 4 calls
console.log('  unfiltered -> '+rU);
ck(sent('AD-1')==='Yes'&&sent('RT-1')==='Yes'&&sent('BOTH')==='Yes',
   'called with NO options, every held-back trip transfers — menu 4 releases them');
ck(/Transferred 5 trip\(s\)/.test(rU),'all five eligible trips move');
ck(!/Held back/.test(rU),'and the unfiltered run says nothing about holding');
fixture();
ck(/Transferred 5/.test(transferReadyTrips({})),'an empty opts object is also unfiltered');

console.log('  ── held trips stay eligible, run after run ──');
fixture();
transferReadyTrips({skip:_holdFromVendor});
transferReadyTrips({skip:_holdFromVendor});
const r3=transferReadyTrips({skip:_holdFromVendor});
console.log('  third filtered run -> '+r3);
ck(/Transferred 0 trip\(s\)/.test(r3),'a repeat run transfers nothing new');
ck(/Held back 3/.test(r3),'but still reports the 3 held — the backlog stays visible, not silent');
ck(sent('AD-1')==='','and they are still un-transferred');
ck(/Transferred 3/.test(transferReadyTrips()),'and menu 4 can still release all 3 afterwards');

/* ==================================================================================================
 * 3. the scheduled job runs all four steps
 * ================================================================================================= */
console.log('\n── 3. scheduledFilteredDrainSync ──');
fixture();
let calls=[];
const _origDrain=drainActions,_origRes=applyResolutionsFromSheet,_origSync=syncToUpstash;
drainActions=()=>{calls.push('drain');return 'Applied 0 vendor action(s).';};
applyResolutionsFromSheet=()=>{calls.push('resolutions');return 'In-sheet resolutions applied: 0';};
syncToUpstash=()=>{calls.push('sync');return 'Synced.';};
const out3=scheduledFilteredDrainSync();
console.log('  '+out3.replace(/\n/g,'\n  '));
ck(calls.join(',')==='drain,resolutions,sync','it runs drain -> resolutions -> sync, in menu 4\'s order');
ck(sent('OK-1')==='Yes','and transferred first');
ck(sent('AD-1')==='','with the filter applied');
ck(/Held back 3/.test(out3),'the run report names the held count');
/* one step failing must not cost the others — the sync especially */
fixture(); calls=[];
drainActions=()=>{throw new Error('Upstash 500');};
const out3b=scheduledFilteredDrainSync();
console.log('  with drain throwing -> '+out3b.split('\n').filter(l=>/FAILED|Synced/.test(l)).join(' | ').trim());
ck(/DRAIN FAILED: Upstash 500/.test(out3b),'a failing step is named in the report');
ck(calls.indexOf('sync')>=0,'and the SYNC still runs, so the panel does not go stale behind one bug');
ck(/Transferred 2/.test(out3b),'the transfer that already succeeded is still reported');
drainActions=_origDrain; applyResolutionsFromSheet=_origRes; syncToUpstash=_origSync;

/* ==================================================================================================
 * 4. the triggers
 * ================================================================================================= */
console.log('\n── 4. installing the schedule ──');
TRIGGERS=[]; SCRIPT_TZ='America/Los_Angeles';
const refused=createScheduledFilteredTriggers();
console.log('  wrong project TZ -> '+refused.split('.')[0]);
ck(/REFUSED/.test(refused),'it REFUSES to install when the Apps Script project is not on IST');
ck(/America\/Los_Angeles/.test(refused),'naming the timezone it actually found');
ck(/Project Settings/.test(refused),'and where to change it');
ck(TRIGGERS.length===0,'and installs nothing');
/* this is the real trap: clock triggers use the PROJECT timezone, not the spreadsheet's */
ck(_tz()==='Asia/Kolkata'&&SCRIPT_TZ!=='Asia/Kolkata',
   'the spreadsheet can be on IST while the project is not — which is exactly how this goes wrong silently');

SCRIPT_TZ='Asia/Kolkata'; TRIGGERS=[];
const ok=createScheduledFilteredTriggers();
console.log('  installed: '+TRIGGERS.map(t=>t.fn+'@'+t.hour+':'+t.min).join(', '));
ck(TRIGGERS.length===4,'four daily triggers are installed');
ck(TRIGGERS.every(t=>t.fn==='scheduledFilteredDrainSync'),'all pointing at the filtered job');
ck(TRIGGERS.every(t=>t.days===1&&t.min===30),'each daily, at minute 30');
ck(JSON.stringify(TRIGGERS.map(t=>t.hour).sort((a,b)=>a-b))==='[3,14,18,22]',
   'at 03:30, 14:30, 18:30 and 22:30 IST');
ck(/within ~15 min/.test(ok),'and the message is honest that Google fires within ~15 minutes, not on the dot');

console.log('  ── the two schedules are mutually exclusive ──');
TRIGGERS=[]; createDrainSyncTrigger();                    // menu 6: the 10-minute UNFILTERED job
ck(TRIGGERS.length===1&&TRIGGERS[0].mins===10,'menu 6 installs the 10-minute auto-apply');
const ok2=createScheduledFilteredTriggers();
console.log('  6a after 6 -> removed the 10-min job: '+/Removed 1 conflicting/.test(ok2));
ck(TRIGGERS.length===4&&TRIGGERS.every(t=>t.fn==='scheduledFilteredDrainSync'),
   'installing 6a REMOVES the 10-minute job — it transfers unfiltered and would undo the filter');
ck(/Removed 1 conflicting/.test(ok2),'and says so');
const back=createDrainSyncTrigger();
ck(TRIGGERS.length===1&&TRIGGERS[0].mins===10,'and 6 removes 6a in turn — it works in both directions');
ck(/REPLACED the filtered/.test(back),'warning that auto-apply sends Adhoc and RTO trips as well');

console.log('  ── stopping ──');
TRIGGERS=[]; createScheduledFilteredTriggers();
TRIGGERS.push({fn:'somethingElse',getHandlerFunction:()=>'somethingElse',getEventType:()=>'CLOCK'});
const stop=stopScheduledFilteredTriggers();
console.log('  '+stop);
ck(/removed 4 trigger/.test(stop),'stopping removes all four');
ck(TRIGGERS.length===1&&TRIGGERS[0].fn==='somethingElse','and leaves unrelated triggers alone');
ck(/was not on/.test(stopScheduledFilteredTriggers()),'stopping twice says so rather than pretending');

const st=showTriggerStatus();
ck(/Asia\/Kolkata/.test(st)&&/somethingElse/.test(st),'the status view lists the timezone and what is installed');
SCRIPT_TZ='America/Los_Angeles';
ck(/NOT IST/.test(showTriggerStatus()),'and flags a wrong project timezone loudly');
SCRIPT_TZ='Asia/Kolkata';

/* ==================================================================================================
 * 5. NON-VACUITY — the literal filter the request asked for matches nothing
 * ================================================================================================= */
console.log('\n── 5. non-vacuity ──');
const literal=t=>((String(t.billing_type_system)==='Adhoc' && String(t.challan_type)==='RTO Only') ? 'both' : '');
fixture();
const rLit=transferReadyTrips({skip:literal});
console.log('  filter written EXACTLY as asked -> '+rLit);
ck(/Transferred 5 trip\(s\)/.test(rLit)&&!/Held back/.test(rLit),
   "the literal filter (Adhoc AND challan=='RTO Only', case-sensitive) holds back NOTHING and every trip goes out");
ck(sent('AD-1')==='Yes'&&sent('RT-1')==='Yes',
   'both the Adhoc and the RTO trip would have been sent to the vendor — the bug this file exists to prevent');
/* and the AND-vs-OR half, measured on the live proportions */
const andOnly=t=>{const x=_classifyTrip(t,{},'Regular'); return (x.isAdhoc&&x.rto)?'both':'';};
fixture();
const rAnd=transferReadyTrips({skip:andOnly});
console.log('  AND instead of OR               -> '+rAnd);
ck(/Held back 1/.test(rAnd),'an AND filter holds only the both-at-once trip (13 of 3,911 live, vs 451 for OR)');
ck(sent('AD-1')==='Yes','leaving the Adhoc-only trip to go out');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
