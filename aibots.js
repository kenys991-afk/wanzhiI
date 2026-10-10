// 萬王之王：5 位 AI 玩家（一般帳號、無 GM、走一般用戶端＋伺服器驗證）
// 用 headless Chrome 開 5 個遊戲頁（?wzwai），由這支程式扮演「玩家的大腦」：練功、升級、加屬性、轉職、換裝、交易所、跨大陸、聊天。
// 啟停：server/aibots.sh start|stop|status
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const HERE=__dirname, SERVER=path.resolve(HERE,'..');
// playwright-core：優先 PW_CORE，其次 aibots/node_modules（持久，npm install 於 aibots/），最後舊的 /tmp/pwt
const PW_CORE=process.env.PW_CORE||(()=>{ for(const c of [require('path').join(__dirname,'node_modules','playwright-core'),'/tmp/pwt/node_modules/playwright-core']){ try{ require.resolve(c); return c; }catch(_){} } return 'playwright-core'; })();
const {chromium}=require(PW_CORE);
const URL=(process.env.WZW_URL||'http://127.0.0.1:8770')+'/?wzwai';
const ACC_FILE=process.env.AI_ACC_FILE||path.join(HERE,'accounts.json');            // 帳密（私密，chmod 600，不會印出）
const DB_FILE=process.env.WZW_DATA?path.join(process.env.WZW_DATA,'db.json'):path.join(SERVER,'data','db.json');
const ONLY=process.env.AI_ONLY?process.env.AI_ONLY.split(','):null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)), rnd=(a,b)=>a+Math.random()*(b-a), pick=a=>a[(Math.random()*a.length)|0];
const log=(...a)=>console.log(new Date().toLocaleString('zh-TW',{hour12:false}),...a);

