/**
 * The `ctx.skills` provider for Cursor skill roots.
 *
 * This is the one stateful piece of the skills half: it owns the registry
 * control handle, the last observed change signature, and the roots a workspace
 * actually read. Discovery and parsing stay in `skill-files.js`.
 */

import { join } from 'node:path'
import { positiveInt } from './config.js'
import { findProjectRoot } from './paths.js'
import { collectSkills, readSkill, skillRootSignature } from './skill-files.js'

/**
 * Registry-unique provider name.
 *
 * The skill registry rejects a duplicate provider name and fails the whole
 * plugin tree at boot, so this must not collide with another Cursor provider —
 * including an in-source one that called itself `cursor`.
 */
export const PROVIDER_NAME = 'dsh-cursor'

/** Duplicate skill names resolve by rank, lower first: project `.dsh` 100, project `.agents` 200, this provider 250/350, custom 300, user `.dsh` 400, user `.agents` 500. */
export const DEFAULT_PROJECT_RANK = 250
export const DEFAULT_USER_RANK = 350

/**
 * Build the provider that serves one workspace's Cursor skills.
 * @param {{ home: string, includeUserSkills?: boolean, projectRank?: number, userRank?: number, warn?: (message: string) => void }} options - resolved configuration and a diagnostic sink.
 * @returns {object} the provider to return from `ctx.skills.registerProvider`, with the row-facing `attach`, `refresh`, `observesRoot`, and `invalidate` methods.
 */
export function createCursorSkillsProvider(options) {
  const home = options.home
  const includeUserSkills = options.includeUserSkills !== false
  const projectRank = positiveInt(options.projectRank, DEFAULT_PROJECT_RANK)
  const userRank = positiveInt(options.userRank, DEFAULT_USER_RANK)
  const warn = options.warn ?? (() => {})

  let control
  let signature
  const observedRoots = new Set()

  /**
   * Roots for one workspace, in precedence order. Pure: the observer set is
   * written by `refresh`, never by a read.
   */
  const rootsFor = async (cwd) => {
    const roots = []
    if (typeof cwd === 'string' && cwd !== '') {
      roots.push({
        dir: join(await findProjectRoot(cwd, { home }), '.cursor', 'skills'),
        source: 'cursor-project',
        rank: projectRank,
      })
    }
    if (includeUserSkills) roots.push({ dir: join(home, 'skills'), source: 'cursor-user', rank: userRank })
    return roots
  }

  return {
    name: PROVIDER_NAME,

    /** Catalog candidates for one workspace; a broken root reports and yields none. */
    async list(lookup) {
      try {
        const candidates = []
        for (const root of await rootsFor(lookup?.cwd)) {
          candidates.push(...await collectSkills(
            root.dir,
            { provider: PROVIDER_NAME, source: root.source, rank: root.rank },
            { onSkip: (path, reason) => warn(`ignored ${path}: ${reason}`) },
          ))
        }
        return candidates
      } catch (error) {
        warn(`discovery failed: ${String(error)}`)
        return []
      }
    },

    /** Load one candidate's body; a skill that vanished reports `undefined`. */
    async get(candidate) {
      const parsed = await readSkill(candidate.locator.path)
      if (parsed === undefined) return undefined
      return {
        ...parsed,
        provider: PROVIDER_NAME,
        source: candidate.source,
        resourceBase: candidate.resourceBase,
        path: candidate.path,
      }
    },

    /** Borrow the registration-scoped control handle from `registerProvider`. */
    attach(providerControl) {
      control = providerControl
    },

    /** Record the observed roots and invalidate a warm catalog when they changed. */
    async refresh(cwd) {
      const roots = await rootsFor(cwd)
      for (const root of roots) observedRoots.add(`${root.dir.toLowerCase()}\\`)
      const next = await skillRootSignature(roots.map(root => root.dir))
      if (signature === undefined) {
        signature = next
        return
      }
      if (signature === next) return
      signature = next
      control?.invalidate()
    },

    /** Whether a changed path lies inside a root this workspace actually read. */
    observesRoot(path) {
      const normalized = path.toLowerCase()
      return [...observedRoots].some(root => normalized.startsWith(root))
    },

    /** Forget the cached signature and invalidate the catalog now. */
    invalidate() {
      signature = undefined
      control?.invalidate()
    },
  }
}
