import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { processProject, finishCleanup } from './job.mjs';
import { inspectFlp } from './flp.mjs';
import { validateZip, hashFile, fingerprint, sameFingerprint } from './archive.mjs';

const exec = promisify(execFile);
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
const ps = async command => (await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command', command], { windowsHide: true, encoding: 'utf8' })).stdout.replace(/^\uFEFF/, '').trim();

export async function installations() {
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $roots=@(Join-Path $env:ProgramFiles 'Image-Line'); $roots+=@(Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -Like '*FL Studio*' | ForEach-Object InstallLocation); $files=@(foreach($r in ($roots | Where-Object {$_} | Select-Object -Unique)){if(Test-Path -LiteralPath $r){Get-ChildItem -LiteralPath $r -Filter FL64.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue}}); ConvertTo-Json -Compress -InputObject @($files | Sort-Object FullName -Unique | ForEach-Object { [pscustomobject]@{exe=$_.FullName;version=$_.VersionInfo.ProductVersion;year=if($_.VersionInfo.ProductVersion -like '25.*'){2025}elseif($_.VersionInfo.ProductVersion -like '26.*'){2026}else{0}}})";
  return JSON.parse(await ps(script) || '[]').filter(i => [2025,2026].includes(i.year));
}

export async function assertFlClosed() {
  if (await ps("@(Get-Process FL64 -ErrorAction SilentlyContinue).Count" ) !== '0') throw new Error('Закройте запущенную FL Studio перед началом. Утилита запускает отдельный процесс для экспорта.');
}

export async function scan(input,{withInstallations=true}={}) {
  const resolved = path.resolve(input); const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Выберите обычную папку без junction/ссылок');
  const real = await fs.realpath(resolved);
  if (real.toLowerCase() !== resolved.toLowerCase() || real === path.parse(real).root || real.toLowerCase() === os.homedir().toLowerCase()) throw new Error('Нельзя обрабатывать корень диска, домашнюю папку или ссылку');
  const projects = []; const ignored = new Set(['backup','.flpack','node_modules','.git']);
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const flps = entries.filter(e => e.isFile() && /\.flp$/i.test(e.name));
    if (flps.length) {
      const project = { id: crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0,16), folder: dir, name: path.basename(dir), status: 'ready', output: path.join(path.dirname(dir), `${path.basename(dir)}.zip`) };
      if (flps.length !== 1) { project.status = 'error'; project.error = 'В корне несколько FLP: основной проект неоднозначен'; }
      else {
        project.flp = path.join(dir, flps[0].name);
        try { const metadata = inspectFlp(await fs.readFile(project.flp)); project.version = metadata.version; project.sampleCount = metadata.samples.length; }
        catch(e) { project.status = 'error'; project.error = e.message; }
      }
      projects.push(project); return;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !ignored.has(e.name.toLowerCase())) await visit(path.join(dir, e.name));
  }
  await visit(real);
  const workspace=path.join(projects.some(p=>p.folder===real)?path.dirname(real):real,'.flpack');
  let recoveryCount=0;
  if(await exists(workspace)){
    if((await fs.lstat(workspace)).isSymbolicLink())throw new Error('.flpack не должна быть ссылкой');
    for(const name of await fs.readdir(workspace))if(/^[a-f0-9]{16}\.json$/.test(name)){
      const job=JSON.parse(await fs.readFile(path.join(workspace,name),'utf8'));
      if(['published','quarantined','deleting'].includes(job.state)&&!await exists(job.folder)&&await exists(job.quarantine))recoveryCount++;
    }
  }
  return { input: real, projects, recoveryCount, installations: withInstallations?await installations():[] };
}

