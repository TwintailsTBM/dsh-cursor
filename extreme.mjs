/**
 * Extreme-input simulation for the rules scan.
 *
 * Builds pathological Cursor rule directories and reports what ONE model
 * request would cost: bytes on disk, bytes actually read, elapsed time, the
 * emitted payload size, and how the payload names what it left out.
 * `node extreme.mjs`
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRules } from './lib/rule-files.js'
import { renderRules } from './lib/rule-render.js'

const KB = 1024
const MB = 1024 * KB

/** Run one scenario in a throwaway workspace and report its cost. */
async function scenario(name, build) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-extreme-'))
  const projectRoot = join(base, 'proj')
  const dir = join(projectRoot, '.cursor', 'rules')
  await mkdir(dir, { recursive: true })
  const diskBytes = await build(dir)
  const started = process.hrtime.bigint()
  const collected = await collectRules({ projectRoot, home: join(base, 'home'), includeUserRules: false })
  const text = renderRules(collected.rules, { maxBytes: 65536, omitted: collected.omitted })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const readBytes = collected.rules.reduce((total, rule) => total + Buffer.byteLength(rule.body), 0)
  const discovered = collected.rules.length + collected.omitted.length
  const reasons = [...new Set(collected.omitted.map(entry => entry.reason))].join(', ')
  console.log(`\n${name}`)
  console.log(`  on disk       ${(diskBytes / MB).toFixed(2)} MB in ${discovered} discovered file(s)`)
  console.log(`  read          ${(readBytes / KB).toFixed(1)} KB`)
  console.log(`  emitted       ${Buffer.byteLength(text)} bytes (budget 65536)`)
  console.log(`  elapsed       ${elapsedMs.toFixed(1)} ms`)
  console.log(`  kept/omitted  ${collected.rules.length} / ${collected.omitted.length}${reasons === '' ? '' : ` (${reasons})`}`)
  for (const line of text.split('\n').filter(row => /^(Omitted|Skipped|Unreadable)/.test(row)).slice(0, 2)) {
    console.log(`  note: ${line.slice(0, 140)}`)
  }
  await rm(base, { recursive: true, force: true })
}

await scenario('A. one 5 MB rule file (pathological single file)', async (dir) => {
  await writeFile(join(dir, 'huge.mdc'), `---\ndescription: huge\n---\n${'H'.repeat(5 * MB)}`)
  return 5 * MB
})

await scenario('B. 500 rule files of 2 KB (1 MB directory)', async (dir) => {
  for (let index = 0; index < 500; index += 1) {
    await writeFile(join(dir, `rule-${String(index).padStart(3, '0')}.mdc`), `---\ndescription: d${index}\n---\n${'R'.repeat(2000)}`)
  }
  return 500 * 2010
})

await scenario('C. realistic shape: 19 files, ~37 KB (your Engine_Mainline)', async (dir) => {
  let bytes = 0
  for (let index = 0; index < 19; index += 1) {
    const body = `---\ndescription: d${index}\n---\n${'M'.repeat(1900)}\n`
    await writeFile(join(dir, `mix-${index}.mdc`), body)
    bytes += Buffer.byteLength(body)
  }
  return bytes
})

await scenario('D. 200 tiny files with interpolation pairs and NUL bytes', async (dir) => {
  let bytes = 0
  for (let index = 0; index < 200; index += 1) {
    const body = `---\ndescription: d${index}\n---\n{{model}} {{}}{{ \u0000 ${'T'.repeat(60)}\n`
    await writeFile(join(dir, `tiny-${index}.mdc`), body)
    bytes += Buffer.byteLength(body)
  }
  return bytes
})
