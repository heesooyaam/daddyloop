#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const localNode = join(root, '.tools/node/bin/node');
const executable = existsSync(localNode) ? localNode : process.execPath;
const built = join(root, 'dist/server/cli.js');
const args = existsSync(built) ? [built] : ['--import', 'tsx', join(root, 'src/cli.ts')];
const child = spawn(executable, [...args, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
