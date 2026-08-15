# dsh-plugin-subagents — 统一子代理插件 · 架构设计

> 状态：设计定稿（已含用户拍板的 4 项决策）。实现前请配合 `docs/TASKS.md` 阅读。
> 前身：`legacy-cwd-plugin`（可配置原生子代理）+ `legacy-bridges-plugin`（外部 agent 桥接）。
> 本文所有机制结论均来自对 rc.6 安装（`~/.npm/_npx/1e7f6d9597241db0/`）与两个前身仓库源码的实际阅读，关键依据随文标注。

---

## 0. 已拍板决策（不再作为开放问题）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 插件名 | `dsh-plugin-subagents`（仓库 / npm 包 / 安装标识统一） |
| D2 | 工具面策略 | **接管官方工具名**：通过自身 bundle patch（`cordis.patch.yml`）禁用官方 `tool-subagent` / `tool-subagent-fork` 行，注册扩展后的 `subagent` / `subagent_fork`（参数扩展 `backend` / `role` 等），模型习惯零迁移 |
| D3 | 与 legacy-bridges-plugin 的关系 | **完全取代**：吸收其全部能力（bridges、角色库、permissionMode 天花板、durable registry、relay 模型、run.js、submit 管道）；README 明确安装时移除旧 host-plane 行 |
| D4 | 默认后端 | **native**：`subagent` 不指定 `backend`/`role` 时走原生 in-process 子代理（行为对齐官方工具 + per-call 覆盖增强）；外部 agent 经 `backend` 参数或显式 role 选择 |

本设计在此之上补充定案：**relay 管道工具统一命名为 `subagent_submit`**（理由见 §5.2）。

---

## 1. 目标与非目标

### 1.1 目标

1. **统一抽象、分开实现**：一个 `SubagentDriver` 接口覆盖两类后端，工具面同构。
2. **native 后端**：继承 `legacy-cwd-plugin` 全部能力 —— per-call `model`（含 `provider/model` 组合 id）/ `provider` / `persona`（含 `@preset:` 引用）/ `toolFilter` / `cwd` 覆盖。
3. **bridge 后端**：继承 `legacy-bridges-plugin` 全部能力 —— claude / codex / 通用 ACP bridges、角色库、permissionMode 映射与委派天花板、durable registry、relay 只读管道、跨平台 `run.js`、`config.providers` 零代码接入任意 ACP agent（如 grok）。
4. **单一工具面**：一套 `subagent*` 家族工具同时服务两类后端。
5. **可安装性**：一条安装路径覆盖 headless 与 web 两种形态（含 preset 适配与 cwd 补丁分发），升级 dsh 后可重放。

### 1.2 非目标（scope 边界）

- **不修改两个前身仓库的任何文件**；新仓库独立演进。
- **不做官方包补丁之外的黑魔法**：cwd 转发仅限 `patches/` 中两个锚定补丁（见 §6.4），不改 dsh 源码树其它内容，不 hook 官方包内部函数。
- **不实现 out-of-process / 远程子代理传输**（harness 已列为 deferred work，见 `@deepseek-ai/dsh-subagent` README "Known Limitations"）。
- **不接管 `send_message` / `list_agents` / `interrupt_agent` / `report`**：官方 `tool-subagent-control` / `tool-subagent-report` 行继续提供，native 与 relay 子代理都依赖它们。
- **不给 ACP 强加 permissionMode**：ACP 无可移植权限标志，维持 legacy-bridges-plugin 的立场（provider `args` 自配 + `requestPermission` 一律拒绝，见其 `lib/bridges/acp.js` 头注）。
- **不迁移旧插件的 durable relay 子会话的对话内容**：仅做 registry 记录迁移与兼容别名（§6.6），不重写历史会话。
- **不内置任何真实 CLI 依赖到测试**：测试套件必须无 CLI、无密钥可跑绿（继承 legacy-bridges-plugin AGENTS.md 红线）。

---

## 2. 现状分析（两个前身 + harness 机制）

### 2.1 legacy-cwd-plugin（bundle 型，483 行核心）

- **机制**：`package.json` 声明 `dsh.bundle.patch → ./cordis.patch.yml`。该 patch 层：
  1. `- id: tool-subagent / tool-subagent-fork` `disabled: true`（禁用官方行，headless 必需，见 §2.3-C）；
  2. `- insert:` 两个自身行（`provider: spawn|fork`、`toolName: subagent|subagent_fork`、`backgroundMode`、`presetHints`）。
- **工具实现**（`lib/index.js`）：
  - Config 与官方 `@deepseek-ai/dsh-tool-subagent` 完全同形（官方 `lib/index.js` L22–L37：`provider/toolName/enableRunInBackground/backgroundMode/agentOptions/persona/toolFilter/maxDepth`），**超集仅增加 `presetHints`** —— 这是 preset 行可直接把 `name` 从官方包改写为本包（配置兼容替换）的原因。
  - per-call 覆盖：`persona`（`@preset:<id|显示名>` 从 `<dshHome>/.agent-presets/<id>/agent.cordis.yml` 读 `id: persona` 行的 `config.text`）、`model`（`resolveModelRoute` 拆 `provider/model`）、`toolFilter`、`provider`、`cwd`（`assertCwd`：绝对路径 + 可访问目录）。
  - 路由：`resolveDelegationRun` → 前台 `ctx.subagents.start` + `settleForegroundRun`；一次性后台经 `ctx.get('jobs')` 包 `SubagentRun`；可续续走 `ctx.subagents.startContinuable` 返回 `childId`。
  - 挂载模式：监听 `subagent/provider-added|removed` 事件惰性 mount/unmount 工具（Cordis 并行加载下注册顺序不可假设 —— 官方 dsh-subagent README L95 同样强调）。
- **cwd 补丁**（`patches/01-in-process-driver.patch`、`02-subagent-bundle.patch`）：`SubagentStartRequest` 无 `cwd` 字段（已核实 `dsh-subagent/lib/types/types.d.ts` L91–L140），而 `CreateAgentOptions.meta.cwd` 是 dsh-session 认可的合法字段（`dsh-agent/lib/types/index.d.ts` L69–L80 "validated absolute cwd"）。补丁仅把 `request.cwd` 透传进两条建子路径的 `meta`：
  - 前台：`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js` L181（`childSessionMeta` 合并点）；
  - 可续续：`@deepseek-ai/dsh-subagent/lib/index.js` **bundle 内联的 continuation manager**（L806 附近；注意 `lib/types/continuation.js` 不是运行实体 —— bundle 陷阱）。
  - `install.sh/ps1`：锚定串替换、幂等、`.bak` 备份、`node --check` 验证、锚失配拒绝盲打。
