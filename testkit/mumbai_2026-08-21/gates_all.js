const fs=require('fs');
const DIR='__DIR__/';
function readCsv(f){ if(!fs.existsSync(DIR+f)) return [];
 const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){if(ch==='"'){if(txt[i+1]==='"'){val+='"';i++;}else q=false;}else val+=ch;}
  else if(ch==='"')q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r')val+=ch;}
 if(val||cur.length){cur.push(val);rows.push(cur);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.some(c=>c!=='')).map(r=>{const o={};h.forEach((k,i)=>o[k]=r[i]===undefined?'':r[i]);return o;});}
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
 const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return String(f).replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
  .replace('yy',String(d.getFullYear()).slice(2)).replace('d',d.getDate())
  .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'}),openById:()=>{throw 0},create:()=>({}),getUi:()=>{throw 0}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'t@x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};
eval(['/root/work/repo/apps-script/Code.gs','/root/work/repo/apps-script/Billing.gs'].map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_readTab=t=>readCsv(t+'.csv'); _tz=()=>'Asia/Kolkata';
MIS_SHEET_ID=''; MIS_EXCLUDE_ORACLES=[];
const d=_misReadSource();
const ORCS=['19434','18764','20517','20426','20226','19252','20882','18722','20703','19280','20682'];
console.log('=== ALL 11 GATES, header neutralised ===\n');
let allNames=null, tot={};
ORCS.forEach(o=>{
  const key=Object.keys(d.byOracle).filter(k=>_misOrcKey(k)===_misOrcKey(o))[0];
  if(!key){ console.log(o+'  NOT FOUND'); return; }
  const m=buildBillingModel(key,d); const g=runGates(m,d)||[];
  if(!allNames) allNames=g.map(x=>x.name);
  g.forEach(x=>{ tot[x.name]=tot[x.name]||{clear:0,bad:0,detail:[]};
    if(x.verdict==='clear') tot[x.name].clear++; else { tot[x.name].bad++; tot[x.name].detail.push(m.vendorName+': '+String(x.detail).slice(0,120)); } });
  const bad=g.filter(x=>x.verdict!=='clear');
  console.log('%s  %-38s payable Rs %-12s %s',o,m.vendorName.slice(0,38),
    Math.round(m.totals.payable).toLocaleString('en-IN'), bad.length? bad.length+' NOT CLEAR':'all 11 clear');
  bad.forEach(x=>console.log('     ['+x.verdict+'] '+x.name+(x.detail?('\n            '+String(x.detail).slice(0,220)):'')));
});
console.log('\n=== gate-by-gate across all 11 vendors ===');
allNames.forEach(n=>{ const t=tot[n];
  console.log('  %-58s %2d clear / %2d not', n.slice(0,58), t.clear, t.bad);
  t.detail.forEach(dd=>console.log('        '+dd)); });
console.log('\n=== fixed total across all vendors ===');
let F=0; ORCS.forEach(o=>{ const key=Object.keys(d.byOracle).filter(k=>_misOrcKey(k)===_misOrcKey(o))[0];
  if(key) F+=buildBillingModel(key,d).totals.payable; });
console.log('  Rs '+Math.round(F).toLocaleString('en-IN')+'   (sheet pivot: Rs 22,61,466 (Contract_Info sum))');
