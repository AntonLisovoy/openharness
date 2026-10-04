import { describe, expect, it } from 'vitest'
import { decide, downstream, outcome, resetTask, settled } from './graph.js'
import type { Task } from './model.js'

const t = (id: string, state: Task['state'], extra: Partial<Task> = {}): Task => ({
  id, title: id, harness: 'run', prompt: 'x', dependsOn: [], state, attempt: 1, agentId: null, cwd: state === 'queued' ? '' : `/r/${id}`,
  summary: '', error: null, uncertain: false, artifacts: [], inputs: {}, ...extra,
})
const idle = () => false
describe('graph', () => {
  it('knows when a dependency has settled', () => {
    expect(settled(t('a', 'succeeded'), idle)).toBe(true)
    expect(settled(t('a', 'blocked', { uncertain: true }), idle)).toBe(false)
    expect(settled(t('a', 'failed', { retryAt: 1 }), idle)).toBe(false)
    expect(settled(t('a', 'failed'), () => true)).toBe(false)
    expect(settled(t('a', 'running'), idle)).toBe(false)
    expect(settled(t('a', 'waiting'), idle)).toBe(false)
  })
  it('all_success: blocks early, waits, skips after a skipped dependency, launches', () => {
    const d = t('d', 'queued', { dependsOn: ['a', 'b'] })
    expect(decide(d, [t('a', 'failed'), t('b', 'running'), d], idle)).toEqual({ kind: 'block', reason: 'An upstream task did not succeed.' })
    expect(decide(d, [t('a', 'succeeded'), t('b', 'running'), d], idle)).toEqual({ kind: 'wait' })
    expect(decide(d, [t('a', 'succeeded'), t('b', 'skipped'), d], idle)).toEqual({ kind: 'skip', reason: 'Skipped: upstream b was skipped.' })
    expect(decide(d, [t('a', 'succeeded'), t('b', 'succeeded'), d], idle)).toEqual({ kind: 'launch' })
    expect(decide(d, [t('a', 'failed', { retryAt: 9 }), t('b', 'succeeded'), d], idle)).toEqual({ kind: 'wait' })
    // under the default rule an uncertain upstream blocks its dependents at once (Director runs rely on it)
    expect(decide(d, [t('a', 'blocked', { uncertain: true }), t('b', 'running'), d], idle)).toEqual({ kind: 'block', reason: 'An upstream task did not succeed.' })
  })
  it('none_failed_min_one_success joins exclusive branches', () => {
    const j = t('j', 'queued', { dependsOn: ['a', 'b'], triggerRule: 'none_failed_min_one_success' })
    expect(decide(j, [t('a', 'succeeded'), t('b', 'skipped'), j], idle)).toEqual({ kind: 'launch' })
    expect(decide(j, [t('a', 'skipped'), t('b', 'skipped'), j], idle)).toEqual({ kind: 'skip', reason: 'Skipped: no upstream task succeeded.' })
    expect(decide(j, [t('a', 'cancelled'), t('b', 'succeeded'), j], idle)).toMatchObject({ kind: 'block' })
    expect(decide(j, [t('a', 'succeeded'), t('b', 'queued'), j], idle)).toEqual({ kind: 'wait' })
  })
  it('all_done runs after any settled outcome, but not while a dependency is busy or uncertain', () => {
    const r = t('r', 'queued', { dependsOn: ['a'], triggerRule: 'all_done' })
    expect(decide(r, [t('a', 'failed'), r], idle)).toEqual({ kind: 'launch' })
    expect(decide(r, [t('a', 'failed'), r], () => true)).toEqual({ kind: 'wait' })
    expect(decide(r, [t('a', 'blocked', { uncertain: true }), r], idle)).toEqual({ kind: 'wait' })
  })
  it('checks when after the rule', () => {
    const w = (when: string, dep: Task) => decide(t('w', 'queued', { dependsOn: [dep.id], when, triggerRule: 'all_done' }), [dep], idle)
    expect(w('a.state == failed', t('a', 'failed'))).toEqual({ kind: 'launch' })
    expect(w('a.state == succeeded', t('a', 'failed'))).toEqual({ kind: 'skip', reason: 'Skipped: a.state == succeeded is false.' })
    expect(w('a.verdict.errors == 0', t('a', 'succeeded'))).toEqual({ kind: 'fail', reason: 'a wrote no verdict; the condition a.verdict.errors == 0 cannot be evaluated.' })
    expect(w('a.decision == ship', t('a', 'succeeded', { decision: { outcome: 'approved', decision: 'ship', at: 1 } }))).toEqual({ kind: 'launch' })
    // a skipped dependency under all_success skips before the condition is looked at
    expect(decide(t('w', 'queued', { dependsOn: ['a'], when: 'a.state == succeeded' }), [t('a', 'skipped')], idle)).toMatchObject({ kind: 'skip', reason: 'Skipped: upstream a was skipped.' })
  })
  it('lists transitive dependents in file order', () => {
    const tasks = [t('c', 'queued', { dependsOn: ['b'] }), t('a', 'queued'), t('b', 'queued', { dependsOn: ['a'] }), t('x', 'queued')]
    expect(downstream(tasks, 'a').map(x => x.id)).toEqual(['c', 'b'])
  })
  it('resets a task by the reset table', () => {
    const task = t('a', 'failed', { agentId: 'g', summary: 's', error: 'e', uncertain: true, artifacts: [{ path: 'p', size: 1, sha256: 'x' }], inputs: { b: 1 },
      engine: 'claude', deadline: 1, pid: 2, verdict: { ready: true, errors: 0, warnings: 0 }, decision: { outcome: 'rejected', at: 1 },
      loopState: { phase: 'working', completed: 1, turn: 1 }, retryAt: 3, scripts: [], promptSha256: 'h' })
    resetTask(task, true)
    expect(task).toEqual(t('a', 'queued', { attempt: 2, promptSha256: 'h' }))
    const never = t('b', 'skipped', { summary: 'Skipped: x' }); resetTask(never, false)
    expect(never).toEqual(t('b', 'queued'))
  })
  it('classifies the run', () => {
    expect(outcome([t('a', 'succeeded'), t('b', 'skipped')], idle)).toBe('completed')
    expect(outcome([t('a', 'succeeded')], () => true)).toBe('in-progress')
    expect(outcome([t('a', 'failed'), t('b', 'blocked')], idle)).toBe('stopped')
    expect(outcome([t('a', 'failed', { retryAt: 1 })], idle)).toBe('in-progress')
    expect(outcome([t('a', 'waiting')], idle)).toBe('in-progress')
    expect(outcome([t('a', 'queued')], idle)).toBe('in-progress')
  })
})
