const {app,BrowserWindow,dialog,ipcMain,shell}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
let window,queue,current;
if(!app.requestSingleInstanceLock()) app.quit();
else {
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.whenReady().then(async()=>{
  const engine=await import(pathToFileURL(path.join(__dirname,'../backend/engine.mjs')).href);
  queue=new engine.Queue({helper:app.isPackaged?path.join(process.resourcesPath,'exporter/flpack-exporter.exe'):undefined,emit:event=>{if(window&&!window.isDestroyed())window.webContents.send('queue-event',event);}});
  window=new BrowserWindow({width:1040,height:720,minWidth:780,minHeight:520,backgroundColor:'#000000',title:'FL Pack',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  ipcMain.handle('choose-folder',async()=>{if(queue.running)throw new Error('Дождитесь окончания очереди');const r=await dialog.showOpenDialog(window,{title:'Папка с проектами FL Studio',properties:['openDirectory']});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('scan',async(_e,folder)=>{if(queue.running)throw new Error('Очередь уже работает');if(typeof folder!=='string')throw new Error('Нужна папка');current=undefined;current=await engine.scan(folder);return current;});
  ipcMain.handle('start',async(_e,ids)=>{if(!current)throw new Error('Сначала выберите папку');if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))throw new Error('Неверная очередь');if(queue.running)throw new Error('Очередь уже запущена');queue.run(current.input,ids).catch(error=>{if(!window.isDestroyed())window.webContents.send('queue-event',{type:'fatal',message:error.message});});return true;});
  ipcMain.handle('stop',()=>queue.stop());
  ipcMain.handle('reveal',async()=>{if(current)await shell.openPath(current.input);});
  window.on('close',event=>{if(queue.running){event.preventDefault();queue.stop();dialog.showMessageBox(window,{type:'info',title:'Завершение текущего этапа',message:'Очередь останавливается безопасно. Дождитесь завершения текущего проекта, затем закройте окно.',buttons:['Понятно']});}});
  if(process.env.FLPACK_DEV_URL) await window.loadURL(process.env.FLPACK_DEV_URL);
  else await window.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('window-all-closed',()=>app.quit());
}