async function atomicJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`; const handle = await fs.open(temp, 'w');
  try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}

export async function acquireLock(base) {
  await fs.mkdir(base, { recursive: true }); const file = path.join(base,'queue.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file,'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
      return async () => fs.unlink(file).catch(() => {});
    } catch(e) {
      if (e.code !== 'EEXIST') throw e;
      const lock = JSON.parse(await fs.readFile(file,'utf8'));
      try { process.kill(lock.pid, 0); throw new Error('Уже выполняется другая очередь FLPack'); }
      catch(err) { if (err.code !== 'ESRCH') throw err; await fs.unlink(file); }
    }
  }
  throw new Error('Не удалось заблокировать очередь');
}

export class Queue {
  constructor({ emit = () => {}, helper, python = 'python', exportProject, checkFl = assertFlClosed, detectInstallations = installations, timeout = 120, lockBase=path.join(os.tmpdir(),'flpack-global') } = {}) {
    this.emit = emit; this.helper = helper; this.python = python; this.exportProject = exportProject; this.checkFl = checkFl; this.detectInstallations = detectInstallations; this.timeout = timeout;
    this.running = false; this.stopped = false; this.child = null; this.lockBase=lockBase;
  }
  stop() { this.stopped = true; this.emit({ type: 'stopping' }); }
  update(project, status, detail, extras = {}) { if(project.status!==status){project.progress=undefined;project.stageStartedAt=Date.now();}Object.assign(project, { status, detail }, extras); this.emit({ type: 'project', project: { ...project } }); }
  async run(input, selected) {
    if (this.running) throw new Error('Очередь уже запущена');
    this.running = true; this.stopped = false;
    let unlock;
    try {
      // Lock across all folders: FL's CLI must never race another queue.
      unlock = await acquireLock(this.lockBase);
      await this.checkFl();
      const detected = await this.detectInstallations();
      const fresh = await scan(input,{withInstallations:false});
      // Renderer IDs are only selectors; all filesystem paths come from a fresh scan.
      const ids = new Set(selected || fresh.projects.map(p => p.id));
      const projects = fresh.projects.filter(p => ids.has(p.id));
      const workspace = path.join(fresh.projects.some(p => p.folder === fresh.input) ? path.dirname(fresh.input) : fresh.input, '.flpack');
      await fs.mkdir(workspace, { recursive: true });
      if ((await fs.lstat(workspace)).isSymbolicLink() || (await fs.realpath(workspace)).toLowerCase()!==workspace.toLowerCase()) throw new Error('Рабочая папка .flpack не должна быть ссылкой');
      await this.recover(workspace);
      for (const project of projects) {
        if (this.stopped) break;
        if (project.status === 'error') { this.emit({ type: 'project', project }); continue; }
        const started = Date.now();
        try { await this.process(project, workspace, detected); this.update(project, project.warnings?.length ? 'warning' : 'done', 'Архив проверен. Исходная папка удалена.', { elapsed: (Date.now()-started)/1000 }); }
        catch(error) {
          const lastError={message:error.message,stage:project.status,file:project.progress?.file||'',at:new Date().toISOString()};
          const journal=path.join(workspace,project.id+'.json');
          if(await exists(journal)){try{const job=JSON.parse(await fs.readFile(journal,'utf8'));job.lastError=lastError;if(project.warnings?.length)job.warnings=[...project.warnings];if(project.warningImages?.length)job.warningImages=[...project.warningImages];await atomicJson(journal,job);}catch{ /* Report the original failure even if its journal cannot be written. */ }}
          this.update(project, 'error', error.message, { error: error.message, elapsed: (Date.now()-started)/1000 });
        }
      }
      this.emit({ type: 'finished', stopped: this.stopped });
    } finally { if (unlock) await unlock(); this.running = false; }
  }
  async nativeExport(project, installation, native) {
    if (this.exportProject) return this.exportProject(project, installation, native);
    const script = this.helper || fileURLToPath(new URL('../automation/exporter.py', import.meta.url));
    const args = [JSON.stringify({ exe: installation.exe, project: project.flp, native, timeout: this.timeout, warningDir: project.warningDir, watchParent:true })];
    const command = script.endsWith('.exe') ? script : this.python;
    return new Promise((resolve,reject) => {
      const child = spawn(command, script.endsWith('.exe') ? args : [script,...args], { windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.child = child; let buffer = '', stderr = '', failure; const warnings = [];
      child.stdout.on('data', data => {
        buffer += data.toString(); let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
          try { const event = JSON.parse(line); if (['missing-plugin','dialog-dismissed'].includes(event.type)) { warnings.push(event.text); if(event.screenshot && path.dirname(event.screenshot)===project.warningDir)(project.warningImages ||= []).push(event.screenshot); this.update(project,'exporting',event.type === 'missing-plugin' ? 'Подтверждено предупреждение об отсутствующем плагине' : 'Закрыто мешающее окно FL Studio', { warnings: [...warnings] }); } if (event.type === 'error') failure = event.message; this.emit({ type: 'export-event', id: project.id, event }); } catch { /* Ignore dependency startup banners. */ }
        }
      });
      child.stderr.on('data', data => { stderr = (stderr+data.toString()).slice(-6000); });
      child.on('error', e => { this.child = null; reject(e); });
      child.on('close', code => { this.child = null; code === 0 && !failure ? resolve(warnings) : reject(new Error(failure || stderr || `Ошибка экспортера: ${code}`)); });
    });
  }
  progress(project) {
    const started=Date.now();let last=0;
    return progress=>{
      const now=Date.now();
      if(now-last<150&&progress.bytes!==progress.totalBytes)return;
      last=now;
      project.progress={...progress,elapsed:(now-started)/1000,speed:progress.bytes/Math.max((now-started)/1000,.05)};
      this.emit({type:'progress',id:project.id,progress:project.progress});
    };
  }
  async verifyBundle(job,file,project) {
    const before=await fingerprint(file);
    const [report,archiveHash]=await Promise.all([
      validateZip(file,{expectedMain:path.basename(job.flp),onProgress:project?this.progress(project):()=>{}}),
      hashFile(file)
    ]);
    const after=await fingerprint(file);
    if(!sameFingerprint(before,after))throw new Error('ZIP изменился во время проверки');
    return {report,archiveHash,snapshot:after,file};
  }
  async process(project,workspace,detected) {
    return processProject(this,project,workspace,detected,{atomicJson,exists});
  }
  async finishCleanup(job,jobFile,proof) {
    return finishCleanup(this,job,jobFile,{atomicJson,exists},proof);
  }
  async validateCleanupPaths(job,jobFile) {
    const workspace = path.dirname(jobFile);
    if(![1,2].includes(job.schema)||!/^[a-f0-9]{16}$/.test(job.id)||path.basename(jobFile)!==job.id+'.json')throw new Error('Некорректный журнал');
    if(!Array.isArray(job.files)||!job.files.length)throw new Error('Пустой список исходников в журнале');
    const seen=new Set();
    for(const file of job.files){
      if(typeof file.relative!=='string'||file.relative.includes('\\')||file.relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(file.relative)||seen.has(file.relative)||!Number.isSafeInteger(file.size)||file.size<0||!/^([a-f0-9]{64})$/.test(file.sha256))throw new Error('Небезопасный список исходников в журнале');
      const full=path.join(job.folder,...file.relative.split('/'));
      if(file.full!==full)throw new Error('Путь исходника в журнале не совпадает с папкой проекта');
      seen.add(file.relative);
    }
    for (const p of [job.partial,job.nativeSaved,job.quarantine]) if (path.dirname(path.resolve(p)) !== path.resolve(workspace) || !path.basename(p).startsWith(job.id+'.')) throw new Error('Небезопасные пути в журнале');
    if (path.resolve(job.output) !== path.join(path.dirname(job.folder),path.basename(job.folder)+'.zip')) throw new Error('Небезопасный путь результата в журнале');
    const parent=path.dirname(workspace);const relative=path.relative(parent,job.folder);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).includes('.flpack'))throw new Error('Исходники из журнала находятся за пределами выбранной папки');
    if ((await fs.realpath(workspace)).toLowerCase() !== path.resolve(workspace).toLowerCase()) throw new Error('Рабочая папка является ссылкой');
  }
  async recover(workspace) {
    for (const name of await fs.readdir(workspace)) if (/^[a-f0-9]{16}\.json$/.test(name)) {
      const file = path.join(workspace,name); const job = JSON.parse(await fs.readFile(file,'utf8'));
      await this.validateCleanupPaths(job,file);
      if(job.schema!==2||job.mode!=='native-zip'){
        if(['quarantined','deleting'].includes(job.state)||await exists(job.quarantine))throw new Error('Незавершённое удаление старой версии: автоматическое продолжение запрещено; карантин сохранён');
        continue;
      }
      if (job.state === 'published' && await exists(job.quarantine) && !await exists(job.folder)) { job.state = 'quarantined'; await atomicJson(file,job); }
      if (['quarantined','deleting'].includes(job.state)) { await this.finishCleanup(job,file); this.emit({type:'recovered',name:path.basename(job.folder)}); }
    }
  }
}
