// cli/src/orchestrator/flow.ts
import { createHash } from 'node:crypto'
import { LineCounter, isAlias, isCollection, isPair, isScalar, parseDocument, visit, type Document } from 'yaml'
import { z } from 'zod'
import { OrchestratorError, TaskId, TaskSpec, validatePlan } from './model.js'

export const FLOW_SOURCE_LIMIT = 256 * 1024
export const RUN_STEP_DEFAULT_TIMEOUT_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const
// Relative, no `..` segment, no backslash or NUL: an output never names a file outside the task folder.
const Glob = z.string().min(1).max(256).regex(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[^\\\0]+$/, 'outputs must be relative paths inside the task folder')

const FlowInput = z.strictObject({
  required: z.boolean().optional(),
  default: z.string().max(32_768).optional(),
  description: z.string().max(500).optional(),
})
const FlowTask = z.strictObject({
  id: TaskId,
  title: z.string().trim().min(1).max(100).optional(),
  harness: z.string().min(1).max(129).optional(),
  prompt: z.string().trim().min(1).max(24_000).optional(),
  run: z.string().trim().min(1).max(24_000).optional(),
  outputs: z.strictObject({ files: z.array(Glob).min(1).max(16), verdict: z.literal('ready').optional() }).optional(),
  timeout: z.string().regex(/^[1-9][0-9]{0,5}[smh]$/, 'timeout looks like 90s, 45m or 2h').optional(),
  retry: z.strictObject({ max_attempts: z.number().int().min(1).max(5) }).optional(),
  depends_on: z.array(TaskId).max(32).optional(),
})
export const FlowFile = z.strictObject({
  spec: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  description: z.string().max(2000).optional(),
  engine: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), FlowInput).optional(),
  tasks: z.array(FlowTask).min(1).max(64),
})
export type FlowFile = z.infer<typeof FlowFile>
export interface FlowIssue { path: string; message: string; line?: number; col?: number }
export interface ParsedFlow {
  flow: FlowFile; sha256: string; file: string
  /** Source position of a path in the file, so compile errors point at the line too. */
  at(path: readonly PropertyKey[]): { line?: number; col?: number }
}
export interface CompiledFlow { name: string; description?: string; engine?: string; inputs: Record<string, string>; tasks: TaskSpec[]; warnings: string[] }

