import { describe, expect, it } from 'vitest'
import { evaluateCondition, parseCondition, type Condition } from './conditions.js'

const parsed = (text: string): Condition => { const c = parseCondition(text); if ('error' in c) throw new Error(c.error); return c }
describe('conditions', () => {
  it('parses one comparison with optional spaces', () => {
    expect(parsed('review.verdict.errors==0')).toMatchObject({ task: 'review', field: 'verdict.errors', op: '==', value: '0' })
    expect(parsed('  tests.state != failed ')).toMatchObject({ task: 'tests', field: 'state', op: '!=', value: 'failed', text: 'tests.state != failed' })
    expect(parsed('choose.decision == ship')).toMatchObject({ field: 'decision', value: 'ship' })
  })
  it.each([
    ['', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.state == succeeded && b.state == succeeded', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.output == x', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.state < succeeded', 'Only verdict.errors and verdict.warnings can be compared with <, <=, > or >=.'],
    ['a.state == done', 'a state is one of succeeded, failed, skipped, cancelled, blocked.'],
    ['a.verdict.ready == yes', 'verdict.ready is true or false.'],
    ['a.verdict.errors >= -1', 'verdict.errors is compared with a whole number.'],
    ['a.decision == Ship', 'a decision id looks like ship or needs-work.'],
  ])('rejects %j', (text, error) => { expect(parseCondition(text)).toEqual({ error }) })
  it('evaluates against a snapshot', () => {
    expect(evaluateCondition(parsed('t.state == failed'), { state: 'failed' })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.errors > 0'), { state: 'succeeded', verdict: { ready: true, errors: 2, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.ready == false'), { state: 'succeeded', verdict: { ready: true, errors: 0, warnings: 0 } })).toEqual({ ok: true, value: false })
    expect(evaluateCondition(parsed('t.verdict.ready == true'), { state: 'succeeded', verdict: { ready: true, errors: 0, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.warnings <= 1'), { state: 'failed', verdict: { ready: false, errors: 0, warnings: 1 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.warnings < 1'), { state: 'failed', verdict: { ready: false, errors: 0, warnings: 1 } })).toEqual({ ok: true, value: false })
    expect(evaluateCondition(parsed('t.verdict.errors >= 1'), { state: 'failed', verdict: { ready: false, errors: 1, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('c.decision != ship'), { state: 'succeeded', decision: 'rework' })).toEqual({ ok: true, value: true })
  })
  it('cannot evaluate what the dependency never recorded', () => {
    expect(evaluateCondition(parsed('review.verdict.errors == 0'), { state: 'succeeded' }))
      .toEqual({ ok: false, reason: 'review wrote no verdict; the condition review.verdict.errors == 0 cannot be evaluated.' })
    expect(evaluateCondition(parsed('ok.decision == ship'), { state: 'failed' }))
      .toEqual({ ok: false, reason: 'ok has no decision; the condition ok.decision == ship cannot be evaluated.' })
  })
})
