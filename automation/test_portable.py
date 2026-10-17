"""Smoke-test the actual self-extracting portable executable, not the dev runtime."""
import os
import json
import pathlib
import subprocess
import time
import psutil
from pywinauto import Desktop
from exporter import terminate_owned

environment=dict(os.environ)
environment.pop('ELECTRON_RUN_AS_NODE',None)
version=json.loads((pathlib.Path.cwd()/'package.json').read_text())['version']
executable=(pathlib.Path.cwd()/'release'/f'FL-Pack-{version}-Windows.exe').resolve()
process=subprocess.Popen([str(executable),'--user-data-dir='+str(pathlib.Path.cwd()/'test-results'/'profiles'/f'portable-{time.time_ns()}')],env=environment)
main=None
try:
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:children=psutil.Process(process.pid).children(recursive=True)
        except psutil.Error:children=[]
        for child in children:
            for window in Desktop(backend='win32').windows(process=child.pid,visible_only=True):
                if window.window_text()=='FL Pack':main=window;break
            if main:break
        if main:
            print('Portable EXE extracted and opened FL Pack successfully; process:',main.process_id())
            main.close()
            process.wait(timeout=15)
            break
        if process.poll()is not None:raise RuntimeError('Portable launcher exited before opening the application')
        time.sleep(.25)
    else:raise RuntimeError('Portable executable did not open FL Pack')
finally:
    if process.poll()is None:terminate_owned(process)
