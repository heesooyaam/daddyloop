import { it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { daddyFixture } from './daddy-fixture.js';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { InstructionSources } from '../src/ops/instruction-sources.js';
import {
  sessionInstructionsSchema,
  effectiveInstructions,
  type SessionInstructions,
} from '../src/core/instructions.js';
import { clearInstructionRole } from '../src/client/presets.js';
import { registerInstructions } from '../src/server/instructions.js';
afterEach(() => vi.restoreAllMocks());
it('composes multiple preset snapshots with component switches and independent roles', async () => {
  const f = daddyFixture();
  try {
    const library = new InstructionPresets(f.store),
      source = new InstructionSources();
    const skill = await source.import({
      kind: 'text',
      name: 'Exact names',
      text: 'Keep exact technical names.',
    });
    const first = library.save({
      name: 'Short',
      instructions: {
        daddy: { prompt: 'Keep it short.', skills: [skill] },
        worker: { prompt: 'Worker detail.', skills: [skill] },
      },
    });
    const second = library.save({
      name: 'Russian',
      instructions: {
        daddy: { prompt: 'Speak Russian.', skills: [skill] },
        worker: { prompt: 'Russian reports.' },
      },
    });
    const instructions: SessionInstructions = {
      daddy: { prompt: 'Explain tradeoffs.' },
      worker: {},
      presets: [
        { preset: first, enabled: true, omit: ['worker:prompt'] },
        { preset: second, enabled: true, omit: [] },
      ],
    };
    sessionInstructionsSchema.parse(instructions);
    expect(effectiveInstructions(instructions, 'daddy')).toEqual({
      prompt: 'Keep it short.\n\nSpeak Russian.\n\nExplain tradeoffs.',
      skills: [skill],
    });
    expect(effectiveInstructions(instructions, 'worker')).toEqual({
      prompt: 'Russian reports.',
      skills: [skill],
    });
    const withoutWorker = clearInstructionRole(instructions, 'worker');
    expect(effectiveInstructions(withoutWorker, 'worker')).toEqual({});
    expect(effectiveInstructions(withoutWorker, 'daddy')).toEqual(
      effectiveInstructions(instructions, 'daddy'),
    );
    const group = f.daddy.create({ workspaceId: f.workspace.id, instructions, message: 'Task' });
    const job = f.store.daddyJobs(group.id)[0];
    const updated = library.save(
      {
        name: first.name,
        instructions: { daddy: { prompt: 'Different version.' }, worker: {} },
        expectedRevision: first.revision,
      },
      first.id,
    );
    expect(updated.revision).toBe(2);
    expect(() =>
      library.save(
        { name: first.name, instructions: first.instructions, expectedRevision: 1 },
        first.id,
      ),
    ).toThrow('changed');
    expect(() => library.remove(first.id, 1)).toThrow('changed');
    library.remove(first.id, 2);
    expect(f.store.daddyJobs(group.id)[0].instructions).toEqual(job.instructions);
    expect(effectiveInstructions(f.daddy.group(group.id).instructions, 'daddy')?.prompt).toContain(
      'Keep it short.',
    );
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]).not.toHaveProperty('instructions');
    const other = f.daddy.create({ workspaceId: f.workspace.id });
    expect(other.instructions).toBeUndefined();
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[0].status).toBe('completed'));
    expect(f.runtime.runSession.mock.calls[0][0].instructions).toContain('Keep it short.');
    expect(f.runtime.runSession.mock.calls[0][0].instructions).not.toContain('Different version.');
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Part',
      requirements: 'Implement',
      createdByAction: 'preset-worker',
    });
    expect(f.store.enqueue(task, 'author', 'implement', 'Implement').instructions).toEqual(
      effectiveInstructions(instructions, 'worker'),
    );
  } finally {
    await f.close();
  }
});
it('rejects invalid component keys, duplicate presets and combined instruction overflow', async () => {
  const f = daddyFixture();
  try {
    const library = new InstructionPresets(f.store);
    const preset = library.save({
      name: 'Large',
      instructions: { daddy: { prompt: 'a'.repeat(40000) }, worker: {} },
    });
    const value: SessionInstructions = {
      daddy: {},
      worker: {},
      presets: [{ preset, enabled: true, omit: [] }],
    };
    expect(() =>
      sessionInstructionsSchema.parse({
        ...value,
        presets: [{ preset, enabled: true, omit: ['unknown'] }],
      }),
    ).toThrow('components');
    expect(() =>
      sessionInstructionsSchema.parse({
        ...value,
        presets: [...value.presets!, ...value.presets!],
      }),
    ).toThrow('once');
    const another = library.save({ name: 'Another', instructions: preset.instructions });
    expect(() =>
      sessionInstructionsSchema.parse({
        ...value,
        presets: [...value.presets!, { preset: another, enabled: true, omit: [] }],
      }),
    ).toThrow();
    expect(() => library.save({ name: 'large', instructions: preset.instructions })).toThrow(
      'unique',
    );
  } finally {
    await f.close();
  }
});
it('accepts bounded preset payloads larger than the default HTTP body budget and requires revision checks', async () => {
  const f = daddyFixture(),
    app = Fastify({ bodyLimit: 200000 });
  registerInstructions(app, f.store);
  try {
    const skill = await new InstructionSources().import({
      kind: 'text',
      name: 'Large skill',
      text: 'x'.repeat(50000),
    });
    const role = { prompt: 'p'.repeat(60000), skills: [skill] };
    const payload = { name: 'Large preset', instructions: { daddy: role, worker: role } };
    expect(JSON.stringify(payload).length).toBeGreaterThan(200000);
    const created = await app.inject({ method: 'POST', url: '/api/instructions/presets', payload });
    expect(created.statusCode).toBe(201);
    const preset = created.json();
    const changed = await app.inject({
      method: 'POST',
      url: '/api/instructions/presets/' + preset.id,
      payload,
    });
    expect(changed.statusCode).toBe(409);
    const selection = { daddy: {}, worker: {}, presets: [{ preset, enabled: true, omit: [] }] };
    expect(
      (await app.inject({ method: 'POST', url: '/api/instructions/validate', payload: selection }))
        .statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    await f.close();
  }
});
