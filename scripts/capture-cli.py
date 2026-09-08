"""Record actual terminal screen updates and verify PTY input, resize and teardown."""
import fcntl
import codecs
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request
from pathlib import Path

node, entry, config_path, output_path, task_id = sys.argv[1:]
config = json.loads(Path(config_path).read_text())
if not config['serverUrl'].startswith('http://127.0.0.1:') or not config.get('demo'):
    raise RuntimeError('Use an isolated loopback demo server')
token = (Path(config['dataDir']) / 'access-token').read_text().strip()
def api(path):
    request = urllib.request.Request(config['serverUrl'] + '/api' + path, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)
before_pid = api('/health')['pid']
initial = api('/tasks/' + task_id)
if initial['task']['ref']['provider'] != 'demo': raise RuntimeError('Only demo tasks may be used for terminal capture')
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
all_snapshots = []

def session(theme='dark', exercise=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    env = {**os.environ, 'REVIEWLOOP_CONFIG': config_path, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'FORCE_COLOR': '3'}
    env.pop('NO_COLOR', None)
    child = subprocess.Popen([node, entry, '--theme', theme, 'console', task_id], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    events = []; output = bytearray(); snapshots = []; decoder = codecs.getincrementaldecoder('utf-8')()
    def drain(seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], min(0.05, max(0, deadline-time.monotonic())))
            if readable:
                try: data = os.read(master, 65536)
                except OSError: return
                if data:
                    output.extend(data); events.append({'data': decoder.decode(data)})
    def wait(marker, start=0):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            drain(0.1)
            if marker in ansi.sub('', output[start:].decode('utf-8', errors='replace')):
                drain(0.25); return
            if child.poll() is not None: break
        raise RuntimeError('Terminal did not render expected content: ' + marker)
    def write(value):
        start = len(output); os.write(master, value.encode()); drain(0.1); return start
    def command(value):
        start = write(value); write('\r'); return start
    def snapshot(name):
        drain(0.2); snapshots.append({'name': name, 'at': len(events)})
    try:
        wait('Connected to your service'); wait('Demo fixture:')
        snapshot('cli' if theme == 'dark' else 'cli-light')
        if exercise:
            start = write('Can this happen on a single event loop?')
            write('\n')  # Ctrl+J, a newline rather than send.
            write('Please keep the draft unpublished.')
            count = len(api('/tasks/' + task_id)['messages'])
            if count != len(initial['messages']): raise RuntimeError('Typing/Ctrl+J unexpectedly submitted a message')
            snapshot('cli-compose')
            start = write('\r'); wait('ordering', start)
            actual = api('/tasks/' + task_id)
            sent = [m for m in actual['messages'] if m['sender'] == 'user'][-1]
            if sent['role'] != 'reviewer' or sent['text'] != 'Can this happen on a single event loop?\nPlease keep the draft unpublished.': raise RuntimeError('Multiline input was not delivered exactly')
            snapshot('cli-chat')
            start = write('\t'); wait('Separate from the reviewer', start)
            write('Unsent author draft'); snapshot('cli-author')
            write('\t'); drain(0.2)
            write('\x1b[200~/publish\nThis is pasted text, not a command.\x1b[201~')
            drain(0.3)
            if api('/tasks/' + task_id)['task']['state'] != 'awaiting_publication': raise RuntimeError('Pasted text changed publication state')
            write('\x03')  # Clear the pasted draft.
            write('/'); wait('COMMANDS'); snapshot('cli-menu')
            write('\x1b'); write('\x03')
            start = write('\x14'); wait('Choose a task', start); snapshot('cli-tasks'); write('\x1b')
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0)); events.append({'resize': [80, 24]}); os.kill(child.pid, signal.SIGWINCH); drain(0.4); snapshot('cli-compact')
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0)); events.append({'resize': [120, 40]}); os.kill(child.pid, signal.SIGWINCH); drain(0.4)
        start = len(output)
        if theme == 'light': os.kill(child.pid, signal.SIGHUP)  # An SSH/terminal hangup.
        else: write('\x11')  # Ctrl+Q closes only the client.
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline: drain(0.1)
        if child.poll() is None: raise RuntimeError('Terminal did not exit promptly')
        drain(0.1)
        restored = termios.tcgetattr(slave)
        mask = termios.ICANON | termios.ECHO | termios.ISIG
        if restored[3] & mask != original[3] & mask: raise RuntimeError('Terminal input modes were not restored')
        if b'\x1b[?1049h' not in output or b'\x1b[?1049l' not in output[start:]: raise RuntimeError('Alternate screen was not entered/restored')
        if b'\x1b[?2004l' not in output[start:]: raise RuntimeError('Bracketed paste was not disabled on exit')
        if child.returncode != 0: raise RuntimeError('CLI exited with an error')
        return {'theme': theme, 'columns': 120, 'rows': 40, 'events': events, 'snapshots': snapshots}
    finally:
        if child.poll() is None: child.terminate(); child.wait(timeout=10)
        os.close(master); os.close(slave)

recordings = [session('dark', True), session('light')]
if api('/health')['pid'] != before_pid: raise RuntimeError('Service was restarted by the console')
if api('/tasks/' + task_id)['task']['state'] != 'awaiting_publication': raise RuntimeError('Closing the console changed the task')
Path(output_path).write_text(json.dumps({'recordings': recordings, 'verified': ['multiline', 'paste', 'roles', 'resize', 'terminal-restoration', 'hangup', 'service-persists']}, ensure_ascii=False))
print('PASS: real TUI PTY, multiline/paste, role navigation, resize, terminal restoration and persistent service')
