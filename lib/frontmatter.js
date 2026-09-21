/**
 * The YAML frontmatter subset Cursor writes, without a YAML dependency.
 */

/**
 * Split leading YAML frontmatter from a markdown file.
 *
 * Fence lines must be exactly `---`, matching the harness reader. A file with
 * no frontmatter, or an unterminated one, reports `undefined` and the caller
 * decides what the whole file means.
 * @param {string} raw - file contents.
 * @returns {{ yaml: string, body: string } | undefined} frontmatter and body.
 */
export function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '')
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const bodyStart = nextNewline < 0 ? text.length : nextNewline + 1
      return { yaml: text.slice(firstLineEnd + 1, lineStart), body: text.slice(bodyStart) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * Parse the flat frontmatter subset Cursor writes.
 *
 * Supports `key: value`, quoted scalars, inline lists, and the `>`/`|` block
 * scalars that carry multi-line descriptions. Nested objects are out of scope
 * on purpose: no Cursor rule or skill metadata needs them.
 * @param {string} yaml - frontmatter body between the `---` fences.
 * @returns {Record<string, string | boolean | string[]>} parsed fields.
 */
export function parseFrontmatterData(yaml) {
  const data = {}
  const lines = yaml.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')
    if (line.trim() === '' || /^\s/.test(line)) continue
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = match[2].trim()
    const block = /^([>|])[+-]?$/.exec(value)
    if (block === null) {
      data[key] = scalar(value)
      continue
    }
    const parts = []
    while (index + 1 < lines.length) {
      const next = lines[index + 1].replace(/\r$/, '')
      if (next.trim() === '') {
        parts.push('')
        index += 1
        continue
      }
      if (!/^\s/.test(next)) break
      parts.push(next.trim())
      index += 1
    }
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    data[key] = block[1] === '|' ? parts.join('\n') : parts.join(' ')
  }
  return data
}

/** One frontmatter scalar: quoted strings, booleans, inline lists, or plain text. */
function scalar(value) {
  if (value === '') return ''
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (quoted !== null) return quoted[2]
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(part => scalar(part.trim())).filter(part => part !== '')
  }
  return value
}
