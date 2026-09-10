import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../core/store.js';
import { AppError, now, type Project, type ResourceStatus } from '../core/types.js';
import type { Locale } from '../i18n/index.js';
import type { Speech } from '../runtime/speech.js';
import { redact } from '../core/security.js';
export interface VoiceRoute {
  ownerId: number;
  chatId: number;
  threadId?: number;
  groupId: string;
  generation: number;
  project: Project;
  locale: Locale;
}
export interface VoiceJob {
  id: string;
  receipt: string;
  route: VoiceRoute;
  fileId?: string;
  duration?: number;
  text?: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  error?: string;
  previewed?: boolean;
  createdAt: string;
}
export class VoiceInbox {
  private timer?: NodeJS.Timeout;
  private active?: { abort: AbortController; done: Promise<void> };
  private stopped = false;
  constructor(
    private store: Store,
    private dataDir: string,
    private speech: Speech,
    private download: (id: string, signal: AbortSignal) => Promise<Uint8Array>,
    private deliver: (job: VoiceJob, signal: AbortSignal) => Promise<void>,
    private failure: (job: VoiceJob) => Promise<void>,
    private resources: () => ResourceStatus,
  ) {}
  private save(job: VoiceJob) {
    this.store.db
      .prepare(
        'INSERT INTO voice_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(job.id, job.status, JSON.stringify(job));
  }
  pending(route: VoiceRoute) {
    return this.rows().some(
      (job) =>
        ['queued', 'running'].includes(job.status) &&
        job.route.groupId === route.groupId &&
        job.route.chatId === route.chatId &&
        job.route.threadId === route.threadId,
    );
  }
  private rows(): VoiceJob[] {
    return this.store.db
      .prepare('SELECT data FROM voice_jobs ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  enqueue(
    receipt: string,
    route: VoiceRoute,
    input: { fileId?: string; duration?: number; text?: string },
  ) {
    const id = createHash('sha256').update(receipt).digest('hex');
    if (this.store.db.prepare('SELECT 1 FROM voice_jobs WHERE id=?').get(id)) return false;
    if (this.rows().filter((job) => ['queued', 'running'].includes(job.status)).length >= 32)
      throw new AppError(
        'voice_queue_full',
        'The voice inbox is full. Wait for the previous messages.',
      );
    this.save({ id, receipt, route, ...input, status: 'queued', createdAt: now() });
    queueMicrotask(() => this.tick());
    return true;
  }
  start() {
    for (const job of this.rows())
      if (job.status === 'running') {
        job.status = 'queued';
        this.save(job);
      }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  private tick() {
    if (this.stopped || this.active) return;
    const job = this.rows().find((job) => job.status === 'queued');
    if (!job) return;
    const available = this.resources();
    if (!job.text && (!available.ok || available.memoryAvailableGiB < 3.5)) return;
    const abort = new AbortController();
    job.status = 'running';
    this.save(job);
    const done = this.run(job, abort.signal).finally(() => {
      this.active = undefined;
      queueMicrotask(() => this.tick());
    });
    this.active = { abort, done };
  }
  private async run(job: VoiceJob, signal: AbortSignal) {
    const root = join(this.dataDir, 'voice'),
      file = join(root, job.id + '.ogg');
    const monitor = setInterval(() => {
      if (!this.resources().ok) this.active?.abort.abort();
    }, 5000);
    monitor.unref();
    try {
      if (!job.text) {
        if (!job.fileId) throw new Error('Missing voice file');
        mkdirSync(root, { recursive: true, mode: 0o700 });
        if (!existsSync(file)) {
          const bytes = await this.download(job.fileId, signal),
            temporary = file + '.part';
          signal.throwIfAborted();
          rmSync(temporary, { force: true });
          writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
          renameSync(temporary, file);
        }
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
          throw new Error('Invalid saved voice recording');
        signal.throwIfAborted();
        job.text = await this.speech.transcribe(file, job.route.locale, signal);
        this.save(job);
      }
      signal.throwIfAborted();
      await this.deliver(job, signal);
      job.status = 'done';
      this.save(job);
      this.cleanup(file, job.id);
    } catch (error) {
      job.error = redact(error instanceof Error ? error.message : String(error));
      job.status = signal.aborted ? 'queued' : 'failed';
      this.save(job);
      if (!signal.aborted) {
        await this.failure(job).catch(() => {});
        this.cleanup(file, job.id);
      }
    } finally {
      clearInterval(monitor);
    }
  }
  private cleanup(file: string, id: string) {
    try {
      if (existsSync(file) && lstatSync(file).isFile()) rmSync(file);
    } catch (error) {
      this.store.event('_system', 'voice.cleanup_failed', { id, error: redact(String(error)) });
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.active?.abort.abort();
    await this.active?.done;
  }
}
