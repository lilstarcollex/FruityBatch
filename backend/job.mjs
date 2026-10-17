import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseInstallation } from './flp.mjs';
import { inventory, assertUnchanged, fingerprint, sameFingerprint, reconcileExportArtifacts } from './archive.mjs';

export async function quarantineSource(source, target, rename = fs.rename) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(source, target); }
    catch (error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await delay(200 * (attempt + 1));
    }
  }
}

export async function processProject(queue,project,workspace,detected,{atomicJson,exists}) {
  const install=chooseInstallation(project.version,detected);
  project.engine=install.year;project.warnings=[];project.progress=undefined;
  project.warningDir=path.join(workspace,project.id+'.warnings');project.warningImages=[];
  const jobFile=path.join(workspace,project.id+'.json');
  const native=project.flp.replace(/\.flp$/i,'.zip');
  let job,proof;
  if(await exists(jobFile))job=JSON.parse(await fs.readFile(jobFile,'utf8'));
  if(job&&(job.folder!==project.folder||job.output!==project.output||job.flp!==project.flp))throw new Error('Журнал относится к другому проекту');
  if(job){
    await queue.validateCleanupPaths(job,jobFile);
    if(job.schema!==2||job.mode!=='native-zip')throw new Error('Журнал старой версии: автоматическое продолжение запрещено. Исходная папка сохранена.');
  }
  queue.update(project,'checking','Подготовка');
  if(!job){
    if(await exists(native))throw new Error(`Рядом с FLP уже есть ZIP. Переместите его перед запуском: ${native}`);
    if(await exists(project.output))throw new Error(`Итоговый ZIP уже существует: ${project.output}`);
    const files=await inventory(project.folder,{onProgress:queue.progress(project)});
    const total=files.reduce((s,f)=>s+f.size,0);const space=await fs.statfs(workspace);
    if(Number(space.bavail)*Number(space.bsize)<total*2+64*1024*1024)throw new Error('Недостаточно свободного места для безопасной упаковки');
    job={schema:2,mode:'native-zip',id:project.id,folder:project.folder,flp:project.flp,output:project.output,native,files,state:'inventoried',warnings:[],engine:install.year,partial:path.join(workspace,project.id+'.partial.zip'),nativeSaved:path.join(workspace,project.id+'.native.zip'),quarantine:path.join(workspace,project.id+'.source'),metrics:{finalVerificationPasses:0}};
    await atomicJson(jobFile,job);
  }
  if(!['inventoried','exporting','exported','verified','published','quarantined','deleting','done'].includes(job.state))throw new Error('Неизвестное состояние журнала; исходники сохранены');
  job.metrics||={finalVerificationPasses:0};
  if(job.state==='done')throw new Error('Проект уже завершён; новая папка с тем же именем требует проверки существующего архива');
  if(job.files.some(f=>f.ctimeMs===undefined)){
    // Upgrade old journals only after matching every original content digest.
    job.files=await assertUnchanged(project.folder,job.files,[path.basename(native)],{onProgress:queue.progress(project)});
    await atomicJson(jobFile,job);
  }
  if(['inventoried','exporting','exported'].includes(job.state)){
    // Older journals never included the exporter-created .zip~ file in their
    // initial inventory. Do not exempt an existing user file with that name.
    job.generatedNativeTemp ??= !job.files.some(f=>f.relative===path.basename(native)+'~');
    if(job.state!=='inventoried')job.files=await reconcileExportArtifacts(job);
    await atomicJson(jobFile,job);
  }
  if(['verified','published'].includes(job.state)){
    queue.update(project,'verifying','Проверка после восстановления');
    proof=await queue.verifyBundle(job,await exists(job.output)?job.output:job.nativeSaved,project);
    if(proof.archiveHash!==job.archiveHash)throw new Error('Архив изменился после предыдущего запуска; исходники сохранены');
    job.metrics.recoveryVerificationPasses=(job.metrics.recoveryVerificationPasses||0)+1;
  }
  if(['inventoried','exporting'].includes(job.state)){
    await assertUnchanged(project.folder,job.files,[path.basename(native)],{metadataOnly:true});
    if(!await exists(job.nativeSaved)){
      if(await exists(native)&&job.state!=='exporting')throw new Error('Неожиданный ZIP в исходной папке');
      if(job.state==='exporting'&&await exists(native))await fs.unlink(native);
      if(!await exists(native)){
        job.state='exporting';await atomicJson(jobFile,job);
        queue.update(project,'exporting',`Экспорт · FL Studio ${install.year}`);
        job.warnings=await queue.nativeExport(project,install,native);job.warningImages=project.warningImages;
      }
      await fs.rename(native,job.nativeSaved);
    }
    job.files=await reconcileExportArtifacts(job);
    job.state='exported';await atomicJson(jobFile,job);
  }
  project.warnings=job.warnings||[];
  if(job.state==='exported'){
    await assertUnchanged(project.folder,job.files,[],{metadataOnly:true});
    // Keep the native ZIP byte-for-byte. No writer, manifest, FLP replacement,
    // backup insertion or compression step exists in this transaction.
    queue.update(project,'verifying','Проверка штатного ZIP');
    proof=await queue.verifyBundle(job,job.nativeSaved,project);
    job.archiveHash=proof.archiveHash;job.bytes=proof.snapshot.size;
    job.metrics.finalVerificationPasses=(job.metrics.finalVerificationPasses||0)+1;
    job.metrics.validation=proof.report.metrics;
    job.state='verified';await atomicJson(jobFile,job);
  }
  if(queue.stopped)throw new Error('Очередь остановлена; исходная папка сохранена');
  if(job.state==='verified'){
    if(!proof)throw new Error('Нет подтверждённой проверки архива в текущем запуске');
    if(!sameFingerprint(proof.snapshot,await fingerprint(proof.file)))throw new Error('Архив изменился после проверки');
    if(await exists(job.output)){
      // Only a crash can leave a verified job with an already published link.
      const existing=await fingerprint(job.output);
      if(existing.ino!==proof.snapshot.ino||existing.dev!==proof.snapshot.dev)throw new Error('Конфликт итогового ZIP: существующий файл отличается');
    }else await fs.link(job.nativeSaved,job.output);
    proof.file=job.output;proof.snapshot=await fingerprint(job.output);
    job.state='published';await atomicJson(jobFile,job);
  }
  if(job.state==='published'){
    queue.update(project,'cleaning','Сверка исходников перед удалением');
    if(!proof||!sameFingerprint(proof.snapshot,await fingerprint(job.output)))throw new Error('Архив изменился; удаление запрещено');
    // The single final content-hash pass over originals is immediately before
    // atomic quarantine. Earlier checkpoints only compare filesystem metadata.
    proof.sourceSnapshot=await assertUnchanged(job.folder,job.files,[],{onProgress:queue.progress(project)});
    if(queue.stopped)throw new Error('Очередь остановлена; исходная папка сохранена');
    await quarantineSource(job.folder,job.quarantine);job.state='quarantined';await atomicJson(jobFile,job);
  }
  await queue.finishCleanup(job,jobFile,proof);
  project.bytes=job.bytes;project.sourceBytes=job.files.reduce((n,f)=>n+f.size,0);project.fileCount=job.files.length;project.progress=undefined;project.metrics=job.metrics;
}

