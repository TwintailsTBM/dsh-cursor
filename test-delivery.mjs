/**
 * Delivery-layer tests: what each row registers on a context and what it hands
 * back. These drive the real `apply()` functions with a stub context, so wiring
 * mistakes (event names, argument order, return values) fail here rather than
 * silently in a session.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply as applyRules } from './rules.js'
import { apply as applySkills } from './skills.js'

/** One stub context recording listeners, the registered provider, and warnings. */
function stubContext() {
  const listeners = new Map()
  const warnings = []
  let provider
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    skills: { registerProvider: (create) => { provider = create({ invalidate: () => { ctx.invalidations += 1 } }) } },
    invalidations: 0,
  }
  return { ctx, listeners, warnings, provider: () => provider }
}

/** An empty assembly, as `assemble()` would produce before any contribution. */
function emptyAssembly() {
  return { sections: [], contexts: [], tools: [], variables: {} }
}

/** An agent-scoped assembly context for one workspace. */
function agentContext(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('the rules row appends one context for an agent assembly and nothing for a scopeless read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-rules-row-'))
  const home = join(base, 'cursorhome')
  const project = join(base, 'proj')
  await mkdir(join(project, '.cursor', 'rules'), { recursive: true })
  await writeFile(
    join(project, '.cursor', 'rules', 'sentinel.mdc'),
    '---\ndescription: d\nalwaysApply: true\n---\nSENTINEL-CURSOR-RULE-BODY\n',
  )

  const { ctx, listeners, warnings } = stubContext()
  applyRules(ctx, { home })
  const assemble = listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')

  const assembled = await assemble(emptyAssembly(), agentContext(project), async () => emptyAssembly())
  assert.equal(assembled.contexts.length, 1)
  assert.equal(assembled.contexts[0].name, 'cursor:rules')
  assert.ok(assembled.contexts[0].text.includes('SENTINEL-CURSOR-RULE-BODY'))
  assert.ok(!assembled.contexts[0].text.includes('alwaysApply'))
  assert.deepEqual(assembled.sections, [])

  // A scopeless assembly has no workspace and must stay untouched.
  const scopeless = await assemble(emptyAssembly(), {}, async () => emptyAssembly())
  assert.equal(scopeless.contexts.length, 0)

  // A workspace without rules contributes nothing at all.
  const bare = join(base, 'bare')
  await mkdir(bare, { recursive: true })
  const untouched = await assemble(emptyAssembly(), agentContext(bare), async () => emptyAssembly())
  assert.equal(untouched.contexts.length, 0)
  assert.deepEqual(warnings, [])
})

test('the skills row serves project skills and invalidates when the root changes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-skills-row-'))
  const home = join(base, 'cursorhome')
  const project = join(base, 'proj')
  const skillsRoot = join(project, '.cursor', 'skills')
  await mkdir(join(skillsRoot, 'sentinel-skill'), { recursive: true })
  await writeFile(join(skillsRoot, 'sentinel-skill', 'SKILL.md'), [
    '---',
    'name: sentinel-skill',
    'description: >-',
    '  A sentinel skill used by the delivery test.',
    '---',
    '',
    'SENTINEL-SKILL-BODY',
  ].join('\n'))

  const { ctx, listeners, provider } = stubContext()
  applySkills(ctx, { home, includeUserSkills: false })
  const cursorProvider = provider()
  // Registry-unique: a duplicate provider name fails the whole plugin tree.
  assert.equal(cursorProvider.name, 'dsh-cursor')

  const candidates = await cursorProvider.list({ cwd: project })
  assert.deepEqual(candidates.map(candidate => candidate.name), ['sentinel-skill'])
  assert.equal(candidates[0].provider, 'dsh-cursor')
  assert.equal(candidates[0].source, 'cursor-project')
  assert.ok(candidates[0].path.endsWith(join('sentinel-skill', 'SKILL.md')))

  const definition = await cursorProvider.get(candidates[0], {})
  assert.ok(definition.content.includes('SENTINEL-SKILL-BODY'))
  // A skill that vanished between list and get reports no definition.
  assert.equal(await cursorProvider.get({ locator: { path: join(skillsRoot, 'gone', 'SKILL.md') } }, {}), undefined)

  // The per-step refresh notices a newly added skill and invalidates the catalog.
  const preStep = listeners.get('agent/pre-step')
  const decision = { kind: 'proceed' }
  assert.equal(await preStep(agentContext(project), async () => decision), decision)
  const before = ctx.invalidations
  await mkdir(join(skillsRoot, 'added-skill'), { recursive: true })
  await writeFile(join(skillsRoot, 'added-skill', 'SKILL.md'), '---\nname: added-skill\ndescription: Added later.\n---\nBody.\n')
  await preStep(agentContext(project), async () => decision)
  assert.equal(ctx.invalidations, before + 1)
  assert.equal((await cursorProvider.list({ cwd: project })).length, 2)

  // An unchanged root does not invalidate again.
  await preStep(agentContext(project), async () => decision)
  assert.equal(ctx.invalidations, before + 1)

  // A mutation inside a known root invalidates immediately.
  const observed = listeners.get('fs/observed')
  observed({ displayPath: join(skillsRoot, 'sentinel-skill', 'SKILL.md') })
  assert.equal(ctx.invalidations, before + 2)
  observed({ displayPath: join(base, 'unrelated', 'file.ts') })
  assert.equal(ctx.invalidations, before + 2)
})

test('a disabled row registers nothing', () => {
  const rules = stubContext()
  applyRules(rules.ctx, { enabled: false })
  assert.equal(rules.listeners.size, 0)

  const skills = stubContext()
  applySkills(skills.ctx, { enabled: false })
  assert.equal(skills.listeners.size, 0)
  assert.equal(skills.provider(), undefined)
})

test('each row exports the Standard Schema config the loader validates', async () => {
  // Cordis calls `Config['~standard'].validate(config)` before `apply`
  // (`vendor/cordis` `resolveConfig`); a plain resolver function here fails the
  // whole plugin tree at boot, which is exactly how v0.1.0 of this package broke.
  for (const [label, module] of [['rules', await import('./rules.js')], ['skills', await import('./skills.js')]]) {
    const standard = module.Config['~standard']
    assert.equal(typeof standard.validate, 'function', `${label}: Config['~standard'].validate`)
    assert.equal(standard.version, 1, `${label}: Standard Schema version`)
    assert.equal(typeof module.Config.toJSON, 'function', `${label}: describe surface`)

    const parsed = standard.validate(label === 'rules' ? { maxBytes: 2048 } : { projectRank: 7 })
    assert.equal(parsed.issues, undefined, `${label}: no issues`)
    assert.equal(typeof parsed.value.enabled, 'boolean', `${label}: defaults applied`)
    assert.equal(
      label === 'rules' ? parsed.value.maxBytes : parsed.value.projectRank,
      label === 'rules' ? 2048 : 7,
      `${label}: explicit field kept`,
    )

    // A missing or hostile config still validates: rows must not throw at load.
    assert.equal(typeof standard.validate(undefined).value.enabled, 'boolean', `${label}: undefined config`)
    assert.equal(standard.validate('nonsense').value.enabled, true, `${label}: non-object config`)
  }
})
