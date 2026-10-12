const http=require('http'), fs=require('fs'), path=require('path');
const PORT=process.env.PORT||3000;
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
    log('Firebase connecting...');
    const snap=await getDoc(doc(firestore,'gamedata','main'));
    if(snap.exists()){
      const data=snap.data();
      if(data&&data.db){
        db=Object.assign(db, data.db);
        log('Loaded from Firebase, accounts:', Object.keys(db.accounts||{}).length);
      }
    } else {
      log('No data in Firebase yet');
    }
  }catch(e){ log('Firebase error:', e.message); }
}

async function saveFB(){
  if(!firestore||!dirty) return;
  try{
    const {doc,setDoc}=require('firebase/firestore');
    await setDoc(doc(firestore,'gamedata','main'),{db, updated:new Date().toISOString()});
    dirty=false;
    log('Saved to Firebase');
  }catch(e){ log('Save error:', e.message); }
}

initFB();
setInterval(()=>{ if(dirty) saveFB(); }, 15000);

const MIME={'.html':'text/html;charset=utf-8','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'};

const server=http.createServer((req,res)=>{
  let urlPath=req.url.split('?')[0];
  if(urlPath==='/') urlPath='/index.html';
  const filePath=path.join(__dirname, urlPath);
  
  if(fs.existsSync(filePath) && fs.statSync(filePath).isFile()){
    const ext=path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext]||'application/octet-stream'});
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, {'Content-Type':'text/plain'});
    res.end('Not found');
  }
});

server.listen(PORT, ()=>log('Server started on port', PORT));
