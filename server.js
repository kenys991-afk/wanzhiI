'use strict';
// 萬王之王 Online — 遊戲伺服器（靜態檔 + WebSocket）
// 資料：server/data/db.json（原子寫入：先寫 .tmp 再 rename；每次寫入前保留 .bak）
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const { WebSocketServer }=require('ws');

const PORT=+process.env.PORT||8770, HOST=process.env.HOST||'0.0.0.0';
const GAME_DIR=(()=>{
  const fs=require('fs'), path=require('path');
  const candidates=[__dirname, path.resolve(__dirname,'..'), process.cwd(), '/opt/render/project', '/opt/render/project/src'];
  for(const c of candidates){
    try{ if(fs.existsSync(path.join(c,'index.html'))) return c; }catch(e){}
  }
  return __dirname;
})(), DATA_DIR=process.env.WZW_DATA||path.join(__dirname,'data'), DB_FILE=path.join(DATA_DIR,'db.json');
// 注意：Render 免費方案重新部署會清空本地檔案，帳號會消失。
// 若要持久化，請設定環境變數 WZW_DATA 指向持久磁碟，或使用外部資料庫。
const TILE=40, EXP_POOL_CAP=1e9, GOLD_CAP=1e9, LV_MAX=99;
const MAX_SPEED=0.65 /*px/ms：最快衝刺＋增益約 0.5*/, MOVE_BUCKET=700 /*瞬步技能緩衝*/;
const GM_ACCOUNTS=['kokbot'], RESERVED=['kokbot','gm','admin','root','system','gamemaster'];
const NAME_RE=/^[A-Za-z0-9_\u4e00-\u9fff]{2,16}$/;
const CONTS={scambray:{reqLv:1},redrock:{reqLv:40},frozen:{reqLv:70}};
const HUBS=[['scambray',8,8],['scambray',36,8],['scambray',8,-30],['redrock',8,8],['frozen',8,8]];
const log=(...a)=>console.log(new Date().toISOString(),...a);

// ===== Firebase Firestore 儲存 =====
const firebaseConfig = {
  apiKey: "AIzaSyAxHXvESxlx4dZHeMqREnzhURxQ2cginIU",
  authDomain: "wanzhi-f1aa8.firebaseapp.com",
  projectId: "wanzhi-f1aa8",
  storageBucket: "wanzhi-f1aa8.firebasestorage.app",
  messagingSenderId: "413457827254",
  appId: "1:413457827254:web:fd8222de89ba8bbf34ed17"
};
let firebaseApp = null, firestore = null;
async function initFirebase(){
  try{
    const { initializeApp } = require('firebase/app');
    const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
    firebaseApp = initializeApp(firebaseConfig);
    firestore = getFirestore(firebaseApp);
    log('Firebase 已連線');
    // 載入資料
    const snap = await getDoc(doc(firestore, 'gamedata', 'main'));
    if(snap.exists()){
      const data = snap.data();
      if(data && data.db){ db = Object.assign(db, data.db); log('已從 Firebase 載入帳號', Object.keys(db.accounts||{}).length); }
    }
    return true;
  }catch(e){ log('Firebase 連線失敗', e.message); return false; }
}
async function saveFirebase(){
  if(!firestore) return;
  try{
    const { doc, setDoc } = require('firebase/firestore');
    await setDoc(doc(firestore, 'gamedata', 'main'), { db, updated: new Date().toISOString() });
  }catch(e){ log('Firebase 儲存失敗', e.message); }
}
initFirebase();
setInterval(()=>{ if(dirty) saveFirebase(); }, 20000);


// ===== 外部資料庫（MongoDB Atlas） =====
let mongoClient = null, mongoDb = null;
async function initExternalDB(){
  const uri = process.env.MONGODB_URI;
  if(!uri){ log('未設定 MONGODB_URI，使用本地檔案'); return false; }
  try{
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    mongoDb = mongoClient.db('wanzhi');
    log('外部資料庫已連線');
    // 載入資料
    const doc = await mongoDb.collection('gamedata').findOne({_id:'main'});
    if(doc && doc.data){ db = Object.assign(db, doc.data); log('已從外部資料庫載入帳號', Object.keys(db.accounts||{}).length); }
    return true;
  }catch(e){ log('外部資料庫連線失敗', e.message); return false; }
}
async function saveExternalDB(){
  if(!mongoDb) return;
  try{
    await mongoDb.collection('gamedata').updateOne(
      {_id:'main'},
      {$set:{data:db, updated:new Date()}},
      {upsert:true}
    );
  }catch(e){ log('外部儲存失敗', e.message); }
}
// 啟動時初始化
initExternalDB();
// 每 30 秒同步到外部
setInterval(()=>{ if(dirty) saveExternalDB(); }, 30000);


// ---------- 資料庫（JSON） ----------
fs.mkdirSync(DATA_DIR,{recursive:true});
let db={version:1,accounts:{},chars:{},auction:[],sessions:{},soldDrops:{},mail:{},hist:{}};
try{ 
  if(fs.existsSync(DB_FILE)){
    const raw = fs.readFileSync(DB_FILE,'utf8');
    if(raw && raw.trim()) db=Object.assign(db,JSON.parse(raw));
  }
}catch(e){ 
  log('DB 讀取失敗，使用空白資料',e.message); 
  try{ 
    if(fs.existsSync(DB_FILE+'.bak')){
      const bak = fs.readFileSync(DB_FILE+'.bak','utf8');
      if(bak && bak.trim()) db=Object.assign(db,JSON.parse(bak));
    }
  }catch(e2){ log('BAK 也失敗，使用空白資料'); }
}
let dirty=false, writing=false;
function markDirty(){ dirty=true; }
function flush(){
  if(!dirty||writing) return; writing=true; dirty=false;
  try{
    const tmp=DB_FILE+'.tmp', s=JSON.stringify(db);
    fs.writeFileSync(tmp,s); try{ if(fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE,DB_FILE+'.bak'); }catch(e){}
    fs.renameSync(tmp,DB_FILE);
  }catch(e){ log('DB 寫入失敗',e.message); dirty=true; }
  writing=false;
}
setInterval(flush,1000);
// ---------- 自動備份：每 10 分鐘一份（data/autobak/，時間戳，保留 24 小時；部署前手動備份在 data/ 不受影響） ----------
const AUTOBAK_DIR=path.join(DATA_DIR,'autobak'), AUTOBAK_MS=+process.env.WZW_AUTOBAK_MS||600000, AUTOBAK_KEEP=24*3600e3;
function autoBackup(){
  try{
    fs.mkdirSync(AUTOBAK_DIR,{recursive:true});
    const d=new Date(Date.now()+8*3600e3), ts=d.toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15); // 台北時間 YYYYMMDD-HHMMSS
    const f=path.join(AUTOBAK_DIR,`db-${ts}.json`), tmp=f+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(db)); fs.renameSync(tmp,f); // 原子寫入
    let pruned=0; for(const n of fs.readdirSync(AUTOBAK_DIR)){ if(!/^db-\d{8}-\d{6}\.json(\.tmp)?$/.test(n)) continue; const fp=path.join(AUTOBAK_DIR,n); try{ if(Date.now()-fs.statSync(fp).mtimeMs>AUTOBAK_KEEP){ fs.unlinkSync(fp); pruned++; } }catch(e){} }
    log('自動備份',path.basename(f),pruned?`（清除 ${pruned} 份超過 24 小時）`:'');
  }catch(e){ log('自動備份失敗',e.message); }
}
setTimeout(autoBackup,60000); setInterval(autoBackup,AUTOBAK_MS);
function shutdown(){ log('關閉中，寫入資料…'); for(const c of clients) if(c.char) persistPos(c); flush(); process.exit(0); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);

// ---------- 帳號 ----------
function findAcct(name){ const low=String(name||'').toLowerCase(); return Object.keys(db.accounts).find(k=>k.toLowerCase()===low)||null; }
function hashPw(pw,salt){ return crypto.scryptSync(String(pw),salt,32,{N:16384,r:8,p:1}).toString('hex'); }
function checkPw(A,pw){ const h=Buffer.from(hashPw(pw,A.salt),'hex'), want=Buffer.from(A.hash,'hex'); return h.length===want.length&&crypto.timingSafeEqual(h,want); }
function isGM(name){ return !!(name&&GM_ACCOUNTS.includes(name.toLowerCase())&&db.accounts[name]&&db.accounts[name].isGM===true); }
function newToken(){ return crypto.randomBytes(24).toString('hex'); }
function acctChars(name){ const out=[null,null,null]; for(const id in db.chars){ const c=db.chars[id]; if(c.account===name&&c.slot>=0&&c.slot<3) out[c.slot]=c; } return out; }

