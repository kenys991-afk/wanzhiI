// 一次性遷移：舊詞綴變體 X~kN → X~kN^N（Ⅰ→綠、Ⅱ→藍、Ⅲ→紅）；金裝不變。用法：node migrate_rarity.js data/db.json [--dry]
const fs=require('fs'); const {loadGameLogic}=require('./gamelogic.js'); const path=require('path');
const G=loadGameLogic(path.join(__dirname,'..','index.html')); const I=G.scambray.ITEMS;
const f=process.argv[2], dry=process.argv.includes('--dry'); const db=JSON.parse(fs.readFileSync(f,'utf8'));
if(db.rarityMigrated){ console.log('already migrated'); process.exit(0); }
const re=/^([a-z_]+)~([a-z]+)([123])$/; const stat={}; let n=0;
function walk(o){ if(Array.isArray(o)){ for(let i=0;i<o.length;i++){ const v=o[i]; if(typeof v==='string') o[i]=fix(v); else if(v&&typeof v==='object') walk(v); } return; }
  for(const k in o){ const v=o[k]; if(typeof v==='string') o[k]=fix(v); else if(v&&typeof v==='object') walk(v); } }
function fix(v){ const m=re.exec(v); if(!m||!I[v]) return v; const nv=v+'^'+m[3]; if(!I[nv]) return v; n++; stat[m[3]]=(stat[m[3]]||0)+1; return nv; }
walk(db); db.rarityMigrated=Date.now();
console.log('migrated',n,'by tier Ⅰ/Ⅱ/Ⅲ →綠/藍/紅',JSON.stringify(stat));
if(!dry) fs.writeFileSync(f,JSON.stringify(db));
