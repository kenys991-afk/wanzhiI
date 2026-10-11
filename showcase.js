// Equipment showcase overlay — runs after the game script; uses window.__dbg
(function(){
  const D=window.__dbg;
  document.body.innerHTML='';
  document.body.style.cssText='margin:0;background:#0d0a06;';
  const ITEMS=D.ITEMS;
  const ids=Object.keys(ITEMS).filter(k=>ITEMS[k].slot);
  const at=k=>ITEMS[k].armorType||ITEMS[k].armorStyle;
  const WEAPON_ZH={sword:'劍',staff:'法杖',kunai:'苦無',twinblade:'雙刀',dagger:'短刃',spear:'槍',axe:'斧',mace:'錘',tome:'魔典',stick:'木棍'};
  const groups=[
    {title:'重裝 Heavy Armor',items:ids.filter(k=>ITEMS[k].slot==='armor'&&at(k)==='heavy'),lab:()=> '重裝'},
    {title:'皮裝 Leather Armor',items:ids.filter(k=>ITEMS[k].slot==='armor'&&at(k)==='leather'),lab:()=> '皮裝'},
    {title:'布裝 Cloth Armor',items:ids.filter(k=>ITEMS[k].slot==='armor'&&at(k)==='cloth'),lab:()=> '布裝'},
    {title:'武器 Weapons',items:ids.filter(k=>ITEMS[k].slot==='weapon'),lab:k=>'武器・'+(WEAPON_ZH[ITEMS[k].weapon]||ITEMS[k].weapon)},
    {title:'頭部 Helmets',items:ids.filter(k=>ITEMS[k].slot==='helmet'),lab:()=> '頭盔'},
    {title:'副手 Off-hand',items:ids.filter(k=>ITEMS[k].slot==='offhand'),lab:()=> '副手'},
  ];
  const other=ids.filter(k=>!groups.some(g=>g.items.includes(k)));
  if(other.length) groups.push({title:'其他',items:other,lab:k=>ITEMS[k].slot});
  const sets=[
    {name:'重裝套組',equip:{armor:'plate_armor',weapon:'iron_sword',helmet:'iron_helm',offhand:'iron_shield'}},
    {name:'皮裝套組',equip:{armor:'scout_leather',weapon:'shadow_blade',helmet:'feather_hat',offhand:'wooden_shield'}},
    {name:'布裝套組',equip:{armor:'sage_robe',weapon:'arcane_staff',helmet:'wizard_hat'}},
  ];
  const CELL_W=160, CELL_H=260, PAD=30, HEAD=34, TOP=96, SCALE=0.75;
  const perRow=Math.max(...groups.map(g=>g.items.length),sets.length);
  const W=PAD*2+perRow*CELL_W;
  const rows=groups.length+1;
  const H=TOP+rows*(HEAD+CELL_H)+PAD+20;
  const cv=document.createElement('canvas');
  cv.width=W;cv.height=H;cv.style.display='block';
  document.body.appendChild(cv);
  const c=cv.getContext('2d');
  // background
  const g=c.createLinearGradient(0,0,0,H);g.addColorStop(0,'#1a1208');g.addColorStop(1,'#0b0805');
  c.fillStyle=g;c.fillRect(0,0,W,H);
  c.strokeStyle='#c9a227';c.lineWidth=3;c.strokeRect(8,8,W-16,H-16);
  c.strokeStyle='rgba(201,162,39,0.4)';c.lineWidth=1;c.strokeRect(14,14,W-28,H-28);
  const FONT='"Noto Sans CJK TC","Noto Serif CJK TC","Microsoft JhengHei",sans-serif';
  c.textAlign='center';c.textBaseline='alphabetic';
  c.fillStyle='#e8c860';c.font='bold 34px '+FONT;
  c.fillText('萬王之王・裝備外觀一覽',W/2,56);
  c.fillStyle='#a89060';c.font='15px '+FONT;
  c.fillText('每格：新手預設外觀＋只穿該件裝備（最後一列為整套搭配）',W/2,80);
  function drawCell(x,y,equip,lines,w){
    w=w||CELL_W;
    c.fillStyle='rgba(60,44,20,0.45)';
    c.fillRect(x+6,y,w-12,CELL_H-8);
    c.strokeStyle='rgba(201,162,39,0.55)';c.lineWidth=1;
    c.strokeRect(x+6.5,y+.5,w-13,CELL_H-9);
    const opt=D.playerSpriteOpt({facing:1,equip});
    opt.scale=SCALE;
    const cx=x+w/2, cy=y+100;
    c.save();c.beginPath();c.rect(x+7,y+1,w-14,CELL_H-10);c.clip();
    D.drawHumanoid(cx,cy,opt,c);
    c.restore();
    c.textAlign='center';
    let ly=y+CELL_H-62;
    for(const L of lines){ c.fillStyle=L.color;c.font=L.font;c.fillText(L.text,cx,ly);ly+=L.h; }
  }
  let y=TOP;
  for(const gr of groups){
    c.textAlign='left';c.fillStyle='#e8c860';c.font='bold 20px '+FONT;
    c.fillText(gr.title+`（${gr.items.length}）`,PAD,y+24);
    c.strokeStyle='rgba(201,162,39,0.5)';c.beginPath();c.moveTo(PAD,y+30);c.lineTo(W-PAD,y+30);c.stroke();
    y+=HEAD;
    gr.items.forEach((k,i)=>{
      const it=ITEMS[k];
      drawCell(PAD+i*CELL_W,y,{[it.slot]:k},[
        {text:it.name,color:'#f0dca0',font:'bold 17px '+FONT,h:21},
        {text:gr.lab(k),color:'#c9a227',font:'14px '+FONT,h:17},
        {text:k,color:'#8a7a5a',font:'11px monospace',h:14}]);
    });
    y+=CELL_H;
  }
  c.textAlign='left';c.fillStyle='#e8c860';c.font='bold 20px '+FONT;
  c.fillText('整套搭配 Full Sets',PAD,y+24);
  c.strokeStyle='rgba(201,162,39,0.5)';c.beginPath();c.moveTo(PAD,y+30);c.lineTo(W-PAD,y+30);c.stroke();
  y+=HEAD;
  const SW=Math.floor((W-PAD*2)/sets.length);
  sets.forEach((s,i)=>{
    const e=s.equip;
    const parts=['armor','weapon','helmet','offhand'].filter(k=>e[k]).map(k=>ITEMS[e[k]].name);
    drawCell(PAD+i*SW,y,e,[
      {text:s.name,color:'#f0dca0',font:'bold 18px '+FONT,h:24},
      {text:parts.join('・'),color:'#c9a227',font:'14px '+FONT,h:17}],SW);
  });
  window.__sheet={W,H,groups:groups.map(g=>({title:g.title,items:g.items.map(k=>ITEMS[k].name+' ('+k+')')})),sets};
})();
