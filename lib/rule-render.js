/**
 * Rule rendering: precedence-ordered blocks plus bounded omission notes.
 *
 * Pure string work, so the payload contract — global layer first, complete text
 * inside the budget, every skipped file named — is testable without a
 * filesystem.
 */

import { positiveInt } from './config.js'
import { DEFAULT_MAX_BYTES } from './rule-files.js'

/** Paths one omission note names before it summarizes the remainder. */
const NOTE_PATH_LIMIT = 5

/**
 * Render rules for the model, global layer first, inside a byte budget.
 *
 * The budget covers the complete emitted text — header, rule blocks, and the
 * omission note — so the caller can trust the bound on what the model receives.
 * Truncation drops the widest (global) rules first, the same "drop wide, keep
 * narrow" policy the instruction chain uses.
 * @param {Array<{ path: string, body: string }>} rules - precedence-ordered rules, widest first.
 * @param {{ maxBytes?: number, omitted?: Array<{ path: string, reason: string }> }} [options] - byte budget for the complete text, plus what the reader left out.
 * @returns {string} the complete context text, or `''` when nothing fits.
 */
export function renderRules(rules, options = {}) {
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES)
  const omitted = Array.isArray(options.omitted) ? options.omitted : []
  const total = rules.length + omitted.length
  const kept = [...rules]
  const dropped = []
  let text = composeRules(kept, dropped, total, omitted, maxBytes)
  while (kept.length > 0 && Buffer.byteLength(text) > maxBytes) {
    dropped.unshift(kept.shift().path)
    text = composeRules(kept, dropped, total, omitted, maxBytes)
  }
  return kept.length === 0 || Buffer.byteLength(text) > maxBytes ? '' : text
}

/**
 * Compose the complete context text for one kept/dropped split.
 *
 * Every skipped file is named with its reason, so a bounded payload never hides
 * the fact that rules exist — but each note names at most
 * {@link NOTE_PATH_LIMIT} paths, because a note that enumerated every omitted
 * file would outgrow the rules it explains.
 */
function composeRules(kept, dropped, total, omitted, maxBytes) {
  if (kept.length === 0) return ''
  const lines = [
    `Cursor rules for this workspace (${kept.length} of ${total} rule files: user-global plus .cursor/rules).`,
    'Later blocks override earlier ones when they conflict; frontmatter is not interpreted.',
  ]
  for (const rule of kept) lines.push('', `## ${rule.path}`, rule.body)
  const overBudget = [...dropped, ...pathsOmittedFor(omitted, 'budget')]
  if (overBudget.length > 0) lines.push('', `Omitted over the ${maxBytes}-byte budget: ${summarizePaths(overBudget)}`)
  const oversized = pathsOmittedFor(omitted, 'size')
  if (oversized.length > 0) lines.push('', `Skipped over the per-file size cap: ${summarizePaths(oversized)}`)
  const unreadable = pathsOmittedFor(omitted, 'unreadable')
  if (unreadable.length > 0) lines.push('', `Unreadable rule files: ${summarizePaths(unreadable)}`)
  return lines.join('\n')
}

/** Paths of the omitted entries carrying one reason. */
function pathsOmittedFor(omitted, reason) {
  return omitted.filter(entry => entry.reason === reason).map(entry => entry.path)
}

/**
 * Name a bounded number of paths, so a note cannot outgrow the rules it explains.
 * @param {string[]} paths - paths left out of the payload.
 * @returns {string} at most {@link NOTE_PATH_LIMIT} paths plus a remainder count.
 */
function summarizePaths(paths) {
  if (paths.length <= NOTE_PATH_LIMIT) return paths.join(', ')
  return `${paths.slice(0, NOTE_PATH_LIMIT).join(', ')} (+${paths.length - NOTE_PATH_LIMIT} more)`
}
