import { z } from 'zod';
import { AppError } from '../core/types.js';
import { cacheScheduleSchema, type CacheSchedule, type Config } from './config.js';
import { InstructionSources } from './instruction-sources.js';
import type { ScheduledCleanup } from './scheduled-cleanup.js';

const inputSchema = z
  .object({
    enabled: z.boolean().optional(),
    diskPercent: cacheScheduleSchema.shape.diskPercent.removeDefault().optional(),
    intervalMinutes: cacheScheduleSchema.shape.intervalMinutes.removeDefault().optional(),
    skillPath: z.string().trim().min(1).max(2048).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose a cleanup setting to change');

export class CleanupControls {
  constructor(
    private scheduler: ScheduledCleanup,
    private pausePercent: number,
    private readConfig: () => Config,
    private persist: (config: Config) => void,
  ) {}
  status() {
    return { ...this.scheduler.status(), pausePercent: this.pausePercent };
  }
  async update(raw: unknown) {
    const { skillPath, ...changes } = inputSchema.parse(raw);
    const skill = skillPath
      ? await new InstructionSources().import({ kind: 'local', path: skillPath })
      : undefined;
    // Import can take time. Merge only the requested fields into the latest config.
    const config = this.readConfig();
    const patch: Partial<CacheSchedule> = {
      ...changes,
      ...(skillPath !== undefined ? { skill } : {}),
    };
    const previous = cacheScheduleSchema.parse(config.cache.schedule ?? {});
    const next = cacheScheduleSchema.parse({ ...previous, ...patch });
    if (next.enabled && (!config.cache.auto || !this.scheduler.status().automaticCleanup))
      throw new AppError('cache_disabled', 'Enable automatic cache cleanup on the host first', 422);
    if (next.diskPercent >= Math.min(this.pausePercent, config.resources.maxDiskPercent))
      throw new AppError(
        'cleanup_threshold',
        'The cleanup threshold must be lower than the pause threshold',
        422,
      );
    this.persist({ ...config, cache: { ...config.cache, schedule: next } });
    this.scheduler.configure({
      enabled: next.enabled,
      diskPercent: next.diskPercent,
      intervalMinutes: next.intervalMinutes,
      skill: next.skill,
    });
    return this.status();
  }
}
export type CleanupScheduleStatus = ReturnType<CleanupControls['status']>;
