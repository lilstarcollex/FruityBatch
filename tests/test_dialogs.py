import ctypes
import importlib.util
import pathlib
import subprocess
import sys
import time
import unittest
import json
import tempfile
import os
import psutil

spec=importlib.util.spec_from_file_location('exporter',pathlib.Path(__file__).parents[1]/'automation'/'exporter.py')
exporter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

class DialogTests(unittest.TestCase):
    def test_recognition(self):
        for text in ['The plugin X could not be found','Missing plugins: X','Не найден плагин X']:
            self.assertTrue(exporter.missing_plugin(text))
        for text in ['Missing samples','Please register your plugin','Replace existing file?']:
            self.assertFalse(exporter.missing_plugin(text))

    def test_real_win32_missing_plugin_dialog(self):
        child=subprocess.Popen([sys.executable,'-c',"import ctypes;ctypes.windll.user32.MessageBoxW(None, 'The plugin FLPackMissing could not be found', 'Plugin not found', 0)"])
        try:
            handled=set();deadline=time.monotonic()+10
            while child.poll() is None and time.monotonic()<deadline:
                exporter.handle_dialogs(child.pid,handled);time.sleep(.1)
            self.assertIsNotNone(child.poll(),'Dialog was not acknowledged')
            self.assertEqual(len(handled),1)
        finally:
            if child.poll() is None:child.kill()

    def test_unknown_ok_dialog_is_dismissed(self):
        child=subprocess.Popen([sys.executable,'-c',"import ctypes;ctypes.windll.user32.MessageBoxW(None, 'Overwrite the existing file?', 'Confirm', 0)"])
        try:
            handled=set();deadline=time.monotonic()+10
            while child.poll() is None and time.monotonic()<deadline:
                exporter.handle_dialogs(child.pid,handled);time.sleep(.1)
            self.assertEqual(len(handled),1);self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:child.kill()
            child.wait()

    def test_all_dialogs_in_sequence_are_dismissed(self):
        child=subprocess.Popen([sys.executable,'-c',"import ctypes;u=ctypes.windll.user32;u.MessageBoxW(None, 'Missing samples', 'Warning', 0);u.MessageBoxW(None, 'Plugin failed to load', 'Error', 0);u.MessageBoxW(None, 'Continue?', 'Question', 4)"])
        try:
            handled=set();deadline=time.monotonic()+10
            while child.poll() is None and time.monotonic()<deadline:
                exporter.handle_dialogs(child.pid,handled);time.sleep(.1)
            self.assertIsNotNone(child.poll(),'Some dialogs remained open')
            self.assertEqual(len(handled),3)
        finally:
            if child.poll() is None:child.kill()
            child.wait()

    def test_foreign_dialog_is_untouched(self):
        foreign=subprocess.Popen([sys.executable,'-c',"import ctypes;ctypes.windll.user32.MessageBoxW(None, 'Foreign', 'Foreign', 0)"])
        try:
            time.sleep(.4);handled=set();exporter.handle_dialogs(os.getpid(),handled)
            self.assertEqual(len(handled),0);self.assertIsNone(foreign.poll())
        finally:foreign.kill();foreign.wait()

    def test_default_timeout_is_two_minutes(self):
        self.assertEqual(exporter.DEFAULT_TIMEOUT,120)

    def test_timeout_kills_only_owned_process(self):
        compiler=pathlib.Path(os.environ['WINDIR'])/'Microsoft.NET'/'Framework64'/'v4.0.30319'/'csc.exe'
        if not compiler.exists():self.skipTest('C# compiler unavailable')
        with tempfile.TemporaryDirectory(prefix='flpack-watchdog-') as directory:
            executable=pathlib.Path(directory)/'hang.exe'
            subprocess.run([str(compiler),'/nologo','/out:'+str(executable),str(pathlib.Path(__file__).parent/'fixtures'/'hang.cs')],check=True,capture_output=True)
            options={'exe':str(executable),'project':str(pathlib.Path(directory)/'p.flp'),'native':str(pathlib.Path(directory)/'p.zip'),'timeout':.5}
            helper=str(pathlib.Path(__file__).parents[1]/'automation'/'exporter.py')
            for blocked in (False,True):
                with self.subTest(blocked_dialog_scanner=blocked):
                    if blocked:
                        code="import sys,time;sys.path.insert(0,"+repr(str(pathlib.Path(helper).parent))+");import exporter;exporter.handle_dialogs=lambda *args:time.sleep(60);sys.exit(exporter.main())"
                        command=[sys.executable,'-c',code,json.dumps(options)]
                    else:
                        command=[sys.executable,helper,json.dumps(options)]
                    result=subprocess.run(command,input='',capture_output=True,text=True,timeout=15)
                    events=[json.loads(line)for line in result.stdout.splitlines()if line.startswith('{')]
                    self.assertEqual(result.returncode,1)
                    self.assertTrue(any(e['type']=='error'and 'Таймаут' in e['message']for e in events))
                    pid=next(e['pid']for e in events if e['type']=='started')
                    self.assertFalse(psutil.pid_exists(pid))

if __name__=='__main__':unittest.main()
