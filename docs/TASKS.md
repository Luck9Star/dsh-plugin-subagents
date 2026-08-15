# dsh-plugin-subagents — 实施任务分解

> 配套 `docs/DESIGN.md` 阅读。任务可独立派发给实现代理；每个任务自包含：目标 / 范围与涉及文件 / 验收标准 / 依赖。
> 通用约束（每个任务默认遵守）：
> - 设计红线见 DESIGN §9（relay 只读、天花板 fail closed、`--` 之后传任务文本、flag 值白名单、能力不匹配 loud error…）。
> - 测试一律 `node:test` + fake（bridge/driver/ctx），**不依赖真实 CLI 与密钥**。
> - 不修改两个前身仓库；迁移代码时保留原注释语义，只做设计文档要求的改名与扩展。
> - 行为约定引用：`D` 表示 DESIGN.md 章节，`R` 表示风险项。

## 阶段总览与依赖图

```
P0 脚手架        T01
P1 纯逻辑迁移    T02 T03 T04 T05 T06          （互相独立，可并行）
P2 抽象与驱动    T07 T08 T09 T10              （T07 先行；T08/T09 依赖 T07；T10 依赖 T08+T09）
P3 工具面        T11 T12 T13 T14              （依赖 T10）
P4 安装形态      T15 T16 T17 T18              （依赖 T03/T13；T15 先行）
P5 质量与发布    T19 T20 T21                  （依赖全部）
```

---

## P0 脚手架

### T01 仓库脚手架与包清单
- **目标**：新仓库可 `npm install && npm test`（空测试）通过，包身份与依赖契约定稿。
- **范围/文件**：`package.json`（name `dsh-plugin-subagents`；`dsh.bundle.patch: ./cordis.patch.yml`；deps `@agentclientprotocol/sdk@^0.25.0`、`zod@^3.23.0`、`yaml`；peerDependencies `@deepseek-ai/{cordis@^4.0.1,dsh-tools@^0.1.0-rc.6,dsh-subagent@^0.1.0-rc.6,dsh-agent@^0.1.0-rc.6,dsh-llm@^0.1.0-rc.6,dsh-session@^0.1.0-rc.6,dsh-jobs@^0.1.0-rc.6,dsh-home-paths}`；scripts test/lint/setup:peer 沿 legacy-bridges-plugin）、`.gitignore`、`LICENSE`（MIT）、`test/.smoke.test.js`、`scripts/link-harness-dsh-tools.sh`（照搬 legacy-bridges-plugin 版）。
- **验收**：`npm test` 绿；`node scripts/lint.js` 存根可跑；`dsh.bundle.patch` 字段存在（`exportsPatch()` 能识别，见 DESIGN §2.3-A）。
- **依赖**：无。

---

## P1 纯逻辑迁移（自 legacy-bridges-plugin 原样搬运 + 指定扩展）

### T02 bridges 三件套迁移
- **目标**：claude / codex / acp bridges 原样可用。
- **范围/文件**：`lib/bridges/claude.js`、`lib/bridges/codex.js`、`lib/bridges/acp.js` ← 原仓库同路径原样迁移（含 `safeFlagValue`/`safeConfigValue` 导出）；`test/bridges.test.js` 随迁。
- **验收**：随迁测试全绿；grep 确认无 `product_delegate`/`product_submit` 字面量残留于文案（bridge 内本无）。
- **依赖**：T01。

### T03 基础设施模块迁移（run/availability/progress/bindings/registry）
- **目标**：跨平台启动、检测、折叠、绑定、durable registry 就位，含指定改名与扩展。
- **范围/文件**：
  - `lib/run.js`、`lib/availability.js` 原样迁移；`test/run.test.js`、`test/providers.test.js`（availability 部分）随迁。
  - `lib/bindings.js`：迁移；`MARKER` 保持字符串 `'PRODUCT_SESSION:'`（历史会话 marker 兼容，DESIGN §7）。
  - `lib/registry.js`：默认路径改 `~/.dsh/subagents-registry.json`；条目结构 `{ backend, remoteId?, cwd?, settings?, updatedAt }`（`product` 字段更名为 `backend`）；`test/registry.test.js` 随迁并改断言。
  - `lib/progress.js`：迁移；`tool/call` 折叠同时匹配 `subagent_submit` 与 `product_submit`（legacy 会话兼容）；`test/progress.test.js` 扩两用例。
- **验收**：迁移+扩展测试全绿；`0600`/原子写/500 上限/`__proto__` 防护用例仍在。
- **依赖**：T01。

