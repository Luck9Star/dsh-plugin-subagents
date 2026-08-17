# dsh-plugin-subagents — 引擎级 dispatchAgentTask 缝（bridge 程序化派发）· 设计

> 状态：已实施（2026-08-16 设计定稿，同周落地 —— `lib/dispatch.js` / `lib/index.js` provide / `lib/config.js` cap 键 / `test/dispatch.test.js` §6.2 矩阵全绿；对齐 dag-orchestrator DESIGN §4.3-O2 拍板行）。
> 本文回答一个问题：**如何让插件代码（非模型工具调用）以受控 permissionMode 程序化派发 bridge 后端（claude-code / codex / grok-native / ACP）任务**。
> 所有机制结论均来自对本仓库 `lib/` 全链、DSH rc.6 宿主 `.d.ts`、消费方（dag-orchestrator）设计文档的实际阅读，关键依据随文标注（文件 + 行号）。

---

## 0. TL;DR

导出一个 Cordis 服务 `ctx.provide('subagentsDispatch', { dispatchAgentTask, available, backends })`。
`dispatchAgentTask({ backend, task, parent, settings?, role?, cwd?, label?, signal? })` 走
**one-shot 直连路径**（`bridge.create → bridge.submit(settings) → bridge.dispose`），完整复用
BridgeDriver 的 sync 路由与工具层的权限/并发治理逻辑；**bridge 专精**（native 派发继续走官方
`ctx.subagents.start`，本缝 loud 重定向）；不 wrap 不替换官方服务；只由全局实例 provide（红线 10）。

---

## 1. 问题与目标

### 1.1 问题实证：官方程序化通道无法携带 settings

DSH 官方的程序化子代理派发面是 `ctx.subagents.start(name, request)`（`@deepseek-ai/dsh-subagent`
`lib/types/index.d.ts` L259）。其请求类型 `SubagentStartRequest`（`lib/types/types.d.ts` L91–L140）
的字段全集是：

```
label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona?
```

其中 `agentOptions` 的类型 `AgentOptions`（`@deepseek-ai/dsh-agent` `lib/types/runtime-types.d.ts`
L21–L28，实读）为：

```ts
export interface AgentOptions {
    provider?: string;   // Provider route
    model?: string;      // Model id
    maxTokens?: number;  // Maximum output tokens
}
```

**没有 settings 字段** —— 即没有 `permissionMode` / `reasoningEffort` 的概念。这两个是外部产品
CLI 的概念，只随本插件的 bridge settings 通道流动。

而本插件 bridge provider 的一次性 `start()` 恰恰不带 settings（`lib/drivers/bridge.js` L288 注释
原文：「`start(request)`：一次性路径 —— create + submit（**settings 不经此路**：harness 的
SubagentStartRequest 无 bridge 设置概念）」；实现 L315–L337：`bridge.create(cwd)` +
`bridge.submit(remote, task, request.signal, cwd)`，第四参 settings 缺席）。settings 目前只随
relay/continuable 路径在 binding 补写（bridge.js L517–L523）。

**结论**：`permissionMode` 受控的程序化 bridge 派发，在官方通道上结构性不存在。本插件内部
的 settings 穿透链（工具层组装 → ceiling 校验 → `bridge.submit(remote, task, signal, cwd, settings)`
—— 各 bridge 映射产品自有 CLI flag，如 `lib/bridges/claude.js` L70–L79）是完整且现成的，
**只缺一个程序化入口**。这就是本缝。

### 1.2 目标消费方

1. **dsh-dag-orchestrator（首要，已在等这个缝）**：其 DESIGN §4.3 选项 B / §14 O2 拍板行
   （L749）明确「✅ 立项落地：subagents 侧导出引擎级 dispatch 缝（设计文档
   `dsh-plugin-subagents/docs/dispatch-seam.md`）；M1 仍 native-only + bridge 字段 loud 拒绝，
   bridge 执行器在该缝实装后接入（M2+）」。DAG 的 bridge 任务节点（codex/claude/grok-native
   跑 DAG 节点）需要 per-task `permission_mode` / `model` / `reasoning_effort`。
2. **未来任意插件**：任何需要「代码直连外部 agent CLI 且受权限天花板治理」的插件（批量审
   查流水线、定时巡检……）。缝是通用引擎面，不绑定 orchestrator 词汇。

### 1.3 非目标

- **不改变工具层语义**：`subagent` / `subagent_fork` 工具的 schema、校验次序、默认值一概不
  动（工具层是模型面，本缝是代码面；共享的只有被抽出的纯校验/组装函数）。
- **不做通用 RPC / 会话管理面**：不暴露 reconnect / dispose / 进度查询 —— 那些属于
  registry/binding 恢复体系与 `subagent_submit` 工具层。本缝只做「派发一个任务、拿到结果」。
- **不 wrap / 不替换官方 `ctx.subagents` 服务**（避免与宿主冲突；见 §5）。
- **不覆盖 native 后端**（见 §5 论证：native 无 settings 需求，官方通道已完备）。
- **不发明调用方认证机制**（进程内信任边界是 DSH 现状，文档化即可；见 §3.6）。

---

## 2. API 形状

### 2.1 完整签名（TypeScript 风格 JSDoc，落 `lib/dispatch.js`）

