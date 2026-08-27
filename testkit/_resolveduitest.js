/* THE PANEL SIDE OF THE LOST-RESOLUTION BUG — 2026-08-27.
 *
 * Two panel defects made the data loss invisible, and made an accepted correction look reverted:
 *
 *  1. The KM cell rendered t.km and nothing else, so a resolved trip and an unresolved one were
 *     pixel-identical. Nothing on the row said the number had been corrected.
 *  2. The "View dispute" link was gated on  status==='disputed' || status==='reconfirm'. The moment a
 *     vendor pressed Accept the trip became 'confirmed' and the link vanished — taking with it the
 *     ONLY place the panel ever showed resolved_km (the Resolution block reads it live from
 *     Disputes_Log). So the vendor saw the right figure while deciding, and then never again.
 *
 * Drives the real index.html in Chromium against a synthetic payload of the shape Code.gs now emits.
 */
const fs=require('fs'), path=require('path');
const { chromium } = require('playwright');
const HTML = path.join(__dirname,'..','vercel-app','index.html');
const fails=[],notes=[]; const ck=(c,m)=>{(c?notes:fails).push((c?'  ok   ':'  FAIL ')+m);};

/* one contract, four trips: unresolved, resolved-and-awaiting-accept, resolved-and-ACCEPTED, adhoc */
const disp=(km)=>({id:'DSP-1',raised_at:'24 Aug',categories:['km_amount'],claim_km:String(km),
  claim_amount:'',claim_zonal_amount:'',claim_billing_type:'',claim_aggregate_vehicle:'',
  claim_rfq_id:'',claim_contract_id:'',description:'KM Mismatch',callback:'',proof_url:'',
  status:'Resolved',reconfirm_status:'Pending Reconfirmation',orig_total_km:'167.074',
  orig_adhoc_amount:'',orig_billing_type:'Regular',orig_route_scope:'Local',orig_rfq_id:'',
  orig_zonal_rfq_amount:'',resolution_note:'We have reviewed and resolved.',
  resolved_billing_type:'',resolved_km:String(km),resolved_amount:'',resolved_zonal_amount:'',
  resolved_rfq_id:'',resolved_aggregate_vehicle:'',resolved_contract_id:'',
  resolved_by:'Sharan',resolved_at:'26 Aug'});
const T=(o)=>Object.assign({size:'8 FT',veh:'GJ01AA0001',vehNo:'GJ01AA0001',route:['A','B'],
  billing:'Regular',scope:'Local',ref:'RJK8-X',replTag:'default',completed:'19 Aug',
  km:null,amt:null,kmWas:null,amtWas:null,win:'05 Sep',winTs:'2026-09-05 15:44:37',
  sent:true,disp:null},o);
const PAYLOAD={
  vendor:{name:'Krushiv Enterprise',oracle:'18838',duration:'01–31 Aug',mtdKm:12873,clusters:1,contractCount:1},
  contracts:[{id:'RJK8-X',name:'RJK8-X',cluster:'Rajkot',size:'8 FT',hours:'12hr',vehicles:1,
    slabKm:17500,regKm:12873,adhoc:0,period:'01–31 Aug',lastTrip:'19 Aug',
    tiers:[{slabPerVeh:2500,count:1,rate:0}]}],
  vehicles:{'RJK8-X':[{name:'GJ01AA0001',no:'GJ01AA0001',size:'8 FT',tag:'default',km:12873,
    regTrips:4,adhocTrips:0,total:4,slab:2500,replFoldedKm:0,replFolded:0,effectiveKm:12873,
    periodLabel:'01–31 Aug'}]},
  trips:{'RJK8-X':[
    T({id:'TR-PLAIN',  km:167.074, status:'pending'}),
    T({id:'TR-OPEN',   km:183, kmWas:167.074, status:'reconfirm', disp:disp(183), win:null}),
    T({id:'TR-ACCEPT', km:183, kmWas:167.074, status:'confirmed', disp:disp(183), win:null}),
    T({id:'TR-ADHOC',  billing:'Adhoc', km:null, amt:3200, amtWas:2871.44,
       status:'confirmed', disp:disp(0), win:null}),
  ]}
};