- **已知缺口**：README 提到 `install-preset.sh` 但仓库只有 `install-preset.ps1`（POSIX 版缺失）；preset 适配只支持 `standard` 源。

### 2.2 legacy-bridges-plugin（host-plane 插件，~2700 行）

- **加载形态**：普通依赖 + profile `cordis.patch.yml` `- insert:` 行（当前 web profile 即此形态）。`apply(ctx, config)` zod-strict 校验（`lib/config.js`）。
- **relay 模型**：bridge 子代理 = harness 可续续子代理 + 中继人格 + 只读 toolFilter（`allow: ['product_submit'(+ 'product_delegate')]`）。真实工作在远端 CLI。
- **provider 契约**（`lib/index.js` L169–L213）：`{ name, inheritsParentContext: false, capabilities: { persona: true, toolFilter: true }, start(request)（一次性直连 bridge）, prepareContinuable(request)（建 remote + binding + registry + start guard） }`，经 `ctx.subagents.registerProvider` 注册，仅对 PATH 检测到的 CLI 注册（`availability.js` 并行 which/where，从不执行 CLI）。
- **Bridge 契约**（`docs/ARCHITECTURE.md` + `lib/bridges/*.js`）：`create(cwd,signal)` / `submit(remote,task,signal,cwd,settings)` / `reconnect(sessionId,cwd,signal)` / `dispose(remote)`；`settings = { model?, reasoningEffort?, permissionMode? }`。claude：预分配 UUID `--session-id`、`--resume`、`--permission-mode plan | --dangerously-skip-permissions`；codex：JSONL 增量捕获 `thread.started`、`resume <thread_id>` 子命令、`-s read-only | --dangerously-bypass-approvals-and-sandbox`；acp：持久进程 + `session/new|load`、`session/cancel` + 宽限强杀、`extNotification` 吸收厂商通知（grok `_x.ai/*`）、`readTextFile` realpath 限制在 cwd 子树、`writeTextFile` 诚实拒绝。
- **会话连续性三层**：内存 binding（per-apply Map）→ durable registry（`~/.dsh/product-subagents-registry.json`，0600 原子写、500 条上限、`__proto__` 防护）→ `PRODUCT_SESSION:` 日志 marker（**仅展示**）。恢复鉴权只认 binding-or-registry；恢复必须还原 `settings`（权限天花板），无 remoteId 的条目授权新会话。
- **权限天花板**（`lib/tools/product-delegate.js`）：`PERM_RANK = { readonly:0, default:1, full:2 }`；调用者是 product 子代理（binding 或 registry 任一命中）时不允许后代权限高于自身；未知 permissionMode fail closed 到 readonly。
- **生命周期**：`subagent/start|end` 配对维护 `liveChildren` 并发槽（仅 bridge 用）；`subagent/end` → `idleTimeoutMs` 后释放远端；pending-start guard 60s 清孤儿；teardown 全量 dispose。`product_submit` per-child tail 队列防并发重连竞态。
- **测试**：`node --test` 纯逻辑 + fake bridge + fakeCtx（`test/tools.test.js` 的 `fakeCtx`/`fakeBridge` 模式），CI 三平台 × Node 18/20/22。
- **peer 陷阱**：`@deepseek-ai/dsh-tools` 以模块级 Symbol 注册调度器，第二物理副本 = 第二 Symbol → 全部工具调用死于 `Cannot read properties of undefined (reading 'prepare')`。`scripts/link-harness-dsh-tools.sh` 与 profile 的 `fix-dsh-tools-dedupe.sh` 都在做同一件事：symlink 到 harness 实例。

### 2.3 harness 机制验证结论（本设计的地基）

**A. 层序与加载**。profile = `dsh.profile.bundles` 顺序的 bundle patch 层栈 + profile 自身 `cordis.patch.yml` + `--patch` overlay（`dsh/lib/profile-boot-*.js` L75/L103）。`dsh plugin add` = pnpm add + reconcile：解析到 `dsh.bundle.patch` 声明的依赖**按依赖序追加**到 bundles 列表尾部（`dsh/lib/plugin-9h8shc4d.js` L46–L78）。⇒ 本插件的 patch 层必然排在 `dsh-base` / `dsh-web-app` 之后，其 disable/insert 都能生效。

**B. 工具注册表是 scope 分层的**（`@deepseek-ai/dsh-tools` `ToolRuntime.view()`，lib/index.js L2836–L2870）：某 scope 的可见面 = 全局层工具被祖先层（preset 层）**同名遮蔽**后、经各层 restrictions 过滤、再并入自身层。全局层同名重复注册才抛错（`NamedEntries` duplicate error，L2517）。 ⇒ 三条推论：
1. host-plane（全局层）新增**新名字**工具对所有会话可见（product_delegate、ssh_* 即证）；**无需 preset 适配**。
2. 要在 web 会话**替换** `subagent`/`subagent_fork` 这两个名字，必须动 **preset 层**（preset 层同名遮蔽全局层）—— preset 适配不可省（见 §6.3）。
3. headless（无 preset roster）下工具面在宿主组合，本插件 bundle patch 禁用官方行后即可替换（`dsh-base/cordis.patch.yml` 的 `tool-subagent` 行即宿主行）。

**C. web 模式工具面归 preset 所有**。`dsh-web-app/cordis.patch.yml` 显式 `disabled: true` 了 base 的全部模型可见工具行（含 `tool-subagent`、`tool-subagent-fork`），注释明确 "the subagents registry and its backends STAY in the host plane … What a preset chooses is which delegation TOOLS its agent sees"。`subagents` **注册表与 spawn/fork 后端始终宿主面单例**。

