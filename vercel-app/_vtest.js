process.env.JWT_SECRET='test-secret-abcdefghijklmnopqrstuvwxyz-0123456789';
process.env.UPSTASH_REDIS_REST_URL='https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN='mock';

// stub nodemailer (not installed in sandbox) via Module loader
const Module=require('module'); const _load=Module._load;
Module._load=function(req,parent,isMain){ if(req==='nodemailer') return {createTransport:()=>({sendMail:async()=>({messageId:'stub'})})}; return _load(req,parent,isMain); };

// mock Upstash via global fetch
const STORE=new Map();
global.fetch=async(url,opts)=>{ const [op,key,val]=JSON.parse(opts.body); let result=null;
  if(op==='GET') result=STORE.has(key)?STORE.get(key):null;
  else if(op==='SET'){STORE.set(key,val);result='OK';}
  else if(op==='DEL'){STORE.delete(key);result=1;} return {json:async()=>({result})}; };

const core=require('./lib/core.js');
let pass=true; const chk=(n,c,x)=>{console.log((c?'PASS':'FAIL')+' — '+n+(x!==undefined?'  ['+x+']':''));if(!c)pass=false;};

const tok=core.signJwt({email:'v@x.com',oracle:'ORC-4521',name:'V1',role:'vendor'});
chk('JWT verifies & carries oracle',(core.verifyJwt(tok)||{}).oracle==='ORC-4521');
chk('Tampered JWT rejected',core.verifyJwt(tok.slice(0,-3)+'zzz')===null);
chk('Expired JWT rejected',core.verifyJwt(core.signJwt({oracle:'X'},-10))===null);
chk('Garbage token rejected',core.verifyJwt('nope')===null && core.verifyJwt('')===null);

function mkReq(method,body,cookie){return {method,body,headers:cookie?{cookie}:{}};}
function mkRes(){const r={_status:200,_json:null,_headers:{}};r.status=c=>{r._status=c;return r;};r.json=j=>{r._json=j;return r;};r.setHeader=(k,v)=>{r._headers[k]=v;};return r;}

STORE.set('access:vendor1@example.com',JSON.stringify({oracle:'ORC-4521',name:'Rajkot Movers',role:'vendor',active:true}));
STORE.set('access:disabled@example.com',JSON.stringify({oracle:'ORC-4521',name:'X',role:'vendor',active:false}));
STORE.set('access:ground.ops@meesho.com',JSON.stringify({oracle:'',name:'',role:'ground',active:true}));
STORE.set('vendor:ORC-4521',JSON.stringify({vendor:{name:'Rajkot Movers',oracle:'ORC-4521',mtdKm:4236,clusters:2,contractCount:3},contracts:[{id:'C1'}],vehicles:{},trips:{}}));
STORE.set('vendor:ORC-9902',JSON.stringify({vendor:{name:'Other',oracle:'ORC-9902'},contracts:[{id:'CX'}],vehicles:{},trips:{}}));

const requestOtp=require('./api/request-otp.js');
const verifyOtp=require('./api/verify-otp.js');
const dataApi=require('./api/data.js');
const logoutApi=require('./api/logout.js');

(async()=>{
  let r=mkRes(); await requestOtp(mkReq('POST',{email:'nobody@x.com'}),r); chk('request-otp unregistered rejected',r._json.ok===false);
  r=mkRes(); await requestOtp(mkReq('POST',{email:'disabled@example.com'}),r); chk('request-otp disabled rejected',r._json.ok===false);
  r=mkRes(); await requestOtp(mkReq('POST',{email:'ground.ops@meesho.com'}),r); chk('request-otp non-vendor rejected',r._json.ok===false);
  r=mkRes(); await requestOtp(mkReq('POST',{email:'bad-email'}),r); chk('request-otp invalid email rejected',r._json.ok===false);
  r=mkRes(); await requestOtp(mkReq('POST',{email:'vendor1@example.com'}),r); chk('request-otp valid → ok + OTP stored',r._json.ok===true && STORE.has('otp:vendor1@example.com'));
  const code=JSON.parse(STORE.get('otp:vendor1@example.com')).code;
  r=mkRes(); await requestOtp(mkReq('POST',{email:'vendor1@example.com'}),r); chk('request-otp resend cooldown blocks',r._json.ok===false);

  r=mkRes(); await verifyOtp(mkReq('POST',{email:'vendor1@example.com',code:'000000'}),r);
  chk('verify wrong code → rejected + attempt counted',r._json.ok===false && JSON.parse(STORE.get('otp:vendor1@example.com')).attempts===1);
  r=mkRes(); await verifyOtp(mkReq('POST',{email:'vendor1@example.com',code:code}),r);
  const setc=r._headers['Set-Cookie']||'';
  chk('verify correct → ok + HttpOnly Secure cookie',r._json.ok===true && /valmo_session=/.test(setc) && /HttpOnly/.test(setc) && /Secure/.test(setc));
  chk('OTP burned after use',!STORE.has('otp:vendor1@example.com'));
  const sess=(setc.match(/valmo_session=([^;]+)/)||[])[1];

  r=mkRes(); await dataApi(mkReq('GET'),r); chk('data without session → 401',r._status===401);
  r=mkRes(); await dataApi(mkReq('GET',null,'valmo_session='+sess),r);
  chk('data with session → own payload only (ORC-4521, mtd 4236)',r._json.ok===true && r._json.data.vendor.oracle==='ORC-4521' && r._json.data.vendor.mtdKm===4236 && r._json.data.contracts[0].id==='C1');
  r=mkRes(); await dataApi(mkReq('GET',null,'valmo_session=eyJ.'+Buffer.from(JSON.stringify({oracle:'ORC-9902',exp:9999999999})).toString('base64')+'.forged'),r);
  chk('forged (unsigned) token → 401 (cannot reach ORC-9902)',r._status===401);

  r=mkRes(); await logoutApi(mkReq('POST'),r); chk('logout clears cookie',/Max-Age=0/.test(r._headers['Set-Cookie']||''));

  console.log('\n'+(pass?'✅ ALL VERCEL BACKEND CHECKS PASSED':'❌ FAILURES ABOVE'));
})();