```ts
/** 引擎级 bridge 派发缝 —— 经 ctx.provide('subagentsDispatch', api) 暴露。 */
interface SubagentsDispatchApi {
  /** 是否有至少一个 bridge driver 装配成功（availability 检测通过）。 */
  readonly available: boolean;
  /** 已装配 bridge provider 名列表（等价 assembled.bridges.keys()）。 */
  backends(): string[];
  /** 派发一个 one-shot bridge 任务并 await 其结果。 */
  dispatchAgentTask(request: DispatchAgentTaskRequest): Promise<DispatchOutcome>;
}

interface DispatchAgentTaskRequest {
  /** 必填。bridge provider 名（必须是 assembled.bridges 中的键）。
   *  'native' / 'spawn' / 'fork' → loud error 并重定向到官方 ctx.subagents.start。 */
  backend: string;
  /** 必填。完整自包含任务文本（调用方自行组装；给 role 时追加 role.instructions 前缀）。 */
  task: string;
  /** 必填。委派父 live Agent —— 权限天花板的主体 + cwd 缺省来源。 */
  parent: Agent;
  /** 可选。3-5 词展示标签（仅回显进结果与日志；one-shot 无子会话可挂）。 */
  label?: string;
  /** 可选。角色 id —— 解析语义与工具层逐字相同（backend 锁定校验 / permissionMode 缺省 /
   *  instructions 前缀）。未知 id loud 报可用列表。 */
  role?: string;
  /** 可选。远端设置 —— 复用 bridge settings 形状（lib/drivers/types.js L72）。 */
  settings?: {
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
    permissionMode?: 'readonly' | 'default' | 'full';
  };
  /** 可选。远端会话 cwd（bridge.create 的启动目录 + registry 恢复锚点）。绝对路径。
   *  缺省 = parentCwd(parent)（与工具层 sync 路径完全一致）。 */
  cwd?: string;
  /** 可选。取消信号 —— 贯穿任务提交 submit（orchestrator 引擎自持 AbortController
   *  的对接点，其 DESIGN §4.2「signal: engine 自持，非 exec.signal」）。 */
  signal?: AbortSignal;
}

interface DispatchOutcome {
  /** 所用 bridge provider 名（回显）。 */
  backend: string;
  /** run id（driver sync 路由的 `${name}-${ts36}-${seq}`，bridge.js L479 同款生成）。 */
  runId: string;
  /** 调用方给的 label（给了才回显）。 */
  label?: string;
  /** 远端产品最终回答文本（经 redactSecrets 边界，见 §3.7）。 */
  text: string;
  /** stopReason —— harness 词汇（completed/aborted/error/…），外来值原样透传
   *  （lib/drivers/types.js L76–L77 同款约定）。 */
  stopReason: string;
}
```

### 2.2 逐字段论证（对照工具层 `lib/tools/subagent.js`）

| 字段 | 工具层对应物 | 程序化通道的取舍与论证 |
|---|---|---|
| `backend`（必填） | `args.backend`，归并序 显式 > `role.backend` > `'native'`（subagent.js L253–L259）；解析 `assembled.bridges.get(backend)`，未命中 loud 报可用列表（L261–L263） | **保留同一归并与同一 loud 错误**。差异仅一处：`'native'` 不再是缺省（本缝 bridge 专精，见 §5）——native 值出现即 loud 重定向到官方 `ctx.subagents.start`（红线 8：绝不静默改道）。必须存在于 `providerBridges`/`bridges`（装配层 `lib/drivers/index.js` L93–L99、L122–L126 已保证两表同键）。 |
| `task`（必填） | `args.prompt` → `task = role.instructions ? instructions + '\n\n' + prompt : prompt`（L272） | **保留 role 前缀拼接**（`role` 字段给出时）。调用方（如 orchestrator §7.4 的 promptWithInputs）自行组装数据内联与分隔符 —— 本缝不掺和 prompt 工程。task 非空字符串，否则 loud。 |
| `parent`（必填） | `exec.agent`（L322：`parent` 进 DelegateRequest） | **程序化通道没有 exec.agent，必须显式给**。三个用途：① ceiling 主体 —— 调用者是 bridge 子代理时按 `parent.session.id` 查 binding ∪ registry（L301–L303 同款并集）；② cwd 缺省 —— `parentCwd(parent)`（`lib/run.js` L160–L168）；③ 审计血缘。与 orchestrator §4.4 拍板的 parent 归属规则（挂当前 tick 调用方 `exec.agent`）严丝合缝 —— orchestrator 把它自己的 exec.agent 传进来即可。 |
| `label`（可选） | `args.description`（L320） | one-shot sync 路由里 label 不进 startContinuable（那是 continuable 才有的展示位，bridge.js L502），仅作结果回显与一行日志。可选、纯建议性。 |
| `role`（可选） | `args.role`，缺省 `general`（L243–L247：未知 loud 报列表） | **暴露但可选、无缺省角色**。理由：orchestrator §7.1（L444）把 agentProfile 平铺为 `backend/role/model/...` —— role 在消费方词汇里；且 role 是任务策略的单一声明源（backend 锁定 + permissionMode 缺省 + instructions）。程序化调用方多数自带策略（spec 字段），强制走 role 反而碍事；省略 role 时 permissionMode 缺省为 `'default'`（与工具层 L306–L308 的 fallback 链一致，只是没有 general 角色的 full 缺省 —— 程序化缺省取保守档）。 |
| `settings`（可选） | 工具层组装 `{ permissionMode, model?, reasoningEffort? }`（L314–L318）；permissionMode 解析序 `args.permission_mode > role.permissionMode > 'default'`（L306–L308） | **逐字段同形同序**。合并规则：`settings.permissionMode > role.permissionMode > 'default'`；`settings.model` / `settings.reasoningEffort` 直通。加固一处：工具层靠 schema enum（L150–L153、L175–L179）挡非法值，本缝没有 schema，**手工 enum 校验，未知 permissionMode / reasoningEffort → loud**（比工具层更严：工具层未知 requestedMode 在 ceiling 里 `?? 1` 当 default 处理，`lib/ceiling.js` L25 —— 代码面没有「模型笔误」容错空间，fail closed 更正确）。 |
| `cwd`（可选） | 工具层 **不暴露** bridge cwd（能力矩阵 §3.5：bridge cwd ❌「用父会话 cwd」） | **本缝唯一的 deliberate 扩展**，两级论证：① 底层契约本就自由收 cwd（`bridge.create(cwd)` bridge.js L316/L340；registry 条目有 `cwd` 字段供 reconnect，`persistRemote` L209–L218）；工具层把它钉死在父 cwd 只是模型面选择。② **正确性**：orchestrator O1 拍板 parent = 当前泵者（跨会话续跑 A 会话 plan、B 会话 tick）—— parent cwd 随泵者漂移，而 DAG 任务的 workspace 是 per-task 的（M3 worktree path）；bridge 任务的远端 cwd 不应取决于哪个会话碰巧在泵。校验复用 `assertCwd`（绝对路径 + 可访问目录，`lib/native-delegate.js` L28–L38）。省略 = `parentCwd(parent)`，与工具层逐字一致。**不改变工具层语义**（工具 schema 不加此参数）。 |
| `signal`（可选） | `exec.signal`（L323） | 程序化调用方自持取消（orchestrator §4.2：engine 自持 AbortController + 超时 timer）。缺省无取消。贯穿任务提交 submit —— driver sync 路由把它转传给 `bridge.submit`（bridge.js L475；`bridge.create` 不携带 signal，各 bridge 的 create 契约里仅 acp 有第二参消费）。 |
| ~~persona / toolFilter / maxDepth / provider / outputSchema / maxTokens~~ | native 专属参数（能力矩阵 `lib/drivers/types.js` L168–L176） | **不收**。bridge 后端能力声明恒 false（`BRIDGE_CAPS` L149–L161）；出现即 loud（红线 8）—— 直接在入口做参数白名单校验，消息含参数名（与 `assertParamsSupported` L214–L224 同款文案形态）。白名单的三个 bypass 面均已关闭（评审 F-8）：**符号键**经 `Object.getOwnPropertySymbols` 检查拒绝（`Object.keys` 只枚举字符串键，符号键原本被静默忽略，先封）；**原型链继承键**经原型检查拒绝（原型非 `Object.prototype`/null 即 loud，不解内容、拒原型面）——继承键既绕过 `Object.keys` 白名单枚举，又会被沿原型链的解构**实际消费**（继承的合法键如 settings 照样生效），两种形态都违背红线 8；`Object.create(null)` 无任何继承键、bypass 面为空，放行；**Object.prototype 污染面**（最后封）——进程内原型污染（缺陷 merge/deepClone 的赋值式污染产生可枚举键）会同时绕过白名单枚举与 `proto === Object.prototype` 快速路径并被解构消费，故该路径加 `Object.keys(proto).length > 0` 检查、命中即 loud fail-closed（污染期间所有 dispatch 拒绝，好于静默消费污染键；非枚举 `defineProperty` 污染属蓄意行为，超出意外污染面）。 |

