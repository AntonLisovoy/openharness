import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { directorPrompt, shellQuote, workerPrompt } from './prompts.js'
import type { Run, Task } from './model.js'

describe('self-contained orchestration briefs', () => {
  it('quotes executable paths without expanding shell metacharacters', () => {
    const value = `/project/a'b $(printf unexpected) \"workspace\"`
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value)
  })
  it.each([true, false])('keeps the explicit unattended setting at %s', bypassPermission => {
    const run = { id: 'a'.repeat(32), root: '/project', prompt: 'Make it', parallelism: 2, engine: 'codex', bypassPermission, tasks: [] } as unknown as Run
    const brief = directorPrompt(run, [], 'harness orchestrator')
    expect(brief).toContain(bypassPermission ? 'explicitly enabled by the user' : 'NOT enabled; normal engine permission prompts')
    expect(brief).toContain('An idle worker or a viewer is NOT evidence of completion')
    expect(brief).toContain('Successful work is immutable')
    const task = { id: 'one', attempt: 2, cwd: '/project/one', prompt: 'Verify dimensions', dependsOn: [] } as unknown as Task
    expect(workerPrompt(run, task, 'harness orchestrator')).toContain(`finish ${run.id} one 2`)
    expect(workerPrompt(run, task, 'harness orchestrator')).toContain(`fail ${run.id} one 2`)
    expect(workerPrompt(run, task, 'harness orchestrator')).toContain('tell the director')
  })
  it('tells a flow worker what finishes its task, and names no director', () => {
    const run = { id: 'a'.repeat(32), root: '/project', directorId: null, flow: { name: 'demo' }, tasks: [] } as unknown as Run
    const task = { id: 'one', attempt: 1, cwd: '/project/one', prompt: 'Model it', dependsOn: [], outputs: { files: ['*.step', 'dims.json'], verdict: 'ready' }, timeoutMs: 2_700_000 } as unknown as Task
    const brief = workerPrompt(run, task, 'harness orchestrator')
    expect(brief).toContain('when your turn ends and every one of these globs matches a file in your folder: *.step, dims.json, and .harness/verdict.json says "ready": true')
    expect(brief).toContain('This attempt is stopped after 45m.')
    expect(brief).not.toMatch(/director/i)
    const plain = workerPrompt(run, { ...task, outputs: { files: ['a.md'] }, timeoutMs: 90_000 } as Task, 'harness orchestrator')
    expect(plain).toContain('matches a file in your folder: a.md. ')
    expect(plain).toContain('stopped after 90s.')
    const bare = workerPrompt(run, { ...task, outputs: undefined, timeoutMs: undefined } as unknown as Task, 'harness orchestrator')
    expect(bare).not.toContain('globs')
    expect(bare).not.toContain('stopped after')
    expect(bare).not.toContain('without activity')
    expect(workerPrompt(run, { ...task, idleTimeoutMs: 900_000 } as Task, 'harness orchestrator')).toContain('The daemon stops this attempt after 15m without activity from you.')
  })
})