### T04 角色库扩展（backend/overrides）
- **目标**：角色文件支持 `backend` 与 native `overrides`（DESIGN §6.2）。
- **范围/文件**：`lib/roles.js` ← 迁移 + 扩展：`backend`（默认 `'native'`，`''` = 调用方选择）、`overrides`（agentOptions/persona/toolFilter/maxDepth，原样透传不做深校验，交给 config schema 常量复用）；`test/roles.test.js` 扩展。
- **验收**：旧角色文件（无新字段）加载行为不变；新字段解析正确；malformed 文件跳过不炸插件；`general` 兜底仍在。
- **依赖**：T01。

### T05 权限天花板抽出
- **目标**：`PERM_RANK` + `assertWithinCeiling` 成为独立模块（原在 product-delegate.js）。
- **范围/文件**：`lib/ceiling.js`（逻辑逐行照搬，注释保留）；`test/ceiling.test.js` 随迁。
- **验收**：随迁测试全绿（含 unknown→readonly fail closed、binding∪registry 判定）。
- **依赖**：T01。

### T06 provider 注册表迁移
- **目标**：`buildProviders`/`createBridgeFor`/`providerPersona` 就位，relay 文案统一 `subagent_submit`。
- **范围/文件**：`lib/providers.js` ← 迁移；`providerPersona` 三段文案中 `product_submit` → `subagent_submit`；BUILT_INS 不变（`claude-code`/`codex`/`acp`）；`test/providers.test.js` 相关用例更新。
- **验收**：grok 形态的 `config.providers` 零代码注册用例通过（fake 检测）；文案断言含 `subagent_submit`。
- **依赖**：T02、T03。

---

## P2 抽象与驱动

### T07 SubagentDriver 契约与能力常量
- **目标**：`lib/drivers/types.js` 固化 DESIGN §3.2 契约（JSDoc 承载 TS 签名）+ `DriverCapabilities` 工厂常量 `NATIVE_CAPS` / `BRIDGE_CAPS` + 参数-能力校验函数 `assertParamsSupported(capabilities, request)`（不匹配 → 带参数名的 Error）。
- **范围/文件**：`lib/drivers/types.js`、`test/drivers.test.js`（校验函数用例矩阵，覆盖 DESIGN §3.5 全行）。
- **验收**：矩阵用例全绿（bridge+persona / bridge+cwd / native+permission_mode 等均 throw 且消息含参数名）。
- **依赖**：T01。

### T08 NativeDriver
- **目标**：spawn/fork 两实例的 native 驱动（DESIGN §3.4）。
- **范围/文件**：
  - `lib/native-delegate.js` ← 自 `legacy-cwd-plugin/lib/index.js` 抽出纯函数：`resolvePersona`/`resolvePresetByDisplayName`/`resolveModelRoute`/`assertCwd`/`settleStart`/`settleForegroundRun`/`stopReasonError`/`withPartialText`/`outputValueText`/`providerWording`/`resolveDelegationRun`。
  - `lib/drivers/native.js`：`start`（三路由：sync=`ctx.subagents.start`+settle；job=`ctx.get('jobs')` 包裹；continuable=`startContinuable`）、`progress`（session 折叠 + listChildren）、`dispose`；cwd 补丁 stamp 检测（`patches/.applied` 缺失且请求带 cwd → Error 指引 `patches/install`）。
  - `test/native-driver.test.js`：fakeCtx 的 `subagents.start/startContinuable/listChildren`、fake jobs；验证三路由输出 kind、per-call 覆盖合并次序（args > role.overrides > config）、`@preset:` 解析（tmp 目录造 preset）、provider-added 惰性挂载不在此层（工具层职责）。
- **验收**：上述用例全绿；`settleForegroundRun` 的 disposal 聚合错误语义保持（原实现照搬）。
- **依赖**：T07。

### T09 BridgeDriver
- **目标**：bridge 驱动三路由（sync 直连 / continuable relay / job 拒绝并折叠为 continuable）。
- **范围/文件**：`lib/drivers/bridge.js`：持有 bridges+bindings+registry+liveChildren+idle 调度（自 legacy-bridges-plugin `lib/index.js` L95–L233 迁移：idleTimeout/并发槽/pending-start guard/endedAt/persistRemote/teardown）；`start` 组装 relay（persona=providerPersona+委派句、toolFilter=§5.4 白名单）；`followup` 校验 binding；`progress`（binding+fold）；`dispose`。provider 注册（`registerProvider` 包装 `start/prepareContinuable`，自 `lib/index.js` L169–L213 迁移）也在此文件导出 `createBridgeProviders()`。
- **验收**：`test/bridge-driver.test.js`（fake bridge + fakeCtx）：sync 路径 create→submit→dispose 顺序断言；continuable 路径 startContinuable 收到 persona/toolFilter；job 路由报能力错误；idle 释放与 cancelDispose；并发槽拒绝。
- **依赖**：T07、T06。

