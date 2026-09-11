"""Verify a built archive through the real installer, using a loopback-only mirror."""
import functools
import http.server
import json
import os
import subprocess
import tempfile
import threading
import pty
import select
import termios
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
assets = root / '.daddyloop/releases'
corrupt_checksum = False
requested_assets = []

class Mirror(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        requested_assets.append(self.path)
        if corrupt_checksum and self.path.endswith('.sha256'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'0' * 64 + b'  archive.tar.gz\n')
        else:
            super().do_GET()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Mirror, directory=str(assets)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='daddyloop-install-test-') as temporary:
        prefix = Path(temporary) / 'prefix with spaces'
        bin_dir = Path(temporary) / 'bin'
        env = {**os.environ, 'DADDYLOOP_DOWNLOAD_BASE': f'http://127.0.0.1:{server.server_port}', 'DADDYLOOP_INSTALL_DIR': str(prefix), 'DADDYLOOP_BIN_DIR': str(bin_dir)}
        def install(ok=True, modules=None):
            result = subprocess.run(['bash', str(root / 'install.sh'), '--no-setup'] + (['--modules', modules] if modules else []), env=env, capture_output=True, text=True)
            if (result.returncode == 0) != ok:
                raise RuntimeError(result.stderr[-2000:] + result.stdout[-1000:])
            return result
        install()
        assert sorted(p.name for p in bin_dir.iterdir()) == ['daddy'], 'Only the daddy executable is installed'
        cli = bin_dir / 'daddy'
        version = subprocess.check_output([str(cli), '--version'], text=True).strip()
        assert version == json.loads((root / 'package.json').read_text())['version']
        # --version alone does not load the lazy TUI and cannot verify its dependencies.
        console_state = Path(temporary) / 'console-state'; console_state.mkdir()
        (console_state / 'access-token').write_text('installer-demo-token')
        console_config = Path(temporary) / 'console-config.json'
        console_url = f'http://127.0.0.1:{server.server_port}'
        console_config.write_text(json.dumps({'dataDir': str(console_state), 'serverUrl': console_url}))
        master, slave = pty.openpty(); before_modes = termios.tcgetattr(slave)
        console_env = {**env, 'DADDYLOOP_CONFIG': str(console_config), 'DADDYLOOP_DATA_DIR': str(console_state), 'DADDYLOOP_URL': console_url, 'TERM': 'xterm-256color'}
        child = subprocess.Popen([str(cli)], stdin=slave, stdout=slave, stderr=slave, env=console_env, start_new_session=True)
        captured = bytearray()
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.1)
                if readable: captured.extend(os.read(master, 65536))
                if b'\x1b[?2004h' in captured: break
                if child.poll() is not None: break
            assert b'\x1b[?1049h' in captured and b'daddyloop.' in captured, 'Bundled TUI did not render'
            os.write(master, b'\x11')
            deadline = time.monotonic() + 10
            while child.poll() is None and time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.1)
                if readable: captured.extend(os.read(master, 65536))
            assert child.poll() == 0, 'Bundled TUI did not exit cleanly'
            after_modes = termios.tcgetattr(slave)
            assert after_modes[3] & (termios.ICANON | termios.ECHO) == before_modes[3] & (termios.ICANON | termios.ECHO), 'Terminal modes were not restored'
        finally:
            if child.poll() is None: child.terminate(); child.wait(timeout=10)
            os.close(master); os.close(slave)
        data = prefix / 'data'; data.mkdir(); (data / 'keep.txt').write_text('user state')
        install()
        assert (data / 'keep.txt').read_text() == 'user state'
        target = os.readlink(prefix / 'current')
        assert sorted(p.name for p in (prefix/'current/modules').iterdir()) == ['codex','github']
        requested_assets.clear()
        install(modules='codex,gitlab')
        alternate = os.readlink(prefix/'current')
        assert alternate != target, 'Each module selection must have an immutable variant'
        assert (Path(target)/'.archive-sha256').exists(), 'The preceding variant must not be overwritten'
        assert sorted(p.name for p in (prefix/'current/modules').iterdir()) == ['codex']
        assert json.loads((prefix/'current/installed-modules.json').read_text())['modules'] == ['codex','gitlab']
        assert not any('daddyloop-github-' in path for path in requested_assets), 'An unchecked module was downloaded'
        assert (data/'keep.txt').read_text() == 'user state'
        install()
        assert os.readlink(prefix/'current') == target, 'Reusing the same selection must select the original variant'
        corrupt_checksum = True
        failure = install(False)
        assert 'checksum mismatch' in failure.stderr
        assert os.readlink(prefix / 'current') == target
        corrupt_checksum = False
        cli.unlink(); cli.write_text('unrelated user command')
        failure = install(False)
        assert 'Existing daddy command preserved' in failure.stderr
        assert cli.read_text() == 'unrelated user command'
        assert os.readlink(prefix / 'current') == target
        print('PASS: fresh install, paths with spaces, bundled TUI in a PTY, idempotent reinstall, checksum rejection and preservation.')
        (assets / 'installer-smoke.json').write_text(json.dumps({'passed': True, 'version': version, 'checks': ['fresh', 'spaces', 'bundled-tui-pty', 'idempotent', 'checksum', 'command-collision', 'preserved-state', 'selected-downloads', 'immutable-module-variants']}, indent=2))
finally:
    server.shutdown()
    server.server_close()
