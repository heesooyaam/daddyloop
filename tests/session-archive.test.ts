import { expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchive, verifySessionArchive } from '../src/runtime/session-archive.js';

it('verifies archived contents before the working copy can be removed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-session-archive-')));
  try {
    const archive = new SessionArchive(root, 0);
    await archive.text('session.json', '{"goal":"Keep this"}');
    await archive.text('arcadia/task/author/files/new.txt', 'unpublished work');
    await archive.text(
      'ownership.json',
      JSON.stringify({ format: 1, sessionId: 'fixture', fingerprints: {}, files: archive.files }),
    );
    await archive.sync();
    const verified = await verifySessionArchive(root, 'fixture');
    expect(verified.manifest.files).toHaveLength(2);
    writeFileSync(join(root, 'arcadia/task/author/files/new.txt'), 'changed');
    await expect(verifySessionArchive(root, 'fixture', verified.digest)).rejects.toThrow(
      'archive file changed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('does not follow a replaced manifest or an external file symlink', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-session-archive-')));
  const outside = root + '-external';
  writeFileSync(outside, 'private external content');
  try {
    const archive = new SessionArchive(root, 0);
    symlinkSync(outside, join(root, 'source-link'));
    await expect(archive.file('files/link', join(root, 'source-link'))).rejects.toThrow(
      'outside its archive',
    );
    symlinkSync(outside, join(root, 'ownership.json'));
    await expect(verifySessionArchive(root, 'fixture')).rejects.toThrow('manifest was replaced');
    expect(readFileSync(outside, 'utf8')).toBe('private external content');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside);
  }
});
