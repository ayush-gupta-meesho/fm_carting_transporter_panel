const Z=[
 {route:"EJN->MIS",vendor:"Ajay Enterprises",size:"8FT",rt:478,band:"250-500",reg:14,vr:8110,mr:243300,d15:121650,vkm:500,rfq:"MIG-FM-Aug-Zonal-EJN-MIS-RFQ-0001"},
 {route:"EAG->QCT->MIS",vendor:"Pune Logistics",size:"8FT",rt:310,band:"250-500",reg:14.5,vr:5085,mr:152550,d15:76275,vkm:310,rfq:"MIG-FM-Aug-Zonal-EAG-QCT-MIS-RFQ-0001"},
 {route:"EBR->MIS",vendor:"Shree Sadguru Krupa Enterprises",size:"7FT",rt:247,band:"0-250",reg:13.5,vr:4030,mr:120900,d15:60450,vkm:260,rfq:"MIG-FM-Aug-Zonal-EBR-MIS-RFQ-0001"}];
const band=k=>k<=250?"0-250":k<=500?"250-500":"500+";
let t15=0;
Z.forEach(z=>{
 const out=[];
 if(Math.abs(z.mr-z.vr*30)>1) out.push("monthly_rate != vendor_rate x 30 ("+z.vr*30+")");
 if(Math.abs(z.d15-z.mr/2)>1) out.push("day_15_rate != monthly/2 ("+z.mr/2+")");
 const toll=z.vr - z.vkm*z.reg, tollRT=z.vr - z.rt*z.reg;
 if(z.rt!==z.vkm) out.push("round_trip_km "+z.rt+" != vendor_km "+z.vkm+"  (diff "+(z.vkm-z.rt)+" km => Rs "+((z.vkm-z.rt)*z.reg*15).toFixed(0)+" over 15 days)");
 if(band(z.rt)!==z.band) out.push('dist_band "'+z.band+'" but round_trip_km '+z.rt+" -> "+band(z.rt));
 if(band(z.vkm)!==z.band) out.push('dist_band "'+z.band+'" but BILLED km '+z.vkm+" -> "+band(z.vkm));
 t15+=z.d15;
 console.log(z.route+"   "+z.vendor);
 console.log("   vendor_rate "+z.vr+" = "+z.vkm+" x "+z.reg+" + toll "+toll.toFixed(0)+"   |  on round_trip "+z.rt+" implied toll would be "+tollRT.toFixed(0));
 out.forEach(o=>console.log("   FLAG: "+o));
 if(!out.length) console.log("   clean");
 console.log("");
});
console.log("zonal 15-day total: Rs "+t15.toLocaleString("en-IN"));
console.log("toll total over 15d: Rs "+(Z.reduce((s,z)=>s+(z.vr-z.vkm*z.reg),0)*15).toFixed(0));
console.log("rfq tail uniqueness (last 8 chars): "+(new Set(Z.map(z=>z.rfq.slice(-8))).size)+" of 3  -> all end '"+Z[0].rfq.slice(-8)+"'");
console.log("full rfq_id uniqueness: "+(new Set(Z.map(z=>z.rfq)).size)+" of 3");
console.log("non-ASCII in any rfq_id: "+Z.some(z=>/[^\x00-\x7F]/.test(z.rfq)));
console.log("vendor names present in Contract_Info? ");
const fs=require('fs');
const names=new Set(fs.readFileSync('__DIR__/Contract_Info.csv','utf8').split('\n').slice(1).filter(Boolean).map(l=>l.split(',').slice(2).join(',').replace(/^"|"$/g,'')).map(s=>s.split('",')[0].replace(/^"/,'')));
const ci=fs.readFileSync('__DIR__/Contract_Info.csv','utf8').split('\n').slice(1).filter(Boolean);
const nm=new Set(); ci.forEach(l=>{const m=/^[^,]+,[^,]+,(.+?),Mumbai,/.exec(l); if(m) nm.add(m[1]);});
Z.forEach(z=>console.log("   '"+z.vendor+"' -> "+(nm.has(z.vendor)?"MATCH":"NO MATCH in Contract_Info")));
console.log("\nContract_Info vendor_names: "+[...nm].join(" | "));
