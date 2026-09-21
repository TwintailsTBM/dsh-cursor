/**
 * Read one session log and report what the model actually received.
 *
 * Answers the two questions Phase 2a/2b ask: did the Cursor rules reach the
 * model as runtime context, and did the skill catalog carry the Cursor skills.
 * `node verify-session.mjs [session log path]` — defaults to the newest session
 * log under `$DSH_HOME/sessions`.
 */

import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Newest session log under a sessions root, or the given path.
 *
 * The harness names a log after its format generation — `session.jsonl.zstd`
 * for the pre-versioned generations, `session.v3.jsonl.zstd` for the current
 * one — and keeps every generation on disk rather than overwriting, so
 * discovery takes the newest matching file instead of one fixed name.
 */
function resolveSession(argument) {
  if (argument !== undefined) return argument
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const found = []
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    for (const session of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('session') || !entry.name.endsWith('.jsonl.zstd')) continue
        const file = join(sessionDir, entry.name)
        try {
          found.push({ file, mtime: statSync(file).mtimeMs })
        } catch {
          // A log that vanished between listing and stat is not a candidate.
        }
      }
    }
  }
  found.sort((left, right) => right.mtime - left.mtime)
  if (found.length === 0) throw new Error(`no session logs under ${root}`)
  return found[0].file
}

/**
 * Decode every concatenated zstd frame of an append-only log.
 *
 * Node's one-shot and streaming decoders both stop at the first frame, and the
 * log appends frames rather than rewriting one. Frame boundaries come from the
 * zstd magic; a magic that occurs inside payload data only widens the window
 * until that frame decodes.
 * @param {Buffer} buffer - the whole log file.
 * @returns {{ text: string, frames: number }} decoded text and frame count.
 */
function decodeFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let at = buffer.indexOf(MAGIC); at >= 0; at = buffer.indexOf(MAGIC, at + 4)) offsets.push(at)
  if (offsets.length === 0) return { text: buffer.toString('utf8'), frames: 0 }
  const parts = []
  let cursor = 0
  let frames = 0
  while (cursor < offsets.length) {
    let decoded
    for (let end = cursor + 1; end <= offsets.length; end += 1) {
      const stop = end < offsets.length ? offsets[end] : buffer.length
      try {
        decoded = zstdDecompressSync(buffer.subarray(offsets[cursor], stop))
        cursor = end
        break
      } catch {
        // A false magic inside payload data breaks the frame: widen the window.
      }
    }
    if (decoded === undefined) break
    parts.push(decoded)
    frames += 1
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames }
}

const file = resolveSession(process.argv[2])
const { text, frames } = decodeFrames(await readFile(file))

console.log(`session  ${file}`)
console.log(`log      ${Buffer.byteLength(text)} bytes decompressed in ${frames} zstd frame(s)`)

let snapshots = 0
let catalogs = 0
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event.type !== 'user/message') continue
  const source = event.data?.source ?? {}
  const body = event.data?.content?.[0]?.text ?? ''
  if (source.plugin === '@deepseek-ai/dsh-system-prompt' && source.form === 'snapshot') {
    snapshots += 1
    const sections = source.sections ?? []
    console.log(`\nRUNTIME CONTEXT SNAPSHOT #${snapshots}: ${body.length} chars, ${sections.length} section(s)`)
    for (const section of sections) {
      const head = section.text.slice(0, 70).replaceAll('\n', ' / ')
      console.log(`  - ${section.name}: ${section.text.length} chars | ${head}...`)
    }
  }
  if (source.kind === 'agent-instructions') {
    console.log(`\nAGENT INSTRUCTIONS${source.baseline === true ? ' (baseline)' : ''}: ${body.length} chars | ${body.slice(0, 90).replaceAll('\n', ' / ')}...`)
  }
  if (source.kind === 'skill-catalog') {
    catalogs += 1
    const names = (source.entries ?? []).map(entry => entry.name)
    console.log(`\nSKILL CATALOG #${catalogs}${source.update === true ? ' (update)' : ''}: ${names.length} entries`)
    console.log(`  ${names.join(', ') || '(none)'}`)
  }
}
const pattern = process.argv[3]
if (pattern !== undefined) {
  const matches = text.split('\n').filter(line => line.includes(pattern))
  console.log(`\nGREP "${pattern}": ${matches.length} matching line(s)`)
  for (const line of matches.slice(0, 3)) console.log(`  ${line.slice(0, 240)}`)
}
if (snapshots === 0) console.log('\nRUNTIME CONTEXT SNAPSHOT: none in this session')
if (catalogs === 0) console.log('SKILL CATALOG: none in this session')
