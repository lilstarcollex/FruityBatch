import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FolderOpen, Loader2, Pause, Play, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { FileProgress, Project, QueueEvent, Scan, Status } from './types';

const labels: Record<Status,string> = { ready:'В очереди',checking:'Подготовка',exporting:'Экспорт',packing:'Упаковка',verifying:'Проверка',cleaning:'Сверка исходников',paused:'Остановлено',done:'Готово',warning:'Готово с замечаниями',error:'Ошибка' };
const isDone = (p:Project) => p.status === 'done' || p.status === 'warning';
const isActive = (p:Project) => ['checking','exporting','packing','verifying','cleaning'].includes(p.status);
const mb = (n:number) => (n/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ';
const time = (n:number) => n<60?`${Math.round(n)} с`:`${Math.floor(n/60)} мин ${Math.round(n%60)} с`;

function StatusLabel({project:p}:{project:Project}) {
  return <Badge variant="outline" className="status-badge">{isActive(p)?<Loader2 className="size-3 animate-spin"/>:p.status==='done'?<Check className="size-3"/>:p.status==='warning'?<TriangleAlert className="size-3"/>:p.status==='error'?<X className="size-3"/>:null}{labels[p.status]}</Badge>;
}

function FileStatus({progress:p}:{progress:FileProgress}) {
  return <div className="file-progress" role="status" aria-label="Прогресс проверки файлов">
    <div className="progress-caption"><span>{mb(p.bytes)}{p.totalBytes>0?` / ${mb(p.totalBytes)}`:''}</span><span>{mb(p.speed)}/с{p.totalFiles?` · ${p.completed??0}/${p.totalFiles} файлов`:''}</span></div>
    {p.totalBytes>0&&<Progress value={Math.min(100,p.bytes/p.totalBytes*100)} className="h-1"/>}
    <div className="current-file" title={p.activeFiles?.join('\n')||p.file}>{p.file||'Завершение этапа'}{p.activeFiles&&p.activeFiles.length>1?` · ещё ${p.activeFiles.length-1}`:''}</div>
  </div>;
}

export default function App() {
  const [folder,setFolder]=useState(''); const [data,setData]=useState<Scan|null>(null);
  const [busy,setBusy]=useState(false); const [running,setRunning]=useState(false); const [stopping,setStopping]=useState(false);
  const [error,setError]=useState(''); const [confirm,setConfirm]=useState(false); const [ended,setEnded]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null); const [logOpen,setLogOpen]=useState(false);
  const [logs,setLogs]=useState<{time:string;text:string}[]>([]);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running]);
  const log=(text:string)=>setLogs(list=>[...list.slice(-499),{time:new Date().toLocaleTimeString('ru-RU'),text}]);
  useEffect(()=>window.flpack?.onEvent((event:QueueEvent)=>{
    if(event.type==='project'){
      setData(d=>d?{...d,projects:d.projects.map(p=>p.id===event.project.id?event.project:p)}:d);
      log(`${event.project.name} · ${event.project.detail||event.project.error||labels[event.project.status]}`);
    } else if(event.type==='progress') {
      setData(d=>d?{...d,projects:d.projects.map(p=>p.id===event.id?{...p,progress:event.progress}:p)}:d);
    } else if(event.type==='finished') {
      setRunning(false);setStopping(false);setEnded(true);
      log(event.stopped?'Очередь остановлена':'Очередь завершена');
    } else if(event.type==='fatal') {
      setRunning(false);setStopping(false);setError(event.message);log(event.message);
    } else if(event.type==='recovered') log(`Восстановлено: ${event.name}`);
    else if(event.type==='export-event'&&['missing-plugin','dialog-dismissed'].includes(event.event.type)) log(event.event.text||'Подтверждено предупреждение FL Studio');
  }),[]);

  async function scan(value=folder) {
    if(!window.flpack){setError('Запустите FL Pack.exe');return;}
    if(!value.trim())return;
    setBusy(true);setData(null);setError('');setExpanded(null);
    try {const result=await window.flpack.scan(value.trim());setFolder(result.input);setData(result);setEnded(false);setLogs([]);}
    catch(e){setError(String(e).replace(/^Error: /,''));}finally{setBusy(false);}
  }
  async function choose() {
    if(!window.flpack){setError('Запустите FL Pack.exe');return;}
    try {const value=await window.flpack.chooseFolder();if(value){setFolder(value);await scan(value);}}
    catch(e){setError(String(e));}
  }
  async function start() {
    setConfirm(false);if(!data||!window.flpack)return;
    setError('');setRunning(true);setStopping(false);setEnded(false);
    try {await window.flpack.start(data.projects.filter(p=>!isDone(p)&&!!p.flp).map(p=>p.id));}
    catch(e){setRunning(false);setError(String(e));}
  }
  async function stop(){setStopping(true);await window.flpack?.stop();}

  const projects=data?.projects||[];
  const done=projects.filter(isDone).length;const failed=projects.filter(p=>p.status==='error').length;
  const pending=projects.filter(p=>!isDone(p)&&!!p.flp).length;
  const current=projects.find(isActive);const elapsed=projects.reduce((n,p)=>n+(p.elapsed||0),0);
  const canStart=!!data&&!!data.installations.length&&(pending>0||!!data.recoveryCount)&&!busy&&!running;

  return <main className="workspace">
    <header className="app-header"><h1>FL Pack</h1><span>Zipped loop package</span></header>
    <section className="folder-section" aria-label="Выбор папки">
      <div className="folder-row"><Input aria-label="Путь к папке с проектами" placeholder="Папка с проектами FL Studio" value={folder} disabled={running||busy} onChange={e=>setFolder(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void scan();}}/>
        <Button variant="outline" disabled={running||busy} onClick={()=>void choose()}><FolderOpen/>Выбрать папку</Button>
        <Button variant="outline" size="icon" aria-label="Просканировать папку" title="Просканировать папку" disabled={!folder.trim()||running||busy} onClick={()=>void scan()}><RefreshCw className={busy?'animate-spin':''}/></Button>
      </div>
    </section>
    {error&&<Alert className="error-notice"><TriangleAlert/><AlertDescription>{error}</AlertDescription></Alert>}
    {data?<section className="queue-section" aria-label="Очередь проектов">
      <div className="queue-toolbar"><span>{running?`Обработка · ${Math.min(done+failed+1,projects.length)} / ${projects.length}`:ended?`Готово: ${done}${failed?` · Ошибок: ${failed}`:''}`:`Проектов: ${projects.length}`}</span>
        {running?<Button variant="outline" size="sm" disabled={stopping} onClick={()=>void stop()}><Pause/>{stopping?'Останавливаем…':'Остановить'}</Button>:<Button size="sm" disabled={!canStart} onClick={()=>setConfirm(true)}><Play/>{!pending&&data.recoveryCount?'Восстановить':ended?'Продолжить':'Запустить'}</Button>}
      </div>
      {projects.length?<div className="queue-table"><Table><TableHeader><TableRow><TableHead className="w-10"/><TableHead>Проект</TableHead><TableHead className="w-24">FL Studio</TableHead><TableHead className="w-48">Статус</TableHead><TableHead className="w-24 text-right">Время</TableHead></TableRow></TableHeader><TableBody>
        {projects.map(p=><ProjectRows key={p.id} project={p} expanded={expanded===p.id} toggle={()=>setExpanded(expanded===p.id?null:p.id)}/>)}
      </TableBody></Table></div>:<div className="empty-state">{data.recoveryCount?'Найдена незавершённая операция. Нажмите «Восстановить».':'В этой папке проекты не найдены.'}</div>}
      {running&&current&&<div className="active-operation"><div className="operation-name"><Loader2 className="size-3.5 animate-spin"/><span>{current.name} · {current.detail||labels[current.status]}</span></div>{current.progress?<FileStatus progress={current.progress}/>:<span className="waiting-status">{current.status==='exporting'?'Ожидание FL Studio':'Подготовка этапа'} · {time(Math.max(0,(now-(current.stageStartedAt||now))/1000))}{current.status==='exporting'?' · таймаут 2 минуты':''}</span>}</div>}
      {projects.length>0&&(running||ended)&&<div className="queue-summary"><Progress value={(done+failed)/projects.length*100} className="h-1"/><div><span>{done+failed} / {projects.length}</span><span>{elapsed>0?time(elapsed):''}</span></div></div>}
    </section>:<div className="empty-state initial">{busy?<><Loader2 className="size-5 animate-spin"/>Сканирование папки…</>:<>Выберите папку, чтобы начать.</>}</div>}
    {logs.length>0&&<Collapsible open={logOpen} onOpenChange={setLogOpen} className="log-section"><div className="log-toolbar"><CollapsibleTrigger asChild><Button variant="ghost" size="sm">{logOpen?<ChevronDown/>:<ChevronRight/>}Журнал<span className="log-count">{logs.length}</span></Button></CollapsibleTrigger><Button variant="ghost" size="sm" onClick={()=>void window.flpack?.reveal()}><FolderOpen/>Открыть папку</Button></div><CollapsibleContent><ScrollArea className="h-40"><div className="log-lines">{logs.map((entry,i)=><div key={i}><time>{entry.time}</time><span>{entry.text}</span></div>)}</div></ScrollArea></CollapsibleContent></Collapsible>}
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{pending?`Упаковать проектов: ${pending}?`:'Восстановить обработку?'}</DialogTitle><DialogDescription>FL Studio создаст Zipped loop package. После проверки ZIP папка проекта будет удалена целиком, включая бэкапы и неиспользуемые файлы.</DialogDescription></DialogHeader><p className="confirm-path">{folder}</p><DialogFooter><Button variant="outline" onClick={()=>setConfirm(false)}>Отмена</Button><Button onClick={()=>void start()}><Play/>Начать</Button></DialogFooter></DialogContent></Dialog>
  </main>;
}

