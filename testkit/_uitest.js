/* End-to-end UI validation of the real index.html in Chromium.
   Serves the real Code.gs payload at /api/data, captures every /api/action body, and walks:
     - the L1 card list (bifurcation of same-cluster zonal cards)
     - every card's L2
     - the dispute modal for EVERY trip kind: Local Regular / Local Adhoc / Local RTO /
       Zonal Regular / Zonal Adhoc / Zonal RTO / zonal with no RFQ / zonal with km+amt absent
     - each category panel, submit, and the posted claim payload
     - confirm, bulk confirm, View-Dispute for a local and a zonal dispute
   Fails on any 'null'/'undefined'/'NaN' rendered to the user, any console error, and any
   claim field that does not match what Actions.gs applyDispute() reads. */
const fs=require('fs'), path=require('path');
const {chromium}=require('playwright');
const HTML=fs.readFileSync(__dirname+'/../vercel-app/index.html','utf8');
const PAYLOAD=JSON.parse(fs.readFileSync(__dirname+'/payload.json','utf8'));

const fails=[], notes=[];
function ck(cond,msg){ if(cond) notes.push('  ok   '+msg); else fails.push('  FAIL '+msg); }

const BADWORD=/(^|[\s>(])(null|undefined|NaN)([\s<).·,]|$)/;
function scanText(label,txt){
  txt=String(txt||'').replace(/\s+/g,' ');
  if(BADWORD.test(txt)) fails.push('  FAIL '+label+' leaked a null/undefined/NaN: "'+txt.slice(0,220)+'"');
}

(async()=>{
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await ctx.newPage();
const posted=[];
const consoleErrs=[];
let alertMsg='';
page.on('dialog',async d=>{ alertMsg=d.message(); try{await d.dismiss();}catch(e){} });
page.on('console',m=>{ if(m.type()==='error') consoleErrs.push(m.text()); });
page.on('pageerror',e=>consoleErrs.push('pageerror: '+e.message));

await page.route('**/api/data',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(PAYLOAD)}));
await page.route('**/api/action',r=>{ posted.push(JSON.parse(r.request().postData()||'{}'));
  r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,queued:99,trip_ids:[]})}); });
await page.route('**/api/upload-proof',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,url:'https://x/proof.png'})}));
await page.route('**/index.html',r=>r.fulfill({contentType:'text/html',body:HTML}));
await page.goto('http://local.test/index.html');
await page.waitForLoadState('domcontentloaded');
await page.evaluate(()=>loadPanel());
await page.waitForSelector('#contractList .ccard');

/* ── 1. L1 cards ─────────────────────────────────────────────────────────── */
const cards=await page.$$eval('#contractList .ccard',els=>els.map(e=>({
  name:e.querySelector('.cc-name').textContent.trim(),
  meta:e.querySelector('.cc-meta')?e.querySelector('.cc-meta').textContent.trim():'',
  id:e.querySelector('.cc-id')?e.querySelector('.cc-id').textContent.trim():''})));
console.log('\n── L1 cards ──');
cards.forEach(c=>console.log('  '+c.name.padEnd(46)+' | '+c.id));
cards.forEach(c=>{ scanText('L1 card "'+c.name+'"',c.name+' '+c.meta+' '+c.id); });
const names=cards.map(c=>c.name);
ck(new Set(names).size===names.length,'every L1 card name is unique (was: two "Rajkot · Zonal Routes")');
const zCards=await page.evaluate(()=>CONTRACTS.filter(c=>c.isZonalCard).map(c=>({id:c.id,rfq:c.rfqId,trips:c.zonalTrips})));
const zNames=cards.filter(c=>/· Zonal ·/.test(c.name)).map(c=>c.name);
ck(zCards.length>0,'zonal cards exist even though every zonal row has a blank contract_id');
ck(zCards.every(c=>c.id==='ZONAL::'+c.rfq),'every zonal card is keyed on its rfq_id: '+zCards.map(c=>c.rfq).join(' | '));
ck(new Set(zCards.map(c=>c.rfq)).size===zCards.length,'one card per RFQ, no duplicates');
ck(zNames.length===zCards.length&&new Set(zNames).size===zNames.length,'zonal card names are unique and carry the RFQ: '+zNames.join(' | '));
ck(cards.filter(c=>/^RFQ ID: /.test(c.id)).length===zCards.length,'each zonal card labels its id line "RFQ ID: …"');
ck(cards.every(c=>!/ZONAL::|::ZONAL/.test(c.id)),'no card leaks the internal ZONAL:: id');

