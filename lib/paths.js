/**
 * Path resolution for the Cursor ecosystem: where the Cursor home is, and which
 * workspace a session belongs to. No harness imports; pure filesystem questions.
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Absolute Cursor home directory; a leading `~` expands to the user home.
 * @param {{ home?: string }} [config] - row configuration.
 * @returns {string} absolute path of the Cursor home.
 */
export function cursorHome(config = {}) {
  const configured = typeof config.home === 'string' ? config.home.trim() : ''
  if (configured === '') return join(homedir(), '.cursor')
  return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : resolve(configured)
}

/** Whether a path exists and is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether two paths denote the same directory.
 *
 * Compares the filesystem identity rather than the text, because one directory
 * can be spelled several ways (a Windows short path, a different case, a
 * junction).
 * @param {string} left - first path.
 * @param {string} right - second path.
 * @returns {Promise<boolean>} whether both resolve to one directory.
 */
export async function sameDirectory(left, right) {
  try {
    const [first, second] = [await stat(left), await stat(right)]
    if (first.ino !== 0 && second.ino !== 0) return first.dev === second.dev && first.ino === second.ino
  } catch {
    return false
  }
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

/**
 * The one workspace a session resolves to.
 *
 * The nearest ancestor holding `.cursor` wins, so a workspace opened from a
 * subdirectory still resolves to that workspace, while a project nested inside
 * another one resolves to itself. A configured marker (`.git`) also ends the
 * walk, matching the harness instruction chain. A Cursor home is a layer, never
 * a workspace: reaching the configured home or the default `~/.cursor` ends the
 * search.
 * @param {string} cwd - session workspace directory.
 * @param {{ markers?: string[], home?: string }} [options] - marker names and the Cursor home to exclude.
 * @returns {Promise<string>} the workspace directory, or `cwd` when nothing above it qualifies.
 */
export async function findProjectRoot(cwd, options = {}) {
  const markers = options.markers ?? ['.git']
  const homes = [join(homedir(), '.cursor')]
  if (options.home !== undefined) homes.push(resolve(options.home))
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    const cursorDir = join(dir, '.cursor')
    if (await isDirectory(cursorDir)) {
      for (const home of homes) {
        if (await sameDirectory(cursorDir, home)) return start
      }
      return dir
    }
    for (const marker of markers) {
      if (await isDirectory(join(dir, marker))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
