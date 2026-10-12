const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const PORT=process.env.PORT||3000, HOST='0.0.0.0';
const log=(...a)=>console.log(new Date().toISOString(),...a);

const firebaseConfig={
  apiKey:"AIzaSyAxHXvESxlx4dZHeMqREnzhURxQ2cginIU",
  authDomain:"wanzhi-f1aa8.firebaseapp.com",
  projectId:"wanzhi-f1aa8",
  storageBucket:"wanzhi-f1aa8.firebasestorage.app",
  messagingSenderId:"413457827254",
  appId:"1:413457827254:web:fd8222de89ba8bbf34ed17"
};

let db={version:1,accounts:{},chars:{},auction:[],sessions:{},soldDrops:{},mail:{},hist:{}};
let firestore=null, dirty=false;

async function initFB(){
  try{
    const {initializeApp}=require('firebase/app');
    const {getFirestore,doc,getDoc,setDoc}=require('firebase/firestore');
    initializeApp(firebaseConfig);
    firestore=getFirestore();
    const snap=await getDoc(doc(firestore,'gamedata','main'));
    if(snap.exists()&&snap.data().db){
      db=Object.assign(db, snap.data().db);
      log('Firebase loaded, accounts:', Object.keys(db.accounts||{}).length);
    }
  }catch(e){log('FB init fail',e.message);}
}
async function saveFB(){
  if(!firestore) return;
  try{
    const {doc,setDoc}=require('firebase/firestore');
    await setDoc(doc(firestore,'gamedata','main'),{db,t:Date.now()});
    dirty=false;
  }catch(e){}
}
initFB();
setInterval(()=>{if(dirty)saveFB();},10000);

function hash(s){return crypto.createHash('sha256').update(s).digest('hex');}
function token(){return crypto.randomBytes(16).toString('hex');}

const MIME={'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.css':'text/css','.png':'image/png'};

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  const p=url.pathname;
  
  // API
  if(p.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    let body='';
    for await(const c of req) body+=c;
    let data={}; try{data=JSON.parse(body||'{}');}catch(e){}
    
    if(p==='/api/register'&&req.method==='POST'){
      const {acc,pw}=data;
      if(!acc||!pw) return res.end(JSON.stringify({ok:0,msg:'缺少帳密'}));
      if(db.accounts[acc]) return res.end(JSON.stringify({ok:0,msg:'帳號已存在'}));
      db.accounts[acc]={pw:hash(pw),created:Date.now()};
      dirty=true;
      return res.end(JSON.stringify({ok:1}));
    }
    if(p==='/api/login'&&req.method==='POST'){
      const {acc,pw}=data;
      const a=db.accounts[acc];
      if(!a||a.pw!==hash(pw)) return res.end(JSON.stringify({ok:0,msg:'帳密錯誤'}));
      const t=token();
      db.sessions[t]={acc,exp:Date.now()+86400000*7};
      dirty=true;
      return res.end(JSON.stringify({ok:1,token:t}));
    }
    if(p==='/api/chars'&&req.method==='GET'){
      const t=url.searchParams.get('token');
      const s=db.sessions[t];
      if(!s) return res.end(JSON.stringify({ok:0}));
      const list=Object.entries(db.chars||{}).filter(([k,v])=>v.account===s.acc).map(([k,v])=>({id:k,...v}));
      return res.end(JSON.stringify({ok:1,chars:list}));
    }
    return res.end(JSON.stringify({ok:0,msg:'unknown'}));
  }
  
  // Static
  let fp=p==='/'?'/index.html':p;
  const full=path.join(__dirname,fp);
  if(fs.existsSync(full)&&fs.statSync(full).isFile()){
    res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'text/plain'});
    fs.createReadStream(full).pipe(res);
  }else{
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(PORT,HOST,()=>log('Server on',PORT));