/* ── 2. every card's L2 renders clean ────────────────────────────────────── */
const cardIds=await page.evaluate(()=>CONTRACTS.map(c=>c.id));
console.log('\n── L2 render ──');
for(const id of cardIds){
  await page.evaluate(i=>showL2(i),id);
  await page.waitForTimeout(60);
  const t=await page.$eval('#view-l2',e=>e.innerText);
  scanText('L2 '+id,t);
  const title=await page.$eval('#csumTitle',e=>e.textContent);
  console.log('  '+id.padEnd(46)+' → '+title);
  ck(!/ZONAL::|::ZONAL/.test(title),'L2 title clean for '+id);
}

/* ── 2b. every trip names its own billing reference ─────────────────────── */
console.log('\n── per-trip Contract / RFQ ID ──');
async function refCells(cid){
  if(cid===null) await page.evaluate(()=>showGlobalMIS());
  else await page.evaluate(i=>showL2(i),cid);
  await page.waitForTimeout(150);
  const pid = cid===null ? 'misPanel' : 'tripPanelContract';
  return page.evaluate(p=>{
    const panel=document.getElementById(p);
    const heads=[].slice.call(panel.querySelectorAll('thead th')).map(h=>h.textContent.trim());
    const i=heads.indexOf('Contract / RFQ ID');
    const rows=[].slice.call(panel.querySelectorAll('tbody tr')).map(tr=>{
      const tds=tr.children;
      return { trip:(tds[heads.indexOf('Trip Info')]||{}).innerText||'',
               ref: i>=0?((tds[i]||{}).innerText||'').trim():null,
               teal: i>=0 && !!(tds[i]&&tds[i].querySelector('.cid-rfq')),
               amt:(tds[heads.indexOf('KMs / Amount')]||{}).innerText||'' };
    });
    return {hasCol:i>=0, rows:rows};
  },pid);
}
/* global view: every row must name its own reference, never the bucket's name */
{
  const r=await refCells(null);
  ck(r.hasCol,'the global Trip MIS has a "Contract / RFQ ID" column');
  // every row must carry SOME reference, and a zonal row must never borrow a bucket card's name
  const blank=r.rows.filter(x=>!x.ref);
  ck(blank.length===0,'every row names a reference ('+blank.length+' blank)');
  const zBad=r.rows.filter(x=>x.teal&&/Zonal_Adhoc_Trips|^ADHOC-/.test(x.ref));
  zBad.slice(0,4).forEach(x=>console.log('    BAD '+x.trip.split('\n')[0]+' -> '+x.ref));
  ck(zBad.length===0,'no zonal row shows a bucket name instead of its own RFQ id ('+zBad.length+' bad)');
  // the rendered value must equal what the payload says, row for row
  const want=await page.evaluate(()=>{const o={};Object.keys(TRIPS).forEach(cid=>TRIPS[cid].forEach(t=>{
    if(o[t.id]===undefined) o[t.id]=t.ref||'';}));return o;});
  const mism=r.rows.filter(x=>{const id=x.trip.split('\n')[0].trim();
    return want[id]!==undefined && want[id] && want[id]!==x.ref;});
  ck(mism.length===0,'each rendered reference equals the payload\'s t.ref ('+mism.length+' mismatch)');
  const z=r.rows.filter(x=>x.teal);
  console.log('  global: '+r.rows.length+' rows, '+z.length+' tinted as RFQ');
  ck(z.length>0&&z.every(x=>/^FM-Zonal-|^MIG-|no RFQ id|^Zonal adhoc$/.test(x.ref)),
     'zonal rows show an RFQ id (or "Zonal adhoc" where none applies), tinted teal');
  ck(r.rows.filter(x=>!x.teal).every(x=>!/^FM-Zonal-|^MIG-/.test(x.ref)),'local rows show a contract id, not an RFQ');
}
/* A zonal ADHOC trip bills on its amount and carries NO rfq_id by design. It must never read as a
   missing value — not "(no RFQ id)", not the bucket's own name. */
{
  const zb=await page.evaluate(()=>(CONTRACTS.find(c=>c.isZonalAdhocBucket)||{}).id);
  const r=await refCells(zb);
  const refs=r.rows.map(x=>x.ref);
  console.log('  zonal-adhoc bucket refs: '+refs.join(' | '));
  ck(r.hasCol,'the Zonal Adhoc bucket shows the reference column');
  ck(refs.every(Boolean),'every zonal adhoc row names a reference');
  ck(r.rows.every(x=>x.teal),'every row in the zonal-adhoc bucket is tinted as zonal');
  ck(!refs.some(x=>/no RFQ id/i.test(x)),'a zonal adhoc trip never reads "(no RFQ id)" — it has none by design');
  ck(!refs.some(x=>/Zonal_Adhoc_Trips|^ADHOC-/.test(x)),'and never borrows the bucket card name');
  const noRfq=await page.evaluate(z=>(TRIPS[z]||[]).filter(t=>!t.rfq).length,zb);
  if(noRfq) ck(refs.filter(x=>x==='Zonal adhoc').length===noRfq,
    'a zonal adhoc trip with no rfq_id reads "Zonal adhoc" ('+noRfq+' row(s))');
}
/* and the dispute modal must not offer an RFQ category on a trip that has no RFQ */
{
  const hit=await page.evaluate(()=>{
    for(const cid of Object.keys(TRIPS)) for(const t of TRIPS[cid])
      if(t.scope==='Zonal'&&t.billing==='Adhoc'&&!t.rfq&&(t.status==='pending'||t.status==='reconfirm'))
        return {cid,id:t.id};
    return null;});
  if(hit){
    await page.evaluate(x=>openDispute(x.cid,x.id),hit);
    await page.waitForSelector('#disputeModal.open');
    const labels=await page.$$eval('#dispCats .disp-check',e=>e.map(x=>x.textContent.trim()));
    console.log('  zonal adhoc, no RFQ → categories: '+labels.join(' / '));
    ck(!labels.some(l=>/RFQ/.test(l)),'a zonal ADHOC trip with no rfq_id is not offered "Wrong RFQ ID"');
    ck(labels.some(l=>/Wrong amount/.test(l)),'it is still offered "Wrong amount"');
    await page.click('#chk-value input'); await page.waitForTimeout(40);
    const note=await page.$eval('#panel-value',e=>e.innerText);
    ck(/billed on its amount/i.test(note),'and the panel explains why there is no RFQ');
    await page.evaluate(()=>closeDispute());
  } else { ck(false,'expected a zonal adhoc trip with no rfq_id in the payload'); }
}
/* the other-adhoc bucket mixes contract ids the same way */
{
  const ob=await page.evaluate(()=>(CONTRACTS.find(c=>c.isAdhocBucket&&!c.isZonalAdhocBucket)||{}).id);
  if(ob){ const r=await refCells(ob);
    console.log('  other-adhoc bucket refs: '+r.rows.map(x=>x.ref).join(' | '));
    ck(r.hasCol,'the Other Adhoc bucket shows the reference column too'); }
}
/* a contract card and a zonal RFQ card pin ONE reference, so the column is redundant there... */
{
  const lc=await page.evaluate(()=>(CONTRACTS.find(c=>!c.isZonalCard&&!c.isAdhocBucket)||{}).id);
  const r=await refCells(lc);
  ck(!r.hasCol,'a local contract card hides the column (the header already names the contract)');
  const zc=await page.evaluate(()=>(CONTRACTS.find(c=>c.isZonalCard)||{}).id);
  const rz=await refCells(zc);
  ck(!rz.hasCol,'a zonal RFQ card hides the column (the header already names the RFQ)');
  // ...but the RFQ is still readable on the row, under the amount
  const amts=rz.rows.map(x=>x.amt.replace(/\n/g,' '));
  console.log('  zonal card amount cells: '+amts.join(' | '));
  ck(amts.some(a=>/RFQ /.test(a)||/not set/.test(a)),'the RFQ id is still visible on each zonal row, under the amount');
}