### 2.3 返回形状：新窄形状，不对齐 DelegateOutcome 三态联合

`DelegateOutcome`（`lib/drivers/types.js` L79–L82）是三变体联合（foreground / job /
continuable），为工具层的多路由而生。本缝只有一条路径（one-shot await），返回单变体联合是
给代码消费者添解构噪音。定案：

- **新窄形状 `DispatchOutcome`**（§2.1）—— 从 foreground 变体压平：`output: ContentBlock[]`
  恒为单 text block（bridge.js L480：`output: [{ type: 'text', text: out.text }]`），压平为
  `text: string`；`runId` / `stopReason` 词汇与 DelegateOutcome 逐字相同（消费方映射表零学
  习成本 —— orchestrator §4.5 的失败映射直接按 stopReason 分支）。
- **基础设施故障 reject（throw）**，与 driver sync 路由一致（bridge.js L483–L486：dispose 后
  rethrow）。子代理级失败（远端产品报错/拒答）不 throw，走 `stopReason ≠ 'completed'` —— 与
  harness `SubagentResult` 契约同构（types.d.ts L204–L231：result 不因子级失败 reject）。
- 无 `structured`：bridge 一次性路径没有 outputSchema 概念（官方 SubagentStartRequest 的
  outputSchema 只进 native in-process 子代理；bridge provider `start()` 不消费它）。消费方
  侧影响见 §8 集成注记 ②。

### 2.4 one-shot 与 continuable：只暴露 one-shot（定案）

**one-shot（暴露，唯一模式）**：`bridge.create → bridge.submit(settings) → bridge.dispose`，
await 到终态。这正是官方通道做不到的事（settings 承载的一次性直连），也正是 orchestrator
DAG 节点的形状（dispatch → await / 收割 → 终态提交，其 §4.4 D8 选定的 promise 主体模型）。

**continuable（不暴露，论证）**：三条理由 —

1. **机械上可行但语义上是反模式**。continuable bridge 子代理是 relay 模型：真 continuable
   child 由 harness continuation manager 拥有（types.d.ts L293–L308 注释：provider 的唯一参与是贡献
   `{seed}`，continuation manager 全权拥有子代理），其后续回合靠 **子代理模型** 收到 inbox 消息后自己调 `subagent_submit`。代码
   调用方要用它，得经 `ctx.subagents.followup(parent, childId, content)`（index.d.ts L136）
   驱动一个**模型中继回合**来转发文本 —— 这正是 orchestrator §4.3 选项 C 明确否决的
   「伪 relay」形状（原文：「需要 model 驱动的中继回合，DAG 执行器是代码不是模型——引入
   伪 relay 复杂度且绕开天花板校验，否决」）。
2. **每回合白烧 relay 模型 token**，且引入 D2b 回合闭环防线（relay-guard）的整个复杂度面，
   换来的是代码本可直连的能力。
3. **无消费方**。orchestrator 不需要（其任务是一次 attempt 一次结果）；模型面要 continuable
   bridge 会话已有 `subagent` 工具（run_in_background 默认 continuable）。

