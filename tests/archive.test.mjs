import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { inspectFlp, chooseInstallation, assertExportMatches } from '../backend/flp.mjs';
import { inventory, assertUnchanged, validateZip } from '../backend/archive.mjs';
import { Queue,scan } from '../backend/engine.mjs';

export function makeFlp(version='25.2.5.5319', samples=[]) {
  const events=[];
  function event(id,b){let n=b.length;const length=[];do{let v=n&127;n>>>=7;if(n)v|=128;length.push(v);}while(n);events.push(Buffer.from([id,...length]),b);}
  event(199,Buffer.from(version+'\0'));
  for(const s of samples)event(196,Buffer.from(s+'\0','utf16le'));
  const data=Buffer.concat(events);const header=Buffer.alloc(22);header.write('FLhd');header.writeUInt32LE(6,4);header.writeUInt16LE(96,12);header.write('FLdt',14);header.writeUInt32LE(data.length,18);
  return Buffer.concat([header,data]);
}
export async function zip(file, entries){const z=new yazl.ZipFile();const done=pipeline(z.outputStream,createWriteStream(file));for(const [name,buffer]of Object.entries(entries))z.addBuffer(buffer,name);z.end();await done;}
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'flpack-test-'));
const installs=[{year:2025,version:'25.2.5.5319',exe:'2025'},{year:2026,version:'26.1.4.5589',exe:'2026'}];

test('Version selection prefers 2025 and uses 2026 only when needed',()=>{
  assert.equal(chooseInstallation('21.0.0',installs).year,2025);
  assert.equal(chooseInstallation('25.2.5.5319',installs).year,2025);
  assert.equal(chooseInstallation('25.3.0',installs).year,2026);
  assert.equal(chooseInstallation('26.1.4.5589',installs).year,2026);
  assert.throws(()=>chooseInstallation('26.2.0',installs));
});
test('FLP framing rejects truncation and overlong varints',()=>{
  assert.equal(inspectFlp(makeFlp()).version,'25.2.5.5319');
  assert.throws(()=>inspectFlp(makeFlp().subarray(0,25)));
  const invalid=makeFlp();invalid.fill(255,23);assert.throws(()=>inspectFlp(invalid));
});
test('FL 25/26 three-byte 0xAC framing does not swallow channel/sample opcodes',()=>{
  for(const version of ['25.2.5.5319','26.1.4.5589']){
    const file=makeFlp(version,['D:\\Samples\\first.wav','D:\\Samples\\second.wav']);
    const offset=22+2+Buffer.byteLength(version+'\0');
    const fixed=Buffer.concat([file.subarray(0,offset),Buffer.from([0xac,1,1,0]),file.subarray(offset)]);
    fixed.writeUInt32LE(fixed.length-22,18);
    assert.deepEqual(inspectFlp(fixed).samples,['D:\\Samples\\first.wav','D:\\Samples\\second.wav']);
    const legacy=makeFlp('24.1.0', ['sample.wav']);const legacyOffset=22+2+Buffer.byteLength('24.1.0\0');
    const old=Buffer.concat([legacy.subarray(0,legacyOffset),Buffer.from([0xac,1,1,0,0]),legacy.subarray(legacyOffset)]);old.writeUInt32LE(old.length-22,18);
    assert.deepEqual(inspectFlp(old).samples,['sample.wav']);
  }
});
test('Export comparison accepts relocation/order/duplicate references but rejects a different asset',()=>{
  const a=inspectFlp(makeFlp(undefined,['D:\\old\\a.wav','D:\\old\\b.wav','D:\\old\\a.wav']));
  const b=inspectFlp(makeFlp(undefined,['b.wav','a.wav']));assert.doesNotThrow(()=>assertExportMatches(a,b));
  assert.throws(()=>assertExportMatches(a,inspectFlp(makeFlp(undefined,['a.wav','c.wav']))),/отсутствуют/);
});