// 首次啟動：建立 GM 帳號 kokbot ＋ 角色 kok（胡尼史），密碼讀 ../bot_account.txt
function seedGM(){
  if(findAcct('kokbot')) { const n=findAcct('kokbot'); if(!db.accounts[n].isGM){ db.accounts[n].isGM=true; markDirty(); } return; }
  let pw=null; try{ const m=fs.readFileSync(path.join(GAME_DIR,'bot_account.txt'),'utf8').match(/密碼：(\S+)/); if(m) pw=m[1]; }catch(e){}
  if(!pw){ log('⚠️ 找不到 bot_account.txt 的密碼，未建立 kokbot'); return; }
  const salt=crypto.randomBytes(16).toString('hex');
  db.accounts.kokbot={salt,hash:hashPw(pw,salt),isGM:true,created:Date.now(),imported:false};
  let tpl=null; try{ const s=fs.readFileSync(path.join(GAME_DIR,'make_bot_account.html'),'utf8'); const m=s.match(/const TEMPLATE=(\{.*\}); \/\//); if(m) tpl=JSON.parse(m[1]); }catch(e){}
  if(tpl&&!db.chars.kok){
    Object.assign(tpl,{id:'kok',name:'胡尼史',level:1,exp:0,job:'novice',cls:'novice',tutorialDone:false,jobTier:0,continent:'scambray',intendedPath:['magician','priest'],bot:{on:false}});
    db.chars.kok={id:'kok',account:'kokbot',slot:0,data:tpl,pending:[],updated:Date.now()};
  }
  markDirty(); log('已建立 GM 帳號 kokbot 與角色 kok／胡尼史');
}
seedGM();

// ---------- 存檔驗證 ----------
function clampInt(v,lo,hi,d){ v=Math.floor(+v); if(!isFinite(v)) return d; return Math.max(lo,Math.min(hi,v)); }
function invAdd(inv,id,q){ const s=inv.find(i=>i&&i.id===id); if(s){ s.qty=(s.qty|0)+q; return true; } if(inv.length<20){ inv.push({id,qty:q}); return true; } return false; }
function invRemove(inv,id,q){ const i=inv.findIndex(x=>x&&x.id===id&&(x.qty|0)>=q); if(i<0) return false; inv[i].qty-=q; if(inv[i].qty<=0) inv.splice(i,1); return true; }
function applyEntry(d,e){ // 伺服器端帳本：金幣／道具／EXP／擊殺／死亡
  if(e.gold) d.gold=clampInt((d.gold|0)+e.gold,0,GOLD_CAP,0);
  if(e.goldHalf) d.gold=Math.floor((d.gold|0)/2);
  if(e.exp) d.exp=clampInt((d.exp|0)+e.exp,0,EXP_POOL_CAP,0);
  if(e.kill){ d.kills=(d.kills|0)+1; if(d.quest&&d.quest.status==='active'){ d.quest.kills=(d.quest.kills|0)+1; if(d.quest.kills>=5) d.quest.status='ready'; } }
  if(Array.isArray(e.unequip)&&d.equip) e.unequip.forEach((slot,i)=>{ if(d.equip[slot]&&(!e.items||d.equip[slot]===e.items[i])) d.equip[slot]=null; });
  if(Array.isArray(e.removes)) for(const r of e.removes) if(r&&r.id) invRemove(d.inv,String(r.id),r.qty|0||1);
  if(e.add) invAdd(d.inv,e.add,e.qty||1);
  if(e.remove) invRemove(d.inv,e.remove,e.qty||1);
  if(Array.isArray(e.adds)) for(const a of e.adds) if(a&&a.id) invAdd(d.inv,String(a.id),a.qty|0||1);
}

/** 六屬性與轉職：與用戶端同一套規則（一次 +1、經驗條須先滿、轉職門檻）。GM 不夾。 */
function sanitizeProgress(d, old, gm){
  const vm=require('vm');
  const ctx=G.scambray;
  if(!ctx) return d;
  ctx.__np=d; ctx.__op=old||null; ctx.__gm=!!gm;
  try{
    vm.runInContext(`(function(){
      if(__gm){ ensureAttr(__np); if(JOBS[__np.job]) applyJobFields(__np); return; }
      clampAttrSave(__np, __op);
      if(__op && __op.job && __np.job!==__op.job && !jobChangeLegal(__op.job, __np.job, __np)) __np.job=__op.job;
      if(!JOBS[__np.job]){ if(__op && JOBS[__op.job]) __np.job=__op.job; else __np.job='novice'; }
      applyJobFields(__np);
    })()`, ctx, {timeout:500});
  }catch(e){ log('進度驗證失敗', e&&e.message); }
  delete ctx.__np; delete ctx.__op; delete ctx.__gm;
  return d;
}
/** 用戶端存檔 → 驗證後寫入。回傳 {ok,err} */
function acceptSave(c,player,acks){
  const ch=db.chars[c.char]; if(!ch) return {ok:false,err:'角色不存在'};
  if(!player||typeof player!=='object') return {ok:false,err:'存檔格式錯誤'};
  const raw=JSON.stringify(player); if(raw.length>400000) return {ok:false,err:'存檔過大'};
  const d=JSON.parse(raw), old=ch.data||{};
  d.id=ch.id; // ID 永久不變
  d.name=String(d.name||old.name||ch.id).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,12)||ch.id;
  if(!Array.isArray(d.inv)) d.inv=[]; d.inv=d.inv.filter(i=>i&&typeof i.id==='string'&&(i.qty|0)>0).slice(0,20);
  const gm=isGM(c.account);
  d.level=clampInt(d.level,1,LV_MAX,1);
  if(!gm&&d.level>(old.level|0||1)+10){ log('⚠️ 等級跳太多，退回',c.account,ch.id,old.level,'→',d.level); d.level=old.level|0||1; }
  d.exp=clampInt(d.exp,0,EXP_POOL_CAP,0);
  d.gold=clampInt(d.gold,0,GOLD_CAP,0);
  if(!gm&&(d.gold-(old.gold|0))>200000){ log('⚠️ 金幣增加異常，退回',c.account,ch.id,old.gold,'→',d.gold); d.gold=old.gold|0; }
  sanitizeProgress(d, old, gm);
  if(d.autoPot!=null){ const a=d.autoPot&&typeof d.autoPot==='object'?d.autoPot:{}, it=(v,re)=>typeof v==='string'&&re.test(v)?v:'best'; d.autoPot={on:a.on?1:0,hp:clampInt(a.hp,0,95,50),mp:clampInt(a.mp,0,95,30),hpItem:it(a.hpItem,/^(hp_potion(_m|_l)?|elixir)$/),mpItem:it(a.mpItem,/^(mp_potion(_m|_l)?|elixir)$/)}; } // 💊 自動喝水設定
  if(d.autoMac!=null){ const L=Array.isArray(d.autoMac)?d.autoMac:[], IV=[0,0.5,1,2,3,5]; d.autoMac=[0,1,2].map(i=>{ const a=L[i]&&typeof L[i]==='object'?L[i]:{}; return {m:clampInt(a.m,-1,7,-1),iv:IV.includes(+a.iv)?+a.iv:0.5,cb:a.cb===0?0:1}; }); } // 自動巨集格
  angelCheck(c,d,old,gm);
  // 帳本：用戶端尚未確認（ack）的伺服器變動要補上
  const ack=new Set(Array.isArray(acks)?acks.map(String):[]);
  const keep=[]; for(const e of (ch.pending||[])){ if(ack.has(e.id)) continue; applyEntry(d,e); keep.push(e); }
  ch.pending=keep;
  // 位置以伺服器為準
  if(c.pos){ d.x=c.pos.x; d.y=c.pos.y; d.continent=c.pos.c; }
  ch.data=d; ch.updated=Date.now(); markDirty(); c.capT=0;
  return {ok:true};
}
/** 天使雕像：轉職與「學會」職業技能必須站在對應雕像旁（城市＝一／二轉；國家＝三轉）；轉職成功全服公告 */
function angelCheck(c,d,old,gm){
  if(gm||!c||!c.pos) return; const X=G[c.pos.c]||G.scambray, J=G.scambray.JOBS;
  const at=tier=>X.ALL_NPCS.find(n=>n.role==='angel'&&(n.cont||'scambray')===c.pos.c&&(n.maxTier||2)>=tier&&Math.hypot(n.x-c.pos.x,n.y-c.pos.y)<300);
  if(old&&old.job&&d.job!==old.job){ const t=J[d.job]?J[d.job].tier|0:9, a=at(t);
    if(!a){ log('⛔ 不在天使雕像旁的轉職，退回',c.account,c.char,old.job,'→',d.job); d.job=old.job; try{ X.applyJobFields(d); }catch(e){} }
    else { const text=`✨ ${d.name} 在「${a.name}」前完成${['','一轉','二轉','三轉'][t]||'轉職'}，成為「${J[d.job].name}」！`; log('👼 轉職',c.char,old.job,'→',d.job);
      const out={t:'chat',ch:'g',cont:c.pos.c,from:'👼 天使雕像',gm:false,sys:1,text,ts:Date.now()}; for(const o of clients) if(o.char) send(o,out); } }
  const os=(old&&old.skills)||{}; if(d.skills&&typeof d.skills==='object') for(const k of Object.keys(d.skills)){
    if((d.skills[k]|0)<=0||(os[k]|0)>0) continue; let def=null; try{ def=X.skillDef(k); }catch(e){}
    if(def&&def.job&&!at(J[def.job]?J[def.job].tier|0:3)){ log('⛔ 不在天使雕像旁學會職業技能，退回',c.char,k); d.skills[k]=0; } }
}
function pushEntry(charId,e){ // 對角色加一筆帳本；在線就推給用戶端，離線直接寫入存檔
  const ch=db.chars[charId]; if(!ch) return;
  e.id=e.id||('L'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'));
  const c=[...clients].find(x=>x.char===charId);
  if(c){ ch.pending=ch.pending||[]; ch.pending.push(e); applyEntry(ch.data,e); send(c,{t:'ledger',e}); }
  else applyEntry(ch.data,e);
  markDirty(); return e;
}

// ---------- 交易所 ----------
function aucPublic(){ return db.auction.map(a=>({id:a.id,itemId:a.itemId,qty:a.qty||1,price:a.price,seller:a.sellerName||'',sellerId:a.seller||'',fromDeath:!!a.fromDeath,dropId:a.dropId||null,t:a.t,exp:a.exp||0})); }
function aucBroadcast(){ const m={t:'auc',list:aucPublic()}; for(const c of clients) if(c.char) send(c,m); }
setInterval(()=>{ const now=Date.now(), n=db.auction.length;
  db.auction=db.auction.filter(a=>{ if(a.fromDeath) return now-a.t<24*3600e3;
    if(a.exp&&now>a.exp){ mailAdd(a.seller,{itemId:a.itemId,qty:a.qty||1,msg:'上架到期，物品退回'}); histAdd(a.seller,{k:'expired',itemId:a.itemId,qty:a.qty||1,price:a.price}); return false; } return true; });
  if(db.auction.length!==n){ markDirty(); aucBroadcast(); } },60000);
// ---------- 交易平台：信箱（售出金幣／到期退回）與紀錄 ----------
const MKT_TAX=0.05, MKT_DUR=[6,12,24,48];
function mailAdd(charId,o){ if(!db.chars[charId]) return; db.mail=db.mail||{}; const L=db.mail[charId]=db.mail[charId]||[];
  L.push(Object.assign({id:'M'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),t:Date.now()},o)); while(L.length>60) L.shift(); markDirty();
  const c=[...clients].find(x=>x.char===charId); if(c) send(c,{t:'mail',n:L.length,msg:o.msg||''}); }
function histAdd(charId,o){ if(!db.chars[charId]) return; db.hist=db.hist||{}; const L=db.hist[charId]=db.hist[charId]||[]; L.push(Object.assign({t:Date.now()},o)); while(L.length>50) L.shift(); markDirty(); }
function GX(c){ return G[(c&&c.pos&&c.pos.c)||'scambray']||G.scambray; }
function itemOf(id){ return G.scambray.ITEMS[id]; }
function npcNear(c,id,pred){ const X=GX(c), n=X.ALL_NPCS.find(n=>n.id===id&&(n.cont||'scambray')===c.pos.c); if(!n||(pred&&!pred(n))) return {err:'找不到這位 NPC'};
  if(Math.hypot(n.x-c.pos.x,n.y-c.pos.y)>260) return {err:'離 NPC 太遠，走近一點'}; return {n}; }
/** 計算一組增減後的背包格數是否 ≤ 20（不修改原背包） */
function invFits(inv,removes,adds){ const m=new Map(); for(const i of inv) m.set(i.id,(m.get(i.id)||0)+(i.qty|0));
  for(const r of removes||[]){ const v=(m.get(r.id)||0)-r.qty; if(v<0) return false; if(v===0) m.delete(r.id); else m.set(r.id,v); }
  for(const a of adds||[]) m.set(a.id,(m.get(a.id)||0)+a.qty); return m.size<=20; }
function ownQty(inv,id){ return inv.filter(i=>i.id===id).reduce((s,i)=>s+(i.qty|0),0); }
/** 整理客戶端送來的物品清單 → [{id,qty}]（合併同 id；qty 夾 1..999） */
function cleanList(L,max){ const m=new Map(); for(const x of (Array.isArray(L)?L:[]).slice(0,max||30)){ if(!x) continue; const id=String(x.id||''); if(!id||!itemOf(id)||id==='herb') continue; m.set(id,(m.get(id)||0)+clampInt(x.qty,1,999,1)); } return [...m].map(([id,qty])=>({id,qty})); }
// ---------- 玩家對玩家交易（伺服器原子交換） ----------
const trades=new Map(); let tradeSeq=1;
function tradeOf(c){ return c&&c.trade?trades.get(c.trade):null; }
function tradeSide(T,c){ return T.a===c?'a':'b'; }
function tradeSend(T,warn){ for(const k of ['a','b']){ const me=T[k], o=k==='a'?'b':'a', them=T[o]; if(!me) continue;
  send(me,{t:'trade',st:{id:T.id,me:T.o[k],them:Object.assign({name:them&&db.chars[them.char]?db.chars[them.char].data.name:'?'},T.o[o]),warn:warn&&warn!==k?warn:null,chg:T.chg}}); } }
function tradeEnd(T,msg,ok){ if(!T||!trades.has(T.id)) return; trades.delete(T.id); for(const k of ['a','b']){ const c=T[k]; if(c){ c.trade=null; send(c,{t:'trade_end',ok:!!ok,msg}); } } }
setInterval(()=>{ for(const T of trades.values()){ const A=T.a, B=T.b; if(!A.char||!B.char||!A.pos||!B.pos||A.pos.c!==B.pos.c||Math.hypot(A.pos.x-B.pos.x,A.pos.y-B.pos.y)>420) tradeEnd(T,'距離太遠或對方離線，交易已取消'); else if(Date.now()-T.t0>10*60e3) tradeEnd(T,'交易逾時取消'); } },1000);

// ---------- 連線 ----------
const clients=new Set(); let sidSeq=1;
// ---------- Phase 2：伺服器權威魔物 ----------
const { loadGameLogic }=require('./gamelogic'), { createWorld }=require('./world');
const G=(()=>{ const t=Date.now(); const g=loadGameLogic(path.join(GAME_DIR,'index.html')); log('遊戲邏輯載入',g.stmtCount,'段，',Date.now()-t,'ms'); return g; })();
const world=createWorld(G,{db,log,pushEntry:(...a)=>pushEntry(...a),send:(...a)=>send(...a),clients,isGM,partyOf:(ch)=>partyOfChar(ch),
  aucAddDeath:(ch,itemId,price,dropId)=>{ db.auction.push({id:'D'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),itemId,price,seller:ch.id,sellerName:ch.data.name,fromDeath:true,dropId,t:Date.now()});
    while(db.auction.filter(a=>a.fromDeath).length>100){ const j=db.auction.findIndex(a=>a.fromDeath); world.removeItem(db.auction[j].dropId); db.auction.splice(j,1); } markDirty(); aucBroadcast(); },
  aucRemoveDrop:(dropId)=>{ const i=db.auction.findIndex(a=>a.fromDeath&&a.dropId===dropId); if(i>=0){ db.auction.splice(i,1); markDirty(); aucBroadcast(); } }});
