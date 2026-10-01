import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Run, StartSpec, TaskSpec } from './model.js'

const legacyRun = {
  version: 1, id: '0123456789abcdef0123456789abcdef', fingerprint: 'f', prompt: 'Make it', engine: 'claude',
  bypassPermission: false, parallelism: 3, root: '/tmp/p', directorId: 'agent-1', directorWorking: false, state: 'active',
  error: null, revision: 3, createdAt: 1, updatedAt: 2, messages: [],
  tasks: [{ id: 'part', title: 'part', harness: 'test/cad', prompt: 'Build', dependsOn: [], state: 'running', attempt: 1,
    agentId: 'agent-2', cwd: '/tmp/p/tasks/part/attempt-1', summary: '', error: null, uncertain: false, artifacts: [], inputs: {} }],
}

describe('model compatibility', () => {
  it('reads a run saved before flows existed and writes it back unchanged', () => {
    expect(JSON.parse(JSON.stringify(Run.parse(legacyRun)))).toEqual(legacyRun)
  })
  it('keeps the fingerprint of an old start request stable', () => {
    const raw = { id: legacyRun.id, prompt: 'Make it', engine: 'claude' }
    const fingerprint = (spec: unknown) => createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    expect(fingerprint(StartSpec.parse(raw))).toBe(fingerprint({ ...raw, bypassPermission: false, parallelism: 3 }))
  })
  it('accepts flow fields on tasks and starts', () => {
    expect(TaskSpec.parse({ id: 'check', title: 'check', harness: 'run', prompt: 'npm test', run: 'npm test', timeoutMs: 600_000, retry: { maxAttempts: 1 } }))
      .toMatchObject({ run: 'npm test', retry: { maxAttempts: 1 } })
    expect(TaskSpec.parse({ id: 'part', title: 'part', harness: 'test/cad', prompt: 'Build', outputs: { files: ['*.step'], verdict: 'ready' } }).outputs)
      .toEqual({ files: ['*.step'], verdict: 'ready' })
    expect(StartSpec.parse({ id: legacyRun.id, prompt: 'Flow x', engine: 'claude', flow: { source: 'spec: 1', path: '/p/x.yaml' }, inputs: { a: '1' } }))
      .toMatchObject({ flow: { path: '/p/x.yaml' }, inputs: { a: '1' } })
    expect(() => TaskSpec.parse({ id: 'x', title: 'x', harness: 'run', prompt: 'p', retry: { maxAttempts: 6 } })).toThrow()
  })
})
