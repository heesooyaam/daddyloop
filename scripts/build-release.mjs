// Create a self-contained Linux release; never package the user's state or credentials.
import { cp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareSpeech } from './prepare-speech.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('Build releases on Linux x64 or arm64.');
const out = resolve(process.env.DADDYLOOP_RELEASE_DIR ?? join(root, '.daddyloop/releases'));
const stage = join(out, `stage-${process.pid}`),
  payload = join(stage, 'daddyloop'),
  app = join(payload, 'app');
await mkdir(app, { recursive: true });
try {
  for (const file of ['package.json', 'package-lock.json', 'README.md'])
    await cp(join(root, file), join(app, file));
  await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true });
  await cp(join(root, 'docs'), join(app, 'docs'), { recursive: true });
  await prepareSpeech(join(app, 'speech/whisper-small'));
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    npm_config_cache: join(out, 'npm-cache'),
    ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
  };
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: app,
    env,
    stdio: 'inherit',
  });
  // These are generated release files; retain only the target's CPU runtime.
  const ort = join(app, 'node_modules/onnxruntime-node/bin/napi-v3');
  for (const platform of ['darwin', 'win32'])
    await rm(join(ort, platform), { recursive: true, force: true });
  for (const arch of ['x64', 'arm64'])
    if (arch !== process.arch) await rm(join(ort, 'linux', arch), { recursive: true, force: true });
  const nodeVersion = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  const archiveName = `node-v${nodeVersion}-linux-${process.arch}.tar.gz`;
  const archive = join(stage, archiveName),
    base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const [download, sums] = await Promise.all([
    fetch(base + archiveName),
    fetch(base + 'SHASUMS256.txt'),
  ]);
  if (!download.ok || !sums.ok) throw new Error('Node download failed');
  const bytes = Buffer.from(await download.arrayBuffer());
  const expected = (await sums.text())
    .split('\n')
    .find((line) => line.trim().endsWith(archiveName))
    ?.split(/\s+/)[0];
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Node checksum mismatch');
  await writeFile(archive, bytes);
  await mkdir(join(payload, 'node'));
  execFileSync('tar', ['-xzf', archive, '-C', join(payload, 'node'), '--strip-components=1']);
  const tools = join(payload, 'tools');
  await mkdir(tools);
  execFileSync(
    'npm',
    ['install', '--prefix', tools, '--no-audit', '--no-fund', '@openai/codex@0.154.0'],
    { env, stdio: 'inherit' },
  );
  const ghVersion = '2.100.0',
    ghArch = process.arch === 'x64' ? 'amd64' : 'arm64',
    ghName = `gh_${ghVersion}_linux_${ghArch}.tar.gz`;
  const ghBase = `https://github.com/cli/cli/releases/download/v${ghVersion}/`;
  const [ghDownload, ghSums] = await Promise.all([
    fetch(ghBase + ghName),
    fetch(ghBase + `gh_${ghVersion}_checksums.txt`),
  ]);
  if (!ghDownload.ok || !ghSums.ok) throw new Error('GitHub CLI download failed');
  const ghBytes = Buffer.from(await ghDownload.arrayBuffer());
  const ghExpected = (await ghSums.text())
    .split('\n')
    .find((line) => line.trim().endsWith(ghName))
    ?.split(/\s+/)[0];
  if (createHash('sha256').update(ghBytes).digest('hex') !== ghExpected)
    throw new Error('GitHub CLI checksum mismatch');
  const ghArchive = join(stage, ghName);
  await writeFile(ghArchive, ghBytes);
  await mkdir(join(tools, 'bin'));
  execFileSync('tar', [
    '-xzf',
    ghArchive,
    '-C',
    join(tools, 'bin'),
    '--strip-components=2',
    `${ghName.slice(0, -7)}/bin/gh`,
  ]);
  await mkdir(join(payload, 'bin'));
  await cp(join(root, 'scripts/daddy-launcher.sh'), join(payload, 'bin/daddy'));
  await writeFile(
    join(payload, 'release.json'),
    JSON.stringify(
      {
        version: pkg.version,
        platform: process.platform,
        arch: process.arch,
        node: nodeVersion,
        codex: '0.154.0',
        gh: ghVersion,
      },
      null,
      2,
    ),
  );
  const launcher = join(payload, 'bin/daddy');
  execFileSync('chmod', ['755', launcher]);
  const runtime = join(payload, 'node/bin/node');
  const result = execFileSync(runtime, [join(app, 'dist/server/cli.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  if (result !== pkg.version) throw new Error('Release CLI version mismatch');
  const speechCheck = execFileSync(
    runtime,
    [
      '--input-type=module',
      '-e',
      `import { LocalSpeech } from './dist/server/runtime/speech.js'; const text = await new LocalSpeech('/unused').transcribe(process.env.VOICE_SAMPLE, 'en', AbortSignal.timeout(90000)); console.log(JSON.stringify({text}));`,
    ],
    {
      cwd: app,
      encoding: 'utf8',
      timeout: 100000,
      env: {
        PATH: dirname(runtime),
        LANG: 'C.UTF-8',
        OMP_NUM_THREADS: '2',
        VOICE_SAMPLE: join(root, 'tests/fixtures/voice-en.ogg'),
      },
    },
  );
  if (!/please\s+reply.*word/i.test(JSON.parse(speechCheck).text))
    throw new Error('Packaged voice recognition failed');
  execFileSync(join(tools, 'node_modules/.bin/codex'), ['--version'], {
    env: { ...env, PATH: `${join(payload, 'node/bin')}:${env.PATH}` },
    stdio: 'inherit',
  });
  if (!(await lstat(join(tools, 'bin/gh'))).isFile()) throw new Error('Missing GitHub CLI');
  const filename = `daddyloop-linux-${process.arch}.tar.gz`,
    target = join(out, filename);
  execFileSync('tar', ['-czf', target, '-C', stage, 'daddyloop']);
  const digest = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
  await writeFile(join(out, `${filename}.sha256`), `${digest}  ${filename}\n`);
  await cp(join(root, 'install.sh'), join(out, 'install.sh'));
  console.log(`Release ready: ${target}`);
} finally {
  if (existsSync(stage)) await rm(stage, { recursive: true });
}