// ---------- 角色設定 ----------
const BOTS=[
  {key:'xueyue', acct:'aib_xueyue', name:'血月狂刃', path:['swordsman','berserker','bloodrager'], grow:['str','vit','str','dex'], greedy:false,
   lines:{idle:['肚子好餓……打完這隻{mon}就去吃烤肉！','衝啊！血月狂刃來也！','這{mon}看起來很好吃的樣子🤤','誰要比誰殺得快？輸的請吃飯！','打怪打到餓了，有人賣便當嗎','砍砍砍！吃吃吃！','剛砍完一群，先來支雞腿補體力🍗','怪物排隊給我砍，順便排隊給我吃'],
     lvup:['Lv.{lv}！慶祝一下，今晚加點大雞腿🍗','升到 {lv} 等了！餓到可以吞下一頭{mon}','Lv.{lv}～力氣變大，飯量也變大'],
     promote:['轉職{job}！以後一刀一隻，吃到飽！','{job}到手！先去吃一頓再說'],
     greet:['嗨嗨～{name}，要不要一起去砍怪？順便吃宵夜','{name} 你好！你有帶吃的嗎？','喲 {name}！一起衝一波？'],
     travel:['聽說{cont}的魔物肉質更Q彈，出發！','{cont}我來了！帶好碗筷'], food:['餓了就要吃！我推薦史坎布雷的烤肉','說到吃我可不會輸'], help:['我來幫你砍！在哪？']}},
  {key:'tianlei', acct:'aib_tianlei', name:'天雷滅世', path:['magician','mage','stormcaller'], grow:['int','wis','int','vit'],
   lines:{idle:['凡人們，見識一下天雷的力量吧⚡','這種小怪，不配讓我出全力','雷霆萬鈞！……咳，剛剛只用了一成功力','全服最強法師就是我，不服來戰','{mon}？一道雷就夠了','我的大招一出，方圓十里寸草不生⚡','天雷滅世，名不虛傳'],
     lvup:['Lv.{lv}？對本大爺來說只是開始','又升級了，天賦這種東西果然藏不住⚡','Lv.{lv}，離滅世又近了一步'],
     promote:['從今天起，叫我{job}大人','{job}！天雷之力，覺醒⚡'],
     greet:['{name}？你運氣好，碰上了本天雷大人','哼，{name}，想學魔法就跪下拜師吧','{name} 來得正好，看我放大招⚡'],
     travel:['{cont}的魔物，準備好被雷劈了嗎⚡','前往{cont}，讓那裡也見識天雷'], strong:['最強？那當然是我天雷滅世⚡','說最強之前先問過我的雷'], help:['讓開，我一招清場⚡']}},
  {key:'yingsha', acct:'aib_yingsha', name:'影殺無痕', path:['scout','ninja','shadow_ninja'], grow:['dex','vit','dex','str'], quiet:true,
   lines:{idle:['……','嗯。','目標確認。','影，無聲。','太吵了。','下一個。','……{mon}。'],
     lvup:['……Lv.{lv}。','嗯，{lv}。'], promote:['{job}。','……{job}，到手。'],
     greet:['……嗯。','{name}。','……'], travel:['{cont}。走了。','……{cont}。'], help:['……在哪。']}},
  {key:'shengguang', acct:'aib_shengguang', name:'聖光破暁', path:['magician','priest','bishop'], grow:['wis','vit','wis','int'],
   lines:{idle:['有人需要補血嗎？我在{place}附近～','新手們加油！記得去稻草人升級喔','打不過的怪別硬拚，安全第一🙏','藥水不夠的話記得找奸商小王補貨～','願聖光守護大家✨','新手區很安全，10 級以前可以多去練練喔～','有問題都可以問我喔，我盡量回答😊'],
     lvup:['升到 Lv.{lv} 了，可以幫更多人了！','Lv.{lv}✨ 謝謝大家一路照顧'], promote:['成為{job}了！大家受傷都可以找我～','{job}✨ 聖光與大家同在'],
     greet:['{name} 你好呀～需要幫忙嗎？','歡迎 {name}！有不懂的可以問我喔✨','{name} 午安～祝你今天打寶順利！'],
     travel:['我去{cont}看看，有需要隨時喊我！','前往{cont}～大家保重✨'], help:['我來了！撐住，聖光與你同在✨','需要幫忙嗎？告訴我位置～'], cheer:['{name} 加油！祝你平安✨','{name} 小心身邊的怪喔～']}},
  {key:'huoba', acct:'aib_huoba', name:'霍霸龍王', path:['scout','fighter','fist_saint'], grow:['str','dex','vit','str'], trader:true,
   lines:{idle:['拳頭硬、錢包更硬，誰敢不服？','{mon}也敢擋我財路？一拳送走👊','交易所看到便宜好貨不買是傻子','今天又賺了一筆，嘿嘿💰','誰要單挑？輸的給 100 金','霍霸龍王的貨，童叟無欺（才怪）','有錢不賺，天誅地滅💰'],
     lvup:['Lv.{lv}！拳頭又硬了👊','Lv.{lv}，賺錢效率 +10%'], promote:['{job}到手！接下來賺翻💰','{job}！誰不服來單挑👊'],
     greet:['{name}？要買東西找我，打折……才怪','喲 {name}，新來的？交易所了解一下💰','{name}，聽說你很強？來單挑啊👊'],
     travel:['{cont}的生意，我霍霸龍王包了💰','去{cont}收購好貨，順便揍幾隻怪'], trade:['剛在交易所上架了 {item}，{price} 金，先搶先贏！','交易所新貨：{item} {price} 金，霍霸龍王出品💰'], buy:['交易所撿到便宜 {item}，賺爛了💰'], tradeq:['要買賣找我霍霸龍王！交易所最懂的就是我💰','想買什麼？交易所看看，我那邊有好貨']}},
];
if(process.env.AI_TEST_SUFFIX){ const s=String(process.env.AI_TEST_SUFFIX).replace(/[^a-z0-9]/gi,"").slice(0,3); for(const b of BOTS){ b.acct+=s; b.name=b.name.slice(0,4)+s; } } // 測試伺服器用：避免與正式帳號同名
const AI_NAMES=new Set(BOTS.map(b=>b.name));
// 不碰：kok 的 bot（胡尼史）、使用者帳號 Kty（不交易、不針對）
const EXCL_NAMES=new Set(['胡尼史','kokbot','Kty','kty']);
const EXCL_CHAR_IDS=new Set();
function loadExclusions(){ try{ const db=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); for(const [id,c] of Object.entries(db.chars||{})){ const a=String(c.account||'').toLowerCase(); if(a==='kokbot'||a==='kty'){ EXCL_CHAR_IDS.add(id); if(c.data&&c.data.name) EXCL_NAMES.add(c.data.name); } } }catch(e){ log('（讀不到 db.json 排除名單，只用預設名稱）'); } }

