import fs from 'node:fs/promises';
import path from 'node:path';
import {Queue,scan} from '../backend/engine.mjs';
import {inventory,validateZip,hashFile} from '../backend/archive.mjs';

// Always use fresh expendable copies. Baseline material is left available for repeat runs.
const root=path.resolve('test-results',`real-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await fs.mkdir(root,{recursive:true});
const newer=process.argv.includes('--fl2026');
for(const dir of await fs.readdir('для теста',{withFileTypes:true}))if(dir.isDirectory()&&(!newer||dir.name.startsWith('Идиот')))await fs.cp(path.join('для теста',dir.name),path.join(root,dir.name),{recursive:true,filter:source=>!source.toLowerCase().endsWith('.zip')});
if(newer){
  // Synthetic compatibility fixture: preserve all music/plugin state, change only
  // the FLP producer-version event so the real queue must select installed 2026.
  const dir=(await fs.readdir(root,{withFileTypes:true})).find(e=>e.isDirectory());
  const folder=path.join(root,dir.name);const name=(await fs.readdir(folder)).find(n=>n.endsWith('.flp'));
  const file=path.join(folder,name);const data=await fs.readFile(file);
  if(data[22]!==199||data[23]!==12)throw new Error('Unexpected fixture version event');
  data.write('26.1.4.5589\0',24,'ascii');await fs.writeFile(file,data);
}
const initial=await scan(root);const inventories={};
for(const p of initial.projects)inventories[p.name]=await inventory(p.folder);
const events=[];const queue=new Queue({helper:process.env.FLPACK_TEST_HELPER,emit:event=>{events.push({...event,at:new Date().toISOString()});if(event.type==='project')console.log(event.project.name,event.project.status,event.project.detail);}});
const nativeHashes=new Map();const nativeExport=queue.nativeExport.bind(queue);
queue.nativeExport=async(project,installation,file)=>{const warnings=await nativeExport(project,installation,file);nativeHashes.set(project.id,await hashFile(file));return warnings;};
const started=Date.now();await queue.run(root);
const results=[];
for(const p of initial.projects){
  const last=events.filter(e=>e.type==='project'&&e.project.id===p.id).at(-1)?.project;
  if(!last||!['done','warning'].includes(last.status))throw new Error(`${p.name}: ${last?.detail||'No completion'}`);
  const report=await validateZip(p.output);const baseline=inventories[p.name];
  if(await hashFile(p.output)!==nativeHashes.get(p.id))throw new Error('Native ZIP bytes changed');
  if(report.entries.filter(e=>e.flp).length!==1||report.entries.some(e=>e.name.startsWith('__flpack__/')))throw new Error('Unexpected backup or service entry');
  if(newer&&last.engine!==2026)throw new Error('New-version fixture did not use 2026');
  if(await fs.stat(p.folder).catch(()=>null))throw new Error('Source folder still exists');
  results.push({name:p.name,status:last.status,engine:last.engine,sourceFiles:baseline.length,archiveEntries:report.entries.length,bytes:last.bytes,seconds:last.elapsed,warnings:last.warnings});
}
const result={root,seconds:(Date.now()-started)/1000,results,events};
await fs.writeFile(path.join(root,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,seconds:result.seconds,results},null,2));
