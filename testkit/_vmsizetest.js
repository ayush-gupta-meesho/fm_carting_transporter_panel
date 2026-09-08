/* "The coordinates of the range are outside the dimensions of the sheet" — Krushiv Enterprise, 18838.
 *
 * A sheet made by insertSheet()/create() is 1000 rows x 26 columns. Krushiv's Local tab needs 1,571
 * rows, so generating that one vendor's MIS threw and no other vendor's did (next largest: Balaji at
 * 581). Nothing in the writers was wrong — the sheet was too small, and none of them grew it.
 *
 * This harness runs the REAL _misWriteVendorMis against a fake Spreadsheet that enforces the same
 * 1000x26 limit and throws the SAME message. That is the only way to reproduce the bug outside Apps
 * Script, and it is what makes the fix testable rather than merely plausible.
 */
const fs=require('fs'), path=require('path');
const DIR=(process.env.LIVE_DIR||path.join(__dirname,'demo-data'))+'/';
function readCsv(f){ if(!fs.existsSync(DIR+f)) return [];
 const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){if(ch==='"'){if(txt[i+1]==='"'){val+='"';i++;}else q=false;}else val+=ch;}
  else if(ch==='"')q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r')val+=ch;}
 if(val||cur.length){cur.push(val);rows.push(cur);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.some(c=>c!=='')).map(r=>{const o={};h.forEach((k,i)=>{if(k)o[k]=r[i]===undefined?'':r[i];});return o;});}

/* ---------------- a Spreadsheet that behaves like the real one about its size ---------------- */
let grewRows=0, grewCols=0, maxSeenRow=0, maxSeenCol=0;
function FakeRange(sh,r,c,nr,nc){
  /* THE assertion this whole file exists for: the real getRange throws when the range runs past the
     sheet, and it throws on getRange, not on setValues. */
  if(r<1||c<1||r+nr-1>sh._rows||c+nc-1>sh._cols){
    throw new Error('Exception: The coordinates of the range are outside the dimensions of the sheet.');
  }
  if(r+nr-1>maxSeenRow) maxSeenRow=r+nr-1;
  if(c+nc-1>maxSeenCol) maxSeenCol=c+nc-1;
  const self={};
  ['setValue','setValues','setFormula','setFormulas','setBackground','setFontColor','setFontFamily',
   'setFontSize','setFontWeight','setNumberFormat','setWrap','setHorizontalAlignment',
   'setVerticalAlignment','merge','breakApart','clearDataValidations','setDataValidation',
   'setBorder','clear','clearContent','setNote'].forEach(k=>{ self[k]=()=>self; });
  self.getValues=()=>Array.from({length:nr},()=>Array.from({length:nc},()=>''));
  self.getValue=()=>'';
  return self;
}
function FakeSheet(name){
  const sh={_rows:1000,_cols:26,_name:name};      // exactly what Apps Script hands you
  sh.getName=()=>name;
  sh.getMaxRows=()=>sh._rows;
  sh.getMaxColumns=()=>sh._cols;
  sh.insertRowsAfter=(after,n)=>{ sh._rows+=n; grewRows++; return sh; };
  sh.insertColumnsAfter=(after,n)=>{ sh._cols+=n; grewCols++; return sh; };
  sh.getRange=(r,c,nr,nc)=>FakeRange(sh,r,c,nr===undefined?1:nr,nc===undefined?1:nc);
  sh.getDataRange=()=>FakeRange(sh,1,1,1,1);
  ['setRowHeight','setColumnWidth','setFrozenRows','setFrozenColumns','setHiddenGridlines',
   'clearConditionalFormatRules','setConditionalFormatRules','activate','setTabColor',
   'autoResizeColumn','hideColumns','deleteRows','deleteColumns'].forEach(k=>{ sh[k]=()=>sh; });
  return sh;
}
function FakeSS(title){
  const sheets=[];
  const ss={};
  ss.getUrl=()=>'https://example.invalid/fake';
  ss.getId=()=>'fake';
  ss.getName=()=>title;
  ss.insertSheet=n=>{ const s=FakeSheet(n); sheets.push(s); return s; };
  ss.getSheetByName=n=>sheets.filter(s=>s.getName()===n)[0]||null;
  ss.getSheets=()=>sheets;
  ss.deleteSheet=s=>{ const i=sheets.indexOf(s); if(i>=0) sheets.splice(i,1); };
  ss.setActiveSheet=()=>ss; ss.moveActiveSheet=()=>ss;
  ss.getSpreadsheetTimeZone=()=>'Asia/Kolkata';
  return ss;
}
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
 const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return String(f).replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
  .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={
  getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata',getSheets:()=>[]}),
  openById:()=>{throw new Error('no MIS sheet in test')},
  create:t=>FakeSS(t),
  getUi:()=>{throw new Error('no ui')},
  newDataValidation:()=>({requireValueInList:function(){return this;},setAllowInvalid:function(){return this;},build:function(){return {};}})
};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};global.ScriptApp={getProjectTriggers:()=>[]};
eval([__dirname+'/../apps-script/Code.gs',__dirname+'/../apps-script/Billing.gs']
     .map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_readTab=t=>readCsv(t+'.csv'); _tz=()=>'Asia/Kolkata';
MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];

const fails=[],notes=[];
const ck=(c,m)=>{ (c?notes:fails).push((c?'  ok   ':'  FAIL ')+m); };

/* ---------------- 1. the fake sheet really does throw like the real one ---------------- */
console.log('The 1000-row ceiling, reproduced\n');
console.log('1) the fake sheet behaves like Apps Script');
let threw='';
try { FakeSheet('probe').getRange(999, 1, 5, 3); } catch(e){ threw=e.message; }
console.log('   getRange(999,1,5,3) on a 1000-row sheet -> '+(threw||'(did not throw)'));
ck(/outside the dimensions of the sheet/.test(threw),
   'the harness throws the exact production message, so a pass here means something');