### T10 驱动注册表与可用性装配
- **目标**：`lib/drivers/index.js`：`assembleDrivers(cfg, ctx)` → `{ native: {spawn, fork}, bridges: Map<name, BridgeDriver>, availability }`；native provider 来自 `ctx.subagents.getProvider`（惰性，provider-added 事件感知）；bridge 仅检测到的 CLI 注册。
- **范围/文件**：`lib/drivers/index.js`、装配用例（fakeCtx 注入伪 provider 注册表）。
- **验收**：grok（config.providers）+ codex（fake PATH 命中）+ claude-code（未命中）三态可用性正确；native spawn/fork 在 provider 出现前后都可解析。
- **依赖**：T08、T09。

---

## P3 工具面

### T11 `subagent` 统一委派工具
- **目标**：接管官方名的统一入口（DESIGN §5.3 全 schema 与校验次序）。
- **范围/文件**：`lib/tools/subagent.js`；校验链：role 解析（未知 role 报列表）→ backend 归并（显式 > role.backend > native；冲突 throw）→ `assertParamsSupported` → bridge 可用性 + `assertWithinCeiling` → native persona/model/cwd/maxDepth → driver.start；输出 oneOf schema + render；`presetHints` 展开进 persona description；continuable 时注册 systemPrompt 后台使用段（order 116.5，沿 legacy-cwd-plugin）。
- **验收**：`test/subagent-tool.test.js`：① 默认走 native（无 backend/role）；② backend=codex 走 bridge sync/continuable；③ role.backend 被显式 backend 覆盖与冲突报错；④ 未知 role loud；⑤ bridge 子代理调用者触发天花板拦截；⑥ native+permission_mode / bridge+cwd 等 loud；⑦ role.instructions 前缀拼接；⑧ role.overrides 与 per-call 覆盖次序。
- **依赖**：T10。

### T12 `subagent_fork` 与 relay 管道 `subagent_submit`
- **目标**：fork 变体（native-only，官方语义 + per-call 增强）与 relay 管道（原 product-submit 改名）。
- **范围/文件**：`lib/tools/subagent-fork.js`（无 backend/role 参数；provider 固定 fork 或 config.fork.provider；bridge 参数出现即 throw）；`lib/tools/subagent-submit.js` ← product-submit 迁移（binding→registry 恢复、per-child tail 队列、marker 追加、settings 还原，逻辑照搬）；`test/subagent-fork.test.js`、`test/submit.test.js`（tools.test.js 相关用例迁移）。
- **验收**：submit 的恢复矩阵用例全绿（live binding / registry+remoteId reconnect / registry 无 remoteId fresh / 无记录拒绝）；并发 submit 串行化用例；fork 的 `inherits conversation` 文案与 one-shot 默认。
- **依赖**：T11（共享 deps 装配）。

### T13 观测族工具（progress/wait/roles/agents）
- **目标**：四件辅助工具统一命名并扩展 native 支持。
- **范围/文件**：`lib/tools/subagent-progress.js`（+native：无 binding 时纯 session 折叠；bridge 字段缺省）、`lib/tools/subagent-wait.js`（原 product-wait 迁移，事件驱动等待对两类 child 通用）、`lib/tools/subagent-roles.js`（+backend 列）、`lib/tools/subagent-agents.js`（availability + native provider 视图 + live children）；对应测试（wait.test.js 迁移 + 扩展）。
- **验收**：wait 的 subscribe-before-check 竞态用例随迁通过；progress 对 fake native session 折叠正确；roles 输出含 backend 列；agents 三态可用性。
- **依赖**：T11。

