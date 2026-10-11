const {chromium}=require('/tmp/pwt/node_modules/playwright-core');
(async()=>{
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--allow-file-access-from-files']});
  const pg=await b.newPage({viewport:{width:1600,height:1000}});
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('file://'+__dirname+'/equipment_showcase.html');
  await pg.waitForFunction(()=>window.__sheet,null,{timeout:10000});
  await pg.evaluate(()=>document.fonts.ready);
  const info=await pg.evaluate(()=>window.__sheet);
  await pg.setViewportSize({width:info.W,height:info.H});
  await pg.waitForTimeout(300);
  await pg.locator('canvas').screenshot({path:__dirname+'/../shots/equipment_showcase.png'});
  console.log(JSON.stringify(info,null,1));
  console.log('errors:',[...new Set(errs)].slice(0,5));
  await b.close();
})();
