# dsh-cursor

English | [中文](README.zh.md)

Cursor rules and skills for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as a
tree-external plugin: one package, two loader rows, no dependencies, no build step.

`.cursor/rules/*.mdc` becomes dynamic model context, and `.cursor/skills` joins the harness skill
catalog — so a workspace that already carries Cursor configuration behaves the same way under `dsh`.

```sh
dsh plugin --profile web add github:TwintailsTBM/dsh-cursor
dsh --profile web --dump-config   # both rows present, exit 0
```

From a local checkout instead, so edits stay live without reinstalling:

```sh
dsh plugin --profile web add /path/to/dsh-cursor
```

## What it mounts

| Row | Delivers |
|---|---|
| `dsh-cursor/rules` | Every `.mdc` under the user-global and workspace `.cursor/rules` as dynamic model context |
| `dsh-cursor/skills` | `.cursor/skills` from the same two layers as `ctx.skills` candidates |

Both scopes are exactly two layers: the user-global Cursor home (`~/.cursor/rules`, `~/.cursor/skills`)
and the one workspace the session resolves to. There is no ancestor chain and no third source.

## Configuration

`dsh-cursor/rules`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount or skip the row |
| `home` | `~/.cursor` | Cursor home; a leading `~` expands to the user home |
| `maxBytes` | `65536` | Byte budget of the complete emitted text: header, rule blocks, and notes |
| `maxSourceBytes` | `262144` | Per-file cap; a larger rule file is skipped and named in the payload |
| `includeUserRules` | `true` | Include `~/.cursor/rules` |

`dsh-cursor/skills`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount or skip the row |
| `home` | `~/.cursor` | Cursor home |
| `includeUserSkills` | `true` | Include `~/.cursor/skills` |
| `projectRank` | `250` | Precedence rank of workspace skills |
| `userRank` | `350` | Precedence rank of user-global skills |

Ranks follow the harness filesystem provider, lower winning a duplicate name: workspace `.dsh` 100,
workspace `.agents` 200, this provider 250/350, custom roots 300, user `.dsh` 400, user `.agents` 500.

## How each half reaches the model

**Rules** ride the runtime-context snapshot. The row appends one context to every agent assembly
(`system-prompt/assemble`) and the harness materializes the joined snapshot as a durable user-role
message, re-emitting it only when the text changes — including across a process restart, because the
snapshot is restored from the session log. The scan therefore runs per assembly and needs no cache:
edits, additions, and deletions are live on the next model request, and a payload that empties out stops
contributing.

**Skills** register one `ctx.skills` provider named `dsh-cursor`. Only catalog metadata (name,
description) reaches the model; bodies load on demand through the `skill` tool. The provider re-reads
its roots on every catalog lookup, and a per-step directory signature invalidates a warm catalog when a
skill file changes.

## Semantics

- **Workspace**: the nearest ancestor of the session's working directory holding `.cursor` (or a
  configured marker such as `.git`). A session opened from a subdirectory therefore still resolves to
  that workspace, while a project nested inside another one resolves to itself. The Cursor home is a
  layer, never a workspace.
- **Order**: the user-global layer first, then the workspace layer, file names sorted inside one layer.
  Later blocks override earlier ones on conflict, which the payload states in its header.
- **Frontmatter is stripped, never interpreted**: `description`, `globs`, and `alwaysApply` do not
  change what is injected. Selective injection by `globs` is deliberately not implemented.
- **Skill frontmatter**: `name` and `description` are required (kebab-case name, non-empty description);
  `disable-model-invocation: true` keeps a skill user-invocable but removes it from the model-facing
  catalog. A file that fails these rules is skipped with a log line, not silently.
- **Budget**: the budget covers the complete emitted text, and over it the widest (global) rules are
  dropped first. Files over `maxSourceBytes`, and files the budget never reached, are named with their
  reason — at most five paths per note plus a remainder count.
- **Subagents** receive the same rules, because the assembly waterfall they run through is the same one.

## Known limitations

- **No second Cursor provider may be mounted alongside this one.** The skill registry rejects a
  duplicate provider name and fails the entire plugin tree at boot, so this plugin registers as
  `dsh-cursor`. An in-source Cursor provider that also calls itself `cursor` must be disabled while this
  one is enabled, or the host will not start.
- Rules are a **separate source** from `AGENTS.md`: they do not share its byte budget, are not
  deduplicated against it, and do not take part in its instruction chain. Cursor rules land after the
  `AGENTS.md` message, which is the driver's own ordering for runtime context.
- If another mechanism injects the same rules, the model receives them twice: there is no cross-source
  deduplication.
- Rule text containing `{{` is rewritten to `{ {`, because prompt assembly treats `{{name}}` as a
  variable reference and an unknown one fails the whole model request. Paired braces in a renderable
  diagram therefore lose one space.
- Skills added by another process while a session is idle appear on the next agent step, not instantly;
  there is no filesystem watcher.
- Host-only: the rows add no browser UI, so nothing here touches client slots or themes.

## Compatibility

Built and verified against DeepSeek Harness `0.1.2-alpha.1`. The plugin depends on three public seams:
the `system-prompt/assemble` waterfall, `ctx.skills.registerProvider`, and the `dsh.bundle.patch`
manifest. It imports nothing from `@deepseek-ai/*`, so it carries no peer requirement.

## Development

The rows are wiring; `lib/` holds the work.

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

```sh
node test.mjs            # 14 unit tests: parsing, discovery, scope, budget, odd inputs
node test-delivery.mjs   # 4 delivery tests: what each row registers and returns
node smoke.mjs [dir]     # what one session in a real workspace would inject
node extreme.mjs         # pathological rules directories: 5 MB file, 500 files, NUL bytes
node verify-session.mjs [session.jsonl.zstd] [grep]
                         # decode a session log and report the context sections and skill catalog
```

`verify-session.mjs` exists because session logs are append-only multi-frame zstd: the one-shot and
streaming decoders both stop at the first frame, so the script decodes every frame and reports what the
model actually received.

## License

MIT — see [LICENSE](LICENSE).