/* Replacement is dropped on an all-zonal panel, and the RFQ never appears twice on one row */
{
  const zb=await page.evaluate(()=>(CONTRACTS.find(c=>c.isZonalAdhocBucket)||{}).id);
  await page.evaluate(i=>showL2(i),zb); await page.waitForTimeout(150);
  const h=await page.$$eval('#tripPanelContract thead th',e=>e.map(x=>x.textContent.trim()));
  console.log('  zonal-adhoc headers: '+h.filter(Boolean).join(' | '));
  ck(h.indexOf('Replacement')<0,'an all-zonal panel drops the Replacement column (no default-vehicle notion)');
  ck(h.indexOf('Contract / RFQ ID')>=0,'and keeps the reference column');
  const cells=await page.$$eval('#tripPanelContract tbody tr',rows=>rows.map(tr=>tr.innerText));
  const dupe=cells.filter(t=>{const m=t.match(/FM-Zonal-[A-Z]+-RFQ-\d+/g)||[];return m.length>1;});
  ck(dupe.length===0,'the RFQ id is not repeated twice on the same row ('+dupe.length+' duped)');
  const lc=await page.evaluate(()=>(CONTRACTS.find(c=>!c.isZonalCard&&!c.isAdhocBucket)||{}).id);
  await page.evaluate(i=>showL2(i),lc); await page.waitForTimeout(150);
  const h2=await page.$$eval('#tripPanelContract thead th',e=>e.map(x=>x.textContent.trim()));
  ck(h2.indexOf('Replacement')>=0,'a local contract panel keeps the Replacement column');
  const cnt=await page.$$eval('#tripPanelContract tbody tr:first-child td',e=>e.length);
  ck(cnt===h2.length,'header and body cell counts agree on a local panel ('+cnt+' vs '+h2.length+')');
  await page.evaluate(i=>showL2(i),zb); await page.waitForTimeout(120);
  const cnt2=await page.$$eval('#tripPanelContract tbody tr:first-child td',e=>e.length);
  ck(cnt2===h.length,'header and body cell counts agree on a zonal panel ('+cnt2+' vs '+h.length+')');
}

