# dsh-cursor

Cursor rules and skills for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as a
tree-external plugin: no harness source changes, no build step, no dependencies.

Two rows, one package:

| Row | Delivers |
|---|---|
| `dsh-cursor/rules` | Every `.mdc` under `<project>/.cursor/rules` and `~/.cursor/rules` as dynamic model context |
| `dsh-cursor/skills` | `<project>/.cursor/skills` and `~/.cursor/skills` as `ctx.skills` candidates |

## Layout

Rows are wiring; `lib/` holds the work. A row reads its configuration, mounts one contribution, and owns
no discovery logic of its own.

| File | Responsibility |
|---|---|
| `rules.js` | Row: renders the workspace's rules into each agent assembly |
| `skills.js` | Row: registers the provider, refreshes it per step, invalidates it on a touched root |
| `lib/config.js` | Standard Schema wrapper plus the shared config coercions |
| `lib/paths.js` | Cursor home, and which workspace a session resolves to |
| `lib/frontmatter.js` | The YAML frontmatter subset Cursor writes |
| `lib/rule-files.js` | Rule discovery and budget-bounded reading |
| `lib/rule-render.js` | Rule rendering, precedence header, bounded omission notes |
| `lib/skill-files.js` | Skill entry points, parsing, and the change signature |
| `lib/skill-provider.js` | The stateful `ctx.skills` provider |

## Install

```sh
dsh plugin --profile web add <path-or-tarball-or-git-url>
dsh --profile web --dump-config   # both rows present, exit 0
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` merges this patch into the profile:

```yaml
- insert:
    - id: cursor-rules
      name: dsh-cursor/rules
    - id: cursor-skills
      name: dsh-cursor/skills
```

## Configuration

`dsh-cursor/rules`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount or skip the row |
| `home` | `~/.cursor` | Cursor home; a leading `~` expands to the user home |
| `maxBytes` | `65536` | Byte budget of the complete emitted text (header, rule blocks, and notes) |
| `maxSourceBytes` | `262144` | Per-file cap; a larger rule file is skipped and named in the payload |
| `includeUserRules` | `true` | Include `~/.cursor/rules` |

`dsh-cursor/skills`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount or skip the row |
| `home` | `~/.cursor` | Cursor home |
| `includeUserSkills` | `true` | Include `~/.cursor/skills` |
| `projectRank` | `250` | Precedence rank of project skills |
| `userRank` | `350` | Precedence rank of user skills |

Ranks follow the harness filesystem provider: project `.dsh` 100, project `.agents` 200, this provider
250/350, custom roots 300, user `.dsh` 400, user `.agents` 500. Lower wins for duplicate names, so a
native project skill outranks the same Cursor skill, and a Cursor project skill outranks a user one.

## How each half reaches the model

**Rules** ride the runtime-context snapshot. The row appends one context to every agent assembly
(`system-prompt/assemble`), and the harness materializes the joined snapshot as a durable user-role
message — re-emitting it only when the text changes. The scan therefore runs per assembly and needs no
cache: edits, additions, and deletions are live on the next model request, and a deletion that empties
the payload produces the harness's own "no runtime context" marker.

**Skills** register a `ctx.skills` provider named `cursor`. Only catalog metadata (name, description)
reaches the model; bodies load on demand through the `skill` tool. The provider re-reads its roots on
every catalog lookup, and a per-step directory signature invalidates a warm catalog when a skill file
changes.

## Semantics

- **Scope**: exactly two layers, for rules and skills alike — the user-global Cursor home
  (`~/.cursor/rules`, `~/.cursor/skills`) and the current workspace's `.cursor`. File names are sorted
  inside one layer, and later blocks override earlier ones on conflict, which the payload states in its
  header.
- **Workspace**: the nearest ancestor of the session's working directory holding `.cursor` (or a
  configured marker such as `.git`). A workspace opened from a subdirectory therefore still resolves to
  that workspace, while a project nested inside another one resolves to itself. The Cursor home is a
  layer, never a workspace, so a session under the user home gets the global layer alone.
- **Frontmatter is stripped, never interpreted**: `description`, `globs`, and `alwaysApply` do not
  change what is injected. Selective injection by `globs` is deliberately not implemented.
- **Skill frontmatter**: `name` and `description` are required (kebab-case name, non-empty
  description); `disable-model-invocation: true` keeps a skill user-invocable but removes it from the
  model-facing catalog. A skill file that fails these rules is skipped, not fatal.
- **Budget**: the budget covers the complete emitted text — header, rule blocks, and notes — and over it
  the widest (least specific) rules are dropped first. Files over `maxSourceBytes`, and files the budget
  never reached, are named with their reason, at most five paths per note plus a remainder count.

## Known limitations

- **No second Cursor provider may be mounted alongside this one.** The skill registry rejects a
  duplicate provider name and fails the entire plugin tree at boot, so this plugin registers as
  `dsh-cursor`. An in-source Cursor provider — for example a patched `dsh-skill-cursor` that also calls
  itself `cursor` — must be disabled while this one is enabled, or the host will not start.
- Rules are a **separate source** from `AGENTS.md`: they do not share its byte budget, are not
  deduplicated against it, and do not take part in its instruction chain. Cursor rules land after the
  `AGENTS.md` message, which is the driver's own ordering for runtime context.
- If another mechanism injects the same rules, the model receives them twice: there is no cross-source
  deduplication.
- The scan is bounded so a pathological rules directory cannot make one model request expensive: at most
  `maxSourceBytes` per file, and reading stops once `maxBytes` is spent, narrowest first.
- Rule text containing `{{` is rewritten to `{ {`, because prompt assembly treats `{{name}}` as a
  variable reference — an unknown one fails the whole model request. Paired braces in a renderable
  diagram therefore lose one space.
- Skills added by another process while a session is idle appear on the next agent step, not
  instantly; there is no filesystem watcher.
- No client UI: this plugin is host-only.

## Tests

```sh
node --test
```

## License

MIT
