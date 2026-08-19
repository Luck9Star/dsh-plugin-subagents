# dsh-plugin-subagents

[English](README.md) | **简体中文**

> 适用于 DeepSeek Harness (dsh) `0.1.0-rc.6` / `0.1.0-rc.7` · Node ≥ 18 · MIT

DeepSeek Harness 的子代理增强插件。模型继续用它已经熟悉的 `subagent` / `subagent_fork` 工具，但每一次调用都能：

- **走原生子代理，更快更省** —— 委派给 dsh 进程内子代理，并且可以按次覆盖任何参数：`model`、`provider`、`persona`、工具权限（`toolFilter`）、工作目录（`cwd`）。
- **借外部 Agent 的手** —— 直接把任务委派给外部 Agent CLI：**Claude Code**、**Codex**、**Grok**，或**任何 ACP agent**。桥接子代理是一个可以持续对话的长期伙伴，dsh 重启后也会重连到同一条外部会话继续干活。
- **按角色委派，不用写长篇要求** —— 带上一个具名角色（`code-review`、`explore`、`codex-full`……），后端、权限档、附加指令都由角色文件替你定好。

一切错误都大声报出来：不支持的参数绝不会被静默忽略；外部 CLI 返回的内容先脱敏再进入对话。

## 什么时候用它

- 想要一个快速、只读的代码侦察兵或审查员，不给写权限（`role: "explore"`、`role: "code-review"`）。
- 想让 Codex 或 Claude Code 干重活，但由你的 dsh 会话来调度，结果回流到对话里。
- 想让多个 agent 并行工作、各写各的目录（`cwd`）—— 搭配
  [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees)。
- 想让一个多任务作业能规划、派发、重启后续跑 —— 搭配
  [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator)。

## 环境要求

| 需要什么 | 说明 |
| --- | --- |
| dsh | `0.1.0-rc.6` 或 `0.1.0-rc.7` |
| Node | ≥ 18 |
| 桥接后端（可选） | 对应 CLI 已安装**并已登录**：`claude`、`codex`、`grok`，或任意 ACP agent（如 `opencode acp`）。CLI 缺失只是意味着该后端不提供 —— 只用原生子代理的话什么都不用额外装。 |

## 安装

```sh
# 1. 拉取仓库，并把它链接到正在运行的 dsh 的内部包上
git clone https://github.com/Luck9Star/dsh-plugin-subagents
cd dsh-plugin-subagents
npm install
npm run setup:peer        # 避免出现第二份 dsh-tools（没有这一步工具调用会崩）

# 2. 安装进 dsh profile
dsh plugin --profile web add "$(pwd)"

# 3. 应用宿主补丁 —— 这一步必须跑
./patches/install.sh      # Windows: patches\install.ps1
#    阶段 A（必须）：修复 dsh-tools 单实例软链
#    阶段 B（推荐）：为子代理打开逐次调用的 cwd 支持

# 4. （推荐）只读体检
./patches/verify.sh       # Windows: patches\verify.ps1 ；--probe 会实测 cwd 是否生效

# 5. （web 会话、standard 类预设）做预设层适配
./scripts/install-preset.sh standard

# 6. 重启并开一个新会话
dsh --profile web
```

**预期结果：** 新会话里出现 `subagent`、`subagent_fork`、`subagent_submit`、`subagent_progress`、`subagent_wait`、`subagent_roles`、`subagent_agents` 这组工具。`subagent_agents` 会显示哪些后端可用、在 PATH 上找到了哪些 CLI。

> **升级了 dsh？** 重跑一遍 `./patches/install.sh` —— dsh 升级会落在新的 npx 缓存目录里，cwd 补丁必须重新打。

## 快速上手

让 agent 自己调工具，或者你亲自调：

```jsonc
// 原生子代理，指定目录，跑完等结果
subagent({ prompt: "运行 pwd 并只回显第一行",
           cwd: "/tmp/dsh-smoke", run_in_background: false })

// 原生子代理，仅这一次调用换个模型
subagent({ prompt: "…", model: "deepseek-v4-flash" })

// 后台委派给 Codex，然后收答案
subagent({ backend: "codex",
           prompt: "Which product/CLI are you running as? Reply with the name only.",
           run_in_background: true })   // → { kind: "background", job_id: "…" }
subagent_wait({ subagent_id: "…", timeout_ms: 60000 })   // → "Codex"

// 用角色代替自己写一堆要求
subagent({ role: "code-review", prompt: "审查暂存区的 diff。" })
```

