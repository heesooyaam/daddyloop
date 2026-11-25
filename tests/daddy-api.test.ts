import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { registerDaddy } from '../src/server/daddy.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { instructionPresetFingerprint } from '../src/core/preset-fingerprint.js';

it('lists session counts and running roles without reading job or conversation history', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const workers = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: { daddy: { prompt: 'Fixture instructions' }, worker: {} },
    });
    const review = f.daddy.create({ workspaceId: f.workspace.id });
    const coordination = f.daddy.create({ workspaceId: f.workspace.id, message: 'Start' });
    const local = (groupId: string, title: string) =>
      f.tickets.local({
        workspace: f.workspace,
        groupId,
        groupGeneration: 1,
        title,
        requirements: 'Fixture task',
        createdByAction: title,
      });
    const completed = await local(workers.id, 'Completed');
    completed.state = 'complete';
    f.store.saveTask(completed);
    const author = await local(workers.id, 'Author');
    const reviewer = await local(review.id, 'Reviewer');
    const pastReview = f.store.enqueue(completed, 'reviewer', 'review', 'Prior review');
    pastReview.status = 'completed';
    f.store.saveJob(pastReview);
    f.store.enqueue(author, 'author', 'implement', 'Implement');
    f.store.enqueue(reviewer, 'reviewer', 'review', 'Review');
    f.store.claim();
    f.store.claim();
    const [daddyJob] = f.store.daddyJobs(coordination.id);
    daddyJob.status = 'running';
    f.store.saveDaddyJob(daddyJob);

    const messages = vi.spyOn(f.store, 'messages');
    const jobs = vi.spyOn(f.store, 'jobs');
    const result = await app.inject('/api/daddy/sessions');
    expect(result.statusCode).toBe(200);
    const sessions = result.json();
    expect(sessions).toMatchObject([
      { id: coordination.id, total: 0, complete: 0, daddyBusy: true, workers: { active: 0 } },
      { id: review.id, total: 1, complete: 0, daddyBusy: true, workers: { active: 0 } },
      { id: workers.id, total: 2, complete: 1, daddyBusy: false, workers: { active: 1 } },
    ]);
    expect(sessions[2]).not.toHaveProperty('instructions');
    expect(messages).not.toHaveBeenCalled();
    expect(jobs).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await f.close();
  }
});

