import { readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
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
  const fs = statfsSync(path),
    diskAvailableGiB = (fs.bavail * fs.bsize) / GiB;
  const diskUsedPercent = ((fs.blocks - fs.bfree) / (fs.blocks - fs.bfree + fs.bavail)) * 100;
  const reasons: string[] = [];
  if (available / GiB < limits.minMemoryGiB) reasons.push('Not enough available RAM');
  if (diskAvailableGiB < limits.minDiskGiB || diskUsedPercent >= limits.maxDiskPercent)
    reasons.push('Disk-space threshold reached');
  return {
    memoryAvailableGiB: available / GiB,
    memoryTotalGiB: total / GiB,
    diskAvailableGiB,
    diskUsedPercent,
    ok: reasons.length === 0,
    reasons,
  };
}