**D. preset 机制**（`@deepseek-ai/dsh-agent-presets` README）：preset 是目录 + `agent.cordis.yml`，standing scope 挂载一次，会话按 scope 父链加入；行内包名从宿主组合解析（user 目录下的 preset 也能引用 `@deepseek-ai/dsh-*`）；`copy(from,id)` 是唯一授权写入；`recompose` 仅限空白会话 ⇒ preset 适配 = 复制官方/用户 preset 后改写再让用户切换，新会话生效。
- 用户实际 preset `~/.dsh/.agent-presets/orchestrator` 不含通用 `subagent` 行，而是多行角色化 `dsh-tool-subagent`（`plan_agent`/`scout_agent`/`dev_agent`…，固定 agentOptions/persona/toolFilter/maxDepth）⇒ preset 适配必须同时考虑两种形态（§6.3 两级策略）。

**E. 子代理 seam 契约**（`@deepseek-ai/dsh-subagent/lib/types/types.d.ts`）：`SubagentProvider = { name, capabilities:{outputSchema,depthLimit,toolFilter,persona}, inheritsParentContext, start(request)→SubagentRun, prepareContinuable?(request)→{seed} }`；`SubagentRun = { id, localAgent, result:Promise<SubagentResult>, dispose() }`；`startContinuable({provider,label,request,signal})→{childId,messageId}`；`followup/interrupt/reportFrom/listChildren/listDescendants`；事件 `subagent/start|end`（一次性运行与可续续 epoch 同词汇）、`subagent/provider-added|removed`。**continuable 子代理由 continuation manager 全权拥有，provider 只提供 `{seed}`** —— relay 模型的正当地位来自此：bridge provider 在 `prepareContinuable` 里建远端会话与 binding，之后子代理的回合由 manager 驱动。

**F. `provider` 名称空间是进程级唯一的**：`registerProvider` 重名 fail loud。rc.6 安装内无官方 `codex`/`claude-code` provider（仅有 spawn/fork in-process），standard preset 里 `tool-subagent-codex` 等禁用行注释明确期待宿主面产品 provider 挂这些名 —— 本插件沿用裸名 `codex`/`claude-code`/`acp` 与 `config.providers` 键名。

---

## 3. 统一抽象层：`SubagentDriver`

### 3.1 设计原则

1. **接口取两者公共分母，差异全部显式化为 capability flags**，不做隐式降级（对齐 harness "fail loud, no silent degradation"）。
2. **生命周期词汇复用 harness seam**：`subagent/start|end` 事件、stopReason 词汇、`AbortError`/`TimeoutError` 错误名。driver 不发明第二套状态机。
3. **共享逻辑放 driver 之上**（角色解析、权限天花板、并发治理、registry），driver 只负责"怎么跑一个子代理"。

### 3.2 接口定义（TypeScript 风格签名）

```ts
/** 后端 id：native 用 'native:spawn' | 'native:fork'；bridge 用 provider 名（'codex' | 'claude-code' | 'acp' | config.providers 键） */
type BackendId = string

/** 能力声明 —— 工具层据此决定参数是否可见、不支持的参数如何失败（一律 loud error） */
interface DriverCapabilities {
  cwd: boolean               // per-call 工作目录（native：需 provider 补丁就位）
  persona: boolean           // per-call persona / @preset:（native）
  toolFilter: boolean        // per-call 子代理工具过滤（native）
  llmRoute: boolean          // per-call LLM 路由 provider/model（native）
  maxDepth: boolean          // 委派深度上限（native：harness depthLimit）
  permissionMode: boolean    // 远端产品权限档（bridge）
  reasoningEffort: boolean   // 远端产品推理档（bridge）
  continuable: boolean       // 可续续会话（native：continuable child；bridge：relay child）
  backgroundJob: boolean     // 一次性后台作业（native：jobs 集成；bridge：无需 —— relay child 天然后台）
  durableResume: boolean     // 跨重启恢复（native：harness session 持久化；bridge：durable registry）
  promptInjectionGuard: boolean // 任务文本恒走 '--' 之后 + flag 值白名单（bridge；native 不适用恒 true 语义缺省）
}

interface DriverInfo {
  id: BackendId
  kind: 'native' | 'bridge'
  /** 描述性（非强制）：子代理是否看到父会话完成回合（native fork = true，spawn/bridge = false） */
  inheritsParentContext: boolean
  capabilities: DriverCapabilities
  /** 可用性：CLI 是否在 PATH、登录产物是否存在（bridge）；provider 是否注册（native） */
  available(): DriverAvailability
}
interface DriverAvailability { registered: boolean; reason: string; auth?: { ok: boolean; note: string } }

/** 一次委派请求（工具层已完成 role 解析、instructions 前缀拼接、天花板校验） */
interface DelegateRequest {
  label: string                      // 3-5 词展示标签
  task: string                       // 已含 role.instructions 前缀的任务文本
  parent: Agent
  signal: AbortSignal
  /** 路由：'sync'（前台等结果）| 'job'（一次性后台作业）| 'continuable'（可续续子代理） */
  route: 'sync' | 'job' | 'continuable'
  native?: {                         // capabilities 不满足的字段出现即 throw（工具层先行校验，driver 兜底）
    provider: string                 // spawn | fork | 其它已注册 in-process provider 名
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    persona?: string
    toolFilter?: { allow?: string[]; deny?: string[] }
    maxDepth?: number | 'provider-managed'
    cwd?: string                     // 绝对路径；补丁未就位时由工具层以明确错误拒绝
  }
  bridge?: {
    provider: string
    settings: { model?: string; reasoningEffort?: 'low'|'medium'|'high'; permissionMode?: 'readonly'|'default'|'full' }
  }
}

/** stopReason 统一采用 harness 词汇（completed/aborted/error/max-tokens/refusal；bridge 外来值原样透传） */
type DelegateOutcome =
  | { kind: 'foreground'; runId: string; output: ContentBlock[]; stopReason: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'continuable'; childId: string; backend: BackendId; role?: string; permissionMode?: string }

interface ProgressSnapshot {
  childId: string
  status: 'running' | 'inactive' | 'stored' | 'unknown'
  label?: string
  turn?: number; stepCount?: number
  lastTask?: string; lastAnswer?: string; lastActivityAt?: string
  tokenUsage?: unknown
  /** bridge 专属字段（native driver 返回 undefined） */
  pinnedProduct?: string; remoteSessionId?: string
  inFlight?: { busySince?: string; stage?: string; receivedChars?: number; partialPreview?: string }
  model?: string; reasoningEffort?: string
}

interface SubagentDriver extends DriverInfo {
  /** 发起一次委派。一次性/前台路径在返回前 settle；job/continuable 立即返回句柄。 */
  start(request: DelegateRequest): Promise<DelegateOutcome>
  /** 可续续子代理的后续回合（bridge = 向远端会话提交；native = 提示模型用官方 send_message，本方法仅 bridge driver 实现） */
  followup?(childId: string, task: string, opts: { signal: AbortSignal }): Promise<void>
  /** 进度快照：两条路径共用 session-log 折叠 + bridge binding/registry 补充 */
  progress(childId: string): Promise<ProgressSnapshot>
  /** 释放一个子代理占用的后端资源（native：run.dispose / harness 自理；bridge：idle 语义由共享层调度，此方法用于显式释放） */
  dispose(childId: string): Promise<void>
}
```

