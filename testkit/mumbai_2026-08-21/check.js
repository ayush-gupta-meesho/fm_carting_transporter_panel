const fs=require('fs');
function parseCSV(p){const t=fs.readFileSync(p,'utf8').trim().split('\n');
 const split=l=>{const o=[];let c='',q=false;for(const ch of l){if(ch==='"'){q=!q;}else if(ch===','&&!q){o.push(c);c='';}else c+=ch;}o.push(c);return o;};
 const h=split(t[0]);return t.slice(1).map(l=>{const v=split(l);const r={};h.forEach((k,i)=>r[k]=v[i]);return r;});}
const num=s=>Number(String(s==null?'':s).replace(/[^0-9.\-]/g,''))||0;
const ci=parseCSV('__DIR__/Contract_Info.csv');
const lo=parseCSV('__DIR__/Local.csv');

// rate card 12hr / 24hr : tier -> monthly
const CARD={
 '12':{ '7':{2000:43000,3000:47000,4500:54000,6000:67000,ex:8},
        '8':{2000:47500,3000:54000,4500:64000,6000:78000,ex:10},
        '10':{2000:60000,3000:71000,4500:91000,6000:103500,ex:12},
        '14':{2000:67000,3000:78000,4500:102000,6000:115000,ex:14}},
 '24':{ '7':{2000:56000,3000:76000,4500:80000,6000:84000,ex:8},
        '8':{2000:60500,3000:80000,4500:86000,6000:94000,ex:10},
        '10':{2000:68000,3000:91000,4500:109000,6000:122000,ex:12},
        '14':{2000:73000,3000:97000,4500:115000,6000:130000,ex:14}}};
const F=[];const fail=(g,m)=>F.push([g,m]);
const days=(a,b)=>Math.round((new Date(b)-new Date(a))/864e5)+1;

// ---- 1. every Local contract_id exists in Contract_Info, and vice versa
const ciMap={};ci.forEach(r=>{if(ciMap[r.contract_id])fail('CI-DUP','duplicate contract_id '+r.contract_id);ciMap[r.contract_id]=r;});
const byC={};lo.forEach(r=>{(byC[r.contract_id]=byC[r.contract_id]||[]).push(r);});
Object.keys(byC).forEach(c=>{if(!ciMap[c])fail('ORPHAN','Local contract_id not in Contract_Info: '+c);});
ci.forEach(r=>{if(!byC[r.contract_id])fail('EMPTY','Contract_Info row with no Local vehicles: '+r.contract_id);});

// ---- 2. count / km / amount reconciliation
console.log('== RECONCILIATION (Contract_Info vs Local) ==');
let tCnt=0,tKm=0,tAmt=0,tCiCnt=0,tCiKm=0,tCiAmt=0;
ci.forEach(r=>{
 const v=byC[r.contract_id]||[];
 const cnt=v.length, km=v.reduce((s,x)=>s+num(x.pegged_km_slab),0), amt=v.reduce((s,x)=>s+num(x.monthly_rate),0);
 tCnt+=cnt;tKm+=km;tAmt+=amt;
 tCiCnt+=num(r.no_of_vehicles);tCiKm+=num(r.total_km_slab);tCiAmt+=num(r.fixed_monthly_value);
 const bad=[];
 if(cnt!==num(r.no_of_vehicles))bad.push('count '+r.no_of_vehicles+' vs '+cnt);
 if(Math.abs(km-num(r.total_km_slab))>1)bad.push('km '+num(r.total_km_slab)+' vs '+km);
 if(Math.abs(amt-num(r.fixed_monthly_value))>1)bad.push('amt '+num(r.fixed_monthly_value)+' vs '+amt);
 if(bad.length){fail('RECON',r.contract_id+' : '+bad.join(' | '));console.log('  MISMATCH '+r.contract_id+' -> '+bad.join(' | '));}
});
console.log('  Contract_Info totals: '+tCiCnt+' veh / '+tCiKm+' km / Rs '+tCiAmt);
console.log('  Local totals        : '+tCnt+' veh / '+tKm+' km / Rs '+tAmt);

