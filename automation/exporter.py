"""Native CLI export with a process-scoped pywinauto dialog watchdog.

Dismiss blocking dialogs belonging to the export process and its children.
No foreground switching, screen clicks, global keystrokes or closing foreign apps.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import pathlib
import ctypes
import psutil
from pywinauto import Desktop
import win32gui
import win32ui
from PIL import Image

DEFAULT_TIMEOUT = 120


def click_button(button):
    # Bound cross-process calls: a hung plugin must not hang the watchdog too.
    if button.class_name() == 'Button':
        messages = [(0x00F5, 0, 0)]  # BM_CLICK
    else:
        # Delphi controls do not necessarily implement BM_CLICK. Deliver local
        # mouse messages to the control HWND, without moving the user's pointer.
        left, top, right, bottom = win32gui.GetClientRect(button.handle)
        point = ((bottom // 2) << 16) | (right // 2)
        messages = [(0x0201, 1, point), (0x0202, 0, point)]
    for message, wparam, lparam in messages:
        result = ctypes.c_size_t()
        if not ctypes.windll.user32.SendMessageTimeoutW(
                ctypes.c_void_p(button.handle), message, wparam, lparam, 0x0002, 200,
                ctypes.byref(result)):
            raise RuntimeError('Кнопка диалога не отвечает')


def button_label(button):
    return button.window_text().replace('&', '').strip().casefold().rstrip('.…')


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=True), flush=True)


def missing_plugin(text):
    text = text.lower().replace("’", "'")
    return bool(re.search(r"(?:plugin|plug-in|плагин)", text) and re.search(
        r"not found|could not be found|couldn't be found|could not find|couldn't find|cannot be found|missing|не найден|не удалось найти|отсутств", text))


def terminate_owned(process):
    try:
        parent = psutil.Process(process.pid)
        for child in parent.children(recursive=True):
            try:
                child.kill()
            except psutil.Error:
                pass
        parent.kill()
    except psutil.Error:
        pass


def capture_dialog(window, directory, number):
    if not directory:
        return None
    pathlib.Path(directory).mkdir(parents=True, exist_ok=True)
    filename=str(pathlib.Path(directory)/f'{number:03d}.png')
    rect=window.rectangle()
    dc=win32gui.GetWindowDC(window.handle)
    source=win32ui.CreateDCFromHandle(dc)
    target=source.CreateCompatibleDC()
    bitmap=win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source,rect.width(),rect.height())
        target.SelectObject(bitmap)
        if not ctypes.windll.user32.PrintWindow(window.handle,target.GetSafeHdc(),2):
            return None
        Image.frombuffer('RGB',(rect.width(),rect.height()),bitmap.GetBitmapBits(True),'raw','BGRX',0,1).save(filename)
        return filename
    finally:
        target.DeleteDC()
        source.DeleteDC()
        win32gui.ReleaseDC(window.handle,dc)
        win32gui.DeleteObject(bitmap.GetHandle())


def handle_dialogs(pid, handled, warning_dir=None):
    observations = []
    try:
        # win32 is deliberate: sending BM_CLICK works without stealing focus.
        windows = Desktop(backend="win32").windows(process=pid, visible_only=True)
        for window in windows:
            try:
              class_name = window.class_name()
              owner = win32gui.GetWindow(window.handle, 4)  # GW_OWNER
              modal = bool(owner and not win32gui.IsWindowEnabled(owner))
              if class_name in ('TFruityLoopsMainForm', 'TApplication'):
                  continue
              if class_name not in ("#32770", "TMsgForm", "TMessageForm", "TExceptionDialog", "TMissingPluginsForm") and not modal:
                  observations.append(class_name+': '+window.window_text())
                  continue
              descendants = window.descendants()
              text = "\n".join(dict.fromkeys([window.window_text()] + [c.window_text() for c in descendants if c.window_text()]))
              if window.class_name() == "TMissingPluginsForm" and window.window_text() == "Problems loading the project":
                  # FL's vector-drawn grid and buttons expose no labels to Win32 or UIA.
                  # The three painted buttons, from right to left: samples help,
                  # plugins help, OK. FL also exposes an unused fourth HWND to their left.
                  # Use the returned control HWND and message-based click, no screen input.
                  key = (window.handle, text)
                  if key not in handled:
                      buttons=sorted([c for c in descendants if c.class_name()=='TQuickFocusBtn' and c.is_visible()],key=lambda c:c.rectangle().left)
                      grid=[c for c in descendants if c.class_name()=='TQuickStringGrid']
                      if len(buttons) not in (3,4) or len(grid)!=1:
                          observations.append('Unrecognized missing-plugins form layout')
                          win32gui.PostMessage(window.handle, 0x0100, 0x0D, 0)
                          win32gui.PostMessage(window.handle, 0x0101, 0x0D, 0)
                          continue
                      painted=buttons[-3:]
                      if len({c.rectangle().top for c in painted})!=1 or any(c.rectangle().top<grid[0].rectangle().bottom for c in painted):
                          observations.append('Unrecognized missing-plugins button layout')
                          win32gui.PostMessage(window.handle, 0x0100, 0x0D, 0)
                          win32gui.PostMessage(window.handle, 0x0101, 0x0D, 0)
                          continue
                      screenshot=None
                      try:
                          screenshot=capture_dialog(window,warning_dir,len(handled)+1)
                      except Exception:
                          pass  # Diagnostics must never prevent acknowledging a dialog.
                      click_button(painted[0])
                      # The form can become visible before its event handlers are ready.
                      # An early click is ignored by FL; acknowledge only after it closes.
                      time.sleep(0.08)
                      if win32gui.IsWindow(window.handle) and win32gui.IsWindowVisible(window.handle):
                          observations.append('Missing-plugins OK not accepted yet; retrying on next poll')
                          continue
                      handled.add(key)
                      emit("missing-plugin", text="FL Studio не смогла загрузить один или несколько плагинов. Диалог подтверждён; ZIP сохранён в том виде, в котором его экспортировала FL Studio.", screenshot=screenshot)
                  continue
              observations.append(text[:6000])
              buttons = [c for c in descendants if c.is_visible() and c.is_enabled()
                         and c.class_name() in ('Button', 'TButton', 'TBitBtn', 'TQuickFocusBtn')]
              # File pickers and save/overwrite prompts should be skipped, not saved.
              file_prompt = any(c.class_name() in ('Edit', 'ComboBoxEx32', 'SHELLDLL_DefView') for c in descendants)
              labels = ('cancel', 'отмена', 'no', 'нет') if file_prompt else (
                  'ok', 'ок', 'ignore', 'игнорировать', 'пропустить', 'skip',
                  'continue', 'продолжить', 'close', 'закрыть', 'no', 'нет', 'cancel', 'отмена', 'yes', 'да')
              selected = next((c for label in labels for c in buttons if button_label(c) == label), None)
              if selected is not None:
                  click_button(selected)
              else:
                  # Custom painted Delphi dialogs may expose no button labels.
                  # WM_CLOSE skips those dialogs without injecting foreground input.
                  win32gui.PostMessage(window.handle, 0x0010, 0, 0)
              time.sleep(0.05)
              if win32gui.IsWindow(window.handle) and win32gui.IsWindowVisible(window.handle):
                  continue  # Retry until FL accepts the action; don't mark an early click as done.
              handled.add((window.handle, text))
              emit('missing-plugin' if missing_plugin(text) else 'dialog-dismissed', text=text[:6000])
            except Exception as error:
              observations.append(str(error))
    except Exception as error:
        observations.append(str(error))
    return observations


def main():
    options = json.loads(sys.argv[1])
    process = subprocess.Popen([options["exe"], "/Z" + options["project"]], cwd=os.path.dirname(options["project"]))
    emit("started", pid=process.pid)
    cancelled = threading.Event()

    def read_commands():
        for line in sys.stdin:
            if line.strip() == "cancel":
                cancelled.set()
                break
        if options.get('watchParent'):
            cancelled.set()
    threading.Thread(target=read_commands, daemon=True).start()
    started = time.monotonic()
    finished = threading.Event()
    observations = []

    def enforce_deadline():
        # Enumeration or a third-party control can hang inside a Win32 call.
        # Enforce the deadline independently of the dialog polling loop.
        if not finished.wait(options.get('timeout', DEFAULT_TIMEOUT)):
            emit('error', message='Таймаут FL Studio. Исходная папка сохранена.' +
                 (' Окна: ' + ' | '.join(observations[-20:]) if observations else ''),
                 seconds=round(time.monotonic() - started, 2))
            terminate_owned(process)
            os._exit(1)

    threading.Thread(target=enforce_deadline, daemon=True).start()
    handled = set()
    try:
        while process.poll() is None:
            if cancelled.is_set():
                raise RuntimeError("Обработка отменена; исходники сохранены")
            if time.monotonic() - started > options.get("timeout", DEFAULT_TIMEOUT):
                raise RuntimeError("Таймаут FL Studio. Окна: " + " | ".join(observations))
            observations = handle_dialogs(process.pid, handled, options.get('warningDir'))
            try:
                children = psutil.Process(process.pid).children(recursive=True)
            except psutil.Error:
                children = []
            for child in children:
                if time.monotonic() - started > options.get('timeout', DEFAULT_TIMEOUT):
                    break
                observations.extend(handle_dialogs(child.pid, handled, options.get('warningDir')))
            time.sleep(0.2)
        if process.returncode != 0:
            raise RuntimeError("FL Studio завершилась с кодом " + str(process.returncode))
        if not os.path.isfile(options["native"]):
            raise RuntimeError("FL Studio завершилась, но ZIP не появился")
        emit("complete", warnings=len(handled), seconds=round(time.monotonic() - started, 2))
    except Exception as error:
        terminate_owned(process)
        emit("error", message=str(error))
        return 1
    finally:
        finished.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
