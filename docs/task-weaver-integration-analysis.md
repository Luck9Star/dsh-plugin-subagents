# task-weaver → DSH 插件化整合分析

> 状态：分析结论（2026-08-16），作为后续拆分实施的事实基线
> 来源：三个并行分析子代理报告（适配器层对比 / 调度治理层拆分 / DSH 插件可行性）
> 上游项目：~/Documents/dev/Agents/task-weaver（Bun + TS monorepo，~45k 行，M0–M3 已交付）

## 0. 用户已拍板的决策

- **第一步**：P0 bridge 增强（本仓库内移植 redact + 新增 grok 原生 bridge）。
- **DAG 生命周期**：倾向「随宿主生死」——dsh-dag-orchestrator 插件自带 sqlite 持久化 + 重启对账，DSH 重开后断点续跑；不做独立进程浅集成。
- **grok 原生 bridge 命名（实施期裁决 2026-08-16）**：注册为独立内置 id **`grok-native`**（bridge type `grok`），绝不占用 `grok` 名字。原因：用户 web profile 的 config.providers 已把 `grok` 显式配为 ACP provider（`grok agent --always-approve stdio`），registry 有多条 ACP 签发 remoteId 的 backend:"grok" 旧会话；buildProviders 合并语义是用户配置按名覆盖内置（`{ ...BUILT_INS, ...(config.providers||{}) }`），若原生 bridge 抢占 `grok` 名，用户删除该 override 后旧会话 reconnect 会静默断裂。不做 reconnect 回退启发式（ACP id 与原生 id 无可靠区分）。

## 1. task-weaver 全景（事实）

- 「六层 Adapter」= L0–L5 六个 vendor Adapter 交付序（Codex→Grok→omp→pi→OpenCode→Claude Code），**不是**传输分层。每个 Adapter 由 manifest/probe/argv/adapter/parse/classify 六模块组成，其下是统一 ProcessManager（`agent-runtime/src/runtime.ts`）+ ACP substrate。
- 子系统规模：agent-runtime ~7k 行（7 vendor）；scheduler 15 文件 ~6.1k 行（CAS claim、每 Attempt 独立终态、事件同事务 + hash 链、多维资源租约）；workspaces 6 文件 ~3.0k 行（三模式隔离、lineage 租约、串行 merge queue、GitPort 唯一 git 出口）；审批治理 ~1k 行（不可变 action digest、CAS resolve、TOCTOU 防护、default-deny path policy）；persistence ~5.5k 行（bun:sqlite，22 表）。

## 2. 与 dsh-plugin-subagents 对比（互补性极强）

抽象方向相反：task-weaver 是「每 attempt 一次 spawn」的长驻多任务模型（重进程治理，POSIX-only）；dsh bridge 是单会话对话模型（create/submit/reconnect/dispose，重会话治理：registry/ceiling/relay，Windows 跨平台）。

### task-weaver 有、dsh 没有（迁移价值排序）

| 能力 | 源证据 | 价值 |
|---|---|---|
| 输出脱敏（5 种秘密形态，redact 先于一切缓冲/解析） | `agent-runtime/src/redact.ts`（57 行零依赖） | **P0**：dsh 无任何 redact |
| grok/omp/pi/opencode 4 个非 ACP 原生 CLI 适配 | `adapters/<v>/{argv,parse,classify}.ts` 纯函数 | **P0**（grok）/ P1（omp、pi、opencode）：omp/pi 共享 `pi-family/parse.ts`，一次移植三受益 |
| env 白名单投影（从不整体继承 process.env） | `src/env.ts` resolveSpawnEnv | 高，但必须 opt-in（dsh 现全量继承 run.js L108，直接切是破坏性变更） |
| 流式事件归一化（8 类 agent.* 事件含 usage/total_cost_usd） | 各 parse.ts + NormalizedAgentEvent | 中高（增强 subagent_progress） |
| 深度 probe（auth status + 能力格 + sha256 兼容摘要） | `_shared/probe-runner.ts` | 中（opt-in 诊断工具；不动「启动时从不执行 CLI」红线） |
| 错误分类（7 类 failureType + retryable，未知 fail-closed） | `src/classification.ts` | 中（DSH 无重试消费方，作诊断信息） |

### dsh 有、task-weaver 没有（移植时必须保留的纪律）

Windows 跨平台（.cmd shim + taskkill /T /F，`lib/run.js`）；零代码 config.providers 接任意 ACP CLI；跨重启 durable registry（「registry 唯一恢复源」红线）；权限委派天花板（readonly<default<full）；Claude 预分配 session UUID；`--` 任务文本终结符 + safeFlagValue/safeConfigValue 防注入。

## 3. 处置清单

