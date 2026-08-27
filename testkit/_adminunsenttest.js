/* ADMIN: an untransferred trip must be VISIBLE and VISIBLY DIFFERENT.
   _buildAdminPayload uses allTrips:true, so trips with sent_to_vendor_flag != Yes are included on
   purpose — but vendor_status reads 'Pending' for them exactly as it does for a trip the vendor can
   actually act on. Before this test the two were pixel-identical in the admin view, which is why the
   backlog looked missing. Drives the real index.html in Chromium against a real admin payload. */
const fs=require('fs'), path=require('path');
const { chromium } = require('playwright');
const HTML = path.join(__dirname,'..','vercel-app','index.html');

/* build a genuine admin payload from the real Code.gs over demo-data */
global.Utilities={formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return String(f).replace('yyyy',d.getFullYear()).replace('MMM',M[d.getMonth()]).replace('dd',p(d.getDate()))
   .replace('yy',String(d.getFullYear()).slice(2)).replace('d',d.getDate())
   .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));}};
global.SpreadsheetApp={getActive:()=>({getSpreadsheetTimeZone:()=>'Asia/Kolkata'})};
global.Session={getScriptTimeZone:()=>'Asia/Kolkata'};global.Logger={log:()=>{}};
global.HtmlService={};global.CacheService={};global.PropertiesService={};global.UrlFetchApp={};
global.MailApp={};global.DriveApp={};
const DIR=__dirname+'/demo-data/';
function readCsv(f){const txt=fs.readFileSync(DIR+f,'utf8');const rows=[];let cur=[],val='',q=false;
 for(let i=0;i<txt.length;i++){const ch=txt[i];
  if(q){if(ch==='"'){if(txt[i+1]==='"'){val+='"';i++;}else q=false;}else val+=ch;}
  else if(ch==='"')q=true; else if(ch===','){cur.push(val);val='';}
  else if(ch==='\n'){cur.push(val);rows.push(cur);cur=[];val='';} else if(ch!=='\r')val+=ch;}
 if(val||cur.length){cur.push(val);rows.push(cur);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.some(c=>c!=='')).map(r=>{const o={};h.forEach((k,i)=>o[k]=r[i]===undefined?'':r[i]);return o;});}
eval(fs.readFileSync(__dirname+'/../apps-script/Code.gs','utf8'));
_readTab=t=>readCsv(t+'.csv'); _tz=()=>'Asia/Kolkata';
const ADMIN=_buildAdminPayload();

const fails=[],notes=[]; const ck=(c,m)=>{(c?notes:fails).push((c?'  ok   ':'  FAIL ')+m);};

