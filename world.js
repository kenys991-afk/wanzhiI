'use strict';
// 伺服器權威魔物世界（Phase 2）：每個大陸一份。重用 index.html 的遊戲邏輯（gamelogic.js 沙盒）
//  - 區塊生成同種子 → 魔物位置／種類／等級和單機版一致；有玩家在附近才啟用，死掉 35–50 秒後原地重生
//  - AI：史坎布雷被動（被打才反擊）；紅石／冰封 ❓→❗ 半主動，追最近的玩家，目標離開「他自己的畫面」就放棄回巢
//  - 傷害由用戶端回報、伺服器驗證（距離、單發上限、頻率）；狀態效果／DoT／擊退在伺服器跑
//  - 擊殺：最後一擊拿金幣＋掉落；傷害 ≥20% 的人（含最後一擊）按傷害比例分 EXP（各自套等級差倍率）
const crypto=require('crypto');
const ST_KEYS=['burn','poison','slow','freeze','stun','curse','taunt','mark'];
const num=(v,lo,hi,d)=>{ v=+v; if(!isFinite(v)) return d; return Math.max(lo,Math.min(hi,v)); };
const rid=(p)=>p+Date.now().toString(36)+crypto.randomBytes(3).toString('hex');

function createWorld(G,deps){
  const {db,log,pushEntry,send,clients,isGM,aucAddDeath,aucRemoveDrop}=deps; const partyOf=deps.partyOf||(()=>null);
  const TILE=40, CHUNK=16, CH=CHUNK*TILE;
  const W={};
  for(const cont of ['scambray','redrock','frozen','lavaTower','abyssRoad','seaVast']) W[cont]={cont,ctx:G[cont],mons:new Map(),chunks:new Map(),items:new Map()};
  const stats={hits:0,rejected:0,clamped:0,kills:0,mhits:0};
  const playersIn=(cont)=>{ const out=[]; for(const c of clients) if(c.char&&c.pos&&c.pos.c===cont&&db.chars[c.char]) out.push(c); return out; };
  const D=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

  // ---------- 區塊啟用／重生 ----------
  function cloneMon(w,id,e,ck,gm){
    return {id,kind:'monster',cont:w.cont,type:e.type,tn:e.type.name,x:e.x,y:e.y,hx:e.x,hy:e.y,sx:e.x,sy:e.y,level:e.level||1,atk:e.atk,exp:e.exp,gold:(e.gold||e.type.gold).slice(),
      hp:e.maxHp||e.hp,maxHp:e.maxHp||e.hp,alive:true,cd:0,vx:0,vy:0,wander:0,hurt:0,aggro:false,counterT:0,ai:null,detect:0,alertT:0,giveT:0,st:{},_dot:0,
      dmg:new Map(),last:null,tgt:null,ck,gm:!!gm,nz:!!e.nz,cave:!!e.cave,hi:w.cont!=='scambray'||(!!e.cave&&(e.level|0)>=40),boss:!!e.boss,rampage:!!e.rampage,slamT:0,slam:null,tpl:{hp:e.maxHp||e.hp}};
  }
  function loadChunk(w,cx,cy){
    const k=cx+','+cy; let rec=w.chunks.get(k); if(rec) return rec;
    const ch=w.ctx.getChunk(cx,cy); rec={k,ids:[],near:Date.now()}; let i=0;
    const base=[];
    for(const e of ch.entities){ if(e.kind!=='monster') continue; const id=`${w.cont[0]}${k}#${i++}`; w.mons.set(id,cloneMon(w,id,e,k)); rec.ids.push(id); if(!e.nz&&!e.boss&&!e.rampage) base.push(e); }
    // 加密：每區塊額外 +3（史坎布雷）／+2（其他）隻，複製同區塊魔物的種類／等級，放在可走、非城鎮的位置（伺服器權威；種子固定）
    let seed=(cx*73856093)^(cy*19349663)^0x5bd1e995;
    const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
    // Lv40+（紅石／冰封野外、Lv40+ 洞窟）：魔物略增 ~+20–30%（野外額外 2 → 3～4 隻；Lv40+ 洞窟額外 +2）
    const hiCave=base.some(e=>e.cave&&(e.level|0)>=40), isCave=base.some(e=>e.cave);
    const extra=!base.length?0:isCave?((w.cont==='scambray'?3:2)+(hiCave?2:0)):w.cont==='scambray'?3:(3+(rnd()<0.4?1:0));
    if(['lavaTower','abyssRoad','seaVast'].includes(w.cont)) extra += 5; // 120+ 地圖野外增量
    for(let j=0,tries=0;j<extra&&tries<40;tries++){
      const src=base[Math.floor(rnd()*base.length)], x=cx*CH+TILE+rnd()*(CH-2*TILE), y=cy*CH+TILE+rnd()*(CH-2*TILE);
      try{ const tx=x/TILE, ty=y/TILE; if(w.ctx.hubAtTile(tx,ty)||Math.hypot(tx-8,ty-8)<10||w.ctx.inNewbieZone(x,y)||!w.ctx.canWalk(x,y,14)||w.ctx.inMonsterFreeHub(x,y)) continue; }catch(e){ continue; } // 同單機規則：不生在城鎮／起始城 10 格內
      const e=Object.assign({},src,{x,y}); const id=`${w.cont[0]}${k}#x${j++}`; w.mons.set(id,cloneMon(w,id,e,k)); rec.ids.push(id);
    }
    w.chunks.set(k,rec); return rec;
  }
  function respawn(w,m){
    Object.assign(m,{x:m.sx,y:m.sy,hx:m.sx,hy:m.sy,hp:m.tpl.hp,maxHp:m.tpl.hp,alive:true,cd:0,hurt:0,aggro:false,counterT:0,ai:null,detect:0,alertT:0,giveT:0,st:{},_dot:0,dmg:new Map(),last:null,tgt:null,respawnAt:0});
  }
  let lastChunkT=0;
  function manageChunks(now){
    for(const cont in W){ const w=W[cont], pls=playersIn(cont);
      for(const c of pls){ const pcx=Math.floor(c.pos.x/CH), pcy=Math.floor(c.pos.y/CH);
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) loadChunk(w,pcx+dx,pcy+dy).near=now; }
      for(const [k,rec] of w.chunks){ if(now-rec.near<120000) continue; // 兩分鐘沒人 → 卸載（回到初始狀態）
        for(const id of rec.ids) w.mons.delete(id); w.chunks.delete(k); }
      for(const m of w.mons.values()){
        if(m.alive||!m.respawnAt||now<m.respawnAt) continue;
        if(m.gm){ w.mons.delete(m.id); continue; }
        if(m.boss){ respawn(w,m); bcast({t:'ann',text:`👑 小王「${m.tn}」再次出現在 ${caveName(w,m)}！`,col:'#ff9a60'},w.cont); continue; }
        if(pls.some(c=>Math.hypot(c.pos.x-m.sx,c.pos.y-m.sy)<(m.nz?50:120))){ m.respawnAt=now+(m.nz?1500:3000); continue; } // 有人站在重生點上 → 晚點再生
        respawn(w,m);
      }
      for(const [id,it] of w.items) if(now>it.expire) w.items.delete(id);
    }
  }

  // ---------- 視野（每位玩家自己的畫面大小） ----------
  function onScreenOf(w,c,m,margin){
    const vw=(c.vw||1280), vh=(c.vh||800), Z=c.zoom||w.ctx.CAM_ZOOM||1.3, TW=w.ctx.ISO_TW||240, TH=w.ctx.ISO_TH||120;
    const dx=(m.x-c.pos.x)/TILE, dy=(m.y-c.pos.y)/TILE;
    const sx=(dx-dy)*TW/2, sy=(dx+dy)*TH/2+8-6; // 鏡頭以玩家為中心（PLAYER_DRAW_Y=8，怪物錨點 -6）
    const zx=sx*Z, zy=sy*Z; margin=margin||0;
    return Math.abs(zx)<=vw/2+margin&&Math.abs(zy)<=vh/2+margin;
  }

  // ---------- 傷害 ----------
  function caps(c){
    const now=Date.now(); if(c.capT&&now-c.capT<5000&&c.capLv===(db.chars[c.char].data.level|0)) return c.caps;
    const ch=db.chars[c.char], w=W[c.pos.c]||W.scambray; let base=10;
    try{ base=Math.max(1,w.ctx.calcDmg(JSON.parse(JSON.stringify(ch.data)),{noCrit:1,quiet:1})|0); }catch(e){ base=Math.max(10,(ch.data.level|0)*6); }
    // 單發上限：普攻 基礎攻擊 ×20、技能 ×160；每秒總傷害 ×1500（超過就整發拒絕並記錄）
    c.caps={base,basic:base*20+40,skill:base*160+100,dps:base*1500+500}; /* 實測（全職業技能腳本）：普攻最高約 ×2、技能最高約 ×25（拳聖）→ 留 5–10 倍餘裕給暫時增益 */ c.capT=now; c.capLv=ch.data.level|0; return c.caps;
  }
  function sanitizeSt(st,base){
    if(!st||typeof st!=='object') return null; const o={};
    if(st.burn) o.burn=num(typeof st.burn==='number'?st.burn:st.burn.t,0,10,3);
    if(st.poison) o.poison={t:num(st.poison.t,0,10,5),n:num(st.poison.n,1,3,1)|0};
    if(st.slow) o.slow={t:num(st.slow.t,0,8,2),v:num(st.slow.v,0,0.7,0.3)};
    if(st.freeze) o.freeze=num(st.freeze,0,4,1.5);
    if(st.stun) o.stun=num(st.stun,0,4,1);
    if(st.curse) o.curse={t:num(st.curse.t,0,12,6),amp:num(st.curse.amp,0,0.6,0.2),drain:num(st.curse.drain,0,0.3,0),dot:num(st.curse.dot,0,1,0),spread:st.curse.spread?1:0};
    if(st.taunt) o.taunt=num(st.taunt,0,8,3);
    if(st.mark) o.mark=num(st.mark,0,10,4);
    return Object.keys(o).length?o:null;
  }
  function damage(w,m,d,by,opt){
    if(!m.alive) return;
    const real=Math.min(d,Math.max(0,m.hp)); m.hp-=d; m.hurt=200;
    if(by){ m.dmg.set(by,(m.dmg.get(by)||0)+real); m.last=by; }
    if(m.hp>0){
      if(by&&!(opt&&opt.dot)){ m.aggro=true; m.counterT=2500; m.tgt=by; m.cd=Math.min(m.cd||0,m.hi?150:220);
        const c=[...clients].find(x=>x.char===by); if(c&&c.pos&&D(c.pos,m)<w.ctx.monR(m)+18) m.cd=Math.min(m.cd,80); }
      return;
    }
    kill(w,m);
  }
  function rollGold(gr){ return gr[0]+Math.floor(Math.random()*(gr[1]-gr[0]+1)); }
  function kill(w,m,noReward){
    m.alive=false; m.hp=0; m.slam=null; m.respawnAt=Date.now()+(m.boss?(process.env.WZW_TEST_BOSS_RESPAWN?+process.env.WZW_TEST_BOSS_RESPAWN:300000+Math.random()*300000):m.rampage?5000+Math.random()*3000:m.nz?5000+Math.random()*3000:w.cont==='scambray'?12000+Math.random()*8000:18000+Math.random()*7000); stats.kills++; // 重生：史坎布雷 12–20 秒、其他大陸 18–25 秒
    const killerC=[...clients].find(x=>x.char===m.last);
    const ev={t:'mkill',i:m.id,k:killerC&&!noReward?killerC.sid:0,x:Math.round(m.x),y:Math.round(m.y)};
    for(const c of playersIn(w.cont)) if(D(c.pos,m)<1600) send(c,ev);
    if(noReward||!m.last||!db.chars[m.last]) return;
    // EXP：傷害 ≥ 20% 最大 HP 的人＋最後一擊，按傷害比例分；各自套等級差倍率
    const elig=[...m.dmg.entries()].filter(([ch,d])=>db.chars[ch]&&(d>=m.maxHp*0.2||ch===m.last));
    const sum=elig.reduce((a,[,d])=>a+d,0)||1, ml=m.level||1;
    const shares=[];
    // 組隊：隊員的份額合併，平分給在附近（同大陸 900px 內）的隊員；每多一人 +10% 隊伍加成（上限 +40%）
    const recv=new Map(); // chId → {f:份額比例, d:傷害, party:人數}
    for(const [chId,d] of elig){ const P=partyOf(chId); const near=P?P.filter(id=>{ const pc=[...clients].find(x=>x.char===id); return pc&&pc.pos&&pc.pos.c===w.cont&&Math.hypot(pc.pos.x-m.x,pc.pos.y-m.y)<900&&db.chars[id]; }):null;
      if(near&&near.length>1){ const bonus=1+Math.min(0.4,0.1*(near.length-1)); for(const id of near){ const r=recv.get(id)||{f:0,d:0,party:near.length}; r.f+=(d/sum)*bonus/near.length; if(id===chId) r.d+=d; recv.set(id,r); } }
      else { const r=recv.get(chId)||{f:0,d:0,party:0}; r.f+=d/sum; r.d+=d; recv.set(chId,r); } }
    for(const [chId,R] of recv){
      const d=R.d;
      const plv=db.chars[chId].data.level|0||1, gm=w.ctx.expLevelGapMul(ml,plv);
      const exp=Math.max(1,Math.round((m.exp||m.type.exp)*R.f*gm*(m.nz?0.5:1))); const pct=Math.round(d/sum*100); // 新手練功區：經驗減半
      const isK=chId===m.last; const e={exp,why:'kill',mon:m.tn,mlv:ml,pct,gap:+gm.toFixed(2)}; if(m.nz) e.nz=1; const nzT=(m.nz?'（新手區 ½）':'')+(R.party>1?`（👥 組隊 ${R.party} 人 +${Math.min(40,10*(R.party-1))}%）`:'')+(m.cave?'（洞窟 ×2.5）':'');
      if(isK){ const g=rollGold(m.gold||m.type.gold); e.gold=g; e.kill=1;
        e.msg=`打倒了 Lv.${ml} ${m.tn}！+${g}G、+${exp} EXP${nzT}${elig.length>1?`（傷害 ${pct}%）`:''}${gm!==1?`（等級差 ×${gm.toFixed(2)}）`:''}`; }
      else e.msg=d>0?`🤝 協助擊倒 Lv.${ml} ${m.tn}（傷害 ${pct}%）：+${exp} EXP${nzT}`:`👥 隊友擊倒 Lv.${ml} ${m.tn}：+${exp} EXP${nzT}`;
      pushEntry(chId,e); shares.push({ch:chId,exp,pct,kill:isK?1:0,gold:e.gold||0});
    }
    m.lastShares=shares;
    // 掉落（同單機機率）→ 地上，最後一擊者優先 30 秒
    const r=Math.random(); let drop=null;
    if(r<0.22) drop='hp_potion'; else if(r<0.34) drop='mp_potion';
    else if(r<0.40){ const pool=['scrap_plate','sage_robe','leather_tunic','mage_robe','wooden_sword','leather_cap']; const kind=m.cave?(m.boss?'boss':m.rampage?'rampage':'cave'):'field'; drop=(w.ctx.rollTieredGear?w.ctx.rollTieredGear(pool,kind,ml):w.ctx.rollGearDrop(pool)); } // 可能帶額外防禦詞綴
    if(!drop&&process.env.WZW_TEST_DROPS==='1') drop='hp_potion'; // 只有測試伺服器會設這個環境變數
    const own={owner:m.last,ownUntil:Date.now()+30000,expire:Date.now()+180000};
    if(drop) addItem(w,Object.assign({itemId:drop,x:m.x,y:m.y},own));
    const kname=db.chars[m.last].data.name, golds=[];
    if(m.cave){ // 洞窟：金裝機率（一般 0.6%、暴走區 2%、小王 35%）；小王保底藥水＋史詩裝
      const gc=(m.boss?0.35:m.rampage?0.02:0.006)*(+process.env.WZW_TEST_GOLD_MUL||1);
      if(Math.random()<gc){ const gid=w.ctx.goldDropFor?w.ctx.goldDropFor(ml):null; if(gid){ addItem(w,Object.assign({itemId:gid,x:m.x+(Math.random()-0.5)*30,y:m.y+(Math.random()-0.5)*30},own)); golds.push(gid); } }
      if(m.boss){ for(const [id,dx] of [['hp_potion',-30],['mp_potion',30]]) addItem(w,Object.assign({itemId:id,x:m.x+dx,y:m.y+20},own));
        const pool=['scrap_plate','sage_robe','leather_tunic','mage_robe','wooden_sword','leather_cap']; const ep=w.ctx.rollTieredGear(pool,'boss',ml); addItem(w,Object.assign({itemId:ep,x:m.x,y:m.y-26},own)); if(w.ctx.itemRarity(ep)>=4){ const I=w.ctx.ITEMS[ep]; bcast({t:'ann',text:`💜 ${kname} 從小王身上取得紫色裝備【${I?I.name:ep}】！`,col:'#c46bff',x:Math.round(m.x),y:Math.round(m.y)},w.cont); }
        bcast({t:'ann',text:`👑 ${kname} 擊倒了小王「${m.tn}」（${caveName(w,m)}）！`,col:'#ffd27a'},null); }
      for(const g of golds){ const I=w.ctx.ITEMS[g]; bcast({t:'ann',text:`✨ ${kname} 在 ${caveName(w,m)} 打出了金色裝備【${I?I.name:g}】！`,col:'#ffd700',gold:1,x:Math.round(m.x),y:Math.round(m.y)},w.cont); } }
    log('擊殺',w.cont,m.id,m.tn,'Lv'+ml,'by',m.last,JSON.stringify(shares),drop||'',golds.join(','),m.boss?'BOSS':'');
  }
  function caveName(w,m){ try{ const f=w.ctx.caveFloorAt(Math.floor(m.sx/TILE),Math.floor(m.sy/TILE)); return f?f.name:'洞窟'; }catch(e){ return '洞窟'; } }
  function bcast(o,cont){ for(const c of clients) if(c.char&&(!cont||(c.pos&&c.pos.c===cont))) send(c,o);
    if(o.t==='ann') for(const c of clients) if(c.char&&(!cont||(c.pos&&c.pos.c===cont))) send(c,{t:'chat',ch:'g',cont:cont||'scambray',from:'系統',gm:false,sys:1,text:o.text,ts:Date.now()}); }
  function addItem(w,o){ const it=Object.assign({id:rid('G'),cont:w.cont,t:Date.now()},o); w.items.set(it.id,it); return it; }

  // ---------- 用戶端回報命中 ----------
  function onHits(c,list){
    if(!Array.isArray(list)) return; const w=W[c.pos.c]; if(!w) return;
    const now=Date.now(), cp=caps(c);
    c.hitT=(c.hitT||[]).filter(h=>now-h.t<1000);
    for(const h of list.slice(0,40)){
      const m=w.mons.get(String(h.i)); if(!m||!m.alive) continue;
      let d=Math.floor(+h.d); if(!(d>0)) continue;
      if(h.s!=null){ // 大範圍華麗技：必須已學會、職業相符、冷卻（施放視窗 6 秒內的多段命中算同一次）
        const sid=String(h.s).slice(0,40), info=w.ctx.bigSkillInfo?w.ctx.bigSkillInfo(sid):null, cd2=db.chars[c.char].data; let why2=null;
        if(!info) why2='未知技能'; else if(!((cd2.skills&&cd2.skills[sid])>0)) why2='尚未學會 '+sid; else { let okJ=true; try{ okJ=w.ctx.hasJob(cd2,info.job); }catch(e){} if(!okJ) why2='職業不符 '+sid; }
        if(!why2){ c.bigT=c.bigT||{}; const L=c.bigT[sid]; if(!L||now-L>info.win){ if(L&&now-L<info.cdMin*1000) why2='冷卻中 '+sid; else c.bigT[sid]=now; } }
        if(why2){ stats.rejected++; c.rejects=(c.rejects||0)+1; if(c.rejects<=5||c.rejects%50===0) log('⛔ 拒絕命中',c.account,c.char,m.id,why2); send(c,{t:'hitrej',i:m.id,why:why2}); continue; } }
      const kind=h.k==='b'?'basic':'skill', cap=kind==='basic'?cp.basic:cp.skill;
      const why=D(c.pos,m)>760+w.ctx.monR(m)?'距離太遠':d>cap?`單發 ${d} > 上限 ${cap}`:
        c.hitT.length>=60?'命中頻率過高':c.hitT.filter(x=>x.m===m.id).length>=15?'同一目標命中過快':
        c.hitT.reduce((a,x)=>a+x.d,0)+d>cp.dps?'每秒傷害過高':null;
      if(why){ stats.rejected++; c.rejects=(c.rejects||0)+1; if(c.rejects<=5||c.rejects%50===0) log('⛔ 拒絕命中',c.account,c.char,m.id,why,'(累計',c.rejects+')'); send(c,{t:'hitrej',i:m.id,why}); continue; }
      c.hitT.push({t:now,m:m.id,d}); stats.hits++;
      if(m.st.freeze&&m.st.freeze.t>0) m.st.freeze.t=0; // 碎冰（用戶端已乘 1.5）
      damage(w,m,d,c.char);
      if(!m.alive) continue;
      const st=sanitizeSt(h.st); if(st){ w.ctx.applyStatus(m,st,{base:num(h.base,1,cap,d),durMul:num(h.dm,0.2,2,1)}); m.stBy=c.char; if(st.taunt){ m.tgt=c.char; m.aggro=true; } }
      const kb=num(h.kb,0,140,0); if(kb>0){ const fx=num(h.fx,m.x-800,m.x+800,c.pos.x), fy=num(h.fy,m.y-800,m.y+800,c.pos.y); w.ctx.knockMonster(m,fx,fy,kb); }
    }
  }

  // ---------- AI ----------
  // Lv40+ 反應加快（舊值：紅石 200px/2500ms/×0.6、冰封 200px/900ms/×1.0、洞窟同紅石）
  const AIP={redrock:{detectR:240,detectMs:1600,spd:0.72},frozen:{detectR:240,detectMs:650,spd:1.05},caveLow:{detectR:200,detectMs:2500,spd:0.6},caveHi:{detectR:240,detectMs:1500,spd:0.75}};
  function tickCont(w,dt,now){
    const pls=playersIn(w.cont).filter(c=>(c.hp|0)>0||c.hp==null); if(!pls.length) return;
    for(const c of pls){ try{ c.safeZ=w.ctx.inMonsterFreeHub(c.pos.x,c.pos.y); }catch(e){ c.safeZ=false; } }
    const X=w.ctx, AI0=AIP[w.cont]||null, byChar=new Map(pls.map(c=>[c.char,c]));
    for(const m of w.mons.values()){
      if(!m.alive) continue;
      const AI=m.cave?(m.hi?AIP.caveHi:AIP.caveLow):AI0; // 洞窟魔物：中階主動（Lv40+ 較快）
      let near=null, nd=1e9, ns=1e9; for(const c of pls){ const d=D(c.pos,m), sc=d+(c.safeZ?5000:0); if(sc<ns){ ns=sc; nd=d; near=c; } } // 安全區內的玩家最後才考慮
      if(nd>1500) continue; // 遠處的魔物不動（同單機：只有畫面附近的會動）
      if(m.hurt>0) m.hurt-=dt; if(m.cd>0) m.cd-=dt; if(m.counterT>0) m.counterT=Math.max(0,m.counterT-dt);
      // 狀態／DoT（每 0.5 秒）
      const S=m.st; for(const k in S) if(S[k]&&S[k].t>0) S[k].t-=dt;
      m._dot=(m._dot||0)+dt;
      if(m._dot>=500){ m._dot-=500; let d=0;
        if(X.stOn(m,'burn')) d+=S.burn.dps*0.5; if(X.stOn(m,'poison')) d+=S.poison.dps*S.poison.n*0.5; if(X.stOn(m,'curse')&&S.curse.dot) d+=S.curse.dot*0.5;
        if(d>0){ if(X.stOn(m,'curse')) d*=1+S.curse.amp; damage(w,m,Math.max(1,Math.floor(d)),m.stBy||m.last,{dot:1}); if(!m.alive) continue; } }
      if(m.slam&&now>=m.slam.at){ const S2=m.slam; m.slam=null;
        for(const c of pls){ if(c.god||c.safeZ||Math.hypot(c.pos.x-S2.x,c.pos.y-S2.y)>S2.r+16) continue; stats.mhits++; send(c,{t:'mhit',i:m.id,d:Math.round((m.atk||m.type.atk)*2.2),c:0}); } }
      if(X.stOn(m,'stun')||X.stOn(m,'freeze')) continue;
      const taunted=X.stOn(m,'taunt');
      // 目標：被打／嘲諷／索敵鎖定的玩家；否則最近的玩家
      let tc=(m.tgt&&byChar.get(m.tgt))||null;
      if(tc&&D(tc.pos,m)>1400){ tc=null; }
      if(!tc){ m.tgt=null; tc=near; }
      const d=D(tc.pos,m), safeT=X.inMonsterFreeHub(tc.pos.x,tc.pos.y), hidden=(!!tc.hidden&&!taunted)||m.nz||X.inNewbieZone(tc.pos.x,tc.pos.y)||safeT; // 主城安全區：不追、不打區內玩家 // 新手練功區：魔物被動、不追打區內玩家
      if(hidden){ m.aggro=false; m.counterT=0; }
      if(m.giveT>0) m.giveT-=dt; if(m.alertT>0) m.alertT-=dt;
      if(AI&&!taunted){
        if(m.ai==='return'&&m.counterT>0) m.ai=null;
        if(hidden&&(m.ai==='hunt'||(safeT&&m.ai!=='return'&&Math.hypot(m.x-m.hx,m.y-m.hy)>14))){ m.ai='return'; m.giveT=1200; m.detect=0; m.tgt=null; }
        if((m.ai==='hunt'||m.aggro||m.counterT>0)&&!onScreenOf(w,tc,m,40)){ m.ai='return'; m.aggro=false; m.counterT=0; m.detect=0; m.giveT=1400; m.tgt=null; }
        if(m.ai==='return'){
          const hd=Math.hypot(m.hx-m.x,m.hy-m.y);
          if(hd<14) m.ai=null;
          else { const a=Math.atan2(m.hy-m.y,m.hx-m.x), sp=m.type.spd*dt*0.04*(X.stOn(m,'slow')?1-S.slow.v:1), cr=X.monColR(m);
            const nx=m.x+Math.cos(a)*sp, ny=m.y+Math.sin(a)*sp;
            if(X.canWalk(nx,m.y,cr)&&!X.monBlockAt(m,nx,m.y)) m.x=nx; if(X.canWalk(m.x,ny,cr)&&!X.monBlockAt(m,m.x,ny)) m.y=ny;
            if(!X.canWalk(nx,ny,cr)) m.ai=null; }
          continue;
        }
        if(m.ai!=='hunt'&&!m.aggro&&!(m.counterT>0)&&!hidden){
          if(d<AI.detectR&&onScreenOf(w,tc,m,0)){ m.detect=Math.min(1,(m.detect||0)+dt/AI.detectMs); if(m.detect>=1){ m.ai='hunt'; m.alertT=1000; m.detect=0; m.tgt=tc.char; } }
          else m.detect=Math.max(0,(m.detect||0)-dt/1500);
        }
      }
      const hunting=!!(AI&&m.ai==='hunt');
      const chaseRange=hidden?0:taunted?600:(m.aggro||m.counterT>0)?(m.hi?360:300):hunting?99999:0;
      if(d>420&&!taunted&&!hunting){ m.aggro=false; m.counterT=0; }
      if(!hidden&&(d<chaseRange||m.counterT>0)){
        const ang=Math.atan2(tc.pos.y-m.y,tc.pos.x-m.x);
        const tlv=((db.chars[tc.char]&&db.chars[tc.char].data.level)|0)||1, nb=tlv<=10&&!taunted; // 新手（Lv.≤10）：追擊 ×0.85、離巢 360px 放棄（同單機）
        if(nb&&!hunting&&(m.aggro||m.counterT>0)&&Math.hypot(m.x-m.hx,m.y-m.hy)>(X.NEWBIE_LEASH||360)){ m.aggro=false; m.counterT=0; m.tgt=null; continue; }
        const spdMul=((m.counterT>0||taunted)?1.25:(hunting?AI.spd:1))*(X.stOn(m,'slow')?1-S.slow.v:1)*(nb?0.85:1);
        const sp=m.type.spd*dt*0.05*spdMul, cr=X.monColR(m);
        const nx=m.x+Math.cos(ang)*sp, ny=m.y+Math.sin(ang)*sp;
        if(X.canWalk(nx,m.y,cr)&&!X.monBlockAt(m,nx,m.y)) m.x=nx;
        if(X.canWalk(m.x,ny,cr)&&!X.monBlockAt(m,m.x,ny)) m.y=ny;
        if(m.boss&&!hidden&&!m.slam&&now>m.slamT&&d<260){ // 小王特殊攻擊：1 秒預警後震地（範圍 150px，2.2 倍傷害）
          m.slamT=now+7000+Math.random()*2000; m.slam={at:now+1000,x:tc.pos.x,y:tc.pos.y,r:150};
          for(const c of pls) if(D(c.pos,m)<1200) send(c,{t:'bossfx',i:m.id,x:Math.round(m.slam.x),y:Math.round(m.slam.y),r:150,ms:1000,nm:'💢 震地猛擊！'}); }
        if(d<X.monR(m)+16&&m.cd<=0){
          const acd=m.hi?780:900; m.cd=X.stOn(m,'slow')?acd/(1-S.slow.v*0.6):acd;
          const counter=m.counterT>0; m.counterT=0;
          if(!tc.god&&!m.nz&&!X.inNewbieZone(tc.pos.x,tc.pos.y)&&!X.inMonsterFreeHub(tc.pos.x,tc.pos.y)){ stats.mhits++; tc.mhitN=(tc.mhitN||0)+1; send(tc,{t:'mhit',i:m.id,d:m.atk||m.type.atk,c:counter?1:0}); }
        }
      } else {
        m.wander-=dt;
        if(m.wander<=0){ m.vx=(Math.random()-0.5)*m.type.spd; m.vy=(Math.random()-0.5)*m.type.spd; m.wander=1000+Math.random()*2000; }
        const sl=X.stOn(m,'slow')?1-S.slow.v:1, nx=m.x+m.vx*dt*0.03*sl, ny=m.y+m.vy*dt*0.03*sl;
        if(X.canWalk(nx,ny,X.monColR(m))&&!X.monBlockAt(m,nx,ny)){ m.x=nx; m.y=ny; }
      }
    }
    // 掉落：擁有者在附近 1.5 秒後自動收進背包（同單機「打倒即入袋」的手感），其他人仍看得到它落地
    for(const it of w.items.values()){
      if(it.death||now-it.t<1500||!it.owner) continue; const oc=byChar.get(it.owner); if(!oc||D(oc.pos,it)>260) continue;
      giveItem(oc,w,it,true);
    }
  }
  function giveItem(c,w,it,auto){
    const ch=db.chars[c.char], inv=ch.data.inv||(ch.data.inv=[]);
    if(!inv.some(x=>x.id===it.itemId)&&inv.length>=20){ if(!auto) return {ok:false,err:'背包滿了'}; it.owner=null; return {ok:false}; }
    w.items.delete(it.id);
    if(it.death&&aucRemoveDrop) aucRemoveDrop(it.id);
    const I=w.ctx.ITEMS[it.itemId];
    const e=pushEntry(c.char,{add:it.itemId,qty:1,why:it.death?'pick_death':'loot',pick:it.id,x:Math.round(it.x),y:Math.round(it.y),msg:`拾取 ${I?I.icon+' ':''}${I?I.name:it.itemId}`});
    return {ok:true,entry:e};
  }
  function onPick(c,id){
    const w=W[c.pos.c], it=w&&w.items.get(String(id)); if(!it) return {ok:false,err:'已經不在地上了'};
    if(D(c.pos,it)>90) return {ok:false,err:'太遠了'};
    if(it.death&&it.owner!==c.char) return {ok:false,err:'這是別人的死亡掉落（可在交易所購買）'};
    if(!it.death&&it.owner&&it.owner!==c.char&&Date.now()<it.ownUntil) return {ok:false,err:'這是別人的戰利品（30 秒後開放）'};
    return giveItem(c,w,it,false);
  }
  function removeItem(id){ for(const w of Object.values(W)) w.items.delete(id); }

  // ---------- 死亡（伺服器擲骰掉裝備＋金幣減半） ----------
  function onDied(c){
    const now=Date.now(); if(c.diedT&&now-c.diedT<3000) return {ok:false}; c.diedT=now;
    const ch=db.chars[c.char], d=ch.data, w=W[c.pos.c]; d.equip=d.equip||{};
    if(w&&w.ctx.inNewbieZone(c.pos.x,c.pos.y)){ log('🛡 新手區內死亡回報被拒（不掉落）',c.account,c.char); return {ok:false,err:'新手練功區內不會死亡'}; }
    const slots=[], items=[], msgs=[];
    const chance=process.env.WZW_TEST_DROPS==='1'?1:w.ctx.DEATH_DROP_CHANCE; // 測試伺服器：必掉，方便驗證
    for(const slot of w.ctx.EQUIP_SLOTS){ const id=d.equip[slot]; if(!id||Math.random()>=chance) continue;
      const price=w.ctx.auctionBuybackPrice(id)|0||8;
      const it=addItem(w,{itemId:id,x:c.pos.x,y:c.pos.y,owner:c.char,death:true,expire:now+24*3600e3});
      aucAddDeath(ch,id,price,it.id); slots.push(slot); items.push(id);
      const I=w.ctx.ITEMS[id]; msgs.push(`💥 裝備掉落：${I?I.icon+' ':''}${I?I.name:id}（可回屍撿／交易所 ${price}G 贖回）`); }
    const lost=Math.ceil((d.gold|0)/2);
    pushEntry(c.char,{goldHalf:1,unequip:slots,items,why:'death',msg:msgs.join('\n')||null});
    for(const m of w.mons.values()) if(m.tgt===c.char){ m.tgt=null; m.aggro=false; m.counterT=0; if(m.ai==='hunt'){ m.ai='return'; m.giveT=1400; } }
    log('💀 死亡',c.account,c.char,w.cont,Math.round(c.pos.x),Math.round(c.pos.y),'掉落',items.join(',')||'無','金幣 -'+lost);
    return {ok:true,items};
  }

  // ---------- GM ----------
  function gmSpawn(c,a){
    const w=W[c.pos.c], X=w.ctx, d=db.chars[c.char].data; const n=Math.max(1,Math.min(20,Math.floor(+a.n||5)));
    const lv=Math.max(1,Math.min(X.MONSTER_LV_MAX||120,Math.floor(+a.lv||d.level||1))); const C=X.contOf(); let made=0;
    for(let i=0;i<n;i++){
      const ang=Math.random()*Math.PI*2, r=(2.5+Math.random()*2.5)*TILE, mx=c.pos.x+Math.cos(ang)*r, my=c.pos.y+Math.sin(ang)*r;
      if(X.inMonsterFreeHub(mx,my)||X.inNewbieZone(mx,my)) continue;
      const mt=C.monsters?C.monsters[Math.floor(Math.random()*C.monsters.length)]:X.MONSTER_TYPES[Math.min(X.MONSTER_TYPES.length-1,Math.floor(lv/8))];
      const mhp=Math.round(mt.hp*(1+0.3*(lv-1))), g=1+0.06*(lv-1);
      const e={type:mt,x:mx,y:my,level:lv,atk:Math.round(mt.atk*(1+0.12*(lv-1))),exp:Math.round(X.monsterExpFor(lv,mt)),gold:[Math.round(mt.gold[0]*g),Math.round(mt.gold[1]*g)],hp:mhp,maxHp:mhp};
      const id=rid('gm'); w.mons.set(id,cloneMon(w,id,e,null,true)); made++;
    }
    return {ok:true,n:made,lv};
  }
  function gmClear(c){ const w=W[c.pos.c]; let n=0; for(const m of w.mons.values()) if(m.alive&&D(c.pos,m)<1000){ m.last=null; kill(w,m,true); n++; } return {ok:true,n}; }

  // ---------- 快照 ----------
  function snapFor(c){
    const w=W[c.pos.c]; if(!w) return {ms:[],gl:[]}; const ms=[], gl=[], R=1100;
    for(const m of w.mons.values()){
      if(!m.alive||Math.abs(m.x-c.pos.x)>R||Math.abs(m.y-c.pos.y)>R) continue;
      let s=null; for(const k of ST_KEYS){ const v=m.st[k]; if(v&&v.t>0){ (s=s||{})[k]=Math.round(v.t); if(k==='slow') s.sv=+v.v.toFixed(2); } }
      const o={i:m.id,n:m.tn,x:Math.round(m.x),y:Math.round(m.y),l:m.level,h:Math.max(0,Math.ceil(m.hp)),mh:m.maxHp,a:m.atk};
      if(m.ai) o.ai=m.ai==='hunt'?1:2; if(m.detect>0) o.dt=+m.detect.toFixed(2); if(m.giveT>0) o.g=Math.round(m.giveT); if(m.alertT>0) o.al=Math.round(m.alertT);
      if(m.aggro||m.counterT>0) o.ag=1; if(m.hurt>0) o.hu=1; if(s) o.s=s; if(m.tgt===c.char) o.me=1; if(m.gm) o.gm=1; if(m.boss) o.b=1; if(m.rampage) o.rz=1;
      ms.push(o);
    }
    for(const it of w.items.values()){ if(Math.abs(it.x-c.pos.x)>R||Math.abs(it.y-c.pos.y)>R) continue;
      gl.push({i:it.id,it:it.itemId,x:Math.round(it.x),y:Math.round(it.y),o:it.owner===c.char?1:(it.owner&&(it.death||Date.now()<it.ownUntil))?2:0,d:it.death?1:0}); }
    return {ms,gl};
  }

  let lastT=Date.now();
  function tick(){
    const now=Date.now(), dt=Math.min(200,now-lastT); lastT=now;
    if(now-lastChunkT>500){ lastChunkT=now; manageChunks(now); }
    for(const cont in W){ try{ tickCont(W[cont],dt,now); }catch(e){ log('世界更新錯誤',cont,e.stack); } }
  }
  return {W,tick,bcast,onHits,onPick,onDied,gmSpawn,gmClear,snapFor,removeItem,stats,caps,
    debug:()=>Object.fromEntries(Object.entries(W).map(([k,w])=>[k,{mons:w.mons.size,alive:[...w.mons.values()].filter(m=>m.alive).length,chunks:w.chunks.size,items:w.items.size}]))};
}
module.exports={createWorld};