setInterval(()=>world.tick(),50);
function send(c,m){ try{ if(c.ws.readyState===1) c.ws.send(JSON.stringify(m)); }catch(e){} }
function reply(c,rid,o){ send(c,Object.assign({t:'res',rid},o)); }
function authPayload(c){ const slots=acctChars(c.account).map(ch=>ch?{player:ch.data,auction:[],groundLoot:[],time:ch.updated}:null);
  return {ok:true,name:c.account,isGM:isGM(c.account),token:c.token,slots,imported:!!db.accounts[c.account].imported}; }
function login(c,name,token){ c.account=name; c.token=token||newToken(); db.sessions[c.token]={account:name,exp:Date.now()+7*24*3600e3}; markDirty(); }
const RECALL_CAST=3000, RECALL_CD=60000, RECALL_CD_MAP={};
function nearTeleport(cont,x,y){
  const pts=[[8,10],[13,9.6],...HUBS.filter(h=>h[0]===cont).map(h=>[h[1]+0.5,h[2]+2.5]),...((G[cont]&&typeof G[cont].caveDests==='function')?G[cont].caveDests(cont):[])]; // 洞窟傳送點目的地（各大陸）
  return pts.some(([tx,ty])=>Math.hypot(x-tx*TILE,y-ty*TILE)<2.5*TILE);
}
function persistPos(c){ const ch=db.chars[c.char]; if(ch&&c.pos){ ch.data.x=c.pos.x; ch.data.y=c.pos.y; ch.data.continent=c.pos.c; markDirty(); } }
function leaveGame(c){ if(!c.char) return; { const T=tradeOf(c); if(T) tradeEnd(T,'對方已離開，交易取消'); } try{ partyLeave(c.char,'離線，離開了隊伍'); }catch(e){} persistPos(c); log('離開',c.account,c.char); const cont=c.pos&&c.pos.c, sid=c.sid; c.char=null; c.pos=null;
  for(const o of clients) if(o!==c&&o.char&&o.pos&&o.pos.c===cont) send(o,{t:'gone',s:sid}); // 其他玩家畫面立刻移除
  broadcastOnline(); }