### T14 apply() 总装与 config
- **目标**：`lib/index.js` + `lib/config.js` 定稿（DESIGN §6.1 schema、§6.6 迁移与别名、§4.1 register 开关）。
- **范围/文件**：
  - `lib/config.js`：zod strict 双分支（presetRow 时按官方行形状校验：provider/toolName/enableRunInBackground/backgroundMode/agentOptions/persona/toolFilter/maxDepth/presetHints/presetRow；否则完整 schema）。
  - `lib/index.js`：validateConfig → registry 迁移（一次性，`.migrated` 标记）→ availability → drivers → 按 register 注册七工具（presetRow 模式只注册行 toolName 的 native 工具，无 provider/辅助）→ legacy 别名（auto 探测）→ 生命周期监听 → teardown。dsh-tools 双实例自检（R2：本实例 Symbol 取 scheduler 为 undefined → logger.fatal 指引 dedupe 脚本）。
  - `test/config.test.js` 扩展（strict、双分支、toolNames 默认）、`test/index.test.js`（装配/迁移/别名/presetRow/teardown）。
- **验收**：全部用例绿；两实例并存（apply 两次模拟 presetRow+全局）无 provider/工具重名注册。
- **依赖**：T11、T12、T13。

---

## P4 安装形态

### T15 bundle patch
- **目标**：`cordis.patch.yml` 按 DESIGN §4.1 落地。
- **范围/文件**：`cordis.patch.yml`（disable `tool-subagent`/`tool-subagent-fork` + 单实例 insert，config 给出注释完备的默认值与 providers 示例注释）。
- **验收**：YAML 可解析为 loader patch 列表（用 cordis loader 方言的 `!!js` 不出现，纯静态）；行 id 与 dsh-base 完全一致（对照 `dsh-base/cordis.patch.yml` 断言，写一个 node:test 校验文件内容）。
- **依赖**：T14（包名/config 形状定稿）。

### T16 cwd 补丁、live 根管理与 install/verify 脚本
- **目标**：cwd 能力可分发、可重放，npx 缓存漂移可检测可修复（DESIGN §6.4 全部硬性要求；R1/R2）。
- **范围/文件**：
  - `patches/01-in-process-driver.patch`、`patches/02-subagent-bundle.patch`：锚点与 rc.6 一致（自 legacy-cwd-plugin 照搬）。
  - `patches/install.sh|ps1`（重写，不照搬前身根发现逻辑；**两段式、成败解耦**，DESIGN §6.4.2）：0. `resolve_live_root()`（POSIX：`which dsh` → realpath → 上溯至 `node_modules` 父目录 + 自证 `@deepseek-ai/dsh-subagent` 存在；Windows：`where dsh` shim 文本提取目标后同法；`DSH_HARNESS_ROOT` 显式覆盖）——**禁止硬编码路径、禁止 `ls | tail -1` 启发式**；A 段【强制先行】修复**两处** dsh-tools 符号链接（profile 与插件仓库 node_modules，均指向 live 根，吸收 fix-dsh-tools-dedupe.sh / link-harness-dsh-tools.sh 职责；`--links-only` 止于此）；B 段 cwd 补丁**四态状态机**逐枚判定（a 未打→应用；b 已打→幂等跳过；c 锚不在但含等价 cwd 合并→原生支持 no-op+提示+stamp 记 native；d 锚不在也无合并→loud 失败，**不阻塞/不影响 A 段结果**）；C 写 stamp `patches/.applied`（dsh 版本、live 根、A/B 各自结果、目标 mtime）。退出码：A 失败立即非零；B 状态 d 非零但输出说明链接已修复。
  - `patches/verify.sh|ps1`（doctor，只读）：报告 (a) live 根、(b) 两枚补丁标记串就位、(c) 两处符号链接指向 live 根（readlink/realpath 比对）、(d) 仓库 `@deepseek-ai/dsh-subagent` 副本版本 vs live 根（仅 warning，§6.4.4）；任一漂移非零退出 + 一行修复提示。
  - `patches/uninstall.sh|ps1`：只还原补丁备份；**不回滚 A 段链接**（部署健康项，非插件私有状态，DESIGN §6.4.2 卸载注意）。
- **验收**：假目录树测试：`resolve_live_root` 上溯算法（构造嵌套 node_modules）；B 段四态各自判定（含状态 c 原生支持降级 no-op 的构造样例）；**A/B 解耦**：B 段状态 d 时 A 段链接已修复且退出码非零、输出含说明；`--links-only` 只跑 A 段；install→verify(全绿)→uninstall（补丁还原、链接不动）→install 幂等往返；verify 对链接三态（正确/错根/悬空）判定正确且退出码符合；stamp 读写（含 native 态）；脚本内无硬编码 hash 路径（grep 断言）。
- **依赖**：T08（driver 侧 stamp 消费）。

