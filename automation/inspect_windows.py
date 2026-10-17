"""Read-only diagnostics for the exporter process during integration tests."""
import json
import psutil
from pywinauto import Desktop
import ctypes
import win32gui
import win32ui
from PIL import Image
for process in psutil.process_iter(['name','pid']):
    if (process.info['name'] or '').lower() == 'fl64.exe':
        result=[]
        for backend in ('win32',):
            try:
                for w in Desktop(backend=backend).windows(process=process.pid,visible_only=True):
                    if w.class_name() not in ('TMissingPluginsForm','TFruityLoopsMainForm'):continue
                    rect=w.rectangle();width=rect.width();height=rect.height()
                    dc=win32gui.GetWindowDC(w.handle);source=win32ui.CreateDCFromHandle(dc);target=source.CreateCompatibleDC();bitmap=win32ui.CreateBitmap();bitmap.CreateCompatibleBitmap(source,width,height);target.SelectObject(bitmap)
                    result_code=ctypes.windll.user32.PrintWindow(w.handle,target.GetSafeHdc(),2)
                    Image.frombuffer('RGB',(width,height),bitmap.GetBitmapBits(True),'raw','BGRX',0,1).save('test-results/'+w.class_name()+'.png')
                    target.DeleteDC();source.DeleteDC();win32gui.ReleaseDC(w.handle,dc);win32gui.DeleteObject(bitmap.GetHandle())
                    result.append({'backend':backend,'title':w.window_text(),'class':w.class_name(),'enabled':w.is_enabled(),'handle':w.handle,'rect':str(w.rectangle()),'children':[{'title':c.window_text(),'class':c.class_name(),'handle':c.handle,'rect':str(c.rectangle()),'id':c.control_id(),'visible':c.is_visible()} for c in w.descendants()]})
            except Exception as e:result.append({'error':str(e)})
        print(json.dumps(result,ensure_ascii=True))