(async()=>{
  const unsent = [];
  Object.keys(ADMIN.trips).forEach(cid=>(ADMIN.trips[cid]||[]).forEach(t=>{ if(t.sent===false) unsent.push({cid,t}); }));
  console.log('── the admin payload ──');
  console.log('  contracts: %d   trips: %d   of which NOT sent: %d',
    ADMIN.contracts.length, Object.values(ADMIN.trips).flat().length, unsent.length);
  unsent.forEach(u=>console.log('     %-12s status=%j  card=%s', u.t.id, u.t.status, u.cid));
  ck(unsent.length>0,'the admin payload carries at least one untransferred trip ('+unsent.length+')');
  ck(Object.values(ADMIN.trips).flat().every(t=>typeof t.sent==='boolean'),
     'every admin trip carries a boolean `sent` field');
  ck(unsent.every(u=>u.t.status==='pending'||u.t.status==='reconfirm'),
     "an untransferred trip still reports status 'pending' — which is exactly why the chip is needed");

  const browser=await chromium.launch();
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
  /* served over http:// like _uitest does — a file:// page cannot resolve the relative /api/* URLs */
  await page.route('**/api/config',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,proofMode:'blob'})}));
  await page.route('**/api/data',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:ADMIN})}));
  await page.route('**/index.html',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(HTML,'utf8')}));
  await page.goto('http://local.test/index.html');
  await page.waitForFunction(()=>typeof window.IS_ADMIN!=='undefined',{timeout:15000});
  await page.evaluate(async()=>{ const r=await fetch('/api/data').then(x=>x.json()); renderAdmin(r.data); });
  await page.waitForTimeout(400);

  /* the header count */
  const hdr = await page.textContent('#asCount');
  console.log('\n  admin header: "%s"', hdr.trim());
  ck(/NOT yet sent to vendor/.test(hdr), 'the admin header names the untransferred backlog');
  ck(new RegExp(unsent.length+' trips? NOT yet sent').test(hdr),
     'and the count matches the payload ('+unsent.length+')');

  /* open the card that holds an untransferred trip and look for the chip.
     If `sent` is missing from the payload there is nothing to open, so say that plainly and stop —
     crashing on unsent[0] would hide the real cause behind a TypeError. */
  if(!unsent.length){
    ck(false,'CANNOT TEST THE UI: no trip has sent===false. Is `sent: _yes(t.sent_to_vendor_flag)` '
       +'still present in all three trip mappers in Code.gs?');
    await browser.close();
    console.log('\n── results ──'); notes.forEach(x=>console.log(x));
    console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1);
  }
  const target = unsent[0];
  const found = await page.evaluate((cid)=>{
    showL2(cid);
    return new Promise(res=>setTimeout(()=>{
      const chips=[...document.querySelectorAll('.st-unsent')];
      res({ n: chips.length, text: chips.length?chips[0].textContent.trim():'',
            title: chips.length?chips[0].getAttribute('title'):'',
            rows: document.querySelectorAll('.ttable tbody tr').length });
    },500));
  }, target.cid);
  console.log('  card %s -> %d rows, %d "Not yet sent" chip(s): %j', target.cid, found.rows, found.n, found.text);
  ck(found.rows>0,'the card renders a trip table');
  ck(found.n>0,'the untransferred trip shows a "Not yet sent" chip');
  ck(/Not yet sent to vendor/.test(found.text),'the chip text says so in plain words');
  ck(/sent_to_vendor_flag/.test(found.title||''),'and the tooltip names the underlying column');

  /* ── the vendor side must be untouched ──────────────────────────────────────────────────────────
     Reload first. logoutFn() calls showLogin() WITHOUT reloading, so DOM rendered for the previous
     session survives in the page — a fresh load is what a real vendor session actually is. That
     carry-over is measured separately below, because it is worth knowing about on its own. */
  const V=_buildVendorPayload('ORC-4521');
  await page.route('**/api/data',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:V})}));
  await page.goto('http://local.test/index.html');
  await page.waitForFunction(()=>typeof window.IS_ADMIN!=='undefined',{timeout:15000});
  const vres = await page.evaluate(async()=>{
    await loadPanel();
    return new Promise(res=>setTimeout(()=>res({
      isAdmin: window.IS_ADMIN, hdr: document.getElementById('asCount').textContent,
      chips: document.querySelectorAll('.st-unsent').length }),500));
  });
  console.log('\n  vendor view -> IS_ADMIN=%s  chips=%d  header="%s"', vres.isAdmin, vres.chips, vres.hdr.trim());
  ck(vres.isAdmin===false,'the vendor payload does not put the panel in admin mode');
  ck(vres.chips===0,'no "Not yet sent" chip is ever shown to a vendor');
  ck(!/NOT yet sent/.test(vres.hdr),'and the vendor header is unchanged');
  ck(V.contracts.length>0 && Object.values(V.trips).flat().every(t=>t.sent===true),
     'every trip in a VENDOR payload is sent===true, so the chip can never fire there');


  /* ── SEPARATE FINDING, not caused by the chip: logoutFn() does not reload ────────────────────────
     It calls showLogin() only, so everything the previous session rendered stays in the DOM. Recorded
     here as OBSERVED behaviour, so the fact is written down and a future fix surfaces as a failure
     here rather than passing unnoticed. What matters is whether the stale panel is merely PRESENT or
     actually VISIBLE — present-but-hidden is a far smaller problem than on-screen. */
  const carry = await page.evaluate(async()=>{
    const r=await fetch('/api/data').then(x=>x.json());
    return new Promise(res=>{
      loadPanel().then(()=>setTimeout(()=>{
        const firstCard=(window.CONTRACTS&&CONTRACTS[0])?CONTRACTS[0].id:null;
        if(firstCard) showL2(firstCard);
        setTimeout(()=>{
          logoutFn();
          setTimeout(()=>{
            const vis=el=>!!el && el.offsetParent!==null;
            res({ rowsInDom: document.querySelectorAll('.ttable tbody tr').length,
                  l2Visible: vis(document.getElementById('l2Screen')),
                  appVisible: vis(document.getElementById('appScreen')),
                  loginVisible: vis(document.getElementById('loginScreen')) });
          },250);
        },350);
      },350));
    });
  });
  console.log('\n  after logoutFn(): trip rows still in DOM=%d  app visible=%s  login visible=%s',
    carry.rowsInDom, carry.appVisible, carry.loginVisible);
  ck(carry.loginVisible===true,'logout returns the user to the login screen');
  ck(carry.appVisible===false,"and the previous session's panel is not left on screen");
  if(carry.rowsInDom>0) console.log('     NOTE: '+carry.rowsInDom+' trip row(s) from the previous session '
    +'remain in the DOM (hidden) because logoutFn() does not call location.reload().');

  ck(errs.length===0,'no JS errors'+(errs.length?': '+errs[0]:''));
  await browser.close();
  console.log('\n── results ──'); notes.forEach(x=>console.log(x));
  if(fails.length){console.log('\n'+fails.length+' FAILURE(S):');fails.forEach(f=>console.log(f));process.exit(1);}
  console.log('\nALL '+notes.length+' CHECKS PASSED');
})();