/* ── 3. dispute modal for every trip kind ────────────────────────────────── */
const specimens=await page.evaluate(()=>{
  const out=[],seen={};
  Object.keys(TRIPS).forEach(cid=>TRIPS[cid].forEach(t=>{
    if(t.status!=='pending'&&t.status!=='reconfirm') return;
    const k=(t.scope||'Local')+'/'+t.billing+(t.rto?'/RTO':'')+(t.scope==='Zonal'&&!t.rfq?'/noRFQ':'')
           +((t.km===undefined&&t.amt===undefined)?'/bare':'');
    if(seen[k]) return; seen[k]=1; out.push({k,cid,id:t.id});
  }));
  return out;
});
console.log('\n── dispute modal ──');
for(const s of specimens){
  await page.evaluate(x=>openDispute(x.cid,x.id),s);
  await page.waitForSelector('#disputeModal.open');
  // tick every category so every panel renders
  const catKeys=await page.$$eval('#dispCats .disp-check',els=>els.map(e=>e.id.replace('chk-','')));
  for(const k of catKeys){ await page.click('#chk-'+k+' input'); }
  await page.waitForTimeout(40);
  const modalTxt=await page.$eval('#disputeModal .modal',e=>e.innerText);
  scanText('dispute modal '+s.k,modalTxt);
  const title=await page.$eval('#dispTripId',e=>e.textContent);
  const labels=await page.$$eval('#dispCats .disp-check',els=>els.map(e=>e.textContent.trim()));
  const curVals=await page.$$eval('#dispDetails input[readonly]',els=>els.map(e=>e.value));
  console.log('  '+s.k.padEnd(26)+' cats: '+labels.join(' / '));
  console.log('    '.padEnd(28)+' current: '+curVals.join(' | '));
  if(/RTO/.test(s.k)){
    const vp=await page.$eval('#panel-value',e=>e.innerText).catch(()=>'');
    ck(/not an RTO trip/i.test(vp),'an RTO trip explains that claiming a value also claims it was not an RTO — '+s.k);
  }
  ck(!/ZONAL::|::ZONAL/.test(title),'modal title clean for '+s.k);
  ck(curVals.every(v=>!/null|undefined|NaN/.test(v)),'no null in readonly fields for '+s.k);

  const zonal=/^Zonal/.test(s.k);
  /* a zonal ADHOC trip with no rfq_id has no RFQ to dispute — the category is correctly withheld */
  const wantsRfqCat = zonal && !(/Adhoc/.test(s.k) && /noRFQ/.test(s.k));
  if(zonal){
    ck(labels.some(l=>/Wrong amount/.test(l)),'zonal shows "Wrong amount" not "Wrong KM" — '+s.k);
    ck(labels.some(l=>/Wrong RFQ ID/.test(l))===wantsRfqCat,
       (wantsRfqCat?'zonal shows "Wrong RFQ ID" — ':'zonal adhoc with no RFQ withholds "Wrong RFQ ID" — ')+s.k);
    ck((await page.$('#dsp_rfq')!==null)===wantsRfqCat,
       (wantsRfqCat?'zonal has an RFQ id input — ':'zonal adhoc with no RFQ has no RFQ input — ')+s.k);
    ck(await page.$('#dsp_contract')===null,'zonal has NO separate contract-id field: the RFQ id IS the contract ref — '+s.k);
    ck(await page.$('#dsp_aggveh')===null,'zonal has NO aggregate-vehicle dropdown — '+s.k);
    ck(curVals.every(v=>!/ km$/.test(v)),'zonal shows no KM field — '+s.k);
  } else {
    ck(labels.some(l=>/Wrong KM \/ Amount/.test(l)),'local keeps "Wrong KM / Amount" — '+s.k);
    ck(await page.$('#dsp_rfq')===null,'local has no RFQ id input — '+s.k);
  }

  // fill and submit
  const before=posted.length;
  await page.fill('#dsp_value', zonal?'9999':(/Adhoc/.test(s.k)?'5555':'321'));
  if(await page.$('#dsp_rfq')) await page.fill('#dsp_rfq','FM-Zonal-TEST-9');
  if(await page.$('#dsp_contract')) await page.fill('#dsp_contract','CID-TEST-9');
  const av=await page.$('#dsp_aggveh');
  if(av){ const opts=await page.$$eval('#dsp_aggveh option',o=>o.map(x=>x.value).filter(Boolean));
          if(opts.length) await page.selectOption('#dsp_aggveh',opts[0]); }
  await page.fill('#dsp_callback','+91 9812345678');
  await page.fill('#dsp_desc','harness');
  await page.setInputFiles('#dsp_proof',{name:'p.png',mimeType:'image/png',buffer:Buffer.from('x')});
  alertMsg='';
  await page.click('#dispSubmitBtn');
  await page.waitForTimeout(200);
  ck(!alertMsg,'submit raised no alert for '+s.k+(alertMsg?(' ("'+alertMsg+'")'):''));
  if(posted.length===before){ fails.push('  FAIL submit did not post for '+s.k); await page.evaluate(()=>closeDispute()); continue; }
  const b=posted[posted.length-1];
  console.log('    → posted: '+JSON.stringify(b.categories)+' '+JSON.stringify(
    Object.keys(b).filter(k=>k.indexOf('claim_')===0).reduce((o,k)=>(o[k]=b[k],o),{})));
  ck(b.type==='dispute'&&b.trip_id===s.id,'posts the right trip for '+s.k);
  /* An RTO trip pays nothing in either scope, so a value claim on one is only meaningful if the RTO
     marking is lifted too — claim_challan_type is what does that. Without it the resolution is a no-op. */
  if(/RTO/.test(s.k)) ck(b.claim_challan_type==='Forward Only',
    'an RTO trip carries claim_challan_type so an upheld claim is not a no-op — '+s.k);
  else ck(!b.claim_challan_type,'a non-RTO trip sends no challan claim — '+s.k);
  if(zonal){
    if(/Adhoc/.test(s.k)) ck(b.claim_amount==='9999','zonal adhoc claims claim_amount — '+s.k);
    else ck(b.claim_zonal_amount==='9999','zonal regular claims claim_zonal_amount — '+s.k);
    ck((b.claim_rfq_id==='FM-Zonal-TEST-9')===wantsRfqCat,
       (wantsRfqCat?'zonal posts claim_rfq_id — ':'zonal adhoc with no RFQ posts no claim_rfq_id — ')+s.k);
    ck(!b.claim_km,'zonal never posts claim_km — '+s.k);
    ck(!b.claim_aggregate_vehicle,'zonal never posts claim_aggregate_vehicle — '+s.k);
    ck((b.categories||[]).some(c=>/Wrong zonal amount|Wrong RFQ/.test(c)),'zonal log categories are scope-aware — '+s.k);
    ck(!b.claim_contract_id,'zonal never posts claim_contract_id — '+s.k);
  } else {
    ck(!b.claim_zonal_amount&&!b.claim_rfq_id,'local never posts zonal claim fields — '+s.k);
    ck(b.claim_contract_id==='CID-TEST-9','local still posts claim_contract_id — '+s.k);
    if(/Adhoc/.test(s.k)) ck(b.claim_amount==='5555','local adhoc claims claim_amount — '+s.k);
    else ck(b.claim_km==='321','local regular claims claim_km — '+s.k);
  }
  await page.evaluate(()=>{ try{closeDispute();}catch(e){} });
}

