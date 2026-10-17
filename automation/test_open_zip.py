"""Open a completed expendable package in real FL and inspect the loaded window."""
import json
import pathlib
import subprocess
import sys
import time
import psutil
from pywinauto import Desktop
from exporter import handle_dialogs,capture_dialog,terminate_owned

archive=pathlib.Path(sys.argv[1]).resolve()
root=(pathlib.Path.cwd()/'test-results').resolve()
if not archive.is_relative_to(root) or archive.suffix.lower()!='.zip':raise RuntimeError('Only disposable test-result ZIPs may be opened')
process=subprocess.Popen([r'C:\Program Files\Image-Line\FL Studio 2025\FL64.exe',str(archive)])
handled=set();started=time.monotonic();stable=0;previous=0
try:
    while time.monotonic()-started<60:
        if process.poll() is not None:raise RuntimeError('FL exited before project loaded')
        observations=handle_dialogs(process.pid,handled,str(archive.parent/'open-warnings'))
        windows=Desktop(backend='win32').windows(process=process.pid,visible_only=True)
        main=[w for w in windows if w.class_name()=='TFruityLoopsMainForm']
        unknown=[w for w in windows if w.class_name()not in ('TFruityLoopsMainForm','TApplication','TMissingPluginsForm','TLightweightLayeredControl')]
        if unknown:raise RuntimeError('Unexpected load dialog: '+str([(w.class_name(),w.window_text())for w in unknown]))
        # Live plugin audio engines continue consuming CPU while playback is stopped;
        # CPU-idle is not a reliable readiness signal. Check enabled workspace instead.
        stable=stable+1 if len(main)==1 and main[0].is_enabled()and time.monotonic()-started>8 else 0
        # This fixture is known to contain unavailable FabFilter Pro-Q 3. Its
        # post-load warning must have appeared and closed before we claim readiness.
        if stable>=3 and handled and len(main)==1 and main[0].is_enabled()and not Desktop(backend='win32').windows(process=process.pid,class_name='TMissingPluginsForm',visible_only=True):
            image=capture_dialog(main[0],str(archive.parent/'reopened'),1)
            print(json.dumps({'opened':str(archive),'seconds':round(time.monotonic()-started,2),'warnings':len(handled),'screenshot':image}));break
        time.sleep(1)
    else:raise RuntimeError('Project did not reach an enabled main window')
finally:terminate_owned(process);process.wait(timeout=10)
