// cli/src/orchestrator/steps.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as shell from '../dsh/shell.js'
import { STEP_LOG_LIMIT, startStep, stepFailure, type StepSpawner } from './steps.js'

const sh: StepSpawner = (script, opts) => spawn('/bin/sh', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('shell steps', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'steps-')) })
  afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }) })

  it('runs in the task folder with env inputs that stay literal', async () => {
    const result = await startStep('pwd; printf "%s" "$HARNESS_INPUT_X"; echo warn >&2', { cwd, env: { HARNESS_INPUT_X: '$(echo pwned)"\'' }, spawn: sh }).done
    expect(result).toMatchObject({ code: 0, signal: null, error: null })
    expect(readFileSync(join(cwd, 'stdout.log'), 'utf8')).toContain(`$(echo pwned)"'`)
    expect(readFileSync(join(cwd, 'stderr.log'), 'utf8')).toBe('warn\n')
  })
  it('reports failures with the output tail, never the script, within 2000 chars', async () => {
    const result = await startStep('echo secret-script >/dev/null; echo boom >&2; exit 3', { cwd, env: {}, spawn: sh }).done
    expect(stepFailure(result)).toBe('exit 3: boom')
    expect(stepFailure({ code: 1, signal: null, error: null, stdoutTail: 'only stdout\n', stderrTail: '' })).toBe('exit 1: only stdout')
    expect(stepFailure({ code: null, signal: 'SIGTERM', error: null, stdoutTail: '', stderrTail: '' })).toBe('stopped by SIGTERM')
    expect(stepFailure({ code: 1, signal: null, error: null, stdoutTail: '', stderrTail: 'x'.repeat(5000) })).toHaveLength(2000)
  })
  it('stops descendants that ignore SIGTERM, even after the shell is gone', async () => {
    const step = startStep('(trap "" TERM; sleep 30) & echo $! > child.pid; wait', { cwd, env: {}, spawn: sh, graceMs: 200 })
    await vi.waitFor(() => expect(readFileSync(join(cwd, 'child.pid'), 'utf8')).toMatch(/\d+/))
    const child = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'))
    step.stop()
    await step.done
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 })
  })
  it('does not wait forever for pipes a leftover process keeps open', async () => {
    const result = await startStep('(trap "" TERM; sleep 30) & echo done', { cwd, env: {}, spawn: sh, graceMs: 200 }).done
    expect(result).toMatchObject({ code: 0, stdoutTail: 'done\n' })
  })
  it('caps each log and keeps a readable tail', async () => {
    const result = await startStep(`printf 'ab'; head -c ${STEP_LOG_LIMIT + 4096} /dev/zero | tr '\\0' 'a'; printf 'é-end'`, { cwd, env: {}, spawn: sh }).done
    expect(statSync(join(cwd, 'stdout.log')).size).toBeLessThan(STEP_LOG_LIMIT + 100)
    expect(readFileSync(join(cwd, 'stdout.log'), 'utf8').endsWith('[output truncated]\n')).toBe(true)
    expect(result.stdoutTail.endsWith('é-end')).toBe(true)
  })
  it('stops the step when its log cannot be written', async () => {
    mkdirSync(join(cwd, 'stdout.log')) // opening a folder as a file fails (EISDIR)
    const result = await startStep('sleep 30', { cwd, env: {}, spawn: sh, graceMs: 200 }).done
    expect(result.error).toMatch(/^could not write stdout\.log: /)
  })
  it('turns spawn failures into worded results', async () => {
    const thrown = (error: Error): StepSpawner => () => { throw error }
    expect((await startStep('true', { cwd, env: {}, spawn: thrown(Object.assign(new Error('x'), { code: 'ENOENT' })) }).done).error).toBe('the shell could not be found (ENOENT)')
    expect((await startStep('true', { cwd, env: {}, spawn: thrown(Object.assign(new Error('x'), { code: 'EACCES' })) }).done).error).toBe('the shell is not executable (EACCES)')
    const plain = startStep('true', { cwd, env: {}, spawn: thrown(new Error('weird')) })
    plain.stop() // no process: a no-op
    expect((await plain.done).error).toBe('weird')
    const missing: StepSpawner = (_s, o) => spawn(join(cwd, 'missing-shell'), [], { cwd: o.cwd, stdio: 'ignore' }) // async ENOENT, no pipes
    expect(await startStep('true', { cwd, env: {}, spawn: missing }).done).toMatchObject({ code: 127, error: 'the shell could not be found (ENOENT)' })
  })
  it('keeps an error reported by a process that did start', async () => {
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('error', new Error('kill failed'))
    fake.emit('exit', 1, null); fake.emit('close', 1, null)
    expect(await step.done).toMatchObject({ code: 1, error: 'kill failed' })
  })
  it('settles once when a process that never started also reports an exit', async () => {
    const fake = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
    fake.emit('exit', 1, null); fake.emit('close', 1, null)
    expect(await step.done).toMatchObject({ code: 127, error: 'the shell could not be found (ENOENT)' })
  })
  it('uses the login-shell spawner by default', async () => {
    const spy = vi.spyOn(shell, 'spawnDshCommand').mockImplementation((script, opts) => sh(script, { cwd: opts.cwd, env: opts.env ?? {} }))
    await startStep('true', { cwd, env: { A: '1' } }).done
    expect(spy).toHaveBeenCalledWith('true', { cwd, env: { A: '1' } })
  })
})