> **扩展预留（写死在本文，防未来走样）**：若真出现代码面 continuable 需求，扩展形态必须是
> `mode: 'continuable'`，且**强制**走 driver continuable 路由的完整装配 —— relay persona
> （`providerPersona`，`lib/providers.js` L112–L124）+ 只读 toolFilter 白名单（bridge.js
> L496–L499）+ binding 登记 + `persistRemote` 含 settings（L517–L523，红线 6：恢复必须还原
> 天花板）+ 并发槽占位。绝不允许「无 relay 装配的裸 continuable」。

---

## 3. 权限与安全（核心章）

### 3.1 ceiling：天花板跟着委派树，主体 = `parent`

工具层的 ceiling 判定（subagent.js L294–L313）：以 `parent.session.id` 查
`bindings.get(id)` ∪ `registry.get(id)` —— 任一命中即「调用者是 bridge 子代理」，
`assertWithinCeiling({ callerSettings, callerIsProductChild, requestedMode })`
（`lib/ceiling.js` L21–L31）拒绝任何上调（`readonly < default < full`，未知 callerMode
fail closed 到 rank 0）。

**本缝逐字复用同一判定，主体就是传入的 `parent`**。这覆盖了关键场景：一个 bridge relay
子代理（readonly）若通过某插件间接发起 dispatch（parent = 该 relay child 的 Agent），
天花板照常生效 —— 「readonly 子代理借插件之手 spawn full 后代」被结构性堵死，红线 3
（权限沿委派树继承不可上调）在代码面无旁路。

- 调用插件**自身**不受 subagents 委派树约束（它不是 product child）—— 正确：插件是进程
  可信代码，与 root 会话同级（见 §3.6）。
- `assembled.state` 必须齐备 `bindings` + `registry`，缺失即 seam 创建时 loud（fail closed，
  逐字沿用 subagent.js L294–L299 的守卫语义，但提前到 provide 时刻 —— 加载期失败好过每次
  调用失败）。

### 3.2 新 config 键 `maxDispatchPermissionMode`：部署侧第二道闸

**来源问题**：DAG 节点的 permissionMode 来自 WorkflowSpec（spec 作者写的）；谁封顶？
parent-based ceiling 只约束「parent 是 bridge 子代理」的情形；parent 是 root 会话时工具层
放行 full（general 角色缺省就是 full）。程序化派发若完全对齐，部署就没有任何「插件派发
不得高于 X」的表达位。

**设计**：`lib/config.js` 全量分支新增

```
maxDispatchPermissionMode?: 'readonly' | 'default' | 'full'   // 缺省 'full'
```

生效规则：effective permissionMode（解析链同 §2.2 settings 行）经 **两道闸**，任一越界即
loud error（**绝不静默降级** —— 红线 8 的「参数绝不静默忽略」在权限上更适用）：

1. parent-based ceiling（`assertWithinCeiling`，原样）；
2. config cap：`rank(effective) > rank(maxDispatchPermissionMode)` → loud，文案指明「调大
   maxDispatchPermissionMode 或调低请求档位」（错误文案形态对齐 subagent.js L336–L339 的
   可行动风格）。

**缺省 full 的论证**（两案对比）：

- *缺省 full（选定）*：**与工具层 root 调用者对齐**。今天的部署里，主会话模型经 `subagent`
  工具即可派发 full-permission bridge 任务（general 角色 `permissionMode: 'full'`，角色库
  §6.2）；若 seam 缺省更低，orchestrator 的 bridge 任务会遭遇「模型能干、代码不能干」的莫
  名其妙失败 —— seam 严格弱于工具面的默认值是安全剧场（模型转头调工具即可绕过），不是
  安全。真正的边界在 parent-based ceiling（§3.1）。
- *缺省更保守（readonly/default）*：默认即拒绝 full 派发，部署必须显式提权。代价：与工具
  面不对齐 + orchestrator M2+ 接入时开箱即坏，逼每个用户改配置。

结论：**缺省 full + 提供收紧位**。保守部署设 `readonly` 即可让 seam 只剩只读派发能力。
（不另设 kill 开关：cap=readonly 已足够中和；彻底不要 seam 的卸载路径是不装本插件 —— 最小
配置面优先。）

### 3.3 registry / binding：one-shot 不登记 —— 与工具层 sync 路由逐字对齐

任务书前提是「dispatch 创建的 bridge 会话必须走 binding + registry」。**该前提对 continuable
成立、对 one-shot 不成立** —— 定案与论证如下：

- **工具层的 one-shot sync 路由本来就不登记**：driver sync 路由直连 create/submit/dispose
  （bridge.js L469–L487），显式注释「一次性前台运行不占并发槽、不动 relay」；binding 由
  provider 的 `prepareContinuable` 或 continuable 路由写入（L341、L517），sync 路径零登记。
- **红线 6 约束的是「可恢复会话」**：「registry 是唯一恢复源；恢复必须还原 settings」——
  前提是存在恢复语义。one-shot dispatch 的远端会话在返回前已 dispose，**没有任何东西存活
  到需要恢复**；给它写 registry 条目反而制造「指向已死 remoteId 的可恢复假象」，污染
  500 条上限的裁剪池（`lib/registry.js` L25 `MAX_ENTRIES`），稀释 registry 作为恢复源的
  信噪比 —— 那才是违背红线 6 的精神。
- **结论**：one-shot = 零 binding、零 registry 写入，与工具层 sync 完全同权同形。本缝的可
  恢复性边界 = 不可恢复（调用方持有一次性结果；崩溃即丢，orchestrator 的 orphaned 对账语
  义天然覆盖）。continuable 扩展（若未来落地）则**必须**按 §2.4 扩展预留走完整登记。

### 3.4 并发槽：占 —— 且占的是同一只 `liveChildren`