### 3.3 生命周期与错误语义（两后端共同遵守）

| 阶段 | native | bridge | 统一语义 |
|---|---|---|---|
| 启动 | `ctx.subagents.start / startContinuable` | bridge provider `prepareContinuable` 或直连 `bridge.submit` | 失败在返回前完全回滚（harness seam 已保证；bridge 沿用其 provider 实现） |
| 运行 | harness Agent loop 驱动 | relay child 收到任务 → `subagent_submit` → 远端 | `subagent/start|end` 事件同词汇；并发治理见 §5.5 |
| 取消 | `exec.signal` / 官方 `interrupt_agent` | 同左（relay child 是真 continuable child） | abort → `AbortError`；超时 → `TimeoutError`；部分输出丢弃不冒充完整结果 |
| 恢复 | harness session 持久化冷恢复 | durable registry + `bridge.reconnect/create`（还原 settings） | 恢复鉴权：binding-or-registry only |
| 释放 | `SubagentRun.dispose()`（幂等） | `bridge.dispose`（claude/codex 无进程可清；acp 杀树） | teardown 全量释放 |

**错误分类**：① 参数/能力不匹配 → 同步 throw（如 bridge + `persona`）；② 后端不可用 → 启动前 throw（含 PATH 检测 reason）；③ 子代理级失败 → 结果对象 `stopReason ≠ completed`（不 throw）；④ 基础设施故障 → reject。与 seam 的 `SubagentResult` 契约一一对应。

### 3.4 两后端如何映射到接口

**NativeDriver（`lib/drivers/native.js`）**：
- 包一层"请求组装器 + 结果 settle 器"，即 `legacy-cwd-plugin/lib/index.js` 的 execute 主体抽出为可复用模块（`resolvePersona`/`resolveModelRoute`/`assertCwd`/`settleForegroundRun`/`settleStart`/`stopReasonError` 迁入）。
- `capabilities`：`{ cwd: true, persona: true, toolFilter: true, llmRoute: true, maxDepth: true, continuable: true, backgroundJob: true, durableResume: true }`；fork 实例 `inheritsParentContext: true`。
- `progress`：session 折叠（复用 `lib/progress.js` 的 `foldProgress/foldTrace/foldTokenUsage`，native 子代理的 session 事件同样可折）+ `ctx.subagents.listChildren`。
- 补丁就位检测：首次使用 `cwd` 时 grep 实例内 `dsh-subagent-in-process-driver` 是否含 `request.cwd` 标记（或记录安装脚本写入的 stamp 文件），未就位 → 明确错误指引跑 `patches/install`。

**BridgeDriver（`lib/drivers/bridge.js`）**：
- 每 provider 一个实例，持有 bridge 工厂句柄；`start` 三路由：`sync` → 直连 `bridge.create+submit+dispose`（不动 relay）；`continuable` → `ctx.subagents.startContinuable({provider, persona: relayPersona, toolFilter: {allow: ['subagent_submit'(, 'subagent')]}})` + binding/registry/persist；`job` → 不支持（capabilities.backgroundJob=false，工具层把 bridge + 后台路由折叠为 continuable —— product_delegate 现行为即如此，`background=true` 默认）。
- `capabilities`：`{ permissionMode: true, reasoningEffort: true, continuable: true, durableResume: true, promptInjectionGuard: true }`，其余 false。
- relayPersona 生成沿用 `providers.js` 的 `providerPersona`（文案里 `product_submit` 改为 `subagent_submit`）。

### 3.5 能力矩阵（模型可见参数 × 后端）

| 参数 | native | bridge | 不支持时的行为 |
|---|---|---|---|
| `model` | ✅ 裸 id 或 `provider/model` | ✅ 产品模型 id（白名单校验） | —（两后端都收） |
| `provider` | ✅ 子代理 provider（spawn/fork…） | —（用 `backend` 选产品） | loud error |
| `persona` / `@preset:` | ✅ | ❌（relay 人格固定） | loud error |
| `toolFilter` | ✅ | ❌（relay 恒只读） | loud error |
| `cwd` | ✅（需补丁） | ❌（用父会话 cwd） | loud error（补丁缺失时另给安装指引） |
| `maxDepth` | ✅（config 级） | ❌ | config 层忽略 + 文档说明 |
| `permission_mode` | ❌ | ✅（天花板校验） | loud error |
| `reasoning_effort` | ❌ | ✅ | loud error |
| `run_in_background` | ✅ 三路由 | ✅（等价 continuable） | — |

---

## 4. 安装形态方案（核心矛盾的解法）

### 4.1 结论：单包双面 —— bundle 型插件，一个 apply() 实例注册全部工具

**形态**：`dsh-plugin-subagents` 声明 `dsh.bundle.patch → ./cordis.patch.yml`（沿 legacy-cwd-plugin 形态）。`dsh plugin add dsh-plugin-subagents` 后 reconcile 自动追加层序（§2.3-A），其 patch 层：

```yaml
# 1) headless 形态：禁用官方委派工具行（web 形态下 web-app 层已禁用，此处幂等）
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true

# 2) 注册统一工具面：单一插件实例持有全部共享状态（bindings/registry/roles/drivers）
- insert:
    - id: subagents
      name: dsh-plugin-subagents
      config:
        toolNames: { delegate: subagent, fork: subagent_fork }
        register: { delegate: true, fork: true, submit: true, progress: true, wait: true, roles: true, agents: true }
        # 以下为 bridge 侧配置（与旧 legacy-bridges-plugin profile 行同构，迁移即拷贝）
        idleTimeoutMs: 600000
        maxConcurrentChildren: 8
        # providers: { grok: { type: acp, command: grok, args: [agent, --always-approve, stdio] } }
```