/* ── 4. validation guards still bite ─────────────────────────────────────── */
console.log('\n── validation guards ──');
const g=specimens.find(s=>/^Zonal\/Regular$/.test(s.k))||specimens[0];
await page.evaluate(x=>openDispute(x.cid,x.id),g);
await page.waitForSelector('#disputeModal.open');
alertMsg='';
await page.click('#dispSubmitBtn'); await page.waitForTimeout(120);
ck(/Select at least one issue/.test(alertMsg),'blocks submit with no category ticked ("'+alertMsg+'")');
await page.click('#chk-value input'); alertMsg='';
await page.click('#dispSubmitBtn'); await page.waitForTimeout(120);
ck(/enter the correct amount/i.test(alertMsg),'blocks empty amount on zonal ("'+alertMsg+'")');
await page.fill('#dsp_value','abc'); alertMsg='';
await page.click('#dispSubmitBtn'); await page.waitForTimeout(120);
ck(/valid number/i.test(alertMsg),'blocks a non-numeric amount ("'+alertMsg+'")');
await page.fill('#dsp_value','1200'); alertMsg='';
await page.click('#dispSubmitBtn'); await page.waitForTimeout(120);
ck(/Callback number is required/i.test(alertMsg),'still requires a callback number ("'+alertMsg+'")');
await page.evaluate(()=>closeDispute());