### T17 preset 适配脚本（L1/L2）
- **目标**：web 形态 preset 遮蔽问题可脚本化解决（DESIGN §6.3，R5）。
- **范围/文件**：`scripts/install-preset.sh|ps1`（双平台，补齐 legacy-cwd-plugin 缺失的 POSIX 版）：L1 默认复制源 preset → 删通用委派行（锚定 `name: '@deepseek-ai/dsh-tool-subagent'` + `toolName in {subagent, subagent_fork}`）→ 写副本标记；`--enhance-rows` L2：全部该 name 行改写 `name: 'dsh-plugin-subagents'` + `presetRow: true`；幂等（检测标记跳过）；锚失配 loud。
- **验收**：`test/preset-adapter.test.js`：对内嵌样例（standard 形态、orchestrator 形态）执行 L1/L2，断言产物 YAML 结构与幂等；不触碰源 preset（只读断言）。
- **依赖**：T15。

### T18 README 安装/互斥/矩阵文档
- **目标**：README.md + README.zh.md 覆盖 DESIGN §4.2 矩阵、§4.3 互斥、§6.5 流程。
- **范围/文件**：`README.md`、`README.zh.md`（同步）、`CHANGELOG.md`（0.1.0 条目）、`AGENTS.md`（红线继承 DESIGN §9）、`SECURITY.md`。
- **验收**：含"二选一"表（对 legacy-cwd-plugin / dsh-subagent-tools / 旧 legacy-bridges-plugin）；升级/漂移重放清单（重跑 patches/install → verify → 重启）；**npx 缓存漂移失效模式专节**（DESIGN §6.4.5：换根后 cwd 静默失效 / 工具调用全挂 reading 'prepare'，任一症状重跑 install 或先 verify）+ dsh-subagent 导入白名单决策说明（§6.4.4）；中英对照齐全。
- **依赖**：T15、T16、T17。

---

## P5 质量与发布

### T19 真机验收清单（手动，文档化）
- **目标**：在真实 dsh 0.1.0-rc.6（web + headless）跑通 DESIGN §4.2 矩阵。
- **范围/文件**：`docs/VERIFY.md`（清单式）：headless 替换生效；web+standard 未适配降级形态；L1 适配后统一工具可见；orchestrator L2 增强；grok config.providers 接入；cwd 前台/可续续两路径；补丁升级重放；dedupe 自检触发；旧 registry 迁移 + legacy 别名恢复。
- **验收**：清单全项勾选记录（附会话证据说明）。
- **依赖**：T18。

### T20 CI 与 lint
- **目标**：三平台 × Node 18/20/22 绿。
- **范围/文件**：`.github/workflows/ci.yml`（沿 legacy-bridges-plugin：macOS/Ubuntu/Windows × 18/20/22，`npm ci && npm run lint && npm test`）、`publish.yml`、`scripts/lint.js`（node --check 全模块 + **`@deepseek-ai/dsh-subagent` 导入白名单检查** `{ assertSubagentMaxDepth, settleRun }`，DESIGN §6.4.4/红线 12）。
- **验收**：CI 首跑绿；无真实 CLI 依赖（runner 裸机可过）；lint 对越白名单导入的样例文件报错（测试内嵌正/反例）。
- **依赖**：T14。

### T21 发布准备
- **目标**：npm 可发布身份完备。
- **范围/文件**：`package.json` files 字段（lib/ roles/ patches/ scripts/ cordis.patch.yml README* CHANGELOG LICENSE）、repository/keywords/engines、`npm pack --dry-run` 核对内容物。
- **验收**：dry-run 列表只含预期文件；version 0.1.0；CHANGELOG 就位。
- **依赖**：T20。

---

## 任务依赖速查

| 任务 | 依赖 |
|---|---|
| T01 | — |
| T02 T03 T04 T05 | T01 |
| T06 | T02 T03 |
| T07 | T01 |
| T08 | T07 |
| T09 | T06 T07 |
| T10 | T08 T09 |
| T11 | T10 |
| T12 T13 | T11 |
| T14 | T11 T12 T13 |
| T15 | T14 |
| T16 | T08 |
| T17 | T15 |
| T18 | T15 T16 T17 |
| T19 | T18 |
| T20 | T14 |
| T21 | T20 |

## 建议派发批次

1. **批 1**（可并行）：T01 →（T02/T03/T04/T05 + T07 并行）。
2. **批 2**：T06、T08、T09 → T10。
3. **批 3**：T11 →（T12/T13 并行）→ T14。
4. **批 4**：T15 →（T16/T17 并行）→ T18。
5. **批 5**：T19（真机）、T20、T21。