let threwC='';
try { FakeSheet('probe').getRange(1, 25, 1, 5); } catch(e){ threwC=e.message; }
ck(/outside the dimensions of the sheet/.test(threwC),'and it enforces the 26-column ceiling too');
ck(FakeSheet('probe').getMaxRows()===1000 && FakeSheet('probe').getMaxColumns()===26,
   'a fresh sheet is 1000 x 26, which is what Apps Script hands you');

/* ---------------- 2. every vendor's MIS builds ---------------- */
const d=_misReadSource();
const oracles=Object.keys(d.byOracle);
console.log('\n2) building every vendor MIS against that ceiling');
let built=0, biggest={o:'',rows:0};
oracles.forEach(o=>{
  const m=buildBillingModel(o,d);
  let rowsNeeded=8;
  m.contracts.forEach(c=>{ rowsNeeded+=(c.vehicles||[]).length+24
    +(c.allTrips||[]).filter(x=>x.type!=='Adhoc').length; });
  if(rowsNeeded>biggest.rows) biggest={o:o+' '+m.vendorName, rows:rowsNeeded};
  grewRows=0; grewCols=0; maxSeenRow=0;
  let err='';
  try { _misWriteVendorMis(m); } catch(e){ err=e.message; }
  ck(!err, 'builds for '+o+' '+m.vendorName.slice(0,26)+(err?('  *** '+err.slice(0,80)+' ***'):
     ('  (deepest row written '+maxSeenRow+', grew '+grewRows+'x)')));
  if(!err) built++;
});
console.log('   built '+built+' of '+oracles.length+'   largest Local need: '+biggest.rows+' rows ('+biggest.o+')');
ck(built===oracles.length, 'all '+oracles.length+' vendor MIS files build');

/* ---------------- 3. non-vacuity: a tab past 1000 rows is actually exercised ---------------- */
console.log('\n3) non-vacuity — is any tab actually past the old ceiling?');
let over=null;
oracles.forEach(o=>{
  const m=buildBillingModel(o,d);
  let need=8;
  m.contracts.forEach(c=>{ need+=(c.vehicles||[]).length+24
    +(c.allTrips||[]).filter(x=>x.type!=='Adhoc').length; });
  if(need>1000 && !over) over={o:o, name:m.vendorName, need:need, m:m};
});
if(over){
  console.log('   '+over.o+' '+over.name+' needs '+over.need+' rows — past the 1000 ceiling');
  grewRows=0; maxSeenRow=0;
  let err=''; try { _misWriteVendorMis(over.m); } catch(e){ err=e.message; }
  ck(!err, over.name+' builds even though it needs '+over.need+' rows');
  ck(maxSeenRow>1000, 'and a range beyond row 1000 was genuinely written ('+maxSeenRow+') — so the '
     +'ceiling was really crossed, not merely approached');
  ck(grewRows>0, 'the sheet was grown '+grewRows+' time(s) rather than the write being skipped');
  ck(grewRows<=6, 'and grown in a few big steps, not once per row ('+grewRows+' calls)');
} else {
  /* the demo CSVs are small; synthesise the overflow so this file never silently stops testing */
  console.log('   no vendor in this dataset exceeds 1000 rows — synthesising one');
  const m=buildBillingModel(oracles[0],d);
  const c=m.contracts[0];
  const proto=(c.allTrips||[])[0]||{date:'01 Aug',id:'T',no:'X',size:'8 FT',route:'A → B',
    challan:'Forward Only',type:'Regular',km:10,countedTo:'',completed:'',status:'Confirmed',sortKey:0};
  c.allTrips=[]; for(let i=0;i<1400;i++) c.allTrips.push(Object.assign({},proto,{id:'T-'+i,sortKey:i}));
  grewRows=0; maxSeenRow=0;
  let err=''; try { _misWriteVendorMis(m); } catch(e){ err=e.message; }
  ck(!err, 'a synthetic 1400-trip contract builds'+(err?('  *** '+err.slice(0,80)+' ***'):''));
  ck(maxSeenRow>1000, 'and it wrote past row 1000 ('+maxSeenRow+')');
  ck(grewRows>0, 'growing the sheet '+grewRows+' time(s)');
  ck(grewRows<=6, 'in a few big steps, not once per row ('+grewRows+' calls)');
}

/* ---------------- 4. the helper itself ---------------- */
console.log('\n4) _vmFit');
const s=FakeSheet('fit');
_vmFit(s, 1500, 13);
ck(s.getMaxRows()>=1500, '_vmFit(1500) grows the sheet to at least 1500 rows (got '+s.getMaxRows()+')');
ck(s.getMaxColumns()===26, 'and leaves columns alone when 13 already fits');
const s2=FakeSheet('fit2'); const before=s2.getMaxRows();
_vmFit(s2, 10, 5);
ck(s2.getMaxRows()===before, 'a fit that already fits is a no-op — no pointless insertRowsAfter');
const s3=FakeSheet('fit3');
_vmFit(s3, 5, 40);
ck(s3.getMaxColumns()>=40, 'it grows columns too when a wide tab needs them ('+s3.getMaxColumns()+')');
const s4=FakeSheet('fit4');
_vmFit(s4, 0, 0);
ck(s4.getMaxRows()===1000 && s4.getMaxColumns()===26, 'and 0/blank is treated as 1, never negative');

console.log('\n── results ──');
notes.forEach(x=>console.log(x));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