**为什么单实例**：`subagent_submit`（binding/registry/并发槽/idle 调度）与 `subagent`（委派入口）必须共享同一份内存状态；若拆多行加载多实例，状态割裂（legacy-bridges-plugin 的 `createBindings()` per-apply 注释即为此防御）。工具是否注册由 `register` 开关控制，默认全开。

**为什么必须 bundle 型而非纯 host-plane insert**：要在 headless 替换官方行必须 disable `tool-subagent`/`tool-subagent-fork`（§2.3-B3），而 disable 只能来自 patch 层 —— 包内 `cordis.patch.yml` 是唯一"安装即带、随包升级"的载体；host-plane insert 行做不到这件事。同时 bundle 行本身就是 host-plane Cordis 插件实例，两种身份兼得。

### 4.2 各形态生效矩阵

| 形态 | `subagent`/`subagent_fork` | 辅助工具（submit/progress/wait/roles/agents） | bridge 委派 | 需要的动作 |
|---|---|---|---|---|
| headless（无 preset roster） | 本插件（官方行已被 bundle patch 禁用） | 本插件 | ✅ | 仅安装 + 可选 cwd 补丁 |
| web + `standard`（未适配） | **官方版遮蔽本插件**（preset 层 > 全局层） | 本插件（新名字不被遮蔽） | ❌（root 无入口） | 跑 preset 适配（§6.3-L1） |
| web + 适配后副本（如 `standard-plus`） | 本插件（副本已删同名行） | 本插件 | ✅ | 适配脚本 + 切换 preset + 新会话 |
| web + `orchestrator` 类（无通用 subagent 行） | 本插件（全局层直接可见） | 本插件 | ✅ | 无需适配；可选 L2 增强（§6.3-L2） |

### 4.3 与旧插件/同族插件的互斥

- **移除旧 legacy-bridges-plugin**：安装本插件时从 profile `cordis.patch.yml` 删 `- id: legacy-bridges-plugin` 行 + `pnpm remove legacy-bridges-plugin`。不删则 `product_submit`/`product_delegate`/`product_roles` 等与新工具并存（全局层同名不冲突，但双份 bridge provider 名 `codex`/`claude-code`/`acp` **会在 `registerProvider` 处 fail loud**，进程起不来 —— 这是有意的强制互斥）。
- **与 legacy-cwd-plugin / dsh-subagent-tools 互斥**：同为接管官方行的 bundle，双方都会尝试在全局层注册 `subagent` → duplicate error。README 用对齐 legacy-cwd-plugin 的"二选一"表格说明。

---

## 5. 统一工具面

### 5.1 工具清单

| 工具 | 来源 | 说明 |
|---|---|---|
| `subagent` | 接管官方名 | 统一委派入口。默认 native（D4）；`backend`/`role` 切后端 |
| `subagent_fork` | 接管官方名 | native fork（继承父会话上下文），per-call 覆盖 + cwd；bridge 不支持（loud error） |
| `subagent_submit` | 改名自 `product_submit` | relay 子代理的远端管道（§5.2 定案理由） |
| `subagent_progress` | 沿用（原名即 subagent_） | 进度/trace/token；**扩展支持 native 子代理**（session 折叠本就通用） |
| `subagent_wait` | 改名自 `product_wait` | 事件驱动等待子代理 settle；native/bridge 通用 |
| `subagent_roles` | 改名自 `product_roles` | 角色库目录（含 backend 维度） |
| `subagent_agents` | 改名自 `product_agents` | 可用性总览：bridge CLI 检测 + native provider + 在册子代理 |

官方 `send_message`/`list_agents`/`interrupt_agent`（tool-subagent-control）与 `report`（tool-subagent-report）不动，两类子代理通用。

### 5.2 `subagent_submit` 命名定案

**结论：统一为 `subagent_submit`，全家族 `subagent_*` 前缀，彻底退役 `product_*` 词汇。**

理由：
1. **与 D2 一致的整体性**：接管策略让 `subagent` 成为唯一委派入口，relay 子代理的 toolFilter 白名单将同时引用 `['subagent_submit', 'subagent']` —— 混用两套前缀（product_submit + subagent）会让模型把一个系统误读为两个。
2. **模型认知负荷**：`product_*` 与 `subagent_*` 并存暗示两套平行能力，恰是本插件要消除的心智模型。
3. **无兼容包袱**：D3 完全取代 + 旧插件卸载，唯一残留是旧 durable relay 子会话 —— 用一次性 registry 迁移 + 可选 legacy 别名工具兜底（§6.6），不构成保留旧名的理由。

### 5.3 `subagent` 工具 schema（归一后）

```
description        string  required  3-5 词展示标签
prompt             string  required  完整自包含任务（fork 语义下表述为"在其已见的会话之上只说新内容"）
backend            string  enum [native, <detected bridge providers>]  默认 native 或 role.backend
role               string  enum [<roleIds>]  默认 general
model              string  native: 裸模型 id 或 provider/model 组合（切换 LLM 路由）
                           bridge: 产品模型 id（白名单校验后传产品自有 flag）
reasoning_effort   string  enum [low, medium, high]  bridge 专属
persona            string  native 专属；支持 @preset:<id|显示名>（presetHints 展开进 description）
toolFilter         object  {allow?, deny?}  native 专属（覆盖实例/角色默认）
cwd                string  native 专属；绝对路径；需 cwd 补丁
permission_mode    string  enum [readonly, default, full]  bridge 专属；受委派天花板约束
provider           string  native 专属；子代理 provider 覆盖（默认实例配置 spawn/fork）
run_in_background  boolean 默认随 backgroundMode（delegate=continuable→true；fork=one-shot→false）
```

输出 schema：`oneOf [{kind:'continuable', childId, backend, role?, permissionMode?}, {kind:'background', jobId}, {kind:'foreground', runId, output[]}]`；bridge 一次性路径映射为 `{kind:'foreground', output:[{type:'text',text}]}`（沿用旧 product_delegate 同步模式）。渲染沿 legacy-cwd-plugin 的 `outputValueText`。

