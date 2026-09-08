/* Do replacement trips fold onto a contracted vehicle, or is KM stranded?
   Runs the REAL engine (Code.gs + Billing.gs) over a CSV export - it does not re-implement anything.
   Set REPO if the repo moves; LIVE_DIR for the CSV folder. */
const fs=require('fs'), path=require('path');
const DIR=(process.env.LIVE_DIR||'live')+'/';
const REPO=process.env.REPO||path.join(__dirname,'..','..');
function readCsv(f){ if(!fs.existsSync(DIR+f)) return [];
 const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){if(ch==='"'){if(txt[i+1]==='"'){val+='"';i++;}else q=false;}else val+=ch;}
  else if(ch==='"')q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r')val+=ch;}
 if(val||cur.length){cur.push(val);rows.push(cur);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.some(c=>c!=='')).map(r=>{const o={};h.forEach((k,i)=>{if(k)o[k]=r[i]===undefined?'':r[i];});return o;});}
global.Utilities={formatDate:(d,tz,f)=>String(f).replace('yyyy',d.getFullYear())};
const SHEETS=['Contract_Info','Contract_Vehicles','Trip_Level','Placement failure'];
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata',
  getSheets:()=>SHEETS.map(n=>({getName:()=>n}))}),openById:()=>{throw 0},create:()=>({}),getUi:()=>{throw 0}};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata',getActiveUser:()=>({getEmail:()=>'x'})};
global.Logger={log:()=>{}};global.HtmlService={};global.CacheService={};global.PropertiesService={};
global.UrlFetchApp={};global.MailApp={};global.DriveApp={};global.ScriptApp={getProjectTriggers:()=>[]};
eval([path.join(REPO,'apps-script','Code.gs'), path.join(REPO,'apps-script','Billing.gs')]
     .map(f=>fs.readFileSync(f,'utf8')).join('\n'));
_readTab=(t)=>readCsv(t+'.csv'); _tz=()=>'Asia/Kolkata'; MIS_SHEET_ID='';
const d=_misReadSource();

let folded=0,foldedKm=0,unfolded=0,unfoldedKm=0,selfFold=0,selfFoldKm=0;
const ex=[];
Object.keys(d.byOracle).forEach(o=>{
  const m=buildBillingModel(o,d);
  m.contracts.forEach(c=>{
    (d.trips[c.cid]||[]).forEach(t=>{
      const x=_classifyTrip(t, (d.defSet&&d.defSet[c.cid])||{}, 'Regular');
      if(x.isAdhoc||x.rto||x.isDefault) return;
      if(x.foldValid){ folded++; foldedKm+=x.km;
        /* if it folds into a near-twin of the plate that ran, it is the SAME vehicle mis-keyed */
        const a=String(x.no),b=String(x.foldTo);
        let diff=0; if(a.length===b.length){for(let i=0;i<a.length;i++) if(a[i]!==b[i]) diff++;} else diff=9;
        if(diff>0&&diff<=2){ selfFold++; selfFoldKm+=x.km;
          if(ex.length<8) ex.push({ran:a,into:b,km:Math.round(x.km),cid:c.cid,v:m.vendorName}); }
      } else { unfolded++; unfoldedKm+=x.km; }
    });
  });
});
console.log('REPLACEMENT TRIPS - do they fold into a contracted vehicle?');
console.log('  folds to a valid contracted vehicle : '+folded+' trips, '+Math.round(foldedKm).toLocaleString('en-IN')+' km');
console.log('  does NOT fold (lands unattributed)  : '+unfolded+' trips, '+Math.round(unfoldedKm).toLocaleString('en-IN')+' km');
console.log('\n  of the folded ones, how many fold into a plate within 2 chars of the one that ran?');
console.log('    '+selfFold+' trips, '+Math.round(selfFoldKm).toLocaleString('en-IN')+' km  <-- same vehicle, mis-keyed, folds back onto itself');
ex.forEach(e=>console.log('      '+String(e.km).padStart(5)+' km   ran as '+e.ran+'  ->  folded into '+e.into+'   ('+e.v.slice(0,20)+')'));

console.log('\nUNATTRIBUTED KM per vendor (the only KM that is really adrift):');
Object.keys(d.byOracle).forEach(o=>{
  const m=buildBillingModel(o,d);
  if(m.totals.unattrKm>0.5) console.log('  '+m.vendorName.slice(0,34).padEnd(35)+Math.round(m.totals.unattrKm)+' km');
});
console.log('  (0 rows above = every replacement trip is attributed to a contracted vehicle)');
