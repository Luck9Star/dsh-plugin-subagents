# dsh-plugin-subagents

[English](README.md) | **简体中文**

> **DSH 兼容性：** `0.1.0-rc.7`（npm latest）与 `0.1.0-rc.6` —— 经代码级核实两者均兼容。`peerDependencies: ^0.1.0-rc.6` 在 semver 下满足 `rc.7`（同 tuple prerelease 规则）。Node ≥ 18。MIT。

DeepSeek Harness 的统一子代理插件：一套 `subagent*` 工具族覆盖两类后端 —— **原生进程内子代理**（支持含 `cwd` 在内的逐次调用覆盖）与**外部 Agent CLI**（Claude Code、Codex、Grok、任意 ACP agent，作为持久、可续聊的 bridge 子代理）。插件接管官方 `subagent` / `subagent_fork` 工具名，模型习惯零迁移；**完全取代** `legacy-cwd-plugin` 与 `legacy-bridges-plugin`（见[互斥](#互斥二选一)）。

## 功能

- **一套工具面、两类后端** —— `subagent` 默认委派给原生进程内子代理；`backend` 参数（或角色）切换到外部 Agent CLI。能力不匹配永远大声报错，绝不静默忽略不支持的参数。
- **原生逐次调用覆盖** —— `model`（裸 id 或 `provider/model` 组合）、`provider`、`persona`（含 `@preset:` 引用）、`toolFilter`，以及逐次调用的 `cwd`（由本仓库安装脚本分发的两枚最小补丁提供）。
- **CLI bridges** —— Claude Code（`--session-id` / `--resume`）、Codex（JSONL 线程捕获、`resume`）、Grok（内置 id **`grok-native`** 的原生 streaming-json 桥：每 turn 一次 `grok --single=<task>` 进程、会话 id 从终止 `end` 事件增量捕获、`--resume <id>` 续接）与通用 ACP 桥（持久进程、`session/load` 重连、厂商通知吸收）。任意 ACP CLI 经 `config.providers` 零代码接入。裸名 `grok` 归你的 `config.providers` 所有（既有部署即 ACP 传输）—— `grok-native` 与用户定义的 `grok` provider 并存。
- **bridge 输出默认脱敏** —— 常见秘密形态（`Bearer …`、`sk-…` 密钥、`gh?_…` PAT、`api_key=…` 赋值、JWT）在捕获 CLI stdout/stderr 时与各 bridge 返回给模型的最终文本处一律洗掉（移植自 task-weaver 的脱敏器），默认开启：产品 CLI 打印出的秘密永远进不了对话上下文。开关：`redactSecrets`（默认 `true`）。
- **带权限天花板的角色库** —— 声明式角色锁定后端、远端权限档、附加指令与 native overrides。委派树上 `readonly < default < full` 不可上调；未知的存量权限档一律按 `readonly` 从严（fail closed）。
- **relay 回合闭环校验（D2b）** —— bridge relay 子代理本回合还没经 `subagent_submit` 转发就想 `report` 自答时，该 report 调用被拒绝并返回纠正性错误（模型仍可转发后再 report）；relay persona 附带同款硬化句，`subagent_progress` / `subagent_wait` 透出零转发的 epoch（`relayEpochSubmits`、`relayGuardFlag`、answer 前缀标记）—— 自答的 relay 再也无法静默冒充远端产品。开关：`relayReportGuard`（默认 `true`）。
- **durable 恢复** —— bridge 子代理在空闲释放与重启后仍可恢复（持久注册表：0600 属主原子写、500 条上限）；native 子代理随 harness 会话持久化。前身 `legacy-bridges-plugin` 的注册表首载时一次性迁移，旧 relay 子代理可经 `product_submit` / `product_delegate` 别名继续使用。
- **安装 + 体检** —— 两段式安装器（强制的 `dsh-tools` 单实例链接修复 + 可选的 cwd 补丁）与只读 `verify` 体检，把 npx 缓存漂移大声报出来，而不是让它静默失效。

## 环境要求

- DeepSeek Harness `0.1.0-rc.7`（npm latest）或 `0.1.0-rc.6` —— 经代码级核实两者均兼容。`peerDependencies` 锁定 `^0.1.0-rc.6` 版本族，在 semver 的同 tuple prerelease 规则下满足 `rc.7`（`^0.1.0-rc.6` 接受 `0.1.0-rc.7`；到 `0.1.1-rc.x` 起不再满足）。两枚 cwd 补丁的锚点在 `rc.7` 中逐字存在且唯一，与 `rc.6` 完全一致。
- Node ≥ 18。
- 仅 bridge 后端需要：至少一个 CLI 在 `PATH` 上且已登录 —— `claude`、`codex`、`grok` 或任意 ACP CLI。纯 native 部署一个都不需要。

## 安装

六步（DESIGN §6.5）。第 1–3 步与第 6 步始终必需；第 5 步面向 `standard` 类 preset 的 web 会话。

```sh
# 1. 安装插件（自动追加 bundle 层：禁用官方 tool-subagent 行、注册统一工具面）
dsh plugin --profile web add dsh-plugin-subagents      # 或:add <本地路径>

# 2. 移除前身插件(互斥——见下表)
#    a. 编辑 ~/.dsh/profiles/web/cordis.patch.yml,删除 `- id: legacy-bridges-plugin` insert 行
#    b. cd ~/.dsh/profiles/web && pnpm remove legacy-bridges-plugin

# 3. 【必跑】dsh-tools 单实例链接修复 + cwd 补丁(两段式)
./patches/install.sh              # macOS / Linux
patches\install.ps1               # Windows

# 4. (推荐)只读体检
./patches/verify.sh               # Windows:patches\verify.ps1

# 5. web 会话的 preset 适配(standard 类 preset 需要)
./scripts/install-preset.sh standard

# 6. 重启 dsh,开新会话
dsh --profile web
```

各步说明：

- **第 3 步即使从不用逐次调用 `cwd` 也必须跑。** A 段修复 `@deepseek-ai/dsh-tools` 的两处引用（本仓库 `node_modules` 与每个 profile 树），使其解析到 live harness 根 —— `dsh-tools` 出现第二份实体副本会让**所有**工具调用阵亡（见[升级 dsh / npx 缓存漂移](#升级-dsh--npx-缓存漂移)）。A 段先于一切执行，且绝不被 B 段阻塞。B 段应用两枚 cwd 补丁（逐枚四态判定、`.bak_cwd` 备份、`node --check` 校验、锚点漂移大声失败）。退出码：`0` 成功；`1` live 根解析或 A 段失败；`3` B 段漂移（A 段结果保留，输出会明确说明）。
  不需要逐次调用 `cwd`？跑 `./patches/install.sh --links-only` —— 只执行 A 段，不评估补丁。
- **第 4 步** 体检 live 根、两枚 cwd 补丁（两个不同文件、两个不同合并点分别检查）、两处 `dsh-tools` 链接、以及仓库 `dsh-subagent` 副本版本偏差（仅 warning）。任一漂移 → 非零退出 + 一行修复提示。`--probe` 独立重跑行为探针做深度复核。
- **第 5 步**：web 会话的工具面归会话的 **preset** 所有 —— preset 层同名行会遮蔽宿主面工具，官方 `standard` preset 会用 native-only 的官方版顶掉本插件的 `subagent`。脚本把源 preset 复制为 `<source>-subagents`，删除副本中的通用委派行（源永不改动），且幂等。然后**在 UI 里切换到适配副本并开新会话**（`recompose` 仅对空白会话生效）。`orchestrator` 类 preset 没有通用 subagent 行、无需适配；可选 L2：`./scripts/install-preset.sh <source> --enhance-rows` 把 preset 行能诚实承载的官方行（`provider: spawn` 且 `toolName` 独立命名）改写为本插件（`presetRow: true`），保留「每行一个 (角色, 模型) 组合」的模式并获得全部逐次调用增强。其余官方行**从副本中删除**而非改写：通用 `subagent`/`subagent_fork` 行（会遮蔽全局实例的全参数工具）、`provider: fork` 行（preset 行实例只注册 spawn 语义委派 —— 继承上下文的委派由全局 `subagent_fork` 承担）、bridge 模板行（`provider: codex` / `claude-code` 等，bridge 委派属全局 `subagent` 工具的 `backend` 参数）。改写这些行要么遮蔽全局工具、要么在挂载时被本插件自身的 config 校验拒绝 —— 一行非法会把整个 preset 拖垮（2026-08-15 冒烟事故，见 docs/VERIFY.md）。

### 本地开发安装

```sh
git clone https://github.com/Luck9Star/dsh-plugin-subagents && cd dsh-plugin-subagents
npm install
npm run setup:peer     # 把正在运行的 harness 的 dsh-tools 链进 node_modules/
dsh plugin --profile web add "$(pwd)"
# 之后照常执行上面第 2–6 步
```

`@deepseek-ai/dsh-tools` 是 peerDependency：dsh-tools 以模块级 Symbol 注册工具调度器，第二份实体副本就是第二个模块实例，所有工具调用会死于
`Cannot read properties of undefined (reading 'prepare')`。`npm run setup:peer`（或 `HARNESS_DSH_TOOLS=/path/to/dsh-tools npm run setup:peer`）把 harness 自己的那份链接进来；在本仓库每次 `npm install` 之后、以及升级 dsh 之后都要重跑 —— `patches/install.sh` 的 A 段也会从 live 根修复同一链接。

## 生效矩阵

各部署形态下每一部分在哪里生效（DESIGN §4.2）：

| 形态 | `subagent` / `subagent_fork` | 辅助工具（submit / progress / wait / roles / agents） | bridge 委派 | 需要的动作 |
|---|---|---|---|---|
| headless（无 preset roster） | 本插件（官方行已被 bundle patch 禁用） | 本插件 | ✅ | 安装 + 可选 cwd 补丁 |
| web + `standard`（未适配） | **官方版遮蔽本插件**（preset 层 > 全局层） | 本插件（新名字不被遮蔽） | ❌（root 无入口） | 跑 preset 适配（第 5 步，L1） |
| web + 适配后副本（如 `standard-subagents`） | 本插件（副本的同名行已删除） | 本插件 | ✅ | 适配脚本 + 切换 preset + 新会话 |
| web + `orchestrator` 类（无通用 subagent 行） | 本插件（全局层直接可见） | 本插件 | ✅ | 无需适配；可选 L2（`--enhance-rows`） |

## 互斥（二选一）

本插件接管官方委派工具名并注册 bridge provider 名，与同族包互斥。失败形态大声报错是**有意为之**的强制互斥：

| 不能共存 | 原因 | 双装时的失败形态 |
|---|---|---|
| `legacy-cwd-plugin` | 同为接管官方名的 bundle | 双方都在全局工具层注册 `subagent` → 工具重名注册错误，进程起不来 |
| `dsh-subagent-tools` | 同为接管官方名的 bundle | 工具重名注册错误（`subagent`），fail loud |
| `legacy-bridges-plugin`（本插件前身） | bridge provider 名重复 | `registerProvider('codex' / 'claude-code' / 'grok-native' / 'acp')` 重名错误，进程起不来；旧 `product_*` 工具也会并存 |

安装本插件前先卸载 / 停用另一边（安装流程第 2 步）。前身的 durable relay 子代理会被一次性迁移，并可通过 legacy 别名（`legacyProductAliases`，默认 `auto`）继续运行。

## 工具

| 工具 | 类别 | 用途 |
|---|---|---|
| `subagent` | 接管官方名 | 统一委派入口；默认 native，`backend` / `role` 切换到外部 CLI |
| `subagent_fork` | 接管官方名 | native fork（子代理继承本会话已完成回合）+ 逐次调用覆盖；出现 bridge 参数即大声报错 |
| `subagent_submit` | relay 管道 | 向该子代理绑定的持久远程产品会话提交一个任务（仅 bridge 可续续子代理可用） |
| `subagent_progress` | 观测 | 单个子代理的状态 + 内部 trace + token 用量 —— native 与 bridge 通用；bridge 子代理另透出本 epoch 的 `subagent_submit` 计数，epoch 零转发时出现 `last-epoch-no-forward` 标记 |
| `subagent_wait` | 观测 | 事件驱动地等待可续续子代理结算并返回其答案（`timeout_ms` 缺省 300000，上限 600000）；被标记的 relay 答案（epoch 零转发）带 `[relay-guard: …]` 前缀 |
| `subagent_roles` | 观测 | 角色目录：id、描述、锁定后端、权限档、可否再委派 |
| `subagent_agents` | 观测 | bridge CLI 可用性 + native provider + 在册子代理总览 |

官方 `send_message` / `list_agents` / `interrupt_agent`（tool-subagent-control）与 `report`（tool-subagent-report）**不被接管** —— native 与 relay 子代理都继续可用。

### `subagent` 参数

| 参数 | 后端 | 说明 |
|---|---|---|
| `description` | 全部（必填） | 3–5 词展示标签 |
| `prompt` | 全部（必填） | 完整自包含的任务文本 |
| `backend` | — | `native`（默认）或某个检测到的 bridge provider（codex / claude-code / grok-native / 用户定义的 `grok` ACP 条目 / 配置的 ACP agent） |
| `role` | 全部 | 角色 id（`subagent_roles` 可列出）；省略 → `general`；须与角色锁定的 backend 一致 |
| `model` | native + bridge | native：裸 id（`k3`）或 `provider/model` 组合；bridge：产品自己的模型 id |
| `persona` | 仅 native | 逐次调用的 persona 文本或 `@preset:<id>` 引用 |
| `toolFilter` | 仅 native | `{ allow?: string[], deny?: string[] }` 逐次调用覆盖 |
| `cwd` | 仅 native | 绝对路径工作目录；需要 cwd 补丁（第 3 步） |
| `provider` | 仅 native | 逐次调用的子代理 provider 覆盖（如 spawn/fork） |
| `permission_mode` | 仅 bridge | `readonly` / `default` / `full`，受委派天花板约束 |
| `reasoning_effort` | 仅 bridge | `low` / `medium` / `high` |
| `run_in_background` | 全部 | 默认随 `backgroundMode`：`continuable` → true（返回 durable 子代理 id），`one-shot` → false（前台等结果，或 true 时返回 job id） |

输出三选一：`{ kind: continuable, child_id, backend, role?, permission_mode? }`、`{ kind: background, job_id }` 或 `{ kind: foreground, run_id, output[], stop_reason? }`。
`subagent_fork` 只提供 native 子集（`description`、`prompt`、`model`、`persona`、`toolFilter`、`cwd`、`provider`、`run_in_background`）—— 没有 `backend` / `role` / bridge 参数，传入任何一个都会大声报错。

## 配置

配置挂在本插件 `cordis.patch.yml` 贡献的 `subagents` insert 行上。校验为 zod strict：未知 / 拼错的键在 apply 时大声失败。

### 完整插件配置

工具面：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolNames.delegate` | string | `subagent` | 委派工具名 |
| `toolNames.fork` | string | `subagent_fork` | fork 工具名 |
| `register.delegate` … `register.agents` | boolean | `true` | 各工具的注册开关（delegate / fork / submit / progress / wait / roles / agents） |
| `presetRow` | boolean | `false` | `true` 切换为官方 preset 行形状（见下） |

native 委派默认（作用于 delegate 工具；fork 工具从 `fork` 块读取同名字段）：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | string | `'spawn'` | delegate 工具的子代理 provider |
| `enableRunInBackground` | boolean | `true` | 是否提供 `run_in_background` |
| `backgroundMode` | `'one-shot' \| 'continuable'` | delegate `'continuable'` / fork `'one-shot'` | `run_in_background` 的默认路由（对齐官方 base 行） |
| `agentOptions` | object | — | 子代理默认选项 `{ provider?, model?, maxTokens? }` |
| `persona` | string | — | 默认 persona 文本或 `@preset:<id>` |
| `toolFilter` | object | — | 默认 `{ allow?: string[], deny?: string[] }` |
| `maxDepth` | 正整数 \| `'provider-managed'` | `3`（driver 侧） | 委派深度上限；数值时逐请求下发，`'provider-managed'` 时不下发（由 provider 自治），省略时驱动侧默认为 3（对齐官方 `.default(3)`） |
| `presetHints` | string[] | — | 展开进 `persona` 参数 description 的 preset 清单 |
| `fork` | object | — | fork 工具覆盖：`provider`（默认 `'fork'`）、`backgroundMode`、`enableRunInBackground`、`agentOptions`、`persona`、`toolFilter`、`maxDepth` |

bridge（自前身全量保留）：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `providers` | record | — | 新增 / 覆盖 provider：`{ type?: 'claude' \| 'codex' \| 'grok' \| 'acp', command?, args?, env?, timeoutMs? }`；任意 ACP CLI 零代码接入。裸名 `grok` 是**用户**的键（既有部署即 ACP 传输，且 `~/.dsh/subagents-registry.json` 存有 `backend: "grok"` 的持久会话）—— 用户自定义的 `grok` 条目完全不受影响、按名优先；原生协议桥以独立内置 `grok-native` 注册，`grok` 与 `grok-native` 可并存 A/B。零迁移、零 resume-id 启发式（ACP remoteId 喂给原生 `--resume` 会得到 clap exit-2 永久错误） |
| `registryPath` | string | `~/.dsh/subagents-registry.json` | 持久注册表路径 |
| `idleTimeoutMs` | ≥ 0 整数 | `600000` | 结算后的 bridge 子代理闲置多久释放远端会话（`0` 禁用） |
| `maxConcurrentChildren` | 正整数 | `8` | 正有一轮任务在跑的 bridge 可续续子代理上限（native 后台走 harness jobs，不占名额） |
| `relayReportGuard` | boolean | `true` | D2b 回合闭环校验：relay 子代理本回合未调 `subagent_submit` 就 report 时拒绝该调用（模型收到纠正性错误后仍可转发再 report）；`false` 恢复不校验的旧行为 |
| `redactSecrets` | boolean | `true` | 对捕获的 CLI stdout/stderr 与各 bridge 返回的最终文本脱敏（Bearer token、`sk-` 密钥、GitHub PAT、`api_key=` 赋值、JWT 五种形态）；`false` 恢复字节精确透传，供确有需要的部署使用 |
| `maxDispatchPermissionMode` | `'readonly' \| 'default' \| 'full'` | `'full'` | 引擎级派发缝（`ctx.get('subagentsDispatch')`，见下节）的 permissionMode 部署上限：程序化 bridge 派发请求更高档位时大声拒绝、绝不静默降级。缺省 `full` 与工具面 root 调用者对齐（真正的边界是委派天花板）；设 `readonly` 即让缝只剩只读派发 |
| `rolesDir` | string | 包内 `roles/` | 角色库目录 |

迁移：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `legacyProductAliases` | `'auto' \| boolean` | `'auto'` | 注册 `product_submit` / `product_delegate` 别名工具，让从迁移后注册表恢复的前身 relay 子代理继续可用；旧子代理消亡后可关闭 |

### preset 行配置（`presetRow: true`）

当 preset 行被改写为本插件（L2 `--enhance-rows`）时，该行配置按**官方工具行形状**校验：`provider`（必填）、`toolName`（默认 `subagent`），加上共享的 native 字段（`enableRunInBackground`、`backgroundMode`、`agentOptions`、`persona`、`toolFilter`、`maxDepth`、`presetHints`）。bridge 侧的键一律拒绝 —— preset 行实例是 native-only 且无状态的（provider、注册表与辅助工具属于唯一的全局实例）。`toolName` 必须与全局实例的 delegate/fork 名及其它 preset 行不同（如 `plan_agent`、`scout_agent`）。相应地，L2 适配器只改写 `provider: spawn` 且 `toolName` 独立命名的行，**删除**无法诚实承载的官方行（通用 `subagent`/`subagent_fork` 行、`provider: fork` 行、bridge 模板行）—— 留下的不可改写行会遮蔽全局工具，而不诚实的改写会在挂载时挂在本节校验上、把整个 preset 拖垮。

### 角色

角色文件是 `rolesDir` 下的 JSON；角色 id 就是文件名。未知角色 id 大声报错（列出可用角色）；只有省略 role 才默认 `general`（角色库缺失 general 时自动合成兜底）。

角色（roles/）与 harness 官方 agent presets（`dsh-agent-presets`，rc.7 能力）是正交概念：角色塑造本插件的委派方式（后端、权限档、native overrides），preset 则是子代理 `persona` 可经 `@preset:<id>` 引用的人格包 —— 引用由本插件的 persona 缝解析。两个方向都无需迁移，可自由组合。

```jsonc
{
  "description": "何时用此角色（展示给委派模型）",
  "backend": "native",          // 'native' | bridge provider 名 | '' = 调用方选择
  "permissionMode": "full",     // bridge 专属；readonly < default < full
  "allowDelegation": true,      // relay 子代理是否可再委派
  "instructions": "前缀进任务文本的额外指令",
  "overrides": {                // native 专属默认（逐次调用参数仍可覆盖）
    "agentOptions": { "provider": "newapi", "model": "glm-5.3" },
    "persona": "…（或 @preset:xxx）",
    "toolFilter": { "deny": ["write", "edit"] },
    "maxDepth": 1
  }
}
```

默认角色集：

| id | backend | permissionMode | allowDelegation | 用途 |
|---|---|---|---|---|
| `general` | `''`（调用方选择） | full | true | 默认角色；调用方选后端 |
| `explore` | native | — | false | 只读侦察：`deny: [write, edit]`、`maxDepth: 1` |
| `code-review` | native | — | false | 审查人格 + 只读 toolFilter |
| `debug` | native | — | true | 允许再派一层只读助手 |
| `codex-full` | codex | full | true | bridge 示例：全权 codex |
| `claude-readonly` | claude-code | readonly | false | bridge 示例：plan 模式审查 |
| `grok-native-full` | grok-native | full | true | bridge 示例：全权 grok（原生 streaming-json 桥） |

## 引擎级派发缝（Engine-level dispatch seam）

除模型面工具外，全局实例还提供一条**引擎级程序化派发缝**：让插件代码（非模型
工具调用）以受控 `permissionMode` 派发 bridge 任务 —— 这正是官方
`ctx.subagents.start` 通道结构性做不到的事（其 `SubagentStartRequest` 没有
settings 概念；`permissionMode` / `reasoningEffort` 只随本插件的 bridge
settings 通道流动）：

```js
const dispatch = ctx.get('subagentsDispatch')
if (dispatch?.available) {
  const outcome = await dispatch.dispatchAgentTask({
    backend: 'codex',                       // 必填：bridge provider 名
    task: 'Review the diff and report.',    // 必填：自包含任务文本
    parent: exec.agent,                     // 必填：委派父 live Agent
    label: 'review node',                   // 可选：展示标签（回显）
    role: 'codex-full',                     // 可选：角色 id（无缺省角色）
    settings: {                             // 可选：远端设置
      permissionMode: 'readonly',           //   显式 > role.permissionMode > 'default'
      model: 'gpt-5-codex',                 //   直通
      reasoningEffort: 'high',              //   直通
    },
    cwd: '/abs/worktree',                   // 可选：绝对路径远端 cwd（缺省 parentCwd(parent)）
    signal: controller.signal,              // 可选：取消信号（贯穿任务提交 submit）
  })
  // → { backend, runId, label?, text, stopReason }
}
```

本缝**bridge 专精、one-shot**（`create → submit(settings) → dispose`，await
到终态；零 registry/binding 写入 —— 已 dispose 的远端没有恢复语义）。
`backend: 'native' | 'spawn' | 'fork'` 被大声拒绝并重定向到官方
`ctx.subagents.start`；缝不 wrap、不替换官方服务。`available` 表示是否至少
装配成功一个 bridge driver；`backends()` 列出它们的名字。native 专属参数
（`persona` / `toolFilter` / `maxDepth` / `provider` / `outputSchema` /
`maxTokens`）按名拒绝。

每次派发都过**两道权限闸**（都 loud，绝不静默降级）：

1. **委派天花板** —— 以 `parent` 查活 binding ∪ 持久 registry（与
   `subagent` 工具同一并集）：bridge 子代理（如 readonly）经任何插件之手
   派发都抬不了自己的权限；未知存量档位 fail closed 到 `readonly`。
2. **部署上限** —— `maxDispatchPermissionMode`（缺省 `full`）封顶整条缝
   可请求的档位。

派发还**占并发槽**：与可续续 bridge 子代理共用同一只 `maxConcurrentChildren`
池（合成键 `dispatch:*`，全程持有、必然释放），in-flight 派发与 continuable
子代理同受这只 cap 计数治理。注意合成键不是 harness 会话：它不会出现在
`subagent_agents` 的 children 列表里（该列表来自 `ctx.subagents.listChildren`）
—— in-flight 派发只能经由它占住的池被间接感知。

**Orchestrator 集成注记**：把本缝与编排器自身的并发准入（如
`maxRunningAgents`）组合时，实际 bridge 并发是两者的 **min** —— 请配置
`maxConcurrentChildren ≥ maxRunningAgents`。本缝**无内置超时**：取消靠调用方
的 `signal`（abort 后 bridge 以 `stopReason: 'aborted'` 结算）。bridge
one-shot 没有 `outputSchema` 概念，bridge 任务上不要声明结构化 `outputs`。
缝只由全局实例 provide；仅装 presetRow 行的部署里
`ctx.get('subagentsDispatch')` 恒为 undefined（无状态，红线 10）。完整设计
记录见 [docs/dispatch-seam.md](docs/dispatch-seam.md)。

**姊妹仓库。** 两个同族插件消费本插件的缝，并设计与本插件组合使用：

- [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator) —— 基于 worktree 隔离任务的 DAG 编排；其执行层绑定本插件的派发缝 / subagent 工具族，其 worktree 任务依赖本插件把 `request.cwd` 转发到各任务的 worktree 目录。
- [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees) —— 并行写隔离 + 串行 merge queue；其组合示例把本插件的逐次调用 `cwd` 参数指向某个 worktree，让被委派的子代理在该 worktree 中工作。

## 升级 dsh / npx 缓存漂移

经 npx 安装的 dsh 住在 npx 缓存根（`~/.npm/_npx/<hash>/`）里。npx 重新解析依赖或缓存清理时，live 根会**静默切换** —— 旧根（连同打好的 cwd 补丁）被整体弃用且毫无报错，`dsh-tools` 符号链接则变成悬空。两个症状（DESIGN §6.4.5）：

1. **逐次调用 `cwd` 大声拒绝（旧形态为静默失效）** —— 旧根（连同打好的 cwd 补丁）被整体弃用后，`patches/.applied` stamp 里记录的 `liveRoot` 不再匹配当前根，native 驱动的 stamp 门控会带双路径与修复指引地 throw（而不是让未打补丁的 harness 静默丢弃 `cwd` 字段、子代理回退父 cwd 还记成功）。
2. **所有工具调用阵亡**，报
   `Cannot read properties of undefined (reading 'prepare')` —— 悬空的 `dsh-tools` 链接解析出第二个模块实例。

**任一症状 → 重跑 `./patches/install.sh`**（或先跑 `./patches/verify.sh` 看清漂移）。**升级 dsh 之后**同样重放这份清单：

```sh
./patches/install.sh     # 针对新 live 根重打链接与补丁
./patches/verify.sh      # 确认健康
# 重启 dsh,开新会话
```

`~/.dsh` 下的 preset 副本不受换根影响。安装器动态解析 live 根（`which dsh` → realpath → 上溯到 `node_modules`；可用 `DSH_HARNESS_ROOT` 显式覆盖）—— 绝不硬编码缓存路径。

stamp 门控自身也在做同样的动态校验：`patches/.applied` 只对它点名的那一个 live 根有证明力，所以 native 驱动每次放行 `cwd` 前都会把 stamp 里的 `liveRoot` 与「当前根」比对 —— 当前根在 JS 侧按 `resolve-root.sh` 同一套逻辑解析（从本插件实际链入的 `@deepseek-ai/dsh-tools` peer 的真实落点上溯到 `node_modules` 的父目录）。外来 stamp（历史上曾随 npm tarball 泄漏，现已从打包白名单排除）、npx 漂移后的旧 stamp、缺失 `liveRoot` 字段的残缺 stamp，一律 loud 失败并指引重跑 `install.sh`。

### 同路径 npx 原地刷新：需警惕的 cwd 静默失效

上面的换根漂移是**大声**失败（stamp `liveRoot` 失配、链接悬空）。npx 的另一种行为则**静默**失败，是 stamp 门控唯一防不住的情形：

npx 可能在**同一路径原地刷新**缓存 —— `~/.npm/_npx/<hash>/` 路径不变、依赖重新解析、文件被替换。stamp 里的 `liveRoot` 仍然匹配（路径从未变过）、补丁状态仍记 `applied`，cwd 门控因此放行 —— 但被替换的新 harness 文件上没有补丁，`request.cwd` 被静默丢弃：子代理回退到父会话的 cwd 运行，任务还被记成成功。

- **症状：** 升级 / 刷新 dsh 后（例如新版 `@deepseek-ai/dsh` 被重新解析进同一个缓存槽位），逐次调用 `cwd` 不再有任何效果 —— 无报错，子代理就是跑在父 cwd 上。
- **恢复：** 重跑 `./patches/install.sh`（幂等：对当前文件重新应用两枚补丁、保留 `.bak_cwd` 备份、提交前对每个目标跑 `node --check` 校验）。跑一次即恢复逐次调用 `cwd`；重启 dsh、开新会话。
- **核实：** `./patches/verify.sh` 复查两枚补丁锚点；`--probe` 经 live 子代理路径重跑行为探针。
- **已知局限 / 纪律：** stamp 门控校验两枚补丁状态与 `liveRoot` 路径，但不比对 stamp 里的 `dshVersion` 或文件 mtime —— 原地刷新后两者看起来都健康。请把**每次升级 / 刷新 dsh 后重跑 `install.sh`** 当作常设纪律，而不是可选项。

## 设计说明

完整细节见 [docs/DESIGN.md](docs/DESIGN.md)；速览版：

- **`SubagentDriver` 抽象。** 两类后端实现同一个 driver 接口；所有差异都显式化为能力标志（`cwd`、`persona`、`toolFilter`、`llmRoute`、`maxDepth`、`permissionMode`、`reasoningEffort`、`continuable`、`backgroundJob`、`durableResume`、`promptInjectionGuard`）。native 覆盖前一组；bridge 覆盖 `permissionMode` / `reasoningEffort` / `continuable` / `durableResume` / `promptInjectionGuard`。工具层按矩阵校验参数，不匹配即大声 throw —— 绝不静默降级。生命周期词汇复用 harness seam（`subagent/start|end` 事件、`stopReason` 词表、`AbortError` / `TimeoutError`）。
- **cwd 补丁为什么存在。** rc.6 与 rc.7 的 `SubagentStartRequest` 都没有逐次调用的 `cwd` 字段 —— 而逐次调用的 `model` / `provider` / `persona` / `toolFilter` 都是原生 request 字段、无需补丁。只有 `cwd` 需要帮助：恰好两枚最小锚定补丁，各打一个建子路径的合并点（one-shot 驱动独立包 `dsh-subagent-in-process-driver`，与 `dsh-subagent` bundle 内联的 continuable 管理器）。安装器对每枚补丁跑四态状态机 —— applied / 幂等 / `native-verified` / 大声漂移 —— 其中「dsh 已原生支持」只能经**硬双闸**记入：人工核实的版本白名单（rc.6/rc.7 初始为空）AND 经 live 子代理路径实测子会话 `meta.cwd` 的行为探针。两闸缺一不可；任一失败都大声报错（d1 锚失配漂移 → 需新版本插件；d2 白名单未证实 → `verify --probe`）。正是这道闸让「cwd 静默失效」永远不会被误判成原生支持。
- **`dsh-subagent` 导入是纯函数白名单。** 运行时存在两份 `@deepseek-ai/dsh-subagent` 实体副本（harness 的与本仓库 peer 安装的）。本插件只从自己的副本导入纯函数（`assertSubagentMaxDepth`、`settleRun`）—— 无模块态、无 Symbol 身份 —— 一切服务访问走 `ctx`。该副本**有意不**符号链接到 live 根：过期的实体副本照样给出正确的纯函数，而 npx 换 hash 后悬空的链接会让整个插件加载失败（我们已知的最脆失效模式）。`npm run lint` 强制执行该白名单。
- **脱敏默认开在捕获边界。** 脱敏器（移植自 task-weaver `redact.ts`）在 CLI stdout/stderr 被捕获的那一刻（`lib/run.js`）与 ACP 桥直连 stdio 的文本进入缓冲处洗掉五种常见秘密形态，另对每个 bridge 返回的最终文本做幂等兜底。任务文本**入向不脱敏** —— 只洗回来的输出。被脱敏后不再能解析为 JSONL 的行会被丢弃、绝不原文透传（fail closed）。`redactSecrets: false` 恢复字节精确输出。
- **grok 桥在无字面 `--` 的情况下防住 flag 注入。** grok 1.0.4 的 clap 解析器拒绝 `-p -- <task>`，因此任务文本以**附值**形态传输：`--single=<task>` —— `=` 之后的一切是一个字面 prompt 值，解析器永不把它重析为 flag（已对本机安装的 CLI 实测：以 `-` 开头的任务仍是任务文本）。这在 grok 自身解析器约束下保住了设计规则 7 的实质（规则 7 字面形态的唯一获准例外，已在 AGENTS.md 注明）；所有真正的 flag 值（model、sessionId 等）仍经与 claude/codex 桥相同的标识符白名单。该桥以内置 **`grok-native`** 注册 —— 裸名 `grok` 归用户 `config.providers` 所有（既有部署即 ACP 传输，其持久注册表会话继续原样工作）。
- **共享状态单实例持有。** binding、注册表与并发槽只存在于唯一的全局 `apply()` 实例；`presetRow` 实例无状态，因此 preset 行改写与全局实例可以安全并存。

## 开发

```bash
npm install
npm run setup:peer     # 链接正在运行的 harness 的 @deepseek-ai/dsh-tools（见上）
npm test               # node:test —— 纯逻辑 + fake bridge/driver/ctx
npm run lint           # node --check 全模块 + dsh-subagent 导入白名单检查
```

测试套件绝不依赖真实 CLI、密钥或网络 —— 只用 fake 即可全绿。CI 在 macOS/Ubuntu/Windows × Node 18/20/22 上跑完整套件（`npm ci` → `npm run lint` → `npm test`），发布构建使用 trusted-publishing（`--provenance`）。架构见 [docs/DESIGN.md](docs/DESIGN.md)，任务分解见 [docs/TASKS.md](docs/TASKS.md)。

## 安全

这是**配置即信任边界**的工具：它会启动你配置的任何 CLI，`full` 档会传递产品自己的「绕过所有权限检查」标志。见 [SECURITY.md](SECURITY.md)。

## License

MIT