(async()=>{
  const browser=await chromium.launch();
  const page=await browser.newPage({viewport:{width:1700,height:1000}});
  const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
  await page.route('**/api/config',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,proofMode:'blob'})}));
  await page.route('**/api/data',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:PAYLOAD})}));
  await page.route('**/index.html',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(HTML,'utf8')}));
  await page.goto('http://local.test/index.html');
  await page.waitForFunction(()=>typeof window.IS_ADMIN!=='undefined',{timeout:15000});
  await page.evaluate(async()=>{ await loadPanel(); showL2('RJK8-X'); });
  await page.waitForTimeout(600);

  const rows = await page.evaluate(()=>{
    const out={};
    [...document.querySelectorAll('.ttable tbody tr')].forEach(tr=>{
      const id=(tr.querySelector('.tid-main')||{}).textContent||'';
      out[id.trim()]={
        kmCell: (tr.querySelector('.km-cell,.adhoc-amt')||{}).textContent||'',
        revised: [...tr.querySelectorAll('.km-revised')].map(e=>e.textContent.trim()),
        revisedTitle: (tr.querySelector('.km-revised')||{}).getAttribute
                       ? (tr.querySelector('.km-revised')||{getAttribute:()=>''}).getAttribute('title') : '',
        statusText: (tr.querySelector('.col-st')||{}).textContent||'',
        links: [...tr.querySelectorAll('.col-st a')].map(a=>a.textContent.trim()),
      };
    });
    return out;
  });
  console.log('── the four rows as rendered ──');
  Object.keys(rows).forEach(k=>console.log('  '+k.padEnd(11)+' km='+JSON.stringify(rows[k].kmCell.trim())
    +'  revised='+JSON.stringify(rows[k].revised)+'  links='+JSON.stringify(rows[k].links)));

  ck(errs.length===0,'the page renders with no JS error'+(errs.length?(' — '+errs[0]):''));
  ck(Object.keys(rows).length===4,'all four trips render ('+Object.keys(rows).length+')');

  console.log('\n── 1. the row itself must carry the correction ──');
  ck(rows['TR-PLAIN'].revised.length===0,'an unresolved trip shows NO revised chip');
  ck(/167\.074/.test(rows['TR-PLAIN'].kmCell),'and shows its own KM');
  ck(rows['TR-OPEN'].revised.length===1,'a resolved trip awaiting accept shows the revised chip');
  ck(/183/.test(rows['TR-OPEN'].kmCell),'with the RESOLVED km as the headline number');
  ck(/revised from 167\.074 km/.test(rows['TR-OPEN'].revised[0]||''),
     'and the chip names what it replaced: '+JSON.stringify(rows['TR-OPEN'].revised[0]));
  ck(rows['TR-ACCEPT'].revised.length===1,
     'THE FIX: an ACCEPTED trip still shows the revised chip (this is the row the vendor said reverted)');
  ck(/183/.test(rows['TR-ACCEPT'].kmCell)&&/revised from 167\.074/.test(rows['TR-ACCEPT'].revised[0]||''),
     'showing 183 km and the 167.074 it came from, after acceptance');
  ck(/dispute was resolved/i.test(rows['TR-OPEN'].revisedTitle||''),'the chip tooltip explains why');
  ck(rows['TR-ADHOC'].revised.length===1&&/2,871/.test(rows['TR-ADHOC'].revised[0]||''),
     'a resolved ADHOC AMOUNT gets the same treatment: '+JSON.stringify(rows['TR-ADHOC'].revised[0]));

  console.log('\n── 2. the resolution must stay reachable after acceptance ──');
  ck(rows['TR-PLAIN'].links.length===0,'a trip with no dispute has no link');
  ck(rows['TR-OPEN'].links.join()==='View dispute','an open reconfirm still says "View dispute"');
  ck(rows['TR-ACCEPT'].links.length===1,
     'THE FIX: an accepted trip STILL has the link (it used to disappear at exactly this point)');
  ck(rows['TR-ACCEPT'].links[0]==='View resolution',
     'and it reads "View resolution", which is what it now is: '+JSON.stringify(rows['TR-ACCEPT'].links[0]));

  /* The reported hunch was that a BULK confirm was accepting the old values. It cannot: the row
     checkbox is rendered only for status==='pending', so a reconfirm trip is not selectable and gets
     its own Accept / Re-dispute buttons instead. Pinned here because /api/action's ACTIONABLE map DOES
     accept 'reconfirm' inside a bulk confirm — so the only thing keeping a bulk accept of unreviewed
     resolutions out is this render gate, and it should not be removed by accident. */
  console.log('\n── 2b. a reconfirm trip is not bulk-selectable ──');
  const sel = await page.evaluate(()=>{
    const o={};
    [...document.querySelectorAll('.ttable tbody tr')].forEach(tr=>{
      const id=((tr.querySelector('.tid-main')||{}).textContent||'').trim();
      o[id]={ box: tr.querySelectorAll('input[type=checkbox]').length,
              actions: [...tr.querySelectorAll('.col-act button')].map(b=>b.textContent.trim()) };
    });
    return o;
  });
  Object.keys(sel).forEach(k=>console.log('  '+k.padEnd(11)+' checkbox='+sel[k].box
    +'  actions=['+sel[k].actions.join(', ')+']'));
  ck(sel['TR-PLAIN'].box===1,'a pending trip IS bulk-selectable');
  ck(sel['TR-OPEN'].box===0,
     'a trip awaiting reconfirmation is NOT bulk-selectable — a bulk confirm cannot sweep it up');
  ck(sel['TR-OPEN'].actions.join(' / ')==='Accept / Re-dispute',
     'it gets Accept / Re-dispute of its own, so accepting a correction is always a deliberate act');
  ck(sel['TR-ACCEPT'].box===0,'and a settled trip is not selectable either');

  console.log('\n── 3. the dialog on an accepted trip shows the resolved figure ──');
  const dlg = await page.evaluate(()=>{
    viewDispute('RJK8-X','TR-ACCEPT');
    const b=document.getElementById('vdBody');
    return { open: document.getElementById('viewDisputeModal').classList.contains('open'),
             text: b?b.textContent.replace(/\s+/g,' '):'' };
  });
  console.log('  dialog open=%s', dlg.open);
  ck(dlg.open===true,'the dialog opens on an accepted trip');
  ck(/Resolved KM/.test(dlg.text)&&/183/.test(dlg.text),'and still shows Resolved KM 183');
  ck(/Was.*167\.074 km/.test(dlg.text),'alongside the original 167.074 km it disputed');
  ck(/Resolved/.test(dlg.text),'with the Resolved pill');

  console.log('\n── 4. non-vacuity: restore the old gate and the old KM cell ──');
  const broke = await page.evaluate(()=>{
    /* reproduce the two old renderers on the accepted row and report what the vendor saw */
    const t=TRIPS['RJK8-X'].filter(x=>x.id==='TR-ACCEPT')[0];
    const oldLink = (t.status==='disputed'||t.status==='reconfirm') && t.disp;
    const oldKmCell = '<b>'+t.km+'</b> km';                 // no kmWas branch at all
    return { oldLinkShown: !!oldLink, oldKmCell: oldKmCell, kmWas: t.kmWas };
  });
  console.log('  old gate on TR-ACCEPT -> link shown: %s ; old km cell: %j',
    broke.oldLinkShown, broke.oldKmCell);
  ck(broke.oldLinkShown===false,
     'under the OLD gate the accepted trip had NO link — the resolution was unreachable (bug reproduced)');
  ck(!/167/.test(broke.oldKmCell),
     'and the OLD km cell showed 183 with no trace of the 167.074 it replaced, so nothing said it had changed');
  ck(broke.kmWas===167.074,'while the payload was carrying the original all along');

  await browser.close();
  console.log('\n── results ──'); notes.forEach(x=>console.log(x));
  if(fails.length){ console.log('\n'+fails.length+' FAILURE(S):'); fails.forEach(f=>console.log(f)); process.exit(1); }
  console.log('\nALL '+notes.length+' CHECKS PASSED');
})();