function ProjectRows({project:p,expanded,toggle}:{project:Project;expanded:boolean;toggle:()=>void}) {
  return <><TableRow className={isActive(p)?'active-row':''}><TableCell><Button aria-label={`Подробнее: ${p.name}`} variant="ghost" size="icon" className="size-7" onClick={toggle}>{expanded?<ChevronDown className="size-3.5"/>:<ChevronRight className="size-3.5"/>}</Button></TableCell><TableCell className="project-name">{p.name}</TableCell><TableCell className="muted">{p.engine||Number(p.version?.split('.')[0])+2000||'—'}</TableCell><TableCell><StatusLabel project={p}/></TableCell><TableCell className="text-right tabular-nums muted">{p.elapsed?time(p.elapsed):'—'}</TableCell></TableRow>
    {(expanded||p.status==='error')&&<TableRow className="detail-row"><TableCell/><TableCell colSpan={4}><div className="project-detail">{p.error&&<p className="project-error">{p.error}</p>}{expanded&&<><p>Архив: {p.output}</p>{p.fileCount&&<p>{p.fileCount} исходных файлов · {mb(p.bytes||0)}</p>}{p.warnings?.map((w,i)=><p key={i}>{w}</p>)}</>}</div></TableCell></TableRow>}
  </>;
}