const ALLY_SKILLS={
  xw_rally:{k:'buff',b:{atk:0.12,def:0.05,dur:10},cd:30,icon:'🎺',name:'鼓舞號令'},
  xk_oath:{k:'shield',v:0.12,cd:25,icon:'🤝',name:'守護誓約'},
  xp_greater_heal:{k:'heal',v:0.2,cd:9,icon:'💖',name:'強效治療'},
  xp_blessing:{k:'buff',b:{atk:0.1,def:0.15,dur:15},cd:25,icon:'🙏',name:'神聖祝福'},
  xp_ward:{k:'shield',v:0.08,cd:24,icon:'🔆',name:'聖域結界'},
  xp_renew:{k:'hot',v:0.15,cd:12,icon:'🌿',name:'恢復術'},
  xp_resurrect:{k:'cleanse',v:0.1,cd:40,icon:'🕯️',name:'復活祈禱'},
  xp_mend:{k:'heal',v:0.25,cd:5,icon:'💚',name:'治癒之光',single:1},
  xp_heaven_judgement:{k:'heal',v:0.1,cd:20,icon:'⚜️',name:'天堂審判'},
};
// ===== 組隊（伺服器權威；最多 5 人；離線即離隊）=====
const PARTY_MAX=5, PARTY_R=600, parties=new Map(), charParty=new Map(); let partySeq=1;
function clientOfChar(ch){ for(const c of clients) if(c.char===ch) return c; return null; }
function partyOfChar(ch){ const P=parties.get(charParty.get(ch)); return P?P.members.slice():null; }
function partySys(P,text){ const o={t:'chat',ch:'p',from:'',sys:1,text,ts:Date.now()}; for(const ch of P.members){ const c=clientOfChar(ch); if(c) send(c,o); } }
function partySend(P){
  const mem=P.members.map(ch=>{ const c=clientOfChar(ch), d=db.chars[ch]&&db.chars[ch].data; if(!d) return null;
    return {ch,n:d.name,lv:d.level|0,job:(c&&c.look&&c.look.job)||d.job||'novice',on:c?1:0,s:c?c.sid:0,c:c&&c.pos?c.pos.c:null,x:c&&c.pos?Math.round(c.pos.x):0,y:c&&c.pos?Math.round(c.pos.y):0,
      hp:c?c.hp|0:0,mhp:c?c.mhp||1:1,mp:c?c.mp|0:0,mmp:c?c.mmp||1:1,bf:(c&&c.bf)||[]}; }).filter(Boolean);
  for(const ch of P.members){ const c=clientOfChar(ch); if(c) send(c,{t:'party',id:P.id,leader:P.leader,me:ch,max:PARTY_MAX,members:mem}); } }
function partyLeave(ch,why){ const pid=charParty.get(ch), P=parties.get(pid); if(!P) return; P.members=P.members.filter(x=>x!==ch); charParty.delete(ch);
  const c=clientOfChar(ch); if(c) send(c,{t:'party',id:0,members:[]});
  const nm=db.chars[ch]?db.chars[ch].data.name:'?';
  if(P.members.length<=1){ for(const m of P.members){ charParty.delete(m); const mc=clientOfChar(m); if(mc){ send(mc,{t:'party',id:0,members:[]}); send(mc,{t:'chat',ch:'p',from:'',sys:1,text:`👥 ${nm} ${why||'離開了隊伍'}，隊伍已解散`,ts:Date.now()}); } } parties.delete(pid); log('隊伍解散',pid); return; }
  if(P.leader===ch) P.leader=P.members[0];
  partySys(P,`👥 ${nm} ${why||'離開了隊伍'}`+(P.leader!==ch?'':'')); partySend(P); }
setInterval(()=>{ for(const P of parties.values()) partySend(P); },500);
function charSummary(c){ const d=db.chars[c.char].data; return {n:d.name,c:c.pos?c.pos.c:d.continent,lv:d.level|0,gm:isGM(c.account),acct:c.account}; }