**校验次序**（execute 内，全部 loud）：
1. role 解析（未知 role 报可用列表；省略 → `general`）；
2. backend 归并（显式 > role.backend > `native`）；role 与显式 backend 冲突 → error；
3. 参数-能力矩阵校验（§3.5）；
4. bridge：可用性检测 + 权限天花板（`assertWithinCeiling`，caller=binding∪registry 命中即 product 子代理）；
5. native：persona/@preset 解析、model 路由拆分、cwd 断言、maxDepth 能力检查；
6. 组装 `DelegateRequest` → driver.start。

`subagent_fork` schema = 上表去掉 bridge 专属参数与 `backend`/`role`（fork 无角色语义，保持官方极简面 + per-call 覆盖）。

### 5.4 relay 子代理的 toolFilter（红线 1 的延续）

`allow: ['subagent_submit']`；`role.allowDelegation` 时追加 `'subagent'`。在任何 preset 下，两个名字对 relay 子代理都必须可见：
- 适配后/无通用行的 preset：全局层本插件提供；
- 未适配 standard：preset 层官方 `subagent` 顶名（native-only 降级可用），`subagent_submit` 来自全局层 —— 均在继承面内，restriction 校验可通过。

### 5.5 共享治理（driver 之上）

- **并发槽**：仅 bridge continuable 占槽（`liveChildren` 严格配对 + `endedAt` 防重复占槽，照搬现实现）；native 后台走 harness jobs，harness 自治。
- **idle 释放 / pending-start guard / teardown**：bridge 专属，行为不变。
- **权限天花板**：bridge 委派统一在工具层校验（`PERM_RANK`、fail closed、恢复还原 settings）。native 子代理的权限由 harness delegated policy（sandbox/approval 继承 + 子代理审批恒 'never'）治理 —— 两个体系互不越界，文档明示该不对称。

---

## 6. 配置、角色与安装流程

### 6.1 config schema（zod strict，`lib/config.js`）

```ts
{
  // —— 工具面 ——
  toolNames?: { delegate?: string; fork?: string }          // 默认 subagent / subagent_fork
  register?: { delegate?: boolean; fork?: boolean; submit?: boolean; progress?: boolean; wait?: boolean; roles?: boolean; agents?: boolean }  // 默认全 true
  presetRow?: boolean          // preset 适配 L2 行载入时置 true：只注册本行 toolName，不注册 provider/辅助工具
  presetHints?: string[]       // 展开进 persona 参数 description
  // —— native 委派默认（同官方/ legacy-cwd-plugin 行配置；作用于 delegate 工具，fork 可用 fork.* 覆盖）——
  provider?: string            // 默认 'spawn'
  enableRunInBackground?: boolean
  backgroundMode?: 'one-shot' | 'continuable'   // delegate 默认 continuable，fork 默认 one-shot（对齐官方 base 行）
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number | 'provider-managed'
  fork?: { provider?: string; backgroundMode?: 'one-shot' | 'continuable'; enableRunInBackground?: boolean; agentOptions?: object; persona?: string; toolFilter?: object; maxDepth?: number | 'provider-managed' }
  // —— bridge（原 legacy-bridges-plugin 全量保留）——
  providers?: Record<string, { type?: 'claude'|'codex'|'acp'; command?: string; args?: string[]; env?: Record<string,string>; timeoutMs?: number }>
  registryPath?: string        // 默认 ~/.dsh/subagents-registry.json
  idleTimeoutMs?: number       // 默认 600000
  maxConcurrentChildren?: number  // 默认 8
  rolesDir?: string            // 默认包内 roles/
  // —— 迁移 ——
  legacyProductAliases?: 'auto' | boolean   // 默认 auto：探测到旧 registry 条目时注册 product_submit/product_delegate 兼容别名
}
```

strict：未知键 fail loud（含中文报错文案沿 legacy-bridges-plugin 风格）。`presetRow: true` 时 schema 分支校验为官方行形状（`provider/toolName/...`，见 §6.3-L2）。

### 6.2 角色 schema（`roles/*.json`，id = 文件名，未知 role 大声失败）

```jsonc
{
  "description": "何时用此角色（展示给委派模型）",
  "backend": "native",            // 'native' | bridge provider 名 | ''（调用方选择；省略 = 'native'）
  "permissionMode": "full",       // bridge 专属；readonly < default < full
  "allowDelegation": true,        // relay 子代理是否可再委派
  "instructions": "前缀进任务文本的额外指令",
  "overrides": {                  // native 专属默认（per-call 参数仍可覆盖）
    "agentOptions": { "provider": "newapi", "model": "glm-5.3" },
    "persona": "…（或 @preset:xxx）",
    "toolFilter": { "deny": ["write", "edit"] },
    "maxDepth": 1
  }
}
```

默认角色集（两类后端各示例）：

| id | backend | permissionMode | allowDelegation | 要点 |
|---|---|---|---|---|
| `general` | `''` | full | true | 省略 role 时的默认；调用方选后端 |
| `explore` | native | — | false | 只读侦察：toolFilter deny write/edit、maxDepth 1 |
| `code-review` | native | — | false | 审查人格 + 只读 toolFilter |
| `debug` | native | — | true | 允许再派一层只读助手 |
| `codex-full` | codex | full | true | bridge 示例：全权 codex |
| `claude-readonly` | claude-code | readonly | false | bridge 示例：plan 模式审查 |

（内置 `general` 兜底沿 legacy-bridges-plugin：rolesDir 缺失/无 general 时合成。）

### 6.3 preset 适配（两级）

**L1（默认，解决遮蔽）**：`scripts/install-preset.sh|ps1`
1. 定位 DSH_HOME 与源 preset（参数指定，默认 `standard`）；
2. 复制到 `$DSH_HOME/.agent-presets/<source>-subagents`（幂等：已含本插件标记则跳过）；
3. **删除副本中的通用委派行**：`id: tool-subagent` / `tool-subagent-fork`（即 `name: '@deepseek-ai/dsh-tool-subagent'` 且 `toolName` 为 `subagent`/`subagent_fork` 的行）→ 全局层本插件工具直接可见（§2.3-B2 推论的逆向利用：删掉遮蔽者即可）；
4. 写 `preset.yml`（name `<源名>+subagents`）；提示用户在 UI 切换（`recompose` 仅限空白会话，README 说明需新会话）。
   —— 相比 legacy-cwd-plugin 的"改写行 name"方案，L1 不产生第二个插件实例，无状态割裂/重名风险；补 legacy-cwd-plugin 缺失的 POSIX 版。

