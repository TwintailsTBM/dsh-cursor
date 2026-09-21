/**
 * Skill discovery and parsing.
 *
 * Pure filesystem work: which entry points exist under one Cursor skill root,
 * what a skill file means, and a cheap change signature for a warm catalog. The
 * stateful registry adapter lives in `skill-provider.js`.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatterData, splitFrontmatter } from './frontmatter.js'

/**
 * Skill name grammar, copied from the harness registry
 * (`packages/skill/skill/src/index.ts` `SKILL_NAME`).
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Candidate entry points under one skill root, name-sorted.
 *
 * Layout matches the Cursor IDE and the harness: `<name>/SKILL.md`, or a bare
 * `<name>.md` directly inside the root. This is the single place that knows that
 * layout: discovery and the change signature both read it.
 * @param {string} rootDir - absolute skill root.
 * @returns {Promise<Array<{ name: string, path: string, base: string }> | undefined>} entry points, or `undefined` when the root is unreadable.
 */
export async function listSkillEntries(rootDir) {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const found = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push({ name: entry.name, path: join(rootDir, entry.name, 'SKILL.md'), base: join(rootDir, entry.name) })
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      found.push({ name: entry.name, path: join(rootDir, entry.name), base: rootDir })
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Read and validate one skill file.
 *
 * The registry requires a kebab-case name and a non-empty description, so a file
 * missing either is not a skill and reports `undefined` without failing
 * discovery.
 * @param {string} path - absolute `SKILL.md` path.
 * @returns {Promise<object | undefined>} parsed skill fields, or `undefined`.
 */
export async function readSkill(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  const data = parseFrontmatterData(split.yaml)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim().replace(/\s+/g, ' ') : ''
  if (name === '' || description === '' || !SKILL_NAME.test(name)) return undefined
  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : ''
  return {
    name,
    description,
    ...(whenToUse === '' ? {} : { whenToUse }),
    // `disable-model-invocation` is Cursor's own frontmatter key: such a skill
    // stays user-invocable but leaves the model-facing catalog.
    invocation: { modelInvocable: !disablesModelInvocation(data['disable-model-invocation']), userInvocable: true },
    content: split.body.trim(),
  }
}

/** Whether a frontmatter value disables model invocation. */
function disablesModelInvocation(value) {
  if (value === true) return true
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === 'on'
  }
  return false
}

/**
 * Collect skill candidates from one Cursor skill root.
 * @param {string} rootDir - absolute skill root.
 * @param {{ provider: string, source: string, rank: number }} identity - registry identity for these candidates.
 * @param {{ onSkip?: (path: string, reason: string) => void }} [options] - observer for files that are present but unusable.
 * @returns {Promise<object[]>} candidates ready for `ctx.skills`.
 */
export async function collectSkills(rootDir, identity, options = {}) {
  const entries = await listSkillEntries(rootDir)
  if (entries === undefined) return []
  const candidates = []
  for (const entry of entries) {
    const parsed = await readSkill(entry.path)
    if (parsed === undefined) {
      // Present but not a skill: report it rather than dropping it silently.
      options.onSkip?.(entry.path, 'missing or invalid frontmatter (needs a kebab-case name and a description)')
      continue
    }
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      source: identity.source,
      provider: identity.provider,
      rank: identity.rank,
      locator: { path: entry.path, directory: entry.base },
      resourceBase: { kind: 'directory', path: entry.base },
      path: entry.path,
    })
  }
  return candidates
}

/**
 * Cheap change signature of the skill roots, used to refresh a warm catalog.
 * @param {string[]} rootDirs - absolute skill roots to observe.
 * @returns {Promise<string>} a signature that changes when a skill file does.
 */
export async function skillRootSignature(rootDirs) {
  const parts = []
  for (const rootDir of rootDirs) {
    const entries = await listSkillEntries(rootDir)
    if (entries === undefined) {
      parts.push(`${rootDir}:absent`)
      continue
    }
    for (const entry of entries) {
      try {
        const info = await stat(entry.path)
        parts.push(`${entry.path}:${info.size}:${info.mtimeMs}`)
      } catch {
        parts.push(`${entry.path}:gone`)
      }
    }
  }
  return parts.join('|')
}
