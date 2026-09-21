/**
 * Maintainer smoke test against the real Cursor directories.
 *
 * Reports what one session in a given workspace would inject: the rule files
 * and their byte cost, and the skill candidates with their model visibility.
 * `node smoke.mjs [workspace]`
 */

import { cursorHome, findProjectRoot } from './lib/paths.js'
import { collectRules } from './lib/rule-files.js'
import { renderRules } from './lib/rule-render.js'
import { collectSkills } from './lib/skill-files.js'

const cwd = process.argv[2] ?? process.cwd()
const home = cursorHome({})
const projectRoot = await findProjectRoot(cwd, { home })

console.log(`workspace      ${cwd}`)
console.log(`project root   ${projectRoot}`)
console.log(`cursor home    ${home}`)

const collected = await collectRules({ projectRoot, home })
const payload = renderRules(collected.rules, { maxBytes: 65536, omitted: collected.omitted })
const bytes = Buffer.byteLength(payload)
const omitted = collected.omitted.length === 0 ? '' : `, ${collected.omitted.length} omitted`
console.log(`\nrules          ${collected.rules.length} files${omitted}, payload ${bytes} bytes (approx ${Math.round(bytes / 4)} tokens)`)
const byScope = new Map()
for (const rule of collected.rules) byScope.set(rule.scope, (byScope.get(rule.scope) ?? 0) + 1)
for (const [scope, count] of byScope) console.log(`  ${count.toString().padStart(3)}  ${scope}`)

const projectSkills = await collectSkills(`${projectRoot}/.cursor/skills`, {
  provider: 'cursor',
  source: 'cursor-project',
  rank: 250,
})
const userSkills = await collectSkills(`${home}/skills`, {
  provider: 'cursor',
  source: 'cursor-user',
  rank: 350,
})
const catalog = [...projectSkills, ...userSkills]
const modelVisible = catalog.filter(skill => skill.invocation.modelInvocable)
const catalogBytes = modelVisible.reduce((total, skill) => total + Buffer.byteLength(skill.name) + Buffer.byteLength(skill.description) + 8, 0)
console.log(`\nskills         ${catalog.length} candidates (${modelVisible.length} model-visible), catalog approx ${catalogBytes} bytes`)
for (const skill of catalog) {
  console.log(`  ${skill.invocation.modelInvocable ? 'model' : 'user '}  ${skill.rank}  ${skill.name}`)
}
