import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it('keeps an unsaved timeout result pending for the director, and still stops the worker and starts what follows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start(); await active()
    service.plan(id, [task('part'), task('next', ['part'])])
    const part = await running('part'), sentBefore = sent.length
    const internal = service as unknown as { runs: Map<string, Run>; expire(run: Run, task: Task, attempt: number): Promise<void> }
    const run = internal.runs.get(id)!
    run.tasks.find(t => t.id === 'part')!.timeoutMs = 60_000 // planned tasks cannot set one: defensive, an automatic failure on a director run
    diskFull()
    try { await internal.expire(run, run.tasks.find(t => t.id === 'part')!, 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    expect(run.messages.find(m => m.text.startsWith('Task part attempt 1 failed. Timed out after 1m.'))!.delivery).toBe('pending')
    expect(sent).toHaveLength(sentBefore)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[orchestrator\] part attempt 1: ENOSPC/))
    expect(cancelled).toEqual([part.agentId])
    // The release pump could not save blocking `next`: the run is paused rather than left active with nothing to wake it.
    expect(run.tasks.find(t => t.id === 'next')!.state).toBe('queued')
    expect(run).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) })
    await service.resume(id)
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
  it('warns and leaves the step open when its result cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: disk full'), { timeout: 5000 })
    expect(state('a').state).toBe('running')
    service.cancel(flowId)
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
    runs: Map<string, Run>; deadlines: Map<string, unknown>; steps: Map<string, { handle: { done: Promise<unknown> } }>
    expire(run: Run, task: Task, attempt: number): Promise<void>
    commit(run: Run, mutate: (draft: Run) => void): void
    appendMessage(run: Run, role: 'user' | 'assistant' | 'system', text: string): Run['messages'][number]
    finishing: Map<string, unknown>; launching: Set<string>
    exclusive<T>(r: Run, t: Task, n: number, b: () => Promise<T>): Promise<T>
  }
  const live = () => internals().runs.get(flowId)! // the service's own objects: reading them never pumps
  const liveTask = (taskId: string) => live().tasks.find(t => t.id === taskId)!
  const onDisk = () => JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8')) as Run
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
  it('still retries a failed step whose failure cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: '[ "$HARNESS_ATTEMPT" = 1 ] && { sleep 0.3; exit 1; }; sleep 30', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 2 }), { timeout: 5000 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[orchestrator\] s attempt 1: ENOSPC/))
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const agentId = liveTask('a').agentId
    diskFull()
    try { await internals().expire(live(), liveTask('a'), 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    expect(cancelled).toEqual([agentId])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[orchestrator\] a attempt 1: ENOSPC/))
    // The retry could not be saved: the run pauses, and resuming starts the retry.
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) })
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
  it('still fails a step whose logs could not be kept, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'exit 2' }]\n`)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: logs not kept: disk full'), { timeout: 5000 })
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(state('a')).toMatchObject({ state: 'failed', error: 'exit 2', artifacts: [] })
  })
  it('still times out a step left running when its result could not be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: disk full'), { timeout: 5000 })
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(state('a').state).toBe('running')
    expect(internals().deadlines.size).toBe(1) // the default 10m deadline is still armed
    const run = internals().runs.get(flowId)!
    await internals().expire(run, run.tasks[0], 1)
    expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 10m.' })
    expect(internals().deadlines.size).toBe(0)
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
  it('keeps a timeout queued behind automatic finishes whose saves fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, outputs: { files: [out.txt] }, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    writeFileSync(join(a.cwd, 'out.txt'), 'x')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const inRename = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(filesystem.rename)
      .mockImplementationOnce(async () => { reached(); await gate; throw new Error('disk full') })
      .mockRejectedValueOnce(new Error('disk full again'))
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // owns the attempt
    await inRename
    const checks = vi.mocked(outputsModule.checkOutputs)
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // queues first
    await checks.mock.results.at(-1)!.value // its settle is now waiting
    const run = internals().runs.get(flowId)!
    const expiring = internals().expire(run, run.tasks[0], 1) // queues second
    release()
    await expiring
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: disk full again'))
    expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(cancelled).toEqual([a.agentId])
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
    expect((recovered as unknown as { retryDue: Set<string> }).retryDue.size).toBe(0) // never retried automatically
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
  it('stops a timed-out step even when the failure cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: s, run: 'sleep 30' }]\n`)
    await until('s', 'running')
    const exited = internals().steps.values().next().value!.handle.done
    const run = internals().runs.get(flowId)!
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try { await internals().expire(run, run.tasks[0], 1) } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[orchestrator\] s attempt 1: ENOTDIR/))
    await exited // the process was terminated, not left to outlive its deadline
    expect(state('s')).toMatchObject({ state: 'failed', error: 'Timed out after 10m.' })
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
})
