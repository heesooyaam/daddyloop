import { rmSync } from 'node:fs';
// dist is generated output owned by this build.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
