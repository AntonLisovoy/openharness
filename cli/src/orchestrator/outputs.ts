import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readVerdictFile } from '../dsh/verdict.js'
import { OrchestratorError, type Outputs } from './model.js'

export type OutputsCheck = { ok: true; files: string[] } | { ok: false; missing: string[] }
const MAX_DEPTH = 16, MAX_ENTRIES = 10_000, MAX_MATCHES = 64, MAX_VERDICT_BYTES = 1024 * 1024

/** `*` and `?` stay inside one folder; `**` crosses folders. Everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) { source += '(?:[^/]+/)*'; i += 2 }
    else if (pattern.startsWith('**', i)) { source += '.*'; i += 1 }
    else if (pattern[i] === '*') source += '[^/]*'
    else if (pattern[i] === '?') source += '[^/]'
    else source += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// Regular files only: symlinks are skipped (they could point outside the task), and so is
// inputs/, the read-only copies of upstream results.
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let seen = 0
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++seen > MAX_ENTRIES) throw new OrchestratorError('OUTPUTS_TOO_LARGE', `The task folder has more than ${MAX_ENTRIES} entries to search.`)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isFile()) files.push(path)
      else if (entry.isDirectory() && depth < MAX_DEPTH && !(depth === 0 && entry.name === 'inputs')) await walk(join(dir, entry.name), path, depth + 1)
    }
  }
  await walk(root, '', 0)
  return files
}
async function verdictReady(cwd: string): Promise<boolean> {
  const file = join(cwd, '.harness', 'verdict.json')
  const info = await lstat(file).catch(() => null)
  return !!info?.isFile() && info.size <= MAX_VERDICT_BYTES && readVerdictFile(file)?.ready === true
}

export async function checkOutputs(cwd: string, outputs: Outputs): Promise<OutputsCheck> {
  const files = await listFiles(cwd)
  const matched = new Set<string>(), missing: string[] = []
  for (const pattern of outputs.files) {
    const expression = globToRegExp(pattern)
    const hits = files.filter(file => expression.test(file))
    if (!hits.length) missing.push(pattern)
    for (const hit of hits) matched.add(hit)
  }
  if (outputs.verdict === 'ready' && !await verdictReady(cwd)) missing.push('.harness/verdict.json with ready: true')
  if (missing.length) return { ok: false, missing }
  if (matched.size > MAX_MATCHES) return { ok: false, missing: [`at most ${MAX_MATCHES} output files (matched ${matched.size})`] }
  return { ok: true, files: [...matched].sort() }
}
