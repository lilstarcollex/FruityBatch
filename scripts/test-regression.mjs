import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Queue,scan} from '../backend/engine.mjs';
import {inventory,validateZip,hashFile} from '../backend/archive.mjs';
const root=path.resolve('test-results',`regression-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await promisify(execFile)('python',['scripts/prepare-regression.py',root]);
const scanned=await scan(root);const baseline=new Map();
for(const p of scanned.projects)baseline.set(p.id,await inventory(p.folder));
const events=[];const queue=new Queue({emit:event=>{
  if(event.type!=='progress')events.push({...event,at:new Date().toISOString()});
  if(event.type==='project')console.log(event.project.name,event.project.status,event.project.detail);
}});
const nativeHashes=new Map();const nativeExport=queue.nativeExport.bind(queue);
queue.nativeExport=async(project,installation,file)=>{const warnings=await nativeExport(project,installation,file);nativeHashes.set(project.id,await hashFile(file));return warnings;};
const started=Date.now();await queue.run(root);
const results=[];
for(const p of scanned.projects){
  const final=events.filter(e=>e.type==='project'&&e.project.id===p.id).at(-1)?.project;
  if(!final||!['done','warning'].includes(final.status))throw new Error(`${p.name}: ${final?.detail}`);
  const report=await validateZip(p.output);const files=baseline.get(p.id);
  if(await hashFile(p.output)!==nativeHashes.get(p.id))throw new Error('Native ZIP bytes changed');
  if(report.entries.filter(e=>e.flp).length!==1||report.entries.some(e=>e.name.startsWith('__flpack__/')))throw new Error('Unexpected backup or service entry');
  if(await fs.stat(p.folder).catch(()=>null))throw new Error('Working source folder was not removed');
  const journal=JSON.parse(await fs.readFile(path.join(root,'.flpack',p.id+'.json'),'utf8'));
  if(journal.metrics.finalVerificationPasses!==1||journal.metrics.recoveryVerificationPasses)throw new Error('Normal run redundantly verified final ZIP');
  results.push({name:p.name,sourceFiles:files.length,sourceBytes:files.reduce((n,f)=>n+f.size,0),seconds:final.elapsed,bytes:final.bytes,nativeHash:nativeHashes.get(p.id),archiveEntries:report.entries.length,samples:report.main.flp.samples.length,metrics:journal.metrics});
}
const report={root,seconds:(Date.now()-started)/1000,results,events};await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,results},null,2));