function onMsg(c,m){
  const t=m.t, rid=m.rid;
  // ---- 未登入可用 ----
  if(t==='register'){
    const name=String(m.name||'').trim(), pw=String(m.pw||'');
    if(!NAME_RE.test(name)) return reply(c,rid,{ok:false,err:'帳號需 2–16 字（英數、底線或中文）'});
    if(RESERVED.includes(name.toLowerCase())) return reply(c,rid,{ok:false,err:`「${name}」是保留名稱，請換一個`});
    if(findAcct(name)) return reply(c,rid,{ok:false,err:`帳號「${name}」已存在`});
    if(pw.length<4||pw.length>64) return reply(c,rid,{ok:false,err:'密碼需 4–64 字'});
    const salt=crypto.randomBytes(16).toString('hex');
    db.accounts[name]={salt,hash:hashPw(pw,salt),isGM:false,created:Date.now(),imported:false}; // 註冊一律無特權
    login(c,name); log('註冊',name); return reply(c,rid,authPayload(c));
  }
  if(t==='login'){
    const name=findAcct(m.name); c.fails=(c.fails||0);
    if(c.fails>=8) return reply(c,rid,{ok:false,err:'嘗試太多次，請稍後再試'});
    if(!name||!checkPw(db.accounts[name],m.pw||'')){ c.fails++; return reply(c,rid,{ok:false,err:name?'❌ 密碼錯誤':`找不到帳號「${String(m.name||'')}」，可按「註冊新帳號」`}); }
    login(c,name); log('登入',name,isGM(name)?'(GM)':''); return reply(c,rid,authPayload(c));
  }
  if(t==='resume'){
    const s=db.sessions[m.token]; if(!s||s.exp<Date.now()||!db.accounts[s.account]) return reply(c,rid,{ok:false,err:'連線已過期，請重新登入'});
    login(c,s.account,m.token); return reply(c,rid,authPayload(c));
  }
  if(!c.account) return reply(c,rid,{ok:false,err:'尚未登入'});
  // ---- 已登入 ----
  if(t==='logout'){ if(m.player&&c.char) acceptSave(c,m.player,m.acks); leaveGame(c); delete db.sessions[c.token]; c.account=null; c.token=null; markDirty(); return reply(c,rid,{ok:true}); }
  if(t==='slots') return reply(c,rid,authPayload(c));
  if(t==='create'){
    const slot=m.slot|0, id=String(m.id||'').trim().replace(/\s+/g,' ').slice(0,12);
    if(slot<0||slot>2) return reply(c,rid,{ok:false,err:'欄位錯誤'});
    if(!id||/[<>\u0000-\u001f]/.test(id)) return reply(c,rid,{ok:false,err:'角色ID不合法'});
    if(acctChars(c.account)[slot]) return reply(c,rid,{ok:false,err:'此欄位已有角色'});
    if(db.chars[id]) return reply(c,rid,{ok:false,err:`❌ 角色ID「${id}」已被使用，請換一個`});
    db.chars[id]={id,account:c.account,slot,data:{id,name:id,level:1,gold:0,exp:0,inv:[]},pending:[],updated:Date.now(),fresh:true};
    markDirty(); log('建立角色',c.account,id); return reply(c,rid,{ok:true,id});
  }
  if(t==='delete'){
    const ch=acctChars(c.account)[m.slot|0]; if(!ch) return reply(c,rid,{ok:false,err:'沒有角色'});
    if(c.char===ch.id) return reply(c,rid,{ok:false,err:'遊戲中的角色不能刪除'});
    delete db.chars[ch.id]; markDirty(); log('刪除角色',c.account,ch.id); return reply(c,rid,authPayload(c));
  }
  if(t==='enter'){
    const ch=acctChars(c.account)[m.slot|0]; if(!ch) return reply(c,rid,{ok:false,err:'沒有角色'});
    for(const o of clients) if(o!==c&&o.char===ch.id){ send(o,{t:'kick',why:'此角色已在其他地方登入'}); leaveGame(o); }
    c.char=ch.id; c.sid=c.sid||sidSeq++; const d=ch.data; c.god=false; c.capT=0; c.hidden=false;
    c.pos={x:+d.x||8*TILE,y:+d.y||10*TILE,c:CONTS[d.continent]?d.continent:'scambray'}; c.bucket=MOVE_BUCKET; c.lastMv=Date.now(); c.firstMv=true;
    log('進入遊戲',c.account,ch.id,c.pos.c);
    // 帳本：一般進入 → 用戶端直接拿伺服器存檔（已含所有變動），清空待確認；斷線重連（resume）→ 保留本地狀態，重送未確認的
    const fresh=!!ch.fresh; ch.fresh=false;
    if(m.resume) for(const e of (ch.pending||[])) send(c,{t:'ledger',e}); else ch.pending=[];
    reply(c,rid,{ok:true,player:d,fresh,sid:c.sid,auction:aucPublic(),isGM:isGM(c.account)});
    broadcastOnline(); return;
  }
  if(t==='leave'){ if(m.player&&c.char) acceptSave(c,m.player,m.acks); leaveGame(c); return reply(c,rid,{ok:true}); }
  if(t==='import'){
    const A=db.accounts[c.account]; if(A.imported) return reply(c,rid,{ok:false,err:'這個帳號已經匯入過本機存檔（只能一次）'});
    const list=Array.isArray(m.chars)?m.chars.slice(0,9):[]; const done=[], skip=[];
    const slots=acctChars(c.account);
    for(const p of list){
      if(!p||typeof p!=='object') continue;
      const id=String(p.id||p.name||'').trim().slice(0,12);
      if(!id){ skip.push('（無ID）'); continue; }
      if(db.chars[id]){ skip.push(`${id}（ID 已存在）`); continue; }
      const free=slots.findIndex(s=>!s); if(free<0){ skip.push(`${id}（欄位已滿）`); continue; }
      const d=JSON.parse(JSON.stringify(p)); d.id=id;
      d.level=clampInt(d.level,1,LV_MAX,1); d.exp=clampInt(d.exp,0,EXP_POOL_CAP,0); d.gold=clampInt(d.gold,0,GOLD_CAP,0);
      if(!Array.isArray(d.inv)) d.inv=[]; d.inv=d.inv.slice(0,20);
      if(!CONTS[d.continent]) d.continent='scambray';
      if(d.bot) d.bot.on=false;
      db.chars[id]={id,account:c.account,slot:free,data:d,pending:[],updated:Date.now()}; slots[free]=db.chars[id]; done.push(id);
    }
    if(done.length){ A.imported=true; markDirty(); }
    log('匯入',c.account,done,skip); return reply(c,rid,Object.assign(authPayload(c),{done,skip}));
  }
  if(!c.char) return reply(c,rid,{ok:false,err:'尚未進入遊戲'});
  // ---- 遊戲中 ----
  if(t==='save'){ return reply(c,rid,acceptSave(c,m.player,m.acks)); }
  if(t==='mv'){ // 約 12Hz：位置（伺服器驗證速度／傳送點）
    const now=Date.now(); c.mvCount=(c.mvCount||0)+1;
    let x=+m.x, y=+m.y; const cont=CONTS[m.c]?m.c:c.pos.c;
    if(!isFinite(x)||!isFinite(y)) return;
    c.bucket=Math.min(MOVE_BUCKET,c.bucket+(now-c.lastMv)*MAX_SPEED); c.lastMv=now;
    const ch=db.chars[c.char], lv=ch.data.level|0;
    let ok=true;
    if(c.firstMv){ c.firstMv=false; }
    else if(c.allowTp&&c.allowTp.c===cont&&Math.hypot(x-c.allowTp.x,y-c.allowTp.y)<3*TILE){ c.allowTp=null; }
    else if(cont!==c.pos.c){ ok=(lv>=CONTS[cont].reqLv||isGM(c.account))&&nearTeleport(cont,x,y); }
    else { const d=Math.hypot(x-c.pos.x,y-c.pos.y); if(d<=c.bucket) c.bucket-=d; else if(nearTeleport(cont,x,y)) {} else ok=false; }
    if(ok&&cont===c.pos.c&&lv>10&&!isGM(c.account)&&G[cont]&&G[cont].inNewbieZone(x,y)&&!G[cont].inNewbieZone(c.pos.x,c.pos.y)) return send(c,{t:'pos',x:c.pos.x,y:c.pos.y,c:c.pos.c}); // 新手練功區：Lv.11 以上不能進入
    if(!ok){ c.strikes=(c.strikes||0)+1; if(c.strikes%10===1) log('⚠️ 移動被拒（速度／傳送）',c.account,c.char,c.strikes); return send(c,{t:'pos',x:c.pos.x,y:c.pos.y,c:c.pos.c}); }
    c.pos={x,y,c:cont}; c.f=m.f>0?1:-1; c.mv=!!m.m; c.hp=clampInt(m.hp,0,1e7,0); c.mhp=clampInt(m.mhp,1,1e7,1);
    c.bot=!!m.b; c.atk=m.a?now:c.atk; if(m.mp!=null){ c.mp=clampInt(m.mp,0,1e7,0); c.mmp=clampInt(m.mmp,1,1e7,1); } if(Array.isArray(m.bf)) c.bf=m.bf.slice(0,8).map(x=>String(x).slice(0,4)); c.hidden=!!m.h; if(m.as!=null) c.as=clampInt(m.as,0,999,0); if(m.cs!=null) c.cs=clampInt(m.cs,0,999,0); // 動畫序號（其他玩家看到攻擊／施法動作）
    if(m.vw) { c.vw=clampInt(m.vw,200,4000,1280); c.vh=clampInt(m.vh,200,3000,800); }
    if(m.z>0) c.zoom=Math.max(0.3,Math.min(3.5,+m.z)||1.3); // 用戶端鏡頭縮放（魔物「離開畫面就放棄」要用）
    if(m.look&&typeof m.look==='object') c.look={job:String(m.look.job||'novice').slice(0,24),eq:(Array.isArray(m.look.eq)?m.look.eq:[]).slice(0,4).map(v=>v?String(v).slice(0,40):null)};
    return;
  }
  if(t==='hits'){ world.onHits(c,m.h); return; } // 命中回報（伺服器驗證距離／上限／頻率）
  if(t==='pick'){ return reply(c,rid,world.onPick(c,m.id)); }
  if(t==='died'){ return reply(c,rid,world.onDied(c)); }
  if(t==='chat'){
    const now=Date.now(); c.chatT=(c.chatT||[]).filter(x=>now-x<10000);
    if(c.chatT.length>=5) return reply(c,rid,{ok:false,err:'說太快了，請稍等（10 秒最多 5 句）'});
    let text=String(m.text||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,100); if(!text) return reply(c,rid,{ok:false});
    c.chatT.push(now); const ch=m.ch==='c'?'c':m.ch==='p'?'p':'g', d=db.chars[c.char].data;
    const out={t:'chat',ch,cont:c.pos.c,from:d.name,gm:isGM(c.account),text,ts:now};
    if(ch==='p'){ const P=parties.get(charParty.get(c.char)); if(!P) return reply(c,rid,{ok:false,err:'你沒有隊伍（隊伍頻道）'}); for(const mc of P.members.map(clientOfChar)) if(mc) send(mc,out); log('聊天',ch,c.pos.c,d.name+':',text); return reply(c,rid,{ok:true}); }
    for(const o of clients) if(o.char&&(ch==='g'||(o.pos&&o.pos.c===c.pos.c))) send(o,out);
    log('聊天',ch,c.pos.c,d.name+':',text); return reply(c,rid,{ok:true});
  }
  if(t==='ally'){ // 二轉群體輔助：伺服器依技能表決定數值；檢查已學技能、冷卻、同大陸 220px
    const A=ALLY_SKILLS[String(m.id||'')]; if(!A||!c.char||!c.pos) return;
    const d=db.chars[c.char].data, lv=Math.min(5,(d.skills&&d.skills[m.id])|0); if(lv<=0) return;
    const now=Date.now(); c.allyCd=c.allyCd||{}; if(now-(c.allyCd[m.id]||0)<A.cd*1000*0.8) return; c.allyCd[m.id]=now;
    const f=1+0.05*(lv-1), out={t:'ally',k:A.k,from:d.name,icon:A.icon,name:A.name};
    if(A.b) out.b={atk:+(A.b.atk*f).toFixed(3),def:+(A.b.def*f).toFixed(3),dur:A.b.dur}; else out.v=+(A.v*f).toFixed(3);
    const P=parties.get(charParty.get(c.char)), mem=new Set(P?P.members:[]), got=[];
    const inR=(o,r)=>o.pos&&o.pos.c===c.pos.c&&Math.hypot(o.pos.x-c.pos.x,o.pos.y-c.pos.y)<=r;
    if(A.single){ // 單體：只對指定的隊友（600px 內）；沒指定 → 不送（施法者自己已在本地回復）
      const o=m.to?clientOfChar(String(m.to)):null; if(o&&o!==c&&mem.has(o.char)&&inR(o,PARTY_R)&&(o.hp|0)>0){ out.single=1; send(o,out); got.push(o.sid); } }
    else { for(const o of clients){ if(o===c||!o.char) continue; const pm=mem.has(o.char); if(!inR(o,pm?PARTY_R:220)) continue; out.pt=pm?1:0; send(o,Object.assign({},out)); got.push(o.sid); if(got.length>=8) break; } }
    if(got.length) send(c,{t:'ally_ack',id:m.id,icon:A.icon,name:A.name,k:A.k,to:got});
    if(P&&got.length) partySend(P);
    return;
  }
  if(t==='pt_inv'){ if(!c.char) return reply(c,rid,{ok:false});
    const o=[...clients].find(x=>x.sid===(m.to|0)&&x.char); if(!o||o===c) return reply(c,rid,{ok:false,err:'找不到這位玩家'});
    let P=parties.get(charParty.get(c.char)); if(P&&P.leader!==c.char) return reply(c,rid,{ok:false,err:'只有隊長可以邀請'});
    if(P&&P.members.length>=PARTY_MAX) return reply(c,rid,{ok:false,err:`隊伍已滿（${PARTY_MAX} 人）`});
    if(charParty.get(o.char)) return reply(c,rid,{ok:false,err:'對方已經有隊伍了'});
    const now=Date.now(); c.ptAsk=c.ptAsk||{}; if(c.ptAsk[o.sid]&&now-c.ptAsk[o.sid]<5000) return reply(c,rid,{ok:false,err:'請稍候再邀請'}); c.ptAsk[o.sid]=now;
    o.ptInv={from:c.sid,t:now}; const d=db.chars[c.char].data; send(o,{t:'pt_inv',from:c.sid,name:d.name,lv:d.level|0}); return reply(c,rid,{ok:true}); }
  if(t==='pt_ans'){ const inv=c.ptInv; c.ptInv=null; const o=[...clients].find(x=>x.sid===(m.from|0)&&x.char);
    if(!inv||inv.from!==(m.from|0)||Date.now()-inv.t>60000||!o) return reply(c,rid,{ok:false,err:'邀請已失效'});
    const me=db.chars[c.char].data.name;
    if(!m.ok){ send(o,{t:'chat',ch:'p',from:'',sys:1,text:`👥 ${me} 拒絕了組隊邀請`,ts:Date.now()}); return reply(c,rid,{ok:true}); }
    if(charParty.get(c.char)) return reply(c,rid,{ok:false,err:'你已經有隊伍了'});
    let P=parties.get(charParty.get(o.char));
    if(P&&P.leader!==o.char) return reply(c,rid,{ok:false,err:'邀請者已不是隊長'});
    if(!P){ P={id:partySeq++,leader:o.char,members:[o.char]}; parties.set(P.id,P); charParty.set(o.char,P.id); }
    if(P.members.length>=PARTY_MAX) return reply(c,rid,{ok:false,err:'隊伍已滿'});
    P.members.push(c.char); charParty.set(c.char,P.id); log('組隊',P.id,P.members.join(','));
    partySys(P,`👥 ${me} 加入了隊伍（${P.members.length}/${PARTY_MAX}）`); partySend(P); return reply(c,rid,{ok:true}); }
  if(t==='pt_leave'){ partyLeave(c.char,'離開了隊伍'); return reply(c,rid,{ok:true}); }
  if(t==='pt_kick'||t==='pt_lead'){ const P=parties.get(charParty.get(c.char)); if(!P||P.leader!==c.char) return reply(c,rid,{ok:false,err:'只有隊長可以這樣做'});
    const who=String(m.ch||''); if(!P.members.includes(who)||who===c.char) return reply(c,rid,{ok:false,err:'不是隊員'});
    if(t==='pt_kick'){ partyLeave(who,'被隊長請出隊伍'); } else { P.leader=who; partySys(P,`👑 ${db.chars[who].data.name} 成為新隊長`); partySend(P); }
    return reply(c,rid,{ok:true}); }
  if(t==='auc_list'){
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const ch=db.chars[c.char], itemId=String(m.itemId||''), price=clampInt(m.price,1,1e8,0), I=itemOf(itemId);
    if(!price) return reply(c,rid,{ok:false,err:'價格需 1–100,000,000'});
    if(!I||itemId==='herb') return reply(c,rid,{ok:false,err:'這個物品不能上架'});
    const qty=I.slot?1:clampInt(m.qty,1,999,1), dur=MKT_DUR.includes(+m.dur)?+m.dur:24;
    if(db.auction.filter(a=>a.seller===ch.id&&!a.fromDeath).length>=10) return reply(c,rid,{ok:false,err:'每個角色最多同時上架 10 件'});
    if(ownQty(ch.data.inv,itemId)<qty) return reply(c,rid,{ok:false,err:'背包裡沒有這麼多'});
    const e=pushEntry(ch.id,{remove:itemId,qty,why:'auc_list'});
    const a={id:'A'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),itemId,qty,price,seller:ch.id,sellerName:ch.data.name,t:Date.now(),exp:Date.now()+dur*3600e3};
    db.auction.push(a); if(db.auction.length>300) db.auction.shift(); markDirty();
    histAdd(ch.id,{k:'listed',itemId,qty,price});
    log('上架',ch.id,itemId,'x'+qty,price,dur+'h'); aucBroadcast(); return reply(c,rid,{ok:true,entry:e,listing:a.id});
  }
  if(t==='auc_buy'){
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const i=db.auction.findIndex(a=>a.id===m.id); if(i<0) return reply(c,rid,{ok:false,err:'這件商品已經賣出或下架了'});
    const a=db.auction[i], ch=db.chars[c.char];
    if(a.seller===ch.id&&!a.fromDeath) return reply(c,rid,{ok:false,err:'不能買自己上架的商品（可下架）'});
    if((ch.data.gold|0)<a.price) return reply(c,rid,{ok:false,err:'金幣不夠'});
    const inv=ch.data.inv; if(!inv.some(x=>x.id===a.itemId)&&inv.length>=20) return reply(c,rid,{ok:false,err:'背包滿了'});
    if(m.price!=null&&+m.price!==a.price) return reply(c,rid,{ok:false,err:'價格已變動，請重新確認'});
    db.auction.splice(i,1); // 先下架：避免兩人同時買到
    if(a.fromDeath&&a.dropId) world.removeItem(a.dropId); // 地上那件同步消失
    if(a.fromDeath&&a.dropId){ db.soldDrops[a.dropId]=Date.now(); const ks=Object.keys(db.soldDrops); if(ks.length>500) delete db.soldDrops[ks[0]]; }
    const e=pushEntry(ch.id,{gold:-a.price,add:a.itemId,qty:a.qty||1,why:'auc_buy'});
    histAdd(ch.id,{k:'bought',itemId:a.itemId,qty:a.qty||1,price:a.price,who:a.sellerName||''});
    if(!a.fromDeath&&db.chars[a.seller]){ const tax=Math.floor(a.price*MKT_TAX), I=itemOf(a.itemId);
      mailAdd(a.seller,{gold:a.price-tax,itemId:a.itemId,qty:a.qty||1,msg:`售出 ${I?I.name:a.itemId}${(a.qty||1)>1?'×'+a.qty:''}：${a.price}G（手續費 ${tax}G）`,buyer:ch.data.name});
      histAdd(a.seller,{k:'sold',itemId:a.itemId,qty:a.qty||1,price:a.price,tax,who:ch.data.name}); }
    markDirty(); log('購買',ch.id,a.itemId,a.price,'賣家',a.seller,a.fromDeath?'(死亡掉落)':''); aucBroadcast();
    return reply(c,rid,{ok:true,entry:e,dropId:a.dropId||null});
  }
  if(t==='auc_cancel'){
    const i=db.auction.findIndex(a=>a.id===m.id&&a.seller===c.char&&!a.fromDeath); if(i<0) return reply(c,rid,{ok:false,err:'找不到你的這筆上架'});
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const ch=db.chars[c.char]; const a=db.auction[i]; const inv=ch.data.inv;
    if(!inv.some(x=>x.id===a.itemId)&&inv.length>=20) return reply(c,rid,{ok:false,err:'背包滿了，無法取回'});
    db.auction.splice(i,1); const e=pushEntry(ch.id,{add:a.itemId,qty:a.qty||1,why:'auc_cancel'}); histAdd(ch.id,{k:'cancel',itemId:a.itemId,qty:a.qty||1,price:a.price}); markDirty(); aucBroadcast();
    return reply(c,rid,{ok:true,entry:e});
  }
  if(t==='mkt_me'){ return reply(c,rid,{ok:true,mail:(db.mail&&db.mail[c.char])||[],hist:((db.hist&&db.hist[c.char])||[]).slice(-50)}); }
  // ===== 回程術：吟唱 3 秒 → 本大陸主城（伺服器驗證冷卻、吟唱時間、沒有移動／受傷，並由伺服器設定位置）=====
  if(t==='recall_start'){ if(!c.char||!c.pos) return reply(c,rid,{ok:false,err:'未進入遊戲'}); const now=Date.now(); RECALL_CD_MAP[c.char]=RECALL_CD_MAP[c.char]||0;
    if(RECALL_CD_MAP[c.char]>now) return reply(c,rid,{ok:false,err:'回程術冷卻中',cd:RECALL_CD_MAP[c.char]-now});
    if((c.hp|0)<=0&&c.mhp) return reply(c,rid,{ok:false,err:'倒下時不能使用'}); if(tradeOf(c)) return reply(c,rid,{ok:false,err:'交易中不能使用'});
    c.recall={t:now,x:c.pos.x,y:c.pos.y,c:c.pos.c,hp:c.hp|0}; return reply(c,rid,{ok:true}); }
  if(t==='recall_cancel'){ c.recall=null; return reply(c,rid,{ok:true}); }
  if(t==='recall'){ const R=c.recall, now=Date.now(); c.recall=null;
    if(!c.char||!c.pos||!R) return reply(c,rid,{ok:false,err:'沒有在吟唱'});
    if(now-R.t<RECALL_CAST-300) return reply(c,rid,{ok:false,err:'吟唱時間不足'});
    if(R.c!==c.pos.c||Math.hypot(c.pos.x-R.x,c.pos.y-R.y)>24) return reply(c,rid,{ok:false,err:'吟唱中移動了'});
    if((c.hp|0)<R.hp) return reply(c,rid,{ok:false,err:'吟唱中受到傷害'});
    if(RECALL_CD_MAP[c.char]>now) return reply(c,rid,{ok:false,err:'回程術冷卻中'});
    const x=8.5*TILE, y=10.5*TILE; RECALL_CD_MAP[c.char]=now+RECALL_CD-500;
    c.pos={x,y,c:c.pos.c}; c.allowTp={x,y,c:c.pos.c}; c.bucket=0; persistPos(c); log('🏠 回程術',c.char,R.c);
    send(c,{t:'pos',x,y,c:c.pos.c}); return reply(c,rid,{ok:true,x,y}); }
  if(t==='mail_claim'){
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const ch=db.chars[c.char], L=(db.mail&&db.mail[c.char])||[]; let gold=0; const adds=[], left=[], took=[];
    for(const x of L){ if(m.id&&x.id!==m.id){ left.push(x); continue; }
      if(x.itemId&&!x.gold){ const add={id:x.itemId,qty:x.qty||1}; if(!invFits(ch.data.inv,[],adds.concat([add]))){ left.push(x); continue; } adds.push(add); }
      gold+=x.gold|0; took.push(x.id); }
    if(!took.length) return reply(c,rid,{ok:false,err:L.length?'背包滿了，物品領不出來':'信箱是空的'});
    db.mail[c.char]=left; markDirty();
    const e=pushEntry(ch.id,{gold,adds,why:'mail'}); log('領取信箱',ch.id,gold,JSON.stringify(adds));
    return reply(c,rid,{ok:true,entry:e,gold,adds,left:left.length});
  }
  if(t==='shop_buy'){
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const r=npcNear(c,String(m.npc||''),n=>!!n.shop&&n.shop!=='buyer'); if(r.err) return reply(c,rid,{ok:false,err:r.err});
    const X=GX(c), id=String(m.itemId||''), qty=clampInt(m.qty,1,99,1), I=X.ITEMS[id];
    if(!I||!X.shopHas(r.n.shop,id)) return reply(c,rid,{ok:false,err:'這位商人沒有賣這個'});
    const ch=db.chars[c.char], cost=((I.price|0)||10)*qty;
    if((ch.data.gold|0)<cost) return reply(c,rid,{ok:false,err:`金幣不夠（需要 ${cost}G）`});
    if(!invFits(ch.data.inv,[],[{id,qty}])) return reply(c,rid,{ok:false,err:'背包滿了'});
    const e=pushEntry(ch.id,{gold:-cost,add:id,qty,why:'shop_buy'}); log('商店購買',ch.id,r.n.id,id,'x'+qty,cost);
    return reply(c,rid,{ok:true,entry:e,cost});
  }
  if(t==='shop_sell'){
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const r=npcNear(c,String(m.npc||''),n=>n.shop==='buyer'); if(r.err) return reply(c,rid,{ok:false,err:r.err});
    const X=GX(c), ch=db.chars[c.char], L=cleanList(m.items,40); if(!L.length) return reply(c,rid,{ok:false,err:'沒有選擇物品'});
    let gold=0; for(const x of L){ if(ownQty(ch.data.inv,x.id)<x.qty) return reply(c,rid,{ok:false,err:'背包裡沒有這麼多：'+(X.ITEMS[x.id]?X.ITEMS[x.id].name:x.id)}); gold+=X.sellPrice(x.id)*x.qty; }
    const e=pushEntry(ch.id,{gold,removes:L,why:'shop_sell'}); log('收購',ch.id,JSON.stringify(L),gold);
    return reply(c,rid,{ok:true,entry:e,gold});
  }
  if(t==='clerr'){ c.clerrN=(c.clerrN|0)+1; if(c.clerrN<=10) log('用戶端錯誤',c.char||c.account||'-',String(m.w||'').slice(0,12),String(m.m||'').slice(0,160),String(m.s||'').slice(0,240)); return; }
  if(t==='item_del'){ // 刪除道具：只能刪背包裡自己擁有的（已裝備需先卸下；交易中不可；上架中的不在背包）
    if(tradeOf(c)) return reply(c,rid,{ok:false,err:'交易中不能刪除道具'});
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    const X=GX(c), ch=db.chars[c.char], id=String(m.id||''), qty=clampInt(m.qty,1,9999,1), I=X.ITEMS[id];
    if(!I) return reply(c,rid,{ok:false,err:'未知物品'});
    const own=ownQty(ch.data.inv,id); if(own<qty){ const eq=ch.data.equip&&Object.values(ch.data.equip).includes(id); return reply(c,rid,{ok:false,err:eq&&!own?'裝備中的物品請先卸下':'背包裡沒有這麼多：'+I.name}); }
    const e=pushEntry(ch.id,{removes:[{id,qty}],why:'item_del'}); const tier=(X.itemRarity?X.itemRarity(id):0)|0;
    log('刪除道具',ch.id,ch.data.name,id,I.name,'x'+qty,'tier'+tier);
    return reply(c,rid,{ok:true,entry:e});
  }
  // ---- 玩家交易 ----
  if(t==='trade_req'){
    const o=[...clients].find(x=>x.sid===(m.to|0)&&x.char); if(!o||o===c) return reply(c,rid,{ok:false,err:'找不到這位玩家'});
    if(!o.pos||o.pos.c!==c.pos.c||Math.hypot(o.pos.x-c.pos.x,o.pos.y-c.pos.y)>260) return reply(c,rid,{ok:false,err:'距離太遠（需在附近）'});
    if(tradeOf(c)||tradeOf(o)) return reply(c,rid,{ok:false,err:'你或對方正在交易中'});
    const now=Date.now(); c.tradeAsk=c.tradeAsk||{}; if(c.tradeAsk[o.sid]&&now-c.tradeAsk[o.sid]<8000) return reply(c,rid,{ok:false,err:'請稍候再邀請'});
    c.tradeAsk[o.sid]=now; o.tradeInv={from:c.sid,t:now};
    send(o,{t:'trade_inv',from:c.sid,name:db.chars[c.char].data.name,lv:db.chars[c.char].data.level|0}); return reply(c,rid,{ok:true});
  }
  if(t==='trade_ans'){
    const inv=c.tradeInv; c.tradeInv=null; const o=[...clients].find(x=>x.sid===(m.from|0)&&x.char);
    if(!inv||inv.from!==(m.from|0)||Date.now()-inv.t>30000||!o) return reply(c,rid,{ok:false,err:'邀請已失效'});
    if(!m.ok){ send(o,{t:'trade_end',ok:false,msg:`${db.chars[c.char].data.name} 拒絕了交易`}); return reply(c,rid,{ok:true}); }
    if(tradeOf(c)||tradeOf(o)) return reply(c,rid,{ok:false,err:'對方正在和別人交易'});
    if(!o.pos||o.pos.c!==c.pos.c||Math.hypot(o.pos.x-c.pos.x,o.pos.y-c.pos.y)>260) return reply(c,rid,{ok:false,err:'距離太遠（需在附近）'});
    const T={id:tradeSeq++,a:o,b:c,o:{a:{items:[],gold:0,lock:false,conf:false},b:{items:[],gold:0,lock:false,conf:false}},chg:Date.now(),t0:Date.now()};
    trades.set(T.id,T); o.trade=T.id; c.trade=T.id; log('交易開始',o.char,c.char); tradeSend(T); return reply(c,rid,{ok:true});
  }
  if(t==='trade_set'||t==='trade_lock'||t==='trade_conf'||t==='trade_cancel'){
    const T=tradeOf(c); if(!T) return reply(c,rid,{ok:false,err:'目前沒有進行中的交易'});
    const k=tradeSide(T,c), me=T.o[k], ch=db.chars[c.char];
    if(t==='trade_cancel'){ tradeEnd(T,`${ch.data.name} 取消了交易`); return reply(c,rid,{ok:true}); }
    if(m.player){ const sv=acceptSave(c,m.player,m.acks); if(!sv.ok) return reply(c,rid,sv); }
    if(t==='trade_set'){
      const L=cleanList(m.items,8), gold=clampInt(m.gold,0,GOLD_CAP,0);
      for(const x of L){ if(ownQty(ch.data.inv,x.id)<x.qty) return reply(c,rid,{ok:false,err:'背包裡沒有這麼多'}); }
      if(gold>(ch.data.gold|0)) return reply(c,rid,{ok:false,err:'金幣不夠'});
      const same=JSON.stringify(L)===JSON.stringify(me.items)&&gold===me.gold;
      me.items=L; me.gold=gold;
      if(!same){ for(const s of ['a','b']){ T.o[s].lock=false; T.o[s].conf=false; } T.chg=Date.now(); }
      tradeSend(T,same?null:k); return reply(c,rid,{ok:true});
    }
    if(t==='trade_lock'){ me.lock=!!m.on; if(!me.lock){ for(const s of ['a','b']) T.o[s].conf=false; } else me.conf=false; tradeSend(T); return reply(c,rid,{ok:true}); }
    // trade_conf
    const ok2=T.o.a.lock&&T.o.b.lock; if(!ok2) return reply(c,rid,{ok:false,err:'雙方都鎖定後才能確認'});
    if(Date.now()-T.chg<2500) return reply(c,rid,{ok:false,err:'內容剛變動，請再看清楚（2 秒後可確認）'});
    me.conf=true; tradeSend(T);
    if(!(T.o.a.conf&&T.o.b.conf)) return reply(c,rid,{ok:true,wait:true});
    // —— 雙方確認：最終驗證後原子交換 ——
    const A=T.a, B=T.b, dA=db.chars[A.char].data, dB=db.chars[B.char].data, oA=T.o.a, oB=T.o.b;
    const fail=(msg)=>{ tradeEnd(T,'交易失敗：'+msg); return reply(c,rid,{ok:false,err:msg}); };
    if(!A.pos||!B.pos||A.pos.c!==B.pos.c||Math.hypot(A.pos.x-B.pos.x,A.pos.y-B.pos.y)>300) return fail('距離太遠');
    for(const [d,o2] of [[dA,oA],[dB,oB]]){ if((d.gold|0)<o2.gold) return fail('金幣不足'); for(const x of o2.items) if(ownQty(d.inv,x.id)<x.qty) return fail('物品已不在背包'); }
    if(!invFits(dA.inv,oA.items,oB.items)||!invFits(dB.inv,oB.items,oA.items)) return fail('背包空間不足');
    if((dA.gold|0)-oA.gold+oB.gold>GOLD_CAP||(dB.gold|0)-oB.gold+oA.gold>GOLD_CAP) return fail('金幣超過上限');
    trades.delete(T.id); A.trade=null; B.trade=null;
    const nA=dA.name, nB=dB.name;
    pushEntry(A.char,{gold:oB.gold-oA.gold,removes:oA.items,adds:oB.items,why:'trade',with:nB});
    pushEntry(B.char,{gold:oA.gold-oB.gold,removes:oB.items,adds:oA.items,why:'trade',with:nA});
    histAdd(A.char,{k:'trade',who:nB,give:oA,get:oB}); histAdd(B.char,{k:'trade',who:nA,give:oB,get:oA});
    log('交易完成',A.char,JSON.stringify(oA),'⇄',B.char,JSON.stringify(oB));
    for(const x of [A,B]) send(x,{t:'trade_end',ok:true,msg:'🤝 交易完成！'});
    return reply(c,rid,{ok:true,done:true});
  }
  // auc_death（Phase 1 用戶端上架死亡掉落）已移除：死亡掉落改由伺服器擲骰（見 world.onDied）
  if(t==='auc_pick'){ // 自己撿回地上的死亡掉落：交易所同步下架；若已被別人買走則不能撿
    const i=db.auction.findIndex(a=>a.fromDeath&&a.dropId===m.dropId&&a.seller===c.char);
    if(i<0) return db.soldDrops[m.dropId]?reply(c,rid,{ok:false,err:'這件掉落已經被別人在交易所買走了'}):reply(c,rid,{ok:true});
    db.auction.splice(i,1); markDirty(); aucBroadcast(); return reply(c,rid,{ok:true});
  }
  if(t==='gm'){
    if(!isGM(c.account)){ log('⛔ 非 GM 嘗試 GM 指令',c.account,m.op); return reply(c,rid,{ok:false,err:'⛔ 需要 GM 權限'}); }
    const ch=db.chars[c.char], d=ch.data, a=m.args||{}; log('👑 GM',c.account,m.op,JSON.stringify(a));
    switch(m.op){
      case 'gold': { const n=clampInt(a.n,0,GOLD_CAP,0); return reply(c,rid,{ok:true,entry:pushEntry(ch.id,{gold:n,why:'gm'})}); }
      case 'item': { const q=clampInt(a.qty,1,999,1); if(!d.inv.some(x=>x.id===a.id)&&d.inv.length>=20) return reply(c,rid,{ok:false,err:'背包已滿（20 格）'}); return reply(c,rid,{ok:true,entry:pushEntry(ch.id,{add:String(a.id),qty:q,why:'gm'})}); }
      case 'level': { d.level=clampInt(a.lv,1,LV_MAX,1); markDirty(); return reply(c,rid,{ok:true,lv:d.level}); }
      case 'exp': { d.exp=clampInt(a.n,0,EXP_POOL_CAP,0); markDirty(); return reply(c,rid,{ok:true,n:d.exp}); }
      case 'tp': { const cont=CONTS[a.cont]?a.cont:null, h=HUBS.find(h=>h[0]===cont); if(!cont) return reply(c,rid,{ok:false,err:'沒有這個大陸'}); c.allowTp={c:cont,x:+a.x,y:+a.y}; return reply(c,rid,{ok:true}); }
      case 'god': c.god=!!a.on; return reply(c,rid,{ok:true,on:c.god});
      case 'spawn': return reply(c,rid,world.gmSpawn(c,a));
      case 'clear': return reply(c,rid,world.gmClear(c));
      case 'accounts': { const rows=[]; for(const an of Object.keys(db.accounts)){ const sl=acctChars(an); let any=false;
          sl.forEach((s,i)=>{ if(!s) return; any=true; const online=[...clients].some(o=>o.char===s.id); rows.push({acct:an,gm:isGM(an),slot:i+1,id:s.id,name:s.data.name,lv:s.data.level|0,job:s.data.job||'novice',cont:s.data.continent||'scambray',online}); });
          if(!any) rows.push({acct:an,gm:isGM(an),slot:0}); }
        return reply(c,rid,{ok:true,rows}); }
    }
    return reply(c,rid,{ok:false,err:'未知的 GM 指令'});
  }
  reply(c,rid,{ok:false,err:'未知指令'});
}

