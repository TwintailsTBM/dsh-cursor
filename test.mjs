/**
 * Unit tests for the pure discovery, parsing, and rendering logic.
 *
 * `node --test` — no test framework dependency, matching the plugin's
 * dependency-free build.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseFrontmatterData, splitFrontmatter } from './lib/frontmatter.js'
import { cursorHome, findProjectRoot } from './lib/paths.js'
import { collectRules, guardBraces } from './lib/rule-files.js'
import { renderRules } from './lib/rule-render.js'
import { collectSkills, readSkill, skillRootSignature } from './lib/skill-files.js'

test('splitFrontmatter separates the fence from the body', () => {
  assert.deepEqual(splitFrontmatter('---\ndescription: d\n---\nbody\n'), { yaml: 'description: d\n', body: 'body\n' })
  assert.equal(splitFrontmatter('# no frontmatter\n'), undefined)
  assert.equal(splitFrontmatter('---\nunterminated: d\n'), undefined)
  assert.deepEqual(splitFrontmatter('---\r\ndescription: d\r\n---\r\nbody'), { yaml: 'description: d\r\n', body: 'body' })
  assert.deepEqual(splitFrontmatter('\uFEFF---\nd: 1\n---\nbody'), { yaml: 'd: 1\n', body: 'body' })
})

test('parseFrontmatterData reads scalars, folded blocks, literal blocks, and lists', () => {
  const yaml = [
    'name: hg-cpp',
    'description: >-',
    '  Diagnose Android native',
    '  process-internal deadlocks.',
    'alwaysApply: true',
    'globs: ["a/**", "b/*.h"]',
    "quoted: 'kept'",
    'literal: |',
    '  line one',
    '  line two',
  ].join('\n')
  const data = parseFrontmatterData(yaml)
  assert.equal(data.name, 'hg-cpp')
  assert.equal(data.description, 'Diagnose Android native process-internal deadlocks.')
  assert.equal(data.alwaysApply, true)
  assert.deepEqual(data.globs, ['a/**', 'b/*.h'])
  assert.equal(data.quoted, 'kept')
  assert.equal(data.literal, 'line one\nline two')
})

test('guardBraces neutralizes the interpolation pairs assembly rejects', () => {
  assert.equal(guardBraces('a {{model}} b'), 'a { {model}} b')
  assert.equal(guardBraces('plain text'), 'plain text')
  assert.equal(guardBraces('{ {already} }'), '{ {already} }')
})

test('cursorHome defaults to the user Cursor directory and expands a leading tilde', () => {
  assert.ok(cursorHome({}).endsWith(join('', '.cursor')))
  assert.equal(cursorHome({ home: '~/.cursor' }).endsWith(join('.cursor')), true)
  assert.equal(cursorHome({ home: join('C:', 'x', 'cursor') }), join('C:', 'x', 'cursor'))
})

test('renderRules keeps the global layer first and bounds the complete text', () => {
  const rules = [
    { path: 'user/a.mdc', body: 'A'.repeat(200) },
    { path: 'workspace/b.mdc', body: 'B'.repeat(200) },
  ]
  const all = renderRules(rules, { maxBytes: 65536 })
  assert.ok(all.indexOf('user/a.mdc') < all.indexOf('workspace/b.mdc'))
  assert.ok(all.startsWith('Cursor rules for this workspace (2 of 2 rule files'))

  // Over budget: the widest (global) rule goes first and the note names it.
  const cut = renderRules(rules, { maxBytes: 500 })
  assert.ok(!cut.includes('## user/a.mdc'))
  assert.ok(cut.includes('## workspace/b.mdc'))
  assert.ok(cut.includes('(1 of 2 rule files'))
  assert.ok(cut.includes('Omitted over the 500-byte budget: user/a.mdc'))
  assert.ok(Buffer.byteLength(cut) <= 500, `emitted ${Buffer.byteLength(cut)} bytes over a 500-byte budget`)

  // A budget smaller than the header alone, or no rules at all, emits nothing.
  assert.equal(renderRules(rules, { maxBytes: 60 }), '')
  assert.equal(renderRules([], { maxBytes: 100 }), '')
})

test('the workspace is the nearest .cursor ancestor and contributes one layer', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-'))
  const home = join(base, 'cursorhome')
  const proj = join(base, 'proj')
  const deep = join(proj, 'Modules', 'Foo')
  const nested = join(proj, 'External', 'Inner')

  await mkdir(join(proj, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(proj, '.cursor', 'rules', 'root.mdc'), '---\ndescription: r\nalwaysApply: true\n---\nRoot rule body\n')
  await mkdir(deep, { recursive: true })
  await mkdir(join(nested, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(nested, '.cursor', 'rules', 'inner.mdc'), '---\ndescription: i\n---\nInner rule body\n')

  // A subdirectory of the workspace resolves to the workspace.
  assert.equal(await findProjectRoot(deep, { home }), proj)
  const { rules } = await collectRules({ projectRoot: proj, home, includeUserRules: false })
  assert.deepEqual(rules.map(rule => rule.path), [join(proj, '.cursor', 'rules', 'root.mdc')])
  assert.equal(rules[0].body, 'Root rule body')

  // A project nested inside another resolves to itself, and its layer is its own.
  assert.equal(await findProjectRoot(nested, { home }), nested)
  const { rules: nestedRules } = await collectRules({ projectRoot: nested, home, includeUserRules: false })
  assert.deepEqual(nestedRules.map(rule => rule.path), [join(nested, '.cursor', 'rules', 'inner.mdc')])

  // A workspace that is also the Cursor home reads each file once, not twice.
  const { rules: withUser } = await collectRules({ projectRoot: proj, home: join(proj, '.cursor'), includeUserRules: true })
  assert.deepEqual(withUser.map(rule => rule.path), [join(proj, '.cursor', 'rules', 'root.mdc')])

  // A .git marker also ends the walk.
  const gitProj = join(base, 'gitproj')
  await mkdir(join(gitProj, '.git'), { recursive: true })
  await mkdir(join(gitProj, 'sub'), { recursive: true })
  assert.equal(await findProjectRoot(join(gitProj, 'sub'), { home }), gitProj)

  const rendered = renderRules(rules, { maxBytes: 65536 })
  assert.ok(rendered.includes('Root rule body'))
  assert.ok(!rendered.includes('alwaysApply'))
})

test('a workspace without .cursor and a Cursor-home workspace both fall back safely', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-fallback-'))
  const home = join(base, 'cursorhome')
  const bare = join(base, 'bare')
  await mkdir(bare, { recursive: true })

  // No .cursor anywhere below the home: the session keeps its own directory and
  // reads no workspace layer (the global layer still applies).
  assert.equal(await findProjectRoot(bare, { home }), bare)
  assert.deepEqual((await collectRules({ projectRoot: bare, home, includeUserRules: false })).rules, [])

  // A workspace that IS the Cursor home must not read the global layer twice.
  await mkdir(join(home, '.cursor'), { recursive: true })
  await mkdir(join(home, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(home, '.cursor', 'rules', 'global.mdc'), '---\ndescription: g\n---\nGlobal rule body\n')
  const { rules } = await collectRules({ projectRoot: home, home, includeUserRules: true })
  assert.equal(rules.filter(rule => rule.path.endsWith('global.mdc')).length, 1)
})

test('the brace guard reaches rule bodies read from disk', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-brace-'))
  const root = join(base, 'proj')
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(root, '.cursor', 'rules', 'cpp.mdc'), '---\ndescription: c\n---\nstd::array<int,2> a{{1,2}};\n')
  const { rules } = await collectRules({ projectRoot: root, home: join(base, 'none'), includeUserRules: false })
  assert.equal(rules[0].body, 'std::array<int,2> a{ {1,2}};')
})

test('skill discovery reads folded descriptions and honours disable-model-invocation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-skills-'))
  const root = join(base, 'skills')
  await mkdir(join(root, 'shown-skill'), { recursive: true })
  await mkdir(join(root, 'hidden-skill'), { recursive: true })
  await mkdir(join(root, 'Bad_Name'), { recursive: true })
  await mkdir(join(root, 'no-description'), { recursive: true })
  await writeFile(join(root, 'shown-skill', 'SKILL.md'), [
    '---',
    'name: shown-skill',
    'description: >-',
    '  Folded description that',
    '  spans two lines.',
    '---',
    '',
    'Body.',
  ].join('\n'))
  await writeFile(join(root, 'hidden-skill', 'SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden\ndisable-model-invocation: true\n---\nHidden body.\n')
  await writeFile(join(root, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Bad\n---\nBad.\n')
  await writeFile(join(root, 'no-description', 'SKILL.md'), '---\nname: no-description\n---\nNone.\n')
  await writeFile(join(root, 'loose.md'), '---\nname: loose\ndescription: A bare markdown skill\n---\nLoose body.\n')

  const candidates = await collectSkills(root, { provider: 'cursor', source: 'cursor-project', rank: 250 })
  assert.deepEqual(candidates.map(candidate => candidate.name), ['loose', 'shown-skill', 'hidden-skill'].sort())
  const shown = candidates.find(candidate => candidate.name === 'shown-skill')
  assert.equal(shown.description, 'Folded description that spans two lines.')
  assert.deepEqual(shown.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidates.find(candidate => candidate.name === 'hidden-skill').invocation.modelInvocable, false)
  assert.equal(candidates.find(candidate => candidate.name === 'loose').rank, 250)
  assert.ok(!candidates.some(candidate => candidate.name === 'Bad_Name'))
  assert.ok(!candidates.some(candidate => candidate.name === 'no-description'))

  const definition = await readSkill(join(root, 'shown-skill', 'SKILL.md'))
  assert.equal(definition.content, 'Body.')
})

test('the skill root signature changes when a skill file changes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-sig-'))
  const root = join(base, 'skills')
  await mkdir(join(root, 'one'), { recursive: true })
  await writeFile(join(root, 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\nA.\n')
  const before = await skillRootSignature([root])
  assert.equal(before, await skillRootSignature([root]))
  await mkdir(join(root, 'two'), { recursive: true })
  await writeFile(join(root, 'two', 'SKILL.md'), '---\nname: two\ndescription: Two\n---\nB.\n')
  assert.notEqual(await skillRootSignature([root]), before)
  assert.equal(await skillRootSignature([join(base, 'missing')]), `${join(base, 'missing')}:absent`)
})

test('an oversized rule file is skipped and named instead of injected', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-size-'))
  const root = join(base, 'proj')
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(root, '.cursor', 'rules', 'small.mdc'), '---\ndescription: s\n---\nSmall body\n')
  await writeFile(join(root, '.cursor', 'rules', 'huge.mdc'), `---\ndescription: h\n---\n${'H'.repeat(5000)}`)

  const collected = await collectRules({
    projectRoot: root,
    home: join(base, 'none'),
    includeUserRules: false,
    maxSourceBytes: 1024,
  })
  assert.deepEqual(collected.rules.map(rule => rule.path), [join(root, '.cursor', 'rules', 'small.mdc')])
  assert.deepEqual(collected.omitted, [{ path: join(root, '.cursor', 'rules', 'huge.mdc'), reason: 'size' }])

  const text = renderRules(collected.rules, { maxBytes: 65536, omitted: collected.omitted })
  assert.ok(text.includes('Skipped over the per-file size cap: ' + join(root, '.cursor', 'rules', 'huge.mdc')))
  assert.ok(text.includes('(1 of 2 rule files'))
  assert.ok(!text.includes('H'.repeat(100)))
})

test('reading is bounded by the budget, not by the size of the rules directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-many-'))
  const root = join(base, 'proj')
  const dir = join(root, '.cursor', 'rules')
  await mkdir(dir, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    await writeFile(join(dir, `rule-${String(index).padStart(2, '0')}.mdc`), `---\ndescription: d\n---\n${'R'.repeat(1000)}`)
  }

  const collected = await collectRules({
    projectRoot: root,
    home: join(base, 'none'),
    includeUserRules: false,
    maxReadBytes: 4000,
  })
  assert.ok(collected.rules.length >= 1 && collected.rules.length <= 4, `read ${collected.rules.length} of 40 files`)
  assert.equal(collected.rules.length + collected.omitted.length, 40)
  // Narrowest-first reading keeps the deepest files and names the rest.
  assert.ok(collected.rules.at(-1).path.endsWith('rule-39.mdc'))
  assert.ok(collected.omitted.every(entry => entry.reason === 'budget'))

  const text = renderRules(collected.rules, { maxBytes: 4000, omitted: collected.omitted })
  assert.ok(Buffer.byteLength(text) <= 4000, `emitted ${Buffer.byteLength(text)} bytes`)
  assert.match(text, /\(\d of 40 rule files/)
  assert.ok(text.includes('Omitted over the 4000-byte budget: '))
  // The note is bounded: 36 omitted paths collapse into a remainder count.
  assert.ok(text.includes('more)'), text.split('\n').at(-1))
})

test('an aborted request reads no rules and reports them as unread', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-abort-'))
  const root = join(base, 'proj')
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(root, '.cursor', 'rules', 'a.mdc'), '---\ndescription: a\n---\nBody A\n')

  const controller = new AbortController()
  controller.abort()
  const collected = await collectRules({
    projectRoot: root,
    home: join(base, 'none'),
    includeUserRules: false,
    signal: controller.signal,
  })
  assert.equal(collected.rules.length, 0)
  assert.ok(collected.omitted.every(entry => entry.reason === 'unreadable'))
})

test('odd rule inputs never break the payload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cursor-odd-'))
  const root = join(base, 'proj')
  const dir = join(root, '.cursor', 'rules')
  // A directory that merely ends in .mdc, a NUL byte, and invalid UTF-8.
  await mkdir(join(dir, 'not-a-file.mdc'), { recursive: true })
  await writeFile(join(dir, 'nul-bytes.mdc'), '---\ndescription: n\n---\nbefore\u0000after\n')
  await writeFile(join(dir, 'bad-utf8.mdc'), Buffer.from([
    0x2d, 0x2d, 0x2d, 0x0a, 0x64, 0x3a, 0x20, 0x31, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x41, 0x0a,
  ]))

  const collected = await collectRules({ projectRoot: root, home: join(base, 'none'), includeUserRules: false })
  const names = collected.rules.map(rule => rule.path.split(/[\\/]/).pop()).sort()
  assert.deepEqual(names, ['bad-utf8.mdc', 'nul-bytes.mdc'])
  const text = renderRules(collected.rules, { maxBytes: 65536, omitted: collected.omitted })
  assert.ok(text.includes('before'))
})
