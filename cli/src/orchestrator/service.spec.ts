import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as filesystem from 'node:fs/promises'
import * as privateState from '../lib/secureState.js'
import { OrchestratorService, type OrchestratorDependencies } from './service.js'
import { OrchestratorError, Run, type Task } from './model.js'
import { compileFlow, parseFlowSource, pinnedFlowName } from './flow.js'
import { processGone, type StepSpawner } from './steps.js'
import { orchestratorRequest } from './wire.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename), stat: vi.fn(actual.stat), copyFile: vi.fn(actual.copyFile) }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
import * as fs from 'node:fs'
const diskFull = () => vi.mocked(fs.writeFileSync).mockImplementation(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })

vi.mock('./outputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./outputs.js')>()
  return { ...actual, checkOutputs: vi.fn(actual.checkOutputs), readVerdictSnapshot: vi.fn(actual.readVerdictSnapshot) }
})
import * as outputsModule from './outputs.js'

const id = '0123456789abcdef0123456789abcdef'
const task = (id: string, dependsOn: string[] = [], harness = 'test/cad') => ({ id, title: id, harness, prompt: `Build ${id} and verify it`, dependsOn })
describe('durable orchestrator lifecycle', () => {
  let root: string, service: OrchestratorService, deps: OrchestratorDependencies
  let launches: Parameters<OrchestratorDependencies['create']>[0][]
  let agents: Set<string>, sent: string[], cancelled: string[]
  const tasks = (): Task[] => service.snapshot(id).tasks as Task[]
  const active = async (): Promise<void> => { await vi.waitFor(() => expect(service.snapshot(id).state).toBe('active')) }
  const running = async (taskId: string): Promise<Task> => {
    await vi.waitFor(() => expect(tasks().find(t => t.id === taskId)?.state).toBe('running'))
    return tasks().find(t => t.id === taskId)!
  }
  const start = () => service.start({ id, engine: 'claude', prompt: 'Make something useful', parallelism: 2 })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestrator-spec-'))
    launches = []; agents = new Set(); sent = []; cancelled = []
    deps = {
      stateDir: join(root, 'state'), workspaceDir: join(root, 'projects'), command: 'harness orchestrator',
      supportsEngine: e => e === 'claude',
      catalog: () => ['cad', 'blender', 'video', 'research'].map(name => ({ id: `test/${name}`, name, description: name, engine: 'claude', viewer: name !== 'research' })),
      create: async input => { launches.push(input); const agentId = `agent-${launches.length}`; agents.add(agentId); return { agentId } },
      send: (_agent, text) => { sent.push(text) }, cancel: agent => { cancelled.push(agent) },
      agent: agent => agents.has(agent) ? { viewerUrl: `http://127.0.0.1:9999/${agent}` } : null,
    }
    service = new OrchestratorService(deps)
  })
  afterEach(() => { service.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('starts once, preserves permissions, and rejects a conflicting creation retry', async () => {
    await Promise.all([start(), start()]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].bypassPermission).toBe(false)
    expect(launches[0].prompt.length).toBeLessThan(2000)
    expect(readFileSync(join(launches[0].cwd, 'ORCHESTRATOR.md'), 'utf8')).toContain('test/blender')
    await expect(service.start({ id, engine: 'claude', prompt: 'Different' })).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' })
  })
  it('keeps a timeout that cannot be saved as a pending result, stops the worker, and applies it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await start(); await active()
    service.plan(id, [task('part'), task('next', ['part'])])
    const part = await running('part'), sentBefore = sent.length
    const internal = service as unknown as { runs: Map<string, Run>; expire(run: Run, task: Task, attempt: number): Promise<void> }
    const run = internal.runs.get(id)!
    run.tasks.find(t => t.id === 'part')!.timeoutMs = 60_000 // planned tasks cannot set one: defensive, an automatic failure on a director run
    diskFull()
    try { await internal.expire(run, run.tasks.find(t => t.id === 'part')!, 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    // The timeout is kept for the resume, but its worker is stopped at once: the time limit holds.
    expect(run.tasks.find(t => t.id === 'part')!.state).toBe('running')
    expect(run).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) })
    expect(cancelled).toEqual([part.agentId])
    expect(run.messages.some(m => m.text.startsWith('Task part attempt 1 failed.'))).toBe(false)
    await service.resume(id)
    expect(run.tasks.find(t => t.id === 'part')).toMatchObject({ state: 'failed', error: 'Timed out after 1m.' })
    expect(sent).toHaveLength(sentBefore + 1)
    expect(sent.at(-1)).toContain('Task part attempt 1 failed. Timed out after 1m.')
    expect(run.tasks.find(t => t.id === 'next')!.state).toBe('blocked')
  })
  it('does not mark a task succeeded when it is cancelled while its artifacts are being saved', async () => {
    await start(); await active()
    service.plan(id, [task('part')])
    const part = await running('part')
    writeFileSync(join(part.cwd, 'part.step'), 'cad')
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { service.cancel(id, 'part'); return realRename(from, to) })
    await expect(service.finish(id, 'part', 1, 'done', ['part.step'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(tasks()[0].state).toBe('cancelled')
    expect(service.snapshot(id).state).toBe('active')
  })
  it('never saves a stale attempt into the artifact folder of the attempt that replaced it', async () => {
    await start(); await active()
    service.plan(id, [task('part')])
    const part = await running('part')
    writeFileSync(join(part.cwd, 'part.step'), 'cad')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let raced = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (!raced && String(path).endsWith(join('artifacts', 'part'))) { raced = true; service.cancel(id, 'part'); service.retry(id, 'part') }
      return actual.mkdir(path, options)
    })
    await expect(service.finish(id, 'part', 1, 'done', ['part.step'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    const second = await vi.waitFor(async () => { const t = tasks()[0]; expect(t).toMatchObject({ attempt: 2, state: 'running' }); return t })
    expect(existsSync(join(root, 'projects', id, 'artifacts', 'part', 'attempt-2'))).toBe(false)
    writeFileSync(join(second.cwd, 'part.step'), 'cad2')
    await service.finish(id, 'part', 2, 'done again', ['part.step'])
    expect(tasks()[0]).toMatchObject({ state: 'succeeded', attempt: 2 })
  })
  it('validates every dependency and harness before launching any task', async () => {
    await start(); await active()
    for (const plan of [[task('a', ['missing'])], [task('a', ['b']), task('b', ['a'])], [task('a'), task('b', [], 'missing/harness')]]) {
      expect(() => service.plan(id, plan)).toThrow()
      expect(tasks()).toHaveLength(0)
    }
    expect(launches).toHaveLength(1)
  })
  it('fans out and joins different harnesses using pinned, checksummed copies', async () => {
    await start(); await active()
    service.plan(id, [task('part'), task('research', [], 'test/research'), task('scene', ['part', 'research'], 'test/blender'), task('film', ['scene'], 'test/video')])
    const part = await running('part'), research = await running('research')
    expect(tasks().find(t => t.id === 'scene')!.state).toBe('queued')
    writeFileSync(join(part.cwd, 'part.step'), 'verified CAD v1')
    await service.finish(id, 'part', 1, 'Dimensions checked', ['part.step'])
    writeFileSync(join(part.cwd, 'part.step'), 'unpublished CAD v2')
    await service.finish(id, 'research', 1, 'Use a warm, minimal setting.', [])
    const scene = await running('scene')
    expect(readFileSync(join(scene.cwd, 'inputs/part/part.step'), 'utf8')).toBe('verified CAD v1')
    expect(scene.inputs).toEqual({ part: 1, research: 1 })
    expect(readFileSync(join(scene.cwd, 'ORCHESTRATOR_TASK.md'), 'utf8')).toContain('warm, minimal')
    writeFileSync(join(scene.cwd, 'scene.png'), 'render fixture')
    await service.finish(id, 'scene', 1, 'Render checked', ['scene.png'])
    const film = await running('film')
    expect(readFileSync(join(film.cwd, 'inputs/scene/scene.png'), 'utf8')).toBe('render fixture')
    await service.finish(id, 'film', 1, 'Film ready', [])
    service.complete(id, 'Delivered all outputs')
    expect(service.snapshot(id).state).toBe('completed')
    expect(sent).toHaveLength(4)
    expect(research.agentId).toBeTruthy()
  })
  it('names each agent\'s role: specialists are never news, the Director only once nothing is left to run', async () => {
    // What the daemon asks before it lets a turn end ring the dial (CommanderMirrorOpts.isSubagent).
    await start(); await active()
    expect(service.roleOf(launches[0].name === `Director ${id.slice(0, 8)}` ? 'agent-1' : '')).toEqual({ role: 'director', busy: false })
    service.plan(id, [task('part')])
    const part = await running('part')
    expect(service.roleOf(part.agentId!)).toEqual({ role: 'worker' })
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: true })
    expect(service.roleOf('nobody')).toBeNull()
    await service.finish(id, 'part', 1, 'Done', [])
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: false })
    expect(service.roleOf(part.agentId!)).toEqual({ role: 'worker' })   // a finished specialist stays one
  })
  it('limits parallelism and treats a repeated plan as the same work', async () => {
    await start(); await active()
    const plan = [task('a'), task('b'), task('c')]
    service.plan(id, plan); service.plan(id, plan)
    await running('a'); await running('b')
    expect(launches).toHaveLength(3)
    expect(tasks().find(t => t.id === 'c')!.state).toBe('queued')
    await service.finish(id, 'a', 1, 'done', [])
    await running('c')
    expect(launches).toHaveLength(4)
  })
  it('blocks dependencies after failure and retries in a new workspace', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])])
    const first = await running('a')
    await service.finish(id, 'a', 1, 'A required tool is missing', [], true)
    expect(tasks().find(t => t.id === 'b')!.state).toBe('blocked')
    service.retry(id, 'a')
    const second = await running('a')
    expect(second.cwd).not.toBe(first.cwd)
    expect(second.attempt).toBe(2)
    await expect(service.finish(id, 'a', 1, 'Late old output', [])).rejects.toMatchObject({ code: 'STALE_ATTEMPT' })
    await service.finish(id, 'a', 2, 'Fixed and verified', [])
    await running('b')
  })
  it('does not mistake idle for success or complete unfinished work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} })
    expect(tasks()[0].state).toBe('running')
    expect(() => service.complete(id, 'done')).toThrow(/Every task/)
  })
  it('rejects path traversal, outside symlinks, directories, and missing artifacts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    writeFileSync(join(root, 'secret'), 'not a task artifact')
    symlinkSync(join(root, 'secret'), join(a.cwd, 'outside'))
    mkdirSync(join(a.cwd, 'directory'))
    for (const path of ['../secret', join(root, 'secret'), 'outside', 'directory', 'missing']) {
      await expect(service.finish(id, 'a', 1, 'done', [path])).rejects.toThrow()
      expect(tasks()[0].state).toBe('running')
    }
    writeFileSync(join(a.cwd, 'valid.txt'), 'safe')
    await service.finish(id, 'a', 1, 'done', ['valid.txt'])
    expect(tasks()[0].artifacts[0].sha256).toHaveLength(64)
  })
  it('stops only this project, ignores late results, and never kills sessions on close', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])]); const a = await running('a')
    service.cancel(id)
    expect(cancelled.sort()).toEqual(['agent-1', a.agentId].sort())
    expect(tasks().every(t => t.state === 'cancelled')).toBe(true)
    await expect(service.finish(id, 'a', 1, 'late', [])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    service.stop()
    expect(cancelled).toHaveLength(2)
  })
  it('cancels an agent that finishes launching after cancellation', async () => {
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start(); service.cancel(id); resolve({ agentId: 'late-director' })
    await vi.waitFor(() => expect(cancelled).toContain('late-director'))
    expect(service.snapshot(id).state).toBe('cancelled')
  })
  it('refuses blind retry of an uncertain process spawn', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux timed out') }
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].uncertain).toBe(true)
    expect(() => service.retry(id, 'a')).toThrow(/uncertain/)
  })
  it('blocks the dependents of an uncertain specialist at once, so the Director is not kept busy', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux pane could not be registered') }
    service.plan(id, [task('a'), task('b', ['a'])])
    const live = () => (service as unknown as { runs: Map<string, Run> }).runs.get(id)!.tasks // reading these never pumps
    await vi.waitFor(() => expect(live()[0]).toMatchObject({ state: 'blocked', uncertain: true }))
    await vi.waitFor(() => expect(live()[1]).toMatchObject({ state: 'blocked', error: 'An upstream task did not succeed.' }))
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: false })
  })
  it('keeps a saved result taken when delivering it to the Director cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start(); await active()
    service.plan(id, [task('a')]); await running('a')
    const actual = vi.mocked(fs.writeFileSync).getMockImplementation()!
    let writes = 0
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (++writes > 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return actual(file, data, options)
    })
    try { await service.finish(id, 'a', 1, 'done', []) } finally { vi.mocked(fs.writeFileSync).mockImplementation(actual) }
    expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: after the result: ENOSPC: no space left on device, write')
    expect((service as unknown as { runs: Map<string, Run> }).runs.get(id)!.tasks[0].state).toBe('succeeded')
  })
  it('counts a task waiting for an answer as work still out for the Director', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux pane could not be registered') }
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(tasks()[0]).toMatchObject({ state: 'blocked', uncertain: true }))
    const run = (service as unknown as { runs: Map<string, Run> }).runs.get(id)!
    run.tasks[0].state = 'waiting' // no service path reaches an approval yet: the model state alone
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: true })
  })
  it('persists transcript and reattaches without launching duplicate agents', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    service.ingest({ type: 'turn_started', agentId: 'agent-1', payload: {} })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Working ' } })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'on it.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1', payload: {} })
    service.stop()
    service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'Working on it.' })]))
    expect(tasks()[0].agentId).toBe('agent-2')
    expect(launches).toHaveLength(2)
    await service.finish(id, 'a', 1, 'recovered result', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('handles lost chat acknowledgments without sending twice', async () => {
    await start(); await active()
    const messageId = '11111111111111111111111111111111'
    service.chat(id, messageId, 'Make it taller')
    service.chat(id, messageId, 'Make it taller')
    expect(sent).toEqual(['Make it taller'])
    expect(() => service.chat(id, messageId, 'Different message')).toThrow()
  })
  it('tracks real delivery receipts and does not silently resend after restart', async () => {
    await start(); await active()
    const messageId = '22222222222222222222222222222222'
    const send = vi.spyOn(deps, 'send')
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledWith('agent-1', 'Make it taller', messageId)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'unknown' })]))
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledTimes(1)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'started' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'started' })]))
  })
  it('recovers a result notification saved before dispatch without rerunning work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    await service.finish(id, 'a', 1, 'verified result', [])
    service.stop()
    const file = join(deps.stateDir, `${id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.messages.at(-1).delivery = 'pending' // crash between durable result and dispatch
    writeFileSync(file, JSON.stringify(saved))
    sent.length = 0
    service = new OrchestratorService(deps)
    expect(tasks()[0].state).toBe('succeeded')
    service.snapshot(id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('verified result')
    expect(launches).toHaveLength(2)
  })
  it('keeps assistant turns separate even when a user message arrives mid-stream', async () => {
    await start(); await active()
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'First ' } })
    service.chat(id, '33333333333333333333333333333333', 'New detail')
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'reply.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1' })
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Second reply.' } })
    expect((service.snapshot(id).messages as Array<{ role: string; text: string }>).filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['First reply.', 'Second reply.'])
  })
  it('steers the current worker once and rejects stale or finished attempts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    const send = vi.spyOn(deps, 'send')
    const messageId = '44444444444444444444444444444444'
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(a.agentId, expect.stringContaining('Use millimeters'), messageId)
    expect(launches).toHaveLength(2)
    expect(() => service.steer(id, 'a', 2, messageId, 'Too late')).toThrow(/older attempt/)
    await service.finish(id, 'a', 1, 'done', [])
    expect(() => service.steer(id, 'a', 1, '55555555555555555555555555555555', 'Change it')).toThrow(/revision task/)
  })
  it('revokes only this project’s queued receipts when stopped', async () => {
    await start(); await active()
    const cancelDelivery = deps.cancelDelivery = vi.fn(() => true)
    const messageId = '66666666666666666666666666666666'
    service.chat(id, messageId, 'Queued correction')
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.cancel(id)
    expect(cancelDelivery).toHaveBeenCalledExactlyOnceWith(messageId)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'failed' })]))
  })
  it('does not race a retry against a worker still being created', async () => {
    await start(); await active()
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    service.cancel(id, 'a')
    expect(() => service.retry(id, 'a')).toThrow(/previous launch/)
    resolve({ agentId: 'late-worker' })
    await vi.waitFor(() => expect(cancelled).toContain('late-worker'))
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('reports invalid folders as an editable request refusal', async () => {
    expect(await orchestratorRequest(service, { action: 'start', id, engine: 'claude', prompt: 'Hi', cwd: join(root, 'missing') })).toMatchObject({ error: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('exposes actionable wire errors without throwing or weakening validation', async () => {
    expect(await orchestratorRequest(service, { action: 'status', id: '../escape' })).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await orchestratorRequest(service, { action: 'status', id })).toMatchObject({ error: 'PROJECT_NOT_FOUND' })
    expect(await orchestratorRequest(service, { action: 'install' })).toMatchObject({ error: 'INVALID_REQUEST' })
  })
  it('deduplicates simultaneous creation after asynchronous folder validation', async () => {
    const spec = { id, engine: 'claude', prompt: 'Use this existing folder', cwd: root }
    await Promise.all([service.start(spec), service.start(spec)]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].cwd).toBe(join(realpathSync(root), '.harness-projects', id))
  })
  it('lists recent projects in order without exposing their full briefs', async () => {
    // Recency needs distinct timestamps even when CI completes both starts in one millisecond.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await start(); await active()
    clock.mockReturnValue(2000)
    const second = 'f'.repeat(32)
    await service.start({ id: second, engine: 'claude', prompt: 'A'.repeat(500) })
    await vi.waitFor(() => expect(service.snapshot(second).state).toBe('active'))
    clock.mockReturnValue(3000)
    service.chat(second, '1'.repeat(32), 'More detail')
    expect(service.list().map(r => r.id)).toEqual([second, id])
    expect(String(service.list()[0].prompt)).toHaveLength(160)
  })
  it('preserves corrupt state and refuses to overwrite its identity', async () => {
    mkdirSync(deps.stateDir, { recursive: true })
    const file = join(deps.stateDir, `${id}.json`)
    writeFileSync(file, '{not valid JSON')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(service.list()).toEqual([])
    await expect(start()).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    expect(readFileSync(file, 'utf8')).toBe('{not valid JSON')
    expect(launches).toHaveLength(0)
  })
  it('recovers interrupted director and worker launches conservatively', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.state = 'starting'; saved.directorId = null; saved.tasks[0].state = 'launching'
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id)).toMatchObject({ state: 'paused', directorAvailable: false, tasks: [{ state: 'blocked', uncertain: true }] })
    await expect(service.resume(id)).rejects.toThrow(/original director/)
    expect(launches).toHaveLength(2)
  })
  it.each([new Error('Engine not authenticated'), 'unknown process refusal'])('records a director creation failure without hiding it: %s', async failure => {
    deps.create = async () => { throw failure }
    await start()
    await vi.waitFor(() => expect(service.snapshot(id).state).toBe('failed'))
    expect(service.snapshot(id).error).toBe(failure instanceof Error ? failure.message : 'Director launch failed.')
  })
  it('never overwrites an existing workspace, even without a saved run', async () => {
    mkdirSync(join(deps.workspaceDir, id), { recursive: true })
    await expect(start()).rejects.toMatchObject({ code: 'WORKSPACE_EXISTS' })
    expect(launches).toHaveLength(0)
  })
  it('refuses unsupported engines and invalid folder forms before creation', async () => {
    await expect(service.start({ id, engine: 'codex', prompt: 'Test' })).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' })
    const file = join(root, 'file'); writeFileSync(file, 'not a directory')
    for (const cwd of ['relative/path', `${root}\n`, file]) await expect(service.start({ id, engine: 'claude', prompt: 'Test', cwd })).rejects.toMatchObject({ code: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('does not start cancelled work while its folder is being prepared', async () => {
    await start(); await active(); service.plan(id, [task('a')]); service.cancel(id, 'a')
    await vi.waitFor(() => expect((service as unknown as { launching: Set<string> }).launching.size).toBe(0))
    expect(tasks()[0].state).toBe('cancelled'); expect(launches).toHaveLength(1)
  })
  it('handles a removed harness without mistaking it for an uncertain spawn', async () => {
    await start(); await active(); service.plan(id, [task('a')]); deps.catalog = () => []
    await vi.waitFor(() => expect(tasks()[0].state).toBe('failed'))
    expect(tasks()[0]).toMatchObject({ uncertain: false, error: expect.stringContaining('no longer installed') })
    expect(launches).toHaveLength(1)
  })
  it('can run general-purpose work, resume, and add a new revision after completion', async () => {
    await start(); await active(); service.plan(id, [task('notes', [], 'engine:claude')]); await running('notes')
    expect(launches[1].dsh).toBeNull()
    await service.finish(id, 'notes', 1, 'Verified notes', [])
    await service.finish(id, 'notes', 1, 'Same completed result', [])
    service.complete(id, 'Done'); service.chat(id, '2'.repeat(32), 'Create a revision')
    expect(service.snapshot(id).state).toBe('active')
    service.plan(id, [task('revision', ['notes'], 'engine:claude')]); await running('revision')
    service.cancel(id); await service.resume(id)
    expect(service.snapshot(id).state).toBe('active')
    expect(tasks()[0].state).toBe('succeeded'); expect(tasks()[1].state).toBe('cancelled')
    expect(launches).toHaveLength(3)
  })
  it('reports the same failure only once and rejects overlapping result commits', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b')]); await running('a'); await running('b')
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    expect(sent).toHaveLength(1)
    const first = service.finish(id, 'b', 1, 'Verified', [])
    await expect(service.finish(id, 'b', 1, 'Verified', [])).rejects.toMatchObject({ code: 'FINISH_IN_PROGRESS' })
    await first
  })
  it.each([new Error('Input route disappeared'), 'unknown dispatch failure'])('retains uncertain guidance instead of resending: %s', async failure => {
    await start(); await active(); deps.send = vi.fn(() => { throw failure })
    service.chat(id, '3'.repeat(32), 'Make it taller')
    service.chat(id, '3'.repeat(32), 'Make it taller')
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'unknown', deliveryReason: failure instanceof Error ? failure.message : 'Message delivery could not be confirmed.' })]))
  })
  it('leaves a recovered pending receipt pending when no director was recorded', async () => {
    await start(); await active(); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; saved.messages.push({ id: '4'.repeat(32), role: 'system', text: 'Saved result', at: Date.now(), delivery: 'pending' })
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
    expect(sent).toHaveLength(0)
  })
  it('flushes coalesced transcript changes and bounds retained messages', async () => {
    await start(); await active()
    for (let i = 0; i < 205; i++) {
      service.ingest({ type: 'turn_started', agentId: 'agent-1' })
      service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: `Reply ${i}` } })
    }
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'Connection lost' } })
    service.ingest({ type: 'unknown', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', replay: true, payload: { content: 'duplicate replay' } })
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(deps.stateDir, `${id}.json`), 'utf8')).error).toBe('Connection lost'))
    expect(service.snapshot(id).messages).toHaveLength(200)
    service.delivery({ deliveryId: 'missing', sessionId: 'not-this-project', state: 'rejected' })
    service.stop()
    const before = service.snapshot(id)
    service.delivery({ deliveryId: 'missing', sessionId: 'agent-1', state: 'started' })
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'ignored after shutdown' } })
    expect(service.snapshot(id)).toEqual(before)
  })
  it('pauses after a real background storage failure without duplicating the agent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start()
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try {
      resolve({ agentId: 'created-before-storage-failure' })
      await vi.waitFor(() => expect(service.snapshot(id).state).toBe('paused'))
      expect(service.snapshot(id).error).toMatch(/background error/)
    } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).directorId).toBe('created-before-storage-failure')
  })
  it('keeps cancellation authoritative when director creation later rejects', async () => {
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    await start(); service.plan(id, [task('queued-before-director')]); service.cancel(id)
    reject(new Error('Spawn rejected after cancellation'))
    await vi.waitFor(() => expect(service.snapshot(id).error).toBe('Spawn rejected after cancellation'))
    expect(service.snapshot(id).state).toBe('cancelled')
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('keeps cancellation authoritative when worker creation later rejects', async () => {
    await start(); await active()
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    service.cancel(id, 'a'); reject(new Error('Late spawn refusal'))
    await vi.waitFor(() => expect((service as unknown as { launching: Set<string> }).launching.size).toBe(0))
    expect(tasks()[0]).toMatchObject({ state: 'cancelled', uncertain: false })
  })
  it('does not downgrade a very fast worker result while creation is returning', async () => {
    await start(); await active()
    deps.create = async () => {
      await service.finish(id, 'fast', 1, 'Already verified', [])
      return { agentId: 'fast-worker' }
    }
    service.plan(id, [task('fast')])
    await vi.waitFor(() => expect(tasks()[0].agentId).toBe('fast-worker'))
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes non-Error worker failures and explicit input rejection', async () => {
    await start(); await active()
    deps.create = async () => { throw 'untyped refusal' }
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].error).toBe('Could not start this specialist.')
    const receipt = '9'.repeat(32)
    service.chat(id, receipt, 'Explain the blocker')
    service.delivery({ deliveryId: receipt, sessionId: 'agent-1', state: 'rejected', reason: 'Input route closed' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: receipt, delivery: 'failed', deliveryReason: 'Input route closed' })]))
  })
  it('preserves orphaned worker results without inventing a director', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    await service.finish(id, 'a', 1, 'Verified despite disconnected director', [])
    expect(tasks()[0].state).toBe('succeeded'); expect(sent).toHaveLength(0)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
  })
  it('does not lose a committed result if staging cleanup itself fails', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    vi.mocked(filesystem.rm).mockRejectedValueOnce(new Error('Cleanup refused'))
    await service.finish(id, 'a', 1, 'Verified', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes untyped private-state and background notification failures', async () => {
    await start(); await active(); service.stop()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(privateState, 'readPrivateStateFile').mockImplementationOnce(() => { throw 'untyped state failure' })
    service = new OrchestratorService(deps); expect(service.list()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid state'))
    service.stop(); service = new OrchestratorService(deps)
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw 'untyped observer failure' } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = 'e'.repeat(32)
    await service.start({ id: other, engine: 'claude', prompt: 'Another project' })
    await vi.waitFor(() => expect(service.snapshot(other).state).toBe('paused'))
    expect(service.snapshot(other).error).toContain('unknown error')
  })
  it('finishes a 64-task mixed-engine graph with bounded parallelism and verified fan-in', async () => {
    deps.supportsEngine = engine => ['claude', 'codex', 'opencode'].includes(engine)
    deps.catalog = () => ['cad', 'blender', 'video', 'research'].map((name, i) => ({
      id: `test/${name}`, name, description: `Synthetic ${name}`, engine: ['codex', 'claude', 'opencode'][i % 3], viewer: i !== 3,
    }))
    await service.start({ id, engine: 'claude', prompt: 'Stress-test a creative fan-out/fan-in project', parallelism: 6 }); await active()
    const graph = Array.from({ length: 64 }, (_, i) => task(`work-${i}`, i < 6 ? [] : [...new Set([`work-${i - 6}`, `work-${Math.floor((i - 6) / 2)}`])], `test/${['cad', 'blender', 'video', 'research'][i % 4]}`))
    service.plan(id, graph.slice(0, 32)); service.plan(id, graph.slice(32))
    expect(() => service.plan(id, [task('one-too-many')])).toThrow(/64 tasks/)
    let finished = 0, checkedInputs = 0
    while (finished < 64) {
      await vi.waitFor(() => expect(tasks().some(t => t.state === 'running')).toBe(true))
      const batch = tasks().filter(t => t.state === 'running')
      expect(tasks().filter(t => ['running', 'launching'].includes(t.state)).length).toBeLessThanOrEqual(6)
      for (const current of batch) {
        for (const parent of current.dependsOn) {
          expect(readFileSync(join(current.cwd, 'inputs', parent, 'result.txt'), 'utf8')).toBe(`Verified ${parent}`)
          checkedInputs++
        }
        writeFileSync(join(current.cwd, 'result.txt'), `Verified ${current.id}`)
        await service.finish(id, current.id, current.attempt, `Checked ${current.dependsOn.length} upstream contracts`, ['result.txt'])
        finished++
      }
    }
    expect(checkedInputs).toBeGreaterThan(100)
    expect(new Set(launches.slice(1).map(l => l.engine))).toEqual(new Set(['claude', 'codex', 'opencode']))
    expect(launches).toHaveLength(65)
    service.complete(id, 'All 64 task results and pinned input contracts verified')
    expect(service.snapshot(id).state).toBe('completed')
  }, 30_000)
})

const sh: StepSpawner = (script, opts) => spawn('/bin/sh', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
// A descendant that ignores SIGTERM, with its output redirected so the step's pipes close without it.
const steps = (...tasks: object[]): string => JSON.stringify({ spec: 1, name: 'demo', tasks }) // JSON is YAML: no quoting puzzles
const stubborn = (file: string) => `sh -c 'trap "" TERM; echo $$ > "${file}"; while :; do sleep 1; done' >/dev/null 2>&1 &`

describe('flow runs', () => {
  let root: string, project: string, service: OrchestratorService, deps: OrchestratorDependencies
  let launches: Parameters<OrchestratorDependencies['create']>[0][], agents: Set<string>, cancelled: string[]
  const flowId = 'abcdefabcdefabcdefabcdefabcdef12'
  const snap = () => service.snapshot(flowId) as unknown as Run & { tasks: Task[] }
  const state = (taskId: string) => snap().tasks.find(t => t.id === taskId)!
  const until = async (taskId: string, wanted: Task['state'], attempt?: number): Promise<Task> => {
    await vi.waitFor(() => expect(state(taskId)).toMatchObject({ state: wanted, ...(attempt ? { attempt } : {}) }), { timeout: 5000 })
    return state(taskId)
  }
  const startFlow = (source: string, inputs: Record<string, string> = {}) =>
    service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, '.harness/flows/demo.yaml') }, inputs })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestrator-flow-')); project = join(root, 'project'); mkdirSync(project)
    launches = []; agents = new Set(); cancelled = []
    deps = {
      stateDir: join(root, 'state'), workspaceDir: join(root, 'projects'), command: 'harness orchestrator', spawnStep: sh,
      supportsEngine: e => e === 'claude' || e === 'codex',
      catalog: () => [{ id: 'test/cad', name: 'cad', description: 'cad', engine: 'claude', viewer: true }],
      create: async input => { launches.push(input); const agentId = `agent-${launches.length}`; agents.add(agentId); return { agentId } },
      send: () => {}, cancel: agent => { cancelled.push(agent) },
      agent: agent => agents.has(agent) ? {} : null,
    }
    service = new OrchestratorService(deps)
  })
  const leftovers: number[] = [], others: OrchestratorService[] = []
  afterEach(() => {
    vi.mocked(fs.writeFileSync).mockReset() // back to the real write
    for (const other of others.splice(0)) other.stop()
    service.stop(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
    for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  })
  const pidIn = async (file: string): Promise<number> => {
    const pid = await vi.waitFor(() => { const text = readFileSync(file, 'utf8'); expect(text).toMatch(/^\d+\n$/); return Number(text) }, { timeout: 5000 })
    leftovers.push(pid)
    return pid
  }

  it('runs a pinned graph without a director and completes it', async () => {
    const source = `spec: 1
name: demo
inputs: { word: { required: true } }
tasks:
  - { id: make, run: 'printf "%s" "$HARNESS_INPUT_WORD" > word.txt; echo "$HARNESS_PROJECT_DIR|$HARNESS_FLOW_DIR|$HARNESS_TASK_ID|$HARNESS_ATTEMPT"' }
  - { id: check, run: 'cat inputs/make/stdout.log', depends_on: [make] }
`
    await startFlow(source, { word: '$(id)' })
    const done = await vi.waitFor(() => { expect(snap().state).toBe('completed'); return snap() }, { timeout: 5000 })
    expect(launches).toHaveLength(0)
    expect(done).toMatchObject({ directorId: null, error: null, cwd: realpathSync(project), flow: { name: 'demo', inputs: { word: '$(id)' }, warnings: [] } })
    expect(done.flow!.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(done.root, 'flow.yaml'), 'utf8')).toBe(source)
    const make = done.tasks[0]
    expect(make).toMatchObject({ state: 'succeeded', harness: 'run', pid: expect.any(Number), promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(make.artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    expect(readFileSync(join(make.cwd, 'word.txt'), 'utf8')).toBe('$(id)')
    expect(done.tasks[1].summary).toContain(`${realpathSync(project)}|${join(project, '.harness/flows')}|make|1`)
    expect(done.messages.every(m => m.delivery === undefined)).toBe(true)
    expect(done.messages.at(-1)!.text).toBe('Flow demo completed: 2 tasks succeeded.')
  })
  it('pins a JSON flow as flow.json, records the name, and compiles again from the copy', async () => {
    const source = '{"spec":1,"name":"demo","tasks":[{"id":"a","run":"true"}]}'
    await service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, 'demo.json') } })
    await until('a', 'succeeded')
    expect(snap().flow!.source).toBe('flow.json')
    expect(readFileSync(join(snap().root, 'flow.json'), 'utf8')).toBe(source)
    expect(existsSync(join(snap().root, 'flow.yaml'))).toBe(false)
    const pinned = join(snap().root, snap().flow!.source!)
    expect(compileFlow(parseFlowSource(readFileSync(pinned, 'utf8'), pinned), {}).tasks).toEqual(compileFlow(parseFlowSource(source, 'demo.json'), {}).tasks)
  })
  it('pins any other flow as flow.yaml and records it', async () => {
    await startFlow('spec: 1\nname: demo\ntasks: [{ id: a, run: "true" }]\n')
    await until('a', 'succeeded')
    expect(snap().flow!.source).toBe('flow.yaml')
    expect(existsSync(join(snap().root, 'flow.json'))).toBe(false)
  })
  it('names the pinned copy by the source extension, ignoring case', () => {
    expect([pinnedFlowName('/p/a.json'), pinnedFlowName('/p/A.JSON'), pinnedFlowName('/p/a.yaml'), pinnedFlowName('/p/a.yml'), pinnedFlowName('/p/json')])
      .toEqual(['flow.json', 'flow.json', 'flow.yaml', 'flow.yaml', 'flow.yaml'])
  })
  it('uses the run root as the project folder when none was chosen, and says when a step printed nothing', async () => {
    await service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', flow: { source: `spec: 1\nname: demo\ntasks: [{ id: a, run: 'test -f "$HARNESS_PROJECT_DIR/flow.yaml"' }]\n`, path: '/flows/demo.yaml' } })
    expect(await until('a', 'succeeded')).toMatchObject({ summary: 'Exited 0.' })
    expect(snap().cwd).toBeUndefined()
  })
  it('fails a step with its exit code and stops the flow with a readable error', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'echo nope >&2; exit 4' }\n  - { id: after, run: 'true', depends_on: [bad] }\n`)
    expect((await until('bad', 'failed')).error).toBe('exit 4: nope')
    // A failed attempt keeps its logs as artifacts once its process is gone.
    await vi.waitFor(() => expect(state('bad').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']))
    expect(readFileSync(join(snap().root, 'artifacts', 'bad', 'attempt-1', 'stderr.log'), 'utf8')).toBe('nope\n')
    await until('after', 'blocked')
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: bad (failed), after (blocked). Retry a task or cancel the project.'))
    expect(snap().state).toBe('active')
    service.retry(flowId, 'bad')
    await until('bad', 'failed', 2)
  })
  it('drops the stopped-flow advice once the project is cancelled', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'exit 4' }\n`)
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: bad (failed). Retry a task or cancel the project.'))
    service.cancel(flowId)
    expect(snap()).toMatchObject({ state: 'cancelled', error: null })
  })
  it('launches agent tasks on any supported engine and refuses director-only operations', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: 'engine:codex', prompt: 'Write a.md', outputs: { files: [a.md] } }\n  - { id: b, harness: test/cad, prompt: 'Model it', timeout: 5m }\n`)
    await until('a', 'running'); await until('b', 'running')
    expect(launches.map(l => l.engine).sort()).toEqual(['claude', 'codex'])
    expect(state('a')).toMatchObject({ engine: 'codex' })
    expect(state('b')).toMatchObject({ engine: 'claude' })
    expect(() => service.plan(flowId, [task('x')])).toThrow(expect.objectContaining({ code: 'FLOW_PINNED' }))
    expect(() => service.chat(flowId, 'c'.repeat(32), 'hi')).toThrow(expect.objectContaining({ code: 'DIRECTOR_UNAVAILABLE' }))
    service.cancel(flowId, 'b')
    await service.resume(flowId)
    expect(snap().state).toBe('active')
  })
  it('validates the whole flow before creating anything', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: missing/x, prompt: p }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): missing\/x is not an installed harness/) })
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: "engine:gemini", prompt: p }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): engine:gemini cannot run/) })
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, run: "echo $inputs.x" }]\n')).rejects.toMatchObject({ code: 'INVALID_FLOW' })
    expect(existsSync(join(project, '.harness-projects'))).toBe(false)
  })
  it('creates nothing, not even the state folder, for a flow that does not compile', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: test/none, prompt: hi }]\n')).rejects.toThrow(/demo\.yaml:3:\d+: tasks\[0\] \(a\): test\/none is not an installed harness/)
    expect(existsSync(deps.stateDir)).toBe(false)
    expect(existsSync(join(project, '.harness-projects'))).toBe(false)
  })
  it('names the position of an engine this daemon cannot run', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: engine:grok, prompt: hi }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): engine:grok cannot run orchestrator work here\./) })
  })
  it('keeps ENGINE_UNSUPPORTED for a start engine this daemon cannot run, with a position when the file declares it', async () => {
    const start = (source: string) => service.start({ id: flowId, engine: 'cursor', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, '.harness/flows/demo.yaml') } })
    await expect(start('spec: 1\nname: demo\nengine: cursor\ntasks: [{ id: a, run: "true" }]\n')).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED', message: expect.stringContaining('demo.yaml:3:9: engine: cursor cannot run orchestrator work here.') })
    await expect(start('spec: 1\nname: demo\ntasks: [{ id: a, run: "true" }]\n')).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED', message: expect.stringMatching(/^[^:]*demo\.yaml: engine: cursor cannot run/) })
    expect(existsSync(deps.stateDir)).toBe(false)
  })
  it('lets a harness problem decide the code when the engine is also unsupported', async () => {
    await expect(service.start({ id: flowId, engine: 'cursor', prompt: 'Flow demo', flow: { source: 'spec: 1\nname: demo\ntasks: [{ id: a, harness: missing/x, prompt: p }]\n', path: join(project, 'demo.yaml') } })).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' })
  })
  it('keeps flow-only fields away from director plans', async () => {
    await service.start({ id, engine: 'claude', prompt: 'Make something' })
    await vi.waitFor(() => expect(service.snapshot(id).state).toBe('active'))
    for (const extra of [{ run: 'rm -rf ~' }, { outputs: { files: ['x'] } }, { timeoutMs: 1000 }, { retry: { maxAttempts: 1 } },
      { when: 'x == 1' }, { triggerRule: 'all_done' }, { approval: { message: 'ok' } }, { cancel: 'stop' },
      { loop: { untilRun: 'true', maxIterations: 2 } }, { idleTimeoutMs: 5000 }, { retry: { maxAttempts: 2, delayMs: 2000 } }]) {
      expect(() => service.plan(id, [{ ...task('a', [], 'test/cad'), ...extra }])).toThrow(expect.objectContaining({ code: 'FLOW_ONLY' }))
    }
    expect(() => service.plan(id, [task('a', [], 'engine:codex')])).toThrow(expect.objectContaining({ code: 'HARNESS_UNAVAILABLE' }))
  })
  it('stops a running step on cancel without recording a result', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    const exited = (service as unknown as { steps: Map<string, { handle: { done: Promise<unknown> } }> }).steps.values().next().value!.handle.done
    service.cancel(flowId)
    await exited
    expect(state('slow')).toMatchObject({ state: 'cancelled', artifacts: [] })
  })
  it('records a step whose shell could not start', async () => {
    deps.spawnStep = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    expect(await until('a', 'failed')).toMatchObject({ error: 'the shell could not be found (ENOENT)' })
    expect(state('a').pid).toBeUndefined()
  })
  it('never retries a step whose shell could not start', async () => {
    const spawner = vi.fn<StepSpawner>(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) })
    deps.spawnStep = spawner
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true', retry: { max_attempts: 2 } }]\n`)
    await until('a', 'failed')
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: a (failed). Retry a task or cancel the project.'))
    expect(state('a').attempt).toBe(1)
    expect(spawner).toHaveBeenCalledTimes(1)
  })
  it('stops the process and the agent on cancel even when the state cannot be saved', async () => {
    await startFlow(steps({ id: 's', run: 'sleep 30' }, { id: 'a', harness: 'test/cad', prompt: 'p' }))
    const pid = (await until('s', 'running')).pid!, agent = (await until('a', 'running')).agentId
    diskFull()
    expect(() => service.cancel(flowId)).toThrow(/ENOSPC/)
    expect(cancelled).toEqual([agent])
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 })
  })
  it('stops every step on a daemon stop even when saving fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's1', run: 'sleep 30' }, { id: 's2', run: 'sleep 30' }))
    const pids = [(await until('s1', 'running')).pid!, (await until('s2', 'running')).pid!]
    diskFull()
    expect(() => service.stop()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(`[orchestrator] could not save ${flowId}: ENOSPC: no space left on device, write`)
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 2000 })
  })
  it('records steps it stopped on a graceful daemon stop', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    service.stop()
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    expect(saved.tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('pauses with the step result kept when its artifacts cannot be saved, and saves it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await vi.waitFor(() => expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('disk full') }), { timeout: 5000 })
    expect(liveTask('a').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId)
    expect(liveTask('a').state).toBe('succeeded')
  })
  it('waits for an explicit finish that fails, then settles the step itself', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'sleep 0.3' }]\n`)
    await until('a', 'running')
    const exited = (service as unknown as { steps: Map<string, { handle: { done: Promise<unknown> } }> }).steps.values().next().value!.handle.done
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async () => { await gate; throw new Error('disk full') })
    const explicit = service.finish(flowId, 'a', 1, 'by hand', ['stdout.log']).catch((error: Error) => error)
    await exited
    release()
    expect(await explicit).toMatchObject({ message: 'disk full' })
    await until('a', 'succeeded')
  })
  it('starts nothing when the daemon stops while a step is being prepared', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const spawned = vi.fn(sh)
    deps.spawnStep = spawned
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    vi.mocked(filesystem.mkdir).mockImplementationOnce(async (...args: Parameters<typeof realMkdir>) => { await gate; return realMkdir(...args) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    service.stop()
    release()
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(spawned).not.toHaveBeenCalled()
    expect(launches).toHaveLength(0)
  })
  it('does not record success for a step whose result is being saved when the daemon stops', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const inRename = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { reached(); await gate; return realRename(from, to) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await inRename
    service.stop()
    release()
    await vi.waitFor(() => expect(internals().finishing.size).toBe(0))
    expect(state('a').state).not.toBe('succeeded')
  })
  it('keeps a cancelled step cancelled when the daemon stops right after', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    service.cancel(flowId)
    service.stop()
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    expect(saved.tasks[0]).toMatchObject({ state: 'cancelled' })
  })

  it('finishes an agent task when its turn ends with the declared outputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'], verdict: ready } }\n  - { id: check, run: 'cat inputs/part/part.step', depends_on: [part] }\n`)
    const part = await until('part', 'running')
    const end = (payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) => service.ingest({ type: 'turn_ended', agentId: part.agentId, payload, ...extra })
    end() // no payload at all
    await vi.waitFor(() => expect(snap().messages.at(-1)!.text).toBe('Task part attempt 1: turn ended. Outputs missing: *.step, .harness/verdict.json with ready: true'))
    writeFileSync(join(part.cwd, 'part.step'), 'cad v1')
    mkdirSync(join(part.cwd, '.harness')); writeFileSync(join(part.cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: true }))
    const checks = vi.mocked(outputsModule.checkOutputs).mock.calls.length
    end({ aborted: true }); end({}, { replay: true }); service.ingest({ type: 'text_delta', agentId: part.agentId, payload: { content: 'x' } })
    expect(vi.mocked(outputsModule.checkOutputs).mock.calls.length).toBe(checks) // none of these is a finished turn
    end({}); end({}) // a duplicate end is harmless
    await until('part', 'succeeded')
    expect(state('part')).toMatchObject({ summary: 'Outputs present: part.step', artifacts: [expect.objectContaining({ path: 'part.step' })] })
    await vi.waitFor(() => expect(snap().state).toBe('completed'))
  })
  it('leaves explicit finish working and ignores turns of tasks without outputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: note, harness: test/cad, prompt: 'Write', timeout: 1h }\n`)
    const note = await until('note', 'running')
    const checks = vi.mocked(outputsModule.checkOutputs).mock.calls.length
    service.ingest({ type: 'turn_ended', agentId: note.agentId, payload: {} })
    expect(vi.mocked(outputsModule.checkOutputs).mock.calls.length).toBe(checks)
    await service.finish(flowId, 'note', 1, 'Done by hand', [])
    expect(state('note').state).toBe('succeeded')
  })
  it('keeps the task running when an output changes while it is saved', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'] } }\n`)
    const part = await until('part', 'running')
    writeFileSync(join(part.cwd, 'part.step'), 'v1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); writeFileSync(join(part.cwd, 'part.step'), 'v2, still writing') })
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed during handoff')))
    expect(state('part').state).toBe('running')
  })
  it('logs, and keeps the task running, when the outputs cannot be checked', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'] } }\n`)
    const part = await until('part', 'running')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(outputsModule.checkOutputs).mockRejectedValueOnce(new OrchestratorError('OUTPUTS_TOO_LARGE', 'too many'))
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] part attempt 1: too many'))
    vi.mocked(outputsModule.checkOutputs).mockRejectedValueOnce('boom')
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] part attempt 1: outputs not checked'))
    expect(state('part').state).toBe('running')
  })

  const internals = () => service as unknown as {
    runs: Map<string, Run>; deadlines: Map<string, unknown>; retryTimers: Map<string, unknown>; steps: Map<string, { handle: { done: Promise<unknown> }; uncertain?: string }>
    expire(run: Run, task: Task, attempt: number): Promise<void>
    commit(run: Run, mutate: (draft: Run) => void): void
    appendMessage(run: Run, role: 'user' | 'assistant' | 'system', text: string): Run['messages'][number]
    finishing: Map<string, unknown>; launching: Map<string, unknown>; reconciling: Map<string, Promise<void>>
    pump(run: Run): void
    exclusive<T>(r: Run, t: Task, n: number, b: () => Promise<T>): Promise<T>
    pending: Map<string, { task: Task; at: number; source: string }>
    fenceUncertain(run: Run, task: Task, attempt: number, error: string, source: 'exit' | 'check', at: number): Promise<boolean>
  }
  const live = () => internals().runs.get(flowId)! // the service's own objects: reading them never pumps
  const liveTask = (taskId: string) => live().tasks.find(t => t.id === taskId)!
  const onDisk = () => JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8')) as Run
  /** A shell fragment that waits until the test opens the gate (a file in the project folder): ordering without fixed delays. */
  const gate = (name: string): { run: string; open(): void } => ({
    run: `while [ ! -e "$HARNESS_PROJECT_DIR/${name}.open" ]; do sleep 0.05; done`,
    open: () => writeFileSync(join(project, `${name}.open`), ''),
  })
  /** Records what disk and memory hold at each notification. */
  const watchChanges = () => {
    const seen: { revision: number; disk: number; live: number }[] = []
    deps.changed = (_id, revision) => { seen.push({ revision, disk: onDisk().revision, live: live().revision }) }
    return seen
  }
  const objectsOf = (value: unknown, found = new Set<object>()): Set<object> => {
    if (value && typeof value === 'object' && !found.has(value)) { found.add(value); for (const child of Object.values(value)) objectsOf(child, found) }
    return found
  }

  it('runs operations on one attempt one after another, and registers at once when nobody owns it', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const order: string[] = []
    let release!: () => void
    const first = internals().exclusive(live(), liveTask('a'), 1, async () => { order.push('first in'); await new Promise<void>(r => { release = r }); order.push('first out') })
    expect(internals().finishing.size).toBe(1) // registered before the first await
    const second = internals().exclusive(live(), liveTask('a'), 1, async () => { order.push('second') })
    await vi.waitFor(() => expect(order).toEqual(['first in']))
    release(); await Promise.all([first, second])
    expect(order).toEqual(['first in', 'first out', 'second'])
    expect(internals().finishing.size).toBe(0)
  })
  it('commits a transition into the same objects, or not at all', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').pid).toEqual(expect.any(Number)))
    const run = live(), task = liveTask('a'), revision = run.revision
    expect(run.cwd).toBeDefined()
    const dirty = () => (internals() as unknown as { dirty: Map<string, unknown> }).dirty
    const changed = (internals() as unknown as { changed(r: Run, durable: boolean): void }).changed.bind(service)
    changed(run, false) // leaves a dirty-save timer
    const seen = watchChanges()
    internals().commit(run, draft => { draft.tasks[0].summary = 'x'; delete draft.tasks[0].pid; delete draft.cwd; draft.error = 'note' })
    expect(dirty().size).toBe(0) // the commit carried that change too
    expect(seen).toEqual([{ revision: revision + 2, disk: revision + 2, live: revision + 2 }]) // once, after disk and memory agree
    expect(liveTask('a')).toBe(task)
    expect(task).toMatchObject({ summary: 'x' }); expect(task.pid).toBeUndefined()
    expect(run.cwd).toBeUndefined()
    expect(run).toMatchObject({ error: 'note', revision: revision + 2 })
    expect(onDisk().tasks[0].summary).toBe('x')

    // A failed save leaves the live run exactly as it was, nested data included, and keeps the pending dirty save.
    run.error = 'unsaved'; changed(run, false)
    const pending = dirty().get(flowId)
    expect(pending).toBeDefined()
    const before = JSON.stringify(run), tasks = [...run.tasks]
    seen.length = 0
    diskFull()
    expect(() => internals().commit(run, draft => {
      const shared = objectsOf(run)
      expect([...objectsOf(draft)].filter(o => shared.has(o))).toEqual([]) // the draft shares nothing with the live run
      draft.tasks[0].summary = 'lost'; draft.tasks[0].dependsOn.push('z'); draft.tasks[0].inputs.z = 1
      draft.tasks[0].artifacts.push({ path: 'p', size: 1, sha256: 'f'.repeat(64) } as Task['artifacts'][number])
      draft.messages.push({ id: 'm', role: 'system', text: 'lost', at: 1 }); draft.flow!.inputs.extra = 'lost'
    })).toThrow(/ENOSPC/)
    expect(JSON.stringify(run)).toBe(before)
    expect(run.tasks).toEqual(tasks); run.tasks.forEach((t, i) => expect(t).toBe(tasks[i]))
    expect(dirty().get(flowId)).toBe(pending)
    expect(seen).toEqual([])
    vi.mocked(fs.writeFileSync).mockReset()
    await vi.waitFor(() => expect(onDisk()).toMatchObject({ error: 'unsaved', revision: run.revision })) // the kept timer saves it
    expect(dirty().size).toBe(0)

    expect(() => internals().commit(run, () => internals().commit(run, () => {}))).toThrow(expect.objectContaining({ code: 'COMMIT_NESTED' }))
    expect(seen).toEqual([])
    expect(live().tasks[0]).toBe(task) // the task array still holds the same objects
  })
  it('publishes tasks by id and refuses a draft that changes the task list', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }, { id: 'b', run: 'sleep 30' }))
    await vi.waitFor(() => expect(live().tasks.map(t => t.state)).toEqual(['running', 'running']))
    const run = live(), a = liveTask('a'), b = liveTask('b'), revision = run.revision
    const seen = watchChanges()
    internals().commit(run, draft => { draft.tasks.reverse(); draft.tasks[0].summary = 'first' })
    expect(run.tasks[0]).toBe(b); expect(run.tasks[1]).toBe(a) // the draft's order, the live objects
    expect(b.summary).toBe('first'); expect(a.summary).not.toBe('first')
    expect(seen).toEqual([{ revision: revision + 1, disk: revision + 1, live: revision + 1 }])
    seen.length = 0
    const before = JSON.stringify(run)
    const twin = (draft: Run) => ({ ...draft.tasks[0] })
    for (const mutate of [
      (draft: Run) => { draft.tasks.push({ ...twin(draft), id: 'c' }) },
      (draft: Run) => { draft.tasks[1] = twin(draft) },
      (draft: Run) => { draft.tasks.pop() },
    ]) {
      expect(() => internals().commit(run, mutate)).toThrow(expect.objectContaining({ code: 'COMMIT_TASKS' }))
      expect(JSON.stringify(run)).toBe(before)
      expect(onDisk().revision).toBe(revision + 1) // nothing was written
    }
    expect(run.tasks[0]).toBe(b); expect(run.tasks[1]).toBe(a)
    expect(seen).toEqual([])
  })
  it('keeps at most 200 messages, also in a committed draft', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    internals().commit(live(), draft => { for (let i = 0; i < 250; i++) internals().appendMessage(draft, 'system', `m${i}`) })
    expect(live().messages).toHaveLength(200)
    expect(Run.parse(JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))).messages.at(-1)!.text).toBe('m249')
  })
  it('keeps the verdict of a finished attempt, failed ones included', async () => {
    writeFileSync(join(project, 'verdict.sh'), `mkdir -p .harness && printf '%s' '{"spec":1,"ready":true,"findings":[{"severity":"warning"}]}' > .harness/verdict.json\n`)
    await startFlow(steps(
      { id: 'ok', run: 'sh "$HARNESS_PROJECT_DIR/verdict.sh"' },
      { id: 'bad', run: 'sh "$HARNESS_PROJECT_DIR/verdict.sh"; exit 3' },
      { id: 'none', run: 'true' },
    ))
    await vi.waitFor(() => { expect(liveTask('ok').state).toBe('succeeded'); expect(liveTask('none').state).toBe('succeeded'); expect(liveTask('bad').state).toBe('failed') })
    expect(liveTask('ok').verdict).toEqual({ ready: true, errors: 0, warnings: 1 })
    expect(liveTask('bad').verdict).toEqual({ ready: true, errors: 0, warnings: 1 })
    expect(liveTask('none').verdict).toBeUndefined()
  })
  it('drops the verdict of an earlier attempt when its retry cannot start, so no condition reads it', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: review, harness: test/cad, prompt: p, retry: { max_attempts: 2 } }
  - { id: gate, run: 'true', depends_on: [review], trigger_rule: all_done, when: 'review.verdict.ready == true' }
