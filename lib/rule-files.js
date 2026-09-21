/**
 * Rule discovery and reading.
 *
 * Scope is exactly two layers, in precedence order: the user-global
 * `<home>/rules`, then the workspace's `.cursor/rules`. Reading is bounded so a
 * pathological rules directory cannot make one model request expensive.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { positiveInt } from './config.js'
import { splitFrontmatter } from './frontmatter.js'

/** Default byte budget for the complete emitted rules text. */
export const DEFAULT_MAX_BYTES = 65536

/** Default per-file byte cap; a larger rule file is skipped and named in the payload. */
export const DEFAULT_MAX_SOURCE_BYTES = 262144

/**
 * Neutralize the double-brace sequences that prompt assembly interpolates.
 *
 * A context or section text is scanned for `{{variable}}` references at every
 * assembly: an unknown or malformed reference throws and fails the whole model
 * request, and a known one silently rewrites rule prose. Splitting every `{{`
 * keeps the text readable and removes both outcomes.
 * @param {string} text - raw file body.
 * @returns {string} body safe to contribute as dynamic context.
 */
export function guardBraces(text) {
  return text.includes('{{') ? text.replaceAll('{{', '{ {') : text
}

/**
 * Read the rule files that can fit in one read budget.
 *
 * Listing is cheap and complete; reading is bounded twice — per file by
 * `maxSourceBytes`, and in total by `maxReadBytes`, because files are read from
 * the narrowest (workspace) end first and reading stops once that budget is
 * spent. So the I/O cost of one model request follows the budget, not the size
 * of the rules directories. Files that were not read are returned by path, so
 * the payload names them instead of dropping them silently.
 * @param {{ projectRoot: string, home: string, includeUserRules?: boolean, maxReadBytes?: number, maxSourceBytes?: number, signal?: AbortSignal }} options - resolved workspace and configuration.
 * @returns {Promise<{ rules: Array<{ path: string, scope: string, body: string }>, omitted: Array<{ path: string, reason: 'budget' | 'size' | 'unreadable' }> }>} precedence-ordered rules plus what was left out and why.
 */
export async function collectRules(options) {
  const maxReadBytes = positiveInt(options.maxReadBytes, DEFAULT_MAX_BYTES)
  const maxSourceBytes = positiveInt(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES)
  const layers = []
  if (options.includeUserRules !== false) layers.push({ dir: join(options.home, 'rules'), scope: 'user' })
  layers.push({ dir: join(options.projectRoot, '.cursor', 'rules'), scope: options.projectRoot })

  const files = []
  const seen = new Set()
  for (const layer of layers) {
    for (const path of await listRuleFiles(layer.dir)) {
      const key = path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      files.push({ path, scope: layer.scope })
    }
  }

  const rules = []
  const omitted = []
  let spent = 0
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index]
    if (spent >= maxReadBytes) {
      omitted.unshift({ path: file.path, reason: 'budget' })
      continue
    }
    const read = await readRuleBody(file.path, maxSourceBytes, options.signal)
    if (read.reason !== undefined) {
      omitted.unshift({ path: file.path, reason: read.reason })
      continue
    }
    spent += Buffer.byteLength(read.body)
    rules.unshift({ path: file.path, scope: file.scope, body: read.body })
  }
  return { rules, omitted }
}

/** Every `.mdc` file of one rules directory, name-sorted, without reading any. */
async function listRuleFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.mdc'))
    .map(entry => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Read one rule body without frontmatter, guarded against prompt interpolation.
 * @param {string} path - absolute rule path.
 * @param {number} maxSourceBytes - per-file byte cap.
 * @param {AbortSignal | undefined} signal - request signal that cancels the read.
 * @returns {Promise<{ body: string } | { reason: 'size' | 'unreadable' }>} the body, or why it was skipped.
 */
async function readRuleBody(path, maxSourceBytes, signal) {
  let raw
  try {
    const info = await stat(path)
    if (info.size > maxSourceBytes) return { reason: 'size' }
    raw = await readFile(path, signal === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', signal })
  } catch {
    // Vanished, a directory, a broken link, or an aborted request: one file is
    // skipped and named, never the whole payload.
    return { reason: 'unreadable' }
  }
  const split = splitFrontmatter(raw)
  const body = guardBraces((split === undefined ? raw : split.body).trim())
  if (body === '') return { reason: 'unreadable' }
  return { body }
}
