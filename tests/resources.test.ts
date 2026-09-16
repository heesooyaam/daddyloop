import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resources } from '../src/core/resources.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
}));
afterEach(() => vi.mocked(readFileSync).mockReset());
const GiB = 1024 ** 3;
const status = (files: Record<string, string>) => {
  const all: Record<string, string> = {
    '/proc/meminfo': `MemTotal: ${90 * 1024 ** 2} kB\nMemAvailable: ${78 * 1024 ** 2} kB\n`,
    ...files,
  };
  vi.mocked(readFileSync).mockImplementation((file) => {
    if (String(file) in all) return all[String(file)];
    throw new Error('ENOENT');
  });
  return resources(tmpdir(), { minMemoryGiB: 2, minDiskGiB: 0, maxDiskPercent: 100 });
};
const root = '/sys/fs/cgroup';
it('reports host RAM when the service and its parents have no memory cap', () => {
  const result = status({
    '/proc/self/cgroup': '0::/system.slice/daddyloop.service',
    [root + '/system.slice/daddyloop.service/memory.max']: 'max',
    [root + '/system.slice/memory.max']: 'max',
  });
  expect(result).toMatchObject({
    memoryScope: 'host',
    memoryTotalGiB: 90,
    memoryAvailableGiB: 78,
    ok: true,
  });
});
it('honors a parent slice cap for an unlimited service', () => {
  const result = status({
    '/proc/self/cgroup': '0::/system.slice/daddyloop.service',
    [root + '/system.slice/daddyloop.service/memory.max']: 'max',
    [root + '/system.slice/memory.max']: String(20 * GiB),
    [root + '/system.slice/memory.current']: String(19 * GiB),
  });
  expect(result).toMatchObject({
    memoryScope: 'service',
    memoryTotalGiB: 20,
    memoryAvailableGiB: 1,
    ok: false,
  });
  expect(result.reasons).toContain('Not enough available RAM');
});
it('includes sibling usage even when the child has a smaller cap than its parent', () => {
  const result = status({
    '/proc/self/cgroup': '0::/system.slice/daddyloop.service',
    [root + '/system.slice/daddyloop.service/memory.max']: String(8 * GiB),
    [root + '/system.slice/daddyloop.service/memory.current']: String(2 * GiB),
    [root + '/system.slice/memory.max']: String(20 * GiB),
    [root + '/system.slice/memory.current']: String(19 * GiB),
  });
  expect(result).toMatchObject({ memoryTotalGiB: 8, memoryAvailableGiB: 1, ok: false });
});
it('counts reclaimable file cache and the parent limit on cgroup v1 hosts', () => {
  const parent = root + '/memory/system.slice';
  const result = status({
    '/proc/self/cgroup': '9:memory:/system.slice/daddyloop.service',
    [parent + '/daddyloop.service/memory.limit_in_bytes']: '9223372036854771712',
    [parent + '/memory.limit_in_bytes']: String(20 * GiB),
    [parent + '/memory.usage_in_bytes']: String(19 * GiB),
    [parent + '/memory.stat']: `total_inactive_file ${3 * GiB}\n`,
  });
  expect(result).toMatchObject({
    memoryScope: 'service',
    memoryTotalGiB: 20,
    memoryAvailableGiB: 4,
    ok: true,
  });
});
it('honors the root limit of a container cgroup namespace', () => {
  const result = status({
    '/proc/self/cgroup': '0::/',
    [root + '/memory.max']: String(12 * GiB),
    [root + '/memory.current']: String(7 * GiB),
    [root + '/memory.stat']: 'inactive_file 0\n',
  });
  expect(result).toMatchObject({
    memoryScope: 'service',
    memoryTotalGiB: 12,
    memoryAvailableGiB: 5,
  });
});