it('checks the viewed revision after acquiring the task lock before a human approval', async () => {
  const f = daddyFixture();
  let release!: () => void, entered!: () => void;
  try {
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'fixture/repo',
        number: 1,
        url: 'https://demo.local/pull/1',
      },
      repoPath: f.dir,
      requirements: 'Review plan',
    });
    task.state = 'awaiting_plan_approval';
    task.kind = 'plan';
    f.store.saveTask(task);
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const locked = f.engine.lock(task.id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const current = f.store.getTask(task.id);
      current.generation++;
      current.revision!.head = 'f'.repeat(40);
      f.store.saveTask(current);
    });
    await ready;
    const approval = f.engine.action(task.id, 'approve-plan', '', {
      head: task.revision!.head,
      generation: task.generation,
    });
    release();
    await locked;
    await expect(approval).rejects.toMatchObject({ code: 'stale_task' });
    expect(f.store.getTask(task.id).approvedAt).toBeUndefined();
  } finally {
    release?.();
    await f.close();
  }
});
it('routes web task actions through the shared revision-bound service with the waiver reason', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Manual check',
      requirements: 'Review the offline result',
      createdByAction: 'fixture',
    });
    const action = vi.spyOn(f.daddy, 'taskAction').mockResolvedValue(task);
    const response = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/task-action`,
      payload: {
        taskId: task.id,
        action: 'waive-checks',
        expectedHead: task.revision!.head,
        expectedGeneration: task.generation,
        reason: 'Offline checks passed on the saved revision',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(action).toHaveBeenCalledWith(
      group.id,
      task.id,
      'waive-checks',
      { head: task.revision!.head, generation: task.generation },
      'Offline checks passed on the saved revision',
    );
  } finally {
    await app.close();
    await f.close();
  }
});
it('rejects removed submit and publish task actions without side effects', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 91,
        url: 'https://demo.local/pull/91',
      },
      repoPath: f.dir,
      requirements: 'Keep submission and publication automatic',
      groupId: group.id,
      groupGeneration: group.generation,
    });
    const push = vi.spyOn(f.tickets, 'pushFixes'),
      publish = vi.spyOn(f.engine, 'publish');
    for (const action of ['submit', 'publish']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/daddy/sessions/${group.id}/task-action`,
        payload: {
          taskId: task.id,
          action,
          expectedHead: task.revision!.head,
          expectedGeneration: task.generation,
        },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(push).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await f.close();
  }
});
it('accepts and discards legacy manual workflow fields when creating a session', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  const create = vi.spyOn(f.daddy, 'create');
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/daddy/sessions',
      payload: {
        workspaceId: f.workspace.id,
        autoPush: false,
        publication: 'human',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).not.toHaveProperty('autoPush');
    expect(create.mock.calls[0]![0]).not.toHaveProperty('publication');
    expect(response.json().group).not.toHaveProperty('defaultPolicy');
  } finally {
    await app.close();
    await f.close();
  }
});
it('keeps settings instructions as a complete replacement for existing import clients', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  const preset = new InstructionPresets(f.store).save({
    name: 'Preset A',
    instructions: { daddy: { prompt: 'A' }, worker: {} },
  });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: {
      daddy: {},
      worker: {},
      presets: [{ preset, enabled: true, omit: [] }],
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/settings`,
      payload: {
        instructions: {
          daddy: { prompt: 'Imported daddy prompt' },
          worker: { prompt: 'Imported worker prompt' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().group.instructions).toEqual({
      daddy: { prompt: 'Imported daddy prompt' },
      worker: { prompt: 'Imported worker prompt' },
    });
  } finally {
    await app.close();
    await f.close();
  }
});
it('merges independent instruction elements and rejects an overlapping patch atomically', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  const library = new InstructionPresets(f.store),
    makePreset = (name: string) =>
      library.save({ name, instructions: { daddy: { prompt: name }, worker: {} } }),
    presetA = makePreset('Preset A'),
    presetB = makePreset('Preset B'),
    presetC = makePreset('Preset C'),
    presetD = makePreset('Preset D'),
    selected = (preset: typeof presetA, enabled = true) => ({ preset, enabled, omit: [] }),
    state = (preset: typeof presetA, enabled = true) => ({
      revision: preset.revision,
      snapshot: instructionPresetFingerprint(preset),
      enabled,
      omit: [],
    }),
    skill = (name: string) => ({
      name,
      text: `# ${name}`,
      checksum: createHash('sha256').update(`# ${name}`).digest('hex'),
      source: { kind: 'text' as const },
    }),
    firstSkill = skill('First'),
    secondSkill = skill('Second');
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: {
      daddy: {},
      worker: { prompt: 'Original worker', skills: [firstSkill] },
      presets: [selected(presetA), selected(presetB)],
    },
  });
  try {
    const concurrent = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: { daddy: {}, worker: {}, presets: [selected(presetA)] },
    });
    for (const preset of [presetB, presetC]) {
      const added = await app.inject({
        method: 'POST',
        url: `/api/daddy/sessions/${concurrent.id}/instructions-patch`,
        payload: {
          changes: [{ target: 'preset', id: preset.id, before: null, after: state(preset) }],
        },
      });
      expect(added.statusCode).toBe(200);
    }
    expect(
      f.daddy.group(concurrent.id).instructions?.presets?.map((entry) => entry.preset.id),
    ).toEqual([presetA.id, presetB.id, presetC.id]);
    const originalOrder = [presetA.id, presetB.id, presetC.id],
      firstOrder = [presetB.id, presetC.id, presetA.id];
    const firstReorder = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${concurrent.id}/instructions-patch`,
      payload: {
        changes: [{ target: 'preset-order', before: originalOrder, after: firstOrder }],
      },
    });
    expect(firstReorder.statusCode).toBe(200);
    const staleReorder = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${concurrent.id}/instructions-patch`,
      payload: {
        changes: [
          {
            target: 'preset-order',
            before: originalOrder,
            after: [presetA.id, presetC.id, presetB.id],
          },
        ],
      },
    });
    expect(staleReorder.statusCode).toBe(409);
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${concurrent.id}/instructions-patch`,
      payload: {
        changes: [{ target: 'preset-order', before: originalOrder, after: firstOrder }],
      },
    });
    expect(repeated.statusCode).toBe(200);

    const membership = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: {
        daddy: {},
        worker: { prompt: 'Keep this prompt' },
        presets: [selected(presetA), selected(presetB), selected(presetC)],
      },
    });
    const moved = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${membership.id}/instructions-patch`,
      payload: {
        changes: [
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id, presetC.id],
            after: [presetA.id, presetC.id, presetB.id],
          },
        ],
      },
    });
    expect(moved.statusCode).toBe(200);
    const independentAdd = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${membership.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'preset', id: presetD.id, before: null, after: state(presetD) },
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id, presetC.id],
            after: [presetA.id, presetB.id, presetC.id, presetD.id],
          },
        ],
      },
    });
    expect(independentAdd.statusCode).toBe(200);
    expect(
      f.daddy.group(membership.id).instructions?.presets?.map((entry) => entry.preset.id),
    ).toEqual([presetA.id, presetC.id, presetB.id, presetD.id]);

    const addedBeforeReorder = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: {
        daddy: {},
        worker: {},
        presets: [selected(presetA), selected(presetB), selected(presetC)],
      },
    });
    for (const changes of [
      [
        { target: 'preset', id: presetD.id, before: null, after: state(presetD) },
        {
          target: 'preset-order',
          before: [presetA.id, presetB.id, presetC.id],
          after: [presetD.id, presetA.id, presetB.id, presetC.id],
        },
      ],
      [
        {
          target: 'preset-order',
          before: [presetA.id, presetB.id, presetC.id],
          after: [presetA.id, presetC.id, presetB.id],
        },
      ],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/daddy/sessions/${addedBeforeReorder.id}/instructions-patch`,
        payload: { changes },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(
      f.daddy.group(addedBeforeReorder.id).instructions?.presets?.map((entry) => entry.preset.id),
    ).toEqual([presetD.id, presetA.id, presetC.id, presetB.id]);

    const sameAddition = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: {
        daddy: {},
        worker: { prompt: 'Keep this prompt' },
        presets: [selected(presetA), selected(presetB)],
      },
    });
    const addAtStart = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${sameAddition.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'preset', id: presetC.id, before: null, after: state(presetC) },
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id],
            after: [presetC.id, presetA.id, presetB.id],
          },
        ],
      },
    });
    expect(addAtStart.statusCode).toBe(200);
    const addAtEnd = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${sameAddition.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'worker.prompt', before: 'Keep this prompt', after: 'Do not save this' },
          { target: 'preset', id: presetC.id, before: null, after: state(presetC) },
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id],
            after: [presetA.id, presetB.id, presetC.id],
          },
        ],
      },
    });
    expect(addAtEnd.statusCode).toBe(409);
    expect(f.daddy.group(sameAddition.id).instructions?.worker.prompt).toBe('Keep this prompt');
    expect(
      f.daddy.group(sameAddition.id).instructions?.presets?.map((entry) => entry.preset.id),
    ).toEqual([presetC.id, presetA.id, presetB.id]);

    const concurrentDelete = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: {
        daddy: {},
        worker: {},
        presets: [selected(presetA), selected(presetB)],
      },
    });
    const removed = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${concurrentDelete.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'preset', id: presetB.id, before: state(presetB), after: null },
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id],
            after: [presetA.id],
          },
        ],
      },
    });
    expect(removed.statusCode).toBe(200);
    const addAfterDelete = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${concurrentDelete.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'preset', id: presetC.id, before: null, after: state(presetC) },
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id],
            after: [presetA.id, presetB.id, presetC.id],
          },
        ],
      },
    });
    expect(addAfterDelete.statusCode).toBe(200);
    expect(
      f.daddy.group(concurrentDelete.id).instructions?.presets?.map((entry) => entry.preset.id),
    ).toEqual([presetA.id, presetC.id]);

    const first = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'worker.prompt', before: 'Original worker', after: 'Changed prompt' },
          {
            target: 'preset',
            id: presetA.id,
            before: state(presetA),
            after: state(presetA, false),
          },
        ],
      },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/instructions-patch`,
      payload: {
        changes: [
          {
            target: 'worker.skills',
            before: [firstSkill],
            after: [firstSkill, secondSkill],
          },
          {
            target: 'preset',
            id: presetB.id,
            before: state(presetB),
            after: state(presetB, false),
          },
          {
            target: 'preset',
            id: presetC.id,
            before: null,
            after: state(presetC),
          },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().group.instructions).toMatchObject({
      worker: { prompt: 'Changed prompt', skills: [firstSkill, secondSkill] },
      presets: [
        { preset: { id: presetA.id }, enabled: false },
        { preset: { id: presetB.id }, enabled: false },
        { preset: { id: presetC.id }, enabled: true },
      ],
    });
    const reordered = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/instructions-patch`,
      payload: {
        changes: [
          {
            target: 'preset-order',
            before: [presetA.id, presetB.id, presetC.id],
            after: [presetC.id, presetA.id, presetB.id],
          },
        ],
      },
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(
      reordered.json().group.instructions.presets.map((entry: any) => entry.preset.id),
    ).toEqual([presetC.id, presetA.id, presetB.id]);

    const imported = structuredClone(reordered.json().group.instructions);
    const importedA = imported.presets.find((entry: any) => entry.preset.id === presetA.id);
    importedA.preset.instructions.daddy.prompt = 'Imported text with the same ID and revision';
    const fullImport = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/settings`,
      payload: { instructions: imported },
    });
    expect(fullImport.statusCode).toBe(200);
    const collision = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'worker.prompt', before: 'Changed prompt', after: 'Must not be saved' },
          {
            target: 'preset',
            id: presetA.id,
            before: state(presetA, false),
            after: null,
          },
        ],
      },
    });
    expect(collision.statusCode).toBe(409);
    expect(f.daddy.group(group.id).instructions?.worker.prompt).toBe('Changed prompt');
    expect(
      f.daddy.group(group.id).instructions?.presets?.find((entry) => entry.preset.id === presetA.id)
        ?.preset.instructions.daddy.prompt,
    ).toBe('Imported text with the same ID and revision');

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/instructions-patch`,
      payload: {
        changes: [
          { target: 'worker.prompt', before: 'Original worker', after: 'Conflicting prompt' },
          {
            target: 'preset',
            id: presetA.id,
            before: state(presetA, false),
            after: state(presetA, true),
          },
        ],
      },
    });
    expect(conflict.statusCode).toBe(409);
    const saved = f.daddy.group(group.id).instructions!;
    expect(saved.worker.prompt).toBe('Changed prompt');
    expect(saved.presets?.find((entry) => entry.preset.id === presetA.id)?.enabled).toBe(false);
  } finally {
    await app.close();
    await f.close();
  }
});
it('authenticates workspace/session controls, deduplicates messages and closes public worker chat', async () => {
  const f = daddyFixture(),
    server = await buildApp({
      dataDir: f.dir,
      store: f.store,
      workspaces: f.workspaces,
      checkouts: f.checkouts,
      daddyRuntime: f.runtime,
      daddyWorkspace: f.context,
      catalogue,
      resourceCheck: healthy,
      startWorker: false,
      token: 'fixture',
    });
  const headers = { authorization: 'Bearer fixture' };
  try {
    expect((await server.app.inject('/api/workspaces')).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/projects', headers })).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/api/workspaces', headers })).json()).toEqual(
      (await server.app.inject({ url: '/api/workspaces', headers })).json(),
    );
    expect((await server.app.inject({ url: '/api/workspaces', headers })).json()).toHaveLength(1);
    const requestId = randomUUID(),
      input = { workspaceId: f.workspace.id, message: 'Start from this goal', requestId };
    const first = (
      await server.app.inject({
        method: 'POST',
        url: '/api/daddy/sessions',
        headers,
        payload: input,
      })
    ).json();
    const second = (
      await server.app.inject({
        method: 'POST',
        url: '/api/daddy/sessions',
        headers,
        payload: input,
      })
    ).json();
    expect(second.group.id).toBe(first.group.id);
    const chat = { text: 'Add one more ticket', requestId: randomUUID() };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/daddy/sessions/${first.group.id}/chat`,
            headers,
            payload: chat,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      f.store.messages(first.group.id).filter((message) => message.sender === 'user'),
    ).toHaveLength(2);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/daddy/sessions/${first.group.id}/settings`,
          headers,
          payload: { workerLimit: 9 },
        })
      ).statusCode,
    ).toBe(400);
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: first.group.id,
      groupGeneration: first.group.generation,
      title: 'Subtask',
      requirements: 'Work',
      createdByAction: 'fixture',
    });
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/messages`,
          headers,
          payload: { role: 'author', text: 'Bypass daddy' },
        })
      ).statusCode,
    ).toBe(404);
    expect(f.store.jobs(task.id)).toHaveLength(0);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/messages`,
          headers,
          payload: { role: 'reviewer', text: 'Question for daddy' },
        })
      ).statusCode,
    ).toBe(404);
    expect(f.store.messages(first.group.id).at(-1)?.text).toBe('Add one more ticket');
    expect(f.store.messages(task.id)).toHaveLength(0);
  } finally {
    await server.app.close();
    await f.close();
  }
});