**L2（opt-in，`--enhance-rows`，服务 orchestrator 类 preset）**：把副本中所有 `name: '@deepseek-ai/dsh-tool-subagent'` 行改写为 `name: 'dsh-plugin-subagents'` + 追加 `presetRow: true`。本插件 apply() 在 presetRow 模式下：只注册该行 `toolName` 的工具（native 语义 + 全部 per-call 增强 + cwd），不注册 provider / 辅助工具 / 不读 bridge 配置（provider 由全局实例注册，seam 是进程级服务，跨实例解析无碍；全局实例缺失时 bridge 委派给明确错误）。**多 presetRow 实例并存安全**：无 provider 重名注册、无辅助工具重名注册、registry/binding 仅全局实例持有。
   —— 保留用户 orchestrator preset 的"每行一个 (角色,模型) 组合"模式并获得 cwd/@preset/per-call 增强。

### 6.4 cwd 补丁分发（照搬 ship，两平台补齐）

`patches/01-in-process-driver.patch` + `patches/02-subagent-bundle.patch` + `install.sh|ps1` + `uninstall.sh|ps1`：锚定替换、幂等、`.bak`、`node --check`、锚失配拒绝。目标与锚点与 rc.6 完全一致（§2.1）。安装脚本顺带写 stamp（`<pkg>/patches/.applied`，记录 dsh 版本与目标文件 mtime），native driver 的 `cwd` 能力检测优先读 stamp。

### 6.5 统一安装 / 升级流程

```sh
# 1. 安装（自动追加 bundle 层并禁用官方行）
dsh plugin --profile web add dsh-plugin-subagents     # 或 add <本地路径>
# 2. 移除旧插件（D3；防 provider 重名 fail loud）
#    - 编辑 ~/.dsh/profiles/web/cordis.patch.yml 删除 - id: legacy-bridges-plugin 行
#    - cd ~/.dsh/profiles/web && pnpm remove legacy-bridges-plugin
# 3. peer 单实例（必须；见 §8-R2）
~/.dsh/profiles/web/fix-dsh-tools-dedupe.sh           # 或包内 scripts/link-harness-dsh-tools.sh
# 4. cwd 能力（可选，需要 per-call cwd 才装）
./patches/install.sh | patches\install.ps1
# 5. web 会话 preset 适配（standard 类 preset 需要）
./scripts/install-preset.sh standard | scripts\install-preset.ps1 standard
# 6. 重启 dsh --profile web，开新会话
```

**dsh 升级后**：重跑 3（npx 缓存目录变了）与 4（node_modules 被重写冲掉补丁）；preset 副本在 DSH_HOME 下不受影响。bundle 层与 peerDependencies 版本契约同 legacy-cwd-plugin（`^0.1.0-rc.6` 一组 peer）。

### 6.6 旧 registry 迁移与 legacy 别名

- `apply()` 首载：若 `~/.dsh/subagents-registry.json` 不存在且 `~/.dsh/product-subagents-registry.json` 存在 → 原子导入其条目（补 `backend` 字段 = 条目 `product` 值）后写入新路径（旧文件保留不动，写 `.migrated` 标记防重入）。
- `legacyProductAliases: 'auto'`（默认）：导入发生且存在条目时，额外注册 `product_submit` / `product_delegate` 别名工具（同一 executor，参数名兼容旧 schema），让冷恢复的旧 relay 子代理的 toolFilter 白名单不至于指向不存在的工具名而失败。用户可在旧子代理自然消亡后关闭。

---

## 7. 模块布局

```
dsh-plugin-subagents/
├── package.json              # dsh.bundle.patch → ./cordis.patch.yml；deps: @agentclientprotocol/sdk, zod, yaml；peers: @deepseek-ai/{cordis,dsh-tools,dsh-subagent,dsh-agent,dsh-llm,dsh-session,dsh-jobs,dsh-home-paths}
├── cordis.patch.yml          # §4.1：disable 官方两行 + insert 单实例
├── lib/
│   ├── index.js              # apply()：config 校验、availability、drivers 装配、工具注册（register 开关）、生命周期、迁移、teardown —— 保持薄
│   ├── config.js             # zod strict（presetRow 双分支）
│   ├── drivers/
│   │   ├── types.js          # SubagentDriver 契约注释 + capability 常量（JSDoc 承载 §3.2 签名）
│   │   ├── native.js         # NativeDriver（spawn/fork 两实例）：请求组装 + settle + progress
│   │   └── bridge.js         # BridgeDriver：relay 组装、binding/registry 持有、三路由
│   ├── native-delegate.js    # 自 legacy-cwd-plugin 迁移的纯函数：resolvePersona/resolveModelRoute/assertCwd/settle*/stopReasonError/输出渲染
│   ├── bridges/              # 自 legacy-bridges-plugin 原样迁移：claude.js / codex.js / acp.js
│   ├── providers.js          # buildProviders/createBridgeFor/providerPersona（文案 subagent_submit 化）
│   ├── roles.js              # + backend/overrides 字段
│   ├── registry.js           # 默认路径改 ~/.dsh/subagents-registry.json；条目 + backend
│   ├── bindings.js           # MARKER 保持 'PRODUCT_SESSION:'（历史会话 marker 兼容）+ 注释更新
│   ├── run.js / availability.js / progress.js   # 原样迁移；progress 的 product_submit 匹配名改 subagent_submit（兼容旧名）
│   ├── ceiling.js            # PERM_RANK + assertWithinCeiling（自 product-delegate.js 抽出）
│   └── tools/
│       ├── subagent.js           # 统一委派（接管官方名）
│       ├── subagent-fork.js      # fork 变体
│       ├── subagent-submit.js    # relay 管道（原 product-submit）
│       ├── subagent-progress.js  # + native 支持
│       ├── subagent-wait.js      # 原 product-wait
│       ├── subagent-roles.js     # 原 product-roles
│       └── subagent-agents.js    # 原 product-agents + native provider 视图
├── roles/                    # §6.2 默认角色集
├── patches/                  # §6.4 两个补丁 + install/uninstall (sh+ps1)
├── scripts/
│   ├── install-preset.sh / install-preset.ps1   # L1/L2（§6.3）
│   └── link-harness-dsh-tools.sh                # peer 单实例
├── test/                     # node:test；fake bridge / fakeCtx / fakeDriver；不碰真实 CLI
├── docs/DESIGN.md  docs/TASKS.md
├── README.md  README.zh.md  CHANGELOG.md  AGENTS.md  LICENSE  SECURITY.md
└── .github/workflows/ci.yml  publish.yml   # 沿 legacy-bridges-plugin 矩阵
```