// ---------- 帳號 ----------
function loadAccounts(){ let A={}; try{ A=JSON.parse(fs.readFileSync(ACC_FILE,'utf8')); }catch(e){}
  let ch=false; for(const b of BOTS){ if(!A[b.key]){ A[b.key]={acct:b.acct,pw:crypto.randomBytes(12).toString('base64url'),created:false}; ch=true; } }
  if(ch) saveAccounts(A); return A; }
function saveAccounts(A){ fs.writeFileSync(ACC_FILE,JSON.stringify(A,null,1),{mode:0o600}); try{ fs.chmodSync(ACC_FILE,0o600); }catch(e){} }

// ---------- 全域聊天節流 ----------
const CHAT={last:0,minGap:40000,seen:new Set()};
function fill(t,v){ return t.replace(/\{(\w+)\}/g,(_,k)=>v[k]!=null?v[k]:''); }

const SKILL_LINES={
  xueyue:['新招「{sk}」學會了！砍起來更香了🍖','「{sk}」到手，誰要陪我試刀？贏的請吃飯！'],
  tianlei:['「{sk}」？對天雷來說不過是小菜一碟⚡','又學會了「{sk}」，這世上還有誰擋得住我？'],
  yingsha:['……{sk}。','新術：{sk}。'],
  shengguang:['學會「{sk}」了！需要幫忙隨時叫我🙏','「{sk}」可以保護大家了，靠近我一點喔！'],
  huoba:['「{sk}」練成！打不贏的魔物找我，收費合理💰','霍霸龍王新絕招「{sk}」，看好了！'],
};
class Bot{
  constructor(cfg,acc,browser){ this.c=cfg; this.acc=acc; this.b=browser; this.page=null; this.next={chat:Date.now()+rnd(60e3,240e3),auc:Date.now()+rnd(90e3,300e3),scare:0,shop:0,react:0,cheer:0,buy:Date.now()+rnd(5*60e3,10*60e3)}; this.task=null; this.lastLv=0; this.lastJob=null; this.lastIn=Date.now(); this.stuck={x:0,y:0,t:Date.now()}; this.mon='史萊姆'; }
  async ev(fn,...a){ return this.page.evaluate(([fn,a])=>{ const A=window.__wzwAI; if(!A) return {__noai:1}; return A[fn](...a); },[fn,a]); }
  async open(){
    const ctx=await this.b.newContext({viewport:{width:640,height:400},deviceScaleFactor:1});
    await ctx.addInitScript(()=>{ window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),50); }); // 20 FPS：省 CPU
    this.page=await ctx.newPage(); this.page.on('dialog',d=>d.accept().catch(()=>{})); this.page.on('pageerror',e=>log(this.c.name,'頁面錯誤',String(e.message).slice(0,160)));
    await this.login(); }
  async login(){
    const pg=this.page; await pg.goto(URL,{waitUntil:'domcontentloaded'}); await pg.waitForSelector('#acct-name',{timeout:20000}); await sleep(800);
    if(!this.acc.created){ await pg.click('#btn-acct-switch').catch(()=>{}); await sleep(200); await pg.fill('#acct-name',this.acc.acct); await pg.fill('#acct-pw',this.acc.pw); await pg.fill('#acct-pw2',this.acc.pw).catch(()=>{}); await pg.click('#btn-login'); await sleep(1500);
      if(await pg.$('.btn-slot-create[data-slot="0"]:visible')||await pg.$('.btn-slot-continue[data-slot="0"]:visible')){ this.acc.created=true; saveAccounts(ACCS); log(this.c.name,'帳號已建立'); }
      else { // 已存在 → 改用登入
        await pg.goto(URL,{waitUntil:'domcontentloaded'}); await pg.waitForSelector('#acct-name'); await sleep(500); await pg.fill('#acct-name',this.acc.acct); await pg.fill('#acct-pw',this.acc.pw); await pg.click('#btn-login'); await sleep(1500); this.acc.created=true; saveAccounts(ACCS); }
    } else { await pg.fill('#acct-name',this.acc.acct); await pg.fill('#acct-pw',this.acc.pw); await pg.click('#btn-login'); await sleep(1500); }
    if(await pg.$('.btn-slot-continue[data-slot="0"]:visible')){ await pg.click('.btn-slot-continue[data-slot="0"]'); }
    else if(await pg.$('.btn-slot-create[data-slot="0"]:visible')){ await pg.click('.btn-slot-create[data-slot="0"]'); await sleep(300); await pg.fill('#player-name',this.c.name); await pg.click('#btn-start'); log(this.c.name,'建立角色'); }
    else throw new Error('登入失敗（找不到角色欄位）');
    await sleep(2500); const st=await this.ev('st'); if(!st||!st.in) throw new Error('進不了遊戲'); log(this.c.name,`上線 Lv.${st.lv} ${st.job} ${st.cont} (${st.x},${st.y})`); this.lastLv=st.lv; this.lastJob=st.job; }
  async say(text,force){ const now=Date.now(); if(!force&&now-CHAT.last<CHAT.minGap) return false; CHAT.last=now; const ok=await this.ev('chat',text,'g').catch(()=>false); if(ok) log(this.c.name,'💬',text); return ok; }
  line(kind,v){ const L=this.c.lines[kind]; if(!L||!L.length) return null; return fill(pick(L),Object.assign({mon:this.mon,place:'史坎布雷'},v||{})); }
  near(st,x,y,r){ return Math.hypot(st.x-x,st.y-y)<=(r||90); }
  async walk(st,x,y,r){ if(this.near(st,x,y,r)) return true; if(st.bot) await this.ev('bot',false);
    if(Math.hypot(st.x-this.stuck.x,st.y-this.stuck.y)>20){ this.stuck={x:st.x,y:st.y,t:Date.now()}; }
    else if(Date.now()-this.stuck.t>8000){ const a=Math.random()*6.28; await this.ev('goto',st.x+Math.cos(a)*90,st.y+Math.sin(a)*90); this.stuck.t=Date.now(); await sleep(1200); return false; }
    await this.ev('goto',x+rnd(-12,12),y+rnd(-12,12)); return false; }
  npc(npcs,f){ return npcs.find(f); }
  /** 二轉追加技能：先學沒學過的（補師先輔助、其他先攻擊），再升級；保留一半升級經驗 */
  async learnExtras(){ try{
    const st=await this.ev('st'); const xs=await this.ev('extras'); if(!Array.isArray(xs)||!xs.length) return;
    const supFirst=this.c.key==='shengguang'; const rank=x=>(x.lv>0?10:0)+x.lv+((x.cat==='sup')===supFirst?0:3)+Math.random();
    let n=0; for(const x of xs.filter(x=>x.need>0&&x.lv>0).sort((a,b)=>rank(a)-rank(b))){ if(n>=2) break;
      const r=await this.ev('learn',x.id,Math.floor((st.expNext||0)*0.5)); if(r===true){ n++; log(this.c.name,'學習技能',x.name,'Lv.'+(x.lv+1));
        if(x.lv===0&&Math.random()<0.6) await this.say(pick(SKILL_LINES[this.c.key]||['學會「{sk}」了！']).replace('{sk}',x.name)); } else if(r==='exp') break; }
  }catch(e){ log(this.c.name,'learnExtras',e.message); } }
  nextJob(st){ const tierNext=st.tier+1; return this.c.path[tierNext-1]||null; }
  attrNeeds(st,needs){ return (needs||[]).filter(([k,n])=>(st.attr[k]|0)<n); }
  async tick(){
    const st=await this.ev('st'); if(!st||st.__noai) throw new Error('AI 介面不存在');
    if(!st.in||!st.conn){ if(Date.now()-this.lastIn>45000) throw new Error('離線太久，重新登入'); return; } this.lastIn=Date.now();
    if(st.dlg) await this.ev('closeDlg');
    if(st.dead) return;
    if(Date.now()>(this.next.nav||0)){ if(this.next.nav){ const n=await this.ev('navStats'); if(n) log(this.c.name,'導航統計',JSON.stringify({stuck:n.stuck,moveS:Math.round(n.moveMs/1000),stuckEv:n.stuckEv,skip:n.skip,legacy:n.legacy})); if(n&&n.rg&&n.rg.shots) log(this.c.name,'遠程命中',JSON.stringify(n.rg)); } this.next.nav=Date.now()+120e3; }
    // 事件：升級／轉職
    if(st.lv>this.lastLv&&this.lastLv>0){ if(Math.random()<0.55){ const t=this.line('lvup',{lv:st.lv}); if(t) await this.say(t); } } this.lastLv=st.lv;
    if(st.job!==this.lastJob&&this.lastJob){ const jn=await this.page.evaluate(j=>{ try{ return document.querySelector('#hud-job, .job-chip')?.textContent||j; }catch(e){ return j; } },st.job); const t=this.line('promote',{job:jobName(st.job)}); if(t) await this.say(t,true); } this.lastJob=st.job;
    const npcs=this.npcsCache||(this.npcsCache=await this.ev('npcs')); if(st.cont!==this.npcsCont){ this.npcsCont=st.cont; this.npcsCache=await this.ev('npcs'); }
    const N=this.npcsCache, master=N.find(n=>n.id==='master'), portal=N.find(n=>n.role==='portal'), shop=N.find(n=>n.id==='merchant'||n.role==='shop'), auc=N.find(n=>n.role==='auction');
    // 1) 新手教學（冒險主）
    if(!st.tut&&master){ if(await this.walk(st,master.x,master.y+40,100)){ await this.ev('tutorial'); log(this.c.name,'完成新手教學'); } return; }
    // 2) 轉職
    const nj=this.nextJob(st);
    // 2) 轉職：到天使雕像（城市雕像＝一／二轉；國家天使雕像（霜燼要塞）＝三轉）
    const goAngel=async(tier)=>{ const a=await this.ev('angel',tier); if(!a) return null;
      if(a.cont!==st.cont){ const req=this.req||(this.req=await this.ev('contReq')); if(portal&&st.lv>=(req[a.cont]||0)){ if(await this.walk(st,portal.x,portal.y+40,100)){ const r=await this.ev('travel',a.cont); log(this.c.name,'前往天使雕像',a.cont,r); } return 'busy'; } return null; }
      return (await this.walk(st,a.x,a.y+60,90))?'at':'busy'; };
    if(nj&&st.kids&&st.kids.includes(nj)){ const needs=await this.ev('jobNeeds',nj); if(!this.attrNeeds(st,needs).length){ const g=await goAngel(st.tier+1); if(g==='at'){ const ok=await this.ev('promote',nj); log(this.c.name,'天使雕像轉職',nj,ok); if(ok===true) await this.ev('angelLearn',0); } if(g) return; } }
    // 2b) 天使雕像：學會新的職業技能（用經驗池；保留一半升級經驗）
    if(Date.now()>(this.next.angel||0)&&st.tier>=1){ const un=(await this.ev('unlearned'))||[]; const res=Math.floor((st.expNext||0)*0.5);
      const can=un.filter(x=>x.tier<=st.tier&&st.exp-res>=x.cost);
      if(can.length){ const g=await goAngel(Math.max(...can.map(x=>x.tier))); if(g==='at'){ const got=await this.ev('angelLearn',res); log(this.c.name,'天使雕像學技能',JSON.stringify(got)); this.next.angel=Date.now()+rnd(60e3,120e3);
          if(Array.isArray(got)&&got.length&&Math.random()<0.6){ const nm=(un.find(x=>x.id===got[0])||{}).name; if(nm) await this.say(pick(SKILL_LINES[this.c.key]||['學會「{sk}」了！']).replace('{sk}',nm)); } }
        if(g) return; this.next.angel=Date.now()+rnd(60e3,120e3); } else this.next.angel=Date.now()+rnd(30e3,60e3); }
    // 3) 稻草人：經驗夠升級，或卡在轉職屬性
    const gate=[1,10,40,70][st.tier+1]||999, needs=nj?await this.ev('jobNeeds',nj):[], lack=this.attrNeeds(st,needs);
    const wantLv=st.exp>=st.expNext&&st.expNext>0, wantAttr=lack.length&&st.lv>=gate&&st.exp>=Math.max(60,st.expNext*0.25);
    const growAttr=!nj&&st.exp>=st.expNext*0.6&&Date.now()>this.next.scare;
    const wantSkill=st.tier>=2&&st.exp>=st.expNext*0.5+40000&&Date.now()>this.next.scare; // 二轉追加技能
    if((wantLv||wantAttr||growAttr||wantSkill)&&Date.now()>this.next.scare){
      const sc=(await this.ev('scarecrows')).sort((a,b)=>Math.hypot(a.x-st.x,a.y-st.y)-Math.hypot(b.x-st.x,b.y-st.y))[0];
      if(sc){ if(await this.walk(st,sc.x,sc.y+30,70)){
        const plan={lv:true,maxLv:3,lvCap:(lack.length?gate:0)||0,attrs:[]};
        if(lack.length&&st.lv>=gate) { plan.lv=false; plan.attrs=lack.map(x=>x[0]); }
        else if(!nj){ plan.attrs=[pick(this.c.grow)]; if(Math.random()<0.5) plan.lv=false; }
        if(!wantLv&&!wantAttr&&!growAttr) plan.lv=false;
        const r=await this.ev('scare',plan); log(this.c.name,'稻草人',JSON.stringify(plan),'→',JSON.stringify(r)); this.next.scare=Date.now()+rnd(40e3,90e3);
        if(st.tier>=2) await this.learnExtras(); }
        return; } }
    // 4) 換裝
    if(Math.random()<0.2||!this.gearChecked){ this.gearChecked=true; const eq=await this.ev('equipBest'); if(eq&&eq.length) log(this.c.name,'換裝',eq.join(',')); }
    // 4b) 缺適合職業的裝備（或身上是別系的）→ 去商人買基本款
    if(shop&&st.tier>=1&&Date.now()>(this.next.gear||0)){ const need=await this.ev('gearNeeds');
      if(need&&need.length&&st.gold>=80){ if(await this.walk(st,shop.x,shop.y+40,100)){ const got=await this.ev('shopGear',Math.floor(st.gold*0.7)); const eq=await this.ev('equipBest'); log(this.c.name,'買裝備',JSON.stringify(got),'→',JSON.stringify(eq)); this.next.gear=Date.now()+rnd(300e3,600e3); } return; }
      this.next.gear=Date.now()+rnd(120e3,240e3); }
    // 5) 補藥水
    const hpN=st.inv.filter(i=>i.id==='hp_potion').reduce((a,i)=>a+i.q,0), mpN=st.inv.filter(i=>i.id==='mp_potion').reduce((a,i)=>a+i.q,0);
    if(shop&&Date.now()>this.next.shop&&((hpN<3&&st.gold>=60)||(mpN<2&&st.gold>=150&&/mag|priest|mage|bishop|storm/.test(st.job)))){
      if(await this.walk(st,shop.x,shop.y+40,100)){ const n1=await this.ev('shop','hp_potion',Math.min(10,Math.floor((st.gold-30)/15))); const n2=/mag|priest|mage|bishop|storm/.test(st.job)?await this.ev('shop','mp_potion',Math.min(5,Math.floor((st.gold-30-n1*15)/12))):0; log(this.c.name,'買藥水',n1,n2); this.next.shop=Date.now()+120e3; } return; }
    // 5b) 收購商：背包快滿或有雜物 → 賣掉
    if(Date.now()>(this.next.junk||0)&&(st.inv.length>=12||st.inv.some(i=>i.id==='gold_nugget'))){
      const by=await this.ev('vendor','buyer'); this.next.junk=Date.now()+rnd(6*60e3,12*60e3);
      if(by&&await this.walk(st,by.x,by.y+40,110)){ const r=await this.ev('sellJunk'); log(this.c.name,'收購商賣出',JSON.stringify(r)); } if(by) return; }
    // 6) 交易所
    if(auc&&Date.now()>this.next.auc&&!this.c.quiet||auc&&Date.now()>this.next.auc+300e3){
      if(await this.walk(st,auc.x,auc.y+40,110)){ await this.trade(st); this.next.auc=Date.now()+(this.c.trader?rnd(120e3,240e3):rnd(300e3,600e3)); } return; }
    // 7) 跨大陸
    const req=this.req||(this.req=await this.ev('contReq'));
    const dest=st.cont==='scambray'&&st.lv>=(req.redrock||40)+3?'redrock':st.cont==='redrock'&&st.lv>=(req.frozen||70)+3?'frozen':null;
    if(dest&&portal){ if(await this.walk(st,portal.x,portal.y+40,100)){ const r=await this.ev('travel',dest); log(this.c.name,'前往',dest,r); const t=this.line('travel',{cont:{redrock:'赤岩大陸',frozen:'霜燼大陸'}[dest]}); if(t) await this.say(t,true); this.npcsCache=null; } return; }
    // 8) 練功
    if(!st.bot){
      if(st.cont==='scambray'&&st.lv<=10){ const z=this.nz||(this.nz=await this.ev('nz')); const tx=this.nzPt||(this.nzPt={x:rnd(z.x0+80,z.x1-80),y:rnd(z.y0+80,z.y1-80)});
        if(st.inNZ&&Math.hypot(st.x-tx.x,st.y-tx.y)<200){ await this.ev('bot',true,tx.x,tx.y); this.nzPt=null; log(this.c.name,'新手區練功 Lv.'+st.lv); return; }
        if(!st.inNZ){ // 圍欄只有北門、西門：先走到門外，再穿過門
          const G=[{ox:960,oy:515,ix:960,iy:650},{ox:595,oy:840,ix:720,iy:840}].sort((a,b)=>Math.hypot(a.ox-st.x,a.oy-st.y)-Math.hypot(b.ox-st.x,b.oy-st.y))[0];
          if(this.gateIn||Math.hypot(st.x-G.ox,st.y-G.oy)<40){ this.gateIn=true; if(await this.walk(st,G.ix,G.iy,30)) this.gateIn=false; } else await this.walk(st,G.ox,G.oy,30);
          return; }
        this.gateIn=false; await this.walk(st,tx.x,tx.y,60); return; }
      const sp=this.spot&&Date.now()-this.spot.t<600e3?this.spot:(this.spot=Object.assign(await this.ev('huntSpot',st.lv)||{x:st.x,y:st.y},{t:Date.now()}));
      if(Math.hypot(st.x-sp.x,st.y-sp.y)>700){ await this.walk(st,sp.x,sp.y,300); return; }
      await this.ev('bot',true,sp.x,sp.y); log(this.c.name,`練功點 (${sp.x},${sp.y}) 怪 Lv≈${sp.med}`); return; }
    // 練功中：偶爾聊天／對附近真人打招呼
    await this.social(st);
  }
  async trade(st){
    { const cl=await this.ev('claim'); if(cl&&cl.ok&&cl.gold) log(this.c.name,'領取信箱',cl.gold+'G'); }
    const A=await this.ev('auc'), mine=A.filter(a=>a.sellerName===this.c.name&&!a.fromDeath), cap=this.c.trader?5:2;
    // 賣：比身上差的裝備、重複裝備
    if(mine.length<cap){ const cands=[]; for(const it of st.inv){ const d=await this.ev('item',it.id); if(!d||!d.slot||!d.price) continue; const cur=await this.ev('item',st.equip[d.slot]); if(!d.suits||!cur||d.score<=cur.score) cands.push({id:it.id,d}); }
      for(const c of cands.slice(0,this.c.trader?2:1)){ const mul=this.c.trader?rnd(0.9,1.05):rnd(0.8,0.95), price=Math.max(5,Math.round(c.d.price*mul)); const r=await this.ev('sell',c.id,price); log(this.c.name,'上架',c.d.name,price,r.ok?'OK':r.err);
        if(r.ok&&this.c.trader&&Math.random()<0.6){ const t=this.line('trade',{item:c.d.name,price}); if(t) await this.say(t); } } }
    // 買：比身上好、價格合理（≤ 原價）、不是自己/胡尼史/Kty 的、不買死亡掉落
    if(Date.now()>this.next.buy){ this.next.buy=Date.now()+rnd(8*60e3,15*60e3);
      for(const a of A.sort((x,y)=>x.price-y.price)){ if(a.fromDeath||a.sellerName===this.c.name||EXCL_NAMES.has(a.sellerName)||EXCL_CHAR_IDS.has(a.seller)) continue; if(st.gold<a.price+120) continue;
        const d=await this.ev('item',a.itemId); if(!d||!d.slot||!d.price||!d.suits||a.price>d.price*1.0) continue; const cur=await this.ev('item',st.equip[d.slot]); if(cur&&d.score<=cur.score*1.08) continue;
        const r=await this.ev('buy',a.id); log(this.c.name,'購買',d.name,a.price,r.ok?'OK':r.err); if(r.ok){ await this.ev('equipBest'); if(this.c.trader){ const t=this.line('buy',{item:d.name}); if(t) await this.say(t); } } break; } } }
  async social(st){
    const now=Date.now();
    // 回應別人說話（由總管分派，避免 5 個一起回）
    // 閒聊
    if(now>this.next.chat){ this.next.chat=now+(this.c.quiet?rnd(10*60e3,20*60e3):rnd(5*60e3,12*60e3)); if(Math.random()<0.7){ const t=this.line('idle'); if(t) await this.say(t); } }
    // 附近有真人玩家：偶爾打招呼／加油（每人 15 分鐘最多一次）
    if(now>this.next.cheer){ this.next.cheer=now+rnd(60e3,120e3); const rs=(await this.ev('remotes')).filter(r=>!AI_NAMES.has(r.n)&&!EXCL_NAMES.has(r.n)&&Math.hypot(r.x-st.x,r.y-st.y)<300);
      this.met=this.met||{}; const r=rs.find(r=>!this.met[r.n]||now-this.met[r.n]>15*60e3); if(r&&Math.random()<0.5){ this.met[r.n]=now; const t=this.line(this.c.lines.cheer?'cheer':'greet',{name:r.n}); if(t) await this.say(t); } }
  }
}
function jobName(j){ return ({swordsman:'劍士',berserker:'狂戰士',bloodrager:'血怒者',magician:'魔導士',mage:'法師',stormcaller:'雷霆使',scout:'斥候',ninja:'忍者',shadow_ninja:'影忍',priest:'牧師',bishop:'主教',fighter:'武鬥家',fist_saint:'拳聖'})[j]||j; }

