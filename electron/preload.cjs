const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('flpack',{
  chooseFolder:()=>ipcRenderer.invoke('choose-folder'),
  scan:folder=>ipcRenderer.invoke('scan',folder),
  start:ids=>ipcRenderer.invoke('start',ids),
  stop:()=>ipcRenderer.invoke('stop'),
  reveal:()=>ipcRenderer.invoke('reveal'),
  onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('queue-event',listener);return()=>ipcRenderer.removeListener('queue-event',listener);}
});