// ---- 3. duplicate plate anywhere (and cross-contract with overlapping window)
const seen={};
lo.forEach(r=>{(seen[r.vehicle_number]=seen[r.vehicle_number]||[]).push(r);});
console.log('\n== PLATE UNIQUENESS ==');
let dupes=0;
Object.keys(seen).forEach(p=>{const rs=seen[p];if(rs.length>1){dupes++;
 // overlap?
 for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){
   const a=rs[i],b=rs[j];
   const ov=!(new Date(a.end_date)<new Date(b.start_date)||new Date(b.end_date)<new Date(a.start_date));
   fail('PLATE-DUP',p+' on '+a.contract_id+' ('+a.start_date+'..'+a.end_date+') and '+b.contract_id+' ('+b.start_date+'..'+b.end_date+')'+(ov?' -- WINDOWS OVERLAP':' -- sequential, OK-ish'));
   console.log('  '+p+': '+a.contract_id+' & '+b.contract_id+(ov?'  OVERLAP':'  sequential'));
 }}});
if(!dupes)console.log('  no plate appears twice  (84 rows, '+Object.keys(seen).length+' unique)');

// ---- 4. day1_order contiguous 1..N per contract
console.log('\n== day1_order ==');
let dbad=0;
Object.keys(byC).forEach(c=>{const o=byC[c].map(r=>num(r.day1_order)).sort((a,b)=>a-b);
 const want=o.map((_,i)=>i+1);
 if(JSON.stringify(o)!==JSON.stringify(want)){dbad++;fail('DAY1',c+' order ['+o.join(',')+'] expected [1..'+o.length+']');console.log('  BAD '+c+' -> ['+o.join(',')+']');}});
if(!dbad)console.log('  all '+Object.keys(byC).length+' contracts have contiguous 1..N');

// ---- 5. active_days vs window (inclusive)
console.log('\n== active_days vs date window (inclusive) ==');
let abad=0;
lo.forEach(r=>{const d=days(r.start_date,r.end_date);if(d!==num(r.active_days)){abad++;
 fail('ACTIVE-DAYS',r.contract_id+' / '+r.vehicle_number+' : active_days '+r.active_days+' but '+r.start_date+'..'+r.end_date+' = '+d+' days');
 console.log('  '+r.contract_id+' '+r.vehicle_number+' : active_days='+r.active_days+'  window='+d);}});
if(!abad)console.log('  all 84 rows match');
// contract-level window vs vehicle window
ci.forEach(r=>{(byC[r.contract_id]||[]).forEach(v=>{
 if(v.start_date!==r.contract_start_date||v.end_date!==r.contract_end_date){
  fail('WINDOW',r.contract_id+' / '+v.vehicle_number+' vehicle '+v.start_date+'..'+v.end_date+' vs contract '+r.contract_start_date+'..'+r.contract_end_date);
  console.log('  WINDOW MISMATCH '+r.contract_id+' '+v.vehicle_number);}});});

// ---- 6. rate card:  monthly_rate == tier x active_days / 30,  pegged_km == tierkm x active_days / 30
console.log('\n== RATE CARD (tier x active_days / 30) ==');
let rbad=0;
lo.forEach(r=>{
 const c=ciMap[r.contract_id];if(!c)return;
 const size=String(num(c.vehicle_size)), hrs=String(num(c.hours_slab));
 const card=(CARD[hrs]||{})[size];
 if(!card){fail('CARD','no card for '+size+'FT '+hrs+'hr ('+r.contract_id+')');return;}
 const ad=num(r.active_days), km=num(r.pegged_km_slab), amt=num(r.monthly_rate);
 // find the tier whose prorated km matches
 let hit=null;
 [2000,3000,4500,6000].forEach(t=>{if(Math.abs(t*ad/30-km)<=1)hit=t;});
 if(hit===null){rbad++;fail('TIER',r.contract_id+' / '+r.vehicle_number+' : pegged '+km+' km at '+ad+' days matches no tier (2000/3000/4500/6000 x '+ad+'/30 = '+[2000,3000,4500,6000].map(t=>Math.round(t*ad/30)).join('/')+')');
  console.log('  NO TIER '+r.contract_id+' '+r.vehicle_number+' km='+km+' days='+ad+'  candidates '+[2000,3000,4500,6000].map(t=>Math.round(t*ad/30)).join('/'));return;}
 const exp=card[hit]*ad/30;
 if(Math.abs(exp-amt)>1){rbad++;fail('RATE',r.contract_id+' / '+r.vehicle_number+' : tier '+hit+' -> Rs '+card[hit]+' x '+ad+'/30 = '+Math.round(exp)+' but sheet says '+amt);
  console.log('  RATE '+r.contract_id+' '+r.vehicle_number+'  expected '+Math.round(exp)+' got '+amt);}
});
if(!rbad)console.log('  all 84 rows match the card');

