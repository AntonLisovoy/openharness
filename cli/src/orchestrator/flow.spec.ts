// cli/src/orchestrator/flow.spec.ts
import { describe, expect, it } from 'vitest'
import { FlowError, compileFlow, inputEnvName, parseFlowSource, RUN_STEP_DEFAULT_TIMEOUT_MS } from './flow.js'

const launch = `spec: 1
name: product-launch
description: CAD part -> check
inputs:
  object: { required: true, description: What to design }
  units: { default: mm }
tasks:
  - id: part
    harness: autonomous/text-to-cad
    prompt: |
      Design $inputs.object in $inputs.units.
    outputs: { files: ["*.step", "dimensions.json"], verdict: ready }
    timeout: 45m
    retry: { max_attempts: 2 }
  - id: part-check
    run: python3 "$HARNESS_PROJECT_DIR/checks/reimport.py" inputs/part "$HARNESS_INPUT_UNITS"
    depends_on: [part]
`
const compile = (source: string, inputs: Record<string, string> = {}) => compileFlow(parseFlowSource(source, 'flow.yaml'), inputs)
const issues = (fn: () => unknown): string => {
  try { fn() } catch (error) { if (error instanceof FlowError) return error.message; throw error }
  throw new Error('expected a FlowError')
}

describe('flow compilation', () => {
  it('compiles the issue example into task specs', () => {
    const flow = compile(launch, { object: 'a desk lamp' })
    expect(flow).toMatchObject({ name: 'product-launch', inputs: { object: 'a desk lamp', units: 'mm' }, warnings: [] })
    expect(flow.tasks).toEqual([
      { id: 'part', title: 'part', harness: 'autonomous/text-to-cad', prompt: 'Design a desk lamp in mm.', dependsOn: [],
        outputs: { files: ['*.step', 'dimensions.json'], verdict: 'ready' }, timeoutMs: 2_700_000, retry: { maxAttempts: 2 } },
      { id: 'part-check', title: 'part-check', harness: 'run', prompt: expect.stringContaining('reimport.py'), dependsOn: ['part'],
        run: expect.stringContaining('$HARNESS_INPUT_UNITS'), timeoutMs: RUN_STEP_DEFAULT_TIMEOUT_MS },
    ])
    expect(inputEnvName('object_id')).toBe('HARNESS_INPUT_OBJECT_ID')
  })
  it('accepts JSON as YAML and records the source hash', () => {
    const parsed = parseFlowSource('{"spec":1,"name":"j","tasks":[{"id":"a","run":"true"}]}', 'j.json')
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(compileFlow(parsed, {}).tasks[0]).toMatchObject({ harness: 'run', run: 'true' })
  })
  it.each([
    ['an alias', 'spec: 1\nname: x\nbase: &b { id: a, run: "true" }\ntasks: [*b]\n', 'Anchors are not allowed'],
    ['a tag', 'spec: 1\nname: x\ntasks:\n  - id: a\n    run: !!str true\n', 'Tags are not allowed'],
    ['a duplicate key', 'spec: 1\nname: x\nname: y\ntasks: [{ id: a, run: "true" }]\n', 'flow.yaml:3:'],
    ['two documents', 'spec: 1\n---\nspec: 1\n', 'flow.yaml:'],
    ['an unknown key', 'spec: 1\nname: x\ntasks: [{ id: a, run: "true", when: x }]\n', 'flow.yaml:3:'],
    ['an approval step', 'spec: 1\nname: x\ntasks: [{ id: a, approval: "ok?" }]\n', 'Approval steps are not supported yet'],
    ['a wrong spec', 'spec: 2\nname: x\ntasks: [{ id: a, run: "true" }]\n', 'spec'],
    ['an empty file', '', 'expected object'],
  ])('rejects %s with a located message', (_name, source, expected) => {
    expect(issues(() => parseFlowSource(source, 'flow.yaml'))).toContain(expected)
  })
  it('rejects oversized sources before parsing', () => {
    expect(issues(() => parseFlowSource(`# ${'x'.repeat(300 * 1024)}`, 'big.yaml'))).toContain('256 KiB')
  })
  it('collects every compile error in one message', () => {
    const message = issues(() => compile(`spec: 1
name: bad
inputs:
  a: { required: true, default: x }
tasks:
  - { id: one, run: "echo $inputs.a", harness: engine:claude }
  - { id: two, harness: engine:claude }
  - { id: two, harness: run, prompt: x }
  - { id: three, run: "echo $HARNESS_INPUT_NOPE", outputs: { files: [x] } }
  - { id: four, harness: engine:claude, prompt: "use $inputs.zzz", timeout: 25h, depends_on: [ghost] }
`, { nope: '1' }))
    for (const part of ['Unknown input: nope', 'both required and have a default', 'HARNESS_INPUT_A', 'not both', 'needs harness and prompt',
      'Duplicate task id: two', 'reserved', 'Unknown input: HARNESS_INPUT_NOPE', 'outputs apply to agent tasks', 'Unknown input: $inputs.zzz', '24h']) {
      expect(message).toContain(part)
    }
    expect(message).not.toContain('1\n') // the value of an unknown input is never echoed
  })
  it('reports missing required inputs, dependency problems and limits', () => {
    expect(issues(() => compile(launch))).toContain('Missing required input: object')
    expect(issues(() => compile('spec: 1\nname: x\ntasks: [{ id: a, run: "true", depends_on: [b] }, { id: b, run: "true", depends_on: [a] }]\n'))).toContain('Dependency cycle')
    expect(issues(() => compile('spec: 1\nname: x\ntasks: [{ id: a, run: "true", depends_on: [ghost] }]\n'))).toContain('Unknown dependency: ghost')
    expect(issues(() => compile(`spec: 1\nname: x\ninputs: { big: {} }\ntasks: [{ id: a, harness: engine:claude, prompt: "$inputs.big" }]\n`, { big: 'y'.repeat(24_001) }))).toContain('tasks[0]')
  })
  it('rejects output globs that leave the task folder', () => {
    for (const glob of ['/etc/passwd', '../x', 'a/../../b', 'a\\\\b']) {
      expect(issues(() => parseFlowSource(`spec: 1\nname: x\ntasks: [{ id: a, harness: engine:claude, prompt: p, outputs: { files: ["${glob}"] } }]\n`, 'f.yaml'))).toContain('outputs')
    }
  })
  it('warns about agent tasks that can only finish explicitly, and treats optional inputs as empty', () => {
    const flow = compile('spec: 1\nname: x\ninputs: { note: {} }\ntasks: [{ id: a, harness: engine:claude, prompt: "Note: $inputs.note." }]\n')
    expect(flow.warnings).toEqual(['Task a has neither outputs nor timeout; it finishes only when its worker calls finish or fail.'])
    expect(flow.tasks[0].prompt).toBe('Note: .')
    expect(flow.inputs).toEqual({ note: '' })
  })
  it('treats inputs named like Object members as plain inputs', () => {
    const source = 'spec: 1\nname: x\ninputs: { constructor: {}, valueof: { default: v } }\ntasks: [{ id: a, harness: engine:claude, prompt: "[$inputs.constructor][$inputs.valueof]", title: Custom }]\n'
    expect(compile(source).tasks[0]).toMatchObject({ prompt: '[][v]', title: 'Custom' })
    expect(compile(source, { constructor: 'c' }).tasks[0].prompt).toBe('[c][v]')
    expect(issues(() => compile('spec: 1\nname: x\ninputs: { constructor: { required: true } }\ntasks: [{ id: a, run: "true" }]\n'))).toContain('Missing required input: constructor')
  })
  it('reports independent problems together, with lines', () => {
    const message = issues(() => compile('spec: 1\nname: x\ntasks:\n  - { id: a, run: "true", timeout: 30h, depends_on: [ghost] }\n  - { id: b, prompt: p }\n'))
    expect(message).toContain('flow.yaml:4:')
    expect(message).toContain('timeout is limited to 24h')
    expect(message).toContain('Unknown dependency: ghost')
    expect(message).toContain('needs harness and prompt')
    expect(issues(() => parseFlowSource('spec: 1\nname: x\ntasks: [{ id: a, approval: ok, when: x }]\n', 'f.yaml'))).toMatch(/Approval steps are not supported yet[\s\S]*Unknown keys: when/)
  })
})