---

## 8. 风险清单与缓解

| # | 风险 | 依据 | 缓解 |
|---|---|---|---|
| R1 | **cwd 补丁与 rc.6 锚点耦合**：dsh 升级改写 bundle 形状 → 锚失配 | §2.1；README "Patches target rc.6 only" | 安装脚本锚失配即拒绝并提示；peerDependencies 版本契约挡住 API 漂移；stamp + 启动时能力检测给出"跑 patches/install"指引；发布流程包含新版本锚点验证任务 |
| R2 | **dsh-tools 双实例 Symbol 陷阱**：`TOOL_RUNTIME_SCHEDULER` 模块级 Symbol，第二物理副本 → 所有工具调用死 `reading 'prepare'` | legacy-bridges-plugin `scripts/link-harness-dsh-tools.sh` 注释；profile `fix-dsh-tools-dedupe.sh`；本会话 profile node_modules 已 symlink | README 安装步骤强制第 3 步；`apply()` 启动时自检：`ctx.tools` 上以本实例 Symbol 取 scheduler 为 undefined → 打印致命指引（检测到即说明双实例已发生） |
| R3 | **bundle（patch 层）与 host-plane 双机制维护成本**：disable 依赖行 id 稳定性；web-app 层序假设 | §2.3-A/C | patch 只引用 `dsh-base` 行 id（`tool-subagent`/`tool-subagent-fork`，rc 内稳定）；CI 加 `dsh --dump-config` 冒烟（可选）；每次 dsh 升级跑回归清单（TASKS T19） |
| R4 | **工具名接管冲突**：与 legacy-cwd-plugin/tools 双装 → 全局层 `subagent` duplicate error；与旧 legacy-bridges-plugin 双装 → provider 名 duplicate error | §4.3 | fail loud 本身是强制互斥（可接受）；README "二选一"表 + 安装命令里显式卸载步骤；错误信息可读化 |
| R5 | **preset 布局耦合**：L1 删除行依赖 standard 的行 id/结构；L2 依赖官方行 config 与本插件 Config 超集兼容 | §2.3-D | 适配脚本锚定 `name: '@deepseek-ai/dsh-tool-subagent'` + `toolName` 字段而非行 id；Config 永远保持官方超集（回归测试断言 schema 兼容）；锚失配 loud |
| R6 | **未适配 standard preset 的降级形态**：root 只有官方 subagent（无 bridge 入口） | §4.2 | `subagent_agents` 会显示 bridge 可用但入口被遮蔽 → 工具 description 提示跑 preset 适配；README 矩阵表 |
| R7 | **旧 durable relay 子代理恢复**：toolFilter 白名单指向已退役工具名 | §6.6 | registry 迁移 + auto legacy 别名（product_submit/product_delegate）；别名随旧条目消亡可关 |
| R8 | **未来官方产品 provider 落地**（如官方 `codex` provider 包）：与本插件 bridge provider 重名 | §2.3-F | `config.providers` 可改名注册（键即 provider 名）；冲突时 fail loud 信息指引用 providers 覆盖改名 |
| R9 | **并发/状态回归**：submit tail 队列、idle 释放、pending-start guard、endedAt 语义复杂 | §2.2 | 这些模块**原样迁移 + 原测试随迁**，重命名不做逻辑改动；新增 driver 层测试只测新增路径 |

---

## 9. 设计红线（继承 legacy-bridges-plugin AGENTS.md 7 条 + 新增 3 条）

1. relay 模型永远只读管道：子代理 toolFilter 只含 `subagent_submit`（+ 角色允许时的 `subagent`）。
2. permissionMode 只作用于远端产品，映射产品自有 CLI flag。
3. 权限沿委派树继承不可上调（readonly < default < full），未知 fail closed 到 readonly。
4. bridge 契约固定：`create/submit/reconnect/dispose`；新增产品 = 新 bridge + provider 条目；纯 ACP CLI 零代码接入。
5. 跨平台：所有 CLI 启动走 `lib/run.js`（Windows `.cmd` shim、`/d /s /c` 外层引号、`taskkill /T /F`）；路径 `join()`+`fileURLToPath`。
6. registry 是唯一恢复源；`PRODUCT_SESSION:` marker 仅展示；恢复必须还原 settings（权限天花板）。
7. 任务文本永远在 `--` 之后；flag/config 值白名单（`safeFlagValue`/`safeConfigValue`）。
8. （新增）**能力不匹配永远 loud error，绝不静默忽略参数**（§3.5）。
9. （新增）**Config 保持官方 `dsh-tool-subagent` 超集**，preset 行可无缝改写指向本包（§6.3-L2 的前提）。
10. （新增）**共享状态单实例持有**：binding/registry/并发槽只存在于全局 apply() 实例；`presetRow` 实例无状态。

---

## 10. 测试与文档要求（摘要，任务级细化见 TASKS.md）

- `node --test`：纯逻辑 + fake bridge + fake driver + fakeCtx；**禁止真实 CLI/密钥**；CI 三平台 × Node 18/20/22。
- 关键新增覆盖：driver 能力矩阵（不支持参数 → throw）、backend/role 归并次序、天花板（native 调用者不受 bridge 天花板约束）、L1/L2 适配脚本对样例 preset 的幂等改写、registry 迁移、legacy 别名、config strict。
- 文档：README.md / README.zh.md 同步更新（安装矩阵 §4.2、二选一表、升级重放清单）、CHANGELOG、AGENTS.md（红线继承）。
