// cli/src/orchestrator/steps.ts
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import { killPidGroup, spawnDshCommand } from '../dsh/shell.js'

export type StepSpawner = (script: string, opts: { cwd: string; env: Record<string, string> }) => ChildProcess
/** `started` is false when the shell itself could not start: a launch error, never retried automatically. */
export interface StepResult { code: number | null; signal: NodeJS.Signals | null; error: string | null; started: boolean; stdoutTail: string; stderrTail: string }
export interface StepHandle { pid: number | undefined; done: Promise<StepResult>; stop(): void }
export const STEP_LOG_LIMIT = 8 * 1024 * 1024
const TAIL = 2000

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return 'the shell could not be found (ENOENT)'
  if (code === 'EACCES') return 'the shell is not executable (EACCES)'
  return `the shell could not start (${code ?? 'unknown error'})`
}
/** Why a step failed: how it ended plus the end of its output, never the script. */
export function stepFailure(result: StepResult): string {
  const how = result.error ?? (result.signal ? `stopped by ${result.signal}` : `exit ${result.code}`)
  const detail = (result.stderrTail.trim() || result.stdoutTail.trim())
  return (detail ? `${how}: ${detail.slice(-(TAIL - how.length - 2))}` : how).slice(0, TAIL)
}

function capture(stream: Readable | null, file: string, onFail: (message: string) => void): { tail(): string; close(): Promise<void> } {
  const out = createWriteStream(file, { mode: 0o600 })
  out.on('error', failure => onFail(`could not write ${basename(file)}: ${failure.message}`))
  const decoder = new StringDecoder('utf8')
  let bytes = 0, tail = ''
  stream?.on('error', failure => onFail(`could not read the step output: ${failure.message}`))
  stream?.on('data', (chunk: Buffer) => {
    tail = (tail + decoder.write(chunk)).slice(-TAIL)
    if (bytes >= STEP_LOG_LIMIT) return
    const room = STEP_LOG_LIMIT - bytes
    out.write(chunk.length > room ? chunk.subarray(0, room) : chunk)
    bytes += Math.min(chunk.length, room)
    if (bytes >= STEP_LOG_LIMIT) out.write('\n[output truncated]\n')
  })
  return {
    tail: () => tail + decoder.end(),
    close: () => new Promise(resolve => { if (out.closed) resolve(); else { out.once('close', () => resolve()); out.end() } }),
  }
}

/** Run a flow's shell step in its task folder and its own process group, output streamed to files. */
export function startStep(script: string, opts: { cwd: string; env: Record<string, string>; spawn?: StepSpawner; graceMs?: number }): StepHandle {
  const spawner = opts.spawn ?? ((s, o) => spawnDshCommand(s, o))
  const graceMs = opts.graceMs ?? 3000
  let child: ChildProcess
  try { child = spawner(script, { cwd: opts.cwd, env: opts.env }) }
  catch (error) {
    return { pid: undefined, stop: () => {}, done: Promise.resolve({ code: 127, signal: null, error: describe(error), started: false, stdoutTail: '', stderrTail: '' }) }
  }
  let error: string | null = null, killing = false
  // killPidGroup's SIGKILL is not tied to the leader: descendants that ignore SIGTERM still go.
  const stop = (): void => { if (child.pid !== undefined && !killing) { killing = true; killPidGroup(child.pid, graceMs) } }
  const failed = (message: string): void => { error ??= message; stop() }
  const stdout = capture(child.stdout, join(opts.cwd, 'stdout.log'), failed)
  const stderr = capture(child.stderr, join(opts.cwd, 'stderr.log'), failed)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const done = new Promise<StepResult>(resolve => {
    let settled = false
    const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return
      settled = true
      stop() // the step is over: whatever it left behind in its group goes too
      await Promise.race([closed, new Promise(r => setTimeout(r, graceMs).unref())])
      child.stdout?.destroy(); child.stderr?.destroy()
      await Promise.all([stdout.close(), stderr.close()])
      resolve({ code: error && code === null ? 127 : code, signal, error, started: child.pid !== undefined, stdoutTail: stdout.tail(), stderrTail: stderr.tail() })
    }
    child.on('error', e => { error ??= describe(e); if (child.pid === undefined) void finish(null, null) })
    child.on('exit', (code, signal) => { void finish(code, signal) })
  })
  return { pid: child.pid, done, stop }
}