// ---------- 快照（依大陸做興趣管理） ----------
setInterval(()=>{
  const by={}; for(const c of clients) if(c.char&&c.pos) (by[c.pos.c]=by[c.pos.c]||[]).push(c);
  const now=Date.now();
  for(const cont in by){
    const list=by[cont].map(c=>{ const d=db.chars[c.char].data; return {s:c.sid,n:d.name,x:Math.round(c.pos.x),y:Math.round(c.pos.y),f:c.f||1,m:c.mv?1:0,hp:c.hp|0,mhp:c.mhp||1,gm:isGM(c.account)?1:0,lv:d.level|0,b:c.bot?1:0,a:c.atk&&now-c.atk<400?1:0,as:c.as|0,cs:c.cs|0,job:(c.look&&c.look.job)||d.job||'novice',eq:(c.look&&c.look.eq)||[]}; });
    for(const c of by[cont]){ const w=world.snapFor(c); send(c,{t:'snap',ts:now,ps:list.filter(p=>p.s!==c.sid),ms:w.ms,gl:w.gl}); }
  }
},100);
function broadcastOnline(){
  const list=[...clients].filter(c=>c.char).map(charSummary);
  const m={t:'online',n:list.length,list:list.slice(0,100).map(({acct,...r})=>r)};
  for(const c of clients) if(c.char) send(c,m);
}
setInterval(broadcastOnline,3000);

