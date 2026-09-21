/**
 * `dsh-cursor/skills` — Cursor skill directories as a `ctx.skills` provider.
 *
 * Delivery only: this row builds the provider from `lib/skill-files.js` and
 * wires the two events that keep its catalog fresh. Project skills live in
 * `<workspace>/.cursor/skills` and user skills in `<home>/skills`; only catalog
 * metadata reaches the model, and bodies load on demand.
 */

import { positiveInt, standardSchema, textOrEmpty } from './lib/config.js'
import { cursorHome } from './lib/paths.js'
import {
  DEFAULT_PROJECT_RANK,
  DEFAULT_USER_RANK,
  createCursorSkillsProvider,
} from './lib/skill-provider.js'

export const name = 'cursor-skills'

export const inject = ['skills']

/**
 * Coerce one row configuration into the accepted fields.
 * @param {unknown} value - raw row configuration from the patch layer.
 * @returns {{ enabled: boolean, home: string, includeUserSkills: boolean, projectRank: number, userRank: number }} resolved configuration.
 */
function resolveSkillsConfig(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    enabled: raw.enabled !== false,
    home: textOrEmpty(raw.home),
    includeUserSkills: raw.includeUserSkills !== false,
    projectRank: positiveInt(raw.projectRank, DEFAULT_PROJECT_RANK),
    userRank: positiveInt(raw.userRank, DEFAULT_USER_RANK),
  }
}

export const Config = standardSchema(resolveSkillsConfig, () => ({
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    home: { type: 'string', default: '' },
    includeUserSkills: { type: 'boolean', default: true },
    projectRank: { type: 'number', default: DEFAULT_PROJECT_RANK },
    userRank: { type: 'number', default: DEFAULT_USER_RANK },
  },
}))

/**
 * Register the Cursor skill provider and keep its catalog fresh.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveSkillsConfig(config)
  if (!resolved.enabled) return
  const provider = createCursorSkillsProvider({
    home: cursorHome(resolved),
    includeUserSkills: resolved.includeUserSkills,
    projectRank: resolved.projectRank,
    userRank: resolved.userRank,
    warn: (message) => ctx.logger.warn('cursor-skills: %s', message),
  })

  ctx.skills.registerProvider((control) => {
    provider.attach(control)
    return provider
  })

  // A step boundary is the cheapest place to notice a skill added or edited
  // outside the registry, by the user or by the agent.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      await provider.refresh(payload?.agent?.session?.header?.cwd)
    } catch (error) {
      ctx.logger.warn('cursor-skills: refresh failed: %s', String(error))
    }
    return decision
  })

  // An agent writing inside a root this workspace read changes the catalog now.
  ctx.on('fs/observed', (target) => {
    const displayPath = target?.displayPath
    if (typeof displayPath !== 'string' || !provider.observesRoot(displayPath)) return
    provider.invalidate()
  })
}