function wav(){const data=Buffer.alloc(44+32000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(32000,40);return data;}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('Validation reads CRC and sizes without modifying ZIP bytes or interpreting audio',async()=>{
  const dir=await temp();try{
    const file=path.join(dir,'native.zip');
    await zip(file,{'a.flp':makeFlp(undefined,['missing.wav']),'a.wav':Buffer.from('opaque native asset')});
    const before=await fs.readFile(file);const stat=await fs.stat(file);
    const report=await validateZip(file);
    assert.equal(report.entries.length,2);assert.equal(report.metrics.crc,'native');
    assert.deepEqual(await fs.readFile(file),before);assert.equal((await fs.stat(file)).mtimeMs,stat.mtimeMs);
    assert.deepEqual(await fs.readdir(dir),['native.zip']);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('A ZIP changed after verification is never published or used to delete originals',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);const project={id:'cccccccccccccccc',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const q=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':makeFlp()});return[];}});
    const verify=q.verifyBundle.bind(q);q.verifyBundle=async(...args)=>{const proof=await verify(...args);await fs.appendFile(args[1],Buffer.from('tamper'));return proof;};
    await assert.rejects(q.process(project,workspace,installs),/изменился после проверки/);
    assert(await fs.stat(folder));await assert.rejects(fs.stat(project.output));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('ZIP rejects corruption, ambiguous projects and old rebuilt bundles',async()=>{
  const dir=await temp();try{
    const file=path.join(dir,'test.zip');
    await zip(file,{'a.flp':makeFlp(),'Backup/old.flp':makeFlp()});
    await assert.rejects(validateZip(file),/ровно один FLP/);
    await zip(file,{'a.flp':makeFlp(),'__flpack__/manifest.json':Buffer.from('{}')});
    await assert.rejects(validateZip(file),/старой версией/);
    await zip(file,{'a.flp':Buffer.from('not a project')});await assert.rejects(validateZip(file),/FLP/);
    await zip(file,{'a.flp':makeFlp()});
    const data=await fs.readFile(file);data[30+data.readUInt16LE(26)+data.readUInt16LE(28)]^=0xff;await fs.writeFile(file,data);
    await assert.rejects(validateZip(file));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('A changed source, existing ZIP and bad export never delete the folder',async()=>{
  // Queue's Windows discovery is intentionally integration-tested separately.
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    const work=path.join(dir,'.flpack');await fs.mkdir(work);const project={id:'1234567890123456',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const queue=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':makeFlp()});await fs.writeFile(flp,makeFlp('25.1.0'));return[];}});
    await assert.rejects(queue.process(project,work,installs),/изменился|не соответствует/);assert(await fs.stat(folder));
    const another=path.join(dir,'another');await fs.mkdir(another);const f=path.join(another,'a.flp');await fs.writeFile(f,makeFlp());await fs.writeFile(f.replace('.flp','.zip'),'existing');
    await assert.rejects(queue.process({...project,id:'aaaaaaaaaaaaaaaa',folder:another,flp:f,output:path.join(dir,'another.zip')},work,installs),/уже есть ZIP/);assert(await fs.stat(another));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Successful transaction publishes a valid package, removes only its source and resumes cleanup after crash',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());await fs.writeFile(path.join(folder,'important.txt'),'important');
    const untouched=path.join(dir,'untouched.txt');await fs.writeFile(untouched,'stay');
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);const project={id:'1234567890123456',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const q=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':makeFlp()});return[];}});
    const finish=q.finishCleanup;q.finishCleanup=async()=>{throw new Error('simulated crash');};
    await assert.rejects(q.process(project,workspace,installs),/simulated crash/);
    assert.equal((await validateZip(project.output)).entries.length,1);
    assert(await fs.stat(path.join(workspace,project.id+'.source')));
    q.finishCleanup=finish;await q.recover(workspace);
    await assert.rejects(fs.stat(folder));await assert.rejects(fs.stat(path.join(workspace,project.id+'.source')));
    assert.equal(await fs.readFile(untouched,'utf8'),'stay');
    assert.equal(JSON.parse(await fs.readFile(path.join(workspace,project.id+'.json'))).state,'done');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Recovery is offered with no remaining project folders; altered quarantine is retained',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);const project={id:'aaaaaaaaaaaaaaaa',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const q=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':makeFlp()});return[];}});
    const finish=q.finishCleanup;q.finishCleanup=async()=>{throw new Error('crash');};await assert.rejects(q.process(project,workspace,installs));q.finishCleanup=finish;
    const scanned=await scan(dir);assert.equal(scanned.projects.length,0);assert.equal(scanned.recoveryCount,1);
    const quarantine=path.join(workspace,project.id+'.source');await fs.writeFile(path.join(quarantine,'new.txt'),'do not delete');
    await assert.rejects(q.recover(workspace),/Карантин изменился/);assert(await fs.stat(quarantine));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Stop before publication preserves original and a verified staged archive',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);const project={id:'bbbbbbbbbbbbbbbb',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const q=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':makeFlp()});q.stop();return[];}});
    await assert.rejects(q.process(project,workspace,installs),/остановлена/);assert(await fs.stat(folder));await assert.rejects(fs.stat(project.output));
    assert.equal(JSON.parse(await fs.readFile(path.join(workspace,project.id+'.json'))).state,'verified');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('A failed native export persists the exact error and stage without deleting originals',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp(undefined,['absent.wav']));
    const events=[];let attempts=0;
    const q=new Queue({lockBase:path.join(dir,'.lock'),checkFl:async()=>{},detectInstallations:async()=>installs,emit:e=>events.push(e),exportProject:async(p,i,n)=>{attempts++;await fs.writeFile(n,'broken native archive');return[];}});
    await q.run(dir);
    const failed=events.find(e=>e.type==='project'&&e.project.status==='error');assert(failed);assert.equal(attempts,1);
    const journal=JSON.parse(await fs.readFile(path.join(dir,'.flpack',failed.project.id+'.json'),'utf8'));
    assert.equal(journal.lastError.message,failed.project.error);assert.equal(journal.lastError.stage,'verifying');
    assert(await fs.stat(flp));await assert.rejects(fs.stat(path.join(dir,'p.zip')));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Publishes exact native bytes and exported FLP, excludes source backups and extra files',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(path.join(folder,'Backup'),{recursive:true});
    const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    await fs.writeFile(path.join(folder,'Backup','old.flp'),makeFlp('24.1.0'));
    await fs.writeFile(path.join(folder,'unused.wav'),'unused');
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);
    const project={id:'dddddddddddddddd',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    let nativeBytes;const exported=makeFlp(undefined,['exported.wav']);
    const q=new Queue({exportProject:async(p,i,n)=>{await zip(n,{'p.flp':exported,'exported.wav':wav()});nativeBytes=await fs.readFile(n);return[];}});
    await q.process(project,workspace,installs);
    assert.deepEqual(await fs.readFile(project.output),nativeBytes);
    const report=await validateZip(project.output);assert.equal(report.main.sha256,sha(exported));
    assert.deepEqual(report.entries.map(e=>e.name).sort(),['exported.wav','p.flp']);
    await assert.rejects(fs.stat(folder));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Legacy journals cannot authorize deletion or resume old assembly',async()=>{
  const dir=await temp();try{
    const folder=path.join(dir,'p');await fs.mkdir(folder);const flp=path.join(folder,'p.flp');await fs.writeFile(flp,makeFlp());
    const workspace=path.join(dir,'.flpack');await fs.mkdir(workspace);
    const project={id:'eeeeeeeeeeeeeeee',folder,flp,output:path.join(dir,'p.zip'),name:'p',version:'25.2.5.5319'};
    const q=new Queue({exportProject:async()=>{throw new Error('Must not export');}});
    const job={schema:1,id:project.id,folder,flp,output:project.output,files:await inventory(folder),state:'assembled',partial:path.join(workspace,project.id+'.partial.zip'),nativeSaved:path.join(workspace,project.id+'.native.zip'),quarantine:path.join(workspace,project.id+'.source')};
    const file=path.join(workspace,project.id+'.json');await fs.writeFile(file,JSON.stringify(job));
    await assert.rejects(q.process(project,workspace,installs),/старой версии/);assert(await fs.stat(folder));
    job.state='quarantined';await fs.rename(folder,job.quarantine);await fs.writeFile(file,JSON.stringify(job));
    await assert.rejects(q.recover(workspace),/старой версии/);assert(await fs.stat(job.quarantine));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