// ---------- 總管：聊天反應分派 ----------
const REACT=[[/(^|[^a-z])(hi|hello|hey)\b|嗨|你好|哈囉|安安|午安|晚安|早安/i,'greet',null],[/補血|救命|help|打不過|快死/i,'help',null],[/交易|拍賣|賣|買|金幣|賺錢/,'tradeq','huoba'],[/最強|好強|厲害|法師/,'strong','tianlei'],[/餓|吃|便當|宵夜|烤肉/,'food','xueyue']];
async function reactLoop(bots){
  const seen=new Set(); let last=0;
  for(;;){ await sleep(2500); if(STOP) return; const live=bots.filter(b=>b.ok); if(!live.length) continue;
    let msgs=[]; for(const b of live){ try{ const m=await b.ev('inbox'); if(Array.isArray(m)) msgs=msgs.concat(m); }catch(e){} }
    for(const m of msgs){ const k=m.from+'|'+m.text; if(seen.has(k)) continue; seen.add(k); if(seen.size>500) seen.clear();
      if(AI_NAMES.has(m.from)||EXCL_NAMES.has(m.from)||m.gm) continue; if(Date.now()-last<60000) continue;
      let who=null, kind=null; const named=live.find(b=>m.text.includes(b.c.name)); if(named){ who=named; kind='greet'; }
      else for(const [re,kd,pref] of REACT){ if(re.test(m.text)){ kind=kd; const cand=live.filter(b=>b.c.lines[kd]); who=pref?live.find(b=>b.c.key===pref)||pick(cand):pick(cand); break; } }
      if(!who||!kind||Math.random()>(named?0.95:0.6)) continue;
      const t=who.line(kind,{name:m.from}); if(!t) continue; last=Date.now(); const delay=rnd(3000,9000); setTimeout(()=>who.say(t,true).catch(()=>{}),delay); }
  } }