export class FlowError extends OrchestratorError {
  constructor(readonly file: string, readonly issues: FlowIssue[]) {
    super('INVALID_FLOW', issues.map(i => `${file}${i.line ? `:${i.line}:${i.col}` : ''}: ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n'))
  }
}
export const inputEnvName = (name: string): string => `HARNESS_INPUT_${name.toUpperCase()}`
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const pathText = (path: readonly PropertyKey[]): string => path.map((p, i) => typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`).join('')

/** Parse YAML 1.2 (JSON included) as plain data: one document, no anchors, aliases or tags. */
export function parseFlowSource(source: string, file: string): ParsedFlow {
  if (Buffer.byteLength(source, 'utf8') > FLOW_SOURCE_LIMIT) throw new FlowError(file, [{ path: '', message: 'A flow file is limited to 256 KiB.' }])
  const lines = new LineCounter()
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: true, uniqueKeys: true, merge: false, schema: 'core', version: '1.2' })
  const issues: FlowIssue[] = doc.errors.map(e => ({ path: '', message: e.message.split('\n')[0], ...e.linePos?.[0] }))
  visit(doc, (_key, node) => {
    const at = (offset = 0): { line: number; col: number } => lines.linePos(offset)
    // toJS() would stringify (and warn with) a collection key's content, which may be a secret.
    if (isPair(node) && !isScalar(node.key)) issues.push({ path: '', message: 'Keys must be plain names.', ...at((node.key as { range?: [number, number, number] } | null)?.range?.[0]) })
    else if (isAlias(node)) issues.push({ path: '', message: 'Aliases are not allowed in a flow.', ...at(node.range?.[0]) })
    else if (isScalar(node) || isCollection(node)) {
      if (node.anchor) issues.push({ path: '', message: 'Anchors are not allowed in a flow.', ...at(node.range?.[0]) })
      if (node.tag) issues.push({ path: '', message: 'Tags are not allowed in a flow.', ...at(node.range?.[0]) })
    }
  })
  if (issues.length) throw new FlowError(file, issues)
  const raw = doc.toJS() as unknown
  const tasks = (raw as { tasks?: unknown })?.tasks
  if (Array.isArray(tasks)) tasks.forEach((task, i) => {
    if (task && typeof task === 'object' && 'approval' in task) issues.push({ path: `tasks[${i}].approval`, message: 'Approval steps are not supported yet.', ...locate(doc, lines, ['tasks', i, 'approval']) })
  })
  const parsed = FlowFile.safeParse(raw)
  if (!parsed.success) for (const issue of parsed.error.issues) {
    // `approval` already has its own message; other unknown keys next to it are still reported.
    if (issue.code === 'unrecognized_keys') {
      const isTask = issue.path.length === 2 && issue.path[0] === 'tasks'
      const keys = isTask ? issue.keys.filter(key => key !== 'approval') : issue.keys
      if (keys.length) issues.push({ path: pathText(issue.path), message: `Unknown keys: ${keys.join(', ')}`, ...locate(doc, lines, [...issue.path, keys[0]]) })
    } else issues.push({ path: pathText(issue.path), message: issue.message, ...locate(doc, lines, issue.path) })
  }
  if (issues.length || !parsed.success) throw new FlowError(file, issues)
  return { flow: parsed.data, sha256: sha256(source), file, at: path => locate(doc, lines, path) }
}
function locate(doc: Document, lines: LineCounter, path: readonly PropertyKey[]): { line?: number; col?: number } {
  for (let n = path.length; n >= 0; n--) {
    const node = (n ? doc.getIn(path.slice(0, n) as unknown[], true) : doc.contents) as { range?: [number, number, number] } | null | undefined
    if (node?.range) return lines.linePos(node.range[0])
  }
  return {}
}

const references = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map(m => m[1])

/** Compile a parsed flow into the orchestrator's task specs. Every problem is reported at once. */
export function compileFlow(parsed: ParsedFlow, given: Record<string, string>): CompiledFlow {
  const { flow, file } = parsed
  const issues: FlowIssue[] = [], warnings: string[] = []
  const declared = flow.inputs ?? {}
  // Name only: a value is often a secret.
  for (const name of Object.keys(given)) if (!Object.hasOwn(declared, name)) issues.push({ path: 'inputs', message: `Unknown input: ${name}`, ...parsed.at(['inputs']) })
  // Own properties only: an input may be called `constructor`.
  const inputs: Record<string, string> = Object.create(null)
  for (const [name, input] of Object.entries(declared)) {
    const at = parsed.at(['inputs', name])
    if (input.required && input.default !== undefined) issues.push({ path: `inputs.${name}`, message: 'An input cannot be both required and have a default.', ...at })
    const value = Object.hasOwn(given, name) ? given[name] : input.default
    if (value === undefined && input.required) issues.push({ path: `inputs.${name}`, message: `Missing required input: ${name}`, ...at })
    else inputs[name] = value ?? ''
  }
  const ids = new Set<string>()
  const tasks: TaskSpec[] = []
  flow.tasks.forEach((t, index) => {
    const fail = (message: string): void => { issues.push({ path: `tasks[${index}] (${t.id})`, message, ...parsed.at(['tasks', index]) }) }
    if (ids.has(t.id)) fail(`Duplicate task id: ${t.id}`)
    ids.add(t.id)
    const timeoutMs = t.timeout ? Number(t.timeout.slice(0, -1)) * UNIT_MS[t.timeout.at(-1) as keyof typeof UNIT_MS] : undefined
    if (timeoutMs !== undefined && timeoutMs > DAY_MS) fail('timeout is limited to 24h.')
    const common = { id: t.id, title: t.title ?? t.id, dependsOn: t.depends_on ?? [], ...(t.retry ? { retry: { maxAttempts: t.retry.max_attempts } } : {}) }
    if (t.run !== undefined) {
      if (t.harness !== undefined || t.prompt !== undefined) fail('A task has either run or harness + prompt, not both.')
      if (t.outputs) fail('outputs apply to agent tasks; a run step succeeds by its exit code.')
      for (const name of references(t.run, /\$inputs\.([A-Za-z0-9_]+)/g)) fail(`Use "$${inputEnvName(name)}" in run steps; $inputs.${name} is not substituted into shell commands.`)
      for (const name of references(t.run, /\$\{?HARNESS_INPUT_([A-Z0-9_]+)/g)) if (!Object.hasOwn(declared, name.toLowerCase())) fail(`Unknown input: HARNESS_INPUT_${name}`)
      tasks.push({ ...common, harness: 'run', prompt: t.run, run: t.run, timeoutMs: timeoutMs ?? RUN_STEP_DEFAULT_TIMEOUT_MS })
      return
    }
    if (t.harness === undefined || t.prompt === undefined) fail('An agent task needs harness and prompt; a shell step needs run.')
    if (t.harness === 'run') fail('"run" is reserved for shell steps; write run: <command> instead.')
    for (const name of references(t.prompt ?? '', /\$inputs\.([a-z][a-z0-9_]*)/g)) if (!Object.hasOwn(declared, name)) fail(`Unknown input: $inputs.${name}`)
    if (!t.outputs && timeoutMs === undefined) warnings.push(`Task ${t.id} has neither outputs nor timeout; it finishes only when its worker calls finish or fail.`)
    const prompt = (t.prompt ?? '').replace(/\$inputs\.([a-z][a-z0-9_]*)/g, (match, name: string) => Object.hasOwn(inputs, name) ? inputs[name] : match)
    tasks.push({ ...common, harness: t.harness ?? '', prompt, ...(t.outputs ? { outputs: t.outputs } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  })
  const specs: TaskSpec[] = []
  tasks.forEach((task, index) => {
    const result = TaskSpec.safeParse(task)
    if (result.success) specs.push(result.data)
    else for (const issue of result.error.issues) issues.push({ path: `tasks[${index}] (${task.id}).${pathText(issue.path)}`, message: issue.message, ...parsed.at(['tasks', index]) })
  })
  // Graph problems are independent of field problems: report every unknown dependency, then cycles.
  const unknown = flow.tasks.flatMap((t, index) => (t.depends_on ?? []).filter(dep => !ids.has(dep)).map(dep => ({ path: `tasks[${index}] (${t.id}).depends_on`, message: `Unknown dependency: ${dep}`, ...parsed.at(['tasks', index, 'depends_on']) })))
  issues.push(...unknown)
  if (!unknown.length && specs.length === tasks.length) {
    try { validatePlan([], specs) } catch (error) {
      // validatePlan only throws OrchestratorError (cycle / unknown dependency).
      issues.push({ path: 'tasks', message: (error as OrchestratorError).message, ...parsed.at(['tasks']) })
    }
  }
  if (issues.length) throw new FlowError(file, issues)
  return { name: flow.name, description: flow.description, engine: flow.engine, inputs, tasks: specs, warnings }
}
