import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Queue } from '../backend/engine.mjs';
import { quarantineSource } from '../backend/job.mjs';
import { inventory, reconcileExportArtifacts } from '../backend/archive.mjs';
import yazl from 'yazl';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

function flp() {
  const version=Buffer.from('25.2.5.5319\0');const data=Buffer.concat([Buffer.from([199,version.length]),version]);
  const header=Buffer.alloc(22);header.write('FLhd');header.writeUInt32LE(6,4);header.writeUInt16LE(96,12);header.write('FLdt',14);header.writeUInt32LE(data.length,18);
  return Buffer.concat([header,data]);
}
async function writeZip(file) {
  const zip=new yazl.ZipFile();const done=pipeline(zip.outputStream,createWriteStream(file));zip.addBuffer(flp(),'p.flp');zip.end();await done;
}
const installs=[{year:2025,version:'25.2.5.5319',exe:'fixture'}];

test('Queue export deadline defaults to two minutes',()=>assert.equal(new Queue().timeout,120));

for(const state of ['exporting','exported'])test(`Resumes ${state} journal with FL artifacts, preserves native ZIP bytes`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flpack-artifacts-'));
  try {
    const folder=path.join(root,'p');const workspace=path.join(root,'.flpack');await fs.mkdir(folder);await fs.mkdir(workspace);
    const project={id:'1234567890abcdef',name:'p',folder,flp:path.join(folder,'p.flp'),output:path.join(root,'p.zip'),version:'25.2.5.5319'};
    await fs.writeFile(project.flp,flp());await fs.writeFile(path.join(folder,'a.wav'),'audio');await fs.writeFile(path.join(folder,'a.wav.zpa'),'old');
    const job={schema:2,mode:'native-zip',...project,files:await inventory(folder),state,native:path.join(folder,'p.zip'),nativeSaved:path.join(workspace,project.id+'.native.zip'),partial:path.join(workspace,project.id+'.partial.zip'),quarantine:path.join(workspace,project.id+'.source'),metrics:{finalVerificationPasses:0}};
    await fs.writeFile(path.join(workspace,project.id+'.json'),JSON.stringify(job));
    await fs.writeFile(path.join(folder,'a.wav.zpa'),'regenerated analysis');await fs.writeFile(path.join(folder,'p.zip~'),'incomplete export');
    let expected;let attempts=0;
    if(state==='exported'){await writeZip(job.nativeSaved);expected=await fs.readFile(job.nativeSaved);}
    const queue=new Queue({exportProject:async(p,i,n)=>{attempts++;await fs.writeFile(path.join(folder,'a.wav.zpa'),'new analysis');await fs.unlink(path.join(folder,'p.zip~'));await writeZip(n);expected=await fs.readFile(n);return[];}});
    await queue.process(project,workspace,installs);
    assert.equal(attempts,state==='exporting'?1:0);assert.deepEqual(await fs.readFile(project.output),expected);
    await assert.rejects(fs.stat(folder));assert.equal(JSON.parse(await fs.readFile(path.join(workspace,project.id+'.json'))).state,'done');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Artifact reconciliation rejects changed audio, FLP, unrelated files and pre-existing ZIP temp',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flpack-protection-'));
  try {
    const source=path.join(folder,'p.flp');await fs.writeFile(source,flp());await fs.writeFile(path.join(folder,'a.wav'),'audio');await fs.writeFile(path.join(folder,'p.zip~'),'user file');
    const job={folder,flp:source,files:await inventory(folder),generatedNativeTemp:false};
    for(const name of ['a.wav','p.flp','p.zip~']) {
      const file=path.join(folder,name);const bytes=await fs.readFile(file);await fs.writeFile(file,'changed bytes');
      await assert.rejects(reconcileExportArtifacts(job),/изменился/);await fs.writeFile(file,bytes);job.files=await inventory(folder);
    }
    for(const name of ['notes.txt','orphan.wav.zpa','other.zip~']) {
      const file=path.join(folder,name);await fs.writeFile(file,'new');await assert.rejects(reconcileExportArtifacts(job),/Состав/);await fs.unlink(file);
    }
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('Quarantine retries temporary locks and immediately reports other errors',async()=>{
  let attempts=0;
  await quarantineSource('source','target',async()=>{if(++attempts===1)throw Object.assign(new Error('locked'),{code:'EPERM'});});assert.equal(attempts,2);
  attempts=0;
  await assert.rejects(quarantineSource('source','target',async()=>{attempts++;throw Object.assign(new Error('exists'),{code:'EEXIST'});}),/exists/);assert.equal(attempts,1);
});