后台或桥接调用会返回一个**子代理 id**；用 `subagent_progress` 看进度，用 `subagent_wait` 收结果。桥接子代理可续聊 —— 再次调用时，回应你的还是同一条外部会话。

## 内置角色

`roles/` 下一个 JSON 文件一个角色 —— 放入你自己的角色文件即可自动生效（`rolesDir` 配置）。

| 角色 | 后端 | 权限 | 用途 |
| --- | --- | --- | --- |
| `general` | 调用方自选 | full | 默认角色，兜底处理没被其他角色匹配到的任务。 |
| `explore` | native | 只读工具集 | 快速代码侦察 —— 只搜索和阅读，绝不写文件。 |
| `code-review` | native | 只读工具集 | 审查 diff 的缺陷、安全性与可维护性。 |
| `debug` | native | default | 定位 bug 与故障根因；允许派只读帮手。 |
| `codex-full` | codex | full | 主力干将：通过 Codex 改文件、跑命令。 |
| `claude-readonly` | claude-code | readonly | 用 Claude Code 读代码、做规划，不改文件。 |
| `grok-native-full` | grok-native | full | Grok CLI 上的主力干将。 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `subagent` | 委派任务。返回可续聊的子代理、后台作业，或（前台模式）最终输出。 |
| `subagent_fork` | 同上，fork 变体（默认一次性）。 |
| `subagent_submit` | 向运行中的桥接子代理递交工作（转发管道）。 |
| `subagent_progress` | 子代理的实时进度 —— 包括桥接子代理真正向外转发过几次工作。 |
| `subagent_wait` | 阻塞等待子代理回答（`timeout_ms` 默认 300 秒，上限 600 秒）。 |
| `subagent_roles` | 列出可用角色。 |
| `subagent_agents` | 可用性总览：有哪些后端、找到了哪些 CLI、登录提示。 |

## 内建的安全机制

- **权限天花板** —— 桥接子代理永远不能生出权限*比自己高*的后代。一个只读的 Codex 子代理没法靠委派给全权限的 Claude 子代理越狱 —— 任何路径都不行，包括插件间调度。未知权限档一律按只读从严处理。
- **密钥脱敏** —— 桥接输出在进入对话前先过一遍脱敏：Bearer token、`sk-…` 密钥、`ghp_/gho_…` 令牌、`api_key=` 赋值、JWT。默认开启（`redactSecrets`）。
- **传话筒诚实守卫** —— 桥接子代理是*传话筒*：它的职责是把任务转发给外部 CLI，而不是自己作答。如果它一次都没转发就交报告，报告会被直接打回并附明确警告 —— 偷懒的传话筒没法把自己的话冒充成 Codex 的工作成果。
- **断线可恢复** —— 每个桥接子代理的会话映射与设置记录在 `~/.dsh/subagents-registry.json`（原子写入、仅所有者可读 `0600`、最多保留 500 条）。重启后子代理重连同一条外部会话，权限天花板原样恢复 —— 恢复依据只有这份注册表，从不信任子代理自己的日志行。

## 配置

全部可选 —— 下表每项都有可用默认值。配置写在 profile 的 `cordis.patch.yml` 中本插件的行上；写错的键会在启动时大声报错。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `providers` | 内置后端 | 额外的桥接 CLI，如 `{ myagent: { type: "acp", command: "opencode", args: ["acp"] } }`。类型：`claude` / `codex` / `grok` / `acp`。 |
| `rolesDir` | 自带 `roles/` | 角色 JSON 文件的加载目录。 |
| `idleTimeoutMs` | `600000` | 桥接子代理的空闲超时（`0` = 永不）。 |
| `maxConcurrentChildren` | `8` | 在线桥接子代理数量上限。 |
| `redactSecrets` | `true` | 对桥接输出脱敏。 |
| `relayReportGuard` | `true` | 打回从未转发过工作的传话筒报告。 |
| `maxDispatchPermissionMode` | `full` | 插件间调度的权限天花板。 |
| `legacyProductAliases` | `auto` | 为从旧版注册表迁移过来的子代理保留的兼容别名。 |
| `provider` | `spawn` | 原生子代理的默认 provider。 |
| `agentOptions` | — | 原生子代理的默认 `{ provider, model, maxTokens }`。 |
| `persona` / `toolFilter` / `maxDepth` | — | 原生子代理的默认值；逐次调用的参数优先。 |
| `toolNames.delegate` / `toolNames.fork` | `subagent` / `subagent_fork` | 必要时可改写接管的工具名。 |
| `register.*` | `true` | 按工具注册开关（`register.wait` 等）。 |
| `presetRow` | `false` | 进阶：以官方预设行形式注册，而不是接管全局工具。 |