// ---------- HTTP（靜態檔） ----------
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  let p; try{ p=decodeURIComponent(new URL(req.url,'http://x').pathname); }catch(e){ res.writeHead(400); return res.end(); }
  if(p==='/'||p==='') p='/index.html';
  if(p==='/favicon.ico'){ res.writeHead(204); return res.end(); }
  if(p==='/debug'&&process.env.WZW_TEST_DEBUG==='1'){ // 只有測試伺服器（環境變數）才有
    const q=new URL(req.url,'http://x').searchParams, out={players:[...clients].filter(c=>c.char).map(c=>({ch:c.char,pos:c.pos,vw:c.vw,vh:c.vh,zoom:c.zoom,hidden:c.hidden,hp:c.hp}))};
    const sj=q.get('setjob'); if(sj){ const X=G.scambray; for(const ch of Object.values(db.chars)){ if(ch.data&&ch.data.name===sj){ const d=ch.data; X.ensureAttr(d); for(const j of (q.get('job')||'').split(',')) if(X.JOBS[j]){ for(const [k,n] of X.jobAttrNeeds(j)) d.attr[k]=Math.max(d.attr[k]|0,n); d.job=j; X.applyJobFields(d); } markDirty(); out.setjob={name:sj,job:d.job,attr:d.attr}; } } } // 測試用：直接設職業
    const gv=q.get('give'); if(gv){ for(const ch of Object.values(db.chars)){ if(ch.data&&ch.data.name===gv){ const adds=(q.get('items')||'').split(',').filter(Boolean).map(x=>{ const [id,n]=x.split('*'); return {id,qty:+n||1}; }).filter(a=>G.scambray.ITEMS[a.id]); out.give=pushEntry(ch.id,{adds,why:'test_give'}); } } } // 測試用：發道具
    const id=q.get('id'); if(id) for(const w of Object.values(world.W)){ const m=w.mons.get(id); if(m) out.mon={x:m.x,y:m.y,ai:m.ai,detect:m.detect,aggro:m.aggro,tgt:m.tgt,cont:w.cont}; }
    res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(out)); }
  if(p==='/healthz'){ res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({ok:true,online:[...clients].filter(c=>c.char).length,accounts:Object.keys(db.accounts).length,world:world.debug(),stats:world.stats})); }
  const f=path.resolve(GAME_DIR,'.'+p);
  // 不提供：伺服器程式／資料、文字檔（含 bot 密碼）、隱藏檔
  if(!f.startsWith(GAME_DIR+path.sep)||f.startsWith(path.join(GAME_DIR,'server'))||/\.(txt|md|sh|py|log|bak|old|orig)$/i.test(f)||/\.bak([-.]|$)/i.test(f)||/\/\./.test(p)){ res.writeHead(404); return res.end('not found'); }
  fs.readFile(f,(err,buf)=>{
    if(err){ res.writeHead(404); return res.end('not found'); }
    const ext=path.extname(f).toLowerCase();
    if(p==='/index.html'){ buf=Buffer.from(buf.toString('utf8').replace('<head>','<head>\n<script>window.WZW_ONLINE=1;</script>'),'utf8'); }
    res.writeHead(200,{'content-type':MIME[ext]||'application/octet-stream','cache-control':'no-cache'}); res.end(buf);
  });
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:512*1024});
wss.on('connection',(ws,req)=>{
  const c={ws,ip:req.socket.remoteAddress,account:null,char:null,msgT:[]};
  clients.add(c);
  ws.on('message',buf=>{
    const now=Date.now(); c.msgT=c.msgT.filter(x=>now-x<1000); c.msgT.push(now);
    if(c.msgT.length>90) return; // 每秒最多 90 則
    let m; try{ m=JSON.parse(buf); }catch(e){ return; }
    if(!m||typeof m.t!=='string') return;
    try{ onMsg(c,m); }catch(e){ log('處理訊息錯誤',m.t,e.stack); if(m.rid) reply(c,m.rid,{ok:false,err:'伺服器錯誤'}); }
  });
  ws.on('close',()=>{ leaveGame(c); clients.delete(c); });
  ws.on('error',()=>{});
});
server.listen(PORT,HOST,()=>{
  log(`萬王之王 Online 伺服器啟動：http://${HOST}:${PORT}/`);
  log(`資料路徑：${DB_FILE}`);
  log(`帳號數：${Object.keys(db.accounts||{}).length}`);
});
