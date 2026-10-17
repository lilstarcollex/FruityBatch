"""Exercise the dialog handler on exactly one exporter-owned disposable test project."""
import pathlib
import time
import psutil
from exporter import handle_dialogs
from pywinauto import Desktop
test_root=str((pathlib.Path.cwd()/'test-results').resolve()).lower()
candidates=[]
for p in psutil.process_iter(['name','cmdline']):
    if (p.info['name'] or '').lower()=='fl64.exe' and any(a.lower().startswith('/z'+test_root) for a in (p.info['cmdline'] or [])):
        candidates.append(p)
if len(candidates)!=1:raise RuntimeError('Expected one owned disposable-test FL process')
process=candidates[0]
handled=set()
print(handle_dialogs(process.pid,handled))
if not handled:raise RuntimeError('No recognized dialog was handled')
deadline=time.monotonic()+5
while time.monotonic()<deadline:
    if not Desktop(backend='win32').windows(process=process.pid,class_name='TMissingPluginsForm',visible_only=True):
        print('Actual FL Studio missing-plugin dialog dismissed successfully');break
    time.sleep(.1)
else:raise RuntimeError('FL dialog remained open')