export async function finishCleanup(queue,job,jobFile,{atomicJson,exists},proof) {
  if(!['quarantined','deleting'].includes(job.state))return;
  await queue.validateCleanupPaths(job,jobFile);
  if(job.schema!==2||job.mode!=='native-zip')throw new Error('Удаление по журналу старой версии запрещено; карантин сохранён');
  if(proof){
    // An in-memory result is usable only for this unchanged inode in this run.
    if(proof.archiveHash!==job.archiveHash||!sameFingerprint(proof.snapshot,await fingerprint(job.output)))throw new Error('ZIP изменился после проверки; карантин сохранён');
  }else{
    // Persisted flags are never treated as proof. Restart always rechecks the
    // actual archive and the surviving quarantined files in full.
    proof=await queue.verifyBundle(job,job.output);
    if(proof.archiveHash!==job.archiveHash)throw new Error('ZIP повреждён после публикации; карантин сохранён');
    job.metrics||={};job.metrics.recoveryVerificationPasses=(job.metrics.recoveryVerificationPasses||0)+1;
  }
  if(await exists(job.quarantine)){
    const stat=await fs.lstat(job.quarantine);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Небезопасный путь карантина');
    if(proof.sourceSnapshot){
      await assertUnchanged(job.quarantine,proof.sourceSnapshot,[],{metadataOnly:true});
    }else{
      const remaining=await inventory(job.quarantine);const expected=new Map(job.files.map(f=>[f.relative,f]));
      if(job.state==='quarantined'&&remaining.length!==job.files.length)throw new Error('Карантин изменился до удаления');
      for(const file of remaining){const original=expected.get(file.relative);if(!original||original.sha256!==file.sha256||original.size!==file.size)throw new Error(`Карантин изменился: ${file.relative}`);}
    }
    if(!sameFingerprint(proof.snapshot,await fingerprint(job.output)))throw new Error('ZIP изменился перед удалением; карантин сохранён');
    job.state='deleting';await atomicJson(jobFile,job);
    await fs.rm(job.quarantine,{recursive:true});
  }
  for(const file of [job.partial,job.nativeSaved])if(await exists(file))await fs.unlink(file);
  const warningDir=path.join(path.dirname(jobFile),job.id+'.warnings');
  for(const file of job.warningImages||[])if(path.dirname(file)===warningDir&&/^\d{3}\.png$/.test(path.basename(file))&&await exists(file))await fs.unlink(file);
  await fs.rmdir(warningDir).catch(error=>{if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;});
  delete job.lastError;job.state='done';job.completedAt=new Date().toISOString();await atomicJson(jobFile,job);
}