/* ── 5. View-Dispute for a zonal and a local dispute ─────────────────────── */
console.log('\n── view dispute ──');
const disputed=await page.evaluate(()=>{ const o=[];
  Object.keys(TRIPS).forEach(cid=>TRIPS[cid].forEach(t=>{ if(t.disp) o.push({cid,id:t.id,scope:t.scope||'Local',st:t.status}); }));
  return o; });
for(const d of disputed){
  await page.evaluate(x=>viewDispute(x.cid,x.id),d);
  await page.waitForSelector('#viewDisputeModal.open');
  const txt=await page.$eval('#vdBody',e=>e.innerText);
  scanText('view-dispute '+d.scope+'/'+d.st,txt);
  console.log('  '+(d.scope+'/'+d.st).padEnd(20)+' → '+txt.replace(/\n/g,' · ').slice(0,190));
  if(d.scope==='Zonal'){
    ck(/Wrong zonal amount|Wrong RFQ/.test(txt),'zonal dispute shows its real category — '+d.id);
    ck(!/Resolved KM/.test(txt),'zonal resolution hides the KM row — '+d.id);
  }
  await page.evaluate(()=>closeViewDispute());
}

/* ── 6. confirm + bulk confirm on a zonal card ───────────────────────────── */
console.log('\n── confirm paths ──');
const zcard=await page.evaluate(()=>(CONTRACTS.find(c=>c.isZonalCard)||{}).id);
await page.evaluate(i=>showL2(i),zcard); await page.waitForTimeout(80);
const before2=posted.length;
const oneZ=await page.evaluate(z=>{const t=(TRIPS[z]||[]).find(x=>x.status==='pending');return t?t.id:null;},zcard);
if(oneZ){ await page.evaluate(x=>confirmTrip(x.c,x.i),{c:zcard,i:oneZ}); await page.waitForTimeout(150);
  ck(posted.length>before2&&posted[posted.length-1].type==='confirm','single confirm posts on a zonal trip'); }
