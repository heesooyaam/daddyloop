import { backupArcadia } from './arcadia-backup.js';
import { parseTicket } from './tickets.js';
import type { RepositoryModule, SubmissionBackend, SubmissionContext } from '../contracts.js';
import type { PRRef, Task } from '../../core/types.js';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ArcadiaProvider } from '../../providers/arcadia.js';
import { parsePR } from '../../providers/provider.js';
class ArcSubmission implements SubmissionBackend {
  constructor(private context: SubmissionContext) {}
  private get arc() {
    return this.context.arc;
  }
  private get workspaces() {
    return this.context.workspaces;
  }
  async owner(task: Task) {
    return (await this.assertArc(task)).user_login;
  }
  async prepare(task: Task) {
    await this.assertArc(task);
  }
  private async assertArc(task: Task) {
    const lease = task.arcWorkspaces?.author;
    if (
      !lease ||
      !(await this.arc.mounts()).some(
        (mount) =>
          mount.path === lease.mount &&
          mount.lease_owner_id === lease.ownerId &&
          mount.object_store_ok,
      )
    )
      throw new Error('This task does not own its Arc author lease');
    const info = JSON.parse(await this.arc.native(['info', '--json'], lease.mount)) as {
      hash: string;
      branch: string;
      user_login: string;
    };
    if (
      info.hash !== task.pendingAuthorHead ||
      !info.branch.startsWith(`daddyloop/${task.id}`) ||
      (await this.arc.native(['status', '--short'], lease.mount))
    )
      throw new Error('The saved Arc implementation changed; inspect it before submitting');
    if (!/^[A-Za-z0-9_.-]+$/.test(info.user_login)) throw new Error('Invalid Arc user identity');
    return info;
  }
  async create(task: Task, title: string, body: string): Promise<PRRef> {
    const info = await this.assertArc(task),
      lease = task.arcWorkspaces!.author!;
    const directory = join(this.workspaces.dataDir, 'ticket-submissions');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, task.id + '.md');
    writeFileSync(file, title + '\n\n' + body + '\n', { mode: 0o600 });
    try {
      await this.arc.native(
        [
          'pr',
          'create',
          '--json',
          '--no-edit',
          '--no-commits',
          '--code-review',
          '--wait',
          '--to',
          task.ticketRepository!.baseBranch,
          '--file',
          file,
          '--push',
          `users/${info.user_login}/${task.ticketRepository!.branch}`,
        ],
        lease.mount,
      );
      const ref = await this.find(task, `daddyloop:ticket:${task.id}`, info.user_login);
      if (!ref)
        throw new Error(
          'Arc created a PR but its identity could not be verified; submit again to reconcile it',
        );
      return ref;
    } finally {
      unlinkSync(file);
    }
  }
  async find(task: Task, marker: string, owner: string): Promise<PRRef | undefined> {
    try {
      const lease = task.arcWorkspaces!.author!;
      const pr = JSON.parse(await this.arc.native(['pr', 'status', '--json'], lease.mount)) as {
        id?: number;
        url?: string;
        description?: string;
        from_branch?: string;
        author?: string;
      };
      if (
        !pr.id ||
        pr.author !== owner ||
        !pr.description?.includes(`<!-- ${marker} -->`) ||
        pr.from_branch !== `users/${owner}/${task.ticketRepository!.branch}`
      )
        return;
      return parsePR(pr.url ?? `https://a.yandex-team.ru/review/${pr.id}`);
    } catch {
      return;
    }
  }
}
export const arcadiaModule: RepositoryModule = {
  id: 'arcadia',
  name: 'Arcadia + Tracker',
  vcs: 'arcadia',
  backupWorkspace: backupArcadia,
  acceptsTicket(input) {
    try {
      return parseTicket(input).kind === 'tracker';
    } catch {
      return false;
    }
  },
  readTicket: (input, reader) => reader.readBuiltin(input),
  matchesRepository: (input) => (input.vcs === 'arcadia' ? 10 : 0),
  parsePR(url) {
    if (url.hostname !== 'a.yandex-team.ru') return undefined;
    const match = url.pathname.match(/^(?:\/review\/|\/arc\/[^?#]+\/pull\/)([1-9]\d*)\/?$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return undefined;
    return {
      provider: 'arcadia',
      host: url.hostname,
      repo: 'arcadia',
      number: Number(match[1]),
      url: `https://a.yandex-team.ru/review/${match[1]}`,
    };
  },
  review: () => new ArcadiaProvider(),
  submission: (context) => new ArcSubmission(context),
};
