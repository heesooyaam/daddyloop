"""Capture the real CLI in a private PTY; only a demo-server config is accepted."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

node, entry, config_path, output_path, *task_ids = sys.argv[1:]
config = json.loads(Path(config_path).read_text())
if not config['serverUrl'].startswith('http://127.0.0.1:') or not config.get('demo'):
    raise RuntimeError('The capture requires an isolated loopback demo server')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 110, 0, 0))
child = subprocess.Popen([node, entry], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'REVIEWLOOP_CONFIG': config_path, 'TERM': 'xterm-256color'}, start_new_session=True)
os.close(slave)
transcript = bytearray()
def receive(marker):
    start = len(transcript)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            transcript.extend(os.read(master, 65536))
            if marker in transcript[start:]: return
        if child.poll() is not None: break
    raise RuntimeError('CLI did not reach the expected prompt')
try:
    receive(b'reviewloop > ')
    if task_ids:
        prefix = task_ids[0][:8]
        os.write(master, f'/use {prefix}\n'.encode())
        receive(f'{prefix}:reviewer > '.encode())
        os.write(master, b'Can this happen on a single event loop?\n')
        receive(b'In live mode this conversation continues in the same Codex thread.')
        os.write(master, b'/role author\n')
        receive(f'{prefix}:author > '.encode())
        os.write(master, b'/status\n')
        receive(f'{prefix}:author > '.encode())
    else:
        os.write(master, b'/help\n')
        receive(b'reviewloop > ')
    Path(output_path).write_bytes(transcript)
    os.write(master, b'/quit\n')
    child.wait(timeout=10)
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=10)
    os.close(master)