- **直接移植**：`redact.ts`→`lib/redact.js`（接入 run.js 捕获与 bridge 返回文本）；`env.ts` buildEnv/resolveSpawnEnv（配置门控）；`argv.ts` summarizeArgv（诊断）。
- **改写吸收（进本仓库）**：grok/omp/pi/opencode 原生 bridge（照 `bridges/codex.js` 蓝本：每 turn 一次 spawn + 增量捕获会话 id——omp `-r`、grok `--resume <id>` 单用、opencode `run -s <id>`；**必须**保证任务文本不可翻转为 flag——grok 采用获准的 `--single=<task>` 附值形态，见 DESIGN §9 规则 7 例外注记；flag 值经 safeFlagValue；TS Result→throw）；parse 增强 progress（usage/tool 事件）；错误对象加 failureType/retryable；opt-in probe 诊断工具。
- **独立 DSH 插件**（拆分路线）：
  1. `dsh-worktrees`（纯 tool，最易：git-port.ts 585 行基本直搬，仅 merge-queue 一处 bun:sqlite 需换）——worktree 并行写隔离 + 串行 merge queue + 冲突保留现场；与 subagents per-call cwd 正交组合。
  2. `dsh-dag-orchestrator`（tool+UI 混合，工程量最大：建议吸收设计以 ~1.5k 行重写，可直搬 critical-path/bounded-queue/verify-gate ~550 行；执行层从 adapter CLI 换绑 DSH subagent 工具族；tick 改为按需调用的工具；随宿主生死：自带 sqlite + 启动对账）。若落地长时无人值守 DAG，审批作为其内部 task kind 吸收（照 task-weaver 建模 `kind: approval`）。
  3. ~~`dsh-approvals` 独立插件~~ **已裁撤（2026-08-16 用户裁决）**：task-weaver 审批为无人值守多 agent 并行而生；DSH 对话模型用户在环（ask_user_question）且原生已有 approval policy + 沙箱审批，独立插件是重复建设；pending 挂起语义与 DSH 同步工具协议的别扭正是模型不契合的证据。归宿：若 dag-orchestrator 需要，作为其 task kind 内置。
- **不整合**：AdapterManifestV1 体系（与 task-weaver scheduler 强耦合）；ProcessRecord 持久化（违反「registry 唯一恢复源」红线）；ACP substrate 整体替换（与 bridges/acp.js 重复）；omp/pi local_rpc（自述 turn 生命周期未实测）；PID 复用 marker（dsh 进程短命无意义）；独立 server/Web 控制台（与 DSH 单会话宿主模型冲突）。

## 4. DSH 落地硬约束（插件实施必读）

- **单包双面成立**：一个包同时注册 tools（`ctx.tools.register(defineTool(...))`）与 Web UI（package.json `dsh.client` + `exports."./client"`，宿主以 `/plugins/<id>/client.js` 提供浏览器 bundle）；dsh-ssh 是完整范例，工具与 UI 共享同一 engine 实例。
- **路由/进程/持久化**：REST→`ctx.webServer.register`；SSE→exact path handler 自持 res（aionui-panel 先例）；WS→`registerUpgrade`（dsh-ssh 先例）；进程一律 `ctx.subprocess.spawn`（已内置 SIGTERM→grace→SIGKILL 终止梯、offset 流读取、敏感 env 清洗）；持久化用 node:sqlite（DSH 自家 dsh-session-query-sqlite 在用，Node ≥22.5）或原子写 JSON（tmp+rename 0600）到 `~/.dsh/<plugin>/`。
- **C4 宿主退出杀全部子进程**：断点续跑必须在 apply() 内先做 sqlite 对账（先于 tool 注册）。
- **C6 peer 双实例陷阱**：新插件必须把 `@deepseek-ai/*` 声明为 peerDependencies 并 symlink 到 live harness 根（本仓库 `patches/install.sh` 模式），否则工具调用死于 `Cannot read properties of undefined (reading 'prepare')`。
- **C7 并发自建**：`maxConcurrentChildren` 是本插件私有 liveChildren Set，非宿主设施；task-weaver 的 Claim/Lease 资源准入需插件自带。
- **UI 无官方侧边栏 slot**：DOM 注入 + MutationObserver 自愈是家族现行范式（抄 dsh-ssh sidebar-entry.ts）；设置卡走官方 SlotMap slot。
- **apply() 返回值必须是 undefined**（Cordis 非 disposable 校验会抛 TypeError）。

## 5. 风险与注意

- R1 `Promise.withResolvers` 需 Node ≥22（本仓 CI 跑 18/20/22）——移植 line-stream 类代码需 polyfill 或手工 deferred。
- R2 TS strict（exactOptionalPropertyTypes / `#` 私有字段）→ Plain JS 是机械改写；parse/argv/classify 纯函数成本低，runtime.ts 不建议移植。
- R3 env 白名单默认继承、opt-in 收紧。
- R6 task-weaver 钉死 CLI 单版本（claude 2.1.220 / codex 0.146.0）；本仓 codex.js 已跟进 0.147 resume 子命令并保留旧形状回退——移植 parse 以本仓兼容层为准。
- R5 failureType/retryable 在 DSH 只能作诊断信息（无重试消费方）。
- R8 opencode HTTP serve 会话层在 task-weaver 自述未验证；若要 HTTP 模式需自行 spike。
- 多 dsh 实例并发下 sqlite 需注意文件锁（WAL）。

## 6. 已核实的环境事实（2026-08-16）

- 六个 CLI 全部在 PATH：grok 1.0.4、claude、codex、opencode、omp、pi。
- `~/.dsh/subagents-registry.json` 有多条 `backend: "grok"` bridge 会话记录——grok 原生 bridge 优先级有实测依据。
- Node v24.19.0（node:sqlite 可用）。
