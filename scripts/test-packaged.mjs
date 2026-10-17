import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inventory,validateZip} from '../backend/archive.mjs';
const root=path.resolve('test-results',`packaged-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const regression=process.argv.includes('--regression');
if(regression)await promisify(execFile)('python',['scripts/prepare-regression.py',root]);else await fs.mkdir(root,{recursive:true});
const sources=new Map();
for(const dir of await fs.readdir(regression?root:'для теста',{withFileTypes:true}))if(dir.isDirectory()){
  const folder=path.join(root,dir.name);if(!regression)await fs.cp(path.join('для теста',dir.name),folder,{recursive:true,filter:source=>!source.toLowerCase().endsWith('.zip')});sources.set(dir.name,await inventory(folder));
}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve('release/win-unpacked/FL Pack.exe'),args:['--user-data-dir='+path.resolve('test-results/profiles/packaged-'+Date.now())],env});
const started=Date.now();const events=[];
try{
  const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'FL Pack',exact:true})).toBeVisible();
  await page.exposeFunction('recordTestEvent',event=>{events.push({...event,at:new Date().toISOString()});if(event.type==='project')console.log(event.project.name,event.project.status);});
  await page.evaluate(()=>window.flpack.onEvent(event=>window.recordTestEvent(event)));
  await page.getByRole('textbox',{name:'Путь к папке с проектами'}).fill(root);
  await page.getByRole('button',{name:'Просканировать папку'}).click();
  await expect(page.getByRole('button',{name:'Запустить',exact:true})).toBeEnabled({timeout:15000});
  await page.getByRole('button',{name:'Запустить',exact:true}).click();
  await page.getByRole('button',{name:'Начать',exact:true}).click();
  await expect(page.getByRole('status',{name:'Прогресс проверки файлов'})).toBeVisible({timeout:30000});
  await page.screenshot({path:path.join(root,'tracking.png'),fullPage:true});
  await expect.poll(()=>events.some(e=>['finished','fatal'].includes(e.type)),{timeout:240000,intervals:[500]}).toBeTruthy();
  const fatal=events.find(e=>e.type==='fatal');if(fatal)throw new Error(fatal.message);
  for(const [name,baseline]of sources){
    const final=events.filter(e=>e.type==='project'&&e.project.name===name).at(-1)?.project;
    if(!final||!['done','warning'].includes(final.status))throw new Error(`${name}: ${final?.detail||'not processed'}`);
    const report=await validateZip(path.join(root,name+'.zip'));
    if(report.entries.filter(e=>e.flp).length!==1||report.entries.some(e=>e.name.startsWith('__flpack__/')))throw new Error('Unexpected backups or service entries');
    if(await fs.stat(path.join(root,name)).catch(()=>null))throw new Error('Source not removed');
    const journal=JSON.parse(await fs.readFile(path.join(root,'.flpack',final.id+'.json'),'utf8'));
    if(journal.metrics.finalVerificationPasses!==1||journal.metrics.recoveryVerificationPasses)throw new Error('Final ZIP was checked redundantly');
    if(name.startsWith('Улетаю')&&!final.warnings?.length)throw new Error('Missing-plugin warning was not reported');
  }
  await page.screenshot({path:path.join(root,'completed.png'),fullPage:true});
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({root,seconds:(Date.now()-started)/1000,events},null,2));
  console.log('Packaged Electron + bundled Python full-cycle passed:',root);
}finally{await app.close();}
