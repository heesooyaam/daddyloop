"""Install a project-local, checksum-verified Node LTS; never change system Node."""
import hashlib
import platform
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = (root / '.nvmrc').read_text().strip()
machine = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
system = {'Linux': 'linux', 'Darwin': 'darwin'}.get(platform.system())
if not machine or not system:
    raise SystemExit('Install Node.js >= 24 using your platform package manager.')
name = 'node-v{}-{}-{}'.format(version, system, machine)
archive = name + '.tar.gz'
base = 'https://nodejs.org/dist/v' + version + '/'
tools = root / '.tools'
tools.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='node-install-', dir=str(tools)) as tmp:
    target = Path(tmp) / archive
    urllib.request.urlretrieve(base + archive, str(target))
    checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == archive)
    with target.open('rb') as file:
        digest = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise SystemExit('Node archive checksum mismatch')
    with tarfile.open(str(target)) as tar:
        for member in tar.getmembers():
            if (member.name != name and not member.name.startswith(name + '/')) or '..' in Path(member.name).parts:
                raise SystemExit('Unexpected archive path')
        tar.extractall(tmp)
    destination = tools / 'node'
    if destination.exists():
        raise SystemExit('Project-local Node already exists; refusing to replace it.')
    shutil.move(str(Path(tmp) / name), str(destination))
print('Installed Node ' + version + ' into .tools/node')