let STOP=false, ACCS=null;
async function runBot(bot){ let fails=0;
  for(;;){ if(STOP) return;
    try{ if(!bot.page){ await bot.open(); bot.ok=true; fails=0; } await bot.tick(); await sleep(rnd(1500,2600)); }
    catch(e){ bot.ok=false; fails++; log(bot.c.name,'⚠',String(e.message||e).slice(0,200)); try{ if(bot.page) await bot.page.context().close(); }catch(_){} bot.page=null; bot.npcsCache=null; await sleep(Math.min(120e3,5000*fails)); } } }
(async()=>{
  loadExclusions(); ACCS=loadAccounts(); log('AI 玩家啟動 →',URL,'排除：',[...EXCL_NAMES].join('、'));
  const browser=await chromium.launch({executablePath:process.env.CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-gpu','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const bots=BOTS.filter(c=>!ONLY||ONLY.includes(c.key)).map(c=>new Bot(c,ACCS[c.key],browser));
  const stop=async()=>{ if(STOP) return; STOP=true; log('停止中：存檔並離線…'); for(const b of bots){ try{ if(b.page){ await b.ev('save'); } }catch(e){} } await sleep(1500); try{ await browser.close(); }catch(e){} log('已停止'); process.exit(0); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  bots.forEach((b,i)=>setTimeout(()=>runBot(b),i*4000)); reactLoop(bots);
})();
