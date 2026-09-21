# dsh-cursor

[English](README.md) | 中文

把 [Cursor](https://cursor.com) 的规则与技能接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
树外插件：一个包、两行、零依赖、零构建。

`.cursor/rules/*.mdc` 变成动态模型上下文，`.cursor/skills` 进入 harness 的技能目录 —— 已经在用 Cursor
配置的工作区，在 `dsh` 下行为一致。

```sh
dsh plugin --profile web add github:TwintailsTBM/dsh-cursor
dsh --profile web --dump-config   # 两行都在、exit 0
```

也可以从本地目录安装，改代码不用重装、重启即生效：

```sh
dsh plugin --profile web add /path/to/dsh-cursor
```

## 挂了什么

| 行 | 交付内容 |
|---|---|
| `dsh-cursor/rules` | 全局与工作区 `.cursor/rules` 下的每个 `.mdc`，作为动态模型上下文 |
| `dsh-cursor/skills` | 同样两层 `.cursor/skills` 作为 `ctx.skills` 候选 |

两层就是两层：用户全局 Cursor 主目录（`~/.cursor/rules`、`~/.cursor/skills`），加上会话解析出的**那一个**工作区。
没有祖先链、没有第三个来源。

## 配置

`dsh-cursor/rules`

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否挂载该行 |
| `home` | `~/.cursor` | Cursor 主目录；开头的 `~` 展开为用户主目录 |
| `maxBytes` | `65536` | **完整输出**的字节预算：抬头 + 规则块 + 说明 |
| `maxSourceBytes` | `262144` | 单文件上限；超限的文件会跳过并在 payload 里点名 |
| `includeUserRules` | `true` | 是否包含 `~/.cursor/rules` |

`dsh-cursor/skills`

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否挂载该行 |
| `home` | `~/.cursor` | Cursor 主目录 |
| `includeUserSkills` | `true` | 是否包含 `~/.cursor/skills` |
| `projectRank` | `250` | 工作区技能优先级 |
| `userRank` | `350` | 全局技能优先级 |

优先级跟随 harness 的文件系统 provider，同名时**数值小者胜**：工作区 `.dsh` 100、工作区 `.agents` 200、
本插件 250/350、custom 根 300、用户 `.dsh` 400、用户 `.agents` 500。

## 两半各自怎么到达模型

**规则**走 runtime-context 快照：该行往每次 agent 装配（`system-prompt/assemble`）追加一段 context，harness 把合并后的
快照物化为一条持久 user 消息，**文本不变就不重复追加**——跨进程重启也一样，因为快照状态是从会话日志恢复的。因此扫描
每次装配重跑、不需要缓存：增删改都在下一次模型请求生效；内容清空后自然不再贡献。

**技能**注册一个名为 `dsh-cursor` 的 `ctx.skills` provider：只有目录元数据（名称、描述）进模型，正文按需由 `skill`
工具载入。provider 每次查目录都重读根目录，并用逐步的目录签名在技能文件变化时让热缓存失效。

## 语义

- **工作区**：从会话工作目录向上，**最近的**含 `.cursor` 的祖先（`.git` 等标记同样终止上溯）。因此子目录开会话仍解析到
  该工作区，而嵌在另一个工程里的工程解析到它自己。Cursor 主目录只是"层"，永远不是工作区。
- **顺序**：全局层在前、工作区层在后，同层按文件名排序；冲突时后者覆盖前者，抬头里写明了这点。
- **frontmatter 只剥不解释**：`description`、`globs`、`alwaysApply` 不影响注入内容；按 `globs` 的选择性注入**有意不做**。
- **技能 frontmatter**：必须有 kebab-case 的 `name` 与非空 `description`；`disable-model-invocation: true` 让技能保持
  用户可调用但不进模型目录。不合规的文件会被跳过并留下日志，不静默丢弃。
- **预算**覆盖完整输出，超预算时**先丢最宽的全局规则**；超过单文件上限的、以及预算没读到的文件，都会带原因被点名
  （每条说明最多列 5 个路径 + 剩余计数）。
- **子代理**同样拿到规则，因为它们经过的是同一个装配 waterfall。

## 已知限制

- **不能与第二个 Cursor provider 同时挂载。** 技能注册表禁止 provider 重名，重名会让整棵插件树加载失败、宿主无法启动，
  所以本插件注册为 `dsh-cursor`。若存在自称 `cursor` 的内置 provider，必须在本插件启用期间禁用它。
- 规则与 `AGENTS.md` 是**独立来源**：不共享字节预算、不做跨源去重、不属于指令链。Cursor 规则排在 `AGENTS.md`
  消息之后（那是 driver 对 runtime context 的固有顺序）。
- 若另有机制注入同一批规则，模型会收到两份：本插件不做跨源去重。
- 正文里出现 `{{` 会被改写成 `{ {`：装配把 `{{name}}` 当变量引用，而未知变量会让整个模型请求失败；因此可渲染示意图里的
  双花括号会少一个空格。
- 会话空闲期间由其他进程新增的技能，要到下一次 agent step 才出现（没有文件系统监听）。
- 纯 host 侧：不提供任何浏览器 UI，不涉及客户端 slot 与主题。

## 兼容性

构建与验证针对 DeepSeek Harness `0.1.2-alpha.1`。插件只依赖三个公开接缝：`system-prompt/assemble` 装配 waterfall、
`ctx.skills.registerProvider`、以及 `dsh.bundle.patch` 清单。它不从 `@deepseek-ai/*` 导入任何东西，因此没有 peer 要求。

## 开发

行只做接线，`lib/` 才是做事的地方。

| 文件 | 职责 |
|---|---|
| `rules.js` | 行：把工作区规则渲染进每次 agent 装配 |
| `skills.js` | 行：注册 provider、逐步刷新、根目录被触碰时失效 |
| `lib/config.js` | Standard Schema 包装与共享的配置强制 |
| `lib/paths.js` | Cursor 主目录，以及会话解析到哪个工作区 |
| `lib/frontmatter.js` | Cursor 写的那套 YAML frontmatter 子集 |
| `lib/rule-files.js` | 规则发现与受预算约束的读取 |
| `lib/rule-render.js` | 规则渲染、优先级抬头、封顶的省略说明 |
| `lib/skill-files.js` | 技能入口点、解析与变更签名 |
| `lib/skill-provider.js` | 有状态的 `ctx.skills` provider |

```sh
node test.mjs            # 14 个单测：解析、发现、作用域、预算、异常输入
node test-delivery.mjs   # 4 个投递层测试：每行注册了什么、返回了什么
node smoke.mjs [目录]     # 某个真实工作区里一次会话会注入多少
node extreme.mjs         # 病态目录：5MB 单文件、500 个文件、NUL 字节
node verify-session.mjs [session.jsonl.zstd] [grep]
                         # 解会话日志，报上下文段与技能目录
```

`verify-session.mjs` 存在的原因：会话日志是多 frame 追加的 zstd，一次性与流式解码器都只解第一帧；脚本逐 frame 解码，
报告模型**实际收到**了什么。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
