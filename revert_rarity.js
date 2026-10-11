// 把 16:06 遷移的舊裝（X~kN → X~kN^N）改回白色；依遷移前備份逐「擁有者」計數，只還原當時遷移的數量
const fs=require('fs'); const [,,cur,pre,dry]=process.argv;
const D=JSON.parse(fs.readFileSync(cur,'utf8')), P=JSON.parse(fs.readFileSync(pre,'utf8'));
const re=/^([a-z_]+)~([a-z]+)([123])$/;
function collect(o,acc){ if(typeof o==='string'){ const m=re.exec(o); if(m&&m[3]!=='3') acc[o]=(acc[o]||0)+qtyHint; return; } if(o&&typeof o==='object') for(const k in o) collect(o[k],acc); }
let qtyHint=1;
// count occurrences of each old id in backup per owner (ids appear once per stack/slot)
function owners(db){ const L=[]; for(const k of Object.keys(db)){ if(k==='chars'||k==='accounts'||k==='sessions'){ if(k==='chars') for(const c in db.chars) L.push(['chars.'+c,db.chars[c]]); } else L.push([k,db[k]]); } return L; }
let n=0; const byT={}; const per=[];
const Pmap=Object.fromEntries(owners(P));
for(const [key,obj] of owners(D)){ const src=Pmap[key]; if(!src) continue; const want={}; collect(src,want); if(!Object.keys(want).length) continue; let cnt=0;
  (function walk(o){ for(const k in o){ const v=o[k]; if(typeof v==='string'){ const b=v.replace(/\^[12]$/,''); if(b!==v&&want[b]>0&&v===b+'^'+re.exec(b)[3]){ o[k]=b; want[b]--; n++; cnt++; byT[v.slice(-1)]=(byT[v.slice(-1)]||0)+1; } } else if(v&&typeof v==='object') walk(v); } })(obj);
  if(cnt) per.push(key.replace('chars.','')+':'+cnt); }
console.log('reverted',n,JSON.stringify(byT)); console.log(per.join(' '));
if(dry!=='--dry') fs.writeFileSync(cur,JSON.stringify(D));
