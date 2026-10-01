import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkOutputs, globToRegExp } from './outputs.js'

describe('output globs', () => {
  it.each([
    ['*.step', 'part.step', true], ['*.step', 'sub/part.step', false], ['renders/*.png', 'renders/a.png', true],
    ['**/*.png', 'a.png', true], ['**/*.png', 'a/b/c.png', true], ['out/**', 'out/x/y.mp4', true],
    ['file?.json', 'file1.json', true], ['file?.json', 'file/.json', false], ['a.b', 'axb', false], ['(x)+', '(x)+', true],
  ])('%s vs %s', (glob, path, expected) => { expect(globToRegExp(glob).test(path)).toBe(expected) })
})

describe('checkOutputs', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'outputs-')) })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (path: string, text = 'x') => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text) }

  it('passes when every glob matches and lists files once, sorted', async () => {
    write('b.step'); write('a.step'); write('dimensions.json')
    expect(await checkOutputs(cwd, { files: ['*.step', '*.step', 'dimensions.json'] })).toEqual({ ok: true, files: ['a.step', 'b.step', 'dimensions.json'] })
  })
  it('names what is missing, including the verdict', async () => {
    write('a.step')
    expect(await checkOutputs(cwd, { files: ['*.step', '*.stl'], verdict: 'ready' })).toEqual({ ok: false, missing: ['*.stl', '.harness/verdict.json with ready: true'] })
  })
  it('accepts a ready verdict and rejects a not-ready, oversized or linked one', async () => {
    write('a.step')
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: true })
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: false }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    write('.harness/verdict.json', '{ not json')
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true, pad: 'x'.repeat(1024 * 1024) }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    rmSync(join(cwd, '.harness/verdict.json')); write('elsewhere.json', JSON.stringify({ spec: 1, ready: true }))
    symlinkSync(join(cwd, 'elsewhere.json'), join(cwd, '.harness/verdict.json'))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
  })
  it('ignores upstream inputs and symlinks', async () => {
    write('inputs/part/a.step')
    const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'b.step'), 'x')
    symlinkSync(join(outside, 'b.step'), join(cwd, 'b.step')); symlinkSync(outside, join(cwd, 'linked'))
    expect(await checkOutputs(cwd, { files: ['**/*.step'] })).toEqual({ ok: false, missing: ['**/*.step'] })
    rmSync(outside, { recursive: true, force: true })
  })
  it('bounds the walk and the number of matches', async () => {
    for (let i = 0; i < 65; i++) write(`many/${i}.png`)
    expect(await checkOutputs(cwd, { files: ['many/*.png'] })).toEqual({ ok: false, missing: ['at most 64 output files (matched 65)'] })
    let deep = 'd'; for (let i = 0; i < 20; i++) deep += '/d'
    write(`${deep}/x.bin`)
    expect(await checkOutputs(cwd, { files: ['**/x.bin'] })).toMatchObject({ ok: false })
  })
  it('refuses folders too large to walk', async () => {
    for (let i = 0; i < 10_001; i++) writeFileSync(join(cwd, `f${i}`), '')
    await expect(checkOutputs(cwd, { files: ['f1'] })).rejects.toMatchObject({ code: 'OUTPUTS_TOO_LARGE' })
  })
})
