import { expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { InstructionSources } from '../src/ops/instruction-sources.js';
import { sessionInstructionsSchema, withInstructions } from '../src/core/instructions.js';
import { taskSession } from '../src/runtime/agent.js';
import { instructionCommand } from '../src/client/instructions.js';
import type { Job } from '../src/core/types.js';
afterEach(() => vi.restoreAllMocks());

it('pins role instructions in jobs, shares worker settings only inside the selected session and preserves defaults', async () => {
  const f = daddyFixture();
  try {
    const defaults = f.engine.defaultAgents();
    const skill = await new InstructionSources().import({
      kind: 'text',
      name: 'Concise',
      text: 'Keep technical details. Use short sentences.',
    });
    const instructions = {
      daddy: { prompt: 'Explain decisions in Russian.', skills: [skill] },
      worker: { prompt: 'Implement with small verified steps.' },
    };
    const group = f.daddy.create({
      workspaceId: f.workspace.id,
      message: 'First request',
      instructions,
    });
    const other = f.daddy.create({ workspaceId: f.workspace.id });
    instructions.daddy.prompt = 'An unrelated later edit';
    expect(f.store.daddyJobs(group.id)[0].instructions?.prompt).toBe(
      'Explain decisions in Russian.',
    );
    const next = {
      daddy: { prompt: 'Use English for the next turn.' },
      worker: { prompt: 'Write thorough tests.' },
    };
    await f.daddy.settings(group.id, { instructions: next });
    f.daddy.chat(group.id, 'Second request');
    expect(f.store.daddyJobs(group.id)).toHaveLength(2);
    expect(f.store.daddyJobs(group.id)[1].instructions).toEqual(next.daddy);
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[0].status).toBe('completed'));
    expect(f.runtime.runSession.mock.calls[0][0].instructions).toContain(
      'Explain decisions in Russian.',
    );
    expect(f.runtime.runSession.mock.calls[0][0].instructions).toContain(skill.text);
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[1].status).toBe('completed'));
    expect(f.runtime.runSession.mock.calls[1][0].instructions).toContain(next.daddy.prompt);
    const jobs: Job[] = [];
    for (const session of [group, group, other]) {
      const task = await f.tickets.local({
        workspace: f.workspace,
        groupId: session.id,
        groupGeneration: session.generation,
        title: 'Part',
        requirements: 'Do it',
        createdByAction: 'fixture-instructions-' + jobs.length,
      });
      const author = f.store.enqueue(task, 'author', 'implement', 'Implement');
      jobs.push(author);
      if (session.id === group.id) {
        expect(author.instructions).toEqual(next.worker);
        const reviewer = f.store.enqueue(task, 'reviewer', 'review', 'Review');
        expect(reviewer.instructions).toEqual(next.daddy);
        const input = taskSession({
          task,
          job: author,
          cwd: f.dir,
          prompt: 'Do it',
          signal: new AbortController().signal,
          onSession: vi.fn(),
          onEvent: vi.fn(),
          onTool: vi.fn(),
        });
        expect(input.instructions).toContain(next.worker.prompt);
        expect(input.instructions).not.toContain(next.daddy.prompt);
      } else expect(author.instructions).toBeUndefined();
    }
    await f.daddy.settings(group.id, { instructions: { daddy: {}, worker: {} } });
    expect(f.store.jobs().find((job) => job.id === jobs[0].id)?.instructions).toEqual(next.worker);
    expect(f.daddy.group(other.id).instructions).toBeUndefined();
    expect(f.engine.defaultAgents()).toEqual(defaults);
  } finally {
    await f.close();
  }
});
it('imports local folders as self-contained snapshots and verifies tampering and size limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-skill-test-'));
  try {
    const path = join(root, 'short');
    mkdirSync(path);
    const body = '---\nname: short\ndescription: concise\n---\nUse fewer words.\n';
    writeFileSync(join(path, 'SKILL.md'), body);
    const skill = await new InstructionSources().import({ kind: 'local', path });
    rmSync(path, { recursive: true });
    expect(skill.name).toBe('short');
    expect(withInstructions('Keep workflow checks.', { skills: [skill] })).toContain(body);
    expect(() =>
      sessionInstructionsSchema.parse({
        daddy: { skills: [{ ...skill, text: 'altered' }] },
        worker: {},
      }),
    ).toThrow('checksum');
    await expect(
      new InstructionSources().import({ kind: 'text', name: 'Large', text: 'я'.repeat(40000) }),
    ).rejects.toThrow('64 KiB');
    const original = { daddy: { skills: [skill] }, worker: { prompt: 'Original worker prompt' } };
    const changed = await instructionCommand('/instructions daddy New style', original, vi.fn());
    expect(changed?.daddy.skills).toEqual([skill]);
    expect(changed?.worker).toEqual(original.worker);
    expect(original.daddy).not.toHaveProperty('prompt');
    expect(
      (await instructionCommand('/instructions daddy --clear', changed, vi.fn()))?.daddy,
    ).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('pins GitHub imports to a commit and never fetches an arbitrary host or runs installers', async () => {
  const revision = 'c'.repeat(40),
    text = '---\nname: caveman\n---\nKeep answers short.';
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/repos/acme/caveman') return Response.json({ default_branch: 'main' });
    if (path.endsWith('/git/ref/heads/main'))
      return Response.json({ object: { type: 'commit', sha: revision } });
    if (path.endsWith('/contents/SKILL.md')) return Response.json({}, { status: 404 });
    expect(String(url)).toBe(
      `https://api.github.com/repos/acme/caveman/contents/skills/caveman/SKILL.md?ref=${revision}`,
    );
    return Response.json({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(text).toString('base64'),
    });
  }) as unknown as typeof fetch;
  const sources = new InstructionSources(fetcher, () => '');
  const skill = await sources.import({ kind: 'github', url: 'acme/caveman' });
  expect(skill.text).toBe(text);
  expect(skill.source.revision).toBe(revision);
  expect(skill.source.location).toContain('/blob/' + revision + '/');
  const raw = await sources.import({
    kind: 'github',
    url: 'https://raw.githubusercontent.com/acme/caveman/refs/heads/main/skills/caveman/SKILL.md',
  });
  expect(raw).toEqual(skill);
  const count = vi.mocked(fetcher).mock.calls.length;
  for (const url of [
    'https://example.com/install.sh',
    'http://github.com/acme/caveman',
    'https://user:pass@github.com/acme/caveman',
  ])
    await expect(sources.import({ kind: 'github', url })).rejects.toThrow('HTTPS GitHub');
  expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(count);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    sources.import({ kind: 'github', url: 'acme/caveman' }, cancelled.signal),
  ).rejects.toThrow();
  expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(count);
});