工具层规则（subagent.js L332–L341 + bridge.js L121–L125）：仅 bridge continuable 占
`maxConcurrentChildren` 槽（`state.liveChildren`，按 childId 严格配对）；sync 路由不占，理
由见 bridge.js L470–L471 注释「one-shot is synchronous and bounded by the caller's own
turn」。

**本缝定案：占槽。** 取舍论证：

- *不占的论据*（继承工具层 sync 理由）：一次性、有界、由调用方自己的回合/超时兜底。
- *占的论据（胜出）*：
  1. **工具层「有界」的前提对代码调用方不成立**。工具层 sync 的调用方是模型回合 —— 回合
     自身的预算天然串住并发；插件代码一次 tick 可以无上限地 fan-out N 个 one-shot
     dispatch（orchestrator 的 `maxRunningAgents` 是**它自己的**准入，本插件管不着；一个
     buggy/失控插件更是没有任何准入）。而每个 dispatch 是**真实子进程**（claude/codex CLI
     或 ACP 常驻进程）—— 资源消耗与路由无关。
  2. **红线 10**：并发槽是全局实例持有的共享治理态 —— seam 若不占槽，就是给「绕开并发
     治理」开了程序化旁路。
  3. **可见性边界（诚实表述）**：占同一只 Set 使 in-flight dispatch 与 continuable
     子代理受**同一只 cap 计数**治理，但合成键不是 harness 会话 child —— 它不会出现在
     `subagent_agents` 的 children 行里（该列表来自 `ctx.subagents.listChildren`，只含
     真实子会话；`busy` 字段按 child.id 查 `liveChildren`，合成键与真实 childId 无
     交集）。即 `subagent_agents` 看不到 in-flight dispatch 本身，只能经由「池被占满 →
     下一个 bridge continuable 被拒」间接感知。若未来需要直观可见，需要单独的可观测面
     （无消费方，YAGNI，不在本缝范围）。

**实现**：合成键 `dispatch:<state.nextSeq()>`（`nextSeq` 即 bridge.js L235–L240 的计数器）
加入 `state.liveChildren`；准入检查 `liveChildren.size >= maxConcurrentChildren` → loud
（文案对齐 subagent.js L337–L339）；**finally 释放**（settle 或 throw 都删键）。合成键带
`dispatch:` 前缀，与真实 child session id（UUID 形）无碰撞面；`attachBridgeLifecycle` 的
事件钩子按 `info.id` 操作（L372–L409），合成键永不出现于事件流，零干扰。检查+加键在任一
`await` 之前同步完成 —— JS 单线程下无 TOCTOU 窗口。

### 3.5 relay 红线 1：不受影响（论证）

红线 1 约束的对象是 **relay 子代理**（bridge continuable child）的工具面：toolFilter 恒
`['subagent_submit']`（+ 允许委派时的 `'subagent'`），永不加可写工具（AGENTS.md L68–L70）。

本缝 one-shot 路径**根本不创建 relay 子代理** —— 无 continuable child、无 relay persona、
无 relay toolFilter，`attachRelayGuard`（`lib/index.js` L193）的对象一个都不存在。任务执
行者是远端产品进程本身，不是任何 harness 子代理。红线 1 的管辖面（relay 模型可能被诱导
自答/越权）在此路径没有对象。

未来 continuable 扩展则**整个落回红线 1 管辖**（§2.4 扩展预留已写死 relay 装配义务）。

### 3.6 调用方身份与信任边界：进程内互信，不发明 token

**威胁模型澄清**：能 `ctx.get('subagentsDispatch')` 的调用方是**同进程的 Cordis 插件**。
Cordis 服务面（`@deepseek-ai/cordis` `lib/types/reflect.d.ts` L14–L16 / L41–L43：`get`/
`provide` 按 isolation scope 解析，store 是进程内 Map）没有跨进程语义；DSH 对插件服务的
信任模型就是进程成员制 —— 官方 `SubagentProvider` 文档明言「Providers are trusted
same-process implementations」（types.d.ts L260–L262），官方 `ctx.subagents` 服务本身同此。

**因此**：一个「任意插件」拿到访问器 ≠ 新威胁 —— 该插件本就可以直接调
`ctx.subagents.start`（官方面）、import 本插件私有模块、或自己 spawn CLI 进程。本缝相对
于这些既有能力，**增加的是治理（ceiling 检查 + config cap + 并发槽），不是新的裸能力**。
发明 token / capability 机制只会制造假安全（进程内代码可读一切内存）。

**seam 的真实防线分层**（文档化即全部实施）：

| 层 | 防什么 | 不防什么 |
|---|---|---|
| parent-based ceiling | 委派树内的权限上调（含 relay child 借插件之手的间接上调）——**这是安全边界** | 恶意进程代码 |
| `maxDispatchPermissionMode` | 部署策略：插件面整体不超过 X | 恶意进程代码 |
| 并发槽 | 失控 fan-out 的资源耗尽（含意外 bug） | 刻意绕过（进程代码可直接改 Set） |
| 进程成员制 | ——（继承 DSH 全部插件服务的共同边界） | 跨进程/沙箱外攻击者 |

**残余开放点**：dsh-cordis-host-runner 的工具沙箱面列出了 `ctx.provide` / `ctx.get`
（其 `lib/index.js` L634 沙箱白名单文案）—— 沙箱化 tool context 能否解析宿主面服务取决
于其 isolation scope 布置。即便能，该面同样已能触达 `ctx.subagents`（本缝未降低任何门
槛），且 seam 要求传入 live `Agent` 句柄（`parent.session.id` 参与 ceiling 判定）。列开放
问题 O-1 持续观察，不为此加锁。

### 3.7 输出脱敏与注入防线（继承，零新面）