// ---- 7. ex_km_rate vs card extra_km
console.log('\n== ex_km_rate vs card extra_km ==');
const EX={'7':8,'8':10,'10':12,'14':14};
ci.forEach(r=>{const s=String(num(r.vehicle_size));if(EX[s]!==num(r.ex_km_rate))
 {fail('EXKM',r.contract_id+' ex_km_rate '+r.ex_km_rate+' vs card '+EX[s]);console.log('  '+r.contract_id+' '+r.ex_km_rate+' vs '+EX[s]);}});

// ---- 8. contract_id internal consistency
console.log('\n== contract_id format ==');
ci.forEach(r=>{
 const m=/^MUM(\d+)-(\d+)-(\d{8})-31(-24H)?$/.exec(r.contract_id);
 if(!m){fail('ID','malformed contract_id '+r.contract_id);console.log('  malformed '+r.contract_id);return;}
 if(m[1]!==String(num(r.vehicle_size)))fail('ID',r.contract_id+' size prefix '+m[1]+' vs vehicle_size '+r.vehicle_size);
 if(m[2]!==String(num(r.vendor_oracle_id)))fail('ID',r.contract_id+' oracle '+m[2]+' vs '+r.vendor_oracle_id);
 const sd=r.contract_start_date.replace(/-/g,'');
 if(m[3]!==sd)fail('ID',r.contract_id+' date-in-id '+m[3]+' vs contract_start_date '+sd);
 if(!!m[4]!==(num(r.hours_slab)===24))fail('ID',r.contract_id+' 24H suffix vs hours_slab '+r.hours_slab);
});

// ---- 9. oracle -> one vendor_name
console.log('\n== vendor identity ==');
const on={};ci.forEach(r=>{(on[r.vendor_oracle_id]=on[r.vendor_oracle_id]||new Set()).add(r.vendor_name);});
Object.keys(on).forEach(o=>{if(on[o].size>1){fail('NAME','oracle '+o+' has names: '+[...on[o]].join(' / '));console.log('  oracle '+o+': '+[...on[o]].join(' / '));}});
const no={};ci.forEach(r=>{(no[r.vendor_name]=no[r.vendor_name]||new Set()).add(r.vendor_oracle_id);});
Object.keys(no).forEach(n=>{if(no[n].size>1){fail('NAME',n+' has oracles '+[...no[n]].join(','));console.log('  '+n+' -> '+[...no[n]].join(','));}});

// ---- 10. KM string formats
console.log('\n== km cell formats ==');
const fmt={};
ci.forEach(r=>{const s=r.total_km_slab;const k=/^\d{1,3}(,\d{3})* km$/.test(s)?'"N,NNN km"':/^\d+ km$/.test(s)?'"NNN km"':/^\d+km$/.test(s)?'"NNNkm" (no space)':/^\d+$/.test(s)?'bare number':'OTHER: '+s;(fmt[k]=fmt[k]||[]).push(r.contract_id);});
Object.keys(fmt).forEach(k=>console.log('  Contract_Info '+k+' : '+fmt[k].length+'  e.g. '+fmt[k][0]));
const fmt2={};
lo.forEach(r=>{const s=r.pegged_km_slab;const k=/^\d{1,3}(,\d{3})* km$/.test(s)?'"N,NNN km"':/^\d+ km$/.test(s)?'"NNN km"':/^\d+km$/.test(s)?'"NNNkm" (no space)':/^\d+$/.test(s)?'bare number':'OTHER: '+s;(fmt2[k]=fmt2[k]||[]).push(r.contract_id);});
Object.keys(fmt2).forEach(k=>console.log('  Local         '+k+' : '+fmt2[k].length+'  e.g. '+fmt2[k][0]));

console.log('\n=========== '+F.length+' FINDINGS ===========');
F.forEach((f,i)=>console.log((i+1)+'. ['+f[0]+'] '+f[1]));
