"""Opt-in host test: a temporary loopback-only SSH server; no global SSH config changes."""
import json
import os
import pwd
import select
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
state = Path(os.environ.get('REVIEWLOOP_DATA_DIR', str(root / '.reviewloop')))
base = 'http://127.0.0.1:4317/api'
token = (state / 'access-token').read_text().strip()
def api(path, body=None):
    request = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)

before = api('/health')
task = None
result = {'before_pid': before['pid'], 'passed': False}
with tempfile.TemporaryDirectory(prefix='reviewloop-ssh-test-', dir=str(Path.home())) as directory:
    temporary = Path(directory)
    for name in ['host', 'client']:
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(temporary/name)], check=True, stdout=subprocess.DEVNULL)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    authorized = temporary/'authorized_keys'; authorized.write_text((temporary/'client.pub').read_text()); authorized.chmod(0o600)
    known = temporary/'known_hosts'; known.write_text('[127.0.0.1]:' + str(port) + ' ' + (temporary/'host.pub').read_text())
    config = temporary/'sshd_config'; pidfile = temporary/'sshd.pid'
    config.write_text('\n'.join([
        'ListenAddress 127.0.0.1', 'Port ' + str(port), 'HostKey ' + str(temporary/'host'),
        'PidFile ' + str(pidfile), 'AuthorizedKeysFile ' + str(authorized),
        'AllowUsers ' + pwd.getpwuid(os.getuid()).pw_name, 'PubkeyAuthentication yes',
        'PasswordAuthentication no', 'ChallengeResponseAuthentication no', 'UsePAM yes',
        'PermitRootLogin no', 'AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no',
        'PrintMotd no', 'StrictModes yes', 'LogLevel ERROR', ''
    ]))
    server = subprocess.Popen(['sudo', '-n', '/usr/sbin/sshd', '-D', '-f', str(config)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    client = None
    try:
        for _ in range(100):
            if pidfile.exists(): break
            if server.poll() is not None: raise RuntimeError('Temporary sshd failed to start: ' + server.stderr.read().decode()[:500])
            time.sleep(0.05)
        client = subprocess.Popen(['ssh', '-tt', '-p', str(port), '-i', str(temporary/'client'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ConnectTimeout=10', pwd.getpwuid(os.getuid()).pw_name + '@127.0.0.1', "printf 'REVIEWLOOP_SSH_SESSION_READY\\n'; sleep 60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = b''; deadline = time.time() + 20
        while time.time() < deadline and b'REVIEWLOOP_SSH_SESSION_READY' not in output:
            readable, _, _ = select.select([client.stdout], [], [], 0.25)
            if readable: output += os.read(client.stdout.fileno(), 4096)
            if client.poll() is not None: raise RuntimeError('SSH session did not authenticate: ' + client.stderr.read().decode()[:500])
        if b'REVIEWLOOP_SSH_SESSION_READY' not in output: raise RuntimeError('SSH session was not established')
        task = api('/demo', {})
        client.kill(); client.wait(timeout=10)
        after = api('/health')
        if before['pid'] != after['pid']: raise RuntimeError('Service PID changed when the SSH client was killed')
        for _ in range(100):
            detail = api('/tasks/' + task['id'])
            if detail['task']['state'] == 'awaiting_publication': break
            time.sleep(0.1)
        else: raise RuntimeError('Task did not progress after disconnect')
        result.update({'passed': True, 'after_pid': after['pid'], 'task_id': task['id'], 'state_after_disconnect': detail['task']['state'], 'ssh_client_killed': True})
        print('PASS: real SSH client killed; service PID unchanged; queued review completed afterward.')
    finally:
        if client and client.poll() is None: client.kill(); client.wait(timeout=10)
        if task:
            try: api('/tasks/' + task['id'] + '/actions', {'action': 'pause', 'reason': 'SSH-disconnect smoke test complete; demo retained for inspection'})
            except Exception: pass
        if pidfile.exists():
            pid = int(pidfile.read_text().strip())
            commandline = Path('/proc')/str(pid)/'cmdline'
            if commandline.exists() and str(config).encode() in commandline.read_bytes(): subprocess.run(['sudo', '-n', 'kill', '-TERM', str(pid)], check=False)
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.terminate(); server.wait(timeout=10)
        (state/'ssh-disconnect-smoke.json').write_text(json.dumps(result, indent=2))