- `redactSecrets`（默认 true）在 buildProviders 织入每个 provider def（`lib/providers.js`
  L77–L80、L92–L96），bridge 返回文本在 bridge 层已过 5 形态脱敏 —— seam 的 `text` 出品
  即已脱敏，无需 seam 级处理。
- 任务文本注入防线（红线 7）由各 bridge 的 `safeFlagValue` / `safeConfigValue` 与 `--` 传
  递纪律承担（如 claude.js buildArgs）；seam 把 task 原样交给 `driver.start` →
  `bridge.submit`，**不新增任何 flag 组装面**。

---

## 4. 暴露机制

### 4.1 provide 形状（worktrees §10 同款）

`lib/index.js` 全局实例装配段（现 L186–L201，`assembleDrivers` + `attachAll` 之后、工具注
册之前/后皆可，定在 attachAll 后一行）：

```js
ctx.provide('subagentsDispatch', createDispatchSeam({ assembled, config: cfg }))
```

- 服务名 `subagentsDispatch`：camelCase，对齐 orchestrator §11.2（L692）期望的
  `worktreesEngine` 命名风格与宿主先例（`dshHomePath` / `cmdlineArgs` / `appExit`，
  dsh-app-boot L1171、dsh-cmdline L28–L29 同款裸 `ctx.provide` 用法）。
- 值形状 `{ dispatchAgentTask, available, backends }` —— 与 orchestrator §11.2 期望的
  `{ ..., available: boolean }` 同构（多出的 `backends()` 是纯增益，不破坏探测）。
- **不要求消费方 `inject`**：orchestrator 侧机会主义探测 `ctx.get('subagentsDispatch')`
  （apply 时 + 每次使用时各探一次；缺席 loud 降级）—— 与 orchestrator §11.2 对
  worktreesEngine 的用法逐字同款（「不用 inject——它会把插件加载阻塞到依赖可用」）。
  本侧无动作，仅契约声明。
- fiber 卸载自动注销服务（reflect.d.ts provide 契约），无需手工 disposer。
- 同 scope 二次 provide 会 throw（reflect.d.ts L35「Throws if the name is already provided
  in this scope」）—— 双全局实例装载本就会被 bundle patch 单行 + 工具撞名挡住，此处
  throw 是又一道 fail-loud，符合预期。

### 4.2 presetRow 无状态实例：不 provide（红线 10）

`apply()` 的 presetRow 分支（`lib/index.js` L139–L168）在 provide 之前早已 `return` ——
该分支只装配 `createNativeDriver({kind:'spawn'})` + 空 `bridges: new Map()`（L157），没有
`assembled.state`（bindings/registry/liveChildren 不存在）、没有 bridge driver、没有可用性
探测。**红线 10（共享状态单实例持有）决定 seam 只能由全局实例提供**：state 是治理主体，
presetRow 实例没有也不能有第二份。

消费方视角：无全局实例的部署里 `ctx.get('subagentsDispatch')` 恒 undefined → 走其 loud
`*_unavailable` 路径（orchestrator §11.2 同款降级文案形态）。这是特性不是缺陷 —— seam 的
存在性如实反映「bridge 治理态是否在本进程」。

---

## 5. 与官方 `ctx.subagents` 的关系：不 wrap、不替换、桥专精

**不 wrap 不替换**：官方 `subagents` 服务（`SubagentRuntime`，index.d.ts）由宿主拥有，本插
件只在其上注册 provider（`registerProvider`，drivers/index.js L149–L151 经 attachAll）。
seam 用**新服务名** `subagentsDispatch`，与官方服务零名字冲突、零生命周期耦合 —— 卸载本
插件即消失，官方面完好。

**native 派发不进本缝（定案：桥专精）**，论证：

- native 没有本缝要解决的问题 —— `permissionMode` / `reasoningEffort` 是产品 CLI 概念，
  native 子代理不存在（能力矩阵：bridge 专属）。native 的 per-call 增强（persona /
  toolFilter / maxDepth / outputSchema）官方 `SubagentStartRequest` 原生支持（types.d.ts
  L91–L140），cwd 经 `request.cwd` 透传 + 补丁（本插件 DESIGN §2.1 证据链）。**官方通道对
  native 已完备，本缝加一层是纯转发**。
- 首要消费方已按此分工定型：orchestrator §4.2 native 绑定全链直用
  `ctx.subagents.start(task.backend ?? 'spawn', request)`；其 §14 O2 拍板「M1 仍 native-only
  + bridge 字段 loud 拒绝，bridge 执行器在该缝实装后接入」—— 即 native 走官方、bridge 走
  seam 正是其既定架构。统一入口包装两者只会迫使 orchestrator 改造已定稿的 M1 执行器。
- 桥专精让 seam 的每个字段都有实义（settings/ceiling/bridge 并发），无「此字段仅 native
  有意义」的折中态 —— 与红线 8（能力不匹配 loud）精神一致。

`backend` 值为 `'native'` / `'spawn'` / `'fork'` 时 loud error，文案重定向到
`ctx.subagents.start`（不静默改道 —— 改道 = 把 settings 静默丢弃，恰是本缝要消灭的静默
降级）。

---

## 6. 实现落点

