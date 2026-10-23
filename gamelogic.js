'use strict';
// 把 index.html 裡的遊戲邏輯（同一份程式碼）載入 Node 的 vm 沙盒，給伺服器用：
// 地形／區塊生成（與用戶端同種子）、魔物種類／等級／體型、狀態效果、傷害公式、道具表…
// 每個大陸一個沙盒（遊戲程式用全域 curCont）。DOM 相關一律用假物件吞掉。
const fs=require('fs'), vm=require('vm'), acorn=require('acorn');
function makeStub(){
  const f=function(){};
  const stub=new Proxy(f,{
    get:(t,k)=>{ if(k===Symbol.toPrimitive) return ()=>0; if(k==='length'||k==='width'||k==='height') return 0; if(k==='then'||k===Symbol.iterator) return undefined; return stub; },
    apply:()=>stub, construct:()=>stub, set:()=>true, has:()=>true
  });
  return stub;
}
function extractBody(html){
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const src=scripts.reduce((a,b)=>b.length>a.length?b:a,'');
  const ast=acorn.parse(src,{ecmaVersion:'latest'});
  for(const st of ast.body){
    const ex=st.expression; if(!ex) continue;
    const call=ex.type==='CallExpression'?ex:(ex.type==='UnaryExpression'&&ex.argument.type==='CallExpression'?ex.argument:null);
    if(call&&(call.callee.type==='FunctionExpression'||call.callee.type==='ArrowFunctionExpression')) return call.callee.body.body.map(n=>({type:n.type,code:src.slice(n.start,n.end)}));
  }
  throw new Error('找不到遊戲主程式 IIFE');
}
function createContext(stmts,contId){
  const stub=makeStub(); const noop=()=>0;
  const g={document:stub,localStorage:{getItem:()=>null,setItem:noop,removeItem:noop,clear:noop,key:()=>null,length:0},sessionStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
    navigator:{userAgent:'node',maxTouchPoints:0},location:{search:'',hostname:'localhost',protocol:'http:',host:'localhost',origin:'http://localhost'},
    performance:{now:()=>Number(process.hrtime.bigint()/1000000n)},requestAnimationFrame:noop,cancelAnimationFrame:noop,setInterval:noop,setTimeout:noop,clearTimeout:noop,clearInterval:noop,
    innerWidth:1280,innerHeight:800,devicePixelRatio:1,addEventListener:noop,removeEventListener:noop,matchMedia:()=>({matches:false,addEventListener:noop}),
    alert:noop,confirm:()=>false,prompt:()=>null,Image:function(){return stub;},WebSocket:function(){return stub;},MutationObserver:function(){return {observe:noop};},
    TextEncoder,URLSearchParams,console:{log:noop,warn:noop,error:noop,info:noop},WZW_ONLINE:0,WZW_SERVER:1};
  g.window=g; g.self=g; g.globalThis=g;
  const ctx=vm.createContext(g); let fail=0;
  // 先跑 function 宣告（模擬 IIFE 內的 hoisting），再依序跑其他敘述
  const ordered=stmts.filter(s=>s.type==='FunctionDeclaration').concat(stmts.filter(s=>s.type!=='FunctionDeclaration'));
  for(const s of ordered){ try{ vm.runInContext(s.code,ctx,{timeout:2000}); }catch(e){ fail++; (ctx.__errs=ctx.__errs||[]).push(String(e).slice(0,120)+" @ "+s.code.slice(0,80)); } }
  vm.runInContext(`floatText=function(){}; spawnParticles=function(){}; msg=function(){}; fxAdd=function(f){return f}; updateHUD=function(){}; saveGame=function(){}; updateQuestUI=function(){};
    applyContinent(${JSON.stringify(contId)});`,ctx);
  // const／let 不在 global 物件上 → 匯出伺服器要用的常數
  const K=vm.runInContext('({CAM_ZOOM,ISO_TW,ISO_TH,EQUIP_SLOTS,DEATH_DROP_CHANCE,ITEMS,MONSTER_TYPES,MONSTER_LV_MAX,TILE,CHUNK,ALL_NPCS,SHOPS,JOBS,CAVE_PORTALS})',ctx);
  for(const k in K) ctx[k]=K[k];
  ctx.__fail=fail;
  return ctx;
}
function loadGameLogic(htmlPath){
  const stmts=extractBody(fs.readFileSync(htmlPath,'utf8'));
  const out={};
  for(const c of ['scambray','redrock','frozen','purgatory']) out[c]=createContext(stmts,c);
  out.stmtCount=stmts.length;
  return out;
}
module.exports={loadGameLogic};
