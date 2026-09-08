"""Verify a built archive through the real installer, using a loopback-only mirror."""
import functools
import http.server
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

root = Path(__file__).resolve().parent.parent
assets = root / '.reviewloop/releases'
corrupt_checksum = False

class Mirror(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
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
    with tempfile.TemporaryDirectory(prefix='reviewloop-install-test-') as temporary:
        prefix = Path(temporary) / 'prefix with spaces'
        bin_dir = Path(temporary) / 'bin'
        env = {**os.environ, 'REVIEWLOOP_DOWNLOAD_BASE': f'http://127.0.0.1:{server.server_port}', 'REVIEWLOOP_INSTALL_DIR': str(prefix), 'REVIEWLOOP_BIN_DIR': str(bin_dir)}
        def install(ok=True):
            result = subprocess.run(['bash', str(root / 'install.sh'), '--no-setup'], env=env, capture_output=True, text=True)
            if (result.returncode == 0) != ok:
                raise RuntimeError(result.stderr[-2000:] + result.stdout[-1000:])
            return result
        install()
        cli = bin_dir / 'reviewctl'
        version = subprocess.check_output([str(cli), '--version'], text=True).strip()
        assert version == json.loads((root / 'package.json').read_text())['version']
        data = prefix / 'data'; data.mkdir(); (data / 'keep.txt').write_text('user state')
        install()
        assert (data / 'keep.txt').read_text() == 'user state'
        target = os.readlink(prefix / 'current')
        corrupt_checksum = True
        failure = install(False)
        assert 'checksum mismatch' in failure.stderr
        assert os.readlink(prefix / 'current') == target
        corrupt_checksum = False
        cli.unlink(); cli.write_text('unrelated user command')
        failure = install(False)
        assert 'Existing reviewctl command preserved' in failure.stderr
        assert cli.read_text() == 'unrelated user command'
        assert os.readlink(prefix / 'current') == target
        print('PASS: fresh install, spaces in paths, bundled CLI, idempotent reinstall, checksum rejection and command-collision preservation.')
        (assets / 'installer-smoke.json').write_text(json.dumps({'passed': True, 'version': version, 'checks': ['fresh', 'spaces', 'bundled-cli', 'idempotent', 'checksum', 'command-collision', 'preserved-state']}, indent=2))
finally:
    server.shutdown()
    server.server_close()