const chks=await page.$$('.rowchk_tripPanelContract');
if(chks.length){ for(const c of chks) await c.check();
  const b3=posted.length;
  await page.click('#bulk_tripPanelContract .btn-primary').catch(async()=>{ await page.evaluate(()=>bulkConfirm('tripPanelContract')); });
  await page.waitForTimeout(200);
  ck(posted.length>b3&&Array.isArray(posted[posted.length-1].trip_ids),'bulk confirm posts trip_ids on a zonal card'); }

/* ── 7. table layout: no horizontal blow-out, scroller present ───────────── */
console.log('\n── table layout ──');
const lay=await page.evaluate(()=>{ const w=document.querySelector('#view-l2 .tscroll');
  return w?{has:true,scrollW:w.scrollWidth,clientW:w.clientWidth,ov:getComputedStyle(w).overflowX}:{has:false}; });
ck(lay.has,'trip table is wrapped in a .tscroll scroller');
ck(lay.ov==='auto','.tscroll uses overflow-x:auto (measured '+lay.ov+')');
console.log('  table '+lay.scrollW+'px inside a '+lay.clientW+'px column');
const bodyOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
ck(bodyOverflow<=1,'the page itself does not scroll sideways (overflow '+bodyOverflow+'px)');

/* ── 7b. Confirm / Raise Dispute must be REACHABLE, not merely rendered ──── */
console.log('\n── action column reachability ──');
for(const w of [1920,1600,1440,1280,1152]){
  await page.setViewportSize({width:w,height:900});
  await page.evaluate(()=>showGlobalMIS()); await page.waitForTimeout(200);
  const m=await page.evaluate(()=>{
    const wrap=document.querySelector('#view-mis .tscroll');
    const tbl=wrap.querySelector('table');
    wrap.scrollLeft=0;                                     // worst case: NOT scrolled right
    const th=[].slice.call(tbl.querySelectorAll('thead th'));
    const act=th[th.length-1];
    const btn=wrap.querySelector('tbody td.col-act .btn-primary');
    const wr=wrap.getBoundingClientRect();
    const ar=act.getBoundingClientRect();
    const br=btn?btn.getBoundingClientRect():null;
    return {last:act.textContent.trim(), sticky:getComputedStyle(act).position,
      overflow:tbl.scrollWidth-wrap.clientWidth,
      headerVisible: ar.right<=wr.right+1 && ar.left>=wr.left-1,
      btnText:btn?btn.textContent.trim():null,
      btnVisible: br? (br.right<=wr.right+1 && br.left>=wr.left-1) : false};
  });
  console.log('  '+w+'px: overflow '+m.overflow+' · last col "'+m.last+'" ('+m.sticky+') · header visible '+m.headerVisible+' · "'+m.btnText+'" visible '+m.btnVisible);
  ck(m.last==='Action','the Action column exists at '+w+'px');
  ck(m.sticky==='sticky','the Action column is pinned at '+w+'px');
  ck(m.headerVisible,'the Action header is on screen without scrolling at '+w+'px');
  ck(m.btnVisible,'the Confirm button is on screen without scrolling at '+w+'px (was scrolled off)');
}
await page.setViewportSize({width:1440,height:1000});
/* and the buttons are actually there for a pending trip, on every card type */
{
  const kinds=await page.evaluate(()=>{
    const out=[];
    ['isZonalCard','isZonalAdhocBucket','isAdhocBucket'].forEach(f=>{const c=CONTRACTS.find(x=>x[f]);if(c)out.push(c.id);});
    const l=CONTRACTS.find(c=>!c.isZonalCard&&!c.isAdhocBucket); if(l) out.push(l.id);
    return out;});
  for(const id of kinds){
    await page.evaluate(i=>showL2(i),id); await page.waitForTimeout(150);
    const b=await page.evaluate(i=>{
      const rows=[].slice.call(document.querySelectorAll('#tripPanelContract tbody tr'));
      let pend=0,conf=0,dispOK=0,dispClosed=0,both=0,neither=0;
      rows.forEach(tr=>{
        const txt=tr.innerText;
        if(!/Pending Confirmation/.test(txt)) return;
        pend++;
        const hasConf=/Confirm<|Confirm$|Confirm\b/.test(txt);
        const hasD=/Raise Dispute/.test(txt), hasC=/Dispute window closed/.test(txt);
        if(hasConf) conf++;
        if(hasD) dispOK++; if(hasC) dispClosed++;
        if(hasD&&hasC) both++; if(!hasD&&!hasC) neither++;
      });
      // cross-check against the payload's own view of the window
      const open=(TRIPS[i]||[]).filter(t=>t.status==='pending'&&disputeOpen(t)).length;
      const shut=(TRIPS[i]||[]).filter(t=>t.status==='pending'&&!disputeOpen(t)).length;
      return {pend,conf,dispOK,dispClosed,both,neither,open,shut};},id);
    console.log('  '+id.padEnd(34)+' pending '+b.pend+' → Confirm '+b.conf
      +' · Raise Dispute '+b.dispOK+'/'+b.open+' open · "closed" '+b.dispClosed+'/'+b.shut);
    if(b.pend){
      ck(b.conf===b.pend,'Confirm shows for EVERY pending trip on '+id+' ('+b.conf+'/'+b.pend+')');
      ck(b.dispOK===b.open,'Raise Dispute shows for every pending trip whose window is open on '+id);
      ck(b.dispClosed===b.shut,'"Dispute window closed" shows where the window has passed on '+id);
      ck(b.both===0,'never both a Raise Dispute button and a closed notice on one row ('+id+')');
      ck(b.neither===0,'every pending row says one or the other ('+id+')');
    }
  }
}

/* ── 8. CSV export still builds ──────────────────────────────────────────── */
const csvHead=await page.evaluate(()=>{
  let cap=null; const old=Blob; window.Blob=function(a,o){cap=a[0];return new old(a,o);};
  const oldC=URL.createObjectURL; URL.createObjectURL=()=>'blob:x'; URL.revokeObjectURL=()=>{};
  try{ downloadCSV(); }catch(e){ return 'ERR '+e.message; }
  window.Blob=old; URL.createObjectURL=oldC;
  return cap?cap.split('\n').slice(0,2).join('\n'):'EMPTY'; });
ck(!/^ERR/.test(csvHead)&&/Route Scope/.test(csvHead),'CSV export builds and carries Route Scope');
scanText('CSV rows',csvHead);

/* the sandbox has no outbound network and blob: is stubbed, so resource-load noise is not an app error */
const realErrs=consoleErrs.filter(e=>!/Failed to load resource|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|Not allowed to load local resource/.test(e));
ck(realErrs.length===0,'no JS/console errors ('+(realErrs.slice(0,3).join(' | ')||'clean')+')');

await browser.close();
console.log('\n── results ──');
notes.forEach(n=>console.log(n));
if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
console.log('\nALL '+notes.length+' CHECKS PASSED');
})();