### 6.1 文件与行数账

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `lib/dispatch.js`（新） | `createDispatchSeam({assembled, config})`：state 齐备守卫（fail at apply）、`backends()`、`dispatchAgentTask`（backend 归并/重定向 → role 解析 → settings 组装 + enum 校验 → ceiling + config cap → cwd 解析（assertCwd / parentCwd）→ 并发槽准入+合成键 → `driver.start({route:'sync',...})` → DispatchOutcome 压平 → finally 释放槽）+ 一行 dispatch 日志（backend/permissionMode/label/runId）；并承载自工具层抽出的共用函数 `resolveBridgePermissionMode` / `buildBridgeSettings` / `assertCallerWithinCeiling`（见下行） | ~190（含 JSDoc） |
| `lib/tools/subagent.js` | 抽出共用：permissionMode 解析链（L306–L308）、settings 组装（L314–L318）、caller-union ceiling 判定（L301–L313）→ import 自 `lib/dispatch.js`；工具行为零变化（既有测试是回归闸） | −20 / +6 |
| `lib/index.js` | 全局实例段 `attachAll` 后一行 provide + import；presetRow 分支不动 | +6 |
| `lib/config.js` | 全量分支加 `maxDispatchPermissionMode: z.enum(['readonly','default','full']).optional()`；presetRow 分支**不加**（红线 9：官方行形状不扩） | +5 |
| `lib/drivers/bridge.js` | sync 路由 cwd 支持（§2.2 cwd 行的通道选项 (a)）：`createBridgeDriver.start` 的 sync 分支把 cwd 解析改为 `request.cwd !== undefined ? request.cwd : parentCwdFn(request.parent)` + 注释（seam 已在调用方 assertCwd；工具层 bridge 分支不传该字段，能力矩阵 bridge cwd ❌ 保持不变，行为零变化） | +6 / −1 |
| `lib/drivers/types.js` | DelegateRequest typedef 补可选 `cwd` 字段契约行（仅 sync 路径 + 引擎级 dispatch 缝消费；工具层 bridge 不暴露；缺省 = parentCwd(parent)），仅 JSDoc | +7 |
| `test/dispatch.test.js`（新） | 见 §6.2 | ~300 |
| `test/index.test.js` | provide 接线 3 例（apply 后可 get / 形状断言 / presetRow 不 provide） | +25 |
| `README.md` / `README.zh.md` | 同步新增「引擎级派发缝」节（双语逐节对齐，仓库约定） | +30 ×2 |
| `CHANGELOG.md` | 新条目 | +6 |

**合计：净新增代码 ~180 行 + 测试 ~325 行 —— 一天级任务**（与任务书预期 ~200 行/一天级吻
合）。`package.json` 无新依赖（dispatch.js 只 import 本仓库模块 + 无 `@deepseek-ai/*` 直
接依赖，红线 12 白名单不受触碰）。

### 6.2 测试策略（fake bridge / fakeCtx，照 `test/bridge-driver.test.js` L42–L110 模式）

全部无真实 CLI / 无密钥（AGENTS.md 测试红线）。`test/dispatch.test.js` 覆盖矩阵：

1. **settings 穿透**：fake bridge（记录 `submit` 第五参）断言 settings 逐字段到达
   （permissionMode 解析链三档：显式 > role > 'default'；model / reasoningEffort 直通）。
2. **ceiling 拒绝**：parent 命中 binding（readonly）请求 full → throw；命中 registry（冷）
   同理；root parent 不受限；callerMode 未知 → fail closed（ceiling.test.js 随迁语义的
   seam 版）。
3. **config cap**：`maxDispatchPermissionMode: 'readonly'` + 请求 default → loud（两道闸
   独立触发、文案可区分）。
4. **registry 零写入**：dispatch 前后 `registry.size` 不变；`bindings` 无新键（§3.3 断言）。
5. **并发槽**：in-flight 期间 `liveChildren` 含 `dispatch:*` 合成键、settle 后释放；预占满
   cap → loud；与真实 continuable 子代理共用同一 cap 计数。
6. **backend 校验**：未知名 loud 报列表；`'native'` → 重定向文案 throw。
7. **role**：未知 loud 报列表；instructions 前缀进 task；role.backend 锁定与显式 backend 冲
   突 → throw（subagent-tool.test.js ③⑤ 的 seam 版）。
8. **cwd**：显式 cwd 到达 `bridge.create`；非法（相对路径/不存在）→ assertCwd 文案；省略 →
   parentCwd(parent)。
9. **signal/失败路径**：signal abort 贯穿；submit throw → dispose 仍被调 + rethrow
   （bridge-driver.test.js sync 用例的 seam 版）；stopReason/text 映射与 label 回显。
10. **参数白名单**：persona / toolFilter / maxDepth / provider / outputSchema / maxTokens 任
    一出现 → loud 含参数名（红线 8）。
11. **enum 加固**：permissionMode / reasoningEffort 非法值 → loud（比工具层 schema 更前置）。

`test/index.test.js`：apply 后 `ctx.get('subagentsDispatch')` 非 undefined 且形状对
（fakeCtx 加 provide/get 记录）；presetRow apply 后为 undefined。

### 6.3 实施任务卡（可直接进 TASKS.md）

> **T22 引擎级 dispatch 缝**（依赖 T14）。目标：§1.2 消费方可用 —— DESIGN
> dispatch-seam.md 全量落地。范围：`lib/dispatch.js` 新建 + `lib/index.js` provide +
> `lib/config.js` cap 键 + `lib/tools/subagent.js` 共用函数抽取 + 测试与双语 README。
> 验收：§6.2 矩阵全绿；`npm run lint` 过（无新 @deepseek-ai import）；既有 subagent-tool
> 测试零改动全绿（共用函数抽取不改变工具行为的证明）。

---

## 7. 十二条红线对照表