角色文件支持字段：`description`（给委派方模型看）、`backend`、`permissionMode`（`readonly` / `default` / `full`）、`allowDelegation`、`instructions`（前置到任务文本）、`overrides`（仅原生子代理的按角色默认值）。完整结构见 [docs/DESIGN.md](docs/DESIGN.md)。

## 给插件作者：调度接缝

其他插件可以通过 `ctx.get('subagentsDispatch')` 以纯代码方式调度桥接子代理 —— 不经过模型工具调用。有两道权限闸（委派天花板与 `maxDispatchPermissionMode`）。细节与示例：[docs/dispatch-seam.md](docs/dispatch-seam.md)。

## 常见问题

| 症状 | 原因 → 处理 |
| --- | --- |
| 每次工具调用都报 `Cannot read properties of undefined (reading 'prepare')` | 出现了两份物理拷贝的 `dsh-tools`。在本仓库重跑 `npm run setup:peer`，再跑 `./patches/install.sh`。 |
| `subagent: backend "codex" is not available: command "codex" not found on PATH` | CLI 没装。安装并登录（`codex login`）后重启 dsh。`subagent_agents` 对每个后端都有提示。 |
| dsh 升级后 `cwd` 好像失效了 | 重跑 `./patches/install.sh` —— 每次 dsh 升级后都要重新打 cwd 补丁。 |
| `subagent: permission escalation blocked …` | 这是设计行为：某个子代理试图生出权限更高的后代，被拦下了。 |
| grok-native 只回一个字符，或每次重试都报 `Session ID ... is already in use` | 已修复：grok CLI 1.0.5 把 `text` 事件改成了分片流、且拒绝复用已存在的 `-s` 会话号。更新本插件即可 —— 解析器现在拼接分片、锁死会自动回退 `--resume`、默认超时提到 15 分钟。 |
| 启动时报重复注册 provider 的错误 | 同一 profile 里有别的插件注册了同名桥接后端，或同样接管了 `subagent`。二选一：编辑 profile 的 `cordis.patch.yml` 删掉那边，`pnpm remove` 对应包，再重装本插件。 |

## 搭配使用

- [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees) —— 并行任务通过 `cwd` 各写各的 git worktree。
- [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator) —— 规划并可续跑多任务 DAG；其任务节点依赖本插件的 `cwd` 支持。

## 开发

```sh
npm install && npm run setup:peer   # 链接正在运行的宿主的 peers
npm test                            # node --test，全部用假对象 —— 不碰 CLI、密钥、网络
npm run lint
```

设计记录：[docs/DESIGN.md](docs/DESIGN.md) · 验证手册：[docs/VERIFY.md](docs/VERIFY.md)。

## 参考与致谢

- **DeepSeek Harness** 原生 `subagent` 工具族 —— 本插件扩展的对象。
- **Claude Code**（`.claude/agents` 一文件一个 agent 的设计）—— 角色库的形态来源：一文件一角色、默认允许再委托。
- **Codex CLI**、**Claude Code CLI**、**Grok CLI** —— 桥接后端。
- **Agent Client Protocol（ACP）** 及其
  [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) —— 任何讲 ACP 的 agent 零代码接入。
- **task-weaver** —— 密钥脱敏逻辑与 Grok 桥接的 argv/解析/分类逻辑移植自它。

## 安全

见 [SECURITY.md](SECURITY.md)。桥接 CLI 用的是你自己的凭据 —— 本插件探测可用性时只查 PATH、绝不执行 CLI；脱敏掉的密钥永远不会进入对话。

## 许可证

[MIT](LICENSE)