`)
    await vi.waitFor(() => expect(liveTask('review').state).toBe('running'))
    const cwd = liveTask('review').cwd
    mkdirSync(join(cwd, '.harness')); writeFileSync(join(cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: true }))
    deps.create = async () => { throw new OrchestratorError('HARNESS_UNAVAILABLE', 'test/cad is no longer installed.') }
    await service.finish(flowId, 'review', 1, 'not ready yet', [], true)
    await vi.waitFor(() => expect(liveTask('review')).toMatchObject({ state: 'failed', attempt: 2, error: 'test/cad is no longer installed.' }))
    expect(liveTask('review').verdict).toBeUndefined()
    await vi.waitFor(() => expect(liveTask('gate').state).toBe('failed'))
    expect(liveTask('gate').error).toBe('review wrote no verdict; the condition review.verdict.ready == true cannot be evaluated.')
  })
  it('changes nothing when a result cannot be saved, and saves it on the next try', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    diskFull()
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(liveTask('a')).toMatchObject({ state: 'running', artifacts: [], summary: '' })
    expect(internals().deadlines.size).toBe(1)
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 succeeded'))).toBe(false)
    await service.finish(flowId, 'a', 1, 'done', ['out.txt']) // the folder renamed by the failed try is replaced
    expect(liveTask('a')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'out.txt' }] })
  })
  it('changes nothing when a reported failure cannot be saved, and saves it on the next try', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const revision = live().revision
    diskFull()
    await expect(service.finish(flowId, 'a', 1, 'broken', [], true)).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 1, error: null, summary: '' })
    expect(live().revision).toBe(revision)
    expect(internals().deadlines.size).toBe(1)
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 failed'))).toBe(false)
    expect(launches).toHaveLength(1) // no retry was started for a failure that was never taken
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    expect(onDisk().messages.some(m => m.text.startsWith('Task a attempt 1 failed. broken'))).toBe(true)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('pauses when a step failure cannot be saved, and retries it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: `[ "$HARNESS_ATTEMPT" = 1 ] && { ${g.run}; exit 1; }; sleep 30`, retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"failed"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk), { timeout: 5000 })
    expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 1 })
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(live().messages.some(m => m.text.startsWith('Task s attempt 1 failed. exit 1'))).toBe(true)
  })
  /** Holds the next verdict read until released. */
  const holdVerdictRead = () => {
    let release!: () => void, reading = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(async () => { reading = true; await gate; return undefined })
    return { release, reading: () => reading }
  }
  it.each(['cancel', 'stop'] as const)('does not stop or cancel anything for a timeout that a %s beat', async winner => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const hold = holdVerdictRead()
    const expiring = internals().expire(live(), liveTask('a'), 1)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    if (winner === 'cancel') service.cancel(flowId, 'a'); else service.stop()
    const before = [...cancelled]
    hold.release(); await expiring
    expect(cancelled).toEqual(before) // the agent that survives a daemon stop is not cancelled by the timeout
    if (winner === 'cancel') expect(liveTask('a').state).toBe('cancelled')
    expect(liveTask('a').error).not.toBe('Timed out after 1h.')
    expect(warn).not.toHaveBeenCalled()
  })
  it('writes nothing more for a result once its task is stopped during a wait', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(filesystem.stat).mockImplementationOnce(async path => { service.cancel(flowId, 'a'); return actual.stat(path) })
    vi.mocked(filesystem.copyFile).mockClear()
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(filesystem.copyFile).not.toHaveBeenCalled()
    expect(existsSync(join(live().root, 'artifacts'))).toBe(false)
  })
  it('does not save a result over a cancel that came during the staging cleanup', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let raced = false
    vi.mocked(filesystem.rm).mockImplementation(async (path, options) => {
      if (!raced && String(path).endsWith('.staging')) { raced = true; service.cancel(flowId, 'a') }
      return actual.rm(path, options)
    })
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(raced).toBe(true)
    expect(liveTask('a').state).toBe('cancelled')
    expect(onDisk().tasks[0].state).toBe('cancelled')
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 succeeded'))).toBe(false)
  })
  it('still stops a timed-out worker when the retry it releases cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const agentId = liveTask('a').agentId
    diskFull()
    try { await internals().expire(live(), liveTask('a'), 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    expect(cancelled).toEqual([agentId])
    // The timeout could not be saved: the run pauses with it kept, and resuming applies it and starts the retry.
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 1 })
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('runs what follows a reported result once, even when a change observer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw new Error('observer down') } }
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    expect(warn).toHaveBeenCalledWith('[orchestrator] change notification failed: observer down')
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(live().messages.filter(m => m.text.startsWith('Task a attempt 1 failed. '))).toHaveLength(1)
    expect(internals().deadlines.size).toBe(1) // only the new attempt's
  })
  it('takes an automatic failure once, even when a change observer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: '[ "$HARNESS_ATTEMPT" = 1 ] && { sleep 0.3; exit 1; }; sleep 30', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw new Error('observer down') } }
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 2 }), { timeout: 5000 })
    expect(warn).toHaveBeenCalledWith('[orchestrator] change notification failed: observer down')
    expect(live().messages.filter(m => m.text.startsWith('Task s attempt 1 failed. '))).toHaveLength(1)
  })
  it('times out a step, kills it, and retries it a bounded number of times', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'echo "$HARNESS_ATTEMPT" >> "$HARNESS_PROJECT_DIR/attempts"; sleep 30', timeout: 1s, retry: { max_attempts: 2 } }]\n`)
    await until('slow', 'failed', 2)
    expect(state('slow').error).toBe('Timed out after 1s.')
    expect(readFileSync(join(project, 'attempts'), 'utf8')).toBe('1\n2\n')
    await vi.waitFor(() => expect(state('slow').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']))
    expect(existsSync(join(snap().root, 'artifacts', 'slow', 'attempt-1', 'stdout.log'))).toBe(true)
    expect(snap().messages.some(m => m.text === 'Task slow attempt 1 failed; retrying (attempt 2 of 2).')).toBe(true)
    // While the retry was due the flow was never reported as stopped.
    expect(snap().messages.filter(m => m.text.startsWith('Task slow attempt')).map(m => m.text.split('\n')[0])).toEqual([
      'Task slow attempt 1 failed. Timed out after 1s.', 'Task slow attempt 1 failed; retrying (attempt 2 of 2).', 'Task slow attempt 2 failed. Timed out after 1s.',
    ])
    expect(internals().deadlines.size).toBe(0)
  }, 15_000)
  it('times out an agent task, cancels its worker after winning, and retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h, retry: { max_attempts: 2 } }]\n`)
    const a = await until('a', 'running')
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10)
    await until('a', 'running', 2)
    expect(cancelled).toEqual([a.agentId])
    expect(snap().messages.some(m => m.text.includes('Timed out after 1h.'))).toBe(true)
  })
  it('lets a finish that is already saving win over the timeout', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    writeFileSync(join(a.cwd, 'out.txt'), 'x')
    let release!: () => void
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await new Promise<void>(r => { release = r }); return realCopy(from, to) })
    const finishing = service.finish(flowId, 'a', 1, 'done', ['out.txt'])
    const run = internals().runs.get(flowId)!
    const expiring = internals().expire(run, run.tasks[0], 1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await finishing; await expiring
    expect(state('a').state).toBe('succeeded')
    expect(cancelled).toEqual([])
    expect(internals().deadlines.size).toBe(0)
  })
  it('keeps the first automatic result that cannot be saved, and ignores the ones queued behind it while paused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, outputs: { files: [out.txt] }, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    writeFileSync(join(a.cwd, 'out.txt'), 'x')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const inRename = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async () => { reached(); await gate; throw new Error('disk full') })
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // owns the attempt
    await inRename
    const checks = vi.mocked(outputsModule.checkOutputs)
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // queues first
    await checks.mock.results.at(-1)!.value // its settle is now waiting
    const run = internals().runs.get(flowId)!
    const expiring = internals().expire(run, run.tasks[0], 1) // queues second
    release()
    await expiring
    await vi.waitFor(() => expect(internals().finishing.size).toBe(0))
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('disk full') })
    expect(liveTask('a').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    expect(cancelled).toEqual([])
    await service.resume(flowId) // the kept success was seen before the 1h deadline
    expect(liveTask('a').state).toBe('succeeded')
  })
  it('ignores an expiry that belongs to an older attempt', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('a', 'running')
    await service.finish(flowId, 'a', 1, 'nope', [], true)
    service.retry(flowId, 'a')
    await until('a', 'running', 2)
    const run = internals().runs.get(flowId)!
    await internals().expire(run, run.tasks[0], 1)
    expect(state('a')).toMatchObject({ state: 'running', attempt: 2 })
    expect(cancelled).toEqual([])
  })
  it('runs a failing worker at most max_attempts times in all, and never retries without retry', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, retry: { max_attempts: 3 } }, { id: b, harness: test/cad, prompt: p }, { id: c, harness: test/cad, prompt: p, retry: { max_attempts: 1 } }]\n`)
    for (const attempt of [1, 2, 3]) {
      await until('a', 'running', attempt)
      await service.finish(flowId, 'a', attempt, `gave up ${attempt}`, [], true)
    }
    for (const id of ['b', 'c']) {
      await until(id, 'running')
      await service.finish(flowId, id, 1, 'gave up', [], true)
    }
    expect(state('a')).toMatchObject({ state: 'failed', attempt: 3 })
    expect(state('b')).toMatchObject({ state: 'failed', attempt: 1 })
    expect(state('c')).toMatchObject({ state: 'failed', attempt: 1 })
    expect(launches).toHaveLength(5)
  })
  it('waits for a failed step to exit before retrying, and lets cancel or a manual retry take over', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: s, run: 'trap "" TERM; while :; do sleep 1; done', timeout: 1s, retry: { max_attempts: 2 } }]\n`)
    await until('s', 'failed', 1)
    const exited = internals().steps.values().next().value!.handle.done
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'TASK_STOPPING' }))
    service.cancel(flowId, 's') // drops the due retry; the failed attempt stays failed
    await exited
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(state('s')).toMatchObject({ state: 'failed', attempt: 1 })
    service.retry(flowId, 's')
    await until('s', 'running', 2)
  }, 15_000)
  it('starts a retry only once the failed attempt\'s leftovers are gone', async () => {
    const child = join(project, 'child.pid'), overlap = join(project, 'overlap')
    await startFlow(steps({ id: 's', run: `[ "$HARNESS_ATTEMPT" = 1 ] || { kill -0 "$(cat ${child})" 2>/dev/null && touch ${overlap}; exit 0; }; ${stubborn(child)} sleep 0.3; exit 1`, retry: { max_attempts: 2 } }))
    await pidIn(child)
    await until('s', 'succeeded', 2)
    expect(existsSync(overlap)).toBe(false)
  }, 15_000)
  it('kills steps outright on a daemon stop, leftovers that ignore SIGTERM included', async () => {
    const child = join(project, 'child.pid')
    await startFlow(steps({ id: 's', run: `${stubborn(child)} wait` }))
    const pid = await pidIn(child)
    service.stop()
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000 })
  })
  it('does not retry while the failed attempt is still launching', async () => {
    let finishLaunch!: () => void
    deps.create = async input => { launches.push(input); await new Promise<void>(r => { finishLaunch = r }); agents.add('late'); return { agentId: 'late' } }
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, retry: { max_attempts: 2 } }]\n`)
    await until('a', 'launching')
    await vi.waitFor(() => expect(finishLaunch).toBeTypeOf('function'))
    await service.finish(flowId, 'a', 1, 'reported early', [], true)
    expect(launches).toHaveLength(1)
    expect(state('a')).toMatchObject({ state: 'failed', attempt: 1 })
    finishLaunch()
    await until('a', 'launching', 2)
  })
  it('recovers after a crash: steps become uncertain, deadlines are enforced', async () => {
    await startFlow(steps({ id: 'slow', run: 'sleep 30' }, { id: 'agent', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'nopid', run: 'sleep 30' }))
    await vi.waitFor(() => { for (const id of ['slow', 'agent', 'nopid']) expect(liveTask(id).state).toBe('running') })
    const left = orphan() // stands in for slow's process, which outlived the crash
    const saved = onDisk()
    saved.tasks.find(t => t.id === 'slow')!.pid = left.pid
    saved.tasks.find(t => t.id === 'agent')!.deadline = Date.now() - 1
    delete saved.tasks.find(t => t.id === 'nopid')!.pid
    const agentId = liveTask('agent').agentId
    service.stop() // the original daemon is gone before the next one starts
    const dir = join(root, 'state-after-crash')
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    const recovered = new OrchestratorService({ ...deps, stateDir: dir }); others.push(recovered)
    await recovered.recover()
    const after = (taskId: string) => (recovered as unknown as { runs: Map<string, Run> }).runs.get(flowId)!.tasks.find(t => t.id === taskId)!
    expect(after('slow')).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringContaining(`pid ${left.pid}`) })
    expect(after('nopid').error).toContain('pid unknown')
    expect(() => recovered.retry(flowId, 'slow')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    await vi.waitFor(() => expect(after('agent')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toContain(agentId)
  })
  it('enforces recovered deadlines only once recover() says the daemon is ready, not on an early lookup', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    const a = await until('a', 'running')
    service.stop()
    const file = join(deps.stateDir, `${flowId}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.tasks[0].deadline = Date.now() - 1
    writeFileSync(file, JSON.stringify(saved))
    service = new OrchestratorService(deps)
    expect(service.roleOf(a.agentId!)).toEqual({ role: 'worker' }) // the daemon asks this while it is still starting
    // loading is synchronous: nothing was scheduled that could still arm a deadline
    expect(internals().deadlines.size).toBe(0)
    expect(state('a').state).toBe('running')
    expect(cancelled).toEqual([])
    await service.recover()
    await vi.waitFor(() => expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toEqual([a.agentId])
  })
  /** A second daemon over a copy of a running step's state, as if the first had crashed with this pid recorded. */
  const afterCrash = async (pid: number | undefined): Promise<{ recovered: OrchestratorService; step: () => Task }> => {
    await startFlow(steps({ id: 's', run: 'sleep 30', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const saved = onDisk()
    saved.tasks[0].pid = pid
    const dir = join(root, 'state-after-crash')
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    service.stop() // the original daemon is gone before the next one starts
    const recovered = new OrchestratorService({ ...deps, stateDir: dir })
    others.push(recovered)
    await recovered.recover()
    return { recovered, step: () => (recovered as unknown as { runs: Map<string, Run> }).runs.get(flowId)!.tasks[0] }
  }
  /** A second daemon on a copy of this run's saved state, started after the first one stopped (as after a crash). */
  const restartOn = async (mutate: (saved: Run) => void = () => {}): Promise<{ next: OrchestratorService; run: () => Run }> => {
    const saved = onDisk(); mutate(saved)
    service.stop()
    const dir = join(root, `state-${others.length}`)
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    const next = new OrchestratorService({ ...deps, stateDir: dir }); others.push(next)
    await next.recover()
    return { next, run: () => (next as unknown as { runs: Map<string, Run> }).runs.get(flowId)! }
  }
  const exitedPid = async (command: string, args: string[]): Promise<{ pid: number; exited: Promise<unknown> }> => {
    const child = spawn(command, args, { stdio: 'ignore' })
    leftovers.push(child.pid!)
    return { pid: child.pid!, exited: new Promise(resolve => child.once('exit', resolve)) }
  }
  /** A process the test owns, alone in its own group, standing in for a step that outlived a crashed daemon. */
  const orphan = (script = 'sleep 30'): { pid: number; exited: Promise<unknown> } => {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
    leftovers.push(-child.pid!) // afterEach kills the whole group
    return { pid: child.pid!, exited: new Promise(resolve => child.once('exit', resolve)) }
  }
  it('fails a crashed step whose process already exited, and lets it be retried by hand', async () => {
    const gone = await exitedPid('true', [])
    await gone.exited
    const { recovered, step } = await afterCrash(gone.pid)
    expect(step()).toMatchObject({ state: 'failed', uncertain: false, error: `Interrupted by a daemon restart (pid ${gone.pid} had already exited). Retry to run it again.` })
    expect(step().retryAt).toBeUndefined() // never retried automatically
    expect(step()).toMatchObject({ state: 'failed', attempt: 1 })
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('refuses to retry a crashed step while its process lives, and accepts once it exited', async () => {
    const live = await exitedPid('sleep', ['30'])
    const { recovered, step } = await afterCrash(live.pid)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: expect.stringContaining(`pid ${live.pid}`) }))
    process.kill(live.pid, 'SIGKILL')
    await live.exited
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2, uncertain: false }))
  })
  it('refuses to retry a crashed step whose leader exited while its group still runs', async () => {
    const left = orphan('sleep 30 & exit 0') // the shell exits at once; its sleep stays in the group
    await left.exited
    const { recovered, step } = await afterCrash(left.pid)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringContaining(`pid ${left.pid}`) })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    process.kill(-left.pid, 'SIGKILL')
    await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('waits the doubled delay before each automatic retry, across a daemon restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', retry: { max_attempts: 3, delay: '2s' } }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    const failedAt = Date.now()
    await service.finish(flowId, 'w', 1, 'nope', [], true)
    expect(liveTask('w')).toMatchObject({ state: 'failed', retryAt: failedAt + 2000 })
    expect(onDisk().tasks[0].retryAt).toBe(failedAt + 2000)
    await vi.advanceTimersByTimeAsync(1999); expect(liveTask('w').attempt).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ attempt: 2, state: 'running' }))
    await service.finish(flowId, 'w', 2, 'nope', [], true)
    expect(liveTask('w').retryAt).toBe(Date.now() + 4000)
    const { run } = await restartOn()
    await vi.advanceTimersByTimeAsync(3999); expect(run().tasks[0].attempt).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(run().tasks[0]).toMatchObject({ attempt: 3, state: 'running' }))
  })
  it('arms one retry timer per task, however often the run moves meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', retry: { max_attempts: 2, delay: '1s' } }, { id: 'o', harness: 'test/cad', prompt: 'other' }))
    await vi.waitFor(() => { for (const id of ['w', 'o']) expect(liveTask(id).state).toBe('running') })
    await service.finish(flowId, 'w', 1, 'nope', [], true)
    const timer = internals().retryTimers.get(`${flowId}/w`)
    expect(timer).toBeDefined()
    await service.finish(flowId, 'o', 1, 'done', []) // its release pumps the run again
    expect(internals().retryTimers.get(`${flowId}/w`)).toBe(timer)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ attempt: 2, state: 'running' }))
    expect(launches).toHaveLength(3)
    expect(internals().retryTimers.size).toBe(0)
  })
  it('does not retry beside a process group that survived a crash, and keeps the retry when it is gone', async () => {
    await startFlow(steps({ id: 's', run: 'exit 1', retry: { max_attempts: 2, delay: '60s' } }))
    await vi.waitFor(() => expect(liveTask('s').retryAt).toBeDefined())
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    const left = orphan()
    const alive = await restartOn(saved => { saved.tasks[0].pid = left.pid }) // the crash hit while this group still ran
    expect(alive.run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1, error: `The daemon restarted while this step was stopping (pid ${left.pid}). Make sure it stopped before retrying.` })
    expect(alive.run().tasks[0].retryAt).toBeUndefined()
    const ended = await exitedPid('true', []); await ended.exited
    const gone = await restartOn(saved => { saved.tasks[0].pid = ended.pid })
    expect(gone.run().tasks[0]).toMatchObject({ state: 'failed', retryAt: expect.any(Number) })
  })
  it.each(['failed', 'cancelled'] as const)('refuses a manual retry of a %s step whose process group survived a crash, until it is gone', async ended => {
    await startFlow(steps({ id: 's', run: ended === 'failed' ? 'exit 1' : 'sleep 30' }))
    if (ended === 'cancelled') { await vi.waitFor(() => expect(liveTask('s').state).toBe('running')); service.cancel(flowId, 's') }
    await vi.waitFor(() => expect(liveTask('s').state).toBe(ended))
    const left = orphan()
    const { next, run } = await restartOn(saved => { saved.tasks[0].pid = left.pid }) // the crash hit while this group still ran
    expect(run().tasks[0]).toMatchObject({ state: ended === 'failed' ? 'blocked' : 'cancelled', uncertain: true, attempt: 1, error: `The daemon restarted while this step was stopping (pid ${left.pid}). Make sure it stopped before retrying.` })
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: `This step may still be running from before the daemon restart (pid ${left.pid}). Stop that process, then retry.` }))
    process.kill(-left.pid, 'SIGKILL')
    await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
    next.retry(flowId, 's')
    expect(run().tasks[0].attempt).toBe(2)
  })
  it('leaves a failed or cancelled step alone after a crash when its process is known to be gone', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('failed'))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('running'))
    service.cancel(flowId, 'b')
    const ended = await exitedPid('true', []); await ended.exited
    const { run } = await restartOn(saved => { for (const t of saved.tasks) t.pid = ended.pid })
    expect(run().tasks.map(t => [t.state, t.uncertain])).toEqual([['failed', false], ['cancelled', false]])
  })
  it('refuses to retry a crashed step whose pid was never recorded', async () => {
    const { recovered, step } = await afterCrash(undefined)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: expect.stringContaining('pid unknown') }))
  })
  it('recovers nothing twice and leaves deadlines of inactive projects alone', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: agent, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('agent', 'running')
    service.cancel(flowId)
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    saved.tasks[0].state = 'running'; saved.tasks[0].deadline = Date.now() - 1 // a cancelled project is never expired
    const recovered = new OrchestratorService({ ...deps, stateDir: join(root, 'state-after-crash') })
    mkdirSync(join(root, 'state-after-crash'), { mode: 0o700 }); writeFileSync(join(root, 'state-after-crash', `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    await recovered.recover(); await recovered.recover()
    expect((recovered as unknown as { deadlines: Map<string, unknown> }).deadlines.size).toBe(0)
    recovered.stop()
  })
  it('enforces a deadline that came due while the project was paused once it is resumed', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    service.stop()
    const file = join(deps.stateDir, `${flowId}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.state = 'paused'; saved.tasks[0].deadline = Date.now() - 1
    writeFileSync(file, JSON.stringify(saved))
    service = new OrchestratorService(deps)
    await service.recover()
    expect(snap().state).toBe('paused')
    expect(internals().deadlines.size).toBe(0)
    await service.resume(flowId)
    await vi.waitFor(() => expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toEqual([a.agentId])
  })
  it('stops a timed-out step even when the timeout cannot be saved, and applies it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: s, run: 'sleep 30' }]\n`)
    await until('s', 'running')
    const exited = internals().steps.values().next().value!.handle.done
    const run = internals().runs.get(flowId)!
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try { await internals().expire(run, run.tasks[0], 1) } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    await exited // the process was terminated, not left to outlive its deadline
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOTDIR/) })
    expect(liveTask('s').state).toBe('running')
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 10m.' })
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']) // its process was gone: the logs go with the timeout
  }, 15_000)
  it('does not mark a worker running or arm its deadline once the daemon has stopped', async () => {
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    service.stop()
    resolve({ agentId: 'late' })
    await vi.waitFor(() => expect(state('a').agentId).toBe('late'))
    expect(state('a').state).toBe('launching')
    expect(internals().deadlines.size).toBe(0)
  })
  it('clears pending deadlines and retries when the daemon stops', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('a', 'running')
    await service.recover(); await service.resume(flowId) // an armed deadline is not armed twice
    expect(internals().deadlines.size).toBe(1)
    service.stop()
    expect(internals().deadlines.size).toBe(0)
  })
  it('skips a branch whose condition is false and completes with skipped tasks', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: check, run: 'true' }
  - { id: fix, run: 'true', depends_on: [check], trigger_rule: all_done, when: 'check.state == failed' }
  - { id: after, run: 'true', depends_on: [fix] }
  - { id: ship, run: 'true', depends_on: [check], when: 'check.state == succeeded' }
