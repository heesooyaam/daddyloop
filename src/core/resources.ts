import { readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname } from 'node:path';
import type { ResourceStatus } from './types.js';
const GiB = 1024 ** 3;
export function resources(
  path: string,
  limits = { minDiskGiB: 10, maxDiskPercent: 95, minMemoryGiB: 2 },
): ResourceStatus {
  let available = freemem(),
    total = totalmem();
  try {
    const mem = readFileSync('/proc/meminfo', 'utf8');
    available = Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? available / 1024) * 1024;
    total = Number(mem.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? total / 1024) * 1024;
  } catch {
    /* Non-Linux hosts use os.freemem(). */
  }
  const hostAvailable = available;
  const hostTotal = total;
  let memoryScope: 'host' | 'service' = 'host';
  try {
    const groups = readFileSync('/proc/self/cgroup', 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(':'));
    const candidates: {
      root: string;
      controller: string;
      limit: string;
      usage: string;
      inactive: string;
    }[] = [];
    const unified = groups.find((parts) => parts[0] === '0');
    if (unified)
      candidates.push({
        root: `/sys/fs/cgroup${unified[2]}`,
        controller: '/sys/fs/cgroup',
        limit: 'memory.max',
        usage: 'memory.current',
        inactive: 'inactive_file',
      });
    const memoryGroup = groups.find((parts) => parts[1].split(',').includes('memory'));
    if (memoryGroup)
      candidates.push({
        root: `/sys/fs/cgroup/memory${memoryGroup[2]}`,
        controller: '/sys/fs/cgroup/memory',
        limit: 'memory.limit_in_bytes',
        usage: 'memory.usage_in_bytes',
        inactive: 'total_inactive_file',
      });
    for (const candidate of candidates) {
      // An unlimited service can still share a capped parent slice/container.
      // Each ancestor's usage includes its siblings, so inspect all headroom limits.
      for (
        let root = candidate.root.replace(/\/+$/, '');
        root === candidate.controller || root.startsWith(candidate.controller + '/');
        root = dirname(root)
      ) {
        try {
          const limit = Number(readFileSync(`${root}/${candidate.limit}`, 'utf8').trim());
          if (!Number.isFinite(limit) || limit <= 0 || limit >= hostTotal) continue;
          const usage = Number(readFileSync(`${root}/${candidate.usage}`, 'utf8').trim());
          if (!Number.isFinite(usage) || usage < 0) continue;
          let inactive = 0;
          try {
            const stats = readFileSync(`${root}/memory.stat`, 'utf8');
            inactive = Number(
              stats.match(new RegExp(`^${candidate.inactive} (\\d+)`, 'm'))?.[1] ?? 0,
            );
          } catch {
            /* Missing cache statistics must not hide the memory limit. */
          }
          available = Math.min(available, Math.max(0, limit - Math.max(0, usage - inactive)));
          total = Math.min(total, limit);
          memoryScope = 'service';
        } catch {
          /* Try the parent or the next available controller. */
        }
      }
    }
  } catch {
    /* No Linux cgroup information is available. */
  }
  const fs = statfsSync(path),
    diskAvailableGiB = (fs.bavail * fs.bsize) / GiB;
  const diskUsedPercent = ((fs.blocks - fs.bfree) / (fs.blocks - fs.bfree + fs.bavail)) * 100;
  const reasons: string[] = [];
  if (available / GiB < limits.minMemoryGiB) reasons.push('Not enough available RAM');
  if (diskAvailableGiB < limits.minDiskGiB || diskUsedPercent >= limits.maxDiskPercent)
    reasons.push('Disk-space threshold reached');
  return {
    hostMemoryAvailableGiB: hostAvailable / GiB,
    memoryScope,
    memoryAvailableGiB: available / GiB,
    memoryTotalGiB: total / GiB,
    diskAvailableGiB,
    diskUsedPercent,
    ok: reasons.length === 0,
    reasons,
  };
}
