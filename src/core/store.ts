import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AppError,
  now,
  type Task,
  type Event,
  type Job,
  type Message,
  type Decision,
  type ReviewGroup,
  type AgentProfiles,
  type Workspace,
  type DaddyJob,
} from './types.js';

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private transactionEvents: Event[] | undefined;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (
      (version !== 0 && version !== 6) ||
      (version === 0 &&
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .get())
    ) {
      this.db.close();
      throw new AppError(
        'schema_version',
        'This daddyloop release requires schema 6. Use a converted database or an empty data directory.',
        500,
      );
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,id);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_task ON jobs(task_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_receipts (id INTEGER PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_actions (id TEXT PRIMARY KEY, data TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, status TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_groups (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daddy_jobs (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_daddy ON daddy_jobs(group_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS daddy_job_status ON daddy_jobs(status);
      CREATE TABLE IF NOT EXISTS telegram_topics (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=6;
    `);
    this.changes.setMaxListeners(100);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionEvents = [];
    try {
      const value = fn();
      this.db.exec('COMMIT');
      for (const event of this.transactionEvents)
        queueMicrotask(() => this.changes.emit('event', event));
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionEvents = undefined;
    }
  }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Task not found', 404);
    return JSON.parse(row.data as string);
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT data FROM tasks ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  saveTask(task: Task) {
    task.updatedAt = now();
    this.db
      .prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(task.id, JSON.stringify(task));
  }
  event(taskId: string, type: string, data: unknown = {}, runId?: string) {
    const at = now();
    const result = this.db
      .prepare('INSERT INTO events(task_id,run_id,type,data,at) VALUES(?,?,?,?,?)')
      .run(taskId, runId ?? null, type, JSON.stringify(data), at);
    const event: Event = {
      id: Number(result.lastInsertRowid),
      taskId,
      runId,
      type,
      data,
      at,
    };
    if (this.transactionEvents) this.transactionEvents.push(event);
    else queueMicrotask(() => this.changes.emit('event', event));
    return event;
  }
  events(taskId: string, after = 0, limit = 500): Event[] {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT ?')
      .all(taskId, after, limit)
      .map((row) => ({
        id: Number(row.id),
        taskId: row.task_id as string,
        runId: row.run_id as string | undefined,
        type: row.type as string,
        data: JSON.parse(row.data as string),
        at: row.at as string,
      }));
  }
  enqueue(task: Task, role: Job['role'], kind: Job['kind'], input: string, actionId?: string): Job {
    const group = task.groupId ? this.getGroup(task.groupId) : undefined;
    const defaults = this.setting<AgentProfiles>('agents.defaults');
    const job: Job = {
      id: randomUUID(),
      taskId: task.id,
      generation: task.generation,
      role,
      kind,
      input,
      status: 'queued',
      createdAt: now(),
      profile:
        role === 'reviewer' && group
          ? group.daddy
          : (task.agents?.[role === 'author' ? 'writer' : 'daddy'] ??
            defaults?.[role === 'author' ? 'writer' : 'daddy']),
      groupId: group?.id,
      groupGeneration: group?.generation,
      actionId,
    };
    this.saveJob(job);
    this.event(task.id, 'job.queued', { role, kind }, job.id);
    return job;
  }
  saveJob(job: Job) {
    this.db
      .prepare(
        'INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(job.id, job.taskId, job.status, JSON.stringify(job));
  }
  jobs(taskId?: string): Job[] {
    return (
      taskId
        ? this.db.prepare('SELECT data FROM jobs WHERE task_id=? ORDER BY rowid').all(taskId)
        : this.db.prepare('SELECT data FROM jobs ORDER BY rowid').all()
    ).map((row) => JSON.parse(row.data as string));
  }
  claim(
    eligible: (job: Job) => boolean = () => true,
    onClaim?: (job: Job) => void,
  ): Job | undefined {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT data FROM jobs WHERE status='queued' AND task_id NOT IN (SELECT task_id FROM jobs WHERE status='running') ORDER BY rowid`,
        )
        .all();
      for (const row of rows) {
        const job: Job = JSON.parse(row.data as string),
          task = this.getTask(job.taskId);
        if (task.generation !== job.generation || task.state === 'paused') {
          job.status = 'cancelled';
          this.saveJob(job);
          continue;
        }
        if (!eligible(job)) continue;
        if (job.notBefore && job.notBefore > now()) continue;
        if (
          job.role === 'reviewer' &&
          job.groupId &&
          this.jobs().some(
            (active) =>
              active.status === 'running' &&
              active.role === 'reviewer' &&
              active.groupId === job.groupId,
          )
        )
          continue;
        job.status = 'running';
        onClaim?.(job);
        job.startedAt = now();
        this.saveJob(job);
        return job;
      }
    });
  }
  busy(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM jobs WHERE task_id=? AND status IN ('queued','running') LIMIT 1")
      .get(id);
  }
  groups(): ReviewGroup[] {
    return this.db
      .prepare('SELECT data FROM review_groups ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  workspaces(): Workspace[] {
    return this.db
      .prepare('SELECT data FROM workspaces ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  workspace(id: string): Workspace {
    const row = this.db.prepare('SELECT data FROM workspaces WHERE id=?').get(id);
    if (!row) throw new AppError('project_missing', 'Workspace not found', 404);
    return JSON.parse(row.data as string);
  }
  saveWorkspace(workspace: Workspace) {
    workspace.updatedAt = now();
    this.db
      .prepare(
        'INSERT INTO workspaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(workspace.id, JSON.stringify(workspace));
  }
  daddyJobs(groupId?: string): DaddyJob[] {
    const rows = groupId
      ? this.db.prepare('SELECT data FROM daddy_jobs WHERE group_id=? ORDER BY rowid').all(groupId)
      : this.db.prepare('SELECT data FROM daddy_jobs ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(row.data as string));
  }
  saveDaddyJob(job: DaddyJob) {
    this.db
      .prepare(
        'INSERT INTO daddy_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(job.id, job.groupId, job.status, JSON.stringify(job));
  }
  daddyMessage(
    groupId: string,
    sender: Message['sender'],
    text: string,
    runId?: string,
    workspace?: Message['workspace'],
  ) {
    const message: Message = {
      id: randomUUID(),
      taskId: groupId,
      role: 'reviewer',
      sender,
      text,
      runId,
      workspace,
      at: now(),
    };
    this.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(message.id, groupId, JSON.stringify(message));
    this.event(groupId, 'daddy.message', { messageId: message.id, sender }, runId);
    return message;
  }
  getGroup(id: string): ReviewGroup {
    const row = this.db.prepare('SELECT data FROM review_groups WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Review group not found', 404);
    return JSON.parse(row.data as string);
  }
  saveGroup(group: ReviewGroup) {
    group.updatedAt = now();
    this.db
      .prepare(
        'INSERT INTO review_groups VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(group.id, JSON.stringify(group));
  }
  cancelJobs(id: string) {
    for (const job of this.jobs(id))
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'cancelled';
        job.finishedAt = now();
        this.saveJob(job);
      }
  }
  message(
    taskId: string,
    role: Message['role'],
    sender: Message['sender'],
    text: string,
    runId?: string,
  ) {
    const msg: Message = {
      id: randomUUID(),
      taskId,
      role,
      sender,
      text,
      runId,
      at: now(),
    };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(msg.id, taskId, JSON.stringify(msg));
    this.event(taskId, 'message.created', { role, messageId: msg.id }, runId);
    return msg;
  }
  messages(id: string): Message[] {
    return this.db
      .prepare('SELECT data FROM messages WHERE task_id=? ORDER BY rowid')
      .all(id)
      .map((row) => JSON.parse(row.data as string));
  }
  decision(task: Task, data: Omit<Decision, 'id' | 'taskId' | 'head' | 'at'>) {
    const item: Decision = {
      ...data,
      id: randomUUID(),
      taskId: task.id,
      head: task.revision?.head ?? '',
      at: now(),
    };
    this.db
      .prepare('INSERT INTO decisions VALUES(?,?,?)')
      .run(item.id, task.id, JSON.stringify(item));
    this.event(task.id, 'decision.recorded', item);
    return item;
  }
  decisions(id: string): Decision[] {
    return this.db
      .prepare('SELECT data FROM decisions WHERE task_id=? ORDER BY rowid')
      .all(id)
      .map((row) => JSON.parse(row.data as string));
  }
  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
