const http=require('http'), fs=require('fs'), path=require('path');
const PORT=process.env.PORT||3000;
const log=(...a)=>console.log(new Date().toISOString(),...a);

// Firebase
const firebaseConfig={
  apiKey:"AIzaSyAxHXvESxlx4dZHeMqREnzhURxQ2cginIU",
  authDomain:"wanzhi-f1aa8.firebaseapp.com",
  projectId:"wanzhi-f1aa8",
  storageBucket:"wanzhi-f1aa8.firebasestorage.app",
  messagingSenderId:"413457827254",
  appId:"1:413457827254:web:fd8222de89ba8bbf34ed17"
};
let db={version:1,accounts:{},chars:{}};
let firestore=null;

async function initFB(){
  try{
    const {initializeApp}=require('firebase/app');
    const {getFirestore,doc,getDoc,setDoc}=require('firebase/firestore');
    initializeApp(firebaseConfig);
    firestore=getFirestore();
    const snap=await getDoc(doc(firestore,'gamedata','main'));
    if(snap.exists()&&snap.data().db) db=Object.assign(db,snap.data().db);
    log('Firebase OK, accounts:',Object.keys(db.accounts).length);
  }catch(e){log('Firebase fail',e.message);}
}
async function saveFB(){
  if(!firestore) return;
  try{
    const {doc,setDoc}=require('firebase/firestore');
    await setDoc(doc(firestore,'gamedata','main'),{db,t:new Date().toISOString()});
  }catch(e){}
}
initFB();
setInterval(saveFB,30000);

const server=http.createServer((req,res)=>{
  let p=req.url.split('?')[0];
  if(p==='/') p='/index.html';
  const fp=path.join(__dirname,p);
  if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){
    const ext=path.extname(fp);
    const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css'}[ext]||'text/plain';
    res.writeHead(200,{'Content-Type':mime});
    fs.createReadStream(fp).pipe(res);
  }else{
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(PORT,()=>log('Server on',PORT));
