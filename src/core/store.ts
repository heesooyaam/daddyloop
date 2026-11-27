import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { correctionDependencies, disputedFindings } from './task-activity.js';
import { effectiveInstructions } from './instructions.js';
import {
  AppError,
  architectProfileFor,
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

// A replacement run keeps the queue position of the original, including across restarts.
const jobOrder = (table: 'jobs' | 'daddy_jobs') => `ORDER BY coalesce(
  (SELECT rowid FROM ${table} AS first_attempt WHERE id=json_extract(${table}.data,'$.firstAttemptId')),
  ${table}.rowid
)`;

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private transactionEvents: Event[] | undefined;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (
      (version !== 0 && version !== 7) ||
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
        'This daddyloop release requires schema 7. Use a converted database or an empty data directory.',
        500,
      );
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,id);
      CREATE INDEX IF NOT EXISTS saved_fix_by_head ON events(task_id,json_extract(data,'$.head'),id) WHERE type='author.fixes_saved';
      CREATE INDEX IF NOT EXISTS released_feedback_by_run ON events(task_id,run_id,id) WHERE type='author.feedback_snapshot';
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_by_task ON jobs(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_task ON jobs(task_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_by_task ON decisions(task_id);
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
      CREATE TABLE IF NOT EXISTS review_lessons (
        repository TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        review_id TEXT NOT NULL, head TEXT NOT NULL, confirmed_at TEXT NOT NULL, data TEXT NOT NULL, terms TEXT NOT NULL,
        PRIMARY KEY(repository,id)
      );
      CREATE TABLE IF NOT EXISTS review_lesson_terms (
        repository TEXT NOT NULL, term TEXT NOT NULL, lesson_id TEXT NOT NULL, weight INTEGER NOT NULL,
        PRIMARY KEY(repository,term,lesson_id), FOREIGN KEY(repository,lesson_id) REFERENCES review_lessons(repository,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS review_terms_by_lesson ON review_lesson_terms(repository,lesson_id);
      CREATE TRIGGER IF NOT EXISTS index_review_lesson AFTER INSERT ON review_lessons BEGIN
        INSERT INTO review_lesson_terms SELECT NEW.repository,key,NEW.id,value FROM json_each(NEW.terms);
      END;
      CREATE TRIGGER IF NOT EXISTS reindex_review_lesson AFTER UPDATE OF terms ON review_lessons BEGIN
        DELETE FROM review_lesson_terms WHERE repository=NEW.repository AND lesson_id=NEW.id;
        INSERT INTO review_lesson_terms SELECT NEW.repository,key,NEW.id,value FROM json_each(NEW.terms);
      END;
      PRAGMA user_version=7;
    `);
    this.db.exec(`
      UPDATE tasks SET data=json_remove(data,'$.policy.publication','$.policy.autoPush')
        WHERE json_type(data,'$.policy.publication') IS NOT NULL
           OR json_type(data,'$.policy.autoPush') IS NOT NULL;
      UPDATE review_groups SET data=json_remove(data,'$.defaultPolicy')
        WHERE json_type(data,'$.defaultPolicy') IS NOT NULL;
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
  effectResult<T>(key?: string) {
    return key ? this.setting<{ result: T }>(key) : undefined;
  }
  recordEffect<T>(key: string | undefined, result: T): T {
    if (key) this.setSetting(key, { result });
    return result;
  }
  private readTask(data: string): Task {
    const task: Task = JSON.parse(data);
    if (task.policy) Reflect.deleteProperty(task.policy, 'maxRounds');
    if (
      task.state === 'needs_input' &&
      task.reason === disputedFindings &&
      task.inputRequest?.role === 'author' &&
      !task.inputRequest.reviewDispute &&
      task.groupId &&
      this.db
        .prepare(
          "SELECT id FROM review_groups WHERE id=? AND json_extract(data,'$.orchestrated')=1",
        )
        .get(task.groupId)
    )
      task.inputRequest.reviewDispute = 'daddy';
    return task;
  }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Task not found', 404);
    return this.readTask(row.data as string);
  }
  tasks(groupId?: string): Task[] {
    const rows =
      groupId === undefined
        ? this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all()
        : this.db
            .prepare(
              "SELECT data FROM tasks WHERE json_extract(data,'$.groupId')=? ORDER BY rowid DESC",
            )
            .all(groupId);
    return rows.map((row) => this.readTask(row.data as string));
  }
  taskCountsByGroup() {
    const rows = this.db
      .prepare(
        `SELECT json_extract(data,'$.groupId') AS groupId,
                count(*) AS total,
                count(*) FILTER (WHERE json_extract(data,'$.state')='complete') AS complete
         FROM tasks
         WHERE json_extract(data,'$.groupId') IS NOT NULL
         GROUP BY groupId`,
      )
      .all();
    return new Map(
      rows.map((row) => [
        row.groupId as string,
        { total: Number(row.total), complete: Number(row.complete) },
      ]),
    );
  }
  pendingReviewWrites(taskId: string, marker: string) {
    return this.db
      .prepare(
        "SELECT id,request FROM operations WHERE task_id=? AND status='pending' AND id GLOB ?",
      )
      .all(taskId, marker + ':*');
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
        kind === 'plan'
          ? (architectProfileFor(task, group) ?? defaults?.daddy)
          : role === 'reviewer' && group
            ? group.daddy
            : (task.agents?.[role === 'author' ? 'worker' : 'daddy'] ??
              defaults?.[role === 'author' ? 'worker' : 'daddy']),
      groupId: group?.id,
      instructions: structuredClone(
        effectiveInstructions(group?.instructions, role === 'author' ? 'worker' : 'daddy'),
      ),
      groupGeneration: group?.generation,
      actionId,
    };
    if (!job.profile)
      throw new AppError('agent_profile_missing', 'Choose an agent profile before queuing a turn');
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
  activeJobs(taskId?: string): Job[] {
    const active = "SELECT data FROM jobs WHERE status IN ('queued','running')";
    const rows = taskId
      ? this.db.prepare(`${active} AND task_id=? ${jobOrder('jobs')}`).all(taskId)
      : this.db.prepare(`${active} ${jobOrder('jobs')}`).all();
    return rows.map((row) => JSON.parse(row.data as string));
  }
  firstTaskStarts(taskIds: string[]): Map<string, string> {
    if (!taskIds.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT jobs.task_id AS taskId,
                min(coalesce(json_extract(jobs.data,'$.firstStartedAt'),
                             json_extract(jobs.data,'$.startedAt'))) AS startedAt
         FROM jobs
         WHERE jobs.task_id IN (${taskIds.map(() => '?').join(',')})
         GROUP BY jobs.task_id
         HAVING startedAt IS NOT NULL`,
      )
      .all(...taskIds);
    return new Map(rows.map((row) => [String(row.taskId), String(row.startedAt)]));
  }
  refreshQueuedPlans(task: Task, group: ReviewGroup) {
    for (const job of this.activeJobs(task.id))
      if (job.kind === 'plan' && job.status === 'queued' && job.generation === task.generation)
        this.saveJob({ ...job, profile: architectProfileFor(task, group) });
  }
  prerequisiteState(groupId: string, id: string) {
    return this.db
      .prepare(
        "SELECT json_extract(data,'$.state') AS state FROM tasks WHERE id=? AND json_extract(data,'$.groupId')=?",
      )
      .get(id, groupId)?.state as Task['state'] | undefined;
  }
  claim(
    eligible: (job: Job) => boolean = () => true,
    onClaim?: (job: Job) => void,
  ): Job | undefined {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT data FROM jobs WHERE status='queued' AND task_id NOT IN (SELECT task_id FROM jobs WHERE status='running') ${jobOrder('jobs')}`,
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
        if (
          task.dependsOn?.length &&
          correctionDependencies(task, job, (id) => this.prerequisiteState(task.groupId!, id))
            .length
        )
          continue;
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
        if (job.kind === 'plan')
          job.profile =
            architectProfileFor(task, job.groupId ? this.getGroup(job.groupId) : undefined) ??
            this.setting<AgentProfiles>('agents.defaults')?.daddy;
        job.status = 'running';
        onClaim?.(job);
        const startedAt = now();
        job.firstStartedAt ??= job.startedAt ?? startedAt;
        job.startedAt = startedAt;
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
      ? this.db
          .prepare(`SELECT data FROM daddy_jobs WHERE group_id=? ${jobOrder('daddy_jobs')}`)
          .all(groupId)
      : this.db.prepare(`SELECT data FROM daddy_jobs ${jobOrder('daddy_jobs')}`).all();
    return rows.map((row) => JSON.parse(row.data as string));
  }
  activeDaddyJobs(): DaddyJob[] {
    return this.db
      .prepare("SELECT data FROM daddy_jobs WHERE status IN ('queued','running') ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  hasRunningDaddyJob(groupId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM daddy_jobs WHERE group_id=? AND status='running' LIMIT 1")
      .get(groupId);
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
    metadata?: Pick<Message, 'origin' | 'phase' | 'needsReply'>,
  ) {
    const message: Message = {
      id: randomUUID(),
      taskId: groupId,
      role: 'reviewer',
      sender,
      text,
      runId,
      workspace,
      ...metadata,
      at: now(),
    };
    this.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(message.id, groupId, JSON.stringify(message));
    this.event(groupId, 'daddy.message', { messageId: message.id, sender }, runId);
    return message;
  }
  messageById(taskId: string, id: string): Message | undefined {
    const row = this.db
      .prepare('SELECT data FROM messages WHERE id=? AND task_id=?')
      .get(id, taskId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  finishDaddyReply(groupId: string, text: string, runId: string, needsReply = false) {
    const row = this.db
      .prepare(
        "SELECT data FROM messages WHERE task_id=? AND json_extract(data,'$.runId')=? AND json_extract(data,'$.sender')='agent' ORDER BY rowid DESC LIMIT 1",
      )
      .get(groupId, runId);
    const previous: Message | undefined = row ? JSON.parse(String(row.data)) : undefined;
    if (previous?.text.trim() === text.trim()) {
      previous.phase = 'final';
      if (needsReply) previous.needsReply = true;
      this.db
        .prepare('UPDATE messages SET data=? WHERE id=?')
        .run(JSON.stringify(previous), previous.id);
      this.event(groupId, 'daddy.message', { messageId: previous.id, sender: 'agent' }, runId);
      return previous;
    }
    return this.daddyMessage(groupId, 'agent', text, runId, undefined, {
      phase: 'final',
      ...(needsReply ? { needsReply: true } : {}),
    });
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
    messageId?: string,
  ) {
    if (messageId) {
      const row = this.db
        .prepare('SELECT data FROM messages WHERE id=? AND task_id=?')
        .get(messageId, taskId);
      if (row) return JSON.parse(row.data as string) as Message;
    }
    const msg: Message = {
      id: messageId ?? randomUUID(),
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
  decisionPage(
    taskId: string,
    filters: { commentId?: string; head?: string; before?: string; includeBefore?: boolean },
    publishedIds: string[] | undefined,
    limit: number,
  ): { id: string; data: string }[] {
    const where = ['task_id = ?'];
    const args = [taskId];
    if (filters.commentId !== undefined) {
      where.push("json_extract(data, '$.commentId') = ?");
      args.push(filters.commentId);
    }
    if (filters.head !== undefined) {
      where.push("json_extract(data, '$.head') = ?");
      args.push(filters.head);
    }
    if (publishedIds !== undefined) {
      where.push("json_extract(data, '$.commentId') IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(publishedIds));
    }
    const predicate = where.join(' AND ');
    const before = filters.before;
    if (before === undefined)
      return this.db
        .prepare(`SELECT id, data FROM decisions WHERE ${predicate} ORDER BY rowid DESC LIMIT ?`)
        .all(...args, limit) as { id: string; data: string }[];
    return this.db
      .prepare(
        `
        SELECT id, data FROM decisions WHERE ${predicate}
        AND rowid ${filters.includeBefore ? '<=' : '<'} (SELECT rowid FROM decisions WHERE id = ? AND ${predicate})
        ORDER BY rowid DESC LIMIT ?
      `,
      )
      .all(...args, before, ...args, limit) as { id: string; data: string }[];
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