`)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(live().tasks.map(t => [t.id, t.state])).toEqual([['check', 'succeeded'], ['fix', 'skipped'], ['after', 'skipped'], ['ship', 'succeeded']])
    expect(liveTask('fix').summary).toBe('Skipped: check.state == failed is false.')
    expect(live().messages.at(-1)!.text).toBe('Flow demo completed: 2 tasks succeeded, 2 skipped.')
  })
  it('runs an all_done report after a failure, with the failed step logs already in its inputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: tests, run: 'echo boom >&2; exit 1' }
  - { id: report, run: 'cat inputs/tests/stderr.log', depends_on: [tests], trigger_rule: all_done }
`)
    await vi.waitFor(() => expect(live()).toMatchObject({ state: 'active', error: 'Flow stopped: tests (failed). Retry a task or cancel the project.' }))
    expect(liveTask('report')).toMatchObject({ state: 'succeeded', summary: 'boom' })
  })
  it('fails a task whose condition reads a verdict the dependency never wrote', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: review, run: 'true' }\n  - { id: gate, run: 'true', depends_on: [review], when: 'review.verdict.errors == 0' }\n`)
    await vi.waitFor(() => expect(liveTask('gate').state).toBe('failed'))
    expect(liveTask('gate')).toMatchObject({ error: 'review wrote no verdict; the condition review.verdict.errors == 0 cannot be evaluated.', cwd: '' })
  })
  it('propagates skips through tasks declared before their upstream, without a status read', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: d, run: 'true', depends_on: [c] }
  - { id: c, run: 'true', depends_on: [b], when: 'b.state == failed', trigger_rule: all_done }
  - { id: b, run: 'true', depends_on: [a] }
  - { id: a, run: 'true' }
`)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(live().tasks.map(t => t.state)).toEqual(['skipped', 'skipped', 'succeeded', 'succeeded'])
  })
  it('starts dependents when a result is released, without a status read', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: work }\n  - { id: b, run: 'true', depends_on: [a] }\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    await service.finish(flowId, 'a', 1, 'done', [])
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
  })
  it('never reports completed while the last attempt is still being saved', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const states: string[] = []
    deps.changed = () => { states.push(`${live().state}:${internals().finishing.size}`) }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(states).not.toContain('completed:1')
    expect(live().state).toBe('completed')
  })
  it('publishes kept logs only to the failed attempt they belong to', async () => {
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    // Nothing public changes a failed attempt while its logs are kept (its process still holds it); the guard is defensive.
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { liveTask('bad').state = 'cancelled'; return realRename(from, to) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: bad, run: 'exit 4' }]\n`)
    await vi.waitFor(() => expect(liveTask('bad').state).toBe('cancelled'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('bad').artifacts).toEqual([])
  })
  it('publishes the logs of a timed-out step only to the failed attempt they belong to', async () => {
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    // The timeout takes the attempt; its logs are saved once the process is gone, and the task changes meanwhile (defensive).
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { liveTask('t').state = 'cancelled'; return realRename(from, to) })
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'cancelled', artifacts: [] })
    expect(onDisk().tasks[0].artifacts).toEqual([])
  })
  /** Fails every state write whose content matches, until the returned function is called. */
  const failWrites = (matches: (json: string) => boolean): (() => void) => {
    const actual = vi.mocked(fs.writeFileSync).getMockImplementation()!
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (typeof data === 'string' && matches(data)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return actual(file, data, options)
    })
    return () => vi.mocked(fs.writeFileSync).mockImplementation(actual)
  }
  const pausedByDisk = { state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) }
  /** Holds the second verdict read (the first runs normally) until released. */
  const holdSecondVerdictRead = async () => {
    const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).readVerdictSnapshot
    let release!: () => void, reading = false
    vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(actual).mockImplementationOnce(async dir => {
      reading = true; await new Promise<void>(r => { release = r }); return actual(dir)
    })
    return { release: () => release(), reading: () => reading }
  }
  it('reconciles once for concurrent resumes, and launches nothing before it ends', async () => {
    await startFlow(steps(
      { id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' },
      { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
      { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' },
    ))
    await vi.waitFor(() => { expect(liveTask('a').state).toBe('running'); expect(liveTask('x').state).toBe('running') })
    live().state = 'paused' // as a background error leaves it
    liveTask('a').deadline = Date.now() - 1; liveTask('x').deadline = Date.now() - 1 // both came due while paused
    const hold = await holdSecondVerdictRead() // a expires normally, x's expiry holds the barrier
    const first = service.resume(flowId), second = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    service.snapshot(flowId) // a status read during reconcile does not pump
    expect(liveTask('b').state).toBe('queued')
    hold.release(); await Promise.all([first, second])
    expect(live().messages.filter(m => m.text.startsWith('Task x attempt 1 failed. Timed out'))).toHaveLength(1)
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
  })
  it('defers a deadline that comes due during reconcile until it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // s is listed first: the reconcile has already passed it when its deadline comes due during x's held expiry.
    await startFlow(steps({ id: 's', harness: 'test/cad', prompt: 'p', timeout: '2h' }, { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await service.recover() // the daemon is ready: deadlines are armed again at the end of a reconcile
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    await vi.advanceTimersByTimeAsync(2 * 3_600_000) // s's own timer comes due inside the barrier and does nothing
    expect(liveTask('s').state).toBe('running')
    hold.release(); await resumed
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 2h.' }))
  })
  it('stops reconciling when the project is cancelled meanwhile', async () => {
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'b', run: 'true', depends_on: ['x'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('x').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    service.cancel(flowId) // does not wait for the barrier
    hold.release(); await resumed
    expect(live().state).toBe('cancelled')
    expect(live().tasks.map(t => t.state)).toEqual(['cancelled', 'cancelled'])
    expect(internals().launching.size).toBe(0)
  })
  it('returns a launch interrupted by a pause to the queue on resume', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    let release: (() => void) | undefined, held = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      // hold the first copy of u's logs into a's inputs, once
      if (!held && String(path).includes(join('tasks', 'a', 'attempt-1', 'inputs'))) { held = true; await new Promise<void>(r => { release = r }) }
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'u', run: 'echo hello' }, { id: 'a', run: 'cat inputs/u/stdout.log', depends_on: ['u'] }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    live().state = 'paused'; release!()
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(liveTask('a').state).toBe('launching')
    await service.resume(flowId) // back to the queue, the half-prepared folder removed, launched again
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'hello', attempt: 1 }))
  })
  it('returns a launch whose preparation ends during reconcile to the queue, and launches it once the reconcile ends', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    let prepared: (() => void) | undefined, held = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (!held && String(path).endsWith(join('tasks', 'a', 'attempt-1'))) { held = true; await new Promise<void>(r => { prepared = r }) }
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', run: 'echo ok' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(prepared).toBeTypeOf('function') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    prepared!() // a's preparation ends while x's expiry holds the reconcile
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(liveTask('a').state).toBe('queued')
    expect(internals().steps.size).toBe(0)
    hold.release(); await resumed
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'ok', attempt: 1 }))
  })
  it('keeps the launch marker of the live preparation when a reconcile ends as an interrupted launch is queued again', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    const gates: (() => void)[] = []
    let preparations = 0
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (String(path).endsWith(join('tasks', 'a', 'attempt-1')) && ++preparations <= 2) await new Promise<void>(r => { gates.push(r) })
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', run: 'echo ok' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(gates).toHaveLength(1) })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    // The narrowest order: the reconcile ends (barrier down, one pump) the moment a is queued again, before the
    // interrupted launch has cleaned up after itself. The pump starts a replacement preparation, held in its mkdir.
    deps.changed = () => {
      if (liveTask('a').state !== 'queued' || !internals().reconciling.has(flowId)) return
      internals().reconciling.delete(flowId); internals().pump(live())
    }
    gates[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    hold.release(); await resumed // the interrupted launch has long cleaned up
    expect(internals().launching.has(`${flowId}/a`)).toBe(true) // the marker belongs to the live preparation
    await service.resume(flowId) // so another reconcile leaves that preparation alone
    gates[1]()
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'ok', attempt: 1 }))
    expect(preparations).toBe(2)
  })
  it('arms the deadline of a worker created during reconcile only once the reconcile ends', async () => {
    let created: (() => void) | undefined
    const create = deps.create
    deps.create = async input => {
      if (input.name === 'y') await new Promise<void>(r => { created = r })
      return create(input)
    }
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'y', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await service.recover() // the daemon is ready: deadlines are armed again at the end of a reconcile
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(created).toBeTypeOf('function') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    created!() // y's agent is created while x's expiry holds the reconcile
    await vi.waitFor(() => expect(liveTask('y').state).toBe('running'))
    expect(liveTask('y').deadline).toBeTypeOf('number')
    expect(internals().deadlines.has(`${flowId}/y/1`)).toBe(false)
    hold.release(); await resumed
    expect(internals().deadlines.has(`${flowId}/y/1`)).toBe(true)
    await service.finish(flowId, 'y', 1, 'done', [])
    expect(liveTask('y').state).toBe('succeeded')
  })
  it('refuses to resume a flow run that was cancelled or completed', async () => {
    await startFlow(steps({ id: 'a', run: 'true' }))
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    await expect(service.resume(flowId)).rejects.toMatchObject({ code: 'PROJECT_INACTIVE', message: 'This flow run has ended; start the flow again instead.' })
    expect(live().state).toBe('completed')
    live().state = 'cancelled' // the same rule for a cancelled run (a cancel step or a project cancel)
    expect(await orchestratorRequest(service, { action: 'resume', id: flowId })).toEqual({ error: 'PROJECT_INACTIVE', detail: 'This flow run has ended; start the flow again instead.' })
    expect(live().state).toBe('cancelled')
  })
  it('pauses the run again when a reconcile step fails, and then answers a request that waited for it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('x').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    deps.cancel = () => { throw new Error('agent unreachable') } // stopping the timed-out worker fails after the timeout was saved
    const resumed = service.resume(flowId)
    const retried = orchestratorRequest(service, { action: 'retry', id: flowId, taskId: 'x' }) // waits for the reconcile
    await expect(resumed).rejects.toThrow('agent unreachable')
    expect(await retried).toEqual({ error: 'PROJECT_INACTIVE', detail: 'Resume the project first.' })
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('agent unreachable') })
    expect(liveTask('x')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    await service.reconciled(flowId) // nothing is being reconciled any more
  })
  it('stays paused when a resume cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p' }, { id: 'b', run: 'true' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    live().state = 'paused'
    diskFull()
    await expect(service.resume(flowId)).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(live()).toMatchObject(pausedByDisk)
  })
  it('names the logs in the result of a step that failed', async () => {
    await startFlow(steps({ id: 't', run: 'echo boom >&2; exit 1' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    const result = live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!
    expect(result.text).toContain('"path":"stdout.log"')
    expect(result.text).toContain('"path":"stderr.log"')
  })
  it('pauses before anything downstream starts when the logs of a timed-out step cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1) // takes the attempt, then stops the step; its logs are kept once it is gone
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('r').state).toBe('queued')
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
  })
  it('pauses a failed launch before its release pump can start a dependent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.create = async input => {
      launches.push(input)
      // The task fails to start, and saving that failure fails once.
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
      throw new OrchestratorError('HARNESS_UNAVAILABLE', 'gone')
    }
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: p }\n  - { id: b, harness: test/cad, prompt: p, depends_on: [a], trigger_rule: all_done }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().launching.size).toBe(0)) // its release pump has run
    expect(launches).toHaveLength(1)
    expect(liveTask('b').state).toBe('queued')
  })
  it('pauses when a skip cannot be saved after a step process is gone, and skips on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('"state":"skipped"'))
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: check, run: 'true' }\n  - { id: fix, run: 'true', depends_on: [check], when: 'check.state == failed' }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(live().tasks.map(t => t.state)).toEqual(['succeeded', 'queued'])
    recover(); await service.resume(flowId)
    expect(live()).toMatchObject({ state: 'completed' })
    expect(liveTask('fix').state).toBe('skipped')
  })
  it('pauses when a block cannot be saved, and blocks on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('An upstream task did not succeed.'))
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'exit 4' }\n  - { id: after, run: 'true', depends_on: [bad] }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(live().tasks.map(t => t.state)).toEqual(['failed', 'queued'])
    recover(); await service.resume(flowId)
    expect(liveTask('after').state).toBe('blocked')
    expect(live()).toMatchObject({ state: 'active', error: 'Flow stopped: bad (failed), after (blocked). Retry a task or cancel the project.' })
  })
  it('pauses when the completion cannot be saved after the last result, and completes on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"completed"'))
    await service.finish(flowId, 'a', 1, 'done', []) // the result itself was saved: no error for its reporter
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    recover(); await service.resume(flowId)
    expect(live()).toMatchObject({ state: 'completed', error: null })
    expect(live().messages.at(-1)!.text).toBe('Flow demo completed: 1 tasks succeeded.')
  })
  it('keeps a taken result when the release pump cannot save and the pause notification fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: observer down')
  })
  it('still stops a timed-out worker when the release pump cannot save and the pause notification fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work, timeout: 1h }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const agentId = liveTask('a').agentId
    failWrites(json => json.includes('Flow stopped:'))
    deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
    await internals().expire(live(), liveTask('a'), 1)
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(cancelled).toEqual([agentId])
    expect(live()).toMatchObject(pausedByDisk)
  })
  it('keeps the run paused when the pause notification throws a value that is not an Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw undefined }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: undefined')
  })
  it('keeps the run paused when the pause notification throws a value that cannot be turned into text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw Object.create(null) }
    await expect(service.finish(flowId, 'a', 1, 'done', [])).resolves.toBeUndefined()
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: unknown error')
  })
  it('pauses a failed launch without an unhandled rejection when the pause notification throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      deps.create = async input => {
        launches.push(input)
        vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
        throw new OrchestratorError('HARNESS_UNAVAILABLE', 'gone')
      }
      deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
      await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: p }\n  - { id: b, harness: test/cad, prompt: p, depends_on: [a], trigger_rule: all_done }\n`)
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      await vi.waitFor(() => expect(internals().launching.size).toBe(0)) // its release pump has run
      expect(unhandled).not.toHaveBeenCalled()
      expect(launches).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: observer down')
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('re-evaluates skipped downstream tasks when an upstream task is retried', async () => {
    await startFlow(steps({ id: 'a', run: 'test -f "$HARNESS_PROJECT_DIR/ok"' }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done', when: 'a.state == succeeded' }))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('skipped'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    writeFileSync(join(project, 'ok'), '')
    service.retry(flowId, 'a')
    expect(onDisk().tasks.find(t => t.id === 'b')).toMatchObject({ state: 'queued', attempt: 1, summary: '' }) // in the same save as a's new attempt
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('b')).toMatchObject({ state: 'succeeded', attempt: 1 })
  })
  it('starts every new attempt from the reset table, also an automatic retry', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    mkdirSync(join(liveTask('a').cwd, '.harness'))
    writeFileSync(join(liveTask('a').cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, findings: [{ severity: 'error' }] }))
    const verdicts: unknown[] = []
    deps.changed = () => { verdicts.push(structuredClone(liveTask('a').verdict)) } // the failed attempt's verdict is saved first
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(verdicts).toContainEqual({ ready: false, errors: 1, warnings: 0 })
    expect(liveTask('a')).toMatchObject({ summary: '', error: null, artifacts: [] })
    expect(liveTask('a').verdict).toBeUndefined()
    expect(live().messages.filter(m => m.text === 'Task a attempt 1 failed; retrying (attempt 2 of 2).')).toHaveLength(1)
  })
  it('changes nothing when a manual retry cannot be saved', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }))
    await vi.waitFor(() => expect(live().error).toMatch(/^Flow stopped/))
    const before = JSON.stringify(live())
    diskFull()
    expect(() => service.retry(flowId, 'a')).toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(JSON.stringify(live())).toBe(before)
  })
  it('pauses and keeps the retry due when an automatic retry cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('retrying (attempt 2 of 2)'))
    await startFlow(steps({ id: 'a', run: '[ "$HARNESS_ATTEMPT" = 1 ] && exit 1; true', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('a')).toMatchObject({ state: 'failed', attempt: 1 })
    recover(); await service.resume(flowId)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('a').attempt).toBe(2)
    expect(live().messages.filter(m => m.text.startsWith('Task a attempt 1 failed; retrying'))).toHaveLength(1)
  })
  it('keeps a step result that arrives while the project is paused and applies it on resume', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    expect(liveTask('s').state).toBe('running')
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(live().state).toBe('completed')
  })
  it('keeps the logs of a step that failed while paused, before anything downstream starts', async () => {
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; echo boom >&2; exit 1` }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    expect(liveTask('r').summary).toBe('boom')
  })
  it('pauses with the result kept when an automatic result cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"succeeded"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(live().state).toBe('completed')
  })
  it('keeps an automatic result when the run is paused while it is being saved', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const hold = holdVerdictRead()
    g.open()
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    live().state = 'paused'
    hold.release()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('lets a result seen before the deadline win over it, and the deadline win over a later one', async () => {
    const early = gate('early'), late = gate('late')
    await startFlow(steps({ id: 'early', run: early.run, timeout: '1h' }, { id: 'late', run: late.run, timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('early').state).toBe('running'); expect(liveTask('late').state).toBe('running') })
    live().state = 'paused'
    early.open(); late.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(2))
    const seen = (id: string) => [...internals().pending.values()].find(p => p.task.id === id)!.at
    liveTask('early').deadline = seen('early') + 1 // still ahead when its result was seen
    liveTask('late').deadline = seen('late') // reached when its result was seen
    await service.resume(flowId)
    expect(liveTask('early').state).toBe('succeeded')
    expect(liveTask('late')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(liveTask('late').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']) // its process was gone: the logs go with the timeout
  })
  it('stops a step whose pid cannot be saved, owns it until it is gone, and fails it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 's')?.state === 'running')
    await startFlow(steps({ id: 's', run: 'sleep 30' }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('launching')
    await vi.waitFor(() => expect(internals().steps.size).toBe(0)) // stopped, and owned until its group was gone
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Stopped: its process id could not be saved \(ENOSPC/) })
  })
  it('fails a shell step whose result was pending when the daemon stops, and saves that', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    service.stop()
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('keeps the logs of a timed-out step on resume when saving them paused the run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'cat inputs/t/stdout.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    recover(); await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('defers a result seen during a reconcile, and lets its deadline win when it was seen after it', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: g.run, timeout: '1h' }, { id: 'b', run: 'true', depends_on: ['s'] }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the barrier
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    liveTask('s').deadline = Date.now() - 1 // s's deadline passed before its exit is seen
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // kept, not settled inside the barrier
    expect(liveTask('s').state).toBe('running')
    hold.release(); await resumed
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(liveTask('b').state).toBe('blocked')
  })
  it('stops nothing for a timeout deferred behind a reconcile until it is saved', async () => {
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('a').state).toBe('running') })
    const aAgent = liveTask('a').agentId!
    let releaseOwner!: () => void
    const owner = internals().exclusive(live(), liveTask('a'), 1, () => new Promise<void>(r => { releaseOwner = r }))
    const expiring = internals().expire(live(), liveTask('a'), 1) // waits for a's owner
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the reconcile
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    releaseOwner(); await owner; await expiring // a's expiry resumes inside the barrier: deferred, no storage failure
    expect(internals().pending.size).toBe(1)
    expect(cancelled).not.toContain(aAgent)
    hold.release(); await resumed
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(cancelled).toContain(aAgent) // only once the replayed timeout was saved
  })
  it('lets a result seen before its deadline win when the deadline passes while the reconcile still runs', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: g.run, timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the reconcile in step 4, before it reaches s
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // s's exit, kept
    const seen = [...internals().pending.values()][0].at
    liveTask('s').deadline = seen + 1 // still ahead when the exit was seen
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(seen + 1)) // and passed before step 4 reaches s
    hold.release(); await resumed
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('pauses when a failed step\'s logs cannot be copied, keeps them on resume, and starts nothing downstream before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; echo boom >&2; exit 1` }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.copyFile).mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('t').state).toBe('running')
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
  })
  it('repairs the logs of a timed-out step on resume when their rename failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('writes nothing more for a log repair once the project is cancelled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks[0].artifacts.length) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    recover()
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    let release: (() => void) | undefined
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await new Promise<void>(r => { release = r }); return realCopy(from, to) })
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function')) // the repair is copying t's logs
    service.cancel(flowId)
    release!(); await resumed
    expect(liveTask('t').artifacts).toEqual([]) // the folder the first, failed save renamed stays unreferenced
    expect(onDisk().tasks[0].artifacts).toEqual([])
    expect(readdirSync(join(live().root, 'artifacts')).filter(n => n.endsWith('.staging'))).toEqual([]) // the held copy wrote nothing that stays
  })
  it('stays paused with the result still kept when it cannot be saved on resume either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"succeeded"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await service.resume(flowId) // the resume itself is saved; applying the kept result fails again
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('stays paused when the logs of a failed step cannot be saved on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    await expect(service.resume(flowId)).rejects.toThrow(/ENOSPC/)
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('t').artifacts).toEqual([])
    expect(liveTask('r').state).toBe('queued')
    recover(); await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('fails a step that removed its own logs without keeping any', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: 'rm -f stdout.log stderr.log; exit 3' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('failed'))
    expect(liveTask('s')).toMatchObject({ error: 'exit 3', artifacts: [] })
    expect(warn).toHaveBeenCalledWith('[orchestrator] s attempt 1: logs not kept: stdout.log (missing); stderr.log (missing)')
  })
  it('fails a step whose log is not a regular file, keeping the other log and naming the one left out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: 'rm stdout.log && mkdir stdout.log; echo boom >&2; exit 1' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('failed'))
    expect(liveTask('s')).toMatchObject({ error: 'exit 1: boom' })
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task s attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log must be a regular file of at most 256 MiB.)')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[orchestrator] s attempt 1: logs not kept: stdout.log'))
    expect(live().state).toBe('active')
  })
  it('fails a step whose log changes while it is copied, keeping the other log', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); appendFileSync(String(from), 'late') })
    g.open()
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t')).toMatchObject({ error: 'exit 1' })
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log changed during handoff')
    expect(live().state).toBe('active')
  })
  it('applies a timeout whose logs cannot be kept, without them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: `rm stdout.log stderr.log && mkdir stdout.log stderr.log; ${g.run}`, timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    liveTask('s').deadline = [...internals().pending.values()][0].at // the exit was seen at the deadline: the timeout wins
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
    expect(live().messages.find(m => m.text.startsWith('Task s attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log must be a regular file')
  })
  it('leaves logs that cannot be kept out after a timeout, also on resume, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'rm stdout.log stderr.log && mkdir stdout.log stderr.log; sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    await vi.waitFor(() => expect(statSync(join(liveTask('t').cwd, 'stderr.log')).isDirectory()).toBe(true))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
    expect(live().state).toBe('active')
    live().state = 'paused'
    await service.resume(flowId) // the repair leaves them alone instead of pausing again
    expect(live().state).toBe('active')
    expect(liveTask('t').artifacts).toEqual([])
  })
  it('keeps only the logs a successful step left', async () => {
    await startFlow(steps({ id: 's', run: 'rm stdout.log; echo done >&2' }))
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
  })
  it('fails a step whose pid could not be saved even when it exits cleanly once stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => {
      if (!json.startsWith('{"version"') || (JSON.parse(json) as Run).tasks.find(t => t.id === 's')?.state !== 'running') return false
      // The failed pid save stops the step at once: hold it until the step has installed its trap, so it exits 0.
      const trapped = join(liveTask('s').cwd, 'trapped'), giveUp = Date.now() + 5000
      while (!existsSync(trapped) && Date.now() < giveUp) { /* the step runs in its own process */ }
      return true
    })
    await startFlow(steps({ id: 's', run: "trap 'exit 0' TERM; : > trapped; while :; do sleep 0.05; done" }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Stopped: its process id could not be saved \(ENOSPC/) })
  })
  it('repairs the stderr log of a timed-out step on resume when its stdout log is gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'rm stdout.log; sleep 30', timeout: '1h' }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    await vi.waitFor(() => expect(existsSync(join(liveTask('t').cwd, 'stdout.log'))).toBe(false))
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('fails a shell step on a daemon stop while its kept result is being applied', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true)) // the kept exit is being applied
    service.stop()
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
    hold.release(); await resumed
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('fails a step whose log vanishes while it is copied, keeping the other log, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); unlinkSync(String(from)) })
    g.open()
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (missing)')
    expect(live().state).toBe('active')
  })
  it('does not try again on resume to keep logs that changed during every copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementation(async (from, to) => { await realCopy(from, to); appendFileSync(String(from), 'late') })
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'failed', artifacts: [] })
    const copies = vi.mocked(filesystem.copyFile).mock.calls.length
    live().state = 'paused'
    await service.resume(flowId)
    expect(vi.mocked(filesystem.copyFile).mock.calls.length).toBe(copies) // remembered as not kept
    expect(live().state).toBe('active')
    vi.mocked(filesystem.copyFile).mockImplementation(realCopy)
  })
  it('keeps the logs a deferred step success has when it is applied, not those it had at exit', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    unlinkSync(join(liveTask('s').cwd, 'stdout.log'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().state).toBe('completed')
  })
  it('applies a deferred step success whose log became a folder, without that log', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    const log = join(liveTask('s').cwd, 'stderr.log')
    unlinkSync(log); mkdirSync(log)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stdout.log'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('logs not kept: stderr.log (stderr.log must be a regular file'))
    expect(live().state).toBe('completed')
  })
  it.skipIf(process.getuid?.() === 0)('fails a step whose log cannot be read, keeping the other log, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'chmod 000 stdout.log; exit 1' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (EACCES')
    expect(live().state).toBe('active')
  })
  it('pauses with the result kept when a log copy cannot be stored, even when its source is removed meanwhile', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => {
      unlinkSync(String(from))
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC', syscall: 'copyfile', path: String(from), dest: String(to) })
    })
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('t').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId) // the copy is tried again: its source is gone now, so that log is not kept
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'exit 1' })
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
  })
  /** Fake step processes, pid 999_999, a fresh one per spawn: the leader is gone, the group answers until `gone()`. */
  const lingeringStep = () => {
    const make = () => Object.assign(new EventEmitter(), { pid: 999_999, stdout: new PassThrough(), stderr: new PassThrough() })
    let fake = make()
    const spawned = vi.fn(() => { fake = make(); return fake as unknown as ChildProcess })
    deps.spawnStep = spawned
    let groupAlive = true
    const real = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      if (Math.abs(target) !== 999_999) return real(target, signal as never)
      if (signal === 0 && (target > 0 || !groupAlive)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true // the group still answers; signals to it are swallowed
    }) as typeof process.kill)
    return {
      spawned, gone: () => { groupAlive = false }, alive: () => { groupAlive = true },
      /** The latest process exits with code 1; the grace period and the time allowed to confirm its group pass. */
      end: async () => { fake.emit('exit', 1, null); fake.emit('close'); await vi.advanceTimersByTimeAsync(10_000) },
    }
  }
  it('blocks a step as uncertain when its leftovers could not be confirmed stopped, and keeps owning it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 3 } }, { id: 'after', run: 'true', depends_on: ['s'] }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringMatching(/could not be confirmed stopped/) }))
    expect(liveTask('s').retryAt).toBeUndefined()
    expect(internals().steps.size).toBe(1) // still signalled by cancel and stop
    await vi.waitFor(() => expect(liveTask('after').state).toBe('blocked'))
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    service.retry(flowId, 's')
    expect(internals().steps.size).toBe(0)
    expect(liveTask('s').attempt).toBe(2)
  })
  it('keeps an attempt that timed out and is due for retry from being replaced while its group may still run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await internals().expire(live(), liveTask('s'), 1) // saved: failed, retry due
    expect(liveTask('s')).toMatchObject({ state: 'failed', retryAt: expect.any(Number) })
    await step.end() // the stop could not be confirmed
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 }))
    expect(liveTask('s').retryAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(step.spawned).toHaveBeenCalledTimes(1) // never replaced
  })
  it('keeps an uncertainty that cannot be saved, and applies it on resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].uncertain === true)
    await step.end()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 })
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('keeps an uncertainty seen while the run pauses during the wait for the attempt owner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('s'), 1, () => new Promise<void>(r => { release = r }))
    await step.end()
    live().state = 'paused' // while the uncertainty waits for the owner
    release(); await owner
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true })
  })
  it('keeps an uncertainty seen after the deadline over the timeout, and starts nothing after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: 'x', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['s'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'
    liveTask('x').deadline = Date.now() - 1; liveTask('s').deadline = Date.now() - 1 // both overdue; x comes first in step 4
    const hold = holdVerdictRead() // x's expiry holds step 4 before it reaches s
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    await step.end() // s ends after its deadline, its group unconfirmed: the uncertainty is kept (the barrier is up)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    hold.release(); await resumed
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true })
    expect(liveTask('s').retryAt).toBeUndefined()
    expect(liveTask('r').state).toBe('queued') // all_done waits for an uncertain upstream
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('fences a step whose pid could not be saved and whose group could not be confirmed stopped, and refuses its retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const step = lingeringStep()
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].state === 'running')
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await step.end() // stopped by the daemon, its group unconfirmed: the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 })
    expect(liveTask('s').pid).toBeUndefined()
    step.gone()
    expect(() => service.retry(flowId, 's')).toThrow('This step may still be running (pid unknown). Stop that process, then retry.')
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('keeps the first uncertainty of an attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true }))
    const { error, revision } = { error: liveTask('s').error, revision: live().revision }
    expect(await internals().fenceUncertain(live(), liveTask('s'), 1, 'Another uncertainty.', 'check', Date.now())).toBe(false)
    expect(liveTask('s').error).toBe(error)
    expect(live().revision).toBe(revision)
  })
  it.each(['running', 'cancelled'] as const)('saves an uncertainty kept at a daemon stop, so the next daemon waits for the group (%s)', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    await step.end() // the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    if (kind === 'cancelled') service.cancel(flowId, 's')
    service.stop() // a graceful stop, saved before the next daemon reads the state
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: kind === 'running' ? 'blocked' : 'cancelled', uncertain: true, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('marks a cancelled step uncertain when its stop could not be confirmed, so a retry after a restart waits for the group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    service.cancel(flowId, 's')
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'cancelled', uncertain: true }))
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    service.stop()
    const { next, run } = await restartOn()
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('keeps a lingering step owned when its retry is refused for another reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }, { id: 'after', run: 'true', depends_on: ['s'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true }))
    liveTask('after').state = 'succeeded' // downstream work consumed this attempt
    step.gone()
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE' }))
    expect(internals().steps.size).toBe(1)
  })
  it('saves an uncertainty kept for an attempt that already failed on its last timeout, so the next daemon waits for the group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await internals().expire(live(), liveTask('s'), 1) // saved: failed, no retry left
    expect(liveTask('s')).toMatchObject({ state: 'failed', uncertain: false })
    live().state = 'paused'
    await step.end() // the stop could not be confirmed: the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    service.stop() // a graceful stop, saved before the next daemon reads the state
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, pid: 999_999, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('saves an uncertainty seen while the fence waits for the attempt owner when the daemon stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('s'), 1, () => new Promise<void>(r => { release = r }))
    await step.end()
    await vi.waitFor(() => expect([...internals().steps.values()][0].uncertain).toMatch(/could not be confirmed stopped/))
    expect(internals().pending.size).toBe(0) // the fence still waits for the owner
    service.stop()
    release(); await owner
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, pid: 999_999, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
})