| # | 红线（AGENTS.md / DESIGN §9） | 本缝触碰？ | 如何不违背 |
|---|---|---|---|
| 1 | relay 永远只读管道 | 不触碰 | one-shot 不创建 relay 子代理（§3.5）；未来 continuable 扩展已写死 relay 装配义务（§2.4） |
| 2 | permissionMode 只作用于远端产品 | 触碰（正是其实现） | settings 经既有 bridge 层映射产品自有 CLI flag（claude.js L70–L79 等），seam 零新 flag 面 |
| 3 | 权限沿委派树继承不可上调，未知 fail closed | 触碰（强化） | seam 复用 `assertWithinCeiling`，主体 = parent（binding ∪ registry 并集），另加 enum 前置校验与 config cap 第二道闸（§3.1–3.2） |
| 4 | bridge 契约固定 create/submit/reconnect/dispose | 不触碰 | seam 经 `driver.start` sync 路由调既有契约，零契约改动 |
| 5 | 跨平台（run.js） | 不触碰 | 进程启动全在 bridge/run.js，seam 不碰 |
| 6 | registry 是唯一恢复源；恢复必须还原 settings | 显式论证 | one-shot 无恢复语义故零登记（与工具层 sync 同权同形，§3.3）；continuable 扩展强制 persistRemote 含 settings |
| 7 | 任务文本永远在 `--` 之后；flag 值白名单 | 不触碰 | task 原样进 `bridge.submit`，注入防线全在 bridge 层（§3.7） |
| 8 | 能力不匹配永远 loud | 触碰（遵守） | 未知 backend loud、native 名重定向、native 专属参数白名单拒绝、非法 enum loud、cap 越界 loud —— 全部不静默（§2.2/§3.2） |
| 9 | Config 保持官方行超集 | 触碰（遵守） | 新键只加全量分支；presetRow 分支零变化（§6.1） |
| 10 | 共享状态单实例持有 | 触碰（遵守） | seam 只由全局 apply provide；消费 `assembled.state` 的 bindings/registry/liveChildren 单实例；presetRow 分支不 provide（§4.2）；并发槽占同一只 Set 防旁路（§3.4） |
| 11 | 安装/体检脚本禁硬编码路径 | 不触碰 | 零脚本改动 |
| 12 | dsh-subagent import 恒纯函数白名单 | 不触碰 | dispatch.js 不 import 任何 `@deepseek-ai/dsh-subagent` 符号（lint 面不变） |

---

## 8. 与 dag-orchestrator 的对齐与冲突清单

**对齐（无冲突）**：

- §4.3-B / §14-O2 期望的 `dispatchAgentTask({backend, settings, …})` —— 名字、settings 键
  名、语义逐字对上（其 L749 拍板行）。
- §11.2 组合缝模式：`ctx.provide` 命名访问器 + 消费方机会主义 `ctx.get`（不用 inject）+
  `available: boolean` —— 本缝 §4.1 同款（多 `backends()` 纯增益）。
- §4.4 parent 归属（挂当前 tick 泵者的 `exec.agent`）→ seam 的必填 `parent` 正是此物。
- §4.2 signal（engine 自持 AbortController）→ seam 的可选 `signal` 对接点。
- §4.3-C 否决伪 relay ↔ seam 不做 continuable（§2.4）—— 同一判断的两面。
- 其 §10 红线 6「bridge 放开时必须复用其 PERM_RANK 天花板校验……此为 O2 的硬前提」
  （L675）—— §3.1 逐字满足。

**显式差异 / 集成注记（orchestrator 侧须知）**：

1. **返回形状**：seam 返回窄 `DispatchOutcome`（text + stopReason），非官方
   `SubagentRun`/promise 句柄 —— orchestrator bridge 执行器不需要 inFlight 句柄（await 即
   得；其 §4.4 的 promise-reflect 收割对 bridge 任务退化为直接 await，engine 自身的
   `reflect()` 包装对 DispatchOutcome 同样适用）。
2. **structured 缺失**：bridge one-shot 无 outputSchema 能力 → orchestrator 的 output 契约
   门（§4.5 completed + task.output 声明 + structured 缺失 → `dag.missing_output`）在
   bridge 任务上恒炸。**建议**：orchestrator 侧 spec 校验对 bridge 后端任务禁 `outputs`
   声明（或映射 text 进单一 output）—— 归 orchestrator 决策，本缝不代劳。
3. **双重并发**：orchestrator `maxRunningAgents` 与本插件 `maxConcurrentChildren` 叠加
   （seam 占槽，§3.4）—— bridge 并发实际为两者 min；README 组合示例应提示按
   `maxConcurrentChildren ≥ maxRunningAgents` 配置。
4. **timeout**：seam 无内置 timeout，靠调用方 signal（orchestrator §4.5 的 timer→abort→
   `aborted` 映射照常成立 —— stopReason 由 bridge 层在 signal 触发后以 aborted settle）。

---

## 9. 开放问题

| # | 问题 | 倾向 |
|---|---|---|
| O-1 | 工具沙箱（dsh-cordis-host-runner 的 sandboxed ctx）能否解析宿主面服务 `subagentsDispatch`？其沙箱白名单列有 `ctx.provide`/`ctx.get`（runner L634）。即便能，该面同样已能触达 `ctx.subagents`，本缝未降低既有门槛，且 seam 需要 live `Agent` 句柄参与 ceiling。 | 维持进程信任模型、不加锁；若 DSH 未来引入跨进程/低信任插件面，届时随全服务面统一加鉴权（非本缝单独特制） |
| O-2 | continuable 模式（`mode:'continuable'` + settings 承载的 binding/registry 登记）是否在某消费方出现后落地？ | 暂缓（YAGNI；orchestrator 明确不需要，§2.4 论证）。落地时严格按 §2.4 扩展预留的完整 relay 装配 |
| O-3 | `maxDispatchPermissionMode` 缺省 full 是否符合部署预期？（§3.2 已论证 parity 立场：seam 不应严格弱于模型工具面，否则是安全剧场） | 缺省 full；等 orchestrator M2+ 实装后的第一个真实部署反馈再评估是否收紧 |
| O-4 | seam 的 `cwd` 是相对工具层的唯一扩展（§2.2）：是否要在 orchestrator M3 前保持更保守（砍掉，恒用 parent cwd）？ | 保留 —— O1 拍板的跨会话泵者漂移使 parent cwd 对 DAG 任务语义错误（§2.2 cwd 行论证）；若无 M3 worktree 需求，消费方不传即得 parity 行为，零成本 |
