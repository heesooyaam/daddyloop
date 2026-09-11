import { afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Ordinary tests must not read the installed service's configuration or credentials.
const directory = mkdtempSync(join(tmpdir(), 'daddyloop-test-config-'));
process.env.DADDYLOOP_CONFIG = join(directory, 'config.json');
writeFileSync(process.env.DADDYLOOP_CONFIG, JSON.stringify({ dataDir: join(directory, 'data') }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
