/**
 * `dsh-cursor/rules` — Cursor `.cursor/rules/*.mdc` files as dynamic model context.
 *
 * Delivery only: this row turns configuration into one contribution on the
 * assembly waterfall and leaves discovery, reading, and rendering to
 * `lib/rule-files.js`. The harness appends the contribution to the
 * runtime-context snapshot and materializes the joined snapshot as a durable
 * user-role message, re-emitting it only when the text changes — so the scan
 * runs per assembly and needs no cache or invalidation of its own.
 */

import { positiveInt, standardSchema, textOrEmpty } from './lib/config.js'
import { cursorHome, findProjectRoot } from './lib/paths.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_SOURCE_BYTES, collectRules } from './lib/rule-files.js'
import { renderRules } from './lib/rule-render.js'

export const name = 'cursor-rules'

/** Uses only `ctx.on` and `ctx.logger`, so no service injection is required. */
export const inject = []

/**
 * Coerce one row configuration into the accepted fields.
 * @param {unknown} value - raw row configuration from the patch layer.
 * @returns {{ enabled: boolean, home: string, maxBytes: number, maxSourceBytes: number, includeUserRules: boolean }} resolved configuration.
 */
function resolveRulesConfig(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    enabled: raw.enabled !== false,
    home: textOrEmpty(raw.home),
    maxBytes: positiveInt(raw.maxBytes, DEFAULT_MAX_BYTES),
    maxSourceBytes: positiveInt(raw.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES),
    includeUserRules: raw.includeUserRules !== false,
  }
}

export const Config = standardSchema(resolveRulesConfig, () => ({
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    home: { type: 'string', default: '' },
    maxBytes: { type: 'number', default: DEFAULT_MAX_BYTES },
    maxSourceBytes: { type: 'number', default: DEFAULT_MAX_SOURCE_BYTES },
    includeUserRules: { type: 'boolean', default: true },
  },
}))

/**
 * Contribute the workspace's Cursor rules to every agent assembly.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveRulesConfig(config)
  if (!resolved.enabled) return
  const home = cursorHome(resolved)

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    // Only an agent assembly has a workspace; a scopeless read (presenter
    // resolution, diagnostics) contributes nothing.
    const cwd = context?.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return result
    let text = ''
    try {
      const collected = await collectRules({
        projectRoot: await findProjectRoot(cwd, { home }),
        home,
        includeUserRules: resolved.includeUserRules,
        maxReadBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      text = renderRules(collected.rules, { maxBytes: resolved.maxBytes, omitted: collected.omitted })
    } catch (error) {
      // An unreadable rules tree must not fail the model request.
      ctx.logger.warn('cursor-rules: scan failed: %s', String(error))
      return result
    }
    if (text === '') return result
    return { ...result, contexts: [...result.contexts, { name: 'cursor:rules', text }] }
  })
}
